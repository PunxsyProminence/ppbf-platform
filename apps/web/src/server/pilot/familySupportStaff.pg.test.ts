// Real PostgreSQL contract for the office's record of support the gym gave a
// family (PH-12b, on PH-12's pilot.family_support_records): an organization
// admin or admin of this gym records and lists it, newest first, named and
// with no account id or email; a coach, another gym's office and a seatless
// admin are refused (the database's seat refusal arrives as a 403); a future
// date and a blank kind are refused (by the app, and by the database when the
// app's clock lets one through); a record is retired once, by an admin, and
// leaves the list -- the loser of two racing retires is a 409; a withdrawn
// athlete's records are hidden and cannot be added to or retired; a recorder
// who has gone is shown as the gym office.
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

import { gymDayIso } from '@/src/lib/gymTime';

import { queryOne } from './db';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes familySupportRecords.ts's queries into the embedded database.
// Declared before the import so jest's mock hoisting sees it.
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

// The app's own future-date check reads the gym day here; a test moves that
// clock forward so the database's check is the one that answers.
jest.mock('@/src/lib/gymTime', () => {
  const actual = jest.requireActual('@/src/lib/gymTime');
  return { ...actual, gymDayIso: jest.fn(actual.gymDayIso) };
});

const mockGymDayIso = gymDayIso as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-support-staff-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let support: typeof import('./familySupportRecords');

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

const ORG = 'org-fss';
const OTHER_ORG = 'org-fss-other';
const COACH = 'acct-fss-coach';
const ORG_ADMIN = 'acct-fss-orgadmin';
const ADMIN = 'acct-fss-admin';
const OTHER_ADMIN = 'acct-fss-other-admin';
const SEATLESS = 'acct-fss-seatless';
const LEAVER = 'acct-fss-leaver';
const LEAVER_EMAIL = 'lee.harper@example.test';
const ORG_ADMIN_EMAIL = 'jane.okafor@example.test';
const ADMIN_EMAIL = 'sam.reyes@example.test';
const ATHLETE = 'ATH-FSS-1';
const SIBLING = 'ATH-FSS-2';
const OTHER_ATHLETE = 'ATH-FSS-X';
const SAME_DAY_ATHLETE = 'ATH-FSS-3';
const WITHDRAWN = 'ATH-FSS-W';

