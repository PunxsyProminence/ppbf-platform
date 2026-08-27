// Real PostgreSQL-backed test for gold / reference-dataset governance.
//
// What needs proving here, and cannot be proved by a mock:
//
//   * NOTHING ARRIVES AS GOLD -- refused by a trigger, against a raw INSERT
//     that fills in a promoter and a timestamp and would satisfy the CHECK
//   * promotion is attributed, in both directions: a gold record cannot exist
//     without its promoter, and a candidate cannot carry one
//   * A LOCKED_TEST RECORD CANNOT BECOME TRAINING_ELIGIBLE. Asserted against
//     raw SQL UPDATEs issued straight at the table, because the whole point of
//     putting this in the database is that the writers who matter -- a
//     backfill, a cleanup, a future feeder's migration -- never call the
//     module. A test that only drove calibration/gold.ts would prove the door
//     is locked while leaving the wall untested.
//   * the same rule cannot be walked around in two hops, or flanked by a
//     second row about the same reading
//   * full provenance round-trips, including BOTH annotators' set ids, and
//     cannot be rewritten afterwards
//   * cross-organization references are refused structurally
//   * deleting the source video takes a 'gold' + LOCKED_TEST record with it --
//     the single hardest row in this schema to delete on purpose
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-gold-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_gold';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-gold-migration.mjs',
);

const BASE_SQL = 'pilot_slice_postgres.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const PROJECTS_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';
const ADJUDICATION_SQL = 'pilot_slice_postgres_calibration_adjudication_migration.sql';
const GOLD_SQL = 'pilot_slice_postgres_calibration_gold_migration.sql';

