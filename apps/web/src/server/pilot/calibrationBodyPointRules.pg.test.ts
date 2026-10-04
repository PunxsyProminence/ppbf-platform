// Real PostgreSQL-backed test for the body-point rules (TEACH-BIOMECH-01-c).
//
// Every claim here is database behaviour, because every rule lives in the
// database:
//
//   * a 0.2 event carries one stance-type label, on its actor; a 0.1 set
//     never holds one
//   * a 0.2 event row has no 0.1 stance and no peak, and a punch has a
//     contact time exactly when its result made contact
//   * a set holding an event cannot change vocabulary
//   * a 0.2 set cannot be submitted incomplete, and the refusal names what is
//     missing; a 0.1 set submits as before
//   * a submitted set's stance labels are frozen, and deleting the footage,
//     clip, set, event or organization still removes them
//   * a submission waits for an uncommitted writer instead of passing unseen
//   * every vocabulary in the SQL is exactly the ontology.ts array
//   * the same rules hold for 0.3, which needs its 25 points (solar_plexus
//     included) at each moment while 0.2 still needs exactly its 24
//   * and for 0.4, which needs its 23 (no ankles); a re-run on a database
//     holding the 0.3 rules reaches 0.4
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-body-rules-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_body_rules';

const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-body-point-rules-migration.mjs',
);

const PREREQUISITE_SQL = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_calibration_projects_migration.sql',
  'pilot_slice_postgres_calibration_annotations_migration.sql',
  'pilot_slice_postgres_calibration_body_points_migration.sql',
];
const RULES_SQL = 'pilot_slice_postgres_calibration_body_point_rules_migration.sql';

const ORG_ID = 'org-rules';
const ANNOTATOR = 'acct-rules-annotator';
const VIDEO_ID = 'vs-rules-ready';
const V01 = 'boxing-ontology-0.1';
const V02 = 'boxing-ontology-0.2';
const V03 = 'boxing-ontology-0.3';
const V04 = 'boxing-ontology-0.4';

/** The rules as they stood before boxing-ontology-0.4: no 0.4 in any version
 * list and no 0.4 count. Stands in for a database the migration reached
 * before 0.4 existed. */
function asBefore04(sql: string): string {
  return sql.replaceAll(`, '${V04}'`, '').replace(`\n    when '${V04}' then 23`, '');
}

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
    name: 'Body point rules study',
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
  version: string;
}

/** A fresh clip and an in-progress set on it, under the given vocabulary. */
async function newSet(
  version: string = V02,
  { orgId = ORG_ID, videoId = VIDEO_ID, projectId = PROJECT_ID } = {},
): Promise<SetRef> {
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
  const setId = crypto.randomUUID();
  await annotations.openAnnotationSet({
    organizationId: orgId,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId: ANNOTATOR,
    ontologyVersion: version,
  });
  return { orgId, setId, clipId, version };
}

/** An event written straight to the table, so only the database judges it.
 * Defaults: a landed punch at EV_CONTACT. */
