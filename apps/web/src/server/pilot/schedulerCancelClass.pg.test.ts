// Real PostgreSQL-backed test: cancelling a class is a soft cancel (#1536,
// F-059). "History, registrations and attendance kept" is a property of the
// UPDATE cancelSchedulerClass runs, and "a registration racing a cancel cannot
// land" is a property of the row lock registerForClassTransactionally takes,
// so only a real database can say whether either holds.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

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
  // A real BEGIN/COMMIT, as schedulerMembershipFlag.pg.test.ts does, so the
  // registration runs under the same row lock it takes in production.
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import { cancelSchedulerClass, registerForClassTransactionally, upsertSchedulerAttendance } from './schedulerDb';

jest.setTimeout(180_000);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cancel-class-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG_ID = 'org-cancel-class';
const COACH_ID = 'acct-coach-1';
const ADMIN_ID = 'acct-admin-1';
const ATHLETE_ACCOUNT_ID = 'acct-athlete-1';
const PARENT_ACCOUNT_ID = 'acct-parent-1';
const ATHLETE_ID = 'ATH-CANCEL-1';
const OTHER_ATHLETE_ID = 'ATH-CANCEL-2';
const CLASS_ID = 'class-1';

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $5, 'microsoft'),
            ($2, 'organization_admin', $5, 'microsoft'),
            ($3, 'athlete', $5, 'microsoft'),
            ($4, 'parent', $5, 'microsoft')`,
    [COACH_ID, ADMIN_ID, ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Cancel Class Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now()),
            ($1, $4, 'Second Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID, OTHER_ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth Boxing', now() + interval '1 day', now() + interval '1 day 1 hour', 'Main Floor', 10, $3, $3, 'open')`,
    [ORG_ID, CLASS_ID, COACH_ID],
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

async function registration(athleteId: string) {
  const now = new Date().toISOString();
  return registerForClassTransactionally(ORG_ID, CLASS_ID, athleteId, {
    registration_id: `reg-${athleteId}`,
    class_id: CLASS_ID,
    athlete_id: athleteId,
    requested_by_role: 'coach',
    requested_by_account_id: COACH_ID,
    parent_reviewed: false,
    created_at: now,
    updated_at: now,
  });
}

/** Every row the class owns, as stored: what a soft cancel must leave alone. */
async function classHistory(client: Client) {
  const registrations = await client.query(
    `select * from pilot.scheduler_registrations where organization_id = $1 and class_id = $2 order by registration_id`,
    [ORG_ID, CLASS_ID],
  );
  const attendance = await client.query(
    `select * from pilot.scheduler_attendance where organization_id = $1 and class_id = $2 order by athlete_id`,
    [ORG_ID, CLASS_ID],
  );
  return { registrations: registrations.rows, attendance: attendance.rows };
}

async function classRow(client: Client) {
  const result = await client.query(
    `select title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id,
            covering_coach_account_id, status, created_at, updated_at
     from pilot.scheduler_classes where organization_id = $1 and class_id = $2`,
    [ORG_ID, CLASS_ID],
  );
  return result.rows[0] as Record<string, unknown>;
}

describe('cancelling a class is a soft cancel', () => {
  test('the status reads cancelled; registrations and attendance are byte-identical', async () => {
    const client = await freshDatabase('cc_soft');
    try {
      expect((await registration(ATHLETE_ID)).outcome).toBe('registered');
      expect((await registration(OTHER_ATHLETE_ID)).outcome).toBe('registered');
      const now = new Date().toISOString();
      await upsertSchedulerAttendance(ORG_ID, {
        attendance_id: 'att-1',
        class_id: CLASS_ID,
        athlete_id: ATHLETE_ID,
        status: 'excused',
        method: 'coach_override',
        checked_in_by_role: 'coach',
        checked_in_by_account_id: COACH_ID,
        note: 'Told us ahead of time.',
        checked_in_at: now,
        updated_at: now,
      });
      const historyBefore = await classHistory(client);
      const classBefore = await classRow(client);

      expect(await cancelSchedulerClass(ORG_ID, CLASS_ID, '2030-01-01T00:00:00.000Z')).toBe(true);

      expect(await classHistory(client)).toEqual(historyBefore);
      const classAfter = await classRow(client);
      expect(classAfter.status).toBe('cancelled');
      // Only the status and its timestamp change; the class is still the class.
      expect({ ...classAfter, status: classBefore.status, updated_at: classBefore.updated_at }).toEqual(classBefore);
      expect(new Date(classAfter.updated_at as string).toISOString()).toBe('2030-01-01T00:00:00.000Z');
    } finally {
      await client.end();
    }
  });

  test('a second cancel writes nothing and says so', async () => {
    const client = await freshDatabase('cc_twice');
    try {
      expect(await cancelSchedulerClass(ORG_ID, CLASS_ID, '2030-01-01T00:00:00.000Z')).toBe(true);
      const after = await classRow(client);

      expect(await cancelSchedulerClass(ORG_ID, CLASS_ID, '2031-01-01T00:00:00.000Z')).toBe(false);
      expect(await classRow(client)).toEqual(after);
    } finally {
      await client.end();
    }
  });

  test("another gym's id cancels nothing", async () => {
    const client = await freshDatabase('cc_other_org');
    try {
      expect(await cancelSchedulerClass('org-someone-else', CLASS_ID, '2030-01-01T00:00:00.000Z')).toBe(false);
      expect((await classRow(client)).status).toBe('open');
    } finally {
      await client.end();
    }
  });
});

describe('a cancelled class takes no registration', () => {
  test('registering is refused as class_cancelled and inserts nothing', async () => {
    const client = await freshDatabase('cc_register');
    try {
      await cancelSchedulerClass(ORG_ID, CLASS_ID, new Date().toISOString());
      const before = await classHistory(client);

      expect(await registration(ATHLETE_ID)).toEqual({ outcome: 'class_cancelled' });
      expect(await classHistory(client)).toEqual(before);
      // And the class is not flipped back to open or full by the attempt.
      expect((await classRow(client)).status).toBe('cancelled');
    } finally {
      await client.end();
    }
  });

  test('a class that is full still cancels, and stays cancelled', async () => {
    const client = await freshDatabase('cc_full');
    try {
      await client.query(`update pilot.scheduler_classes set capacity = 1 where organization_id = $1 and class_id = $2`, [ORG_ID, CLASS_ID]);
      expect((await registration(ATHLETE_ID)).outcome).toBe('registered');
      expect((await classRow(client)).status).toBe('full');

      expect(await cancelSchedulerClass(ORG_ID, CLASS_ID, new Date().toISOString())).toBe(true);
      expect(await registration(OTHER_ATHLETE_ID)).toEqual({ outcome: 'class_cancelled' });
      expect((await classRow(client)).status).toBe('cancelled');
    } finally {
      await client.end();
    }
  });
});
