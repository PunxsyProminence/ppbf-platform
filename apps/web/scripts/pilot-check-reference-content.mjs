import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Shared with cue-source-provenance rather than copied, so there is one rule to
// audit, not two that can drift: an organization_id or created_by_role is free
// text, and a raw newline or `::warning::` in one would forge a line in the CI
// log. See the encoder's own header.
import { encodeSingleLineJson } from './lib/single-line-json.mjs';

/**
 * Read-only census of the reference content a database already holds, so the
 * first gym load is planned on counts rather than on what a handoff says.
 *
 * WHY THIS EXISTS. What is known about production's reference rows is REPORTED,
 * not observed: PRODUCTION_STATE.json:226 records the 2026-08-24 seed running as
 * Admin@ with the organization taken from the default-org secret, and until #997
 * the loaders wrote created_by_role from the CSV rather than from the account.
 * If those rows sit under ppbf-default-org, the gym (punxsy_prominence) cannot
 * see them, and a first load there inserts fresh v1 rows rather than new
 * versions. Nobody can answer that from the repository. This answers it, plus
 * the two numbers the load and the repair decision also wait on: how many
 * reference drills a gym has already adopted (pilot.drills.reference_drill_id)
 * or superseded, and how many drill rows carry the '|' claim-id defect -- the
 * seed loader stored 'A1-001|A2-002' as ONE element because its splitter did
 * not know '|' (the retired seed-drill-library.mjs split on ';' and ',' only).
 *
 * COUNTS ONLY. Each count is keyed by organization_id, and by created_by_role on
 * the tables that have that column -- those two keys ARE the question. Nothing
 * else is selected: no drill, template or script id, no name, no account id, no
 * email, no text. A count is the whole answer, and a census that printed more
 * than its purpose needs is one people are right to be nervous about running.
 *
 * A MISSING TABLE IS AN ANSWER, NOT AN ERROR. Every table is asked of the
 * catalog (to_regclass) before it is selected from, and every optional column
 * likewise, because an environment that never took a migration is a legitimate
 * state and the point is to find out which state production is in. Absent is
 * printed as `absent`, never as 0: a zero asserts an empty table.
 *
 * IT IS A REPORT, NOT A GATE. Nothing here needs a human decision to clear, so
 * it exits zero whenever it ran and the answer is the printed counts -- the same
 * contract seed-identity and cue-source-provenance carry (run-checks.yml header).
 *
 * SELECT ONLY, inside an explicit READ ONLY transaction, so Postgres itself
 * refuses any write this file could attempt. Safe to run against production;
 * running it there is still the owner's call per run.
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
 * Every table a reference-content load writes, in the order a reader thinks of
 * them: the drill library and its four child tables, templates, session scripts,
 * then the registries. Named rather than discovered, so the census always asks
 * about exactly these and a new table is added here on purpose. Constants only
 * -- they are interpolated into SQL, and nothing a caller supplies ever is.
 */
export const REFERENCE_TABLES = [
  'drill_library',
  'drill_scale_levels',
  'drill_stop_rules',
  'drill_cues',
  'drill_secondary_skills',
  'workout_templates',
  'workout_template_items',
  'session_scripts',
  'session_script_blocks',
  'session_script_renderings',
  'disciplines',
  'competence_levels',
  'cohort_definitions',
  'transfer_claims',
  'assessment_protocols',
];

/** The gym-side table that records adoption of a reference drill. */
const ADOPTION_TABLE = 'drills';

/**
 * Columns this census reads that are not on every version of the schema.
 * created_by_role is only on drill_library and workout_templates today
 * (drill_library_v3_migration.sql:135, workout_templates_v2_migration.sql:60);
 * it is looked up per table rather than hard-coded, so a later migration that
 * adds it elsewhere is picked up rather than silently ignored.
 */
const OPTIONAL_COLUMNS = ['created_by_role', 'superseded_at', 'grounding_claim_ids', 'reference_drill_id'];

