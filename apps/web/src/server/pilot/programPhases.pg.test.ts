// Real PostgreSQL-backed contract test for the program-phases migration
// (module 129), AND for the REAL module behavior on top of it: './db' is
// mocked to route into the embedded server (see trainingHolds.pg.test.ts
// for the same pattern), so startPhase, endPhase, and listPhases below are
// the actual production functions executing their actual SQL against
// actual rows -- not the hand-written raw-SQL inserts the rest of this
// file uses to prove schema-level constraints.
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing and re-applies as a no-op; ONE OPEN PHASE per
// program is a partial unique index (a program cannot be in two blocks at
// once) while closed history accumulates freely; and a phase cannot end
// before it began. On top of that: startPhase's own date-ordering refusal
// (a new phase cannot begin before the one it replaces) and its
// auto-close-the-day-before behavior, and endPhase's already-closed and
// ends-before-it-began guards, only exist in the TS module -- the partial
// unique index only proves the DATABASE refuses two open rows, never that
// the module's own ordering rule is what keeps a second row from being
// attempted in the first place.
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
}));

import { endPhase, getPhase, listPhases, startPhase } from './programPhases';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-program-phases-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_program_phases_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-program-phases-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-phases';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-phases-admin';
const COACH_ID = 'acct-phases-coach';
const ATHLETE_ID = 'ath-phases-1';

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
     values ($1, $2, 'Phases Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
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

afterEach(() => {
  activeClient = null;
});

function insertPhase(client: Client, phaseId: string, overrides: Record<string, string | null> = {}) {
  return client.query(
    `insert into pilot.program_phases
       (organization_id, phase_id, program_name, phase_name, started_on, ended_on, created_by_account_id)
     values ($1, $2, $3, $4, $5::date, $6::date, $7)`,
    [
      ORG_ID,
      phaseId,
      overrides.program_name ?? 'Youth Boxing',
      overrides.phase_name ?? 'Foundation',
      overrides.started_on ?? '2026-01-01',
      overrides.ended_on ?? null,
      ADMIN_ID,
    ],
  );
}

describe('program phases migration', () => {
  test('creates from nothing, re-applies as a no-op, and allows exactly one open phase per program', async () => {
    const client = await freshDatabase('phases_fresh');
    try {
      await client.query(migrationSql);
      await insertPhase(client, 'ph-1');
      await client.query(migrationSql);

      // A second OPEN phase for the same program is refused.
      await expect(insertPhase(client, 'ph-dup', { phase_name: 'Competition prep', started_on: '2026-03-01' }))
        .rejects.toMatchObject({ code: '23505' });

      // A different program may run its own open phase.
      await insertPhase(client, 'ph-other', { program_name: 'Wrestling' });

      // Closed history accumulates freely for the same program.
      await client.query(
        `update pilot.program_phases set ended_on = '2026-02-28' where organization_id = $1 and phase_id = 'ph-1'`,
        [ORG_ID],
      );
      await insertPhase(client, 'ph-2', { phase_name: 'Competition prep', started_on: '2026-03-01' });
      await client.query(
        `update pilot.program_phases set ended_on = '2026-05-31' where organization_id = $1 and phase_id = 'ph-2'`,
        [ORG_ID],
      );
      await insertPhase(client, 'ph-3', { phase_name: 'Off season', started_on: '2026-06-01' });

      // A phase cannot end before it began.
      await expect(client.query(
        `update pilot.program_phases set ended_on = '2025-12-31' where organization_id = $1 and phase_id = 'ph-3'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      const rows = await client.query(
        `select count(*)::int as n from pilot.program_phases where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(4);
    } finally {
      await client.end();
    }
  });
});

// The tests above prove the migration's schema. These prove the module:
// startPhase's own date-ordering refusal and its auto-close-the-day-before
// behavior, and endPhase's already-closed and ends-before-it-began guards
// -- none of which a raw-SQL insert can exercise, because none of it is a
// database constraint.
describe('the real program-phase lifecycle against real rows', () => {
  test('startPhase opens the first phase, then closes it the day before the next one begins', async () => {
    const client = await freshDatabase('phases_start_lifecycle');
    activeClient = client;
    try {
      await client.query(migrationSql);

      const first = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Foundation',
        startedOn: '2026-01-01',
        createdByAccountId: ADMIN_ID,
      });
      expect(first).toMatchObject({ phase_name: 'Foundation', started_on: '2026-01-01', ended_on: null });

      const second = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Competition prep',
        startedOn: '2026-03-01',
        createdByAccountId: ADMIN_ID,
      });
      expect(second).toMatchObject({ phase_name: 'Competition prep', started_on: '2026-03-01', ended_on: null });

      // The first phase was closed the day before the second began, not on
      // the same day (that would double-count the boundary date).
      await expect(getPhase(ORG_ID, first!.phase_id)).resolves.toMatchObject({ ended_on: '2026-02-28' });
    } finally {
      await client.end();
    }
  });

  test('startPhase refuses to begin before (or on) the phase it would replace', async () => {
    const client = await freshDatabase('phases_start_order');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const open = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Foundation',
        startedOn: '2026-03-01',
        createdByAccountId: ADMIN_ID,
      });

      await expect(startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Backdated',
        startedOn: '2026-02-01',
        createdByAccountId: ADMIN_ID,
      })).resolves.toBeNull();

      // Same day is also refused, not just strictly earlier.
      await expect(startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Same day',
        startedOn: '2026-03-01',
        createdByAccountId: ADMIN_ID,
      })).resolves.toBeNull();

      // The open phase is untouched by either refused attempt.
      await expect(getPhase(ORG_ID, open!.phase_id)).resolves.toMatchObject({ ended_on: null });
    } finally {
      await client.end();
    }
  });

  test('endPhase refuses an end date before the phase began, and is a no-op on an already-closed phase', async () => {
    const client = await freshDatabase('phases_end');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const open = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Foundation',
        startedOn: '2026-01-01',
        createdByAccountId: ADMIN_ID,
      });

      await expect(endPhase({
        organizationId: ORG_ID,
        phaseId: open!.phase_id,
        endedOn: '2025-12-31',
      })).resolves.toBeNull();

      const ended = await endPhase({ organizationId: ORG_ID, phaseId: open!.phase_id, endedOn: '2026-04-30' });
      expect(ended).toMatchObject({ ended_on: '2026-04-30' });

      // Already closed: a second end attempt is a quiet null, not a rewrite.
      await expect(endPhase({
        organizationId: ORG_ID,
        phaseId: open!.phase_id,
        endedOn: '2026-05-31',
      })).resolves.toBeNull();
      await expect(getPhase(ORG_ID, open!.phase_id)).resolves.toMatchObject({ ended_on: '2026-04-30' });
    } finally {
      await client.end();
    }
  });

  test('listPhases surfaces open phases before closed history, and filters by program', async () => {
    const client = await freshDatabase('phases_listing');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const boxingClosed = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Foundation',
        startedOn: '2026-01-01',
        createdByAccountId: ADMIN_ID,
      });
      const boxingOpen = await startPhase({
        organizationId: ORG_ID,
        programName: 'Youth Boxing',
        phaseName: 'Competition prep',
        startedOn: '2026-03-01',
        createdByAccountId: ADMIN_ID,
      });
      await startPhase({
        organizationId: ORG_ID,
        programName: 'Wrestling',
        phaseName: 'Foundation',
        startedOn: '2026-01-01',
        createdByAccountId: ADMIN_ID,
      });

      const boxing = await listPhases(ORG_ID, 'Youth Boxing');
      expect(boxing.map((p) => p.phase_id)).toEqual([boxingOpen!.phase_id, boxingClosed!.phase_id]);

      const all = await listPhases(ORG_ID);
      expect(all).toHaveLength(3);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-program-phases-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('program phases runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('progph_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PROGRAM_PHASES_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('progph_rdy_ok');
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
