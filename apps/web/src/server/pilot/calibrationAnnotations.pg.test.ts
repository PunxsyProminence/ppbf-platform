// Real PostgreSQL-backed test for annotation sets and events.
//
// The load-bearing claims here are all database behavior:
//
//   * a submitted set is frozen -- no insert, no update, no delete -- so
//     "independent" is a property of the system and not a claim about intent
//   * but deletion of the FOOTAGE still cascades through a submitted set, so
//     a research record can never block a minor's deletion request
//   * an event cannot lie outside the clip it belongs to, enforced by a
//     composite foreign key carrying the clip's real bounds
//   * a relationship cannot cross annotators -- annotator A's event
//     physically cannot reference annotator B's
//   * a punch cannot borrow a defense's fields and a defense cannot borrow a
//     punch's
//   * every controlled vocabulary rejects rather than coerces
//
// The freeze/deletion pair is the reason this file exists. A trigger that
// refuses every write to a submitted set's events looks correct and makes
// data deletion impossible; the test below is what tells those two apart.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-annotations-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_ann';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-annotations-migration.mjs',
);

const BASE_SQL = 'pilot_slice_postgres.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const PROJECTS_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';

const ORG_ID = 'org-ann';
const OTHER_ORG_ID = 'org-ann-other';
const ANNOTATOR_A = 'acct-annotator-a';
const ANNOTATOR_B = 'acct-annotator-b';
const VIDEO_ID = 'vs-ann-ready';

/** Clip bounds in VIDEO coordinates. Events use the same origin. */
const CLIP_START_MS = 60_000;
const CLIP_END_MS = 72_000;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let annotations: typeof import('./calibration/annotations');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');

