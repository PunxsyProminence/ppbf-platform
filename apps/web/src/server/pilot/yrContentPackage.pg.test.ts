// Lane YR (YR-b): the youth and recreational stage content added to a gym that
// already holds everything before it -- as staging and production do: the
// registries, the whole drill library, the FT1 track and its templates, and the
// Week 2 Monday script committed with no blocks.
//
// What this pins, each a way adding the 27 templates, the 53 tracks and the
// script's 13 blocks could have gone wrong:
//   - the new details column on the template files makes an EXISTING template
//     read as changed: every template and track from before stays unchanged;
//   - lane YR's rows are the only new ones (counted from the files), and the
//     Week 2 Monday script becomes version 2 with its blocks, version 1 kept;
//   - a Backbone JSON cell is stored as written;
//   - the USA Boxing line sits beside both frozen Thursday lines of DOC-154
//     (OD-2026-11-16-004 ruling 1), the sheet unchanged;
//   - a second plan over the loaded state finds nothing to do.
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
const DATABASE = 'content_yr';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-yr-pg-test-${Date.now()}`);
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
     values ('src_yr_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/yr-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_yr_test', 'src_yr_test', '__platform__', 'Loaded research claims (test)', 'yr-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_yr_test', 'src_yr_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
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
const TEMPLATES_CSV = 'workout-templates/seed_workout_templates.csv';
const ITEMS_CSV = 'workout-templates/seed_workout_template_items.csv';
const TRACKS_CSV = 'training-tracks/seed_training_tracks.csv';
const BLOCKS_CSV = 'training-tracks/seed_track_blocks.csv';
const SESSIONS_CSV = 'training-tracks/seed_track_block_sessions.csv';
const SCRIPTS_CSV = 'session-scripts/seed_session_scripts.csv';
const SCRIPT_BLOCKS_CSV = 'session-scripts/seed_session_script_blocks.csv';
const LABEL_COLUMNS = ['field_labels', 'evidence', 'stage_keys'];
const SCRIPT = 'scr_e2ed38b1a19670';
const DOC154 = 'trk_98f1b755dce913';
const YR_STAGES = ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'];

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

const PACKAGES: readonly DatasetName[] = ['drill-library', 'workout-templates', 'session-scripts', 'training-tracks'];
const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions', 'pathway-catalog'];
const committed = readDatasetFiles(SEED_DATA_DIR, PACKAGES);
const inLane = (row: Row) => row.stage_keys !== 'FT1' && row.stage_keys.split('|').some((key) => YR_STAGES.includes(key));
const yrTemplateIds = new Set(rowsOf(committed[TEMPLATES_CSV]).filter(inLane).map((row) => row.template_id));
const yrTrackIds = new Set(rowsOf(committed[TRACKS_CSV]).filter(inLane).map((row) => row.track_id));
const otherTemplates = rowsOf(committed[TEMPLATES_CSV]).filter((row) => !yrTemplateIds.has(row.template_id));
const otherTracks = rowsOf(committed[TRACKS_CSV]).filter((row) => !yrTrackIds.has(row.track_id));
const otherScripts = rowsOf(committed[SCRIPTS_CSV]).filter((row) => row.script_id !== SCRIPT);
const ofYrTemplate = (row: Row) => yrTemplateIds.has(row.template_id);
const ofYrTrack = (row: Row) => yrTrackIds.has(row.track_id);

/**
 * Production and staging before this lane: every committed row but lane YR's, the template files
 * without their details column, the script files without their label columns and without the
 * 13 blocks of the Week 2 Monday script (committed with none until now).
 */
function beforeFiles(): Record<string, string> {
  return {
    ...committed,
    [TEMPLATES_CSV]: reshape(committed[TEMPLATES_CSV], (row) => !ofYrTemplate(row), ['details']),
    [ITEMS_CSV]: reshape(committed[ITEMS_CSV], (row) => !ofYrTemplate(row), ['details']),
    [TRACKS_CSV]: reshape(committed[TRACKS_CSV], (row) => !ofYrTrack(row)),
    [BLOCKS_CSV]: reshape(committed[BLOCKS_CSV], (row) => !ofYrTrack(row)),
    [SESSIONS_CSV]: reshape(committed[SESSIONS_CSV], (row) => !ofYrTrack(row)),
    [SCRIPTS_CSV]: reshape(committed[SCRIPTS_CSV], () => true, LABEL_COLUMNS),
    [SCRIPT_BLOCKS_CSV]: reshape(committed[SCRIPT_BLOCKS_CSV], (row) => row.script_id !== SCRIPT),
  };
}

async function plan(organizationId: string, actorAccountId: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId, files });
}

async function applyCommitted(organizationId: string, actorAccountId: string, files: Record<string, string>) {
  const shown = await plan(organizationId, actorAccountId, files);
  expect(shown.blocking).toEqual([]);
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client, organizationId, actorAccountId, files, expectedPlanHash: shown.planHash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('the youth and recreational content added to a gym that has everything before it', () => {
  const ORG = 'yr_gym';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(ORG);
    await applyCommitted(ORG, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
    await applyCommitted(ORG, admin, beforeFiles());
  });

  it('plans only lane YR as new, the Week 2 Monday script as its next version, and everything else unchanged', async () => {
    // 27: the 6 DOC-136 templates are held out (OD-2026-10-02-013 2A; Overwatch, option B).
    expect([yrTemplateIds.size, yrTrackIds.size]).toEqual([27, 53]);
    const result = await plan(ORG, admin, committed);
    expect(result.blocking).toEqual([]);
    expect(result.counts['workout-templates']).toEqual({ new: 27, new_version: 0, unchanged: otherTemplates.length, absent: 0, reject: 0 });
    expect(result.counts['training-tracks']).toEqual({ new: 53, new_version: 0, unchanged: otherTracks.length, absent: 0, reject: 0 });
    expect(result.counts['session-scripts']).toEqual({ new: 0, new_version: 1, unchanged: otherScripts.length, absent: 0, reject: 0 });
    expect(result.counts['drill-library']).toEqual(expect.objectContaining({ new: 0, new_version: 0, reject: 0 }));
  });

  it('loads it: the 53 tracks with their 3 blocks and 48 block sessions, every Backbone field kept, and plans nothing more', async () => {
    await applyCommitted(ORG, admin, committed);
    const counts = await observer.query<{ tracks: string; blocks: string; sessions: string; templates: string; items: string }>(
      `select (select count(*) from pilot.training_tracks where organization_id = $1 and track_id = any($2::text[])) as tracks,
              (select count(*) from pilot.track_blocks where organization_id = $1 and track_id = any($2::text[])) as blocks,
              (select count(*) from pilot.track_block_sessions where organization_id = $1 and track_id = any($2::text[])) as sessions,
              (select count(*) from pilot.workout_templates where organization_id = $1 and template_id = any($3::text[])) as templates,
              (select count(*) from pilot.workout_template_items where organization_id = $1 and template_id = any($3::text[])) as items`,
      [ORG, [...yrTrackIds], [...yrTemplateIds]],
    );
    expect(counts.rows[0]).toEqual({ tracks: '53', blocks: '3', sessions: '48', templates: '27', items: '240' });

    // Every Backbone field: a JSON cell is stored as the file has it.
    const files = new Map(rowsOf(committed[TRACKS_CSV]).filter(ofYrTrack).map((row) => [row.track_id, JSON.parse(row.details || '{}')]));
    const stored = await observer.query<{ track_id: string; details: unknown }>(
      `select track_id, details from pilot.training_tracks where organization_id = $1 and track_id = any($2::text[])`,
      [ORG, [...yrTrackIds]],
    );
    for (const row of stored.rows) expect({ track: row.track_id, details: row.details }).toEqual({ track: row.track_id, details: files.get(row.track_id) });
    const itemDetails = await observer.query<{ n: string }>(
      `select count(*) as n from pilot.workout_template_items where organization_id = $1 and template_id = any($2::text[]) and details <> '{}'::jsonb`,
      [ORG, [...yrTemplateIds]],
    );
    expect(Number(itemDetails.rows[0].n)).toBe(rowsOf(committed[ITEMS_CSV]).filter((row) => ofYrTemplate(row) && row.details !== '').length);

    const again = await plan(ORG, admin, committed);
    expect(again.blocking).toEqual([]);
    expect(again.changes).toBe(0);
  });

  it('shows the USA Boxing line beside both DOC-154 Thursday lines, the sheet as frozen, and links the track to Y2-Y5', async () => {
    const { rows } = await observer.query<{ details: { groups: { blocks: { text: string }[] }[]; beside_lines: { block_index: number; sheet_text: string; line_key: string }[] } }>(
      `select details from pilot.training_tracks where organization_id = $1 and track_id = $2`,
      [ORG, DOC154],
    );
    const { groups, beside_lines: beside } = rows[0].details;
    expect(beside.map((line) => [line.block_index, line.line_key])).toEqual([[5, 'USAB-R11'], [10, 'USAB-R11']]);
    expect(groups[0].blocks[5].text).toBe(beside[0].sheet_text);
    expect(groups[1].blocks[10].text).toBe(beside[1].sheet_text);
    const links = await observer.query<{ stage_key: string }>(
      `select stage_key from pilot.content_stage_links
        where organization_id = $1 and target_kind = 'training_track' and target_lineage_id = $2 and superseded_at is null order by stage_key`,
      [ORG, DOC154],
    );
    expect(links.rows.map((row) => row.stage_key)).toEqual(['Y2', 'Y3', 'Y4', 'Y5']);
  });

  it('makes the Week 2 Monday script version 2 with its 13 blocks and its renderings, and keeps version 1 as it was', async () => {
    const { rows } = await observer.query<{ version: number; blocks: string; renderings: string }>(
      `select s.version,
              (select count(*) from pilot.session_script_blocks b where b.organization_id = s.organization_id and b.script_id = s.script_id) as blocks,
              (select count(*) from pilot.session_script_renderings r where r.organization_id = s.organization_id and r.script_id = s.script_id) as renderings
         from pilot.session_scripts s where s.organization_id = $1 and s.lineage_id = $2 order by s.version`,
      [ORG, SCRIPT],
    );
    expect(rows.map((row) => [row.version, row.blocks, row.renderings])).toEqual([[1, '0', '4'], [2, '13', '4']]);
  });
});
