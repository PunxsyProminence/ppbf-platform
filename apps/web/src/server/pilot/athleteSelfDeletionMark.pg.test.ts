// Real PostgreSQL-backed test: a deleted athlete's own session reaches none of
// their records through the two athlete-self paths that never called the
// access guard.
//
// WHY THIS SUITE EXISTS. #1153 made assertActorCanAccessAthlete's athlete arm
// read the live row (OD-2026-09-29-002 item 10, "10 C"; Jason's "A": a
// deleted athlete's own surviving session is refused like everyone else).
// Two paths check an athlete's own id themselves and never reach that guard:
//   - app/api/pilot/scheduler/route.ts: assertCanActOnAthlete's athlete arm
//     (register, request coaching, check in) and the GET's athlete filter
//     (registrations, coaching requests, attendance);
//   - shadowReadModels.ts resolveAthleteScope's athlete arm (every Shadow
//     read: events, telemetry, authority checks, review projection).
// Both admitted a deleted athlete on an id match alone.
//
// WHY REAL POSTGRES. The fix is "read pilot.athletes.deleted_at"; a mocked db
// cannot tell a query that reads the mark from one that does not.
//
// EVERY REFUSAL HAS A LIVE-ATHLETE CONTROL, run through the same call, so a
// change that broke the athlete role outright cannot pass this file.
//
// The deletion is exactly what deleteAthleteRecord writes to pilot.athletes
// (deleted_at) and nothing else, so the property pinned is "the mark alone
// closes these paths". Session revocation is the other lock and is not
// exercised here: the principal is handed to the route directly.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes every pilot query into the embedded database. Declared before the
// imports so jest's mock hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows;
    }),
    queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows[0] ?? null;
    }),
    withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      await activeClient.query('BEGIN');
      try {
        const result = await fn(activeClient);
        await activeClient.query('COMMIT');
        return result;
      } catch (error) {
        await activeClient.query('ROLLBACK');
        throw error;
      }
    }),
  };
});

// The route takes its principal from here; the rest of the module stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { GET as schedulerGET, POST as schedulerPOST } from '@/app/api/pilot/scheduler/route';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { listShadowEvents } from './shadowReadModels';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-self-deletion-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-asd';
const ADMIN_ACCOUNT = 'acct-admin-asd';
const COACH = 'acct-coach-asd';
/** Soft-deleted after their records are written. */
const DELETED_ATHLETE = 'ATH-ASD-DELETED';
/** Never deleted: the control. */
const LIVE_ATHLETE = 'ATH-ASD-LIVE';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

/** Both athletes are registered and checked in here before the deletion. */
let seededClassId = '';
/** Nobody is registered here; the register attempts below target it. */
let openClassId = '';

const mockRequirePrincipal = requirePrincipal as jest.Mock;

function principal(accountId: string, role: PilotPrincipal['role'], athleteId: string | null = null): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG_ID,
    athleteId,
    sessionToken: `token-${accountId}`,
    authProvider: 'ppbf_local',
  };
}

const adminPrincipal = principal(ADMIN_ACCOUNT, 'organization_admin');
const athletePrincipal = (athleteId: string) => principal(`acct-${athleteId}`, 'athlete', athleteId);

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

async function schedulerPost(actor: PilotPrincipal, body: Record<string, unknown>): Promise<Response> {
  mockRequirePrincipal.mockResolvedValue(actor);
  return schedulerPOST(
    new NextRequest('http://localhost/api/pilot/scheduler', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

async function okJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status: 200, body: expect.anything() });
  return body as T;
}

interface SchedulerView {
  registrations: Array<{ athlete_id: string }>;
  coaching_requests: Array<{ athlete_id: string }>;
  attendance: Array<{ athlete_id: string }>;
}

async function schedulerView(actor: PilotPrincipal): Promise<SchedulerView> {
  mockRequirePrincipal.mockResolvedValue(actor);
  return okJson<SchedulerView>(await schedulerGET(new NextRequest('http://localhost/api/pilot/scheduler')));
}

