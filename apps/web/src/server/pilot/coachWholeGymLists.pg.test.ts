// Real PostgreSQL-backed test for issue #1480's PR B: the coach-facing pickers
// and per-record actions that still refused a coach's unassigned athletes after
// the access gate widened to the whole gym (OD-2026-10-11-007, Jason: "lets
// make it coaches to whole gym").
//
// Each case drives the REAL route handler (or module) against real rows, per
// role and per gym:
//
//   GET  /api/pilot/coach/athletes          the athlete picker
//   GET  /api/pilot/coach/attendance-today  today's marks for that roster
//   POST /api/pilot/escalations acknowledge a coach acting on one escalation
//
// (The card list, listCoachCards, is proven against real rows in
// coachCards.pg.test.ts.)
//
// The coach under test is assigned NO athletes and holds NO coverage grant, so
// anything they reach in their own gym they reach through the whole-gym rule
// alone. Another gym's athlete, a deleted athlete, and a parent or athlete
// caller are the controls.
//
// The harness is coachAuthorizedRoster.pg.test.ts's: same embedded server,
// same full-schema fixture, same disposable local-only database. It NEVER
// connects to production or staging.

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

// Routes every query the handlers make into whichever embedded database the
// current test opened. Declared before the imports so jest's hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
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

// Only the session lookup is replaced: who is calling is the variable here.
// Every authorization decision after it runs for real.
jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  requirePrincipal: jest.fn(),
}));

import { GET as getPicker } from '@/app/api/pilot/coach/athletes/route';
import { GET as getAttendanceToday } from '@/app/api/pilot/coach/attendance-today/route';
import { POST as postEscalation } from '@/app/api/pilot/escalations/route';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.setTimeout(180_000);

const mockRequirePrincipal = requirePrincipal as jest.Mock;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-whole-gym-lists-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-wgl';
const OTHER_ORG_ID = 'org-wgl-other';
/** The coach under test: no athlete of record, no coverage grant. */
const UNASSIGNED_COACH = 'acct-wgl-coach-unassigned';
/** The coach every athlete in ORG_ID is assigned to. */
const RECORD_COACH = 'acct-wgl-coach-record';
/** A coach of the other gym. */
const OTHER_GYM_COACH = 'acct-wgl-coach-other-gym';
const ADMIN_ACCOUNT = 'acct-wgl-admin';

const GYM_ATHLETE = 'ATH-WGL-1';
const GYM_ATHLETE_2 = 'ATH-WGL-2';
const DELETED_ATHLETE = 'ATH-WGL-DELETED';
const OTHER_GYM_ATHLETE = 'ATH-WGL-OTHER';

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

async function insertAthlete(
  client: Client,
  organizationId: string,
  athleteId: string,
  coachId: string,
  fullName: string,
): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $4, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [organizationId, athleteId, coachId, fullName],
  );
}

