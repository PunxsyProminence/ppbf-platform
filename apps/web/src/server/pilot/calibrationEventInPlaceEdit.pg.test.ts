// Real PostgreSQL-backed test for editing a calibration event IN PLACE
// (updateAnnotationEvent in src/server/pilot/calibration/annotations.ts).
//
// WHY IT EXISTS. The events route's PUT replaces an event: a new row, then the
// old one deleted. The old row's body marks (three moments, up to 25 points at
// each, a stance type) go with it by cascade. A coach who fixed a typo on a
// punch after marking it lost the marks. An edit in place keeps the event's id
// and so keeps them. This suite holds:
//
//   * a field that does not move a moment changes, and the event's id, its
//     moments, their points and its stance type are the same rows afterwards
//   * start, end, contact time, class and actor are refused, by name, while
//     the event holds a moment (the actor also under a stance type alone), and
//     are allowed once the marks are removed
//   * the edited row is held to every rule a new one is: vocabulary, shape,
//     span, the clip, and the set's own version (0.2+: no stance, no peak, a
//     contact time exactly when the result made contact)
//   * a relationship cannot point outside the set, or at the event itself
//   * a submitted set is frozen; nothing is reachable across an organization
//     or from another set
//
// Both body-point migrations are applied. Spins up the same disposable,
// local-only embedded Postgres the other migration suites use. It NEVER
// connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-event-edit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_event_edit';

const PREREQUISITE_SQL = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_calibration_projects_migration.sql',
  'pilot_slice_postgres_calibration_annotations_migration.sql',
  'pilot_slice_postgres_calibration_body_points_migration.sql',
  'pilot_slice_postgres_calibration_body_point_rules_migration.sql',
  'pilot_slice_postgres_calibration_events_freeze_old_parent_migration.sql',
];

const ORG_ID = 'org-edit';
const OTHER_ORG_ID = 'org-edit-other';
const ANNOTATOR = 'acct-edit-annotator';
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
    name: 'In-place edit study',
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

type Changes = Partial<Omit<import('./calibration/annotations').UpdateAnnotationEventInput, 'organizationId' | 'annotationSetId' | 'eventId'>>;

function edit(set: SetRef, eventId: string, changes: Changes) {
  return annotations.updateAnnotationEvent({
    organizationId: set.orgId,
    annotationSetId: set.setId,
    eventId,
    ...changes,
  });
}

/** The event row as the database holds it. */
async function eventRow(set: SetRef, eventId: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    'select * from pilot.calibration_annotation_events where organization_id = $1 and event_id = $2',
    [set.orgId, eventId],
  );
  return result.rows[0];
}

/** Every mark on one event, ids included, read straight from the tables. */
async function marksOf(set: SetRef, eventId: string) {
  const args = [set.orgId, eventId];
  const moments = await db.query(
    `select * from pilot.calibration_body_moments
      where organization_id = $1 and event_id = $2 order by body_moment_id`,
    args,
  );
  const points = await db.query(
    `select p.* from pilot.calibration_body_points p
       join pilot.calibration_body_moments m
         on m.organization_id = p.organization_id and m.body_moment_id = p.body_moment_id
      where m.organization_id = $1 and m.event_id = $2 order by p.body_point_id`,
    args,
  );
  const stance = await db.query(
    'select * from pilot.calibration_event_stance_labels where organization_id = $1 and event_id = $2',
    args,
  );
  return { moments: moments.rows, points: points.rows, stance: stance.rows };
}

const HAS_MARKS = { name: 'EventHoldsBodyMarksError', status: 409, code: 'CALIBRATION_EVENT_HAS_BODY_MARKS' };

/** What turns a punch into a defence in one edit: the new class, its type,
 * and every punch-only field cleared by the caller. */