/**
 * One gym, one admin, one coach, two athletes that differ only in deleted_at.
 * Every scheduler record is written through the route as the admin, the way
 * the gym writes them, BEFORE the deletion -- so each record the deleted
 * athlete is refused below genuinely exists.
 */
async function seed(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  for (const [accountId, role] of [
    [ADMIN_ACCOUNT, 'organization_admin'],
    [COACH, 'coach'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG_ID],
    );
  }
  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Deleted Or Not', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, COACH],
    );
  }

  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  for (const title of ['Seeded class', 'Open class']) {
    const created = await okJson<{ class_id: string }>(
      await schedulerPost(adminPrincipal, {
        action: 'create_class',
        title,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        location: 'Main floor',
        capacity: 20,
      }),
    );
    if (title === 'Seeded class') seededClassId = created.class_id;
    else openClassId = created.class_id;
  }

  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    await okJson(await schedulerPost(adminPrincipal, { action: 'register_class', class_id: seededClassId, athlete_id: athleteId }));
    await okJson(
      await schedulerPost(adminPrincipal, {
        action: 'request_coaching',
        athlete_id: athleteId,
        preferred_at: start.toISOString(),
        goals: 'Footwork',
      }),
    );
    await okJson(
      await schedulerPost(adminPrincipal, {
        action: 'attendance_checkin',
        class_id: seededClassId,
        athlete_id: athleteId,
        status: 'present',
      }),
    );
    await client.query(
      `insert into pilot.shadow_events (organization_id, event_name, entity_type, entity_id, payload)
       values ($1, 'ATHLETE_TEST_EVENT', 'athlete', $2, '{}'::jsonb)`,
      [ORG_ID, athleteId],
    );
  }

  // The deletion: what deleteAthleteRecord writes to the athlete row.
  await client.query(
    `update pilot.athletes set deleted_at = now(), updated_at = now()
     where organization_id = $1 and athlete_id = $2`,
    [ORG_ID, DELETED_ATHLETE],
  );
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists asd_main');
  await admin.query('create database asd_main');
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor('asd_main') });
  await client.connect();
  /* THE WHOLE SCHEMA -- this suite drives feature code and tests no
     migration. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  await seed(client);
});

afterAll(async () => {
  if (activeClient) {
    await activeClient.end();
    activeClient = null;
  }
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe('scheduler: a deleted athlete reads none of their own rows', () => {
  /* Not a fail-first case. listSchedulerStore already drops a deleted
     athlete's registrations, coaching requests and attendance for every role
     (scope B, #1027), so the GET's athlete filter, which reads no mark itself,
     never sees those rows. Pinned here so a change to the store that dropped
     that filter is caught on the athlete's own path too. */
  test('the seeded rows exist in the tables for both athletes', async () => {
    // Without this, an empty athlete view below could mean "never written".
    const counts = await activeClient!.query<{ athlete_id: string; n: string }>(
      `select athlete_id, count(*)::text as n from (
         select athlete_id from pilot.scheduler_registrations where organization_id = $1
         union all select athlete_id from pilot.scheduler_coaching_requests where organization_id = $1
         union all select athlete_id from pilot.scheduler_attendance where organization_id = $1
       ) rows group by athlete_id order by athlete_id`,
      [ORG_ID],
    );
    expect(counts.rows).toEqual([
      { athlete_id: DELETED_ATHLETE, n: '3' },
      { athlete_id: LIVE_ATHLETE, n: '3' },
    ]);
  });

  test('live control: the live athlete sees exactly their own rows', async () => {
    const view = await schedulerView(athletePrincipal(LIVE_ATHLETE));
    for (const collection of [view.registrations, view.coaching_requests, view.attendance]) {
      expect(collection.map((row) => row.athlete_id)).toEqual([LIVE_ATHLETE]);
    }
  });

  test('the deleted athlete sees no registration, coaching request or attendance row', async () => {
    const view = await schedulerView(athletePrincipal(DELETED_ATHLETE));
    expect({
      registrations: view.registrations,
      coaching_requests: view.coaching_requests,
      attendance: view.attendance,
    }).toEqual({ registrations: [], coaching_requests: [], attendance: [] });
  });
});

