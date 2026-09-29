// The content-import engine's DATABASE half -- plan, apply, the seeder rule,
// the history ledger and the audit row -- against the full migrated schema.
//
// IMP-06 of the intake plan. The engine is what both loaders of reference
// content call: the seed CLI now (R1 "for seeding it will be 3") and the
// upload route later (R1 "for future work it will be 2"). Every test here pins
// a failure the old per-dataset loaders had or a guarantee the new one makes:
//   - lib/seed-account-role.mjs:18-40 recorded ANY role, so the platform owner
//     could seed gym content;
//   - seed-disciplines.mjs:174 and seed-competence-cohorts.mjs:178,213 said ON
//     CONFLICT DO NOTHING, so a revised row was skipped without a word (R2
//     says it gets a new version, the old one kept);
//   - seed-disciplines.mjs:208-213 COMMITs in a `finally`, so a JavaScript
//     error after the first insert committed that insert.
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

import { assertImportActor, type DbClient } from './contentImport/actor';
import { applyImport } from './contentImport/apply';
import { readDatasetFiles, runApply } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { MINT } from './contentImport/ids';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import { ContentImportRefusal } from './contentImport/refusal';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_engine';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-engine-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const CLI_SCRIPT = path.join(WEB_DIR, 'scripts/pilot-content-import.ts');
const TSX_CLI = path.resolve(WEB_DIR, '../../node_modules/tsx/dist/cli.mjs');

const REGISTRIES = ['disciplines', 'competence-levels', 'cohort-definitions'] as const;
const DISCIPLINES_CSV = 'multidiscipline/seed_disciplines.csv';
const LEVELS_CSV = 'competence-cohorts/seed_competence_levels.csv';
const COHORTS_CSV = 'competence-cohorts/seed_cohort_definitions.csv';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type OldSeedAll = (client: Client, seedDir: string, placeholders: { organizationId: string }, options?: { dryRun?: boolean }) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
/** A second connection: sees only what is COMMITTED. */
let observer: Client;
let oldSeedDisciplines: OldSeedAll;
let oldSeedCompetenceCohorts: OldSeedAll;

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

  // The OLD loaders, exactly as the seed workflow runs them today, to build
  // an organization the way production's reference rows were built.
  oldSeedDisciplines = (await nativeDynamicImport(pathToFileURL(path.join(WEB_DIR, 'scripts/seed-disciplines.mjs')).href)).seedAll as OldSeedAll;
  oldSeedCompetenceCohorts = (await nativeDynamicImport(pathToFileURL(path.join(WEB_DIR, 'scripts/seed-competence-cohorts.mjs')).href))
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
});

// ---------------------------------------------------------------------------
// Fixtures

async function createOrganization(organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict (organization_id) do nothing`,
    [organizationId],
  );
}

interface AccountOptions {
  role?: string;
  homeOrganizationId: string;
  isPlatformOwner?: boolean;
  active?: boolean;
  deleted?: boolean;
  /** Organizations the account holds a membership in, and whether each is active. */
  memberships?: Record<string, boolean>;
}

async function createAccount(accountId: string, options: AccountOptions): Promise<string> {
  await createOrganization(options.homeOrganizationId);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag, deleted_at)
     values ($1, $2, $3, $4, $5, case when $6 then now() else null end)`,
    [accountId, options.role ?? 'organization_admin', options.homeOrganizationId, options.isPlatformOwner ?? false, options.active ?? true, options.deleted ?? false],
  );
  for (const [organizationId, active] of Object.entries(options.memberships ?? {})) {
    await createOrganization(organizationId);
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)`,
      [accountId, organizationId, options.role ?? 'organization_admin', active],
    );
  }
  return accountId;
}

/** A gym and an organization admin of it with an active membership: the account the rule accepts. */
async function createGym(organizationId: string): Promise<string> {
  await createOrganization(organizationId);
  return createAccount(`admin@${organizationId}`, { homeOrganizationId: organizationId, memberships: { [organizationId]: true } });
}

/**
 * Every claim id of the LOADED research package as chunks of the shared
 * __platform__ library, which referenceSetsDb.ts reads for every gym.
 */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url)
     values ('src_engine_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/engine-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_engine_test', 'src_engine_test', '__platform__', 'Loaded research claims (test)', 'engine-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_engine_test', 'src_engine_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
            jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)`,
    [ids],
  );
}

function committedFiles(): Record<string, string> {
  return readDatasetFiles(SEED_DATA_DIR, REGISTRIES);
}