const AS_DEFENSE: Changes = {
  eventClass: 'defense',
  defenseType: 'slip',
  punchType: null,
  targetZone: null,
  contactResult: null,
  contactZone: null,
  combinationGroup: null,
  sequenceOrder: null,
  counterAgainstEventId: null,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('an edit in place keeps the event and everything marked on it', () => {
  test('every field that does not move a moment changes on a fully marked punch; ids, moments, points and stance type are untouched', async () => {
    const set = await newSet();
    const other = await punch(set, { startMs: EV_START + 2_000, endMs: EV_END + 2_000, contactMs: EV_CONTACT + 2_000 });
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    const before = await marksOf(set, eventId);
    expect([before.moments.length, before.points.length, before.stance.length]).toEqual([3, 72, 1]);
    const rowBefore = await eventRow(set, eventId);

    const edited = await edit(set, eventId, {
      opponentTrack: 'blue corner',
      physicalHand: 'right',
      handRole: 'rear',
      punchType: 'rear_hook',
      targetZone: 'torso',
      contactResult: 'guard_contact',
      contactZone: 'forearm',
      visibility: 'partially_occluded',
      certainty: 'probable',
      combinationGroup: 'combo-1',
      sequenceOrder: 2,
      counterAgainstEventId: other,
    });

    expect(edited.event_id).toBe(eventId);
    expect(await marksOf(set, eventId)).toEqual(before);
    expect(await eventRow(set, eventId)).toEqual({
      ...rowBefore,
      opponent_track: 'blue corner',
      physical_hand: 'right',
      hand_role: 'rear',
      punch_type: 'rear_hook',
      target_zone: 'torso',
      contact_result: 'guard_contact',
      contact_zone: 'forearm',
      visibility: 'partially_occluded',
      certainty: 'probable',
      combination_group: 'combo-1',
      sequence_order: 2,
      counter_against_event_id: other,
    });
    // Still complete: the edit left nothing for submission to refuse on.
    expect((await bodyPoints.listMissingBodyData(set.orgId, set.setId)).filter((item) => item.startsWith(eventId))).toEqual([]);
  });

  test('a marked defence: its type, hand, and what it defends against change; its marks stay', async () => {
    const set = await newSet();
    const thrown = await punch(set);
    const eventId = await defense(set);
    await completeEvent(set, eventId, EV_START + 100);
    const before = await marksOf(set, eventId);

    const edited = await edit(set, eventId, {
      defenseType: 'block',
      physicalHand: 'left',
      handRole: 'lead',
      defendsAgainstEventId: thrown,
      certainty: 'uncertain',
    });

    expect(edited).toMatchObject({
      event_id: eventId,
      defense_type: 'block',
      physical_hand: 'left',
      hand_role: 'lead',
      defends_against_event_id: thrown,
      certainty: 'uncertain',
    });
    expect(await marksOf(set, eventId)).toEqual(before);
  });

  test('a whole draft that repeats the stored start, end, contact time, class and actor is not a move', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    const before = await marksOf(set, eventId);

    const edited = await edit(set, eventId, {
      eventClass: 'punch',
      actorTrack: 'red',
      startMs: EV_START,
      endMs: EV_END,
      contactMs: EV_CONTACT,
      punchType: 'lead_hook',
    });

    expect(edited).toMatchObject({ event_id: eventId, punch_type: 'lead_hook', start_ms: EV_START });
    expect(await marksOf(set, eventId)).toEqual(before);
  });

  test('a relationship another event points at the edited one survives', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const counter = await punch(set, {
      startMs: EV_START + 2_000, endMs: EV_END + 2_000, contactMs: EV_CONTACT + 2_000, counterAgainstEventId: eventId,
    });

    await edit(set, eventId, { punchType: 'lead_uppercut' });

    expect((await eventRow(set, counter)).counter_against_event_id).toBe(eventId);
  });

  test('two edits of one event at once both land: the second merges over the first, not over the row it started from', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    // Hold the row so both edits are in flight together, then let them go.
    await db.query('begin');
    try {
      await db.query(
        'select 1 from pilot.calibration_annotation_events where organization_id = $1 and event_id = $2 for update',
        [set.orgId, eventId],
      );
      const first = edit(set, eventId, { punchType: 'rear_hook' });
      const second = edit(set, eventId, { certainty: 'uncertain' });
      await sleep(500);
      await db.query('commit');
      await Promise.all([first, second]);
    } finally {
      await db.query('rollback').catch(() => {});
    }
    expect(await eventRow(set, eventId)).toMatchObject({ punch_type: 'rear_hook', certainty: 'uncertain' });
  });

  test('a field left out stays as stored; null clears an optional one', async () => {
    const set = await newSet();
    const eventId = await punch(set, { contactZone: 'head', combinationGroup: 'c', sequenceOrder: 1 });
    const rowBefore = await eventRow(set, eventId);

    await edit(set, eventId, { contactZone: null, sequenceOrder: null });

    expect(await eventRow(set, eventId)).toEqual({ ...rowBefore, contact_zone: null, sequence_order: null });
  });
});

