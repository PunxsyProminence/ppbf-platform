// Real PostgreSQL-backed test for the body-points server module
// (TEACH-BIOMECH-01-d, src/server/pilot/calibration/bodyPoints.ts).
//
// The two body-point migrations are tested on their own
// (calibrationBodyPoints.pg.test.ts, calibrationBodyPointRules.pg.test.ts).
// This suite is about what the module adds on top of them, and that it never
// weakens them:
//
//   * the server derives every moment's time and kind from the event; the
//     client picks a time only for a middle with no contact, inside the event
//   * every vocabulary is refused by name, before the database, and the
//     database refuses the same rows
//   * a point is on the picture or not visible, and the set's own version
//     decides which points exist
//   * a 0.1 set has no body points; a submitted set is frozen; nothing is
//     reachable across an organization, a set, an event or a moment
//   * replacing or deleting an event leaves no points behind on anything
//   * a set reads as itself only, and the missing list the page reads is the
//     list the submission trigger raises
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

import { Client } from 'pg';

import { seedCaptureTake } from '../../testing/captureFixture';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-body-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_body_module';

const PREREQUISITE_SQL = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_calibration_projects_migration.sql',
  'pilot_slice_postgres_calibration_annotations_migration.sql',
  'pilot_slice_postgres_calibration_body_points_migration.sql',
  'pilot_slice_postgres_calibration_body_point_rules_migration.sql',
];

const ORG_ID = 'org-module';
const OTHER_ORG_ID = 'org-module-other';
const ANNOTATOR = 'acct-module-annotator';
const V01 = 'boxing-ontology-0.1';
const V02 = 'boxing-ontology-0.2';
const V04 = 'boxing-ontology-0.4';

const CLIP_START_MS = 60_000;
const CLIP_END_MS = 72_000;
const EV_START = CLIP_START_MS + 1_000;
const EV_END = CLIP_START_MS + 1_400;
const EV_CONTACT = CLIP_START_MS + 1_250;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let annotations: typeof import('./calibration/annotations');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');
let bodyPoints: typeof import('./calibration/bodyPoints');
let db: Client;
const PROJECTS: Record<string, string> = {};
const VIDEOS: Record<string, string> = {};

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

