// Real PostgreSQL-backed contract test for the second email alert sweep
// indexes migration (lane W4-1, EM-IX-2), adapted from EM-IX's
// (emailAlertSweepIndexes.pg.test.ts).
//
// What needs proving that reading SQL cannot prove: on the schema production
// runs, neither pilot.family_thread_posts nor pilot.coach_observations has an
// index that starts with created_at before this migration; the migration adds
// exactly one b-tree on (created_at) to each and nothing else to the pilot
// catalog, and a re-apply is a no-op; the SQL names a missing table, either
// one; the runner's readiness check refuses a database where either index is
// absent or is not the index promised (and rolls back what it built), and
// accepts one where both are; the runner refuses a host or database the
// operator did not name; behind a long write on the family thread posts it
// gives up at its lock timeout while coach notes go on being written; and
// the planner can serve the sweep's window read (`created_at > $1 and
// created_at <= $2`) from each index, returning the same rows as a plain scan.
//
// Family thread posts are written as the app writes them, through the table's
// guard trigger: a guardian of this child (pilot.parents and
// pilot.guardian_links) on a live account. The trigger sets created_at to
// clock_timestamp(), so the posts' window is taken between two batches of
// inserts rather than written into the rows.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-sweep-indexes-2-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_email_alert_sweep_indexes_2_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-email-alert-sweep-indexes-2-migration.mjs',
);

const POSTS_INDEX = 'idx_pilot_family_thread_posts_created_at';
const NOTES_INDEX = 'idx_pilot_coach_observations_created_at';
const TABLES = [
  { index: POSTS_INDEX, table: 'family_thread_posts' },
  { index: NOTES_INDEX, table: 'coach_observations' },
] as const;

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as auditEventsEntityIndex.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-sweep2';
const COACH_ID = 'acct-sweep2-coach';
const GUARDIAN_ID = 'acct-sweep2-guardian';
const GUARDIAN_RECORD_ID = 'parent-sweep2-guardian';
const ATHLETE_ID = 'ath-sweep2';
const TEMPLATE_DB = 'sweep_indexes_2_template';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let runMigration: () => Promise<void>;

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

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/**
 * The schema production runs, as it stands BEFORE this migration: the base
 * schema and every migration ahead of this one in the deploy order (see
 * beforeAll), plus one gym, coach, guardian and child for the event rows to
 * hang from.
 */
async function freshDatabase(name: string): Promise<Client> {
  await adminQuery(`drop database if exists ${name}`);
  await adminQuery(`create database ${name} template ${TEMPLATE_DB}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function bareDatabase(name: string): Promise<Client> {
  await adminQuery(`drop database if exists ${name}`);
  await adminQuery(`create database ${name}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The key columns of a valid index of this name, in index order, or null if there is none. */
async function indexColumns(client: Client, indexName: string): Promise<string[] | null> {
  const result = await client.query<{ attname: string }>(
    `select a.attname
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     join unnest(i.indkey) with ordinality as k(attnum, ord) on true
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where n.nspname = 'pilot' and c.relname = $1 and i.indisvalid
     order by k.ord`,
    [indexName],
  );
  return result.rows.length === 0 ? null : result.rows.map((row) => row.attname);
}

/** The first key column of every index on a pilot table. */
async function leadingColumns(client: Client, table: string): Promise<string[]> {
  const result = await client.query<{ attname: string }>(
    `select a.attname
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where i.indrelid = to_regclass($1)`,
    [`pilot.${table}`],
  );
  return result.rows.map((row) => row.attname);
}

/**
 * Every column, constraint and index the pilot schema holds, as comparable
 * strings: the snapshot of migrationReadinessGates.pg.test.ts (CATALOG_SNAPSHOT).
 */
const CATALOG_SNAPSHOT = `
  select 'COLUMN ' || table_name || '.' || column_name || ' ' || data_type
         || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-') as item
  from information_schema.columns
  where table_schema = 'pilot'
  union all
  select 'CONSTRAINT ' || conrelid::regclass::text || ' ' || conname
         || ' :: ' || pg_get_constraintdef(oid)
  from pg_constraint
  where connamespace = 'pilot'::regnamespace
  union all
  select 'INDEX ' || indexname || ' :: ' || indexdef
  from pg_indexes
  where schemaname = 'pilot'
  order by 1
`;

async function catalogOf(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ item: string }>(CATALOG_SNAPSHOT);
  return rows.map((row) => row.item);
}

/** Whether any relation of this name exists in pilot, valid or not. */
async function relationExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query<{ found: string | null }>('select to_regclass($1)::text as found', [`pilot.${name}`]);
  return rows[0].found !== null;
}

