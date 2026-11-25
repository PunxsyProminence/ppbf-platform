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

import type { PilotRole } from './contracts';
import { readEmailAlertSwitch, setEmailAlertSwitch } from './emailAlertSwitches';

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
       from pilot.audit_events where entity_type = 'email_alert_switch' order by created_at, audit_id`,
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

afterEach(() => {
  activeClient = null;
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

  test('an adult athlete is offered the switch but cannot turn it on before an address is confirmed: no row, no audit', async () => {
    const client = await freshDatabase('emailsw_adult');
    activeClient = client;
    try {
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false,
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
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true,
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
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false,
      });
    } finally {
      await activeClient.end();
    }
  });

  test('a non-boolean is refused before anything is read or written', async () => {
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

  test('a row saved under another user type is not this switch: it reads off, and a save under the new type drops any address', async () => {
    const client = await freshDatabase('emailsw_retype');
    activeClient = client;
    try {
      // The coach account's row as if it had been saved while the account was an adult athlete.
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, pending_address, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'typed@example.test', 'someone@example.test', now())`,
        [ORG_ID, COACH_ID],
      );
      await expect(readEmailAlertSwitch(subject('coach'), NOW)).resolves.toEqual({
        offered: true, user_type: 'staff', switched_on: false,
      });
      await setEmailAlertSwitch({ ...subject('coach'), switchedOn: true }, NOW);
      expect(await switchRows(client)).toEqual([expect.objectContaining({
        account_id: COACH_ID, user_type: 'staff', switched_on: true, pending_address: null, confirmed_address: null,
      })]);
      expect((await auditRows(client))[0].details).toEqual({ user_type: 'staff', switched_on: true, previous_switched_on: false });
    } finally {
      await client.end();
    }
  });
});
