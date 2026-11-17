// Lane AP: the amateur + pro stage content added to a gym that already holds
// everything before it -- as staging and production do once lane YR has loaded:
// the registries, the whole drill library, the FT1 track and its templates, and
// lane YR's youth and recreational rows.
//
// What this pins, each a way adding the 66 templates, 14 tracks, 16 blocks and
// 498 block sessions could have gone wrong:
//   - lane AP's rows are the only new ones (counted from the files); every
//     template, track, script and drill from before stays unchanged;
//   - a Backbone JSON cell is stored as written, the block weeks the Backbone
//     leaves blank stay blank and the day "1 (bout day)" is kept as written;
//   - the AI-drafted template fields (OD-2026-11-17-001) are stored as filled,
//     their labels with the draft marker;
//   - the sparring minutes stay in item details with the column blank
//     (OD-2026-11-17-002; pilot_wti_no_contact_volume unchanged);
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
import { labelTargetKind } from './contentImport/datasets/contentLabels';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import type { DatasetName } from './contentImport/types';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_ap';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-ap-pg-test-${Date.now()}`);
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

/** Every claim id of the LOADED research package, as chunks of the shared __platform__ library (as lane YR's suite). */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, rights_status)
     values ('src_ap_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/ap-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_ap_test', 'src_ap_test', '__platform__', 'Loaded research claims (test)', 'ap-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_ap_test', 'src_ap_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
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
  // workout-template-details (YR-a) among them.
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
const OTHER_STAGES = ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'];
const AP_STAGES = ['T1', 'T2', 'AM1', 'AM2', 'AM3', 'PR1', 'PR2', 'PR3', 'PR4', 'PR5'];
const MARK = 'AI draft, lane AP, 2026-11-17 (OD-2026-11-17-001)';

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

/** A CSV text with `keep` rows only, through the real reader and writer. */
function reshape(text: string, keep: (row: Row) => boolean): string {
  const table = readCsv(text);
  return writeCsv(table.header, rowsOf(text).filter(keep).map((row) => table.header.map((name) => row[name] ?? '')));
}

const PACKAGES: readonly DatasetName[] = ['drill-library', 'workout-templates', 'session-scripts', 'training-tracks'];
const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions', 'pathway-catalog'];
const committed = readDatasetFiles(SEED_DATA_DIR, PACKAGES);
const inLane = (row: Row) => {
  // The exporter's own filter: not exactly ["FT1"], no youth or RC1 stage, an amateur or pro stage.
  const keys = row.stage_keys.split('|');
  return row.stage_keys !== 'FT1' && !keys.some((key) => OTHER_STAGES.includes(key)) && keys.some((key) => AP_STAGES.includes(key));
};
const apTemplates = rowsOf(committed[TEMPLATES_CSV]).filter(inLane);
const apTemplateIds = new Set(apTemplates.map((row) => row.template_id));
const apTrackIds = new Set(rowsOf(committed[TRACKS_CSV]).filter(inLane).map((row) => row.track_id));
const otherTemplates = rowsOf(committed[TEMPLATES_CSV]).filter((row) => !apTemplateIds.has(row.template_id));
const otherTracks = rowsOf(committed[TRACKS_CSV]).filter((row) => !apTrackIds.has(row.track_id));
const ofApTemplate = (row: Row) => apTemplateIds.has(row.template_id);
const ofApTrack = (row: Row) => apTrackIds.has(row.track_id);

/** Production and staging before this lane: every committed row but lane AP's. */
function beforeFiles(): Record<string, string> {
  return {
    ...committed,
    [TEMPLATES_CSV]: reshape(committed[TEMPLATES_CSV], (row) => !ofApTemplate(row)),
    [ITEMS_CSV]: reshape(committed[ITEMS_CSV], (row) => !ofApTemplate(row)),
    [TRACKS_CSV]: reshape(committed[TRACKS_CSV], (row) => !ofApTrack(row)),
    [BLOCKS_CSV]: reshape(committed[BLOCKS_CSV], (row) => !ofApTrack(row)),
    [SESSIONS_CSV]: reshape(committed[SESSIONS_CSV], (row) => !ofApTrack(row)),
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

describe('the amateur and pro content added to a gym that has everything before it', () => {
  const ORG = 'ap_gym';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(ORG);
    await applyCommitted(ORG, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
    await applyCommitted(ORG, admin, beforeFiles());
  });

  it('plans only lane AP as new, and every template, track, script and drill from before unchanged', async () => {
    expect([apTemplateIds.size, apTrackIds.size]).toEqual([66, 14]);
    const result = await plan(ORG, admin, committed);
    expect(result.blocking).toEqual([]);
    expect(result.counts['workout-templates']).toEqual({ new: 66, new_version: 0, unchanged: otherTemplates.length, absent: 0, reject: 0 });
    expect(result.counts['training-tracks']).toEqual({ new: 14, new_version: 0, unchanged: otherTracks.length, absent: 0, reject: 0 });
    expect(result.counts['session-scripts']).toEqual(expect.objectContaining({ new: 0, new_version: 0, absent: 0, reject: 0 }));
    expect(result.counts['session-scripts']?.unchanged).toBe(rowsOf(committed[SCRIPTS_CSV]).length);
    expect(result.counts['drill-library']).toEqual(expect.objectContaining({ new: 0, new_version: 0, absent: 0, reject: 0 }));
    expect(result.counts['drill-library']?.unchanged).toBe(rowsOf(committed['drill-library/seed_drill_library.csv']).length);
  });

  it('loads it: 14 tracks, 16 blocks, 498 block sessions, 66 templates, 162 items, every Backbone field kept, and plans nothing more', async () => {
    await applyCommitted(ORG, admin, committed);
    const counts = await observer.query<{ tracks: string; blocks: string; sessions: string; templates: string; items: string }>(
      `select (select count(*) from pilot.training_tracks where organization_id = $1 and track_id = any($2::text[])) as tracks,
              (select count(*) from pilot.track_blocks where organization_id = $1 and track_id = any($2::text[])) as blocks,
              (select count(*) from pilot.track_block_sessions where organization_id = $1 and track_id = any($2::text[])) as sessions,
              (select count(*) from pilot.workout_templates where organization_id = $1 and template_id = any($3::text[])) as templates,
              (select count(*) from pilot.workout_template_items where organization_id = $1 and template_id = any($3::text[])) as items`,
      [ORG, [...apTrackIds], [...apTemplateIds]],
    );
    expect(counts.rows[0]).toEqual({ tracks: '14', blocks: '16', sessions: '498', templates: '66', items: '162' });

    const files = new Map(rowsOf(committed[TRACKS_CSV]).filter(ofApTrack).map((row) => [row.track_id, JSON.parse(row.details || '{}')]));
    const stored = await observer.query<{ track_id: string; details: unknown }>(
      `select track_id, details from pilot.training_tracks where organization_id = $1 and track_id = any($2::text[])`,
      [ORG, [...apTrackIds]],
    );
    for (const row of stored.rows) expect({ track: row.track_id, details: row.details }).toEqual({ track: row.track_id, details: files.get(row.track_id) });

    const blank = await observer.query<{ weeks: number | null; n: string }>(
      `select weeks, count(*) as n from pilot.track_blocks where organization_id = $1 and track_id = 'trk_89c3ba325a7e0d' group by weeks`,
      [ORG],
    );
    expect(blank.rows).toEqual([{ weeks: null, n: '2' }]);
    const boutDay = await observer.query<{ day: string }>(
      `select day from pilot.track_block_sessions where organization_id = $1 and track_id = 'trk_a5e16184502c0f'`,
      [ORG],
    );
    expect(boutDay.rows).toEqual([{ day: '1 (bout day)' }]);

    const again = await plan(ORG, admin, committed);
    expect(again.blocking).toEqual([]);
    expect(again.changes).toBe(0);
  });

  it('stores the four template fields as the files fill them, and the 68 drafted fields\' labels with the draft marker', async () => {
    const { rows } = await observer.query<{ template_id: string; session_type: string; difficulty: string; duration_minutes: number; intent: string }>(
      `select template_id, session_type, difficulty, duration_minutes, intent from pilot.workout_templates
        where organization_id = $1 and template_id = any($2::text[]) and superseded_at is null`,
      [ORG, [...apTemplateIds]],
    );
    const byId = new Map(apTemplates.map((row) => [row.template_id, row]));
    for (const row of rows) {
      const file = byId.get(row.template_id)!;
      expect({ id: row.template_id, session_type: row.session_type, difficulty: row.difficulty, duration_minutes: String(row.duration_minutes), intent: row.intent })
        .toEqual({ id: row.template_id, session_type: file.session_type, difficulty: file.difficulty, duration_minutes: file.duration_minutes, intent: file.intent });
    }
    const labels = await observer.query<{ n: string }>(
      `select count(*) as n
         from pilot.content_record_labels l, jsonb_each(l.field_labels) as field(name, label)
        where l.organization_id = $1 and l.target_kind = $2 and l.target_lineage_id = any($3::text[])
          and field.name in ('session_type', 'difficulty', 'duration_minutes', 'intent') and field.label->>'draft' = $4`,
      [ORG, labelTargetKind('workout-templates'), [...apTemplateIds], MARK],
    );
    expect(labels.rows[0].n).toBe('68');
  });

  it('keeps the three sparring minutes in item details with the column blank, and links a pro track to PR1-PR5', async () => {
    const { rows } = await observer.query<{ template_id: string; ordinal: number; duration_minutes: number | null; minutes: number }>(
      `select template_id, ordinal, duration_minutes, (details->>'duration_minutes')::int as minutes from pilot.workout_template_items
        where organization_id = $1 and template_id = any($2::text[]) and contact_level not in ('none', 'light_technical') and details ? 'duration_minutes'
        order by template_id, ordinal`,
      [ORG, [...apTemplateIds]],
    );
    expect(rows.map((row) => [row.template_id, row.ordinal, row.duration_minutes, row.minutes])).toEqual([
      ['wtp_25a003f73a472c', 2, null, 55], ['wtp_a2d9f97418ec52', 4, null, 30], ['wtp_bc964fe230d8f3', 6, null, 30],
    ]);
    const links = await observer.query<{ stage_key: string }>(
      `select stage_key from pilot.content_stage_links
        where organization_id = $1 and target_kind = 'training_track' and target_lineage_id = 'trk_c818600ed825bd' and superseded_at is null order by stage_key`,
      [ORG],
    );
    expect(links.rows.map((row) => row.stage_key)).toEqual(['PR1', 'PR2', 'PR3', 'PR4', 'PR5']);
  });
});
