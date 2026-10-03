// Real PostgreSQL-backed test for body points (TEACH-BIOMECH-01-b).
//
// Every claim here is database behaviour, because every rule lives in the
// database:
//
//   * a 0.1 set cannot hold a moment, and a set holding moments cannot change
//     vocabulary
//   * a moment sits on its event's start, end or contact time, or inside the
//     event, and its middle kind follows from the event
//   * points are only ever on the person whose action the event is
//   * the facts a moment was checked against cannot change under it
//   * nothing crosses set, clip, event or organization
//   * a placed point is inside the picture; a not-visible one has no position
//   * a submitted set's moments and points are frozen, and deleting the
//     footage, clip, set or event still removes them
//   * every vocabulary CHECK carries exactly the ontology.ts array
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { seedCaptureTake } from '../../testing/captureFixture';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-body-points-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_body';

const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-body-points-migration.mjs',
);

const PREREQUISITE_SQL = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_calibration_projects_migration.sql',
  'pilot_slice_postgres_calibration_annotations_migration.sql',
];
const BODY_POINTS_SQL = 'pilot_slice_postgres_calibration_body_points_migration.sql';

const ORG_ID = 'org-body';
const OTHER_ORG_ID = 'org-body-other';
const ANNOTATOR = 'acct-body-annotator';
const VIDEO_ID = 'vs-body-ready';

const CLIP_START_MS = 60_000;
const CLIP_END_MS = 72_000;
const EV_START = CLIP_START_MS + 1_000;
const EV_END = CLIP_START_MS + 1_400;
const EV_CONTACT = CLIP_START_MS + 1_250;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let annotations: typeof import('./calibration/annotations');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');
let db: Client;
let PROJECT_ID: string;

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

async function readMigration(name: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, name), 'utf8');
}

type ApplyFn = (client: Client, sql: string) => Promise<void>;

async function loadRunner(): Promise<{ applyMigrationTransaction: ApplyFn; run: () => Promise<void> }> {
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  return runner as unknown as { applyMigrationTransaction: ApplyFn; run: () => Promise<void> };
}

/** A database with every prerequisite applied and the body-points migration NOT applied. */
async function prerequisiteDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const file of PREREQUISITE_SQL) {
    await client.query(await readMigration(file));
  }
  return client;
}

async function seed(client: Client): Promise<void> {
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [ANNOTATOR, ORG_ID],
  );
  await seedVideo(client, VIDEO_ID);
}

/** Teaching footage: clips are only cut from a video with a capture take. */
async function seedVideo(client: Client, videoId: string): Promise<void> {
  const take = await seedCaptureTake(client, { organizationId: ORG_ID, createdByAccountId: ANNOTATOR });
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status,
        recording_session_id, capture_take_id)
     values ($1, $2, $3, null, 'Sparring', $4, 'b.mp4', 2048, 'video/mp4', 'ready', $5, $6)
     on conflict do nothing`,
    [videoId, ORG_ID, ANNOTATOR, `p/${videoId}.mp4`, take.recordingSessionId, take.captureTakeId],
  );
}

async function newClip(videoId = VIDEO_ID): Promise<string> {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId: ORG_ID,
    calibrationClipId: clipId,
    calibrationProjectId: PROJECT_ID,
    videoSessionId: videoId,
    clipCode: `C-${clipId.slice(0, 8)}`,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: ANNOTATOR,
  });
  return clipId;
}

interface SetRef {
  setId: string;
  clipId: string;
}

/** A fresh clip and an in-progress set on it, under the given vocabulary. */
async function newSet(version: string = 'boxing-ontology-0.2', videoId = VIDEO_ID): Promise<SetRef> {
  const clipId = await newClip(videoId);
  const setId = crypto.randomUUID();
  await annotations.openAnnotationSet({
    organizationId: ORG_ID,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId: ANNOTATOR,
    ontologyVersion: version,
  });
  return { setId, clipId };
}

async function punch(set: SetRef, overrides: Record<string, unknown> = {}): Promise<string> {
  const event = await annotations.recordAnnotationEvent({
    organizationId: ORG_ID,
    eventId: crypto.randomUUID(),
    annotationSetId: set.setId,
    eventClass: 'punch',
    actorTrack: 'red',
    opponentTrack: 'blue',
    startMs: EV_START,
    endMs: EV_END,
    contactMs: EV_CONTACT,
    physicalHand: 'left',
    handRole: 'lead',
    punchType: 'lead_straight',
    targetZone: 'head',
    contactResult: 'clean_target_contact',
    visibility: 'clear',
    certainty: 'clear',
    ...overrides,
  });
  return event.event_id;
}

async function defense(set: SetRef, overrides: Record<string, unknown> = {}): Promise<string> {
  const event = await annotations.recordAnnotationEvent({
    organizationId: ORG_ID,
    eventId: crypto.randomUUID(),
    annotationSetId: set.setId,
    eventClass: 'defense',
    actorTrack: 'blue',
    opponentTrack: 'red',
    startMs: EV_START,
    endMs: EV_END,
    defenseType: 'slip',
    visibility: 'clear',
    certainty: 'clear',
    ...overrides,
  });
  return event.event_id;
}

interface MomentInput {
  slot?: string;
  kind?: string;
  observationMs?: number;
  eventStartMs?: number;
  eventEndMs?: number;
  clipId?: string;
  organizationId?: string;
  leadSide?: string | null;
  guardType?: string | null;
}

const SLOT_DEFAULTS: Record<string, { kind: string; observationMs: number }> = {
  start: { kind: 'start', observationMs: EV_START },
  middle: { kind: 'contact', observationMs: EV_CONTACT },
  end: { kind: 'end', observationMs: EV_END },
};

async function insertMoment(set: SetRef, eventId: string, input: MomentInput = {}): Promise<string> {
  const slot = input.slot ?? 'start';
  const defaults = SLOT_DEFAULTS[slot] ?? SLOT_DEFAULTS.start;
  const momentId = crypto.randomUUID();
  await db.query(
    `insert into pilot.calibration_body_moments
       (organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
        event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms,
        lead_side, guard_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.organizationId ?? ORG_ID,
      momentId,
      set.setId,
      input.clipId ?? set.clipId,
      eventId,
      input.eventStartMs ?? EV_START,
      input.eventEndMs ?? EV_END,
      slot,
      input.kind ?? defaults.kind,
      input.observationMs ?? defaults.observationMs,
      input.leadSide === undefined ? 'orthodox' : input.leadSide,
      input.guardType === undefined ? 'usa_boxing__high_double_guard' : input.guardType,
    ],
  );
  return momentId;
}

