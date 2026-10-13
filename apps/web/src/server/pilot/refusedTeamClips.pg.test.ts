// Real PostgreSQL-backed test for the refused-team-clip set (#1445).
//
// './db' is mocked to route into an embedded server, so countRefusedTeamClips
// and listRefusedTeamClips run their production SQL against real rows. Every
// claim this slice makes is a WHERE term -- no athlete, quarantined, refused by
// the content screen, no human decision yet, this organization -- and the
// failure mode of getting one wrong is a plausible number, not an error. One
// clip per term sits just outside the set.
//
// The human decision is written by the production reviewVideoSessionScan, not
// by a hand-built scan_detail, so the test fails if that write ever stops
// recording what the predicate reads.
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

import { countRefusedTeamClips, listRefusedTeamClips } from './refusedTeamClips';
import { reviewVideoSessionScan } from './videoSessions';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-refused-team-clips-pg-test-${Date.now()}`);
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
const ATHLETE = 'ath-1';

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

interface VideoFixture {
  id: string;
  organizationId?: string;
  athleteId?: string | null;
  status: string;
  scanState: string;
  scanDetail?: Record<string, unknown>;
  createdAt: string;
}

async function insertVideo(client: Client, video: VideoFixture): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
        file_name, file_size_bytes, mime_type, status, scan_state, scan_detail, created_at)
     values ($1, $2, $3, $4, $1, 'blob/' || $1, $1 || '.mp4', 1024, 'video/mp4', $5, $6, $7::jsonb, $8::timestamptz)`,
    [
      video.id,
      video.organizationId ?? ORG,
      COACH,
      video.athleteId ?? null,
      video.status,
      video.scanState,
      JSON.stringify(video.scanDetail ?? {}),
      video.createdAt,
    ],
  );
}

/** In the set: two, so the order is asserted rather than assumed. */
const REFUSED_OLD = 'v-refused-old';
const REFUSED_NEW = 'v-refused-new';

/** One per term of the predicate, each just outside the set. */
const OUTSIDE: VideoFixture[] = [
  // Names an athlete: the safety badge counts it through its escalation.
  { id: 'v-athlete-refused', athleteId: ATHLETE, status: 'quarantined', scanState: 'blocked', createdAt: '2026-03-02' },
  // The malware scanner, not the content screen (#1445 Q2.2, default A).
  { id: 'v-infected', status: 'infected', scanState: 'infected', createdAt: '2026-03-03' },
  // Unsure rather than refused.
  { id: 'v-needs-review', status: 'quarantined', scanState: 'needs_human_review', createdAt: '2026-03-04' },
  // Cleared.
  { id: 'v-ready', status: 'ready', scanState: 'passed', createdAt: '2026-03-05' },
  // Refused, but no longer quarantined (archived by an operator).
  { id: 'v-archived', status: 'archived', scanState: 'blocked', createdAt: '2026-03-06' },
  // Another organization's refused team clip.
  { id: 'v-foreign', organizationId: OTHER_ORG, status: 'quarantined', scanState: 'blocked', createdAt: '2026-03-07' },
];

async function seededDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
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
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Scanned Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );

  await insertVideo(client, { id: REFUSED_OLD, status: 'quarantined', scanState: 'blocked', createdAt: '2026-01-01' });
  await insertVideo(client, { id: REFUSED_NEW, status: 'quarantined', scanState: 'blocked', createdAt: '2026-03-01' });
  for (const video of OUTSIDE) {
    await insertVideo(client, video);
  }

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

function decide(videoSessionId: string, decision: 'approve' | 'block') {
  return reviewVideoSessionScan({
    organizationId: ORG,
    videoSessionId,
    decision,
    priorScanState: 'blocked',
    reviewedByAccountId: ADMIN,
    reviewedByRole: 'organization_admin',
  });
}

describe('the refused team clips: one set, counted and listed', () => {
  test('the count and the list are the same two clips, newest first, and nothing just outside the set', async () => {
    const client = await seededDatabase('rtc_set');
    try {
      expect(await countRefusedTeamClips(ORG)).toBe(2);
      const listed = await listRefusedTeamClips(ORG, 100);
      expect(listed.map((row) => row.video_session_id)).toEqual([REFUSED_NEW, REFUSED_OLD]);
      expect(listed.every((row) => row.athlete_id === null && row.scan_state === 'blocked')).toBe(true);

      // The other organization has its own one, and sees only that.
      expect(await countRefusedTeamClips(OTHER_ORG)).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the list honours its limit; the count does not stop at it', async () => {
    const client = await seededDatabase('rtc_limit');
    try {
      expect((await listRefusedTeamClips(ORG, 1)).map((row) => row.video_session_id)).toEqual([REFUSED_NEW]);
      expect(await countRefusedTeamClips(ORG)).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("an administrator's block takes a clip out, though it stays refused and quarantined", async () => {
    const client = await seededDatabase('rtc_block');
    try {
      expect(await decide(REFUSED_OLD, 'block')).not.toBeNull();

      const row = await client.query<{ status: string; scan_state: string }>(
        'select status, scan_state from pilot.video_sessions where video_session_id = $1',
        [REFUSED_OLD],
      );
      expect(row.rows[0]).toEqual({ status: 'quarantined', scan_state: 'blocked' });
      expect(await countRefusedTeamClips(ORG)).toBe(1);
      expect((await listRefusedTeamClips(ORG, 100)).map((r) => r.video_session_id)).toEqual([REFUSED_NEW]);
    } finally {
      await client.end();
    }
  });

  test("an administrator's approve takes a clip out", async () => {
    const client = await seededDatabase('rtc_approve');
    try {
      expect(await decide(REFUSED_NEW, 'approve')).not.toBeNull();

      expect(await countRefusedTeamClips(ORG)).toBe(1);
      expect((await listRefusedTeamClips(ORG, 100)).map((r) => r.video_session_id)).toEqual([REFUSED_OLD]);
    } finally {
      await client.end();
    }
  });
});
