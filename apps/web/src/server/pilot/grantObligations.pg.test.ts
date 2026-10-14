// Real PostgreSQL-backed contract test for the grant-obligations migration.
//
// What needs proving that reading SQL cannot prove: the migration creates the
// table from nothing; re-applying it over an existing install is a no-op that
// leaves rows untouched; the check constraints actually refuse what the
// module's vocabulary refuses; and the table's defining boundary holds -- no
// column of this table references athlete data, which is what keeps the
// parked BACKLOG-grant-packet disclosure question structurally parked.
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

// The report read (RP-03) runs its production SQL against the database the
// current test opened. Declared before the import so jest's mock hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import { grantObligationsReport } from './grantObligations';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-grant-obligations-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_grant_obligations_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-grant-obligations-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-grants';
const ADMIN_ID = 'acct-grants-admin';

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
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  return client;
}

function insertObligation(client: Client, obligationId: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.grant_obligations
       (organization_id, obligation_id, grant_name, obligation_type, description, due_date, created_by_account_id, status)
     values ($1, $2, $3, $4, $5, $6::date, $7, $8)`,
    [
      ORG_ID,
      obligationId,
      overrides.grant_name ?? 'Community Youth Grant',
      overrides.obligation_type ?? 'report',
      overrides.description ?? 'Quarterly outcomes report to the funder.',
      overrides.due_date ?? '2026-10-01',
      ADMIN_ID,
      overrides.status ?? 'open',
    ],
  );
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

describe('grant obligations migration', () => {
  test('creates the table from nothing and accepts a valid row', async () => {
    const client = await freshDatabase('grants_fresh');
    try {
      await client.query(migrationSql);
      await insertObligation(client, 'ob-1');

      const rows = await client.query(
        `select grant_name, status, due_date::text as due_date from pilot.grant_obligations
         where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe('open');
      expect(rows.rows[0].due_date).toBe('2026-10-01');
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('grants_noop');
    try {
      await client.query(migrationSql);
      await insertObligation(client, 'ob-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select obligation_id from pilot.grant_obligations where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.obligation_id)).toEqual(['ob-keep']);
    } finally {
      await client.end();
    }
  });

  test('the vocabularies are enforced by the database, not just the module', async () => {
    const client = await freshDatabase('grants_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertObligation(client, 'ob-bad-type', { obligation_type: 'party' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertObligation(client, 'ob-bad-status', { status: 'someday' }))
        .rejects.toMatchObject({ code: '23514' });
      // A blank description is a row nobody can act on.
      await expect(insertObligation(client, 'ob-blank', { description: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      // completed_at on an open row is refused by the settled-only check.
      await client.query(migrationSql);
      await expect(client.query(
        `insert into pilot.grant_obligations
           (organization_id, obligation_id, grant_name, obligation_type, description, due_date, created_by_account_id, status, completed_at)
         values ($1, 'ob-open-completed', 'G', 'report', 'D', '2026-10-01', $2, 'open', now())`,
        [ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the table has no athlete-shaped column: the disclosure question stays structurally parked', async () => {
    const client = await freshDatabase('grants_boundary');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'grant_obligations'`,
      );
      const names = columns.rows.map((row) => String(row.column_name));
      expect(names.some((name) => /athlete|minor|child|participant/i.test(name))).toBe(false);

      const fks = await client.query(
        `select confrelid::regclass::text as referenced
         from pg_constraint
         where conrelid = to_regclass('pilot.grant_obligations') and contype = 'f'`,
      );
      const referenced = fks.rows.map((row) => String(row.referenced));
      expect(referenced.sort()).toEqual(['pilot.accounts', 'pilot.organizations']);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-grant-obligations-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('grant obligations runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('grantob_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /GRANT_OBLIGATIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('grantob_rdy_ok');
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

/*
 * THE OBLIGATIONS REPORT READ (RP-03): this organization's obligations due in
 * a range, for one state, ordered by grant, funder and due date. Every stored
 * status is seeded, across two grants, with a second gym whose rows must not
 * appear.
 */
describe('grantObligationsReport on real rows (RP-03)', () => {
  const OTHER_ORG = 'org-grants-other';

  async function seeded(name: string): Promise<Client> {
    const client = await freshDatabase(name);
    await client.query(migrationSql);
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [OTHER_ORG],
    );
    const rows: Array<[string, string, string, string]> = [
      // [id, grant, status, due]
      ['ob-b-open', 'Youth Grant', 'open', '2026-10-05'],
      ['ob-b-prog', 'Youth Grant', 'in_progress', '2026-10-20'],
      ['ob-b-sub', 'Youth Grant', 'submitted', '2026-09-30'],
      ['ob-a-comp', 'Arts Grant', 'complete', '2026-10-10'],
      ['ob-a-waiv', 'Arts Grant', 'waived', '2026-11-15'],
    ];
    for (const [id, grant, status, due] of rows) {
      await insertObligation(client, id, { grant_name: grant, status, due_date: due });
    }
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-other-admin', 'organization_admin', $1, 'microsoft')`,
      [OTHER_ORG],
    );
    await client.query(
      `insert into pilot.grant_obligations
         (organization_id, obligation_id, grant_name, obligation_type, description, due_date, created_by_account_id, status)
       values ($1, 'ob-other', 'Arts Grant', 'report', 'Elsewhere.', '2026-10-10', 'acct-other-admin', 'open')`,
      [OTHER_ORG],
    );
    activeClient = client;
    return client;
  }

  afterEach(() => {
    activeClient = null;
  });

  test('all states: every stored status, grouped by grant then due date, and no other gym', async () => {
    const client = await seeded('grants_report_all');
    try {
      const rows = await grantObligationsReport(ORG_ID, { state: 'all' });
      expect(rows.map((row) => row.obligation_id)).toEqual(['ob-a-comp', 'ob-a-waiv', 'ob-b-sub', 'ob-b-open', 'ob-b-prog']);
      expect(rows.map((row) => row.status).sort()).toEqual(['complete', 'in_progress', 'open', 'submitted', 'waived']);
    } finally {
      await client.end();
    }
  });

  test('open is open or in progress; settled is submitted, complete or waived', async () => {
    const client = await seeded('grants_report_states');
    try {
      expect((await grantObligationsReport(ORG_ID, { state: 'open' })).map((row) => row.obligation_id))
        .toEqual(['ob-b-open', 'ob-b-prog']);
      expect((await grantObligationsReport(ORG_ID, { state: 'settled' })).map((row) => row.obligation_id))
        .toEqual(['ob-a-comp', 'ob-a-waiv', 'ob-b-sub']);
    } finally {
      await client.end();
    }
  });

  test('the due range is inclusive at both ends', async () => {
    const client = await seeded('grants_report_range');
    try {
      const rows = await grantObligationsReport(ORG_ID, { state: 'all', dueFrom: '2026-10-05', dueTo: '2026-10-20' });
      expect(rows.map((row) => row.obligation_id)).toEqual(['ob-a-comp', 'ob-b-open', 'ob-b-prog']);
    } finally {
      await client.end();
    }
  });
});
