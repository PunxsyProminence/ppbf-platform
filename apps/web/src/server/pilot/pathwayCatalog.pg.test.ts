// The pathway catalog (SCHEMA_PROPOSAL P1, P2, P7 catalog half; lane BB-1b),
// DATABASE half: the pathway_catalog migration applies, and a pathway-catalog
// package validates, plans, dry-runs, applies, versions and retires; link
// ends, scopes and content stage keys are refused by name.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { applyImport } from './contentImport/apply';
import { formatPlan, readDatasetFiles, runApply } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { type ImportPlan, planImport } from './contentImport/plan';
import { loadOfflineReferenceSets } from './contentImport/referenceSets';
import { hex14 } from './contentImport/ids';
import { validatePackage } from './contentImport/validate';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'pathway_catalog';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-pathway-catalog-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-pathway-catalog-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_pathway_catalog_migration.sql');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const STAGES = 'pathway-catalog/seed_pathway_stages.csv';
const LINKS = 'pathway-catalog/seed_pathway_stage_links.csv';
const DEFAULTS = 'pathway-catalog/seed_pathway_stage_defaults.csv';
const DISCIPLINES = 'multidiscipline/seed_disciplines.csv';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let applyMigrationTransaction: (c: Client, sql: string) => Promise<void>;

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
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as (c: Client, sql: string) => Promise<void>;
});

afterAll(async () => {
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

/** A gym and an organization admin of it with an active membership. */
async function createGym(organizationId: string): Promise<string> {
  const account = `admin@${organizationId}`;
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [organizationId]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag) values ($1, 'organization_admin', $2, false, true)`,
    [account, organizationId],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'organization_admin', true)`,
    [account, organizationId],
  );
  return account;
}

const ORG = '{{PPBF_ORG_ID}}';
const PINNED_BASE_HASH = 'bba5875f46eef7c5b61ea8f9de1ea7ba216a5ecae01f7676ffde1e39a35219ab';
const LABELS = JSON.stringify({ name: { status: 'REPORTED', sources: ['DOC-156'] }, who_text: { status: 'INFERRED', sources: ['inference'] } });
const EVIDENCE = JSON.stringify([
  { evidence_category: 'convention', evidence_label: 'CONVENTION', check_state: 'unchecked', basis: 'PPBF owner-system practice' },
  { evidence_category: 'research', evidence_label: 'EMERGING', check_state: 'verified', source_key: 'EXT-TEST' },
]);
// A dft_ id is the backbone's own ('dft_' + hex14(scope:default_key)), kept as given and checked, never re-minted.
const DFT_Y1 = `dft_${hex14('Y1:sparring_rounds_per_7d_max')}`;
const DFT_LANE = `dft_${hex14('lane:non_contact:contact_level_ceiling')}`;

const STAGE_HEADER = ['organization_id', 'stage_key', 'segment', 'ordinal', 'name', 'who_text', 'contact_default', 'ppbf_name', 'backbone_version', 'field_labels'];
const LINK_HEADER = ['organization_id', 'from_stage_key', 'to_stage_key', 'link_kind', 'backbone_version'];
const DEFAULT_HEADER = [
  'organization_id', 'default_id', 'scope', 'default_key', 'kind', 'value_text', 'value_min', 'value_max', 'unit', 'window_days', 'phases',
  'display_text', 'status', 'sources', 'backbone_version', 'evidence',
];

type Row = Record<string, string>;
const csv = (header: string[], rows: Row[]) => writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));

const Y1: Row = {
  organization_id: ORG, stage_key: 'Y1', segment: 'youth', ordinal: '1', name: 'Introduction', who_text: 'Ages 5-8, a guide',
  contact_default: 'none', ppbf_name: 'AURORA', backbone_version: 'draft-1', field_labels: LABELS,
};
const Y2: Row = { organization_id: ORG, stage_key: 'Y2', segment: 'youth', ordinal: '2', name: 'Foundations', contact_default: 'none', ppbf_name: 'ORIENS', backbone_version: 'draft-1' };
const Y1_Y2: Row = { organization_id: ORG, from_stage_key: 'Y1', to_stage_key: 'Y2', link_kind: 'progression', backbone_version: 'draft-1' };
const D_Y1: Row = {
  organization_id: ORG, default_id: DFT_Y1, scope: 'Y1', default_key: 'sparring_rounds_per_7d_max', kind: 'default_rule', value_max: '2', unit: 'rounds',
  window_days: '7', phases: '[{"months_in_stage": "0-12", "value_max": 0}]', display_text: 'max 2 rounds a week', status: 'REPORTED',
  sources: 'LR-140|DOC-156', backbone_version: 'draft-1', evidence: EVIDENCE,
};
const D_LANE: Row = {
  organization_id: ORG, default_id: DFT_LANE, scope: 'lane:non_contact', default_key: 'contact_level_ceiling', kind: 'default_rule', value_text: 'light_technical',
  display_text: 'Non-contact lane: contact held at none or light_technical.', status: 'INFERRED', sources: 'DOC-156|inference', backbone_version: 'draft-1',
};

