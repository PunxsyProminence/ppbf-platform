// Class plans read module (lane FT1c) against the full migrated schema, with the
// FT1 track loaded from the committed package exactly as lane FT1b loads it.
//
// What this pins: the committed FT1 track reads back as 8 weeks with their
// titles and 5 days each, every day resolved to its template by name; every day
// is judged by the same readiness an issue applies (planTemplateIssue), except a
// day of typed steps only, which reads coach-run (OD-2026-11-15-001); a day
// whose template lineage has no current row reads "missing" and a withdrawn one
// "withdrawn", both still present; another gym sees nothing of this gym's track.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

let activeClient: import('pg').Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

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
import { readCsv } from './contentImport/csv';
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

const FT1_PACKAGES: readonly DatasetName[] = ['drill-library', 'workout-templates', 'training-tracks'];
// The stages a stage_keys cell names must be loaded: the pathway catalog comes with the registries.
const REGISTRIES: readonly DatasetName[] = ['disciplines', 'competence-levels', 'cohort-definitions', 'pathway-catalog'];
const committed = readDatasetFiles(SEED_DATA_DIR, FT1_PACKAGES);
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

import { getClassPlanTrack, listClassPlanTracks, listLibraryTracks } from './classPlans';

const FT1_TRACK = 'trk_d104860a7eccef';
const csvRows = (name: string) => {
  const table = readCsv(committed[name]);
  return table.records.map((record) => Object.fromEntries(table.header.map((column, index) => [column, record.cells[index] ?? ''])));
};
/**
 * The committed tracks Class plans lists: those with at least one block. Read from the files, never
 * pinned: lane YR adds the 48-session youth manual beside FT1, and its 52 library tracks (no blocks)
 * go to the Library view instead.
 */
