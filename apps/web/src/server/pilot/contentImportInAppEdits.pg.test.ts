// LANE IG, against the full migrated schema: a content import never silently
// supersedes a coach's in-app edit (OD-2026-11-19-005) and never carries an
// "In-app edit" label onto text it imports.
//
//   - a drill or a template whose current version a coach edited in the app is
//     HELD: nothing is written for it, the plan says why, and every other item
//     of the package still loads (a held item does not block);
//   - a package without label columns, or with child rows only (cues, template
//     items), is a revision too and is held the same way;
//   - a template step that links a held drill is judged against the coach's
//     kept version, not the package's;
//   - the dry run prints the held item, and the plan hash covers it: an edit
//     that lands after a plan was shown makes its apply STALE_PLAN;
//   - an edit recorded only in the audit log still counts.
//
// The edits are made through the real edit paths (drillLibraryEdit.ts,
// workoutTemplateEdit.ts). The engine's own unit half is contentImport/inAppEdits.test.ts. Spins up the same disposable, local-only embedded
// Postgres the other pg suites use; it NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

let activeConnectionString: string | null = null;

// The edit paths open their own transaction (db.ts withTransaction); here it is
// a connection of its own to the test database, so an edit commits for real.
jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const own = new Client({ connectionString: activeConnectionString });
    await own.connect();
    try {
      await own.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => own.query(text, values) });
        await own.query('COMMIT');
        return result;
      } catch (error) {
        await own.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await own.end();
    }
  }),
}));

import { applyImport } from './contentImport/apply';
import { formatPlan, readDatasetFiles, runApply } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import { ContentImportRefusal } from './contentImport/refusal';
import type { DatasetName } from './contentImport/types';
import { editLibraryDrill, parseDrillLibraryEdit } from './drillLibraryEdit';
import { editWorkoutTemplate, parseWorkoutTemplateEdit } from './workoutTemplateEdit';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_in_app_edits';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-in-app-edits-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions', 'pathway-catalog'];
const LIBRARY_CSV = 'drill-library/seed_drill_library.csv';
const CUES_CSV = 'drill-library/seed_drill_cues.csv';
const TEMPLATES_CSV = 'workout-templates/seed_workout_templates.csv';
const ITEMS_CSV = 'workout-templates/seed_workout_template_items.csv';
const LABEL_COLUMNS = ['field_labels', 'evidence', 'stage_keys'];

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let gyms = 0;

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

