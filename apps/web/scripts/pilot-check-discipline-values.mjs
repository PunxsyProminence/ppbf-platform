import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only census of the discipline values the training-content tables
 * actually hold, and the question it answers is the one nobody can answer
 * from the repository: WHICH rows would a `validate constraint` refuse?
 *
 * #756, #757 and #758 added composite foreign keys from pilot.drill_library,
 * pilot.session_scripts and pilot.cohort_definitions to
 * pilot.disciplines(organization_id, discipline) -- deliberately NOT VALID.
 * That was the right call: a validating constraint could have refused to apply
 * against unmeasured production and taken a deploy down. But NOT VALID means
 * the existing rows were never scanned, so nothing has ever reported what is
 * in them, and Postgres reports only the FIRST offending key when a validation
 * fails. An operator running `validate constraint` today learns one row at a
 * time, from a database, in production.
 *
 * This answers it in advance, completely, and without touching anything.
 *
 * TWO DIFFERENT ANSWERS, REPORTED SEPARATELY, because they need different
 * actions:
 *
 *   AN EMPTY REGISTRY   The organization has no pilot.disciplines rows at all.
 *                       Every write to the three tables fails for it --
 *                       including writes that never name a discipline, because
 *                       the column default 'boxing' is itself a reference. The
 *                       fix is to seed the registry, not to touch any row.
 *
 *   AN UNKNOWN VALUE    The organization has a registry, and a row names
 *                       something absent from it -- 'general' being the value
 *                       the drill-library CHECK still admits and the registry
 *                       has never contained. The fix is an owner decision
 *                       about those specific rows. This script does not make
 *                       it, does not suggest one, and cannot: it has no write
 *                       path.
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

/**
 * The three tables carrying a discipline foreign key, with the constraint each
 * one's migration installs. Named rather than discovered so this census always
 * asks about precisely the constraints those three migrations add.
 */
const TABLES = [
  { table: 'drill_library', constraint: 'pilot_drill_library_discipline_fk' },
  { table: 'session_scripts', constraint: 'pilot_session_scripts_discipline_fk' },
  { table: 'cohort_definitions', constraint: 'pilot_cohortdef_discipline_fk' },
];

// High enough to be the complete set for any realistic accumulation, low
// enough that a pathological database cannot make this diagnostic print
// unboundedly. Exceeding it is REPORTED, never silent -- the multiorg orphan
// check records what a quiet `limit 10` cost: ten ids named, covering 23 of 43
// rows, and a cleanup built from that list would have missed twenty.
const DISTINCT_LIMIT = 500;

/** Organizations holding content rows but no discipline registry at all. */
async function findEmptyRegistries(client) {
  const result = await client.query(
    `select o.organization_id, count(*)::int as row_count
     from (
       ${TABLES.map(({ table }) =>
         `select organization_id from pilot.${table}`).join('\n       union all\n       ')}
     ) o
     where not exists (
       select 1 from pilot.disciplines d where d.organization_id = o.organization_id
     )
     group by o.organization_id
     order by row_count desc, o.organization_id
     limit ${DISTINCT_LIMIT + 1}`,
  );
  return result.rows;
}

/** Rows naming a discipline the organization's registry does not contain. */
async function findUnknownValues(client, table) {
  const result = await client.query(
    `select t.organization_id, t.discipline, count(*)::int as row_count
     from pilot.${table} t
     where exists (
       select 1 from pilot.disciplines d where d.organization_id = t.organization_id
     )
     and not exists (
       select 1 from pilot.disciplines d
       where d.organization_id = t.organization_id and d.discipline = t.discipline
     )
     group by t.organization_id, t.discipline
     order by row_count desc, t.organization_id, t.discipline
     limit ${DISTINCT_LIMIT + 1}`,
  );
  return result.rows;
}

/** Whether each constraint exists yet, and whether it has been validated. */
async function findConstraintStates(client) {
  const result = await client.query(
    `select conname, convalidated
     from pg_constraint
     where conname = any($1::text[])`,
    [TABLES.map(({ constraint }) => constraint)],
  );
  return new Map(result.rows.map((row) => [row.conname, row.convalidated]));
}