/** The committed files with one CSV edited through the real reader and writer. */
function withEdit(
  files: Record<string, string>,
  file: string,
  edit: (row: Record<string, string>) => Record<string, string> | null,
): Record<string, string> {
  const table = readCsv(files[file]);
  const rows: string[][] = [];
  for (const record of table.records) {
    const row = Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]]));
    const edited = edit(row);
    if (edited) rows.push(table.header.map((name) => edited[name] ?? ''));
  }
  return { ...files, [file]: writeCsv(table.header, rows) };
}

function withAddedRow(files: Record<string, string>, file: string, row: Record<string, string>): Record<string, string> {
  const table = readCsv(files[file]);
  const rows = table.records.map((record) => record.cells);
  rows.push(table.header.map((name) => row[name] ?? ''));
  return { ...files, [file]: writeCsv(table.header, rows) };
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

async function seedTheOldWay(organizationId: string): Promise<void> {
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await oldSeedDisciplines(client, path.join(SEED_DATA_DIR, 'multidiscipline'), { organizationId });
    await oldSeedCompetenceCohorts(client, path.join(SEED_DATA_DIR, 'competence-cohorts'), { organizationId });
  } finally {
    quiet.mockRestore();
  }
}

interface Counts {
  disciplines: number;
  levels: number;
  cohorts: number;
  ledger: number;
  audit: number;
  shadowEvents: number;
}

/** Committed rows only: read on the observer connection. */
async function committedCounts(organizationId: string): Promise<Counts> {
  const { rows } = await observer.query<{ [K in keyof Counts]: string }>(
    `select
       (select count(*) from pilot.disciplines where organization_id = $1) as disciplines,
       (select count(*) from pilot.competence_levels where organization_id = $1) as levels,
       (select count(*) from pilot.cohort_definitions where organization_id = $1) as cohorts,
       (select count(*) from pilot.reference_content_revisions where organization_id = $1) as ledger,
       (select count(*) from pilot.audit_events where organization_id = $1 and entity_type = 'content_import') as audit,
       (select count(*) from pilot.shadow_events where organization_id = $1 and entity_type = 'content_import') as "shadowEvents"`,
    [organizationId],
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as unknown as Counts;
}

/**
 * Every registry row's xmin -- the id of the transaction that wrote its
 * current version. The three registry tables have no updated_at
 * (multidiscipline migration :35-50, competence_cohorts migration :28-37,
 * :107-142), and xmin is the stronger test anyway: ANY update, even one that
 * writes identical values, gives the row a new xmin.
 */
async function rowVersions(organizationId: string): Promise<Record<string, string>> {
  const { rows } = await observer.query<{ key: string; xmin: string }>(
    `select 'disciplines:' || discipline as key, xmin::text as xmin from pilot.disciplines where organization_id = $1
     union all
     select 'levels:' || level_key, xmin::text from pilot.competence_levels where organization_id = $1
     union all
     select 'cohorts:' || cohort_id, xmin::text from pilot.cohort_definitions where organization_id = $1`,
    [organizationId],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.xmin]));
}

async function ledgerRows(organizationId: string, dataset: string, itemKey: string) {
  const { rows } = await observer.query<{ version: number; content: Record<string, string>; import_id: string; recorded_by_account_id: string; recorded_by_role: string }>(
    `select version, content, import_id, recorded_by_account_id, recorded_by_role
       from pilot.reference_content_revisions
      where organization_id = $1 and dataset = $2 and item_key = $3
      order by version`,
    [organizationId, dataset, itemKey],
  );
  return rows;
}

function unitsOf(result: ImportPlan, outcome: string): string[] {
  return result.units.filter((unit) => unit.outcome === outcome).map((unit) => `${unit.dataset}:${unit.key}`);
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ContentImportRefusal);
  expect((error as ContentImportRefusal).code).toBe(code);
}

// ---------------------------------------------------------------------------

