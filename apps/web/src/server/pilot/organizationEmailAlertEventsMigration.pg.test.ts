// Real PostgreSQL-backed test for the organization-email-alert-events
// migration (lane W4-1, EM-5a; the store, EM-5b, has its own suite;
// OW27-10 A: the gym's organization admin chooses, per user type, which events
// send the email alert; OW27-39 A: every event starts ticked). './db' is mocked
// to route into the embedded server (the tabletIdlePolicy.pg.test.ts pattern;
// withTransaction runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL
// and audit.ts's run against real rows. The runner is driven through its real
// entrypoint, so its readiness check runs against a real Postgres here.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-org-email-alert-events-migration-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_organization_email_alert_events_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-organization-email-alert-events-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-emailev';
const OTHER_ORG_ID = 'org-emailev-elsewhere';
const ADMIN_ID = 'acct-emailev-admin';
const SECOND_ADMIN_ID = 'acct-emailev-second-admin';
const COACH_ID = 'acct-emailev-coach';

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

/** The full schema, two gyms, two gym admins and a coach in the first. */
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
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'organization_admin', $4, 'microsoft', null, null),
            ($2, 'organization_admin', $4, 'microsoft', null, null),
            ($3, 'coach',              $4, 'magic_link', null, null)
     on conflict do nothing`,
    [ADMIN_ID, SECOND_ADMIN_ID, COACH_ID, ORG_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.organization_email_alert_events cascade');
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

async function choiceRows(client: Client) {
  const { rows } = await client.query(
    `select organization_id, user_type, event_kind, ticked, set_by_account_id
       from pilot.organization_email_alert_events order by organization_id, user_type, event_kind`,
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


describe('organization email alert events migration', () => {
  test('creates the table from nothing, passes the runner readiness check, and a re-apply keeps the row', async () => {
    const client = await freshDatabase('emailev_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.organization_email_alert_events') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked, set_by_account_id)
         values ($1, 'parent', 'family_note', false, $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await applyMigrationTransaction(client, migrationSql);
      expect(await choiceRows(client)).toEqual([{
        organization_id: ORG_ID, user_type: 'parent', event_kind: 'family_note', ticked: false, set_by_account_id: ADMIN_ID,
      }]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a key of any shape', 'alter table pilot.organization_email_alert_events drop constraint pilot_org_email_alert_event_kind_check'],
    [
      'a user type off the list',
      `alter table pilot.organization_email_alert_events
         drop constraint pilot_org_email_alert_event_user_type_check,
         add constraint pilot_org_email_alert_event_user_type_check check (user_type in ('staff', 'parent', 'adult_athlete', 'volunteer'))`,
    ],
    ['an extra CHECK', 'alter table pilot.organization_email_alert_events add constraint pilot_org_email_alert_extra check (ticked)'],
    ['a default on ticked', 'alter table pilot.organization_email_alert_events alter column ticked set default false'],
    [
      'a gym key that no longer cascades',
      `alter table pilot.organization_email_alert_events
         drop constraint organization_email_alert_events_organization_id_fkey,
         add constraint organization_email_alert_events_organization_id_fkey
           foreign key (organization_id) references pilot.organizations(organization_id)`,
    ],
    [
      'a setter key that deletes the choice with the admin',
      `alter table pilot.organization_email_alert_events
         drop constraint organization_email_alert_events_set_by_account_id_fkey,
         add constraint organization_email_alert_events_set_by_account_id_fkey
           foreign key (set_by_account_id) references pilot.accounts(account_id) on delete cascade`,
    ],
    [
      'the primary key in another order',
      `alter table pilot.organization_email_alert_events
         drop constraint organization_email_alert_events_pkey,
         add primary key (user_type, organization_id, event_kind)`,
    ],
  ])('the readiness check refuses %s', async (_label, drift) => {
    const client = await freshDatabase('emailev_drift');
    try {
      await client.query(drift);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('ORGANIZATION_EMAIL_ALERT_EVENTS_TABLE_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a user type off the list', 'volunteer', 'gym_notice', 'pilot_org_email_alert_event_user_type_check'],
    ['an event key with capitals', 'staff', 'Gym_Notice', 'pilot_org_email_alert_event_kind_check'],
    ['an event key with a space', 'staff', 'gym notice', 'pilot_org_email_alert_event_kind_check'],
    ['an empty event key', 'staff', '', 'pilot_org_email_alert_event_kind_check'],
  ])('the database refuses %s, by its own CHECK', async (_label, userType, eventKind, constraint) => {
    const client = await freshDatabase('emailev_check');
    try {
      await expect(client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked)
         values ($1, $2, $3, true)`,
        [ORG_ID, userType, eventKind],
      )).rejects.toMatchObject({ code: '23514', constraint });
      expect(await choiceRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a deleted gym takes its choices with it; a deleted admin leaves them and clears who set them', async () => {
    const client = await freshDatabase('emailev_cascade');
    try {
      await client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked, set_by_account_id)
         values ($1, 'parent', 'family_note', false, null), ($2, 'staff', 'gym_notice', false, $3)`,
        [OTHER_ORG_ID, ORG_ID, SECOND_ADMIN_ID],
      );
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      await client.query('delete from pilot.accounts where account_id = $1', [SECOND_ADMIN_ID]);
      expect(await choiceRows(client)).toEqual([{
        organization_id: ORG_ID, user_type: 'staff', event_kind: 'gym_notice', ticked: false, set_by_account_id: null,
      }]);
    } finally {
      await client.end();
    }
  });
});