describe('while an event holds marks, what a moment was checked against cannot change', () => {
  const MOVES: [string, string, Changes, Record<string, unknown>][] = [
    ['start', 'start', { startMs: EV_START - 100 }, { start_ms: EV_START - 100 }],
    ['end', 'end', { endMs: EV_END + 100 }, { end_ms: EV_END + 100 }],
    ['contact time', 'contact time', { contactMs: EV_CONTACT + 10 }, { contact_ms: EV_CONTACT + 10 }],
    ['class', 'class', AS_DEFENSE, { event_class: 'defense', defense_type: 'slip', punch_type: null }],
    ['actor', 'actor', { actorTrack: 'blue' }, { actor_track: 'blue' }],
  ];

  test.each(MOVES)('%s: refused naming it while a moment exists, nothing changed; allowed once the marks are removed', async (_label, named, changes, expected) => {
    const set = await newSet();
    const eventId = await punch(set);
    const ids = await completeEvent(set, eventId);
    const before = await marksOf(set, eventId);
    const rowBefore = await eventRow(set, eventId);

    await expect(edit(set, eventId, changes)).rejects.toMatchObject({
      ...HAS_MARKS,
      message: `Conflict: this event has marked moments, so its ${named} cannot change. `
        + `Remove its marked moments${named === 'actor' ? ' and its stance type' : ''} first, then edit it.`,
    });
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
    expect(await marksOf(set, eventId)).toEqual(before);

    for (const bodyMomentId of Object.values(ids)) {
      await bodyPoints.deleteBodyMoment(set.orgId, set.setId, bodyMomentId);
    }
    await bodyPoints.clearEventStanceType(set.orgId, set.setId, eventId);

    const edited = await edit(set, eventId, changes);
    expect(edited.event_id).toBe(eventId);
    expect(await eventRow(set, eventId)).toMatchObject(expected);
  });

  test('one moment is enough, and every moved field is named together', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await open(set, eventId, 'end');

    await expect(edit(set, eventId, { startMs: EV_START - 50, endMs: EV_END + 50, actorTrack: 'blue' })).rejects.toMatchObject({
      ...HAS_MARKS,
      message: expect.stringContaining('so its start, end, actor cannot change'),
    });
  });

  test('a stance type alone holds the actor, and only the actor', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await bodyPoints.setEventStanceType({ organizationId: set.orgId, annotationSetId: set.setId, eventId, stanceType: 'usa_boxing__classic' });

    await expect(edit(set, eventId, { actorTrack: 'blue' })).rejects.toMatchObject({
      ...HAS_MARKS,
      message: expect.stringContaining('has a stance type, so its actor cannot change'),
    });
    expect((await eventRow(set, eventId)).actor_track).toBe('red');

    const edited = await edit(set, eventId, { startMs: EV_START - 100, contactMs: EV_CONTACT - 10 });
    expect(edited).toMatchObject({ event_id: eventId, start_ms: EV_START - 100, contact_ms: EV_CONTACT - 10 });
    expect((await marksOf(set, eventId)).stance).toHaveLength(1);
  });

  test('landed to missed needs the contact time cleared, so with marks it is refused either way and the marks stay', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    const before = await marksOf(set, eventId);

    await expect(edit(set, eventId, { contactResult: 'no_contact' })).rejects.toThrow(/^Missing contact_ms: in boxing-ontology-0\.2/);
    await expect(edit(set, eventId, { contactResult: 'no_contact', contactMs: null })).rejects.toMatchObject(HAS_MARKS);
    // Inside the same group the result is a label, and it changes.
    expect((await edit(set, eventId, { contactResult: 'glancing_target_contact' })).contact_result).toBe('glancing_target_contact');
    expect(await marksOf(set, eventId)).toEqual(before);
  });

  test('a moment landing while the edit is in flight is seen: the edit waits for it, then refuses', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await db.query('begin');
    try {
      await insertMomentDirect(set, eventId);
      let settled = false;
      const pending = edit(set, eventId, { contactMs: EV_CONTACT + 10 }).finally(() => { settled = true; });
      pending.catch(() => {});
      await sleep(500);
      expect(settled).toBe(false);
      await db.query('commit');
      await expect(pending).rejects.toMatchObject({
        ...HAS_MARKS,
        message: expect.stringContaining('so its contact time cannot change'),
      });
    } finally {
      await db.query('rollback').catch(() => {});
    }
    expect((await eventRow(set, eventId)).contact_ms).toBe(EV_CONTACT);
  });
});

