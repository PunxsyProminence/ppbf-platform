// Real PostgreSQL-backed test for the email-alert-switches migration (lane
// W4-1, EM-1a; OD-2026-11-19-019, OW27-10 A: each person's own opt-in switch;
// OW27-02 C: staff, parents and athletes 18 or over; OW27-38 B: an adult
// athlete's address is confirmed first; Overwatch GO on #2159, conditions 3
// and 4). The runner is driven through its real entrypoint, so its readiness
// check runs against a real Postgres here. The module that reads and writes
// the switch is EM-1b, with its own suite.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-switch-migration-pg-test-${Date.now()}`);
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
    // Turns 18 on 2026-11-25 (the store suite's birthday case).
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

describe('email alert switches migration', () => {
  test('creates the table from nothing, passes the runner readiness check, and a re-apply keeps the row', async () => {
    const client = await freshDatabase('emailsw_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.email_alert_switches') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
         values ($1, $2, 'parent', true, now())`,
        [ORG_ID, PARENT_ID],
      );
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query('select account_id, user_type, switched_on from pilot.email_alert_switches');
      expect(rows).toEqual([{ account_id: PARENT_ID, user_type: 'parent', switched_on: true }]);
    } finally {
      await client.end();
    }
  });

  test.each([
    [
      'a user type off the list',
      `alter table pilot.email_alert_switches
         drop constraint pilot_email_alert_switch_user_type_check,
         add constraint pilot_email_alert_switch_user_type_check check (user_type in ('staff', 'parent', 'adult_athlete', 'volunteer'))`,
    ],
    [
      'an adult athlete switch allowed on without an address',
      'alter table pilot.email_alert_switches drop constraint pilot_email_alert_switch_athlete_confirmed_check',
    ],
    [
      'an account key that no longer cascades',
      `alter table pilot.email_alert_switches
         drop constraint email_alert_switches_account_id_fkey,
         add constraint email_alert_switches_account_id_fkey foreign key (account_id) references pilot.accounts(account_id)`,
    ],
    ['no partial index for the sender', 'drop index pilot.idx_email_alert_switches_on'],
    ['no membership key', 'alter table pilot.email_alert_switches drop constraint pilot_email_alert_switch_membership_fk'],
    [
      'a membership key that no longer cascades',
      `alter table pilot.email_alert_switches
         drop constraint pilot_email_alert_switch_membership_fk,
         add constraint pilot_email_alert_switch_membership_fk foreign key (account_id, organization_id)
           references pilot.organization_memberships(account_id, organization_id)`,
    ],
    [
      'the sender\'s index on other columns',
      `drop index pilot.idx_email_alert_switches_on;
       create index idx_email_alert_switches_on on pilot.email_alert_switches (account_id) where switched_on`,
    ],
    ['a switch that starts on', 'alter table pilot.email_alert_switches alter column switched_on set default true'],
    ['a switch that may be null', 'alter table pilot.email_alert_switches alter column switched_on drop not null'],
    [
      'an extra CHECK that would block the address step',
      'alter table pilot.email_alert_switches add constraint pilot_email_alert_switch_extra check (pending_address is null)',
    ],
    [
      'the primary key in the other column order',
      `alter table pilot.email_alert_switches
         drop constraint email_alert_switches_pkey,
         add primary key (account_id, organization_id)`,
    ],
  ])('the readiness check refuses %s', async (_label, drift) => {
    const client = await freshDatabase('emailsw_drift');
    try {
      await client.query(drift);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SWITCHES_TABLE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a user type off the list', `($1, $2, 'volunteer', false, null, null, null, null)`, VOLUNTEER_ID,
      'pilot_email_alert_switch_user_type_check'],
    ['an adult athlete switched on with no confirmed address', `($1, $2, 'adult_athlete', true, now(), null, null, null)`, ADULT_ID,
      'pilot_email_alert_switch_athlete_confirmed_check'],
    ['a confirmed address on a parent row', `($1, $2, 'parent', false, null, null, 'someone@example.test', now())`, PARENT_ID,
      'pilot_email_alert_switch_address_athlete_only_check'],
    ['an address typed on a staff row', `($1, $2, 'staff', false, null, 'someone@example.test', null, null)`, COACH_ID,
      'pilot_email_alert_switch_address_athlete_only_check'],
    ['a switch on with no time it went on', `($1, $2, 'parent', true, null, null, null, null)`, PARENT_ID,
      'pilot_email_alert_switch_on_time_check'],
  ])('the database refuses %s, by its own CHECK', async (_label, values, accountId, constraint) => {
    const client = await freshDatabase('emailsw_check');
    try {
      await expect(client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, pending_address, confirmed_address, confirmed_at)
         values ${values}`,
        [ORG_ID, accountId],
      )).rejects.toMatchObject({ code: '23514', constraint });
      const { rows } = await client.query('select count(*)::int as n from pilot.email_alert_switches');
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the database refuses half a code, a code with no typed address, half a confirmation and a negative try count; it takes an adult athlete on with a confirmed address', async () => {
    const client = await freshDatabase('emailsw_pairs');
    try {
      const insert = (columns: string, values: string) => client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type${columns})
         values ($1, $2, 'adult_athlete'${values})`,
        [ORG_ID, ADULT_ID],
      );
      const pair = 'pilot_email_alert_switch_code_pair_check';
      const confirmedPair = 'pilot_email_alert_switch_confirmed_pair_check';
      await expect(insert(', pending_address, pending_code_hash', ", 'typed@example.test', 'h'"))
        .rejects.toMatchObject({ code: '23514', constraint: pair });
      await expect(insert(', pending_address, pending_code_expires_at', ", 'typed@example.test', now()"))
        .rejects.toMatchObject({ code: '23514', constraint: pair });
      await expect(insert(', pending_code_hash, pending_code_expires_at', ", 'h', now()"))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_email_alert_switch_code_needs_address_check' });
      await expect(insert(', confirmed_address', ", 'someone@example.test'"))
        .rejects.toMatchObject({ code: '23514', constraint: confirmedPair });
      await expect(insert(', confirmed_at', ', now()')).rejects.toMatchObject({ code: '23514', constraint: confirmedPair });
      await expect(insert(', pending_code_attempts', ', -1'))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_email_alert_switch_attempts_check' });

      // The states the address step (EM-2b) needs: a typed address with its code, before any confirm.
      await insert(', pending_address, pending_code_hash, pending_code_expires_at', ", 'typed@example.test', 'h', now()");
      await client.query('delete from pilot.email_alert_switches');

      await insert(
        ', switched_on, switched_on_at, confirmed_address, confirmed_at',
        ", true, now(), 'someone@example.test', now()",
      );
      const { rows } = await client.query('select user_type, switched_on from pilot.email_alert_switches');
      expect(rows).toEqual([{ user_type: 'adult_athlete', switched_on: true }]);
    } finally {
      await client.end();
    }
  });

  test('a hard-deleted account takes its switch, address included, with it; other rows stay', async () => {
    const client = await freshDatabase('emailsw_cascade');
    try {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), 'someone@example.test', now()),
                ($1, $3, 'parent', true, now(), null, null)`,
        [ORG_ID, ADULT_ID, PARENT_ID],
      );
      await client.query('delete from pilot.accounts where account_id = $1', [ADULT_ID]);
      const { rows } = await client.query('select account_id from pilot.email_alert_switches');
      expect(rows).toEqual([{ account_id: PARENT_ID }]);
    } finally {
      await client.end();
    }
  });

  test('a deleted gym takes its switches with it', async () => {
    const client = await freshDatabase('emailsw_gym_cascade');
    try {
      // OTHER_ORG_ID's only tie in this fixture is the parent's second
      // membership, so its row in pilot.organizations can be deleted.
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'parent', true)`,
        [PARENT_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type)
         values ($1, $2, 'parent'), ($3, $2, 'parent')`,
        [OTHER_ORG_ID, PARENT_ID, ORG_ID],
      );
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      const { rows } = await client.query('select organization_id from pilot.email_alert_switches');
      expect(rows).toEqual([{ organization_id: ORG_ID }]);
    } finally {
      await client.end();
    }
  });

  test('a new row starts off when nothing says otherwise', async () => {
    const client = await freshDatabase('emailsw_default');
    try {
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type) values ($1, $2, 'parent')`,
        [ORG_ID, PARENT_ID],
      );
      const { rows } = await client.query('select switched_on, pending_code_attempts from pilot.email_alert_switches');
      expect(rows).toEqual([{ switched_on: false, pending_code_attempts: 0 }]);
    } finally {
      await client.end();
    }
  });

  test('a switch can only name an account in a gym it belongs to (Codex P1 on #2168)', async () => {
    const client = await freshDatabase('emailsw_membership');
    try {
      // The parent is a member of ORG_ID only.
      await expect(client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type) values ($1, $2, 'parent')`,
        [OTHER_ORG_ID, PARENT_ID],
      )).rejects.toMatchObject({ code: '23503', constraint: 'pilot_email_alert_switch_membership_fk' });
      const { rows } = await client.query('select count(*)::int as n from pilot.email_alert_switches');
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a deleted membership takes that gym\'s switch with it; the account keeps its other gym\'s switch', async () => {
    const client = await freshDatabase('emailsw_membership_cascade');
    try {
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'parent', true)`,
        [PARENT_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type)
         values ($1, $2, 'parent'), ($3, $2, 'parent')`,
        [OTHER_ORG_ID, PARENT_ID, ORG_ID],
      );
      await client.query(
        'delete from pilot.organization_memberships where account_id = $1 and organization_id = $2',
        [PARENT_ID, OTHER_ORG_ID],
      );
      const { rows } = await client.query('select organization_id from pilot.email_alert_switches');
      expect(rows).toEqual([{ organization_id: ORG_ID }]);
    } finally {
      await client.end();
    }
  });
});
