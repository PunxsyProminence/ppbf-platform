// Real PostgreSQL-backed test for the email-alert-sends migration (lane W4-1,
// EM-3a; OD-2026-11-19-019: a content-free email; OW27-03 B: one email per
// event per person; Q1.10: a send log to prevent repeats and resume after a
// restart; Overwatch GO on #2159, condition 4). The runner's real
// applyMigrationTransaction is driven here, so its readiness check runs against
// a real Postgres. The sender that reads and writes these rows is EM-3b.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-sends-migration-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_email_alert_sends_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-email-alert-sends-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-emailsend';
const OTHER_ORG_ID = 'org-emailsend-elsewhere';
const ADMIN_ID = 'acct-emailsend-admin';
const COACH_ID = 'acct-emailsend-coach';
const PARENT_ID = 'acct-emailsend-parent';
const OUTSIDER_ID = 'acct-emailsend-outsider';

// Event row ids are UUIDs in every source (the event id CHECK takes nothing else).
const EVENT_1 = '00000000-0000-4000-8000-0000000000e1';
const NOTE_1 = '00000000-0000-4000-8000-0000000000a1';
const NOTE_2 = '00000000-0000-4000-8000-0000000000a2';
const EVENT_SENT = '00000000-0000-4000-8000-0000000000b1';
const EVENT_SKIPPED = '00000000-0000-4000-8000-0000000000b2';
const EVENT_FAILED = '00000000-0000-4000-8000-0000000000b3';
const EVENT_SENDING = '00000000-0000-4000-8000-0000000000b4';

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

/** The full schema, two gyms, and a gym admin, a coach and a parent who are members of the first. */
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
  const people: Array<[string, string, string]> = [
    [ADMIN_ID, 'organization_admin', ORG_ID],
    [COACH_ID, 'coach', ORG_ID],
    [PARENT_ID, 'parent', ORG_ID],
    // An account of the other gym only: never a member of the first.
    [OUTSIDER_ID, 'coach', OTHER_ORG_ID],
  ];
  for (const [accountId, role, org] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null) on conflict do nothing`,
      [accountId, role, org],
    );
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts
     where account_id = any($1::text[])
     on conflict do nothing`,
    [[ADMIN_ID, COACH_ID, PARENT_ID, OUTSIDER_ID]],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.email_alert_sends cascade');
    await client.query('drop table if exists pilot.email_alert_checkpoints cascade');
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

