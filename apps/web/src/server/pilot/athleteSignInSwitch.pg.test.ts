// Real PostgreSQL-backed contract test for the athlete sign-in switch (Jason
// 2026-11-19, OD-2026-11-19-025, "A: Add a switch (Recommended)": "Deactivate
// for athlete logins, same as staff, reversible by the gym admin. Their
// records stay."; lane SW, Overwatch GO with Q1 = A).
//
// WHAT IS UNDER TEST. Gym Office's existing deactivate route, now open to an
// athlete login, and the two additions setAccountActiveStatus makes for one:
//   - switching off also supersedes any unredeemed activation code. For an
//     athlete, active_flag false already means "not activated yet", and
//     redeeming a code sets it back to true, so a code issued before the
//     switch would otherwise turn the athlete back on with no office action;
//   - an athlete with no PIN yet is refused by name in both directions.
//
// WHY REAL POSTGRES. Every claim here is a SQL predicate or a write in one
// transaction: which sign-in door reads which flag, whether the code row is
// superseded, whether a session row is revoked, whether an athlete's records
// are untouched. A mocked client can only be asked whether a string contains
// a clause. The routes run as they do in production (login, activate, the
// switch, the PIN directory), against the whole schema.
//
// EVERY REFUSAL IS PAIRED WITH A CONTROL: the same door working for the same
// athlete before the switch, or for a bystander who is never switched. A
// change that broke sign-in outright would satisfy every "is refused" line.
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

// Routes every db helper into whichever embedded database the current test
// opened. withTransaction runs on the SAME client, so the switch, the code
// supersede and the session revocation are one unit of work here exactly as
// they are in production.
let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  const client = (): Client => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return activeClient;
  };
  return {
    ...actual,
    query: jest.fn(async (text: string, params: unknown[] = []) => (await client().query(text, params)).rows),
    queryOne: jest.fn(async (text: string, params: unknown[] = []) => (await client().query(text, params)).rows[0] ?? null),
    withPoolClient: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client())),
    withTransaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => {
      const c = client();
      await c.query('BEGIN');
      try {
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    }),
  };
});

import { POST as switchPOST } from '@/app/api/pilot/admin/accounts/deactivate/route';
import { GET as pinDirectoryGET } from '@/app/api/pilot/admin/athlete-pin-directory/route';
import { POST as activatePOST } from '@/app/api/pilot/auth/activate/route';
import { POST as loginPOST } from '@/app/api/pilot/auth/login/route';

import { issueActivationCode } from './activation';
import { ATHLETE_NOT_ACTIVATED_REFUSAL, changeOwnPin, resolvePrincipal } from './auth';
import { PILOT_SESSION_COOKIE } from './env';
import { clearRateLimit } from './rateLimit';
import { hashPin, hashToken } from './security';
import { listOrganizationMembers } from './staffProvisioning';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-sign-in-switch-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-swa';
const OTHER_ORG = 'org-swb';

/** Any PIN validatePinPolicy accepts; the athlete's own. */
const PIN = '481902';
/** The PIN chosen when an activation code is redeemed. */
const CHOSEN_PIN = '590317';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let databaseCounter = 0;

/**
 * The people in one test's database. Account ids carry the test's own suffix:
 * the PIN sign-in rate limiter keeps an in-memory count per account id across
 * the whole jest process, so reused ids would trip it a few tests in.
 */
interface Gym {
  client: Client;
  admin: string;
  adminToken: string;
  coach: string;
  coachToken: string;
  /** Activated: a PIN, active, with a live PIN session. The one switched. */
  athlete: string;
  athleteId: string;
  athleteToken: string;
  /** Activated too, never switched: the control for every "untouched". */
  bystander: string;
  bystanderToken: string;
  /** Never activated: no PIN, active_flag false, as every athlete login starts. */
  waiting: string;
  waitingAthleteId: string;
  /** The other gym's admin, for the tenancy case. */
  otherAdminToken: string;
}

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

