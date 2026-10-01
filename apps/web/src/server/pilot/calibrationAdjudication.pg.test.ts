// Real PostgreSQL-backed test for adjudication.
//
// What needs proving here, and cannot be proved by a mock:
//
//   * an adjudication REFERENCES the two readings and never alters them --
//     asserted by reading both source events byte-for-byte before and after
//   * the adjudication and its field decisions are ONE transaction, so a row
//     claiming 'new_adjudicated_value' can never exist without the values it
//     claims to carry
//   * a source event cannot be filed under the wrong annotator's set
//   * a verdict must be answerable from the events actually present
//   * deleting the footage still takes the adjudication with it
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-adj-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_adj';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-adjudication-migration.mjs',
);

const BASE_SQL = 'pilot_slice_postgres.sql';
// athletes.deleted_at. Deletion scope B makes the readers this suite drives
// leave a deleted athlete's rows out, and production has had the column since
// the data-retention migration; a database without it is one that never existed.
const RETENTION_SQL = 'pilot_slice_postgres_data_retention_deletion_migration.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
/* Applied because these suites now seed a recording session and a take: a
   study cuts its clips from teaching footage, and assertVideoClippable
   refuses anything else. It also adds capture_take_id to pilot.video_sessions,
   so it must run after the video-sessions migration, never before. */
const CAPTURE_SESSIONS_SQL = 'pilot_slice_postgres_capture_sessions_migration.sql';
const PROJECTS_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';
const ADJUDICATION_SQL = 'pilot_slice_postgres_calibration_adjudication_migration.sql';
const REVISIONS_SQL = 'pilot_slice_postgres_calibration_adjudication_revisions_migration.sql';
const REVISIONS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-adjudication-revisions-migration.mjs',
);
const PAIR_REVISION_CONSTRAINT = 'pilot_calibration_adjudications_decision_revision_uq';

const ORG_ID = 'org-adj';
const OTHER_ORG_ID = 'org-adj-other';
const ANNOTATOR_A = 'acct-adj-a';
const ANNOTATOR_B = 'acct-adj-b';
const ADJUDICATOR = 'acct-adj-reviewer';
const VIDEO_ID = 'vs-adj-ready';
const CLIP_START_MS = 0;
const CLIP_END_MS = 20_000;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let adjudication: typeof import('./calibration/adjudication');
let annotations: typeof import('./calibration/annotations');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');
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

async function freshClient(): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  return client;
}

async function runnerDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const file of [BASE_SQL, RETENTION_SQL, VIDEO_SESSIONS_SQL, CAPTURE_SESSIONS_SQL, PROJECTS_SQL, ANNOTATIONS_SQL]) {
    await client.query(await readMigration(file));
  }
  return client;
}

