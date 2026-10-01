/**
 * Sign-in refuses any account marked deleted. ONE rule, stated here, read by
 * every place a login is issued or a session is honoured.
 *
 * Owner decisions (docs/current/OWNER_DECISIONS.md): OD-2026-09-29-003 Q9,
 * Jason "all recommended" -> A, "one central rule: sign-in refuses any account
 * marked deleted"; it is what makes OD-2026-09-29-002 item 10 hold, where
 * deleting a person means "their login stops".
 *
 * WHY AT SIGN-IN, AND NOT ON EACH PATH THAT CAN TURN A LOGIN BACK ON
 *
 * Deletion (dataDeletion.ts) sets pilot.accounts.deleted_at, clears active_flag
 * and revokes sessions. Several admin paths wrote to that login without
 * reading deleted_at, and could set active_flag back to true: redeeming a new
 * activation code (after an athlete PIN reset, re-provision, or intake
 * re-promoting a withdrawn athlete), re-inviting an email as staff, and the
 * platform owner's status and membership routes. Those now refuse a deleted
 * login themselves (OD-2026-09-30-004 e2; deletedLoginConflict below, and
 * docs/DATA_RETENTION.md for the ones that do not). Blocking each one alone
 * (option B) leaves the next such path to be missed. So the rule sits where
 * every login passes:
 *
 *   issued    loginWithAccountIdAndPin and loginWithMicrosoftEmail (auth.ts);
 *             issueMagicLink, and validateTokenForRedemption (magicLink.ts),
 *             which redeemMagicLink (magicLinkStore.ts) runs before it mints
 *             a session.
 *   honoured  resolvePrincipal (auth.ts). Every authenticated request reaches
 *             it (http.ts requirePrincipal*, pageGuard.ts requirePageRole, the
 *             session route), so it is the backstop: a session minted by any
 *             path, now or later, that forgot to ask here resolves to nobody.
 *
 * Only deleted_at decides this. active_flag stays its own rule with its own
 * refusals: an account can be inactive without being deleted, and -- the case
 * this exists for -- active again while still deleted.
 *
 * FAIL CLOSED. isDeletedAccount reads anything other than an explicit `false`
 * as deleted, so a query that forgets to select the flag refuses everyone the
 * first time it runs, instead of quietly admitting the deleted.
 */

import { ConflictError } from './errors';

const PLAIN_SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * The one SQL statement of "this account is marked deleted", for the
 * pilot.accounts row under `alias`. Select it `as account_deleted` and read it
 * with isDeletedAccount, or put `not <this>` in a where clause.
 */
export function accountDeletedSql(alias: string): string {
  if (!PLAIN_SQL_ALIAS.test(alias)) {
    throw new Error(`accountDeletedSql: "${alias}" is not a plain SQL alias`);
  }
  return `(${alias}.deleted_at is not null)`;
}

/** A row that selected `${accountDeletedSql(alias)} as account_deleted`. */
export interface AccountDeletionFlag {
  account_deleted: boolean;
}

/** True unless the row says, explicitly, that the account is not deleted. */
export function isDeletedAccount(row: AccountDeletionFlag): boolean {
  return row.account_deleted !== false;
}

/**
 * The refusal for an admin action on a login marked deleted (Jason
 * 2026-09-30, OD-2026-09-30-004 e2, A: refuse with a clear message, like
 * intake's 409). Each of those actions used to succeed and leave the login
 * shown as active, with a PIN or a code, while sign-in refused it and nothing
 * said why. One message for all of them: a deleted login is changed by
 * nothing in the app.
 *
 * `login` is what the caller named -- an account_id or an email -- never a
 * value read from the row.
 */
export function deletedLoginConflict(login: string): ConflictError {
  return new ConflictError(
    `Conflict: the login "${login}" was deleted. A deleted login cannot sign in and nothing here changes it; `
    + 'a deletion is not undone from the app. A returning person gets a new login.',
    'DELETED_LOGIN',
  );
}

/** The one method of a pg client, or a pool wrapper, this module needs. */
export interface AccountLookupClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * For a write that carries `not accountDeletedSql(...)` in its own where
 * clause and wrote nothing: throws deletedLoginConflict if that was because
 * the login is deleted, and returns otherwise so the caller raises the error
 * it always raised. The write is the guard; this only names the reason.
 *
 * `organizationId` scopes the lookup, so an organization's admin is told
 * about a deleted login in their own organization and learns nothing about
 * any other. Pass null only from a platform-owner route, which is
 * cross-organization by role.
 */
export async function refuseIfLoginDeleted(
  client: AccountLookupClient,
  accountId: string,
  organizationId: string | null,
): Promise<void> {
  const found = await client.query(
    `select 1 from pilot.accounts a
     where a.account_id = $1
       and ($2::text is null or a.organization_id = $2)
       and ${accountDeletedSql('a')}`,
    [accountId, organizationId],
  );

  if (found.rows.length > 0) {
    throw deletedLoginConflict(accountId);
  }
}
