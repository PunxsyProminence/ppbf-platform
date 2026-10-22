// Real PostgreSQL test for the staff display name write (profileDb.ts
// setStaffDisplayName) and its read on the people screen
// (staffProvisioning.ts listOrganizationMembers); parent-portal Q1 part B.
//
// What needs a real database to prove: that the gate and the write are one
// statement -- a coach or staff member in THIS gym is named, while an athlete,
// a guardian, a board member, a deleted account and a coach of ANOTHER gym are
// refused with nothing written; that a second write overwrites only the name and
// leaves the ring name, corner and portrait state as they were; that a clear
// stores NULL; and that the member list carries the name the gym typed, per gym.
// Spins up the disposable local embedded Postgres the other suites use. It
// never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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

import { setStaffDisplayName } from './profileDb';
import { listOrganizationMembers } from './staffProvisioning';
import { STAFF_DISPLAY_NAME_ROLES } from '@/src/shared/staffDisplayName';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-staff-display-name-write-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-sdw';
const OTHER_ORG = 'org-sdw-other';
const COACH = 'acct-sdw-coach';
const STAFF = 'acct-sdw-staff';
const ADMIN = 'acct-sdw-admin';
const VOLUNTEER = 'acct-sdw-volunteer';
const ATHLETE = 'acct-sdw-athlete';
const GUARDIAN = 'acct-sdw-guardian';
const BOARD = 'acct-sdw-board';
const GONE_COACH = 'acct-sdw-gone-coach';
const OTHER_COACH = 'acct-sdw-other-coach';
/** Homed in ORG, coaching at OTHER_ORG as well: one name per gym. */
const TWO_GYM_COACH = 'acct-sdw-two-gym-coach';

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function addAccount(client: Client, accountId: string, role: string, org: string): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
     values ($1, $2, $3, $4, 'microsoft')`,
    [accountId, `${accountId}@example.com`, role, org],
  );
  await addMembership(client, accountId, role, org);
}

async function addMembership(client: Client, accountId: string, role: string, org: string): Promise<void> {
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)
     on conflict (account_id, organization_id) do nothing`,
    [accountId, org, role],
  );
}

async function freshDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  activeClient = client;

  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await addAccount(client, COACH, 'coach', ORG);
  await addAccount(client, STAFF, 'staff', ORG);
  await addAccount(client, ADMIN, 'organization_admin', ORG);
  await addAccount(client, VOLUNTEER, 'volunteer', ORG);
  await addAccount(client, ATHLETE, 'athlete', ORG);
  await addAccount(client, GUARDIAN, 'parent', ORG);
  await addAccount(client, BOARD, 'coach', ORG);
  await client.query(`update pilot.organization_memberships set role = 'board' where account_id = $1`, [BOARD]);
  await addAccount(client, GONE_COACH, 'coach', ORG);
  await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [GONE_COACH]);
  await addAccount(client, OTHER_COACH, 'coach', OTHER_ORG);
  await addAccount(client, TWO_GYM_COACH, 'coach', ORG);
  await addMembership(client, TWO_GYM_COACH, 'coach', OTHER_ORG);
}

async function storedName(org: string, accountId: string): Promise<unknown[]> {
  const rows = await activeClient!.query(
    'select staff_display_name from pilot.account_profiles where organization_id = $1 and account_id = $2',
    [org, accountId],
  );
  return rows.rows.map((row) => row.staff_display_name);
}

const setName = (org: string, accountId: string, name: string | null) =>
  setStaffDisplayName(org, accountId, name, STAFF_DISPLAY_NAME_ROLES);

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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
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

describe('setStaffDisplayName (Q1 part B)', () => {
  test('names every staff role in this gym, creating the profile row the first time', async () => {
    await freshDatabase('sdw_staff_roles');
    for (const [accountId, name] of [[COACH, 'Mike Neale'], [STAFF, 'Pat Front Desk'], [ADMIN, 'Jason'], [VOLUNTEER, 'Sam']]) {
      expect(await setName(ORG, accountId, name)).toBe(true);
      expect(await storedName(ORG, accountId)).toEqual([name]);
    }
  });

  test('refuses an athlete, a guardian, a board member, a deleted coach and an unknown account, writing nothing', async () => {
    await freshDatabase('sdw_refusals');
    for (const accountId of [ATHLETE, GUARDIAN, BOARD, GONE_COACH, 'acct-sdw-nobody']) {
      expect(await setName(ORG, accountId, 'Someone')).toBe(false);
      expect(await storedName(ORG, accountId)).toEqual([]);
    }
  });

  test("refuses another gym's coach, and leaves that coach's own profile alone", async () => {
    await freshDatabase('sdw_other_gym');
    expect(await setName(OTHER_ORG, OTHER_COACH, 'Their Name')).toBe(true);

    expect(await setName(ORG, OTHER_COACH, 'Our Name')).toBe(false);

    expect(await storedName(ORG, OTHER_COACH)).toEqual([]);
    expect(await storedName(OTHER_ORG, OTHER_COACH)).toEqual(['Their Name']);
  });

  test('a second write overwrites the name only; a clear stores NULL', async () => {
    await freshDatabase('sdw_overwrite');
    await activeClient!.query(
      `insert into pilot.account_profiles (organization_id, account_id, display_nickname, corner)
       values ($1, $2, 'Iron Mike', 'red')`,
      [ORG, COACH],
    );

    expect(await setName(ORG, COACH, 'Mike Neale')).toBe(true);
    expect(await setName(ORG, COACH, 'Michael Neale')).toBe(true);
    const row = await activeClient!.query(
      `select staff_display_name, display_nickname, corner, program, photo_review_state
         from pilot.account_profiles where organization_id = $1 and account_id = $2`,
      [ORG, COACH],
    );
    expect(row.rows).toEqual([{
      staff_display_name: 'Michael Neale',
      display_nickname: 'Iron Mike',
      corner: 'red',
      program: 'unstated',
      photo_review_state: 'pending_review',
    }]);

    expect(await setName(ORG, COACH, null)).toBe(true);
    expect(await storedName(ORG, COACH)).toEqual([null]);
  });

  test('the member list carries the name each gym typed', async () => {
    await freshDatabase('sdw_member_list');
    await setName(ORG, TWO_GYM_COACH, 'Coach At Home');
    await setName(OTHER_ORG, TWO_GYM_COACH, 'Coach Away');

    const here = await listOrganizationMembers(ORG);
    const there = await listOrganizationMembers(OTHER_ORG);
    const nameIn = (members: Awaited<ReturnType<typeof listOrganizationMembers>>, accountId: string) =>
      members.find((member) => member.account_id === accountId)?.staff_display_name;

    expect(nameIn(here, TWO_GYM_COACH)).toBe('Coach At Home');
    expect(nameIn(there, TWO_GYM_COACH)).toBe('Coach Away');
    expect(nameIn(here, COACH)).toBeNull();
  });
});