/** A queued send, with any column overridden. */
async function insertSend(client: Client, overrides: Record<string, unknown> = {}): Promise<void> {
  const row: Record<string, unknown> = {
    organization_id: ORG_ID,
    account_id: COACH_ID,
    user_type: 'staff',
    event_kind: 'safety_escalation',
    event_id: EVENT_1,
    ...overrides,
  };
  const columns = Object.keys(row);
  await client.query(
    `insert into pilot.email_alert_sends (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
}

async function sendRows(client: Client): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    'select organization_id, account_id, event_kind, event_id from pilot.email_alert_sends order by send_id',
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

describe('email alert sends migration', () => {
  test('creates both tables from nothing, passes the runner readiness check, and a re-apply keeps the rows', async () => {
    const client = await freshDatabase('emailsend_fresh', { preMigration: true });
    try {
      const before = await client.query(
        `select to_regclass('pilot.email_alert_sends') as s, to_regclass('pilot.email_alert_checkpoints') as c`,
      );
      expect(before.rows[0]).toEqual({ s: null, c: null });

      await applyMigrationTransaction(client, migrationSql);
      await insertSend(client);
      await client.query(
        `insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ('safety_escalation', now())`,
      );
      await applyMigrationTransaction(client, migrationSql);

      expect(await sendRows(client)).toEqual([
        { organization_id: ORG_ID, account_id: COACH_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
      ]);
      const checkpoints = await client.query('select event_kind from pilot.email_alert_checkpoints');
      expect(checkpoints.rows).toEqual([{ event_kind: 'safety_escalation' }]);
    } finally {
      await client.end();
    }
  });

  test.each([
    [
      'a user type off the list',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_user_type_check,
         add constraint pilot_email_alert_send_user_type_check check (user_type in ('staff', 'parent', 'adult_athlete', 'volunteer'))`,
    ],
    [
      'an event id of any shape (an address could be stored)',
      'alter table pilot.email_alert_sends drop constraint pilot_email_alert_send_event_id_check',
    ],
    [
      'an error code of any shape',
      'alter table pilot.email_alert_sends drop constraint pilot_email_alert_send_error_code_check',
    ],
    [
      'a sixth try',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_tries_check,
         add constraint pilot_email_alert_send_tries_check check (tries between 0 and 6)`,
    ],
    ['no lease rule', 'alter table pilot.email_alert_sends drop constraint pilot_email_alert_send_lease_check'],
    [
      'an extra CHECK',
      'alter table pilot.email_alert_sends add constraint pilot_email_alert_send_extra check (tries >= 0)',
    ],
    ['a new send that starts sent', `alter table pilot.email_alert_sends alter column status set default 'sent'`],
    ['a new send that starts with a try spent', 'alter table pilot.email_alert_sends alter column tries set default 1'],
    ['an event id that may be null', 'alter table pilot.email_alert_sends alter column event_id drop not null'],
    ['a lease token stored as text', 'alter table pilot.email_alert_sends alter column lease_token type text'],
    ['an extra column (an address)', 'alter table pilot.email_alert_sends add column to_address text'],
    ['no one-row-per-event key', 'alter table pilot.email_alert_sends drop constraint pilot_email_alert_send_once_key'],
    [
      'the one-row key without the gym',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_once_key,
         add constraint pilot_email_alert_send_once_key unique (account_id, event_kind, event_id)`,
    ],
    ['no membership key', 'alter table pilot.email_alert_sends drop constraint pilot_email_alert_send_membership_fk'],
    [
      'a membership key that no longer cascades',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_membership_fk,
         add constraint pilot_email_alert_send_membership_fk foreign key (account_id, organization_id)
           references pilot.organization_memberships(account_id, organization_id)`,
    ],
    [
      'a crossed membership key',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_membership_fk,
         add constraint pilot_email_alert_send_membership_fk foreign key (account_id, organization_id)
           references pilot.organization_memberships(organization_id, account_id) on delete cascade`,
    ],
    [
      'an account key that no longer cascades',
      `alter table pilot.email_alert_sends
         drop constraint email_alert_sends_account_id_fkey,
         add constraint email_alert_sends_account_id_fkey foreign key (account_id) references pilot.accounts(account_id)`,
    ],
    [
      'an extra foreign key',
      `alter table pilot.email_alert_sends
         add constraint pilot_email_alert_send_extra_fk foreign key (organization_id)
           references pilot.organizations(organization_id) on delete restrict`,
    ],
    ['no index for the queue', 'drop index pilot.idx_email_alert_sends_queued'],
    [
      'the queue index on every row',
      `drop index pilot.idx_email_alert_sends_queued;
       create index idx_email_alert_sends_queued on pilot.email_alert_sends (next_try_at)`,
    ],
    ['no index for expired leases', 'drop index pilot.idx_email_alert_sends_leased'],
    ['an extra index', 'create index idx_email_alert_sends_extra on pilot.email_alert_sends (created_at)'],
    [
      'an extra unique index (a second person\'s alert would be dropped)',
      'create unique index email_alert_sends_per_event on pilot.email_alert_sends (organization_id, event_kind, event_id)',
    ],
    [
      'an extra unique key',
      `alter table pilot.email_alert_sends
         add constraint pilot_email_alert_send_extra_key unique (organization_id, event_kind, event_id)`,
    ],
    [
      'a deferrable one-row key (ON CONFLICT refuses it)',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_once_key,
         add constraint pilot_email_alert_send_once_key unique (organization_id, account_id, event_kind, event_id)
           deferrable initially immediate`,
    ],
    [
      'a deferred membership key',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_membership_fk,
         add constraint pilot_email_alert_send_membership_fk foreign key (account_id, organization_id)
           references pilot.organization_memberships(account_id, organization_id) on delete cascade
           deferrable initially deferred`,
    ],
    [
      'a gym key that no longer cascades',
      `alter table pilot.email_alert_sends
         drop constraint email_alert_sends_organization_id_fkey,
         add constraint email_alert_sends_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id)`,
    ],
    [
      'the primary key on other columns',
      `alter table pilot.email_alert_sends
         drop constraint email_alert_sends_pkey,
         add constraint email_alert_sends_pkey primary key (send_id, organization_id)`,
    ],
    [
      'a CHECK not validated',
      `alter table pilot.email_alert_sends
         drop constraint pilot_email_alert_send_event_id_check,
         add constraint pilot_email_alert_send_event_id_check
           check (event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') not valid`,
    ],
    [
      'a new send that is never due',
      `alter table pilot.email_alert_sends alter column next_try_at set default 'infinity'`,
    ],
    ['no time a send was made', 'alter table pilot.email_alert_sends alter column created_at drop default'],
    ['a send id with no generator', 'alter table pilot.email_alert_sends alter column send_id drop identity'],
    ['a checkpoint with no update time', 'alter table pilot.email_alert_checkpoints alter column updated_at drop default'],
    ['an extra checkpoint index', 'create index idx_email_alert_checkpoints_extra on pilot.email_alert_checkpoints (swept_to)'],
    [
      'a checkpoint of any kind',
      'alter table pilot.email_alert_checkpoints drop constraint pilot_email_alert_checkpoint_kind_check',
    ],
    ['a checkpoint with no time', 'alter table pilot.email_alert_checkpoints alter column swept_to drop not null'],
    ['no checkpoint key', 'alter table pilot.email_alert_checkpoints drop constraint email_alert_checkpoints_pkey'],
  ])('the readiness check refuses %s', async (_label, drift) => {
    const client = await freshDatabase('emailsend_drift');
    try {
      await client.query(drift);
      // Readiness alone: re-running the migration would put a dropped index back.
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SENDS_TABLES_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a user type off the list', { user_type: 'volunteer' }, 'pilot_email_alert_send_user_type_check'],
    ['an event kind with capitals', { event_kind: 'Gym_Notice' }, 'pilot_email_alert_send_kind_check'],
    ['an address as the event id', { event_id: 'someone@example.org' }, 'pilot_email_alert_send_event_id_check'],
    ['an event id with spaces', { event_id: 'open the app' }, 'pilot_email_alert_send_event_id_check'],
    ['an id-like token that is not a UUID', { event_id: 'esc-1' }, 'pilot_email_alert_send_event_id_check'],
    ['a UUID in capitals', { event_id: '00000000-0000-4000-8000-0000000000AB' }, 'pilot_email_alert_send_event_id_check'],
    ['a status off the list', { status: 'pending' }, 'pilot_email_alert_send_status_check'],
    [
      'a sixth try',
      { status: 'failed', tries: 6, finished_at: '2026-11-25T12:00:00Z' },
      'pilot_email_alert_send_tries_check',
    ],
    ['a queued row with no tries left', { tries: 5 }, 'pilot_email_alert_send_queued_tries_check'],
    ['a negative try count', { tries: -1 }, 'pilot_email_alert_send_tries_check'],
    ['an address as the error code', { last_error_code: 'someone@example.org' }, 'pilot_email_alert_send_error_code_check'],
    ['an HTTP status off the scale', { last_status_code: 99 }, 'pilot_email_alert_send_status_code_check'],
    ['a send in progress with no lease', { status: 'sending' }, 'pilot_email_alert_send_lease_check'],
    [
      'a queued row holding a lease',
      { lease_token: '00000000-0000-4000-8000-000000000001', lease_expires_at: '2026-11-25T12:00:00Z' },
      'pilot_email_alert_send_lease_check',
    ],
    [
      'a lease with no expiry',
      { status: 'sending', lease_token: '00000000-0000-4000-8000-000000000001' },
      'pilot_email_alert_send_lease_check',
    ],
    ['a sent row with no finished time', { status: 'sent' }, 'pilot_email_alert_send_finished_check'],
    ['a queued row with a finished time', { finished_at: '2026-11-25T12:00:00Z' }, 'pilot_email_alert_send_finished_check'],
    [
      'a skip with no reason',
      { status: 'skipped', finished_at: '2026-11-25T12:00:00Z' },
      'pilot_email_alert_send_skipped_check',
    ],
    ['a reason on a row that was not skipped', { skip_reason: 'switched_off' }, 'pilot_email_alert_send_skipped_check'],
    [
      'a skip reason off the list',
      { status: 'skipped', finished_at: '2026-11-25T12:00:00Z', skip_reason: 'because' },
      'pilot_email_alert_send_skip_reason_check',
    ],
  ])('the database refuses %s, by its own CHECK', async (_label, overrides, constraint) => {
    const client = await freshDatabase('emailsend_refused');
    try {
      await expect(insertSend(client, overrides)).rejects.toMatchObject({ code: '23514', constraint });
      expect(await sendRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('it takes every finished state the sender writes: sent, skipped with its reason, failed with its codes', async () => {
    const client = await freshDatabase('emailsend_states');
    try {
      await insertSend(client, { event_id: EVENT_SENT, status: 'sent', tries: 1, finished_at: '2026-11-25T12:00:00Z' });
      await insertSend(client, {
        event_id: EVENT_SKIPPED, status: 'skipped', skip_reason: 'gym_unticked', finished_at: '2026-11-25T12:00:00Z',
      });
      await insertSend(client, {
        event_id: EVENT_FAILED, status: 'failed', tries: 5, last_status_code: 503,
        last_error_code: 'GRAPH_SEND_FAILED', finished_at: '2026-11-25T12:00:00Z',
      });
      await insertSend(client, {
        event_id: EVENT_SENDING, status: 'sending',
        lease_token: '00000000-0000-4000-8000-000000000001', lease_expires_at: '2026-11-25T12:02:00Z',
      });
      const { rows } = await client.query('select event_id, status from pilot.email_alert_sends order by send_id');
      expect(rows).toEqual([
        { event_id: EVENT_SENT, status: 'sent' },
        { event_id: EVENT_SKIPPED, status: 'skipped' },
        { event_id: EVENT_FAILED, status: 'failed' },
        { event_id: EVENT_SENDING, status: 'sending' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a new send starts queued with no tries, due now', async () => {
    const client = await freshDatabase('emailsend_defaults');
    try {
      await insertSend(client);
      const { rows } = await client.query(
        `select status, tries, next_try_at <= clock_timestamp() as due, lease_token, finished_at, skip_reason
           from pilot.email_alert_sends`,
      );
      expect(rows).toEqual([{ status: 'queued', tries: 0, due: true, lease_token: null, finished_at: null, skip_reason: null }]);
    } finally {
      await client.end();
    }
  });

  test('one row per gym, person, event kind and event: a second is refused, another person or kind is not', async () => {
    const client = await freshDatabase('emailsend_once');
    try {
      await insertSend(client);
      await expect(insertSend(client)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_email_alert_send_once_key' });
      await insertSend(client, { account_id: ADMIN_ID });
      await insertSend(client, { event_kind: 'gym_notice' });
      expect(await sendRows(client)).toEqual([
        { organization_id: ORG_ID, account_id: COACH_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
        { organization_id: ORG_ID, account_id: ADMIN_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
        { organization_id: ORG_ID, account_id: COACH_ID, event_kind: 'gym_notice', event_id: EVENT_1 },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a send can only name an account in a gym it has a membership row in', async () => {
    const client = await freshDatabase('emailsend_member');
    try {
      await expect(insertSend(client, { account_id: OUTSIDER_ID })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_email_alert_send_membership_fk',
      });
      expect(await sendRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a deleted membership or account takes its sends with it; other rows stay', async () => {
    const client = await freshDatabase('emailsend_cascade');
    try {
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'parent', true)`,
        [PARENT_ID, OTHER_ORG_ID],
      );
      await insertSend(client, { account_id: PARENT_ID, user_type: 'parent', event_kind: 'family_note', event_id: NOTE_1 });
      await insertSend(client, {
        organization_id: OTHER_ORG_ID, account_id: PARENT_ID, user_type: 'parent', event_kind: 'family_note', event_id: NOTE_2,
      });
      await insertSend(client, { account_id: COACH_ID });
      await insertSend(client, { account_id: ADMIN_ID });

      // A membership: the parent's first-gym send goes, the other gym's stays.
      await client.query(
        'delete from pilot.organization_memberships where account_id = $1 and organization_id = $2',
        [PARENT_ID, ORG_ID],
      );
      expect(await sendRows(client)).toEqual([
        { organization_id: OTHER_ORG_ID, account_id: PARENT_ID, event_kind: 'family_note', event_id: NOTE_2 },
        { organization_id: ORG_ID, account_id: COACH_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
        { organization_id: ORG_ID, account_id: ADMIN_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
      ]);

      // An account (the purge hard-deletes parent accounts): every send of it goes.
      await client.query('delete from pilot.accounts where account_id = $1', [PARENT_ID]);
      expect(await sendRows(client)).toEqual([
        { organization_id: ORG_ID, account_id: COACH_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
        { organization_id: ORG_ID, account_id: ADMIN_ID, event_kind: 'safety_escalation', event_id: EVENT_1 },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a deleted gym takes its sends with it; the other gym keeps its own', async () => {
    const client = await freshDatabase('emailsend_gym_cascade');
    try {
      // Leave the other gym tied only to the parent's second membership, so its
      // row in pilot.organizations can be deleted.
      await client.query('delete from pilot.organization_memberships where account_id = $1', [OUTSIDER_ID]);
      await client.query('delete from pilot.accounts where account_id = $1', [OUTSIDER_ID]);
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'parent', true)`,
        [PARENT_ID, OTHER_ORG_ID],
      );
      await insertSend(client, { account_id: PARENT_ID, user_type: 'parent', event_kind: 'family_note', event_id: NOTE_1 });
      await insertSend(client, {
        organization_id: OTHER_ORG_ID, account_id: PARENT_ID, user_type: 'parent', event_kind: 'family_note', event_id: NOTE_2,
      });
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      expect(await sendRows(client)).toEqual([
        { organization_id: ORG_ID, account_id: PARENT_ID, event_kind: 'family_note', event_id: NOTE_1 },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a checkpoint is one row per event kind of the right shape', async () => {
    const client = await freshDatabase('emailsend_checkpoint');
    try {
      await client.query(`insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ('gym_notice', now())`);
      await expect(
        client.query(`insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ('gym_notice', now())`),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query(`insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ('Gym Notice', now())`),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_email_alert_checkpoint_kind_check' });
    } finally {
      await client.end();
    }
  });
});