async function seedTenancy(client: Client): Promise<void> {
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  for (const accountId of [ANNOTATOR_A, ANNOTATOR_B, ADJUDICATOR]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [accountId, ORG_ID],
    );
  }
  /* Teaching footage: assertVideoClippable refuses a video with no capture
     take, because only footage recorded to teach Shadow may become evidence a
     recognizer is taught from. These fixtures predate takes; a study cuts its
     clips from teaching footage, so this is the accurate description, not a
     way around the guard. seedCaptureTake is idempotent. */
  const take = await seedCaptureTake(client, { organizationId: ORG_ID, createdByAccountId: ANNOTATOR_A });
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status,
        recording_session_id, capture_take_id)
     values ($1, $2, $3, null, 'Sparring', 'p/adj.mp4', 'adj.mp4', 2048, 'video/mp4', 'ready', $4, $5)
     on conflict do nothing`,
    [VIDEO_ID, ORG_ID, ANNOTATOR_A, take.recordingSessionId, take.captureTakeId],
  );
}

/** A clip with two submitted sets, one event each, ready to adjudicate. */
async function stagedDisagreement(code: string, videoId = VIDEO_ID) {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId: ORG_ID,
    calibrationClipId: clipId,
    calibrationProjectId: PROJECT_ID,
    videoSessionId: videoId,
    clipCode: code,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: ANNOTATOR_A,
  });

  const made: Record<string, string> = {};
  const events: Record<string, string> = {};
  for (const [key, annotator, punchType] of [
    ['a', ANNOTATOR_A, 'lead_straight'],
    ['b', ANNOTATOR_B, 'lead_hook'],
  ] as const) {
    const setId = crypto.randomUUID();
    await annotations.openAnnotationSet({
      organizationId: ORG_ID,
      annotationSetId: setId,
      calibrationClipId: clipId,
      annotatorAccountId: annotator,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    });
    const event = await annotations.recordAnnotationEvent({
      organizationId: ORG_ID,
      eventId: crypto.randomUUID(),
      annotationSetId: setId,
      eventClass: 'punch',
      actorTrack: 'red',
      startMs: 1_000,
      endMs: 1_400,
      physicalHand: 'left',
      handRole: 'lead',
      punchType,
      targetZone: 'head',
      contactResult: 'clean_target_contact',
      visibility: 'clear',
      certainty: 'clear',
    });
    await annotations.submitAnnotationSet(ORG_ID, setId);
    made[key] = setId;
    events[key] = event.event_id;
  }

  return { clipId, setA: made.a, setB: made.b, eventA: events.a, eventB: events.b };
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  // REVISIONS_SQL last: recordAdjudication writes `revision`, so every test in
  // this file needs the superseding migration, not only the revision tests.
  for (const file of [BASE_SQL, RETENTION_SQL, VIDEO_SESSIONS_SQL, CAPTURE_SESSIONS_SQL, PROJECTS_SQL, ANNOTATIONS_SQL, ADJUDICATION_SQL, REVISIONS_SQL]) {
    await migrateClient.query(await readMigration(file));
  }
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  adjudication = await import('./calibration/adjudication');
  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: PROJECT_ID,
    name: 'Adjudication slice study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR_A,
  });
});

afterAll(async () => {
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

describe('an adjudication records a decision without altering the readings', () => {
  test('both source events are byte-identical after adjudication', async () => {
    // THE CORE CLAIM. The two readings ARE the measurement; a reviewer who
    // could edit them would be destroying the data in the act of interpreting
    // it. Asserted against the full rows, not a spot check.
    const staged = await stagedDisagreement('C-INTACT');
    const before = [
      await annotations.listAnnotationEvents(ORG_ID, staged.setA),
      await annotations.listAnnotationEvents(ORG_ID, staged.setB),
    ];

    await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      resolutionType: 'accept_a',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      fields: [
        {
          adjudicatedFieldId: crypto.randomUUID(),
          fieldName: 'punch_type',
          disagreementCategory: 'PUNCH_TYPE',
          resolvedFrom: 'annotator_a',
          resolvedValue: 'lead_straight',
        },
      ],
    });

    const after = [
      await annotations.listAnnotationEvents(ORG_ID, staged.setA),
      await annotations.listAnnotationEvents(ORG_ID, staged.setB),
    ];
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // B's losing reading is still there, still saying what B said.
    expect(after[1][0].punch_type).toBe('lead_hook');
  });

  test('field-level decisions round-trip with their provenance', async () => {
    const staged = await stagedDisagreement('C-FIELDS');
    const { adjudication: row } = await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      resolutionType: 'new_adjudicated_value',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      notes: 'Neither reading matched the frames.',
      fields: [
        {
          adjudicatedFieldId: crypto.randomUUID(),
          fieldName: 'punch_type',
          disagreementCategory: 'PUNCH_TYPE',
          resolvedFrom: 'adjudicator',
          resolvedValue: 'rear_hook',
        },
        {
          adjudicatedFieldId: crypto.randomUUID(),
          fieldName: 'target_zone',
          disagreementCategory: 'TARGET',
          resolvedFrom: 'annotator_b',
          resolvedValue: 'head',
        },
        {
          adjudicatedFieldId: crypto.randomUUID(),
          fieldName: 'contact_zone',
          disagreementCategory: 'CONTACT_ZONE',
          resolvedFrom: 'adjudicator',
          unresolved: true,
        },
      ],
    });

    const fields = await adjudication.listAdjudicatedFields(ORG_ID, row.adjudication_id);
    expect(fields).toHaveLength(3);

    const byName = Object.fromEntries(fields.map((field) => [field.field_name, field]));
    expect(byName.punch_type.resolved_from).toBe('adjudicator');
    expect(byName.punch_type.resolved_value).toBe('rear_hook');
    // Accepting one annotator stays distinguishable from supplying a value.
    expect(byName.target_zone.resolved_from).toBe('annotator_b');
    // Unresolved carries no value, and is not a null the caller has to guess about.
    expect(byName.contact_zone.unresolved).toBe(true);
    expect(byName.contact_zone.resolved_value).toBeNull();

    expect(row.adjudicator_account_id).toBe(ADJUDICATOR);
    expect(row.ontology_version).toBe('boxing-ontology-0.1');
    expect(row.adjudicated_at).not.toBeNull();
  });
});

describe('the adjudication and its fields are one transaction', () => {
  test('a failing field write leaves NO adjudication row behind', async () => {
    // The shape being corrected: resolveFilmStudyProposal writes its proposal
    // update and its revision row as two separate statements with no
    // transaction, so a failure between them leaves a corrected proposal with
    // no record of who corrected it. The equivalent here would be an
    // adjudication claiming 'new_adjudicated_value' with none of the values it
    // claims -- in a table a gold dataset is later built from.
    //
    // Forced by two field decisions sharing one field_name, which the
    // one-decision-per-field unique constraint refuses on the second insert.
    const staged = await stagedDisagreement('C-ATOMIC');
    const adjudicationId = crypto.randomUUID();

    await expect(
      adjudication.recordAdjudication({
        organizationId: ORG_ID,
        adjudicationId,
        calibrationClipId: staged.clipId,
        annotationSetIdA: staged.setA,
        annotationSetIdB: staged.setB,
        sourceEventIdA: staged.eventA,
        sourceEventIdB: staged.eventB,
        resolutionType: 'new_adjudicated_value',
        adjudicatorAccountId: ADJUDICATOR,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
        fields: [
          {
            adjudicatedFieldId: crypto.randomUUID(),
            fieldName: 'punch_type',
            disagreementCategory: 'PUNCH_TYPE',
            resolvedFrom: 'adjudicator',
            resolvedValue: 'rear_hook',
          },
          {
            adjudicatedFieldId: crypto.randomUUID(),
            fieldName: 'punch_type',
            disagreementCategory: 'PUNCH_TYPE',
            resolvedFrom: 'adjudicator',
            resolvedValue: 'lead_uppercut',
          },
        ],
      }),
    ).rejects.toThrow(/pilot_calibration_adjudicated_fields_uq/);

    expect(await adjudication.getAdjudication(ORG_ID, adjudicationId)).toBeNull();
    expect(await adjudication.listAdjudicatedFields(ORG_ID, adjudicationId)).toEqual([]);
  });

  test('a new_adjudicated_value with no supplied value is refused before anything is written', async () => {
    const staged = await stagedDisagreement('C-CLAIM');
    const adjudicationId = crypto.randomUUID();

    await expect(
      adjudication.recordAdjudication({
        organizationId: ORG_ID,
        adjudicationId,
        calibrationClipId: staged.clipId,
        annotationSetIdA: staged.setA,
        annotationSetIdB: staged.setB,
        sourceEventIdA: staged.eventA,
        sourceEventIdB: staged.eventB,
        resolutionType: 'new_adjudicated_value',
        adjudicatorAccountId: ADJUDICATOR,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
        fields: [],
      }),
    ).rejects.toThrow(/must record the value the adjudicator supplied/);

    expect(await adjudication.getAdjudication(ORG_ID, adjudicationId)).toBeNull();
  });

  test('an unresolved adjudicator field does not satisfy the new-value claim either', async () => {
    // "I supplied a new value" and "I could not settle it" are opposites.
    const staged = await stagedDisagreement('C-CLAIM-UNRES');
    await expect(
      adjudication.recordAdjudication({
        organizationId: ORG_ID,
        adjudicationId: crypto.randomUUID(),
        calibrationClipId: staged.clipId,
        annotationSetIdA: staged.setA,
        annotationSetIdB: staged.setB,
        sourceEventIdA: staged.eventA,
        sourceEventIdB: staged.eventB,
        resolutionType: 'new_adjudicated_value',
        adjudicatorAccountId: ADJUDICATOR,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
        fields: [
          {
            adjudicatedFieldId: crypto.randomUUID(),
            fieldName: 'punch_type',
            disagreementCategory: 'PUNCH_TYPE',
            resolvedFrom: 'adjudicator',
            unresolved: true,
          },
        ],
      }),
    ).rejects.toThrow(/must record the value the adjudicator supplied/);
  });
});

describe('a verdict must be answerable from the events present', () => {
  test('accepting A when A recorded no event is refused by the database', async () => {
    const staged = await stagedDisagreement('C-UNSUPPORTED');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, null, $6, 'accept_a', 1, $7, $8)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_adjudications_verdict_supported/);
    } finally {
      await client.end();
    }
  });

  test('an adjudication about no event at all is refused', async () => {
    const staged = await stagedDisagreement('C-NOSOURCE');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, null, null, 'unresolvable', 1, $6, $7)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_adjudications_has_source/);
    } finally {
      await client.end();
    }
  });

  test('a missed-event verdict is refused when both annotators recorded the event', async () => {
    // That vocabulary answers "did this happen at all", which is not the
    // question when both of them saw it.
    const staged = await stagedDisagreement('C-MISSED-BOTH');
    await expect(
      adjudication.recordAdjudication({
        organizationId: ORG_ID,
        adjudicationId: crypto.randomUUID(),
        calibrationClipId: staged.clipId,
        annotationSetIdA: staged.setA,
        annotationSetIdB: staged.setB,
        sourceEventIdA: staged.eventA,
        sourceEventIdB: staged.eventB,
        resolutionType: 'unresolvable',
        missedEventVerdict: 'neither_valid',
        adjudicatorAccountId: ADJUDICATOR,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      }),
    ).rejects.toThrow(/only applies where one annotator recorded no event/);
  });

  test('both_distinct is recordable, so a real event is never deleted to tidy a disagreement', async () => {
    // Two annotators may EACH have recorded a real event that were never the
    // same event. Without this verdict a reviewer's honest options would
    // misrepresent that.
    const staged = await stagedDisagreement('C-DISTINCT');
    const { adjudication: row } = await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: null,
      resolutionType: 'unresolvable',
      missedEventVerdict: 'both_distinct',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    });
    expect(row.missed_event_verdict).toBe('both_distinct');
  });

  test('an unrecognised resolution or verdict is rejected, never coerced', async () => {
    const staged = await stagedDisagreement('C-VOCAB');
    const base = {
      organizationId: ORG_ID,
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    };

    await expect(
      adjudication.recordAdjudication({
        ...base,
        adjudicationId: crypto.randomUUID(),
        resolutionType: 'split_decision' as never,
      }),
    ).rejects.toThrow(/resolution_type/);

    await expect(
      adjudication.recordAdjudication({
        ...base,
        adjudicationId: crypto.randomUUID(),
        resolutionType: 'unresolvable',
        missedEventVerdict: 'probably_real' as never,
      }),
    ).rejects.toThrow(/missed_event_verdict/);
  });
});

describe('an adjudication cannot misattribute a reading', () => {
  test("B's event cannot be filed as A's source", async () => {
    // Without the set-scoped composite key, a reviewer could file B's event
    // under A and the record would credit the observation to the wrong person.
    const staged = await stagedDisagreement('C-MISATTRIB');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, null, 'accept_a', 1, $7, $8)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_adjudications_source_a_fk/);
    } finally {
      await client.end();
    }
  });

  test('one reading cannot be adjudicated against itself', async () => {
    const staged = await stagedDisagreement('C-SELF');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $4, $5, null, 'accept_a', 1, $6, $7)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA,
            staged.eventA, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_adjudications_two_sets/);
    } finally {
      await client.end();
    }
  });

  test('an adjudication in another organization is invisible', async () => {
    const staged = await stagedDisagreement('C-TENANCY');
    const { adjudication: row } = await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      resolutionType: 'accept_a',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    });

    expect(await adjudication.getAdjudication(OTHER_ORG_ID, row.adjudication_id)).toBeNull();
    expect(await adjudication.listAdjudicatedFields(OTHER_ORG_ID, row.adjudication_id)).toEqual([]);
    expect(await adjudication.listAdjudicationsForClip(OTHER_ORG_ID, staged.clipId)).toEqual([]);
  });
});

describe('an adjudication never blocks a deletion request', () => {
  test('deleting the footage takes the adjudication and its fields with it', async () => {
    const client = await freshClient();
    try {
      // Teaching footage, like every other video these suites clip. See the
      // note in the seed.
      const doomedTake = await seedCaptureTake(client, { organizationId: ORG_ID, createdByAccountId: ANNOTATOR_A });
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
            blob_path, file_name, file_size_bytes, mime_type, status,
            recording_session_id, capture_take_id)
         values ('vs-adj-doomed', $1, $2, null, 'Doomed', 'p/d.mp4', 'd.mp4', 10, 'video/mp4', 'ready', $3, $4)`,
        [ORG_ID, ANNOTATOR_A, doomedTake.recordingSessionId, doomedTake.captureTakeId],
      );
      const staged = await stagedDisagreement('C-DOOMED', 'vs-adj-doomed');
      const { adjudication: row } = await adjudication.recordAdjudication({
        organizationId: ORG_ID,
        adjudicationId: crypto.randomUUID(),
        calibrationClipId: staged.clipId,
        annotationSetIdA: staged.setA,
        annotationSetIdB: staged.setB,
        sourceEventIdA: staged.eventA,
        sourceEventIdB: staged.eventB,
        resolutionType: 'accept_a',
        adjudicatorAccountId: ADJUDICATOR,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
        fields: [
          {
            adjudicatedFieldId: crypto.randomUUID(),
            fieldName: 'punch_type',
            disagreementCategory: 'PUNCH_TYPE',
            resolvedFrom: 'annotator_a',
            resolvedValue: 'lead_straight',
          },
        ],
      });

      await client.query(`delete from pilot.video_sessions where video_session_id = 'vs-adj-doomed'`);

      expect(await adjudication.getAdjudication(ORG_ID, row.adjudication_id)).toBeNull();
      expect(await adjudication.listAdjudicatedFields(ORG_ID, row.adjudication_id)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('the shipped migration runner', () => {
  test('REFUSES a database where the adjudication migration never ran', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_adj_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_ADJUDICATION_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_adj_ok');
    try {
      const migrationSql = await readMigration(ADJUDICATION_SQL);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});

/* OD-2026-08-29-005. Supersession, and the race the decision left open on purpose.
 *
 * The decision assigns a revision per disagreement -- the pair of MARKS a
 * decision names, inside the pair of readings -- with NO row lock, so the
 * unique index is the only arbiter. Proved against a real database rather than
 * reasoned about: that a second adjudication of the same disagreement is
 * RETAINED at the next revision rather than replacing anything, that a
 * duplicate revision is refused by the named index, that the real module,
 * racing a real concurrent writer, loses with exactly the error shape the
 * route translates, and that a DIFFERENT disagreement on the same clip is
 * neither numbered as a correction nor made to collide. */
describe('a later adjudication supersedes an earlier one without replacing it', () => {
  function decisionFor(staged: Awaited<ReturnType<typeof stagedDisagreement>>) {
    return {
      organizationId: ORG_ID,
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    };
  }

  test('revisions for one pair start at 1 and increment, and every revision is kept', async () => {
    const staged = await stagedDisagreement(`ADJ-REV-${crypto.randomUUID().slice(0, 8)}`);

    const first = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });
    expect(first.adjudication.revision).toBe(1);

    const second = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_b',
    });
    expect(second.adjudication.revision).toBe(2);

    // BOTH rows survive (OD-2026-08-29-004: "both are retained as history").
    const client = await freshClient();
    try {
      const kept = await client.query<{ revision: number; resolution_type: string; adjudication_id: string }>(
        `select revision, resolution_type, adjudication_id
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4
          order by revision asc`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(kept.rows.map((row) => row.revision)).toEqual([1, 2]);
      expect(kept.rows.map((row) => row.resolution_type)).toEqual(['accept_a', 'accept_b']);
      // The first answer is the same row it was, not a rewritten one.
      expect(kept.rows[0]?.adjudication_id).toBe(first.adjudication.adjudication_id);
    } finally {
      await client.end();
    }

    // And the reads the route serves carry the revision, so a surface can tell
    // which answer is current.
    const listed = await adjudication.listAdjudicationsForClip(ORG_ID, staged.clipId);
    expect(listed.map((row) => row.revision).sort()).toEqual([1, 2]);
    const reread = await adjudication.getAdjudication(ORG_ID, second.adjudication.adjudication_id);
    expect(reread?.revision).toBe(2);
  });

  test('a second row at the SAME pair and revision is refused by the named constraint', async () => {
    const staged = await stagedDisagreement(`ADJ-DUP-${crypto.randomUUID().slice(0, 8)}`);

    const landed = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });
    expect(landed.adjudication.revision).toBe(1);

    const client = await freshClient();
    try {
      let raised: { code?: string; constraint?: string } | null = null;
      try {
        await client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, $7, 'accept_b', 1, $8, $9)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventA, staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        );
      } catch (error) {
        raised = error as { code?: string; constraint?: string };
      }

      // Both halves matter: the route matches the code AND the name.
      expect(raised?.code).toBe('23505');
      expect(raised?.constraint).toBe(PAIR_REVISION_CONSTRAINT);
      expect(PAIR_REVISION_CONSTRAINT).toBe(adjudication.ADJUDICATION_PAIR_REVISION_CONSTRAINT);

      const surviving = await client.query<{ n: number; resolution_type: string }>(
        `select count(*)::int as n, min(resolution_type) as resolution_type
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(surviving.rows[0]?.n).toBe(1);
      expect(surviving.rows[0]?.resolution_type).toBe('accept_a');
    } finally {
      await client.end();
    }
  });

  test('THE RACE ITSELF: recordAdjudication loses to a concurrent writer with the error the route translates', async () => {
    /* The schedule the missing lock permits, driven for real rather than
     * imitated:
     *
     *   rival:   BEGIN; insert revision 1            (not committed)
     *   module:  select max(revision) -> 0           (the rival's row is invisible)
     *   module:  insert revision 1    -> WAITS on the rival's index entry
     *   rival:   COMMIT
     *   module:  23505 on pilot_calibration_adjudications_decision_revision_uq
     *
     * The commit is released only once pg_stat_activity shows a backend
     * waiting on a lock, so the order above is observed, not hoped for. */
    const staged = await stagedDisagreement(`ADJ-RACE-${crypto.randomUUID().slice(0, 8)}`);
    const losingId = crypto.randomUUID();

    const rival = await freshClient();
    const observer = await freshClient();
    try {
      await rival.query('begin');
      await rival.query(
        `insert into pilot.calibration_adjudications
           (organization_id, adjudication_id, calibration_clip_id,
            annotation_set_id_a, annotation_set_id_b,
            source_event_id_a, source_event_id_b,
            resolution_type, revision, adjudicator_account_id, ontology_version)
         values ($1, $2, $3, $4, $5, $6, $7, 'accept_b', 1, $8, $9)`,
        [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
          staged.eventA, staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
      );

      const losing = adjudication.recordAdjudication({
        ...decisionFor(staged),
        adjudicationId: losingId,
        resolutionType: 'accept_a',
        fields: [
          {
            adjudicatedFieldId: crypto.randomUUID(),
            fieldName: 'punch_type',
            disagreementCategory: 'PUNCH_TYPE',
            resolvedFrom: 'annotator_a',
            resolvedValue: 'lead_straight',
          },
        ],
      }).then(
        () => ({ raised: null as null | { code?: string; constraint?: string } }),
        (error: unknown) => ({ raised: error as { code?: string; constraint?: string } }),
      );

      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const activity = await observer.query<{ n: number }>(
          `select count(*)::int as n
             from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and query ilike '%insert into pilot.calibration_adjudications%'`,
        );
        waiting = activity.rows[0]?.n ?? 0;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The module really is blocked on the rival's uncommitted row.
      expect(waiting).toBe(1);

      await rival.query('commit');

      const { raised } = await losing;
      expect(raised?.code).toBe('23505');
      expect(raised?.constraint).toBe(adjudication.ADJUDICATION_PAIR_REVISION_CONSTRAINT);

      // The loser left nothing behind: no adjudication, no field decisions.
      expect(await adjudication.getAdjudication(ORG_ID, losingId)).toBeNull();
      expect(await adjudication.listAdjudicatedFields(ORG_ID, losingId)).toEqual([]);
      const rows = await observer.query<{ revision: number; resolution_type: string }>(
        `select revision, resolution_type
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(rows.rows).toEqual([{ revision: 1, resolution_type: 'accept_b' }]);

      // Having reloaded, the same administrator's answer is the next revision.
      const retried = await adjudication.recordAdjudication({
        ...decisionFor(staged),
        adjudicationId: crypto.randomUUID(),
        resolutionType: 'accept_a',
      });
      expect(retried.adjudication.revision).toBe(2);
    } finally {
      await rival.query('rollback').catch(() => {});
      await rival.end();
      await observer.end();
    }
  });

  test('a different pair of marks on the same clip is its own disagreement and starts at 1', async () => {
    /* A clip carries one row per disagreement, all sharing the clip and the
     * two readings. Keyed on the readings alone, the second and third
     * decisions below would be revisions 2 and 3 and would read as
     * corrections of the first. The staged clip has one mark per reading, so
     * the three disagreements it can carry are (A's mark, B's mark),
     * (A's mark, nothing from B) and (nothing from A, B's mark). */
    const staged = await stagedDisagreement(`ADJ-MARKS-${crypto.randomUUID().slice(0, 8)}`);

    const both = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });
    const onlyA = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      sourceEventIdB: null,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
      missedEventVerdict: 'a_event_real',
    });
    const onlyB = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      sourceEventIdA: null,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_b',
      missedEventVerdict: 'b_event_real',
    });
    expect([both, onlyA, onlyB].map((made) => made.adjudication.revision)).toEqual([1, 1, 1]);

    // Correcting ONE of them advances that one and no other.
    const corrected = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      sourceEventIdB: null,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'unresolvable',
      missedEventVerdict: 'unresolvable',
    });
    expect(corrected.adjudication.revision).toBe(2);

    const again = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_b',
    });
    expect(again.adjudication.revision).toBe(2);
  });

  test('a decision about one lone mark collides with another about the same lone mark', async () => {
    // The null side is why the arbiter is an index over coalesce(): a plain
    // unique constraint treats NULLs as distinct and would let both rows land.
    const staged = await stagedDisagreement(`ADJ-LONE-${crypto.randomUUID().slice(0, 8)}`);
    await adjudication.recordAdjudication({
      ...decisionFor(staged),
      sourceEventIdB: null,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });

    const client = await freshClient();
    try {
      let raised: { code?: string; constraint?: string } | null = null;
      try {
        await client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, null, 'accept_a', 1, $7, $8)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventA, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        );
      } catch (error) {
        raised = error as { code?: string; constraint?: string };
      }
      expect(raised?.code).toBe('23505');
      expect(raised?.constraint).toBe(PAIR_REVISION_CONSTRAINT);
    } finally {
      await client.end();
    }
  });

  test('a colleague settling a DIFFERENT disagreement on the clip does not block or refuse this one', async () => {
    /* The false 409 a readings-only key would produce: the rival below holds
     * an uncommitted revision 1 of another disagreement on the same clip. The
     * module's write must complete while that transaction is still open --
     * it neither waits on it nor collides with it. */
    const staged = await stagedDisagreement(`ADJ-APART-${crypto.randomUUID().slice(0, 8)}`);
    const rival = await freshClient();
    try {
      await rival.query('begin');
      await rival.query(
        `insert into pilot.calibration_adjudications
           (organization_id, adjudication_id, calibration_clip_id,
            annotation_set_id_a, annotation_set_id_b,
            source_event_id_a, source_event_id_b,
            resolution_type, revision, adjudicator_account_id, ontology_version)
         values ($1, $2, $3, $4, $5, $6, null, 'accept_a', 1, $7, $8)`,
        [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
          staged.eventA, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
      );

      const settled = await adjudication.recordAdjudication({
        ...decisionFor(staged),
        adjudicationId: crypto.randomUUID(),
        resolutionType: 'accept_b',
      });
      expect(settled.adjudication.revision).toBe(1);

      await rival.query('commit');
    } finally {
      await rival.query('rollback').catch(() => {});
      await rival.end();
    }
  });

  test('the swapped orientation of a pair keeps its own revision sequence', async () => {
    // The constraint keys on the pair as the route resolves it, (A, B) in
    // order. No unordered-pair rule is introduced here.
    const staged = await stagedDisagreement(`ADJ-SCOPE-${crypto.randomUUID().slice(0, 8)}`);

    const first = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });
    expect(first.adjudication.revision).toBe(1);

    const swapped = await adjudication.recordAdjudication({
      ...decisionFor(staged),
      annotationSetIdA: staged.setB,
      annotationSetIdB: staged.setA,
      sourceEventIdA: staged.eventB,
      sourceEventIdB: staged.eventA,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
    });
    expect(swapped.adjudication.revision).toBe(1);
  });

  test('a revision below 1 is refused', async () => {
    const staged = await stagedDisagreement(`ADJ-POS-${crypto.randomUUID().slice(0, 8)}`);
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, $7, 'accept_a', 0, $8, $9)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventA, staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_adjudications_revision_positive/);
    } finally {
      await client.end();
    }
  });

  test('an insert that names no revision is refused rather than defaulted', async () => {
    // No DEFAULT on purpose: a default of 1 would be wrong for every pair that
    // already has an answer, and would land as a collision blamed on a person.
    const staged = await stagedDisagreement(`ADJ-NODEF-${crypto.randomUUID().slice(0, 8)}`);
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, $7, 'accept_a', $8, $9)`,
          [ORG_ID, crypto.randomUUID(), staged.clipId, staged.setA, staged.setB,
            staged.eventA, staged.eventB, ADJUDICATOR, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/null value in column "revision"/);
    } finally {
      await client.end();
    }
  });
});

describe('the shipped revisions migration runner', () => {
  type Apply = (client: Client, sql: string) => Promise<void>;

  async function loadApply(): Promise<Apply> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(REVISIONS_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as Apply;
  }

  test('REFUSES a database where the revisions migration never ran', async () => {
    const applyMigrationTransaction = await loadApply();
    const client = await runnerDatabase('ppbf_test_calib_rev_no');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('applies to an EMPTY table, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadApply();
    const client = await runnerDatabase('ppbf_test_calib_rev_empty');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));
      const migrationSql = await readMigration(REVISIONS_SQL);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('backfills rows that already exist, per pair in recorded order, and a re-apply renumbers nothing', async () => {
    const applyMigrationTransaction = await loadApply();
    const client = await runnerDatabase('ppbf_test_calib_rev_backfill');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));

      /* ROWS WRITTEN BEFORE THE COLUMN EXISTS, which is the state of every
       * database the adjudication migration has already been applied to.
       *
       * Raw SQL with the four tenancy foreign keys dropped, because the point
       * is the backfill and not the write path. Inserted deliberately out of
       * chronological order; two rows of one disagreement share a timestamp so
       * the adjudication_id tiebreak is exercised; other marks inside the same
       * two readings, a lone-mark disagreement decided twice, a second pair of
       * readings and a second organization prove the numbering restarts per
       * disagreement and that NULL sides group together. */
      for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
        await client.query(
          `insert into pilot.organizations (organization_id, organization_name, status)
           values ($1, $1, 'active') on conflict do nothing`,
          [orgId],
        );
      }
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'admin', $2, 'microsoft') on conflict do nothing`,
        [ADJUDICATOR, ORG_ID],
      );
      await client.query(
        `alter table pilot.calibration_adjudications
           drop constraint pilot_calibration_adjudications_set_a_fk,
           drop constraint pilot_calibration_adjudications_set_b_fk,
           drop constraint pilot_calibration_adjudications_source_a_fk,
           drop constraint pilot_calibration_adjudications_source_b_fk`,
      );

      const existing: Array<{ org: string; id: string; b: string; ea: string | null; eb: string | null; at: string }> = [
        { org: ORG_ID, id: 'adj-late', b: 'set-b', ea: 'evt-a', eb: 'evt-b', at: '2026-03-03T00:00:00Z' },
        { org: ORG_ID, id: 'adj-early', b: 'set-b', ea: 'evt-a', eb: 'evt-b', at: '2026-01-01T00:00:00Z' },
        { org: ORG_ID, id: 'adj-tie-2', b: 'set-b', ea: 'evt-a', eb: 'evt-b', at: '2026-02-02T00:00:00Z' },
        { org: ORG_ID, id: 'adj-tie-1', b: 'set-b', ea: 'evt-a', eb: 'evt-b', at: '2026-02-02T00:00:00Z' },
        // Other marks inside the SAME two readings: their own disagreement.
        { org: ORG_ID, id: 'adj-other-marks', b: 'set-b', ea: 'evt-a2', eb: 'evt-b2', at: '2026-01-15T00:00:00Z' },
        // One lone mark, decided twice: NULL sides must group together.
        { org: ORG_ID, id: 'adj-lone-2', b: 'set-b', ea: 'evt-a', eb: null, at: '2026-02-20T00:00:00Z' },
        { org: ORG_ID, id: 'adj-lone-1', b: 'set-b', ea: 'evt-a', eb: null, at: '2026-02-10T00:00:00Z' },
        { org: ORG_ID, id: 'adj-other-pair', b: 'set-c', ea: 'evt-a', eb: 'evt-b', at: '2026-04-04T00:00:00Z' },
        { org: OTHER_ORG_ID, id: 'adj-other-org', b: 'set-b', ea: 'evt-a', eb: 'evt-b', at: '2026-05-05T00:00:00Z' },
      ];
      for (const row of existing) {
        await client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b, source_event_id_a, source_event_id_b,
              resolution_type, adjudicator_account_id, adjudicated_at, ontology_version)
           values ($1, $2, 'clip-backfill', 'set-a', $3, $4, $5,
                   'accept_a', $6, $7, 'v1')`,
          [row.org, row.id, row.b, row.ea, row.eb, ADJUDICATOR, row.at],
        );
      }

      const read = async () => (await client.query<{ k: string }>(
        `select organization_id || '/' || annotation_set_id_b || '/'
                || source_event_id_a || '+' || coalesce(source_event_id_b, 'none') || '/'
                || adjudication_id || '=' || revision as k
           from pilot.calibration_adjudications
          order by 1`,
      )).rows.map((row) => row.k).sort();

      const migrationSql = await readMigration(REVISIONS_SQL);
      await applyMigrationTransaction(client, migrationSql);

      const numbered = await read();
      expect(numbered).toEqual([
        `${ORG_ID}/set-b/evt-a+evt-b/adj-early=1`,
        `${ORG_ID}/set-b/evt-a+evt-b/adj-tie-1=2`,
        `${ORG_ID}/set-b/evt-a+evt-b/adj-tie-2=3`,
        `${ORG_ID}/set-b/evt-a+evt-b/adj-late=4`,
        `${ORG_ID}/set-b/evt-a2+evt-b2/adj-other-marks=1`,
        `${ORG_ID}/set-b/evt-a+none/adj-lone-1=1`,
        `${ORG_ID}/set-b/evt-a+none/adj-lone-2=2`,
        `${ORG_ID}/set-c/evt-a+evt-b/adj-other-pair=1`,
        `${OTHER_ORG_ID}/set-b/evt-a+evt-b/adj-other-org=1`,
      ].sort());

      // A row written after the migration, then a re-apply (every `all`
      // dispatch re-runs this file): nothing is renumbered.
      await client.query(
        `insert into pilot.calibration_adjudications
           (organization_id, adjudication_id, calibration_clip_id,
            annotation_set_id_a, annotation_set_id_b, source_event_id_a,
            resolution_type, revision, adjudicator_account_id, adjudicated_at, ontology_version)
         values ($1, 'adj-after', 'clip-backfill', 'set-a', 'set-b', 'evt-a',
                 'accept_a', 5, $2, '2025-12-12T00:00:00Z', 'v1')`,
        [ORG_ID, ADJUDICATOR],
      );
      await client.query(
        `update pilot.calibration_adjudications set source_event_id_b = 'evt-b'
          where adjudication_id = 'adj-after'`,
      );
      await applyMigrationTransaction(client, migrationSql);
      expect(await read()).toEqual(
        [...numbered, `${ORG_ID}/set-b/evt-a+evt-b/adj-after=5`].sort(),
      );
    } finally {
      await client.end();
    }
  });

  test('REFUSES an arbiter of the right name keyed on the two readings alone', async () => {
    /* `create unique index if not exists` goes by name. An index of this name
     * that leaves the marks out -- the shape that numbers unrelated decisions
     * on a clip as corrections of each other -- would be left in place by the
     * migration, so the readiness query has to see the difference. */
    const applyMigrationTransaction = await loadApply();
    const client = await runnerDatabase('ppbf_test_calib_rev_shape');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));
      await client.query(
        `alter table pilot.calibration_adjudications add column revision integer;
         create unique index ${PAIR_REVISION_CONSTRAINT}
           on pilot.calibration_adjudications (
             organization_id, calibration_clip_id,
             annotation_set_id_a, annotation_set_id_b, revision)`,
      );
      await expect(
        applyMigrationTransaction(client, await readMigration(REVISIONS_SQL)),
      ).rejects.toThrow(/CALIBRATION_ADJUDICATION_REVISIONS_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('a failed apply rolls back whole, leaving the table as it was', async () => {
    const applyMigrationTransaction = await loadApply();
    const client = await runnerDatabase('ppbf_test_calib_rev_rollback');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));
      const migrationSql = await readMigration(REVISIONS_SQL);
      await expect(
        applyMigrationTransaction(client, `${migrationSql}\nselect 1 / 0;`),
      ).rejects.toThrow(/division by zero/);

      const column = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'pilot' and table_name = 'calibration_adjudications'
            and column_name = 'revision'`,
      );
      expect(column.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
