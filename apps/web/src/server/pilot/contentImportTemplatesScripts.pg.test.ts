// Workout templates and session scripts on the content-import engine
// (IMP-08): R2 for the two reference tables that DO hold versions, against the
// full migrated schema.
//
// Every test pins a failure the old loaders had (seed-workout-templates.mjs and
// seed-session-scripts.mjs, retired by IMP-10; git history keeps them) or a
// guarantee the engine makes:
//   - they said ON CONFLICT DO NOTHING, so a revised template or script was
//     skipped without a word. R2 says a changed item becomes a NEW VERSION and
//     the old one is kept.
//   - a package names a drill by its LINEAGE; stored, a template item must
//     name a real version -- the one current at load -- and a template must
//     not look "changed" just because one of its drills got a newer version
//     (the owner-flagged default: it keeps the version it was built with).
//   - a script run pins the version it started on (sessionScriptRuns.ts
//     startSessionScriptRun), so a revision must never touch that version's
//     blocks.
//   - authoring_state is lifecycle, not content: it never makes a version,
//     and a package can never retire a script.
//
// The drills the templates name are inserted by SQL, so this suite does not
// depend on the drill-library engine (IMP-07). Spins up the same disposable,
// local-only embedded Postgres the other pg suites use; it NEVER connects to
// production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import type { DbClient } from './contentImport/actor';
import { applyImport } from './contentImport/apply';
import { readDatasetFiles } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { versionId } from './contentImport/datasets/templateScriptVersions';
import { hex14, MINT } from './contentImport/ids';
import { sessionScriptLineageHeads } from './contentImport/lineage';
import { type ImportPlan, planImport } from './contentImport/plan';
import { ContentImportRefusal } from './contentImport/refusal';
import { insertLegacyGoldenRows, LEGACY_GOLDEN_TABLES, legacyGoldenFiles, legacyGoldenRows } from '../../testing/legacyLoaderGolden';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_templates_scripts';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-templates-scripts-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const TEMPLATES_CSV = 'workout-templates/seed_workout_templates.csv';
const ITEMS_CSV = 'workout-templates/seed_workout_template_items.csv';
const SCRIPTS_CSV = 'session-scripts/seed_session_scripts.csv';
const BLOCKS_CSV = 'session-scripts/seed_session_script_blocks.csv';
const RENDERINGS_CSV = 'session-scripts/seed_session_script_renderings.csv';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
/** A second connection: sees only what is COMMITTED. */
let observer: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });
  // Keep draining the server's output: a full pipe would stall it.
  serverProcess.stdout.resume();

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  observer = new Client({ connectionString: connectionStringFor(DATABASE) });
  await observer.connect();
});

afterAll(async () => {
  await observer?.end().catch(() => {});
  await client?.end().catch(() => {});
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Fixtures

async function createGym(organizationId: string): Promise<string> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict (organization_id) do nothing`,
    [organizationId],
  );
  const accountId = `admin@${organizationId}`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
     values ($1, 'organization_admin', $2, false, true)`,
    [accountId, organizationId],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'organization_admin', true)`,
    [accountId, organizationId],
  );
  return accountId;
}

async function plan(organizationId: string, actorAccountId: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId, files });
}

/** BEGIN, apply, COMMIT -- ROLLBACK on any throw. The caller shape the engine requires. */
async function applyCommitted(
  organizationId: string,
  actorAccountId: string,
  files: Record<string, string>,
  expectedPlanHash?: string,
  via: DbClient = client,
) {
  const hash = expectedPlanHash ?? (await plan(organizationId, actorAccountId, files)).planHash;
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client: via, organizationId, actorAccountId, files, expectedPlanHash: hash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** A gym with its disciplines (the drills', templates' and scripts' foreign keys need them), loaded through the engine. */
async function createGymWithDisciplines(organizationId: string): Promise<string> {
  const admin = await createGym(organizationId);
  await applyCommitted(organizationId, admin, readDatasetFiles(SEED_DATA_DIR, ['disciplines']));
  return admin;
}

function fixtureDrillId(label: string): string {
  return `drl_${hex14(`fixture drill:${label}`)}`;
}

/** v1 of a drill lineage, by SQL: the drill id IS the lineage key. */
async function insertDrill(
  organizationId: string,
  drillId: string,
  options: { lineageId?: string; version?: number; supersedes?: string; name?: string; contactLevel?: string } = {},
) {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name,
        category, target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level)
     values ($1,$2,$3,$4,$5,$6,'footwork','t','p','s','e','g','b',$7)`,
    [organizationId, drillId, options.lineageId ?? drillId, options.version ?? 1, options.supersedes ?? null, options.name ?? drillId, options.contactLevel ?? 'none'],
  );
}

/**
 * The committed drill's own contact_level (seed_drill_library.csv). A step
 * may not link a drill above it (step_contact_above_drill), so a gym holding
 * the committed steps needs their drills at their committed levels, as the
 * old drill loader stored them (src/testing/legacyLoaderGoldenData).
 */
function committedDrillContact(drillId: string): string {
  const table = readCsv(committedText('drill-library/seed_drill_library.csv'));
  const id = table.header.indexOf('drill_id');
  const contact = table.header.indexOf('contact_level');
  const record = table.records.find((row) => row.cells[id] === drillId);
  if (!record) throw new Error(`no committed drill ${drillId}`);
  return record.cells[contact] || 'none';
}

/**
 * A drill revision the way the drill engine writes one (IMP-07; content-import
 * migration (1)-(2)): the old head gets superseded_at FIRST and stays active
 * for gyms that adopted it, then v(n+1) keeps the name.
 */
async function reviseDrill(organizationId: string, lineageId: string, label: string): Promise<string> {
  const { rows } = await client.query<{ drill_id: string; version: number; name: string }>(
    `update pilot.drill_library set superseded_at = now()
      where organization_id = $1 and lineage_id = $2 and superseded_at is null
      returning drill_id, version, name`,
    [organizationId, lineageId],
  );
  expect(rows).toHaveLength(1);
  const newId = fixtureDrillId(`${lineageId}:${label}`);
  await insertDrill(organizationId, newId, { lineageId, version: rows[0].version + 1, supersedes: rows[0].drill_id, name: rows[0].name });
  return newId;
}

function committedText(relative: string): string {
  return readFileSync(path.join(SEED_DATA_DIR, relative), 'utf8');
}

/** A package file with the committed file's header and these rows. */
function csv(relative: string, rows: Record<string, string>[]): string {
  const { header } = readCsv(committedText(relative));
  return writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));
}

