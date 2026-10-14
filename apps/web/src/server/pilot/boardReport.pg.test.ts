// Real PostgreSQL contract for the dated board report (#1542, RP-04): the
// reporting window counts sessions by their date and coach reviews by the gym
// day they were written, both ends inclusive, for this organization's active
// athletes only, through the same suppression as the board summary.
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

import { pathToFileURL } from 'node:url';


import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes boardSummary.ts's query into whichever embedded database the
// current test opened. Declared before the import so jest's mock
// hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-board-report-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');


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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  board = await import('./boardSummary');
});

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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

const ORG_ID = 'org-board-report';
const OTHER_ORG_ID = 'org-board-report-other';
const COACH = 'acct-board-coach';
const OTHER_COACH = 'acct-board-coach-x';
const ATHLETES = ['ATH-B1', 'ATH-B2', 'ATH-B3', 'ATH-B4', 'ATH-B5'];
const DELETED = 'ATH-B6';
const INACTIVE = 'ATH-B7';
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

let board: typeof import('./boardSummary');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const [org, coach] of [[ORG_ID, COACH], [OTHER_ORG_ID, OTHER_COACH]] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
      [coach, org],
    );
  }

  async function athlete(org: string, athleteId: string, coach: string, active = true, deleted = false) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Board Athlete', '2010-01-01', 'fly', 'active', 'contact', $3, $4, now(), now(),
               case when $5 then now() else null end)`,
      [org, athleteId, active, coach, deleted],
    );
  }
  for (const athleteId of ATHLETES) {
    await athlete(ORG_ID, athleteId, COACH);
    // The same ids in the other gym: a read keyed on athlete id alone would mix them.
    await athlete(OTHER_ORG_ID, athleteId, OTHER_COACH);
  }
  await athlete(ORG_ID, DELETED, COACH, true, true);
  await athlete(ORG_ID, INACTIVE, COACH, false);

  return client;
}

async function session(org: string, sessionId: string, athleteId: string, date: string, completed: boolean) {
  await activeClient!.query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
     values ($1, $2, $3, $4::date, 5, 'athlete_post_session_self_report', '', $5, now(), now())`,
    [org, sessionId, athleteId, date, completed],
  );
}

