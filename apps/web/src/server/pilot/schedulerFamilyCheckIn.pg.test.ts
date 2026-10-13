// Real PostgreSQL-backed test: a family check-in never changes a staff mark
// (Jason 2026-10-12, issue #1524: "A self check-in never replaces a coach or
// admin mark").
//
// The rule lives in the WHERE of FAMILY_ATTENDANCE_UPSERT_SQL's ON CONFLICT
// update, so only a real database can say whether it holds. The audit case
// (F-046) was exactly this: "PRESENT via coach, September 28" became "PRESENT
// via self check-in, October 11" under an unconditional upsert. Each staff
// method is written by the production staff upsert, then a family write is
// attempted over it, and the row must come back byte-identical.
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
}));

import { type SchedulerAttendance, upsertFamilySchedulerAttendance, upsertSchedulerAttendance } from './schedulerDb';

jest.setTimeout(180_000);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-checkin-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG_ID = 'org-family-checkin';
const COACH_ID = 'acct-coach-1';
const ADMIN_ID = 'acct-admin-1';
const ATHLETE_ACCOUNT_ID = 'acct-athlete-1';
const PARENT_ACCOUNT_ID = 'acct-parent-1';
const ATHLETE_ID = 'ATH-FAMILY-1';
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
     values ($1, $2, 'Family Check-in Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth Boxing', now(), now() + interval '1 hour', 'Main Floor', 10, $3, $3, 'open')`,
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

function mark(overrides: Partial<SchedulerAttendance>): SchedulerAttendance {
  const now = new Date().toISOString();
  return {
    attendance_id: `att-${Math.random().toString(36).slice(2, 10)}`,
    class_id: CLASS_ID,
    athlete_id: ATHLETE_ID,
    status: 'present',
    method: 'self',
    checked_in_by_role: 'athlete',
    checked_in_by_account_id: ATHLETE_ACCOUNT_ID,
    note: '',
    checked_in_at: now,
    updated_at: now,
    ...overrides,
  };
}

const familySelf = (status: SchedulerAttendance['status'] = 'present') => mark({ status });
const familyParent = () => mark({ method: 'parent', checked_in_by_role: 'parent', checked_in_by_account_id: PARENT_ACCOUNT_ID });

async function storedRow(client: Client): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select attendance_id, status, method, checked_in_by_role, checked_in_by_account_id, note,
            checked_in_at, updated_at
     from pilot.scheduler_attendance
     where organization_id = $1 and class_id = $2 and athlete_id = $3`,
    [ORG_ID, CLASS_ID, ATHLETE_ID],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as Record<string, unknown>;
}

describe('a family check-in never changes a staff mark', () => {
  test.each([
    ['coach_override', mark({ status: 'absent', method: 'coach_override', checked_in_by_role: 'coach', checked_in_by_account_id: COACH_ID, note: 'Left early; ankle.' })],
    ['admin_override', mark({ status: 'excused', method: 'admin_override', checked_in_by_role: 'organization_admin', checked_in_by_account_id: ADMIN_ID })],
    ['walk_in', mark({ status: 'present', method: 'walk_in', checked_in_by_role: 'coach', checked_in_by_account_id: COACH_ID })],
  ])('over a %s mark: the row is unchanged and the write reports false', async (_method, staffMark) => {
    const client = await freshDatabase(`fci_staff_${_method}`);
    try {
      await upsertSchedulerAttendance(ORG_ID, staffMark);
      const before = await storedRow(client);

      expect(await upsertFamilySchedulerAttendance(ORG_ID, familySelf())).toBe(false);
      expect(await upsertFamilySchedulerAttendance(ORG_ID, familyParent())).toBe(false);

      expect(await storedRow(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});

describe('a family check-in still records what it may', () => {
  test('with no mark yet, it inserts the family row', async () => {
    const client = await freshDatabase('fci_insert');
    try {
      expect(await upsertFamilySchedulerAttendance(ORG_ID, familySelf())).toBe(true);
      expect(await storedRow(client)).toMatchObject({ status: 'present', method: 'self', checked_in_by_role: 'athlete' });
    } finally {
      await client.end();
    }
  });

  test("over the family's own mark, it updates it (a parent after the athlete)", async () => {
    const client = await freshDatabase('fci_family_over_family');
    try {
      await upsertFamilySchedulerAttendance(ORG_ID, familySelf());

      expect(await upsertFamilySchedulerAttendance(ORG_ID, familyParent())).toBe(true);
      expect(await storedRow(client)).toMatchObject({ method: 'parent', checked_in_by_account_id: PARENT_ACCOUNT_ID });
    } finally {
      await client.end();
    }
  });

  test("a parent's mark from before the parent-method migration is still the family's to update", async () => {
    const client = await freshDatabase('fci_legacy_parent');
    try {
      // What that migration left behind: a parent's mark stored as coach_override.
      await upsertSchedulerAttendance(
        ORG_ID,
        mark({ status: 'absent', method: 'coach_override', checked_in_by_role: 'parent', checked_in_by_account_id: PARENT_ACCOUNT_ID }),
      );

      expect(await upsertFamilySchedulerAttendance(ORG_ID, familyParent())).toBe(true);
      expect(await storedRow(client)).toMatchObject({ status: 'present', method: 'parent', checked_in_by_role: 'parent' });
    } finally {
      await client.end();
    }
  });

  test('the register still overwrites a family mark: staff behaviour is unchanged', async () => {
    const client = await freshDatabase('fci_staff_over_family');
    try {
      await upsertFamilySchedulerAttendance(ORG_ID, familySelf());

      await upsertSchedulerAttendance(
        ORG_ID,
        mark({ status: 'absent', method: 'coach_override', checked_in_by_role: 'coach', checked_in_by_account_id: COACH_ID }),
      );

      expect(await storedRow(client)).toMatchObject({ status: 'absent', method: 'coach_override', checked_in_by_account_id: COACH_ID });
    } finally {
      await client.end();
    }
  });
});
