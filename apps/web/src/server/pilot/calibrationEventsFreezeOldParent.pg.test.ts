// Real PostgreSQL-backed test for the events freeze on the set an event
// leaves.
//
// The annotations migration's events freeze looks up only the set an UPDATE
// moves an event INTO, so an event could be moved out of a submitted set into
// an in-progress set on the same clip. Every claim here is database
// behaviour:
//
//   * an event cannot leave a submitted set, by any UPDATE
//   * without the new trigger the same move goes through (the hole)
//   * moves between in-progress sets and in-place edits are unchanged
//   * deleting the footage, clip, set or organization still removes a
//     submitted set's events, including a defence and the punch it points at
//   * a submission of the set being left waits for the uncommitted move
//   * re-running the annotations migration does not reopen the hole
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-events-old-parent-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_events_old_parent';

const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-events-freeze-old-parent-migration.mjs',
);

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
const THIS_SQL = 'pilot_slice_postgres_calibration_events_freeze_old_parent_migration.sql';

const ORG_ID = 'org-old-parent';
const ANNOTATOR = 'acct-old-parent-a';
const SECOND_ANNOTATOR = 'acct-old-parent-b';
const VIDEO_ID = 'vs-old-parent-ready';
const V01 = 'boxing-ontology-0.1';

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

/** A database with every prerequisite applied and this migration NOT applied. */
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

/** An organization with an annotator, teaching footage and a project. */
async function seedOrganization(orgId: string, videoId: string): Promise<string> {
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [orgId],
  );
  await seedVideo(orgId, videoId);
  const projectId = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: orgId,
    calibrationProjectId: projectId,
    name: 'Events freeze old parent study',
    ontologyVersion: ontology.PROJECT_CREATION_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR,
  });
  return projectId;
}

/** Teaching footage: clips are only cut from a video with a capture take. */
async function seedVideo(orgId: string, videoId: string): Promise<void> {
  const take = await seedCaptureTake(db, { organizationId: orgId, createdByAccountId: ANNOTATOR });
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status,
        recording_session_id, capture_take_id)
     values ($1, $2, $3, null, 'Sparring', $4, 'r.mp4', 2048, 'video/mp4', 'ready', $5, $6)
     on conflict do nothing`,
    [videoId, orgId, ANNOTATOR, `p/${videoId}.mp4`, take.recordingSessionId, take.captureTakeId],
  );
}

interface SetRef {
  orgId: string;
  setId: string;
  clipId: string;
}

/** A fresh clip with one in-progress 0.1 set on it per annotator given. */
async function clipWithSets(
  annotators: string[],
  { orgId = ORG_ID, videoId = VIDEO_ID, projectId = PROJECT_ID } = {},
): Promise<SetRef[]> {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId: orgId,
    calibrationClipId: clipId,
    calibrationProjectId: projectId,
    videoSessionId: videoId,
    clipCode: `C-${clipId.slice(0, 8)}`,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: ANNOTATOR,
  });
  const sets: SetRef[] = [];
  for (const annotatorAccountId of annotators) {
    const setId = crypto.randomUUID();
    await annotations.openAnnotationSet({
      organizationId: orgId,
      annotationSetId: setId,
      calibrationClipId: clipId,
      annotatorAccountId,
      ontologyVersion: V01,
    });
    sets.push({ orgId, setId, clipId });
  }
  return sets;
}

/** An event written straight to the table, so only the database judges it.
 * Defaults: a landed punch. */
async function insertEvent(set: SetRef, fields: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    organization_id: set.orgId,
    event_id: crypto.randomUUID(),
    annotation_set_id: set.setId,
    calibration_clip_id: set.clipId,
    clip_start_ms: CLIP_START_MS,
    clip_end_ms: CLIP_END_MS,
    event_class: 'punch',
    actor_track: 'red',
    start_ms: EV_START,
    end_ms: EV_END,
    contact_ms: EV_CONTACT,
    physical_hand: 'left',
    hand_role: 'lead',
    punch_type: 'lead_straight',
    target_zone: 'head',
    contact_result: 'clean_target_contact',
    visibility: 'clear',
    certainty: 'clear',
    ...fields,
  };
  const columns = Object.keys(row);
  await db.query(
    `insert into pilot.calibration_annotation_events (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
  return row.event_id as string;
}