describe('scheduler: a deleted athlete cannot act on their own record', () => {
  const actions = (classId: () => string) => [
    { action: 'register_class', class_id: classId() },
    { action: 'request_coaching', preferred_at: new Date(Date.now() + 86_400_000).toISOString(), goals: 'Defence' },
    { action: 'attendance_checkin', class_id: seededClassId, status: 'present' },
  ];

  test('register, request coaching and check in are each refused at the live-row check, and nothing is written', async () => {
    const snapshot = async () =>
      (
        await activeClient!.query(
          `select
             (select count(*) from pilot.scheduler_registrations
               where organization_id = $1 and athlete_id = $2)::text as registrations,
             (select count(*) from pilot.scheduler_coaching_requests
               where organization_id = $1 and athlete_id = $2)::text as requests,
             (select json_agg(a order by a.attendance_id) from pilot.scheduler_attendance a
               where a.organization_id = $1 and a.athlete_id = $2)::text as attendance`,
          [ORG_ID, DELETED_ATHLETE],
        )
      ).rows[0];
    const before = await snapshot();
    // The seeded rows are there, so "unchanged" below is not "never written".
    expect({ registrations: before.registrations, requests: before.requests }).toEqual({
      registrations: '1',
      requests: '1',
    });
    expect(before.attendance).not.toBeNull();

    const outcomes: Array<{ action: string; status: number; error: unknown }> = [];
    for (const body of actions(() => openClassId)) {
      const response = await schedulerPost(athletePrincipal(DELETED_ATHLETE), body);
      outcomes.push({ action: body.action, status: response.status, error: (await response.json()).error });
    }
    // The message pins WHICH check refused: the live-row read, not the id
    // match or a missing registration.
    expect(outcomes).toEqual(
      actions(() => openClassId).map((body) => ({
        action: body.action,
        status: 403,
        error: 'Forbidden: athlete does not belong to organization',
      })),
    );

    // Including the attendance row: the refused check-in targets the seeded
    // class, where an upsert would overwrite the row without changing a count.
    expect(await snapshot()).toEqual(before);
  });

  test('live control: the live athlete may register, request coaching and check in', async () => {
    const outcomes: Array<{ action: string; status: number }> = [];
    for (const body of actions(() => openClassId)) {
      const response = await schedulerPost(athletePrincipal(LIVE_ATHLETE), body);
      outcomes.push({ action: body.action, status: response.status });
    }
    expect(outcomes).toEqual(actions(() => openClassId).map((body) => ({ action: body.action, status: 200 })));
  });
});