/** The loaded research claims, as the shared __platform__ library: the drills cite them. */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, rights_status)
     values ('src_ig_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/ig-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_ig_test', 'src_ig_test', '__platform__', 'Loaded research claims (test)', 'ig-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_ig_test', 'src_ig_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
            jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)`,
    [ids],
  );
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  serverProcess.stdout.resume();

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();
  client = new Client({ connectionString: connectionStringFor(DATABASE) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await loadPlatformClaims();
  activeConnectionString = connectionStringFor(DATABASE);
});

afterAll(async () => {
  activeConnectionString = null;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Fixtures

type Row = Record<string, string>;
type Files = Record<string, string>;

function rowsOf(files: Files, file: string): Row[] {
  const table = readCsv(files[file]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index] ?? ''])));
}

function withRows(files: Files, file: string, rows: Row[], header = readCsv(files[file]).header): Files {
  return { ...files, [file]: writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? ''))) };
}

/** The committed drill package cut down to three drills: D1 is at light_technical, D2 and D3 at none. */
const COMMITTED = readDatasetFiles(SEED_DATA_DIR, ['drill-library']);
const LIBRARY = rowsOf(COMMITTED, LIBRARY_CSV).filter((row) => row.discipline === 'boxing');
const D1 = (LIBRARY.find((row) => row.contact_level === 'light_technical') as Row).drill_id;
const [D2, D3] = LIBRARY.filter((row) => row.contact_level === 'none').slice(0, 2).map((row) => row.drill_id);
const PICKED = new Set([D1, D2, D3]);
const DRILLS: Files = Object.fromEntries(Object.keys(COMMITTED).map((file) => {
  const rows = rowsOf(COMMITTED, file).filter((row) => PICKED.has(row.drill_id));
  return [file, withRows(COMMITTED, file, rows)[file]];
}));

/** The drill package with these root columns changed for these drills. */
function drillsWith(changes: Record<string, Row>, files: Files = DRILLS): Files {
  return withRows(files, LIBRARY_CSV, rowsOf(files, LIBRARY_CSV).map((row) => ({ ...row, ...(changes[row.drill_id] ?? {}) })));
}

/** The same root file without its three label columns: a package written before labels existed. */
function withoutLabelColumns(files: Files, file: string): Files {
  return withRows(files, file, rowsOf(files, file), readCsv(files[file]).header.filter((name) => !LABEL_COLUMNS.includes(name)));
}

function csv(relative: string, rows: Row[]): string {
  const { header } = readCsv(readFileSync(path.join(SEED_DATA_DIR, relative), 'utf8'));
  return writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));
}

function templateRow(templateId: string, overrides: Row = {}): Row {
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

function itemRow(templateId: string, ordinal: number, drillId: string, overrides: Row = {}): Row {
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

const T1 = 'wtp_1a00000000000a';
const T2 = 'wtp_2b00000000000b';

function templates(items: Row[] = [itemRow(T1, 1, D2), itemRow(T2, 1, D3)], roots: Row[] = [templateRow(T1), templateRow(T2)]): Files {
  return { [TEMPLATES_CSV]: csv(TEMPLATES_CSV, roots), [ITEMS_CSV]: csv(ITEMS_CSV, items) };
}

async function createGym(): Promise<{ org: string; admin: string }> {
  gyms += 1;
  const org = `gym_ig_${gyms}`;
  const admin = `admin@${org}`;
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
     values ($1, 'organization_admin', $2, false, true)`,
    [admin, org],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'organization_admin', true)`,
    [admin, org],
  );
  await applyCommitted(org, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
  return { org, admin };
}

async function plan(org: string, admin: string, files: Files): Promise<ImportPlan> {
  return planImport({ client, organizationId: org, actorAccountId: admin, files });
}

async function applyCommitted(org: string, admin: string, files: Files, expectedPlanHash?: string) {
  const hash = expectedPlanHash ?? (await plan(org, admin, files)).planHash;
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client, organizationId: org, actorAccountId: admin, files, expectedPlanHash: hash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** A gym holding the three drills (and, when asked, the two templates) as an import left them. */
async function loadedGym(withTemplates = false) {
  const gym = await createGym();
  await applyCommitted(gym.org, gym.admin, withTemplates ? { ...DRILLS, ...templates() } : DRILLS);
  return gym;
}

async function head(org: string, table: 'drill_library' | 'workout_templates', lineage: string) {
  return (await client.query(
    `select * from pilot.${table} where organization_id = $1 and lineage_id = $2 and superseded_at is null`,
    [org, lineage],
  )).rows[0];
}

async function coachEditsDrill(org: string, lineage: string, body: Record<string, unknown>) {
  const current = await head(org, 'drill_library', lineage);
  return editLibraryDrill({
    organizationId: org,
    request: parseDrillLibraryEdit({ drill_id: current.drill_id, ...body }),
    actorAccountId: `coach@${org}`,
    actorRole: 'coach',
  });
}

async function coachEditsTemplate(org: string, lineage: string, body: Record<string, unknown>) {
  const current = await head(org, 'workout_templates', lineage);
  return editWorkoutTemplate({
    organizationId: org,
    request: parseWorkoutTemplateEdit({ template_id: current.template_id, ...body }),
    actorAccountId: `coach@${org}`,
    actorRole: 'coach',
  });
}

function unitOf(result: ImportPlan, dataset: DatasetName, key: string) {
  const unit = result.units.find((candidate) => candidate.dataset === dataset && candidate.key === key);
  if (!unit) throw new Error(`no ${dataset} unit ${key}`);
  return unit;
}

/** Every label row an IMPORT wrote for this gym that carries an in-app label. Must always be none. */
async function importedInAppLabels(org: string) {
  return (await client.query(
    `select target_kind, target_lineage_id, target_version from pilot.content_record_labels
      where organization_id = $1 and import_id not like 'in-app-edit:%' and field_labels::text like '%In-app edit%'`,
    [org],
  )).rows;
}

// ---------------------------------------------------------------------------

describe('a drill a coach edited in the app', () => {
  it('is held, says why, and the rest of the package still loads', async () => {
    const { org, admin } = await loadedGym();
    await coachEditsDrill(org, D1, { purpose: 'Coach purpose.' });

    const files = drillsWith({ [D1]: { purpose: 'Package purpose one.' }, [D2]: { purpose: 'Package purpose two.' } });
    const shown = await plan(org, admin, files);
    expect(shown.blocking).toEqual([]);
    const held = unitOf(shown, 'drill-library', D1);
    expect(held.outcome).toBe('held');
    expect(held.fromVersion).toBeUndefined();
    expect(held.toVersion).toBeUndefined();
    expect(held.reasons).toEqual([
      expect.stringMatching(/^kept: its current version v2 holds an in-app edit \(purpose\) by coach, \d{4}-\d{2}-\d{2}; the package's version was not loaded/),
    ]);
    expect(unitOf(shown, 'drill-library', D2)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });
    expect(unitOf(shown, 'drill-library', D3).outcome).toBe('unchanged');
    expect(shown.counts['drill-library']).toEqual({ new: 0, new_version: 1, unchanged: 1, absent: 0, reject: 0, held: 1 });
    expect(shown.changes).toBe(1);

    const lines = formatPlan(shown);
    expect(lines).toContain('  drill-library: 0 new, 1 new version, 1 unchanged, 0 absent, 0 reject, 1 held');
    expect(lines.find((line) => line.startsWith(`    held ${D1}: kept: its current version v2 holds an in-app edit`))).toBeDefined();

    const applied = await applyCommitted(org, admin, files, shown.planHash);
    expect(applied.audit?.details.held).toEqual({ 'drill-library': [D1] });

    // The coach's version is still the head; the other drill was revised.
    expect(await head(org, 'drill_library', D1)).toMatchObject({ version: 2, purpose: 'Coach purpose.', created_by_role: 'coach' });
    expect(await head(org, 'drill_library', D2)).toMatchObject({ version: 2, purpose: 'Package purpose two.' });
    expect(await importedInAppLabels(org)).toEqual([]);
  });

  it('is held when the package has no label columns, or only a child file -- no coach label lands on imported text', async () => {
    const { org, admin } = await loadedGym();
    await coachEditsDrill(org, D1, { execution: 'Coach execution.' });

    // No label columns: the stored labels would have stood in for them, the coach's included.
    const unlabelled = withoutLabelColumns(drillsWith({ [D1]: { purpose: 'Package purpose.' }, [D2]: { purpose: 'Package purpose two.' } }), LIBRARY_CSV);
    const first = await plan(org, admin, unlabelled);
    expect(first.blocking).toEqual([]);
    expect(unitOf(first, 'drill-library', D1).outcome).toBe('held');
    expect(unitOf(first, 'drill-library', D2).outcome).toBe('new_version');
    await applyCommitted(org, admin, unlabelled, first.planHash);

    // Child rows only: a cue change is a revision of the whole drill, and the root would be the coach's.
    const cuesOnly = { [CUES_CSV]: withRows(DRILLS, CUES_CSV, rowsOf(DRILLS, CUES_CSV).map((row) => (
      row.drill_id === D1 ? { ...row, cue_text: `${row.cue_text} (package)` } : row
    )))[CUES_CSV] };
    const second = await plan(org, admin, cuesOnly);
    expect(second.blocking).toEqual([]);
    expect(unitOf(second, 'drill-library', D1).outcome).toBe('held');
    expect(second.changes).toBe(0);
    const nothing = await applyCommitted(org, admin, cuesOnly, second.planHash);
    expect(nothing.importId).toBeNull();

    expect(await head(org, 'drill_library', D1)).toMatchObject({ version: 2, execution: 'Coach execution.' });
    // D2 (never edited) was revised from a package without label columns: its stored labels carried, none of them a coach's.
    expect((await head(org, 'drill_library', D2)).version).toBe(2);
    expect(await importedInAppLabels(org)).toEqual([]);
  });

  it('is held when only the audit log records the edit', async () => {
    const { org, admin } = await loadedGym();
    const current = await head(org, 'drill_library', D3);
    await client.query(
      `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
       values ('update', $1, 'coach', $2, 'drill_library', $3, $4::jsonb)`,
      [`coach@${org}`, org, current.drill_id, JSON.stringify({ action: 'in_app_edit', lineage_id: D3, version: 1 })],
    );
    const shown = await plan(org, admin, drillsWith({ [D3]: { purpose: 'Package purpose three.' } }));
    expect(unitOf(shown, 'drill-library', D3)).toMatchObject({ outcome: 'held' });
    expect(unitOf(shown, 'drill-library', D3).reasons?.[0]).toMatch(/^kept: its current version v1 holds an in-app edit by coach, \d{4}-\d{2}-\d{2};/);
  });
});

describe('a workout template a coach edited in the app', () => {
  it('is held, from its root file or its items alone, and the other template still loads', async () => {
    const { org, admin } = await loadedGym(true);
    await coachEditsTemplate(org, T1, { intent: 'Coach intent.' });

    const itemsOnly = { [ITEMS_CSV]: templates([
      itemRow(T1, 1, D2, { duration_minutes: '12' }),
      itemRow(T2, 1, D3, { duration_minutes: '12' }),
    ])[ITEMS_CSV] };
    const shown = await plan(org, admin, itemsOnly);
    expect(shown.blocking).toEqual([]);
    expect(unitOf(shown, 'workout-templates', T1)).toMatchObject({ outcome: 'held' });
    expect(unitOf(shown, 'workout-templates', T1).reasons?.[0]).toMatch(/^kept: its current version v2 holds an in-app edit \(intent\) by coach/);
    expect(unitOf(shown, 'workout-templates', T2)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });
    expect(formatPlan(shown)).toContain('  workout-templates: 0 new, 1 new version, 0 unchanged, 0 absent, 0 reject, 1 held');

    const applied = await applyCommitted(org, admin, itemsOnly, shown.planHash);
    expect(applied.audit?.details.held).toEqual({ 'workout-templates': [T1] });
    expect(await head(org, 'workout_templates', T1)).toMatchObject({ version: 2, intent: 'Coach intent.', created_by_role: 'coach' });
    expect((await head(org, 'workout_templates', T2)).version).toBe(2);

    // The root file, without label columns: held the same way.
    const roots = withoutLabelColumns(templates(undefined, [templateRow(T1, { name: 'Renamed by package' }), templateRow(T2)]), TEMPLATES_CSV);
    const again = await plan(org, admin, { [TEMPLATES_CSV]: roots[TEMPLATES_CSV] });
    expect(unitOf(again, 'workout-templates', T1).outcome).toBe('held');
    expect(await importedInAppLabels(org)).toEqual([]);
  });

  it('holds a template whose step links a held drill it would not fit, and loads one that fits', async () => {
    const { org, admin } = await loadedGym();
    // The coach takes D1 from light_technical down to no contact.
    await coachEditsDrill(org, D1, { contact_level: 'none' });

    const T3 = 'wtp_3c00000000000c';
    const T4 = 'wtp_4d00000000000d';
    const files = {
      // The package still has D1 at light_technical (and changes it, so it is held),
      ...drillsWith({ [D1]: { purpose: 'Package purpose.' } }),
      // so the validator passes a light_technical step on D1 -- against a version that will not be loaded.
      ...templates(
        [itemRow(T3, 1, D1, { contact_level: 'light_technical' }), itemRow(T4, 1, D1, { contact_level: 'none' })],
        [templateRow(T3), templateRow(T4)],
      ),
    };
    const shown = await plan(org, admin, files);
    expect(shown.blocking).toEqual([]);
    expect(unitOf(shown, 'drill-library', D1).outcome).toBe('held');
    expect(unitOf(shown, 'workout-templates', T3)).toMatchObject({
      outcome: 'held',
      reasons: [`not loaded: seed_workout_template_items.csv row 1 links drill ${D1} is held (its in-app-edited version is kept), whose contact_level is none, below the step's light_technical`],
    });
    expect(unitOf(shown, 'workout-templates', T4).outcome).toBe('new');

    await applyCommitted(org, admin, files, shown.planHash);
    expect(await head(org, 'workout_templates', T3)).toBeUndefined();
    const t4 = await head(org, 'workout_templates', T4);
    const items = (await client.query(`select drill_id from pilot.workout_template_items where organization_id = $1 and template_id = $2`, [org, t4.template_id])).rows;
    // T4's step links the coach's kept version.
    expect(items).toEqual([{ drill_id: (await head(org, 'drill_library', D1)).drill_id }]);
  });
});

