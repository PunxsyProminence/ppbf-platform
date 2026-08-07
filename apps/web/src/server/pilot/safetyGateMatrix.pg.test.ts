// Real PostgreSQL-backed contract test for the Safety Gate Matrix migration
// (pilot.safety_gates, pilot.safety_gate_evaluations).
//
// Four things need proving, and none can be proven by reading SQL:
//
// 1. Every organization that exists when the migration runs ends up with the
//    contact_medical_clearance gate, with the exact enforcement/category the
//    platform ships.
// 2. Re-running does not duplicate or resurrect a gym's own edit --
//    deactivating the gate is a decision the next run must not overturn.
// 3. The vocabulary (enforcement, category, outcome) is enforced by the
//    database, not only by the TypeScript validator.
// 4. The runner's readiness check actually fails when the seeds did not
//    land, and seedDefaultSafetyGates (the createOrganization path) reaches
//    the same row shape as the migration.
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

import { Client, type PoolClient } from 'pg';

// Routes safetyGateMatrix.ts's getGuardianGateSummary into whichever
// embedded database the current test opened, so the real listEscalations-
// style LEFT JOIN LATERAL SQL executes against real rows. Round 9 review:
// every existing test for this function mocked query() with one
// pre-selected row per gate, so the "most recent evaluation" ORDER BY and
// the org+athlete correlation in the LATERAL join were never actually
// exercised by anything. withTransaction/queryOne are included so
// safetyGateSeeds.ts's fallback (no-client) path stays safe even though
// every test below passes an explicit client.
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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return fn({ query: (text: string, values: unknown[]) => activeClient!.query(text, values) });
  }),
}));

import { getGuardianGateSummary } from './safetyGateMatrix';
import { seedDefaultSafetyGates } from './safetyGateSeeds';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-safety-gate-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_safety_gate_matrix_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-safety-gate-matrix-migration.mjs',
);

const ORG_A = 'org-gate-a';
const ORG_B = 'org-gate-b';
const COACH_ID = 'acct-gate-coach';
const ATHLETE_ID = 'ATH-GATE-1';

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
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

/**
 * Fresh database holding two organizations, a coach, and an athlete on ORG_A.
 *
 * Organizations are inserted BEFORE the migration runs, on purpose: the
 * migration's seed step selects `from pilot.organizations` at apply time
 * (matching compliance-rule-seeds), so applying it against an empty
 * organizations table would prove nothing -- every gym in this suite must
 * already exist for "the migration seeds every existing org" to be a real
 * test rather than a vacuous one.
 *
 * `dropGateTablesFirst` simulates a database from BEFORE this change:
 * pilot_slice_postgres.sql (the fresh-environment bootstrap) now carries
 * safety_gates/safety_gate_evaluations directly, so a brand-new database
 * already has them -- the increment migration below exists for databases
 * that predate that, and the negative-control tests need to reproduce that
 * older shape rather than one that can no longer occur from this file.
 */
async function freshDatabase(
  name: string,
  { applyGateMigration = true, dropGateTablesFirst = false }: { applyGateMigration?: boolean; dropGateTablesFirst?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (dropGateTablesFirst) {
    await client.query('drop table if exists pilot.safety_gate_evaluations cascade');
    await client.query('drop table if exists pilot.safety_gates cascade');
  }
  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Gate Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_A, ATHLETE_ID, COACH_ID],
  );
  if (applyGateMigration) {
    await client.query(migrationSql);
  }
  return client;
}

async function gatesFor(client: Client, organizationId: string) {
  const { rows } = await client.query(
    `select gate_id, gate_key, name, category, enforcement, requirement_text, active_flag
     from pilot.safety_gates
     where organization_id = $1
     order by gate_id`,
    [organizationId],
  );
  return rows as Array<{
    gate_id: string;
    gate_key: string;
    name: string;
    category: string;
    enforcement: string;
    requirement_text: string;
    active_flag: boolean;
  }>;
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
});