/** A defence against `punchId`: the two are tied by the ON DELETE SET NULL
 * relationship a deletion has to get past. */
async function insertDefenseAgainst(set: SetRef, punchId: string): Promise<string> {
  return insertEvent(set, {
    event_class: 'defense',
    actor_track: 'blue',
    contact_ms: null,
    physical_hand: null,
    hand_role: null,
    punch_type: null,
    target_zone: null,
    contact_result: null,
    defense_type: 'slip',
    defends_against_event_id: punchId,
  });
}

async function submit(set: SetRef, client: Client = db): Promise<void> {
  await client.query(
    `update pilot.calibration_annotation_sets set status = 'submitted', submitted_at = now()
      where organization_id = $1 and annotation_set_id = $2`,
    [set.orgId, set.setId],
  );
}

async function move(eventId: string, to: SetRef, client: Client = db): Promise<void> {
  await client.query(
    `update pilot.calibration_annotation_events set annotation_set_id = $3
      where organization_id = $1 and event_id = $2`,
    [to.orgId, eventId, to.setId],
  );
}

async function setOf(orgId: string, eventId: string): Promise<string | undefined> {
  const result = await db.query<{ annotation_set_id: string }>(
    `select annotation_set_id from pilot.calibration_annotation_events
      where organization_id = $1 and event_id = $2`,
    [orgId, eventId],
  );
  return result.rows[0]?.annotation_set_id;
}