const blockRows = csvRows('training-tracks/seed_track_blocks.csv');
const sessionRows = csvRows('training-tracks/seed_track_block_sessions.csv');
const tracksWithBlocks = csvRows('training-tracks/seed_training_tracks.csv')
  .filter((row) => blockRows.some((block) => block.track_id === row.track_id))
  .map((row) => ({
    track_id: row.track_id,
    name: row.name,
    duration_weeks: row.duration_weeks === '' ? null : Number(row.duration_weeks),
    block_count: blockRows.filter((block) => block.track_id === row.track_id).length,
    day_count: sessionRows.filter((session) => session.track_id === row.track_id).length,
  }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const committedLibraryTracks = csvRows('training-tracks/seed_training_tracks.csv')
  .filter((row) => !blockRows.some((block) => block.track_id === row.track_id)).length;

describe('Class plans over the loaded FT1 track', () => {
  const ORG = 'ft1_gym';
  const OTHER = 'other_gym';
  let admin: string;
  let trackId: string;

  beforeAll(async () => {
    activeClient = client;
    admin = await createGym(ORG);
    await createGym(OTHER);
    await applyCommitted(ORG, admin, readDatasetFiles(SEED_DATA_DIR, REGISTRIES));
    await applyCommitted(ORG, admin, committed);
    trackId = (await client.query<{ track_id: string }>(
      `select track_id from pilot.training_tracks where organization_id = $1 and track_id = $2`, [ORG, FT1_TRACK],
    )).rows[0].track_id;
  });

  it('lists every committed track with blocks, FT1 among them, with its counts', async () => {
    expect(tracksWithBlocks.map((track) => track.track_id)).toContain(FT1_TRACK);
    expect(tracksWithBlocks.find((track) => track.track_id === FT1_TRACK)).toEqual({
      track_id: FT1_TRACK, name: '8-Week Non-Contact Boxing Pilot Program', duration_weeks: 8, block_count: 8, day_count: 40,
    });
    expect(await listClassPlanTracks(ORG)).toEqual(tracksWithBlocks.map((track) => expect.objectContaining(track)));
  });

  it('reads 8 titled weeks of 5 days in order, each day naming its template, and carries the detail fields', async () => {
    const track = await getClassPlanTrack(ORG, trackId);
    expect(track).not.toBeNull();
    expect(track!.weeks).toHaveLength(8);
    track!.weeks.forEach((week, index) => {
      expect(week.week).toBe(index + 1);
      expect(week.title).toMatch(new RegExp(`^Week ${index + 1}:`));
      expect(week.days).toHaveLength(5);
      expect(week.days.map((day) => day.ordinal)).toEqual([...week.days.map((day) => day.ordinal)].sort((a, b) => a - b));
      expect(week.days.map((day) => day.day)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
      for (const day of week.days) {
        expect(day.template.state).not.toBe('missing');
        expect(day.template.state).not.toBe('withdrawn');
        expect(day.template.name).toEqual(expect.any(String));
        expect(day.template.template_id).toEqual(expect.any(String));
      }
    });
    expect(Object.keys(track!.details)).toEqual(expect.arrayContaining(['primary_cue', 'decision_cycle', 'friday_protocol']));
  });

  it('judges each day as an issue would: Monday to Thursday ready, every Friday (typed steps only) coach-run', async () => {
    const days = (await getClassPlanTrack(ORG, trackId))!.weeks.flatMap((week) => week.days);
    const fridays = days.filter((day) => day.day === 'Friday');
    expect(fridays).toHaveLength(8);
    for (const day of fridays) {
      expect(day.template).toMatchObject({ state: 'coach_run', drill_count: 3, drills_to_complete: 0 });
    }
    for (const day of days.filter((d) => d.day !== 'Friday')) {
      expect(day.template).toMatchObject({ state: 'ready', drills_to_complete: 0 });
    }
  });

  it('still reads not ready, with counts, where a template mixes a typed step with drills', async () => {
    const monday = (await getClassPlanTrack(ORG, trackId))!.weeks[0].days[0];
    expect(monday.template.state).toBe('ready');
    await client.query('BEGIN');
    try {
      const changed = await client.query(
        `update pilot.workout_template_items set drill_id = null, free_text_drill = 'Typed step'
         where organization_id = $1 and template_id = $2
           and ordinal = (select min(ordinal) from pilot.workout_template_items where organization_id = $1 and template_id = $2)`,
        [ORG, monday.template.template_id],
      );
      expect(changed.rowCount).toBe(1);
      const after = (await getClassPlanTrack(ORG, trackId))!.weeks[0].days[0];
      expect(after.template.state).toBe('not_ready');
      expect(after.template.drills_to_complete).toBe(1);
      expect(after.template.drill_count).toBeGreaterThan(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('shows a lineage with no current template as missing and a withdrawn template as withdrawn, never dropping the day', async () => {
    const before = (await getClassPlanTrack(ORG, trackId))!.weeks.flatMap((week) => week.days);
    const [first, second] = before;
    await client.query('BEGIN');
    try {
      await client.query(
        `update pilot.track_block_sessions set template_lineage_id = 'wtp_00000000000000' where organization_id = $1 and block_session_id = $2`,
        [ORG, first.block_session_id],
      );
      await client.query(
        `update pilot.workout_templates set active = false where organization_id = $1 and template_id = $2`,
        [ORG, second.template.template_id],
      );
      const after = (await getClassPlanTrack(ORG, trackId))!.weeks.flatMap((week) => week.days);
      expect(after).toHaveLength(40);
      expect(after[0].template).toEqual({ state: 'missing', template_id: null, name: null, drill_count: null, drills_to_complete: null });
      expect(after[1].template).toMatchObject({ state: 'withdrawn', name: second.template.name, template_id: second.template.template_id });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('shows another gym nothing of the track of this gym', async () => {
    expect(await listClassPlanTracks(OTHER)).toEqual([]);
    expect(await getClassPlanTrack(OTHER, trackId)).toBeNull();
  });
  // Library tracks (lane YR-c): a track with no blocks is text only. Written
  // straight into the table inside a rolled-back transaction; made-up text.
  async function insertLibraryTrack(
    organizationId: string,
    id: string,
    name: string,
    details: Record<string, unknown>,
    extra: { active?: boolean; superseded?: boolean } = {},
  ) {
    await client.query(
      `insert into pilot.training_tracks (organization_id, track_id, lineage_id, name, lane, status, details, active, superseded_at)
       values ($1, $2, $2, $3, 'standard', 'REPORTED', $4::jsonb, $5, case when $6 then now() else null end)`,
      [organizationId, id, name, JSON.stringify(details), extra.active ?? true, extra.superseded ?? false],
    );
  }

  it('lists a track with no blocks as library, not as a class plan, with its headings and group count', async () => {
    await client.query('BEGIN');
    try {
      await insertLibraryTrack(ORG, 'trk_00000000000b02', 'B library track', {
        part_heading: 'PART 1', chapter_heading: '1. Made-up chapter', subtitle: 'A subtitle',
        groups: [{ section: 'S1', heading: 'One', blocks: [] }, { section: 'S2', heading: 'Two', blocks: [] }],
      });
      await insertLibraryTrack(ORG, 'trk_00000000000a01', 'A library track', { groups: 'not a list' });
      await insertLibraryTrack(ORG, 'trk_00000000000c03', 'C withdrawn', {}, { active: false });
      await insertLibraryTrack(ORG, 'trk_00000000000d04', 'D superseded', {}, { superseded: true, active: false });
      await insertLibraryTrack(OTHER, 'trk_00000000000e05', 'E other gym', {});

      // Class plans: the committed tracks with blocks, nothing else (lane YR adds the 48-session youth manual).
      expect((await listClassPlanTracks(ORG)).map((track) => track.track_id)).toEqual(tracksWithBlocks.map((track) => track.track_id));
      // Library: the two fixtures, plus every committed track without blocks (lane YR's library tracks).
      const library = await listLibraryTracks(ORG);
      expect(library.filter((track) => track.track_id.startsWith('trk_00000000000'))).toEqual([
        { track_id: 'trk_00000000000a01', name: 'A library track', lane: 'standard', age_band: 'any',
          part_heading: null, chapter_heading: null, subtitle: null, group_count: 0 },
        { track_id: 'trk_00000000000b02', name: 'B library track', lane: 'standard', age_band: 'any',
          part_heading: 'PART 1', chapter_heading: '1. Made-up chapter', subtitle: 'A subtitle', group_count: 2 },
      ]);
      expect(library).toHaveLength(2 + committedLibraryTracks);
      expect((await listLibraryTracks(OTHER)).map((track) => track.track_id)).toEqual(['trk_00000000000e05']);

      // One library track opens through the same read, with its details whole and no weeks.
      const opened = await getClassPlanTrack(ORG, 'trk_00000000000b02');
      expect(opened).toMatchObject({ track_id: 'trk_00000000000b02', block_count: 0, day_count: 0, weeks: [] });
      expect(opened!.details).toMatchObject({ part_heading: 'PART 1', groups: [{ section: 'S1' }, { section: 'S2' }] });
      expect(await getClassPlanTrack(OTHER, 'trk_00000000000b02')).toBeNull();
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