/** Every node of an EXPLAIN (format json) plan tree, flattened. */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [plan];
  for (const child of (plan.Plans as Record<string, unknown>[] | undefined) ?? []) {
    out.push(...planNodes(child));
  }
  return out;
}

/** The index names a query's plan reads, with sequential scans switched off. */
async function indexesUsed(client: Client, sql: string, params: unknown[]): Promise<string[]> {
  // The test tables hold a few hundred rows, where a sequential scan is the
  // cheaper plan; switching it off asks the planner "COULD an index serve the
  // query", which is the property that matters at production size. Skip scans
  // and bitmap scans still count: the question is which index is read.
  await client.query('set enable_seqscan = off');
  try {
    const result = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
      `explain (format json) ${sql}`,
      params,
    );
    return planNodes(result.rows[0]['QUERY PLAN'][0].Plan)
      .map((node) => node['Index Name'])
      .filter((name): name is string => typeof name === 'string');
  } finally {
    await client.query('reset enable_seqscan');
  }
}

/** A guardian opening `count` threads about the child, through the posts' guard trigger. */
async function guardianPosts(client: Client, count: number): Promise<void> {
  await client.query(
    `insert into pilot.family_thread_posts
       (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
     select $1, s.id, s.id, $2, $3, 'parent', 'Is practice on Saturday?'
     from (select gen_random_uuid() as id from generate_series(1, $4::int)) as s`,
    [ORG_ID, ATHLETE_ID, GUARDIAN_ID, count],
  );
}

/**
 * A window as the database's own text, not a JS Date: a Date keeps
 * milliseconds, and the posts' times are microseconds apart.
 */
interface EventWindow {
  from: string;
  to: string;
}

/**
 * Rows of both event tables, so the statistics are real, and the window on
 * each that holds exactly five of them. Coach notes are spread over two days
 * (no trigger on that table touches created_at); the posts' times are the
 * trigger's clock_timestamp(), so their window is the moment between two
 * batches up to the moment after the second.
 */