describe('who may load content (actor.ts)', () => {
  it('a platform_owner seeding punxsy_prominence is refused, even holding an active membership there', async () => {
    const accepted = await createGym('punxsy_prominence');
    const platformOwner = await createAccount('Admin@punxsyprominence.org', {
      role: 'platform_owner',
      isPlatformOwner: true,
      homeOrganizationId: 'punxsy_prominence',
      memberships: { punxsy_prominence: true },
    });
    // The flag alone makes an account the platform owner, whatever its role says.
    const flagged = await createAccount('flagged-admin@punxsyprominence.org', {
      role: 'admin',
      isPlatformOwner: true,
      homeOrganizationId: 'punxsy_prominence',
      memberships: { punxsy_prominence: true },
    });

    await expectRefusal(plan('punxsy_prominence', platformOwner, committedFiles()), 'ACTOR_PLATFORM_OWNER');
    await expectRefusal(plan('punxsy_prominence', flagged, committedFiles()), 'ACTOR_PLATFORM_OWNER');

    // Through the command the seed workflow will run: refused, nothing written.
    const lines: string[] = [];
    const code = await runApply(
      { client, organizationId: 'punxsy_prominence', actorAccountId: platformOwner, seedDataDir: SEED_DATA_DIR, datasets: REGISTRIES, dryRun: false },
      { log: (line) => lines.push(line) },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('RESULT: REFUSED -- CONTENT_IMPORT_ACTOR_PLATFORM_OWNER');
    expect(await committedCounts('punxsy_prominence')).toMatchObject({ disciplines: 0, levels: 0, cohorts: 0, ledger: 0, audit: 0 });

    // Control: the gym's organization admin is accepted by the same check.
    const plannedByAdmin = await plan('punxsy_prominence', accepted, committedFiles());
    expect(plannedByAdmin.blocking).toEqual([]);
    expect(plannedByAdmin.totals.new).toBe(17);
  });

  it('refuses an inactive account, a deleted account, and an organization admin without an ACTIVE membership in the target org', async () => {
    await createGym('gym_actor_rules');
    const inactive = await createAccount('inactive@gym_actor_rules', {
      homeOrganizationId: 'gym_actor_rules',
      active: false,
      memberships: { gym_actor_rules: true },
    });
    const deleted = await createAccount('deleted@gym_actor_rules', {
      homeOrganizationId: 'gym_actor_rules',
      deleted: true,
      memberships: { gym_actor_rules: true },
    });
    // An admin of ANOTHER gym: no membership here at all.
    const otherGym = await createAccount('admin@gym_elsewhere', { homeOrganizationId: 'gym_elsewhere', memberships: { gym_elsewhere: true } });
    // Home org IS the target, but the membership was switched off: the home
    // org alone must not be enough (the critique's correction; auth.ts:396-399).
    const switchedOff = await createAccount('switched-off@gym_actor_rules', {
      homeOrganizationId: 'gym_actor_rules',
      memberships: { gym_actor_rules: false },
    });
    const noRow = await createAccount('no-membership@gym_actor_rules', { homeOrganizationId: 'gym_actor_rules' });
    const coach = await createAccount('coach@gym_actor_rules', {
      role: 'coach',
      homeOrganizationId: 'gym_actor_rules',
      memberships: { gym_actor_rules: true },
    });

    await expectRefusal(assertImportActor(client, 'gym_actor_rules', inactive), 'ACTOR_INACTIVE');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', deleted), 'ACTOR_DELETED');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', otherGym), 'ACTOR_NOT_A_MEMBER');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', switchedOff), 'ACTOR_NOT_A_MEMBER');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', noRow), 'ACTOR_NOT_A_MEMBER');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', coach), 'ACTOR_ROLE_NOT_ALLOWED');
    await expectRefusal(assertImportActor(client, 'gym_actor_rules', 'nobody@gym_actor_rules'), 'ACTOR_NOT_FOUND');
    await expectRefusal(assertImportActor(client, 'no_such_gym', otherGym), 'ORGANIZATION_NOT_FOUND');

    // apply checks again inside its own transaction; a refused actor writes nothing.
    await expectRefusal(applyCommitted('gym_actor_rules', switchedOff, committedFiles(), 'any-hash'), 'ACTOR_NOT_A_MEMBER');
    expect(await committedCounts('gym_actor_rules')).toMatchObject({ disciplines: 0, ledger: 0, audit: 0 });
  });

  it('accepts an admin whose home org is elsewhere but who holds an active membership in the target org', async () => {
    await createGym('gym_secondary');
    const visiting = await createAccount('visiting-admin@gym_home', {
      role: 'admin',
      homeOrganizationId: 'gym_home',
      memberships: { gym_home: true, gym_secondary: true },
    });
    await expect(assertImportActor(client, 'gym_secondary', visiting)).resolves.toMatchObject({ accountId: visiting, role: 'admin', isPlatformOwner: false });
  });

  it('__platform__ takes the platform owner only', async () => {
    const owner = await createAccount('owner@platform-test', { role: 'platform_owner', isPlatformOwner: true, homeOrganizationId: 'gym_platform_home' });
    const orgAdmin = await createGym('gym_platform_other');
    await expect(assertImportActor(client, '__platform__', owner)).resolves.toMatchObject({ isPlatformOwner: true });
    await expectRefusal(assertImportActor(client, '__platform__', orgAdmin), 'ACTOR_NOT_PLATFORM_OWNER');
  });
});