function catalog(stages: Row[], links: Row[], defaults: Row[]): Record<string, string> {
  return { [STAGES]: csv(STAGE_HEADER, stages), [LINKS]: csv(LINK_HEADER, links), [DEFAULTS]: csv(DEFAULT_HEADER, defaults) };
}

const FIXTURE = () => catalog([Y1, Y2], [Y1_Y2], [D_Y1, D_LANE]);

async function plan(organizationId: string, actor: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId: actor, files });
}

async function load(organizationId: string, actor: string, files: Record<string, string>) {
  const shown = await plan(organizationId, actor, files);
  expect(shown.blocking).toEqual([]);
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client, organizationId, actorAccountId: actor, files, expectedPlanHash: shown.planHash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function outcomes(result: ImportPlan): Record<string, string> {
  return Object.fromEntries(result.units.map((unit) => [unit.key, unit.outcome]));
}

async function rows(sql: string, organizationId: string) {
  return (await client.query(sql, [organizationId])).rows;
}

const stageRows = (org: string) => rows('select stage_key, name, active_flag, field_labels from pilot.pathway_stages where organization_id = $1 order by stage_key', org);
const linkRows = (org: string) => rows('select from_stage_key, to_stage_key, link_kind, active_flag from pilot.pathway_stage_links where organization_id = $1 order by 1, 2', org);
const defaultRows = (org: string) => rows(
  `select default_id, scope, stage_key, value_max::text, window_days, phases, sources, evidence, status, active_flag
     from pilot.pathway_stage_defaults where organization_id = $1 order by default_id`,
  org,
);
const ledger = async (org: string) => (await rows(
  `select dataset, item_key, version, content->>'active_flag' as active from pilot.reference_content_revisions
    where organization_id = $1 and dataset like 'pathway%' order by dataset, item_key, version`,
  org,
)).map((row) => `${row.dataset} ${row.item_key} v${row.version} ${row.active}`);

function codes(result: ImportPlan): string[] {
  return result.blocking.map((finding) => `${finding.code} ${finding.column ?? ''} ${finding.message}`);
}

// ---------------------------------------------------------------------------

describe('the pathway_catalog migration', () => {
  it('is in the schema, and its runner re-applies it and passes its own readiness check', async () => {
    await expect(applyMigrationTransaction(client, await fs.readFile(MIGRATION_PATH, 'utf8'))).resolves.toBeUndefined();
    const { rows: found } = await client.query(
      `select conname, convalidated from pg_constraint where conrelid = 'pilot.content_stage_links'::regclass
        and conname in ('pilot_content_stage_links_stage_check', 'pilot_content_stage_links_stage_fkey')`,
    );
    // Lane BB-1a's CHECK is gone; the foreign key took its place, validated on a database with no orphan rows.
    expect(found).toEqual([{ conname: 'pilot_content_stage_links_stage_fkey', convalidated: true }]);
  });

  it('keeps an existing content stage link that names no catalog stage: the key stays NOT VALID until a re-run finds every row covered', async () => {
    await createGym('gym_keep');
    await client.query('alter table pilot.content_stage_links drop constraint pilot_content_stage_links_stage_fkey');
    await client.query(
      `insert into pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key, import_id, recorded_by_account_id, recorded_by_role)
       values ('gym_keep', 'drill', 'drl_00000000000000', 'T1', 'imp_test', 'admin@gym_keep', 'organization_admin')`,
    );
    const state = async () => (await client.query(
      `select convalidated from pg_constraint where conname = 'pilot_content_stage_links_stage_fkey' and conrelid = 'pilot.content_stage_links'::regclass`,
    )).rows;
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    await applyMigrationTransaction(client, sql);
    expect(await state()).toEqual([{ convalidated: false }]);
    expect((await client.query(`select count(*)::int as n from pilot.content_stage_links where organization_id = 'gym_keep'`)).rows[0].n).toBe(1);
    await client.query(
      `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default)
       values ('gym_keep', 'T1', 'trunk', 6, 'Foundation', 'light_technical')`,
    );
    await applyMigrationTransaction(client, sql);
    expect(await state()).toEqual([{ convalidated: true }]);
  });

  it('refuses what the catalog tables refuse: a link or content stage link to a stage the organization lacks, a bad scope, and any delete', async () => {
    await createGym('gym_db');
    await client.query(
      `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default) values ('gym_db', 'Y1', 'youth', 1, 'Introduction', 'none')`,
    );
    await expect(client.query(
      `insert into pilot.pathway_stage_links (organization_id, from_stage_key, to_stage_key, link_kind) values ('gym_db', 'Y1', 'Y2', 'progression')`,
    )).rejects.toMatchObject({ code: '23503' });
    await expect(client.query(
      `insert into pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key, import_id, recorded_by_account_id, recorded_by_role)
       values ('gym_db', 'drill', 'drl_00000000000000', 'T3', 'imp_test', 'admin@gym_db', 'organization_admin')`,
    )).rejects.toMatchObject({ code: '23503' });
    const insertDefault = (scope: string) => client.query(
      `insert into pilot.pathway_stage_defaults (organization_id, default_id, scope, default_key, kind, status)
       values ('gym_db', 'dft_00000000000b01', $1, 'k', 'information', 'REPORTED')`,
      [scope],
    );
    await expect(insertDefault('Y2')).rejects.toMatchObject({ code: '23503' });
    await expect(insertDefault('lane:contact')).rejects.toMatchObject({ code: '23514' });
    await expect(insertDefault('lane:non_contact')).resolves.toBeDefined();
    await expect(client.query(`delete from pilot.pathway_stage_defaults where organization_id = 'gym_db'`)).rejects.toMatchObject({ code: '23001' });
    await expect(client.query(`delete from pilot.pathway_stages where organization_id = 'gym_db'`)).rejects.toMatchObject({ code: '23001' });
    // The owning organization's own deletion still removes its catalog, through
    // every stage key that names it: a link, a stage-scoped default, a content link.
    await client.query(
      `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default) values ('gym_db', 'Y2', 'youth', 2, 'Foundations', 'none')`,
    );
    await client.query(`insert into pilot.pathway_stage_links (organization_id, from_stage_key, to_stage_key, link_kind) values ('gym_db', 'Y1', 'Y2', 'progression')`);
    await client.query(
      `insert into pilot.pathway_stage_defaults (organization_id, default_id, scope, default_key, kind, status) values ('gym_db', 'dft_00000000000b02', 'Y2', 'k', 'information', 'REPORTED')`,
    );
    await client.query(
      `insert into pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key, import_id, recorded_by_account_id, recorded_by_role)
       values ('gym_db', 'drill', 'drl_00000000000000', 'Y1', 'imp_test', 'admin@gym_db', 'organization_admin')`,
    );
    await client.query(`delete from pilot.organization_memberships where organization_id = 'gym_db'`);
    await client.query(`delete from pilot.accounts where organization_id = 'gym_db'`);
    await client.query(`delete from pilot.organizations where organization_id = 'gym_db'`);
    const left = await client.query(
      `select (select count(*) from pilot.pathway_stages where organization_id = 'gym_db')
            + (select count(*) from pilot.pathway_stage_links where organization_id = 'gym_db')
            + (select count(*) from pilot.pathway_stage_defaults where organization_id = 'gym_db')
            + (select count(*) from pilot.content_stage_links where organization_id = 'gym_db') as n`,
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});

describe('the plan hash of a plan with no retirement', () => {
  it('is what it was before this lane: a committed disciplines package for a new gym', async () => {
    const admin = await createGym('gym_hash');
    const shown = await plan('gym_hash', admin, readDatasetFiles(SEED_DATA_DIR, ['disciplines']));
    expect(shown.blocking).toEqual([]);
    // Pinned from the same plan made at base 00ec726b (before `retires` existed).
    expect(shown.planHash).toBe(PINNED_BASE_HASH);
  });
});

describe('a pathway-catalog package', () => {
  const GYM = 'gym_catalog';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(GYM);
  });

  it('validates offline: 2 stages, 1 link, 2 defaults', () => {
    const result = validatePackage(
      Object.entries(FIXTURE()).map(([p, text]) => ({ path: p, text })),
      { references: loadOfflineReferenceSets(SEED_DATA_DIR) },
    );
    expect(result.blocking).toEqual([]);
  });

  it('refuses malformed catalog rows offline, each by name', () => {
    const findings = (files: Record<string, string>) => validatePackage(
      Object.entries(files).map(([p, text]) => ({ path: p, text })),
      { references: loadOfflineReferenceSets(SEED_DATA_DIR) },
    ).blocking.map((finding) => `${finding.code} ${finding.message}`);
    const withKeys = [...STAGE_HEADER, 'stage_keys'];
    expect(findings({ [STAGES]: csv(withKeys, [{ ...Y1, stage_keys: 'Y2' }, { ...Y2, stage_key: 'y2' }]) })).toEqual([
      expect.stringMatching(/^row_rule stage_key 'y2' is not a stage key/),
      expect.stringMatching(/^row_rule stage_keys is for content items; leave it blank on a pathway catalog row \('Y2'\)/),
    ]);
    expect(findings(catalog([Y1, Y2], [{ ...Y1_Y2, to_stage_key: 'Y1' }], [
      { ...D_Y1, default_id: 'dft_ABC' },
      { ...D_LANE, value_min: '4', value_max: '3', phases: '{"months": 1}' },
      { ...D_LANE, default_id: 'dft_0000000000a002', default_key: 'other_key' },
    ]))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^row_rule a link joins two different stages \(Y1 to itself\)/),
      expect.stringMatching(/^row_rule default_id 'dft_ABC' is not 'dft_' and 14 lowercase hex/),
      expect.stringMatching(/^row_rule default_id 'dft_0000000000a002' is not the id of lane:non_contact:other_key \(dft_[0-9a-f]{14}\)/),
      expect.stringMatching(/^row_rule value_min 4 is above value_max 3/),
      expect.stringMatching(/^row_rule phases must be a JSON list/),
    ]));
  });

  it('plans all new, and the dry run lists every row and writes nothing', async () => {
    const shown = await plan(GYM, admin, FIXTURE());
    expect(shown.blocking).toEqual([]);
    expect(outcomes(shown)).toEqual({ Y1: 'new', Y2: 'new', 'Y1>Y2': 'new', [DFT_Y1]: 'new', [DFT_LANE]: 'new' });
    // Information only: what the snapshot carries without labels. Never blocks.
    expect(shown.warnings.filter((warning) => warning.code === 'unlabelled_catalog_rows').map((warning) => [warning.file, warning.message])).toEqual([
      [STAGES, '1 of 2 stages carry no field_labels; they load without them (information only).'],
    ]);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'ppbf-pathway-seed-'));
    try {
      mkdirSync(path.join(dir, 'pathway-catalog'));
      for (const [name, text] of Object.entries(FIXTURE())) writeFileSync(path.join(dir, name), text);
      const lines: string[] = [];
      const code = await runApply(
        { client, organizationId: GYM, actorAccountId: admin, seedDataDir: dir, datasets: ['pathway-catalog'], dryRun: true },
        { log: (line) => lines.push(line) },
      );
      const out = lines.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('pathway-catalog: 5 new');
      expect(out).toContain('RESULT: DRY RUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await stageRows(GYM)).toEqual([]);
  });

  it('applies: rows, native labels and v1 ledger rows; the same package then plans unchanged', async () => {
    const result = await load(GYM, admin, FIXTURE());
    expect([...(result.written['pathway-catalog']?.inserted ?? [])].sort()).toEqual(['Y1', 'Y1>Y2', 'Y2', DFT_LANE, DFT_Y1].sort());
    expect(await stageRows(GYM)).toEqual([
      { stage_key: 'Y1', name: 'Introduction', active_flag: true, field_labels: JSON.parse(LABELS) },
      { stage_key: 'Y2', name: 'Foundations', active_flag: true, field_labels: null },
    ]);
    expect(await linkRows(GYM)).toEqual([{ from_stage_key: 'Y1', to_stage_key: 'Y2', link_kind: 'progression', active_flag: true }]);
    // The lane default's stage_key is NULL (generated from its scope) and the foreign key accepts it.
    expect(Object.fromEntries((await defaultRows(GYM)).map((row) => [row.default_id, row]))).toEqual({
      [DFT_Y1]: {
        default_id: DFT_Y1, scope: 'Y1', stage_key: 'Y1', value_max: '2', window_days: 7, phases: [{ months_in_stage: '0-12', value_max: 0 }],
        sources: ['LR-140', 'DOC-156'], evidence: JSON.parse(EVIDENCE), status: 'REPORTED', active_flag: true,
      },
      [DFT_LANE]: {
        default_id: DFT_LANE, scope: 'lane:non_contact', stage_key: null, value_max: null, window_days: null, phases: null,
        sources: ['DOC-156', 'inference'], evidence: null, status: 'INFERRED', active_flag: true,
      },
    });
    expect((await ledger(GYM)).sort()).toEqual([
      `pathway_stage_defaults ${DFT_LANE} v1 true`,
      `pathway_stage_defaults ${DFT_Y1} v1 true`,
      'pathway_stage_links Y1>Y2 v1 true',
      'pathway_stages Y1 v1 true',
      'pathway_stages Y2 v1 true',
    ]);
    const again = await plan(GYM, admin, FIXTURE());
    expect(again.blocking).toEqual([]);
    expect(outcomes(again)).toEqual({ Y1: 'unchanged', Y2: 'unchanged', 'Y1>Y2': 'unchanged', [DFT_Y1]: 'unchanged', [DFT_LANE]: 'unchanged' });
  });

  it('a second snapshot: a changed value is a new ledger version, and a stage and link it leaves out are retired and kept', async () => {
    const second = catalog([{ ...Y1, name: 'Introduction / Movement' }], [], [{ ...D_Y1, value_max: '3' }, D_LANE]);
    const shown = await plan(GYM, admin, second);
    expect(shown.blocking).toEqual([]);
    expect(outcomes(shown)).toEqual({ Y1: 'new_version', Y2: 'new_version', 'Y1>Y2': 'new_version', [DFT_Y1]: 'new_version', [DFT_LANE]: 'unchanged' });
    // A retirement is shown as one, not as an ordinary revision.
    expect(shown.units.filter((unit) => unit.retires).map((unit) => unit.key).sort()).toEqual(['Y1>Y2', 'Y2']);
    const printed = formatPlan(shown);
    expect(printed).toContain('    retire Y2: history v1 -> v2 (left out of the file; kept, marked inactive)');
    expect(printed).toContain('    retire Y1>Y2: history v1 -> v2 (left out of the file; kept, marked inactive)');
    expect(printed).toContain('    new version Y1: history v1 -> v2');
    const result = await load(GYM, admin, second);
    expect([...(result.written['pathway-catalog']?.updated ?? [])].sort()).toEqual(['Y1', 'Y1>Y2 retired', 'Y2 retired', DFT_Y1].sort());
    expect(await stageRows(GYM)).toEqual([
      { stage_key: 'Y1', name: 'Introduction / Movement', active_flag: true, field_labels: JSON.parse(LABELS) },
      { stage_key: 'Y2', name: 'Foundations', active_flag: false, field_labels: null },
    ]);
    expect(await linkRows(GYM)).toEqual([{ from_stage_key: 'Y1', to_stage_key: 'Y2', link_kind: 'progression', active_flag: false }]);
    expect(Object.fromEntries((await defaultRows(GYM)).map((row) => [row.default_id, row.value_max]))).toEqual({ [DFT_Y1]: '3', [DFT_LANE]: null });
    const versions = await ledger(GYM);
    expect(versions).toEqual(expect.arrayContaining([
      `pathway_stage_defaults ${DFT_Y1} v2 true`,
      'pathway_stage_links Y1>Y2 v2 false',
      'pathway_stages Y1 v2 true',
      'pathway_stages Y2 v2 false',
    ]));
    expect(versions).toHaveLength(9);
    // Retired rows the next snapshot still leaves out are absent: not touched again.
    expect(outcomes(await plan(GYM, admin, second))).toEqual({ Y1: 'unchanged', Y2: 'absent', 'Y1>Y2': 'absent', [DFT_Y1]: 'unchanged', [DFT_LANE]: 'unchanged' });
  });

  it('a file without a label column keeps the stored labels; a retired stage carried again comes back as a new version', async () => {
    const header = STAGE_HEADER.filter((name) => name !== 'field_labels');
    const files = { [STAGES]: csv(header, [{ ...Y1, name: 'Introduction / Movement' }, Y2]) };
    expect(outcomes(await plan(GYM, admin, files))).toEqual({ Y1: 'unchanged', Y2: 'new_version' });
    await load(GYM, admin, files);
    expect((await stageRows(GYM)).map((row) => [row.stage_key, row.active_flag, row.field_labels])).toEqual([
      ['Y1', true, JSON.parse(LABELS)],
      ['Y2', true, null],
    ]);
    expect(await ledger(GYM)).toContain('pathway_stages Y2 v3 true');
  });

  it('refuses by name: a bad link end, a bad scope, a scope naming no stage, and a stage file that would orphan a loaded link', async () => {
    const badEnd = await plan(GYM, admin, catalog([Y1, Y2], [{ ...Y1_Y2, to_stage_key: 'Y9' }], []));
    expect(codes(badEnd)).toEqual([expect.stringMatching(/^orphan_reference to_stage_key the link names stage 'Y9', which is not in seed_pathway_stages.csv/)]);
    expect(badEnd.units.find((unit) => unit.key === 'Y1>Y9')?.outcome).toBe('reject');

    const badScope = await plan(GYM, admin, catalog([Y1, Y2], [Y1_Y2], [{ ...D_LANE, scope: 'lane:contact', default_id: `dft_${hex14('lane:contact:contact_level_ceiling')}` }]));
    expect(codes(badScope)).toEqual([expect.stringMatching(/^row_rule {2}scope 'lane:contact' is neither a stage key nor lane:non_contact/)]);

    const noStage = await plan(GYM, admin, catalog([Y1, Y2], [Y1_Y2], [{ ...D_Y1, scope: 'T1', default_id: `dft_${hex14('T1:sparring_rounds_per_7d_max')}` }]));
    expect(codes(noStage)).toEqual([expect.stringMatching(/^orphan_reference scope default dft_[0-9a-f]{14} names stage 'T1'/)]);

    // Without a stage file, the loaded catalog is the one the ends must name.
    const loadedOnly = await plan(GYM, admin, { [LINKS]: csv(LINK_HEADER, [Y1_Y2, { ...Y1_Y2, from_stage_key: 'Y2', to_stage_key: 'Y3' }]) });
    expect(codes(loadedOnly)).toEqual([
      expect.stringMatching(/^orphan_reference to_stage_key the link names stage 'Y3', which is not in this organization's active pathway stages/),
    ]);

    // Bring the retired link back, then try to retire Y2 with a stage file alone.
    await load(GYM, admin, { [LINKS]: csv(LINK_HEADER, [Y1_Y2]) });
    const orphaning = await plan(GYM, admin, { [STAGES]: csv(STAGE_HEADER, [{ ...Y1, name: 'Introduction / Movement' }]) });
    expect(codes(orphaning)).toEqual([expect.stringMatching(/^orphan_reference {2}this file would retire stage 'Y2', but the loaded link Y1>Y2 still names it/)]);
  });

  it('content items: a stage key the catalog lacks is refused at plan by name; loaded stages link, through the foreign key', async () => {
    const disciplines = readDatasetFiles(SEED_DATA_DIR, ['disciplines'])[DISCIPLINES];
    const table = readCsv(disciplines);
    const keyIndex = table.header.indexOf('discipline');
    const withStages = (keys: string) => writeCsv(
      [...table.header, 'stage_keys'],
      table.records.map((record) => [...table.header.map((_, index) => record.cells[index] ?? ''), record.cells[keyIndex] === 'boxing' ? keys : '']),
    );

    const unknown = await plan(GYM, admin, { [DISCIPLINES]: withStages('Y1|AM1') });
    expect(unknown.blocking.map((finding) => [finding.code, finding.column, finding.message])).toEqual([
      ['unknown_stage_key', 'stage_keys', "'AM1' is not a stage in this organization's pathway catalog (pilot.pathway_stages)"],
    ]);
    // A key outside the 18 keeps its offline finding, not repeated at plan.
    const offline = await plan(GYM, admin, { [DISCIPLINES]: withStages('Y1|Z1') });
    expect(offline.blocking.map((finding) => finding.code)).toEqual(['unknown_stage_key']);
    // A package's own stage file is the catalog after the load.
    const am1: Row = { ...Y2, stage_key: 'AM1', segment: 'amateur', ordinal: '8', name: 'National Amateur' };
    const together = await plan(GYM, admin, { ...catalog([Y1, Y2, am1], [Y1_Y2], []), [DISCIPLINES]: withStages('Y1|AM1') });
    expect(together.blocking).toEqual([]);

    await load(GYM, admin, { [DISCIPLINES]: withStages('Y1|Y2') });
    expect(await rows('select stage_key from pilot.content_stage_links where organization_id = $1 and superseded_at is null order by 1', GYM))
      .toEqual([{ stage_key: 'Y1' }, { stage_key: 'Y2' }]);

    // A retired stage is kept, so content already linked to it re-imports (the foreign key accepts it too).
    await client.query(
      `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default, active_flag)
       values ($1, 'RC1', 'recreational', 16, 'Recreational Boxing', 'light_technical', false)`,
      [GYM],
    );
    expect((await plan(GYM, admin, { [DISCIPLINES]: withStages('Y1|RC1') })).blocking).toEqual([]);
  });

  it('defaults: one the snapshot leaves out is retired with its evidence kept, and comes back as a new version', async () => {
    const without = { [DEFAULTS]: csv(DEFAULT_HEADER, [{ ...D_Y1, value_max: '3' }]) };
    expect(outcomes(await plan(GYM, admin, without))).toEqual({ [DFT_Y1]: 'unchanged', [DFT_LANE]: 'new_version' });
    await load(GYM, admin, without);
    const lane = async () => (await defaultRows(GYM)).find((row) => row.default_id === DFT_LANE);
    expect(await lane()).toMatchObject({ active_flag: false, status: 'INFERRED', sources: ['DOC-156', 'inference'] });
    const withLane = { [DEFAULTS]: csv(DEFAULT_HEADER, [{ ...D_Y1, value_max: '3', evidence: '' }, { ...D_LANE, evidence: EVIDENCE }]) };
    await load(GYM, admin, withLane);
    expect(await lane()).toMatchObject({ active_flag: true, evidence: JSON.parse(EVIDENCE) });
    expect((await defaultRows(GYM)).find((row) => row.default_id === DFT_Y1)?.evidence).toBeNull(); // present and blank = none
    // Retiring the evidence-carrying default again keeps its evidence on the row.
    await load(GYM, admin, { [DEFAULTS]: csv(DEFAULT_HEADER, [{ ...D_Y1, value_max: '3', evidence: '' }]) });
    expect(await lane()).toMatchObject({ active_flag: false, evidence: JSON.parse(EVIDENCE) });
  });

  it('a stage file alone that would retire a stage a loaded default names is refused by name', async () => {
    const orphaning = await plan(GYM, admin, { [STAGES]: csv(STAGE_HEADER, [Y2]) });
    expect(codes(orphaning)).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^orphan_reference {2}this file would retire stage 'Y1', but the loaded default ${DFT_Y1} still names it`)),
    ]));
  });

  it('a plan the database moved under is refused at apply, and nothing is written', async () => {
    const files = { [STAGES]: csv(STAGE_HEADER, [{ ...Y1, name: 'Introduction / Movement', who_text: 'Ages 5-8' }, Y2]) };
    const shown = await plan(GYM, admin, files);
    expect(shown.blocking).toEqual([]);
    await client.query(`update pilot.pathway_stages set name = 'Edited elsewhere' where organization_id = $1 and stage_key = 'Y2'`, [GYM]);
    await client.query('BEGIN');
    await expect(applyImport({ client, organizationId: GYM, actorAccountId: admin, files, expectedPlanHash: shown.planHash }))
      .rejects.toThrow(/changed after the plan was made/);
    await client.query('ROLLBACK');
    expect((await stageRows(GYM)).filter((row) => row.stage_key !== 'RC1').map((row) => row.name)).toEqual(['Introduction / Movement', 'Edited elsewhere']);
  });
});