async function addSession(client: Client, accountId: string, organizationId: string, method: string): Promise<string> {
  const token = `token-${accountId}-${method}`;
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, sign_in_method)
     values ($1, $2, $3, now() + interval '1 hour', $4)`,
    [hashToken(token), accountId, organizationId, method],
  );
  return token;
}

async function addStaff(client: Client, organizationId: string, accountId: string, role: string, method: string): Promise<string> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, $2, $3, $4, true)`,
    [accountId, role, organizationId, method === 'microsoft' ? 'microsoft' : 'magic_link'],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, organizationId, role],
  );
  return addSession(client, accountId, organizationId, method);
}

async function addAthlete(
  client: Client,
  accountId: string,
  athleteId: string,
  pinHash: string | null,
  coachId: string,
): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Athlete Name', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG, athleteId, coachId],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, pin_hash, active_flag)
     values ($1, 'athlete', $2, 'ppbf_local', $3, $4, $5)`,
    [accountId, ORG, athleteId, pinHash, pinHash !== null],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'athlete', $3)`,
    [accountId, ORG, pinHash !== null],
  );
}

async function freshGym(): Promise<Gym> {
  databaseCounter += 1;
  const n = databaseCounter;
  const name = `athlete_sign_in_switch_${n}`;
  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${name}`);
  await adminClient.query(`create database ${name}`);
  await adminClient.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  // Ended in afterEach even if setup below throws; a client left open is
  // killed with the server and reports it as an unhandled error.
  openClient = client;
  client.on('error', () => {});
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }

  const gym: Gym = {
    client,
    admin: `acct-admin-${n}`,
    adminToken: '',
    coach: `acct-coach-${n}`,
    coachToken: '',
    athlete: `acct-athlete-${n}`,
    athleteId: `ATH-SW-${n}`,
    athleteToken: '',
    bystander: `acct-bystander-${n}`,
    bystanderToken: '',
    waiting: `acct-waiting-${n}`,
    waitingAthleteId: `ATH-SW-WAIT-${n}`,
    otherAdminToken: '',
  };

  gym.adminToken = await addStaff(client, ORG, gym.admin, 'organization_admin', 'microsoft');
  gym.coachToken = await addStaff(client, ORG, gym.coach, 'coach', 'magic_link');
  gym.otherAdminToken = await addStaff(client, OTHER_ORG, `acct-other-admin-${n}`, 'organization_admin', 'microsoft');

  const pinHash = await hashPin(PIN);
  await addAthlete(client, gym.athlete, gym.athleteId, pinHash, gym.coach);
  gym.athleteToken = await addSession(client, gym.athlete, ORG, 'pin');
  await addAthlete(client, gym.bystander, `ATH-SW-BY-${n}`, pinHash, gym.coach);
  gym.bystanderToken = await addSession(client, gym.bystander, ORG, 'pin');
  await addAthlete(client, gym.waiting, gym.waitingAthleteId, null, gym.coach);

  return gym;
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

let openClient: Client | null = null;

afterEach(async () => {
  activeClient = null;
  if (openClient) {
    await openClient.end().catch(() => {});
    openClient = null;
  }
});

async function gym(): Promise<Gym> {
  return freshGym();
}

/* ---- Requests, as the browser sends them ---- */

function request(url: string, init: { method: string; token?: string; body?: unknown }): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.cookie = `${PILOT_SESSION_COOKIE}=${init.token}`;
  return new NextRequest(`http://localhost${url}`, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function flip(token: string, accountId: string, activeFlag: boolean): Promise<Response> {
  return switchPOST(request('/api/pilot/admin/accounts/deactivate', {
    method: 'POST', token, body: { account_id: accountId, active_flag: activeFlag },
  }));
}