describe('an edited event is held to every rule a new one is', () => {
  test('a 0.2 event takes no stance and no peak, and a contact time exactly when its result made contact', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const rowBefore = await eventRow(set, eventId);

    await expect(edit(set, eventId, { stance: 'orthodox' })).rejects.toThrow(/^Missing stance: boxing-ontology-0\.2/);
    await expect(edit(set, eventId, { peakMs: EV_CONTACT })).rejects.toThrow(/^Missing peak_ms: boxing-ontology-0\.2/);
    await expect(edit(set, eventId, { contactResult: 'uncertain_contact' })).rejects.toThrow(/^Missing contact_ms: in boxing-ontology-0\.2/);
    await expect(edit(set, eventId, { contactMs: null })).rejects.toThrow(/^Missing contact_ms: in boxing-ontology-0\.2/);
    expect(await eventRow(set, eventId)).toEqual(rowBefore);

    // Both halves together are a consistent row, and with no marks it is taken.
    const missed = await edit(set, eventId, { contactResult: 'no_contact', contactMs: null });
    expect(missed).toMatchObject({ event_id: eventId, contact_result: 'no_contact', contact_ms: null });
  });

  test('the same three rules hold under 0.4', async () => {
    const set = await newSet(V04);
    const eventId = await punch(set);
    await expect(edit(set, eventId, { stance: 'southpaw' })).rejects.toThrow(/^Missing stance: boxing-ontology-0\.4/);
    await expect(edit(set, eventId, { contactMs: null })).rejects.toThrow(/^Missing contact_ms: in boxing-ontology-0\.4/);
  });

  test('a 0.1 event keeps its own rules: stance and peak are editable, and contact time is free of the result', async () => {
    const set = await newSet(V01);
    const eventId = await punch(set, { stance: 'orthodox' });

    const edited = await edit(set, eventId, { stance: 'southpaw', peakMs: EV_CONTACT, contactMs: null, startMs: EV_START - 100 });

    expect(edited).toMatchObject({
      event_id: eventId, stance: 'southpaw', peak_ms: EV_CONTACT, contact_ms: null, start_ms: EV_START - 100, contact_result: 'clean_target_contact',
    });
  });

  test.each<[string, Changes, RegExp]>([
    ['a punch type outside the list', { punchType: 'haymaker' as never }, /^Missing punch_type/],
    ['a visibility outside the list', { visibility: 'blurry' as never }, /^Missing visibility/],
    ['a required field cleared', { certainty: null as never }, /^Missing certainty/],
    ['a required punch field cleared', { targetZone: null }, /^Missing target_zone/],
    ['an actor cleared', { actorTrack: '  ' }, /^Missing actor_track/],
    ['an opponent that is not text', { opponentTrack: { a: 1 } as never }, /^Missing opponent_track/],
    ['a defence type on a punch', { defenseType: 'slip' }, /^Missing defense_type/],
    ['a class change that keeps the punch fields', { eventClass: 'defense', defenseType: 'slip' }, /^Missing punch_type: a defense cannot carry it/],
    ['an end before the start', { endMs: EV_START }, /^Missing end_ms/],
    ['a contact time outside the event', { contactMs: EV_END + 1 }, /^Missing contact_ms: must fall within the event/],
    ['a span outside the clip', { startMs: CLIP_START_MS - 1 }, /^Missing start_ms: the event falls outside the clip/],
    ['a sequence position of zero', { sequenceOrder: 0 }, /^Missing sequence_order/],
    ['a time that is not a whole number', { startMs: 1.5 }, /^Missing start_ms/],
  ])('%s is refused by name and nothing is written', async (_label, changes, message) => {
    const set = await newSet();
    const eventId = await punch(set);
    const rowBefore = await eventRow(set, eventId);

    await expect(edit(set, eventId, changes)).rejects.toThrow(message);
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
  });
});

