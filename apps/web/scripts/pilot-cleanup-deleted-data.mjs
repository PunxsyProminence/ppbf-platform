#!/usr/bin/env node

/**
 * Hard-deletes soft-deleted records that have passed their retention window.
 *
 * This is the only permanently destructive job in the platform. Everything else
 * that "deletes" sets deleted_at and is recoverable; this removes rows. It is
 * also intended to run unattended on a schedule, with nobody reading the output
 * until something has already gone wrong. The guards below exist for that
 * combination.
 *
 *   TARGET GUARD    Refuses to run unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                   PPBF_EXPECTED_POSTGRES_DATABASE match the connection
 *                   string, the same contract every migration runner uses. An
 *                   agent shell holding a production connection string is not
 *                   hypothetical here -- see scripts/lib/postgres-write-target.mjs
 *                   for the 361 rows that got into production that way.
 *
 *   DRY RUN         Default. The job reports what it WOULD delete and exits
 *                   without deleting. Set PPBF_RETENTION_APPLY=true to make it
 *                   act. A destructive default would mean a mistyped command,
 *                   or a copy-pasted CI step, is unrecoverable.
 *
 *   BLAST RADIUS    Refuses to proceed if the purge would remove more than
 *                   PPBF_RETENTION_MAX_ROWS rows (default 50). The windows are
 *                   two years and one year, so a correct run in a pilot this
 *                   size removes a handful of rows. A run that suddenly wants
 *                   hundreds means something upstream is wrong -- a bad
 *                   deleted_at backfill, a clock problem, a cascade that fired
 *                   too widely -- and the right response is to stop and let a
 *                   human look, not to enact it.
 *
 *   ONE TRANSACTION Deletes and the audit row commit together or not at all.
 *                   The audit row is the only record that the deletion
 *                   happened; rows gone with no record of their going is the
 *                   one outcome a retention policy must never produce.
 *
 * Usage:
 *   npm run pilot:cleanup-deleted-data                     # dry run, reports counts
 *   PPBF_RETENTION_APPLY=true npm run pilot:cleanup-deleted-data
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const ATHLETE_RETENTION = "interval '2 years'";
const ACCOUNT_RETENTION = "interval '1 year'";

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'retention.cleanup.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

// Refuses POSTGRES_TARGET_MISMATCH (and friends) before a connection is opened.
// Caught rather than thrown: this runs unattended and its output is read from a
// CI log, so every exit -- including a refusal -- has to be one structured line
// rather than a stack trace someone has to interpret.
try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'retention.cleanup.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const apply = process.env.PPBF_RETENTION_APPLY === 'true';
// THE BLAST-RADIUS GUARD MUST NOT BE DEFEATABLE BY THE PERSON TRIGGERING THE
// DELETION. This file's own header sells the cap as the thing that stops a
// runaway sweep -- "the right response is to stop and let a human look" -- but
// the threshold arrived as a free-text workflow input with no upper bound, from
// the same dispatch box that types APPLY. `max_rows=999999` switched the guard
// off entirely while still reading as a deliberate, guarded run in the log.
//
// A ceiling here rather than only in the workflow, because this script is also
// runnable by hand. The input can now only ever NARROW the blast radius; it can
// never widen it past what a human agreed to in review.
const MAX_ROWS_CEILING = 200;
const requestedMaxRows = Number.parseInt(process.env.PPBF_RETENTION_MAX_ROWS ?? '50', 10);
if (!Number.isFinite(requestedMaxRows) || requestedMaxRows < 0) {
  console.error(JSON.stringify({ event: 'retention.cleanup.failed', reason: 'INVALID_MAX_ROWS' }));
  process.exit(1);
}
const maxRows = Math.min(requestedMaxRows, MAX_ROWS_CEILING);
if (requestedMaxRows > MAX_ROWS_CEILING) {
  console.error(
    JSON.stringify({
      event: 'retention.cleanup.max_rows_clamped',
      requested: requestedMaxRows,
      ceiling: MAX_ROWS_CEILING,
      note: 'The dispatcher asked to widen the blast radius past the ceiling. Clamped, not honoured.',
    }),
  );
}

const pool = new Pool({ connectionString });

/**
 * The constraint that refused a delete, or the SQLSTATE if Postgres named none.
 *
 * A constraint name is a schema identifier, not personal data, so it is safe in
 * a log this job writes unattended about a database of minors' records. Nothing
 * else from the error is emitted -- `detail` carries the offending key value.
 */
