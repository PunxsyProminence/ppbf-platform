// Real PostgreSQL-backed test for emailAlertSwitches.ts on the
// email-alert-switches migration (lane W4-1, EM-1b; the migration's own suite
// is emailAlertSwitchesMigration.pg.test.ts, EM-1a; OD-2026-11-19-019,
// OW27-10 A: each person's own opt-in switch; OW27-02 C: staff, parents and
// athletes 18 or over; OW27-38 B: an adult athlete's address is confirmed
// first). './db' is mocked to route into the embedded server (the
// tabletIdlePolicy.pg.test.ts pattern; withTransaction runs a real
// BEGIN/COMMIT/ROLLBACK), so the module's real SQL and audit.ts's run against
// real rows. The runner is driven through its real entrypoint, so its
// readiness check runs against a real Postgres here.
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
// Set only by the concurrency test: each withTransaction then takes its own
// connection from a real pool, so two saves can really run at once. Every
// other test sends everything down one connection, which serialises them.
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

// The /me route test below signs each person in as their session would.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { NextRequest } from 'next/server';

import * as meRoute from '@/app/api/pilot/email-alerts/me/route';

import type { PilotRole } from './contracts';
import { readEmailAlertSwitch, setEmailAlertSwitch } from './emailAlertSwitches';
import { requirePrincipal } from './http';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-switch-pg-test-${Date.now()}`);
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

const ORG_ID = 'org-emailsw';
const OTHER_ORG_ID = 'org-emailsw-elsewhere';
const ADMIN_ID = 'acct-emailsw-admin';
const COACH_ID = 'acct-emailsw-coach';
const PARENT_ID = 'acct-emailsw-parent';
const STAFF_ROLE_ID = 'acct-emailsw-staffrole';
const VOLUNTEER_ID = 'acct-emailsw-volunteer';
const ADULT_ID = 'acct-emailsw-adult';
const MINOR_ID = 'acct-emailsw-minor';
const GONE_ID = 'acct-emailsw-gone';
const BIRTHDAY_ID = 'acct-emailsw-birthday';

const ADULT_ATHLETE = 'ath-emailsw-adult';
const MINOR_ATHLETE = 'ath-emailsw-minor';
const GONE_ATHLETE = 'ath-emailsw-gone';
const BIRTHDAY_ATHLETE = 'ath-emailsw-birthday';

// A fixed "now" well after the adult's 18th birthday and before the minor's.
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

/** The full schema, two gyms, and one account of each kind in the first. */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  // Staff and parents first: an athlete row names its coach (pilot_athletes_coach_fk).
  const people: Array<[string, string, string]> = [
    [ADMIN_ID, 'organization_admin', 'microsoft'],
    [COACH_ID, 'coach', 'magic_link'],
    [PARENT_ID, 'parent', 'magic_link'],
    [STAFF_ROLE_ID, 'staff', 'magic_link'],
    [VOLUNTEER_ID, 'volunteer', 'magic_link'],
  ];
  for (const [accountId, role, provider] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, $4, null, null) on conflict do nothing`,
      [accountId, role, ORG_ID, provider],
    );
  }
  // pilot.athletes.dob is NOT NULL in the schema, so "no date of birth" cannot
  // be stored; emailAlertSwitches.test.ts covers a null date in code.
  const athletes: Array<[string, string, string, boolean]> = [
    [ADULT_ID, ADULT_ATHLETE, '2000-03-14', false],
    [MINOR_ID, MINOR_ATHLETE, '2012-06-01', false],
    [GONE_ID, GONE_ATHLETE, '1995-01-01', true],
    // Turns 18 on 2026-11-25, the gym's day of NOW.
    [BIRTHDAY_ID, BIRTHDAY_ATHLETE, '2008-11-25', false],
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
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, 'athlete', $2, 'ppbf_local', $3, null) on conflict do nothing`,
      [accountId, ORG_ID, athleteId],
    );
  }

  // Each account is a member of its own gym, as resolvePrincipal requires; the
  // switch's membership key (pilot_email_alert_switch_membership_fk) needs it.
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts where organization_id = $1
     on conflict do nothing`,
    [ORG_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.email_alert_switches cascade');
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

const SUBJECTS: Record<string, { accountId: string; role: PilotRole; athleteId: string | null }> = {
  admin: { accountId: ADMIN_ID, role: 'organization_admin', athleteId: null },
  coach: { accountId: COACH_ID, role: 'coach', athleteId: null },
  parent: { accountId: PARENT_ID, role: 'parent', athleteId: null },
  staffRole: { accountId: STAFF_ROLE_ID, role: 'staff', athleteId: null },
  volunteer: { accountId: VOLUNTEER_ID, role: 'volunteer', athleteId: null },
  adult: { accountId: ADULT_ID, role: 'athlete', athleteId: ADULT_ATHLETE },
  minor: { accountId: MINOR_ID, role: 'athlete', athleteId: MINOR_ATHLETE },
  gone: { accountId: GONE_ID, role: 'athlete', athleteId: GONE_ATHLETE },
  birthday: { accountId: BIRTHDAY_ID, role: 'athlete', athleteId: BIRTHDAY_ATHLETE },
};

function subject(key: keyof typeof SUBJECTS, organizationId = ORG_ID) {
  return { organizationId, ...SUBJECTS[key] };
}

async function switchRows(client: Client) {
  const { rows } = await client.query(
    `select organization_id, account_id, user_type, switched_on,
            switched_on_at is not null as has_on_at, switched_off_at is not null as has_off_at,
            pending_address, confirmed_address
       from pilot.email_alert_switches order by account_id`,
  );
  return rows;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'email_alert_switch' order by audit_id`,
  );
  return rows;
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

describe('emailAlertSwitches.ts on a real database', () => {
  test.each([
    ['admin', 'staff'],
    ['coach', 'staff'],
    ['parent', 'parent'],
  ] as const)('a %s is offered a %s switch that starts off', async (key, userType) => {
    activeClient = await freshDatabase('emailsw_read');
    try {
      await expect(readEmailAlertSwitch(subject(key), NOW)).resolves.toEqual({
        offered: true, user_type: userType, switched_on: false,
      });
    } finally {
      await activeClient.end();
    }
  });

  test('a coach switches on, then off: each save moves its own time and is audited without any address; the other gym sees nothing', async () => {
    const client = await freshDatabase('emailsw_set');
    activeClient = client;
    try {
      await expect(setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: true,
      });
      expect(await switchRows(client)).toEqual([{
        organization_id: ORG_ID, account_id: COACH_ID, user_type: 'staff', switched_on: true,
        has_on_at: true, has_off_at: false, pending_address: null, confirmed_address: null,
      }]);
      const firstOn = await client.query('select switched_on_at::text as t from pilot.email_alert_switches');

      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: false }, NOW);
      expect(await switchRows(client)).toEqual([expect.objectContaining({ switched_on: false, has_on_at: true, has_off_at: true })]);
      // Turning off keeps the time it last went on.
      const kept = await client.query(
        'select switched_on_at = $1::timestamptz as kept from pilot.email_alert_switches',
        [firstOn.rows[0].t],
      );
      expect(kept.rows[0].kept).toBe(true);

      await expect(readEmailAlertSwitch(subject('coach'), NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: false,
      });
      await expect(readEmailAlertSwitch(subject('coach', OTHER_ORG_ID), NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: false,
      });

      expect(await auditRows(client)).toEqual([
        {
          event_type: 'update', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID,
          entity_id: COACH_ID, details: { user_type: 'staff', switched_on: true, previous_switched_on: false },
        },
        {
          event_type: 'update', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID,
          entity_id: COACH_ID, details: { user_type: 'staff', switched_on: false, previous_switched_on: true },
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a coach made an organization admin, as the role writers do it (account and membership), keeps the switch on: same user type, nothing retired', async () => {
    const client = await freshDatabase('emailsw_within_staff');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      await client.query(`update pilot.accounts set role = 'organization_admin' where account_id = $1`, [COACH_ID]);
      await client.query(
        `update pilot.organization_memberships set role = 'organization_admin' where account_id = $1 and organization_id = $2`,
        [COACH_ID, ORG_ID],
      );
      // The session after the change acts with the new role (role writers end the old sessions).
      const promoted = { organizationId: ORG_ID, accountId: COACH_ID, role: 'organization_admin' as const, athleteId: null };

      await expect(readEmailAlertSwitch(promoted, NOW)).resolves.toEqual({ offered: true, user_type: 'staff', switched_on: true });
      await expect(setEmailAlertSwitch({ ...promoted, switchedOn: true }, NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: true,
      });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: COACH_ID, user_type: 'staff', switched_on: true, has_on_at: true, has_off_at: false,
      })]);
      // No retire, and no change of user type, is recorded.
      expect((await auditRows(client)).map((row) => row.details)).toEqual([
        { user_type: 'staff', switched_on: true, previous_switched_on: false },
        { user_type: 'staff', switched_on: true, previous_switched_on: true },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a parent with email on made a coach: the first read as a coach switches the parent row off, so made a parent again it stays off (T-1 A, Codex 4703532904)', async () => {
    const client = await freshDatabase('emailsw_type_change');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW);
      // As the role writers do it: the account and the membership (and every session ended).
      const makeRole = async (role: string) => {
        await client.query('update pilot.accounts set role = $2 where account_id = $1', [PARENT_ID, role]);
        await client.query(
          'update pilot.organization_memberships set role = $3 where account_id = $1 and organization_id = $2',
          [PARENT_ID, ORG_ID, role],
        );
      };
      const as = (role: PilotRole) => ({ organizationId: ORG_ID, accountId: PARENT_ID, role, athleteId: null });

      await makeRole('coach');
      await expect(readEmailAlertSwitch(as('coach'), NOW)).resolves.toEqual({ offered: true, user_type: 'staff', switched_on: false });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: PARENT_ID, user_type: 'parent', switched_on: false, has_on_at: true, has_off_at: true,
      })]);
      // A second read finds nothing left to retire.
      await readEmailAlertSwitch(as('coach'), NOW);

      await makeRole('parent');
      await expect(readEmailAlertSwitch(as('parent'), NOW)).resolves.toEqual({ offered: true, user_type: 'parent', switched_on: false });
      expect((await auditRows(client)).map((row) => row.details)).toEqual([
        { user_type: 'parent', switched_on: true, previous_switched_on: false },
        { user_type: 'parent', switched_on: false, previous_switched_on: true, address_cleared: false, reason: 'user_type_changed' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a type change and back with no read in between leaves the switch as it was: it was never shown off (T-1 A, disclosed)', async () => {
    const client = await freshDatabase('emailsw_type_round_trip');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW);
      for (const role of ['coach', 'parent']) {
        await client.query('update pilot.accounts set role = $2 where account_id = $1', [PARENT_ID, role]);
        await client.query(
          'update pilot.organization_memberships set role = $3 where account_id = $1 and organization_id = $2',
          [PARENT_ID, ORG_ID, role],
        );
      }
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: true, user_type: 'parent', switched_on: true });
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('an adult athlete is offered the switch but cannot turn it on before an address is confirmed: no row, no audit', async () => {
    const client = await freshDatabase('emailsw_adult');
    activeClient = client;
    try {
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: false,
      });
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 409 });
      expect(await switchRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an adult athlete with a confirmed address switches on; the address stays on the row and never reaches the audit', async () => {
    const client = await freshDatabase('emailsw_adult_on');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: false,
      });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, switched_on: true, confirmed_address: 'someone@example.test',
      })]);
      const audits = await auditRows(client);
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain('example.test');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['an athlete under 18', 'minor'],
    ['an athlete whose athlete record is deleted', 'gone'],
    ['the account role staff', 'staffRole'],
    ['a volunteer', 'volunteer'],
  ] as const)('%s is not offered a switch, cannot set one, and nothing is written', async (_label, key) => {
    const client = await freshDatabase('emailsw_refused');
    activeClient = client;
    try {
      await expect(readEmailAlertSwitch(subject(key), NOW)).resolves.toEqual({ offered: false });
      await expect(setEmailAlertSwitch({ ...subject(key), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 403 });
      await expect(setEmailAlertSwitch({ ...subject(key), switchedOn: false }, NOW)).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an athlete account with no athlete record linked is not offered a switch', async () => {
    activeClient = await freshDatabase('emailsw_unlinked');
    try {
      await expect(readEmailAlertSwitch({ ...subject('adult'), athleteId: null }, NOW)).resolves.toEqual({ offered: false });
    } finally {
      await activeClient.end();
    }
  });

  test('an athlete is offered the switch from the gym day they turn 18, not the day before', async () => {
    activeClient = await freshDatabase('emailsw_birthday');
    try {
      await expect(readEmailAlertSwitch(subject('birthday'), new Date('2026-11-24T17:00:00Z'))).resolves.toEqual({ offered: false });
      await expect(readEmailAlertSwitch(subject('birthday'), NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: false,
      });
    } finally {
      await activeClient.end();
    }
  });

  test('L1 at /me (a reviewer on EM-2b-2): a person offered no switch gets the same answer whatever the query or body; a coach gets the 400s as before', async () => {
    const client = await freshDatabase('emailsw_route_minor');
    activeClient = client;
    try {
      const url = 'http://localhost/api/pilot/email-alerts/me';
      const get = async (query: string) => {
        const response = await meRoute.GET(new NextRequest(`${url}${query}`));
        return { status: response.status, headers: [...response.headers.entries()], body: await response.json() };
      };
      const put = async (sent: unknown, query = '') => {
        const request = new NextRequest(`${url}${query}`, { method: 'PUT', body: typeof sent === 'string' ? sent : JSON.stringify(sent) });
        const response = await meRoute.PUT(request);
        return { status: response.status, headers: [...response.headers.entries()], body: await response.json() };
      };
      const signIn = (who: { accountId: string; role: PilotRole; athleteId: string | null }) => (requirePrincipal as jest.Mock)
        .mockResolvedValue({ ...who, organizationId: ORG_ID, sessionToken: 'session', authProvider: 'magic_link' });
      const shapes: Array<[unknown, string]> = [
        [{ switched_on: true }, ''], [{ switched_on: false }, ''], [{ switched_on: true }, '?account_id=acct-other'], ['', ''], ['{"', ''],
        [[true], ''], [{ on: true }, ''], [{ switched_on: true, account_id: 'acct-other' }, ''], [{ switched_on: 'yes' }, ''], [{ switched_on: null }, ''],
      ];
      // A parent account linked to a record under 18 is offered nothing either (A5).
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, 'ath-emailsw-kid', 'Email Athlete', '2013-02-02', '100', 'active', 'contact', true, $2, now(), now())`,
        [ORG_ID, COACH_ID],
      );
      await client.query(`update pilot.accounts set athlete_id = 'ath-emailsw-kid' where account_id = $1`, [PARENT_ID]);
      const people = [SUBJECTS.minor, SUBJECTS.gone, { ...SUBJECTS.adult, athleteId: null }, SUBJECTS.parent];
      let offeredNone: Awaited<ReturnType<typeof get>> | null = null;
      let refused: Awaited<ReturnType<typeof put>> | null = null;
      for (const person of people) {
        signIn(person);
        for (const query of ['', '?account_id=acct-other', '?x=']) {
          const answer = await get(query);
          offeredNone ??= answer;
          expect({ person, query, answer }).toEqual({ person, query, answer: offeredNone });
        }
        for (const [sent, query] of shapes) {
          const answer = await put(sent, query);
          refused ??= answer;
          expect({ person, sent, query, answer }).toEqual({ person, sent, query, answer: refused });
        }
      }
      expect(offeredNone).toMatchObject({ status: 200, body: { ok: true, offered: false } });
      expect(refused).toMatchObject({ status: 403, body: { error: 'Forbidden: email alerts are not offered to this account' } });
      expect(await switchRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);

      // A coach: the same 400s as before, worded as before.
      signIn(SUBJECTS.coach);
      expect(await get('?x=')).toMatchObject({ status: 400, body: { error: 'Unsupported query: this read takes no fields' } });
      expect(await put({ switched_on: true }, '?x=')).toMatchObject({ status: 400, body: { error: 'Unsupported query: send switched_on in the body only' } });
      for (const sent of ['', '{"', [true]]) {
        expect(await put(sent)).toMatchObject({ status: 400, body: { error: 'Request body must be a JSON object with switched_on' } });
      }
      for (const sent of [{ on: true }, { switched_on: true, account_id: 'acct-other' }]) {
        expect(await put(sent)).toMatchObject({ status: 400, body: { error: 'Unsupported fields: send switched_on only' } });
      }
      expect(await put({ switched_on: 'yes' })).toMatchObject({ status: 400, body: { error: 'switched_on must be true or false' } });
      expect(await switchRows(client)).toEqual([]);

      // An adult switched on with a confirmed address, then corrected to under
      // 18: a malformed PUT gets the plain 403, and the row is switched off and
      // cleared, audited once (the store's leftover retire).
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at, set_at)
         values ($1, $2, 'adult_athlete', true, now(), 'left.over@example.test', now(), now())`,
        [ORG_ID, ADULT_ID],
      );
      await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]);
      signIn(SUBJECTS.adult);
      expect(await put('{"')).toEqual(refused);
      expect(await switchRows(client)).toMatchObject([{ account_id: ADULT_ID, switched_on: false, confirmed_address: null, pending_address: null }]);
      expect((await auditRows(client)).map((row) => row.details.reason)).toEqual(['no_longer_offered']);
    } finally {
      await client.end();
    }
  });

  test('a non-boolean is refused before anything is written', async () => {
    const client = await freshDatabase('emailsw_bad');
    activeClient = client;
    try {
      for (const value of ['true', 1, null, undefined, {}]) {
        await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: value }, NOW)).rejects.toMatchObject({ status: 400 });
      }
      expect(await switchRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a row left on under another user type is retired by the next read (T-1 A): switched off, address cleared, audited; a save under the new type starts fresh', async () => {
    const client = await freshDatabase('emailsw_retype');
    activeClient = client;
    try {
      // The coach account's row as if it had been saved while the account was an adult athlete.
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, pending_address,
            pending_code_hash, pending_code_expires_at, pending_code_attempts, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'typed@example.test',
                 'code-hash', now() + interval '15 minutes', 2, 'someone@example.test', now())`,
        [ORG_ID, COACH_ID],
      );
      await expect(readEmailAlertSwitch(subject('coach'), NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: false,
      });
      // The read retired the row it left behind: off, address gone, type as stored.
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: COACH_ID, user_type: 'adult_athlete', switched_on: false, has_off_at: true,
        pending_address: null, confirmed_address: null,
      })]);
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: COACH_ID, user_type: 'staff', switched_on: true, pending_address: null, confirmed_address: null,
      })]);
      const code = await client.query(
        `select pending_code_hash, pending_code_expires_at, pending_code_attempts, confirmed_at
           from pilot.email_alert_switches`,
      );
      expect(code.rows).toEqual([{
        pending_code_hash: null, pending_code_expires_at: null, pending_code_attempts: 0, confirmed_at: null,
      }]);
      // The retire, then the save, each describing the row as stored; no address in either.
      const audits = await auditRows(client);
      expect(audits.map((row) => row.details)).toEqual([
        {
          user_type: 'adult_athlete', switched_on: false, previous_switched_on: true,
          address_cleared: true, reason: 'user_type_changed',
        },
        { user_type: 'staff', switched_on: true, previous_switched_on: false, previous_user_type: 'adult_athlete' },
      ]);
      expect(JSON.stringify(audits)).not.toContain('example.test');
    } finally {
      await client.end();
    }
  });

  test('an adult athlete whose date of birth is corrected to under 18: the next read switches the row off and clears the address, audited, and shows nothing', async () => {
    const client = await freshDatabase('emailsw_retire_read');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, pending_address,
            confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'typed@example.test', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]);

      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({ offered: false });
      expect(await switchRows(client)).toEqual([{
        organization_id: ORG_ID, account_id: ADULT_ID, user_type: 'adult_athlete', switched_on: false,
        has_on_at: true, has_off_at: true, pending_address: null, confirmed_address: null,
      }]);
      const audits = await auditRows(client);
      expect(audits.map((row) => row.details)).toEqual([{
        user_type: 'adult_athlete', switched_on: false, previous_switched_on: true,
        address_cleared: true, reason: 'no_longer_offered',
      }]);
      expect(JSON.stringify(audits)).not.toContain('example.test');

      // A second read finds nothing left to retire and writes nothing more.
      await readEmailAlertSwitch(subject('adult'), NOW);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a write from someone no longer offered is refused, after their row is switched off', async () => {
    const client = await freshDatabase('emailsw_retire_write');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now())`,
        [ORG_ID, MINOR_ID],
      );
      await expect(setEmailAlertSwitch({ ...subject('minor'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: MINOR_ID, switched_on: false, confirmed_address: null,
      })]);
      expect((await auditRows(client)).map((row) => row.details.reason)).toEqual(['no_longer_offered']);
    } finally {
      await client.end();
    }
  });

  test('a row saved on under another user type, then a switch-off under the new type: retired first (T-1 A), then saved; the off-time is stamped', async () => {
    const client = await freshDatabase('emailsw_retype_off');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
         values ($1, $2, 'parent', true, now())`,
        [ORG_ID, COACH_ID],
      );
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: false }, NOW);
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        user_type: 'staff', switched_on: false, has_on_at: true, has_off_at: true,
      })]);
      // T-1 A: the write retires the parent row first, then saves under the new type from off.
      expect((await auditRows(client)).map((row) => row.details)).toEqual([
        { user_type: 'parent', switched_on: false, previous_switched_on: true, address_cleared: false, reason: 'user_type_changed' },
        { user_type: 'staff', switched_on: false, previous_switched_on: false, previous_user_type: 'parent' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('three first saves at once, on separate connections: all succeed, one row, and the audit chain is consistent', async () => {
    const client = await freshDatabase('emailsw_concurrent');
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_concurrent'), max: 4 });
    try {
      const results = await Promise.allSettled([true, false, true].map((switchedOn) =>
        setEmailAlertSwitch({ ...subject('parent'), switchedOn }, NOW)));
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);

      const { rows } = await client.query('select count(*)::int as n from pilot.email_alert_switches');
      expect(rows[0].n).toBe(1);
      const chain = (await auditRows(client)).map((row) => row.details as { switched_on: boolean; previous_switched_on: boolean });
      expect(chain).toHaveLength(3);
      // Each save saw the one before it: the first started from off, and every
      // later "previous" is the value the save before it wrote.
      expect(chain[0].previous_switched_on).toBe(false);
      for (let i = 1; i < chain.length; i += 1) {
        expect(chain[i].previous_switched_on).toBe(chain[i - 1].switched_on);
      }
    } finally {
      await client.end();
    }
  });

  // Codex on #2169: each change the office can make between the save's first
  // age read and its write, held open on a second connection while the save waits.
  test.each([
    ['the date of birth corrected to under 18', `update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, ADULT_ATHLETE],
    ['the athlete record deleted', 'update pilot.athletes set deleted_at = now() where athlete_id = $1', ADULT_ATHLETE],
    ['the account unlinked from the athlete record', 'update pilot.accounts set athlete_id = null where account_id = $1', ADULT_ID],
  ] as const)('%s while a save waits on it is seen inside the save: 403, never switched on', async (_label, change, id) => {
    const client = await freshDatabase('emailsw_age_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_age_race'), max: 4 });
    const office = await activePool.connect();
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      // The office's change is not committed yet: the save's first age read
      // still sees a linked adult.
      await office.query('BEGIN');
      await office.query(change, [id]);
      let settled = false;
      const save = setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW);
      save.then(() => { settled = true; }, () => { settled = true; });
      // Wait until the save is held on the row the office holds (or has finished).
      let waited = false;
      for (let i = 0; i < 200 && !settled; i += 1) {
        const { rows } = await client.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0].n > 0) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The save really was held by the office's row, not finished before it.
      expect(waited).toBe(true);
      await office.query('COMMIT');
      await expect(save).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ account_id: ADULT_ID, switched_on: false })]);
      expect((await auditRows(client)).map((row) => (row.details as { switched_on: boolean }).switched_on)).not.toContain(true);
    } finally {
      office.release(true);
      await client.end();
    }
  });

  // Codex on #2169: the login or the membership changed by the office while
  // the save waits on the account row; every such writer locks the account first.
  test.each([
    // The login alone, its membership left on, so the account's own flag is what refuses.
    ['the login switched off', [
      'update pilot.accounts set active_flag = false where account_id = $1',
      'update pilot.accounts set updated_at = now() where account_id = $1',
    ]],
    ['the login deleted', [
      'update pilot.accounts set deleted_at = now() where account_id = $1',
      'update pilot.accounts set updated_at = now() where account_id = $1',
    ]],
    // This gym's membership only: the other gym's stays an active coach, so only a read
    // pinned to this gym refuses.
    ['the membership switched off', [
      'update pilot.accounts set updated_at = now() where account_id = $1',
      `update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = '${ORG_ID}'`,
    ]],
    ['the membership made a volunteer', [
      'update pilot.accounts set updated_at = now() where account_id = $1',
      `update pilot.organization_memberships set role = 'volunteer' where account_id = $1 and organization_id = '${ORG_ID}'`,
    ]],
  ] as const)('%s while a coach\'s save waits on the account is seen inside the save: 403, never switched on', async (_label, changes) => {
    const client = await freshDatabase('emailsw_member_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_member_race'), max: 4 });
    // An active coach membership in the other gym too: only this gym's counts.
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
      [COACH_ID, OTHER_ORG_ID],
    );
    const office = await activePool.connect();
    try {
      await office.query('BEGIN');
      await office.query(changes[0], [COACH_ID]);
      let settled = false;
      const save = setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      save.then(() => { settled = true; }, () => { settled = true; });
      let waited = false;
      for (let i = 0; i < 200 && !settled; i += 1) {
        const { rows } = await client.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0].n > 0) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waited).toBe(true);
      await office.query(changes[1], [COACH_ID]);
      await office.query('COMMIT');
      await expect(save).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([]);
    } finally {
      office.release(true);
      await client.end();
    }
  });

  // OVERWATCH 7182466510: sign-in switched off (T-3 A) or a role with no switch (T-2 A) only
  // pauses a switch that is on, so a save that races it is refused and writes nothing. A role
  // of another user type retires it only through a read or write under the new type (T-1 A):
  // this save is still the coach's, so it too is refused only, and the parent's first read
  // retires the row (the type-change test above).
  test.each([
    ['the login switched off', 'update pilot.accounts set active_flag = false where account_id = $1'],
    ['the login deleted', 'update pilot.accounts set deleted_at = now() where account_id = $1'],
    ['the membership switched off', `update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = '${ORG_ID}'`],
    ['the membership made a volunteer', `update pilot.organization_memberships set role = 'volunteer' where account_id = $1 and organization_id = '${ORG_ID}'`],
    ['the membership made a parent', `update pilot.organization_memberships set role = 'parent' where account_id = $1 and organization_id = '${ORG_ID}'`],
  ] as const)('a coach with email on, %s while a save waits: 403, nothing written, the switch kept', async (_label, change) => {
    const client = await freshDatabase('emailsw_on_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_on_race'), max: 4 });
    try {
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      const office = await activePool.connect();
      try {
        await office.query('BEGIN');
        // The account row first, as every membership writer takes it.
        await office.query('update pilot.accounts set updated_at = now() where account_id = $1', [COACH_ID]);
        let settled = false;
        const save = setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
        save.then(() => { settled = true; }, () => { settled = true; });
        let waited = false;
        for (let i = 0; i < 200 && !settled; i += 1) {
          const { rows } = await client.query(
            `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
          );
          if (rows[0].n > 0) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(waited).toBe(true);
        await office.query(change, [COACH_ID]);
        await office.query('COMMIT');
        await expect(save).rejects.toMatchObject({ status: 403 });
      } finally {
        office.release(true);
      }
      expect(await switchRows(client)).toEqual([expect.objectContaining({ user_type: 'staff', switched_on: true, has_off_at: false })]);
      // Only the first save's audit row.
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a switch-on under the new type that ends in a 409 still retires the row left on under another type (T-1 A; reviewer A)', async () => {
    const client = await freshDatabase('emailsw_retype_409');
    activeClient = client;
    try {
      // A row saved on while this account was a parent (no address: the table allows one only on an adult athlete's row).
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
         values ($1, $2, 'parent', true, now())`,
        [ORG_ID, ADULT_ID],
      );
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 409 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, user_type: 'parent', switched_on: false, has_off_at: true,
      })]);
      expect((await auditRows(client)).map((row) => row.details)).toEqual([
        { user_type: 'parent', switched_on: false, previous_switched_on: true, address_cleared: false, reason: 'user_type_changed' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('an adult athlete with email on whose login is switched off while a save waits: 403, and the switch and its confirmed address are kept (T-3 A)', async () => {
    const client = await freshDatabase('emailsw_adult_off_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_adult_off_race'), max: 4 });
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      await expect(whileHeld(
        client,
        ['update pilot.accounts set active_flag = false where account_id = $1', [ADULT_ID]],
        () => setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW),
      )).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, switched_on: true, confirmed_address: 'someone@example.test',
      })]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an adult athlete with email on whose date of birth is corrected to under 18 as their login is switched off, while a save waits: retired, address cleared (the record decides before the sign-in)', async () => {
    const client = await freshDatabase('emailsw_minor_and_off_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_minor_and_off_race'), max: 4 });
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      // One office transaction: the athlete row first, then the login, as the writers lock them.
      await expect(whileHeld(
        client,
        [
          `with corrected as (update pilot.athletes set dob = '2012-01-01' where athlete_id = $1 returning 1)
           update pilot.accounts set active_flag = false where account_id = $2`,
          [ADULT_ATHLETE, ADULT_ID],
        ],
        () => setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW),
      )).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, switched_on: false, confirmed_address: null, pending_address: null,
      })]);
      const audits = await auditRows(client);
      expect(audits.map((row) => row.details.reason)).toEqual(['no_longer_offered']);
      expect(JSON.stringify(audits)).not.toContain('example.test');
    } finally {
      await client.end();
    }
  });

  test('the type-change retire decides again under its own locks: made a parent again while a coach read\'s retire waits keeps the parent row on (reviewer B)', async () => {
    const client = await freshDatabase('emailsw_type_back_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_type_back_race'), max: 4 });
    try {
      await setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW);
      await client.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [PARENT_ID]);
      await client.query(`update pilot.organization_memberships set role = 'coach' where account_id = $1`, [PARENT_ID]);
      const asCoach = { organizationId: ORG_ID, accountId: PARENT_ID, role: 'coach' as const, athleteId: null };
      // One office statement: the account, then the membership, made a parent again.
      await whileHeld(client, [
        `with a as (update pilot.accounts set role = 'parent' where account_id = $1 returning account_id)
         update pilot.organization_memberships m set role = 'parent' from a where m.account_id = a.account_id and m.organization_id = $2`,
        [PARENT_ID, ORG_ID],
      ], () => readEmailAlertSwitch(asCoach, NOW));
      expect(await switchRows(client)).toEqual([expect.objectContaining({ user_type: 'parent', switched_on: true })]);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a coach with email on, the gym suspended while a switch-on save waits: 403, the switch kept on, nothing written (T-3 A; reviewer B)', async () => {
    const client = await freshDatabase('emailsw_gym_on_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_gym_on_race'), max: 4 });
    try {
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      await expect(whileHeld(
        client,
        [`update pilot.organizations set status = 'suspended' where organization_id = $1`, [ORG_ID]],
        () => setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW),
      )).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ user_type: 'staff', switched_on: true, has_off_at: false })]);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the record deleted', [`update pilot.athletes set deleted_at = now() where athlete_id = '${ADULT_ATHLETE}'`]],
    ['the account unlinked', [`update pilot.accounts set athlete_id = null where account_id = '${ADULT_ID}'`]],
    ['the record deleted and the login deleted and off', [
      `update pilot.athletes set deleted_at = now() where athlete_id = '${ADULT_ATHLETE}'`,
      `update pilot.accounts set deleted_at = now(), active_flag = false where account_id = '${ADULT_ID}'`,
    ]],
  ] as const)('an adult athlete with email on, %s: the next read retires it and clears the address, audited no_longer_offered (reviewer B)', async (_label, changes) => {
    const client = await freshDatabase('emailsw_record_gone');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      for (const sql of changes) await client.query(sql);
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({ offered: false });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ switched_on: false, confirmed_address: null })]);
      const audits = await auditRows(client);
      expect(audits.map((row) => row.details.reason)).toEqual(['no_longer_offered']);
      expect(JSON.stringify(audits)).not.toContain('example.test');
    } finally {
      await client.end();
    }
  });

  test('a coach with email on made a volunteer, then a coach again: the switch is kept, paused, and reads on again (T-2 A)', async () => {
    const client = await freshDatabase('emailsw_no_switch_role');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      const makeRole = async (role: string) => {
        await client.query('update pilot.accounts set role = $2 where account_id = $1', [COACH_ID, role]);
        await client.query(
          'update pilot.organization_memberships set role = $3 where account_id = $1 and organization_id = $2',
          [COACH_ID, ORG_ID, role],
        );
      };
      await makeRole('volunteer');
      // The route refuses a volunteer before the store; asked directly, the store keeps the row too.
      const asVolunteer = { organizationId: ORG_ID, accountId: COACH_ID, role: 'volunteer' as const, athleteId: null };
      await expect(readEmailAlertSwitch(asVolunteer, NOW)).resolves.toEqual({ offered: false });
      await expect(setEmailAlertSwitch({ ...asVolunteer, switchedOn: false }, NOW)).rejects.toMatchObject({ status: 403 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ user_type: 'staff', switched_on: true })]);

      await makeRole('coach');
      await expect(readEmailAlertSwitch(subject('coach'), NOW)).resolves.toEqual({ offered: true, user_type: 'staff', switched_on: true });
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  /** Holds `change` open on a second connection until `step` is waiting on a lock, then commits it. */
  async function whileHeld(client: Client, change: [string, unknown[]], step: () => Promise<unknown>) {
    const office = await activePool!.connect();
    try {
      await office.query('BEGIN');
      await office.query(change[0], change[1]);
      let settled = false;
      const result = step();
      result.then(() => { settled = true; }, () => { settled = true; });
      let waited = false;
      for (let i = 0; i < 200 && !settled; i += 1) {
        const { rows } = await client.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0].n > 0) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waited).toBe(true);
      await office.query('COMMIT');
      return result;
    } finally {
      office.release(true);
    }
  }

  // Every status but active, as sign-in refuses each (auth.ts).
  test.each(['suspended', 'inactive', 'pending'])('the gym made %s while a save waits on its row is seen inside the save: 403, never switched on, and nothing cleared', async (status) => {
    const client = await freshDatabase('emailsw_gym_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_gym_race'), max: 4 });
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      const save = whileHeld(client, [`update pilot.organizations set status = $2 where organization_id = $1`, [ORG_ID, status]],
        () => setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW));
      await expect(save).rejects.toMatchObject({ status: 403 });
      // Refused, but the person is still offered: their confirmed address stays.
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, switched_on: false, confirmed_address: 'someone@example.test',
      })]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a switch-off made while the gym is suspended under it is still saved: an opt-out is never lost', async () => {
    const client = await freshDatabase('emailsw_gym_off_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_gym_off_race'), max: 4 });
    try {
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      const save = whileHeld(client, [`update pilot.organizations set status = 'suspended' where organization_id = $1`, [ORG_ID]],
        () => setEmailAlertSwitch({ ...subject('coach'), switchedOn: false }, NOW));
      await expect(save).resolves.toEqual({ offered: true, user_type: 'staff', switched_on: false });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ account_id: COACH_ID, switched_on: false })]);
      // Reactivated later: the person stays opted out.
      await client.query(`update pilot.organizations set status = 'active' where organization_id = $1`, [ORG_ID]);
      await expect(readEmailAlertSwitch(subject('coach'), NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: false,
      });
    } finally {
      await client.end();
    }
  });

  test('a membership deleted while the save waits on the membership key: the plain 403, nothing written', async () => {
    const client = await freshDatabase('emailsw_membership_key_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_membership_key_race'), max: 4 });
    try {
      // The delete is held open on a second connection: lockPerson's read still
      // sees the membership, the insert's key check waits on the delete, and the
      // key refuses the insert once it commits (reviewer B on #2169).
      const save = whileHeld(client,
        ['delete from pilot.organization_memberships where account_id = $1 and organization_id = $2', [COACH_ID, ORG_ID]],
        () => setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW));
      await expect(save).rejects.toMatchObject({ status: 403, message: 'Forbidden: email alerts are not offered to this account' });
      expect(await switchRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the retire decides again under its own locks: an athlete corrected back to 18 or over while it waits keeps the row and address', async () => {
    const client = await freshDatabase('emailsw_retire_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_retire_race'), max: 4 });
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      // The record reads under 18 (a mistaken correction) when the read starts.
      await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]);
      // The office puts it right while the read's retire waits on the athlete row.
      const read = whileHeld(client, [`update pilot.athletes set dob = '2000-03-14' where athlete_id = $1`, [ADULT_ATHLETE]],
        () => readEmailAlertSwitch(subject('adult'), NOW));
      await expect(read).resolves.toEqual({ offered: false });
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: ADULT_ID, switched_on: true, confirmed_address: 'someone@example.test',
      })]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the confirmed address is read under the switch row lock: an address cleared while the save waits gives the 409', async () => {
    const client = await freshDatabase('emailsw_address_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_address_race'), max: 4 });
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      const save = whileHeld(client,
        ['update pilot.email_alert_switches set confirmed_address = null, confirmed_at = null where account_id = $1', [ADULT_ID]],
        () => setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW));
      await expect(save).rejects.toMatchObject({ status: 409 });
      expect(await switchRows(client)).toEqual([expect.objectContaining({ account_id: ADULT_ID, switched_on: false, confirmed_address: null })]);
    } finally {
      await client.end();
    }
  });

  test('an athlete deleted the way the office deletes one, while a save waits, does not deadlock: the deletion commits and the save gets 403', async () => {
    const client = await freshDatabase('emailsw_delete_order');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailsw_delete_order'), max: 4 });
    const office = await activePool.connect();
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', 'someone@example.test', now())`,
        [ORG_ID, ADULT_ID],
      );
      // deleteAthleteRecord's order (dataDeletion.ts): the athlete row, then its account.
      await office.query('BEGIN');
      await office.query('select 1 from pilot.athletes where athlete_id = $1 and organization_id = $2 for update', [ADULT_ATHLETE, ORG_ID]);
      await office.query('update pilot.athletes set deleted_at = now() where athlete_id = $1 and organization_id = $2', [ADULT_ATHLETE, ORG_ID]);
      let settled = false;
      const save = setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW);
      save.then(() => { settled = true; }, () => { settled = true; });
      let waited = false;
      for (let i = 0; i < 200 && !settled; i += 1) {
        const { rows } = await client.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0].n > 0) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The save really was held by the office's row, not finished before it.
      expect(waited).toBe(true);
      await office.query(
        `update pilot.accounts set deleted_at = now(), active_flag = false
          where organization_id = $1 and athlete_id = $2 and role = 'athlete'`,
        [ORG_ID, ADULT_ATHLETE],
      );
      await office.query('COMMIT');
      await expect(save).rejects.toMatchObject({ status: 403 });
      // The record is gone: the row that held a confirmed address is retired, whatever the login (reviewer B).
      expect(await switchRows(client)).toEqual([expect.objectContaining({ account_id: ADULT_ID, switched_on: false, confirmed_address: null })]);
      expect((await auditRows(client)).map((row) => row.details.reason)).toEqual(['no_longer_offered']);
    } finally {
      office.release(true);
      await client.end();
    }
  });

  test('a membership removed between sign-in and the save gets the plain 403, and nothing is written', async () => {
    const client = await freshDatabase('emailsw_no_membership');
    activeClient = client;
    try {
      // As if the gym removed the coach's membership row after they signed in.
      await client.query('delete from pilot.organization_memberships where account_id = $1', [COACH_ID]);
      await expect(setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW))
        .rejects.toMatchObject({ status: 403, message: 'Forbidden: email alerts are not offered to this account' });
      expect(await switchRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
