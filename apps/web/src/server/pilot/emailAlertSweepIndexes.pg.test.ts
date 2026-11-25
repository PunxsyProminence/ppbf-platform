// Real PostgreSQL-backed contract test for the email alert sweep indexes
// migration (lane W4-1, EM-IX).
//
// What needs proving that reading SQL cannot prove: on the schema production
// runs, neither event table has an index that starts with created_at before
// this migration; the migration adds exactly one b-tree on (created_at) to
// each and a re-apply is a no-op; the SQL names a missing table; the runner's
// readiness check refuses a database where either index is absent or is not
// the index promised, and accepts one where both are; and the planner can
// serve the sweep's window read (`created_at > $1 and created_at <= $2`) from
// each index, returning the same rows as a plain scan.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-sweep-indexes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_email_alert_sweep_indexes_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-email-alert-sweep-indexes-migration.mjs',
);

const ESCALATIONS_INDEX = 'idx_pilot_safety_escalations_created_at';
const REPLIES_INDEX = 'idx_pilot_family_message_replies_created_at';
const TABLES = [
  { index: ESCALATIONS_INDEX, table: 'safety_escalations' },
  { index: REPLIES_INDEX, table: 'family_message_replies' },
] as const;

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as auditEventsEntityIndex.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-sweep';
const COACH_ID = 'acct-sweep-coach';
const ATHLETE_ID = 'ath-sweep';
const NOTE_ID = '6b0f3a52-2c1e-4c55-9a0e-5d2f4f0c1a01';
const TEMPLATE_DB = 'sweep_indexes_template';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
 * The schema production runs, as it stands BEFORE this migration: the full
 * schema (which applies this migration too, in its place in the deploy order)
 * with this migration's two indexes dropped again, plus one gym, coach,
 * athlete and note for the event rows to hang from.
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

