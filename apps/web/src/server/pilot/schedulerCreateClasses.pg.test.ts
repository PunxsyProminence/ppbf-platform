// Real PostgreSQL-backed test: Schedule Class with Repeat weekly (lane LW).
// "All or none", "a repeated submit makes nothing twice" and "two submits
// racing on one key make one set" are properties of the one transaction and
// the insert's ON CONFLICT on the class's primary key, so only a real database
// can say whether they hold.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

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
// Connections handed to the next transactions in turn, so two can run at once.
const transactionClients: Client[] = [];

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  // A real BEGIN/COMMIT, as the other scheduler pg suites do.
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = transactionClients.shift() ?? activeClient;
    if (!client) throw new Error('test bug: no active embedded client');
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

import { ConflictError } from './errors';
import { createSchedulerClasses, type SchedulerClass } from './schedulerDb';

jest.setTimeout(180_000);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-create-classes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG_ID = 'org-create-classes';
const COACH_ID = 'acct-coach-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
const extraClients: Client[] = [];

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  activeClient = client;
  return client;
}

async function secondConnection(name: string): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  extraClients.push(client);
  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(async () => {
  transactionClients.length = 0;
  await Promise.all(extraClients.splice(0).map((client) => client.end().catch(() => {})));
  await activeClient?.end().catch(() => {});
  activeClient = null;
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

/** Four Tuesday classes as the route builds them for one request key. */
function weeklyClasses(prefix: string, overrides: Partial<SchedulerClass> = {}): SchedulerClass[] {
  const now = new Date().toISOString();
  return ['2026-10-27T22:00:00.000Z', '2026-11-03T23:00:00.000Z', '2026-11-10T23:00:00.000Z', '2026-11-17T23:00:00.000Z']
    .map((start, week) => ({
      class_id: `${prefix}-${week}`,
      title: 'Evening boxing',
      start_at: start,
      end_at: new Date(Date.parse(start) + 90 * 60_000).toISOString(),
      location: 'Main Floor',
      capacity: 20,
      scheduled_by_account_id: COACH_ID,
      coach_account_id: COACH_ID,
      status: 'open' as const,
      created_at: now,
      updated_at: now,
      ...overrides,
    }));
}

async function stored(client: Client) {
  const result = await client.query(
    `select class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id,
            coach_account_id, covering_coach_account_id, status
       from pilot.scheduler_classes where organization_id = $1 order by start_at, class_id`,
    [ORG_ID],
  );
  return result.rows.map((row) => ({ ...row, start_at: (row.start_at as Date).toISOString(), end_at: (row.end_at as Date).toISOString() }));
}

describe('createSchedulerClasses (Repeat weekly)', () => {
  test('makes every class in one write: ordinary rows, each as asked', async () => {
    const client = await freshDatabase('lw_create_all');
    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a'))).resolves.toBe('created');

    const rows = await stored(client);
    expect(rows.map((row) => [row.class_id, row.start_at, row.end_at])).toEqual([
      ['a-0', '2026-10-27T22:00:00.000Z', '2026-10-27T23:30:00.000Z'],
      ['a-1', '2026-11-03T23:00:00.000Z', '2026-11-04T00:30:00.000Z'],
      ['a-2', '2026-11-10T23:00:00.000Z', '2026-11-11T00:30:00.000Z'],
      ['a-3', '2026-11-17T23:00:00.000Z', '2026-11-18T00:30:00.000Z'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        title: 'Evening boxing', location: 'Main Floor', capacity: 20,
        scheduled_by_account_id: COACH_ID, coach_account_id: COACH_ID,
        covering_coach_account_id: null, status: 'open',
      });
    }
  });

  test('the same request again adds nothing and says so, even after one class was cancelled', async () => {
    const client = await freshDatabase('lw_create_replay');
    await createSchedulerClasses(ORG_ID, weeklyClasses('a'));
    await client.query(`update pilot.scheduler_classes set status = 'cancelled' where class_id = 'a-2'`);
    const before = await stored(client);

    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a'))).resolves.toBe('already_created');
    expect(await stored(client)).toEqual(before);
  });

  test('a key that made different classes is refused and changes nothing', async () => {
    const client = await freshDatabase('lw_create_key_other');
    await createSchedulerClasses(ORG_ID, weeklyClasses('a'));
    const before = await stored(client);

    const error = await createSchedulerClasses(ORG_ID, weeklyClasses('a', { title: 'Morning boxing' })).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, code: 'CLASS_REQUEST_KEY_REUSED' });
    expect(await stored(client)).toEqual(before);
  });

  test('a key that made only some of these is refused, and the rest are taken back', async () => {
    const client = await freshDatabase('lw_create_key_partial');
    await createSchedulerClasses(ORG_ID, weeklyClasses('a').slice(0, 2));
    const before = await stored(client);

    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a'))).rejects.toBeInstanceOf(ConflictError);
    expect(await stored(client)).toEqual(before);
  });

  test('one class the database refuses means none are made', async () => {
    const client = await freshDatabase('lw_create_none');
    const classes = weeklyClasses('a');
    classes[3] = { ...classes[3], capacity: 0 };

    await expect(createSchedulerClasses(ORG_ID, classes)).rejects.toMatchObject({ code: '23514' });
    expect(await stored(client)).toEqual([]);
  });

  test('two submits racing on one key make one set: one creates, the other finds it', async () => {
    await freshDatabase('lw_create_race');
    const first = await secondConnection('lw_create_race');
    const second = await secondConnection('lw_create_race');
    transactionClients.push(first, second);

    const outcomes = await Promise.all([
      createSchedulerClasses(ORG_ID, weeklyClasses('a')),
      createSchedulerClasses(ORG_ID, weeklyClasses('a')),
    ]);
    expect(outcomes.sort()).toEqual(['already_created', 'created']);
    expect((await stored(activeClient as Client)).map((row) => row.class_id)).toEqual(['a-0', 'a-1', 'a-2', 'a-3']);
  });

  test('one class alone is the one-row case of the same write', async () => {
    const client = await freshDatabase('lw_create_single');
    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('solo').slice(0, 1))).resolves.toBe('created');
    expect((await stored(client)).map((row) => row.class_id)).toEqual(['solo-0']);
  });
});
