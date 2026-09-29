// The drill library and the universal stop rules on the content-import
// engine, against the full migrated schema.
//
// IMP-07 of the intake plan: R2 ("new stuff gets added if there is nothing to
// update") for drills, and R3's stored-once universal stop rules. Every test
// pins a failure the old loader had or a guarantee the engine makes:
//   - seed-drill-library.mjs:245 says ON CONFLICT (discipline, name) DO
//     NOTHING, so a revised drill was skipped without a word, and a RENAMED
//     drill that kept its id stopped the run on the primary key;
//   - its child inserts (:303, :340, :373) keyed on the drill_id in the file --
//     the lineage key -- so new scale, stop-rule and cue rows landed on v1,
//     whatever version was current;
//   - seed-drill-secondary-skills.mjs:224 looks the drill up by that same id,
//     with no head filter;
//   - its grounding_claim_ids split on ';' and ',' only (:210-219), so a '|'
//     list is ONE element in the database -- which must not read as a revision.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import type { DbClient } from './contentImport/actor';
import { applyImport } from './contentImport/apply';
import { readDatasetFiles, runApply } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { MINT } from './contentImport/ids';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import { ContentImportRefusal } from './contentImport/refusal';
import type { DatasetName } from './contentImport/types';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_drills';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-drills-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions'];
const LIBRARY_CSV = 'drill-library/seed_drill_library.csv';
const SCALE_CSV = 'drill-library/seed_drill_scale_levels.csv';
const STOP_CSV = 'drill-library/seed_drill_stop_rules.csv';
const CUES_CSV = 'drill-library/seed_drill_cues.csv';
const SECONDARY_CSV = 'drill-library/seed_drill_secondary_skills.csv';
const UNIVERSAL_CSV = 'drill-library/seed_universal_stop_rules.csv';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type OldSeedAll = (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string; seedAccountId?: string },
  options?: { dryRun?: boolean },
) => Promise<unknown>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
/** A second connection: sees only what is COMMITTED. */
let observer: Client;
let oldSeedDrillLibrary: OldSeedAll;
let oldSeedSecondarySkills: OldSeedAll;
/** Folders written for the old loaders; removed in afterAll. */
const oldLoaderDirs: string[] = [];

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

/**
 * Every claim id of the LOADED research package, as chunks of the shared
 * __platform__ library -- what referenceSetsDb.ts reads for every gym. The
 * drills cite 115 of them; without them each citation is an orphan.
 */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url)
     values ('src_drills_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/drills-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_drills_test', 'src_drills_test', '__platform__', 'Loaded research claims (test)', 'drills-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_drills_test', 'src_drills_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
            jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)`,
    [ids],
  );
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
  // Every migration in apply-migrations.yml's `all` order (scripts/lib/full-schema.mjs),
  // pilot_slice_postgres_drill_vocabulary_widening_migration.sql among them:
  // the committed CSVs carry literature_grounded_draft and warmup_decay, which
  // the old seedAll below cannot load without it (drillSeedPrerequisite.test.ts).
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  observer = new Client({ connectionString: connectionStringFor(DATABASE) });
  await observer.connect();

  await loadPlatformClaims();

  // The OLD loaders, exactly as the seed workflow runs them today, to build a
  // gym the way production's reference rows were built.
  oldSeedDrillLibrary = (await nativeDynamicImport(pathToFileURL(path.join(WEB_DIR, 'scripts/seed-drill-library.mjs')).href)).seedAll as OldSeedAll;
  oldSeedSecondarySkills = (await nativeDynamicImport(pathToFileURL(path.join(WEB_DIR, 'scripts/seed-drill-secondary-skills.mjs')).href))
    .seedAll as OldSeedAll;
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
  for (const dir of oldLoaderDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Fixtures

async function createGym(organizationId: string): Promise<string> {
  const accountId = `admin@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
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

function drillFiles(): Record<string, string> {
  return readDatasetFiles(SEED_DATA_DIR, ['drill-library']);
}

type Row = Record<string, string>;

function rowsOf(files: Record<string, string>, file: string): Row[] {
  const table = readCsv(files[file]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index] ?? ''])));
}

function withRows(files: Record<string, string>, file: string, rows: Row[]): Record<string, string> {
  const header = readCsv(files[file]).header;
  return { ...files, [file]: writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? ''))) };
}

/** The files with one CSV edited row by row through the real reader and writer; return null to drop a row. */
function withEdit(files: Record<string, string>, file: string, edit: (row: Row) => Row | null): Record<string, string> {
  return withRows(files, file, rowsOf(files, file).map(edit).filter((row): row is Row => row !== null));
}

/** One drill's rows in a child file replaced by `rows`, the rest kept. */
function withDrillRows(files: Record<string, string>, file: string, drillId: string, rows: Row[]): Record<string, string> {
  return withRows(files, file, [...rowsOf(files, file).filter((row) => row.drill_id !== drillId), ...rows]);
}

const COMMITTED = drillFilesOnDisk();

function drillFilesOnDisk() {
  const files = readDatasetFiles(SEED_DATA_DIR, ['drill-library']);
  const library = rowsOf(files, LIBRARY_CSV);
  const byId = new Map(library.map((row) => [row.drill_id, row]));
  const secondaries = rowsOf(files, SECONDARY_CSV);
  return { files, library, byId, secondaries };
}

async function plan(organizationId: string, actorAccountId: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId, files });
}

/** BEGIN, apply, COMMIT -- ROLLBACK on any throw. The caller shape the engine requires. */
async function applyCommitted(organizationId: string, actorAccountId: string, files: Record<string, string>, expectedPlanHash?: string) {
  const hash = expectedPlanHash ?? (await plan(organizationId, actorAccountId, files)).planHash;
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client, organizationId, actorAccountId, files, expectedPlanHash: hash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** A gym with its disciplines, levels and cohorts loaded through the engine: what the drills point at. */
async function prepareGym(organizationId: string): Promise<string> {
  const admin = await createGym(organizationId);
  await applyCommitted(organizationId, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
  return admin;
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return await work();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

const COMMITTED_DRILL_DIR = path.join(SEED_DATA_DIR, 'drill-library');

async function oldDrillLoader(organizationId: string, admin: string, seedDir = COMMITTED_DRILL_DIR): Promise<void> {
  await quietly(() => oldSeedDrillLibrary(client, seedDir, { organizationId, seedAccountId: admin }));
}

async function oldSecondaryLoader(organizationId: string, seedDir = COMMITTED_DRILL_DIR): Promise<void> {
  await quietly(() => oldSeedSecondarySkills(client, seedDir, { organizationId }));
}

/** The drill library as production holds it today: the OLD loaders, over the committed files. */
async function seedDrillsTheOldWay(organizationId: string, admin: string): Promise<void> {
  await oldDrillLoader(organizationId, admin);
  await oldSecondaryLoader(organizationId);
}

/** A folder holding these files under their base names, for the old loaders. */
async function oldLoaderDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-content-drills-old-loader-'));
  oldLoaderDirs.push(dir);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, path.basename(name)), text, 'utf8');
  return dir;
}