/** Rows of both event tables spread over two days, so the statistics are real. */
async function seedEvents(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.safety_escalations
       (organization_id, escalation_id, source_type, athlete_id, severity, reason, escalated_to_role, triggered_by, created_at)
     select $1, 'esc-' || g, 'near_miss', $2, 'moderate', 'a near miss', 'coach', 'system',
            now() - make_interval(mins => g * 7)
     from generate_series(1, 400) as g`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.family_message_replies
       (organization_id, reply_id, note_id, athlete_id, author_role, reply_text, created_at)
     select $1, gen_random_uuid(), $2::uuid, $3, 'parent', 'Thanks, see you Thursday.',
            now() - make_interval(mins => g * 7)
     from generate_series(1, 400) as g`,
    [ORG_ID, NOTE_ID, ATHLETE_ID],
  );
  await client.query('analyze pilot.safety_escalations');
  await client.query('analyze pilot.family_message_replies');
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
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

  // Built once and cloned per test: the full schema takes a while to apply.
  await adminQuery(`drop database if exists ${TEMPLATE_DB}`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    // The full schema includes this migration in its deploy-order place; the
    // suite needs the database as it was before it.
    for (const { index } of TABLES) await template.query(`drop index if exists pilot.${index}`);
    await template.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [ORG_ID],
    );
    await template.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
      [COACH_ID, ORG_ID],
    );
    await template.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Sweep Athlete', '2000-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, ATHLETE_ID, COACH_ID],
    );
    await template.query(
      `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, 'parent_message', 'Bring gloves Thursday.')`,
      [ORG_ID, NOTE_ID, ATHLETE_ID, COACH_ID],
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

describe('email alert sweep indexes migration', () => {
  test('before it, no index on either event table starts with created_at; the SQL adds exactly one (created_at) b-tree to each', async () => {
    const client = await freshDatabase('sweep_index_create');
    try {
      for (const { index, table } of TABLES) {
        expect(await indexColumns(client, index)).toBeNull();
        // Not a duplicate of an index already there.
        expect(await leadingColumns(client, table)).not.toContain('created_at');
      }

      await client.query(migrationSql);

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
    const client = await freshDatabase('sweep_index_idempotent');
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
    const empty = await bareDatabase('sweep_index_bare');
    try {
      await expect(empty.query(migrationSql)).rejects.toThrow(
        /EMAIL_ALERT_SWEEP_INDEXES_NOT_READY: pilot\.safety_escalations does not exist/,
      );
    } finally {
      await empty.end();
    }
    const baseOnly = await bareDatabase('sweep_index_base_only');
    try {
      await baseOnly.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
      await expect(baseOnly.query(migrationSql)).rejects.toThrow(
        /EMAIL_ALERT_SWEEP_INDEXES_NOT_READY: pilot\.family_message_replies does not exist/,
      );
      // Nothing was built on the table that does exist.
      expect(await indexColumns(baseOnly, ESCALATIONS_INDEX)).toBeNull();
    } finally {
      await baseOnly.end();
    }
  });

  test('the real runner REFUSES a database where the indexes are absent, and rolls back', async () => {
    const client = await freshDatabase('sweep_index_runner_refuses');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_NOT_READY');
      // Not left inside a transaction.
      const probe = await client.query<{ ok: number }>('select 1 as ok');
      expect(probe.rows[0].ok).toBe(1);
      for (const { index } of TABLES) expect(await indexColumns(client, index)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a database where the migration applied, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('sweep_index_runner_accepts');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      for (const { index } of TABLES) expect(await indexColumns(client, index)).toEqual(['created_at']);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['only the escalations index', `create index ${ESCALATIONS_INDEX} on pilot.safety_escalations (created_at)`],
    ['only the replies index', `create index ${REPLIES_INDEX} on pilot.family_message_replies (created_at)`],
  ])('the runner refuses a database with %s', async (_label, onlyOne) => {
    const client = await freshDatabase('sweep_index_only_one');
    try {
      await client.query(onlyOne);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['on the wrong columns', `create index ${REPLIES_INDEX} on pilot.family_message_replies (organization_id, created_at)`],
    ['partial', `create index ${REPLIES_INDEX} on pilot.family_message_replies (created_at) where author_role = 'parent'`],
    ['unique', `create unique index ${REPLIES_INDEX} on pilot.family_message_replies (created_at)`],
    ['not a b-tree', `create index ${REPLIES_INDEX} on pilot.family_message_replies using hash (created_at)`],
    ['on the wrong table', `create index ${REPLIES_INDEX} on pilot.coach_observations (created_at)`],
  ])('the runner refuses an index of the right name that is %s', async (_label, wrong) => {
    const client = await freshDatabase('sweep_index_wrong');
    try {
      await client.query(wrong);
      // `if not exists` sees the name and leaves the wrong index in place;
      // the readiness check must notice and refuse.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('EMAIL_ALERT_SWEEP_INDEXES_NOT_READY');
    } finally {
      await client.end();
    }
  });

  test('the planner can serve the sweep\'s window read from each index, and the rows are the same as a plain scan', async () => {
    const client = await freshDatabase('sweep_index_plans');
    try {
      await seedEvents(client);
      // The sweep's window (emailAlertEvents.ts, inWindow): rows created
      // after the checkpoint less ten minutes, up to now.
      const window = await client.query<{ from: Date; to: Date }>(
        `select now() - interval '40 minutes' as "from", now() as "to"`,
      );
      const { from, to } = window.rows[0];
      const reads = [
        { index: ESCALATIONS_INDEX, sql: 'select e.escalation_id from pilot.safety_escalations e where e.created_at > $1 and e.created_at <= $2' },
        { index: REPLIES_INDEX, sql: 'select r.reply_id from pilot.family_message_replies r where r.created_at > $1 and r.created_at <= $2' },
      ];

      // Without the migration neither read can use a (created_at) index.
      for (const read of reads) expect(await indexesUsed(client, read.sql, [from, to])).not.toContain(read.index);

      await applyMigrationTransaction(client, migrationSql);
      await client.query('analyze pilot.safety_escalations');
      await client.query('analyze pilot.family_message_replies');

      for (const read of reads) {
        expect({ index: read.index, used: await indexesUsed(client, read.sql, [from, to]) })
          .toEqual({ index: read.index, used: expect.arrayContaining([read.index]) });
        // And the index returns the right rows, not merely a plan: the window
        // holds rows 1-5 of each table (7, 14, ... 35 minutes old).
        const viaIndex = await client.query(read.sql, [from, to]);
        await client.query('set enable_indexscan = off');
        await client.query('set enable_bitmapscan = off');
        try {
          const viaScan = await client.query(read.sql, [from, to]);
          expect(viaIndex.rows.length).toBe(5);
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