async function seedEvents(client: Client): Promise<{ notes: EventWindow; posts: EventWindow }> {
  await client.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at)
     select $1, gen_random_uuid(), $2, $3, 'coach',
            case when g % 2 = 0 then 'athlete_message' else 'parent_message' end,
            'Bring gloves Thursday.', now() - make_interval(mins => g * 7)
     from generate_series(1, 400) as g`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  // The sweep's window (emailAlertEvents.ts, inWindow): rows created after
  // the checkpoint less ten minutes, up to now. It holds notes 1-5 (7, 14,
  // ... 35 minutes old).
  const notes = (
    await client.query<EventWindow>(`select (now() - interval '40 minutes')::text as "from", now()::text as "to"`)
  ).rows[0];

  await guardianPosts(client, 395);
  const from = (await client.query<{ at: string }>('select clock_timestamp()::text as at')).rows[0].at;
  await guardianPosts(client, 5);
  const to = (await client.query<{ at: string }>('select clock_timestamp()::text as at')).rows[0].at;

  await client.query('analyze pilot.coach_observations');
  await client.query('analyze pilot.family_thread_posts');
  return { notes, posts: { from, to } };
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
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  runMigration = runnerModule.run as () => Promise<void>;
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const listMigrationFiles = fullSchema.listMigrationFiles as (infraDir?: string) => Promise<string[]>;
  const baseSchemaFile = fullSchema.BASE_SCHEMA_FILE as string;
  const inOrder = await listMigrationFiles(INFRA_DIR);
  if (!inOrder.includes(MIGRATION_FILE)) throw new Error(`${MIGRATION_FILE} is not in the deploy order`);

  // Built once and cloned per test: the schema takes a while to apply.
  await adminQuery(`drop database if exists ${TEMPLATE_DB}`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    // BEFORE this migration: the base schema, then every migration ahead of
    // this one in the workflow's order, each in its own transaction (as
    // applyFullSchema does; as schedulerClassPlanMigration.pg.test.ts builds
    // its BEFORE). This file is left out, so nothing it does is already in the
    // starting state that the catalog comparison below reads.
    await template.query(await fs.readFile(path.join(INFRA_DIR, baseSchemaFile), 'utf8'));
    for (const file of inOrder.slice(0, inOrder.indexOf(MIGRATION_FILE))) {
      await template.query('BEGIN');
      await template.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
      await template.query('COMMIT');
    }
    await template.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [ORG_ID],
    );
    for (const [account, role] of [[COACH_ID, 'coach'], [GUARDIAN_ID, 'parent']]) {
      await template.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
        [account, role, ORG_ID],
      );
      await template.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
        [account, ORG_ID, role],
      );
    }
    await template.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Sweep Child', '2014-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, ATHLETE_ID, COACH_ID],
    );
    // The guardian of this child, as the posts' guard trigger asks for it.
    await template.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Sweep Guardian')`,
      [ORG_ID, GUARDIAN_RECORD_ID, GUARDIAN_ID],
    );
    await template.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'guardian')`,
      [ORG_ID, GUARDIAN_RECORD_ID, ATHLETE_ID],
    );
  } finally {
    await template.end();
  }
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

describe('email alert sweep indexes 2 migration', () => {
  test('before it, no index on either table starts with created_at; the SQL adds exactly one (created_at) b-tree to each', async () => {
    const client = await freshDatabase('sweep2_index_create');
    try {
      for (const { index, table } of TABLES) {
        expect(await indexColumns(client, index)).toBeNull();
        // Not a duplicate of an index already there.
        expect(await leadingColumns(client, table)).not.toContain('created_at');
      }

      const before = await catalogOf(client);
      await client.query(migrationSql);
      const after = await catalogOf(client);

      // The two indexes and nothing else: no column, constraint or other
      // index added, and nothing dropped or changed.
      expect({
        added: after.filter((item) => !before.includes(item)).sort(),
        removed: before.filter((item) => !after.includes(item)).sort(),
        growth: after.length - before.length,
      }).toEqual({
        added: [
          `INDEX ${NOTES_INDEX} :: CREATE INDEX ${NOTES_INDEX} ON pilot.coach_observations USING btree (created_at)`,
          `INDEX ${POSTS_INDEX} :: CREATE INDEX ${POSTS_INDEX} ON pilot.family_thread_posts USING btree (created_at)`,
        ],
        removed: [],
        growth: 2,
      });

      for (const { index, table } of TABLES) {
        expect({ index, columns: await indexColumns(client, index) }).toEqual({ index, columns: ['created_at'] });
        const shape = await client.query<{ table_name: string; partial: boolean; unique: boolean; method: string }>(
          `select i.indrelid::regclass::text as table_name, i.indpred is not null as partial, i.indisunique as unique,
                  am.amname as method
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
           join pg_am am on am.oid = c.relam
           where c.relname = $1`,
          [index],
        );
        expect(shape.rows).toEqual([{ table_name: `pilot.${table}`, partial: false, unique: false, method: 'btree' }]);
      }
    } finally {
      await client.end();
    }
  });

  test('a re-apply is a no-op: still one index of each name, same column', async () => {
    const client = await freshDatabase('sweep2_index_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      for (const { index } of TABLES) {
        const count = await client.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes where schemaname = 'pilot' and indexname = $1`,
          [index],
        );
        expect({ index, n: count.rows[0].n }).toEqual({ index, n: '1' });
        expect(await indexColumns(client, index)).toEqual(['created_at']);
      }
    } finally {
      await client.end();
    }
  });

  test('the SQL refuses a database without either table, naming the one missing', async () => {
    const empty = await bareDatabase('sweep2_index_bare');
    try {
      await expect(empty.query(migrationSql)).rejects.toThrow(
        /EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY: pilot\.coach_observations does not exist/,
      );
    } finally {
      await empty.end();
    }
    // pilot.family_thread_posts comes from a later migration than the base.
    const baseOnly = await bareDatabase('sweep2_index_base_only');
    try {
      await baseOnly.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
      await expect(baseOnly.query(migrationSql)).rejects.toThrow(
        /EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY: pilot\.family_thread_posts does not exist/,
      );
      // Nothing was built on the table that does exist.
      expect(await indexColumns(baseOnly, NOTES_INDEX)).toBeNull();
    } finally {
      await baseOnly.end();
    }
  });

  test.each([
    ['family_thread_posts', 'coach_observations', NOTES_INDEX],
    ['coach_observations', 'family_thread_posts', POSTS_INDEX],
  ])('the SQL refuses a database where pilot.%s is gone, naming it, and builds nothing on pilot.%s', async (gone, _kept, keptIndex) => {
    const client = await freshDatabase('sweep2_index_table_gone');
    try {
      await client.query(`drop table pilot.${gone} cascade`);
      await expect(client.query(migrationSql)).rejects.toThrow(
        new RegExp(`EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY: pilot\\.${gone} does not exist`),
      );
      expect(await indexColumns(client, keptIndex)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the indexes are absent, and rolls back', async () => {
    const client = await freshDatabase('sweep2_index_runner_refuses');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY');
      // Not left inside a transaction.
      const probe = await client.query<{ ok: number }>('select 1 as ok');
      expect(probe.rows[0].ok).toBe(1);
      for (const { index } of TABLES) expect(await indexColumns(client, index)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a database where the migration applied, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('sweep2_index_runner_accepts');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      for (const { index } of TABLES) expect(await indexColumns(client, index)).toEqual(['created_at']);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['database', 'localhost', 'some_other_database'],
    ['host', 'some-other-host.example', 'sweep2_index_target'],
  ])('the real runner refuses a %s the operator did not name, and builds nothing there', async (_label, host, database) => {
    // The target check: the operator states the host and database they believe
    // they are pointing at, and a mismatch refuses before any DDL. Plaintext is
    // allowed here, so without the check the runner would reach this database.
    const client = await freshDatabase('sweep2_index_target');
    const saved = { ...process.env };
    try {
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('sweep2_index_target');
      process.env.PPBF_EXPECTED_POSTGRES_HOSTNAME = host;
      process.env.PPBF_EXPECTED_POSTGRES_DATABASE = database;
      await expect(runMigration()).rejects.toThrow('POSTGRES_TARGET_MISMATCH');
      for (const { index } of TABLES) expect(await relationExists(client, index)).toBe(false);
    } finally {
      process.env = saved;
      await client.end();
    }
  });

  test('the runner requires a verified TLS certificate everywhere but the opted-out test run', async () => {
    // Read from the source: embedded Postgres serves no TLS, so this cannot be
    // exercised here. The only plaintext path is NODE_ENV=test with the opt-in.
    const source = await fs.readFile(MIGRATION_RUNNER_PATH, 'utf8');
    expect(/function resolveSslConfig\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]).toBe([
      'function resolveSslConfig() {',
      "  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {",
      '    return false;',
      '  }',
      '  return { rejectUnauthorized: true };',
      '}',
    ].join('\n'));
    expect(source.match(/rejectUnauthorized/g)).toHaveLength(1);
    expect(source).toContain('ssl: resolveSslConfig(),');
  });

  test.each([
    ['only the family thread posts index', `create index ${POSTS_INDEX} on pilot.family_thread_posts (created_at)`],
    ['only the coach notes index', `create index ${NOTES_INDEX} on pilot.coach_observations (created_at)`],
  ])('the runner refuses a database with %s', async (_label, onlyOne) => {
    const client = await freshDatabase('sweep2_index_only_one');
    try {
      await client.query(onlyOne);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['on the wrong columns', `create index ${POSTS_INDEX} on pilot.family_thread_posts (organization_id, created_at)`],
    // One key column, so indnatts = 1 passes it: only the created_at name check can refuse it.
    ['on one other column', `create index ${POSTS_INDEX} on pilot.family_thread_posts (organization_id)`],
    ['partial', `create index ${POSTS_INDEX} on pilot.family_thread_posts (created_at) where author_role = 'parent'`],
    ['unique', `create unique index ${POSTS_INDEX} on pilot.family_thread_posts (created_at)`],
    ['not a b-tree', `create index ${POSTS_INDEX} on pilot.family_thread_posts using hash (created_at)`],
    ['on the wrong table', `create index ${POSTS_INDEX} on pilot.coach_observations (created_at)`],
    ['keyed on created_at and an expression', `create index ${POSTS_INDEX} on pilot.family_thread_posts (created_at, lower(post_text))`],
    ['keyed on created_at with an INCLUDE column', `create index ${POSTS_INDEX} on pilot.family_thread_posts (created_at) include (thread_id)`],
    ['led by an expression', `create index ${POSTS_INDEX} on pilot.family_thread_posts (lower(post_text), created_at)`],
    ['an exclusion constraint\'s index', `alter table pilot.family_thread_posts add constraint ${POSTS_INDEX} exclude using btree (created_at with =)`],
    ['a BRIN index', `create index ${POSTS_INDEX} on pilot.family_thread_posts using brin (created_at)`],
  ])('the runner refuses an index of the right name that is %s', async (_label, wrong) => {
    const client = await freshDatabase('sweep2_index_wrong');
    try {
      await client.query(wrong);
      // `if not exists` sees the name and leaves the wrong index in place;
      // the readiness check must notice and refuse.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY');
      // And roll back: the coach notes index the SQL built in the same
      // transaction is gone too.
      expect(await relationExists(client, NOTES_INDEX)).toBe(false);
    } finally {
      await client.end();
    }
  });

  test.each([
    // As a CREATE INDEX CONCURRENTLY that failed would leave it.
    ['not valid', 'indisvalid'],
    // Valid but not ready: new writes do not go into it, so a read through it misses them.
    ['not ready', 'indisready'],
    ['not live', 'indislive'],
  ])('the runner refuses an index of the right name that is %s', async (_label, flag) => {
    const client = await freshDatabase('sweep2_index_flag');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The test server's superuser sets the catalog flag directly.
      await client.query(
        `update pg_index set ${flag} = false where indexrelid = to_regclass('pilot.${POSTS_INDEX}')`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('behind a long write on the family thread posts the runner gives up after its lock timeout, holding nothing on the coach notes while it waits', async () => {
    const client = await freshDatabase('sweep2_index_lock_timeout');
    const writer = new Client({ connectionString: connectionStringFor('sweep2_index_lock_timeout') });
    const noteWriter = new Client({ connectionString: connectionStringFor('sweep2_index_lock_timeout') });
    await writer.connect();
    await noteWriter.connect();
    try {
      // A guardian's post being written in a transaction that stays open.
      await writer.query('begin');
      await writer.query('lock table pilot.family_thread_posts in row exclusive mode');

      const started = Date.now();
      const apply = applyMigrationTransaction(client, migrationSql).then(
        () => 'applied',
        (error: { code?: string; message?: string }) => error.code ?? error.message,
      );
      // While the runner waits on the posts table, a new coach note is still
      // written at once: the posts index is built first, so nothing is held
      // on pilot.coach_observations yet.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await noteWriter.query("set statement_timeout = '3s'");
      await noteWriter.query(
        `insert into pilot.coach_observations
           (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
         values ($1, gen_random_uuid(), $2, $3, 'coach', 'athlete_message', 'Good work tonight.')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );

      // 55P03 lock_not_available: lock_timeout, about 10 seconds, not the
      // writer's whole transaction.
      expect(await apply).toBe('55P03');
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      // Under 15 s: the 10 s timeout, not a longer one.
      expect(waited).toBeLessThan(15_000);
      // Rolled back: neither index, and the session is usable.
      for (const { index } of TABLES) expect(await indexColumns(client, index)).toBeNull();
      expect((await client.query<{ ok: number }>('select 1 as ok')).rows[0].ok).toBe(1);
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end();
      await noteWriter.end();
      await client.end();
    }
  });

  test('the planner can serve the sweep\'s window read from each index, and the rows are the same as a plain scan', async () => {
    const client = await freshDatabase('sweep2_index_plans');
    try {
      const windows = await seedEvents(client);
      const reads = [
        {
          index: POSTS_INDEX,
          sql: 'select p.post_id from pilot.family_thread_posts p where p.created_at > $1 and p.created_at <= $2',
          window: windows.posts,
        },
        {
          index: NOTES_INDEX,
          sql: 'select co.note_id from pilot.coach_observations co where co.created_at > $1 and co.created_at <= $2',
          window: windows.notes,
        },
      ];

      await applyMigrationTransaction(client, migrationSql);
      await client.query('analyze pilot.family_thread_posts');
      await client.query('analyze pilot.coach_observations');

      for (const read of reads) {
        const params = [read.window.from, read.window.to];
        expect({ index: read.index, used: await indexesUsed(client, read.sql, params) })
          .toEqual({ index: read.index, used: expect.arrayContaining([read.index]) });
        // And the index returns the right rows, not merely a plan: each
        // window holds five rows (see seedEvents).
        const viaIndex = await client.query(read.sql, params);
        await client.query('set enable_indexscan = off');
        await client.query('set enable_bitmapscan = off');
        try {
          const viaScan = await client.query(read.sql, params);
          expect({ index: read.index, rows: viaIndex.rows.length }).toEqual({ index: read.index, rows: 5 });
          expect(viaIndex.rows.map((row) => Object.values(row)[0]).sort())
            .toEqual(viaScan.rows.map((row) => Object.values(row)[0]).sort());
        } finally {
          await client.query('reset enable_indexscan');
          await client.query('reset enable_bitmapscan');
        }
      }
    } finally {
      await client.end();
    }
  });
});