interface Counts {
  drills: number;
  scale: number;
  stop: number;
  cues: number;
  secondary: number;
  transfer: number;
  universal: number;
  audit: number;
}

/** Committed rows only: read on the observer connection. */
async function committedCounts(organizationId: string): Promise<Counts> {
  const { rows } = await observer.query<{ [K in keyof Counts]: string }>(
    `select
       (select count(*) from pilot.drill_library where organization_id = $1) as drills,
       (select count(*) from pilot.drill_scale_levels where organization_id = $1) as scale,
       (select count(*) from pilot.drill_stop_rules where organization_id = $1) as stop,
       (select count(*) from pilot.drill_cues where organization_id = $1) as cues,
       (select count(*) from pilot.drill_secondary_skills where organization_id = $1) as secondary,
       (select count(*) from pilot.transfer_claims where organization_id = $1) as transfer,
       (select count(*) from pilot.universal_stop_rules where organization_id = $1) as universal,
       (select count(*) from pilot.audit_events where organization_id = $1 and entity_type = 'content_import') as audit`,
    [organizationId],
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as unknown as Counts;
}

/**
 * Every row's xmin -- the transaction that wrote its current version. ANY
 * update, even one writing identical values, gives a row a new xmin, so an
 * unchanged map means nothing was written, not just nothing visible changed.
 */
async function rowVersions(organizationId: string): Promise<Record<string, string>> {
  const { rows } = await observer.query<{ key: string; xmin: string }>(
    `select 'drill:' || drill_id as key, xmin::text as xmin from pilot.drill_library where organization_id = $1
     union all select 'scale:' || scale_id, xmin::text from pilot.drill_scale_levels where organization_id = $1
     union all select 'stop:' || stop_rule_id, xmin::text from pilot.drill_stop_rules where organization_id = $1
     union all select 'cue:' || cue_id, xmin::text from pilot.drill_cues where organization_id = $1
     union all select 'secondary:' || drill_id || '/' || skill_id, xmin::text from pilot.drill_secondary_skills where organization_id = $1
     union all select 'transfer:' || transfer_id, xmin::text from pilot.transfer_claims where organization_id = $1
     union all select 'universal:' || universal_rule_id, xmin::text from pilot.universal_stop_rules where organization_id = $1
     union all select 'operational:' || drill_id, xmin::text from pilot.drills where organization_id = $1`,
    [organizationId],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.xmin]));
}

interface VersionRow {
  drill_id: string;
  lineage_id: string;
  version: number;
  supersedes_drill_id: string | null;
  superseded: boolean;
  active: boolean;
  name: string;
  purpose: string;
  skill_id: string | null;
  grounding_claim_ids: string[];
  created_by_role: string | null;
}

async function versionsOf(organizationId: string, lineageId: string): Promise<VersionRow[]> {
  const { rows } = await observer.query<VersionRow>(
    `select drill_id, lineage_id, version, supersedes_drill_id, superseded_at is not null as superseded, active,
            name, purpose, skill_id, grounding_claim_ids, created_by_role
       from pilot.drill_library
      where organization_id = $1 and lineage_id = $2
      order by version`,
    [organizationId, lineageId],
  );
  return rows;
}

interface Children {
  scale: { id: string; level: string; demand: string; xmin: string }[];
  stop: { id: string; ordinal: number; text: string; xmin: string }[];
  cues: { id: string; text: string; xmin: string }[];
  secondary: string[];
}

async function childrenOf(organizationId: string, drillId: string): Promise<Children> {
  const scale = await observer.query(
    `select scale_id as id, scale_level as level, demand_description as demand, xmin::text as xmin
       from pilot.drill_scale_levels where organization_id = $1 and drill_id = $2 order by scale_level`,
    [organizationId, drillId],
  );
  const stop = await observer.query(
    `select stop_rule_id as id, ordinal, condition_text as text, xmin::text as xmin
       from pilot.drill_stop_rules where organization_id = $1 and drill_id = $2 order by ordinal`,
    [organizationId, drillId],
  );
  const cues = await observer.query(
    `select cue_id as id, cue_text as text, xmin::text as xmin
       from pilot.drill_cues where organization_id = $1 and drill_id = $2 order by cue_text`,
    [organizationId, drillId],
  );
  const secondary = await observer.query<{ skill_id: string }>(
    'select skill_id from pilot.drill_secondary_skills where organization_id = $1 and drill_id = $2 order by skill_id',
    [organizationId, drillId],
  );
  return { scale: scale.rows, stop: stop.rows, cues: cues.rows, secondary: secondary.rows.map((row) => row.skill_id) };
}

function unitOf(result: ImportPlan, key: string) {
  return result.units.find((unit) => unit.dataset === 'drill-library' && unit.key === key);
}

