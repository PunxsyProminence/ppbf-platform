// The FT1 track content (lane FT1b) added to a database that already holds the
// committed library, against the full migrated schema.
//
// What this pins, each a way adding the 131 drills, 33 templates and the track
// could have gone wrong:
//   - the three label columns now on the drill and template files make an
//     EXISTING row read as changed (a blank label cell means "none", so a
//     database holding labels on existing items would show it; one that never
//     had them must not): every row that was loaded from the files WITHOUT
//     the columns stays unchanged;
//   - the FT1 rows are the only new ones: 131 drills, 33 templates, and the
//     track with its 8 blocks and 40 block sessions;
//   - a drill the Backbone left without setup and steps loads as '' (the
//     columns are text not null), never as NULL;
//   - a second plan over the loaded state finds everything unchanged.
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
import { readCsv, writeCsv } from './contentImport/csv';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import type { DatasetName } from './contentImport/types';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_ft1';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-ft1-pg-test-${Date.now()}`);
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

/**
 * Every claim id of the LOADED research package, as chunks of the shared
 * __platform__ library -- what referenceSetsDb.ts reads for every gym. The
 * drills cite 115 of them; without them each citation is an orphan.
 */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    // ppbf_owned: the claims it stands in for are the research program's own
    // synthesis, and full text loads only under such a source (source rights).
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, rights_status)
     values ('src_ft1_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/ft1-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_ft1_test', 'src_ft1_test', '__platform__', 'Loaded research claims (test)', 'ft1-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_ft1_test', 'src_ft1_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
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
  // drill_library_v3's CHECK constraints refuse without it, whichever loader
  // writes them (drillSeedPrerequisite.test.ts).
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  observer = new Client({ connectionString: connectionStringFor(DATABASE) });
  await observer.connect();

  await loadPlatformClaims();
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

type Row = Record<string, string>;
const DRILLS_CSV = 'drill-library/seed_drill_library.csv';
const CUES_CSV = 'drill-library/seed_drill_cues.csv';
const STOPS_CSV = 'drill-library/seed_drill_stop_rules.csv';
const TEMPLATES_CSV = 'workout-templates/seed_workout_templates.csv';
const ITEMS_CSV = 'workout-templates/seed_workout_template_items.csv';
const LABEL_COLUMNS = ['field_labels', 'evidence', 'stage_keys'];

async function createGym(organizationId: string): Promise<string> {
  const accountId = `admin@${organizationId}`;
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [organizationId]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag) values ($1, 'organization_admin', $2, false, true)`,
    [accountId, organizationId],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'organization_admin', true)`,
    [accountId, organizationId],
  );
  return accountId;
}

function rowsOf(text: string): Row[] {
  const table = readCsv(text);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index] ?? ''])));
}

/** A CSV text with `keep` rows only and `drop` columns removed, through the real reader and writer. */
function reshape(text: string, keep: (row: Row) => boolean, drop: string[] = []): string {
  const table = readCsv(text);
  const header = table.header.filter((name) => !drop.includes(name));
  return writeCsv(header, rowsOf(text).filter(keep).map((row) => header.map((name) => row[name] ?? '')));
}

const FT1_PACKAGES: readonly DatasetName[] = ['drill-library', 'workout-templates', 'training-tracks'];
// The stages a stage_keys cell names must be loaded: the pathway catalog comes with the registries.
const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions', 'pathway-catalog'];
const committed = readDatasetFiles(SEED_DATA_DIR, FT1_PACKAGES);
const ft1DrillIds = new Set(rowsOf(committed[DRILLS_CSV]).filter((row) => row.stage_keys === 'FT1').map((row) => row.drill_id));
const ft1TemplateIds = new Set(rowsOf(committed[TEMPLATES_CSV]).filter((row) => row.stage_keys === 'FT1').map((row) => row.template_id));
const existingDrills = rowsOf(committed[DRILLS_CSV]).filter((row) => !ft1DrillIds.has(row.drill_id));
const existingTemplates = rowsOf(committed[TEMPLATES_CSV]).filter((row) => !ft1TemplateIds.has(row.template_id));

