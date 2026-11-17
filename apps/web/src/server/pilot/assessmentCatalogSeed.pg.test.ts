// The COMMITTED assessment-catalog seed (lane CAT-c): the whole frozen
// Backbone catalog, as backbone-export-assessment-catalog.mjs wrote it, plans
// with no blocking finding for a gym with the pathway catalog loaded, applies,
// and re-plans unchanged; every count holds (46 protocols, 2 scales, 1 cap, 29
// items, 38 gates, 94 criteria, 105 anchor specs); blank loads blank for the
// three Q1 columns on all 46; no licensed excerpt reaches the database; and a
// new gym loads the pathway seed and the catalog in one package.
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

import { applyImport } from './contentImport/apply';
import { readDatasetFiles } from './contentImport/cli';
import { type ImportPlan, planImport } from './contentImport/plan';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'assessment_catalog_seed';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assessment-catalog-seed-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

const EXPECTED = { protocols: 46, scales: 2, caps: 1, items: 29, gates: 38, criteria: 94, specs: 105 };
const TOTAL = Object.values(EXPECTED).reduce((sum, n) => sum + n, 0);

async function counts(organizationId: string) {
  const { rows: [row] } = await client.query(
    `select (select count(*) from pilot.assessment_protocols where organization_id = $1 and active)::int as protocols,
            (select count(*) from pilot.scorecard_scales where organization_id = $1 and active_flag)::int as scales,
            (select count(*) from pilot.scorecard_score_caps where organization_id = $1 and active_flag)::int as caps,
            (select count(*) from pilot.scorecard_items where organization_id = $1 and active_flag)::int as items,
            (select count(*) from pilot.pathway_gates where organization_id = $1 and active_flag)::int as gates,
            (select count(*) from pilot.pathway_gate_criteria where organization_id = $1 and active_flag)::int as criteria,
            (select count(*) from pilot.scorecard_anchor_clip_specs where organization_id = $1 and active_flag)::int as specs`,
    [organizationId],
  );
  return row;
}

describe('the committed assessment-catalog seed', () => {
  const catalog = readDatasetFiles(SEED_DATA_DIR, ['assessment-catalog']);
  const pathway = readDatasetFiles(SEED_DATA_DIR, ['pathway-catalog']);

  it('is the seven committed files', () => {
    expect(Object.keys(catalog).sort()).toEqual([
      'assessment-catalog/seed_assessment_protocols.csv', 'assessment-catalog/seed_pathway_gate_criteria.csv', 'assessment-catalog/seed_pathway_gates.csv',
      'assessment-catalog/seed_scorecard_anchor_clip_specs.csv', 'assessment-catalog/seed_scorecard_items.csv', 'assessment-catalog/seed_scorecard_scales.csv',
      'assessment-catalog/seed_scorecard_score_caps.csv',
    ]);
  });

  it('plans with no blocking finding once the pathway catalog is loaded, applies, and re-plans unchanged', async () => {
    const actor = await createGym('gym_seed');
    await load('gym_seed', actor, pathway);
    const first = await plan('gym_seed', actor, catalog);
    expect(first.blocking).toEqual([]);
    expect(first.counts['assessment-catalog']).toEqual({ new: TOTAL, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    await load('gym_seed', actor, catalog);
    expect(await counts('gym_seed')).toEqual(EXPECTED);
    const again = await plan('gym_seed', actor, catalog);
    expect(again.blocking).toEqual([]);
    expect(again.counts['assessment-catalog']).toEqual({ new: 0, new_version: 0, unchanged: TOTAL, absent: 0, reject: 0 });
  });

  it('stores the frozen values as ruled: Q1 blanks, the cap, the gate kinds, no licensed excerpt', async () => {
    const { rows: [protocols] } = await client.query(
      `select count(*) filter (where quality_measured = '' and boxing_specific = '' and evidence_class = '')::int as blank,
              count(*) filter (where retest_interval_basis = 'TBD - no defensible basis')::int as tbd,
              count(*) filter (where human_authority_required and field_labels->'human_authority_required'->>'status' = 'INFERRED')::int as inferred
         from pilot.assessment_protocols where organization_id = 'gym_seed'`,
    );
    expect(protocols).toEqual({ blank: 46, tbd: 46, inferred: 46 });
    const { rows: [cap] } = await client.query(
      `select scale_key, max_score::text as max_score, applies_to_protocol_id, applies_to_contexts from pilot.scorecard_score_caps where organization_id = 'gym_seed'`,
    );
    expect(cap).toEqual({ scale_key: 'live_long_road', max_score: '3', applies_to_protocol_id: 'PP-T01', applies_to_contexts: ['drill', 'shadow', 'partner'] });
    const { rows: kinds } = await client.query(
      `select gate_kind, count(*)::int as n from pilot.pathway_gates where organization_id = 'gym_seed' group by 1 order by 1`,
    );
    expect(kinds).toEqual([
      { gate_kind: 'checkpoint_90_days', n: 1 }, { gate_kind: 'contact_readiness', n: 1 }, { gate_kind: 'entry', n: 18 }, { gate_kind: 'exit', n: 18 },
    ]);
    const { rows: [excerpts] } = await client.query(
      `select ((select count(*) from pilot.pathway_gates where organization_id = 'gym_seed' and evidence::text like '%"quotes"%')
             + (select count(*) from pilot.pathway_gate_criteria where organization_id = 'gym_seed' and evidence::text like '%"quotes"%')
             + (select count(*) from pilot.assessment_protocols where organization_id = 'gym_seed' and evidence::text like '%"quotes"%')
             + (select count(*) from pilot.scorecard_items where organization_id = 'gym_seed' and evidence::text like '%"quotes"%'))::int as n`,
    );
    expect(excerpts.n).toBe(0);
  });

  it('a new gym loads the pathway seed and the catalog in one package', async () => {
    const actor = await createGym('gym_one');
    await load('gym_one', actor, { ...pathway, ...catalog });
    expect(await counts('gym_one')).toEqual(EXPECTED);
  });
});
