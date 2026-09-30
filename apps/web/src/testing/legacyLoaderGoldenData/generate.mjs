// HOW rows.json AND inputs/ WERE MADE. Kept as the fixture's source, not run by
// any test or workflow: the loaders it runs were retired by IMP-10 and exist
// only in git history, so it runs against a `git archive` of an older commit.
//
//   git archive 943930d4d2ca307823f7c626d81e3eb7d1a2adf2 apps/web/scripts apps/web/seed-data infra/azure .github/workflows \
//     | tar -x -C <archive>
//   <archive>/node_modules -> this checkout's node_modules (a junction or symlink:
//     the archived loaders `import 'pg'`, resolved from where they sit)
//   node apps/web/src/testing/legacyLoaderGoldenData/generate.mjs <archive> <out> <commit>
//
// with TEMP/TMP pointed at an empty folder (the embedded server's stale-folder
// sweep reads it). It starts the embedded test Postgres (never a real
// database), builds the schema the archive's migrations define, runs the
// archive's loaders the way seed-reference-data.yml ran them, and writes
// <out>/inputs (the exact files the loaders read) and <out>/rows.json (every
// column they wrote, as Postgres's own text form, created_at/updated_at
// left out). ../legacyLoaderGolden.ts explains why the fixture exists.
//
// THE DRILLS ARE A SUBSET. The whole library is ~590 KB of CSV and its rows
// more again, so the drill inputs are the drills a greedy cover picks until
// every (file, column, value shape) the five drill files hold appears at
// least once -- blank, padded, '|' / ';' / ',' lists, integers, decimals,
// '2.0'-style whole numbers, each boolean spelling, JSON, dates, non-ASCII,
// and every value of a column with at most 12 distinct values -- plus all of
// each chosen drill's child rows. The subset files are the chosen records'
// original bytes, not a re-serialisation. As a check, the subset is loaded
// alone (organization A) and the whole library beside the templates
// (organization B), and the chosen drills' rows must be identical in both.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../scripts/test-embedded-pg-server.mjs');

const ORG_A = 'legacy_golden_a';
const ORG_B = 'legacy_golden_b';
const ACCOUNT = 'seed-admin@legacy_golden';

const REGISTRY_INPUTS = {
  multidiscipline: ['seed_disciplines.csv'],
  'competence-cohorts': ['seed_competence_levels.csv', 'seed_cohort_definitions.csv'],
  'workout-templates': ['seed_workout_templates.csv', 'seed_workout_template_items.csv'],
  'session-scripts': ['seed_session_scripts.csv', 'seed_session_script_blocks.csv', 'seed_session_script_renderings.csv'],
};
const DRILL_FILES = [
  'seed_drill_library.csv',
  'seed_drill_scale_levels.csv',
  'seed_drill_stop_rules.csv',
  'seed_drill_cues.csv',
  'seed_drill_secondary_skills.csv',
];
const ORG_A_TABLES = [
  'pilot.disciplines', 'pilot.competence_levels', 'pilot.cohort_definitions',
  'pilot.drill_library', 'pilot.drill_scale_levels', 'pilot.drill_stop_rules', 'pilot.drill_cues', 'pilot.drill_secondary_skills',
];
const ORG_B_TABLES = [
  'pilot.workout_templates', 'pilot.workout_template_items',
  'pilot.session_scripts', 'pilot.session_script_blocks', 'pilot.session_script_renderings',
];

/** RFC 4180 records with their original text, so a subset file keeps each record's bytes. */
function csvRecords(text) {
  const records = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const cells = [];
    let cell = '';
    let quoted = false;
    for (;;) {
      if (i >= text.length) { cells.push(cell); break; }
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        if (ch === '"') { quoted = false; i += 1; continue; }
        cell += ch; i += 1; continue;
      }
      if (ch === '"') { quoted = true; i += 1; continue; }
      if (ch === ',') { cells.push(cell); cell = ''; i += 1; continue; }
      if (ch === '\n') { cells.push(cell); i += 1; break; }
      cell += ch; i += 1;
    }
    const raw = text.slice(start, i).replace(/\n$/, '');
    if (raw !== '') records.push({ raw, cells });
  }
  return records;
}

