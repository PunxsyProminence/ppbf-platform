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
 * SQL predicate for a row WRITTEN BY a person and stamped, at write time, with
 * the gym and the capacity they wrote it in (a feedback submission): true
 * unless the writer is PROVEN gone.
 *
 * It decides from the row's own frozen columns, not from the account as it
 * reads today. An account drifts -- a role changes, upsertOrganizationMembership
 * (auth.ts) moves it to another gym, and both leave athlete_id where it was --
 * so "is this an athlete?" and "which gym?" are asked of the submission, and
 * the account is believed only while it still agrees with it: same gym, and
 * still (or still not) an athlete's login. Where it no longer agrees, the
 * original writer cannot be proven gone and the row STAYS. Failing that way
 * keeps a closed record on a safeguarding queue; failing the other way hides
 * one.
 *
 * Written as an athlete: the ATHLETE ROW decides, never the login alone. A
 * live athlete's login can be deleted on its own (the state intake names
 * ATHLETE_RECORD_HELD_BY_DELETED_LOGIN). Gone means one of:
 *  1. the athlete this gym's login names is marked deleted;
 *  2. the login is deleted and names no athlete row. That is what the
 *     retention purge leaves: when it removes an athlete row it clears
 *     athlete_id on the login that named it (pilot-cleanup-deleted-data.mjs,
 *     purgeExpiredDeletedData), because that is the one moment an athlete_id
 *     can come free -- before it, the deleted row still holds the primary key.
 *     A new child later given the same athlete_id therefore has no link to
 *     the old login, and nothing here compares a date to tell them apart. A
 *     NULL athlete_id matches no row, so the same `not exists` also covers a
 *     deleted login left carrying a stale id that names no row.
 *
 *     WHAT THAT CANNOT COVER: a stale id that has ALREADY been given to a new
 *     athlete. The id then names a live row, the old writer reads as present,
 *     and the queue's name join would put the new athlete's name on the old
 *     rows. That needs an athlete hard-purged BEFORE the purge unlinked
 *     logins. No retention purge had ever run when this was written. OBSERVED
 *     2026-10-01, read-only check `membership-orphans` (run-checks.yml), which
 *     counts audit rows with event_type 'data_purged' and entity_type
 *     'retention_cleanup' -- the row both purge paths write: staging run
 *     36936795333 and production run 36936798184 each reported "retention
 *     purge history: 0 run(s), 0 account(s) ever purged". (The deletion
 *     preflight's "Retention purge events" counts every 'data_purged' row,
 *     whoever wrote it, and read 1 in production, run 36922416115; that row
 *     is therefore not a retention purge.) The owner's own statement the same
 *     day: "the app has never been live".
 * A cleared account REFERENCE proves nothing here: the purge removes parent
 * logins only.
 *
 * Written in any other capacity (guardian, staff): the account is the person.
 * Gone means this gym's login is marked deleted, or the reference has cleared
 * -- `on delete set null`, which only the retention purge triggers, and it
 * removes only logins already marked deleted.
 */
export function submissionWriterNotDeletedSql(
  row: string,
  accountColumn: string,
  roleColumn: string,
  orgColumn = 'organization_id',
): string {
  const r = identifier(row);
  const account = identifier(accountColumn);
  const role = identifier(roleColumn);
  const org = identifier(orgColumn);
  return `not (
    case when ${r}.${role} = 'athlete' then exists (
      select 1 from pilot.accounts writer_account
       where writer_account.account_id = ${r}.${account}
         and writer_account.organization_id = ${r}.${org}
         and writer_account.role = 'athlete'
         and (
           exists (
             select 1 from pilot.athletes deleted_athlete
              where deleted_athlete.organization_id = ${r}.${org}
                and deleted_athlete.athlete_id = writer_account.athlete_id
                and deleted_athlete.deleted_at is not null)
           or (
             writer_account.deleted_at is not null
             and not exists (
               select 1 from pilot.athletes any_athlete
                where any_athlete.organization_id = ${r}.${org}
                  and any_athlete.athlete_id = writer_account.athlete_id))))
    else ${r}.${account} is null or exists (
      select 1 from pilot.accounts writer_account
       where writer_account.account_id = ${r}.${account}
         and writer_account.organization_id = ${r}.${org}
         and writer_account.role <> 'athlete'
         and writer_account.deleted_at is not null)
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