/* The sign-in limiter is not under test here. It blocks a key for at least a
   second after any failed attempt, so a refusal followed at once by the
   control would read as 429; its in-memory buckets (the durable store is off
   with no connection string) are cleared before each attempt instead. */
async function signIn(accountId: string, pin: string): Promise<Response> {
  clearRateLimit('pin_ip:unknown');
  clearRateLimit(`pin_account:${accountId}`);
  return loginPOST(request('/api/pilot/auth/login', { method: 'POST', body: { account_id: accountId, pin } }));
}

async function activate(code: string, pin: string): Promise<Response> {
  clearRateLimit('activate_ip:unknown');
  return activatePOST(request('/api/pilot/auth/activate', { method: 'POST', body: { code, pin } }));
}

async function sessionFor(token: string) {
  return resolvePrincipal(request('/api/pilot/auth/session', { method: 'POST', token }));
}

/* ---- What the database holds ---- */

async function loginState(client: Client, accountId: string) {
  const result = await client.query<{
    active_flag: boolean;
    membership_active: boolean;
    pin_hash: string | null;
    live_sessions: number;
  }>(
    `select a.active_flag, om.active_flag as membership_active, a.pin_hash,
       (select count(*)::int from pilot.session_tokens st
         where st.account_id = a.account_id and st.revoked_at is null) as live_sessions
     from pilot.accounts a
     join pilot.organization_memberships om
       on om.account_id = a.account_id and om.organization_id = a.organization_id
     where a.account_id = $1`,
    [accountId],
  );
  return result.rows[0];
}

/** The exact account and membership rows, to show a refused write left them alone. */
async function loginRows(client: Client, accountId: string): Promise<string> {
  const result = await client.query<{ rows: string }>(
    `select (select to_jsonb(a)::text from pilot.accounts a where a.account_id = $1)
       || ' | ' || (select to_jsonb(om)::text from pilot.organization_memberships om where om.account_id = $1) as rows`,
    [accountId],
  );
  return result.rows[0].rows;
}

async function codeRows(client: Client, accountId: string) {
  const result = await client.query<{ consumed: boolean; superseded: boolean }>(
    `select consumed_at is not null as consumed, superseded_at is not null as superseded
     from pilot.account_activation_tokens where account_id = $1 order by created_at`,
    [accountId],
  );
  return result.rows;
}

/**
 * Every row any athlete-keyed table holds for this athlete, as text, table by
 * table: the athlete's records. pilot.accounts is left out, because the login
 * row is what the switch changes; nothing else may change.
 */
async function athleteRecords(client: Client, athleteId: string): Promise<Record<string, string>> {
  const tables = await client.query<{ table_name: string }>(
    `select table_name from information_schema.columns
     where table_schema = 'pilot' and column_name = 'athlete_id' and table_name <> 'accounts'
       and table_name in (select table_name from information_schema.tables
                          where table_schema = 'pilot' and table_type = 'BASE TABLE')
     order by table_name`,
  );
  const snapshot: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const rows = await client.query<{ rows: string | null }>(
      `select string_agg(to_jsonb(t)::text, E'\\n' order by to_jsonb(t)::text) as rows
       from pilot.${table} t where t.athlete_id = $1`,
      [athleteId],
    );
    if (rows.rows[0].rows !== null) snapshot[table] = rows.rows[0].rows;
  }
  return snapshot;
}

/* ---- Switched off: every door refuses ---- */