async function insertPoint(
  setId: string,
  momentId: string,
  pointCode: string,
  state: string,
  x: number | null,
  y: number | null,
): Promise<string> {
  const pointId = crypto.randomUUID();
  await db.query(
    `insert into pilot.calibration_body_points
       (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ORG_ID, pointId, setId, momentId, pointCode, state, x, y],
  );
  return pointId;
}

async function countFor(table: string, setId: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from pilot.${table} where organization_id = $1 and annotation_set_id = $2`,
    [ORG_ID, setId],
  );
  return Number(result.rows[0].n);
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

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
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  // The suite's database is built through the runner, so every test below
  // also runs against what the runner applied.
  db = await prerequisiteDatabase(TEST_DB_NAME);
  const runner = await loadRunner();
  await runner.applyMigrationTransaction(db, await readMigration(BODY_POINTS_SQL));
  await seed(db);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: PROJECT_ID,
    name: 'Body points study',
    ontologyVersion: ontology.PROJECT_CREATION_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR,
  });
});

afterAll(async () => {
  await db?.end().catch(() => {});
  const { closePool } = await import('./db');
  await closePool();

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

describe('the runner', () => {
  test('refuses a database the migration has not reached', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_body_unmigrated');
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_BODY_POINTS_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  test('a second run is a no-op that leaves rows in place', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await insertMoment(set, eventId);

    const runner = await loadRunner();
    await runner.applyMigrationTransaction(db, await readMigration(BODY_POINTS_SQL));
    expect(await countFor('calibration_body_moments', set.setId)).toBe(1);
  });

  test('refuses a target other than the one the operator named, before connecting', async () => {
    const saved = { ...process.env };
    try {
      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
      process.env.PPBF_EXPECTED_POSTGRES_HOSTNAME = 'localhost';
      process.env.PPBF_EXPECTED_POSTGRES_DATABASE = 'some_other_database';
      const runner = await loadRunner();
      await expect(runner.run()).rejects.toThrow('POSTGRES_TARGET_MISMATCH');
    } finally {
      process.env = saved;
    }
  });
});

describe('the database agrees with ontology.ts', () => {
  const CHECKS: Array<[string, string, string, () => readonly string[]]> = [
    ['calibration_body_moments', 'pilot_calibration_body_moments_slot_vocab', 'moment_slot', () => ontology.MOMENT_SLOTS],
    ['calibration_body_moments', 'pilot_calibration_body_moments_kind_vocab', 'moment_kind', () => ontology.MOMENT_KINDS],
    ['calibration_body_moments', 'pilot_calibration_body_moments_lead_side_vocab', 'lead_side', () => ontology.LEAD_SIDES],
    ['calibration_body_moments', 'pilot_calibration_body_moments_guard_vocab', 'guard_type', () => ontology.GUARD_TYPES],
    ['calibration_body_points', 'pilot_calibration_body_points_code_vocab', 'point_code', () => ontology.BODY_POINTS],
    ['calibration_body_points', 'pilot_calibration_body_points_state_vocab', 'state', () => ontology.BODY_POINT_STATES],
  ];

  test.each(CHECKS)('%s %s is written as vocabularyCheckSql and holds exactly the array', async (table, name, column, vocabulary) => {
    const source = await readMigration(BODY_POINTS_SQL);
    expect(source).toContain(`constraint ${name}\n    ${ontology.vocabularyCheckSql(column, vocabulary())}`);

    // The live constraint, read back. Postgres deparses `in (...)` into an
    // ANY(ARRAY[...]) form, so the values are compared, not the text.
    const live = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = to_regclass($1) and conname = $2`,
      [`pilot.${table}`, name],
    );
    expect(live.rows).toHaveLength(1);
    const values = [...live.rows[0].def.matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(values).toEqual([...vocabulary()]);
  });

  test('the version gate admits exactly BODY_POINT_ONTOLOGY_VERSIONS', async () => {
    const live = await db.query<{ def: string }>(
      `select pg_get_functiondef('pilot.calibration_body_moments_guard()'::regprocedure) as def`,
    );
    const gate = live.rows[0].def.match(/parent_version not in \(([^)]*)\)/);
    expect(gate).not.toBeNull();
    const versions = [...(gate as RegExpMatchArray)[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
    expect(versions).toEqual([...ontology.BODY_POINT_ONTOLOGY_VERSIONS]);
  });
});

describe('a complete event', () => {
  test('a landed punch holds three moments, 24 points on each', async () => {
    const set = await newSet();
    const eventId = await punch(set);

    for (const slot of ontology.MOMENT_SLOTS) {
      const momentId = await insertMoment(set, eventId, { slot });
      for (const [index, code] of ontology.BODY_POINTS.entries()) {
        if (index % 5 === 0) {
          await insertPoint(set.setId, momentId, code, 'not_visible', null, null);
        } else {
          await insertPoint(set.setId, momentId, code, 'placed', (index % 3) / 2, 1 - (index % 4) / 3);
        }
      }
    }

    expect(await countFor('calibration_body_moments', set.setId)).toBe(3);
    expect(await countFor('calibration_body_points', set.setId)).toBe(3 * 24);
  });

  test('the edges of the picture are on it', async () => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await insertPoint(set.setId, momentId, 'nose', 'placed', 0, 0);
    await insertPoint(set.setId, momentId, 'chin', 'placed', 1, 1);
    expect(await countFor('calibration_body_points', set.setId)).toBe(2);
  });
});

describe('old studies never hold body points', () => {
  test('a moment on a 0.1 set is refused', async () => {
    const set = await newSet('boxing-ontology-0.1');
    const eventId = await punch(set);
    await expect(insertMoment(set, eventId)).rejects.toThrow('CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION');
  });

  test('a set holding moments cannot change vocabulary; an empty one still can', async () => {
    const holding = await newSet();
    await insertMoment(holding, await punch(holding));
    await expect(
      db.query(
        `update pilot.calibration_annotation_sets set ontology_version = 'boxing-ontology-0.1'
          where organization_id = $1 and annotation_set_id = $2`,
        [ORG_ID, holding.setId],
      ),
    ).rejects.toThrow('CALIBRATION_SET_HAS_BODY_MOMENTS');

    const empty = await newSet();
    await db.query(
      `update pilot.calibration_annotation_sets set ontology_version = 'boxing-ontology-0.1'
        where organization_id = $1 and annotation_set_id = $2`,
      [ORG_ID, empty.setId],
    );
  });
});

describe('every label from its own vocabulary', () => {
  test.each([
    // An unknown slot also fails the slot/kind pairing, which Postgres may name
    // first; either refusal is the vocabulary holding.
    ['slot', { slot: 'peak', kind: 'start' }, /pilot_calibration_body_moments_slot_(vocab|kind)/],
    ['kind', { kind: 'peak' }, 'pilot_calibration_body_moments_kind_vocab'],
    ['lead side', { leadSide: 'switching' }, 'pilot_calibration_body_moments_lead_side_vocab'],
    ['guard', { guardType: 'good_guard' }, 'pilot_calibration_body_moments_guard_vocab'],
  ])('an unknown %s is refused', async (_label, input, constraint) => {
    const set = await newSet();
    await expect(insertMoment(set, await punch(set), input)).rejects.toThrow(constraint);
  });

  test('lead side and guard may wait for the coach (null)', async () => {
    const set = await newSet();
    await insertMoment(set, await punch(set), { leadSide: null, guardType: null });
    expect(await countFor('calibration_body_moments', set.setId)).toBe(1);
  });

  test('an unknown point code or state is refused', async () => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await expect(insertPoint(set.setId, momentId, 'left_index', 'placed', 0.5, 0.5)).rejects.toThrow(
      'pilot_calibration_body_points_code_vocab',
    );
    // An unknown state also fails the position rule, which Postgres may name
    // first; either refusal is the vocabulary holding.
    await expect(insertPoint(set.setId, momentId, 'nose', 'accepted', 0.5, 0.5)).rejects.toThrow(
      /pilot_calibration_body_points_(state_vocab|position)/,
    );
  });
});

describe('a point is on the picture or not visible', () => {
  test.each([
    ['x above 1', 'placed', 1.0001, 0.5],
    ['x below 0', 'placed', -0.0001, 0.5],
    ['y above 1', 'placed', 0.5, 1.5],
    ['x missing', 'placed', null, 0.5],
    ['y missing', 'placed', 0.5, null],
    ['NaN', 'placed', Number.NaN, 0.5],
    ['infinity', 'placed', 0.5, Number.POSITIVE_INFINITY],
    ['not visible with a position', 'not_visible', 0.5, 0.5],
    ['not visible with half a position', 'not_visible', null, 0.5],
  ])('%s is refused', async (_label, state, x, y) => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await expect(insertPoint(set.setId, momentId, 'nose', state as string, x as number | null, y as number | null)).rejects.toThrow(
      'pilot_calibration_body_points_position',
    );
  });
});

describe('a moment sits where the event says', () => {
  test('a start moment off the event start is refused', async () => {
    const set = await newSet();
    await expect(insertMoment(set, await punch(set), { slot: 'start', observationMs: EV_START + 1 })).rejects.toThrow(
      'pilot_calibration_body_moments_on_edge',
    );
  });

  test('an end moment off the event end is refused', async () => {
    const set = await newSet();
    await expect(insertMoment(set, await punch(set), { slot: 'end', observationMs: EV_END - 1 })).rejects.toThrow(
      'pilot_calibration_body_moments_on_edge',
    );
  });

  test.each([
    ['one side only', 1920, null],
    ['the other side only', null, 1080],
    ['zero', 0, 1080],
  ])('a picture size with %s is refused', async (_label, width, height) => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await expect(
      db.query(
        `update pilot.calibration_body_moments
            set source_frame_width_px = $3, source_frame_height_px = $4
          where organization_id = $1 and body_moment_id = $2`,
        [ORG_ID, momentId, width, height],
      ),
    ).rejects.toThrow('pilot_calibration_body_moments_frame_size');
  });

  test('a picture size with both sides is kept', async () => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await db.query(
      `update pilot.calibration_body_moments
          set source_frame_width_px = 1920, source_frame_height_px = 1080
        where organization_id = $1 and body_moment_id = $2`,
      [ORG_ID, momentId],
    );
  });

  test('a slot and kind that do not pair are refused', async () => {
    const set = await newSet();
    await expect(
      insertMoment(set, await punch(set), { slot: 'start', kind: 'end', observationMs: EV_END }),
    ).rejects.toThrow('pilot_calibration_body_moments_slot_kind');
  });

  test('a full-extension moment outside the event is refused', async () => {
    const set = await newSet();
    const eventId = await punch(set, { contactMs: undefined, contactResult: 'no_contact' });
    await expect(
      insertMoment(set, eventId, { slot: 'middle', kind: 'full_extension', observationMs: EV_END + 1 }),
    ).rejects.toThrow('pilot_calibration_body_moments_within_event');
  });

  test('bounds that are not the event\'s real bounds are refused', async () => {
    const set = await newSet();
    await expect(
      insertMoment(set, await punch(set), { eventStartMs: EV_START - 100, observationMs: EV_START - 100 }),
    ).rejects.toThrow('pilot_calibration_body_moments_event_fk');
  });
});

describe('the middle moment follows from the event', () => {
  test('contact on an event with no contact time is refused', async () => {
    const set = await newSet();
    const eventId = await punch(set, { contactMs: undefined, contactResult: 'no_contact' });
    await expect(insertMoment(set, eventId, { slot: 'middle', kind: 'contact' })).rejects.toThrow(
      'CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT',
    );
  });

  test('contact away from the contact time is refused', async () => {
    const set = await newSet();
    await expect(
      insertMoment(set, await punch(set), { slot: 'middle', kind: 'contact', observationMs: EV_CONTACT + 1 }),
    ).rejects.toThrow('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT');
  });

  test('full extension on a punch that has a contact time is refused', async () => {
    const set = await newSet();
    await expect(
      insertMoment(set, await punch(set), { slot: 'middle', kind: 'full_extension', observationMs: EV_CONTACT }),
    ).rejects.toThrow('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT');
  });

  test('full extension on a defence is refused', async () => {
    const set = await newSet();
    await expect(
      insertMoment(set, await defense(set), { slot: 'middle', kind: 'full_extension', observationMs: EV_CONTACT }),
    ).rejects.toThrow('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT');
  });

  test('furthest point on a punch is refused', async () => {
    const set = await newSet();
    const eventId = await punch(set, { contactMs: undefined, contactResult: 'no_contact' });
    await expect(
      insertMoment(set, eventId, { slot: 'middle', kind: 'furthest_point', observationMs: EV_CONTACT }),
    ).rejects.toThrow('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT');
  });

  test('furthest point on a defence that has a contact time is refused', async () => {
    const set = await newSet();
    const eventId = await defense(set, { contactMs: EV_CONTACT });
    await expect(
      insertMoment(set, eventId, { slot: 'middle', kind: 'furthest_point', observationMs: EV_CONTACT }),
    ).rejects.toThrow('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT');
  });

  test('the allowed middles: full extension on a missed punch, furthest point on a defence, contact on a defence', async () => {
    const missed = await newSet();
    const missId = await punch(missed, { contactMs: undefined, contactResult: 'no_contact' });
    await insertMoment(missed, missId, { slot: 'middle', kind: 'full_extension', observationMs: EV_START + 150 });

    const slipped = await newSet();
    await insertMoment(slipped, await defense(slipped), {
      slot: 'middle', kind: 'furthest_point', observationMs: EV_START + 200,
    });

    const blocked = await newSet();
    await insertMoment(blocked, await defense(blocked, { defenseType: 'block', contactMs: EV_CONTACT }), {
      slot: 'middle', kind: 'contact', observationMs: EV_CONTACT,
    });

    expect(await countFor('calibration_body_moments', missed.setId)).toBe(1);
    expect(await countFor('calibration_body_moments', slipped.setId)).toBe(1);
    expect(await countFor('calibration_body_moments', blocked.setId)).toBe(1);
  });
});

describe('points are on the person whose action the event is', () => {
  // Jason, 2026-10-03: the other boxer is marked on their own event, never
  // inside the puncher's. The table has no column that could name anyone else.
  test('a moment has no column for another person', async () => {
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'calibration_body_moments'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names.filter((name) => /opponent|subject|person|track/.test(name))).toEqual([]);
  });
});

describe('nothing crosses set, clip, event or organization', () => {
  test('a moment naming an event from another set is refused', async () => {
    const mine = await newSet();
    const theirs = await newSet();
    const theirEvent = await punch(theirs);
    await expect(insertMoment(mine, theirEvent)).rejects.toThrow('pilot_calibration_body_moments_event_fk');
  });

  test('a moment naming a clip its set is not about is refused', async () => {
    const set = await newSet();
    const otherClip = await newClip();
    await expect(insertMoment(set, await punch(set), { clipId: otherClip })).rejects.toThrow(
      'pilot_calibration_body_moments_set_fk',
    );
  });

  test('a moment filed under another organization is refused', async () => {
    const set = await newSet();
    await expect(insertMoment(set, await punch(set), { organizationId: OTHER_ORG_ID })).rejects.toThrow(
      /pilot_calibration_body_moments_(event|set)_fk|CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION/,
    );
  });

  test('a point naming a moment in another set is refused', async () => {
    const mine = await newSet();
    const theirs = await newSet();
    const theirMoment = await insertMoment(theirs, await punch(theirs));
    await expect(insertPoint(mine.setId, theirMoment, 'nose', 'not_visible', null, null)).rejects.toThrow(
      'pilot_calibration_body_points_moment_fk',
    );
  });
});

describe('one of each', () => {
  test('a second moment in the same slot for the same person is refused', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await insertMoment(set, eventId);
    await expect(insertMoment(set, eventId)).rejects.toThrow('pilot_calibration_body_moments_one_per_slot');
  });

  test('a second point with the same code on a moment is refused', async () => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    await insertPoint(set.setId, momentId, 'nose', 'placed', 0.5, 0.5);
    await expect(insertPoint(set.setId, momentId, 'nose', 'not_visible', null, null)).rejects.toThrow(
      'pilot_calibration_body_points_one_per_moment',
    );
  });
});

describe('a row cannot be moved by update', () => {
  test('a moment keeps its slot and event; its labels and a free middle time can change', async () => {
    const set = await newSet();
    const missId = await punch(set, { contactMs: undefined, contactResult: 'no_contact' });
    const momentId = await insertMoment(set, missId, {
      slot: 'middle', kind: 'full_extension', observationMs: EV_START + 100,
    });

    const otherEvent = await punch(set);
    for (const [column, value] of [['moment_slot', 'end'], ['event_id', otherEvent]] as const) {
      await expect(
        db.query(
          `update pilot.calibration_body_moments set ${column} = $3
            where organization_id = $1 and body_moment_id = $2`,
          [ORG_ID, momentId, value],
        ),
      ).rejects.toThrow('CALIBRATION_BODY_MOMENT_IDENTITY_FIXED');
    }

    await db.query(
      `update pilot.calibration_body_moments
          set lead_side = 'neutral', guard_type = 'other', observation_ms = $3
        where organization_id = $1 and body_moment_id = $2`,
      [ORG_ID, momentId, EV_START + 200],
    );
  });

  test('a point keeps its code and moment; its position can change', async () => {
    const set = await newSet();
    const momentId = await insertMoment(set, await punch(set));
    const pointId = await insertPoint(set.setId, momentId, 'nose', 'placed', 0.5, 0.5);

    await expect(
      db.query(
        `update pilot.calibration_body_points set point_code = 'chin'
          where organization_id = $1 and body_point_id = $2`,
        [ORG_ID, pointId],
      ),
    ).rejects.toThrow('CALIBRATION_BODY_POINT_IDENTITY_FIXED');

    await db.query(
      `update pilot.calibration_body_points set state = 'not_visible', x_norm = null, y_norm = null
        where organization_id = $1 and body_point_id = $2`,
      [ORG_ID, pointId],
    );
  });
});

describe('what a moment was checked against cannot change under it', () => {
  test.each([
    ['moved', 'contact_ms = contact_ms + 1'],
    ['cleared', 'contact_ms = null'],
  ])('the event\'s contact time cannot be %s while it has moments', async (_label, assignment) => {
    const set = await newSet();
    const eventId = await punch(set);
    await insertMoment(set, eventId);
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set ${assignment}
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_HAS_BODY_MOMENTS');
  });

  test('the event\'s class cannot change while it has moments', async () => {
    const set = await newSet();
    const eventId = await defense(set);
    await insertMoment(set, eventId);
    // Reaching the guard needs a row the class-shape CHECK would also accept,
    // so the update swaps every class-specific field at once.
    await expect(
      db.query(
        `update pilot.calibration_annotation_events
            set event_class = 'punch', defense_type = null, punch_type = 'lead_straight',
                physical_hand = 'left', hand_role = 'lead', target_zone = 'head',
                contact_result = 'no_contact'
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_HAS_BODY_MOMENTS');
  });

  test('the event\'s actor cannot change while it has moments', async () => {
    // The actor is whose body the points are on; changing it would move every
    // point onto someone else.
    const set = await newSet();
    const eventId = await punch(set);
    await insertMoment(set, eventId);
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set actor_track = 'blue'
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_HAS_BODY_MOMENTS');
  });

  test('the event\'s start cannot move while it has moments', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await insertMoment(set, eventId);
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set start_ms = start_ms - 1
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId],
      ),
    ).rejects.toThrow('pilot_calibration_body_moments_event_fk');
  });

  test('an event with no moments can still be changed, and other fields of one with moments', async () => {
    const bare = await newSet();
    const bareEvent = await punch(bare);
    await db.query(
      `update pilot.calibration_annotation_events set contact_ms = contact_ms + 1
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, bareEvent],
    );

    const marked = await newSet();
    const markedEvent = await punch(marked);
    await insertMoment(marked, markedEvent);
    await db.query(
      `update pilot.calibration_annotation_events set certainty = 'probable', opponent_track = null
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, markedEvent],
    );
  });
});