describe('safety gate matrix against real Postgres', () => {
  test('the gap is real: without the migration neither table exists', async () => {
    const client = await freshDatabase('ppbf_test_gate_absent', { applyGateMigration: false, dropGateTablesFirst: true });
    try {
      await expect(client.query('select 1 from pilot.safety_gates')).rejects.toThrow(
        /relation "pilot.safety_gates" does not exist/i,
      );
      await expect(client.query('select 1 from pilot.safety_gate_evaluations')).rejects.toThrow(
        /relation "pilot.safety_gate_evaluations" does not exist/i,
      );
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in
  // this file would be worthless: the runner would commit an environment
  // where the tables or the seed silently did not land.
  // Tables already exist here (pilot_slice_postgres.sql carries them), but
  // the seed step never ran -- 'select 1' stands in for the migration SQL,
  // matching compliance-rule-seeds' equivalent test. The readiness check
  // must catch an unseeded organization even when the tables are present.
  test('the readiness check REFUSES a database where the seed never ran', async () => {
    const client = await freshDatabase('ppbf_test_gate_readiness_negative', { applyGateMigration: false });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SAFETY_GATE_MATRIX_NOT_READY/,
      );

      const gates = await gatesFor(client, ORG_A);
      expect(gates).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('the migration creates both tables and seeds the default gate for every existing org', async () => {
    const client = await freshDatabase('ppbf_test_gate_fresh');
    try {
      for (const organizationId of [ORG_A, ORG_B]) {
        const gates = await gatesFor(client, organizationId);
        expect(gates).toEqual([
          expect.objectContaining({
            gate_id: `gate_${organizationId}_contact_medical_clearance`,
            gate_key: 'contact_medical_clearance',
            name: 'Contact Requires Medical Clearance',
            category: 'medical',
            enforcement: 'flag',
            active_flag: true,
          }),
          // #82: the training-hold gate seeds alongside -- 'block' because
          // it guards a pre-action (class registration).
          expect.objectContaining({
            gate_id: `gate_${organizationId}_training_hold`,
            gate_key: 'training_hold',
            name: 'Active Training Hold',
            category: 'training_level',
            enforcement: 'block',
            active_flag: true,
          }),
        ]);
        expect(gates[0].requirement_text).toContain('cleared');
      }
    } finally {
      await client.end();
    }
  });

  test('a gym that deactivated the gate keeps it deactivated after a re-run', async () => {
    const client = await freshDatabase('ppbf_test_gate_deactivated');
    try {
      await client.query(
        `update pilot.safety_gates set active_flag = false where organization_id = $1 and gate_key = 'contact_medical_clearance'`,
        [ORG_A],
      );

      await client.query(migrationSql);

      const gates = await gatesFor(client, ORG_A);
      expect(gates[0].active_flag).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate rows, no change to an edited row', async () => {
    const client = await freshDatabase('ppbf_test_gate_rerun');
    try {
      await client.query(
        `update pilot.safety_gates set name = 'Renamed By Gym' where organization_id = $1 and gate_key = 'contact_medical_clearance'`,
        [ORG_A],
      );

      await client.query(migrationSql);
      await client.query(migrationSql);

      const gates = await gatesFor(client, ORG_A);
      expect(gates).toHaveLength(2);
      expect(gates.find((gate) => gate.gate_key === 'contact_medical_clearance')?.name).toBe('Renamed By Gym');
    } finally {
      await client.end();
    }
  });

  test('enforcement only admits block or flag', async () => {
    const client = await freshDatabase('ppbf_test_gate_enforcement_vocab');
    try {
      await expect(
        client.query(
          `insert into pilot.safety_gates (organization_id, gate_id, gate_key, name, category, enforcement, requirement_text)
           values ($1, 'gate-bad-enforcement', 'bad_gate', 'Bad Gate', 'other', 'override', 'x')`,
          [ORG_A],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  test('evaluation outcome only admits passed, blocked, or flagged', async () => {
    const client = await freshDatabase('ppbf_test_gate_outcome_vocab');
    try {
      await expect(
        client.query(
          `insert into pilot.safety_gate_evaluations (
             organization_id, evaluation_id, gate_key, athlete_id, outcome,
             evaluated_by_account_id, evaluated_by_role, evaluated_at
           ) values ($1, 'eval-bad', 'contact_medical_clearance', $2, 'overridden', $3, 'coach', now())`,
          [ORG_A, ATHLETE_ID, COACH_ID],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  test('an evaluation cannot reference an athlete or gate that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_gate_fk');
    try {
      await expect(
        client.query(
          `insert into pilot.safety_gate_evaluations (
             organization_id, evaluation_id, gate_key, athlete_id, outcome,
             evaluated_by_account_id, evaluated_by_role, evaluated_at
           ) values ($1, 'eval-no-athlete', 'contact_medical_clearance', 'ATH-DOES-NOT-EXIST', 'passed', $2, 'coach', now())`,
          [ORG_A, COACH_ID],
        ),
      ).rejects.toThrow(/violates foreign key constraint/i);

      await expect(
        client.query(
          `insert into pilot.safety_gate_evaluations (
             organization_id, evaluation_id, gate_key, athlete_id, outcome,
             evaluated_by_account_id, evaluated_by_role, evaluated_at
           ) values ($1, 'eval-no-gate', 'gate_key_does_not_exist', $2, 'passed', $3, 'coach', now())`,
          [ORG_A, ATHLETE_ID, COACH_ID],
        ),
      ).rejects.toThrow(/violates foreign key constraint/i);
    } finally {
      await client.end();
    }
  });

  // The real write path an evaluation goes through, minus the pooled
  // connection layer (db.ts) that this suite does not stand up -- same
  // reasoning as goalCategoryProgress.pg.test.ts's equivalent test.
  test('a passed and a flagged evaluation both store the shape the app writes', async () => {
    const client = await freshDatabase('ppbf_test_gate_writepath');
    try {
      await client.query(
        `insert into pilot.safety_gate_evaluations (
           organization_id, evaluation_id, gate_key, athlete_id, outcome, reason,
           evaluated_by_account_id, evaluated_by_role, context_id, metadata, evaluated_at
         ) values
           ($1, 'eval-pass', 'contact_medical_clearance', $2, 'passed', '', $3, 'athlete', 'ctx-1', '{}'::jsonb, now()),
           ($1, 'eval-flag', 'contact_medical_clearance', $2, 'flagged', 'no clearance on file', $3, 'coach', 'ctx-2',
            '{"medical_status":"not_cleared"}'::jsonb, now())`,
        [ORG_A, ATHLETE_ID, COACH_ID],
      );

      const { rows } = await client.query(
        `select evaluation_id, outcome, reason, metadata from pilot.safety_gate_evaluations
         where organization_id = $1 order by evaluation_id`,
        [ORG_A],
      );
      expect(rows).toEqual([
        { evaluation_id: 'eval-flag', outcome: 'flagged', reason: 'no clearance on file', metadata: { medical_status: 'not_cleared' } },
        { evaluation_id: 'eval-pass', outcome: 'passed', reason: '', metadata: {} },
      ]);
    } finally {
      await client.end();
    }
  });

  // seedDefaultSafetyGates is createOrganization's half of the seeding job --
  // it must land on the identical row the migration would have produced for
  // the same organization, so a gym seeded either way is indistinguishable.
  test('seedDefaultSafetyGates (the createOrganization path) reaches the same row shape as the migration', async () => {
    const client = await freshDatabase('ppbf_test_gate_apppath', { applyGateMigration: false });
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-brand-new', 'org-brand-new', 'active') on conflict do nothing`,
      );

      await client.query(migrationSql);
      await seedDefaultSafetyGates('org-brand-new', client as unknown as PoolClient);
      // Calling it twice must stay a no-op -- createOrganization's own
      // upsert-style retry path could plausibly call this more than once.
      await seedDefaultSafetyGates('org-brand-new', client as unknown as PoolClient);

      const gates = await gatesFor(client, 'org-brand-new');
      expect(gates).toEqual([
        expect.objectContaining({
          gate_id: 'gate_org-brand-new_contact_medical_clearance',
          gate_key: 'contact_medical_clearance',
          enforcement: 'flag',
          active_flag: true,
        }),
        expect.objectContaining({
          gate_id: 'gate_org-brand-new_training_hold',
          gate_key: 'training_hold',
          enforcement: 'block',
          active_flag: true,
        }),
      ]);
    } finally {
      await client.end();
    }
  });
});

// ─── the real getGuardianGateSummary against real rows (#84, Round 9) ───────
//
// The "most recent evaluation per gate" ORDER BY and the org+athlete
// correlation inside the LATERAL join live in this SQL. A mocked query()
// handing back one pre-selected row per test can only prove the calling
// code shapes its output correctly -- it cannot prove the ORDER BY actually
// picks the newest row, or that the join doesn't leak a different
// athlete's or organization's evaluation. This runs the real function.
describe('the real getGuardianGateSummary against real rows', () => {
  afterEach(() => {
    activeClient = null;
  });

  async function insertEvaluation(
    client: Client,
    params: { evaluationId: string; organizationId: string; athleteId: string; outcome: string; evaluatedAt: string },
  ): Promise<void> {
    await client.query(
      `insert into pilot.safety_gate_evaluations (
         organization_id, evaluation_id, gate_key, athlete_id, outcome,
         evaluated_by_account_id, evaluated_by_role, evaluated_at
       ) values ($1, $2, 'contact_medical_clearance', $3, $4, $5, 'coach', $6)`,
      [params.organizationId, params.evaluationId, params.athleteId, params.outcome, COACH_ID, params.evaluatedAt],
    );
  }

  test('returns the most recent evaluation per gate, not an arbitrary one', async () => {
    const client = await freshDatabase('ppbf_test_gate_summary_latest');
    activeClient = client;
    try {
      // Inserted out of chronological order on purpose -- if the SQL's ORDER
      // BY were missing or reversed, insertion order (not evaluated_at)
      // would silently determine which row "wins."
      await insertEvaluation(client, {
        evaluationId: 'eval-newer',
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        outcome: 'flagged',
        evaluatedAt: '2026-08-05T00:00:00Z',
      });
      await insertEvaluation(client, {
        evaluationId: 'eval-older',
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        outcome: 'passed',
        evaluatedAt: '2026-08-01T00:00:00Z',
      });

      const summary = await getGuardianGateSummary(ORG_A, ATHLETE_ID);
      const clearance = summary.find((row) => row.gate_key === 'contact_medical_clearance');
      expect(clearance?.outcome).toBe('flagged');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a gate with no evaluation for this athlete reads as not_evaluated, not a fabricated pass', async () => {
    const client = await freshDatabase('ppbf_test_gate_summary_unevaluated');
    activeClient = client;
    try {
      const summary = await getGuardianGateSummary(ORG_A, ATHLETE_ID);
      expect(summary.every((row) => row.outcome === 'not_evaluated')).toBe(true);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an evaluation on a different athlete never leaks into this one\'s summary', async () => {
    const client = await freshDatabase('ppbf_test_gate_summary_athlete_scope');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, 'ATH-GATE-OTHER', 'Other Athlete', '2012-01-01', 'fly', 'active', 'contact', true, $2, now(), now())`,
        [ORG_A, COACH_ID],
      );
      await insertEvaluation(client, {
        evaluationId: 'eval-other-athlete',
        organizationId: ORG_A,
        athleteId: 'ATH-GATE-OTHER',
        outcome: 'flagged',
        evaluatedAt: '2026-08-05T00:00:00Z',
      });

      const summary = await getGuardianGateSummary(ORG_A, ATHLETE_ID);
      expect(summary.find((row) => row.gate_key === 'contact_medical_clearance')?.outcome).toBe('not_evaluated');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an evaluation in a different organization never leaks into this one\'s summary', async () => {
    const client = await freshDatabase('ppbf_test_gate_summary_org_scope');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Cross-Org Athlete', '2012-01-01', 'fly', 'active', 'contact', true, $3, now(), now())`,
        [ORG_B, ATHLETE_ID, COACH_ID],
      );
      await insertEvaluation(client, {
        evaluationId: 'eval-other-org',
        organizationId: ORG_B,
        athleteId: ATHLETE_ID,
        outcome: 'flagged',
        evaluatedAt: '2026-08-05T00:00:00Z',
      });

      const summary = await getGuardianGateSummary(ORG_A, ATHLETE_ID);
      expect(summary.find((row) => row.gate_key === 'contact_medical_clearance')?.outcome).toBe('not_evaluated');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a deactivated gate is left out of the summary entirely', async () => {
    const client = await freshDatabase('ppbf_test_gate_summary_inactive');
    activeClient = client;
    try {
      await client.query(
        `update pilot.safety_gates set active_flag = false where organization_id = $1 and gate_key = 'training_hold'`,
        [ORG_A],
      );

      const summary = await getGuardianGateSummary(ORG_A, ATHLETE_ID);
      expect(summary.find((row) => row.gate_key === 'training_hold')).toBeUndefined();
      expect(summary.find((row) => row.gate_key === 'contact_medical_clearance')).toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