describe('the gym admin switches an activated athlete off', () => {
  test('PIN sign-in, the open session and Change PIN are all refused; the control signs in first', async () => {
    const { client, adminToken, athlete, athleteToken } = await gym();
    const before = await loginState(client, athlete);

    // Controls: before the switch, the PIN signs in and the open session resolves.
    expect((await signIn(athlete, PIN)).status).toBe(200);
    expect((await sessionFor(athleteToken))?.accountId).toBe(athlete);

    const switched = await flip(adminToken, athlete, false);
    expect(switched.status).toBe(200);
    await expect(switched.json()).resolves.toEqual({ ok: true, account_id: athlete, active_flag: false, role: 'athlete' });

    // The same wrong-PIN answer: nothing that says the login exists or is off.
    const refused = await signIn(athlete, PIN);
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({ error: 'Invalid credentials' });

    // The open session resolves to nobody, and every session row is revoked --
    // the control sign-in's as well as the seeded one.
    expect(await sessionFor(athleteToken)).toBeNull();
    const after = await loginState(client, athlete);
    expect(after).toMatchObject({ active_flag: false, membership_active: false, live_sessions: 0 });

    // Change PIN refuses the switched-off login (and it holds no session to ask with).
    await expect(changeOwnPin(athlete, PIN, '715240')).rejects.toThrow('Unauthorized');

    // The credential is kept, as for staff: the same PIN works again on reactivation.
    expect(after.pin_hash).toBe(before.pin_hash);
  });

  test('an activation code issued before the switch and never used is refused, and the athlete stays off', async () => {
    const { client, admin, adminToken, athlete, bystander } = await gym();

    const targetCode = await issueActivationCode({
      accountId: athlete, organizationId: ORG, issuedByAccountId: admin, issuedByRole: 'organization_admin',
    });
    const controlCode = await issueActivationCode({
      accountId: bystander, organizationId: ORG, issuedByAccountId: admin, issuedByRole: 'organization_admin',
    });

    expect((await flip(adminToken, athlete, false)).status).toBe(200);
    expect(await codeRows(client, athlete)).toEqual([{ consumed: false, superseded: true }]);

    const refused = await activate(targetCode.code, CHOSEN_PIN);
    expect(refused.status).toBe(401);
    expect(await loginState(client, athlete)).toMatchObject({ active_flag: false, membership_active: false, live_sessions: 0 });
    expect((await signIn(athlete, CHOSEN_PIN)).status).toBe(401);

    // Control: the bystander's code, issued the same way and never switched, redeems.
    const redeemed = await activate(controlCode.code, CHOSEN_PIN);
    expect(redeemed.status).toBe(200);
    await expect(redeemed.json()).resolves.toMatchObject({ ok: true, account_id: bystander, signed_in: true });
    expect(await codeRows(client, bystander)).toEqual([{ consumed: true, superseded: false }]);
  });
});

/* ---- Switched back on ---- */

describe('the gym admin switches the athlete back on', () => {
  test('the same PIN signs in again, and no activation code is issued or needed', async () => {
    const { client, adminToken, athlete } = await gym();

    expect((await flip(adminToken, athlete, false)).status).toBe(200);
    expect((await signIn(athlete, PIN)).status).toBe(401);

    const back = await flip(adminToken, athlete, true);
    expect(back.status).toBe(200);
    await expect(back.json()).resolves.toEqual({ ok: true, account_id: athlete, active_flag: true, role: 'athlete' });

    expect(await loginState(client, athlete)).toMatchObject({ active_flag: true, membership_active: true });
    const signedIn = await signIn(athlete, PIN);
    expect(signedIn.status).toBe(200);
    expect(await codeRows(client, athlete)).toEqual([]);
  });
});

/* ---- Never activated ---- */

describe('an athlete who has never activated', () => {
  test.each([false, true])('is refused by name (active_flag %s), and nothing is written', async (activeFlag) => {
    const { client, admin, adminToken, waiting } = await gym();
    // They hold a live code: it must not be superseded by a refused switch.
    await issueActivationCode({
      accountId: waiting, organizationId: ORG, issuedByAccountId: admin, issuedByRole: 'organization_admin',
    });
    const rowsBefore = await loginRows(client, waiting);

    const refused = await flip(adminToken, waiting, activeFlag);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({
      error: ATHLETE_NOT_ACTIVATED_REFUSAL,
      code: 'ATHLETE_SIGN_IN_NOT_ACTIVATED',
    });
    expect(ATHLETE_NOT_ACTIVATED_REFUSAL).toBe(
      'This athlete has not activated their sign-in yet, so there is nothing to switch off.',
    );

    expect(await loginRows(client, waiting)).toBe(rowsBefore);
    expect(await codeRows(client, waiting)).toEqual([{ consumed: false, superseded: false }]);
    const audited = await client.query(
      `select 1 from pilot.audit_events where entity_id = $1 and details->>'action' like 'organization_admin_%activate_account'`,
      [waiting],
    );
    expect(audited.rows).toHaveLength(0);
  });
});