function blockedBy(error) {
  if (error && typeof error === 'object') {
    if (typeof error.constraint === 'string' && error.constraint) return error.constraint;
    if (typeof error.code === 'string' && error.code) return error.code;
  }
  return 'UNKNOWN';
}

/**
 * Does the deleting, and is run in BOTH modes -- the dry run rolls it back.
 *
 * WHY THE DRY RUN DELETES. It did not, and that is how the defect below went
 * unseen: the nightly run issued `select count(*)` and reported a healthy
 * number every night, while the delete those rows were counted for could not
 * execute at all. A count is not a rehearsal. This attempts the real
 * statements and rolls them back, so the number the job reports is a number it
 * has actually earned.
 *
 * EACH ACCOUNT IS ITS OWN SAVEPOINT. Before this, one account Postgres refused
 * aborted the whole transaction -- taking the athlete purge and the audit row
 * with it -- so a single blocked guardian meant the sweep deleted NOTHING and
 * said only `{"event":"retention.cleanup.failed","code":"23503"}`. Retention is
 * per-family; one family the platform cannot yet purge must not stop the
 * others, and the constraint that blocked it has to reach the log by name or
 * nobody can act on it.
 */
async function attemptPurge(client, accountIds) {
  let athletesDeleted = 0;
  const blocked = {};
  const record = (error) => {
    const name = blockedBy(error);
    blocked[name] = (blocked[name] ?? 0) + 1;
  };

  await client.query('savepoint purge_athletes');
  try {
    const athleteDelete = await client.query(
      `delete from pilot.athletes
        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})
        returning athlete_id`,
    );
    athletesDeleted = athleteDelete.rows.length;
    await client.query('release savepoint purge_athletes');
  } catch (error) {
    await client.query('rollback to savepoint purge_athletes');
    record(error);
  }

  let accountsDeleted = 0;
  for (const accountId of accountIds) {
    await client.query('savepoint purge_account');
    try {
      /* THE GUARDIAN'S OWN RECORD GOES WITH THE ACCOUNT. Owner decision,
         2026-08-28 (D-8): "delete the parents row too". pilot.parents holds
         their name, phone and email -- the personal data this policy promises
         to remove -- and its foreign key onto pilot.accounts restricts, so
         until this statement existed no guardian who had ever been recorded as
         a parent could be purged at all.

         What follows it is deliberate and load-bearing: guardian_links is ON
         DELETE CASCADE from pilot.parents, so the child-to-guardian links go
         too; pilot.waivers.parent_id is ON DELETE SET NULL, so the waivers
         themselves SURVIVE with their signed_by_name, type, status and dates
         intact. Purging a withdrawn family must never destroy the documents
         that authorised a minor's participation. */
      /* THE POINTER IS CLEARED BY HAND, and it has to be. pilot.waivers has a
         COMPOSITE foreign key onto pilot.parents -- (organization_id,
         parent_id) -- declared ON DELETE SET NULL. Postgres applies SET NULL to
         EVERY column in the key, so deleting the guardian record tries to null
         waivers.organization_id too, and that column is NOT NULL: the delete
         fails with 23502 and no constraint name. Nulling only parent_id first
         means no waiver row still matches the key, so the referential action
         never fires.

         Found by running it, not by reading the schema: it surfaced as a bare
         `{"23502": 1}` in this job's own blocked_by report. The foreign key's
         shape is the real defect and is left alone here -- it is a schema
         change to a different migration, and retention is the only path that
         deletes a pilot.parents row today. */
      await client.query(
        `update pilot.waivers w
            set parent_id = null
           from pilot.parents p
          where p.account_id = $1
            and w.organization_id = p.organization_id
            and w.parent_id = p.parent_id`,
        [accountId],
      );
      await client.query('delete from pilot.parents where account_id = $1', [accountId]);
      await client.query('delete from pilot.accounts where account_id = $1', [accountId]);
      await client.query('release savepoint purge_account');
      accountsDeleted += 1;
    } catch (error) {
      await client.query('rollback to savepoint purge_account');
      record(error);
    }
  }

  return { athletesDeleted, accountsDeleted, blocked };
}