let CLIP_ID: string;
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
  await client.query(await readMigration(BASE_SQL));
  await client.query(await readMigration(VIDEO_SESSIONS_SQL));
  await client.query(await readMigration(PROJECTS_SQL));
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
  for (const accountId of [ANNOTATOR_A, ANNOTATOR_B]) {
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
     values ($1, $2, $3, null, 'Sparring', 'p/ann.mp4', 'ann.mp4', 2048, 'video/mp4', 'ready')
     on conflict do nothing`,
    [VIDEO_ID, ORG_ID, ANNOTATOR_A],
  );
}

/** A clip and a fresh in-progress set for the given annotator. */
async function newSetFor(annotatorAccountId: string, clipId = CLIP_ID): Promise<string> {
  const setId = crypto.randomUUID();
  await annotations.openAnnotationSet({
    organizationId: ORG_ID,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId,
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
  });
  return setId;
}

async function newClip(code: string): Promise<string> {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId: ORG_ID,
    calibrationClipId: clipId,
    calibrationProjectId: PROJECT_ID,
    videoSessionId: VIDEO_ID,
    clipCode: code,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: ANNOTATOR_A,
  });
  return clipId;
}

function punchInput(setId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_ID,
    eventId: crypto.randomUUID(),
    annotationSetId: setId,
    eventClass: 'punch' as const,
    actorTrack: 'red',
    opponentTrack: 'blue',
    startMs: CLIP_START_MS + 1_000,
    endMs: CLIP_START_MS + 1_400,
    physicalHand: 'left' as const,
    handRole: 'lead' as const,
    punchType: 'lead_straight' as const,
    targetZone: 'head' as const,
    contactResult: 'clean_target_contact' as const,
    visibility: 'clear' as const,
    certainty: 'clear' as const,
    ...overrides,
  };
}

function defenseInput(setId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_ID,
    eventId: crypto.randomUUID(),
    annotationSetId: setId,
    eventClass: 'defense' as const,
    actorTrack: 'blue',
    startMs: CLIP_START_MS + 1_100,
    endMs: CLIP_START_MS + 1_500,
    defenseType: 'slip' as const,
    visibility: 'clear' as const,
    certainty: 'probable' as const,
    ...overrides,
  };
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
  await migrateClient.query(await readMigration(BASE_SQL));
  await migrateClient.query(await readMigration(VIDEO_SESSIONS_SQL));
  await migrateClient.query(await readMigration(PROJECTS_SQL));
  await migrateClient.query(await readMigration(ANNOTATIONS_SQL));
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: PROJECT_ID,
    name: 'Annotation slice study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR_A,
  });
  CLIP_ID = await newClip('C-MAIN');
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

describe('one annotator, one clip, one set', () => {
  test('a set opens in progress with no submission time', async () => {
    const clipId = await newClip('C-OPEN');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const set = await annotations.getAnnotationSet(ORG_ID, setId);

    expect(set?.status).toBe('in_progress');
    expect(set?.submitted_at).toBeNull();
    expect(set?.ontology_version).toBe('boxing-ontology-0.1');
  });

  test('the same annotator cannot open a second set on the same clip', async () => {
    const clipId = await newClip('C-DUP');
    await newSetFor(ANNOTATOR_A, clipId);
    await expect(newSetFor(ANNOTATOR_A, clipId)).rejects.toThrow(
      /pilot_calibration_sets_one_per_annotator_uq/,
    );
  });

  test('a different annotator opens their own independent set on the same clip', async () => {
    const clipId = await newClip('C-TWO');
    const a = await newSetFor(ANNOTATOR_A, clipId);
    const b = await newSetFor(ANNOTATOR_B, clipId);

    expect(a).not.toBe(b);
    const sets = await annotations.listAnnotationSetsForClip(ORG_ID, clipId);
    expect(sets.map((set) => set.annotator_account_id).sort()).toEqual(
      [ANNOTATOR_A, ANNOTATOR_B].sort(),
    );
  });

  test('a set cannot claim to be submitted without a submission time', async () => {
    // The status and its timestamp are one fact. A submitted set with no time
    // cannot be ordered against the other annotator's, which is the single
    // thing a blinding audit has to be able to do.
    const clipId = await newClip('C-ATTEST');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_sets
             (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
              ontology_version, status, submitted_at)
           values ($1, $2, $3, $4, $5, 'submitted', null)`,
          [ORG_ID, crypto.randomUUID(), clipId, ANNOTATOR_A, ontology.BOXING_ONTOLOGY_VERSION],
        ),
      ).rejects.toThrow(/pilot_calibration_sets_submission_attested/);
    } finally {
      await client.end();
    }
  });

  test('submitting twice does not re-stamp the submission time', async () => {
    const clipId = await newClip('C-RESUBMIT');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    const first = await annotations.submitAnnotationSet(ORG_ID, setId);
    expect(first?.status).toBe('submitted');
    expect(first?.submitted_at).not.toBeNull();

    // A second stamp would move this set's position in the submission order.
    const second = await annotations.submitAnnotationSet(ORG_ID, setId);
    expect(second).toBeNull();

    const after = await annotations.getAnnotationSet(ORG_ID, setId);
    // Compared by value: node-postgres parses timestamptz into a Date, so two
    // reads of the same instant are distinct objects. See the note on
    // AnnotationSetRow.
    expect(String(after?.submitted_at)).toBe(String(first?.submitted_at));
  });
});

