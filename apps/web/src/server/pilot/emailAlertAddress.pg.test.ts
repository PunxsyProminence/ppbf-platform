// Real PostgreSQL-backed test for the adult athlete's alert switch and the
// records linked to an account (lane W4-1, EM-2b-2a). A5 (carried from EM-2,
// #2197): an account linked to an athlete record under 18, with no date of
// birth, deleted or not in this gym is offered no switch, whatever its role,
// and its row is retired; that record is read, never locked. GET's
// code_pending says whether a code can still be entered, never an address.
// The address and its code (EM-2b-2b) join this suite.
//
// './db' is mocked to route into an embedded server (the
// emailAlertSwitches.pg.test.ts pattern; withTransaction runs a real
// BEGIN/COMMIT/ROLLBACK), so the module's real SQL and audit.ts's run against
// real rows.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, Pool } from 'pg';

let activeClient: Client | null = null;
// Set only by the race tests: each withTransaction then takes its own
// connection from a real pool, so two requests can really run at once.
let activePool: Pool | null = null;
jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    const result = await target.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    const result = await target.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const pooled = activePool ? await activePool.connect() : null;
    const client = pooled ?? activeClient;
    if (!client) throw new Error('test bug: no active embedded client');
    try {
      await client.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      pooled?.release();
    }
  }),
}));

import type { PilotRole } from './contracts';
import { readEmailAlertSwitch, setEmailAlertSwitch } from './emailAlertSwitches';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-address-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_email_alert_switches_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-email-alert-switches-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-emailaddr';
const COACH_ID = 'acct-emailaddr-coach';
const PARENT_ID = 'acct-emailaddr-parent';
const ADULT_ID = 'acct-emailaddr-adult';
const ADULT2_ID = 'acct-emailaddr-adult2';
const MINOR_ID = 'acct-emailaddr-minor';
const GONE_ID = 'acct-emailaddr-gone';
const BIRTHDAY_ID = 'acct-emailaddr-birthday';

const ADULT_ATHLETE = 'ath-emailaddr-adult';
const ADULT2_ATHLETE = 'ath-emailaddr-adult2';
const MINOR_ATHLETE = 'ath-emailaddr-minor';
const GONE_ATHLETE = 'ath-emailaddr-gone';
const BIRTHDAY_ATHLETE = 'ath-emailaddr-birthday';
/** A record with no login of its own, for A5. */
const KID_ATHLETE = 'ath-emailaddr-kid';

/** The coach's sign-in address: default 6 sends a code to it. */
const COACH_LOGIN = 'coach.login@example.test';