/** A client that runs every statement on the real one, and throws plain JavaScript at the first statement matching `at`. */
function failingClient(at: RegExp, seen: string[]): DbClient {
  return {
    query: (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
      seen.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (at.test(text)) throw new Error('injected: a JavaScript failure mid-way through the load');
      return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as DbClient;
}

// The drills the tests revise, picked from the committed library by what they
// carry rather than by hard-coded ids.
const FIRST = COMMITTED.library[0].drill_id;
const MASHED = COMMITTED.library.find((row) => row.grounding_claim_ids.includes('|')) as Row;
const WITH_SECONDARY = COMMITTED.secondaries[0];
const SAME_DISCIPLINE = COMMITTED.library.find(
  (row) => row.drill_id !== FIRST && row.discipline === (COMMITTED.byId.get(FIRST) as Row).discipline,
) as Row;
const PRIMARY_ONLY = COMMITTED.library.find(
  (row) => row.skill_id && row.skill_id !== WITH_SECONDARY.skill_id && !COMMITTED.secondaries.some((s) => s.drill_id === row.drill_id)
    && row.drill_id !== FIRST,
) as Row;

// ---------------------------------------------------------------------------

describe('the shipped 119-drill package', () => {
  it('re-importing it onto the rows the OLD loaders wrote finds every drill unchanged and writes nothing', async () => {
    // The canonicaliser guard. Production's drills were written by the old
    // loader; if the engine read ANY of its stored forms as different content,
    // the first run would "revise" every drill it was meant to leave alone.
    const admin = await prepareGym('gym_old_drills');
    await seedDrillsTheOldWay('gym_old_drills', admin);
    const counts = await committedCounts('gym_old_drills');
    expect(counts).toMatchObject({ drills: 119, scale: 357, stop: 674, cues: 258, secondary: 1 });
    const before = await rowVersions('gym_old_drills');

    const result = await applyCommitted('gym_old_drills', admin, drillFiles());
    expect(result.plan.blocking).toEqual([]);
    expect(result.plan.counts['drill-library']).toEqual({ new: 0, new_version: 0, unchanged: 119, absent: 0, reject: 0 });
    expect(result.importId).toBeNull();

    expect(await rowVersions('gym_old_drills')).toEqual(before);
    expect(await committedCounts('gym_old_drills')).toEqual(counts);
  });

  it('a first load writes v1 of every drill with its children, and loading it again writes nothing', async () => {
    const admin = await prepareGym('gym_first_drills');
    const first = await applyCommitted('gym_first_drills', admin, drillFiles());
    expect(first.plan.counts['drill-library']).toEqual({ new: 119, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    expect(first.written['drill-library']?.inserted).toHaveLength(119);
    expect(first.written['drill-library']?.ledgerRows).toBe(0);
    expect(await committedCounts('gym_first_drills')).toEqual({
      drills: 119, scale: 357, stop: 674, cues: 258, secondary: 1, transfer: 0, universal: 0, audit: 2,
    });

    const { rows } = await observer.query<{ drill_id: string; lineage_id: string; version: number; head: boolean; active: boolean; role: string; mashed: boolean }>(
      `select drill_id, lineage_id, version, superseded_at is null as head, active, created_by_role as role,
              exists (select 1 from unnest(grounding_claim_ids) element where element like '%|%') as mashed
         from pilot.drill_library where organization_id = 'gym_first_drills'`,
    );
    expect(rows.every((row) => row.drill_id === row.lineage_id && row.version === 1 && row.head && row.active)).toBe(true);
    expect(new Set(rows.map((row) => row.role))).toEqual(new Set(['organization_admin']));
    // Written split: the engine never stores the old loader's mashed element.
    expect(rows.filter((row) => row.mashed)).toEqual([]);
    const stored = await versionsOf('gym_first_drills', MASHED.drill_id);
    expect(stored[0].grounding_claim_ids).toEqual(MASHED.grounding_claim_ids.split('|').map((id) => id.trim()));

    // Children keep the committed ids -- the ids production already holds.
    const scaleIds = await observer.query<{ scale_id: string }>("select scale_id from pilot.drill_scale_levels where organization_id = 'gym_first_drills'");
    expect(new Set(scaleIds.rows.map((row) => row.scale_id))).toEqual(new Set(rowsOf(COMMITTED.files, SCALE_CSV).map((row) => row.scale_id)));

    const before = await rowVersions('gym_first_drills');
    const again = await applyCommitted('gym_first_drills', admin, drillFiles());
    expect(again.plan.counts['drill-library']).toEqual({ new: 0, new_version: 0, unchanged: 119, absent: 0, reject: 0 });
    expect(again.importId).toBeNull();
    expect(await rowVersions('gym_first_drills')).toEqual(before);
  });

  it("a '|' mashed grounding element already in the database compares equal to the split file value", async () => {
    const admin = await prepareGym('gym_mashed');
    await seedDrillsTheOldWay('gym_mashed', admin);
    // The defect is really there: one element holding the whole '|' list.
    const [v1] = await versionsOf('gym_mashed', MASHED.drill_id);
    expect(v1.grounding_claim_ids).toEqual([MASHED.grounding_claim_ids]);
    expect(v1.grounding_claim_ids[0]).toContain('|');
    const mashedDrills = await observer.query<{ count: string }>(
      `select count(*) from pilot.drill_library
        where organization_id = 'gym_mashed' and exists (select 1 from unnest(grounding_claim_ids) element where element like '%|%')`,
    );
    expect(Number(mashedDrills.rows[0].count)).toBe(COMMITTED.library.filter((row) => row.grounding_claim_ids.includes('|')).length);

    const planned = await plan('gym_mashed', admin, drillFiles());
    expect(unitOf(planned, MASHED.drill_id)).toMatchObject({ outcome: 'unchanged' });
    expect(unitOf(planned, MASHED.drill_id)?.fileSha256).toBe(unitOf(planned, MASHED.drill_id)?.databaseSha256);

    // A real change to the list is still a change, and the new version is stored split.
    const claims = MASHED.grounding_claim_ids.split('|').map((id) => id.trim());
    const fewer = withEdit(drillFiles(), LIBRARY_CSV, (row) =>
      (row.drill_id === MASHED.drill_id ? { ...row, grounding_claim_ids: claims.slice(1).join('|') } : row));
    const revised = await applyCommitted('gym_mashed', admin, fewer);
    expect(revised.plan.counts['drill-library']).toMatchObject({ new_version: 1, unchanged: 118 });
    const [, v2] = await versionsOf('gym_mashed', MASHED.drill_id);
    expect(v2.grounding_claim_ids).toEqual(claims.slice(1));
  });
});

describe('a revised drill becomes a new version', () => {
  it('a same-name revision creates v2; v1 stays active with superseded_at set and keeps its children', async () => {
    const admin = await prepareGym('gym_same_name');
    await seedDrillsTheOldWay('gym_same_name', admin);
    const v1Children = await childrenOf('gym_same_name', FIRST);
    const revised = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, purpose: `${row.purpose} Revised.` } : row));

    // The old loader, given the revised file, skips it without a word.
    const dir = await oldLoaderDir({ [LIBRARY_CSV]: revised[LIBRARY_CSV] });
    await oldDrillLoader('gym_same_name', admin, dir);
    expect(await versionsOf('gym_same_name', FIRST)).toHaveLength(1);

    const planned = await plan('gym_same_name', admin, revised);
    expect(unitOf(planned, FIRST)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });
    expect(planned.counts['drill-library']).toEqual({ new: 0, new_version: 1, unchanged: 118, absent: 0, reject: 0 });
    const before = await rowVersions('gym_same_name');
    const result = await applyCommitted('gym_same_name', admin, revised, planned.planHash);
    const v2Id = MINT.drillVersion(FIRST, 2);
    expect(result.written['drill-library']).toEqual({ inserted: [v2Id], updated: [FIRST], ledgerRows: 0 });

    // Written: v1's row (superseded_at) and v2's new rows. Nothing else --
    // not the other 118 drills, not v1's children.
    const after = await rowVersions('gym_same_name');
    expect(Object.keys(before).filter((key) => after[key] !== before[key])).toEqual([`drill:${FIRST}`]);
    const v1ChildCount = v1Children.scale.length + v1Children.stop.length + v1Children.cues.length + v1Children.secondary.length;
    const added = Object.keys(after).filter((key) => !(key in before));
    expect(added).toContain(`drill:${v2Id}`);
    expect(added).toHaveLength(1 + v1ChildCount);

    const [v1, v2] = await versionsOf('gym_same_name', FIRST);
    expect(v1).toMatchObject({ drill_id: FIRST, version: 1, superseded: true, active: true });
    expect(v2).toMatchObject({
      drill_id: v2Id,
      lineage_id: FIRST,
      version: 2,
      supersedes_drill_id: FIRST,
      superseded: false,
      active: true,
      name: v1.name,
      purpose: `${v1.purpose} Revised.`,
      created_by_role: 'organization_admin',
    });

    // v1 keeps its own children, untouched (same ids, same xmin).
    expect(await childrenOf('gym_same_name', FIRST)).toEqual(v1Children);
    // v2 has the same material under ids minted from v2.
    const v2Children = await childrenOf('gym_same_name', v2Id);
    expect(v2Children.scale.map((row) => [row.level, row.demand])).toEqual(v1Children.scale.map((row) => [row.level, row.demand]));
    expect(v2Children.scale.map((row) => row.id)).toEqual(v2Children.scale.map((row) => MINT.scale(v2Id, row.level)));
    expect(v2Children.stop.map((row) => [row.ordinal, row.text])).toEqual(v1Children.stop.map((row) => [row.ordinal, row.text]));
    expect(v2Children.stop.map((row) => row.id)).toEqual(v2Children.stop.map((row) => MINT.stopRule(v2Id, String(row.ordinal))));
    expect(v2Children.cues.map((row) => row.text)).toEqual(v1Children.cues.map((row) => row.text));
    expect(v2Children.cues.map((row) => row.id)).toEqual(v2Children.cues.map((row) => MINT.cue(v2Id, row.text)));

    // One head, and the same files again are now unchanged.
    const heads = await observer.query("select count(*)::int as n from pilot.drill_library where organization_id = 'gym_same_name' and superseded_at is null");
    expect(heads.rows[0].n).toBe(119);
    const again = await plan('gym_same_name', admin, revised);
    expect(again.counts['drill-library']).toEqual({ new: 0, new_version: 0, unchanged: 119, absent: 0, reject: 0 });
  });

  it('a renamed revision creates v2 instead of aborting on the primary key', async () => {
    const admin = await prepareGym('gym_rename');
    await seedDrillsTheOldWay('gym_rename', admin);
    const original = COMMITTED.byId.get(FIRST) as Row;
    const renamed = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, name: `${row.name} (renamed)` } : row));

    // The old loader: the name index is its ON CONFLICT arbiter, the kept id
    // hits the primary key, and the run stops.
    const dir = await oldLoaderDir({ [LIBRARY_CSV]: renamed[LIBRARY_CSV] });
    await expect(oldDrillLoader('gym_rename', admin, dir)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_drill_library_pkey' });

    const result = await applyCommitted('gym_rename', admin, renamed);
    expect(unitOf(result.plan, FIRST)).toMatchObject({ outcome: 'new_version', toVersion: 2 });
    const [v1, v2] = await versionsOf('gym_rename', FIRST);
    expect(v1).toMatchObject({ name: original.name, superseded: true, active: true });
    expect(v2).toMatchObject({ drill_id: MINT.drillVersion(FIRST, 2), name: `${original.name} (renamed)`, superseded: false, supersedes_drill_id: FIRST });
    // The name is held by no current drill any more; the new one is.
    const current = await observer.query(
      "select name from pilot.drill_library where organization_id = 'gym_rename' and lineage_id = $1 and superseded_at is null",
      [FIRST],
    );
    expect(current.rows).toEqual([{ name: `${original.name} (renamed)` }]);
  });

  it('new scale, stop-rule and cue rows never attach to v1', async () => {
    const admin = await prepareGym('gym_children');
    await applyCommitted('gym_children', admin, drillFiles());
    const v1Before = await childrenOf('gym_children', FIRST);
    const scale = rowsOf(COMMITTED.files, SCALE_CSV).filter((row) => row.drill_id === FIRST);
    const cues = rowsOf(COMMITTED.files, CUES_CSV).filter((row) => row.drill_id === FIRST);

    let revised = withDrillRows(drillFiles(), STOP_CSV, FIRST, [
      { organization_id: '{{PPBF_ORG_ID}}', stop_rule_id: '', drill_id: FIRST, ordinal: '1', condition_text: 'Stop when the stance collapses on two reps in a row.', scope: 'drill_specific', rule_kind: 'technique_degradation' },
      { organization_id: '{{PPBF_ORG_ID}}', stop_rule_id: '', drill_id: FIRST, ordinal: '2', condition_text: 'Stop when the athlete cannot hold the pace.', scope: '', rule_kind: 'fatigue' },
    ]);
    revised = withDrillRows(revised, CUES_CSV, FIRST, [...cues, { organization_id: '{{PPBF_ORG_ID}}', cue_id: '', drill_id: FIRST, cue_text: 'Eyes through the target.', cue_family: cues[0]?.cue_family ?? '', focus_type: 'external' }]);
    revised = withDrillRows(revised, SCALE_CSV, FIRST, scale.map((row) => (row.scale_level === 'A' ? { ...row, demand_description: 'Walk it through at half pace.' } : row)));

    const result = await applyCommitted('gym_children', admin, revised);
    expect(result.plan.counts['drill-library']).toEqual({ new: 0, new_version: 1, unchanged: 118, absent: 0, reject: 0 });
    const v2Id = MINT.drillVersion(FIRST, 2);

    // v1: exactly the rows it had -- the same ids, never rewritten.
    expect(await childrenOf('gym_children', FIRST)).toEqual(v1Before);
    // v2: the new material, on v2 only.
    const v2 = await childrenOf('gym_children', v2Id);
    expect(v2.stop.map((row) => [row.id, row.ordinal, row.text])).toEqual([
      [MINT.stopRule(v2Id, '1'), 1, 'Stop when the stance collapses on two reps in a row.'],
      [MINT.stopRule(v2Id, '2'), 2, 'Stop when the athlete cannot hold the pace.'],
    ]);
    expect(v2.cues.map((row) => row.text)).toEqual([...cues.map((row) => row.cue_text), 'Eyes through the target.'].sort());
    expect(v2.cues.find((row) => row.text === 'Eyes through the target.')?.id).toBe(MINT.cue(v2Id, 'Eyes through the target.'));
    expect(v2.scale.find((row) => row.level === 'A')?.demand).toBe('Walk it through at half pace.');
    const onV1 = await observer.query(
      `select 'stop' as t from pilot.drill_stop_rules where organization_id = 'gym_children' and drill_id = $1 and condition_text like 'Stop when the stance collapses%'
       union all select 'cue' from pilot.drill_cues where organization_id = 'gym_children' and drill_id = $1 and cue_text = 'Eyes through the target.'`,
      [FIRST],
    );
    expect(onV1.rows).toEqual([]);
  });

  it('an adopted pilot.drills row still points at v1 after v2 loads', async () => {
    const admin = await prepareGym('gym_adopted');
    await applyCommitted('gym_adopted', admin, drillFiles());
    const original = COMMITTED.byId.get(FIRST) as Row;
    await client.query(
      `insert into pilot.drills (organization_id, drill_id, name, category, focus, lineage_id, reference_drill_id)
       values ('gym_adopted', 'gym_drill_1', $1, $2, 'Adopted from the reference library.', 'gym_drill_1', $3)`,
      [original.name, original.category, FIRST],
    );
    const before = await rowVersions('gym_adopted');

    const revised = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, execution: `${row.execution} Then reset.` } : row));
    await applyCommitted('gym_adopted', admin, revised);

    const after = await rowVersions('gym_adopted');
    expect(after['operational:gym_drill_1']).toBe(before['operational:gym_drill_1']);
    const adopted = await observer.query("select reference_drill_id from pilot.drills where organization_id = 'gym_adopted' and drill_id = 'gym_drill_1'");
    expect(adopted.rows).toEqual([{ reference_drill_id: FIRST }]);
    // And the version it points at is still live for that gym's athletes.
    const [v1, v2] = await versionsOf('gym_adopted', FIRST);
    expect(v1).toMatchObject({ drill_id: FIRST, active: true, superseded: true });
    expect(v2).toMatchObject({ drill_id: MINT.drillVersion(FIRST, 2), active: true, superseded: false });
  });

  it("a drill's transfer claims are part of its unit: unchanged with it, and carried to its new version", async () => {
    const admin = await prepareGym('gym_transfer');
    await applyCommitted('gym_transfer', admin, drillFiles());
    // No committed claim points at a library drill yet (specs/transferClaims.ts),
    // and no engine loads that file, so the claim is put in the way the app would find it.
    const statement = 'Resetting the stance after a miss is practice at recovering from a mistake.';
    const claimId = MINT.transfer(FIRST, 'life_skill_transfer', statement);
    await client.query(
      `insert into pilot.transfer_claims (organization_id, transfer_id, drill_id, claim_kind, statement, evidence_class)
       values ('gym_transfer', $1, $2, 'life_skill_transfer', $3, 'COACHING INTENT')`,
      [claimId, FIRST, statement],
    );

    // The claim is on both sides of the comparison, so the drill is unchanged.
    const unchanged = await plan('gym_transfer', admin, drillFiles());
    expect(unitOf(unchanged, FIRST)).toMatchObject({ outcome: 'unchanged' });
    const before = await rowVersions('gym_transfer');

    const revised = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, purpose: `${row.purpose} Revised.` } : row));
    await applyCommitted('gym_transfer', admin, revised);
    const v2Id = MINT.drillVersion(FIRST, 2);
    const claims = await observer.query(
      `select transfer_id, drill_id, claim_kind, statement, evidence_class, athlete_facing, public_facing
         from pilot.transfer_claims where organization_id = 'gym_transfer' order by drill_id = $1 desc`,
      [FIRST],
    );
    expect(claims.rows).toEqual([
      { transfer_id: claimId, drill_id: FIRST, claim_kind: 'life_skill_transfer', statement, evidence_class: 'COACHING INTENT', athlete_facing: true, public_facing: false },
      {
        transfer_id: MINT.transfer(v2Id, 'life_skill_transfer', statement),
        drill_id: v2Id,
        claim_kind: 'life_skill_transfer',
        statement,
        evidence_class: 'COACHING INTENT',
        athlete_facing: true,
        public_facing: false,
      },
    ]);
    // v1's claim is the same row it was.
    expect((await rowVersions('gym_transfer'))[`transfer:${claimId}`]).toBe(before[`transfer:${claimId}`]);
  });

  it('two drills that trade names in one hand-off both become new versions', async () => {
    // Every supersede runs before any insert: inserting the first new version
    // while the other drill still held the name would trip
    // pilot_drill_library_one_active_name.
    const admin = await prepareGym('gym_swap');
    await applyCommitted('gym_swap', admin, drillFiles());
    const first = COMMITTED.byId.get(FIRST) as Row;
    const swapped = withEdit(drillFiles(), LIBRARY_CSV, (row) =>
      (row.drill_id === FIRST ? { ...row, name: SAME_DISCIPLINE.name } : row.drill_id === SAME_DISCIPLINE.drill_id ? { ...row, name: first.name } : row));
    const result = await applyCommitted('gym_swap', admin, swapped);
    expect(result.plan.blocking).toEqual([]);
    expect(result.plan.counts['drill-library']).toMatchObject({ new_version: 2, unchanged: 117 });
    const current = await observer.query(
      `select lineage_id, version, name from pilot.drill_library
        where organization_id = 'gym_swap' and superseded_at is null and lineage_id = any($1::text[]) order by lineage_id`,
      [[FIRST, SAME_DISCIPLINE.drill_id]],
    );
    expect(current.rows).toEqual(
      [
        { lineage_id: FIRST, version: 2, name: SAME_DISCIPLINE.name },
        { lineage_id: SAME_DISCIPLINE.drill_id, version: 2, name: first.name },
      ].sort((a, b) => (a.lineage_id < b.lineage_id ? -1 : 1)),
    );
  });

  it('a drill plan made before another import revised the drill is refused as stale', async () => {
    const admin = await prepareGym('gym_stale_drill');
    await applyCommitted('gym_stale_drill', admin, drillFiles());
    const mine = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, purpose: `${row.purpose} Mine.` } : row));
    const theirs = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, purpose: `${row.purpose} Theirs.` } : row));
    const shown = await plan('gym_stale_drill', admin, mine);
    await applyCommitted('gym_stale_drill', admin, theirs);

    const error = await applyCommitted('gym_stale_drill', admin, mine, shown.planHash).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentImportRefusal);
    expect((error as ContentImportRefusal).code).toBe('STALE_PLAN');
    expect((await versionsOf('gym_stale_drill', FIRST)).map((row) => [row.version, row.superseded])).toEqual([[1, true], [2, false]]);
  });

  it("a package carrying only a drill's cues holds its head: a stop rule inserted elsewhere mid-import is waited for, then seen, and the plan is refused as stale", async () => {
    // A cues-only package still revises the drill, and v2's stop rules are
    // copied from a read. Without the head held FOR UPDATE (apply.ts step 3
    // once took keys from ROOT files only), a stop rule another writer inserts
    // onto v1 -- the old loader, still in the seed workflow, inserts on the
    // lineage key, seed-drill-library.mjs:340 -- commits after that read, and
    // v2 is written without it. The insert's foreign-key check takes FOR KEY
    // SHARE on the head, which the supersede UPDATE (FOR NO KEY UPDATE) does
    // not wait for, but FOR UPDATE does.
    const admin = await prepareGym('gym_child_lock');
    await applyCommitted('gym_child_lock', admin, drillFiles());
    const cues = rowsOf(COMMITTED.files, CUES_CSV).filter((row) => row.drill_id === FIRST);
    const cuesOnly = withRows({ [CUES_CSV]: drillFiles()[CUES_CSV] }, CUES_CSV, [
      ...cues,
      { organization_id: '{{PPBF_ORG_ID}}', cue_id: '', drill_id: FIRST, cue_text: 'Eyes through the target.', cue_family: cues[0]?.cue_family ?? '', focus_type: 'external' },
    ]);
    const shown = await plan('gym_child_lock', admin, cuesOnly);
    expect(shown.blocking).toEqual([]);
    expect(unitOf(shown, FIRST)).toMatchObject({ outcome: 'new_version', fromVersion: 1, toVersion: 2 });

    const importPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    const otherPid = (await observer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    const extra = 'Stop when the athlete drops the guard twice in a row.';
    await observer.query('BEGIN');
    try {
      const next = (await observer.query<{ next: number }>(
        "select coalesce(max(ordinal), 0) + 1 as next from pilot.drill_stop_rules where organization_id = 'gym_child_lock' and drill_id = $1",
        [FIRST],
      )).rows[0].next;
      await observer.query(
        `insert into pilot.drill_stop_rules (organization_id, stop_rule_id, drill_id, ordinal, condition_text, rule_kind)
         values ('gym_child_lock', $1, $2, $3, $4, 'technique_degradation')`,
        [MINT.stopRule(FIRST, String(next)), FIRST, next, extra],
      );
      let settled = false;
      const applying = applyCommitted('gym_child_lock', admin, cuesOnly, shown.planHash).finally(() => {
        settled = true;
      });
      applying.catch(() => undefined);
      // Not a timer: wait until the import is either blocked by this
      // connection or finished. Finished first is the failure.
      let blocked = false;
      while (!blocked && !settled) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { rows } = await observer.query<{ blocked: boolean }>('select $2::int = any(pg_blocking_pids($1::int)) as blocked', [importPid, otherPid]);
        blocked = rows[0].blocked;
      }
      expect(blocked).toBe(true);
      await observer.query('COMMIT');
      const error = await applying.then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ContentImportRefusal);
      expect((error as ContentImportRefusal).code).toBe('STALE_PLAN');
    } finally {
      await observer.query('ROLLBACK').catch(() => undefined);
    }
    expect((await versionsOf('gym_child_lock', FIRST)).map((row) => [row.version, row.superseded])).toEqual([[1, false]]);
    expect((await childrenOf('gym_child_lock', FIRST)).stop.map((row) => row.text)).toContain(extra);
  });

  it('secondary skills attach to the head version and differ from its primary', async () => {
    const admin = await prepareGym('gym_secondary');
    await applyCommitted('gym_secondary', admin, drillFiles());
    const drill = PRIMARY_ONLY.drill_id;
    const secondaryCode = WITH_SECONDARY.skill_id;
    expect(secondaryCode).not.toBe(PRIMARY_ONLY.skill_id);

    // v2 first, so the lineage key names history, not the head.
    const v2Files = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === drill ? { ...row, purpose: `${row.purpose} Second pass.` } : row));
    await applyCommitted('gym_secondary', admin, v2Files);
    const withSecondary = withRows(v2Files, SECONDARY_CSV, [
      ...rowsOf(v2Files, SECONDARY_CSV),
      { organization_id: '{{PPBF_ORG_ID}}', drill_id: drill, skill_id: secondaryCode },
    ]);
    const result = await applyCommitted('gym_secondary', admin, withSecondary);
    expect(unitOf(result.plan, drill)).toMatchObject({ outcome: 'new_version', fromVersion: 2, toVersion: 3 });
    expect(result.plan.counts['drill-library']).toMatchObject({ new_version: 1, unchanged: 118 });

    const v3Id = MINT.drillVersion(drill, 3);
    expect((await childrenOf('gym_secondary', v3Id)).secondary).toEqual([secondaryCode]);
    expect((await childrenOf('gym_secondary', drill)).secondary).toEqual([]);
    expect((await childrenOf('gym_secondary', MINT.drillVersion(drill, 2))).secondary).toEqual([]);

    // The old loader looks the drill up by the id in the file -- the lineage
    // key -- and writes onto v1, which is history.
    const dir = await oldLoaderDir({ [SECONDARY_CSV]: withSecondary[SECONDARY_CSV] });
    await oldSecondaryLoader('gym_secondary', dir);
    expect((await childrenOf('gym_secondary', drill)).secondary).toEqual([secondaryCode]);

    // A secondary skill equal to the head's primary is refused.
    const same = withRows(v2Files, SECONDARY_CSV, [{ organization_id: '{{PPBF_ORG_ID}}', drill_id: drill, skill_id: PRIMARY_ONLY.skill_id }]);
    const refused = await plan('gym_secondary', admin, same);
    expect(refused.blocking.some((finding) => finding.code === 'row_rule' && finding.message.includes(PRIMARY_ONLY.skill_id))).toBe(true);
    expect(unitOf(refused, drill)?.outcome).toBe('reject');

    // So is a new primary that equals a secondary the drill already has --
    // carried from the database, which the validator never sees.
    const carried = withEdit({ [LIBRARY_CSV]: drillFiles()[LIBRARY_CSV] }, LIBRARY_CSV, (row) =>
      (row.drill_id === WITH_SECONDARY.drill_id ? { ...row, skill_id: WITH_SECONDARY.skill_id } : null));
    const blocked = await plan('gym_secondary', admin, carried);
    expect(blocked.blocking.map((finding) => [finding.code, finding.key])).toEqual([['row_rule', WITH_SECONDARY.drill_id]]);
    expect(unitOf(blocked, WITH_SECONDARY.drill_id)?.outcome).toBe('reject');
    expect(blocked.counts['drill-library']).toMatchObject({ reject: 1, absent: 118 });
  });
});

