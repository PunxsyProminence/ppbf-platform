/**
 * DELETION SCOPE B (Jason, 2026-09-29, "10 C"; OD-2026-09-29-002 item 10):
 * "everything tied to the athlete is marked deleted at the same moment".
 *
 * THE MARK IS THE ATHLETE ROW'S OWN deleted_at. deleteAthleteRecord (and the
 * guardian cascade trigger) writes it in the deletion transaction, and every
 * reader of a row tied to that athlete checks it. So every tied row is marked
 * at exactly the moment the athlete is, by the same write, whichever path did
 * the deleting -- and there is one value to read, not seventy copies that can
 * disagree. Only one tied table carries a deletion column of its own
 * (pilot.shadow_chat_sessions.deleted_at, which dataDeletion.ts also stamps);
 * giving every other table one would take a migration on roughly seventy
 * tables to say again what the athlete row already says.
 *
 * `not exists (... deleted_at is not null)`, not `exists (... deleted_at is
 * null)`: a row with no athlete (unassigned gym footage, teaching footage) and
 * a row whose athlete is live both stay exactly as visible as before. The only
 * rows this removes are rows of an athlete marked deleted -- matched on BOTH
 * halves of pilot.athletes' key, because one athlete_id names a different
 * child in every gym that issues it.
 *
 * The arguments are SQL identifiers written in the calling module, never
 * request data; the pattern check refuses anything else rather than trusting
 * every future caller to remember that.
 */

import { query } from './db';

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;

function identifier(value: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`deletedAthletes: not a SQL identifier: ${value}`);
  }
  return value;
}

/**
 * SQL predicate: the row's athlete is not marked deleted.
 *
 * @param row           the alias (or schema-qualified table name) of the row being read
 * @param athleteColumn that row's athlete id column
 * @param orgColumn     that row's organization id column
 */
export function athleteNotDeletedSql(
  row: string,
  athleteColumn = 'athlete_id',
  orgColumn = 'organization_id',
): string {
  const r = identifier(row);
  const athlete = identifier(athleteColumn);
  const org = identifier(orgColumn);
  return `not exists (
    select 1 from pilot.athletes deleted_athlete
     where deleted_athlete.organization_id = ${r}.${org}
       and deleted_athlete.athlete_id = ${r}.${athlete}
       and deleted_athlete.deleted_at is not null)`;
}

/**
 * SQL predicate for rows keyed by an ACCOUNT rather than an athlete (a
 * portrait, a feedback submission): the account is not marked deleted, and
 * neither is the athlete it belongs to. deleteAthleteRecord marks the
 * athlete's account in the same transaction, so the first half is normally
 * enough; the second holds even for an athlete account that was left open.
 */
export function accountNotDeletedSql(row: string, accountColumn = 'account_id'): string {
  const r = identifier(row);
  const account = identifier(accountColumn);
  return `not exists (
    select 1 from pilot.accounts deleted_account
     where deleted_account.account_id = ${r}.${account}
       and (
         deleted_account.deleted_at is not null
         or exists (
           select 1 from pilot.athletes deleted_athlete
            where deleted_athlete.organization_id = deleted_account.organization_id
              and deleted_athlete.athlete_id = deleted_account.athlete_id
              and deleted_athlete.deleted_at is not null)))`;
}

/**
 * SQL predicate for a row WRITTEN BY an account (a feedback submission), where
 * the question is whether the PERSON is gone, not whether their login is.
 *
 * accountNotDeletedSql above treats a deleted login as enough. That is wrong
 * for an athlete: a live athlete's login can be deleted on its own (the state
 * intake refuses to re-provision, ATHLETE_RECORD_HELD_BY_DELETED_LOGIN), and
 * what a child who is still in the gym told it must not change because their
 * login did. So:
 *  - an athlete's login: the athlete row decides -- the writer is gone unless
 *    a live athlete row (deleted_at is null) stands behind the login;
 *  - any other login (guardian, staff): the account's own deleted_at decides,
 *    there being no other row that is the person.
 * A row whose account reference is null is the CALLER's to decide; this
 * predicate is true for it, as the two above are.
 */
export function accountHolderNotDeletedSql(row: string, accountColumn = 'account_id'): string {
  const r = identifier(row);
  const account = identifier(accountColumn);
  return `not exists (
    select 1 from pilot.accounts holder_account
     where holder_account.account_id = ${r}.${account}
       and case
             when holder_account.athlete_id is not null then not exists (
               select 1 from pilot.athletes live_athlete
                where live_athlete.organization_id = holder_account.organization_id
                  and live_athlete.athlete_id = holder_account.athlete_id
                  and live_athlete.deleted_at is null)
             else holder_account.deleted_at is not null
           end)`;
}

/**
 * The same test for rows already in memory: which of these athlete ids name
 * an athlete of this organization marked deleted. For a reader whose athlete
 * is resolved in code rather than in its query (a subject named in JSON
 * metadata, say). An id that names no athlete row at all is not in the result
 * -- the same "not deleted" answer the SQL predicates give it.
 */
export async function deletedAthleteIdsAmong(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  const distinct = Array.from(new Set(athleteIds));
  if (distinct.length === 0) {
    return new Set();
  }
  const rows = await query<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
      where organization_id = $1 and athlete_id = any($2::text[])
        and deleted_at is not null`,
    [organizationId, distinct],
  );
  return new Set(rows.map((row) => row.athlete_id));
}
