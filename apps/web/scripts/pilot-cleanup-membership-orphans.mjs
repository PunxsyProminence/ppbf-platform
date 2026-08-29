#!/usr/bin/env node

/**
 * Deletes the specific pilot.organization_memberships rows
 * pilot-check-membership-orphans.mjs reports: rows whose account_id matches
 * no row in pilot.accounts. organization_memberships has never had a foreign
 * key on account_id, so these rows survive independently of whatever removed
 * (or never created) the account they point at; the read-only check exists
 * precisely because a diagnostic must answer "what and how many" before
 * anyone decides whether to delete them, and this is the write half of that
 * same question, run only after that decision has actually been made.
 *
 * Owner decision, 2026-08-29: the 17 rows the census found are not real --
 * confirmed non-retention (0 purge runs on record), all in one organization,
 * 15 of them created at the exact same millisecond (a bulk seed/bootstrap
 * artifact), every account_id a non-email id the platform's real provisioning
 * never produces. "Delete them" is that decision; this script is what carries
 * it out, scoped to exactly the rows a fresh read confirms are still orphaned.
 *
 *   TARGET GUARD    Same contract as pilot-cleanup-deleted-data.mjs: refuses
 *                   unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                   PPBF_EXPECTED_POSTGRES_DATABASE match the connection
 *                   string, so an agent shell holding a production
 *                   connection string cannot run this against the wrong
 *                   database by accident.
 *
 *   DRY RUN         Default. Reports exactly which rows it WOULD delete
 *                   (masked account_id, role, organization_id, created_at)
 *                   and rolls back. Set PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY
 *                   =true to commit.
 *
 *   RE-READ, NOT REUSE   The set of orphan rows is re-selected inside this
 *                   run's own transaction rather than trusted from an earlier
 *                   check's output, so a row that stopped being orphaned
 *                   between the two (an account created since) is never
 *                   deleted on stale information.
 *
 *   SCOPED DELETE   Deletes by the exact (account_id, organization_id)
 *                   primary-key pairs this run selected -- never a bare
 *                   `where not exists (...)` delete statement -- so the
 *                   rows removed are provably the rows the same transaction
 *                   just reported, and nothing broader.
 *
 *   BLAST RADIUS    Refuses to proceed if more than PPBF_MEMBERSHIP_ORPHAN_
 *                   CLEANUP_MAX_ROWS rows (default 25, hard ceiling 50) are
 *                   found. 17 is the known count; this exists so a much
 *                   larger, unexpected population stops the run for a human
 *                   rather than being swept silently.
 *
 *   ONE TRANSACTION The delete and its audit row commit together or not at
 *                   all, mirroring pilot-cleanup-deleted-data.mjs.
 *
 * Usage:
 *   npm run pilot:cleanup-membership-orphans                     # dry run
 *   PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY=true npm run pilot:cleanup-membership-orphans
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'membership_orphan_cleanup.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'membership_orphan_cleanup.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const apply = process.env.PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY === 'true';

// Same reasoning as pilot-cleanup-deleted-data.mjs's MAX_ROWS_CEILING: a
// ceiling here, not only in the dispatching workflow, so the input can only
// ever narrow the blast radius and never widen it past what was reviewed.
const MAX_ROWS_CEILING = 50;
const requestedMaxRows = Number.parseInt(process.env.PPBF_MEMBERSHIP_ORPHAN_CLEANUP_MAX_ROWS ?? '25', 10);
if (!Number.isFinite(requestedMaxRows) || requestedMaxRows < 0) {
  console.error(JSON.stringify({ event: 'membership_orphan_cleanup.failed', reason: 'INVALID_MAX_ROWS' }));
  process.exit(1);
}
const maxRows = Math.min(requestedMaxRows, MAX_ROWS_CEILING);
if (requestedMaxRows > MAX_ROWS_CEILING) {
  console.error(JSON.stringify({
    event: 'membership_orphan_cleanup.max_rows_clamped',
    requested: requestedMaxRows,
    ceiling: MAX_ROWS_CEILING,
    note: 'The dispatcher asked to widen the blast radius past the ceiling. Clamped, not honoured.',
  }));
}

const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('begin');

    // Re-read inside this transaction -- see the header note on why this is
    // never taken from an earlier check's output.
    const orphanRows = await client.query(
      `select m.account_id, m.organization_id, m.role, m.active_flag, m.created_at
         from pilot.organization_memberships m
        where not exists (
          select 1 from pilot.accounts a where a.account_id = m.account_id
        )
        order by m.created_at`,
    );
    const total = orphanRows.rows.length;

    if (total > maxRows) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'membership_orphan_cleanup.refused',
        reason: 'BLAST_RADIUS_EXCEEDED',
        total,
        max_rows: maxRows,
      }));
      process.exitCode = 1;
      return;
    }

    if (total === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({ event: 'membership_orphan_cleanup.completed', deleted: 0, total: 0 }));
      return;
    }

    const byRole = {};
    for (const row of orphanRows.rows) {
      byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    }

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'membership_orphan_cleanup.dry-run',
        total,
        by_role: byRole,
        note: 'set PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY=true to delete',
      }));
      return;
    }

    // Deletes exactly the pairs this run selected above -- never a bare
    // `where not exists (...)` delete -- so what is removed is provably what
    // was just reported and nothing a concurrent write introduced meanwhile.
    const deleteResult = await client.query(
      `delete from pilot.organization_memberships m
        where (m.account_id, m.organization_id) in (
          select * from unnest($1::text[], $2::text[])
        )
        returning m.account_id`,
      [orphanRows.rows.map((row) => row.account_id), orphanRows.rows.map((row) => row.organization_id)],
    );
    const deleted = deleteResult.rows.length;

    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'membership_orphan_cleanup', 'system', $2)`,
      [
        'data_purged',
        JSON.stringify({ deleted, total, by_role: byRole }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: 'membership_orphan_cleanup.completed',
      deleted,
      total,
      by_role: byRole,
    }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error(JSON.stringify({
      event: 'membership_orphan_cleanup.failed',
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