describe('the dry run and the plan hash', () => {
  it('a dry run prints the held item and writes nothing', async () => {
    const { org, admin } = await loadedGym();
    await coachEditsDrill(org, D1, { purpose: 'Coach purpose.' });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-ig-seed-'));
    try {
      const files = drillsWith({ [D1]: { purpose: 'Package purpose.' }, [D2]: { purpose: 'Package purpose two.' } });
      for (const [relative, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
        await fs.writeFile(path.join(dir, relative), text, 'utf8');
      }
      const lines: string[] = [];
      const code = await runApply(
        { client, organizationId: org, actorAccountId: admin, seedDataDir: dir, datasets: ['drill-library'], dryRun: true },
        { log: (line) => lines.push(line) },
      );
      expect(code).toBe(0);
      expect(lines).toContain('  drill-library: 0 new, 1 new version, 1 unchanged, 0 absent, 0 reject, 1 held');
      expect(lines.some((line) => line.startsWith(`    held ${D1}: kept: its current version v2 holds an in-app edit (purpose)`))).toBe(true);
      expect(lines.some((line) => line.startsWith('RESULT: DRY RUN'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect((await head(org, 'drill_library', D2)).version).toBe(1);
    expect(await head(org, 'drill_library', D1)).toMatchObject({ version: 2, purpose: 'Coach purpose.' });
  });

  it('an edit that lands after the plan was shown makes the apply stale, and nothing is written', async () => {
    const { org, admin } = await loadedGym();
    const files = drillsWith({ [D1]: { purpose: 'Package purpose.' }, [D2]: { purpose: 'Package purpose two.' } });
    const before = await plan(org, admin, files);
    expect(unitOf(before, 'drill-library', D1).outcome).toBe('new_version');

    await coachEditsDrill(org, D1, { purpose: 'Coach purpose.' });
    const after = await plan(org, admin, files);
    expect(unitOf(after, 'drill-library', D1).outcome).toBe('held');
    expect(after.planHash).not.toBe(before.planHash);

    await expect(applyCommitted(org, admin, files, before.planHash)).rejects.toMatchObject({ code: 'STALE_PLAN' });
    await expect(applyCommitted(org, admin, files, before.planHash)).rejects.toBeInstanceOf(ContentImportRefusal);
    expect(await head(org, 'drill_library', D1)).toMatchObject({ version: 2, purpose: 'Coach purpose.' });
    expect((await head(org, 'drill_library', D2)).version).toBe(1);
  });
});