async function insertEvent(set: SetRef, fields: Record<string, unknown> = {}, client: Client = db): Promise<string> {
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
  await client.query(
    `insert into pilot.calibration_annotation_events (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
  return row.event_id as string;
}

const DEFENSE = {
  event_class: 'defense',
  actor_track: 'blue',
  contact_ms: null,
  physical_hand: null,
  hand_role: null,
  punch_type: null,
  target_zone: null,
  contact_result: null,
  defense_type: 'slip',
};

async function insertStanceLabel(set: SetRef, eventId: string, stanceType = 'usa_boxing__classic', client: Client = db): Promise<void> {
  await client.query(
    `insert into pilot.calibration_event_stance_labels
       (organization_id, annotation_set_id, event_id, stance_type)
     values ($1, $2, $3, $4)`,
    [set.orgId, set.setId, eventId, stanceType],
  );
}

interface CompleteOptions {
  middleKind?: string;
  middleMs?: number;
  stance?: boolean;
  skipSlot?: string;
  nullLeadSideAt?: string;
  nullGuardAt?: string;
  pointsAtStart?: number;
  /** The points at every moment; defaults to the set's version's list. */
  points?: readonly string[];
}

/** Stance label, three moments and the version's points on each: everything
 * submission requires, unless an option leaves one piece out. */
async function completeEvent(set: SetRef, eventId: string, options: CompleteOptions = {}): Promise<Record<string, string>> {
  if (options.stance !== false) {
    await insertStanceLabel(set, eventId);
  }
  const slots: Array<[string, string, number]> = [
    ['start', 'start', EV_START],
    ['middle', options.middleKind ?? 'contact', options.middleMs ?? EV_CONTACT],
    ['end', 'end', EV_END],
  ];
  const momentIds: Record<string, string> = {};
  for (const [slot, kind, observationMs] of slots) {
    if (slot === options.skipSlot) continue;
    const momentId = crypto.randomUUID();
    momentIds[slot] = momentId;
    await db.query(
      `insert into pilot.calibration_body_moments
         (organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
          event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms, lead_side, guard_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        set.orgId, momentId, set.setId, set.clipId, eventId, EV_START, EV_END, slot, kind, observationMs,
        options.nullLeadSideAt === slot ? null : 'orthodox',
        options.nullGuardAt === slot ? null : 'usa_boxing__high_double_guard',
      ],
    );
    const points = options.points
      ?? ontology.BODY_POINTS_BY_VERSION[set.version as keyof typeof ontology.BODY_POINTS_BY_VERSION];
    const codes = slot === 'start' ? points.slice(0, options.pointsAtStart ?? points.length) : points;
    await db.query(
      `insert into pilot.calibration_body_points
         (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
       select $1, gen_random_uuid()::text, $2, $3, code, 'placed', 0.5, 0.5
         from unnest($4::text[]) as code`,
      [set.orgId, set.setId, momentId, codes],
    );
  }
  return momentIds;
}

async function submit(set: SetRef, client: Client = db): Promise<void> {
  await client.query(
    `update pilot.calibration_annotation_sets set status = 'submitted', submitted_at = now()
      where organization_id = $1 and annotation_set_id = $2`,
    [set.orgId, set.setId],
  );
}

async function statusOf(set: SetRef): Promise<string> {
  const result = await db.query<{ status: string }>(
    'select status from pilot.calibration_annotation_sets where organization_id = $1 and annotation_set_id = $2',
    [set.orgId, set.setId],
  );
  return result.rows[0]?.status;
}