function templateRow(templateId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: '{{PPBF_ORG_ID}}',
    template_id: templateId,
    name: `Template ${templateId}`,
    session_type: 'technical',
    difficulty: 'beginner',
    age_band: 'youth_and_adult',
    duration_minutes: '45',
    intent: 'Build a guard before any punch.',
    requires_coach_authorization: 'false',
    created_by_account_id: '{{SEED_ACCOUNT_ID}}',
    ...overrides,
  };
}

function itemRow(templateId: string, ordinal: number, drillId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: '{{PPBF_ORG_ID}}',
    template_id: templateId,
    ordinal: String(ordinal),
    block: 'technical',
    drill_id: drillId,
    duration_minutes: '10',
    contact_level: 'none',
    ...overrides,
  };
}

function templatePackage(templates: Record<string, string>[], items: Record<string, string>[]): Record<string, string> {
  return { [TEMPLATES_CSV]: csv(TEMPLATES_CSV, templates), [ITEMS_CSV]: csv(ITEMS_CSV, items) };
}

function scriptRow(scriptId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: '{{PPBF_ORG_ID}}',
    script_id: scriptId,
    name: `Script ${scriptId}`,
    discipline: 'boxing',
    theme: 'See first',
    day_of_week: 'Wednesday',
    total_minutes: '60',
    contact_structure: 'non_contact',
    reset_protocol: 'Freeze. Back to stance. One sentence. One rep. Restart slower.',
    authoring_state: 'coach_reviewed',
    source_document: 'fixture',
    created_by_account_id: '{{SEED_ACCOUNT_ID}}',
    ...overrides,
  };
}

function blockRow(scriptId: string, order: number, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: '{{PPBF_ORG_ID}}',
    script_id: scriptId,
    block_order: String(order),
    start_offset_min: String((order - 1) * 10),
    end_offset_min: String(order * 10),
    block_label: `Block ${order}`,
    what_to_say: `Say ${order}`,
    block_kind: 'instruction',
    contact_level: 'none',
    ...overrides,
  };
}

function renderingRow(scriptId: string, format: string, body: string): Record<string, string> {
  return { organization_id: '{{PPBF_ORG_ID}}', script_id: scriptId, format, audience_note: 'Coach, in hand', body, generated_from_blocks: 'false' };
}

function scriptPackage(scripts: Record<string, string>[], blocks: Record<string, string>[], renderings: Record<string, string>[]): Record<string, string> {
  return { [SCRIPTS_CSV]: csv(SCRIPTS_CSV, scripts), [BLOCKS_CSV]: csv(BLOCKS_CSV, blocks), [RENDERINGS_CSV]: csv(RENDERINGS_CSV, renderings) };
}

async function templateVersions(organizationId: string, lineageId: string) {
  const { rows } = await observer.query<{
    template_id: string;
    version: number;
    supersedes_template_id: string | null;
    superseded: boolean;
    active: boolean;
    name: string;
    intent: string;
  }>(
    `select template_id, version, supersedes_template_id, superseded_at is not null as superseded, active, name, intent
       from pilot.workout_templates where organization_id = $1 and lineage_id = $2 order by version`,
    [organizationId, lineageId],
  );
  return rows;
}

async function templateItems(organizationId: string, templateId: string) {
  const { rows } = await observer.query<{ item_id: string; ordinal: number; drill_id: string | null; free_text_drill: string | null; coach_note: string | null }>(
    `select item_id, ordinal, drill_id, free_text_drill, coach_note
       from pilot.workout_template_items where organization_id = $1 and template_id = $2 order by ordinal`,
    [organizationId, templateId],
  );
  return rows;
}

/** Every template/script row's xmin: ANY write to a row, even of equal values, gives it a new one. */
async function rowVersions(organizationId: string): Promise<Record<string, string>> {
  const { rows } = await observer.query<{ key: string; xmin: string }>(
    `select 'template:' || template_id as key, xmin::text as xmin from pilot.workout_templates where organization_id = $1
     union all select 'item:' || item_id, xmin::text from pilot.workout_template_items where organization_id = $1
     union all select 'script:' || script_id, xmin::text from pilot.session_scripts where organization_id = $1
     union all select 'block:' || block_id, xmin::text from pilot.session_script_blocks where organization_id = $1
     union all select 'rendering:' || rendering_id, xmin::text from pilot.session_script_renderings where organization_id = $1`,
    [organizationId],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.xmin]));
}

async function contentImportAuditRows(organizationId: string) {
  const { rows } = await observer.query<{ details: { datasets: string[]; counts: Record<string, Record<string, number>> } }>(
    "select details from pilot.audit_events where organization_id = $1 and entity_type = 'content_import' order by created_at",
    [organizationId],
  );
  return rows;
}

function unitOf(result: ImportPlan, dataset: string, key: string) {
  return result.units.find((unit) => unit.dataset === dataset && unit.key === key);
}

// ---------------------------------------------------------------------------

