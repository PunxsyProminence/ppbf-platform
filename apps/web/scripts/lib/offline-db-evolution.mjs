import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_INFRA_DIR, listMigrationFiles } from './full-schema.mjs';

const HISTORY_TABLE = 'pilot.offline_runtime_schema_history';

function digest(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

async function migrationManifest(infraDir = DEFAULT_INFRA_DIR) {
  const files = await listMigrationFiles(infraDir);
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

function validateRecordedHistory(current, recorded) {
  const byFile = new Map(current.map((entry) => [entry.file, entry]));

  for (const row of recorded) {
    const entry = byFile.get(row.migration_file);
    if (!entry) {
      throw new Error(
        `Recorded offline migration ${row.migration_file} is missing from the current checkout.`,
      );
    }
    if (entry.sha256 !== row.sha256) {
      throw new Error(
        `Recorded offline migration ${row.migration_file} changed after it was recorded.`,
      );
    }
  }
}

export async function baselineMigrationHistory(
  client,
  { infraDir = DEFAULT_INFRA_DIR } = {},
) {
  const current = await migrationManifest(infraDir);

  if (await hasMigrationHistory(client)) {
    const recorded = await historyRows(client);
    if (recorded.length === 0 && current.length > 0) {
      throw new Error('Offline migration history exists but is empty; refusing implicit baseline.');
    }
    validateRecordedHistory(current, recorded);
    return { recorded: 0, total: recorded.length };
  }

  await client.query('BEGIN');
  try {
    await client.query(`
      create table ${HISTORY_TABLE} (
        migration_file text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const entry of current) {
      await client.query(
        `insert into ${HISTORY_TABLE} (migration_file, sha256) values ($1, $2)`,
        [entry.file, entry.sha256],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  return { recorded: current.length, total: current.length };
}

export async function applyPendingMigrations(
  client,
  { infraDir = DEFAULT_INFRA_DIR } = {},
) {
  if (!await hasMigrationHistory(client)) {
    throw new Error(
      'Existing PPBF offline database has no migration history. Explicit baseline is required.',
    );
  }

  const current = await migrationManifest(infraDir);
  const recorded = await historyRows(client);

  if (recorded.length === 0 && current.length > 0) {
    throw new Error('Offline migration history exists but is empty; refusing migration replay.');
  }

  validateRecordedHistory(current, recorded);

  const recordedFiles = new Set(recorded.map((row) => row.migration_file));
  let pending = current.filter((entry) => !recordedFiles.has(entry.file));

  if (pending.length === 0) return { applied: [], rounds: 0 };

  const applied = [];
  const lastError = new Map();
  let rounds = 0;

  while (pending.length > 0) {
    rounds += 1;
    const stillPending = [];
    let placedThisRound = 0;

    for (const entry of pending) {
      try {
        await client.query('BEGIN');
        await client.query(entry.sql);
        await client.query(
          `insert into ${HISTORY_TABLE} (migration_file, sha256) values ($1, $2)`,
          [entry.file, entry.sha256],
        );
        await client.query('COMMIT');
        applied.push(entry.file);
        placedThisRound += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        lastError.set(
          entry.file,
          error instanceof Error ? error.message.split('\n')[0] : String(error),
        );
        stillPending.push(entry);
      }
    }

    pending = stillPending;

    if (pending.length > 0 && placedThisRound === 0) {
      const detail = pending
        .map((entry) => `  ${entry.file}: ${lastError.get(entry.file)}`)
        .join('\n');
      throw new Error(
        `Offline schema evolution could not place ${pending.length} migration(s):\n${detail}`,
      );
    }
  }

  return { applied, rounds };
}