async function insertEscalation(
  client: Client,
  organizationId: string,
  escalationId: string,
  athleteId: string,
  sourceType = 'pain_report',
): Promise<void> {
  await client.query(
    `insert into pilot.safety_escalations (
       organization_id, escalation_id, source_type, athlete_id, severity, reason,
       escalated_to_role, triggered_by
     ) values ($1, $2, $3, $4, 'high', 'test escalation', 'coach', 'system')`,
    [organizationId, escalationId, sourceType, athleteId],
  );
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  for (const [accountId, role, organizationId] of [
    [UNASSIGNED_COACH, 'coach', ORG_ID],
    [RECORD_COACH, 'coach', ORG_ID],
    [ADMIN_ACCOUNT, 'organization_admin', ORG_ID],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG_ID],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }

  await insertAthlete(client, ORG_ID, GYM_ATHLETE, RECORD_COACH, 'Rosa Delgado');
  await insertAthlete(client, ORG_ID, GYM_ATHLETE_2, RECORD_COACH, 'Marcus Webb');
  await insertAthlete(client, ORG_ID, DELETED_ATHLETE, RECORD_COACH, 'Gone Athlete');
  await client.query(
    'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
    [ORG_ID, DELETED_ATHLETE],
  );
  await insertAthlete(client, OTHER_ORG_ID, OTHER_GYM_ATHLETE, OTHER_GYM_COACH, 'Other Gym Athlete');

  return client;
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

afterEach(() => {
  activeClient = null;
  mockRequirePrincipal.mockReset();
});

function signedInAs(accountId: string, role: PilotPrincipal['role'], organizationId = ORG_ID): void {
  mockRequirePrincipal.mockResolvedValue({
    accountId,
    role,
    organizationId,
    athleteId: role === 'athlete' ? GYM_ATHLETE : undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal);
}

async function pickerIds(): Promise<{ status: number; ids: string[] }> {
  const response = await getPicker(new NextRequest('http://localhost/api/pilot/coach/athletes'));
  const body = (await response.json()) as { items?: Array<{ athlete_id: string }> };
  return { status: response.status, ids: (body.items ?? []).map((item) => item.athlete_id).sort() };
}

async function attendanceCovered(): Promise<{ status: number; covered: string[] }> {
  const response = await getAttendanceToday(new NextRequest('http://localhost/api/pilot/coach/attendance-today'));
  const body = (await response.json()) as { covered?: string[] };
  return { status: response.status, covered: [...(body.covered ?? [])].sort() };
}

async function acknowledge(escalationId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await postEscalation(new NextRequest('http://localhost/api/pilot/escalations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'acknowledge', escalation_id: escalationId }),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the athlete picker (real database)', () => {
  test('a coach with no assigned athletes is offered every live athlete of their own gym, and nothing else', async () => {
    const client = await freshDatabase('wgl_picker_coach');
    activeClient = client;
    try {
      signedInAs(UNASSIGNED_COACH, 'coach');
      const { status, ids } = await pickerIds();
      expect(status).toBe(200);
      expect(ids).toEqual([GYM_ATHLETE, GYM_ATHLETE_2].sort());
      expect(ids).not.toContain(DELETED_ATHLETE);
      expect(ids).not.toContain(OTHER_GYM_ATHLETE);
    } finally {
      await client.end();
    }
  });

  test('a coach of the other gym is offered only that gym', async () => {
    const client = await freshDatabase('wgl_picker_other_gym');
    activeClient = client;
    try {
      signedInAs(OTHER_GYM_COACH, 'coach', OTHER_ORG_ID);
      expect((await pickerIds()).ids).toEqual([OTHER_GYM_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('the organization admin is offered the same set as the coach', async () => {
    const client = await freshDatabase('wgl_picker_admin');
    activeClient = client;
    try {
      signedInAs(ADMIN_ACCOUNT, 'organization_admin');
      expect((await pickerIds()).ids).toEqual([GYM_ATHLETE, GYM_ATHLETE_2].sort());
    } finally {
      await client.end();
    }
  });

  test.each(['parent', 'athlete'] as const)('a %s is refused', async (role) => {
    const client = await freshDatabase(`wgl_picker_${role}`);
    activeClient = client;
    try {
      signedInAs(`acct-wgl-${role}`, role);
      const { status, ids } = await pickerIds();
      expect(status).toBe(403);
      expect(ids).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe("today's attendance (real database)", () => {
  test('a coach with no assigned athletes is asked about every live athlete of their own gym', async () => {
    const client = await freshDatabase('wgl_attendance_coach');
    activeClient = client;
    try {
      signedInAs(UNASSIGNED_COACH, 'coach');
      const { status, covered } = await attendanceCovered();
      expect(status).toBe(200);
      expect(covered).toEqual([GYM_ATHLETE, GYM_ATHLETE_2].sort());
    } finally {
      await client.end();
    }
  });

  test('another gym is never covered, and a parent is refused', async () => {
    const client = await freshDatabase('wgl_attendance_controls');
    activeClient = client;
    try {
      signedInAs(OTHER_GYM_COACH, 'coach', OTHER_ORG_ID);
      expect((await attendanceCovered()).covered).toEqual([OTHER_GYM_ATHLETE]);

      signedInAs('acct-wgl-parent', 'parent');
      expect((await attendanceCovered()).status).toBe(403);
    } finally {
      await client.end();
    }
  });
});

describe('acknowledging an escalation (real database)', () => {
  test('a coach acknowledges an escalation for an unassigned athlete of their own gym', async () => {
    const client = await freshDatabase('wgl_escalation_ack');
    activeClient = client;
    try {
      await insertEscalation(client, ORG_ID, 'esc-gym', GYM_ATHLETE);
      signedInAs(UNASSIGNED_COACH, 'coach');

      const { status } = await acknowledge('esc-gym');

      expect(status).toBe(200);
      const row = await client.query(
        'select status, acknowledged_by_account_id from pilot.safety_escalations where organization_id = $1 and escalation_id = $2',
        [ORG_ID, 'esc-gym'],
      );
      expect(row.rows[0]).toEqual({ status: 'acknowledged', acknowledged_by_account_id: UNASSIGNED_COACH });
    } finally {
      await client.end();
    }
  });

  test("another gym's escalation and an athlete_voice escalation answer as missing, and change nothing", async () => {
    const client = await freshDatabase('wgl_escalation_controls');
    activeClient = client;
    try {
      await insertEscalation(client, OTHER_ORG_ID, 'esc-other-gym', OTHER_GYM_ATHLETE);
      await insertEscalation(client, ORG_ID, 'esc-voice', GYM_ATHLETE, 'athlete_voice');
      signedInAs(UNASSIGNED_COACH, 'coach');

      for (const escalationId of ['esc-other-gym', 'esc-voice']) {
        const { status, body } = await acknowledge(escalationId);
        expect(status).toBe(400);
        expect(body).toEqual({ error: 'Missing escalation record' });
      }
      const rows = await client.query(`select status from pilot.safety_escalations order by escalation_id`);
      expect(rows.rows.map((row) => row.status)).toEqual(['open', 'open']);
    } finally {
      await client.end();
    }
  });

  test("a deleted athlete's escalation answers as missing", async () => {
    const client = await freshDatabase('wgl_escalation_deleted');
    activeClient = client;
    try {
      await insertEscalation(client, ORG_ID, 'esc-deleted', DELETED_ATHLETE);
      signedInAs(UNASSIGNED_COACH, 'coach');

      const { status } = await acknowledge('esc-deleted');

      expect(status).toBe(400);
      const row = await client.query(
        'select status from pilot.safety_escalations where organization_id = $1 and escalation_id = $2',
        [ORG_ID, 'esc-deleted'],
      );
      expect(row.rows[0].status).toBe('open');
    } finally {
      await client.end();
    }
  });

  test.each(['parent', 'athlete'] as const)('a %s cannot acknowledge at all', async (role) => {
    const client = await freshDatabase(`wgl_escalation_${role}`);
    activeClient = client;
    try {
      await insertEscalation(client, ORG_ID, 'esc-gym', GYM_ATHLETE);
      signedInAs(`acct-wgl-${role}`, role);

      expect((await acknowledge('esc-gym')).status).toBe(403);
    } finally {
      await client.end();
    }
  });
});