describe('the rows the OLD loaders wrote, as production holds them', () => {
  // Production's templates and scripts were written by the retired
  // seed-workout-templates.mjs and seed-session-scripts.mjs, and a row nobody
  // revises keeps their stored form for good. These rows are those loaders'
  // own output, frozen with the files they read
  // (src/testing/legacyLoaderGolden.ts): the loaders themselves are gone, and
  // an engine first load would only show the engine reading its own forms.
  const DATASETS = ['workout-templates', 'session-scripts'] as const;
  const OLD_TABLES = [...LEGACY_GOLDEN_TABLES.templates, ...LEGACY_GOLDEN_TABLES.scripts];
  const oldRowCount = (table: string) => legacyGoldenRows(table).length;

  /** Every drill the old rows' template items and script blocks name, as a v1 head: their foreign keys need one. */
  const oldDrillIds = () =>
    [
      ...new Set(
        [...legacyGoldenRows('pilot.workout_template_items'), ...legacyGoldenRows('pilot.session_script_blocks')]
          .map((row) => row.drill_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ].sort();

  /** A gym with the old loaders' disciplines and the drills their rows name; `withOldRows` adds their templates and scripts. */
  async function gymForOldRows(organizationId: string, withOldRows: boolean): Promise<string> {
    const admin = await createGym(organizationId);
    const target = { organizationId, accountId: admin };
    await insertLegacyGoldenRows(client, ['pilot.disciplines'], target);
    for (const drillId of oldDrillIds()) await insertDrill(organizationId, drillId, { contactLevel: committedDrillContact(drillId) });
    if (withOldRows) await insertLegacyGoldenRows(client, OLD_TABLES, target);
    return admin;
  }

  it('re-importing the files they read finds every item unchanged and writes nothing', async () => {
    // The canonicaliser guard: the old loaders stored an item's '8.0' as 8,
    // 'False' as false and a blank coach_notes as NULL. If the engine read any
    // of that as different content, a load would "revise" every template and
    // script it was meant to leave alone.
    const admin = await gymForOldRows('gym_old_loaders', true);
    const before = await rowVersions('gym_old_loaders');
    expect(Object.keys(before)).toHaveLength(OLD_TABLES.reduce((sum, table) => sum + oldRowCount(table), 0));
    expect(oldRowCount('pilot.workout_template_items')).toBeGreaterThan(0);

    const planned = await plan('gym_old_loaders', admin, legacyGoldenFiles(DATASETS));
    expect(planned.blocking).toEqual([]);
    expect(planned.counts['workout-templates']).toEqual({ new: 0, new_version: 0, unchanged: oldRowCount('pilot.workout_templates'), absent: 0, reject: 0 });
    expect(planned.counts['session-scripts']).toEqual({ new: 0, new_version: 0, unchanged: oldRowCount('pilot.session_scripts'), absent: 0, reject: 0 });

    const result = await applyCommitted('gym_old_loaders', admin, legacyGoldenFiles(DATASETS), planned.planHash);
    expect(result.importId).toBeNull();
    expect(await rowVersions('gym_old_loaders')).toEqual(before);
  });

  it('a first load through the engine writes exactly the rows they wrote, ids included', async () => {
    // So the engine's WRITTEN form cannot drift from production's either: a
    // gym loaded after IMP-10 holds rows in the same form as one loaded
    // before it, and whatever reads these tables meets one form.
    await gymForOldRows('gym_old_rows', true);
    const admin = await gymForOldRows('gym_engine_rows', false);
    const result = await applyCommitted('gym_engine_rows', admin, legacyGoldenFiles(DATASETS));
    expect(result.plan.counts['workout-templates']).toMatchObject({ new: oldRowCount('pilot.workout_templates') });
    expect(result.plan.counts['session-scripts']).toMatchObject({ new: oldRowCount('pilot.session_scripts') });

    // Every column the content decides, row by row. Authorship and timestamps
    // differ by construction and are left out.
    const snapshot = async (organizationId: string) => {
      const read = async (sql: string) => (await observer.query(sql, [organizationId])).rows;
      return {
        templates: await read(
          `select template_id, lineage_id, version, supersedes_template_id, superseded_at, name, session_type, difficulty,
                  age_band, duration_minutes, intent, coach_notes, requires_coach_authorization, active, created_by_role
             from pilot.workout_templates where organization_id = $1 order by template_id`,
        ),
        items: await read(
          `select item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level, duration_minutes, rep_count,
                  contact_level, coach_note
             from pilot.workout_template_items where organization_id = $1 order by item_id`,
        ),
        scripts: await read(
          `select script_id, lineage_id, version, name, discipline, theme, phase, day_of_week, total_minutes, contact_structure,
                  target_group, prerequisite_note, reset_protocol, coach_priorities, frequent_phrases, authoring_state, source_document
             from pilot.session_scripts where organization_id = $1 order by script_id`,
        ),
        blocks: await read(
          `select block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, what_to_say, what_to_explain,
                  what_to_watch, what_to_fix, block_kind, drill_id, scale_level, contact_level
             from pilot.session_script_blocks where organization_id = $1 order by block_id`,
        ),
        renderings: await read(
          `select rendering_id, script_id, format, audience_note, body, generated_from_blocks
             from pilot.session_script_renderings where organization_id = $1 order by rendering_id`,
        ),
      };
    };
    const engine = await snapshot('gym_engine_rows');
    expect(engine.items).toHaveLength(oldRowCount('pilot.workout_template_items'));
    expect(engine).toEqual(await snapshot('gym_old_rows'));
  });
});

describe('the committed templates and scripts', () => {
  const committedDrillIds = () => {
    const table = readCsv(committedText(ITEMS_CSV));
    const column = table.header.indexOf('drill_id');
    return [...new Set(table.records.map((record) => record.cells[column]).filter(Boolean))].sort();
  };
  const committedFiles = () => readDatasetFiles(SEED_DATA_DIR, ['workout-templates', 'session-scripts']);

  const committedIds = (file: string, column: string) => {
    const table = readCsv(committedText(file));
    const index = table.header.indexOf(column);
    return table.records.map((record) => record.cells[index]).filter(Boolean).sort();
  };

  it('a first load writes every committed row under its committed id, and loading again writes nothing', async () => {
    // The package as committed today, whatever a hand-off has changed since
    // the old loaders' files were frozen: every row lands under its committed
    // id (the ids production already holds -- a changed id would make a later
    // load see the item as new), and a second load plans nothing. Reading the
    // OLD loaders' stored forms is the describe block above.
    const admin = await createGymWithDisciplines('gym_engine_first');
    for (const drillId of committedDrillIds()) await insertDrill('gym_engine_first', drillId, { contactLevel: committedDrillContact(drillId) });
    const result = await applyCommitted('gym_engine_first', admin, committedFiles());
    const templates = committedIds(TEMPLATES_CSV, 'template_id');
    const scripts = committedIds(SCRIPTS_CSV, 'script_id');
    expect(result.plan.counts['workout-templates']).toMatchObject({ new: templates.length });
    expect(result.plan.counts['session-scripts']).toMatchObject({ new: scripts.length });

    const ids = async (table: string, column: string) =>
      (await observer.query(`select ${column} as id from pilot.${table} where organization_id = $1`, ['gym_engine_first'])).rows
        .map((row: { id: string }) => row.id)
        .sort();
    expect(await ids('workout_templates', 'template_id')).toEqual(templates);
    expect(await ids('workout_template_items', 'item_id')).toEqual(committedIds(ITEMS_CSV, 'item_id'));
    expect(await ids('session_scripts', 'script_id')).toEqual(scripts);
    expect(await ids('session_script_blocks', 'block_id')).toEqual(committedIds(BLOCKS_CSV, 'block_id'));
    expect(await ids('session_script_renderings', 'rendering_id')).toEqual(committedIds(RENDERINGS_CSV, 'rendering_id'));
    // Not vacuous: the committed files carry their ids.
    expect(committedIds(ITEMS_CSV, 'item_id').length).toBeGreaterThan(0);

    const before = await rowVersions('gym_engine_first');
    const planned = await plan('gym_engine_first', admin, committedFiles());
    expect(planned.blocking).toEqual([]);
    expect(planned.counts['workout-templates']).toEqual({ new: 0, new_version: 0, unchanged: templates.length, absent: 0, reject: 0 });
    expect(planned.counts['session-scripts']).toEqual({ new: 0, new_version: 0, unchanged: scripts.length, absent: 0, reject: 0 });
    const again = await applyCommitted('gym_engine_first', admin, committedFiles(), planned.planHash);
    expect(again.importId).toBeNull();
    expect(await rowVersions('gym_engine_first')).toEqual(before);
  });
});

describe('workout templates', () => {
  it('an item naming a drill lineage stores the head drill_id; a new:<name> template gets its minted id', async () => {
    const admin = await createGymWithDisciplines('gym_heads');
    const lineage = fixtureDrillId('jab');
    await insertDrill('gym_heads', lineage);
    const head = await reviseDrill('gym_heads', lineage, 'v2');

    const files = templatePackage(
      [templateRow('new:jab-basics', { name: 'Jab basics' })],
      [
        itemRow('new:jab-basics', 1, lineage),
        itemRow('new:jab-basics', 2, '', { free_text_drill: 'Shadowbox two rounds' }),
      ],
    );
    const minted = MINT.template('Jab basics');
    const result = await applyCommitted('gym_heads', admin, files);
    expect(unitOf(result.plan, 'workout-templates', minted)).toMatchObject({ packageKey: 'new:jab-basics', outcome: 'new', toVersion: 1 });
    expect(result.written['workout-templates']).toEqual({ inserted: [minted], updated: [], ledgerRows: 0 });

    expect(await templateVersions('gym_heads', minted)).toEqual([
      { template_id: minted, version: 1, supersedes_template_id: null, superseded: false, active: true, name: 'Jab basics', intent: 'Build a guard before any punch.' },
    ]);
    expect(await templateItems('gym_heads', minted)).toEqual([
      // The package named the LINEAGE; the row names the version current at load.
      { item_id: MINT.templateItem(minted, '1'), ordinal: 1, drill_id: head, free_text_drill: null, coach_note: null },
      { item_id: MINT.templateItem(minted, '2'), ordinal: 2, drill_id: null, free_text_drill: 'Shadowbox two rounds', coach_note: null },
    ]);
    const { rows } = await observer.query(
      'select created_by_account_id, created_by_role from pilot.workout_templates where organization_id = $1 and template_id = $2',
      ['gym_heads', minted],
    );
    expect(rows).toEqual([{ created_by_account_id: admin, created_by_role: 'organization_admin' }]);
  });

  // OD-2026-10-03-002 section 7: the AI workout prompt carries the gym's
  // current ACTIVE reference drills, and the upload refuses what the prompt
  // would never offer. A withdrawn head is still the head of its lineage
  // (lineage.ts), so the refusal is the validator's, not the head query's.
  it('an item naming a withdrawn drill is refused at plan with withdrawn_drill; the same step in words loads', async () => {
    const admin = await createGymWithDisciplines('gym_withdrawn_drill');
    const lineage = fixtureDrillId('retired-pivot');
    await insertDrill('gym_withdrawn_drill', lineage);
    await client.query("update pilot.drill_library set active = false where organization_id = 'gym_withdrawn_drill' and drill_id = $1", [lineage]);

    const linked = await plan('gym_withdrawn_drill', admin, templatePackage(
      [templateRow('new:pivot-day', { name: 'Pivot day' })],
      [itemRow('new:pivot-day', 1, lineage)],
    ));
    expect(linked.blocking.map((finding) => [finding.code, finding.file, finding.line, finding.column])).toEqual([
      ['withdrawn_drill', ITEMS_CSV, 2, 'drill_id'],
    ]);
    expect(linked.blocking[0].message).toContain('free_text_drill');

    const inWords = await applyCommitted('gym_withdrawn_drill', admin, templatePackage(
      [templateRow('new:pivot-day', { name: 'Pivot day' })],
      [itemRow('new:pivot-day', 1, '', { free_text_drill: 'Pivot off the lead foot, three rounds' })],
    ));
    expect(inWords.plan.blocking).toEqual([]);
    expect(inWords.written['workout-templates']).toEqual({ inserted: [MINT.template('Pivot day')], updated: [], ledgerRows: 0 });
  });

  // PR #1208's design: at plan the drill's own contact_level is read from
  // pilot.drill_library (lineage.ts), and a step linking it at more contact
  // is refused. The same step at the drill's level loads.
  it("an item above its linked drill's contact_level is refused at plan with step_contact_above_drill; at the drill's level it loads", async () => {
    const admin = await createGymWithDisciplines('gym_contact_above');
    const lineage = fixtureDrillId('pad-touch');
    await insertDrill('gym_contact_above', lineage, { contactLevel: 'light_technical' });

    const above = await plan('gym_contact_above', admin, templatePackage(
      [templateRow('new:pad-day', { name: 'Pad day' })],
      [itemRow('new:pad-day', 1, lineage, { contact_level: 'controlled_sparring', duration_minutes: '' })],
    ));
    expect(above.blocking.map((finding) => [finding.code, finding.file, finding.line, finding.column])).toEqual([
      ['step_contact_above_drill', ITEMS_CSV, 2, 'contact_level'],
    ]);

    const atLevel = await applyCommitted('gym_contact_above', admin, templatePackage(
      [templateRow('new:pad-day', { name: 'Pad day' })],
      [itemRow('new:pad-day', 1, lineage, { contact_level: 'light_technical' })],
    ));
    expect(atLevel.plan.blocking).toEqual([]);
    expect(atLevel.written['workout-templates']).toEqual({ inserted: [MINT.template('Pad day')], updated: [], ledgerRows: 0 });
  });

  it("a script block above its linked drill's contact_level is refused at plan", async () => {
    const admin = await createGymWithDisciplines('gym_contact_above_block');
    const lineage = fixtureDrillId('mirror-step');
    await insertDrill('gym_contact_above_block', lineage);

    const above = await plan('gym_contact_above_block', admin, scriptPackage(
      [scriptRow('new:mirror-night')],
      [blockRow('new:mirror-night', 1, { drill_id: lineage, contact_level: 'light_technical' })],
      [],
    ));
    expect(above.blocking.map((finding) => [finding.code, finding.file, finding.line, finding.column])).toEqual([
      ['step_contact_above_drill', BLOCKS_CSV, 2, 'contact_level'],
    ]);
  });

  it('a changed template creates v2 (active) and supersedes v1 (active=false, superseded_at); v1 keeps its items', async () => {
    const admin = await createGymWithDisciplines('gym_revise');
    const jab = fixtureDrillId('revise:jab');
    const cross = fixtureDrillId('revise:cross');
    await insertDrill('gym_revise', jab);
    await insertDrill('gym_revise', cross);
    const template = `wtp_${hex14('fixture template:revise')}`;
    // With item ids, as a committed file carries them: a revision must not reuse them.
    const v1Items = [
      itemRow(template, 1, jab, { item_id: MINT.templateItem(template, '1') }),
      itemRow(template, 2, cross, { item_id: MINT.templateItem(template, '2') }),
    ];
    await applyCommitted('gym_revise', admin, templatePackage([templateRow(template)], v1Items));

    // The jab drill gets a new version after the template was built.
    const jabV2 = await reviseDrill('gym_revise', jab, 'v2');

    const revised = templatePackage([templateRow(template, { intent: 'Guard first, then the jab.' })], v1Items);
    const planned = await plan('gym_revise', admin, revised);
    expect(planned.blocking).toEqual([]);
    expect(unitOf(planned, 'workout-templates', template)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });

    const result = await applyCommitted('gym_revise', admin, revised, planned.planHash);
    const v2 = versionId('wtp', template, 2);
    expect(result.written['workout-templates']).toEqual({ inserted: [], updated: [`${v2} (v2 of ${template})`], ledgerRows: 0 });

    expect(await templateVersions('gym_revise', template)).toEqual([
      { template_id: template, version: 1, supersedes_template_id: null, superseded: true, active: false, name: `Template ${template}`, intent: 'Build a guard before any punch.' },
      { template_id: v2, version: 2, supersedes_template_id: template, superseded: false, active: true, name: `Template ${template}`, intent: 'Guard first, then the jab.' },
    ]);
    // v1 is history, untouched: its items and the drill versions it was built with.
    expect(await templateItems('gym_revise', template)).toEqual([
      { item_id: MINT.templateItem(template, '1'), ordinal: 1, drill_id: jab, free_text_drill: null, coach_note: null },
      { item_id: MINT.templateItem(template, '2'), ordinal: 2, drill_id: cross, free_text_drill: null, coach_note: null },
    ]);
    // v2's items are re-minted under v2 and name each drill's CURRENT version.
    expect(await templateItems('gym_revise', v2)).toEqual([
      { item_id: MINT.templateItem(v2, '1'), ordinal: 1, drill_id: jabV2, free_text_drill: null, coach_note: null },
      { item_id: MINT.templateItem(v2, '2'), ordinal: 2, drill_id: cross, free_text_drill: null, coach_note: null },
    ]);
    // The coach browse lists `where active` (workoutTemplates.ts:78-82): exactly the new version.
    const browse = await observer.query("select template_id from pilot.workout_templates where organization_id = 'gym_revise' and active");
    expect(browse.rows).toEqual([{ template_id: v2 }]);

    // The same files again: nothing to do.
    const again = await plan('gym_revise', admin, revised);
    expect(again.counts['workout-templates']).toEqual({ new: 0, new_version: 0, unchanged: 1, absent: 0, reject: 0 });

    // A package names the LINEAGE, never a version.
    const byVersion = await plan('gym_revise', admin, templatePackage([templateRow(v2, { intent: 'x' })], []));
    expect(byVersion.blocking.map((finding) => [finding.code, finding.key])).toEqual([['bad_id', v2]]);
    expect(unitOf(byVersion, 'workout-templates', v2)?.outcome).toBe('reject');

    // Items alone revise the template they name: v3 carries v2's template row.
    const itemsOnly = { [ITEMS_CSV]: csv(ITEMS_CSV, [v1Items[0], { ...v1Items[1], coach_note: 'Rear hand back to the chin.' }]) };
    const third = await applyCommitted('gym_revise', admin, itemsOnly);
    expect(third.plan.counts['workout-templates']).toEqual({ new: 0, new_version: 1, unchanged: 0, absent: 0, reject: 0 });
    const v3 = versionId('wtp', template, 3);
    expect((await templateVersions('gym_revise', template)).map((row) => [row.template_id, row.version, row.active, row.superseded, row.supersedes_template_id, row.intent])).toEqual([
      [template, 1, false, true, null, 'Build a guard before any punch.'],
      [v2, 2, false, true, template, 'Guard first, then the jab.'],
      [v3, 3, true, false, v2, 'Guard first, then the jab.'],
    ]);
    expect((await templateItems('gym_revise', v3)).map((row) => [row.item_id, row.drill_id, row.coach_note])).toEqual([
      [MINT.templateItem(v3, '1'), jabV2, null],
      [MINT.templateItem(v3, '2'), cross, 'Rear hand back to the chin.'],
    ]);
  });

  it('a template is unchanged when only its drill got a newer version, and keeps the version it was built with', async () => {
    const admin = await createGymWithDisciplines('gym_pinned');
    const drill = fixtureDrillId('pinned:slip');
    await insertDrill('gym_pinned', drill);
    // Built on v2, whose id is NOT the lineage key, so the comparison has to
    // map the stored version back to its lineage to see "unchanged".
    const builtOn = await reviseDrill('gym_pinned', drill, 'v2');
    const template = `wtp_${hex14('fixture template:pinned')}`;
    const files = templatePackage([templateRow(template)], [itemRow(template, 1, drill)]);
    await applyCommitted('gym_pinned', admin, files);
    expect((await templateItems('gym_pinned', template)).map((row) => row.drill_id)).toEqual([builtOn]);
    const before = await rowVersions('gym_pinned');

    const newer = await reviseDrill('gym_pinned', drill, 'v3');
    expect(newer).not.toBe(builtOn);

    const planned = await plan('gym_pinned', admin, files);
    expect(planned.blocking).toEqual([]);
    const unit = unitOf(planned, 'workout-templates', template);
    expect(unit).toMatchObject({ outcome: 'unchanged' });
    expect(unit?.fileSha256).toBe(unit?.databaseSha256);

    const result = await applyCommitted('gym_pinned', admin, files, planned.planHash);
    expect(result.importId).toBeNull();
    expect(await rowVersions('gym_pinned')).toEqual(before);
    expect((await templateItems('gym_pinned', template)).map((row) => row.drill_id)).toEqual([builtOn]);
  });

  it('a withdrawn template stays withdrawn when its content is revised, and its name is free for a template with a different id', async () => {
    const admin = await createGymWithDisciplines('gym_withdrawn');
    const template = `wtp_${hex14('fixture template:withdrawn')}`;
    await applyCommitted('gym_withdrawn', admin, templatePackage([templateRow(template, { name: 'Pad rounds' })], []));
    await client.query("update pilot.workout_templates set active = false where organization_id = 'gym_withdrawn' and template_id = $1", [template]);

    const revised = await applyCommitted('gym_withdrawn', admin, templatePackage([templateRow(template, { name: 'Pad rounds', intent: 'Rhythm on the pads.' })], []));
    expect(unitOf(revised.plan, 'workout-templates', template)).toMatchObject({ outcome: 'new_version', toVersion: 2 });
    expect((await templateVersions('gym_withdrawn', template)).map((row) => [row.version, row.active, row.superseded])).toEqual([
      [1, false, true],
      [2, false, false],
    ]);

    // Only an ACTIVE row holds a name (pilot_workout_templates_one_active_name
    // is `where active`). This withdrawn template's id is a fixture id, not
    // MINT.template('Pad rounds'), so the new: one mints a different id; the
    // next test is the case where it does not.
    const added = await applyCommitted('gym_withdrawn', admin, templatePackage([templateRow('new:pad-rounds', { name: 'Pad rounds' })], []));
    expect(added.plan.blocking).toEqual([]);
    expect(await templateVersions('gym_withdrawn', MINT.template('Pad rounds'))).toMatchObject([{ version: 1, active: true, name: 'Pad rounds' }]);
  });

  it('a withdrawn template whose id comes from its name keeps that name: a new: template of the same name is refused, naming it', async () => {
    // Every committed template's id is MINT.template(name) (ids.ts), so this
    // is the case a real withdrawn template is in.
    const admin = await createGymWithDisciplines('gym_withdrawn_formula');
    await applyCommitted('gym_withdrawn_formula', admin, templatePackage([templateRow('new:pad-rounds', { name: 'Pad rounds' })], []));
    const withdrawn = MINT.template('Pad rounds');
    await client.query("update pilot.workout_templates set active = false where organization_id = 'gym_withdrawn_formula' and template_id = $1", [withdrawn]);

    // The same name mints the same id: this names the withdrawn template, it does not add one.
    const again = await plan('gym_withdrawn_formula', admin, templatePackage([templateRow('new:pad-rounds-again', { name: 'Pad rounds' })], []));
    expect(again.blocking.map((finding) => [finding.code, finding.file, finding.line])).toEqual([['minted_id_exists', TEMPLATES_CSV, 2]]);
    expect(again.blocking[0].message).toContain(`mints ${withdrawn}, which is already the committed item 'Pad rounds'.`);
    expect(unitOf(again, 'workout-templates', withdrawn)?.outcome).toBe('reject');

    // A different name is a different template.
    const other = await plan('gym_withdrawn_formula', admin, templatePackage([templateRow('new:pad-rounds-two', { name: 'Pad rounds two' })], []));
    expect(other.blocking).toEqual([]);
    expect(unitOf(other, 'workout-templates', MINT.template('Pad rounds two'))?.outcome).toBe('new');
  });

  it('a new template or script cannot take a child id the database already holds: refused at plan, at the row', async () => {
    const admin = await createGymWithDisciplines('gym_child_ids');
    const drill = fixtureDrillId('child-ids:jab');
    await insertDrill('gym_child_ids', drill);
    const original = `wtp_${hex14('fixture template:child-ids')}`;
    const takenItem = MINT.templateItem(original, '1');
    const script = `scr_${hex14('fixture script:child-ids')}`;
    const takenBlock = MINT.block(script, '1');
    await applyCommitted('gym_child_ids', admin, {
      ...templatePackage([templateRow(original)], [itemRow(original, 1, drill, { item_id: takenItem })]),
      ...scriptPackage([scriptRow(script)], [blockRow(script, 1, { block_id: takenBlock })], []),
    });
    const before = await rowVersions('gym_child_ids');

    // A copy of each that kept the original's child id.
    const copies = (itemId: string, blockId: string) => ({
      ...templatePackage([templateRow('new:copy', { name: 'Copy' })], [itemRow('new:copy', 1, drill, { item_id: itemId })]),
      ...scriptPackage([scriptRow('new:copy-script', { name: 'Copy script' })], [blockRow('new:copy-script', 1, { block_id: blockId })], []),
    });
    const copy = MINT.template('Copy');
    const copyScript = MINT.script('boxing', 'Copy script');
    const planned = await plan('gym_child_ids', admin, copies(takenItem, takenBlock));
    expect(planned.blocking.map((finding) => [finding.code, finding.file, finding.line, finding.column, finding.key])).toEqual([
      ['duplicate_id', ITEMS_CSV, 2, 'item_id', `${copy} / 1`],
      ['duplicate_id', BLOCKS_CSV, 2, 'block_id', `${copyScript} / 1`],
    ]);
    expect(planned.blocking[0].message).toContain(`item_id ${takenItem} is already used by template_id ${original}`);
    expect(planned.blocking[1].message).toContain(`block_id ${takenBlock} is already used by script_id ${script}`);
    expect(unitOf(planned, 'workout-templates', copy)).toMatchObject({ outcome: 'reject' });
    expect(unitOf(planned, 'workout-templates', copy)?.toVersion).toBeUndefined();
    expect(unitOf(planned, 'session-scripts', copyScript)?.outcome).toBe('reject');

    // The apply refuses the plan instead of failing on the primary key; nothing is written.
    await expect(applyCommitted('gym_child_ids', admin, copies(takenItem, takenBlock), planned.planHash)).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
    expect(await rowVersions('gym_child_ids')).toEqual(before);

    // Blank child ids: minted under the new ids, and the copies load.
    await applyCommitted('gym_child_ids', admin, copies('', ''));
    expect((await templateItems('gym_child_ids', copy)).map((row) => row.item_id)).toEqual([MINT.templateItem(copy, '1')]);
    const copyBlocks = await observer.query("select block_id from pilot.session_script_blocks where organization_id = 'gym_child_ids' and script_id = $1", [copyScript]);
    expect(copyBlocks.rows).toEqual([{ block_id: MINT.block(copyScript, '1') }]);
  });
});

describe('session scripts', () => {
  it('a changed script creates version+1 with new script, block and rendering ids; a run pinned to v1 keeps its blocks', async () => {
    const admin = await createGymWithDisciplines('gym_scripts');
    const script = `scr_${hex14('fixture script:wednesday')}`;
    const blocks = [blockRow(script, 1), blockRow(script, 2, { block_kind: 'drill_round' }), blockRow(script, 3, { block_kind: 'close', what_to_say: '' })];
    const renderings = [renderingRow(script, 'cheat_sheet', 'WEDNESDAY: see first.')];
    await applyCommitted('gym_scripts', admin, scriptPackage([scriptRow(script)], blocks, renderings));
    const v1Blocks = [1, 2, 3].map((order) => MINT.block(script, String(order)));

    // A coach started a run on v1: it pins script_id, script_version and its cursor block.
    await client.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on, run_state, started_at, current_block_id)
       values ('gym_scripts', 'ssrun_pinned_v1', $1, 1, $2, current_date, 'in_progress', now(), $3)`,
      [script, admin, v1Blocks[1]],
    );
    const before = await rowVersions('gym_scripts');

    const revised = scriptPackage([scriptRow(script, { theme: 'See first, then decide' })], blocks, renderings);
    const planned = await plan('gym_scripts', admin, revised);
    expect(planned.blocking).toEqual([]);
    expect(unitOf(planned, 'session-scripts', script)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });
    await applyCommitted('gym_scripts', admin, revised, planned.planHash);

    const v2 = versionId('scr', script, 2);
    const scripts = await observer.query(
      "select script_id, lineage_id, version, theme, authoring_state from pilot.session_scripts where organization_id = 'gym_scripts' order by version",
    );
    expect(scripts.rows).toEqual([
      { script_id: script, lineage_id: script, version: 1, theme: 'See first', authoring_state: 'coach_reviewed' },
      { script_id: v2, lineage_id: script, version: 2, theme: 'See first, then decide', authoring_state: 'coach_reviewed' },
    ]);
    // New ids for every child of v2; none shared with v1.
    const children = async (scriptId: string) => ({
      blocks: (await observer.query("select block_id, block_order, block_kind from pilot.session_script_blocks where organization_id = 'gym_scripts' and script_id = $1 order by block_order", [scriptId])).rows,
      renderings: (await observer.query("select rendering_id, format, body from pilot.session_script_renderings where organization_id = 'gym_scripts' and script_id = $1", [scriptId])).rows,
    });
    expect(await children(v2)).toEqual({
      blocks: [
        { block_id: MINT.block(v2, '1'), block_order: 1, block_kind: 'instruction' },
        { block_id: MINT.block(v2, '2'), block_order: 2, block_kind: 'drill_round' },
        { block_id: MINT.block(v2, '3'), block_order: 3, block_kind: 'close' },
      ],
      renderings: [{ rendering_id: MINT.rendering(v2, 'cheat_sheet'), format: 'cheat_sheet', body: 'WEDNESDAY: see first.' }],
    });
    expect((await children(script)).blocks.map((row) => row.block_id)).toEqual(v1Blocks);

    // Nothing of v1 was written: every row it had keeps its xmin.
    const after = await rowVersions('gym_scripts');
    for (const [key, xmin] of Object.entries(before)) expect([key, after[key]]).toEqual([key, xmin]);

    // The run still reads v1: its version, its cursor, and v1's blocks.
    const run = await observer.query(
      `select r.script_id, r.script_version, r.current_block_id, array_agg(b.block_id order by b.block_order) as blocks
         from pilot.session_script_runs r
         join pilot.session_script_blocks b on b.organization_id = r.organization_id and b.script_id = r.script_id
        where r.organization_id = 'gym_scripts' and r.run_id = 'ssrun_pinned_v1'
        group by r.script_id, r.script_version, r.current_block_id`,
    );
    expect(run.rows).toEqual([{ script_id: script, script_version: 1, current_block_id: v1Blocks[1], blocks: v1Blocks }]);

    // v2 is now the lineage's current version (a higher version supersedes).
    expect((await sessionScriptLineageHeads(observer, 'gym_scripts')).get(script)).toEqual({ lineageId: script, id: v2, version: 2 });
    expect((await plan('gym_scripts', admin, revised)).counts['session-scripts']).toEqual({ new: 0, new_version: 0, unchanged: 1, absent: 0, reject: 0 });

    // The script row alone: v3 carries v2's blocks and renderings, re-minted under v3.
    await applyCommitted('gym_scripts', admin, { [SCRIPTS_CSV]: csv(SCRIPTS_CSV, [scriptRow(script, { theme: 'Decide, then move' })]) });
    const v3 = versionId('scr', script, 3);
    expect(await children(v3)).toEqual({
      blocks: [
        { block_id: MINT.block(v3, '1'), block_order: 1, block_kind: 'instruction' },
        { block_id: MINT.block(v3, '2'), block_order: 2, block_kind: 'drill_round' },
        { block_id: MINT.block(v3, '3'), block_order: 3, block_kind: 'close' },
      ],
      renderings: [{ rendering_id: MINT.rendering(v3, 'cheat_sheet'), format: 'cheat_sheet', body: 'WEDNESDAY: see first.' }],
    });
    expect((await children(v2)).blocks.map((row) => row.block_id)).toEqual([1, 2, 3].map((order) => MINT.block(v2, String(order))));
  });

  it('authoring_state is lifecycle: a change to it alone writes nothing, retired is refused, a content change takes the file state', async () => {
    const admin = await createGymWithDisciplines('gym_lifecycle');
    const script = `scr_${hex14('fixture script:lifecycle')}`;
    const blocks = [blockRow(script, 1)];
    await applyCommitted('gym_lifecycle', admin, scriptPackage([scriptRow(script)], blocks, []));
    const before = await rowVersions('gym_lifecycle');

    // Lifecycle alone: unchanged, nothing written.
    const inUse = scriptPackage([scriptRow(script, { authoring_state: 'in_use' })], blocks, []);
    const lifecycleOnly = await plan('gym_lifecycle', admin, inUse);
    expect(unitOf(lifecycleOnly, 'session-scripts', script)).toMatchObject({ outcome: 'unchanged' });
    expect((await applyCommitted('gym_lifecycle', admin, inUse, lifecycleOnly.planHash)).importId).toBeNull();
    expect(await rowVersions('gym_lifecycle')).toEqual(before);

    // 'retired' in a file is refused, before anything could load it as a version.
    const retired = await plan('gym_lifecycle', admin, scriptPackage([scriptRow(script, { authoring_state: 'retired', theme: 'Last time' })], blocks, []));
    expect(retired.blocking.map((finding) => [finding.code, finding.file, finding.line])).toEqual([['row_rule', SCRIPTS_CSV, 2]]);
    expect(retired.blocking[0].message).toContain('retiring a script is a separate action');
    expect(unitOf(retired, 'session-scripts', script)?.outcome).toBe('reject');
    await expect(
      applyCommitted('gym_lifecycle', admin, scriptPackage([scriptRow(script, { authoring_state: 'retired', theme: 'Last time' })], blocks, []), retired.planHash),
    ).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
    expect(await rowVersions('gym_lifecycle')).toEqual(before);

    // A content change writes the new version with the file's state.
    await applyCommitted('gym_lifecycle', admin, scriptPackage([scriptRow(script, { authoring_state: 'in_use', theme: 'See, decide, move' })], blocks, []));
    // A script already retired stays retired: a package neither retires one nor brings it back.
    await client.query("update pilot.session_scripts set authoring_state = 'retired' where organization_id = 'gym_lifecycle' and version = 2");
    await applyCommitted('gym_lifecycle', admin, scriptPackage([scriptRow(script, { authoring_state: 'coach_reviewed', theme: 'Composure' })], blocks, []));

    const { rows } = await observer.query(
      "select version, theme, authoring_state from pilot.session_scripts where organization_id = 'gym_lifecycle' order by version",
    );
    expect(rows).toEqual([
      { version: 1, theme: 'See first', authoring_state: 'coach_reviewed' },
      { version: 2, theme: 'See, decide, move', authoring_state: 'retired' },
      { version: 3, theme: 'Composure', authoring_state: 'retired' },
    ]);
  });
});

describe('one transaction', () => {
  it('a failure after the template is written leaves neither the template nor the script changed; without it both commit together', async () => {
    const admin = await createGymWithDisciplines('gym_atomic');
    const drill = fixtureDrillId('atomic:guard');
    await insertDrill('gym_atomic', drill);
    const template = `wtp_${hex14('fixture template:atomic')}`;
    const script = `scr_${hex14('fixture script:atomic')}`;
    const files = (intent: string, theme: string) => ({
      ...templatePackage([templateRow(template, { intent })], [itemRow(template, 1, drill)]),
      ...scriptPackage([scriptRow(script, { theme })], [blockRow(script, 1)], []),
    });
    await applyCommitted('gym_atomic', admin, files('Guard.', 'See first'));
    const before = await rowVersions('gym_atomic');
    const auditBefore = (await contentImportAuditRows('gym_atomic')).length;

    const revised = files('Guard, then jab.', 'See, then decide');
    const shown = await plan('gym_atomic', admin, revised);
    expect(shown.changes).toBe(2);

    // Throws -- plain JavaScript, so Postgres does NOT abort the transaction
    // -- at the script insert, which comes after the template's old head was
    // superseded and its v2 inserted. A caller that committed anyway would
    // keep half a revision.
    const seen: string[] = [];
    const failing = {
      query: (...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
        seen.push(text.trim().split(/\s+/).join(' '));
        if (/^\s*insert into pilot\.session_scripts\b/i.test(text)) throw new Error('injected: a JavaScript failure after the template was written');
        return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as DbClient;
    await expect(applyCommitted('gym_atomic', admin, revised, shown.planHash, failing)).rejects.toThrow('injected');
    const at = (start: string) => seen.findIndex((statement) => statement.startsWith(start));
    expect(at('update pilot.workout_templates set superseded_at')).toBeGreaterThan(-1);
    expect(at('insert into pilot.workout_templates')).toBeGreaterThan(at('update pilot.workout_templates set superseded_at'));
    expect(at('insert into pilot.session_scripts')).toBeGreaterThan(at('insert into pilot.workout_templates'));

    expect(await rowVersions('gym_atomic')).toEqual(before);
    expect((await templateVersions('gym_atomic', template)).map((row) => [row.version, row.active, row.superseded])).toEqual([[1, true, false]]);
    expect(await contentImportAuditRows('gym_atomic')).toHaveLength(auditBefore);

    // The same plan, no failure: both revisions and one audit row, together.
    const result = await applyCommitted('gym_atomic', admin, revised, shown.planHash);
    expect(result.written).toEqual({
      'workout-templates': { inserted: [], updated: [`${versionId('wtp', template, 2)} (v2 of ${template})`], ledgerRows: 0 },
      'session-scripts': { inserted: [], updated: [`${versionId('scr', script, 2)} (v2 of ${script})`], ledgerRows: 0 },
    });
    const audits = await contentImportAuditRows('gym_atomic');
    expect(audits).toHaveLength(auditBefore + 1);
    expect(audits[audits.length - 1].details.datasets).toEqual(['workout-templates', 'session-scripts']);
  });

  it('holds the template and script a child-only package names, even when it writes nothing', async () => {
    // A package of items alone (or blocks alone) re-plans, and may revise, the
    // template (or script) they name, so apply must hold that row FOR UPDATE
    // like any row a root file names (apply.ts "THE ORDER", step 3).
    const admin = await createGymWithDisciplines('gym_child_locks');
    const template = `wtp_${hex14('fixture template:locks')}`;
    const script = `scr_${hex14('fixture script:locks')}`;
    const items = [itemRow(template, 1, '', { free_text_drill: 'Skip rope' })];
    const blocks = [blockRow(script, 1)];
    await applyCommitted('gym_child_locks', admin, { ...templatePackage([templateRow(template)], items), ...scriptPackage([scriptRow(script)], blocks, []) });

    const childOnly = { [ITEMS_CSV]: csv(ITEMS_CSV, items), [BLOCKS_CSV]: csv(BLOCKS_CSV, blocks) };
    const shown = await plan('gym_child_locks', admin, childOnly);
    expect(shown.blocking).toEqual([]);
    expect(shown.changes).toBe(0);

    const takeRow = (sql: string, id: string) => observer.query(`${sql} for update nowait`, ['gym_child_locks', id]);
    const templateRowSql = 'select 1 from pilot.workout_templates where organization_id = $1 and template_id = $2';
    const scriptRowSql = 'select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2';
    await client.query('BEGIN');
    try {
      const result = await applyImport({ client, organizationId: 'gym_child_locks', actorAccountId: admin, files: childOnly, expectedPlanHash: shown.planHash });
      expect(result.importId).toBeNull();
      // Another session cannot take either row while the import's transaction is open (55P03 lock_not_available).
      await expect(takeRow(templateRowSql, template)).rejects.toMatchObject({ code: '55P03' });
      await expect(takeRow(scriptRowSql, script)).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await client.query('ROLLBACK');
    }
    await expect(takeRow(templateRowSql, template)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('refuses a stale plan: a template revised after the plan was shown', async () => {
    const admin = await createGymWithDisciplines('gym_stale_template');
    const template = `wtp_${hex14('fixture template:stale')}`;
    await applyCommitted('gym_stale_template', admin, templatePackage([templateRow(template)], []));
    const revised = templatePackage([templateRow(template, { intent: 'Changed.' })], []);
    const shown = await plan('gym_stale_template', admin, revised);

    await client.query("update pilot.workout_templates set coach_notes = 'edited elsewhere' where organization_id = 'gym_stale_template'");
    const error = await applyCommitted('gym_stale_template', admin, revised, shown.planHash).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentImportRefusal);
    expect((error as ContentImportRefusal).code).toBe('STALE_PLAN');
    expect(await templateVersions('gym_stale_template', template)).toHaveLength(1);
  });
});