describe('the freeze', () => {
  // Two moments: one holding a point, and an empty one, so the moments' own
  // freeze is tested on a delete the points' freeze cannot catch for it.
  async function submittedSetWithOnePoint(): Promise<{
    set: SetRef; eventId: string; momentId: string; emptyMomentId: string; pointId: string;
  }> {
    const set = await newSet();
    const eventId = await punch(set);
    const momentId = await insertMoment(set, eventId);
    const emptyMomentId = await insertMoment(set, eventId, { slot: 'end' });
    const pointId = await insertPoint(set.setId, momentId, 'nose', 'placed', 0.5, 0.5);
    const submitted = await annotations.submitAnnotationSet(ORG_ID, set.setId);
    expect(submitted?.status).toBe('submitted');
    return { set, eventId, momentId, emptyMomentId, pointId };
  }

  test.each([
    ['insert a moment', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      insertMoment(f.set, f.eventId, { slot: 'middle' })],
    ['update a moment', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      db.query(`update pilot.calibration_body_moments set lead_side = 'southpaw'
                 where organization_id = $1 and body_moment_id = $2`, [ORG_ID, f.momentId])],
    ['delete a moment', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      db.query(`delete from pilot.calibration_body_moments
                 where organization_id = $1 and body_moment_id = $2`, [ORG_ID, f.emptyMomentId])],
    ['insert a point', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      insertPoint(f.set.setId, f.momentId, 'chin', 'not_visible', null, null)],
    ['update a point', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      db.query(`update pilot.calibration_body_points set x_norm = 0.6
                 where organization_id = $1 and body_point_id = $2`, [ORG_ID, f.pointId])],
    ['delete a point', async (f: Awaited<ReturnType<typeof submittedSetWithOnePoint>>) =>
      db.query(`delete from pilot.calibration_body_points
                 where organization_id = $1 and body_point_id = $2`, [ORG_ID, f.pointId])],
  ])('a submitted set refuses: %s', async (_label, act) => {
    const fixture = await submittedSetWithOnePoint();
    await expect(act(fixture)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
    expect(await countFor('calibration_body_points', fixture.set.setId)).toBe(1);
    expect(await countFor('calibration_body_moments', fixture.set.setId)).toBe(2);
  });

  test('deleting the footage removes a submitted set\'s body points', async () => {
    const videoId = `vs-body-doomed-${crypto.randomUUID().slice(0, 8)}`;
    await seedVideo(db, videoId);
    const set = await newSet('boxing-ontology-0.2', videoId);
    const momentId = await insertMoment(set, await punch(set));
    await insertPoint(set.setId, momentId, 'nose', 'placed', 0.5, 0.5);
    await annotations.submitAnnotationSet(ORG_ID, set.setId);

    await db.query('delete from pilot.video_sessions where video_session_id = $1', [videoId]);

    expect(await countFor('calibration_body_moments', set.setId)).toBe(0);
    expect(await countFor('calibration_body_points', set.setId)).toBe(0);
  });

  test.each([
    ['the clip', 'delete from pilot.calibration_clips where organization_id = $1 and calibration_clip_id = $2', 'clipId'],
    ['the set', 'delete from pilot.calibration_annotation_sets where organization_id = $1 and annotation_set_id = $2', 'setId'],
  ] as const)('deleting %s removes a submitted set\'s body points', async (_label, statement, key) => {
    const fixture = await submittedSetWithOnePoint();
    await db.query(statement, [ORG_ID, fixture.set[key]]);
    expect(await countFor('calibration_body_moments', fixture.set.setId)).toBe(0);
    expect(await countFor('calibration_body_points', fixture.set.setId)).toBe(0);
  });

  test('deleting an in-progress event removes its moments and points', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const momentId = await insertMoment(set, eventId);
    await insertPoint(set.setId, momentId, 'nose', 'placed', 0.5, 0.5);

    await annotations.deleteAnnotationEvent(ORG_ID, set.setId, eventId);

    expect(await countFor('calibration_body_moments', set.setId)).toBe(0);
    expect(await countFor('calibration_body_points', set.setId)).toBe(0);
  });
});

