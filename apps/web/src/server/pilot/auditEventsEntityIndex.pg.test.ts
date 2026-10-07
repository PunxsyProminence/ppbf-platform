// Real PostgreSQL-backed contract test for the audit_events entity index
// migration.
//
// What needs proving that reading SQL cannot prove: the index creates on a
// base-schema database and a re-apply is a no-op; the runner's readiness
// check refuses a database where the index is absent and accepts one where
// it is present; the index is keyed on exactly (organization_id,
// entity_type, entity_id); and the planner can use it for the #1286
// authorship query shape (announcements.ts) and for audit/get's one-entity
// read -- the two reads the index exists for.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-audit-events-entity-index-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_audit_events_entity_index_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-audit-events-entity-index-migration.mjs',
);
const INDEX_NAME = 'idx_pilot_audit_events_org_entity';

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as onePercentClub.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-index';
const OTHER_ORG_ID = 'org-elsewhere';
const ACCOUNT_ID = 'acct-index-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', true) on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  return client;
}

async function indexColumns(client: Client): Promise<string[] | null> {
  const result = await client.query<{ attname: string }>(
    `select a.attname
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     join unnest(i.indkey) with ordinality as k(attnum, ord) on true
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where n.nspname = 'pilot' and c.relname = $1 and i.indisvalid
     order by k.ord`,
    [INDEX_NAME],
  );
  return result.rows.length === 0 ? null : result.rows.map((row) => row.attname);
}

/** Every node of an EXPLAIN (format json) plan tree, flattened. */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [plan];
  for (const child of (plan.Plans as Record<string, unknown>[] | undefined) ?? []) {
    out.push(...planNodes(child));
  }
  return out;
}

async function explainUsesIndex(client: Client, sql: string, params: unknown[]): Promise<boolean> {
  // The test table holds a few hundred rows, where a sequential scan is the
  // cheaper plan; disabling it asks the planner "COULD this index serve the
  // query", which is the property that matters at production size.
  await client.query('set enable_seqscan = off');
  try {
    const result = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
      `explain (format json) ${sql}`,
      params,
    );
    const plan = result.rows[0]['QUERY PLAN'][0].Plan;
    return planNodes(plan).some((node) => node['Index Name'] === INDEX_NAME);
  } finally {
    await client.query('reset enable_seqscan');
  }
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('audit_events entity index migration', () => {
  test('the base schema has no index on (organization_id, entity_type, entity_id), and the SQL adds exactly that one', async () => {
    const client = await freshDatabase('audit_index_create');
    try {
      expect(await indexColumns(client)).toBeNull();
      const before = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'pilot' and tablename = 'audit_events'`,
      );
      // No pre-existing index covers the shape (confirming the migration is
      // not a duplicate of one already there).
      expect(before.rows.some((r) => /\(organization_id, entity_type, entity_id\)/.test(r.indexdef))).toBe(false);

      await client.query(migrationSql);

      expect(await indexColumns(client)).toEqual(['organization_id', 'entity_type', 'entity_id']);
    } finally {
      await client.end();
    }
  });

  test('a re-apply is a no-op: still one index of that name, same columns', async () => {
    const client = await freshDatabase('audit_index_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      const count = await client.query<{ n: string }>(
        `select count(*)::text as n from pg_indexes where schemaname = 'pilot' and indexname = $1`,
        [INDEX_NAME],
      );
      expect(count.rows[0].n).toBe('1');
      expect(await indexColumns(client)).toEqual(['organization_id', 'entity_type', 'entity_id']);
    } finally {
      await client.end();
    }
  });

  test('the SQL refuses a database without pilot.audit_events, by name', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists audit_index_bare');
    await admin.query('create database audit_index_bare');
    await admin.end();
    const client = new Client({ connectionString: connectionStringFor('audit_index_bare') });
    await client.connect();
    try {
      await expect(client.query(migrationSql)).rejects.toThrow(/AUDIT_EVENTS_ENTITY_INDEX_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the index is absent, and rolls back', async () => {
    const client = await freshDatabase('audit_index_runner_refuses');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'AUDIT_EVENTS_ENTITY_INDEX_NOT_READY',
      );
      // Not left inside a transaction.
      const probe = await client.query<{ ok: number }>('select 1 as ok');
      expect(probe.rows[0].ok).toBe(1);
      expect(await indexColumns(client)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a database where the migration applied, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('audit_index_runner_accepts');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      expect(await indexColumns(client)).toEqual(['organization_id', 'entity_type', 'entity_id']);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses an index of the right name on the wrong columns', async () => {
    const client = await freshDatabase('audit_index_wrong_columns');
    try {
      await client.query(
        `create index ${INDEX_NAME} on pilot.audit_events (organization_id, entity_id)`,
      );
      // `if not exists` sees the name and leaves the wrong index in place;
      // the readiness check must notice the columns and refuse.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        'AUDIT_EVENTS_ENTITY_INDEX_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  test('the planner can serve the #1286 authorship query and the audit/get one-entity read from the index', async () => {
    const client = await freshDatabase('audit_index_plans');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // A few hundred rows across two organizations and several entity
      // types, so the statistics are real rather than empty-table guesses.
      await client.query(
        `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
         select case when g % 3 = 0 then 'create' else 'update' end,
                $1, 'organization_admin',
                case when g % 4 = 0 then $3 else $2 end,
                (array['announcement', 'goal', 'session', 'coach_review'])[1 + (g % 4)],
                'entity-' || (g % 50)::text,
                '{}'::jsonb
         from generate_series(1, 400) as g`,
        [ACCOUNT_ID, ORG_ID, OTHER_ORG_ID],
      );
      await client.query('analyze pilot.audit_events');

      // announcements.ts listAuthoredAnnouncementIds, verbatim shape.
      const authorship = `select distinct entity_id
         from pilot.audit_events
         where organization_id = $1
           and entity_type = 'announcement'
           and event_type = 'create'
           and actor_account_id = $2
           and entity_id = any($3::text[])`;
      expect(await explainUsesIndex(client, authorship, [ORG_ID, ACCOUNT_ID, ['entity-4', 'entity-8']])).toBe(true);

      // audit/get with an entity_type and entity_id filter.
      const oneEntity = `select * from pilot.audit_events
         where organization_id = $1 and entity_type = $2 and entity_id = $3
         order by created_at desc limit 20`;
      expect(await explainUsesIndex(client, oneEntity, [ORG_ID, 'goal', 'entity-5'])).toBe(true);

      // And the index returns the right rows, not merely a plan.
      const rows = await client.query<{ n: string }>(
        `select count(*)::text as n from pilot.audit_events
         where organization_id = $1 and entity_type = 'goal' and entity_id = 'entity-5'`,
        [ORG_ID],
      );
      const expected = await client.query<{ n: string }>(
        `select count(*)::text as n from (
           select * from pilot.audit_events offset 0
         ) t where organization_id = $1 and entity_type = 'goal' and entity_id = 'entity-5'`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(expected.rows[0].n);
    } finally {
      await client.end();
    }
  });
});