async function stanceLabelCount(set: SetRef): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from pilot.calibration_event_stance_labels
      where organization_id = $1 and annotation_set_id = $2`,
    [set.orgId, set.setId],
  );
  return Number(result.rows[0].n);
}

async function functionSource(name: string): Promise<string> {
  const result = await db.query<{ def: string }>(
    `select pg_get_functiondef($1::regprocedure) as def`,
    [`pilot.${name}()`],
  );
  return result.rows[0].def;
}

function quotedValues(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]);
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
  await runner.applyMigrationTransaction(db, await readMigration(RULES_SQL));

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
     values ($1, 'coach', $2, 'microsoft')`,
    [ANNOTATOR, ORG_ID],
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
    const client = await prerequisiteDatabase('ppbf_test_calib_body_rules_unmigrated');
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_BODY_POINT_RULES_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  test('a second run is a no-op that leaves rows in place', async () => {
    const set = await newSet();
    await insertStanceLabel(set, await insertEvent(set));

    const runner = await loadRunner();
    await runner.applyMigrationTransaction(db, await readMigration(RULES_SQL));
    expect(await stanceLabelCount(set)).toBe(1);
  });

  test.each([
    ['a 0.1 stance', { stance: 'orthodox' }],
    ['a peak', { peak_ms: EV_CONTACT }],
    ['a contact time on a miss', { contact_result: 'no_contact' }],
  ])('refuses a database already holding a 0.2 event with %s', async (_label, fields) => {
    const set = await newSet();
    await db.query('alter table pilot.calibration_annotation_events disable trigger pilot_calibration_events_body_point_rules');
    let broken: string;
    try {
      broken = await insertEvent(set, fields);
    } finally {
      await db.query('alter table pilot.calibration_annotation_events enable trigger pilot_calibration_events_body_point_rules');
    }
    try {
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(db, await readMigration(RULES_SQL))).rejects.toThrow(
        'CALIBRATION_EVENTS_BREAK_0_2_RULES',
      );
    } finally {
      await db.query('delete from pilot.calibration_annotation_events where organization_id = $1 and event_id = $2', [ORG_ID, broken]);
    }
    // A 0.1 set holding the same shape does not stop it.
    await insertEvent(await newSet(V01), fields);
    await (await loadRunner()).applyMigrationTransaction(db, await readMigration(RULES_SQL));
  });

  test('a re-run on a database holding the 0.2-only rules reaches 0.3; readiness tells the two apart', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_body_rules_before_03');
    try {
      const sql = await readMigration(RULES_SQL);
      // The rules as they stood before 0.3: every 0.3 literal turned into 0.2.
      const before = asBefore04(sql).replaceAll(`'${V03}'`, `'${V02}'`);
      expect(before).not.toContain(V03);
      expect(before).not.toContain(V04);
      await client.query(before);
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_BODY_POINT_RULES_NOT_READY',
      );

      await runner.applyMigrationTransaction(client, sql);
      for (const fn of [
        'calibration_event_stance_labels_guard',
        'calibration_annotation_events_body_point_rules',
        'calibration_annotation_sets_body_point_rules',
      ]) {
        const result = await client.query<{ def: string }>(
          'select pg_get_functiondef($1::regprocedure) as def',
          [`pilot.${fn}()`],
        );
        expect(result.rows[0].def).toContain(`'${V03}'`);
      }
    } finally {
      await client.end();
    }
  });

  test('a re-run on a database holding the 0.3 rules reaches 0.4; readiness tells the two apart', async () => {
    const client = await prerequisiteDatabase('ppbf_test_calib_body_rules_before_04');
    try {
      const sql = await readMigration(RULES_SQL);
      const before = asBefore04(sql);
      expect(before).toContain(V03);
      expect(before).not.toContain(V04);
      await client.query(before);
      const runner = await loadRunner();
      await expect(runner.applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'CALIBRATION_BODY_POINT_RULES_NOT_READY',
      );

      await runner.applyMigrationTransaction(client, sql);
      for (const fn of [
        'calibration_event_stance_labels_guard',
        'calibration_annotation_events_body_point_rules',
        'calibration_annotation_sets_body_point_rules',
      ]) {
        const result = await client.query<{ def: string }>(
          'select pg_get_functiondef($1::regprocedure) as def',
          [`pilot.${fn}()`],
        );
        expect(result.rows[0].def).toContain(`'${V04}'`);
      }
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

describe('the database agrees with ontology.ts', () => {
  test('the stance-type CHECK is vocabularyCheckSql and holds exactly STANCE_TYPES', async () => {
    const name = 'pilot_calibration_event_stance_labels_stance_type_vocab';
    const source = await readMigration(RULES_SQL);
    expect(source).toContain(`constraint ${name}\n    ${ontology.vocabularyCheckSql('stance_type', ontology.STANCE_TYPES)}`);

    const live = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = to_regclass('pilot.calibration_event_stance_labels') and conname = $1`,
      [name],
    );
    expect(live.rows).toHaveLength(1);
    const values = [...live.rows[0].def.matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(values).toEqual([...ontology.STANCE_TYPES]);
  });

  test.each([
    'calibration_event_stance_labels_guard',
    'calibration_annotation_events_body_point_rules',
    'calibration_annotation_sets_body_point_rules',
  ])('%s applies to exactly BODY_POINT_ONTOLOGY_VERSIONS', async (fn) => {
    const gate = (await functionSource(fn)).match(/ontology_version not in \(([^)]*)\)|parent_version not in \(([^)]*)\)/);
    expect(gate).not.toBeNull();
    const list = (gate as RegExpMatchArray)[1] ?? (gate as RegExpMatchArray)[2];
    expect(quotedValues(list)).toEqual([...ontology.BODY_POINT_ONTOLOGY_VERSIONS]);
  });

  test('the contact-time rule lists exactly CONTACT_RESULTS_WITH_CONTACT', async () => {
    const rule = (await functionSource('calibration_annotation_events_body_point_rules'))
      .match(/new\.contact_result in \(([^)]*)\)/);
    expect(rule).not.toBeNull();
    expect(quotedValues((rule as RegExpMatchArray)[1])).toEqual([...ontology.CONTACT_RESULTS_WITH_CONTACT]);

    // The migration-time check of existing rows says the same, and so does
    // its version list.
    const source = await readMigration(RULES_SQL);
    const existing = [...source.matchAll(/e\.contact_result in \(([^)]*)\)/g)];
    expect(existing).toHaveLength(1);
    expect(quotedValues(existing[0][1])).toEqual([...ontology.CONTACT_RESULTS_WITH_CONTACT]);
    const versions = source.match(/s\.ontology_version in \(([^)]*)\)/);
    expect(quotedValues((versions as RegExpMatchArray)[1])).toEqual([...ontology.BODY_POINT_ONTOLOGY_VERSIONS]);
  });

  test('completeness asks for exactly MOMENT_SLOTS, and each version\'s BODY_POINTS_BY_VERSION length', async () => {
    const source = await functionSource('calibration_annotation_sets_body_point_rules');
    const slots = source.match(/\(values ([^)]*\)(?:, \([^)]*\))*)\) as slot/);
    expect(slots).not.toBeNull();
    expect(quotedValues((slots as RegExpMatchArray)[1])).toEqual([...ontology.MOMENT_SLOTS]);
    const counts = [...source.matchAll(/when '([^']*)' then (\d+)/g)].map((match) => [match[1], Number(match[2])]);
    expect(counts).toEqual(
      ontology.BODY_POINT_ONTOLOGY_VERSIONS.map((version) => [version, ontology.BODY_POINTS_BY_VERSION[version].length]),
    );
    expect(source).toContain('having count(p.point_code) <> expected_points');
    expect(source).toContain(`' of ' || expected_points`);
  });
});

describe('the stance type, once per event', () => {
  test('a 0.2 event takes one; it can be changed while the set is in progress', async () => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await insertStanceLabel(set, eventId);
    await db.query(
      `update pilot.calibration_event_stance_labels set stance_type = 'aiba__crouching_stance'
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, eventId],
    );
    expect(await stanceLabelCount(set)).toBe(1);
  });

  test('a 0.1 set cannot hold one', async () => {
    const set = await newSet(V01);
    const eventId = await insertEvent(set);
    await expect(insertStanceLabel(set, eventId)).rejects.toThrow('CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION');
  });

  test('a second one for the same event is refused', async () => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await insertStanceLabel(set, eventId);
    await expect(insertStanceLabel(set, eventId, 'other')).rejects.toThrow(/pilot_calibration_event_stance_labels_pkey/);
  });

  test('a stance type from outside the list is refused', async () => {
    const set = await newSet();
    await expect(insertStanceLabel(set, await insertEvent(set), 'orthodox')).rejects.toThrow(
      /pilot_calibration_event_stance_labels_stance_type_vocab/,
    );
  });

  test('a label naming an event from another set is refused', async () => {
    const set = await newSet();
    const otherSet = await newSet();
    const otherEvent = await insertEvent(otherSet);
    await expect(insertStanceLabel(set, otherEvent)).rejects.toThrow(/pilot_calibration_event_stance_labels_event_fk/);
  });

  test('a label cannot be moved to another event by update', async () => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    const otherEvent = await insertEvent(set);
    await insertStanceLabel(set, eventId);
    await expect(
      db.query(
        `update pilot.calibration_event_stance_labels set event_id = $3
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId, otherEvent],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_STANCE_LABEL_IDENTITY_FIXED');
  });

  test('the event\'s actor cannot change under a label; without one it can', async () => {
    const set = await newSet();
    const labelled = await insertEvent(set);
    await insertStanceLabel(set, labelled);
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set actor_track = 'blue'
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, labelled],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_HAS_STANCE_LABEL');

    const unlabelled = await insertEvent(set);
    await db.query(
      `update pilot.calibration_annotation_events set actor_track = 'blue'
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, unlabelled],
    );
  });

  test('a label has no column for another person', async () => {
    // Jason 2026-10-03, "1 and 3": the other boxer is marked on their own event.
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'calibration_event_stance_labels'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names.filter((name) => /opponent|subject|person|track/.test(name))).toEqual([]);
  });
});

