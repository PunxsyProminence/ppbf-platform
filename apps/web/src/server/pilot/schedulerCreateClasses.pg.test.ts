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

import { ConflictError, PilotError, ValidationError } from './errors';
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
// The plan a class runs (lane W4-5, SP-3): two plans of this gym, one of another gym's.
const OTHER_ORG_ID = 'org-create-classes-other';
const PLAN_ID = 'plan-create-classes-1';
const SECOND_PLAN_ID = 'plan-create-classes-2';
const OTHER_PLAN_ID = 'plan-create-classes-other';

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

/** Two plans of this gym and one of another gym's, each authored by a coach of its own gym. */
async function seedPlans(client: Client) {
  for (const [org, author] of [[ORG_ID, 'acct-plan-author'], [OTHER_ORG_ID, 'acct-plan-author-other']] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [author, org]);
    // A plan's discipline (default 'boxing') must be one of its gym's (pilot_session_scripts_discipline_fk).
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [org],
    );
  }
  for (const [org, plan, author] of [
    [ORG_ID, PLAN_ID, 'acct-plan-author'],
    [ORG_ID, SECOND_PLAN_ID, 'acct-plan-author'],
    [OTHER_ORG_ID, OTHER_PLAN_ID, 'acct-plan-author-other'],
  ] as const) {
    await client.query(
      `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, $2, $2, 1, 'Evening plan', $3)`,
      [org, plan, author],
    );
  }
}

async function storedPlans(client: Client) {
  const result = await client.query(
    `select class_id, script_id from pilot.scheduler_classes where organization_id = $1 order by start_at, class_id`,
    [ORG_ID],
  );
  return result.rows.map((row) => [row.class_id, row.script_id]);
}

