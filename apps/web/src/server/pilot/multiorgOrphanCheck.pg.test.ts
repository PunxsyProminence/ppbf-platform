// Real PostgreSQL-backed test for pilot-check-multiorg-orphans.mjs.
//
// Spins up a disposable, local-only embedded Postgres instance (see
// scripts/test-embedded-pg-server.mjs). This NEVER connects to production or
// staging.
//
// WHY THIS TEST MATTERS BEYOND THE SCRIPT ITSELF: the current base schema
// (pilot_slice_postgres.sql) already declares organization_id with an inline
// `references pilot.organizations(organization_id)` on all eight tables the
// multiorg migration's FK-adding block targets. A database built fresh from
// today's base schema can never contain an orphaned organization_id in these
// columns -- the FK rejects the insert at write time. The real risk PR #52
// raised only exists on a LEGACY database: one whose schema predates that
// inline FK, where organization_id could be written with no referential check
// at all. This test constructs exactly that legacy shape -- present column,
// absent constraint -- rather than testing against today's schema, which
// would make the orphan-detection code path untestable by construction.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-multiorg-orphan-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECKER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-multiorg-orphans.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

// A plain `await import(specifier)` gets downleveled by ts-jest's CommonJS
// transform into require(), which cannot load a real ESM-only .mjs file.
// Constructing the import() call inside `new Function` hides it from that
// downleveling, so it remains a genuine dynamic import Node's own ESM loader
// executes at runtime -- the same technique sessionExpiry.migration.pg.test.ts
// uses for the same reason.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ checkOrphans: (client: Client) => Promise<Array<{ table: string; orphanCount: number; sample: Array<{ organization_id: string; row_count: number }> }>> }>;

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

async function newTestDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

// Finds and drops the (auto-named) FK constraint Postgres generated for an
// inline `references` clause, so the test can put a table into the
// pre-migration "legacy" shape: the column exists, nothing enforces it.
async function dropOrganizationIdForeignKey(client: Client, table: string): Promise<void> {
  const { rows } = await client.query<{ conname: string }>(
    `select conname from pg_constraint
     where conrelid = $1::regclass and contype = 'f'
       and pg_get_constraintdef(oid) like '%organization_id%organizations%'`,
    [`pilot.${table}`],
  );
  for (const { conname } of rows) {
    await client.query(`alter table pilot.${table} drop constraint ${conname}`);
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
});

describe('checkOrphans', () => {
  let client: Client;
  const ORG = 'clean-org';

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_multiorg_orphans');
    await client.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status, created_at, updated_at)
       values ($1, 'Clean Org', 'active', now(), now())`,
      [ORG],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  test('reports zero orphans on a fresh, fully-constrained database', async () => {
    // Today's base schema enforces the FK inline on every one of these eight
    // tables, so a normal insert against a valid org cannot produce an orphan.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, is_platform_owner, created_at, updated_at)
       values ('acct-clean', 'organization_admin', $1, 'microsoft', true, false, now(), now())`,
      [ORG],
    );

    const { checkOrphans } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const results = await checkOrphans(client);

    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.orphanCount).toBe(0);
      expect(result.sample).toEqual([]);
    }
  });

  test('detects an orphaned organization_id on a legacy-shaped table (FK absent), and clears once resolved', async () => {
    // Simulates the actual condition PR #52 described: a table whose
    // organization_id predates the inline FK, so nothing stopped a bad value
    // from being written.
    await dropOrganizationIdForeignKey(client, 'audit_events');

    await client.query(
      `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
       values ('create', null, 'coach', 'org-that-does-not-exist', 'athlete', '1', '{}'::jsonb)`,
    );

    const { checkOrphans } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const firstPass = await checkOrphans(client);

    const auditResult = firstPass.find((r) => r.table === 'audit_events');
    expect(auditResult?.orphanCount).toBe(1);
    expect(auditResult?.sample).toEqual([
      { organization_id: 'org-that-does-not-exist', row_count: 1 },
    ]);

    // Every other table is untouched by this test and must still read clean --
    // proves the check is per-table, not a single global flag that one bad
    // row anywhere would flip for everything.
    for (const result of firstPass) {
      if (result.table !== 'audit_events') {
        expect(result.orphanCount).toBe(0);
      }
    }

    // Resolve it the way an operator actually would -- reassign to a real org
    // -- and confirm the check reflects that, rather than caching a stale
    // answer from the first pass.
    await client.query(
      `update pilot.audit_events set organization_id = $1 where organization_id = 'org-that-does-not-exist'`,
      [ORG],
    );

    const secondPass = await checkOrphans(client);
    expect(secondPass.find((r) => r.table === 'audit_events')?.orphanCount).toBe(0);
  });

  test('a null organization_id is not reported as an orphan', async () => {
    // audit_events.organization_id is nullable; a null means "no
    // organization applies" (e.g. a platform-level event), which is a valid
    // state distinct from "refers to an organization that does not exist".
    await client.query(
      `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
       values ('login', null, 'platform_owner', null, 'account', '2', '{}'::jsonb)`,
    );

    const { checkOrphans } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const results = await checkOrphans(client);

    expect(results.find((r) => r.table === 'audit_events')?.orphanCount).toBe(0);
  });
});
