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
 * ATHLETE_RECORD_HELD_BY_DELETED_LOGIN). Gone means the athlete this gym's
 * login names is marked deleted -- or, after the retention purge has removed
 * that row (accounts.athlete_id has no foreign key, and the purge leaves the
 * athlete's login behind, deleted), that the login is deleted and names no
 * athlete row that can be the writer. A cleared account reference proves
 * nothing here: the purge removes parent logins only.
 *
 * "THE ATHLETE THE LOGIN NAMES" MEANS THE ONE WHO COULD HAVE WRITTEN THE ROW
 * (submissionWriterAthleteSql below). After the purge the roster lets the same
 * athlete_id be created again for a different child, and the old deleted login
 * still carries that id. An athlete row created after the submission was
 * written is somebody else, so it is not counted: the purged child's closed
 * rows stay hidden, and nothing of theirs is put under the new child's name.
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
  createdColumn = 'created_at',
): string {
  const r = identifier(row);
  const account = identifier(accountColumn);
  const role = identifier(roleColumn);
  const org = identifier(orgColumn);
  const writerAthlete = (athlete: string) =>
    submissionWriterAthleteSql(athlete, 'writer_account', row, orgColumn, createdColumn);
  return `not (
    case when ${r}.${role} = 'athlete' then exists (
      select 1 from pilot.accounts writer_account
       where writer_account.account_id = ${r}.${account}
         and writer_account.organization_id = ${r}.${org}
         and writer_account.role = 'athlete'
         and writer_account.athlete_id is not null
         and (
           exists (
             select 1 from pilot.athletes deleted_athlete
              where ${writerAthlete('deleted_athlete')}
                and deleted_athlete.deleted_at is not null)
           or (
             writer_account.deleted_at is not null
             and not exists (
               select 1 from pilot.athletes any_athlete
                where ${writerAthlete('any_athlete')}))))
    else ${r}.${account} is null or exists (
      select 1 from pilot.accounts writer_account
       where writer_account.account_id = ${r}.${account}
         and writer_account.organization_id = ${r}.${org}
         and writer_account.role <> 'athlete'
         and writer_account.deleted_at is not null)
    end)`;
}

/**
 * SQL condition: this pilot.athletes row is the athlete who could have written
 * the submission through this login -- the submission's gym, the id the login
 * carries, and a row that already existed when the submission was written.
 *
 * The last part is what tells a purged child from a new child given the same
 * athlete_id afterwards. The submission's date is the anchor because nothing
 * rewrites it. The login's deletion date is NOT usable: deleting the new
 * child addresses the login by athlete_id and re-stamps the old login's
 * deleted_at (dataDeletion.ts), after which the new child's row would predate
 * it. And a submission is written through a live login, so a row that existed
 * by then also existed before that login was first deleted.
 *
 * WHAT created_at CAN GET WRONG. It is written once (upsertAthlete never
 * updates it), by the server for the roster import and intake; the roster's
 * add-one-athlete route takes it from the request, which the People page
 * fills from the admin's device clock.
 *  - A row stamped EARLIER than an old submission (a device clock that is
 *    behind, or a deliberate backdate) still passes: the old closed rows come
 *    back under the new child's name.
 *  - A row stamped LATER than something its own athlete wrote (a device clock
 *    that is ahead, or a login provisioned and used before the roster row was
 *    added) fails: those rows show no athlete name, and if that athlete's
 *    login alone is later deleted their closed rows are treated as a gone
 *    writer's.
 *
 * Shared by the predicate above and by the reader's name join, so a row is
 * never hidden by one athlete and named after another.
 */
export function submissionWriterAthleteSql(
  athlete: string,
  account: string,
  row: string,
  orgColumn = 'organization_id',
  createdColumn = 'created_at',
): string {
  const a = identifier(athlete);
  const acct = identifier(account);
  const r = identifier(row);
  const org = identifier(orgColumn);
  const created = identifier(createdColumn);
  return `${a}.organization_id = ${r}.${org}
                and ${a}.athlete_id = ${acct}.athlete_id
                and ${a}.created_at <= ${r}.${created}`;
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
