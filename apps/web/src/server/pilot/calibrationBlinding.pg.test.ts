// Real PostgreSQL-backed test for BLINDING -- treated as an authorization
// boundary, not as a display preference.
//
// The claim under test is the one the whole calibration study rests on: two
// people label the same clip, and neither can anchor on the other's work.
// Slice 2 made a submitted set unrevisable, which settles what happens to
// annotator A's rows. It says nothing about what annotator A can READ, and a
// study where A copies B's finished set produces perfect agreement figures
// that measure nothing at all.
//
// WHAT IS PROVEN HERE, against a real database rather than a stub:
//
//   * A cannot read B's set, and B cannot read A's, until both are submitted
//   * the blinded set is ABSENT from the annotator's list, not present with
//     nulled fields -- so no id, no count, no timestamp, no "somebody else is
//     working on this" survives to be calibrated against
//   * the events endpoint is blinded with the set, because the events ARE the
//     annotation
//   * an organization administrator gets no privilege on the annotator
//     surface -- the owner's explicit rule, and the one a well-meant admin
//     screen breaks by accident
//   * A submitting leaves B's set and B's events BYTE-IDENTICAL
//   * another organization's sets are invisible even by exact id
//   * the adjudication surface admits only an organization administrator, and
//     only once every set on the clip is submitted
//
// THE TRAP THIS FILE IS WRITTEN AROUND. The naive implementation returns every
// set on the clip and nulls the fields of the ones the reader may not see.
// It passes any test that checks for nulled fields, and it leaks: the row's
// presence discloses the second annotator, its id discloses what to ask about,
// and an event count beside it discloses how much they found. The assertions
// below check ABSENCE.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calib-blinding-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calib_blind';

const BASE_SQL = 'pilot_slice_postgres.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const PROJECTS_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';
const ANNOTATIONS_SQL = 'pilot_slice_postgres_calibration_annotations_migration.sql';

const ORG_ID = 'org-blind';
const OTHER_ORG_ID = 'org-blind-other';

const ANNOTATOR_A = 'acct-blind-a';
const ANNOTATOR_B = 'acct-blind-b';
/** A coach in the same organization who annotates nothing. */
const BYSTANDER = 'acct-blind-bystander';
const ORG_ADMIN = 'acct-blind-admin';
/** An un-migrated row still spelling the same role the old way. */
const LEGACY_ADMIN = 'acct-blind-legacy-admin';
const FOREIGN_ANNOTATOR = 'acct-blind-foreign';

const VIDEO_ID = 'vs-blind-ready';
const FOREIGN_VIDEO_ID = 'vs-blind-foreign';

/** Clip bounds in VIDEO coordinates. Events use the same origin. */
const CLIP_START_MS = 30_000;
const CLIP_END_MS = 42_000;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let annotations: typeof import('./calibration/annotations');
let blinding: typeof import('./calibration/blinding');
let projects: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');

let PROJECT_ID: string;
let FOREIGN_CLIP_ID: string;
let FOREIGN_SET_ID: string;

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

