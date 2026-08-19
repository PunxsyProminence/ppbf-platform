// Real PostgreSQL-backed contract test for the external-competition
// migration.
//
// What needs proving that reading SQL cannot prove: the migration creates
// both tables from nothing; re-applying it is a no-op that leaves rows
// untouched; the status vocabularies are enforced by the database; and the
// tenancy shape holds -- an entry can only reference a competition (and an
// athlete) in the SAME organization, and an athlete cannot be entered twice
// in one competition.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-external-competition-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_external_competition_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-external-competition-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-competition';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-competition-admin';
const COACH_ID = 'acct-competition-coach';
const ATHLETE_ID = 'ath-competition-1';

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
     values ($1, $2, 'Competition Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

function insertCompetition(client: Client, competitionId: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.external_competitions
       (organization_id, competition_id, competition_name, competition_date, status, created_by_account_id)
     values ($1, $2, $3, $4::date, $5, $6)`,
    [
      overrides.organization_id ?? ORG_ID,
      competitionId,
      overrides.competition_name ?? 'Regional Open 2026',
      overrides.competition_date ?? '2026-12-05',
      overrides.status ?? 'planned',
      ADMIN_ID,
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

describe('external competition migration', () => {
  test('creates both tables from nothing and accepts a valid chain', async () => {
    const client = await freshDatabase('competition_fresh');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, 'comp-1');
      await client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
         values ($1, 'entry-1', 'comp-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );

      const entries = await client.query(
        `select e.athlete_id, a.full_name
         from pilot.external_competition_entries e
         join pilot.athletes a on a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
         where e.organization_id = $1 and e.competition_id = 'comp-1'`,
        [ORG_ID],
      );
      expect(entries.rows).toEqual([{ athlete_id: ATHLETE_ID, full_name: 'Competition Athlete' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('competition_noop');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, 'comp-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select competition_id from pilot.external_competitions where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.competition_id)).toEqual(['comp-keep']);
    } finally {
      await client.end();
    }
  });

  test('the vocabularies are enforced by the database', async () => {
    const client = await freshDatabase('competition_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertCompetition(client, 'comp-bad', { status: 'someday' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertCompetition(client, 'comp-blank', { competition_name: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      await insertCompetition(client, 'comp-1');
      await expect(client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, status, created_by_account_id)
         values ($1, 'entry-bad', 'comp-1', $2, 'maybe', $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('tenancy is structural: cross-org references and duplicate entries are refused', async () => {
    const client = await freshDatabase('competition_tenancy');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, 'comp-1');

      // An entry claiming this competition from ANOTHER organization: the
      // composite FK makes the competition simply not exist there.
      await expect(client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
         values ($1, 'entry-cross', 'comp-1', $2, $3)`,
        [OTHER_ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // One entry per athlete per competition.
      await client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
         values ($1, 'entry-1', 'comp-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );
      await expect(client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
         values ($1, 'entry-2', 'comp-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ constraint: 'pilot_external_competition_entries_unique' });
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-external-competition-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('external competition runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('extcomp_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /EXTERNAL_COMPETITION_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('extcomp_rdy_ok');
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
