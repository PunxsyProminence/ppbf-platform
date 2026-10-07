// Real PostgreSQL-backed test for calibration re-mark passes: one annotator
// labelling the same clip again, blind, in a later session.
//
// Every claim here is database behaviour or a read against a real database:
//
//   * existing sets become pass 1 without being rewritten
//   * a later pass opens only on that annotator's submitted earlier pass
//   * while (and after) a later pass exists, its annotator reads NOTHING of
//     their earlier pass on any annotator read path
//   * every reader that compares people reads first passes only, so a repeat
//     pass never pairs a person with themselves
//   * a second annotator's blinding, organization isolation and each pass's
//     body-point data are unchanged
//   * the runners: the annotations runner still passes after this migration,
//     in either order and repeatedly, and the three-column key stays gone
//
// Most cases open a later pass by a direct row write, so that only the
// database judges it. The application's own way in, openNextAnnotationPass,
// has its own section at the end.
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
import type { PilotPrincipal } from './auth';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-remark-pass-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_remark_pass';

const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-remark-pass-migration.mjs',
);
const ANNOTATIONS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-annotations-migration.mjs',
);

const BEFORE_ADJUDICATION_SQL = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_calibration_projects_migration.sql',
  'pilot_slice_postgres_calibration_annotations_migration.sql',
];
const PREREQUISITE_SQL = [
  ...BEFORE_ADJUDICATION_SQL,
  'pilot_slice_postgres_calibration_adjudication_migration.sql',
  'pilot_slice_postgres_calibration_adjudication_revisions_migration.sql',
  'pilot_slice_postgres_calibration_gold_migration.sql',
  'pilot_slice_postgres_calibration_body_points_migration.sql',
  'pilot_slice_postgres_calibration_body_point_rules_migration.sql',
  'pilot_slice_postgres_calibration_events_freeze_old_parent_migration.sql',
];
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';
const THIS_SQL = 'pilot_slice_postgres_calibration_remark_pass_migration.sql';

const OLD_KEY = 'pilot_calibration_sets_one_per_annotator_uq';
const PASS_KEY = 'pilot_calibration_sets_one_per_annotator_pass_uq';

const ORG_ID = 'org-remark';
const OTHER_ORG_ID = 'org-remark-other';
const A = 'acct-remark-a';
const B = 'acct-remark-b';
const ADJUDICATOR = 'acct-remark-adjudicator';
const OTHER_A = 'acct-remark-other-a';
const VIDEO_ID = 'vs-remark-ready';
const OTHER_VIDEO_ID = 'vs-remark-other-ready';
const V01 = 'boxing-ontology-0.1';
const V04 = 'boxing-ontology-0.4';

const CLIP_START_MS = 60_000;
const CLIP_END_MS = 72_000;
const EV_START = CLIP_START_MS + 1_000;
const EV_END = CLIP_START_MS + 1_400;
const EV_CONTACT = CLIP_START_MS + 1_250;

const NOT_SUBMITTED = 'CALIBRATION_ANNOTATION_SET_PREVIOUS_PASS_NOT_SUBMITTED';
const PASS_FIXED = 'CALIBRATION_ANNOTATION_SET_PASS_FIXED';
const NOT_FOUND = 'Not found: no such annotation set for this annotator';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let annotations: typeof import('./calibration/annotations');
let blinding: typeof import('./calibration/blinding');
let bodyPoints: typeof import('./calibration/bodyPoints');
let adjudication: typeof import('./calibration/adjudication');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');
let qaReportLoader: typeof import('./calibration/qaReportLoader');
let coverage: typeof import('./teachShadow/coverage');
let gate: typeof import('../../../app/api/pilot/calibration/annotatorGate');
let db: Client;
let PROJECT_ID: string;
let OTHER_PROJECT_ID: string;

/** Two sets written BEFORE this migration ran, and what the database said
 * about their row versions at the time. */
let legacy: { clipId: string; rows: Array<{ annotation_set_id: string; ctid: string; xmin: string }> };

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

async function loadRunner(runnerPath: string = RUNNER_PATH): Promise<{ applyMigrationTransaction: ApplyFn; run: () => Promise<void> }> {
  const runner = await nativeDynamicImport(pathToFileURL(runnerPath).href);
  return runner as unknown as { applyMigrationTransaction: ApplyFn; run: () => Promise<void> };
}

/** A database with the listed migrations applied and this one NOT applied. */
async function prerequisiteDatabase(name: string, files: string[] = PREREQUISITE_SQL): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const file of files) {
    await client.query(await readMigration(file));
  }
  return client;
}