async function seedTenancy(client: Client): Promise<void> {
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }

  // Roles are seeded exactly as the platform spells them, legacy 'admin'
  // included -- the alias is the thing the adjudication gate has to honour,
  // and a fixture that only ever writes 'organization_admin' would let a
  // bare === through unnoticed.
  const accounts: ReadonlyArray<readonly [string, string, string]> = [
    [ANNOTATOR_A, 'coach', ORG_ID],
    [ANNOTATOR_B, 'coach', ORG_ID],
    [BYSTANDER, 'coach', ORG_ID],
    [ORG_ADMIN, 'organization_admin', ORG_ID],
    [LEGACY_ADMIN, 'admin', ORG_ID],
    [FOREIGN_ANNOTATOR, 'coach', OTHER_ORG_ID],
  ];
  for (const [accountId, role, organizationId] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }

  for (const [videoId, organizationId, uploader] of [
    [VIDEO_ID, ORG_ID, ANNOTATOR_A],
    [FOREIGN_VIDEO_ID, OTHER_ORG_ID, FOREIGN_ANNOTATOR],
  ] as const) {
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status)
       values ($1, $2, $3, null, 'Sparring', 'p/blind.mp4', 'blind.mp4', 2048, 'video/mp4', 'ready')
       on conflict do nothing`,
      [videoId, organizationId, uploader],
    );
  }
}

async function newClip(code: string, organizationId = ORG_ID): Promise<string> {
  const clipId = crypto.randomUUID();
  await projects.createCalibrationClip({
    organizationId,
    calibrationClipId: clipId,
    calibrationProjectId: organizationId === ORG_ID ? PROJECT_ID : `${PROJECT_ID}-foreign`,
    videoSessionId: organizationId === ORG_ID ? VIDEO_ID : FOREIGN_VIDEO_ID,
    clipCode: code,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
    primarySamplingReason: 'isolated_punch',
    createdByAccountId: organizationId === ORG_ID ? ANNOTATOR_A : FOREIGN_ANNOTATOR,
  });
  return clipId;
}

async function newSetFor(
  annotatorAccountId: string,
  clipId: string,
  organizationId = ORG_ID,
): Promise<string> {
  const setId = crypto.randomUUID();
  await annotations.openAnnotationSet({
    organizationId,
    annotationSetId: setId,
    calibrationClipId: clipId,
    annotatorAccountId,
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
  });
  return setId;
}

function punchInput(setId: string, offsetMs: number, organizationId = ORG_ID) {
  return {
    organizationId,
    eventId: crypto.randomUUID(),
    annotationSetId: setId,
    eventClass: 'punch' as const,
    actorTrack: 'red',
    opponentTrack: 'blue',
    startMs: CLIP_START_MS + offsetMs,
    endMs: CLIP_START_MS + offsetMs + 400,
    physicalHand: 'left' as const,
    handRole: 'lead' as const,
    punchType: 'lead_straight' as const,
    targetZone: 'head' as const,
    contactResult: 'clean_target_contact' as const,
    visibility: 'clear' as const,
    certainty: 'clear' as const,
  };
}

/** The reader, as the annotator surface sees them. */
function actor(accountId: string, role: 'coach' | 'organization_admin' | 'admin' = 'coach') {
  return { organizationId: ORG_ID, actorAccountId: accountId, actorRole: role } as const;
}

/**
 * A clip with A and B both mid-pass, each carrying events, so every
 * assertion below has something real to leak.
 */
async function stagedClip(
  code: string,
  aEvents = 2,
  bEvents = 3,
): Promise<{ clipId: string; aSetId: string; bSetId: string }> {
  const clipId = await newClip(code);
  const aSetId = await newSetFor(ANNOTATOR_A, clipId);
  const bSetId = await newSetFor(ANNOTATOR_B, clipId);

  for (let i = 0; i < aEvents; i += 1) {
    await annotations.recordAnnotationEvent(punchInput(aSetId, 1_000 + i * 600));
  }
  for (let i = 0; i < bEvents; i += 1) {
    await annotations.recordAnnotationEvent(punchInput(bSetId, 5_000 + i * 600));
  }

  return { clipId, aSetId, bSetId };
}

/** The whole row, every column, as the database holds it -- the only
 *  comparison strong enough to back the phrase "byte-identical". */
async function rawSnapshot(client: Client, setId: string): Promise<string> {
  const set = await client.query(
    `select * from pilot.calibration_annotation_sets
      where organization_id = $1 and annotation_set_id = $2`,
    [ORG_ID, setId],
  );
  const events = await client.query(
    `select * from pilot.calibration_annotation_events
      where organization_id = $1 and annotation_set_id = $2
      order by event_id asc`,
    [ORG_ID, setId],
  );
  return JSON.stringify({ set: set.rows, events: events.rows });
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
  blinding = await import('./calibration/blinding');
  projects = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');

  PROJECT_ID = crypto.randomUUID();
  await projects.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: PROJECT_ID,
    name: 'Blinding slice study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: ANNOTATOR_A,
  });
  await projects.createCalibrationProject({
    organizationId: OTHER_ORG_ID,
    calibrationProjectId: `${PROJECT_ID}-foreign`,
    name: 'Another gym study',
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: FOREIGN_ANNOTATOR,
  });

  // A complete, real, SUBMITTED annotation in the other organization. The
  // cross-org assertions have to run against rows that exist -- a test that
  // proves nothing is returned from an empty tenant proves nothing.
  FOREIGN_CLIP_ID = await newClip('C-FOREIGN', OTHER_ORG_ID);
  FOREIGN_SET_ID = await newSetFor(FOREIGN_ANNOTATOR, FOREIGN_CLIP_ID, OTHER_ORG_ID);
  await annotations.recordAnnotationEvent(punchInput(FOREIGN_SET_ID, 1_000, OTHER_ORG_ID));
  await annotations.submitAnnotationSet(OTHER_ORG_ID, FOREIGN_SET_ID);
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

describe('A cannot read B and B cannot read A', () => {
  test('while both are in progress, each sees only their own set', async () => {
    const { clipId, aSetId, bSetId } = await stagedClip('C-BOTH-OPEN');

    const aSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_A), clipId);
    const bSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_B), clipId);

    // ABSENCE, NOT REDACTION. The list has ONE element. A redacting
    // implementation returns two and passes any assertion that only checks
    // for nulled fields -- and the second row's mere presence is the leak.
    expect(aSees).toHaveLength(1);
    expect(aSees[0].annotation_set_id).toBe(aSetId);
    expect(bSees).toHaveLength(1);
    expect(bSees[0].annotation_set_id).toBe(bSetId);

    // The unblinded read still sees both. If this ever fails, the filter
    // above is passing for the wrong reason -- there was nothing to hide.
    expect(await annotations.listAnnotationSetsForClip(ORG_ID, clipId)).toHaveLength(2);
  });

  test("B's set cannot be reached by id, and answers the same null a missing set does", async () => {
    const { bSetId } = await stagedClip('C-BY-ID');

    expect(await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();
    expect(
      await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), crypto.randomUUID()),
    ).toBeNull();

    // And the row is really there, so the null above is a refusal rather than
    // an accident of the fixture.
    expect(await annotations.getAnnotationSet(ORG_ID, bSetId)).not.toBeNull();
  });

  test("B's events are blinded with B's set, so no count survives", async () => {
    const { aSetId, bSetId } = await stagedClip('C-EVENTS', 2, 3);

    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_B), aSetId)).toBeNull();

    // Null, not an empty array. An empty array is a real answer about a
    // VISIBLE set, and the two must not be conflated -- collapsing them would
    // make "you may not know" indistinguishable from "they found nothing",
    // which is itself a disclosure about the other annotator's work.
    const own = await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_A), aSetId);
    expect(own).toHaveLength(2);

    // The events exist. Three of them.
    expect(await annotations.listAnnotationEvents(ORG_ID, bSetId)).toHaveLength(3);
  });

  test('an annotator reads their own set in every state, including in progress', async () => {
    const { aSetId } = await stagedClip('C-OWN');

    const before = await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), aSetId);
    expect(before?.status).toBe('in_progress');

    await annotations.submitAnnotationSet(ORG_ID, aSetId);

    const after = await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), aSetId);
    expect(after?.status).toBe('submitted');
  });
});

describe('finishing first buys nothing', () => {
  test("B submitting does not open B's set to A", async () => {
    // The single most plausible mistake in this subject matter: gating on the
    // TARGET set's status alone. B finishes, A is still working, and A is
    // handed an answer key -- after which A's remaining work is a
    // transcription and every agreement figure computed later is measuring
    // one reading against a copy of itself.
    const { clipId, aSetId, bSetId } = await stagedClip('C-B-FIRST');
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    expect(await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();

    const aSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_A), clipId);
    expect(aSees.map((set) => set.annotation_set_id)).toEqual([aSetId]);
  });

  test("A submitting does not open B's UNFINISHED set to A", async () => {
    // The other half of the gate, and the half a database test can miss. Every
    // case above has the reader still working, so an implementation that
    // checked only the READER's submission would pass all of them: the reader
    // being unfinished is doing the refusing. Here A has finished and B has
    // not, so the only thing that can refuse is the check on B's state.
    const { clipId, aSetId, bSetId } = await stagedClip('C-A-DONE-B-OPEN', 2, 3);
    await annotations.submitAnnotationSet(ORG_ID, aSetId);

    expect(await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_A), bSetId)).toBeNull();

    const aSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_A), clipId);
    expect(aSees.map((set) => set.annotation_set_id)).toEqual([aSetId]);
  });

  test("A submitting does not open A's set to B either -- the rule is symmetric", async () => {
    const { clipId, aSetId, bSetId } = await stagedClip('C-A-FIRST');
    await annotations.submitAnnotationSet(ORG_ID, aSetId);

    expect(await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_B), aSetId)).toBeNull();
    const bSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_B), clipId);
    expect(bSees.map((set) => set.annotation_set_id)).toEqual([bSetId]);
  });

  test('once BOTH have submitted, each may read the other in full', async () => {
    // The gate has to open, or the study can never be compared and this file
    // would be passing by refusing everything.
    const { clipId, aSetId, bSetId } = await stagedClip('C-BOTH-DONE', 2, 3);
    await annotations.submitAnnotationSet(ORG_ID, aSetId);
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    const aSees = await blinding.listAnnotationSetsForAnnotator(actor(ANNOTATOR_A), clipId);
    expect(aSees.map((set) => set.annotation_set_id).sort()).toEqual([aSetId, bSetId].sort());

    expect((await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), bSetId))?.annotator_account_id)
      .toBe(ANNOTATOR_B);
    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_A), bSetId)).toHaveLength(3);
    expect(await blinding.listAnnotationEventsForAnnotator(actor(ANNOTATOR_B), aSetId)).toHaveLength(2);
  });
});

describe('submission does not touch the other annotator', () => {
  test("A submitting leaves B's set and B's events byte-identical", async () => {
    // "Independent" has to survive the moment one of them finishes. Compared
    // as whole rows, every column, rather than by spot-checking a status --
    // a submission path that stamped anything at all onto the sibling would
    // slip past a narrower assertion.
    const { aSetId, bSetId } = await stagedClip('C-NO-MUTATE', 1, 4);
    const client = await freshClient();
    try {
      const before = await rawSnapshot(client, bSetId);

      await annotations.submitAnnotationSet(ORG_ID, aSetId);

      expect(await rawSnapshot(client, bSetId)).toBe(before);

      // And B carries on working afterwards, so the freeze on A's set has not
      // spread to B's.
      await annotations.recordAnnotationEvent(punchInput(bSetId, 8_000));
      expect(await annotations.listAnnotationEvents(ORG_ID, bSetId)).toHaveLength(5);
      expect((await annotations.getAnnotationSet(ORG_ID, bSetId))?.status).toBe('in_progress');
    } finally {
      await client.end();
    }
  });
});

describe('an administrator is not privileged on the annotator surface', () => {
  test('an organization admin annotating nothing sees nothing, however far along the clip is', async () => {
    // The owner's explicit rule. An admin screen that reused this surface and
    // trusted the role would break blinding without anybody noticing, because
    // it would look like an ordinary list call.
    const { clipId, aSetId, bSetId } = await stagedClip('C-ADMIN');
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    for (const role of ['organization_admin', 'admin'] as const) {
      const context = { organizationId: ORG_ID, actorAccountId: ORG_ADMIN, actorRole: role };
      expect(await blinding.listAnnotationSetsForAnnotator(context, clipId)).toEqual([]);
      expect(await blinding.getAnnotationSetForAnnotator(context, bSetId)).toBeNull();
      expect(await blinding.listAnnotationEventsForAnnotator(context, bSetId)).toBeNull();
      expect(await blinding.getAnnotationSetForAnnotator(context, aSetId)).toBeNull();
    }
  });

  test('an admin who IS one of the two annotators is bound by the same rule', async () => {
    const clipId = await newClip('C-ADMIN-ANNOTATES');
    const adminSetId = await newSetFor(ORG_ADMIN, clipId);
    const bSetId = await newSetFor(ANNOTATOR_B, clipId);
    await annotations.recordAnnotationEvent(punchInput(bSetId, 1_000));
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    const context = {
      organizationId: ORG_ID,
      actorAccountId: ORG_ADMIN,
      actorRole: 'organization_admin' as const,
    };

    // Their own set, yes. B's finished set, not until they finish too.
    expect(await blinding.getAnnotationSetForAnnotator(context, adminSetId)).not.toBeNull();
    expect(await blinding.getAnnotationSetForAnnotator(context, bSetId)).toBeNull();
    expect(
      (await blinding.listAnnotationSetsForAnnotator(context, clipId)).map((s) => s.annotation_set_id),
    ).toEqual([adminSetId]);

    await annotations.submitAnnotationSet(ORG_ID, adminSetId);
    expect(await blinding.getAnnotationSetForAnnotator(context, bSetId)).not.toBeNull();
  });

  test('a coach who annotates nothing on the clip is equally blind', async () => {
    const { clipId, aSetId, bSetId } = await stagedClip('C-BYSTANDER');
    await annotations.submitAnnotationSet(ORG_ID, aSetId);
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    // Both finished. Still nothing, because the bystander is not one of this
    // clip's annotators -- eligibility is standing on THIS clip, not a
    // general permission that unlocks once the work is done.
    expect(await blinding.listAnnotationSetsForAnnotator(actor(BYSTANDER), clipId)).toEqual([]);
    expect(await blinding.getAnnotationSetForAnnotator(actor(BYSTANDER), aSetId)).toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(actor(BYSTANDER), aSetId)).toBeNull();
  });

  test('submitting on one clip does not unlock a different clip', async () => {
    const finished = await stagedClip('C-ELSEWHERE-DONE');
    await annotations.submitAnnotationSet(ORG_ID, finished.aSetId);

    const other = await stagedClip('C-ELSEWHERE-OPEN');
    await annotations.submitAnnotationSet(ORG_ID, other.bSetId);

    // A has submitted -- on the OTHER clip. That must buy nothing here.
    expect(await blinding.getAnnotationSetForAnnotator(actor(ANNOTATOR_A), other.bSetId)).toBeNull();
  });
});

describe('cross-organization isolation', () => {
  test("another gym's submitted set is invisible even by exact id", async () => {
    // A real, complete, submitted annotation in OTHER_ORG_ID -- so this
    // proves a refusal rather than an empty tenant.
    expect(await annotations.getAnnotationSet(OTHER_ORG_ID, FOREIGN_SET_ID)).not.toBeNull();

    for (const accountId of [ANNOTATOR_A, ORG_ADMIN, FOREIGN_ANNOTATOR]) {
      const context = actor(accountId);
      expect(await blinding.getAnnotationSetForAnnotator(context, FOREIGN_SET_ID)).toBeNull();
      expect(await blinding.listAnnotationEventsForAnnotator(context, FOREIGN_SET_ID)).toBeNull();
      expect(await blinding.listAnnotationSetsForAnnotator(context, FOREIGN_CLIP_ID)).toEqual([]);
    }
  });

  test('the foreign annotator still reads their own set inside their own organization', async () => {
    // Negative control for the assertions above: the refusal is about the
    // ORGANIZATION, not about the fixture being broken.
    const context = {
      organizationId: OTHER_ORG_ID,
      actorAccountId: FOREIGN_ANNOTATOR,
      actorRole: 'coach' as const,
    };
    expect(await blinding.getAnnotationSetForAnnotator(context, FOREIGN_SET_ID)).not.toBeNull();
    expect(await blinding.listAnnotationEventsForAnnotator(context, FOREIGN_SET_ID)).toHaveLength(1);
  });

  test("an admin cannot adjudicate another organization's clip", async () => {
    await expect(
      blinding.listAnnotationSetsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'organization_admin', actorAccountId: ORG_ADMIN },
        FOREIGN_CLIP_ID,
      ),
    ).rejects.toThrow(/Not found/);
  });
});

describe('the adjudication surface', () => {
  test('refuses a coach even when the clip is finished', async () => {
    const { clipId, aSetId, bSetId } = await stagedClip('C-ADJ-ROLE');
    await annotations.submitAnnotationSet(ORG_ID, aSetId);
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    for (const role of ['coach', 'athlete', 'parent', 'staff', 'volunteer', 'platform_owner'] as const) {
      await expect(
        blinding.listAnnotationSetsForAdjudication({ organizationId: ORG_ID, actorRole: role, actorAccountId: ORG_ADMIN }, clipId),
      ).rejects.toThrow(/Forbidden: adjudication is limited to organization administrators/);
    }
  });

  test('refuses an admin while either annotator is still working', async () => {
    const { clipId, aSetId } = await stagedClip('C-ADJ-EARLY');
    await annotations.submitAnnotationSet(ORG_ID, aSetId);

    // One submitted, one not. An adjudicator who could read A now would be a
    // channel from A into B by way of a conversation -- the same leak the
    // annotator surface refuses, routed through a third person.
    await expect(
      blinding.listAnnotationSetsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'organization_admin', actorAccountId: ORG_ADMIN },
        clipId,
      ),
    ).rejects.toThrow(/not ready for adjudication/);

    await expect(
      blinding.listAnnotationEventsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'organization_admin', actorAccountId: ORG_ADMIN },
        clipId,
        aSetId,
      ),
    ).rejects.toThrow(/not ready for adjudication/);
  });

  test('admits an organization admin once every set is submitted, and a legacy admin too', async () => {
    const { clipId, aSetId, bSetId } = await stagedClip('C-ADJ-READY', 2, 3);
    await annotations.submitAnnotationSet(ORG_ID, aSetId);
    await annotations.submitAnnotationSet(ORG_ID, bSetId);

    for (const role of ['organization_admin', 'admin'] as const) {
      const context = { organizationId: ORG_ID, actorRole: role, actorAccountId: ORG_ADMIN };
      const sets = await blinding.listAnnotationSetsForAdjudication(context, clipId);
      expect(sets.map((set) => set.annotation_set_id).sort()).toEqual([aSetId, bSetId].sort());

      expect(await blinding.listAnnotationEventsForAdjudication(context, clipId, aSetId)).toHaveLength(2);
      expect(await blinding.listAnnotationEventsForAdjudication(context, clipId, bSetId)).toHaveLength(3);
    }
  });

  test('a clip nobody has annotated is not adjudicable', async () => {
    const clipId = await newClip('C-ADJ-EMPTY');
    await expect(
      blinding.listAnnotationSetsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'organization_admin', actorAccountId: ORG_ADMIN },
        clipId,
      ),
    ).rejects.toThrow(/Not found: no annotation sets on this clip/);
  });

  test('a set id from another clip is not reachable through an eligible one', async () => {
    const ready = await stagedClip('C-ADJ-PAIR-A');
    await annotations.submitAnnotationSet(ORG_ID, ready.aSetId);
    await annotations.submitAnnotationSet(ORG_ID, ready.bSetId);

    const busy = await stagedClip('C-ADJ-PAIR-B');

    // The busy clip's set is nowhere near eligible. Naming it alongside the
    // ready clip's id must not smuggle it through.
    expect(
      await blinding.listAnnotationEventsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'organization_admin', actorAccountId: ORG_ADMIN },
        ready.clipId,
        busy.aSetId,
      ),
    ).toBeNull();
  });

  test('the refusal names WHICH refusal, for the QA read-out', async () => {
    const { clipId, aSetId } = await stagedClip('C-ADJ-REASON');
    await annotations.submitAnnotationSet(ORG_ID, aSetId);

    // A boolean gate could not carry this, which is why the resolver returns
    // a discriminated result and the error carries the reason forward.
    await expect(
      blinding.listAnnotationSetsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'coach', actorAccountId: ORG_ADMIN },
        clipId,
      ),
    ).rejects.toMatchObject({ reason: 'role_not_permitted' });

    await expect(
      blinding.listAnnotationSetsForAdjudication(
        { organizationId: ORG_ID, actorRole: 'admin', actorAccountId: ORG_ADMIN },
        clipId,
      ),
    ).rejects.toMatchObject({ reason: 'annotation_in_progress' });
  });
});

describe('the underlying unblinded read is unchanged', () => {
  test('listAnnotationSetsForClip still returns everything, as its docblock promises', async () => {
    // Slice 2 is at review and this slice must not have altered its
    // behaviour. The QA and adjudication paths depend on that function
    // staying unblinded; the gate is added BESIDE it, never inside it.
    const { clipId, aSetId, bSetId } = await stagedClip('C-UNCHANGED');

    const all = await annotations.listAnnotationSetsForClip(ORG_ID, clipId);
    expect(all.map((set) => set.annotation_set_id).sort()).toEqual([aSetId, bSetId].sort());
    expect(all.every((set) => set.status === 'in_progress')).toBe(true);
  });
});