describe('registries: disciplines, competence levels, cohort definitions', () => {
  it('re-importing the committed files onto rows the OLD loaders wrote finds every item unchanged', async () => {
    // The canonicaliser guard: the old loaders stored '2.0' as 2, a blank
    // contact_permitted as 'none', a blank governing_body as NULL. If the
    // engine read any of that as different content, the first run in
    // production would "revise" every row it was meant to leave alone.
    const admin = await createGym('gym_old_loaders');
    await seedTheOldWay('gym_old_loaders');
    expect(await committedCounts('gym_old_loaders')).toMatchObject({ disciplines: 5, levels: 6, cohorts: 6 });

    const result = await plan('gym_old_loaders', admin, committedFiles());
    expect(result.blocking).toEqual([]);
    expect(result.totals).toEqual({ new: 0, new_version: 0, unchanged: 17, absent: 0, reject: 0 });
  });

  it('a first load inserts every row and records each as history v1', async () => {
    const admin = await createGym('gym_first_load');
    const result = await applyCommitted('gym_first_load', admin, committedFiles());
    expect(result.plan.totals).toEqual({ new: 17, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    expect(await committedCounts('gym_first_load')).toEqual({ disciplines: 5, levels: 6, cohorts: 6, ledger: 17, audit: 1, shadowEvents: 0 });
    const boxing = await ledgerRows('gym_first_load', 'disciplines', 'boxing');
    expect(boxing.map((row) => row.version)).toEqual([1]);
    expect(boxing[0]).toMatchObject({ import_id: result.importId, recorded_by_account_id: admin, recorded_by_role: 'organization_admin' });
    expect(boxing[0].content.display_name).toBe('Boxing');
  });

  it('a changed discipline updates the live row in place, and the ledger holds before and after', async () => {
    const admin = await createGym('gym_revise');
    await seedTheOldWay('gym_revise'); // no history yet, as in production today
    const before = await rowVersions('gym_revise');

    const revised = withEdit(committedFiles(), DISCIPLINES_CSV, (row) =>
      row.discipline === 'boxing' ? { ...row, display_name: 'Olympic-style Boxing', governing_body: 'USA Boxing (amateur)' } : row);
    const planned = await plan('gym_revise', admin, revised);
    expect(unitsOf(planned, 'new_version')).toEqual(['disciplines:boxing']);
    expect(planned.units.find((unit) => unit.key === 'boxing')).toMatchObject({ fromVersion: 1, toVersion: 2, recordsBefore: true });
    expect(planned.totals).toEqual({ new: 0, new_version: 1, unchanged: 16, absent: 0, reject: 0 });

    const result = await applyCommitted('gym_revise', admin, revised, planned.planHash);
    expect(result.written.disciplines).toEqual({ inserted: [], updated: ['boxing'], ledgerRows: 2 });

    // In place: still five rows, same key, new content.
    const { rows } = await observer.query<{ display_name: string; governing_body: string }>(
      "select display_name, governing_body from pilot.disciplines where organization_id = 'gym_revise' and discipline = 'boxing'",
    );
    expect(rows).toEqual([{ display_name: 'Olympic-style Boxing', governing_body: 'USA Boxing (amateur)' }]);
    expect(await committedCounts('gym_revise')).toMatchObject({ disciplines: 5, levels: 6, cohorts: 6, ledger: 2, audit: 1 });

    // Before (v1, the row as the old loader wrote it) and after (v2).
    const history = await ledgerRows('gym_revise', 'disciplines', 'boxing');
    expect(history.map((row) => [row.version, row.content.display_name, row.content.governing_body])).toEqual([
      [1, 'Boxing', 'USA Boxing'],
      [2, 'Olympic-style Boxing', 'USA Boxing (amateur)'],
    ]);

    // Only boxing was written.
    const after = await rowVersions('gym_revise');
    const moved = Object.keys(before).filter((key) => before[key] !== after[key]);
    expect(moved).toEqual(['disciplines:boxing']);

    // A second revision appends v3 only: v2 already records what the row says.
    const again = withEdit(revised, DISCIPLINES_CSV, (row) => (row.discipline === 'boxing' ? { ...row, display_name: 'Boxing (amateur)' } : row));
    const second = await applyCommitted('gym_revise', admin, again);
    expect(second.plan.units.find((unit) => unit.key === 'boxing')).toMatchObject({ outcome: 'new_version', fromVersion: 2, toVersion: 3 });
    expect((await ledgerRows('gym_revise', 'disciplines', 'boxing')).map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it('an unchanged re-import writes nothing: no row gets a new version, zero ledger rows, zero audit rows', async () => {
    const admin = await createGym('gym_unchanged');
    await applyCommitted('gym_unchanged', admin, committedFiles());
    const countsBefore = await committedCounts('gym_unchanged');
    const versionsBefore = await rowVersions('gym_unchanged');
    expect(Object.keys(versionsBefore)).toHaveLength(17);

    const result = await applyCommitted('gym_unchanged', admin, committedFiles());
    expect(result.plan.totals).toEqual({ new: 0, new_version: 0, unchanged: 17, absent: 0, reject: 0 });
    expect(result.importId).toBeNull();
    expect(result.ledgerRows).toBe(0);

    expect(await rowVersions('gym_unchanged')).toEqual(versionsBefore);
    expect(await committedCounts('gym_unchanged')).toEqual(countsBefore);
  });

  it('a JavaScript error after the first write leaves nothing committed', async () => {
    const admin = await createGym('gym_js_error');
    const seen: string[] = [];
    // Throws -- plain JavaScript, not a database error, so Postgres does NOT
    // abort the transaction -- at the first history-ledger insert, which
    // comes right after the first row is inserted. A caller that committed
    // anyway (the old `finally`) would keep that row.
    const failing = {
      query: (...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
        seen.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/^\s*insert into pilot\.reference_content_revisions/i.test(text)) {
          throw new Error('injected: a JavaScript failure after the first write');
        }
        return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as DbClient;

    await expect(
      runApply(
        { client: failing, organizationId: 'gym_js_error', actorAccountId: admin, seedDataDir: SEED_DATA_DIR, datasets: REGISTRIES, dryRun: false },
        { log: () => undefined },
      ),
    ).rejects.toThrow('injected: a JavaScript failure after the first write');

    // It really was AFTER a write.
    const firstWrite = seen.indexOf('insert into pilot.disciplines');
    expect(firstWrite).toBeGreaterThan(-1);
    expect(seen.indexOf('insert into pilot.reference_content_revisions')).toBeGreaterThan(firstWrite);

    expect(await committedCounts('gym_js_error')).toEqual({ disciplines: 0, levels: 0, cohorts: 0, ledger: 0, audit: 0, shadowEvents: 0 });
    // And the connection was handed back outside any transaction.
    const { rows } = await client.query<{ open: boolean }>("select pg_current_xact_id_if_assigned() is not null as open");
    expect(rows[0].open).toBe(false);
  });

  it('apply refuses when the database changed after the plan; an edit to an item the files do not name does not count', async () => {
    const admin = await createGym('gym_stale');
    await applyCommitted('gym_stale', admin, committedFiles());
    // A row only the database has: absent from the files, listed, left alone.
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ('gym_stale', 'kickboxing', 'Kickboxing', 'striking', 'head_impact')`,
    );

    const revised = withEdit(committedFiles(), DISCIPLINES_CSV, (row) => (row.discipline === 'boxing' ? { ...row, display_name: 'Boxing, revised' } : row));
    const shown = await plan('gym_stale', admin, revised);
    expect(unitsOf(shown, 'absent')).toEqual(['disciplines:kickboxing']);
    expect(unitsOf(shown, 'new_version')).toEqual(['disciplines:boxing']);

    // Someone edits wrestling in the app after the person saw the plan.
    await observer.query("update pilot.disciplines set evidence_note = 'edited in the app' where organization_id = 'gym_stale' and discipline = 'wrestling'");
    const countsBefore = await committedCounts('gym_stale');
    await expectRefusal(applyCommitted('gym_stale', admin, revised, shown.planHash), 'STALE_PLAN');
    expect(await committedCounts('gym_stale')).toEqual(countsBefore);
    const { rows } = await observer.query("select display_name from pilot.disciplines where organization_id = 'gym_stale' and discipline = 'boxing'");
    expect(rows).toEqual([{ display_name: 'Boxing' }]);

    // An edit to the absent row changes nothing this import would write.
    const reshown = await plan('gym_stale', admin, revised);
    // Wrestling's ledger head (v1, the first load) no longer matches the row,
    // so the row as the app left it is recorded first (ledger.ts:20-24, :67).
    expect(reshown.units.find((unit) => unit.dataset === 'disciplines' && unit.key === 'wrestling')).toMatchObject({
      outcome: 'new_version',
      fromVersion: 2,
      toVersion: 3,
      recordsBefore: true,
    });
    await observer.query("update pilot.disciplines set display_name = 'Kickboxing (edited)' where organization_id = 'gym_stale' and discipline = 'kickboxing'");
    const applied = await applyCommitted('gym_stale', admin, revised, reshown.planHash);
    expect(applied.written.disciplines?.updated.sort()).toEqual(['boxing', 'wrestling']);
    const kick = await observer.query("select display_name from pilot.disciplines where organization_id = 'gym_stale' and discipline = 'kickboxing'");
    expect(kick.rows).toEqual([{ display_name: 'Kickboxing (edited)' }]);

    // The history never skips a state the row held: the file's note (first
    // load), the note edited in the app, then the file's note again.
    const disciplinesTable = readCsv(committedFiles()[DISCIPLINES_CSV]);
    const wrestlingCells = disciplinesTable.records.find((record) => record.cells[disciplinesTable.header.indexOf('discipline')] === 'wrestling')?.cells;
    const fileNote = wrestlingCells?.[disciplinesTable.header.indexOf('evidence_note')];
    expect(fileNote).toContain('CB-002');
    const wrestling = await ledgerRows('gym_stale', 'disciplines', 'wrestling');
    expect(wrestling.map((row) => [row.version, row.content.evidence_note])).toEqual([
      [1, fileNote],
      [2, 'edited in the app'],
      [3, fileNote],
    ]);
    expect(wrestling[1].import_id).toBe(applied.importId);
    expect(wrestling[2].import_id).toBe(applied.importId);
  });

  it('holds the rows it will write: an edit in flight when apply starts is waited for, then seen, and the plan is refused as stale', async () => {
    // Without the FOR UPDATE before the re-plan, apply would re-plan against
    // the row as last committed, find its hash unchanged, then block on the
    // UPDATE and -- once the other writer commits -- overwrite that writer's
    // edit with content planned against a state that no longer exists.
    const admin = await createGym('gym_locks');
    await applyCommitted('gym_locks', admin, committedFiles());
    const revised = withEdit(committedFiles(), DISCIPLINES_CSV, (row) => (row.discipline === 'boxing' ? { ...row, display_name: 'Boxing, revised' } : row));
    const shown = await plan('gym_locks', admin, revised);

    await observer.query('BEGIN');
    try {
      await observer.query("update pilot.disciplines set display_name = 'Boxing (edited in the app)' where organization_id = 'gym_locks' and discipline = 'boxing'");
      let settled = false;
      const applying = applyCommitted('gym_locks', admin, revised, shown.planHash).finally(() => {
        settled = true;
      });
      applying.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false); // waiting on the other writer's row
      await observer.query('COMMIT');
      await expectRefusal(applying, 'STALE_PLAN');
    } finally {
      await observer.query('ROLLBACK').catch(() => undefined);
    }
    const { rows } = await observer.query("select display_name from pilot.disciplines where organization_id = 'gym_locks' and discipline = 'boxing'");
    expect(rows).toEqual([{ display_name: 'Boxing (edited in the app)' }]);
  });

  it('exactly one content_import audit row is written, inside the transaction', async () => {
    const admin = await createGym('gym_audit');
    const files = committedFiles();
    const shown = await plan('gym_audit', admin, files);

    await client.query('BEGIN');
    let importId: string | null = null;
    try {
      const result = await applyImport({ client, organizationId: 'gym_audit', actorAccountId: admin, files, expectedPlanHash: shown.planHash });
      importId = result.importId;
      const inside = await client.query<{ entity_id: string; event_type: string; actor_account_id: string; actor_role: string; details: Record<string, unknown> }>(
        "select entity_id, event_type, actor_account_id, actor_role, details from pilot.audit_events where organization_id = 'gym_audit' and entity_type = 'content_import'",
      );
      expect(inside.rows).toHaveLength(1);
      expect(inside.rows[0]).toMatchObject({ entity_id: importId, event_type: 'create', actor_account_id: admin, actor_role: 'organization_admin' });
      expect(inside.rows[0].details).toMatchObject({
        import_id: importId,
        plan_hash: shown.planHash,
        datasets: ['disciplines', 'competence-levels', 'cohort-definitions'],
        ledger_rows: 17,
      });
      // Not visible to any other connection until COMMIT: it rides the
      // import's own transaction, not the pool writePilotAuditEvent uses.
      expect((await committedCounts('gym_audit')).audit).toBe(0);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    expect(await committedCounts('gym_audit')).toMatchObject({ audit: 1, ledger: 17 });
    const ledgerImports = await observer.query("select distinct import_id from pilot.reference_content_revisions where organization_id = 'gym_audit'");
    expect(ledgerImports.rows).toEqual([{ import_id: importId }]);
  });

  it('an ordinal change on a competence level is blocked; other fields of a level may change', async () => {
    const admin = await createGym('gym_ordinals');
    await applyCommitted('gym_ordinals', admin, committedFiles());

    const moved = withEdit(committedFiles(), LEVELS_CSV, (row) => (row.level_key === 'holding' ? { ...row, ordinal: '7' } : row));
    const blocked = await plan('gym_ordinals', admin, moved);
    expect(blocked.blocking.map((finding) => [finding.code, finding.key])).toEqual([['ordinal_change', 'holding']]);
    expect(blocked.units.find((unit) => unit.key === 'holding')).toMatchObject({ outcome: 'reject' });
    await expectRefusal(applyCommitted('gym_ordinals', admin, moved, blocked.planHash), 'PLAN_BLOCKED');

    // A swap is two ordinal changes -- a blocking finding each, not a 23505 mid-load.
    const swapped = withEdit(committedFiles(), LEVELS_CSV, (row) =>
      row.level_key === 'forming' ? { ...row, ordinal: '3' } : row.level_key === 'holding' ? { ...row, ordinal: '2' } : row);
    expect((await plan('gym_ordinals', admin, swapped)).blocking.map((finding) => [finding.code, finding.key]).sort()).toEqual([
      ['ordinal_change', 'forming'],
      ['ordinal_change', 'holding'],
    ]);

    const { rows } = await observer.query("select level_key, ordinal from pilot.competence_levels where organization_id = 'gym_ordinals' and level_key in ('forming', 'holding') order by ordinal");
    expect(rows).toEqual([{ level_key: 'forming', ordinal: 2 }, { level_key: 'holding', ordinal: 3 }]);

    const renamed = withEdit(committedFiles(), LEVELS_CSV, (row) => (row.level_key === 'holding' ? { ...row, display_name: 'Holding shape' } : row));
    const allowed = await applyCommitted('gym_ordinals', admin, renamed);
    expect(allowed.written['competence-levels']).toEqual({ inserted: [], updated: ['holding'], ledgerRows: 1 });
  });

  it('a new cohort written as new:<name> is inserted under its minted id, and cohorts load after the disciplines they name', async () => {
    const admin = await createGym('gym_new_cohort');
    const files = withAddedRow(committedFiles(), COHORTS_CSV, {
      organization_id: '{{PPBF_ORG_ID}}',
      cohort_id: 'new:morning-conditioning',
      cohort_name: 'Morning Conditioning',
      discipline: 'conditioning',
      contact_permitted: 'none',
      requires_coach_approval: 'true',
      notes: 'Before-school conditioning block.',
    });
    const result = await applyCommitted('gym_new_cohort', admin, files);
    const minted = MINT.cohort('Morning Conditioning');
    expect(result.plan.units.find((unit) => unit.packageKey === 'new:morning-conditioning')).toMatchObject({ key: minted, outcome: 'new' });
    const { rows } = await observer.query(
      'select cohort_name, discipline, active_flag, required_domains from pilot.cohort_definitions where organization_id = $1 and cohort_id = $2',
      ['gym_new_cohort', minted],
    );
    expect(rows).toEqual([{ cohort_name: 'Morning Conditioning', discipline: 'conditioning', active_flag: true, required_domains: '' }]);
  });

  it('refuses apply outside a transaction, and a package carrying material it cannot load yet', async () => {
    const admin = await createGym('gym_guards');
    const shown = await plan('gym_guards', admin, committedFiles());
    await expectRefusal(
      applyImport({ client, organizationId: 'gym_guards', actorAccountId: admin, files: committedFiles(), expectedPlanHash: shown.planHash }),
      'NOT_IN_TRANSACTION',
    );
    expect(await committedCounts('gym_guards')).toMatchObject({ disciplines: 0, ledger: 0, audit: 0 });

    // Transfer claims: a type no engine loads yet (the drill library was the
    // example here until IMP-07 registered it).
    const withClaims = { ...committedFiles(), 'transfer-claims/seed_transfer_claims.csv': await fs.readFile(path.join(SEED_DATA_DIR, 'transfer-claims/seed_transfer_claims.csv'), 'utf8') };
    const refused = await plan('gym_guards', admin, withClaims);
    expect(refused.blocking.filter((finding) => finding.code === 'dataset_not_loadable').map((finding) => finding.file)).toEqual([
      'transfer-claims/seed_transfer_claims.csv',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The real command, as the seed workflow will run it.

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_SCRIPT, ...args], {
      cwd: WEB_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`content-import CLI timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 180_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** From the PLAN line to PLAN_HASH, inclusive: the plan exactly as printed. */
function planBlock(stdout: string): string[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('PLAN for organization'));
  const end = lines.findIndex((line) => line.startsWith('PLAN_HASH: '));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1);
}

describe('the content-import command (scripts/pilot-content-import.ts)', () => {
  let env: Record<string, string>;

  beforeAll(async () => {
    const admin = await createGym('gym_cli');
    // 'all' includes the drill library since IMP-07, and its drills cite
    // research claims: the plan checks each against the claims this gym can
    // read (referenceSetsDb.ts), so the loaded package's claims go into the
    // shared __platform__ library first, as in production.
    await loadPlatformClaims();
    env = {
      AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(DATABASE),
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
      PPBF_EXPECTED_POSTGRES_DATABASE: DATABASE,
      PPBF_SEED_ORG_ID: 'gym_cli',
      PPBF_SEED_ACCOUNT_ID: admin,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
    };
  });

  it('--dry-run leaves zero rows and prints the same plan as plan', async () => {
    const planned = await runCli(['plan', '--dataset', 'all'], env);
    expect({ code: planned.code, stderr: planned.stderr }).toEqual({ code: 0, stderr: '' });
    const dry = await runCli(['apply', '--dry-run', '--dataset', 'all'], env);
    expect({ code: dry.code, stderr: dry.stderr }).toEqual({ code: 0, stderr: '' });

    const shown = planBlock(planned.stdout);
    expect(planBlock(dry.stdout)).toEqual(shown);
    expect(shown).toContain('  disciplines: 5 new, 0 new version, 0 unchanged, 0 absent, 0 reject');
    expect(shown).toContain('  drill-library: 119 new, 0 new version, 0 unchanged, 0 absent, 0 reject');
    expect(shown).toContain('BLOCKING: 0');
    expect(dry.stdout).toContain('RESULT: DRY RUN -- applied inside the transaction and ROLLED BACK');
    // It really applied: the rows were written, then rolled back.
    expect(dry.stdout).toContain('  cohort-definitions: inserted 6');

    expect(await committedCounts('gym_cli')).toEqual({ disciplines: 0, levels: 0, cohorts: 0, ledger: 0, audit: 0, shadowEvents: 0 });
  });

  it('apply --dataset all commits the registries and the drills together, mirrors the audit event after commit, and a re-plan finds nothing to do', async () => {
    const applied = await runCli(['apply', '--dataset', 'all'], env);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.stdout).toContain('target_hostname: localhost');
    // 17 registry rows and 119 drills, in one transaction: the drills'
    // discipline foreign key is satisfied by disciplines written earlier in it.
    expect(applied.stdout).toContain('RESULT: COMMITTED -- 136 item(s) written');
    expect(await committedCounts('gym_cli')).toEqual({ disciplines: 5, levels: 6, cohorts: 6, ledger: 17, audit: 1, shadowEvents: 1 });
    const drills = await observer.query("select count(*)::int as n from pilot.drill_library where organization_id = 'gym_cli'");
    expect(drills.rows).toEqual([{ n: 119 }]);
    const mirror = await observer.query("select event_name from pilot.shadow_events where organization_id = 'gym_cli' and entity_type = 'content_import'");
    expect(mirror.rows).toEqual([{ event_name: 'SHADOW_AUDIT_CREATE_CONTENT_IMPORT' }]);

    const again = await runCli(['plan', '--dataset', 'all'], env);
    expect(again.code).toBe(0);
    expect(planBlock(again.stdout)).toContain('  cohort-definitions: 0 new, 0 new version, 6 unchanged, 0 absent, 0 reject');
    expect(planBlock(again.stdout)).toContain('  drill-library: 0 new, 0 new version, 119 unchanged, 0 absent, 0 reject');
    expect(again.stdout).toContain('RESULT: PLANNED -- 0 item(s) would be written.');
  });

  it('refuses a connection string that is not the declared target, before connecting', async () => {
    const wrong = await runCli(['plan', '--dataset', 'all'], { ...env, PPBF_EXPECTED_POSTGRES_DATABASE: 'some_other_database' });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('POSTGRES_TARGET_MISMATCH');
  });
});