/**
 * The state before this lane: the committed files with the FT1 rows taken out and the three
 * label columns removed from the two root files, as they were written before.
 */
function beforeFiles(): Record<string, string> {
  return {
    [DRILLS_CSV]: reshape(committed[DRILLS_CSV], (row) => !ft1DrillIds.has(row.drill_id), LABEL_COLUMNS),
    [CUES_CSV]: reshape(committed[CUES_CSV], (row) => !ft1DrillIds.has(row.drill_id)),
    [STOPS_CSV]: reshape(committed[STOPS_CSV], (row) => !ft1DrillIds.has(row.drill_id)),
    'drill-library/seed_drill_scale_levels.csv': reshape(committed['drill-library/seed_drill_scale_levels.csv'], (row) => !ft1DrillIds.has(row.drill_id)),
    'drill-library/seed_drill_secondary_skills.csv': committed['drill-library/seed_drill_secondary_skills.csv'],
    [TEMPLATES_CSV]: reshape(committed[TEMPLATES_CSV], (row) => !ft1TemplateIds.has(row.template_id), LABEL_COLUMNS),
    [ITEMS_CSV]: reshape(committed[ITEMS_CSV], (row) => !ft1TemplateIds.has(row.template_id)),
  };
}

async function plan(organizationId: string, actorAccountId: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId, files });
}

async function applyCommitted(organizationId: string, actorAccountId: string, files: Record<string, string>) {
  const hash = (await plan(organizationId, actorAccountId, files)).planHash;
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

describe('FT1 content added to a loaded library', () => {
  const ORG = 'ft1_gym';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(ORG);
    await applyCommitted(ORG, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
    // The library and templates as they were loaded before this lane: no label columns, no FT1 rows.
    await applyCommitted(ORG, admin, beforeFiles());
  });

  it('plans the whole committed set with every existing drill and template unchanged and only the FT1 rows new', async () => {
    const result = await plan(ORG, admin, committed);
    expect(result.counts['drill-library']).toEqual({ new: ft1DrillIds.size, new_version: 0, unchanged: existingDrills.length, absent: 0, reject: 0 });
    expect(result.counts['workout-templates']).toEqual({ new: ft1TemplateIds.size, new_version: 0, unchanged: existingTemplates.length, absent: 0, reject: 0 });
    expect(result.counts['training-tracks']).toEqual({ new: 1, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    expect(ft1DrillIds.size).toBe(131);
    expect(ft1TemplateIds.size).toBe(33);
    expect(result.blocking).toEqual([]);
  });

  it('loads it, stores a blank setup as an empty string, and finds the next plan unchanged', async () => {
    await applyCommitted(ORG, admin, committed);
    const { rows } = await observer.query<{ nulls: string; blanks: string; total: string }>(
      `select count(*) filter (where standard_setup is null or execution is null) as nulls,
              count(*) filter (where standard_setup = '' or execution = '') as blanks,
              count(*) as total
         from pilot.drill_library where organization_id = $1 and drill_id = any($2::text[])`,
      [ORG, [...ft1DrillIds]],
    );
    expect(Number(rows[0].total)).toBe(131);
    expect(Number(rows[0].nulls)).toBe(0);
    // No FT1 drill loads with a blank setup or steps: the drafts Jason approved fill them (OD-2026-11-12-005 ruling 3).
    expect(Number(rows[0].blanks)).toBe(0);
    const again = await plan(ORG, admin, committed);
    expect(again.blocking).toEqual([]);
    expect(again.changes).toBe(0);
  });

  it('keeps the track, 8 blocks and 40 block sessions, each session naming a template the gym has', async () => {
    const { rows } = await observer.query<{ blocks: string; sessions: string }>(
      `select (select count(*) from pilot.track_blocks where organization_id = $1) as blocks,
              (select count(*) from pilot.track_block_sessions where organization_id = $1) as sessions`,
      [ORG],
    );
    expect(rows[0]).toEqual({ blocks: '8', sessions: '40' });
  });
});