async function freshDatabase(name: string): Promise<Client> {
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

/** An organization with an annotator, teaching footage and a project. */
async function seedOrganization(orgId: string): Promise<void> {
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [orgId],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [`${ANNOTATOR}-${orgId}`, orgId],
  );
  const videoId = `vs-${orgId}`;
  const take = await seedCaptureTake(db, { organizationId: orgId, createdByAccountId: `${ANNOTATOR}-${orgId}` });
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status,
        recording_session_id, capture_take_id)
     values ($1, $2, $3, null, 'Sparring', $4, 'm.mp4', 2048, 'video/mp4', 'ready', $5, $6)
     on conflict do nothing`,
    [videoId, orgId, `${ANNOTATOR}-${orgId}`, `p/${videoId}.mp4`, take.recordingSessionId, take.captureTakeId],
  );
  VIDEOS[orgId] = videoId;
  const projectId = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: orgId,
    calibrationProjectId: projectId,
    name: 'Body points module study',
    ontologyVersion: ontology.PROJECT_CREATION_ONTOLOGY_VERSION,
    createdByAccountId: `${ANNOTATOR}-${orgId}`,
  });
  PROJECTS[orgId] = projectId;
}

interface SetRef {
  orgId: string;
  setId: string;
  clipId: string;
  version: string;
}

/** A fresh clip and an in-progress set on it, under the given vocabulary. */
async function newSet(version: string = V02, orgId: string = ORG_ID, setId: string = crypto.randomUUID()): Promise<SetRef> {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId: orgId,
    calibrationClipId: clipId,
    calibrationProjectId: PROJECTS[orgId],
    videoSessionId: VIDEOS[orgId],
    clipCode: `C-${clipId.slice(0, 8)}`,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: `${ANNOTATOR}-${orgId}`,
  });
  await annotations.openAnnotationSet({
    organizationId: orgId,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId: `${ANNOTATOR}-${orgId}`,
    ontologyVersion: version,
  });
  return { orgId, setId, clipId, version };
}

/** A landed punch at EV_CONTACT, through the annotations module. */
async function punch(set: SetRef, overrides: Record<string, unknown> = {}): Promise<string> {
  const event = await annotations.recordAnnotationEvent({
    organizationId: set.orgId,
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

const MISSED = { contactMs: null, contactResult: 'no_contact' };

async function defense(set: SetRef, overrides: Record<string, unknown> = {}): Promise<string> {
  const event = await annotations.recordAnnotationEvent({
    organizationId: set.orgId,
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

type MomentSlot = 'start' | 'middle' | 'end';

async function open(
  set: SetRef,
  eventId: string,
  momentSlot: MomentSlot,
  extra: Partial<import('./calibration/bodyPoints').OpenBodyMomentInput> = {},
) {
  return bodyPoints.openBodyMoment({
    organizationId: set.orgId,
    annotationSetId: set.setId,
    eventId,
    momentSlot,
    leadSide: 'orthodox',
    guardType: 'usa_boxing__high_double_guard',
    ...extra,
  });
}

function placed(pointCode: string, x = 0.5, y = 0.5) {
  return { pointCode, state: 'placed', xNorm: x, yNorm: y } as import('./calibration/bodyPoints').BodyPointMark;
}

function notVisible(pointCode: string) {
  return { pointCode, state: 'not_visible' } as import('./calibration/bodyPoints').BodyPointMark;
}

/** Every point of the set's version, placed, at one moment. */
async function markAll(set: SetRef, bodyMomentId: string) {
  const list = ontology.BODY_POINTS_BY_VERSION[set.version as keyof typeof ontology.BODY_POINTS_BY_VERSION];
  return bodyPoints.markBodyPoints({
    organizationId: set.orgId,
    annotationSetId: set.setId,
    bodyMomentId,
    points: list.map((code) => placed(code)),
  });
}

/** Everything submission requires on one event, through the module. */
async function completeEvent(set: SetRef, eventId: string, middleMs?: number): Promise<Record<MomentSlot, string>> {
  await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__classic' });
  const ids = {} as Record<MomentSlot, string>;
  for (const slot of ['start', 'middle', 'end'] as const) {
    const moment = await open(set, eventId, slot, slot === 'middle' && middleMs !== undefined ? { observationMs: middleMs } : {});
    ids[slot] = moment.body_moment_id;
    await markAll(set, moment.body_moment_id);
  }
  return ids;
}

async function countFor(table: string, set: SetRef): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from pilot.${table} where organization_id = $1 and annotation_set_id = $2`,
    [set.orgId, set.setId],
  );
  return Number(result.rows[0].n);
}

async function statusOf(set: SetRef): Promise<string> {
  const result = await db.query<{ status: string }>(
    'select status from pilot.calibration_annotation_sets where organization_id = $1 and annotation_set_id = $2',
    [set.orgId, set.setId],
  );
  return result.rows[0].status;
}

