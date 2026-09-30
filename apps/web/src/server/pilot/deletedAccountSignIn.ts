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
 * and revokes sessions. Several admin paths write to that login without
 * reading deleted_at, and can set active_flag back to true: redeeming a new
 * activation code (after an athlete PIN reset, re-provision, or intake
 * re-promoting a withdrawn athlete, which re-provisions the login inactive),
 * re-inviting an email as staff, and the platform owner's status and
 * membership routes (docs/DATA_RETENTION.md, "Still open"). Blocking each one
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