const ORG_ID = 'org-gold';
const OTHER_ORG_ID = 'org-gold-other';
const ANNOTATOR_A = 'acct-gold-a';
const ANNOTATOR_B = 'acct-gold-b';
const ADJUDICATOR = 'acct-gold-reviewer';
const PROMOTER = 'acct-gold-promoter';
const OTHER_ANNOTATOR_A = 'acct-gold-other-a';
const OTHER_ANNOTATOR_B = 'acct-gold-other-b';
const OTHER_ADJUDICATOR = 'acct-gold-other-reviewer';
const VIDEO_ID = 'vs-gold-ready';
const OTHER_VIDEO_ID = 'vs-gold-other-ready';
const CLIP_START_MS = 0;
const CLIP_END_MS = 20_000;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let gold: typeof import('./calibration/gold');
let adjudication: typeof import('./calibration/adjudication');
let annotations: typeof import('./calibration/annotations');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');
let PROJECT_ID: string;
let OTHER_PROJECT_ID: string;

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
  for (const file of [BASE_SQL, VIDEO_SESSIONS_SQL, PROJECTS_SQL, ANNOTATIONS_SQL, ADJUDICATION_SQL]) {
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
  for (const accountId of [ANNOTATOR_A, ANNOTATOR_B, ADJUDICATOR, PROMOTER]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [accountId, ORG_ID],
    );
  }
  for (const accountId of [OTHER_ANNOTATOR_A, OTHER_ANNOTATOR_B, OTHER_ADJUDICATOR]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [accountId, OTHER_ORG_ID],
    );
  }
  for (const [videoId, orgId, uploader] of [
    [VIDEO_ID, ORG_ID, ANNOTATOR_A],
    [OTHER_VIDEO_ID, OTHER_ORG_ID, OTHER_ANNOTATOR_A],
  ] as const) {
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status)
       values ($1, $2, $3, null, 'Sparring', 'p/gold.mp4', 'gold.mp4', 2048, 'video/mp4', 'ready')
       on conflict do nothing`,
      [videoId, orgId, uploader],
    );
  }
}

interface StageOptions {
  clipCode: string;
  organizationId?: string;
  projectId?: string;
  videoId?: string;
  clipId?: string;
  annotatorA?: string;
  annotatorB?: string;
  adjudicator?: string;
}

interface Staged {
  organizationId: string;
  projectId: string;
  videoId: string;
  clipId: string;
  setA: string;
  setB: string;
  eventA: string;
  eventB: string;
  adjudicationId: string;
  adjudicator: string;
}

/**
 * A clip, two independently submitted readings that disagree, and a reviewer's
 * settled decision between them. Everything a gold record can legitimately be
 * made from, and nothing more.
 */
async function stage(options: StageOptions): Promise<Staged> {
  const organizationId = options.organizationId ?? ORG_ID;
  const projectId = options.projectId ?? PROJECT_ID;
  const videoId = options.videoId ?? VIDEO_ID;
  const clipId = options.clipId ?? crypto.randomUUID();
  const annotatorA = options.annotatorA ?? ANNOTATOR_A;
  const annotatorB = options.annotatorB ?? ANNOTATOR_B;
  const adjudicator = options.adjudicator ?? ADJUDICATOR;

  await projects.createCalibrationClip({
    organizationId,
    calibrationClipId: clipId,
    calibrationProjectId: projectId,
    videoSessionId: videoId,
    clipCode: options.clipCode,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: annotatorA,
  });

  const sets: Record<string, string> = {};
  const events: Record<string, string> = {};
  for (const [key, annotator, punchType] of [
    ['a', annotatorA, 'lead_straight'],
    ['b', annotatorB, 'lead_hook'],
  ] as const) {
    const setId = crypto.randomUUID();
    await annotations.openAnnotationSet({
      organizationId,
      annotationSetId: setId,
      calibrationClipId: clipId,
      annotatorAccountId: annotator,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    });
    const event = await annotations.recordAnnotationEvent({
      organizationId,
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
    await annotations.submitAnnotationSet(organizationId, setId);
    sets[key] = setId;
    events[key] = event.event_id;
  }

  const adjudicationId = crypto.randomUUID();
  await adjudication.recordAdjudication({
    organizationId,
    adjudicationId,
    calibrationClipId: clipId,
    annotationSetIdA: sets.a,
    annotationSetIdB: sets.b,
    sourceEventIdA: events.a,
    sourceEventIdB: events.b,
    resolutionType: 'accept_a',
    adjudicatorAccountId: adjudicator,
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

  return {
    organizationId,
    projectId,
    videoId,
    clipId,
    setA: sets.a,
    setB: sets.b,
    eventA: events.a,
    eventB: events.b,
    adjudicationId,
    adjudicator,
  };
}

/** The raw INSERT a backfill would write, with every column named. */
function rawInsert(client: Client, values: Record<string, unknown>): Promise<unknown> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  return client.query(
    `insert into pilot.calibration_gold_records (${columns.join(', ')})
     values (${placeholders.join(', ')})`,
    Object.values(values),
  );
}

function goldColumnsFor(staged: Staged, overrides: Record<string, unknown> = {}) {
  return {
    organization_id: staged.organizationId,
    gold_record_id: crypto.randomUUID(),
    calibration_project_id: staged.projectId,
    calibration_clip_id: staged.clipId,
    video_session_id: staged.videoId,
    ontology_version: 'boxing-ontology-0.1',
    adjudication_id: staged.adjudicationId,
    adjudicator_account_id: staged.adjudicator,
    annotation_set_id_a: staged.setA,
    annotation_set_id_b: staged.setB,
    eligibility: 'TRAINING_ELIGIBLE',
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
  for (const file of [
    BASE_SQL,
    VIDEO_SESSIONS_SQL,
    PROJECTS_SQL,
    ANNOTATIONS_SQL,
    ADJUDICATION_SQL,
    GOLD_SQL,
  ]) {
    await migrateClient.query(await readMigration(file));
  }
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  gold = await import('./calibration/gold');
  adjudication = await import('./calibration/adjudication');
  annotations = await import('./calibration/annotations');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: PROJECT_ID,
    name: 'Gold slice study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR_A,
  });

  OTHER_PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: OTHER_ORG_ID,
    calibrationProjectId: OTHER_PROJECT_ID,
    name: 'Another gym study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: OTHER_ANNOTATOR_A,
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

describe('nothing arrives as gold', () => {
  test('a nomination lands as a candidate, unpromoted and unattributed', async () => {
    const staged = await stage({ clipCode: 'G-NOM' });
    const record = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });

    expect(record.governance_state).toBe('candidate');
    expect(record.promoted_by_account_id).toBeNull();
    expect(record.promoted_at).toBeNull();
  });

  test('a raw INSERT that arrives as gold is refused by the trigger, attribution and all', async () => {
    // THE CASE THE CHECK CANNOT HOLD. This row satisfies the promotion
    // attestation completely -- it names a promoter and a time. What makes it
    // wrong is that promotion never happened as a separate, deliberate act,
    // and only a trigger can see the difference between an INSERT and an
    // UPDATE. This is the shape a bulk import produces.
    const staged = await stage({ clipCode: 'G-BORN' });
    const client = await freshClient();
    try {
      await expect(
        rawInsert(
          client,
          goldColumnsFor(staged, {
            governance_state: 'gold',
            promoted_by_account_id: PROMOTER,
            promoted_at: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow(/CALIBRATION_GOLD_PROMOTION_MUST_BE_A_SEPARATE_ACT/);
    } finally {
      await client.end();
    }
  });

  test('arriving excluded IS permitted -- the asymmetry is deliberate', async () => {
    // Arriving excluded adds nothing to the reference dataset. Arriving gold
    // adds something, and everything added must be chosen.
    const staged = await stage({ clipCode: 'G-BORN-EXCLUDED' });
    const client = await freshClient();
    try {
      await expect(
        rawInsert(client, goldColumnsFor(staged, { governance_state: 'excluded' })),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe('promotion is a deliberate, attributed act', () => {
  test('promoting names the human and the moment, and only that record', async () => {
    const staged = await stage({ clipCode: 'G-PROMOTE' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });

    const promoted = await gold.promoteGoldRecord({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      promotedByAccountId: PROMOTER,
    });

    expect(promoted.governance_state).toBe('gold');
    expect(promoted.promoted_by_account_id).toBe(PROMOTER);
    expect(promoted.promoted_at).not.toBeNull();
    // Eligibility is untouched by promotion: "is this reference data" and
    // "what may it be used for" are two questions.
    expect(promoted.eligibility).toBe('TRAINING_ELIGIBLE');
  });

  test('an unattributed promotion is refused by the CHECK, not by this module', async () => {
    const staged = await stage({ clipCode: 'G-UNATTRIBUTED' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'VALIDATION_ONLY',
    });

    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_gold_records
              set governance_state = 'gold'
            where organization_id = $1 and gold_record_id = $2`,
          [ORG_ID, candidate.gold_record_id],
        ),
      ).rejects.toThrow(/pilot_calibration_gold_promotion_attested/);
    } finally {
      await client.end();
    }
  });

  test('a record that is NOT gold cannot carry promotion attribution either', async () => {
    // The backwards half of the attestation, the half that is easy to leave
    // out. Without it a candidate could name a promoter who promoted nothing.
    const staged = await stage({ clipCode: 'G-FALSE-PROMOTER' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'VALIDATION_ONLY',
    });

    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_gold_records
              set promoted_by_account_id = $3, promoted_at = now()
            where organization_id = $1 and gold_record_id = $2`,
          [ORG_ID, candidate.gold_record_id, PROMOTER],
        ),
      ).rejects.toThrow(/pilot_calibration_gold_promotion_attested/);
    } finally {
      await client.end();
    }
  });

  test('promoting a record that is already gold is refused rather than re-stamped', async () => {
    const staged = await stage({ clipCode: 'G-REPROMOTE' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });
    await gold.promoteGoldRecord({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      promotedByAccountId: PROMOTER,
    });

    await expect(
      gold.promoteGoldRecord({
        organizationId: ORG_ID,
        goldRecordId: candidate.gold_record_id,
        promotedByAccountId: ADJUDICATOR,
      }),
    ).rejects.toThrow(/only a candidate can be promoted/);
  });

  test('there is no bulk promotion path in the module', () => {
    // "Promote everything adjudicated in this project" is the act the order
    // forbids, and it arrives wearing a reasonable name. Pinned as a test so
    // adding one is a deliberate, visible act rather than a convenience.
    const exported = Object.keys(gold).filter((name) => /promot/i.test(name));
    expect(exported).toEqual(['promoteGoldRecord']);
  });
});

describe('a LOCKED_TEST record cannot become training data', () => {
  /** A promoted, held-out record: the row this whole slice exists to protect. */
  async function lockedTestGoldRecord(clipCode: string): Promise<string> {
    const staged = await stage({ clipCode });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'LOCKED_TEST',
    });
    const promoted = await gold.promoteGoldRecord({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      promotedByAccountId: PROMOTER,
    });
    expect(promoted.eligibility).toBe('LOCKED_TEST');
    expect(promoted.governance_state).toBe('gold');
    return promoted.gold_record_id;
  }

  test('a raw SQL UPDATE straight at the table is refused by the trigger', async () => {
    // THE CORE CLAIM, and it is deliberately asserted with raw SQL rather than
    // through calibration/gold.ts. A backfill, a cleanup script, or a psql
    // session at 2am all look exactly like this statement, and none of them
    // call the module. If this only worked through the module, the rule would
    // be a promise rather than a property.
    const goldRecordId = await lockedTestGoldRecord('G-LOCKED-RAW');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_gold_records
              set eligibility = 'TRAINING_ELIGIBLE'
            where organization_id = $1 and gold_record_id = $2`,
          [ORG_ID, goldRecordId],
        ),
      ).rejects.toThrow(/CALIBRATION_GOLD_LOCKED_TEST_IS_TERMINAL/);

      const after = await gold.getGoldRecord(ORG_ID, goldRecordId);
      expect(after?.eligibility).toBe('LOCKED_TEST');
    } finally {
      await client.end();
    }
  });

  test('a blanket UPDATE over the whole table is refused too, and changes nothing', async () => {
    // The realistic shape of the accident: not a targeted statement, but one
    // that sweeps a column across every row. It must fail loudly rather than
    // updating everything except the held-out rows.
    //
    // Either refusal is the correct outcome and which one fires depends on the
    // scan order over rows this suite has already left behind -- a
    // VALIDATION_ONLY record trips the loosening rule, a LOCKED_TEST one trips
    // the terminal rule. What is asserted precisely is the consequence: the
    // whole statement fails, so the held-out record is untouched.
    const goldRecordId = await lockedTestGoldRecord('G-LOCKED-SWEEP');
    const client = await freshClient();
    try {
      await expect(
        client.query(`update pilot.calibration_gold_records set eligibility = 'TRAINING_ELIGIBLE'`),
      ).rejects.toThrow(/CALIBRATION_GOLD_(LOCKED_TEST_IS_TERMINAL|ELIGIBILITY_LOOSENED)/);

      const after = await gold.getGoldRecord(ORG_ID, goldRecordId);
      expect(after?.eligibility).toBe('LOCKED_TEST');
    } finally {
      await client.end();
    }
  });

  test('the two-hop launder through VALIDATION_ONLY is refused at the first hop', async () => {
    // LOCKED_TEST -> VALIDATION_ONLY -> TRAINING_ELIGIBLE would reach the
    // forbidden state through two individually-legal-looking updates. This is
    // why LOCKED_TEST is terminal rather than merely one-directional.
    const goldRecordId = await lockedTestGoldRecord('G-LOCKED-LAUNDER');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_gold_records
              set eligibility = 'VALIDATION_ONLY'
            where organization_id = $1 and gold_record_id = $2`,
          [ORG_ID, goldRecordId],
        ),
      ).rejects.toThrow(/CALIBRATION_GOLD_LOCKED_TEST_IS_TERMINAL/);
    } finally {
      await client.end();
    }
  });

  test('VALIDATION_ONLY cannot be loosened to TRAINING_ELIGIBLE either', async () => {
    const staged = await stage({ clipCode: 'G-VALIDATION-LOOSEN' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'VALIDATION_ONLY',
    });

    const client = await freshClient();
    try {
      await expect(
        client.query(
          `update pilot.calibration_gold_records
              set eligibility = 'TRAINING_ELIGIBLE'
            where organization_id = $1 and gold_record_id = $2`,
          [ORG_ID, candidate.gold_record_id],
        ),
      ).rejects.toThrow(/CALIBRATION_GOLD_ELIGIBILITY_LOOSENED/);
    } finally {
      await client.end();
    }
  });

  test('the ratchet still turns toward tighter, including after promotion', async () => {
    const staged = await stage({ clipCode: 'G-TIGHTEN' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });
    await gold.promoteGoldRecord({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      promotedByAccountId: PROMOTER,
    });

    const validation = await gold.tightenGoldEligibility({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      eligibility: 'VALIDATION_ONLY',
    });
    expect(validation.eligibility).toBe('VALIDATION_ONLY');

    const locked = await gold.tightenGoldEligibility({
      organizationId: ORG_ID,
      goldRecordId: candidate.gold_record_id,
      eligibility: 'LOCKED_TEST',
    });
    expect(locked.eligibility).toBe('LOCKED_TEST');
    // Still gold, still attributed to the person who promoted it.
    expect(locked.governance_state).toBe('gold');
    expect(locked.promoted_by_account_id).toBe(PROMOTER);
  });

  test('the module refuses a loosening with a 400 before the trigger has to', async () => {
    const staged = await stage({ clipCode: 'G-TIGHTEN-REFUSE' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'LOCKED_TEST',
    });

    await expect(
      gold.tightenGoldEligibility({
        organizationId: ORG_ID,
        goldRecordId: candidate.gold_record_id,
        eligibility: 'TRAINING_ELIGIBLE',
      }),
    ).rejects.toThrow(/LOCKED_TEST cannot be loosened to TRAINING_ELIGIBLE/);
  });

  test('a second, looser record for the same reading is refused -- the ratchet cannot be flanked', async () => {
    // Without one-record-per-adjudication, the rule above needs no UPDATE to
    // walk around: leave the LOCKED_TEST row alone and INSERT a
    // TRAINING_ELIGIBLE one about the same adjudicated reading. Two rows
    // disagreeing about whether one reading is held out is exactly the state
    // the ratchet exists to prevent.
    const staged = await stage({ clipCode: 'G-FLANK' });
    await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'LOCKED_TEST',
    });

    await expect(
      gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: staged.adjudicationId,
        eligibility: 'TRAINING_ELIGIBLE',
      }),
    ).rejects.toThrow(/pilot_calibration_gold_one_per_adjudication/);

    const client = await freshClient();
    try {
      await expect(
        rawInsert(client, goldColumnsFor(staged, { eligibility: 'TRAINING_ELIGIBLE' })),
      ).rejects.toThrow(/pilot_calibration_gold_one_per_adjudication/);
    } finally {
      await client.end();
    }
  });

  test('an eligibility outside the vocabulary is rejected, never coerced', async () => {
    const staged = await stage({ clipCode: 'G-VOCAB' });
    await expect(
      gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: staged.adjudicationId,
        eligibility: 'MAYBE_TRAINING' as never,
      }),
    ).rejects.toThrow(/eligibility/);

    const client = await freshClient();
    try {
      await expect(
        rawInsert(client, goldColumnsFor(staged, { eligibility: 'MAYBE_TRAINING' })),
      ).rejects.toThrow(/calibration_gold_records_eligibility_check/);
    } finally {
      await client.end();
    }
  });
});

describe('a gold record retains where it came from', () => {
  test('full provenance round-trips, including BOTH annotators', async () => {
    const staged = await stage({ clipCode: 'G-PROVENANCE' });
    const created = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'VALIDATION_ONLY',
      notes: 'Clean isolated jab, both readings agreed on timing.',
    });

    const readBack = await gold.getGoldRecord(ORG_ID, created.gold_record_id);
    expect(readBack).not.toBeNull();
    expect({
      calibration_project_id: readBack?.calibration_project_id,
      calibration_clip_id: readBack?.calibration_clip_id,
      video_session_id: readBack?.video_session_id,
      ontology_version: readBack?.ontology_version,
      adjudication_id: readBack?.adjudication_id,
      adjudicator_account_id: readBack?.adjudicator_account_id,
      annotation_set_id_a: readBack?.annotation_set_id_a,
      annotation_set_id_b: readBack?.annotation_set_id_b,
    }).toEqual({
      calibration_project_id: PROJECT_ID,
      calibration_clip_id: staged.clipId,
      video_session_id: VIDEO_ID,
      ontology_version: 'boxing-ontology-0.1',
      adjudication_id: staged.adjudicationId,
      adjudicator_account_id: ADJUDICATOR,
      annotation_set_id_a: staged.setA,
      annotation_set_id_b: staged.setB,
    });

    // The two set ids lead back to two DIFFERENT people. A gold record that
    // cannot say which two produced the reading is not governed data.
    const setA = await annotations.getAnnotationSet(ORG_ID, staged.setA);
    const setB = await annotations.getAnnotationSet(ORG_ID, staged.setB);
    expect(setA?.annotator_account_id).toBe(ANNOTATOR_A);
    expect(setB?.annotator_account_id).toBe(ANNOTATOR_B);
    expect(setA?.annotator_account_id).not.toBe(setB?.annotator_account_id);
  });

  test('provenance cannot be rewritten after the fact', async () => {
    // The foreign keys stop an INCONSISTENT provenance. They do nothing about
    // repointing a promoted record at a different, perfectly consistent one --
    // which is how a record keeps its attribution while quietly changing what
    // it is a record OF.
    const staged = await stage({ clipCode: 'G-FREEZE' });
    const other = await stage({ clipCode: 'G-FREEZE-OTHER' });
    const candidate = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });

    const client = await freshClient();
    try {
      for (const [column, value] of [
        ['adjudication_id', other.adjudicationId],
        ['annotation_set_id_a', other.setA],
        ['calibration_clip_id', other.clipId],
        ['ontology_version', 'boxing-ontology-0.2'],
        ['adjudicator_account_id', PROMOTER],
      ] as const) {
        await expect(
          client.query(
            `update pilot.calibration_gold_records
                set ${column} = $3
              where organization_id = $1 and gold_record_id = $2`,
            [ORG_ID, candidate.gold_record_id, value],
          ),
        ).rejects.toThrow(/CALIBRATION_GOLD_PROVENANCE_IMMUTABLE/);
      }
    } finally {
      await client.end();
    }
  });

  test('the two annotators cannot be swapped at insert time', async () => {
    // A and B are not interchangeable: the adjudication says which reading was
    // whose, and a gold record that reversed them would credit an observation
    // to the wrong person while looking entirely well-formed.
    const staged = await stage({ clipCode: 'G-SWAP' });
    const client = await freshClient();
    try {
      await expect(
        rawInsert(
          client,
          goldColumnsFor(staged, {
            annotation_set_id_a: staged.setB,
            annotation_set_id_b: staged.setA,
          }),
        ),
      ).rejects.toThrow(/pilot_calibration_gold_adjudication_fk/);
    } finally {
      await client.end();
    }
  });

  test('an unresolvable adjudication settled no reading to govern', async () => {
    // The adjudication migration's own words: a gold dataset built from forced
    // verdicts would carry a confidence nobody earned. One built from
    // UNRESOLVED ones would carry a verdict nobody reached.
    const staged = await stage({ clipCode: 'G-UNRESOLVABLE' });
    const unresolvableId = crypto.randomUUID();
    await adjudication.recordAdjudication({
      organizationId: ORG_ID,
      adjudicationId: unresolvableId,
      calibrationClipId: staged.clipId,
      annotationSetIdA: staged.setB,
      annotationSetIdB: staged.setA,
      sourceEventIdA: staged.eventB,
      sourceEventIdB: staged.eventA,
      resolutionType: 'unresolvable',
      adjudicatorAccountId: ADJUDICATOR,
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    });

    await expect(
      gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: unresolvableId,
        eligibility: 'TRAINING_ELIGIBLE',
      }),
    ).rejects.toThrow(/settled no reading to govern/);
  });

  test('an adjudication that does not exist here is a 404, not a half-written row', async () => {
    const missingId = crypto.randomUUID();
    await expect(
      gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: missingId,
        eligibility: 'TRAINING_ELIGIBLE',
      }),
    ).rejects.toThrow(/^Not found/);
  });
});

describe('a gold record cannot reach across organizations', () => {
  test("a clip id shared with another gym does not let a record borrow that gym's clip", async () => {
    // THE PRECISE TENANCY TEST. The other organization's clip is given the SAME
    // calibration_clip_id -- legal, because the primary key is (organization_id,
    // calibration_clip_id) -- and a different project and video. The gold row
    // below then names this organization, this organization's adjudication and
    // annotation sets, and the OTHER organization's project and video.
    //
    // Every foreign key except the clip's is satisfied. Only
    // organization_id's presence in pilot_calibration_gold_clip_fk refuses it:
    // strip organization_id from that key and this row becomes storable.
    const staged = await stage({ clipCode: 'G-TENANCY' });
    await stage({
      clipCode: 'G-TENANCY-MIRROR',
      organizationId: OTHER_ORG_ID,
      projectId: OTHER_PROJECT_ID,
      videoId: OTHER_VIDEO_ID,
      clipId: staged.clipId,
      annotatorA: OTHER_ANNOTATOR_A,
      annotatorB: OTHER_ANNOTATOR_B,
      adjudicator: OTHER_ADJUDICATOR,
    });

    const client = await freshClient();
    try {
      await expect(
        rawInsert(
          client,
          goldColumnsFor(staged, {
            calibration_project_id: OTHER_PROJECT_ID,
            video_session_id: OTHER_VIDEO_ID,
          }),
        ),
      ).rejects.toThrow(/pilot_calibration_gold_clip_fk/);
    } finally {
      await client.end();
    }
  });

  test("another organization's whole provenance is refused outright", async () => {
    const staged = await stage({ clipCode: 'G-TENANCY-WHOLE' });
    const client = await freshClient();
    try {
      await expect(
        rawInsert(client, goldColumnsFor(staged, { organization_id: OTHER_ORG_ID })),
      ).rejects.toThrow(/pilot_calibration_gold_/);
    } finally {
      await client.end();
    }
  });

  test('a gold record is invisible from another organization', async () => {
    const staged = await stage({ clipCode: 'G-TENANCY-READ' });
    const record = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });

    expect(await gold.getGoldRecord(OTHER_ORG_ID, record.gold_record_id)).toBeNull();
    expect(await gold.listGoldRecordsForProject(OTHER_ORG_ID, PROJECT_ID)).toEqual([]);
    await expect(
      gold.promoteGoldRecord({
        organizationId: OTHER_ORG_ID,
        goldRecordId: record.gold_record_id,
        promotedByAccountId: PROMOTER,
      }),
    ).rejects.toThrow(/^Not found/);
  });
});

describe('a governed dataset never blocks a deletion request', () => {
  test('deleting the source video takes a gold + LOCKED_TEST record with it', async () => {
    // THE HARDEST ROW IN THIS SCHEMA TO DELETE ON PURPOSE: promoted into the
    // reference dataset AND held out of training. If any row could be given a
    // reason to survive a data-deletion request made on behalf of a minor, it
    // would be this one. It must not, and the naive form of the annotations
    // freeze trigger would have broken exactly this while looking correct.
    const client = await freshClient();
    try {
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
            blob_path, file_name, file_size_bytes, mime_type, status)
         values ('vs-gold-doomed', $1, $2, null, 'Doomed', 'p/d.mp4', 'd.mp4', 10, 'video/mp4', 'ready')`,
        [ORG_ID, ANNOTATOR_A],
      );
      const staged = await stage({ clipCode: 'G-DOOMED', videoId: 'vs-gold-doomed' });
      const candidate = await gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: staged.adjudicationId,
        eligibility: 'LOCKED_TEST',
      });
      const promoted = await gold.promoteGoldRecord({
        organizationId: ORG_ID,
        goldRecordId: candidate.gold_record_id,
        promotedByAccountId: PROMOTER,
      });
      expect(promoted.governance_state).toBe('gold');
      expect(promoted.eligibility).toBe('LOCKED_TEST');

      await client.query(`delete from pilot.video_sessions where video_session_id = 'vs-gold-doomed'`);

      expect(await gold.getGoldRecord(ORG_ID, promoted.gold_record_id)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('deleting the adjudication alone also removes the record built from it', async () => {
    const staged = await stage({ clipCode: 'G-ADJ-DELETED' });
    const record = await gold.nominateGoldCandidate({
      organizationId: ORG_ID,
      goldRecordId: crypto.randomUUID(),
      adjudicationId: staged.adjudicationId,
      eligibility: 'TRAINING_ELIGIBLE',
    });

    const client = await freshClient();
    try {
      await client.query(
        `delete from pilot.calibration_adjudications
          where organization_id = $1 and adjudication_id = $2`,
        [ORG_ID, staged.adjudicationId],
      );
      expect(await gold.getGoldRecord(ORG_ID, record.gold_record_id)).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('the governance read-out', () => {
  test('lists candidates, gold and excluded alike for one study', async () => {
    // A read-out showing only the promoted rows would answer "what is in the
    // dataset" while hiding "what was considered and kept out", and the second
    // question is the one an audit is usually asking.
    const projectId = crypto.randomUUID();
    await projects.createCalibrationProject({
      organizationId: ORG_ID,
      calibrationProjectId: projectId,
      name: 'Gold read-out study',
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      createdByAccountId: ANNOTATOR_A,
    });

    const states: string[] = [];
    for (const [index, action] of ['leave', 'promote', 'exclude'].entries()) {
      const staged = await stage({ clipCode: `G-READOUT-${index}`, projectId });
      const candidate = await gold.nominateGoldCandidate({
        organizationId: ORG_ID,
        goldRecordId: crypto.randomUUID(),
        adjudicationId: staged.adjudicationId,
        eligibility: 'TRAINING_ELIGIBLE',
      });
      if (action === 'promote') {
        await gold.promoteGoldRecord({
          organizationId: ORG_ID,
          goldRecordId: candidate.gold_record_id,
          promotedByAccountId: PROMOTER,
        });
      }
      if (action === 'exclude') {
        const excluded = await gold.excludeGoldRecord({
          organizationId: ORG_ID,
          goldRecordId: candidate.gold_record_id,
          notes: 'Camera cut across the exchange.',
        });
        expect(excluded.promoted_by_account_id).toBeNull();
      }
      states.push(action);
    }

    const listed = await gold.listGoldRecordsForProject(ORG_ID, projectId);
    expect(listed).toHaveLength(states.length);
    expect(listed.map((row) => row.governance_state).sort()).toEqual([
      'candidate',
      'excluded',
      'gold',
    ]);
  });
});

describe('the shipped migration runner', () => {
  test('REFUSES a database where the gold migration never ran', async () => {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_gold_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_GOLD_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('REFUSES a database whose triggers were dropped but whose table is intact', async () => {
    // The failure a table-existence check cannot see. Every constraint is in
    // place; the rules that stop a WELL-FORMED row are gone.
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
      client: Client,
      sql: string,
    ) => Promise<void>;
    const client = await runnerDatabase('ppbf_test_calib_gold_notrigger');
    try {
      await client.query(await readMigration(GOLD_SQL));
      await client.query(
        `drop trigger pilot_calibration_gold_eligibility_ratchet
           on pilot.calibration_gold_records`,
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_GOLD_NOT_READY/,
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
    const client = await runnerDatabase('ppbf_test_calib_gold_ok');
    try {
      const migrationSql = await readMigration(GOLD_SQL);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