async function eventCount(set: SetRef): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from pilot.calibration_annotation_events
      where organization_id = $1 and annotation_set_id = $2`,
    [set.orgId, set.setId],
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
  await runner.applyMigrationTransaction(db, await readMigration(THIS_SQL));

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'coach', $3, 'microsoft')`,
    [ANNOTATOR, SECOND_ANNOTATOR, ORG_ID],
  );
  PROJECT_ID = await seedOrganization(ORG_ID, VIDEO_ID);
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
    const client = await prerequisiteDatabase('ppbf_test_calib_events_old_parent_unmigrated');
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_EVENTS_FREEZE_OLD_PARENT_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  test('a second run is a no-op that leaves rows in place, and the move stays refused', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(from);

    const runner = await loadRunner();
    await runner.applyMigrationTransaction(db, await readMigration(THIS_SQL));
    expect(await eventCount(from)).toBe(1);
    await expect(move(eventId, to)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
  });

  test('re-running the annotations migration does not reopen the hole', async () => {
    await db.query(await readMigration('pilot_slice_postgres_calibration_annotations_migration.sql'));
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(from);
    await expect(move(eventId, to)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
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

describe('an event cannot leave a submitted set', () => {
  test('moving it into an in-progress set on the same clip is refused; it stays put', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(from);

    await expect(move(eventId, to)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
    expect(await setOf(ORG_ID, eventId)).toBe(from.setId);
    expect(await eventCount(to)).toBe(0);
  });

  test('without this trigger the same move goes through (the hole it closes)', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(from);

    await db.query('begin');
    try {
      await db.query('alter table pilot.calibration_annotation_events disable trigger pilot_calibration_events_freeze_old_parent');
      await move(eventId, to);
      expect(await setOf(ORG_ID, eventId)).toBe(to.setId);
    } finally {
      await db.query('rollback');
    }
    expect(await setOf(ORG_ID, eventId)).toBe(from.setId);
  });

  test('moving it into another submitted set is refused', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(from);
    await submit(to);
    await expect(move(eventId, to)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
  });

  test('moving an event into a submitted set is still refused by the existing freeze', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await submit(to);
    await expect(move(eventId, to)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
  });

  test('between two in-progress sets nothing changes: the move is allowed as before', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);
    await move(eventId, to);
    expect(await setOf(ORG_ID, eventId)).toBe(to.setId);
  });

  test('an in-place edit of an in-progress event is not affected', async () => {
    const [set] = await clipWithSets([ANNOTATOR]);
    const eventId = await insertEvent(set);
    await db.query(
      `update pilot.calibration_annotation_events set certainty = 'probable'
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, eventId],
    );
    expect(await setOf(ORG_ID, eventId)).toBe(set.setId);
  });
});

describe('deletion still reaches a submitted set\'s events', () => {
  // Each fixture holds a punch and a defence against it, so the deletion also
  // reaches the ON DELETE SET NULL relationship between them.
  async function submittedPair(options: Parameters<typeof clipWithSets>[1] = {}): Promise<SetRef> {
    const [set] = await clipWithSets([ANNOTATOR], options);
    await insertDefenseAgainst(set, await insertEvent(set));
    await submit(set);
    return set;
  }

  test.each([
    ['the clip', 'delete from pilot.calibration_clips where organization_id = $1 and calibration_clip_id = $2', 'clipId'],
    ['the set', 'delete from pilot.calibration_annotation_sets where organization_id = $1 and annotation_set_id = $2', 'setId'],
  ] as const)('deleting %s removes them', async (_label, statement, key) => {
    const set = await submittedPair();
    await db.query(statement, [ORG_ID, set[key]]);
    expect(await eventCount(set)).toBe(0);
  });

  test('deleting the footage removes them', async () => {
    const videoId = `vs-old-parent-doomed-${crypto.randomUUID().slice(0, 8)}`;
    await seedVideo(ORG_ID, videoId);
    const set = await submittedPair({ videoId });
    await db.query('delete from pilot.video_sessions where video_session_id = $1', [videoId]);
    expect(await eventCount(set)).toBe(0);
  });

  test('deleting a whole organization removes them', async () => {
    // pilot.accounts does not cascade from pilot.organizations (base schema),
    // so the doomed organization's study names this suite's annotators.
    const orgId = `org-old-parent-doomed-${crypto.randomUUID().slice(0, 8)}`;
    const videoId = `vs-${orgId}`;
    const projectId = await seedOrganization(orgId, videoId);
    const set = await submittedPair({ orgId, videoId, projectId });
    await db.query('delete from pilot.organizations where organization_id = $1', [orgId]);
    expect(await eventCount(set)).toBe(0);
  });
});

describe('two writers at once', () => {
  /** Resolves once `client`'s backend is waiting on a lock, so the test never
   * commits the other writer before this one has reached the database. */
  async function blockedOnLock(client: Client): Promise<void> {
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await db.query<{ wait_event_type: string | null }>(
        'select wait_event_type from pg_stat_activity where pid = $1',
        [pid],
      );
      if (row.rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('NEVER_BLOCKED');
  }

  test('a submission of the set an event is leaving waits for the uncommitted move', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);

    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    const other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    await other.connect();
    try {
      await writer.query('begin');
      await move(eventId, to, writer);
      await other.query("set lock_timeout = '2s'");
      await expect(submit(from, other)).rejects.toThrow(/lock timeout/);
      await writer.query('rollback');
    } finally {
      await writer.end();
      await other.end();
    }
    expect(await setOf(ORG_ID, eventId)).toBe(from.setId);
  });

  test('once the move commits, the waiting submission goes ahead without the event', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);

    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    const other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    await other.connect();
    try {
      await writer.query('begin');
      await move(eventId, to, writer);
      const waiting = blockedOnLock(other);
      const submission = submit(from, other);
      await waiting;
      await writer.query('commit');
      await submission;
    } finally {
      await writer.end();
      await other.end();
    }
    expect(await setOf(ORG_ID, eventId)).toBe(to.setId);
    expect(await eventCount(from)).toBe(0);
  });

  test('a move that waits on an uncommitted submission of the set it leaves is refused once it commits', async () => {
    const [from, to] = await clipWithSets([ANNOTATOR, SECOND_ANNOTATOR]);
    const eventId = await insertEvent(from);

    const submitter = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    const mover = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await submitter.connect();
    await mover.connect();
    try {
      await submitter.query('begin');
      await submit(from, submitter);
      const waiting = blockedOnLock(mover);
      const moving = move(eventId, to, mover);
      // Swallowed here and asserted below, so an early rejection is not unhandled.
      const outcome = moving.then(() => 'moved', (error: Error) => error.message);
      await waiting;
      await submitter.query('commit');
      expect(await outcome).toBe('CALIBRATION_ANNOTATION_SET_SUBMITTED');
    } finally {
      await submitter.end();
      await mover.end();
    }
    expect(await setOf(ORG_ID, eventId)).toBe(from.setId);
  });
});
