// Real PostgreSQL-backed integration test for the capability-network audit
// finding: membership status (active/lapsed/ended) was read only by
// programMemberships.ts and its own admin page -- registerForClassTransactionally
// checked training holds and never looked at membership at all. This proves
// the fix at the only altitude that can prove it: a real transaction, on the
// real function, against real rows in both pilot.scheduler_registrations and
// pilot.program_memberships.
//
// The behavior under test is deliberately non-blocking: a lapsed/ended
// membership rides along on a successful 'registered'/'waitlisted' outcome
// as membershipFlags, and never turns into a refusal. Whether it SHOULD ever
// block is a real product-policy question the PR leaves open for the owner;
// this suite only proves the conservative (flag, don't block) default.
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
  // A real BEGIN/COMMIT/ROLLBACK, same as trainingHolds.pg.test.ts -- a
  // passthrough mock cannot reproduce Postgres's aborted-transaction
  // semantics (25P02), which is exactly what the membership-flag probe's
  // SAVEPOINT guard exists to survive when the table is not migrated yet.
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

import { registerForClassTransactionally } from './schedulerDb';
import { createMembership, setMembershipStatus } from './programMemberships';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-scheduler-membership-flag-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MEMBERSHIP_MIGRATION_FILE = 'pilot_slice_postgres_program_memberships_migration.sql';

const ORG_ID = 'org-membership-flag';
const COACH_ID = 'acct-coach-1';
const ATHLETE_ID = 'ATH-MEMBERSHIP-FLAG-1';
const CLASS_ID = 'class-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let membershipMigrationSql: string;
let baseSchemaSql: string;

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

async function freshDatabase(name: string, { applyMembershipMigration = true }: { applyMembershipMigration?: boolean } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
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
     values ($1, $2, 'Membership Flag Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  // scheduler_classes/scheduler_registrations already ship in the base
  // schema -- only program_memberships needs its own migration applied.
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth Boxing', now() + interval '1 day', now() + interval '1 day 1 hour', 'Main Floor', 10, $3, $3, 'open')`,
    [ORG_ID, CLASS_ID, COACH_ID],
  );
  if (applyMembershipMigration) {
    await client.query(membershipMigrationSql);
  }
  return client;
}

function registration() {
  const now = new Date().toISOString();
  return {
    registration_id: `reg-${Math.random().toString(36).slice(2, 10)}`,
    class_id: CLASS_ID,
    athlete_id: ATHLETE_ID,
    requested_by_role: 'athlete',
    requested_by_account_id: 'acct-athlete-1',
    parent_reviewed: false,
    created_at: now,
    updated_at: now,
  } as Parameters<typeof registerForClassTransactionally>[3];
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  membershipMigrationSql = await fs.readFile(path.join(INFRA_DIR, MEMBERSHIP_MIGRATION_FILE), 'utf8');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  activeClient = null;
});

describe('registerForClassTransactionally x program membership (non-blocking flag)', () => {
  test('an athlete with no membership record registers normally, with no flags', async () => {
    const client = await freshDatabase('ppbf_test_membflag_none');
    activeClient = client;
    try {
      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({ outcome: 'registered', membershipFlags: [] });
    } finally {
      await client.end();
    }
  });

  test('an active membership registers normally, with no flags', async () => {
    const client = await freshDatabase('ppbf_test_membflag_active');
    activeClient = client;
    try {
      await createMembership({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        programName: 'Youth Boxing',
        startedOn: '2026-06-01',
        createdByAccountId: COACH_ID,
      });

      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({ outcome: 'registered', membershipFlags: [] });
    } finally {
      await client.end();
    }
  });

  // The heart of the finding: a membership that ended today used to be
  // invisible to the registration path entirely. This proves it now surfaces
  // -- and, just as importantly, that the registration still SUCCEEDS. The
  // flag is informational; it must never become a refusal.
  test('a lapsed membership does NOT block registration, and comes back as a flag', async () => {
    const client = await freshDatabase('ppbf_test_membflag_lapsed');
    activeClient = client;
    try {
      const membership = await createMembership({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        programName: 'Youth Boxing',
        startedOn: '2026-01-01',
        createdByAccountId: COACH_ID,
      });
      await setMembershipStatus({ organizationId: ORG_ID, membershipId: membership!.membership_id, status: 'lapsed' });

      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({
        outcome: 'registered',
        membershipFlags: [{ membership_id: membership!.membership_id, program_name: 'Youth Boxing', status: 'lapsed' }],
      });
    } finally {
      await client.end();
    }
  });

  test('an ended membership does NOT block registration either, and flags the same way', async () => {
    const client = await freshDatabase('ppbf_test_membflag_ended');
    activeClient = client;
    try {
      const membership = await createMembership({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        programName: 'Wrestling',
        startedOn: '2024-01-01',
        createdByAccountId: COACH_ID,
      });
      await setMembershipStatus({ organizationId: ORG_ID, membershipId: membership!.membership_id, status: 'ended' });

      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({
        outcome: 'registered',
        membershipFlags: [{ membership_id: membership!.membership_id, program_name: 'Wrestling', status: 'ended' }],
      });
    } finally {
      await client.end();
    }
  });

  // A database that has not run the program-memberships migration yet must
  // degrade to "no flags", never a 500 on the registration path -- the same
  // pre-migration-window contract findRegistrationBlockingHold already
  // guarantees for training holds, proven here for the exact scenario where
  // both probes run on the same client in the same transaction.
  test('a database without the program_memberships table still registers normally, with no flags', async () => {
    const client = await freshDatabase('ppbf_test_membflag_missing', { applyMembershipMigration: false });
    activeClient = client;
    try {
      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({ outcome: 'registered', membershipFlags: [] });
    } finally {
      await client.end();
    }
  });
});
