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
const maxRows = Number.parseInt(process.env.PPBF_RETENTION_MAX_ROWS ?? '50', 10);
if (!Number.isFinite(maxRows) || maxRows < 0) {
  console.error(JSON.stringify({ event: 'retention.cleanup.failed', reason: 'INVALID_MAX_ROWS' }));
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();

  try {
    // Count first, always -- in the same transaction that will do the deleting,
    // so the rows counted are the rows removed.
    await client.query('begin');

    const counts = await client.query(
      `select
         (select count(*)::int from pilot.athletes
           where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})) as athletes,
         (select count(*)::int from pilot.accounts
           where deleted_at is not null and deleted_at < (now() - ${ACCOUNT_RETENTION})
             and role = 'parent') as accounts`,
    );
    const { athletes, accounts } = counts.rows[0];
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

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.dry-run',
        athletes,
        accounts,
        total,
        note: 'set PPBF_RETENTION_APPLY=true to delete',
      }));
      return;
    }

    if (total === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({ event: 'retention.cleanup.completed', athletes: 0, accounts: 0, total: 0 }));
      return;
    }

    const athleteDelete = await client.query(
      `delete from pilot.athletes
        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})
        returning athlete_id`,
    );
    const accountDelete = await client.query(
      `delete from pilot.accounts
        where deleted_at is not null and deleted_at < (now() - ${ACCOUNT_RETENTION})
          and role = 'parent'
        returning account_id`,
    );

    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'retention_cleanup', 'system', $2)`,
      [
        'data_purged',
        JSON.stringify({
          athletes_deleted: athleteDelete.rows.length,
          accounts_deleted: accountDelete.rows.length,
          total_rows_deleted: athleteDelete.rows.length + accountDelete.rows.length,
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: 'retention.cleanup.completed',
      athletes: athleteDelete.rows.length,
      accounts: accountDelete.rows.length,
      total: athleteDelete.rows.length + accountDelete.rows.length,
    }));
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