// A fixed "now" well after the adults' 18th birthdays, on the birthday athlete's.
const NOW = new Date('2026-11-25T17:00:00Z');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/** The full schema, one gym, and one account of each kind in it. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  // Staff and parents first: an athlete row names its coach (pilot_athletes_coach_fk).
  const people: Array<[string, string, string, string | null]> = [
    [COACH_ID, 'coach', 'magic_link', COACH_LOGIN],
    [PARENT_ID, 'parent', 'magic_link', null],
  ];
  for (const [accountId, role, provider, login] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, $4, null, $5)`,
      [accountId, role, ORG_ID, provider, login],
    );
  }
  // pilot.athletes.dob is NOT NULL in the schema, so "no date of birth" cannot
  // be stored; emailAlertSwitches.test.ts covers a null date in code.
  const athletes: Array<[string | null, string, string, boolean]> = [
    [ADULT_ID, ADULT_ATHLETE, '2000-03-14', false],
    [ADULT2_ID, ADULT2_ATHLETE, '1999-07-01', false],
    [MINOR_ID, MINOR_ATHLETE, '2012-06-01', false],
    [GONE_ID, GONE_ATHLETE, '1995-01-01', true],
    // Turns 18 on 2026-11-25, the gym's day of NOW.
    [BIRTHDAY_ID, BIRTHDAY_ATHLETE, '2008-11-25', false],
    [null, KID_ATHLETE, '2013-02-02', false],
  ];
  for (const [accountId, athleteId, dob, deleted] of athletes) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Email Athlete', $3::date, '100', 'active', 'contact', true, $5, now(), now(),
               case when $4 then now() end)`,
      [ORG_ID, athleteId, dob, deleted, COACH_ID],
    );
    if (accountId) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
         values ($1, 'athlete', $2, 'ppbf_local', $3, null)`,
        [accountId, ORG_ID, athleteId],
      );
    }
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts where organization_id = $1`,
    [ORG_ID],
  );
  await applyMigrationTransaction(client, migrationSql);
  return client;
}

const SUBJECTS: Record<string, { accountId: string; role: PilotRole; athleteId: string | null }> = {
  coach: { accountId: COACH_ID, role: 'coach', athleteId: null },
  parent: { accountId: PARENT_ID, role: 'parent', athleteId: null },
  adult: { accountId: ADULT_ID, role: 'athlete', athleteId: ADULT_ATHLETE },
  adult2: { accountId: ADULT2_ID, role: 'athlete', athleteId: ADULT2_ATHLETE },
  minor: { accountId: MINOR_ID, role: 'athlete', athleteId: MINOR_ATHLETE },
  gone: { accountId: GONE_ID, role: 'athlete', athleteId: GONE_ATHLETE },
  birthday: { accountId: BIRTHDAY_ID, role: 'athlete', athleteId: BIRTHDAY_ATHLETE },
};

function subject(key: keyof typeof SUBJECTS) {
  return { organizationId: ORG_ID, ...SUBJECTS[key] };
}

async function addressRow(client: Client, accountId = ADULT_ID) {
  const { rows } = await client.query(
    `select user_type, switched_on, pending_address, pending_code_hash, pending_code_expires_at,
            pending_code_attempts, confirmed_address, confirmed_at is not null as has_confirmed_at
       from pilot.email_alert_switches where organization_id = $1 and account_id = $2`,
    [ORG_ID, accountId],
  );
  return rows[0] ?? null;
}

async function switchCount(client: Client): Promise<number> {
  const { rows } = await client.query('select count(*)::int as n from pilot.email_alert_switches');
  return rows[0].n;
}

async function auditDetails(client: Client) {
  const { rows } = await client.query(
    `select details from pilot.audit_events where entity_type = 'email_alert_switch' order by audit_id`,
  );
  return rows.map((row) => row.details as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds the office's statements open on a second connection until `waiters`
 * requests are waiting on a lock, runs `after`, then commits.
 */
