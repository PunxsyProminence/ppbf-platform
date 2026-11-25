// Real PostgreSQL-backed test for stoppedComingPolicy.ts on top of the
// organization-stopped-coming-policy migration (lane W4-6, SC-0a; OW27-30 A).
// './db' is mocked to route into the embedded server (the
// tabletIdlePolicy.pg.test.ts pattern; withTransaction runs a real
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

import { readStoppedComingPolicy, setStoppedComingPolicy } from './stoppedComingPolicy';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-stopped-coming-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-stoppedmod';
const OTHER_ORG_ID = 'org-stoppedmod-elsewhere';
const ADMIN_ID = 'acct-stoppedmod-admin';
const SECOND_ADMIN_ID = 'acct-stoppedmod-second-admin'; // a second gym admin in ORG_ID
const COACH_ID = 'acct-stoppedmod-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

/** The full schema (which carries the migration through the workflow's `all` list), two gyms, two admins and a coach in the first. */
async function freshDatabase(name: string): Promise<Client> {
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
            ($3, 'coach',              $4, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, SECOND_ADMIN_ID, COACH_ID, ORG_ID],
  );
  return client;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'organization_stopped_coming_policy' order by created_at, audit_id`,
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
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

describe('stoppedComingPolicy.ts on a real database', () => {
  test('a gym with no row reads 14 days, marked as the default', async () => {
    activeClient = await freshDatabase('stoppedmod_default');
    try {
      await expect(readStoppedComingPolicy(ORG_ID)).resolves.toEqual({ gap_days: 14, is_default: true });
    } finally {
      await activeClient.end();
    }
  });

  test('the gym admin sets it, a second gym admin changes it, a third save puts the default back; each is audited with the old and new value; the other gym is untouched', async () => {
    const client = await freshDatabase('stoppedmod_set');
    activeClient = client;
    try {
      await expect(setStoppedComingPolicy({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'organization_admin', gapDays: 21,
      })).resolves.toEqual({ gap_days: 21, is_default: false });
      const first = await client.query('select set_at::text as set_at_text from pilot.organization_stopped_coming_policy where organization_id = $1', [ORG_ID]);

      await setStoppedComingPolicy({
        organizationId: ORG_ID, actorAccountId: SECOND_ADMIN_ID, actorRole: 'organization_admin', gapDays: 42,
      });
      await expect(readStoppedComingPolicy(ORG_ID)).resolves.toEqual({ gap_days: 42, is_default: false });
      await expect(readStoppedComingPolicy(OTHER_ORG_ID)).resolves.toEqual({ gap_days: 14, is_default: true });
      const { rows } = await client.query(
        'select organization_id, gap_days, set_by_account_id from pilot.organization_stopped_coming_policy',
      );
      expect(rows).toEqual([{ organization_id: ORG_ID, gap_days: 42, set_by_account_id: SECOND_ADMIN_ID }]);
      // Compared in SQL, at microsecond precision: two fast saves can share a millisecond.
      const moved = await client.query(
        'select set_at > $2::timestamptz as moved from pilot.organization_stopped_coming_policy where organization_id = $1',
        [ORG_ID, first.rows[0].set_at_text],
      );
      expect(moved.rows[0].moved).toBe(true);

      await expect(setStoppedComingPolicy({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'admin', gapDays: null,
      })).resolves.toEqual({ gap_days: 14, is_default: true });
      await expect(readStoppedComingPolicy(ORG_ID)).resolves.toEqual({ gap_days: 14, is_default: true });
      expect((await client.query('select count(*)::int as n from pilot.organization_stopped_coming_policy')).rows[0].n).toBe(0);

      expect(await auditRows(client)).toEqual([
        {
          event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: ORG_ID, details: { gap_days: 21, previous_gap_days: null },
        },
        {
          event_type: 'update', actor_account_id: SECOND_ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID,
          entity_id: ORG_ID, details: { gap_days: 42, previous_gap_days: 21 },
        },
        {
          event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'admin', organization_id: ORG_ID,
          entity_id: ORG_ID, details: { gap_days: null, previous_gap_days: 42 },
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a coach is refused and a number off the list is refused: no row and no audit either way', async () => {
    const client = await freshDatabase('stoppedmod_refused');
    activeClient = client;
    try {
      await expect(setStoppedComingPolicy({
        organizationId: ORG_ID, actorAccountId: COACH_ID, actorRole: 'coach', gapDays: 21,
      })).rejects.toMatchObject({ status: 403 });
      await expect(setStoppedComingPolicy({
        organizationId: ORG_ID, actorAccountId: ADMIN_ID, actorRole: 'organization_admin', gapDays: 30,
      })).rejects.toMatchObject({ status: 400 });

      const { rows } = await client.query('select count(*)::int as n from pilot.organization_stopped_coming_policy');
      expect(rows[0].n).toBe(0);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
