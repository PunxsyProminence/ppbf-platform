// Real PostgreSQL-backed contract test for the intervention-protocols
// migration (module 026 slice 1).
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing; re-applying it is a no-op; the status vocabulary
// and the lineage shape (v1 heads its lineage, v2+ must name what it
// supersedes) are database facts; one ACTIVE head per lineage is a partial
// unique index; and tenancy holds via the composite FKs.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-protocols-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_intervention_protocols_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-intervention-protocols-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-protocols';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-protocols-admin';
const COACH_ID = 'acct-protocols-coach';
const ATHLETE_ID = 'ath-protocols-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let baseSchemaSql: string;

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
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Protocols Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
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


function insertProtocol(client: Client, protocolId: string, overrides: Record<string, string | number | null> = {}) {
  return client.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, version, supersedes_protocol_id, athlete_id,
        title, target_problem, hypothesis, intervention_description, expected_outcome, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'fades in round 3', 'aerobic capacity limits round 3 output', 'constrained 3-round intervals', 'round-3 work rate holds', $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      protocolId,
      overrides.lineage_id ?? protocolId,
      overrides.version ?? 1,
      overrides.supersedes_protocol_id ?? null,
      'athlete_id' in overrides ? overrides.athlete_id : null,
      overrides.title ?? 'Round-3 endurance block',
      overrides.status ?? 'active',
      ADMIN_ID,
    ],
  );
}

describe('intervention protocols migration', () => {
  test('creates the table from nothing and accepts a v1 head', async () => {
    const client = await freshDatabase('protocols_fresh');
    try {
      await client.query(migrationSql);
      await insertProtocol(client, 'proto-1');

      const rows = await client.query(
        `select title, version, status from pilot.intervention_protocols where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ title: 'Round-3 endurance block', version: 1, status: 'active' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('protocols_noop');
    try {
      await client.query(migrationSql);
      await insertProtocol(client, 'proto-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select protocol_id from pilot.intervention_protocols where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.protocol_id)).toEqual(['proto-keep']);
    } finally {
      await client.end();
    }
  });

  test('the lineage shape is a database fact in both directions', async () => {
    const client = await freshDatabase('protocols_lineage');
    try {
      await client.query(migrationSql);
      await insertProtocol(client, 'proto-1');

      // A v2 claiming to head its own lineage (no supersedes) is refused.
      await expect(insertProtocol(client, 'proto-bad-v2', { lineage_id: 'proto-1', version: 2 }))
        .rejects.toMatchObject({ code: '23514' });
      // A v1 claiming to supersede something is refused.
      await expect(insertProtocol(client, 'proto-bad-v1', { version: 1, supersedes_protocol_id: 'proto-1' }))
        .rejects.toMatchObject({ code: '23514' });
      // A second ACTIVE head in one lineage is refused by the partial index.
      await expect(insertProtocol(client, 'proto-second-head', { lineage_id: 'proto-1', version: 2, supersedes_protocol_id: 'proto-1' }))
        .rejects.toMatchObject({ code: '23505' });
      // The legal shape: the new head is active only after the old one is stamped.
      await client.query(
        `update pilot.intervention_protocols set status = 'superseded' where organization_id = $1 and protocol_id = 'proto-1'`,
        [ORG_ID],
      );
      await insertProtocol(client, 'proto-v2', { lineage_id: 'proto-1', version: 2, supersedes_protocol_id: 'proto-1' });
    } finally {
      await client.end();
    }
  });

  test('tenancy is composite: cross-org supersession and athlete claims are refused', async () => {
    const client = await freshDatabase('protocols_tenancy');
    try {
      await client.query(migrationSql);
      await insertProtocol(client, 'proto-1');

      await expect(insertProtocol(client, 'proto-cross-athlete', { athlete_id: ATHLETE_ID, organization_id: OTHER_ORG_ID }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-intervention-protocols-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('intervention protocols runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('intpr_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /INTERVENTION_PROTOCOLS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('intpr_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