async function hasConstraint(client: Client, name: string): Promise<boolean> {
  const result = await client.query(
    `select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_annotation_sets') and conname = $1`,
    [name],
  );
  return result.rowCount === 1;
}

async function hasPassColumn(client: Client): Promise<boolean> {
  const result = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'calibration_annotation_sets'
        and column_name = 'pass_number'`,
  );
  return result.rowCount === 1;
}

/** Teaching footage: clips are only cut from a video with a capture take. */
async function seedVideo(orgId: string, videoId: string, uploader: string): Promise<void> {
  const take = await seedCaptureTake(db, { organizationId: orgId, createdByAccountId: uploader });
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status,
        recording_session_id, capture_take_id)
     values ($1, $2, $3, null, 'Sparring', $4, 'r.mp4', 2048, 'video/mp4', 'ready', $5, $6)`,
    [videoId, orgId, uploader, `p/${videoId}.mp4`, take.recordingSessionId, take.captureTakeId],
  );
}

async function newProject(orgId: string = ORG_ID, creator: string = A): Promise<string> {
  const projectId = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: orgId,
    calibrationProjectId: projectId,
    name: `Remark pass study ${projectId.slice(0, 8)}`,
    ontologyVersion: ontology.PROJECT_CREATION_ONTOLOGY_VERSION,
    createdByAccountId: creator,
  });
  return projectId;
}

async function newClip(
  { orgId = ORG_ID, videoId = VIDEO_ID, projectId = PROJECT_ID, creator = A } = {},
): Promise<string> {
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
    createdByAccountId: creator,
  });
  return clipId;
}

interface SetRef {
  orgId: string;
  setId: string;
  clipId: string;
  annotator: string;
  version: string;
}

/** A first pass, through the module -- the only way the application opens one. */
async function firstPass(annotator: string, clipId: string, version: string = V01, orgId: string = ORG_ID): Promise<SetRef> {
  const setId = crypto.randomUUID();
  await annotations.openAnnotationSet({
    organizationId: orgId,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId: annotator,
    ontologyVersion: version,
  });
  return { orgId, setId, clipId, annotator, version };
}

/** A set at a given pass number, written straight to the table so only the
 * database judges it. */
async function insertPass(
  annotator: string,
  clipId: string,
  passNumber: number,
  { version = V01, orgId = ORG_ID } = {},
): Promise<SetRef> {
  const setId = crypto.randomUUID();
  await db.query(
    `insert into pilot.calibration_annotation_sets
       (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
        ontology_version, pass_number)
     values ($1, $2, $3, $4, $5, $6)`,
    [orgId, setId, clipId, annotator, version, passNumber],
  );
  return { orgId, setId, clipId, annotator, version };
}

async function submit(set: SetRef): Promise<void> {
  expect(await annotations.submitAnnotationSet(set.orgId, set.setId)).not.toBeNull();
}

/** A landed punch, through the annotations module. */
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

/** A clip A has labelled, submitted, and opened a second pass on. */
async function clipWithRemark(version: string = V01): Promise<{ clipId: string; pass1: SetRef; pass2: SetRef; event1: string }> {
  const clipId = await newClip();
  const pass1 = await firstPass(A, clipId, version);
  const event1 = version === V01 ? await punch(pass1) : '';
  await submit(pass1);
  const pass2 = await insertPass(A, clipId, 2, { version });
  return { clipId, pass1, pass2, event1 };
}

/** Everything submission requires on one event of a body-point set. */
async function completeEvent(set: SetRef, eventId: string): Promise<void> {
  await bodyPoints.setEventStanceType({
    organizationId: set.orgId,
    annotationSetId: set.setId,
    eventId,
    stanceType: 'usa_boxing__classic',
  });
  const list = ontology.BODY_POINTS_BY_VERSION[set.version as keyof typeof ontology.BODY_POINTS_BY_VERSION];
  for (const momentSlot of ['start', 'middle', 'end'] as const) {
    const moment = await bodyPoints.openBodyMoment({
      organizationId: set.orgId,
      annotationSetId: set.setId,
      eventId,
      momentSlot,
      leadSide: 'orthodox',
      guardType: 'usa_boxing__high_double_guard',
    });
    await bodyPoints.markBodyPoints({
      organizationId: set.orgId,
      annotationSetId: set.setId,
      bodyMomentId: moment.body_moment_id,
      points: list.map((pointCode) => ({ pointCode, state: 'placed', xNorm: 0.5, yNorm: 0.5 })) as
        import('./calibration/bodyPoints').BodyPointMark[],
    });
  }
}