describe('a new:<short-name> never lands on a drill the gym already has', () => {
  it("one that mints a WITHDRAWN drill's id is refused, not planned as a revision that lands withdrawn", async () => {
    // The validator judges minted ids against readBaseline, which holds ACTIVE
    // heads only (a withdrawn drill does not hold its name). plan() resolves
    // against every head, so before the engine's own check the "new" drill
    // planned as new_version of the withdrawn lineage, with nothing blocking,
    // and v2 inherited active = false.
    const admin = await prepareGym('gym_withdrawn');
    const source = COMMITTED.byId.get(FIRST) as Row;
    const probe = (drillId: string, purpose: string) =>
      withRows({ [LIBRARY_CSV]: drillFiles()[LIBRARY_CSV] }, LIBRARY_CSV, [
        { ...source, drill_id: drillId, lineage_id: '', version: '', supersedes_drill_id: '', superseded_at: '', name: 'Probe drill', purpose },
      ]);
    const probeId = MINT.drill(source.discipline, 'Probe drill');
    const first = await applyCommitted('gym_withdrawn', admin, probe('new:probe-drill', source.purpose));
    expect(first.written['drill-library']?.inserted).toEqual([probeId]);
    const again = probe('new:probe-again', `${source.purpose} Again.`);

    // Active: the validator refuses it (and the name, which the drill holds).
    const whileActive = await plan('gym_withdrawn', admin, again);
    expect(whileActive.blocking.map((finding) => finding.code).sort()).toEqual(['duplicate_value', 'minted_id_exists']);
    expect(whileActive.blocking.find((finding) => finding.code === 'minted_id_exists')?.message)
      .toContain(`new:probe-again mints ${probeId}, which is already the committed item`);

    // Withdrawn: the engine refuses it, in the same words, saying why.
    await client.query("update pilot.drill_library set active = false where organization_id = 'gym_withdrawn' and drill_id = $1", [probeId]);
    const whileWithdrawn = await plan('gym_withdrawn', admin, again);
    expect(whileWithdrawn.blocking.map((finding) => [finding.code, finding.key])).toEqual([['minted_id_exists', probeId]]);
    expect(whileWithdrawn.blocking[0].message).toContain(`new:probe-again mints ${probeId}, which is already the committed item 'Probe drill' (withdrawn`);
    expect(unitOf(whileWithdrawn, probeId)).toMatchObject({ outcome: 'reject', packageKey: 'new:probe-again' });
    expect(unitOf(whileWithdrawn, probeId)?.toVersion).toBeUndefined();

    const error = await applyCommitted('gym_withdrawn', admin, again, whileWithdrawn.planHash).then(() => null, (caught: unknown) => caught);
    expect((error as ContentImportRefusal).code).toBe('PLAN_BLOCKED');
    expect(await versionsOf('gym_withdrawn', probeId)).toEqual([
      expect.objectContaining({ drill_id: probeId, version: 1, superseded: false, active: false, purpose: source.purpose }),
    ]);
  });
});

