// Real PostgreSQL-backed test for archiving teaching footage.
//
// './db' is mocked to route into an embedded server, so the functions exercised
// below are the production functions running their production SQL against real
// rows. That matters here more than usual, because every claim this slice makes
// lives in a WHERE clause or a JOIN condition:
//
//   - archive is a compare-and-set, so the thing worth testing is what happens
//     when the row is NOT in the status the caller inspected;
//   - the retraction is six `status <> 'archived'` terms spread across two
//     files, and a mocked test would assert that the strings contain them
//     rather than that the counts move;
//   - the released read counts clips and labelled clips through a LATERAL, and
//     the failure mode of getting that wrong is a plausible-looking number
//     (clips multiplied by annotation sets), not an error.
//
// WHY THE SLICE EXISTS. pilot.video_sessions.status has admitted 'archived'
// since the table shipped and nothing ever wrote it, so footage could not be
// taken out of circulation except by a hand-typed UPDATE against production.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import { setVideoArchiveState } from './videoArchive';
import { readReleasedTeachingFootage } from './teachShadow/releasedFootage';
import { readTeachShadowCoverage } from './teachShadow/coverage';
import { BOXING_ONTOLOGY_VERSION_0_1 } from './calibration/ontology';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-video-archive-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-gym';
const OTHER_ORG = 'org-elsewhere';
const COACH = 'acct-coach';
const ADMIN = 'acct-admin';

/** Teaching footage, released, with clips and labels hanging off it. */
const TAUGHT_VIDEO = 'vid-teaching-labelled';
/** Teaching footage, released, nothing cut from it. The test-footage case. */
const BARE_VIDEO = 'vid-teaching-bare';
/** Teaching footage still held. Not archivable, not in the released read. */
const HELD_VIDEO = 'vid-teaching-held';
/** Film Study footage. Archivable, but never in the teaching read. */
const FILM_STUDY_VIDEO = 'vid-film-study';
/** Teaching footage in ANOTHER organization. Must never be reachable. */
const FOREIGN_VIDEO = 'vid-foreign';

const CLIP = 'clip-1';
const SECOND_CLIP = 'clip-2';
// The real constant, not a plausible-looking '0.1'. coverage.ts filters every
// labelling count on BOXING_ONTOLOGY_VERSION_0_1, so a fixture with a different
// version reports zero submitted sets and the retraction test passes for the
// wrong reason -- it would assert 0 before and 0 after.
const ONTOLOGY = BOXING_ONTOLOGY_VERSION_0_1;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