describe('a relationship stays inside the set', () => {
  test('a counter may point at another event of this set, and at nothing else', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const sibling = await punch(set, { startMs: EV_START + 2_000, endMs: EV_END + 2_000, contactMs: EV_CONTACT + 2_000 });
    const otherSet = await newSet();
    const inOtherSet = await punch(otherSet);
    // Same set id in another organization, holding an event of its own.
    const twin = await newSet(V02, OTHER_ORG_ID, set.setId);
    const inOtherOrg = await punch(twin);
    const noSuch = 'Missing counter_against_event_id: no such event in this annotation set';

    await expect(edit(set, eventId, { counterAgainstEventId: inOtherSet })).rejects.toThrow(noSuch);
    await expect(edit(set, eventId, { counterAgainstEventId: inOtherOrg })).rejects.toThrow(noSuch);
    await expect(edit(set, eventId, { counterAgainstEventId: crypto.randomUUID() })).rejects.toThrow(noSuch);
    await expect(edit(set, eventId, { counterAgainstEventId: eventId })).rejects.toThrow('Missing counter_against_event_id: an event cannot point at itself');
    expect((await eventRow(set, eventId)).counter_against_event_id).toBeNull();

    expect((await edit(set, eventId, { counterAgainstEventId: sibling })).counter_against_event_id).toBe(sibling);
    expect((await edit(set, eventId, { counterAgainstEventId: null })).counter_against_event_id).toBeNull();
  });

  test('a defence may say what it defends against only inside this set; a punch defends against nothing', async () => {
    const set = await newSet();
    const thrown = await punch(set);
    const eventId = await defense(set);
    const inOtherSet = await punch(await newSet());

    await expect(edit(set, eventId, { defendsAgainstEventId: inOtherSet })).rejects.toThrow('Missing defends_against_event_id: no such event in this annotation set');
    await expect(edit(set, eventId, { defendsAgainstEventId: eventId })).rejects.toThrow('an event cannot point at itself');
    await expect(edit(set, thrown, { defendsAgainstEventId: eventId })).rejects.toThrow(/^Missing defends_against_event_id: a punch defends against nothing/);
    await expect(edit(set, eventId, { counterAgainstEventId: thrown })).rejects.toThrow(/^Missing counter_against_event_id: a defense cannot carry it/);
    expect((await edit(set, eventId, { defendsAgainstEventId: thrown })).defends_against_event_id).toBe(thrown);
  });

  test('a bad relationship sent with a moved start is reported as the relationship, never as marks the event does not have', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const rowBefore = await eventRow(set, eventId);

    await expect(edit(set, eventId, { startMs: EV_START - 100, counterAgainstEventId: crypto.randomUUID() }))
      .rejects.toThrow('Missing counter_against_event_id: no such event in this annotation set');
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
  });

  test('the database holds the same line on a direct write', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const inOtherSet = await punch(await newSet());
    await expect(db.query(
      `update pilot.calibration_annotation_events set counter_against_event_id = $3
        where organization_id = $1 and event_id = $2`,
      [set.orgId, eventId, inOtherSet],
    )).rejects.toThrow('pilot_calibration_events_counter_fk');
  });
});