/* ---- Records stay ---- */

describe("the athlete's records", () => {
  test('are byte-identical across off and on, and the office still lists the athlete', async () => {
    const { client, adminToken, athlete, athleteId } = await gym();
    // A guardian link against the athlete, beside the athlete row itself.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ('acct-guardian-sw', 'parent', $1, 'magic_link')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-sw', 'acct-guardian-sw', 'Guardian Name')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, 'par-sw', $2, 'parent')`,
      [ORG, athleteId],
    );
    const before = await athleteRecords(client, athleteId);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['athletes', 'guardian_links']));

    expect((await flip(adminToken, athlete, false)).status).toBe(200);
    expect(await athleteRecords(client, athleteId)).toEqual(before);

    // Gym Office's roster and the PIN directory still list the athlete, as switched off.
    const members = await listOrganizationMembers(ORG);
    expect(members.find((m) => m.account_id === athlete)).toMatchObject({ active_flag: false, has_pin: true, membership_active: false });
    const directory = await pinDirectoryGET(request('/api/pilot/admin/athlete-pin-directory', { method: 'GET', token: adminToken }));
    expect(directory.status).toBe(200);
    const items = ((await directory.json()) as { items: Array<{ athlete_id: string; account_active: boolean }> }).items;
    expect(items.find((item) => item.athlete_id === athleteId)).toMatchObject({ account_active: false });

    expect((await flip(adminToken, athlete, true)).status).toBe(200);
    expect(await athleteRecords(client, athleteId)).toEqual(before);
  });
});

/* ---- Only the gym admin ---- */

describe('who may switch an athlete', () => {
  test('a coach, an athlete and another gym\'s admin are refused, and nothing is written; the gym admin is the control', async () => {
    const { client, adminToken, coachToken, bystanderToken, otherAdminToken, athlete } = await gym();
    const rowsBefore = await loginRows(client, athlete);

    // A coach's emailed-link session: not a Microsoft session.
    expect((await flip(coachToken, athlete, false)).status).toBe(403);
    // An athlete's PIN session.
    expect((await flip(bystanderToken, athlete, false)).status).toBe(403);
    // Another gym's admin: the athlete is not in their gym.
    expect((await flip(otherAdminToken, athlete, false)).status).toBe(404);

    expect(await loginRows(client, athlete)).toBe(rowsBefore);
    expect((await signIn(athlete, PIN)).status).toBe(200);

    // Control: this gym's admin is admitted.
    expect((await flip(adminToken, athlete, false)).status).toBe(200);
  });
});

/* ---- Staff behaviour unchanged ---- */

describe('a coach login', () => {
  test('is switched off and back on as before; switching off touches no activation code', async () => {
    const { client, adminToken, coach, coachToken } = await gym();

    expect((await flip(adminToken, coach, false)).status).toBe(200);
    expect(await sessionFor(coachToken)).toBeNull();
    expect(await loginState(client, coach)).toMatchObject({ active_flag: false, membership_active: false, live_sessions: 0 });
    expect(await codeRows(client, coach)).toEqual([]);

    expect((await flip(adminToken, coach, true)).status).toBe(200);
    expect(await loginState(client, coach)).toMatchObject({ active_flag: true, membership_active: true });
  });
});
