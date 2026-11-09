// Real PostgreSQL-backed test for the `refused` block of the Teach Shadow
// coverage read: files the content screen turned away (scan_state 'blocked').
// Production SQL against real rows; local embedded Postgres only, never
// production or staging.

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

import { readTeachShadowCoverage } from './teachShadow/coverage';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coverage-refused-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-gym';
const OTHER_ORG = 'org-elsewhere';
const COACH = 'acct-coach';

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
  p: {
    id: string;
    org: string;
    takeId: string | null;
    status: string;
    scanState: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
        file_name, file_size_bytes, mime_type, status, scan_state, scan_detail, capture_take_id,
        recording_session_id, camera_view)
     values ($1, $2, $3, null, $1, 'blob/' || $1, $1 || '.mp4', 1024, 'video/mp4', $4, $5, $6::jsonb,
             $7::text, case when $7::text is null then null else $8::text end, 'front')`,
    [p.id, p.org, COACH, p.status, p.scanState, JSON.stringify(p.detail), p.takeId, `rs-${p.org}`],
  );
}

const REFUSED = { decision: 'blocked', reason: 'CONTENT_SCREEN_REFUSED', content_verdict: 'fail' };

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
     values ($1, 'coach@ppbf.test', 'coach', $2, 'microsoft')`,
    [COACH, ORG],
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


describe('coverage.refused', () => {
  let client: Client;
  beforeEach(async () => { client = await seededDatabase('coverage_refused'); });
  afterEach(async () => { await client.end(); });

  test('empty database: zeros and an empty list, never null', async () => {
    const { refused } = await readTeachShadowCoverage(ORG);
    expect(refused).toEqual({ files: 0, awaiting_human_review: 0, by_reason: [] });
  });

  test('counts, breakdown, archived exclusion, Film Study exclusion, organization boundary', async () => {
    const take = `take-${ORG}`;
    const seed = (id: string, over: Partial<Parameters<typeof insertVideo>[1]> = {}) =>
      insertVideo(client, {
        id, org: ORG, takeId: take, status: 'quarantined', scanState: 'blocked', detail: REFUSED, ...over,
      });

    await seed('vid-b1');
    await seed('vid-b2');
    // A second reason key (fixture value, not a claim about videoScan) and a
    // recorded administrator decision: refused, but not awaiting review.
    await seed('vid-b3', {
      detail: { reason: 'FIXTURE_SECOND_REASON', human_review: { decision: 'blocked' } },
    });
    await seed('vid-archived', { status: 'archived' });
    await seed('vid-accepted', { status: 'ready', scanState: 'passed', detail: { reason: 'ALL_GATES_PASSED' } });
    await seed('vid-film-study', { takeId: null });
    await insertVideo(client, {
      id: 'vid-foreign', org: OTHER_ORG, takeId: `take-${OTHER_ORG}`, status: 'quarantined',
      scanState: 'blocked', detail: REFUSED,
    });

    const { refused } = await readTeachShadowCoverage(ORG);
    expect(refused).toEqual({
      files: 3,
      awaiting_human_review: 2,
      by_reason: [
        { reason: 'CONTENT_SCREEN_REFUSED', files: 2 },
        { reason: 'FIXTURE_SECOND_REASON', files: 1 },
      ],
    });
    // Numbers and reason keys only: no id, file name or title reaches the payload.
    expect(JSON.stringify(refused)).not.toMatch(/vid-|\.mp4/);

    const other = await readTeachShadowCoverage(OTHER_ORG);
    expect(other.refused.files).toBe(1);

    // Archived footage is not counted anywhere else here either, and a
    // refused file does not inflate the capture ledger's accepted figures.
    const cap = await readTeachShadowCoverage(ORG);
    expect(cap.capture.captured_files).toBe(4);
  });

  test('ties on file count sort by reason', async () => {
    for (const [id, reason] of [['vid-z', 'ZZZ'], ['vid-a', 'AAA']] as const) {
      await insertVideo(client, {
        id, org: ORG, takeId: `take-${ORG}`, status: 'quarantined', scanState: 'blocked', detail: { reason },
      });
    }
    const { refused } = await readTeachShadowCoverage(ORG);
    expect(refused.by_reason.map((r) => r.reason)).toEqual(['AAA', 'ZZZ']);
  });
});
