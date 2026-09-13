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
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const PROJECTS_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';
const ADJUDICATION_SQL = 'pilot_slice_postgres_calibration_adjudication_migration.sql';
const REVISIONS_SQL = 'pilot_slice_postgres_calibration_adjudication_revisions_migration.sql';
const REVISIONS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-adjudication-revisions-migration.mjs',
);
const PAIR_REVISION_CONSTRAINT = 'pilot_calibration_adjudications_pair_revision_uq';

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
  for (const file of [BASE_SQL, VIDEO_SESSIONS_SQL, PROJECTS_SQL, ANNOTATIONS_SQL]) {
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
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status)
     values ($1, $2, $3, null, 'Sparring', 'p/adj.mp4', 'adj.mp4', 2048, 'video/mp4', 'ready')
     on conflict do nothing`,
    [VIDEO_ID, ORG_ID, ANNOTATOR_A],
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
  for (const file of [
    BASE_SQL,
    VIDEO_SESSIONS_SQL,
    PROJECTS_SQL,
    ANNOTATIONS_SQL,
    ADJUDICATION_SQL,
    // recordAdjudication writes `revision`, so every test in this file needs the
    // superseding migration applied -- not only the revision tests below.
    REVISIONS_SQL,
  ]) {
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      expectedCurrentRevision: 0,
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
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
            blob_path, file_name, file_size_bytes, mime_type, status)
         values ('vs-adj-doomed', $1, $2, null, 'Doomed', 'p/d.mp4', 'd.mp4', 10, 'video/mp4', 'ready')`,
        [ORG_ID, ANNOTATOR_A],
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
      expectedCurrentRevision: 0,
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
 * The decision assigns a revision per pair with NO row lock, so the unique
 * constraint is the only arbiter. That makes two properties worth proving against
 * a real database rather than reasoning about: that a second adjudication of the
 * same pair is RETAINED at a higher revision rather than replacing anything, and
 * that two writers who compute the same revision cannot both land. */
describe('a later adjudication supersedes an earlier one without replacing it', () => {
  test('revisions for one pair start at 1 and increment, and every revision is kept', async () => {
    const staged = await stagedDisagreement(`ADJ-REV-${crypto.randomUUID().slice(0, 8)}`);

    const first = await adjudication.recordAdjudication({
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
      expectedCurrentRevision: 0,
    });
    expect(first.adjudication.revision).toBe(1);

    const second = await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      resolutionType: 'accept_b',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      // This reviewer HAS seen revision 1 -- an ordinary supersession, not a
      // stale one. Sending 0 here would be refused, and correctly so.
      expectedCurrentRevision: 1,
    });
    expect(second.adjudication.revision).toBe(2);

    // BOTH rows survive. A supersession that deleted the earlier answer would
    // destroy the record of what was thought before, which is the opposite of
    // what this table is for.
    const client = await freshClient();
    try {
      const kept = await client.query<{ revision: number; resolution_type: string }>(
        `select revision, resolution_type
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4
          order by revision asc`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(kept.rows).toHaveLength(2);
      expect(kept.rows.map((row) => row.revision)).toEqual([1, 2]);
      expect(kept.rows.map((row) => row.resolution_type)).toEqual(['accept_a', 'accept_b']);

      // The highest revision IS the current answer. Asserted as the max, because
      // that is how a reader has to find it -- adjudicated_at cannot serve, two
      // rows can share a timestamp.
      const current = await client.query<{ resolution_type: string; revision: number }>(
        `select resolution_type, revision
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4
          order by revision desc
          limit 1`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(current.rows[0]?.revision).toBe(2);
      expect(current.rows[0]?.resolution_type).toBe('accept_b');
    } finally {
      await client.end();
    }
  });

  test('a second row at the SAME pair and revision is refused by the named constraint', async () => {
    const staged = await stagedDisagreement(`ADJ-RACE-${crypto.randomUUID().slice(0, 8)}`);

    const landed = await adjudication.recordAdjudication({
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
      expectedCurrentRevision: 0,
    });
    expect(landed.adjudication.revision).toBe(1);

    // The losing writer of the race, reproduced exactly: it computed revision 1
    // before the row above landed, so it inserts revision 1 directly rather than
    // through recordAdjudication, which would now compute 2. This is the write
    // the missing lock permits.
    const client = await freshClient();
    try {
      let raised: { code?: string; constraint?: string } | null = null;
      try {
        await client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b,
              source_event_id_a, source_event_id_b,
              resolution_type, revision,
              adjudicator_account_id, ontology_version)
           values ($1, $2, $3, $4, $5, $6, $7, 'accept_b', 1, $8, $9)`,
          [
            ORG_ID,
            crypto.randomUUID(),
            staged.clipId,
            staged.setA,
            staged.setB,
            staged.eventA,
            staged.eventB,
            ADJUDICATOR,
            ontology.BOXING_ONTOLOGY_VERSION,
          ],
        );
      } catch (error) {
        raised = error as { code?: string; constraint?: string };
      }

      // Both halves matter: the route matches on the code AND the name, so a
      // 23505 from some other constraint must not reach the conflict branch.
      expect(raised?.code).toBe('23505');
      expect(raised?.constraint).toBe(PAIR_REVISION_CONSTRAINT);

      const surviving = await client.query<{ n: number }>(
        `select count(*)::int as n
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );
      expect(surviving.rows[0]?.n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a different pair on the same clip keeps its own revision sequence', async () => {
    // Scoping proof: the constraint keys on the pair, not on the clip. Without
    // the set columns a second disagreement on the same footage would be forced
    // to revision 2 and read as a correction of the first.
    const staged = await stagedDisagreement(`ADJ-SCOPE-${crypto.randomUUID().slice(0, 8)}`);

    const first = await adjudication.recordAdjudication({
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
      expectedCurrentRevision: 0,
    });
    expect(first.adjudication.revision).toBe(1);

    // Same clip, orientation swapped -- a distinct pair under the existing
    // source_a/source_b attribution rule.
    const swapped = await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: crypto.randomUUID(),
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setB,
      annotationSetIdB: staged.setA,
      sourceEventIdA: staged.eventB,
      sourceEventIdB: staged.eventA,
      resolutionType: 'accept_a',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      expectedCurrentRevision: 0,
    });
    expect(swapped.adjudication.revision).toBe(1);
  });
});

