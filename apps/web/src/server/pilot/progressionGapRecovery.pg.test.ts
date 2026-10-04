// Real PostgreSQL-backed contract test for the progression gap 'recovery'
// migration.
//
// The property under test: pilot.progression_gaps.gap_type admits 'recovery'
// after the migration and did not before; the six original values still store
// on both sides of it; a value outside the vocabulary is still refused; and a
// 'recovery' gap goes in and comes back out through the shipped code paths
// (createProgressionGap, getAthleteGaps, getProgressionGapById), not just raw
// SQL.
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

// progression.ts reads and writes through ./db; route it at the embedded
// database this suite owns (the coachCards.pg.test.ts pattern).
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
  withTransaction: jest.fn(async () => {
    throw new Error('test bug: this suite does not exercise transactional writes');
  }),
}));

import { createProgressionGap, getAthleteGaps, getProgressionGapById } from './progression';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gap-recovery-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_progression_gap_recovery_migration.sql';
const PROGRESSION_MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-progression-gap-recovery-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-gap-recovery';
const COACH_ID = 'acct-gap-recovery-coach';
const ATHLETE_ID = 'ATH-GAP-RECOVERY-1';
const ORIGINAL_GAP_TYPES = ['technique', 'strength', 'endurance', 'skill', 'mental', 'tactical'];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let progressionSql: string;
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

/**
 * Fresh database with the base schema, pilot.progression_gaps as the
 * progression migration creates it (the original six-value CHECK), and the
 * org/coach/athlete rows the foreign keys need. Becomes the client ./db uses.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(progressionSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Recovery Athlete', '2010-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  activeClient = client;
  return client;
}

async function closeDatabase(client: Client): Promise<void> {
  activeClient = null;
  await client.end();
}

function createGap(gapType: string) {
  return createProgressionGap({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    coachAccountId: COACH_ID,
    gapType,
    gapDescription: `${gapType} gap`,
    severity: 'medium',
    detectedFrom: 'coach_observation',
  });
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
  progressionSql = await fs.readFile(path.join(INFRA_DIR, PROGRESSION_MIGRATION_FILE), 'utf8');
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
});

describe('progression gap recovery migration against real Postgres', () => {
  test('the gap is real: the original six-value constraint refuses recovery', async () => {
    const client = await freshDatabase('ppbf_test_gaprec_absent');
    try {
      await expect(createGap('recovery')).rejects.toThrow(/progression_gaps_gap_type_check/);
    } finally {
      await closeDatabase(client);
    }
  });

  test('after the migration a recovery gap stores and reads back through the shipped code paths', async () => {
    const client = await freshDatabase('ppbf_test_gaprec_roundtrip');
    try {
      await client.query(migrationSql);

      const created = await createGap('recovery');
      expect(created.gap_type).toBe('recovery');

      const byId = await getProgressionGapById(ORG_ID, created.gap_id);
      expect(byId?.gap_type).toBe('recovery');

      const listed = await getAthleteGaps(ORG_ID, ATHLETE_ID);
      expect(listed.map((gap) => [gap.gap_id, gap.gap_type])).toEqual([[created.gap_id, 'recovery']]);
    } finally {
      await closeDatabase(client);
    }
  });

  test('the six original gap types still store after the migration', async () => {
    const client = await freshDatabase('ppbf_test_gaprec_original');
    try {
      await client.query(migrationSql);
      for (const gapType of ORIGINAL_GAP_TYPES) {
        await createGap(gapType);
      }

      const listed = await getAthleteGaps(ORG_ID, ATHLETE_ID);
      expect(listed.map((gap) => gap.gap_type).sort()).toEqual([...ORIGINAL_GAP_TYPES].sort());
    } finally {
      await closeDatabase(client);
    }
  });

  test('the database still refuses a gap type outside the vocabulary', async () => {
    const client = await freshDatabase('ppbf_test_gaprec_refuses');
    try {
      await client.query(migrationSql);
      for (const unknown of ['sleep', 'Recovery', '']) {
        await expect(createGap(unknown)).rejects.toThrow(/progression_gaps_gap_type_check/);
      }
      const count = await client.query('select count(*)::int as n from pilot.progression_gaps');
      expect(count.rows[0].n).toBe(0);
    } finally {
      await closeDatabase(client);
    }
  });

  test('applies over existing rows, re-runs as a no-op, and leaves exactly one gap_type constraint', async () => {
    const client = await freshDatabase('ppbf_test_gaprec_rerun');
    try {
      // A row written under the old constraint, as production has.
      const before = await createGap('technique');

      await client.query(migrationSql);
      const recovery = await createGap('recovery');
      await client.query(migrationSql);

      const listed = await getAthleteGaps(ORG_ID, ATHLETE_ID);
      expect(listed.map((gap) => gap.gap_id).sort()).toEqual([before.gap_id, recovery.gap_id].sort());

      const constraints = await client.query(
        `select conname
           from pg_constraint
          where conrelid = 'pilot.progression_gaps'::regclass
            and contype = 'c'
            and pg_get_constraintdef(oid) like '%gap_type%'`,
      );
      expect(constraints.rows.map((row: { conname: string }) => row.conname)).toEqual([
        'progression_gaps_gap_type_check',
      ]);
    } finally {
      await closeDatabase(client);
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies. The query
// is never restated here: applyMigrationTransaction is imported from the
// shipped runner and executes the shipped READINESS_QUERY (see
// attendanceParentMethod.pg.test.ts for why, #488).
describe('progression gap recovery runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('gaprec_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PROGRESSION_GAP_RECOVERY_NOT_READY/,
      );
    } finally {
      await closeDatabase(client);
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('gaprec_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489).
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await closeDatabase(client);
    }
  });
});
