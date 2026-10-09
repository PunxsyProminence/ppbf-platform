/**
 * The scan's consent re-check before the vision call, against real PostgreSQL.
 *
 * Reviewer B on #1369: the sweep checked consent with plain reads, then
 * downloaded and cut the frames, then sent them. A guardian's withdrawal, a
 * photo-only change or a coach's tag naming a photo-only child, committed in
 * that window, was never seen. recheckBeforeVision (videoScanSweep.ts) now
 * asks again under the consent locks and holds them through the call.
 *
 * These tests drive the SHIPPED writers (guardianConsent.ts withdrawMediaConsent
 * and grantMediaConsent, videoClipTags.ts addClipTag) and prove:
 *   - a change committed before the re-check stops the call;
 *   - a change attempted during the call waits until the call is over.
 *
 * Local disposable embedded Postgres only; never production or staging.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

/*
 * For the end-to-end tests below: the blob download and the frame cutter are
 * doubled (no storage, no ffmpeg), and the vision call is counted rather than
 * made. lateCommit runs DURING the download -- after the sweep's first
 * consent check, before the vision call -- which is the window the finding
 * names. Everything else, the sweep, the scan and the re-check, is shipped.
 */
let lateCommit: (() => Promise<unknown>) | null = null;
let visionCalls = 0;
jest.mock('./blob', () => ({
  ...jest.requireActual('./blob'),
  downloadPilotVideoFile: jest.fn(async () => {
    if (lateCommit) await lateCommit();
    return Buffer.from('clip');
  }),
}));
jest.mock('./shadowFilmStudy', () => {
  const actual = jest.requireActual('./shadowFilmStudy');
  return {
    ...actual,
    isFilmStudyVisionConfigured: jest.fn(() => true),
    extractFrames: jest.fn(async ({ directory }: { directory: string }) => {
      const framePath = require('node:path').join(directory, 'frame-1.jpg');
      await require('node:fs/promises').writeFile(framePath, Buffer.from([0xff, 0xd8, 0xff]));
      return { framePaths: [framePath] };
    }),
    analyzeFramesWithVision: jest.fn(async () => {
      visionCalls += 1;
      return { content: 'SCAN_PASS' };
    }),
  };
});

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_scan_recheck';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-scan-recheck-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-scan-recheck';
const COACH_ID = 'acct-recheck-coach';
const PARENT_ID = 'parent-recheck-owner';
const TAGGED_PARENT_ID = 'parent-recheck-tagged';
const ATHLETE_ID = 'ath-recheck-owner';
const TAGGED_ATHLETE_ID = 'ath-recheck-tagged';
const VIDEO_SESSION_ID = 'vs-recheck';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let sweep: typeof import('./videoScanSweep');
let consent: typeof import('./guardianConsent');
let tags: typeof import('./videoClipTags');
let closePool: () => Promise<void>;

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

