// Real PostgreSQL-backed test for the web-push migration (lane W5-WP, WP-1a;
// OW27-17 B, OW27-18 A; plan, answers and GO on #2228: QC A1, QG A). The
// runner is driven through its real entrypoint, so its readiness check runs
// against a real Postgres here. The store that reads and writes the rows is
// WP-1b, with its own suite.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-web-push-migration-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_web_push_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-web-push-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-webpush';
const OTHER_ORG_ID = 'org-webpush-elsewhere';
const COACH_ID = 'acct-webpush-coach';
const PARENT_ID = 'acct-webpush-parent';
const OTHER_PARENT_ID = 'acct-webpush-parent-2';

const EVENT_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

/** A browser's keys as PushSubscription gives them: a P-256 point (65 bytes) and a 16-byte secret, base64url, no padding. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  return {
    p256dh: ecdh.generateKeys().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}
const KEYS = browserKeys();
const ENDPOINT = 'https://push.example.test/send/abc123';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let readiness: (client: Client) => Promise<Record<string, boolean>>;
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

/** The full schema, two gyms, a coach and two parents in the first, each a member of it. */
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
  for (const [accountId, role] of [[COACH_ID, 'coach'], [PARENT_ID, 'parent'], [OTHER_PARENT_ID, 'parent']]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null) on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts where organization_id = $1
     on conflict do nothing`,
    [ORG_ID],
  );

  if (preMigration) {
    await client.query(
      'drop table if exists pilot.push_alert_checkpoints, pilot.push_alert_sends, pilot.push_subscriptions cascade',
    );
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

function insertSubscription(
  client: Client,
  overrides: Partial<Record<'organization_id' | 'account_id' | 'user_type' | 'endpoint' | 'key_p256dh' | 'key_auth' | 'device_key_hash', string | null>> = {},
) {
  const row = {
    organization_id: ORG_ID,
    account_id: PARENT_ID,
    user_type: 'parent',
    endpoint: ENDPOINT,
    key_p256dh: KEYS.p256dh,
    key_auth: KEYS.auth,
    device_key_hash: null as string | null,
    ...overrides,
  };
  return client.query(
    `insert into pilot.push_subscriptions
       (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth, device_key_hash)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [row.organization_id, row.account_id, row.user_type, row.endpoint, row.key_p256dh, row.key_auth, row.device_key_hash],
  );
}