const office = { organizationId: ORG, accountId: ORG_ADMIN, role: 'organization_admin' };
const admin = { organizationId: ORG, accountId: ADMIN, role: 'admin' };

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

  support = await import('./familySupportRecords');

  const name = 'ppbf_test_family_support_staff';
  const root = new Client({ connectionString: connectionStringFor('postgres') });
  await root.connect();
  await root.query(`drop database if exists ${name}`);
  await root.query(`create database ${name}`);
  await root.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org, email] of [
    [COACH, 'coach', ORG, 'coach.one@example.test'],
    [ORG_ADMIN, 'organization_admin', ORG, ORG_ADMIN_EMAIL],
    [ADMIN, 'admin', ORG, ADMIN_EMAIL],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG, 'other.office@example.test'],
    [SEATLESS, 'organization_admin', ORG, 'no.seat@example.test'],
    [LEAVER, 'organization_admin', ORG, LEAVER_EMAIL],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
      [accountId, role, org, email],
    );
  }
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts). SEATLESS has none.
  for (const [accountId, org, role] of [
    [COACH, ORG, 'coach'],
    [ORG_ADMIN, ORG, 'organization_admin'],
    [ADMIN, ORG, 'admin'],
    [OTHER_ADMIN, OTHER_ORG, 'organization_admin'],
    [LEAVER, ORG, 'organization_admin'],
  ] as const) {
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, $3)`,
      [accountId, org, role],
    );
  }
  for (const [org, athleteId] of [
    [ORG, ATHLETE], [ORG, SIBLING], [ORG, SAME_DAY_ATHLETE], [ORG, WITHDRAWN], [OTHER_ORG, OTHER_ATHLETE],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Support Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
  }
  activeClient = client;
});

afterAll(async () => {
  await activeClient?.end();
  activeClient = null;
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
  // Windows can hold the folder a moment after Postgres exits; the helper's sweep clears it next run.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

async function rowCount(): Promise<number> {
  const result = await activeClient!.query('select count(*)::int as n from pilot.family_support_records');
  return result.rows[0].n as number;
}

describe('the office records family support (PH-12b)', () => {
  test('an organization admin and an admin record it; the list is newest first, named, with no ids or emails', async () => {
    await support.recordSupport(office, ATHLETE, '  Gloves and wraps  ', '2026-09-30');
    await support.recordSupport(admin, ATHLETE, 'Transportation to the October 12 tournament', '2026-10-12');

    const items = await support.listSupportForStaff(ORG, ATHLETE);
    expect(items.map(({ support_kind, provided_on, recorded_by_name }) => ({ support_kind, provided_on, recorded_by_name }))).toEqual([
      { support_kind: 'Transportation to the October 12 tournament', provided_on: '2026-10-12', recorded_by_name: 'Sam Reyes' },
      { support_kind: 'Gloves and wraps', provided_on: '2026-09-30', recorded_by_name: 'Jane Okafor' },
    ]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['created_at', 'provided_on', 'record_id', 'recorded_by_name', 'support_kind']);
    }
    const text = JSON.stringify(items);
    for (const secret of [ORG_ADMIN, ADMIN, ORG_ADMIN_EMAIL, ADMIN_EMAIL, '@']) expect(text).not.toContain(secret);
    // Another athlete's list does not carry them.
    expect(await support.listSupportForStaff(ORG, SIBLING)).toEqual([]);
  });

  test('a coach is refused, before any write', async () => {
    const before = await rowCount();
    await expect(support.recordSupport({ organizationId: ORG, accountId: COACH, role: 'coach' }, ATHLETE, 'Gloves', '2026-10-01'))
      .rejects.toMatchObject({ status: 403 });
    // A coach's account claiming the office role is refused by the seat check.
    await expect(support.recordSupport({ organizationId: ORG, accountId: COACH, role: 'organization_admin' }, ATHLETE, 'Gloves', '2026-10-01'))
      .rejects.toMatchObject({ status: 403 });
    expect(await rowCount()).toBe(before);
  });

  test("another gym's office is refused: it cannot reach this gym's athletes or records", async () => {
    const otherOffice = { organizationId: OTHER_ORG, accountId: OTHER_ADMIN, role: 'organization_admin' };
    expect(await support.recordSupport(otherOffice, ATHLETE, 'Gloves', '2026-10-01')).toBeNull();
    // Its account named against this gym holds no seat here.
    await expect(support.recordSupport({ ...otherOffice, organizationId: ORG }, ATHLETE, 'Gloves', '2026-10-01'))
      .rejects.toMatchObject({ status: 403 });

    const created = await support.recordSupport(office, SIBLING, 'Fee covered for October', '2026-10-02');
    expect(await support.retireSupport(otherOffice, created!.record_id)).toBeNull();
    expect(await support.listSupportForStaff(OTHER_ORG, SIBLING)).toEqual([]);
    expect((await support.listSupportForStaff(ORG, SIBLING)).map((item) => item.support_kind)).toEqual(['Fee covered for October']);
  });

  test('a future date, a date that does not exist and a blank or overlong kind are refused', async () => {
    const before = await rowCount();
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const [kind, date] of [
      ['Gloves', tomorrow],
      ['Gloves', '2999-01-01'],
      ['Gloves', '2026-02-30'],
      ['Gloves', 'October 1'],
      ['   ', '2026-10-01'],
      ['', '2026-10-01'],
      ['x'.repeat(201), '2026-10-01'],
    ] as const) {
      await expect(support.recordSupport(office, ATHLETE, kind, date)).rejects.toMatchObject({ status: 400 });
    }
    expect(await rowCount()).toBe(before);
  });

  test('a record is retired once, by an admin seat, naming who; it leaves the list and stays in the table', async () => {
    const created = await support.recordSupport(office, ATHLETE, 'Headgear loaned', '2026-10-03');
    const recordId = created!.record_id;

    await expect(support.retireSupport({ organizationId: ORG, accountId: COACH, role: 'coach' }, recordId))
      .rejects.toMatchObject({ status: 403 });
    await expect(support.retireSupport({ organizationId: ORG, accountId: SEATLESS, role: 'organization_admin' }, recordId))
      .rejects.toMatchObject({ status: 403 });

    expect(await support.retireSupport(admin, recordId)).toEqual({ record_id: recordId });
    expect((await support.listSupportForStaff(ORG, ATHLETE)).map((item) => item.record_id)).not.toContain(recordId);
    await expect(support.retireSupport(office, recordId)).rejects.toMatchObject({ status: 409 });

    const stored = await activeClient!.query(
      `select retired_by_account_id, retired_at is not null as retired from pilot.family_support_records where record_id = $1::uuid`,
      [recordId],
    );
    expect(stored.rows).toEqual([{ retired_by_account_id: ADMIN, retired: true }]);
  });

  test('seats are required: an admin with no active seat in this gym is refused', async () => {
    const before = await rowCount();
    await expect(support.recordSupport({ organizationId: ORG, accountId: SEATLESS, role: 'organization_admin' }, ATHLETE, 'Gloves', '2026-10-01'))
      .rejects.toMatchObject({ status: 403 });

    await activeClient!.query(`update pilot.organization_memberships set active_flag = false where account_id = $1`, [ADMIN]);
    try {
      await expect(support.recordSupport(admin, ATHLETE, 'Gloves', '2026-10-01')).rejects.toMatchObject({ status: 403 });
    } finally {
      await activeClient!.query(`update pilot.organization_memberships set active_flag = true where account_id = $1`, [ADMIN]);
    }
    expect(await rowCount()).toBe(before);
  });

  test("a future date the app's clock lets through is refused by the database, as a 400", async () => {
    const before = await rowCount();
    // The app believes it is the last day of 2999, so 2999-01-01 passes its check.
    mockGymDayIso.mockReturnValueOnce('2999-12-31');
    await expect(support.recordSupport(office, ATHLETE, 'Gloves', '2999-01-01'))
      .rejects.toMatchObject({ status: 400, message: 'The date provided cannot be in the future.' });
    expect(mockGymDayIso).toHaveBeenCalled();
    expect(await rowCount()).toBe(before);
  });

  test('records of one day written in the same moment come back in a stable order: by record id', async () => {
    const low = '00000000-0000-4000-8000-000000000001';
    const high = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    // One transaction, so the guard stamps both with the same created_at. The high id is written first.
    await activeClient!.query('begin');
    try {
      for (const [recordId, kind] of [[high, 'Mouthguard'], [low, 'Hand wraps']] as const) {
        await activeClient!.query(
          `insert into pilot.family_support_records
             (organization_id, record_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role)
           values ($1, $2::uuid, $3, $4, '2026-10-05', $5, 'organization_admin')`,
          [ORG, recordId, SAME_DAY_ATHLETE, kind, ORG_ADMIN],
        );
      }
      await activeClient!.query('commit');
    } catch (error) {
      await activeClient!.query('rollback');
      throw error;
    }

    const items = await support.listSupportForStaff(ORG, SAME_DAY_ATHLETE);
    expect(new Set(items.map((item) => item.created_at)).size).toBe(1);
    expect(items.map((item) => item.record_id)).toEqual([low, high]);
  });

  test('two retires racing on one record: one wins, the other is a 409 from the update itself, not a 404', async () => {
    const created = await support.recordSupport(office, ATHLETE, 'Fee covered for the November card', '2026-10-06');
    const recordId = created!.record_id;
    mockQueryOne.mockClear();

    // Both pre-checks are queued before either update, so both see a live record.
    const results = await Promise.allSettled([support.retireSupport(admin, recordId), support.retireSupport(office, recordId)]);

    const updates = mockQueryOne.mock.calls.filter(([text]) => String(text).includes('update pilot.family_support_records'));
    expect(updates).toHaveLength(2);
    const winners = results.filter((result) => result.status === 'fulfilled') as PromiseFulfilledResult<unknown>[];
    expect(winners.map((result) => result.value)).toEqual([{ record_id: recordId }]);
    const losers = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ status: 409 });
  });

  test("a withdrawn athlete's records are hidden: the list is empty, a new one is refused, retiring one is a not-found", async () => {
    const created = await support.recordSupport(office, WITHDRAWN, 'Boxing shoes', '2026-10-04');
    const recordId = created!.record_id;
    await activeClient!.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, WITHDRAWN]);

    expect(await support.listSupportForStaff(ORG, WITHDRAWN)).toEqual([]);
    const before = await rowCount();
    expect(await support.recordSupport(office, WITHDRAWN, 'Gloves', '2026-10-05')).toBeNull();
    expect(await rowCount()).toBe(before);
    expect(await support.retireSupport(admin, recordId)).toBeNull();

    const stored = await activeClient!.query(
      `select retired_at is null as live from pilot.family_support_records where record_id = $1::uuid`,
      [recordId],
    );
    expect(stored.rows).toEqual([{ live: true }]);
  });

  test('a recorder whose seat is retired and whose account is removed is shown as the gym office, with no id', async () => {
    const leaver = { organizationId: ORG, accountId: LEAVER, role: 'organization_admin' };
    const created = await support.recordSupport(leaver, ATHLETE, 'Ride home from the Erie show', '2026-10-07');
    const recordId = created!.record_id;
    const named = (await support.listSupportForStaff(ORG, ATHLETE)).find((item) => item.record_id === recordId);
    expect(named?.recorded_by_name).toBe('Lee Harper');

    await activeClient!.query(`update pilot.organization_memberships set active_flag = false where account_id = $1`, [LEAVER]);
    await activeClient!.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [LEAVER]);

    const item = (await support.listSupportForStaff(ORG, ATHLETE)).find((row) => row.record_id === recordId);
    expect(item?.recorded_by_name).toBe('Gym office');
    const text = JSON.stringify(item);
    for (const secret of [LEAVER, LEAVER_EMAIL, 'Lee', 'Harper', '@']) expect(text).not.toContain(secret);
  });
});