function principal(accountId: string, organizationId: string = ORG_ID): PilotPrincipal {
  return { accountId, role: 'coach', organizationId } as PilotPrincipal;
}

function reader(accountId: string, organizationId: string = ORG_ID) {
  return { organizationId, actorAccountId: accountId, actorRole: 'coach' as const };
}

function adjudicatorContext(accountId: string = ADJUDICATOR) {
  return { organizationId: ORG_ID, actorAccountId: accountId, actorRole: 'organization_admin' as const };
}

async function passNumbers(clipId: string, annotator: string): Promise<number[]> {
  const result = await db.query<{ pass_number: number }>(
    `select pass_number from pilot.calibration_annotation_sets
      where organization_id = $1 and calibration_clip_id = $2 and annotator_account_id = $3
      order by pass_number`,
    [ORG_ID, clipId, annotator],
  );
  return result.rows.map((row) => row.pass_number);
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

  db = await prerequisiteDatabase(TEST_DB_NAME);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  annotations = await import('./calibration/annotations');
  blinding = await import('./calibration/blinding');
  bodyPoints = await import('./calibration/bodyPoints');
  adjudication = await import('./calibration/adjudication');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');
  qaReportLoader = await import('./calibration/qaReportLoader');
  coverage = await import('./teachShadow/coverage');
  gate = await import('../../../app/api/pilot/calibration/annotatorGate');

  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [orgId],
    );
  }
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $5, 'microsoft'), ($2, 'coach', $5, 'microsoft'),
            ($3, 'organization_admin', $5, 'microsoft'), ($4, 'coach', $6, 'microsoft')`,
    [A, B, ADJUDICATOR, OTHER_A, ORG_ID, OTHER_ORG_ID],
  );
  await seedVideo(ORG_ID, VIDEO_ID, A);
  await seedVideo(OTHER_ORG_ID, OTHER_VIDEO_ID, OTHER_A);
  PROJECT_ID = await newProject();
  OTHER_PROJECT_ID = await newProject(OTHER_ORG_ID, OTHER_A);

  // Two sets written before the migration, by direct row writes: the module's
  // own insert already names the new column and cannot run yet.
  const legacyClip = await newClip();
  for (const [annotator, status] of [[A, 'in_progress'], [B, 'submitted']] as const) {
    await db.query(
      `insert into pilot.calibration_annotation_sets
         (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
          ontology_version, status, submitted_at)
       values ($1, $2, $3, $4, $5, $6, case when $6 = 'submitted' then now() end)`,
      [ORG_ID, crypto.randomUUID(), legacyClip, annotator, V01, status],
    );
  }
  const before = await db.query<{ annotation_set_id: string; ctid: string; xmin: string }>(
    `select annotation_set_id, ctid::text as ctid, xmin::text as xmin
       from pilot.calibration_annotation_sets
      where organization_id = $1 and calibration_clip_id = $2
      order by annotation_set_id`,
    [ORG_ID, legacyClip],
  );
  legacy = { clipId: legacyClip, rows: before.rows };

  // The suite's database is built through the runner, so every test below
  // also runs against what the runner applied.
  const runner = await loadRunner();
  await runner.applyMigrationTransaction(db, await readMigration(THIS_SQL));
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
    const client = await prerequisiteDatabase('ppbf_test_calib_remark_pass_unmigrated');
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_REMARK_PASS_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  test('existing sets become pass 1 and their rows are not rewritten', async () => {
    const after = await db.query<{ annotation_set_id: string; ctid: string; xmin: string; pass_number: number }>(
      `select annotation_set_id, ctid::text as ctid, xmin::text as xmin, pass_number
         from pilot.calibration_annotation_sets
        where organization_id = $1 and calibration_clip_id = $2
        order by annotation_set_id`,
      [ORG_ID, legacy.clipId],
    );
    expect(after.rows.map((row) => row.pass_number)).toEqual([1, 1]);
    // Same physical row version, written by the same transaction as before.
    expect(after.rows.map(({ annotation_set_id, ctid, xmin }) => ({ annotation_set_id, ctid, xmin })))
      .toEqual(legacy.rows);
  });

  test('a second run is a no-op that leaves every pass in place', async () => {
    const { clipId } = await clipWithRemark();
    const runner = await loadRunner();
    await runner.applyMigrationTransaction(db, await readMigration(THIS_SQL));
    expect(await passNumbers(clipId, A)).toEqual([1, 2]);
    expect(await hasConstraint(db, OLD_KEY)).toBe(false);
  });

  test('is not ready while the three-column key is still there beside the pass key, and a real run removes it', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_remark_pass_both_keys');
    try {
      await client.query(await readMigration(THIS_SQL));
      await client.query(
        `alter table pilot.calibration_annotation_sets
           add constraint ${OLD_KEY}
           unique (organization_id, calibration_clip_id, annotator_account_id)`,
      );
      expect([await hasConstraint(client, OLD_KEY), await hasConstraint(client, PASS_KEY)]).toEqual([true, true]);

      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_REMARK_PASS_NOT_READY',
      );
      await runner.applyMigrationTransaction(client, await readMigration(THIS_SQL));
      expect([await hasConstraint(client, OLD_KEY), await hasConstraint(client, PASS_KEY)]).toEqual([false, true]);
    } finally {
      await client.end();
    }
  });

  test('without the adjudications table the run is refused and nothing is left behind', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_remark_pass_no_adjudication', BEFORE_ADJUDICATION_SQL);
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, await readMigration(THIS_SQL))).rejects.toThrow(
        'CALIBRATION_REMARK_PASS_NOT_READY',
      );
      expect(await hasPassColumn(client)).toBe(false);
      expect(await hasConstraint(client, OLD_KEY)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('the annotations runner passes after this migration, in either order and twice, and the three-column key stays gone', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_remark_pass_order');
    try {
      const mine = await loadRunner();
      const old = await loadRunner(ANNOTATIONS_RUNNER_PATH);
      const [mineSql, oldSql] = [await readMigration(THIS_SQL), await readMigration(ANNOTATIONS_SQL)];

      for (let round = 0; round < 2; round += 1) {
        await old.applyMigrationTransaction(client, oldSql);
        await mine.applyMigrationTransaction(client, mineSql);
        await old.applyMigrationTransaction(client, oldSql);
        expect([await hasConstraint(client, OLD_KEY), await hasConstraint(client, PASS_KEY)]).toEqual([false, true]);
      }
    } finally {
      await client.end();
    }
  });

  test('the annotations runner still refuses a database with neither key', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_remark_pass_neither_key');
    try {
      await client.query(await readMigration(THIS_SQL));
      await client.query(`alter table pilot.calibration_annotation_sets drop constraint ${PASS_KEY}`);
      const old = await loadRunner(ANNOTATIONS_RUNNER_PATH);
      await expect(old.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_ANNOTATIONS_NOT_READY',
      );
    } finally {
      await client.end();
    }
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

describe('when a later pass may be opened', () => {
  test('the application still opens a first pass, and refuses a second first pass', async () => {
    const clipId = await newClip();
    const set = await firstPass(A, clipId);
    expect((await annotations.getAnnotationSet(ORG_ID, set.setId))?.pass_number).toBe(1);
    await expect(firstPass(A, clipId)).rejects.toThrow(PASS_KEY);
  });

  test('refused while the earlier pass is in progress', async () => {
    const clipId = await newClip();
    await firstPass(A, clipId);
    await expect(insertPass(A, clipId, 2)).rejects.toThrow(NOT_SUBMITTED);
    expect(await passNumbers(clipId, A)).toEqual([1]);
  });

  test('refused with no earlier pass at all, and another annotator\'s submitted pass does not count', async () => {
    const clipId = await newClip();
    const other = await firstPass(B, clipId);
    await submit(other);
    await expect(insertPass(A, clipId, 2)).rejects.toThrow(NOT_SUBMITTED);
    expect(await passNumbers(clipId, A)).toEqual([]);
  });

  test('opened once the earlier pass is submitted', async () => {
    const { clipId, pass2 } = await clipWithRemark();
    expect(await passNumbers(clipId, A)).toEqual([1, 2]);
    const row = await annotations.getAnnotationSet(ORG_ID, pass2.setId);
    expect([row?.pass_number, row?.status, row?.submitted_at]).toEqual([2, 'in_progress', null]);
  });

  test('a third pass waits for the second, cannot skip it, and cannot be opened twice', async () => {
    const { clipId, pass2 } = await clipWithRemark();
    await expect(insertPass(A, clipId, 3)).rejects.toThrow(NOT_SUBMITTED);
    await expect(insertPass(A, clipId, 2)).rejects.toThrow(PASS_KEY);
    await submit(pass2);
    await insertPass(A, clipId, 3);
    expect(await passNumbers(clipId, A)).toEqual([1, 2, 3]);

    const skipped = await newClip();
    await submit(await firstPass(A, skipped));
    await expect(insertPass(A, skipped, 3)).rejects.toThrow(NOT_SUBMITTED);
  });

  test('a pass number below 1 is not storable', async () => {
    const clipId = await newClip();
    await expect(insertPass(A, clipId, 0)).rejects.toThrow('pilot_calibration_sets_pass_number_positive');
  });

  test('a pass keeps its number, and a later pass keeps its annotator and clip', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    const renumber = (set: SetRef, to: number) => db.query(
      'update pilot.calibration_annotation_sets set pass_number = $3 where organization_id = $1 and annotation_set_id = $2',
      [ORG_ID, set.setId, to],
    );
    await expect(renumber(pass2, 5)).rejects.toThrow(PASS_FIXED);
    await expect(renumber(pass1, 5)).rejects.toThrow(PASS_FIXED);
    const fresh = await firstPass(A, await newClip());
    await expect(renumber(fresh, 2)).rejects.toThrow(PASS_FIXED);

    await expect(db.query(
      'update pilot.calibration_annotation_sets set annotator_account_id = $3 where organization_id = $1 and annotation_set_id = $2',
      [ORG_ID, pass2.setId, B],
    )).rejects.toThrow(PASS_FIXED);
    await expect(db.query(
      'update pilot.calibration_annotation_sets set calibration_clip_id = $3 where organization_id = $1 and annotation_set_id = $2',
      [ORG_ID, pass2.setId, fresh.clipId],
    )).rejects.toThrow(PASS_FIXED);
    expect(await passNumbers(clipId, A)).toEqual([1, 2]);
  });

  test('deleting the clip removes every pass, submitted or not', async () => {
    const { clipId, pass2 } = await clipWithRemark();
    await punch(pass2);
    await db.query(
      'delete from pilot.calibration_clips where organization_id = $1 and calibration_clip_id = $2',
      [ORG_ID, clipId],
    );
    expect(await passNumbers(clipId, A)).toEqual([]);
  });
});

describe('while a later pass exists, its annotator reads nothing of the earlier one', () => {
  test('the set lookup says so in one read, per annotator, per clip and per organization', async () => {
    const { pass1, pass2 } = await clipWithRemark();
    const superseded = async (set: SetRef) =>
      (await annotations.getAnnotationSet(set.orgId, set.setId))?.superseded_by_later_pass;
    expect([await superseded(pass1), await superseded(pass2)]).toEqual([true, false]);

    // Another annotator's first pass on the same clip, A's first pass on
    // another clip, and another organization's first pass: none superseded.
    const sibling = await firstPass(B, pass1.clipId);
    const elsewhere = await firstPass(A, await newClip());
    const foreign = await firstPass(
      OTHER_A,
      await newClip({ orgId: OTHER_ORG_ID, videoId: OTHER_VIDEO_ID, projectId: OTHER_PROJECT_ID, creator: OTHER_A }),
      V01,
      OTHER_ORG_ID,
    );
    expect([await superseded(sibling), await superseded(elsewhere), await superseded(foreign)])
      .toEqual([false, false, false]);
  });

  test('the gate every set-id route passes through answers "not found" for the earlier pass', async () => {
    const { pass1, pass2 } = await clipWithRemark();
    await expect(gate.loadOwnAnnotationSet(principal(A), pass1.setId)).rejects.toThrow(NOT_FOUND);
    expect((await gate.loadOwnAnnotationSet(principal(A), pass2.setId)).annotation_set_id).toBe(pass2.setId);

    // Still so once the later pass is submitted: it never comes back.
    await submit(pass2);
    await expect(gate.loadOwnAnnotationSet(principal(A), pass1.setId)).rejects.toThrow(NOT_FOUND);
  });

  test('the workspace read by clip returns the later pass and its events, never the earlier one\'s', async () => {
    const { clipId, pass1, pass2, event1 } = await clipWithRemark();
    const own = await gate.findOwnAnnotationSetForClip(principal(A), clipId);
    expect(own?.annotation_set_id).toBe(pass2.setId);
    expect(own?.pass_number).toBe(2);

    const events = await annotations.listAnnotationEvents(ORG_ID, own!.annotation_set_id);
    expect(events).toEqual([]);
    expect(events.map((event) => event.event_id)).not.toContain(event1);
    expect(own?.annotation_set_id).not.toBe(pass1.setId);
  });

  test('before any later pass, the gate and the workspace read behave as they always did', async () => {
    const clipId = await newClip();
    const only = await firstPass(A, clipId);
    expect((await gate.loadOwnAnnotationSet(principal(A), only.setId)).annotation_set_id).toBe(only.setId);
    expect((await gate.findOwnAnnotationSetForClip(principal(A), clipId))?.annotation_set_id).toBe(only.setId);
    await expect(gate.loadOwnAnnotationSet(principal(B), only.setId)).rejects.toThrow(NOT_FOUND);
    expect(await gate.findOwnAnnotationSetForClip(principal(B), clipId)).toBeNull();
  });

  test('the blinded reads omit the earlier pass: by list, by id, and its events', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    const other = await firstPass(B, clipId);
    await punch(other);
    await submit(other);

    // A, part-way through pass 2: their own pass 2 and nothing else -- not
    // pass 1, and not B's finished reading either.
    const listed = await blinding.listAnnotationSetsForAnnotator(reader(A), clipId);
    expect(listed.map((set) => set.annotation_set_id)).toEqual([pass2.setId]);
    expect(await blinding.getAnnotationSetForAnnotator(reader(A), pass1.setId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(reader(A), pass1.setId)).toBeNull();
    expect(await blinding.getAnnotationSetForAnnotator(reader(A), other.setId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(reader(A), pass2.setId)).toEqual([]);

    // Once pass 2 is submitted A may read B's first pass again, and still
    // never their own pass 1.
    await submit(pass2);
    const after = await blinding.listAnnotationSetsForAnnotator(reader(A), clipId);
    expect(after.map((set) => set.annotation_set_id).sort()).toEqual([pass2.setId, other.setId].sort());
    expect(await blinding.getAnnotationSetForAnnotator(reader(A), pass1.setId)).toBeNull();
  });
});

describe('a second annotator\'s blinding is unchanged', () => {
  test('B, in progress, sees only their own set while A holds one pass or two', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    const other = await firstPass(B, clipId);
    const listed = await blinding.listAnnotationSetsForAnnotator(reader(B), clipId);
    expect(listed.map((set) => set.annotation_set_id)).toEqual([other.setId]);
    expect(await blinding.getAnnotationSetForAnnotator(reader(B), pass1.setId)).toBeNull();
    expect(await blinding.getAnnotationSetForAnnotator(reader(B), pass2.setId)).toBeNull();
  });

  test('B, submitted, reads A\'s submitted first pass and never A\'s repeat pass', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    const other = await firstPass(B, clipId);
    await submit(other);
    await submit(pass2);

    const listed = await blinding.listAnnotationSetsForAnnotator(reader(B), clipId);
    expect(listed.map((set) => set.annotation_set_id).sort()).toEqual([pass1.setId, other.setId].sort());
    expect(await blinding.getAnnotationSetForAnnotator(reader(B), pass2.setId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(reader(B), pass2.setId)).toBeNull();
    await expect(gate.loadOwnAnnotationSet(principal(B), pass2.setId)).rejects.toThrow(NOT_FOUND);
  });
});

describe('readers that compare people read first passes only', () => {
  test('two passes by one person are not a pair for adjudication', async () => {
    const { clipId, pass2 } = await clipWithRemark();
    await submit(pass2);
    await expect(blinding.listAnnotationSetsForAdjudication(adjudicatorContext(), clipId))
      .rejects.toMatchObject({ reason: 'insufficient_sets_for_comparison' });
  });

  test('an open repeat pass keeps the clip closed to adjudication', async () => {
    const { clipId } = await clipWithRemark();
    await submit(await firstPass(B, clipId));
    await expect(blinding.listAnnotationSetsForAdjudication(adjudicatorContext(), clipId))
      .rejects.toMatchObject({ reason: 'annotation_in_progress' });
  });

  test('once every pass is submitted the adjudicator gets the two first passes, and the repeat pass cannot be asked for', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    const other = await firstPass(B, clipId);
    await submit(other);
    await punch(pass2);
    await submit(pass2);

    const sets = await blinding.listAnnotationSetsForAdjudication(adjudicatorContext(), clipId);
    expect(sets.map((set) => set.annotation_set_id).sort()).toEqual([pass1.setId, other.setId].sort());
    expect(await blinding.listAnnotationEventsForAdjudication(adjudicatorContext(), clipId, pass2.setId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAdjudication(adjudicatorContext(), clipId, pass1.setId)).toHaveLength(1);

    // The person who re-marked is still an annotator of the clip.
    await expect(blinding.listAnnotationSetsForAdjudication(adjudicatorContext(A), clipId))
      .rejects.toMatchObject({ reason: 'adjudicator_annotated_this_clip' });
  });

  test('the database refuses an adjudication that names a repeat pass, and accepts one between first passes', async () => {
    const { clipId, pass1, pass2, event1 } = await clipWithRemark();
    const other = await firstPass(B, clipId);
    const otherEvent = await punch(other);
    await submit(other);
    const event2 = await punch(pass2);
    await submit(pass2);

    const record = (setA: SetRef, eventA: string, setB: SetRef, eventB: string) => adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: clipId,
      annotationSetIdA: setA.setId,
      annotationSetIdB: setB.setId,
      sourceEventIdA: eventA,
      sourceEventIdB: eventB,
      resolutionType: 'accept_a',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: V01,
      expectedCurrentRevision: 0,
    });

    await expect(record(pass1, event1, pass2, event2)).rejects.toThrow('CALIBRATION_ADJUDICATION_NOT_FIRST_PASS');
    await expect(record(pass2, event2, other, otherEvent)).rejects.toThrow('CALIBRATION_ADJUDICATION_NOT_FIRST_PASS');
    await record(pass1, event1, other, otherEvent);
    expect(await adjudication.listAdjudicationsForClip(ORG_ID, clipId)).toHaveLength(1);
  });

  test('the agreement report loads with a re-marked clip in the study and does not count it as two readings', async () => {
    const projectId = await newProject();

    // Clip 1: A twice, nobody else. Clip 2: A twice and B once.
    const lone = await newClip({ projectId });
    const loneFirst = await firstPass(A, lone);
    await submit(loneFirst);
    await submit(await insertPass(A, lone, 2));

    const paired = await newClip({ projectId });
    const first = await firstPass(A, paired);
    await punch(first);
    await submit(first);
    const second = await insertPass(A, paired, 2);
    await punch(second);
    await submit(second);
    const other = await firstPass(B, paired);
    await punch(other);
    await submit(other);

    const result = await qaReportLoader.loadCalibrationQaReport(ORG_ID, projectId);
    expect(result?.report.clipProgress).toMatchObject({
      totalClips: 2,
      clipsAwaitingSecondAnnotator: 1,
      clipsReadyToCompare: 1,
    });
    expect(result?.report.comparisonCount).toBe(1);
    expect(result?.excludedClips).toEqual({
      readingInProgress: 0,
      noRecordedPair: 0,
      pairNotEstablished: 0,
      notComparable: 0,
    });
  });

  test('coverage does not move when a coach re-marks a clip, and does when a second coach labels it', async () => {
    const clipId = await newClip();
    const first = await firstPass(A, clipId);
    await punch(first);
    await submit(first);
    const before = await coverage.readTeachShadowCoverage(ORG_ID);

    const second = await insertPass(A, clipId, 2);
    await punch(second);
    await submit(second);
    expect(await coverage.readTeachShadowCoverage(ORG_ID)).toEqual(before);

    const other = await firstPass(B, clipId);
    await punch(other);
    await submit(other);
    const after = await coverage.readTeachShadowCoverage(ORG_ID);
    expect(after.labelling.submitted_sets).toBe(before.labelling.submitted_sets + 1);
    expect(after.labelling.clips_with_two_submitted_sets).toBe(before.labelling.clips_with_two_submitted_sets + 1);
  });
});

describe('each pass keeps its own body-point data', () => {
  test('moments, points and stance labels of one pass are not on the other, and the earlier pass\'s are out of the annotator\'s reach', async () => {
    const clipId = await newClip();
    const pass1 = await firstPass(A, clipId, V04);
    await completeEvent(pass1, await punch(pass1));
    await submit(pass1);
    const pass2 = await insertPass(A, clipId, 2, { version: V04 });
    const event2 = await punch(pass2);

    const first = await bodyPoints.listBodyDataForSet(ORG_ID, pass1.setId);
    const second = await bodyPoints.listBodyDataForSet(ORG_ID, pass2.setId);
    expect([first.moments.length, first.stance_labels.length]).toEqual([3, 1]);
    expect([second.moments, second.stance_labels]).toEqual([[], []]);

    await completeEvent(pass2, event2);
    const secondAfter = await bodyPoints.listBodyDataForSet(ORG_ID, pass2.setId);
    expect(secondAfter.moments.every((moment) => moment.annotation_set_id === pass2.setId)).toBe(true);
    expect(secondAfter.moments.map((moment) => moment.event_id)).toEqual([event2, event2, event2]);
    // Marking pass 2 changed nothing on pass 1.
    expect(await bodyPoints.listBodyDataForSet(ORG_ID, pass1.setId)).toEqual(first);

    // The body-points routes resolve their set through the gate first.
    await expect(gate.loadOwnAnnotationSet(principal(A), pass1.setId)).rejects.toThrow(NOT_FOUND);
    expect(await annotations.submitAnnotationSet(ORG_ID, pass2.setId)).not.toBeNull();
  });
});

describe('organization isolation is unchanged', () => {
  test('another organization reads neither pass, and passes there stand on their own', async () => {
    const { clipId, pass1, pass2 } = await clipWithRemark();
    for (const set of [pass1, pass2]) {
      expect(await annotations.getAnnotationSet(OTHER_ORG_ID, set.setId)).toBeNull();
      await expect(gate.loadOwnAnnotationSet(principal(A, OTHER_ORG_ID), set.setId)).rejects.toThrow(NOT_FOUND);
      expect(await blinding.getAnnotationSetForAnnotator(reader(A, OTHER_ORG_ID), set.setId)).toBeNull();
    }
    expect(await annotations.listAnnotationSetsForClip(OTHER_ORG_ID, clipId)).toEqual([]);

    // A submitted pass 1 in ORG does not let the other organization open a
    // pass 2 on its own clip.
    const foreignClip = await newClip({
      orgId: OTHER_ORG_ID, videoId: OTHER_VIDEO_ID, projectId: OTHER_PROJECT_ID, creator: OTHER_A,
    });
    await expect(insertPass(OTHER_A, foreignClip, 2, { orgId: OTHER_ORG_ID })).rejects.toThrow(NOT_SUBMITTED);
  });
});

describe('opening the next pass through the application', () => {
  const open = (annotator: string, clipId: string, version: string = V01, orgId: string = ORG_ID) =>
    annotations.openNextAnnotationPass({
      organizationId: orgId,
      annotationSetId: crypto.randomUUID(),
      calibrationClipId: clipId,
      annotatorAccountId: annotator,
      ontologyVersion: version,
    });

  test('opens nothing with no earlier pass, or while the earlier pass is in progress', async () => {
    const clipId = await newClip();
    expect(await open(A, clipId)).toBeNull();
    await firstPass(A, clipId);
    expect(await open(A, clipId)).toBeNull();
    expect(await passNumbers(clipId, A)).toEqual([1]);
  });

  test('opens pass 2 once pass 1 is submitted, then pass 3 only once pass 2 is', async () => {
    const clipId = await newClip();
    await submit(await firstPass(A, clipId));

    const second = await open(A, clipId);
    expect(second).toMatchObject({
      organization_id: ORG_ID,
      calibration_clip_id: clipId,
      annotator_account_id: A,
      ontology_version: V01,
      status: 'in_progress',
      pass_number: 2,
      submitted_at: null,
    });
    expect(await open(A, clipId)).toBeNull();
    expect(await passNumbers(clipId, A)).toEqual([1, 2]);

    expect(await annotations.submitAnnotationSet(ORG_ID, second!.annotation_set_id)).not.toBeNull();
    expect((await open(A, clipId))?.pass_number).toBe(3);
    expect(await passNumbers(clipId, A)).toEqual([1, 2, 3]);
  });

  test('two requests at once open one pass between them', async () => {
    const clipId = await newClip();
    await submit(await firstPass(A, clipId));

    const results = await Promise.all([open(A, clipId), open(A, clipId), open(A, clipId)]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(await passNumbers(clipId, A)).toEqual([1, 2]);
  });

  test('another annotator\'s submitted pass, or another organization, opens nothing', async () => {
    const clipId = await newClip();
    await submit(await firstPass(B, clipId));
    expect(await open(A, clipId)).toBeNull();
    expect(await open(B, clipId, V01, OTHER_ORG_ID)).toBeNull();
    expect(await passNumbers(clipId, A)).toEqual([]);
    expect(await passNumbers(clipId, B)).toEqual([1]);
  });

  test('the new pass starts empty, and from that moment the earlier pass is out of its annotator\'s reach', async () => {
    const clipId = await newClip();
    const pass1 = await firstPass(A, clipId, V04);
    await completeEvent(pass1, await punch(pass1));
    await submit(pass1);
    expect((await gate.loadOwnAnnotationSet(principal(A), pass1.setId)).annotation_set_id).toBe(pass1.setId);

    const second = await open(A, clipId, V04);

    expect(await annotations.listAnnotationEvents(ORG_ID, second!.annotation_set_id)).toEqual([]);
    const body = await bodyPoints.listBodyDataForSet(ORG_ID, second!.annotation_set_id);
    expect([body.moments, body.stance_labels]).toEqual([[], []]);
    await expect(gate.loadOwnAnnotationSet(principal(A), pass1.setId)).rejects.toThrow(NOT_FOUND);
    expect((await gate.findOwnAnnotationSetForClip(principal(A), clipId))?.annotation_set_id)
      .toBe(second!.annotation_set_id);
    // Pass 1's own rows are untouched.
    expect((await bodyPoints.listBodyDataForSet(ORG_ID, pass1.setId)).moments).toHaveLength(3);
  });
});
