// Real PostgreSQL-backed test for the scan claim/settle statements (#49).
//
// These are the only statements in the platform that write
// pilot.video_sessions.status = 'ready'. Everything else about the scan is
// pure logic covered by videoScanPolicy.test.ts; what CANNOT be covered there
// is whether the SQL does what the comments claim -- that FOR UPDATE SKIP
// LOCKED really stops two workers claiming the same video, that the
// `status = 'quarantined'` settle guard really closes the claim-to-settle
// window, and that the backoff really keeps a row out of the queue.
//
// The real module is imported (after env is set), not a copy of its SQL, so
// this suite fails if videoSessions.ts drifts.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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
const PG_DATABASE = 'ppbf_test_video_scan';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-video-scan-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../../../infra/azure/pilot_slice_postgres_video_sessions_migration.sql',
);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type VideoSessionsModule = typeof import('./videoSessions');
let videoSessions: VideoSessionsModule;
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

async function insertQuarantined(id: string, overrides: Record<string, string> = {}): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, 'org-1', 'acct-coach', 'ath-1', 'Session tape', '',
             $2, 'tape.mp4', 1024, 'video/mp4', 'quarantined', now(), now())`,
    [id, `org-1/${id}/tape.mp4`],
  );
  for (const [column, value] of Object.entries(overrides)) {
    await client.query(
      `update pilot.video_sessions set ${column} = $2 where video_session_id = $1`,
      [id, value],
    );
  }
}

async function readRow(id: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    'select * from pilot.video_sessions where video_session_id = $1',
    [id],
  );
  return result.rows[0];
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
  await client.query('create schema if not exists pilot');
  await client.query(await fs.readFile(MIGRATION_PATH, 'utf8'));

  // Env before import: db.ts reads the connection string when its pool is
  // first built, so the dynamic import has to come after this.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  videoSessions = await import('./videoSessions');
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
});

beforeEach(async () => {
  await client.query('truncate pilot.video_sessions');
});

describe('claimNextVideoSessionForScan', () => {
  test('claims a due quarantined video and burns an attempt', async () => {
    await insertQuarantined('vs-1');

    const claim = await videoSessions.claimNextVideoSessionForScan();

    expect(claim).toMatchObject({
      video_session_id: 'vs-1',
      organization_id: 'org-1',
      blob_path: 'org-1/vs-1/tape.mp4',
      status: 'quarantined',
      // Incremented AT CLAIM, so a worker that dies mid-scan still spends an
      // attempt and a video that kills the worker is not retried forever.
      scan_attempts: 1,
    });

    const row = await readRow('vs-1');
    expect(row.scan_state).toBe('scanning');
    expect(row.scan_claimed_at).not.toBeNull();
  });

  test('never claims the same video twice', async () => {
    await insertQuarantined('vs-1');

    expect(await videoSessions.claimNextVideoSessionForScan()).not.toBeNull();
    // Second call finds it already 'scanning' with a fresh claim.
    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });

  test('ignores videos that are not quarantined', async () => {
    await insertQuarantined('vs-ready', { status: 'ready' });
    await insertQuarantined('vs-infected', { status: 'infected' });
    await insertQuarantined('vs-archived', { status: 'archived' });

    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });

  test('ignores videos that already reached a terminal scan state', async () => {
    // These stay quarantined forever by design. Re-claiming them would spin
    // the sweep on verdicts that will not change.
    for (const state of ['passed', 'blocked', 'needs_human_review', 'unconfigured']) {
      await insertQuarantined(`vs-${state}`, { scan_state: state });
    }
    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });

  test('respects the retry backoff', async () => {
    await insertQuarantined('vs-1');
    await client.query(
      "update pilot.video_sessions set scan_next_attempt_at = now() + interval '10 minutes'",
    );
    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();

    await client.query(
      "update pilot.video_sessions set scan_next_attempt_at = now() - interval '1 second'",
    );
    expect(await videoSessions.claimNextVideoSessionForScan()).not.toBeNull();
  });

  test('takes over a stale claim from a worker that died mid-scan', async () => {
    await insertQuarantined('vs-1');
    await client.query(
      `update pilot.video_sessions
       set scan_state = 'scanning', scan_claimed_at = now() - interval '30 minutes'`,
    );

    const claim = await videoSessions.claimNextVideoSessionForScan();
    expect(claim?.video_session_id).toBe('vs-1');
  });

  test('does not steal a claim from a worker that is still scanning', async () => {
    await insertQuarantined('vs-1');
    await client.query(
      `update pilot.video_sessions
       set scan_state = 'scanning', scan_claimed_at = now() - interval '2 minutes'`,
    );

    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });

  test('takes the oldest due video first', async () => {
    await insertQuarantined('vs-new');
    await insertQuarantined('vs-old');
    await client.query(
      "update pilot.video_sessions set created_at = now() - interval '1 day' where video_session_id = 'vs-old'",
    );

    expect((await videoSessions.claimNextVideoSessionForScan())?.video_session_id).toBe('vs-old');
  });

  test('two concurrent workers never claim the same row', async () => {
    // The SKIP LOCKED guarantee, exercised for real rather than asserted from
    // the SQL text. Three videos, three simultaneous claims, three distinct
    // winners.
    await insertQuarantined('vs-1');
    await insertQuarantined('vs-2');
    await insertQuarantined('vs-3');

    const claims = await Promise.all([
      videoSessions.claimNextVideoSessionForScan(),
      videoSessions.claimNextVideoSessionForScan(),
      videoSessions.claimNextVideoSessionForScan(),
    ]);

    const ids = claims.map((claim) => claim?.video_session_id).sort();
    expect(ids).toEqual(['vs-1', 'vs-2', 'vs-3']);
  });
});

describe('settleVideoSessionScan', () => {
  test('a promote is the one thing that makes a video readable', async () => {
    await insertQuarantined('vs-1');
    await videoSessions.claimNextVideoSessionForScan();

    const settled = await videoSessions.settleVideoSessionScan({
      videoSessionId: 'vs-1',
      scanState: 'passed',
      nextStatus: 'ready',
      detail: { decision: 'promote', reason: 'ALL_GATES_PASSED' },
      retryInSeconds: 0,
      terminal: true,
    });

    expect(settled).toBe(true);
    const row = await readRow('vs-1');
    expect(row.status).toBe('ready');
    expect(row.scan_state).toBe('passed');
    expect(row.scanned_at).not.toBeNull();
    expect(row.scan_claimed_at).toBeNull();
    expect(row.scan_detail).toMatchObject({ decision: 'promote' });
  });

  test('a non-promoting decision leaves the video quarantined', async () => {
    for (const scanState of ['blocked', 'needs_human_review', 'pending']) {
      await client.query('truncate pilot.video_sessions');
      await insertQuarantined('vs-1');
      await videoSessions.claimNextVideoSessionForScan();

      await videoSessions.settleVideoSessionScan({
        videoSessionId: 'vs-1',
        scanState,
        nextStatus: null,
        detail: { decision: scanState },
        retryInSeconds: 0,
        terminal: scanState !== 'pending',
      });

      const row = await readRow('vs-1');
      expect(row.status).toBe('quarantined');
      expect(row.scan_state).toBe(scanState);
    }
  });

  test('a retry schedules the next attempt into the future', async () => {
    await insertQuarantined('vs-1');
    await videoSessions.claimNextVideoSessionForScan();

    await videoSessions.settleVideoSessionScan({
      videoSessionId: 'vs-1',
      scanState: 'pending',
      nextStatus: null,
      detail: {},
      retryInSeconds: 120,
      terminal: false,
    });

    // Back in the queue, but not yet due -- which is what stops the sweep
    // re-scanning it on the very next tick.
    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();

    const row = await readRow('vs-1');
    expect(row.scanned_at).toBeNull();
    expect(row.scan_state).toBe('pending');
  });

  test('cannot resurrect a video that stopped being quarantined mid-scan', async () => {
    // The claim-to-settle window. A scan starts, an operator archives the
    // video, the scan finishes and tries to write 'ready'. The guard has to
    // refuse, or an archived video becomes streamable minutes later.
    await insertQuarantined('vs-1');
    await videoSessions.claimNextVideoSessionForScan();
    await client.query("update pilot.video_sessions set status = 'archived'");

    const settled = await videoSessions.settleVideoSessionScan({
      videoSessionId: 'vs-1',
      scanState: 'passed',
      nextStatus: 'ready',
      detail: {},
      retryInSeconds: 0,
      terminal: true,
    });

    expect(settled).toBe(false);
    expect((await readRow('vs-1')).status).toBe('archived');
  });

  test('a malware verdict marks the video infected and it is never claimed again', async () => {
    await insertQuarantined('vs-1');
    await videoSessions.claimNextVideoSessionForScan();

    await videoSessions.settleVideoSessionScan({
      videoSessionId: 'vs-1',
      scanState: 'infected',
      nextStatus: 'infected',
      detail: { decision: 'infected' },
      retryInSeconds: 0,
      terminal: true,
    });

    expect((await readRow('vs-1')).status).toBe('infected');
    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });

  test('settling an unknown id changes nothing and reports false', async () => {
    await insertQuarantined('vs-1');
    const settled = await videoSessions.settleVideoSessionScan({
      videoSessionId: 'no-such-video',
      scanState: 'passed',
      nextStatus: 'ready',
      detail: {},
      retryInSeconds: 0,
      terminal: true,
    });

    expect(settled).toBe(false);
    expect((await readRow('vs-1')).status).toBe('quarantined');
  });

  // The race that mattered. A human 'block' leaves status at 'quarantined' --
  // only an approve moves it to 'ready' -- so the `status = 'quarantined'`
  // guard, which exists to stop a late scan resurrecting a video, did not fire
  // for the one case where a PERSON had refused it.
  //
  // Ordering under test: an administrator blocks the video while a scan is
  // still in flight, then that scan returns with 'passed'/'ready'. Before the
  // scan_state guard, it promoted the video and -- because scan_detail is
  // replaced, not merged -- erased the attestation that a person had refused
  // it. A blocked video of a child would have been published with no trace of
  // the decision.
  test('an in-flight scan cannot overturn a human block, and the attestation survives', async () => {
    await insertQuarantined('vs-1');
    await client.query(
      `update pilot.video_sessions set scan_state = 'needs_human_review'`,
    );
    await videoSessions.claimNextVideoSessionForScan();

    await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'block',
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'admin-1',
      reviewedByRole: 'organization_admin',
      notes: 'A person refused this.',
    });

    const blocked = await readRow('vs-1');
    expect(blocked.status).toBe('quarantined');
    expect(blocked.scan_state).toBe('blocked');

    // The scan that was already running comes back and says it is fine.
    const settled = await videoSessions.settleVideoSessionScan({
      videoSessionId: 'vs-1',
      scanState: 'passed',
      nextStatus: 'ready',
      detail: { decision: 'promote', reason: 'ALL_GATES_PASSED' },
      retryInSeconds: 0,
      terminal: true,
    });

    expect(settled).toBe(false);

    const after = await readRow('vs-1');
    expect(after.status).toBe('quarantined');
    expect(after.scan_state).toBe('blocked');
    // The person's decision is still on the record.
    expect(after.scan_detail).toMatchObject({
      human_review: {
        decision: 'block',
        reviewed_by_account_id: 'admin-1',
        notes: 'A person refused this.',
      },
    });
    // And what the machine concluded afterwards is kept beside it rather than
    // dropped -- a scanner disagreeing with a person is worth being able to
    // look at later.
    expect(after.scan_detail).toMatchObject({
      late_scan_after_human_block: { scan_state: 'passed' },
    });
  });
});

describe('reviewVideoSessionScan (human attestation)', () => {
  test('approving releases the video and keeps the machine verdict it overrode', async () => {
    await insertQuarantined('vs-1');
    await client.query(
      `update pilot.video_sessions
       set scan_state = 'needs_human_review',
           scan_detail = '{"decision":"needs_human_review","reason":"CONTENT_SCREEN_UNCERTAIN","content_verdict":"uncertain"}'::jsonb`,
    );

    const updated = await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'approve',
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'coach-1',
      reviewedByRole: 'coach',
      notes: 'ordinary sparring, poor lighting',
    });

    expect(updated).toMatchObject({ status: 'ready', scan_state: 'passed' });

    const row = await readRow('vs-1');
    expect(row.status).toBe('ready');
    const detail = row.scan_detail as Record<string, unknown>;
    // The override is recorded WITHOUT erasing what the screen concluded --
    // a human-released video must never look like one the screen passed.
    expect(detail.reason).toBe('CONTENT_SCREEN_UNCERTAIN');
    expect(detail.content_verdict).toBe('uncertain');
    expect(detail.human_review).toMatchObject({
      decision: 'approve',
      prior_scan_state: 'needs_human_review',
      reviewed_by_account_id: 'coach-1',
      reviewed_by_role: 'coach',
      notes: 'ordinary sparring, poor lighting',
    });
    expect(row.scanned_at).not.toBeNull();
  });

  test('blocking leaves the video exactly as unwatchable as it was', async () => {
    await insertQuarantined('vs-1');

    const updated = await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'block',
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'coach-1',
      reviewedByRole: 'coach',
    });

    expect(updated).toMatchObject({ status: 'quarantined', scan_state: 'blocked' });
    expect((await readRow('vs-1')).status).toBe('quarantined');
  });

  test('a human override of a blocked verdict is recorded as such', async () => {
    await insertQuarantined('vs-1');
    await client.query("update pilot.video_sessions set scan_state = 'blocked'");

    await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'approve',
      priorScanState: 'blocked',
      reviewedByAccountId: 'admin-1',
      reviewedByRole: 'organization_admin',
    });

    const detail = (await readRow('vs-1')).scan_detail as Record<string, unknown>;
    expect(detail.human_review).toMatchObject({ decision: 'approve', prior_scan_state: 'blocked' });
  });

  test('cannot release a video that is no longer quarantined', async () => {
    // Same claim-to-settle window the sweep has. An archived video must not
    // become streamable because a review was in flight.
    await insertQuarantined('vs-1', { status: 'archived' });

    const updated = await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'approve',
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'coach-1',
      reviewedByRole: 'coach',
    });

    expect(updated).toBeNull();
    expect((await readRow('vs-1')).status).toBe('archived');
  });

  test('is scoped to the organization', async () => {
    await insertQuarantined('vs-1');

    const updated = await videoSessions.reviewVideoSessionScan({
      organizationId: 'someone-elses-org',
      videoSessionId: 'vs-1',
      decision: 'approve',
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'coach-1',
      reviewedByRole: 'coach',
    });

    expect(updated).toBeNull();
    expect((await readRow('vs-1')).status).toBe('quarantined');
  });

  test('a released video is never re-claimed by the sweep', async () => {
    await insertQuarantined('vs-1');
    await videoSessions.reviewVideoSessionScan({
      organizationId: 'org-1',
      videoSessionId: 'vs-1',
      decision: 'approve',
      priorScanState: 'pending',
      reviewedByAccountId: 'coach-1',
      reviewedByRole: 'coach',
    });

    expect(await videoSessions.claimNextVideoSessionForScan()).toBeNull();
  });
});

describe('the sweep end to end against real Postgres', () => {
  // The unit suite proves the sweep calls the right functions; this proves the
  // whole chain actually moves a row. Only the two network boundaries are
  // stubbed -- the verdict itself, and the events table this database does not
  // have. Claim, settle, backoff and the status guard all run for real.
  // resetModules gives each case a fresh registry, which means a fresh db.ts
  // and therefore a fresh pool. Tracked and closed in afterEach: leaving them
  // open let the embedded server's shutdown surface as a wall of discarded
  // idle-connection errors that had nothing to do with the assertions.
  let registryPools: Array<() => Promise<void>> = [];

  async function loadSweep(scanImpl: jest.Mock) {
    jest.resetModules();
    jest.doMock('./videoScan', () => ({ scanVideoSession: scanImpl }));
    jest.doMock('./shadowEvents', () => ({ emitShadowEvent: jest.fn(async () => {}) }));
    const sweepModule = await import('./videoScanSweep');
    const { closePool: closeRegistryPool } = await import('./db');
    registryPools.push(closeRegistryPool);
    return sweepModule.sweepQuarantinedVideos;
  }

  afterEach(async () => {
    for (const close of registryPools) {
      await close().catch(() => {});
    }
    registryPools = [];
    jest.dontMock('./videoScan');
    jest.dontMock('./shadowEvents');
    jest.resetModules();
  });

  test('a quarantined upload becomes readable after a passing scan', async () => {
    await insertQuarantined('vs-1');

    const sweep = await loadSweep(jest.fn(async () => ({
      decision: 'promote' as const,
      gatesEnabled: ['content'],
      gatesPassed: ['content'],
      reason: 'ALL_GATES_PASSED',
      malware: null,
      content: 'pass' as const,
      durationMs: 12,
    })));

    const result = await sweep({ env: { PPBF_VIDEO_CONTENT_SCAN: 'vision' } });

    expect(result).toMatchObject({ scanned: 1, promoted: 1 });
    const row = await readRow('vs-1');
    // This is the assertion the whole task exists for: a video that was
    // unreachable by every reader is now servable.
    expect(row.status).toBe('ready');
    expect(row.scan_state).toBe('passed');
  });

  test('an unconfigured environment leaves the row completely untouched', async () => {
    await insertQuarantined('vs-1');
    const before = await readRow('vs-1');

    const scan = jest.fn();
    const sweep = await loadSweep(scan);
    const result = await sweep({ env: {} });

    expect(result.skippedReason).toBe('not_configured');
    expect(scan).not.toHaveBeenCalled();
    const after = await readRow('vs-1');
    // Not even scan_attempts moved. An environment that cannot produce a
    // verdict must not accumulate evidence that it tried.
    expect(after).toEqual(before);
  });

  test('a retry leaves the video quarantined and out of the queue until it is due', async () => {
    await insertQuarantined('vs-1');

    const sweep = await loadSweep(jest.fn(async () => ({
      decision: 'retry' as const,
      gatesEnabled: ['content'],
      gatesPassed: [],
      reason: 'SCAN_VERDICT_PENDING',
      malware: null,
      content: null,
      durationMs: 3,
    })));

    await sweep({ env: { PPBF_VIDEO_CONTENT_SCAN: 'vision' } });
    expect((await readRow('vs-1')).status).toBe('quarantined');

    // A second sweep in the same minute finds nothing due, so a stuck video
    // cannot spin the worker every tick.
    const second = await sweep({ env: { PPBF_VIDEO_CONTENT_SCAN: 'vision' } });
    expect(second).toMatchObject({ scanned: 0, skippedReason: 'nothing_due' });
    expect((await readRow('vs-1')).scan_attempts).toBe(1);
  });

  test('a refusal keeps the video quarantined permanently', async () => {
    await insertQuarantined('vs-1');

    const sweep = await loadSweep(jest.fn(async () => ({
      decision: 'blocked' as const,
      gatesEnabled: ['content'],
      gatesPassed: [],
      reason: 'CONTENT_SCREEN_REFUSED',
      malware: null,
      content: 'fail' as const,
      durationMs: 9,
    })));

    await sweep({ env: { PPBF_VIDEO_CONTENT_SCAN: 'vision' } });

    const row = await readRow('vs-1');
    expect(row.status).toBe('quarantined');
    expect(row.scan_state).toBe('blocked');

    // And it is never picked up again, no matter how long passes.
    await client.query("update pilot.video_sessions set scan_next_attempt_at = now() - interval '1 day'");
    const second = await sweep({ env: { PPBF_VIDEO_CONTENT_SCAN: 'vision' } });
    expect(second).toMatchObject({ scanned: 0 });
  });
});

describe('scanRetryBackoffSeconds', () => {
  test('doubles from the worker tick and caps', () => {
    expect(videoSessions.scanRetryBackoffSeconds(1)).toBe(30);
    expect(videoSessions.scanRetryBackoffSeconds(2)).toBe(60);
    expect(videoSessions.scanRetryBackoffSeconds(3)).toBe(120);
    expect(videoSessions.scanRetryBackoffSeconds(8)).toBe(1_800);
    // Clamped at both ends, so a nonsense attempt count cannot produce a
    // negative or unbounded delay.
    expect(videoSessions.scanRetryBackoffSeconds(0)).toBe(30);
    expect(videoSessions.scanRetryBackoffSeconds(99)).toBe(1_800);
  });

  test('the whole budget outlasts a slow asynchronous scanner', () => {
    // Defender writes its verdict minutes after upload. If the 8 attempts
    // were spent at worker cadence, every upload would reach human review
    // before the scanner answered -- which would look exactly like the
    // feature not working.
    let total = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      total += videoSessions.scanRetryBackoffSeconds(attempt);
    }
    expect(total).toBeGreaterThan(45 * 60);
  });
});