// High enough to be every group any real database holds, low enough that a
// pathological one cannot make this print without bound. Exceeding it is
// REPORTED, never silent -- the multiorg orphan check records what a quiet
// `limit 10` cost. Totals come from a window over the whole table, so they stay
// complete even when the group list is cut.
export const GROUP_LIMIT = 500;

/** Which named tables exist, asked of the catalog rather than by selecting from them. */
async function readPresentTables(client, tables) {
  const result = await client.query(
    `select t.name, to_regclass('pilot.' || t.name) is not null as present
     from unnest($1::text[]) as t(name)`,
    [tables],
  );
  return new Set(result.rows.filter((row) => row.present).map((row) => row.name));
}

/**
 * Which optional columns each present table has. pg_attribute rather than
 * information_schema.columns, because the latter hides columns the connected
 * role holds no privilege on, and "no privilege" must not read as "absent".
 */
async function readColumns(client, tables) {
  const result = await client.query(
    `select c.relname as table_name, a.attname as column_name
     from pg_catalog.pg_attribute a
     join pg_catalog.pg_class c on c.oid = a.attrelid
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'pilot'
       and c.relname = any($1::text[])
       and a.attname = any($2::text[])
       and a.attnum > 0
       and not a.attisdropped`,
    [tables, OPTIONAL_COLUMNS],
  );
  const columns = new Map(tables.map((table) => [table, new Set()]));
  for (const row of result.rows) {
    columns.get(row.table_name)?.add(row.column_name);
  }
  return columns;
}

/**
 * Rows per organization_id (and created_by_role, when the table has it), plus
 * the table total. `where` is one of the fixed predicates below, never input.
 */
async function countGroups(client, table, { byRole, where = 'true' }) {
  const keys = byRole ? 'organization_id, created_by_role' : 'organization_id';
  const order = byRole ? 'organization_id, created_by_role nulls first' : 'organization_id';
  const result = await client.query(
    `select ${keys},
            count(*)::int as row_count,
            (sum(count(*)) over ())::int as table_total
     from pilot.${table}
     where ${where}
     group by ${keys}
     order by ${order}
     limit ${GROUP_LIMIT + 1}`,
  );
  const truncated = result.rows.length > GROUP_LIMIT;
  const rows = truncated ? result.rows.slice(0, GROUP_LIMIT) : result.rows;
  return {
    total: result.rows[0]?.table_total ?? 0,
    groups: rows.map((row) => (byRole
      ? { organization_id: row.organization_id, created_by_role: row.created_by_role, row_count: row.row_count }
      : { organization_id: row.organization_id, row_count: row.row_count })),
    truncated,
  };
}

/**
 * One filtered count keyed by organization_id, or the reason it could not be
 * asked: the table or the column it filters on is not in this database.
 */
async function countFiltered(client, { table, column, where }, present, columns) {
  if (!present.has(table)) return { table, column, state: 'table absent' };
  if (!columns.get(table)?.has(column)) return { table, column, state: 'column absent' };
  return { table, column, state: 'counted', ...(await countGroups(client, table, { byRole: false, where })) };
}