describe('two writers at once', () => {
  // A moment insert holds the set and event rows FOR SHARE until it commits.
  // A change that would invalidate it must wait, not slip past unseen.
  async function racingUpdate(sql: string, params: unknown[]): Promise<void> {
    const other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await other.connect();
    try {
      await other.query("set lock_timeout = '2s'");
      await other.query(sql, params);
    } finally {
      await other.end();
    }
  }

  test.each([
    [
      'the set\'s vocabulary',
      `update pilot.calibration_annotation_sets set ontology_version = 'boxing-ontology-0.1'
        where organization_id = $1 and annotation_set_id = $2`,
      'set',
    ],
    [
      'the set\'s submission',
      `update pilot.calibration_annotation_sets set status = 'submitted', submitted_at = now()
        where organization_id = $1 and annotation_set_id = $2`,
      'set',
    ],
    [
      'the event\'s contact time',
      `update pilot.calibration_annotation_events set contact_ms = null, contact_result = 'no_contact'
        where organization_id = $1 and event_id = $2`,
      'event',
    ],
  ] as const)('%s waits for an uncommitted moment insert', async (_label, sql, target) => {
    const set = await newSet();
    const eventId = await punch(set);
    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    try {
      await writer.query('begin');
      await writer.query(
        `insert into pilot.calibration_body_moments
           (organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
            event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms)
         values ($1, $2, $3, $4, $5, $6, $7, 'middle', 'contact', $8)`,
        [ORG_ID, crypto.randomUUID(), set.setId, set.clipId, eventId, EV_START, EV_END, EV_CONTACT],
      );
      await expect(
        racingUpdate(sql, [ORG_ID, target === 'set' ? set.setId : eventId]),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end();
    }
  });
});

describe('deleting a whole organization', () => {
  test('removes a submitted set\'s body points; the freeze does not block it', async () => {
    const orgId = `org-body-doomed-${crypto.randomUUID().slice(0, 8)}`;
    // pilot.accounts does not cascade from pilot.organizations (base schema),
    // so an organization with its own logins cannot be deleted at all. The
    // study's rows here name this suite's annotator instead, which leaves the
    // body-point freeze as the only thing that could block the deletion.
    const accountId = ANNOTATOR;
    const videoId = `vs-${orgId}`;
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [orgId],
    );
    const take = await seedCaptureTake(db, { organizationId: orgId, createdByAccountId: accountId });
    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status,
          recording_session_id, capture_take_id)
       values ($1, $2, $3, null, 'Doomed', $4, 'd.mp4', 10, 'video/mp4', 'ready', $5, $6)`,
      [videoId, orgId, accountId, `p/${videoId}.mp4`, take.recordingSessionId, take.captureTakeId],
    );
    const projectId = crypto.randomUUID();
    await projects.createCalibrationProject({
      organizationId: orgId,
      calibrationProjectId: projectId,
      name: 'Doomed study',
      ontologyVersion: ontology.PROJECT_CREATION_ONTOLOGY_VERSION,
      createdByAccountId: accountId,
    });
    const clipId = crypto.randomUUID();
    await projects.createCalibrationClip({
      organizationId: orgId,
      calibrationClipId: clipId,
      calibrationProjectId: projectId,
      videoSessionId: videoId,
      clipCode: 'C-DOOMED-ORG',
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      primarySamplingReason: 'isolated_punch',
      createdByAccountId: accountId,
    });
    const setId = crypto.randomUUID();
    await annotations.openAnnotationSet({
      organizationId: orgId,
      annotationSetId: setId,
      calibrationClipId: clipId,
      annotatorAccountId: accountId,
      ontologyVersion: 'boxing-ontology-0.2',
    });
    const event = await annotations.recordAnnotationEvent({
      organizationId: orgId,
      eventId: crypto.randomUUID(),
      annotationSetId: setId,
      eventClass: 'punch',
      actorTrack: 'red',
      startMs: EV_START,
      endMs: EV_END,
      contactMs: EV_CONTACT,
      physicalHand: 'left',
      handRole: 'lead',
      punchType: 'lead_straight',
      targetZone: 'head',
      contactResult: 'clean_target_contact',
      visibility: 'clear',
      certainty: 'clear',
    });
    const momentId = crypto.randomUUID();
    await db.query(
      `insert into pilot.calibration_body_moments
         (organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
          event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms)
       values ($1, $2, $3, $4, $5, $6, $7, 'start', 'start', $6)`,
      [orgId, momentId, setId, clipId, event.event_id, EV_START, EV_END],
    );
    await db.query(
      `insert into pilot.calibration_body_points
         (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
       values ($1, $2, $3, $4, 'nose', 'placed', 0.5, 0.5)`,
      [orgId, crypto.randomUUID(), setId, momentId],
    );
    expect((await annotations.submitAnnotationSet(orgId, setId))?.status).toBe('submitted');

    await db.query('delete from pilot.organizations where organization_id = $1', [orgId]);

    const left = await db.query<{ n: string }>(
      `select ((select count(*) from pilot.calibration_body_moments where organization_id = $1)
             + (select count(*) from pilot.calibration_body_points where organization_id = $1))::text as n`,
      [orgId],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});
