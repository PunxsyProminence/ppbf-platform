import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only diagnostic for the question PR #52 raised and deliberately left
 * open: the multi-org migration's eight `organization_id` foreign keys have
 * never actually been added to any real database (the ADD CONSTRAINT IF NOT
 * EXISTS syntax that was supposed to add them is not valid PostgreSQL, so it
 * has failed identically on every attempt). Adding them for the first time
 * will fail if any row's organization_id does not resolve to a real
 * pilot.organizations row -- and whether that is true is a data question this
 * script answers, without touching the schema or any row.
 *
 * This performs SELECT statements only, inside an explicit READ ONLY
 * transaction, so it is safe to run directly against production: there is no
 * code path in this file that can mutate anything.
 */

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// The exact eight tables and constraint names from
// pilot_slice_postgres_multiorg_migration.sql, so a check here always asks
// about precisely the foreign keys that migration adds -- not a
// hand-maintained list that could drift from it.
const TABLES = [
  'accounts',
  'session_tokens',
  'athletes',
  'goals',
  'sessions',
  'coach_reviews',
  'shadow_intake',
  'audit_events',
];

// High enough to be the complete set for any realistic accumulation of stray
// ids, low enough that a pathological database cannot make this diagnostic
// print unboundedly. Exceeding it is reported, never silent.
const DISTINCT_ID_LIMIT = 500;

export async function checkOrphans(client) {
  const results = [];

  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    for (const table of TABLES) {
      const countResult = await client.query(
        `select count(*)::int as orphan_count
         from pilot.${table} t
         where t.organization_id is not null
           and not exists (
             select 1 from pilot.organizations o where o.organization_id = t.organization_id
           )`,
      );
      const orphanCount = countResult.rows[0].orphan_count;

      let sample = [];
      let truncated = false;
      if (orphanCount > 0) {
        // Enumerates EVERY distinct orphaned organization_id, not a top-N
        // sample. The original `limit 10` made this check answer "are there
        // orphans" but not "which ones", and resolving them needs the complete
        // set: the first production run reported 43 orphaned rows in
        // pilot.accounts while naming ten ids covering only 23 of them, so 20
        // rows belonged to ids the output never mentioned. A cleanup built from
        // that list would silently miss them and the migration would still
        // fail.
        //
        // Bounded anyway, because an unbounded group-by against an unknown
        // database is not something a diagnostic should promise -- but when the
        // bound is hit it is REPORTED rather than quietly applied, so the
        // output can never read as complete when it is not.
        const sampleResult = await client.query(
          `select t.organization_id, count(*)::int as row_count
           from pilot.${table} t
           where t.organization_id is not null
             and not exists (
               select 1 from pilot.organizations o where o.organization_id = t.organization_id
             )
           group by t.organization_id
           order by row_count desc, t.organization_id
           limit ${DISTINCT_ID_LIMIT + 1}`,
        );
        truncated = sampleResult.rows.length > DISTINCT_ID_LIMIT;
        sample = truncated ? sampleResult.rows.slice(0, DISTINCT_ID_LIMIT) : sampleResult.rows;
      }

      results.push({ table, orphanCount, sample, truncated });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  return results;
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  let results;
  try {
    results = await checkOrphans(client);
  } finally {
    await client.end();
  }

  const totalOrphans = results.reduce((sum, r) => sum + r.orphanCount, 0);

  console.log('Multi-org organization_id orphan check');
  console.log('======================================');
  for (const { table, orphanCount, sample, truncated } of results) {
    const named = sample.reduce((sum, row) => sum + row.row_count, 0);
    console.log(
      `pilot.${table}: ${orphanCount} orphaned row(s)`
      + (orphanCount > 0 ? ` across ${sample.length} distinct organization_id(s)` : ''),
    );
    for (const { organization_id: orgId, row_count: rowCount } of sample) {
      console.log(`    organization_id=${JSON.stringify(orgId)} -> ${rowCount} row(s)`);
    }
    if (truncated) {
      console.log(
        `    !! more than ${DISTINCT_ID_LIMIT} distinct ids -- list above is TRUNCATED and incomplete`,
      );
    } else if (orphanCount > 0 && named !== orphanCount) {
      // Should be unreachable now the enumeration is complete. If it ever
      // fires, the ids above do not account for every orphaned row and any
      // cleanup derived from them would leave the migration still failing --
      // so say so rather than let the numbers quietly disagree.
      console.log(
        `    !! ids above account for ${named} of ${orphanCount} row(s) -- output is inconsistent`,
      );
    }
  }
  console.log('======================================');

  if (totalOrphans === 0) {
    console.log('PILOT MULTIORG ORPHAN CHECK: CLEAN');
    console.log(
      'No orphaned organization_id values in any of the eight tables. '
      + 'Adding the eight foreign keys (pilot:apply-multiorg) will not fail on existing data.',
    );
  } else {
    console.log(`PILOT MULTIORG ORPHAN CHECK: ORPHANS FOUND (${totalOrphans} total row(s))`);
    console.log(
      'Applying pilot:apply-multiorg as-is WILL fail on one of the tables listed above with orphans. '
      + 'Resolve the data (reassign or remove those rows) before applying the migration.',
    );
  }

  return { totalOrphans, results };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { totalOrphans } = await run();
    // Exits non-zero on orphans found, not on a script error -- this is a
    // gate result, not a crash, and CI should show it as a stop sign rather
    // than a passing diagnostic that happened to print a warning.
    process.exit(totalOrphans === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT MULTIORG ORPHAN CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
