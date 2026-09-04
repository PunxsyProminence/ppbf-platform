import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_INFRA_DIR, listMigrationFiles } from './full-schema.mjs';

const HISTORY_TABLE = 'pilot.offline_runtime_schema_history';

function digest(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

async function migrationManifest(infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined) {
  const files = await listMigrationFiles(infraDir, workflowPath);
  return await Promise.all(files.map(async (file) => {
    const sql = await fs.readFile(path.join(infraDir, file), 'utf8');
    return { file, sql, sha256: digest(sql) };
  }));
}

export async function hasMigrationHistory(client) {
  const result = await client.query(
    "select to_regclass('pilot.offline_runtime_schema_history') as table_name",
  );
  return Boolean(result.rows[0]?.table_name);
}

async function historyRows(client) {
  const result = await client.query(`
    select migration_file, sha256
    from ${HISTORY_TABLE}
    order by migration_file
  `);
  return result.rows;
}

/**
 * Which manifest entries still need to run for real, against what is
 * recorded.
 *
 * This table is a LOCAL-ONLY reconciliation cache, not an immutable ledger --
 * it has no relationship to and is never read by production's own migration
 * path (`.github/workflows/apply-migrations.yml`'s `all` chain re-runs every
 * idempotent migration on every deploy and keeps no per-file record at all).
 * A recorded digest here means "the last content of this file this local
 * database actually ran", so a file whose content changed since it was
 * recorded is exactly as "pending" as a file that was never recorded: both
 * need their real SQL executed again before anything can claim they are
 * satisfied. Owner policy (2026-09-03): production migrations remain
 * immutable after deployment; this local cache is the separate, more
 * flexible mechanism that lets a reused local database catch up to a
 * sanctioned local edit without a reset.
 *
 * A recorded row naming a file no longer present in the current manifest is
 * a different, harder failure: a migration disappearing from the checkout
 * entirely is not the "changed desired state" case this cache exists for, so
 * it stays a hard, fail-closed error.
 */
function pendingAgainstRecorded(current, recorded) {
  const currentFiles = new Set(current.map((entry) => entry.file));
  for (const row of recorded) {
    if (!currentFiles.has(row.migration_file)) {
      throw new Error(
        `Recorded offline migration ${row.migration_file} is missing from the current checkout.`,
      );
    }
  }

  const recordedByFile = new Map(recorded.map((row) => [row.migration_file, row]));
  return current.filter((entry) => recordedByFile.get(entry.file)?.sha256 !== entry.sha256);
}

/**
 * Executes every pending manifest entry for real, strictly in the manifest's
 * (authoritative) order, one migration per transaction. A history row is
 * written or advanced only in the same transaction as -- and only after --
 * that specific migration's own SQL has committed, so the ledger can never
 * claim a file succeeded when its actual database effect did not. The first
 * failure stops the whole pass immediately: earlier successes in this same
 * call keep their newly-written rows (each was its own commit), so a retry
 * resumes at exactly the file that failed.
 */
async function reconcile(client, { infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined } = {}) {
  const current = await migrationManifest(infraDir, workflowPath);
  const recorded = await historyRows(client);
  const pending = pendingAgainstRecorded(current, recorded);

  const applied = [];
  for (const entry of pending) {
    try {
      await client.query('BEGIN');
      await client.query(entry.sql);
      await client.query(
        `insert into ${HISTORY_TABLE} (migration_file, sha256)
         values ($1, $2)
         on conflict (migration_file) do update set sha256 = excluded.sha256, applied_at = excluded.applied_at`,
        [entry.file, entry.sha256],
      );
      await client.query('COMMIT');
      applied.push(entry.file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new Error(
        `Offline schema reconciliation stopped at ${entry.file} (${applied.length + 1}/${pending.length} pending): ${message}`,
      );
    }
  }

  return { applied, total: current.length };
}

/**
 * Establishes local reconciliation bookkeeping for a database with no
 * history table yet, then reconciles it for real.
 *
 * Unlike the blind-insert baseline this replaced, every manifest entry is
 * genuinely executed here (guarded/idempotent, matching the same convention
 * production's own re-run-everything model already relies on) -- so a
 * pre-history database that is actually missing a migration's schema effect
 * gets that effect applied now, instead of having it permanently marked
 * "applied" on the strength of the file merely existing in the checkout.
 */
export async function baselineMigrationHistory(
  client,
  { infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined } = {},
) {
  if (!await hasMigrationHistory(client)) {
    await client.query(`
      create table ${HISTORY_TABLE} (
        migration_file text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      )
    `);
  }

  const { applied, total } = await reconcile(client, { infraDir, workflowPath });
  return { recorded: applied.length, total };
}

/**
 * Reconciles an already-baselined reused local database: executes every
 * migration that is new, or whose recorded digest no longer matches its
 * current content, in authoritative order; skips everything already
 * satisfied. Requires baselineMigrationHistory to have run at least once --
 * a database with no history table at all needs that explicit, one-time,
 * owner-gated step first.
 *
 * A history table that EXISTS but has never recorded a single row is a
 * separate, ambiguous case this function guards on its own: it looks
 * identical whether it is a genuine interruption partway through this same
 * reconciliation (safe to resume) or an unrelated change to an
 * already-fully-evolved database -- a manually cleared ledger, or a table
 * from an unknown history -- that a blind full replay would not fix and
 * might mask. baselineMigrationHistory()'s own first-ever call is NOT this
 * case: zero recorded rows there is the expected, already-authorized initial
 * state, not an ambiguity to guard.
 */
export async function applyPendingMigrations(
  client,
  { infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined } = {},
) {
  if (!await hasMigrationHistory(client)) {
    throw new Error(
      'Existing PPBF offline database has no migration history. Explicit baseline is required.',
    );
  }

  const recorded = await historyRows(client);
  if (recorded.length === 0 && process.env.PPBF_OFFLINE_ALLOW_EMPTY_HISTORY_RECOVERY !== 'true') {
    throw new Error(
      'Existing PPBF offline migration history table has zero recorded entries. PPBF cannot '
      + 'safely infer why -- a genuine interruption partway through reconciliation and an '
      + 'unrelated change to an already-evolved database look identical here, so replaying '
      + 'every migration automatically would be a guess, not a decision. No reset, drop, or '
      + 'reinitialize is required or suggested. Set '
      + 'PPBF_OFFLINE_ALLOW_EMPTY_HISTORY_RECOVERY=true for one verified local startup to '
      + 'reconcile the current migration set against this database.',
    );
  }

  const { applied } = await reconcile(client, { infraDir, workflowPath });
  return { applied, rounds: applied.length > 0 ? 1 : 0 };
}