async function whileHeld<T>(
  client: Client,
  before: Array<[string, unknown[]]>,
  steps: Array<() => Promise<T>>,
  { waiters = steps.length, after = [] as Array<[string, unknown[]]> } = {},
) {
  const office = await activePool!.connect();
  try {
    await office.query('BEGIN');
    for (const [sql, values] of before) await office.query(sql, values);
    let settled = 0;
    const results = steps.map((step) => {
      const result = step();
      result.then(() => { settled += 1; }, () => { settled += 1; });
      return result;
    });
    let waited = false;
    for (let i = 0; i < 400 && settled === 0; i += 1) {
      const { rows } = await client.query(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= waiters) {
        waited = true;
        break;
      }
      await sleep(25);
    }
    // The requests really were held by the office's rows, not finished before them.
    expect(waited).toBe(true);
    for (const [sql, values] of after) await office.query(sql, values);
    await office.query('COMMIT');
    return await Promise.allSettled(results);
  } finally {
    office.release(true);
  }
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(async () => {
  activeClient = null;
  if (activePool) await activePool.end().catch(() => {});
  activePool = null;
  jest.restoreAllMocks();
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

describe('the adult athlete\'s alert switch on a real database', () => {
  // GET's code_pending, read from a row as the table holds it (the address
  // and its code are written by EM-2b-2b): true only for a code that can
  // still be entered, and never an address.
  test('GET\'s code_pending: a code not expired with tries left; an expired or used-up code is not pending', async () => {
    const client = await freshDatabase('emailaddr_code_pending');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, pending_address, pending_code_hash, pending_code_expires_at, pending_code_attempts)
         values ($1, $2, 'adult_athlete', 'typed@example.test', 'code-hash', $3, 4)`,
        [ORG_ID, ADULT_ID, new Date(NOW.getTime() + 60_000)],
      );
      const read = (now: Date) => readEmailAlertSwitch(subject('adult'), now);
      await expect(read(NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true,
      });
      await expect(read(new Date(NOW.getTime() + 60_000))).resolves.toMatchObject({ code_pending: false });
      await client.query('update pilot.email_alert_switches set pending_code_attempts = 5');
      await expect(read(NOW)).resolves.toMatchObject({ code_pending: false });
      expect(JSON.stringify(await read(NOW))).not.toContain('example.test');
      // A switch save leaves it as it was.
      await client.query('update pilot.email_alert_switches set pending_code_attempts = 0');
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: false }, NOW)).resolves.toMatchObject({ code_pending: true });
      expect(await addressRow(client)).toMatchObject({ pending_address: 'typed@example.test', pending_code_hash: 'code-hash' });
    } finally {
      await client.end();
    }
  });

  test('A5: a parent account linked to a record under 18 is offered nothing, and its switch is retired; linked to an adult, it keeps its switch', async () => {
    const client = await freshDatabase('emailaddr_a5');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ user_type: 'parent', switched_on: false });
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 403 });
      expect((await auditDetails(client)).map((row) => row.reason ?? null)).toEqual([null, 'no_longer_offered']);

      // The same record, corrected to 18 or over: offered again, from off.
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: true, user_type: 'parent', switched_on: false });
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).resolves.toMatchObject({ switched_on: true });
      // Deleted: retired again.
      await client.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ switched_on: false });
    } finally {
      await client.end();
    }
  });

  test('A5: the record a parent account is linked to is read, never locked: a save does not wait on it, and the next read after a correction retires', async () => {
    const client = await freshDatabase('emailaddr_a5_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_race'), max: 4 });
    const office = await activePool.connect();
    try {
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      // The office's correction is held open: the save does not wait for it.
      await office.query('BEGIN');
      await office.query(`update pilot.athletes set dob = '2013-02-02' where athlete_id = $1`, [KID_ATHLETE]);
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).resolves.toMatchObject({ switched_on: true });
      await office.query('COMMIT');
      // The sender re-reads the record before every send; the next own read retires.
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ switched_on: false });
      expect((await auditDetails(client)).map((row) => row.reason ?? null)).toEqual([null, 'no_longer_offered']);
    } finally {
      office.release(true);
      await client.end();
    }
  });

  test('A5: a parent account retired by the guardian trigger (account first, then the children FOR UPDATE) while its save waits: no deadlock, 403', async () => {
    const client = await freshDatabase('emailaddr_a5_guardian');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_guardian'), max: 4 });
    try {
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-emailaddr', $2, 'Email Parent')`,
        [ORG_ID, PARENT_ID],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-emailaddr', $2, 'parent')`,
        [ORG_ID, KID_ATHLETE],
      );
      // The office holds the guardian's account; the save waits on it; then the
      // office deletes it, and pilot.cascade_parent_deletion locks the child FOR UPDATE.
      const [result] = await whileHeld(client,
        [['update pilot.accounts set updated_at = now() where account_id = $1', [PARENT_ID]]],
        [() => setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)],
        { after: [['update pilot.accounts set deleted_at = now() where account_id = $1', [PARENT_ID]]] });
      expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await switchCount(client)).toBe(0);
      const kid = await client.query('select deleted_at is not null as deleted from pilot.athletes where athlete_id = $1', [KID_ATHLETE]);
      expect(kid.rows[0].deleted).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('A5: a link made while a save waits on the account is read under that lock: linked to a record under 18, 403 and nothing written', async () => {
    const client = await freshDatabase('emailaddr_a5_link_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_link_race'), max: 4 });
    try {
      const [result] = await whileHeld(client,
        [['update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]]],
        [() => setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)]);
      expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // The 'deleted' case is the one that catches a read not pinned to this gym:
  // with the gym clause dropped two rows come back, and the 'under 18' case can
  // still pass when this gym's row happens to come first (reviewer B's re-read).
});