async function writeConsent(athleteId: string, parentId: string, coversVideo: boolean): Promise<void> {
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Recheck Guardian',
             'parent', now(), 'v1', 'signed', $4)`,
    [ORG_ID, athleteId, parentId, coversVideo],
  );
}

function withdraw() {
  return consent.withdrawMediaConsent({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    parentId: PARENT_ID,
    signedByName: 'Recheck Guardian',
    recordedByAccountId: COACH_ID,
  });
}

function grantPhotoOnly() {
  return consent.grantMediaConsent({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    parentId: PARENT_ID,
    signedByName: 'Recheck Guardian',
    coversVideo: false,
    publicUseAllowed: false,
    recordedByAccountId: COACH_ID,
  });
}

function tagPhotoOnlyChild() {
  return tags.addClipTag({
    organizationId: ORG_ID,
    videoSessionId: VIDEO_SESSION_ID,
    athleteId: TAGGED_ATHLETE_ID,
    eventKind: 'sparring',
    competitionId: null,
    note: '',
    taggedByAccountId: COACH_ID,
  });
}

/**
 * Runs the shipped guard around a stand-in for the vision call. `during`
 * runs while the guard holds its locks; the stand-in returns only once it
 * has settled, so nothing asserted here can leave a transaction open.
 */
async function runGuard(during?: () => Promise<void>) {
  const skips: string[] = [];
  let sent = 0;
  const guard = sweep.recheckBeforeVision(ORG_ID, VIDEO_SESSION_ID, ATHLETE_ID, (reason) => skips.push(reason));
  const result = await guard(async () => {
    sent += 1;
    if (during) await during();
    return 'verdict';
  });
  return { result, sent, skips };
}

/** True once a backend other than this test's own is waiting on a lock. */
async function someoneWaitsOnALock(attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await client.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
    );
    if ((waiting.rowCount ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/*
 * Starts `write` while the guard is inside the vision call and reports whether
 * it had to wait, and whether it finished before the call did. The write is
 * left to complete after the call returns; it is awaited before returning.
 */
async function writeDuringCall(write: () => Promise<unknown>) {
  const order: string[] = [];
  let waited = false;
  let writing: Promise<unknown> | null = null;
  const outcome = await runGuard(async () => {
    writing = write().then(() => { order.push('write-committed'); });
    waited = await someoneWaitsOnALock(80);
    order.push('call-returned');
  });
  await writing;
  return { outcome, waited, order };
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
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Owner Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $4, now(), now()),
            ($1, $3, 'Tagged Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $4, now(), now())`,
    [ORG_ID, ATHLETE_ID, TAGGED_ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, full_name)
     values ($1, $2, 'Owner Guardian'), ($1, $3, 'Tagged Guardian')`,
    [ORG_ID, PARENT_ID, TAGGED_PARENT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother'), ($1, $4, $5, 'father')`,
    [ORG_ID, PARENT_ID, ATHLETE_ID, TAGGED_PARENT_ID, TAGGED_ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Sparring tape', '', $2 || '/tape.mp4', 'tape.mp4', 1024, 'video/mp4', 'quarantined', now(), now())`,
    [VIDEO_SESSION_ID, ORG_ID, COACH_ID, ATHLETE_ID],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  sweep = await import('./videoScanSweep');
  consent = await import('./guardianConsent');
  tags = await import('./videoClipTags');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
  await client?.end();
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

beforeEach(async () => {
  await client.query('delete from pilot.video_clip_tags');
  await client.query('delete from pilot.waivers');
  await writeConsent(ATHLETE_ID, PARENT_ID, true);
  await writeConsent(TAGGED_ATHLETE_ID, TAGGED_PARENT_ID, false);
});

describe('a change committed after the first check stops the vision call', () => {
  test('CONTROL: consent unchanged, the call is made', async () => {
    const { result, sent, skips } = await runGuard();

    expect(sent).toBe(1);
    expect(result).toBe('verdict');
    expect(skips).toEqual([]);
  });

  test('a withdrawal', async () => {
    await withdraw();
    const { result, sent, skips } = await runGuard();

    expect(sent).toBe(0);
    expect(result).toBeNull();
    expect(skips).toEqual(['guardian_consent_withdrawn']);
  });

  test('a photo-only change', async () => {
    await grantPhotoOnly();
    const { result, sent, skips } = await runGuard();

    expect(sent).toBe(0);
    expect(result).toBeNull();
    expect(skips).toEqual(['guardian_consent_excludes_video']);
  });

  test('a new tag naming a photo-only child', async () => {
    await tagPhotoOnlyChild();
    const { result, sent, skips } = await runGuard();

    expect(sent).toBe(0);
    expect(result).toBeNull();
    expect(skips).toEqual(['guardian_consent_excludes_video']);
  });
});

describe('a change attempted during the vision call waits for it to end', () => {
  test('a withdrawal', async () => {
    const { outcome, waited, order } = await writeDuringCall(withdraw);

    expect(outcome.sent).toBe(1);
    expect(waited).toBe(true);
    expect(order).toEqual(['call-returned', 'write-committed']);
  });

  test('a photo-only change', async () => {
    const { outcome, waited, order } = await writeDuringCall(grantPhotoOnly);

    expect(outcome.sent).toBe(1);
    expect(waited).toBe(true);
    expect(order).toEqual(['call-returned', 'write-committed']);
  });

  test('a new tag', async () => {
    const { outcome, waited, order } = await writeDuringCall(tagPhotoOnlyChild);

    expect(outcome.sent).toBe(1);
    expect(waited).toBe(true);
    expect(order).toEqual(['call-returned', 'write-committed']);
  });

  test('the next re-check reads what landed during the call', async () => {
    await writeDuringCall(withdraw);
    const { sent, skips } = await runGuard();

    expect(sent).toBe(0);
    expect(skips).toEqual(['guardian_consent_withdrawn']);
  });
});

describe('end to end: the sweep, with the change landing while the frames are pulled', () => {
  const CONTENT_ON = { PPBF_VIDEO_CONTENT_SCAN: 'vision' };

  beforeEach(async () => {
    visionCalls = 0;
    lateCommit = null;
    await client.query(
      `update pilot.video_sessions
          set status = 'quarantined', scan_state = 'pending', scan_attempts = 0,
              scan_next_attempt_at = now() - interval '1 second', scan_claimed_at = null
        where organization_id = $1 and video_session_id = $2`,
      [ORG_ID, VIDEO_SESSION_ID],
    );
  });

  async function scanRow() {
    const row = await client.query<{ status: string; scan_detail: Record<string, unknown> | null }>(
      'select status, scan_detail from pilot.video_sessions where organization_id = $1 and video_session_id = $2',
      [ORG_ID, VIDEO_SESSION_ID],
    );
    return row.rows[0];
  }

  test('CONTROL: nothing changes, the frames are sent and the video promoted', async () => {
    const result = await sweep.sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result.scanned).toBe(1);
    expect(visionCalls).toBe(1);
    expect((await scanRow()).status).toBe('ready');
  });

  test.each([
    ['a withdrawal', () => withdraw(), 'guardian_consent_withdrawn'],
    ['a photo-only change', () => grantPhotoOnly(), 'guardian_consent_excludes_video'],
    ['a new tag naming a photo-only child', () => tagPhotoOnlyChild(), 'guardian_consent_excludes_video'],
  ])('%s committed mid-download: no frames are sent', async (_name, change, reason) => {
    lateCommit = change;

    const result = await sweep.sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result.scanned).toBe(1);
    expect(visionCalls).toBe(0);
    const row = await scanRow();
    expect(row.status).toBe('quarantined');
    expect(row.scan_detail?.content_skipped_reason).toBe(reason);
  });

  test('the athlete the video is filed under, deleted mid-download: no frames are sent', async () => {
    lateCommit = () => client.query(
      'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
      [ORG_ID, ATHLETE_ID],
    );
    try {
      await sweep.sweepQuarantinedVideos({ env: CONTENT_ON });
    } finally {
      await client.query(
        'update pilot.athletes set deleted_at = null where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );
    }

    expect(visionCalls).toBe(0);
    expect((await scanRow()).scan_detail?.content_skipped_reason).toBe('athlete_deleted');
  });

});

/*
 * Reviewer A on this change: if Postgres ends the held session during the
 * call (idle_in_transaction_session_timeout), pg emits 'error' on a client
 * pg-pool has stopped listening to. Unheard, that is an uncaught exception
 * in the web server. Ended here by hand, as the timeout would.
 */
describe('the session dropped during the vision call', () => {
  test('fails the scan attempt, and nothing goes unheard', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    let outcome: string;
    try {
      outcome = await runGuard(async () => {
        await client.query(
          `select pg_terminate_backend(pid) from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and state = 'idle in transaction'`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      }).then(() => 'committed', () => 'failed');
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(outcome).toBe('failed');
    expect(uncaught).toEqual([]);
  });
});