describe('recording what was seen', () => {
  test('a punch round-trips every ratified field', async () => {
    const clipId = await newClip('C-PUNCH');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    const event = await annotations.recordAnnotationEvent(
      punchInput(setId, {
        startMs: CLIP_START_MS + 2_000,
        endMs: CLIP_START_MS + 2_500,
        contactMs: CLIP_START_MS + 2_300,
        peakMs: CLIP_START_MS + 2_200,
        stance: 'orthodox',
        punchType: 'rear_uppercut',
        physicalHand: 'right',
        handRole: 'rear',
        targetZone: 'torso',
        contactResult: 'glancing_target_contact',
        contactZone: 'torso',
        combinationGroup: 'exchange-1',
        sequenceOrder: 2,
        visibility: 'partially_occluded',
        certainty: 'probable',
      }),
    );

    expect(event.punch_type).toBe('rear_uppercut');
    expect(event.target_zone).toBe('torso');
    expect(event.contact_zone).toBe('torso');
    expect(event.contact_result).toBe('glancing_target_contact');
    expect(event.visibility).toBe('partially_occluded');
    expect(event.certainty).toBe('probable');
    expect(event.sequence_order).toBe(2);
    expect(event.defense_type).toBeNull();

    // Video coordinates, not clip-relative.
    expect(event.start_ms).toBe(CLIP_START_MS + 2_000);
    expect(event.clip_start_ms).toBe(CLIP_START_MS);
  });

  test('a defense round-trips, carrying no punch fields', async () => {
    const clipId = await newClip('C-DEF');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    const event = await annotations.recordAnnotationEvent(
      defenseInput(setId, { defenseType: 'roll_weave', stance: 'southpaw', physicalHand: 'left' }),
    );

    expect(event.defense_type).toBe('roll_weave');
    expect(event.punch_type).toBeNull();
    expect(event.target_zone).toBeNull();
    expect(event.contact_result).toBeNull();
    // The actor's body IS recordable on a defense -- a block has a hand.
    expect(event.physical_hand).toBe('left');
    expect(event.stance).toBe('southpaw');
  });

  test('contact and peak are independent -- either may exist without the other', async () => {
    const clipId = await newClip('C-INDEP');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    const contactOnly = await annotations.recordAnnotationEvent(
      punchInput(setId, { contactMs: CLIP_START_MS + 1_200, peakMs: null }),
    );
    expect(contactOnly.contact_ms).toBe(CLIP_START_MS + 1_200);
    expect(contactOnly.peak_ms).toBeNull();

    const peakOnly = await annotations.recordAnnotationEvent(
      punchInput(setId, { contactMs: null, peakMs: CLIP_START_MS + 1_300 }),
    );
    expect(peakOnly.contact_ms).toBeNull();
    expect(peakOnly.peak_ms).toBe(CLIP_START_MS + 1_300);

    const neither = await annotations.recordAnnotationEvent(punchInput(setId));
    expect(neither.contact_ms).toBeNull();
    expect(neither.peak_ms).toBeNull();
  });

  test('contact and peak must fall inside the event, inclusive at both ends', async () => {
    const clipId = await newClip('C-WITHIN');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const start = CLIP_START_MS + 3_000;
    const end = CLIP_START_MS + 3_400;

    // Inclusive: contact at the exact first millisecond is an observation.
    await expect(
      annotations.recordAnnotationEvent(punchInput(setId, { startMs: start, endMs: end, contactMs: start })),
    ).resolves.toBeDefined();
    await expect(
      annotations.recordAnnotationEvent(punchInput(setId, { startMs: start, endMs: end, peakMs: end })),
    ).resolves.toBeDefined();

    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setId, { startMs: start, endMs: end, contactMs: start - 1 }),
      ),
    ).rejects.toThrow(/contact_ms/);
    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setId, { startMs: start, endMs: end, peakMs: end + 1 }),
      ),
    ).rejects.toThrow(/peak_ms/);
  });

  test('an event must be a span', async () => {
    const clipId = await newClip('C-SPAN');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setId, { startMs: CLIP_START_MS + 5_000, endMs: CLIP_START_MS + 5_000 }),
      ),
    ).rejects.toThrow(/end_ms/);
  });
});

describe('an event cannot lie outside its clip', () => {
  test('the module refuses an event past either clip boundary', async () => {
    const clipId = await newClip('C-BOUNDS');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setId, { startMs: CLIP_START_MS - 500, endMs: CLIP_START_MS + 100 }),
      ),
    ).rejects.toThrow(/outside the clip/);

    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setId, { startMs: CLIP_END_MS - 100, endMs: CLIP_END_MS + 500 }),
      ),
    ).rejects.toThrow(/outside the clip/);
  });

  test('the database refuses it too, against a writer that skips the module', async () => {
    const clipId = await newClip('C-BOUNDS-RAW');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track,
              start_ms, end_ms, physical_hand, hand_role, punch_type, target_zone,
              contact_result, visibility, certainty)
           values ($1, $2, $3, $4, $5, $6, 'punch', 'red', $7, $8,
                   'left', 'lead', 'lead_straight', 'head', 'no_contact', 'clear', 'clear')`,
          [ORG_ID, crypto.randomUUID(), setId, clipId, CLIP_START_MS, CLIP_END_MS,
            CLIP_END_MS - 100, CLIP_END_MS + 1_000],
        ),
      ).rejects.toThrow(/pilot_calibration_events_within_clip/);
    } finally {
      await client.end();
    }
  });

  test('the carried clip bounds cannot lie about the clip', async () => {
    // THE POINT of the composite foreign key. Widening the copied bounds
    // would otherwise satisfy the containment CHECK and smuggle in an event
    // annotating footage outside the clip.
    const clipId = await newClip('C-BOUNDS-LIE');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track,
              start_ms, end_ms, physical_hand, hand_role, punch_type, target_zone,
              contact_result, visibility, certainty)
           values ($1, $2, $3, $4, 0, 999999, 'punch', 'red', 10, 2000,
                   'left', 'lead', 'lead_straight', 'head', 'no_contact', 'clear', 'clear')`,
          [ORG_ID, crypto.randomUUID(), setId, clipId],
        ),
      ).rejects.toThrow(/pilot_calibration_events_clip_fk/);
    } finally {
      await client.end();
    }
  });
});