async function review(org: string, reviewId: string, sessionId: string, createdAt: string, approved: boolean) {
  await activeClient!.query(
    `insert into pilot.coach_reviews (organization_id, review_id, session_id, coach_id, decision, notes, approved_flag, created_at, updated_at)
     values ($1, $2, $3, $4, 'reviewed', '', $5, $6::timestamptz, $6::timestamptz)`,
    [org, reviewId, sessionId, org === ORG_ID ? COACH : OTHER_COACH, approved, createdAt],
  );
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_board_report');

  /* Sessions: every athlete trains on September's first day (completed) and
     last day (not), so both ends of the window count. Outside it: one on
     August 31 and one on October 1. A deleted and an inactive athlete train in
     September and do not count. The other gym's same-id athletes train
     mid-September. */
  for (const athleteId of ATHLETES) {
    await session(ORG_ID, `${athleteId}-0901`, athleteId, '2026-09-01', true);
    await session(ORG_ID, `${athleteId}-0930`, athleteId, '2026-09-30', false);
    await session(OTHER_ORG_ID, `${athleteId}-x-0915`, athleteId, '2026-09-15', true);
    await review(OTHER_ORG_ID, `${athleteId}-x-r`, `${athleteId}-x-0915`, '2026-09-15T12:00:00Z', true);
  }
  await session(ORG_ID, 'ATH-B1-0831', 'ATH-B1', '2026-08-31', true);
  await session(ORG_ID, 'ATH-B1-1001', 'ATH-B1', '2026-10-01', true);
  await session(ORG_ID, 'ATH-B6-0915', DELETED, '2026-09-15', true);
  await session(ORG_ID, 'ATH-B7-0915', INACTIVE, '2026-09-15', true);

  /* Reviews, by the gym day they were written (America/New_York, EDT = UTC-4):
       R1 2026-10-01 03:30Z = Sep 30 11:30 pm  in  (UTC says October)
       R2 2026-09-01 03:30Z = Aug 31 11:30 pm  out (UTC says September)
       R3..R6 mid-September                      in
       R7 2026-10-01 04:30Z = Oct 1 12:30 am   out
       R8 2026-09-01 05:00Z = Sep 1 1:00 am    in
       R9 2026-10-01 02:00Z = Sep 30 10:00 pm  in  (UTC says October)
     In the window by gym day: R1 R3 R4 R5 R6 R8 R9 = 7, approved R1 R3 R4. */
  await review(ORG_ID, 'R1', 'ATH-B1-0901', '2026-10-01T03:30:00Z', true);
  await review(ORG_ID, 'R2', 'ATH-B2-0901', '2026-09-01T03:30:00Z', true);
  await review(ORG_ID, 'R3', 'ATH-B2-0930', '2026-09-15T12:00:00Z', true);
  await review(ORG_ID, 'R4', 'ATH-B3-0901', '2026-09-15T12:00:00Z', true);
  await review(ORG_ID, 'R5', 'ATH-B4-0901', '2026-09-15T12:00:00Z', false);
  await review(ORG_ID, 'R6', 'ATH-B5-0901', '2026-09-15T12:00:00Z', false);
  await review(ORG_ID, 'R7', 'ATH-B3-0930', '2026-10-01T04:30:00Z', true);
  await review(ORG_ID, 'R8', 'ATH-B4-0930', '2026-09-01T05:00:00Z', false);
  await review(ORG_ID, 'R9', 'ATH-B5-0930', '2026-10-01T02:00:00Z', false);
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('the dated board report on real rows (RP-04)', () => {
  test("September: sessions on both end days, reviews by the gym day, an inactive athlete's month counted, no deleted or other-gym rows", async () => {
    const report = await board.getBoardReport(ORG_ID, SEPTEMBER);

    expect(report.window).toEqual(SEPTEMBER);
    expect(report.timeZone).toBe('America/New_York');
    expect(report.activeAthletes).toEqual({ status: 'available', count: 5 });
    // 10 from the five active athletes and 1 from the athlete since made
    // inactive; the deleted athlete's session is not counted.
    expect(report.trainingSessions30Days).toEqual({
      status: 'available',
      count: 11,
      completedCount: 6,
      completionRate: 0.5455,
    });
    expect(report.coachReviews30Days).toEqual({
      status: 'available',
      count: 7,
      approvedCount: 3,
      approvalRate: 0.4286,
    });
  });

  test('the other gym reads only its own rows', async () => {
    const report = await board.getBoardReport(OTHER_ORG_ID, SEPTEMBER);

    expect(report.trainingSessions30Days.count).toBe(5);
    expect(report.coachReviews30Days.count).toBe(5);
  });

  test('a window with one athlete is suppressed, and a window with nothing is "no records", never zero', async () => {
    const august31 = await board.getBoardReport(ORG_ID, { from: '2026-08-31', to: '2026-08-31' });
    expect(august31.trainingSessions30Days).toEqual({
      status: 'insufficient_data',
      count: null,
      completedCount: null,
      completionRate: null,
    });
    // R2 was written on the gym's August 31.
    expect(august31.coachReviews30Days.status).toBe('insufficient_data');

    const january = await board.getBoardReport(ORG_ID, { from: '2026-01-01', to: '2026-01-31' });
    expect(january.trainingSessions30Days.status).toBe('unavailable');
    expect(january.coachReviews30Days.status).toBe('unavailable');
  });

  test('deactivating an athlete later does not change a past month', async () => {
    const before = await board.getBoardReport(ORG_ID, SEPTEMBER);
    await activeClient!.query(
      `update pilot.athletes set active_flag = false where organization_id = $1 and athlete_id = 'ATH-B1'`,
      [ORG_ID],
    );
    const after = await board.getBoardReport(ORG_ID, SEPTEMBER);

    expect(after.trainingSessions30Days).toEqual(before.trainingSessions30Days);
    expect(after.coachReviews30Days).toEqual(before.coachReviews30Days);
  });

  test('the same window read twice gives the same figures', async () => {
    const first = await board.getBoardReport(ORG_ID, SEPTEMBER);
    const second = await board.getBoardReport(ORG_ID, SEPTEMBER);

    expect({ ...second, generatedAt: first.generatedAt }).toEqual(first);
  });
});