/* THE STALE DECISION, which the unique constraint alone does not catch.
 *
 * The pair+revision constraint protects two writers whose inserts overlap. It
 * does NOTHING about the far more likely case: an administrator opens the desk
 * at revision 1, thinks for ten minutes, somebody else records revision 2 in
 * that gap, and the first one submits. A server that computes max+1 assigns
 * revision 3, the insert succeeds, and a decision made without ever seeing
 * revision 2 silently becomes the current answer.
 *
 * That is exactly the harm the 409 message describes -- "reload and review their
 * answer before replacing it" -- so a server that only raises it when two inserts
 * happen to collide is claiming a protection it does not provide.
 *
 * The fix is an expected-revision contract: the client carries back the revision
 * state the administrator actually reviewed, and the server refuses when that no
 * longer matches. The client never chooses the new revision. */
describe('an administrator whose view went stale cannot overwrite the answer they never saw', () => {
  test('a decision submitted against a superseded revision is refused, and writes nothing', async () => {
    const staged = await stagedDisagreement(`ADJ-STALE-${crypto.randomUUID().slice(0, 8)}`);
    const pair = {
      organizationId: ORG_ID,
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    };

    // 1. Administrator A opens the desk. Revision 1 is the current answer.
    const first = await adjudication.recordAdjudication({
      ...pair,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
      expectedCurrentRevision: 0,
    } as unknown as Parameters<typeof adjudication.recordAdjudication>[0]);
    expect(first.adjudication.revision).toBe(1);

    // 2. What A's page is holding while A thinks.
    const whatAReviewed = first.adjudication.revision;
    expect(whatAReviewed).toBe(1);

    // 3. Administrator B answers in that gap.
    const second = await adjudication.recordAdjudication({
      ...pair,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_b',
      expectedCurrentRevision: 1,
    } as unknown as Parameters<typeof adjudication.recordAdjudication>[0]);
    expect(second.adjudication.revision).toBe(2);

    // 4/5. A submits, still believing revision 1 is current. This must be
    // refused -- not assigned revision 3.
    //
    // Cast because this asserts a contract the input type may not carry yet:
    // the refusal has to be observed as BEHAVIOUR. Against a server that ignores
    // the field, step 6 below is what goes red.
    await expect(
      adjudication.recordAdjudication({
        ...pair,
        adjudicationId: crypto.randomUUID(),
        resolutionType: 'unresolvable',
        expectedCurrentRevision: whatAReviewed,
      } as unknown as Parameters<typeof adjudication.recordAdjudication>[0]),
    ).rejects.toThrow(/while you were deciding/);

    const client = await freshClient();
    try {
      const rows = await client.query<{ revision: number; resolution_type: string }>(
        `select revision, resolution_type
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = $2
            and annotation_set_id_a = $3 and annotation_set_id_b = $4
          order by revision asc`,
        [ORG_ID, staged.clipId, staged.setA, staged.setB],
      );

      // 6. Revision 3 does not exist. This is the assertion that fails against a
      // max+1 server: it writes revision 3 and reports success.
      expect(rows.rows.map((row) => row.revision)).toEqual([1, 2]);
      expect(rows.rows.some((row) => row.revision === 3)).toBe(false);

      // 7. Both real answers survive untouched. A refusal must not be a rollback
      // of somebody else's decision.
      expect(rows.rows.map((row) => row.resolution_type)).toEqual(['accept_a', 'accept_b']);

      // And the refusal wrote no field rows either -- it must refuse BEFORE the
      // insert, not leave an orphaned decision behind.
      const fields = await client.query<{ n: number }>(
        `select count(*)::int as n
           from pilot.calibration_adjudicated_fields f
           join pilot.calibration_adjudications a
             on a.organization_id = f.organization_id
            and a.adjudication_id = f.adjudication_id
          where a.organization_id = $1 and a.calibration_clip_id = $2
            and a.revision = 3`,
        [ORG_ID, staged.clipId],
      );
      expect(fields.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a decision submitted against the current revision is accepted', async () => {
    // The other half: the contract must not refuse the ordinary case. A guard
    // that refuses everything would pass the test above and break the desk.
    const staged = await stagedDisagreement(`ADJ-FRESH-${crypto.randomUUID().slice(0, 8)}`);
    const pair = {
      organizationId: ORG_ID,
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setA,
      annotationSetIdB: staged.setB,
      sourceEventIdA: staged.eventA,
      sourceEventIdB: staged.eventB,
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    };

    const first = await adjudication.recordAdjudication({
      ...pair,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_a',
      expectedCurrentRevision: 0,
    } as unknown as Parameters<typeof adjudication.recordAdjudication>[0]);
    expect(first.adjudication.revision).toBe(1);

    const onTime = await adjudication.recordAdjudication({
      ...pair,
      adjudicationId: crypto.randomUUID(),
      resolutionType: 'accept_b',
      expectedCurrentRevision: 1,
    } as unknown as Parameters<typeof adjudication.recordAdjudication>[0]);
    expect(onTime.adjudication.revision).toBe(2);
  });
});

describe('the shipped revisions migration runner', () => {
  test('REFUSES a database where the revisions migration never ran', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(REVISIONS_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
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

  test('backfills existing rows per pair in historical order, and a re-apply stays a no-op', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(REVISIONS_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_rev_backfill');
    try {
      await client.query(await readMigration(ADJUDICATION_SQL));

      /* PRE-EXISTING ROWS, WRITTEN BEFORE THE COLUMN EXISTS.
       *
       * The migration must not assume an empty table merely because nobody
       * believes it was deployed. These three rows are inserted with no
       * revision, deliberately out of chronological insert order, so that a
       * backfill keyed on anything other than adjudicated_at would number them
       * differently and this test would catch it. Written with raw SQL and
       * minimal tenancy because the point is the backfill, not the write path.
       */
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [ORG_ID],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'admin', $2, 'microsoft') on conflict do nothing`,
        [ADJUDICATOR, ORG_ID],
      );
      await client.query(
        `alter table pilot.calibration_adjudications
           drop constraint if exists pilot_calibration_adjudications_set_a_fk,
           drop constraint if exists pilot_calibration_adjudications_set_b_fk,
           drop constraint if exists pilot_calibration_adjudications_source_a_fk,
           drop constraint if exists pilot_calibration_adjudications_source_b_fk`,
      );

      const rows = [
        { id: 'adj-late', at: '2026-03-03T00:00:00Z' },
        { id: 'adj-early', at: '2026-01-01T00:00:00Z' },
        { id: 'adj-middle', at: '2026-02-02T00:00:00Z' },
      ];
      for (const row of rows) {
        await client.query(
          `insert into pilot.calibration_adjudications
             (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b, source_event_id_a,
              resolution_type, adjudicator_account_id, adjudicated_at, ontology_version)
           values ($1, $2, 'clip-backfill', 'set-a', 'set-b', 'evt-a',
                   'accept_a', $3, $4, 'v1')`,
          [ORG_ID, row.id, ADJUDICATOR, row.at],
        );
      }

      await applyMigrationTransaction(client, await readMigration(REVISIONS_SQL));

      const numbered = await client.query<{ adjudication_id: string; revision: number }>(
        `select adjudication_id, revision
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = 'clip-backfill'
          order by revision asc`,
        [ORG_ID],
      );
      expect(numbered.rows).toEqual([
        { adjudication_id: 'adj-early', revision: 1 },
        { adjudication_id: 'adj-middle', revision: 2 },
        { adjudication_id: 'adj-late', revision: 3 },
      ]);

      // Idempotency: a second apply renumbers nothing and still passes readiness.
      await applyMigrationTransaction(client, await readMigration(REVISIONS_SQL));
      const again = await client.query<{ adjudication_id: string; revision: number }>(
        `select adjudication_id, revision
           from pilot.calibration_adjudications
          where organization_id = $1 and calibration_clip_id = 'clip-backfill'
          order by revision asc`,
        [ORG_ID],
      );
      expect(again.rows).toEqual(numbered.rows);
    } finally {
      await client.end();
    }
  });
});