describe('a punch and a defense cannot borrow each other s fields', () => {
  test('a punch without its required fields is refused', async () => {
    const clipId = await newClip('C-SHAPE-P');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    for (const field of ['punchType', 'physicalHand', 'handRole', 'targetZone', 'contactResult']) {
      await expect(
        annotations.recordAnnotationEvent(punchInput(setId, { [field]: null })),
      ).rejects.toThrow(/Missing/);
    }
  });

  test('a defense carrying punch fields is refused', async () => {
    const clipId = await newClip('C-SHAPE-D');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    for (const field of ['punchType', 'targetZone', 'contactResult', 'contactZone', 'combinationGroup', 'sequenceOrder']) {
      await expect(
        annotations.recordAnnotationEvent(
          defenseInput(setId, { [field]: field === 'sequenceOrder' ? 1 : 'head' }),
        ),
      ).rejects.toThrow(/cannot carry it/);
    }
  });

  test('the database enforces the same shape, against a writer that skips the module', async () => {
    const clipId = await newClip('C-SHAPE-RAW');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const client = await freshClient();
    try {
      // A defense wearing a punch type.
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track, start_ms, end_ms,
              defense_type, punch_type, visibility, certainty)
           values ($1, $2, $3, $4, $5, $6, 'defense', 'blue', $7, $8,
                   'block', 'lead_hook', 'clear', 'clear')`,
          [ORG_ID, crypto.randomUUID(), setId, clipId, CLIP_START_MS, CLIP_END_MS,
            CLIP_START_MS + 10, CLIP_START_MS + 500],
        ),
      ).rejects.toThrow(/pilot_calibration_events_class_shape/);

      // A punch with no punch type.
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track, start_ms, end_ms,
              visibility, certainty)
           values ($1, $2, $3, $4, $5, $6, 'punch', 'red', $7, $8, 'clear', 'clear')`,
          [ORG_ID, crypto.randomUUID(), setId, clipId, CLIP_START_MS, CLIP_END_MS,
            CLIP_START_MS + 10, CLIP_START_MS + 500],
        ),
      ).rejects.toThrow(/pilot_calibration_events_class_shape/);
    } finally {
      await client.end();
    }
  });
});

describe('every vocabulary rejects rather than coerces', () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['punch_type', { punchType: 'jab' }],
    ['physical_hand', { physicalHand: 'Left' }],
    ['hand_role', { handRole: 'front' }],
    ['stance', { stance: 'switch' }],
    ['target_zone', { targetZone: 'body' }],
    ['contact_result', { contactResult: 'landed' }],
    ['contact_zone', { contactZone: 'shoulder' }],
    ['visibility', { visibility: 'obscured' }],
    ['certainty', { certainty: 'maybe' }],
  ];

  test.each(CASES)('a near-miss %s is refused, not rewritten', async (field, overrides) => {
    const clipId = await newClip(`C-VOC-${field}`);
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    await expect(
      annotations.recordAnnotationEvent(punchInput(setId, overrides)),
    ).rejects.toThrow(new RegExp(field));

    // Nothing was written under a substituted value.
    expect(await annotations.listAnnotationEvents(ORG_ID, setId)).toEqual([]);
  });

  test('an unratified defense type is refused', async () => {
    const clipId = await newClip('C-VOC-DEF');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    await expect(
      annotations.recordAnnotationEvent(defenseInput(setId, { defenseType: 'dodge' })),
    ).rejects.toThrow(/defense_type/);
  });
});