describe('universal stop rules (R3: stored once)', () => {
  const HEADER = ['organization_id', 'universal_rule_id', 'ordinal', 'condition_text', 'rule_kind', 'applies_to_contact_levels'];
  const INJURY = 'Stop when an athlete reports or shows any sign of injury.';
  const WARMUP = 'Stop contact work when the warm-up effect has clearly worn off.';
  const universal = (rows: string[][]) => ({ [UNIVERSAL_CSV]: writeCsv(HEADER, rows) });

  it('a changed universal rule creates a new version and supersedes the old; unchanged writes nothing', async () => {
    const admin = await createGym('gym_universal');
    const injuryId = MINT.universalRule(INJURY);
    const warmupId = MINT.universalRule(WARMUP);
    const first = await applyCommitted('gym_universal', admin, universal([
      ['{{PPBF_ORG_ID}}', 'new:injury', '1', INJURY, 'safety', ''],
      ['{{PPBF_ORG_ID}}', 'new:warmup', '2', WARMUP, 'warmup_decay', 'light_technical|conditioned|controlled_sparring|open_sparring'],
    ]));
    expect(first.plan.counts['universal-stop-rules']).toEqual({ new: 2, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    const stored = await observer.query(
      `select universal_rule_id, lineage_id, version, applies_to_contact_levels as applies, active, superseded_at is null as head
         from pilot.universal_stop_rules where organization_id = 'gym_universal' order by ordinal`,
    );
    expect(stored.rows).toEqual([
      { universal_rule_id: injuryId, lineage_id: injuryId, version: 1, applies: null, active: true, head: true },
      { universal_rule_id: warmupId, lineage_id: warmupId, version: 1, applies: ['light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'], active: true, head: true },
    ]);

    // The hand-off as prepare rewrites it (minted ids in place): unchanged.
    const asCommitted = [
      ['{{PPBF_ORG_ID}}', injuryId, '1', INJURY, 'safety', ''],
      ['{{PPBF_ORG_ID}}', warmupId, '2', WARMUP, 'warmup_decay', 'light_technical|conditioned|controlled_sparring|open_sparring'],
    ];
    const before = await rowVersions('gym_universal');
    const again = await applyCommitted('gym_universal', admin, universal(asCommitted));
    expect(again.importId).toBeNull();
    expect(await rowVersions('gym_universal')).toEqual(before);

    // Revised wording, same id: v2 supersedes v1; v1 stays active.
    const revisedText = `${INJURY} Get a coach before anything else.`;
    const revised = await applyCommitted('gym_universal', admin, universal([[...asCommitted[0].slice(0, 3), revisedText, 'safety', ''], asCommitted[1]]));
    expect(revised.plan.counts['universal-stop-rules']).toEqual({ new: 0, new_version: 1, unchanged: 1, absent: 0, reject: 0 });
    const v2Id = MINT.universalRuleVersion(injuryId, 2);
    expect(revised.written['universal-stop-rules']).toEqual({ inserted: [v2Id], updated: [injuryId], ledgerRows: 0 });
    const lineage = await observer.query(
      `select universal_rule_id, version, supersedes_rule_id, condition_text, active, superseded_at is null as head
         from pilot.universal_stop_rules where organization_id = 'gym_universal' and lineage_id = $1 order by version`,
      [injuryId],
    );
    expect(lineage.rows).toEqual([
      { universal_rule_id: injuryId, version: 1, supersedes_rule_id: null, condition_text: INJURY, active: true, head: false },
      { universal_rule_id: v2Id, version: 2, supersedes_rule_id: injuryId, condition_text: revisedText, active: true, head: true },
    ]);

    // Two rules trade places in one hand-off: both supersedes run before
    // either insert, so the one-current-rule-per-ordinal index never sees two.
    const swapped = await applyCommitted('gym_universal', admin, universal([
      ['{{PPBF_ORG_ID}}', injuryId, '2', revisedText, 'safety', ''],
      ['{{PPBF_ORG_ID}}', warmupId, '1', WARMUP, 'warmup_decay', 'light_technical|conditioned|controlled_sparring|open_sparring'],
    ]));
    expect(swapped.plan.counts['universal-stop-rules']).toMatchObject({ new_version: 2 });
    const current = await observer.query(
      `select lineage_id, version, ordinal from pilot.universal_stop_rules
        where organization_id = 'gym_universal' and superseded_at is null order by ordinal`,
    );
    expect(current.rows).toEqual([
      { lineage_id: warmupId, version: 2, ordinal: 1 },
      { lineage_id: injuryId, version: 3, ordinal: 2 },
    ]);
  });

  it("a new:<short-name> that mints a WITHDRAWN rule's id is refused, not planned as a revision that lands withdrawn", async () => {
    const admin = await createGym('gym_universal_withdrawn');
    const injuryId = MINT.universalRule(INJURY);
    await applyCommitted('gym_universal_withdrawn', admin, universal([['{{PPBF_ORG_ID}}', 'new:injury', '1', INJURY, 'safety', '']]));
    await client.query(
      "update pilot.universal_stop_rules set active = false where organization_id = 'gym_universal_withdrawn' and universal_rule_id = $1",
      [injuryId],
    );

    const again = universal([['{{PPBF_ORG_ID}}', 'new:injury-again', '1', INJURY, 'safety', '']]);
    const refused = await plan('gym_universal_withdrawn', admin, again);
    expect(refused.blocking.map((finding) => [finding.code, finding.key])).toEqual([['minted_id_exists', injuryId]]);
    expect(refused.blocking[0].message).toContain(`new:injury-again mints ${injuryId}, which is already the committed item '${INJURY}' (withdrawn`);
    expect(refused.units.find((unit) => unit.dataset === 'universal-stop-rules' && unit.key === injuryId)).toMatchObject({
      outcome: 'reject',
      packageKey: 'new:injury-again',
    });

    const error = await applyCommitted('gym_universal_withdrawn', admin, again, refused.planHash).then(() => null, (caught: unknown) => caught);
    expect((error as ContentImportRefusal).code).toBe('PLAN_BLOCKED');
    const rows = await observer.query(
      "select universal_rule_id, version, active, superseded_at is null as head from pilot.universal_stop_rules where organization_id = 'gym_universal_withdrawn'",
    );
    expect(rows.rows).toEqual([{ universal_rule_id: injuryId, version: 1, active: false, head: true }]);
  });
});

describe('one transaction', () => {
  it('a failure mid-way through a drill load leaves nothing', async () => {
    const admin = await prepareGym('gym_midway');
    const seen: string[] = [];
    // Plain JavaScript, not a database error, so Postgres does not abort the
    // transaction on its own: only the caller's ROLLBACK keeps the drills and
    // scale levels already inserted out of the database.
    await expect(
      runApply(
        {
          client: failingClient(/^\s*insert into pilot\.drill_stop_rules/i, seen),
          organizationId: 'gym_midway',
          actorAccountId: admin,
          seedDataDir: SEED_DATA_DIR,
          datasets: ['drill-library'],
          dryRun: false,
        },
        { log: () => undefined },
      ),
    ).rejects.toThrow('injected: a JavaScript failure mid-way through the load');
    expect(seen.indexOf('insert into pilot.drill_library')).toBeGreaterThan(-1);
    expect(seen.indexOf('insert into pilot.drill_scale_levels')).toBeGreaterThan(seen.indexOf('insert into pilot.drill_library'));

    expect(await committedCounts('gym_midway')).toMatchObject({ drills: 0, scale: 0, stop: 0, cues: 0, secondary: 0, audit: 1 });
    const { rows } = await client.query<{ open: boolean }>('select pg_current_xact_id_if_assigned() is not null as open');
    expect(rows[0].open).toBe(false);
  });

  it('a failure after the old head is superseded leaves it the head, with no v2', async () => {
    const admin = await prepareGym('gym_midway_revision');
    await applyCommitted('gym_midway_revision', admin, drillFiles());
    const revised = withEdit(drillFiles(), LIBRARY_CSV, (row) => (row.drill_id === FIRST ? { ...row, purpose: `${row.purpose} Revised.` } : row));
    const shown = await plan('gym_midway_revision', admin, revised);
    const seen: string[] = [];

    await client.query('BEGIN');
    await expect(
      applyImport({
        client: failingClient(/^\s*insert into pilot\.drill_library/i, seen),
        organizationId: 'gym_midway_revision',
        actorAccountId: admin,
        files: revised,
        expectedPlanHash: shown.planHash,
      }),
    ).rejects.toThrow('injected');
    await client.query('ROLLBACK');
    expect(seen).toContain('update pilot.drill_library set');

    const versions = await versionsOf('gym_midway_revision', FIRST);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ drill_id: FIRST, superseded: false, active: true });
  });
});