describe('scheduler: an admin cannot act on a deleted athlete', () => {
  /* The admin arm of assertCanActOnAthlete returned on the role alone and read
     no athlete row, so an admin could register a deleted athlete for a class
     or file a coaching request for them by id. Check-in was already refused,
     as 400 "Missing registration": the registration list drops a deleted
     athlete. */
  async function freshClass(): Promise<string> {
    const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const created = await okJson<{ class_id: string }>(
      await schedulerPost(adminPrincipal, {
        action: 'create_class',
        title: 'Admin arm class',
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
        location: 'Main floor',
        capacity: 20,
      }),
    );
    return created.class_id;
  }

  const counts = async (athleteId: string) =>
    (
      await activeClient!.query(
        `select
           (select count(*) from pilot.scheduler_registrations
             where organization_id = $1 and athlete_id = $2)::text as registrations,
           (select count(*) from pilot.scheduler_coaching_requests
             where organization_id = $1 and athlete_id = $2)::text as requests`,
        [ORG_ID, athleteId],
      )
    ).rows[0];

  test('register and request coaching for a deleted athlete are refused at the live-row check, and nothing is written', async () => {
    const classId = await freshClass();
    const before = await counts(DELETED_ATHLETE);

    const outcomes: Array<{ action: string; status: number; error: unknown }> = [];
    for (const body of [
      { action: 'register_class', class_id: classId, athlete_id: DELETED_ATHLETE },
      { action: 'request_coaching', athlete_id: DELETED_ATHLETE, preferred_at: new Date(Date.now() + 86_400_000).toISOString(), goals: 'Defence' },
    ]) {
      const response = await schedulerPost(adminPrincipal, body);
      outcomes.push({ action: body.action, status: response.status, error: (await response.json()).error });
    }
    expect(outcomes).toEqual(
      ['register_class', 'request_coaching'].map((action) => ({
        action,
        status: 403,
        error: 'Forbidden: athlete does not belong to organization',
      })),
    );
    expect(await counts(DELETED_ATHLETE)).toEqual(before);
  });

  const seededRegistration = async (athleteId: string) =>
    (
      await activeClient!.query<{ registration_id: string; parent_reviewed: boolean; parent_reviewer_account_id: string | null }>(
        `select registration_id, parent_reviewed, parent_reviewer_account_id from pilot.scheduler_registrations
         where organization_id = $1 and athlete_id = $2 and class_id = $3`,
        [ORG_ID, athleteId, seededClassId],
      )
    ).rows[0];

  test("parent_review_registration: an admin cannot mark a deleted athlete's registration reviewed (not found, row unchanged)", async () => {
    /* The registration was loaded by id with no deletion mark, so this
       flipped parent_reviewed on a deleted athlete's row. */
    const before = await seededRegistration(DELETED_ATHLETE);
    expect(before.parent_reviewed).toBe(false);

    const response = await schedulerPost(adminPrincipal, {
      action: 'parent_review_registration',
      registration_id: before.registration_id,
    });
    expect({ status: response.status, error: (await response.json()).error }).toEqual({ status: 404, error: 'Not found' });
    expect(await seededRegistration(DELETED_ATHLETE)).toEqual(before);
  });

  test("live control: the admin may mark the live athlete's registration reviewed", async () => {
    const before = await seededRegistration(LIVE_ATHLETE);
    await okJson(
      await schedulerPost(adminPrincipal, { action: 'parent_review_registration', registration_id: before.registration_id }),
    );
    expect(await seededRegistration(LIVE_ATHLETE)).toEqual(
      expect.objectContaining({ parent_reviewed: true, parent_reviewer_account_id: ADMIN_ACCOUNT }),
    );
  });

  test('live control: the admin may register and request coaching for the live athlete', async () => {
    const classId = await freshClass();
    await okJson(await schedulerPost(adminPrincipal, { action: 'register_class', class_id: classId, athlete_id: LIVE_ATHLETE }));
    await okJson(
      await schedulerPost(adminPrincipal, {
        action: 'request_coaching',
        athlete_id: LIVE_ATHLETE,
        preferred_at: new Date(Date.now() + 86_400_000).toISOString(),
        goals: 'Footwork',
      }),
    );
  });
});

describe('Shadow reads: a deleted athlete sees none of their own athlete-tied rows', () => {
  const context = (athleteId: string) => ({
    organizationId: ORG_ID,
    actorAccountId: `acct-${athleteId}`,
    actorRole: 'athlete' as const,
    athleteId,
  });

  test('live control: the live athlete sees their own event', async () => {
    const rows = await listShadowEvents(context(LIVE_ATHLETE), { eventName: 'ATHLETE_TEST_EVENT' });
    expect(rows.map((row) => row.entity_id)).toEqual([LIVE_ATHLETE]);
  });

  test('the deleted athlete sees nothing, though their event is still in the table', async () => {
    const stored = await activeClient!.query(
      `select 1 from pilot.shadow_events where organization_id = $1 and entity_id = $2`,
      [ORG_ID, DELETED_ATHLETE],
    );
    expect(stored.rows).toHaveLength(1);

    const rows = await listShadowEvents(context(DELETED_ATHLETE), { eventName: 'ATHLETE_TEST_EVENT' });
    expect(rows).toEqual([]);
  });
});