async function insertVideo(
  client: Client,
  params: {
    id: string;
    organizationId: string;
    takeId: string | null;
    status: string;
    uploadedBy?: string;
    cameraView?: string;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
        file_name, file_size_bytes, mime_type, status, scan_state, capture_take_id,
        recording_session_id, camera_view)
     values ($1, $2, $3, null, $1, 'blob/' || $1, $1 || '.mp4', 1024, 'video/mp4', $4, 'passed',
             $5::text, case when $5::text is null then null else $7::text end, $6)`,
    [
      params.id,
      params.organizationId,
      params.uploadedBy ?? COACH,
      params.status,
      params.takeId,
      params.cameraView ?? 'front',
      `rs-${params.organizationId}`,
    ],
  );
}

/**
 * The whole schema, then the five videos above. Athlete ids are deliberately
 * NULL throughout: teaching media names nobody (TS-ANON-01), and a fixture that
 * attached an athlete would be testing a state the platform no longer creates.
 */
async function seededDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  // WITH (FORCE), because a seeding failure in an earlier test leaves a
  // connection open and the next drop would fail with "being accessed by other
  // users" -- turning one real fault into fifteen identical downstream ones.
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
     values ($1, 'coach@ppbf.test', 'coach', $3, 'microsoft'),
            ($2, 'admin@ppbf.test', 'organization_admin', $3, 'microsoft')`,
    [COACH, ADMIN, ORG],
  );

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.recording_sessions
         (recording_session_id, organization_id, created_by_account_id, training_context, join_code)
       values ($1, $2, $3, 'shadowboxing', 'JOIN' || $2)`,
      [`rs-${org}`, org, COACH],
    );
    await client.query(
      `insert into pilot.capture_takes (capture_take_id, recording_session_id, organization_id, take_number, state)
       values ($1, $2, $3, 1, 'closed')`,
      [`take-${org}`, `rs-${org}`, org],
    );
  }

  await insertVideo(client, { id: TAUGHT_VIDEO, organizationId: ORG, takeId: `take-${ORG}`, status: 'ready' });
  await insertVideo(client, { id: BARE_VIDEO, organizationId: ORG, takeId: `take-${ORG}`, status: 'ready', cameraView: 'side' });
  await insertVideo(client, { id: HELD_VIDEO, organizationId: ORG, takeId: `take-${ORG}`, status: 'quarantined' });
  await insertVideo(client, { id: FILM_STUDY_VIDEO, organizationId: ORG, takeId: null, status: 'ready' });
  await insertVideo(client, { id: FOREIGN_VIDEO, organizationId: OTHER_ORG, takeId: `take-${OTHER_ORG}`, status: 'ready' });

  // Two clips from TAUGHT_VIDEO, one of them labelled by a submitted set. Two
  // clips rather than one so a LATERAL that fanned out over the annotation sets
  // would report a number that is wrong rather than one that is coincidentally
  // right.
  await client.query(
    `insert into pilot.calibration_projects
       (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
     values ($1, 'proj-1', 'Calibration', $2, 'annotating', $3)`,
    [ORG, ONTOLOGY, COACH],
  );

  for (const [clipId, code] of [[CLIP, 'C1'], [SECOND_CLIP, 'C2']] as const) {
    await client.query(
      `insert into pilot.calibration_clips
         (organization_id, calibration_clip_id, calibration_project_id, video_session_id, athlete_id,
          clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
       values ($1, $2, 'proj-1', $3, null, $4, 0, 4000, 'isolated_punch', $5)`,
      [ORG, clipId, TAUGHT_VIDEO, code, COACH],
    );
  }

  await client.query(
    `insert into pilot.calibration_annotation_sets
       (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
        ontology_version, status, submitted_at)
     values ($1, 'set-1', $2, $3, $4, 'submitted', now())`,
    [ORG, CLIP, COACH, ONTOLOGY],
  );

  activeClient = client;
  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(() => { activeClient = null; });

afterAll(async () => {
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

async function statusOf(client: Client, videoSessionId: string): Promise<string | null> {
  const result = await client.query<{ status: string }>(
    'select status from pilot.video_sessions where video_session_id = $1',
    [videoSessionId],
  );
  return result.rows[0]?.status ?? null;
}

function archive(videoSessionId: string, organizationId = ORG, reason?: string) {
  return setVideoArchiveState({
    organizationId,
    videoSessionId,
    action: 'archive',
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    reason,
  });
}

describe('archiving footage, and putting it back', () => {
  let client: Client;

  beforeEach(async () => { client = await seededDatabase('video_archive'); });
  afterEach(async () => { await client.end(); });

  test('released footage archives, and the reason is recorded on the row', async () => {
    const updated = await archive(BARE_VIDEO, ORG, 'test footage of a desk');

    expect(updated?.status).toBe('archived');
    expect(await statusOf(client, BARE_VIDEO)).toBe('archived');

    const detail = await client.query<{ reason: string; role: string }>(
      `select scan_detail #>> '{archive,reason}' as reason,
              scan_detail #>> '{archive,decided_by_role}' as role
         from pilot.video_sessions where video_session_id = $1`,
      [BARE_VIDEO],
    );
    expect(detail.rows[0]).toEqual({ reason: 'test footage of a desk', role: 'organization_admin' });
  });

  test('archiving does not touch the media path', async () => {
    // Archive is a withdrawal, not a deletion, and every caller is told so.
    // If this ever stops holding, the wording on the route and the page is a
    // false statement about what the button did.
    const before = await client.query<{ blob_path: string }>(
      'select blob_path from pilot.video_sessions where video_session_id = $1',
      [BARE_VIDEO],
    );
    await archive(BARE_VIDEO);
    const after = await client.query<{ blob_path: string }>(
      'select blob_path from pilot.video_sessions where video_session_id = $1',
      [BARE_VIDEO],
    );
    expect(after.rows[0].blob_path).toBe(before.rows[0].blob_path);
  });

  test('restore returns it to ready', async () => {
    await archive(BARE_VIDEO);
    const restored = await setVideoArchiveState({
      organizationId: ORG,
      videoSessionId: BARE_VIDEO,
      action: 'restore',
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
    });

    expect(restored?.status).toBe('ready');
    expect(await statusOf(client, BARE_VIDEO)).toBe('ready');
  });

  test('held footage cannot be archived, so restore can never promote it', async () => {
    /*
     * THE PAIRING THAT MAKES RESTORE SAFE. Archive accepts 'ready' only, so
     * 'archived' can only have come from 'ready', so restoring to 'ready'
     * returns a row exactly where it was. If archive ever accepted a
     * quarantined row, restore would become a path from quarantine to playback
     * that skips the content screen entirely.
     */
    expect(await archive(HELD_VIDEO)).toBeNull();
    expect(await statusOf(client, HELD_VIDEO)).toBe('quarantined');
  });

  test('archiving twice is refused rather than repeated', async () => {
    expect(await archive(BARE_VIDEO)).not.toBeNull();
    // The compare-and-set misses, which is what lets the route report "this
    // changed while you were looking at it" instead of a second success.
    expect(await archive(BARE_VIDEO)).toBeNull();
  });

  test('another organization cannot archive this one\'s footage', async () => {
    expect(await archive(FOREIGN_VIDEO, ORG)).toBeNull();
    expect(await statusOf(client, FOREIGN_VIDEO)).toBe('ready');
  });

  test('Film Study footage archives too -- the action is not teaching-only', async () => {
    // The LIST is teaching-only, because that is the area the surface lives in.
    // The write is not: withdrawing a Film Study video is the same decision.
    expect((await archive(FILM_STUDY_VIDEO))?.status).toBe('archived');
  });
});

describe('the released teaching footage read', () => {
  let client: Client;

  beforeEach(async () => { client = await seededDatabase('video_archive_list'); });
  afterEach(async () => { await client.end(); });

  test('lists released teaching footage, and counts its clips without multiplying them', async () => {
    const { items } = await readReleasedTeachingFootage(ORG, null, 50);
    const taught = items.find((item) => item.video_session_id === TAUGHT_VIDEO);

    // TWO clips, ONE of them labelled. A GROUP BY over both joins would report
    // clips_cut as 3 here (two clips, one of which has a set) -- a number that
    // looks plausible and is wrong.
    expect(taught).toMatchObject({ clips_cut: 2, clips_labelled: 1, archived: false });
  });

  test('held footage is not in it, and neither is Film Study', async () => {
    const { items } = await readReleasedTeachingFootage(ORG, null, 50);
    const ids = items.map((item) => item.video_session_id);

    expect(ids).toContain(TAUGHT_VIDEO);
    expect(ids).toContain(BARE_VIDEO);
    // Held footage has its own queue; this read is what is IN circulation.
    expect(ids).not.toContain(HELD_VIDEO);
    // The Film Study boundary: teaching surfaces never show Film Study media.
    expect(ids).not.toContain(FILM_STUDY_VIDEO);
    // Tenancy.
    expect(ids).not.toContain(FOREIGN_VIDEO);
  });

  test('archived footage stays listed, marked, with its reason', async () => {
    // A reversible action whose result vanishes from the only screen offering
    // it cannot be reversed by anyone unwilling to write SQL.
    await archive(BARE_VIDEO, ORG, 'test footage');

    const { items } = await readReleasedTeachingFootage(ORG, null, 50);
    const bare = items.find((item) => item.video_session_id === BARE_VIDEO);

    expect(bare).toMatchObject({ archived: true, status: 'archived', archive_reason: 'test footage' });
  });

  test('a restored row reports no archive reason, though the jsonb key survives', async () => {
    /*
     * The `||` merge leaves the archive key in place after a restore. Reporting
     * its reason on live footage would be a false statement about the current
     * state -- "withdrawn because: test footage" on a video that is back in the
     * corpus.
     */
    await archive(BARE_VIDEO, ORG, 'test footage');
    await setVideoArchiveState({
      organizationId: ORG,
      videoSessionId: BARE_VIDEO,
      action: 'restore',
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
    });

    const { items } = await readReleasedTeachingFootage(ORG, null, 50);
    const bare = items.find((item) => item.video_session_id === BARE_VIDEO);

    expect(bare).toMatchObject({ archived: false, archive_reason: null });
  });

  test('a coach sees only their own uploads', async () => {
    await client.query(
      `update pilot.video_sessions set uploaded_by_account_id = $1 where video_session_id = $2`,
      [ADMIN, BARE_VIDEO],
    );

    const { items } = await readReleasedTeachingFootage(ORG, COACH, 50);
    const ids = items.map((item) => item.video_session_id);

    expect(ids).toContain(TAUGHT_VIDEO);
    expect(ids).not.toContain(BARE_VIDEO);
  });
});

describe('what archiving does to the corpus figures', () => {
  let client: Client;

  beforeEach(async () => { client = await seededDatabase('video_archive_coverage'); });
  afterEach(async () => { await client.end(); });

  test('archiving a source video retracts its files, clips and labels', async () => {
    const before = await readTeachShadowCoverage(ORG);

    /*
     * THE WHOLE POINT OF THE SLICE. Before this, every count walked back to
     * the source video and asked only whether it carried a take -- so
     * withdrawing footage changed nothing a coach could see, and archive was a
     * gesture. assertVideoClippable already refused to REOPEN clips cut from
     * archived footage; the figures went on reporting their labels as evidence
     * the recognizer would be taught from.
     */
    expect(before.capture.captured_files).toBe(3); // taught + bare + held
    expect(before.labelling.clips_cut).toBe(2);
    expect(before.labelling.submitted_sets).toBe(1);

    await archive(TAUGHT_VIDEO);

    const after = await readTeachShadowCoverage(ORG);
    expect(after.capture.captured_files).toBe(2);
    expect(after.labelling.clips_cut).toBe(0);
    expect(after.labelling.submitted_sets).toBe(0);
  });

  test('held footage still counts as captured -- only archived footage is retracted', async () => {
    // Held footage was captured and is what a coach is waiting on. Dropping it
    // from the capture ledger would hide the upload the held queue exists to
    // surface.
    const coverage = await readTeachShadowCoverage(ORG);
    expect(coverage.capture.captured_files).toBe(3);
  });

  test('restoring brings the labels back exactly as they were', async () => {
    const before = await readTeachShadowCoverage(ORG);
    await archive(TAUGHT_VIDEO);
    await setVideoArchiveState({
      organizationId: ORG,
      videoSessionId: TAUGHT_VIDEO,
      action: 'restore',
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
    });
    const after = await readTeachShadowCoverage(ORG);

    // Nothing was deleted to make a number move, so the number comes back.
    expect(after.capture.captured_files).toBe(before.capture.captured_files);
    expect(after.labelling.clips_cut).toBe(before.labelling.clips_cut);
    expect(after.labelling.submitted_sets).toBe(before.labelling.submitted_sets);
  });
});