describe('the 0.2 rules on the event row', () => {
  test('a 0.2 event with a 0.1 stance is refused; a 0.1 event keeps it', async () => {
    await expect(insertEvent(await newSet(), { stance: 'orthodox' })).rejects.toThrow(
      'CALIBRATION_EVENT_STANCE_NOT_IN_THIS_VERSION',
    );
    await insertEvent(await newSet(V01), { stance: 'orthodox' });
  });

  test('a 0.2 event with a peak is refused; a 0.1 event keeps it', async () => {
    await expect(insertEvent(await newSet(), { peak_ms: EV_CONTACT })).rejects.toThrow(
      'CALIBRATION_EVENT_PEAK_NOT_IN_THIS_VERSION',
    );
    await insertEvent(await newSet(V01), { peak_ms: EV_CONTACT });
  });

  test.each(['clean_target_contact', 'glancing_target_contact', 'guard_contact', 'non_target_contact'])(
    'a 0.2 punch with %s and no contact time is refused; 0.1 is unchanged',
    async (contactResult) => {
      await expect(
        insertEvent(await newSet(), { contact_result: contactResult, contact_ms: null }),
      ).rejects.toThrow('CALIBRATION_EVENT_CONTACT_TIME_NOT_THIS_RESULT');
      await insertEvent(await newSet(V01), { contact_result: contactResult, contact_ms: null });
    },
  );

  test.each(['no_contact', 'uncertain_contact'])(
    'a 0.2 punch with %s and a contact time is refused (it is marked at full extension); 0.1 is unchanged',
    async (contactResult) => {
      await expect(
        insertEvent(await newSet(), { contact_result: contactResult, contact_ms: EV_CONTACT }),
      ).rejects.toThrow('CALIBRATION_EVENT_CONTACT_TIME_NOT_THIS_RESULT');
      await insertEvent(await newSet(V01), { contact_result: contactResult, contact_ms: EV_CONTACT });
    },
  );

  test('the allowed shapes: contact with a time, a miss and a can\'t-tell without, a defence either way', async () => {
    const set = await newSet();
    await insertEvent(set);
    await insertEvent(set, { contact_result: 'no_contact', contact_ms: null });
    await insertEvent(set, { contact_result: 'uncertain_contact', contact_ms: null });
    await insertEvent(set, DEFENSE);
    await insertEvent(set, { ...DEFENSE, contact_ms: EV_CONTACT });
  });

  test('an update into a broken shape is refused', async () => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set contact_ms = null
          where organization_id = $1 and event_id = $2`,
        [ORG_ID, eventId],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_CONTACT_TIME_NOT_THIS_RESULT');
  });

  test('a row written before these rules can still be changed in fields they do not read', async () => {
    const set = await newSet();
    const target = await insertEvent(set);
    await db.query('alter table pilot.calibration_annotation_events disable trigger pilot_calibration_events_body_point_rules');
    let older: string;
    try {
      older = await insertEvent(set, { stance: 'orthodox', counter_against_event_id: target });
    } finally {
      await db.query('alter table pilot.calibration_annotation_events enable trigger pilot_calibration_events_body_point_rules');
    }
    await db.query(
      `update pilot.calibration_annotation_events set counter_against_event_id = null, certainty = 'probable'
        where organization_id = $1 and event_id = $2`,
      [ORG_ID, older],
    );
    await expect(
      db.query(
        `update pilot.calibration_annotation_events set peak_ms = $3 where organization_id = $1 and event_id = $2`,
        [ORG_ID, older, EV_CONTACT],
      ),
    ).rejects.toThrow('CALIBRATION_EVENT_STANCE_NOT_IN_THIS_VERSION');
  });
});

describe('a set holding an event cannot change vocabulary', () => {
  test.each([
    [V02, V01],
    [V01, V02],
    [V03, V02],
  ])('%s to %s is refused once an event exists; an empty set still can', async (from, to) => {
    const holding = await newSet(from);
    await insertEvent(holding);
    await expect(
      db.query(
        'update pilot.calibration_annotation_sets set ontology_version = $3 where organization_id = $1 and annotation_set_id = $2',
        [ORG_ID, holding.setId, to],
      ),
    ).rejects.toThrow('CALIBRATION_SET_HAS_EVENTS');

    const empty = await newSet(from);
    await db.query(
      'update pilot.calibration_annotation_sets set ontology_version = $3 where organization_id = $1 and annotation_set_id = $2',
      [ORG_ID, empty.setId, to],
    );
  });
});

describe('a 0.2, 0.3 or 0.4 set cannot be submitted incomplete', () => {
  test('a complete set submits: a landed punch and a defence', async () => {
    const set = await newSet();
    await completeEvent(set, await insertEvent(set));
    await completeEvent(set, await insertEvent(set, DEFENSE), { middleKind: 'furthest_point', middleMs: EV_CONTACT });
    await submit(set);
    expect(await statusOf(set)).toBe('submitted');
  });

  test('the module\'s own submission is held the same way', async () => {
    const set = await newSet();
    await completeEvent(set, await insertEvent(set), { pointsAtStart: 0 });
    await expect(annotations.submitAnnotationSet(ORG_ID, set.setId)).rejects.toThrow('CALIBRATION_BODY_POINTS_INCOMPLETE');
    expect(await statusOf(set)).toBe('in_progress');
  });

  test('an empty 0.2 set submits, and a 0.1 set with no body data submits as before', async () => {
    const empty = await newSet();
    await submit(empty);
    expect(await statusOf(empty)).toBe('submitted');

    const old = await newSet(V01);
    await insertEvent(old, { stance: 'orthodox', peak_ms: EV_CONTACT });
    await submit(old);
    expect(await statusOf(old)).toBe('submitted');
  });

  test.each([
    ['no stance type', { stance: false }, 'stance type'],
    ['no middle moment', { skipSlot: 'middle' }, 'middle moment'],
    ['no lead side at the end', { nullLeadSideAt: 'end' }, 'end lead side'],
    ['no guard at the start', { nullGuardAt: 'start' }, 'start guard'],
    ['23 points at the start', { pointsAtStart: 23 }, 'start points, 23 of 24'],
  ] as Array<[string, CompleteOptions, string]>)('%s is refused, and named', async (_label, options, item) => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await completeEvent(set, eventId, options);
    let detail: string | undefined;
    await submit(set).catch((error: { message: string; detail?: string }) => {
      expect(error.message).toBe('CALIBRATION_BODY_POINTS_INCOMPLETE');
      detail = error.detail;
    });
    expect(detail).toBe(`${eventId}: ${item}`);
    expect(await statusOf(set)).toBe('in_progress');
  });

  test.each([
    ['a landed punch', {}, {}],
    ['a defence', DEFENSE, { middleKind: 'furthest_point', middleMs: EV_CONTACT }],
  ] as Array<[string, Record<string, unknown>, CompleteOptions]>)(
    'a complete 0.3 set submits: %s with 25 points at each moment, solar_plexus among them',
    async (_label, fields, options) => {
      const set = await newSet(V03);
      await completeEvent(set, await insertEvent(set, fields), options);
      const held = await db.query<{ point_code: string; n: string }>(
        `select point_code, count(*)::text as n from pilot.calibration_body_points
          where organization_id = $1 and annotation_set_id = $2 group by point_code`,
        [ORG_ID, set.setId],
      );
      expect(held.rows).toHaveLength(25);
      expect(held.rows.find((row) => row.point_code === 'solar_plexus')?.n).toBe('3');
      await submit(set);
      expect(await statusOf(set)).toBe('submitted');
    },
  );

  test('a 0.3 set holding only 0.2\'s 24 points is refused, each moment named', async () => {
    const set = await newSet(V03);
    const eventId = await insertEvent(set);
    await completeEvent(set, eventId, { points: ontology.BODY_POINTS_BY_VERSION[V02] });
    let detail: string | undefined;
    await submit(set).catch((error: { message: string; detail?: string }) => {
      expect(error.message).toBe('CALIBRATION_BODY_POINTS_INCOMPLETE');
      detail = error.detail;
    });
    expect(detail?.split('; ')).toEqual(
      ['end', 'middle', 'start'].map((slot) => `${eventId}: ${slot} points, 24 of 25`),
    );
    expect(await statusOf(set)).toBe('in_progress');
  });

  test('a 0.3 set one point short at the start is refused as 24 of 25', async () => {
    const set = await newSet(V03);
    const eventId = await insertEvent(set);
    await completeEvent(set, eventId, { pointsAtStart: 24 });
    let detail: string | undefined;
    await submit(set).catch((error: { detail?: string }) => {
      detail = error.detail;
    });
    expect(detail).toBe(`${eventId}: start points, 24 of 25`);
  });

  test.each([
    ['a landed punch', {}, {}],
    ['a defence', DEFENSE, { middleKind: 'furthest_point', middleMs: EV_CONTACT }],
  ] as Array<[string, Record<string, unknown>, CompleteOptions]>)(
    'a complete 0.4 set submits: %s with 23 points at each moment, no ankle among them',
    async (_label, fields, options) => {
      const set = await newSet(V04);
      await completeEvent(set, await insertEvent(set, fields), options);
      const held = await db.query<{ point_code: string; n: string }>(
        `select point_code, count(*)::text as n from pilot.calibration_body_points
          where organization_id = $1 and annotation_set_id = $2 group by point_code`,
        [ORG_ID, set.setId],
      );
      expect(held.rows).toHaveLength(23);
      expect(held.rows.map((row) => row.point_code)).not.toEqual(expect.arrayContaining(['left_ankle']));
      expect(held.rows.map((row) => row.point_code)).not.toEqual(expect.arrayContaining(['right_ankle']));
      expect(held.rows.every((row) => row.n === '3')).toBe(true);
      await submit(set);
      expect(await statusOf(set)).toBe('submitted');
    },
  );

  test('a 0.4 set one point short at the start is refused as 22 of 23', async () => {
    const set = await newSet(V04);
    const eventId = await insertEvent(set);
    await completeEvent(set, eventId, { pointsAtStart: 22 });
    let detail: string | undefined;
    await submit(set).catch((error: { message: string; detail?: string }) => {
      expect(error.message).toBe('CALIBRATION_BODY_POINTS_INCOMPLETE');
      detail = error.detail;
    });
    expect(detail).toBe(`${eventId}: start points, 22 of 23`);
    expect(await statusOf(set)).toBe('in_progress');
  });

  test('every missing item is listed', async () => {
    const set = await newSet();
    const bare = await insertEvent(set);
    let detail: string | undefined;
    await submit(set).catch((error: { detail?: string }) => {
      detail = error.detail;
    });
    expect(detail?.split('; ')).toEqual([
      `${bare}: end moment`,
      `${bare}: middle moment`,
      `${bare}: stance type`,
      `${bare}: start moment`,
    ]);
  });
});

describe('the freeze', () => {
  async function submittedSet(): Promise<{ set: SetRef; eventId: string }> {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await completeEvent(set, eventId);
    await submit(set);
    return { set, eventId };
  }

  test.each([
    ['insert a label', async ({ set }: { set: SetRef; eventId: string }) =>
      insertStanceLabel(set, await insertEventIgnoringFreeze(set))],
    ['update a label', async ({ eventId }: { set: SetRef; eventId: string }) =>
      db.query(`update pilot.calibration_event_stance_labels set stance_type = 'other'
                 where organization_id = $1 and event_id = $2`, [ORG_ID, eventId])],
    ['delete a label', async ({ eventId }: { set: SetRef; eventId: string }) =>
      db.query(`delete from pilot.calibration_event_stance_labels
                 where organization_id = $1 and event_id = $2`, [ORG_ID, eventId])],
  ])('a submitted set refuses: %s', async (_label, act) => {
    const fixture = await submittedSet();
    await expect(act(fixture)).rejects.toThrow('CALIBRATION_ANNOTATION_SET_SUBMITTED');
    expect(await stanceLabelCount(fixture.set)).toBe(1);
  });

  /** A second event in a submitted set, put there with the events freeze off,
   * so the label insert is refused by the label's own freeze. */
  async function insertEventIgnoringFreeze(set: SetRef): Promise<string> {
    await db.query('alter table pilot.calibration_annotation_events disable trigger pilot_calibration_events_freeze');
    try {
      return await insertEvent(set);
    } finally {
      await db.query('alter table pilot.calibration_annotation_events enable trigger pilot_calibration_events_freeze');
    }
  }

  test.each([
    ['the clip', 'delete from pilot.calibration_clips where organization_id = $1 and calibration_clip_id = $2', 'clipId'],
    ['the set', 'delete from pilot.calibration_annotation_sets where organization_id = $1 and annotation_set_id = $2', 'setId'],
  ] as const)('deleting %s removes a submitted set\'s stance labels', async (_label, statement, key) => {
    const { set } = await submittedSet();
    await db.query(statement, [ORG_ID, set[key]]);
    expect(await stanceLabelCount(set)).toBe(0);
  });

  test('deleting the footage removes a submitted set\'s stance labels', async () => {
    const videoId = `vs-rules-doomed-${crypto.randomUUID().slice(0, 8)}`;
    await seedVideo(ORG_ID, videoId);
    const set = await newSet(V02, { videoId });
    await completeEvent(set, await insertEvent(set));
    await submit(set);

    await db.query('delete from pilot.video_sessions where video_session_id = $1', [videoId]);
    expect(await stanceLabelCount(set)).toBe(0);
  });

  test('deleting an in-progress event removes its label', async () => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    await insertStanceLabel(set, eventId);
    await annotations.deleteAnnotationEvent(ORG_ID, set.setId, eventId);
    expect(await stanceLabelCount(set)).toBe(0);
  });

  test('deleting a whole organization removes a submitted set\'s labels; the freeze does not block it', async () => {
    // pilot.accounts does not cascade from pilot.organizations (base schema),
    // so the doomed organization's study names this suite's annotator.
    const orgId = `org-rules-doomed-${crypto.randomUUID().slice(0, 8)}`;
    const videoId = `vs-${orgId}`;
    const projectId = await seedOrganization(orgId, videoId);
    const set = await newSet(V02, { orgId, videoId, projectId });
    await completeEvent(set, await insertEvent(set));
    await submit(set);
    expect(await statusOf(set)).toBe('submitted');

    await db.query('delete from pilot.organizations where organization_id = $1', [orgId]);
    expect(await stanceLabelCount(set)).toBe(0);
  });
});

describe('two writers at once', () => {
  // The writer holds its change uncommitted; the racing statement must wait
  // for it (and here, time out) rather than pass its check without seeing it.
  async function racing(sql: string, params: unknown[]): Promise<void> {
    const other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await other.connect();
    try {
      await other.query("set lock_timeout = '2s'");
      await other.query(sql, params);
    } finally {
      await other.end();
    }
  }

  const SUBMIT = `update pilot.calibration_annotation_sets set status = 'submitted', submitted_at = now()
                   where organization_id = $1 and annotation_set_id = $2`;

  test.each([
    ['a point delete', `delete from pilot.calibration_body_points
       where organization_id = $1 and body_moment_id = $2 and point_code = 'nose'`, 'moment'],
    ['a moment delete', `delete from pilot.calibration_body_moments
       where organization_id = $1 and body_moment_id = $2`, 'moment'],
    ['a stance label delete', `delete from pilot.calibration_event_stance_labels
       where organization_id = $1 and event_id = $2`, 'event'],
    ['an event delete', `delete from pilot.calibration_annotation_events
       where organization_id = $1 and event_id = $2`, 'event'],
  ] as const)('a submission waits for an uncommitted %s', async (_label, sql, target) => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    const momentIds = await completeEvent(set, eventId);
    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    try {
      await writer.query('begin');
      await writer.query(sql, [ORG_ID, target === 'moment' ? momentIds.end : eventId]);
      await expect(racing(SUBMIT, [ORG_ID, set.setId])).rejects.toThrow(/lock timeout/);
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end();
    }
    expect(await statusOf(set)).toBe('in_progress');
  });

  test.each([
    ['a submission', SUBMIT],
    ['a vocabulary change', `update pilot.calibration_annotation_sets set ontology_version = '${V01}'
       where organization_id = $1 and annotation_set_id = $2`],
  ])('%s waits for an uncommitted event insert', async (_label, sql) => {
    const set = await newSet();
    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    try {
      await writer.query('begin');
      await insertEvent(set, {}, writer);
      await expect(racing(sql, [ORG_ID, set.setId])).rejects.toThrow(/lock timeout/);
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end();
    }
  });

  test.each([
    ['a submission', SUBMIT, 'set'],
    ['the event\'s actor', `update pilot.calibration_annotation_events set actor_track = 'blue'
       where organization_id = $1 and event_id = $2`, 'event'],
  ] as const)('%s waits for an uncommitted stance label insert', async (_label, sql, target) => {
    const set = await newSet();
    const eventId = await insertEvent(set);
    const writer = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await writer.connect();
    try {
      await writer.query('begin');
      await insertStanceLabel(set, eventId, 'other', writer);
      await expect(racing(sql, [ORG_ID, target === 'set' ? set.setId : eventId])).rejects.toThrow(/lock timeout/);
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end();
    }
  });
});
