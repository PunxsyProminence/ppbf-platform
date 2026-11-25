// Real PostgreSQL-backed test for the organization-email-alert-events
// migration and emailAlertGymEvents.ts on top of it (lane W4-1, EM-5b; the
// migration's own suite is organizationEmailAlertEventsMigration.pg.test.ts;
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

import { EMAIL_ALERT_EVENTS } from '@/src/shared/emailAlerts';

import { isGymEmailAlertEventTicked, readGymEmailAlertEvents, setGymEmailAlertEvent } from './emailAlertGymEvents';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-org-email-alert-events-pg-test-${Date.now()}`);
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

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'organization_email_alert_event' order by audit_id`,
  );
  return rows;
}

const ALL_TICKED = Object.entries(EMAIL_ALERT_EVENTS).flatMap(([userType, kinds]) =>
  kinds.map((eventKind) => ({ user_type: userType, event_kind: eventKind, ticked: true, is_default: true })));

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


describe('emailAlertGymEvents.ts on a real database', () => {
  test('a gym with no choices reads every event on every list ticked, each marked as the starting value', async () => {
    activeClient = await freshDatabase('emailev_default');
    try {
      await expect(readGymEmailAlertEvents(ORG_ID)).resolves.toEqual(ALL_TICKED);
      await expect(isGymEmailAlertEventTicked(ORG_ID, 'staff', 'safety_escalation')).resolves.toBe(true);
    } finally {
      await activeClient.end();
    }
  });

  test('the gym admin unticks, a second admin ticks it back; each change is audited with the old and new value; the other gym is untouched', async () => {
    const client = await freshDatabase('emailev_set');
    activeClient = client;
    try {
      await expect(setGymEmailAlertEvent({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'organization_admin',
        userType: 'parent', eventKind: 'family_note', ticked: false,
      })).resolves.toEqual({ user_type: 'parent', event_kind: 'family_note', ticked: false, is_default: false });
      await expect(isGymEmailAlertEventTicked(ORG_ID, 'parent', 'family_note')).resolves.toBe(false);
      await expect(isGymEmailAlertEventTicked(OTHER_ORG_ID, 'parent', 'family_note')).resolves.toBe(true);
      // The other user types' gym notices are their own choices.
      await expect(isGymEmailAlertEventTicked(ORG_ID, 'parent', 'gym_notice')).resolves.toBe(true);

      await setGymEmailAlertEvent({
        organizationId: ORG_ID, actorAccountId: SECOND_ADMIN_ID, actorRole: 'organization_admin',
        userType: 'parent', eventKind: 'family_note', ticked: true,
      });
      const read = await readGymEmailAlertEvents(ORG_ID);
      expect(read.find((row) => row.user_type === 'parent' && row.event_kind === 'family_note'))
        .toEqual({ user_type: 'parent', event_kind: 'family_note', ticked: true, is_default: false });
      await expect(readGymEmailAlertEvents(OTHER_ORG_ID)).resolves.toEqual(ALL_TICKED);

      expect(await choiceRows(client)).toEqual([{
        organization_id: ORG_ID, user_type: 'parent', event_kind: 'family_note', ticked: true, set_by_account_id: SECOND_ADMIN_ID,
      }]);
      expect(await auditRows(client)).toEqual([
        {
          event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: `${ORG_ID}:parent:family_note`,
          details: { user_type: 'parent', event_kind: 'family_note', ticked: false, previous_ticked: true, previous_was_default: true },
        },
        {
          event_type: 'update', actor_account_id: SECOND_ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: `${ORG_ID}:parent:family_note`,
          details: { user_type: 'parent', event_kind: 'family_note', ticked: true, previous_ticked: false, previous_was_default: false },
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a coach', { actorAccountId: COACH_ID, actorRole: 'coach', userType: 'staff', eventKind: 'gym_notice', ticked: false }, 403],
    ['an event not on that user type\'s list (a family note for staff)',
      { actorAccountId: ADMIN_ID, actorRole: 'organization_admin', userType: 'staff', eventKind: 'family_note', ticked: false }, 400],
    ['an event on no list',
      { actorAccountId: ADMIN_ID, actorRole: 'organization_admin', userType: 'staff', eventKind: 'everything', ticked: false }, 400],
    ['a user type with no list (the role staff\'s name is not a user type here)',
      { actorAccountId: ADMIN_ID, actorRole: 'organization_admin', userType: 'volunteer', eventKind: 'gym_notice', ticked: false }, 400],
    ['ticked that is not a boolean',
      { actorAccountId: ADMIN_ID, actorRole: 'organization_admin', userType: 'staff', eventKind: 'gym_notice', ticked: 'false' }, 400],
  ] as const)('refuses %s: no row and no audit', async (_label, input, status) => {
    const client = await freshDatabase('emailev_refused');
    activeClient = client;
    try {
      await expect(setGymEmailAlertEvent({ organizationId: ORG_ID, ...input })).rejects.toMatchObject({ status });
      expect(await choiceRows(client)).toEqual([]);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a stored choice for an event not on the list is never read as ticked and never shown', async () => {
    const client = await freshDatabase('emailev_offlist');
    activeClient = client;
    try {
      // As if an event had been removed from the list after a gym ticked it.
      await client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked)
         values ($1, 'parent', 'coach_message', true), ($1, 'staff', 'retired_event', true)`,
        [ORG_ID],
      );
      await expect(isGymEmailAlertEventTicked(ORG_ID, 'parent', 'coach_message')).resolves.toBe(false);
      await expect(isGymEmailAlertEventTicked(ORG_ID, 'staff', 'retired_event')).resolves.toBe(false);
      await expect(readGymEmailAlertEvents(ORG_ID)).resolves.toEqual(ALL_TICKED);
    } finally {
      await client.end();
    }
  });
});