describe('createSchedulerClasses names the plan the classes run (lane W4-5, SP-3)', () => {
  test('a plan of the gym is stored on every class of a weekly repeat', async () => {
    const client = await freshDatabase('w45_plan_weekly');
    await seedPlans(client);
    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: PLAN_ID }))).resolves.toBe('created');
    expect(await storedPlans(client)).toEqual([['a-0', PLAN_ID], ['a-1', PLAN_ID], ['a-2', PLAN_ID], ['a-3', PLAN_ID]]);
  });

  test.each([
    ['another gym\'s plan', OTHER_PLAN_ID],
    ['an id that names no plan', 'plan-nobody-made'],
  ])('%s is refused with CLASS_PLAN_NOT_FOUND (400), and nothing is written', async (_label, plan) => {
    const client = await freshDatabase('w45_plan_refused');
    await seedPlans(client);
    const error = await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: plan })).catch((caught) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      status: 400,
      code: 'CLASS_PLAN_NOT_FOUND',
      message: 'script_id must name a session plan of this gym',
    });
    expect(await stored(client)).toEqual([]);
  });

  test('the same key with the same plan again adds nothing and says so', async () => {
    const client = await freshDatabase('w45_plan_replay');
    await seedPlans(client);
    await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: PLAN_ID }));
    const before = await storedPlans(client);

    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: PLAN_ID }))).resolves.toBe('already_created');
    expect(await storedPlans(client)).toEqual(before);
  });

  test.each<[string, string | null, string | null]>([
    ['made with a plan, sent again with another', PLAN_ID, SECOND_PLAN_ID],
    ['made with a plan, sent again with none', PLAN_ID, null],
    ['made with no plan, sent again with one', null, PLAN_ID],
  ])('the same key %s is CLASS_REQUEST_KEY_REUSED and changes nothing', async (_label, first, again) => {
    const client = await freshDatabase('w45_plan_key_other');
    await seedPlans(client);
    await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: first }));
    const before = await storedPlans(client);

    const error = await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: again })).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, code: 'CLASS_REQUEST_KEY_REUSED' });
    expect(await storedPlans(client)).toEqual(before);
  });

  test('a create with no plan stores none, as before', async () => {
    const client = await freshDatabase('w45_plan_none');
    await seedPlans(client);
    await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a'))).resolves.toBe('created');
    expect(await storedPlans(client)).toEqual([['a-0', null], ['a-1', null], ['a-2', null], ['a-3', null]]);
  });

  test('a plan delete in progress makes the create wait, then refuses it in words, not with a database error', async () => {
    // The plan check reads the row FOR KEY SHARE (schedulerDb.ts): it waits for a delete already
    // holding the row and then finds no plan. Read without that lock, the check sees the row the
    // delete has not yet committed, and the insert's foreign key fails with 23503, an opaque 500
    // (reviewer K on #2238, OBSERVED with the lock removed).
    const client = await freshDatabase('w45_plan_delete_race');
    await seedPlans(client);
    const deleter = await secondConnection('w45_plan_delete_race');
    const creator = await secondConnection('w45_plan_delete_race');
    const creatorPid = (await creator.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    transactionClients.push(creator);

    await deleter.query('BEGIN');
    await deleter.query(`delete from pilot.session_scripts where organization_id = $1 and script_id = $2`, [ORG_ID, PLAN_ID]);
    const outcome = createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: PLAN_ID })).catch((caught) => caught);
    // Commit only once the create is waiting on the delete's row lock, so the order is the race's.
    for (let tries = 0; ; tries += 1) {
      const waiting = await client.query(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [creatorPid]);
      if (waiting.rows.length > 0) break;
      if (tries > 200) throw new Error('test bug: the create never waited on the delete');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await deleter.query('COMMIT');

    const error = await outcome;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: 'CLASS_PLAN_NOT_FOUND' });
    expect(await stored(client)).toEqual([]);
  });

  describe('a retired plan is not scheduled (App Overwatch on #2238, 7211257563: "A, refuse it")', () => {
    const LINEAGE = 'plan-create-classes-lineage';
    const V1 = 'plan-create-classes-lineage-v1';
    const V2 = 'plan-create-classes-lineage-v2';

    /** A plan of this gym in two versions: v1 and v2 (the newest), in the states given. */
    async function twoVersions(client: Client, v1State: string, v2State: string) {
      for (const [script, version, state] of [[V1, 1, v1State], [V2, 2, v2State]] as const) {
        await client.query(
          `insert into pilot.session_scripts
             (organization_id, script_id, lineage_id, version, name, authoring_state, created_by_account_id)
           values ($1, $2, $3, $4, 'Evening plan', $5, 'acct-plan-author')`,
          [ORG_ID, script, LINEAGE, version, state],
        );
      }
    }

    async function refusedAsRetired(plan: string) {
      const error = await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: plan })).catch((caught) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        status: 400,
        code: 'CLASS_PLAN_RETIRED',
        message: 'This plan is retired. Bring it back on Session Plans to schedule a class with it.',
      });
    }

    test('a retired plan is refused with CLASS_PLAN_RETIRED (400), and nothing is written', async () => {
      const client = await freshDatabase('w45_plan_retired');
      await seedPlans(client);
      await client.query(`update pilot.session_scripts set authoring_state = 'retired' where script_id = $1`, [PLAN_ID]);
      await refusedAsRetired(PLAN_ID);
      expect(await stored(client)).toEqual([]);
    });

    test('an older version is refused when the newest version is retired', async () => {
      const client = await freshDatabase('w45_plan_retired_head');
      await seedPlans(client);
      await twoVersions(client, 'in_use', 'retired');
      await refusedAsRetired(V1);
      expect(await stored(client)).toEqual([]);
    });

    test('the newest version decides: an older version once retired is scheduled when the plan was brought back', async () => {
      // A retire writes the current version; bringing the plan back writes the version current then,
      // so an older version can still read retired (setSessionScriptRetired, sessionScriptAuthoring.ts).
      const client = await freshDatabase('w45_plan_back');
      await seedPlans(client);
      await twoVersions(client, 'retired', 'in_use');
      await expect(createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: V1 }))).resolves.toBe('created');
      expect((await storedPlans(client)).map(([, plan]) => plan)).toEqual([V1, V1, V1, V1]);
    });

    test('a class already scheduled keeps its plan when the plan is retired afterwards', async () => {
      const client = await freshDatabase('w45_plan_retired_later');
      await seedPlans(client);
      await createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: PLAN_ID }));
      await client.query(`update pilot.session_scripts set authoring_state = 'retired' where script_id = $1`, [PLAN_ID]);
      expect((await storedPlans(client)).map(([, plan]) => plan)).toEqual([PLAN_ID, PLAN_ID, PLAN_ID, PLAN_ID]);
    });

    // A retire holds the newest version FOR UPDATE (lockCurrentScript) while it writes; the create's
    // FOR KEY SHARE read of that row waits, and then sees the plan retired. Linking the newest version
    // itself, the first read already waits; linking an older one, only the newest-version read does.
    test.each([
      ['the newest version linked', 'w45_plan_retire_race_head', PLAN_ID, PLAN_ID],
      ['an older version linked', 'w45_plan_retire_race_older', V1, V2],
    ])('a retire in progress makes the create wait, then refuses it (%s)', async (_label, database, linked, retired) => {
      const client = await freshDatabase(database);
      await seedPlans(client);
      await twoVersions(client, 'in_use', 'in_use');
      const retirer = await secondConnection(database);
      const creator = await secondConnection(database);
      const creatorPid = (await creator.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
      transactionClients.push(creator);

      await retirer.query('BEGIN');
      await retirer.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [ORG_ID, retired]);
      await retirer.query(`update pilot.session_scripts set authoring_state = 'retired' where organization_id = $1 and script_id = $2`, [ORG_ID, retired]);
      const outcome = createSchedulerClasses(ORG_ID, weeklyClasses('a', { script_id: linked })).catch((caught) => caught);
      for (let tries = 0; ; tries += 1) {
        const waiting = await client.query(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [creatorPid]);
        if (waiting.rows.length > 0) break;
        if (tries > 200) throw new Error('test bug: the create never waited on the retire');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await retirer.query('COMMIT');

      const error = await outcome;
      expect(error).toMatchObject({ status: 400, code: 'CLASS_PLAN_RETIRED' });
      expect(await stored(client)).toEqual([]);
    });
  });

  test('classes of one create naming different plans are a programming error, and nothing is written', async () => {
    const client = await freshDatabase('w45_plan_mixed');
    await seedPlans(client);
    const classes = weeklyClasses('a', { script_id: PLAN_ID });
    classes[2] = { ...classes[2], script_id: SECOND_PLAN_ID };

    const error = await createSchedulerClasses(ORG_ID, classes).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    // A plain Error: jsonError answers it as an opaque 500, not as the caller's fault.
    expect(error).not.toBeInstanceOf(PilotError);
    expect((error as Error).message).toBe('createSchedulerClasses: every class of one create must name the same plan');
    expect(await stored(client)).toEqual([]);
  });
});