function shapes(cell, categorical) {
  const tags = [];
  if (cell === '') tags.push('blank');
  if (cell !== cell.trim()) tags.push('padded');
  for (const [tag, pattern] of [['pipe', /\|/], ['semicolon', /;/], ['comma', /,/], ['newline', /\n/], ['quote', /"/], ['placeholder', /\{\{/],
    ['int', /^-?\d+$/], ['decimal', /^-?\d+\.\d+$/], ['whole-decimal', /^-?\d+\.0+$/], ['json', /^\s*[[{]/], ['date', /^\d{4}-\d{2}-\d{2}/], ['non-ascii', /[^\x00-\x7f]/]]) {
    if (pattern.test(cell)) tags.push(tag);
  }
  if (/^(true|false)$/i.test(cell)) tags.push(`bool:${cell}`);
  if (categorical) tags.push(`value:${cell}`);
  return tags.length > 0 ? tags : ['text'];
}

function drillSubset(seedData) {
  const files = DRILL_FILES.map((name) => {
    const text = fs.readFileSync(path.join(seedData, 'drill-library', name), 'utf8');
    if (text.includes('\r')) throw new Error(`${name} has CR bytes; the committed seed files are LF`);
    const [header, ...rows] = csvRecords(text);
    return { name, header, rows, drill: header.cells.indexOf('drill_id') };
  });
  const keysByDrill = new Map();
  for (const file of files) {
    const categorical = file.header.cells.map((_, index) => new Set(file.rows.map((row) => row.cells[index])).size <= 12);
    for (const row of file.rows) {
      const keys = keysByDrill.get(row.cells[file.drill]) ?? new Set();
      keysByDrill.set(row.cells[file.drill], keys);
      file.header.cells.forEach((column, index) => {
        for (const tag of shapes(row.cells[index] ?? '', categorical[index])) keys.add(`${file.name}:${column}:${tag}`);
      });
    }
  }
  const order = files[0].rows.map((row) => row.cells[files[0].drill]);
  const uncovered = new Set([...keysByDrill.values()].flatMap((keys) => [...keys]));
  const covered = uncovered.size;
  const chosen = [];
  while (uncovered.size > 0) {
    let best = null;
    let bestGain = 0;
    for (const id of order) {
      const gain = chosen.includes(id) ? 0 : [...(keysByDrill.get(id) ?? [])].filter((key) => uncovered.has(key)).length;
      if (gain > bestGain) { best = id; bestGain = gain; }
    }
    if (!best) throw new Error(`no drill covers: ${[...uncovered].join(', ')}`);
    chosen.push(best);
    for (const key of keysByDrill.get(best)) uncovered.delete(key);
  }
  const texts = Object.fromEntries(files.map((file) => [
    file.name,
    `${[file.header.raw, ...file.rows.filter((row) => chosen.includes(row.cells[file.drill])).map((row) => row.raw)].join('\n')}\n`,
  ]));
  return { chosen, covered, texts };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [SERVER, dataDir, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`Embedded Postgres did not become ready:\n${stderr}`)), 180_000);
    lines.on('line', (line) => {
      if (!line.includes('EMBEDDED_PG_READY')) return;
      clearTimeout(timer);
      lines.close();
      resolve();
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Embedded Postgres exited (${code}):\n${stderr}`)); });
  });
  child.stdout.resume();
  return child;
}

/** Every value as Postgres's own text output: '8.0' stays '8.0', an array stays '{a|b}'. */
const AS_TEXT = { getTypeParser: () => (value) => value };

async function dump(client, table, organizationId, extra = '', params = []) {
  const [schema, name] = table.split('.');
  const columns = (await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' and column_name not in ('created_at', 'updated_at')
      order by ordinal_position`,
    [schema, name],
  )).rows.map((row) => row.column_name);
  const key = (await client.query(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`,
    [table],
  )).rows.map((row) => `"${row.attname}"`);
  const { rows } = await client.query({
    text: `select ${columns.map((column) => `"${column}"`).join(', ')} from ${table} where organization_id = $1 ${extra} order by ${key.join(', ')}`,
    values: [organizationId, ...params],
    types: AS_TEXT,
    rowMode: 'array',
  });
  return { columns, rows };
}

/** Structure indented, one row per line: readable, and a regeneration diffs row by row. */
function formatRows(document) {
  const lines = ['{'];
  lines.push(`  "provenance": ${JSON.stringify(document.provenance, null, 2).replace(/\n/g, '\n  ')},`);
  lines.push(`  "organizationIds": ${JSON.stringify(document.organizationIds)},`);
  lines.push(`  "accountId": ${JSON.stringify(document.accountId)},`);
  lines.push('  "tables": {');
  const tables = Object.entries(document.tables);
  tables.forEach(([table, { columns, rows }], index) => {
    lines.push(`    ${JSON.stringify(table)}: {`);
    lines.push(`      "columns": ${JSON.stringify(columns)},`);
    lines.push('      "rows": [');
    rows.forEach((row, rowIndex) => lines.push(`        ${JSON.stringify(row)}${rowIndex < rows.length - 1 ? ',' : ''}`));
    lines.push('      ]');
    lines.push(`    }${index < tables.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const [archiveArg, outArg, commit] = process.argv.slice(2);
  if (!archiveArg || !outArg || !commit) throw new Error('usage: node generate.mjs <archive> <out> <commit>');
  const archive = path.resolve(archiveArg);
  const out = path.resolve(outArg);
  const web = path.join(archive, 'apps/web');
  const seedData = path.join(web, 'seed-data');

  const subset = drillSubset(seedData);
  const inputs = path.join(out, 'inputs');
  fs.rmSync(inputs, { recursive: true, force: true });
  fs.mkdirSync(path.join(inputs, 'drill-library'), { recursive: true });
  for (const [name, text] of Object.entries(subset.texts)) fs.writeFileSync(path.join(inputs, 'drill-library', name), text, 'utf8');
  for (const [folder, names] of Object.entries(REGISTRY_INPUTS)) {
    fs.mkdirSync(path.join(inputs, folder), { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(seedData, folder, name), path.join(inputs, folder, name));
  }

  const dataDir = path.join(os.tmpdir(), `ppbf-legacy-golden-pg-test-${Date.now()}`);
  const port = await freePort();
  const server = await startServer(dataDir, port);
  const url = (database) => `postgres://postgres:postgres@localhost:${port}/${database}`;
  const quiet = console.log;
  try {
    const admin = new pg.Client({ connectionString: url('postgres') });
    await admin.connect();
    await admin.query('create database legacy_golden');
    await admin.end();
    const client = new pg.Client({ connectionString: url('legacy_golden') });
    await client.connect();
    const { applyFullSchema } = await import(pathToFileURL(path.join(web, 'scripts/lib/full-schema.mjs')).href);
    await applyFullSchema(client, { infraDir: path.join(archive, 'infra/azure') });

    for (const organizationId of [ORG_A, ORG_B]) {
      await client.query("insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')", [organizationId]);
    }
    await client.query(
      "insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag) values ($1, 'organization_admin', $2, false, true)",
      [ACCOUNT, ORG_A],
    );
    for (const organizationId of [ORG_A, ORG_B]) {
      await client.query(
        "insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'organization_admin', true)",
        [ACCOUNT, organizationId],
      );
    }

    const loader = async (name) => (await import(pathToFileURL(path.join(web, 'scripts', `${name}.mjs`)).href)).seedAll;
    const [disciplines, cohorts, drills, secondary, templates, scripts] = await Promise.all(
      ['seed-disciplines', 'seed-competence-cohorts', 'seed-drill-library', 'seed-drill-secondary-skills', 'seed-workout-templates', 'seed-session-scripts'].map(loader),
    );
    const placeholders = (organizationId) => ({ organizationId, seedAccountId: ACCOUNT });
    console.log = () => undefined;
    // A: the registries and the drill subset, all from the files written above.
    await disciplines(client, path.join(inputs, 'multidiscipline'), placeholders(ORG_A));
    await cohorts(client, path.join(inputs, 'competence-cohorts'), placeholders(ORG_A));
    await drills(client, path.join(inputs, 'drill-library'), placeholders(ORG_A));
    await secondary(client, path.join(inputs, 'drill-library'), placeholders(ORG_A));
    // B: templates and scripts, over the WHOLE drill library -- their items name drills outside the subset.
    await disciplines(client, path.join(inputs, 'multidiscipline'), placeholders(ORG_B));
    await drills(client, path.join(seedData, 'drill-library'), placeholders(ORG_B));
    await secondary(client, path.join(seedData, 'drill-library'), placeholders(ORG_B));
    await templates(client, path.join(inputs, 'workout-templates'), placeholders(ORG_B));
    await scripts(client, path.join(inputs, 'session-scripts'), placeholders(ORG_B));
    console.log = quiet;

    const tables = {};
    for (const table of ORG_A_TABLES) tables[table] = await dump(client, table, ORG_A);
    for (const table of ORG_B_TABLES) tables[table] = await dump(client, table, ORG_B);
    for (const table of ORG_A_TABLES.filter((name) => name.startsWith('pilot.drill_'))) {
      const whole = await dump(client, table, ORG_B, 'and drill_id = any($2::text[])', [subset.chosen]);
      const org = whole.columns.indexOf('organization_id');
      const strip = ({ rows }) => JSON.stringify(rows.map((row) => row.filter((_, index) => index !== org)));
      if (strip(whole) !== strip(tables[table])) throw new Error(`${table}: the subset loaded alone differs from the same drills loaded with the whole library`);
    }
    await client.end();

    const provenance = {
      loadersFrom: commit,
      loaders: 'apps/web/scripts/seed-{disciplines,competence-cohorts,drill-library,drill-secondary-skills,workout-templates,session-scripts}.mjs',
      generator: 'apps/web/src/testing/legacyLoaderGoldenData/generate.mjs',
      drillSubset: { chosen: subset.chosen, coveredShapes: subset.covered },
    };
    fs.writeFileSync(
      path.join(out, 'rows.json'),
      formatRows({ provenance, organizationIds: [ORG_A, ORG_B], accountId: ACCOUNT, tables }),
      'utf8',
    );
    quiet(JSON.stringify({ ...provenance, rows: Object.fromEntries(Object.entries(tables).map(([table, { rows }]) => [table, rows.length])) }, null, 2));
  } finally {
    console.log = quiet;
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 15_000).unref();
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