describe('the gates', () => {
  test('a submitted set is frozen: the edit is refused and the row is as submitted', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    expect(await annotations.submitAnnotationSet(set.orgId, set.setId)).not.toBeNull();
    const rowBefore = await eventRow(set, eventId);
    const before = await marksOf(set, eventId);

    await expect(edit(set, eventId, { certainty: 'uncertain' })).rejects.toMatchObject({ name: 'AnnotationSetSubmittedError' });
    await expect(edit(set, eventId, { punchType: 'rear_hook' })).rejects.toMatchObject({ name: 'AnnotationSetSubmittedError' });
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
    expect(await marksOf(set, eventId)).toEqual(before);
    // The trigger under the module refuses the same write.
    await expect(db.query(
      `update pilot.calibration_annotation_events set certainty = 'uncertain'
        where organization_id = $1 and event_id = $2`,
      [set.orgId, eventId],
    )).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
  });

  test('an edit racing a submission is refused as submitted, not told to remove marks it can no longer remove', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    const rowBefore = await eventRow(set, eventId);
    // The submission holds the set and has not committed when the edit starts.
    await db.query('begin');
    try {
      await db.query(
        `update pilot.calibration_annotation_sets set status = 'submitted', submitted_at = now()
          where organization_id = $1 and annotation_set_id = $2`,
        [set.orgId, set.setId],
      );
      let settled = false;
      const pending = edit(set, eventId, { contactMs: EV_CONTACT + 10 }).finally(() => { settled = true; });
      pending.catch(() => {});
      await sleep(500);
      expect(settled).toBe(false);
      await db.query('commit');
      await expect(pending).rejects.toMatchObject({ name: 'AnnotationSetSubmittedError' });
    } finally {
      await db.query('rollback').catch(() => {});
    }
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
  });

  test('nothing is reachable across an organization, even through a set with the same id', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    const twin = await newSet(V02, OTHER_ORG_ID, set.setId);
    const rowBefore = await eventRow(set, eventId);

    await expect(annotations.updateAnnotationEvent({
      organizationId: OTHER_ORG_ID, annotationSetId: set.setId, eventId, certainty: 'uncertain',
    })).rejects.toThrow('Not found: no such event in this annotation set');
    await expect(annotations.updateAnnotationEvent({
      organizationId: OTHER_ORG_ID, annotationSetId: crypto.randomUUID(), eventId, certainty: 'uncertain',
    })).rejects.toThrow('Not found: no such annotation set in this organization');
    expect(await eventRow(set, eventId)).toEqual(rowBefore);
    expect(await countFor('calibration_annotation_events', twin)).toBe(0);
  });

  test('an event of another set in the same organization is not found, and is untouched', async () => {
    const theirs = await newSet();
    const theirEvent = await punch(theirs);
    const mine = await newSet();
    const rowBefore = await eventRow(theirs, theirEvent);

    await expect(edit(mine, theirEvent, { certainty: 'uncertain' })).rejects.toThrow('Not found: no such event in this annotation set');
    await expect(edit(mine, crypto.randomUUID(), { certainty: 'uncertain' })).rejects.toThrow('Not found: no such event in this annotation set');
    expect(await eventRow(theirs, theirEvent)).toEqual(rowBefore);
  });
});

describe('what this change leaves alone', () => {
  test('withdrawing an event outright still removes its marks: that delete is the annotator\'s own choice', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await completeEvent(set, eventId);
    expect(await annotations.deleteAnnotationEvent(set.orgId, set.setId, eventId)).toBe(true);
    expect(await countFor('calibration_body_moments', set)).toBe(0);
  });

  test('the freeze an edit reports is the database\'s own: a direct write is refused the same', async () => {
    const set = await newSet();
    const eventId = await punch(set);
    await open(set, eventId, 'middle');
    await expect(db.query(
      `update pilot.calibration_annotation_events set contact_ms = $3
        where organization_id = $1 and event_id = $2`,
      [set.orgId, eventId, EV_CONTACT + 10],
    )).rejects.toThrow('CALIBRATION_EVENT_HAS_BODY_MOMENTS');
    await expect(db.query(
      `update pilot.calibration_annotation_events set start_ms = $3
        where organization_id = $1 and event_id = $2`,
      [set.orgId, eventId, EV_START - 10],
    )).rejects.toThrow('pilot_calibration_body_moments_event_fk');
  });
});