export async function checkReferenceContent(client) {
  // REPEATABLE READ as well as READ ONLY, for the reason
  // pilot-check-cue-source-provenance.mjs gives: this is many SELECTs, and under
  // READ COMMITTED each takes its own snapshot, so a seed committing mid-census
  // would give child-table counts that disagree with their parents. One snapshot
  // means the numbers describe one state of the database. The literal
  // `BEGIN TRANSACTION READ ONLY` is what checkDispatchCoverage.test.ts asserts.
  await client.query('BEGIN TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ');
  try {
    const allTables = [...REFERENCE_TABLES, ADOPTION_TABLE];
    const present = await readPresentTables(client, allTables);
    const columns = await readColumns(client, allTables);

    const tables = [];
    for (const table of REFERENCE_TABLES) {
      if (!present.has(table)) {
        tables.push({ table, present: false });
        continue;
      }
      const byRole = columns.get(table).has('created_by_role');
      tables.push({ table, present: true, byRole, ...(await countGroups(client, table, { byRole })) });
    }

    const adopted = await countFiltered(
      client,
      { table: ADOPTION_TABLE, column: 'reference_drill_id', where: 'reference_drill_id is not null' },
      present,
      columns,
    );
    const superseded = await countFiltered(
      client,
      { table: 'drill_library', column: 'superseded_at', where: 'superseded_at is not null' },
      present,
      columns,
    );
    // strpos, not LIKE: '|' is not a LIKE metacharacter today, but the question
    // is "does this element contain this character", and strpos says exactly
    // that with nothing to escape.
    const pipeClaimIds = await countFiltered(
      client,
      {
        table: 'drill_library',
        column: 'grounding_claim_ids',
        where: `exists (
          select 1 from unnest(grounding_claim_ids) as g(claim_id) where strpos(g.claim_id, '|') > 0
        )`,
      },
      present,
      columns,
    );

    await client.query('COMMIT');
    return { tables, adopted, superseded, pipeClaimIds };
  } catch (error) {
    // Rollback failure must not mask the real error, same as the siblings.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function groupLine(group) {
  const role = 'created_by_role' in group
    ? ` created_by_role=${encodeSingleLineJson(group.created_by_role)}`
    : '';
  return `    organization_id=${encodeSingleLineJson(group.organization_id)}${role} -> ${group.row_count}`;
}

function truncationLine(truncated) {
  return truncated
    ? [`    !! more than ${GROUP_LIMIT} groups -- list above is TRUNCATED; the total is complete`]
    : [];
}

function filteredLines(label, entry) {
  const target = `pilot.${entry.table}.${entry.column}`;
  if (entry.state !== 'counted') {
    return [`${label}: absent (${entry.state === 'table absent' ? `pilot.${entry.table}` : target} not in this database)`];
  }
  return [
    `${label}: ${entry.total} row(s)`,
    ...entry.groups.map(groupLine),
    ...truncationLine(entry.truncated),
  ];
}

/**
 * Everything run() prints, as lines. Exported so the test asserts on the exact
 * text a CI log would carry -- including that no row identifier is in it --
 * rather than on a copy of this logic.
 */
export function formatReport(report) {
  const lines = [
    'Reference content census',
    '========================',
    'Counts only, keyed by organization_id (and created_by_role where the table has it).',
    '',
  ];

  for (const entry of report.tables) {
    if (!entry.present) {
      lines.push(`pilot.${entry.table}: absent`);
      continue;
    }
    const keys = entry.byRole ? 'organization_id, created_by_role' : 'organization_id';
    lines.push(`pilot.${entry.table}: ${entry.total} row(s), by ${keys}`);
    lines.push(...entry.groups.map(groupLine), ...truncationLine(entry.truncated));
  }

  lines.push('');
  lines.push(...filteredLines('Adopted by a gym (pilot.drills.reference_drill_id set)', report.adopted));
  lines.push(...filteredLines('Superseded versions (pilot.drill_library.superseded_at set)', report.superseded));
  lines.push(...filteredLines(
    "Claim-id defect (pilot.drill_library rows with a grounding_claim_ids element containing '|')",
    report.pipeClaimIds,
  ));
  lines.push('========================');
  lines.push('PILOT REFERENCE CONTENT CENSUS PASS');
  return lines;
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await checkReferenceContent(client);
  } finally {
    await client.end();
  }

  for (const line of formatReport(report)) {
    console.log(line);
  }
  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    // No process.exit on success, for the reason cue-source-provenance gives: a
    // forced exit can cut stdout off mid-flush and lose the counts.
    await run();
  } catch (error) {
    console.error('PILOT REFERENCE CONTENT CENSUS FAILED TO RUN');
    console.error(String(error));
    process.exitCode = 1;
  }
}