async function main() {
  const client = await pool.connect();

  try {
    // Count first, always -- in the same transaction that will do the deleting,
    // so the rows counted are the rows removed.
    await client.query('begin');

    const expiredAccounts = await client.query(
      `select account_id from pilot.accounts
        where deleted_at is not null and deleted_at < (now() - ${ACCOUNT_RETENTION})
          and role = 'parent'`,
    );
    const counts = await client.query(
      `select
         (select count(*)::int from pilot.athletes
           where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})) as athletes`,
    );
    const athletes = counts.rows[0].athletes;
    const accounts = expiredAccounts.rows.length;
    const total = athletes + accounts;

    if (total > maxRows) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'retention.cleanup.refused',
        reason: 'BLAST_RADIUS_EXCEEDED',
        athletes,
        accounts,
        total,
        max_rows: maxRows,
      }));
      process.exitCode = 1;
      return;
    }

    const accountIds = expiredAccounts.rows.map((row) => row.account_id);
    const outcome = total === 0
      ? { athletesDeleted: 0, accountsDeleted: 0, blocked: {} }
      : await attemptPurge(client, accountIds);
    const blockedCount = Object.values(outcome.blocked).reduce((sum, n) => sum + n, 0);

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.dry-run',
        athletes,
        accounts,
        total,
        would_delete_athletes: outcome.athletesDeleted,
        would_delete_accounts: outcome.accountsDeleted,
        blocked: blockedCount,
        blocked_by: outcome.blocked,
        note: 'set PPBF_RETENTION_APPLY=true to delete',
      }));
      // A dry run that found rows it CANNOT delete is a failing monitor, not a
      // report. Exiting non-zero is the whole point: retention is not
      // happening, and the schedule is the only thing watching.
      if (blockedCount > 0) process.exitCode = 1;
      return;
    }

    if (total === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({ event: 'retention.cleanup.completed', athletes: 0, accounts: 0, total: 0 }));
      return;
    }

    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'retention_cleanup', 'system', $2)`,
      [
        'data_purged',
        JSON.stringify({
          athletes_deleted: outcome.athletesDeleted,
          accounts_deleted: outcome.accountsDeleted,
          total_rows_deleted: outcome.athletesDeleted + outcome.accountsDeleted,
          blocked: blockedCount,
          blocked_by: outcome.blocked,
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: blockedCount > 0 ? 'retention.cleanup.incomplete' : 'retention.cleanup.completed',
      athletes: outcome.athletesDeleted,
      accounts: outcome.accountsDeleted,
      total: outcome.athletesDeleted + outcome.accountsDeleted,
      blocked: blockedCount,
      blocked_by: outcome.blocked,
    }));
    // Rows WERE deleted and the audit row records exactly what, so this commits
    // rather than throwing away good work -- but retention did not fully happen
    // and the run must not read as green.
    if (blockedCount > 0) process.exitCode = 1;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // Identifier only. This job runs against a database of minors' records and
    // its output goes to a CI log.
    console.error(JSON.stringify({
      event: 'retention.cleanup.failed',
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