export async function checkDisciplineValues(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const constraintStates = await findConstraintStates(client);

    const emptyRows = await findEmptyRegistries(client);
    const emptyTruncated = emptyRows.length > DISTINCT_LIMIT;
    const emptyRegistries = emptyTruncated ? emptyRows.slice(0, DISTINCT_LIMIT) : emptyRows;

    const tables = [];
    for (const { table, constraint } of TABLES) {
      const rows = await findUnknownValues(client, table);
      const truncated = rows.length > DISTINCT_LIMIT;
      const unknown = truncated ? rows.slice(0, DISTINCT_LIMIT) : rows;

      tables.push({
        table,
        constraint,
        constraintExists: constraintStates.has(constraint),
        constraintValidated: constraintStates.get(constraint) ?? false,
        unknown,
        truncated,
        unknownRowCount: unknown.reduce((sum, row) => sum + row.row_count, 0),
      });
    }

    await client.query('COMMIT');

    return {
      emptyRegistries,
      emptyTruncated,
      emptyRegistryRowCount: emptyRegistries.reduce((sum, row) => sum + row.row_count, 0),
      tables,
      blockingRowCount:
        emptyRegistries.reduce((sum, row) => sum + row.row_count, 0)
        + tables.reduce((sum, entry) => sum + entry.unknownRowCount, 0),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await checkDisciplineValues(client);
  } finally {
    await client.end();
  }

  console.log('Discipline value census');
  console.log('=======================');

  console.log('Constraint state:');
  for (const { table, constraint, constraintExists, constraintValidated } of report.tables) {
    const state = !constraintExists
      ? 'NOT INSTALLED -- the migration has not been applied here'
      : constraintValidated
        ? 'VALIDATED -- every existing row already satisfies it'
        : 'NOT VALID -- installed, enforcing new writes, existing rows never scanned';
    console.log(`    pilot.${table} (${constraint}): ${state}`);
  }
  console.log('');

  console.log(
    `Organizations with NO discipline registry: ${report.emptyRegistries.length}`
    + (report.emptyRegistries.length > 0 ? ` (${report.emptyRegistryRowCount} content row(s))` : ''),
  );
  for (const { organization_id: orgId, row_count: rowCount } of report.emptyRegistries) {
    console.log(`    organization_id=${JSON.stringify(orgId)} -> ${rowCount} row(s) across the three tables`);
  }
  if (report.emptyTruncated) {
    console.log(
      `    !! more than ${DISTINCT_LIMIT} organizations -- list above is TRUNCATED and incomplete`,
    );
  }
  console.log('');

  for (const { table, unknown, truncated, unknownRowCount } of report.tables) {
    console.log(
      `pilot.${table}: ${unknownRowCount} row(s) naming a discipline the registry does not hold`
      + (unknown.length > 0 ? `, across ${unknown.length} distinct (organization, discipline) pair(s)` : ''),
    );
    for (const { organization_id: orgId, discipline, row_count: rowCount } of unknown) {
      console.log(
        `    organization_id=${JSON.stringify(orgId)} discipline=${JSON.stringify(discipline)} -> ${rowCount} row(s)`,
      );
    }
    if (truncated) {
      console.log(
        `    !! more than ${DISTINCT_LIMIT} distinct pairs -- list above is TRUNCATED and incomplete`,
      );
    }
  }
  console.log('=======================');

  if (report.blockingRowCount === 0) {
    console.log('PILOT DISCIPLINE VALUE CENSUS: CLEAN');
    console.log(
      'Every discipline value in the three tables resolves to a registry row. '
      + '`validate constraint` on all three would succeed against this database.',
    );
  } else {
    console.log(`PILOT DISCIPLINE VALUE CENSUS: UNRESOLVED VALUES (${report.blockingRowCount} row(s))`);
    console.log(
      '`validate constraint` WILL fail on this database, and Postgres would name only the '
      + 'first offending row. Every one is listed above. What should happen to them is an '
      + 'owner decision -- this script does not map, convert, or delete anything.',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { blockingRowCount } = await run();
    // Exits non-zero on values found, not on a script error -- this is a gate
    // result, not a crash, and CI should show it as a stop sign rather than a
    // passing diagnostic that happened to print a warning.
    process.exit(blockingRowCount === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT DISCIPLINE VALUE CENSUS FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