function insertSend(client: Client, columns = '', values = '', accountId = PARENT_ID) {
  return client.query(
    `insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id${columns})
     values ($1, $2, 'parent', 'family_note', $3${values})`,
    [ORG_ID, accountId, EVENT_ID],
  );
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
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;
  readiness = runnerModule.readiness as typeof readiness;
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

describe('web push migration', () => {
  test('creates the three tables from nothing, passes every readiness flag, and a re-apply keeps the rows', async () => {
    const client = await freshDatabase('webpush_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.push_subscriptions') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      const flags = await readiness(client);
      // 3 tables x 8 flags; every one true. Named, so a failure says which.
      expect(Object.keys(flags)).toHaveLength(24);
      expect(Object.entries(flags).filter(([, value]) => value !== true)).toEqual([]);

      await insertSubscription(client);
      await insertSend(client);
      await client.query(`insert into pilot.push_alert_checkpoints (event_kind, swept_to) values ('family_note', now())`);
      await applyMigrationTransaction(client, migrationSql);

      const counts = await client.query(
        `select (select count(*) from pilot.push_subscriptions)::int as subs,
                (select count(*) from pilot.push_alert_sends)::int as sends,
                (select count(*) from pilot.push_alert_checkpoints)::int as checkpoints`,
      );
      expect(counts.rows[0]).toEqual({ subs: 1, sends: 1, checkpoints: 1 });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['push_subscriptions.checks_ready', 'an endpoint CHECK that also takes http',
      `alter table pilot.push_subscriptions drop constraint pilot_push_subscription_endpoint_check,
         add constraint pilot_push_subscription_endpoint_check check (endpoint ~ '^https?://[^[:space:]]+$' and length(endpoint) <= 2048)`],
    ['push_subscriptions.checks_ready', 'no p256dh length CHECK',
      'alter table pilot.push_subscriptions drop constraint pilot_push_subscription_p256dh_check'],
    ['push_subscriptions.checks_ready', 'the device key CHECK not validated',
      `alter table pilot.push_subscriptions drop constraint pilot_push_subscription_device_key_check,
         add constraint pilot_push_subscription_device_key_check check (device_key_hash ~ '^[0-9a-f]{64}$') not valid`],
    ['push_subscriptions.checks_ready', 'an extra CHECK',
      'alter table pilot.push_subscriptions add constraint pilot_push_subscription_extra check (device_key_hash is null)'],
    ['push_subscriptions.unique_keys_ready', 'no one-person-per-endpoint key',
      'alter table pilot.push_subscriptions drop constraint pilot_push_subscription_endpoint_key'],
    ['push_subscriptions.unique_keys_ready', 'a deferrable endpoint key',
      `alter table pilot.push_subscriptions drop constraint pilot_push_subscription_endpoint_key,
         add constraint pilot_push_subscription_endpoint_key unique (endpoint) deferrable`],
    ['push_subscriptions.foreign_keys_ready', 'an account key that no longer cascades',
      `alter table pilot.push_subscriptions drop constraint push_subscriptions_account_id_fkey,
         add constraint push_subscriptions_account_id_fkey foreign key (account_id) references pilot.accounts(account_id)`],
    ['push_subscriptions.foreign_keys_ready', 'a membership key crossed on the referenced side',
      `alter table pilot.push_subscriptions drop constraint pilot_push_subscription_membership_fk,
         add constraint pilot_push_subscription_membership_fk foreign key (account_id, organization_id)
           references pilot.organization_memberships(organization_id, account_id) on delete cascade`],
    ['push_subscriptions.foreign_keys_ready', 'no membership key',
      'alter table pilot.push_subscriptions drop constraint pilot_push_subscription_membership_fk'],
    ['push_subscriptions.foreign_keys_ready', 'an extra key that blocks deleting a membership',
      `alter table pilot.push_subscriptions add constraint pilot_push_subscription_extra_fk foreign key (account_id, organization_id)
         references pilot.organization_memberships(account_id, organization_id) on delete restrict`],
    ['push_subscriptions.columns_ready', 'a device key that must be filled',
      'alter table pilot.push_subscriptions alter column device_key_hash set not null'],
    ['push_subscriptions.columns_ready', 'an extra column (a user agent)',
      'alter table pilot.push_subscriptions add column user_agent text'],
    ['push_subscriptions.indexes_ready', "no index for the sweep's per-person read",
      'drop index pilot.idx_push_subscriptions_person'],
    ['push_subscriptions.table_plain', 'a trigger that could drop rows',
      `create function pilot.webpush_test_noop() returns trigger language plpgsql as $$ begin return null; end $$;
       create trigger webpush_test_noop before insert on pilot.push_subscriptions for each row execute function pilot.webpush_test_noop()`],
    ['push_alert_sends.checks_ready', 'a skip reason off the list',
      `alter table pilot.push_alert_sends drop constraint pilot_push_alert_send_skip_reason_check,
         add constraint pilot_push_alert_send_skip_reason_check check (skip_reason in ('switched_off', 'gym_unticked', 'sign_in_off', 'not_offered', 'no_subscription', 'other'))`],
    ['push_alert_sends.checks_ready', 'no queued-with-a-try-left CHECK',
      'alter table pilot.push_alert_sends drop constraint pilot_push_alert_send_queued_tries_check'],
    ['push_alert_sends.unique_keys_ready', 'a once key on fewer columns',
      `alter table pilot.push_alert_sends drop constraint pilot_push_alert_send_once_key,
         add constraint pilot_push_alert_send_once_key unique (organization_id, account_id, event_id)`],
    ['push_alert_sends.columns_ready', 'a send that starts sent',
      "alter table pilot.push_alert_sends alter column status set default 'sent'"],
    ['push_alert_sends.foreign_keys_ready', 'a gym key that is deferrable',
      `alter table pilot.push_alert_sends drop constraint push_alert_sends_organization_id_fkey,
         add constraint push_alert_sends_organization_id_fkey foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade deferrable`],
    ['push_alert_sends.indexes_ready', "no index for the sender's claim",
      'drop index pilot.idx_push_alert_sends_queued'],
    ['push_alert_sends.table_plain', 'row security turned on',
      'alter table pilot.push_alert_sends enable row level security'],
    ['push_alert_checkpoints.checks_ready', 'no checkpoint key CHECK',
      'alter table pilot.push_alert_checkpoints drop constraint pilot_push_alert_checkpoint_kind_check'],
    ['push_alert_checkpoints.indexes_ready', 'an extra index',
      'create index webpush_test_extra on pilot.push_alert_checkpoints (swept_to)'],
  ])('the readiness check fails %s when it sees %s', async (flag, _label, drift) => {
    const client = await freshDatabase('webpush_drift');
    try {
      await client.query(drift);
      // The named flag goes false (so the test knows which check bit), and the runner refuses.
      expect((await readiness(client))[flag]).toBe(false);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('WEB_PUSH_TABLES_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the readiness check fails when a table is missing', async () => {
    const client = await freshDatabase('webpush_missing');
    try {
      await client.query('drop table pilot.push_alert_checkpoints');
      expect((await readiness(client))['push_alert_checkpoints.table_ready']).toBe(false);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('WEB_PUSH_TABLES_NOT_READY');
    } finally {
      await client.end();
    }
  });

  const longEndpoint = `https://push.example.test/${'a'.repeat(2049 - 'https://push.example.test/'.length)}`;
  test.each([
    ['a user type off the list', { user_type: 'volunteer' }, 'pilot_push_subscription_user_type_check'],
    ['an http endpoint', { endpoint: 'http://push.example.test/send/abc' }, 'pilot_push_subscription_endpoint_check'],
    ['an endpoint with a space in it', { endpoint: 'https://push.example.test/a b' }, 'pilot_push_subscription_endpoint_check'],
    ['an endpoint over 2048 characters', { endpoint: longEndpoint }, 'pilot_push_subscription_endpoint_check'],
    ['a p256dh one character short (64 bytes)', { key_p256dh: KEYS.p256dh.slice(1) }, 'pilot_push_subscription_p256dh_check'],
    ['a p256dh with base64 padding', { key_p256dh: `${KEYS.p256dh}=` }, 'pilot_push_subscription_p256dh_check'],
    ['a p256dh in standard base64 (+ and /)', { key_p256dh: `+/${KEYS.p256dh.slice(2)}` }, 'pilot_push_subscription_p256dh_check'],
    ['an auth secret under 16 bytes', { key_auth: KEYS.auth.slice(1) }, 'pilot_push_subscription_auth_check'],
    ['a device key that is not a SHA-256 hex', { device_key_hash: 'not-a-hash' }, 'pilot_push_subscription_device_key_check'],
    ['a device key in capitals', { device_key_hash: 'A'.repeat(64) }, 'pilot_push_subscription_device_key_check'],
  ])('the database refuses a browser row with %s, by its own CHECK', async (_label, overrides, constraint) => {
    const client = await freshDatabase('webpush_sub_check');
    try {
      await expect(insertSubscription(client, overrides)).rejects.toMatchObject({ code: '23514', constraint });
      const { rows } = await client.query('select count(*)::int as n from pilot.push_subscriptions');
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('it takes a browser row as a real P-256 key and secret give it, with and without a device key, at the 2048 limit', async () => {
    const client = await freshDatabase('webpush_sub_ok');
    try {
      expect(KEYS.p256dh).toHaveLength(87);
      expect(KEYS.auth).toHaveLength(22);
      await insertSubscription(client, { endpoint: longEndpoint.slice(0, 2048) });
      const other = browserKeys();
      await insertSubscription(client, {
        account_id: OTHER_PARENT_ID,
        endpoint: `${ENDPOINT}-2`,
        key_p256dh: other.p256dh,
        key_auth: other.auth,
        device_key_hash: randomBytes(32).toString('hex'),
      });
      const { rows } = await client.query('select count(*)::int as n from pilot.push_subscriptions');
      expect(rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('one person per browser: a second row for the same endpoint is refused, whoever it is for', async () => {
    const client = await freshDatabase('webpush_endpoint_key');
    try {
      await insertSubscription(client);
      await expect(insertSubscription(client, { account_id: OTHER_PARENT_ID }))
        .rejects.toMatchObject({ code: '23505', constraint: 'pilot_push_subscription_endpoint_key' });
      await expect(insertSubscription(client))
        .rejects.toMatchObject({ code: '23505', constraint: 'pilot_push_subscription_endpoint_key' });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a status off the list', ', status', ", 'delivered'", 'pilot_push_alert_send_status_check'],
    ['six tries', ', status, tries, finished_at', ", 'failed', 6, now()", 'pilot_push_alert_send_tries_check'],
    ['a skip reason off the list', ', status, skip_reason, finished_at', ", 'skipped', 'no_address', now()", 'pilot_push_alert_send_skip_reason_check'],
    ['an HTTP status out of range', ', last_status_code', ', 99', 'pilot_push_alert_send_status_code_check'],
    ['an error code that could hold an address', ', last_error_code', ", 'x@example.test'", 'pilot_push_alert_send_error_code_check'],
    ['a row being sent with no lease', ', status', ", 'sending'", 'pilot_push_alert_send_lease_check'],
    ['a lease with no expiry', ', lease_token', ', gen_random_uuid()', 'pilot_push_alert_send_lease_check'],
    ['a sent row with no finish time', ', status', ", 'sent'", 'pilot_push_alert_send_finished_check'],
    ['a skip with no reason', ', status, finished_at', ", 'skipped', now()", 'pilot_push_alert_send_skipped_check'],
    ['a reason on a row that was not skipped', ', status, skip_reason, finished_at', ", 'sent', 'gym_unticked', now()", 'pilot_push_alert_send_skipped_check'],
    ['a queued row with no try left', ', tries', ', 5', 'pilot_push_alert_send_queued_tries_check'],
  ])('the database refuses a send row with %s, by its own CHECK', async (_label, columns, values, constraint) => {
    const client = await freshDatabase('webpush_send_check');
    try {
      await expect(insertSend(client, columns, values)).rejects.toMatchObject({ code: '23514', constraint });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['an event kind of the wrong shape', 'Family-Note', EVENT_ID, 'pilot_push_alert_send_kind_check'],
    ['an event id that is not a UUID', 'family_note', 'not-a-uuid', 'pilot_push_alert_send_event_id_check'],
    ['an event id in capitals', 'family_note', EVENT_ID.toUpperCase(), 'pilot_push_alert_send_event_id_check'],
  ])('the database refuses a send row with %s, by its own CHECK', async (_label, kind, eventId, constraint) => {
    const client = await freshDatabase('webpush_send_event');
    try {
      await expect(client.query(
        `insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id)
         values ($1, $2, 'parent', $3, $4)`,
        [ORG_ID, PARENT_ID, kind, eventId],
      )).rejects.toMatchObject({ code: '23514', constraint });
    } finally {
      await client.end();
    }
  });

  test('a new send row starts queued, with no tries, due now; a second row for the same event is refused', async () => {
    const client = await freshDatabase('webpush_send_default');
    try {
      await insertSend(client);
      const { rows } = await client.query(
        'select status, tries, next_try_at <= clock_timestamp() as due, finished_at from pilot.push_alert_sends',
      );
      expect(rows).toEqual([{ status: 'queued', tries: 0, due: true, finished_at: null }]);
      await expect(insertSend(client)).rejects.toMatchObject({ code: '23505', constraint: 'pilot_push_alert_send_once_key' });
      // Another person, same event: their own row.
      await insertSend(client, '', '', OTHER_PARENT_ID);
      // A skipped row with its reason, and a switched_off skip (QA B only).
      await client.query(
        `update pilot.push_alert_sends set status = 'skipped', skip_reason = 'switched_off', finished_at = now()
          where account_id = $1`,
        [OTHER_PARENT_ID],
      );
    } finally {
      await client.end();
    }
  });

  test('a browser and a send can only name an account in a gym it belongs to (Codex P1 on #2168)', async () => {
    const client = await freshDatabase('webpush_membership');
    try {
      await expect(insertSubscription(client, { organization_id: OTHER_ORG_ID }))
        .rejects.toMatchObject({ code: '23503', constraint: 'pilot_push_subscription_membership_fk' });
      await expect(client.query(
        `insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id)
         values ($1, $2, 'parent', 'family_note', $3)`,
        [OTHER_ORG_ID, PARENT_ID, EVENT_ID],
      )).rejects.toMatchObject({ code: '23503', constraint: 'pilot_push_alert_send_membership_fk' });
    } finally {
      await client.end();
    }
  });

  test('a hard-deleted account takes its browsers and sends with it; another person\'s stay', async () => {
    const client = await freshDatabase('webpush_account_cascade');
    try {
      await insertSubscription(client);
      await insertSubscription(client, { account_id: OTHER_PARENT_ID, endpoint: `${ENDPOINT}-2` });
      await insertSend(client);
      await insertSend(client, '', '', OTHER_PARENT_ID);
      await client.query('delete from pilot.accounts where account_id = $1', [PARENT_ID]);
      const subs = await client.query('select account_id from pilot.push_subscriptions');
      const sends = await client.query('select account_id from pilot.push_alert_sends');
      expect(subs.rows).toEqual([{ account_id: OTHER_PARENT_ID }]);
      expect(sends.rows).toEqual([{ account_id: OTHER_PARENT_ID }]);
    } finally {
      await client.end();
    }
  });

  test('a deleted membership takes that gym\'s browsers and sends; a deleted gym takes its own', async () => {
    const client = await freshDatabase('webpush_gym_cascade');
    try {
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'parent', true), ($3, $2, 'parent', true)`,
        [PARENT_ID, OTHER_ORG_ID, OTHER_PARENT_ID],
      );
      await insertSubscription(client, { organization_id: OTHER_ORG_ID });
      await insertSubscription(client, { endpoint: `${ENDPOINT}-2` });
      await insertSubscription(client, { organization_id: OTHER_ORG_ID, account_id: OTHER_PARENT_ID, endpoint: `${ENDPOINT}-3` });
      await client.query(
        `insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id)
         values ($1, $2, 'parent', 'family_note', $3), ($4, $2, 'parent', 'family_note', $3)`,
        [OTHER_ORG_ID, PARENT_ID, EVENT_ID, ORG_ID],
      );

      await client.query('delete from pilot.organization_memberships where account_id = $1 and organization_id = $2', [PARENT_ID, OTHER_ORG_ID]);
      let subs = await client.query('select organization_id, account_id from pilot.push_subscriptions order by endpoint');
      expect(subs.rows).toEqual([
        { organization_id: ORG_ID, account_id: PARENT_ID },
        { organization_id: OTHER_ORG_ID, account_id: OTHER_PARENT_ID },
      ]);
      const sends = await client.query('select organization_id from pilot.push_alert_sends');
      expect(sends.rows).toEqual([{ organization_id: ORG_ID }]);

      // The gym itself, with OTHER_PARENT_ID's membership and browser still in it.
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      subs = await client.query('select organization_id from pilot.push_subscriptions');
      expect(subs.rows).toEqual([{ organization_id: ORG_ID }]);
    } finally {
      await client.end();
    }
  });

  test('a checkpoint key of the wrong shape is refused, by its own CHECK', async () => {
    const client = await freshDatabase('webpush_checkpoint');
    try {
      await expect(client.query(
        `insert into pilot.push_alert_checkpoints (event_kind, swept_to) values ('Gym Notice', now())`,
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_push_alert_checkpoint_kind_check' });
    } finally {
      await client.end();
    }
  });
});