describe('a relationship cannot cross annotators', () => {
  test('a counter may reference an event in the same set', async () => {
    const clipId = await newClip('C-REL-OK');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    const first = await annotations.recordAnnotationEvent(punchInput(setId));
    const counter = await annotations.recordAnnotationEvent(
      punchInput(setId, {
        startMs: CLIP_START_MS + 1_500,
        endMs: CLIP_START_MS + 1_900,
        counterAgainstEventId: first.event_id,
      }),
    );
    expect(counter.counter_against_event_id).toBe(first.event_id);
  });

  test("annotator A's event cannot reference annotator B's", async () => {
    // THE BLINDING INVARIANT, held by a composite foreign key that includes
    // annotation_set_id. Not discouraged -- impossible.
    const clipId = await newClip('C-REL-XSET');
    const setA = await newSetFor(ANNOTATOR_A, clipId);
    const setB = await newSetFor(ANNOTATOR_B, clipId);

    const bEvent = await annotations.recordAnnotationEvent(punchInput(setB));

    await expect(
      annotations.recordAnnotationEvent(
        punchInput(setA, { counterAgainstEventId: bEvent.event_id }),
      ),
    ).rejects.toThrow(/pilot_calibration_events_counter_fk/);

    await expect(
      annotations.recordAnnotationEvent(
        defenseInput(setA, { defendsAgainstEventId: bEvent.event_id }),
      ),
    ).rejects.toThrow(/pilot_calibration_events_defends_fk/);
  });

  test('an event cannot counter or defend against itself', async () => {
    const clipId = await newClip('C-REL-SELF');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const client = await freshClient();
    try {
      const eventId = crypto.randomUUID();
      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track, start_ms, end_ms,
              physical_hand, hand_role, punch_type, target_zone, contact_result,
              visibility, certainty, counter_against_event_id)
           values ($1, $2, $3, $4, $5, $6, 'punch', 'red', $7, $8,
                   'left', 'lead', 'lead_straight', 'head', 'no_contact', 'clear', 'clear', $2)`,
          [ORG_ID, eventId, setId, clipId, CLIP_START_MS, CLIP_END_MS,
            CLIP_START_MS + 10, CLIP_START_MS + 500],
        ),
      ).rejects.toThrow(/pilot_calibration_events_no_self_counter/);
    } finally {
      await client.end();
    }
  });
});

describe('a submitted set is frozen', () => {
  test('events cannot be added, changed or removed after submission', async () => {
    const clipId = await newClip('C-FREEZE');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const event = await annotations.recordAnnotationEvent(punchInput(setId));
    await annotations.submitAnnotationSet(ORG_ID, setId);

    await expect(
      annotations.recordAnnotationEvent(punchInput(setId)),
    ).rejects.toThrow(/submitted/);

    await expect(
      annotations.deleteAnnotationEvent(ORG_ID, setId, event.event_id),
    ).rejects.toThrow(/submitted/);

    // And against a writer that skips the module entirely -- the trigger, not
    // the application, is what holds this.
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_annotation_events
              set punch_type = 'rear_hook'
            where organization_id = $1 and event_id = $2`,
          [ORG_ID, event.event_id],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);

      await expect(
        client.query(
          `delete from pilot.calibration_annotation_events
            where organization_id = $1 and event_id = $2`,
          [ORG_ID, event.event_id],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);

      await expect(
        client.query(
          `insert into pilot.calibration_annotation_events
             (organization_id, event_id, annotation_set_id, calibration_clip_id,
              clip_start_ms, clip_end_ms, event_class, actor_track, start_ms, end_ms,
              defense_type, visibility, certainty)
           values ($1, $2, $3, $4, $5, $6, 'defense', 'blue', $7, $8, 'slip', 'clear', 'clear')`,
          [ORG_ID, crypto.randomUUID(), setId, clipId, CLIP_START_MS, CLIP_END_MS,
            CLIP_START_MS + 20, CLIP_START_MS + 600],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);
    } finally {
      await client.end();
    }
  });

  test('a submitted set cannot be un-submitted or re-stamped', async () => {
    const clipId = await newClip('C-FREEZE-SET');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    await annotations.submitAnnotationSet(ORG_ID, setId);

    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_annotation_sets set status = 'in_progress', submitted_at = null
            where organization_id = $1 and annotation_set_id = $2`,
          [ORG_ID, setId],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);

      // Re-stamping would move this set's place in the submission order.
      await expect(
        client.query(
          `update pilot.calibration_annotation_sets set submitted_at = now() + interval '1 day'
            where organization_id = $1 and annotation_set_id = $2`,
          [ORG_ID, setId],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);

      // Re-attributing it to the other annotator would be worse still.
      await expect(
        client.query(
          `update pilot.calibration_annotation_sets set annotator_account_id = $3
            where organization_id = $1 and annotation_set_id = $2`,
          [ORG_ID, setId, ANNOTATOR_B],
        ),
      ).rejects.toThrow(/CALIBRATION_ANNOTATION_SET_SUBMITTED/);
    } finally {
      await client.end();
    }
  });

  test('an in-progress set is still fully editable', async () => {
    // The freeze must not be so broad that it stops the annotator working.
    const clipId = await newClip('C-EDITABLE');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    const event = await annotations.recordAnnotationEvent(punchInput(setId));

    expect(await annotations.deleteAnnotationEvent(ORG_ID, setId, event.event_id)).toBe(true);
    expect(await annotations.listAnnotationEvents(ORG_ID, setId)).toEqual([]);
  });
});

describe('a submitted set never blocks a deletion request', () => {
  test('deleting the source footage cascades through a SUBMITTED set', async () => {
    // THE TEST THIS FILE EXISTS FOR. The obvious version of the freeze trigger
    // -- refuse every delete of a submitted set's events -- looks correct and
    // makes a minor's data-deletion request impossible to fulfil. This is what
    // tells the two implementations apart.
    const client = await freshClient();
    try {
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
            blob_path, file_name, file_size_bytes, mime_type, status)
         values ('vs-ann-doomed', $1, $2, null, 'Doomed', 'p/d.mp4', 'd.mp4', 10, 'video/mp4', 'ready')`,
        [ORG_ID, ANNOTATOR_A],
      );

      const clipId = crypto.randomUUID();
      await projects.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: clipId,
        calibrationProjectId: PROJECT_ID,
        videoSessionId: 'vs-ann-doomed',
        clipCode: 'C-DOOMED',
        startMs: CLIP_START_MS,
        endMs: CLIP_END_MS,
        primarySamplingReason: 'other',
        createdByAccountId: ANNOTATOR_A,
      });

      const setId = await newSetFor(ANNOTATOR_A, clipId);
      await annotations.recordAnnotationEvent(punchInput(setId));
      await annotations.submitAnnotationSet(ORG_ID, setId);
      expect((await annotations.getAnnotationSet(ORG_ID, setId))?.status).toBe('submitted');

      await client.query(`delete from pilot.video_sessions where video_session_id = 'vs-ann-doomed'`);

      expect(await annotations.getAnnotationSet(ORG_ID, setId)).toBeNull();
      expect(await annotations.listAnnotationEvents(ORG_ID, setId)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('deleting the set itself cascades its events, submitted or not', async () => {
    const clipId = await newClip('C-SETDEL');
    const setId = await newSetFor(ANNOTATOR_A, clipId);
    await annotations.recordAnnotationEvent(punchInput(setId));
    await annotations.submitAnnotationSet(ORG_ID, setId);

    const client = await freshClient();
    try {
      await client.query(
        `delete from pilot.calibration_annotation_sets
          where organization_id = $1 and annotation_set_id = $2`,
        [ORG_ID, setId],
      );
      expect(await annotations.listAnnotationEvents(ORG_ID, setId)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('tenancy', () => {
  test('a set in another organization is invisible', async () => {
    const clipId = await newClip('C-TENANCY');
    const setId = await newSetFor(ANNOTATOR_A, clipId);

    expect(await annotations.getAnnotationSet(OTHER_ORG_ID, setId)).toBeNull();
    expect(await annotations.listAnnotationEvents(OTHER_ORG_ID, setId)).toEqual([]);
    expect(await annotations.listAnnotationSetsForClip(OTHER_ORG_ID, clipId)).toEqual([]);
  });

  test('a set cannot be opened against another organization clip', async () => {
    const clipId = await newClip('C-TENANCY-2');
    await expect(
      annotations.openAnnotationSet({
        organizationId: OTHER_ORG_ID,
        annotationSetId: crypto.randomUUID(),
        calibrationClipId: clipId,
        annotatorAccountId: ANNOTATOR_A,
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      }),
    ).rejects.toThrow(/pilot_calibration_sets_clip_fk/);
  });
});

describe('the shipped migration runner', () => {
  test('REFUSES a database where the annotations migration never ran', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_ann_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_ANNOTATIONS_NOT_READY/,
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
    const client = await runnerDatabase('ppbf_test_calib_ann_ok');
    try {
      const migrationSql = await readMigration(ANNOTATIONS_SQL);
      await applyMigrationTransaction(client, migrationSql);
      // Including the `create or replace function` / `drop trigger if exists`
      // pair, which the `all` chain re-runs on every dispatch (#489).
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