/** A direct row write, so only the database judges it. */
async function insertMomentDirect(set: SetRef, eventId: string, fields: Record<string, unknown> = {}): Promise<void> {
  const row = {
    organization_id: set.orgId,
    body_moment_id: crypto.randomUUID(),
    annotation_set_id: set.setId,
    calibration_clip_id: set.clipId,
    event_id: eventId,
    event_start_ms: EV_START,
    event_end_ms: EV_END,
    moment_slot: 'start',
    moment_kind: 'start',
    observation_ms: EV_START,
    ...fields,
  };
  const columns = Object.keys(row);
  await db.query(
    `insert into pilot.calibration_body_moments (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
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

  db = await freshDatabase(TEST_DB_NAME);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');
  bodyPoints = await import('./calibration/bodyPoints');

  await seedOrganization(ORG_ID);
  await seedOrganization(OTHER_ORG_ID);
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

describe('the server says when a moment is', () => {
  test('a landed punch: start and end on the event\'s edges, middle on its contact time, nothing sent by the client', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const start = await open(set, eventId, 'start');
    const middle = await open(set, eventId, 'middle');
    const end = await open(set, eventId, 'end');
    expect([start.moment_kind, start.observation_ms]).toEqual(['start', EV_START]);
    expect([middle.moment_kind, middle.observation_ms]).toEqual(['contact', EV_CONTACT]);
    expect([end.moment_kind, end.observation_ms]).toEqual(['end', EV_END]);
    expect([start.event_start_ms, start.event_end_ms, start.calibration_clip_id]).toEqual([EV_START, EV_END, set.clipId]);
  });

  test('a missed punch takes the coach\'s full-extension time; a defence its furthest point; a defence with contact its contact', async () => {
    const set = await newSet();
    const missed = await open(set, await punch(set, MISSED), 'middle', { observationMs: EV_START + 300 });
    expect([missed.moment_kind, missed.observation_ms]).toEqual(['full_extension', EV_START + 300]);

    const slip = await open(set, await defense(set), 'middle', { observationMs: EV_START + 200 });
    expect([slip.moment_kind, slip.observation_ms]).toEqual(['furthest_point', EV_START + 200]);

    const block = await open(set, await defense(set, { defenseType: 'block', contactMs: EV_CONTACT }), 'middle');
    expect([block.moment_kind, block.observation_ms]).toEqual(['contact', EV_CONTACT]);
  });

  test('a time sent for a derived moment is refused, and nothing is written', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await expect(open(set, eventId, 'start', { observationMs: EV_START })).rejects.toThrow('Missing observation_ms');
    await expect(open(set, eventId, 'middle', { observationMs: EV_CONTACT })).rejects.toThrow('do not send a time');
    expect(await countFor('calibration_body_moments', set)).toBe(0);
  });

  test('a free middle needs a time inside the event; the database holds the same line', async () => {
    const set = await newSet();
    const eventId = await punch(set, MISSED);
    await expect(open(set, eventId, 'middle')).rejects.toThrow('full extension');
    await expect(open(set, eventId, 'middle', { observationMs: EV_END + 1 })).rejects.toThrow('within the event');
    await expect(
      insertMomentDirect(set, eventId, { moment_slot: 'middle', moment_kind: 'full_extension', observation_ms: EV_END + 1 }),
    ).rejects.toThrow('pilot_calibration_body_moments_within_event');
  });

  test('an occupied slot is a 409, not an overwrite', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const first = await open(set, eventId, 'start', { leadSide: 'southpaw' });
    await expect(open(set, eventId, 'start', { leadSide: 'orthodox' })).rejects.toMatchObject({ status: 409 });
    const data = await bodyPoints.listBodyDataForSet(set.orgId, set.setId);
    expect(data.moments.map((m) => [m.body_moment_id, m.lead_side])).toEqual([[first.body_moment_id, 'southpaw']]);
  });

  test('an event from another set, or none, is not found', async () => {
    const mine = await newSet();
    const theirs = await newSet();
    const theirEvent = await punch(theirs);
    await expect(open(mine, theirEvent, 'start')).rejects.toThrow('Not found: no such event');
    await expect(open(mine, 'no-such-event', 'start')).rejects.toThrow('Not found: no such event');
    expect(await countFor('calibration_body_moments', theirs)).toBe(0);
  });
});

describe('what the coach records at a moment', () => {
  test('lead side and guard come from their lists or wait as null; the database holds the same lists', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await expect(open(set, eventId, 'start', { leadSide: 'switching' as never })).rejects.toThrow('Missing lead_side');
    await expect(open(set, eventId, 'start', { guardType: 'high_guard' as never })).rejects.toThrow('Missing guard_type');
    await expect(insertMomentDirect(set, eventId, { lead_side: 'switching' })).rejects.toThrow('pilot_calibration_body_moments_lead_side_vocab');
    await expect(insertMomentDirect(set, eventId, { guard_type: 'high_guard' })).rejects.toThrow('pilot_calibration_body_moments_guard_vocab');
    await expect(db.query(
      `insert into pilot.calibration_event_stance_labels (organization_id, annotation_set_id, event_id, stance_type)
       values ($1, $2, $3, 'usa_boxing__basic_stance')`,
      [set.orgId, set.setId, eventId],
    )).rejects.toThrow('pilot_calibration_event_stance_labels_stance_type_vocab');
    const waiting = await open(set, eventId, 'start', { leadSide: null, guardType: null });
    expect([waiting.lead_side, waiting.guard_type]).toEqual([null, null]);
  });

  test('the picture size needs both sides, positive', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await expect(open(set, eventId, 'start', { sourceFrameWidthPx: 1920 })).rejects.toThrow('both sides, or neither');
    await expect(open(set, eventId, 'start', { sourceFrameWidthPx: 0, sourceFrameHeightPx: 1080 })).rejects.toThrow('Missing source_frame_width_px');
    await expect(open(set, eventId, 'start', { sourceFrameWidthPx: 3_000_000_000, sourceFrameHeightPx: 1080 })).rejects.toThrow('Missing source_frame_width_px');
    const sized = await open(set, eventId, 'start', { sourceFrameWidthPx: 1920, sourceFrameHeightPx: 1080 });
    expect([sized.source_frame_width_px, sized.source_frame_height_px]).toEqual([1920, 1080]);
  });

  test('update changes labels, size and a free middle\'s time; never a derived time, never another set\'s moment', async () => {
    const set = await newSet();
    const missed = await open(set, await punch(set, MISSED), 'middle', { observationMs: EV_START + 100 });
    const changed = await bodyPoints.updateBodyMoment({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: missed.body_moment_id,
      observationMs: EV_START + 350, leadSide: 'neutral', guardType: null, sourceFrameWidthPx: 1280, sourceFrameHeightPx: 720,
    });
    expect([changed.observation_ms, changed.lead_side, changed.guard_type, changed.source_frame_width_px]).toEqual([EV_START + 350, 'neutral', null, 1280]);

    const untouched = await bodyPoints.updateBodyMoment({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: missed.body_moment_id, guardType: 'aiba__high_guard',
    });
    expect([untouched.observation_ms, untouched.lead_side, untouched.guard_type]).toEqual([EV_START + 350, 'neutral', 'aiba__high_guard']);

    const start = await open(set, await punch(set), 'start');
    await expect(bodyPoints.updateBodyMoment({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: start.body_moment_id, observationMs: EV_START + 1,
    })).rejects.toThrow('do not send a time');

    const other = await newSet();
    await expect(bodyPoints.updateBodyMoment({
      organizationId: other.orgId, annotationSetId: other.setId, bodyMomentId: start.body_moment_id, leadSide: 'southpaw',
    })).rejects.toThrow('Not found: no such body moment');
  });

  test('deleting a moment takes its points with it; another set\'s moment is not found', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await markAll(set, moment.body_moment_id);
    expect(await countFor('calibration_body_points', set)).toBe(24);

    const other = await newSet();
    expect(await bodyPoints.deleteBodyMoment(other.orgId, other.setId, moment.body_moment_id)).toBe(false);
    expect(await countFor('calibration_body_points', set)).toBe(24);

    expect(await bodyPoints.deleteBodyMoment(set.orgId, set.setId, moment.body_moment_id)).toBe(true);
    expect(await countFor('calibration_body_moments', set)).toBe(0);
    expect(await countFor('calibration_body_points', set)).toBe(0);
  });
});

describe('a point is on the picture or not visible', () => {
  test('placed points keep their fractions, not-visible ones none, and a re-mark writes over the earlier one', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    const first = await bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('left_glove', 0.25, 0.75), notVisible('chin'), placed('nose', 0, 1)],
    });
    expect(first.map((p) => [p.point_code, p.state, p.x_norm, p.y_norm])).toEqual([
      ['nose', 'placed', 0, 1],
      ['chin', 'not_visible', null, null],
      ['left_glove', 'placed', 0.25, 0.75],
    ]);

    const again = await bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('chin', 0.4, 0.6)],
    });
    const chin = again.find((p) => p.point_code === 'chin');
    expect([chin?.state, chin?.x_norm, chin?.y_norm]).toEqual(['placed', 0.4, 0.6]);
    expect(chin?.body_point_id).toBe(first.find((p) => p.point_code === 'chin')?.body_point_id);
    expect(again).toHaveLength(3);
    expect(await countFor('calibration_body_points', set)).toBe(3);
  });

  test.each([
    ['x above 1', placed('nose', 1.0001, 0.5), 'Missing x_norm'],
    ['y below 0', placed('nose', 0.5, -0.0001), 'Missing y_norm'],
    ['x not a number', { pointCode: 'nose', state: 'placed', xNorm: Number.NaN, yNorm: 0.5 }, 'Missing x_norm'],
    ['y missing', { pointCode: 'nose', state: 'placed', xNorm: 0.5 }, 'Missing y_norm'],
    ['not visible with a position', { pointCode: 'nose', state: 'not_visible', xNorm: 0.5, yNorm: 0.5 }, 'has no position'],
    ['a third state', { pointCode: 'nose', state: 'occluded' }, 'Missing state'],
    ['an entry that is not an object', null, 'Missing points'],
  ] as Array<[string, import('./calibration/bodyPoints').BodyPointMark, string]>)('%s is refused, and the batch writes nothing', async (_label, bad, message) => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('chin'), bad],
    })).rejects.toThrow(message);
    expect(await countFor('calibration_body_points', set)).toBe(0);
  });

  test('the database refuses the same positions', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await expect(db.query(
      `insert into pilot.calibration_body_points
         (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
       values ($1, $2, $3, $4, 'nose', 'placed', 1.0001, 0.5)`,
      [set.orgId, crypto.randomUUID(), set.setId, moment.body_moment_id],
    )).rejects.toThrow('pilot_calibration_body_points_position');
  });

  test('an empty batch, or a point sent twice, is refused', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id, points: [],
    })).rejects.toThrow('Missing points');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('nose'), placed('nose', 0.1, 0.1)],
    })).rejects.toThrow('sent twice');
  });

  test('one point can be removed to be marked afresh', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await markAll(set, moment.body_moment_id);
    expect(await bodyPoints.deleteBodyPoint(set.orgId, set.setId, moment.body_moment_id, 'left_knee')).toBe(true);
    expect(await bodyPoints.deleteBodyPoint(set.orgId, set.setId, moment.body_moment_id, 'left_knee')).toBe(false);
    expect(await countFor('calibration_body_points', set)).toBe(23);
  });
});

describe('the set\'s own version decides which points exist', () => {
  test('a 0.2 set refuses solar_plexus by name; the database refuses it too', async () => {
    const set = await newSet(V02);
    const moment = await open(set, await punch(set), 'start');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('solar_plexus')],
    })).rejects.toThrow(`Missing point_code: not a point in ${V02}`);
    await expect(db.query(
      `insert into pilot.calibration_body_points
         (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
       values ($1, $2, $3, $4, 'solar_plexus', 'placed', 0.5, 0.5)`,
      [set.orgId, crypto.randomUUID(), set.setId, moment.body_moment_id],
    )).rejects.toThrow('CALIBRATION_BODY_POINT_NOT_IN_THIS_VERSION');
  });

  test('a 0.4 set refuses an ankle and takes solar_plexus; all 23 land in marking order', async () => {
    const set = await newSet(V04);
    const moment = await open(set, await punch(set), 'start');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('left_ankle')],
    })).rejects.toThrow(`Missing point_code: not a point in ${V04}`);
    const all = await markAll(set, moment.body_moment_id);
    expect(all.map((p) => p.point_code)).toEqual([...ontology.BODY_POINTS_0_4]);
  });

  test('a code no version knows is refused', async () => {
    const set = await newSet();
    const moment = await open(set, await punch(set), 'start');
    await expect(bodyPoints.markBodyPoints({
      organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: moment.body_moment_id,
      points: [placed('left_eye')],
    })).rejects.toThrow('Missing point_code');
  });
});

describe('the stance type, once per event', () => {
  test('set, change, clear; outside the list refused; another set\'s event not found', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const first = await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__classic' });
    expect(first.stance_type).toBe('usa_boxing__classic');
    const second = await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'aiba__crouching_stance' });
    expect(second.stance_type).toBe('aiba__crouching_stance');
    expect(await countFor('calibration_event_stance_labels', set)).toBe(1);

    await expect(bodyPoints.setEventStanceType({
      organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__basic_stance' as never,
    })).rejects.toThrow('Missing stance_type');

    const other = await newSet();
    await expect(bodyPoints.setEventStanceType({
      organizationId: other.orgId, annotationSetId: other.setId, eventId, stanceType: 'usa_boxing__classic',
    })).rejects.toThrow('Not found: no such event');
    expect(await bodyPoints.clearEventStanceType(other.orgId, other.setId, eventId)).toBe(false);

    expect(await bodyPoints.clearEventStanceType(set.orgId, set.setId, eventId)).toBe(true);
    expect(await countFor('calibration_event_stance_labels', set)).toBe(0);
  });
});

describe('the gates', () => {
  test('a 0.1 set has no body points: every write is refused as Forbidden, and the database agrees', async () => {
    const set = await newSet(V01);
    const eventId = await punch(set, { stance: 'orthodox' });
    const refusal = { name: 'BodyPointsNotInThisVersionError', message: expect.stringMatching(/^Forbidden: .*boxing-ontology-0\.1/) };
    await expect(open(set, eventId, 'start')).rejects.toMatchObject(refusal);
    await expect(bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__classic' })).rejects.toMatchObject(refusal);
    await expect(bodyPoints.markBodyPoints({ organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: 'x', points: [placed('nose')] })).rejects.toMatchObject(refusal);
    await expect(insertMomentDirect(set, eventId)).rejects.toThrow('CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION');
    const data = await bodyPoints.listBodyDataForSet(set.orgId, set.setId);
    expect([data.expected_points, data.moments, data.stance_labels]).toEqual([null, [], []]);
    expect(await bodyPoints.listMissingBodyData(set.orgId, set.setId)).toEqual([]);
  });

  test('a submitted set refuses every write and still reads; the database refuses a direct write too', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const ids = await completeEvent(set, eventId);
    expect(await annotations.submitAnnotationSet(set.orgId, set.setId)).not.toBeNull();

    const submitted = { name: 'AnnotationSetSubmittedError' };
    const base = { organizationId: set.orgId, annotationSetId: set.setId };
    await expect(open(set, eventId, 'start')).rejects.toMatchObject(submitted);
    await expect(bodyPoints.updateBodyMoment({ ...base, bodyMomentId: ids.start, leadSide: 'southpaw' })).rejects.toMatchObject(submitted);
    await expect(bodyPoints.deleteBodyMoment(set.orgId, set.setId, ids.start)).rejects.toMatchObject(submitted);
    await expect(bodyPoints.markBodyPoints({ ...base, bodyMomentId: ids.start, points: [placed('nose', 0.1, 0.1)] })).rejects.toMatchObject(submitted);
    await expect(bodyPoints.deleteBodyPoint(set.orgId, set.setId, ids.start, 'nose')).rejects.toMatchObject(submitted);
    await expect(bodyPoints.setEventStanceType({ ...base, eventId, stanceType: 'aiba__classic' })).rejects.toMatchObject(submitted);
    await expect(bodyPoints.clearEventStanceType(set.orgId, set.setId, eventId)).rejects.toMatchObject(submitted);
    await expect(db.query(
      `update pilot.calibration_body_points set x_norm = 0.1 where organization_id = $1 and annotation_set_id = $2 and point_code = 'nose'`,
      [set.orgId, set.setId],
    )).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');

    const data = await bodyPoints.listBodyDataForSet(set.orgId, set.setId);
    expect(data.moments).toHaveLength(3);
    expect(data.moments.every((m) => m.points.length === 24)).toBe(true);
    expect(data.stance_labels.map((s) => s.stance_type)).toEqual(['usa_boxing__classic']);
    expect(await bodyPoints.listMissingBodyData(set.orgId, set.setId)).toEqual([]);
  });

  test('nothing is reachable across an organization, even when the other organization has a set with the same id', async () => {
    const set = await newSet();
    // The same set id exists in the other organization, so a lookup that
    // forgot the organization would find a set, and only the statements
    // under it decide what is reached.
    const twin = await newSet(V02, OTHER_ORG_ID, set.setId);
    expect(twin.setId).toBe(set.setId);
    const eventId = await punch(set);
    const moment = await open(set, eventId, 'start');
    await markAll(set, moment.body_moment_id);
    await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__classic' });
    // Exact messages, on purpose: a lookup that forgot the organization would
    // find ORG's event or moment through the twin's set id, write under the
    // other organization, and fail on a foreign key -- which translates to a
    // different "Not found" (the parent-gone one). Only the lookup's own
    // refusal is accepted here.
    const noSuchEvent = 'Not found: no such event in this annotation set';
    const noSuchMoment = 'Not found: no such body moment in this annotation set';
    const notFound = /^Not found/;
    const foreign = { organizationId: OTHER_ORG_ID, annotationSetId: set.setId };
    await expect(bodyPoints.openBodyMoment({ ...foreign, eventId, momentSlot: 'end' })).rejects.toThrow(noSuchEvent);
    await expect(bodyPoints.updateBodyMoment({ ...foreign, bodyMomentId: moment.body_moment_id, leadSide: 'southpaw' })).rejects.toThrow(noSuchMoment);
    // The twin set exists, so a delete finds nothing to remove (false) rather
    // than refusing the set; what matters is that nothing of ORG's is touched.
    expect(await bodyPoints.deleteBodyMoment(OTHER_ORG_ID, set.setId, moment.body_moment_id)).toBe(false);
    await expect(bodyPoints.markBodyPoints({ ...foreign, bodyMomentId: moment.body_moment_id, points: [placed('nose')] })).rejects.toThrow(noSuchMoment);
    expect(await bodyPoints.deleteBodyPoint(OTHER_ORG_ID, set.setId, moment.body_moment_id, 'nose')).toBe(false);
    await expect(bodyPoints.setEventStanceType({ ...foreign, eventId, stanceType: 'usa_boxing__classic' })).rejects.toThrow(noSuchEvent);
    expect(await bodyPoints.clearEventStanceType(OTHER_ORG_ID, set.setId, eventId)).toBe(false);
    const twinData = await bodyPoints.listBodyDataForSet(OTHER_ORG_ID, set.setId);
    expect([twinData.moments, twinData.stance_labels]).toEqual([[], []]);
    expect(await bodyPoints.listMissingBodyData(OTHER_ORG_ID, set.setId)).toEqual([]);
    await expect(bodyPoints.listBodyDataForSet(OTHER_ORG_ID, crypto.randomUUID())).rejects.toThrow(notFound);
    expect(await countFor('calibration_body_points', set)).toBe(24);
    expect(await countFor('calibration_body_moments', set)).toBe(1);
    expect(await countFor('calibration_event_stance_labels', set)).toBe(1);
    expect(await countFor('calibration_body_moments', twin)).toBe(0);
  });

  test('a moment in another set of the same organization is not found, and its points are untouched', async () => {
    const theirs = await newSet();
    const moment = await open(theirs, await punch(theirs), 'start');
    await markAll(theirs, moment.body_moment_id);
    const mine = await newSet();
    const base = { organizationId: mine.orgId, annotationSetId: mine.setId, bodyMomentId: moment.body_moment_id };
    await expect(bodyPoints.markBodyPoints({ ...base, points: [placed('nose', 0.1, 0.1)] })).rejects.toThrow('Not found: no such body moment');
    await expect(bodyPoints.updateBodyMoment({ ...base, leadSide: 'southpaw' })).rejects.toThrow('Not found: no such body moment');
    expect(await bodyPoints.deleteBodyPoint(mine.orgId, mine.setId, moment.body_moment_id, 'nose')).toBe(false);
    expect(await bodyPoints.deleteBodyMoment(mine.orgId, mine.setId, moment.body_moment_id)).toBe(false);
    const theirData = await bodyPoints.listBodyDataForSet(theirs.orgId, theirs.setId);
    expect(theirData.moments[0].points.find((p) => p.point_code === 'nose')?.x_norm).toBe(0.5);
    expect(theirData.moments[0].lead_side).toBe('orthodox');
    const myData = await bodyPoints.listBodyDataForSet(mine.orgId, mine.setId);
    expect(myData.moments).toEqual([]);
  });
});

describe('replacing or deleting an event leaves no points on the wrong event', () => {
  test('deleting an event removes its moments, points and stance type', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    expect(await countFor('calibration_body_points', set)).toBe(72);
    expect(await annotations.deleteAnnotationEvent(set.orgId, set.setId, eventId)).toBe(true);
    expect(await countFor('calibration_body_moments', set)).toBe(0);
    expect(await countFor('calibration_body_points', set)).toBe(0);
    expect(await countFor('calibration_event_stance_labels', set)).toBe(0);
  });

  test('the events route\'s replace (new row, then delete the old) carries nothing over', async () => {
    const set = await newSet();
    const oldEvent = await punch(set);
    await completeEvent(set, oldEvent);
    const newEvent = await punch(set, { punchType: 'lead_hook' });
    await annotations.deleteAnnotationEvent(set.orgId, set.setId, oldEvent);
    const data = await bodyPoints.listBodyDataForSet(set.orgId, set.setId);
    expect([data.moments, data.stance_labels]).toEqual([[], []]);
    expect(await bodyPoints.listMissingBodyData(set.orgId, set.setId)).toEqual([
      `${newEvent}: end moment`,
      `${newEvent}: middle moment`,
      `${newEvent}: stance type`,
      `${newEvent}: start moment`,
    ]);
  });

  test('the event\'s contact time cannot move under its moments', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await open(set, eventId, 'middle');
    await expect(db.query(
      `update pilot.calibration_annotation_events set contact_ms = $3
        where organization_id = $1 and event_id = $2`,
      [set.orgId, eventId, EV_CONTACT + 10],
    )).rejects.toThrow('CALIBRATION_EVENT_HAS_BODY_MOMENTS');
  });
});

describe('reading one set', () => {
  test('a set reads as itself only, with its version\'s point list', async () => {
    const a = await newSet(V02);
    const b = await newSet(V04);
    const aMoment = await open(a, await punch(a), 'start');
    await markAll(a, aMoment.body_moment_id);
    const bEvent = await defense(b);
    const bMoment = await open(b, bEvent, 'end');
    await bodyPoints.markBodyPoints({ organizationId: b.orgId, annotationSetId: b.setId, bodyMomentId: bMoment.body_moment_id, points: [notVisible('solar_plexus')] });
    await bodyPoints.setEventStanceType({ organizationId: b.orgId, annotationSetId: b.setId, eventId: bEvent, stanceType: 'usiba__on_guard' });

    const aData = await bodyPoints.listBodyDataForSet(a.orgId, a.setId);
    expect(aData.expected_points).toEqual([...ontology.BODY_POINTS_0_2]);
    expect(aData.moments.map((m) => [m.body_moment_id, m.points.length])).toEqual([[aMoment.body_moment_id, 24]]);
    expect(aData.stance_labels).toEqual([]);

    const bData = await bodyPoints.listBodyDataForSet(b.orgId, b.setId);
    expect(bData.expected_points).toEqual([...ontology.BODY_POINTS_0_4]);
    expect(bData.moments.map((m) => [m.body_moment_id, m.points.map((p) => p.point_code)])).toEqual([[bMoment.body_moment_id, ['solar_plexus']]]);
    expect(bData.stance_labels.map((s) => [s.event_id, s.stance_type])).toEqual([[bEvent, 'usiba__on_guard']]);
    await expect(bodyPoints.listBodyDataForSet(a.orgId, 'no-such-set')).rejects.toThrow('Not found');
  });

  test('the missing list is the submission trigger\'s list, item for item', async () => {
    const set = await newSet();
    const landed = await punch(set);
    const missed = await punch(set, MISSED);
    await completeEvent(set, landed);
    await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId: missed, stanceType: 'other' });
    const start = await open(set, missed, 'start', { guardType: null });
    await bodyPoints.markBodyPoints({ organizationId: set.orgId, annotationSetId: set.setId, bodyMomentId: start.body_moment_id, points: [placed('nose'), notVisible('chin')] });
    await open(set, missed, 'end', { leadSide: null });

    let detail: string | undefined;
    await annotations.submitAnnotationSet(set.orgId, set.setId).catch((error: { message: string; detail?: string }) => {
      expect(error.message).toBe('CALIBRATION_BODY_POINTS_INCOMPLETE');
      detail = error.detail;
    });
    expect(await statusOf(set)).toBe('in_progress');
    const missing = await bodyPoints.listMissingBodyData(set.orgId, set.setId);
    expect(missing).toEqual(detail?.split('; '));
    expect(missing).toEqual([
      `${missed}: end lead side`,
      `${missed}: end points, 0 of 24`,
      `${missed}: middle moment`,
      `${missed}: start guard`,
      `${missed}: start points, 2 of 24`,
    ]);
  });

  test('a set completed through the module submits', async () => {
    const set = await newSet(V04);
    await completeEvent(set, await punch(set));
    await completeEvent(set, await defense(set), EV_START + 50);
    expect(await bodyPoints.listMissingBodyData(set.orgId, set.setId)).toEqual([]);
    expect(await annotations.submitAnnotationSet(set.orgId, set.setId)).not.toBeNull();
    expect(await statusOf(set)).toBe('submitted');
    expect(await countFor('calibration_body_points', set)).toBe(23 * 6);
  });
});
