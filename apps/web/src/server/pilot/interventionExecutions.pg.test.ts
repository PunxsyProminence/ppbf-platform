// Real PostgreSQL-backed contract test for the intervention-executions
// migration (module 026 slice 2), AND for the REAL module behavior on top
// of it: './db' is mocked to route into the embedded server (see
// trainingHolds.pg.test.ts for the same pattern), so startExecution,
// recordExecutionFacts, closeExecution, correctExecution, getExecution, and
// listExecutions below are the actual production functions executing their
// actual SQL against actual rows -- not the hand-written raw-SQL inserts
// the rest of this file uses to prove schema-level constraints.
//
// What needs proving that reading SQL cannot prove: the migration stacks
// cleanly on the decision-loop and protocols migrations and is a no-op on
// re-apply; PLANNED columns survive actual-fact updates untouched; one
// protocol/decision legally spans multiple executions; the adherence and
// context vocabularies, the named-deviations and stop-reason rules, and
// the correction lineage (reason required, one current record) are
// database facts; and the composite FKs make cross-org decision or athlete
// claims impossible, not merely unqueried. On top of that: startExecution's
// protocol-must-be-active and athlete-scoping checks, recordExecutionFacts's
// coalesce-only-in-progress semantics, and correctExecution's two-step
// supersession only exist in the TS module -- a raw-SQL test can prove the
// database allows the shape, never that the module itself enforces the rule.
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

import { listRetiredReviews, reviewOutcome } from './interventionEvidence';

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
  // correctExecution runs its two-step supersession inside withTransaction,
  // so the mock has to provide one -- without it the module throws
  // "withTransaction is not a function" before touching a row.
  //
  // It issues real BEGIN/COMMIT/ROLLBACK against the embedded server rather
  // than handing the callback a bare client. That is the whole point of the
  // function under test: the supersession is ONE act. A pass-through mock
  // would let a half-applied correction commit and still report success,
  // which is exactly the failure this suite exists to rule out.
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('begin');
    try {
      const result = await fn(activeClient);
      await activeClient.query('commit');
      return result;
    } catch (error) {
      await activeClient.query('rollback');
      throw error;
    }
  }),
}));

import {
  closeExecution,
  correctExecution,
  getExecution,
  listExecutions,
  recordExecutionFacts,
  startExecution,
} from './interventionExecutions';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-executions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_intervention_executions_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-intervention-executions-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-executions';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-executions-admin';
const COACH_ID = 'acct-executions-coach';
const OTHER_ADMIN_ID = 'acct-elsewhere-admin';
const ATHLETE_ID = 'ath-executions-1';
const OTHER_ATHLETE_ID = 'ath-elsewhere-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let evidenceSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let protocolsSql: string;
let decisionLoopSql: string;
let sessionScriptsSql: string;
let drillLibrarySql: string;
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
  await client.query(decisionLoopSql);
  await client.query(drillLibrarySql);
  await client.query(sessionScriptsSql);
  await client.query(protocolsSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft'),
            ($4, 'organization_admin', $5, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID, OTHER_ADMIN_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Executions Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now()),
            ($4, $5, 'Elsewhere Athlete', '2012-01-01', '100', 'active', 'contact', true, $6, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID, OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_ADMIN_ID],
  );
  await client.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
        intervention_description, intended_exposure, expected_outcome, created_by_account_id)
     values ($1, 'proto-1', 'proto-1', 1, 'Round-3 endurance block', 'fades in round 3',
             'aerobic capacity limits round 3 output', 'constrained 3-round intervals',
             '{"rounds": 6, "sessions": 2}'::jsonb, 'round-3 work rate holds', $2)`,
    [ORG_ID, ADMIN_ID],
  );
  return client;
}

async function insertDecision(client: Client, orgId: string, athleteId: string, accountId: string): Promise<string> {
  const result = await client.query(
    `insert into pilot.shadow_decisions
       (organization_id, athlete_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role)
     values ($1, $2, 'run the endurance block', 'round-3 holds', $3, 'coach')
     returning decision_id`,
    [orgId, athleteId, accountId],
  );
  return result.rows[0].decision_id as string;
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
  decisionLoopSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_decision_loop_migration.sql'), 'utf8');
  drillLibrarySql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_v3_migration.sql'), 'utf8');
  sessionScriptsSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_session_scripts_migration.sql'), 'utf8');
  protocolsSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_intervention_protocols_migration.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  evidenceSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_intervention_evidence_migration.sql'), 'utf8');

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

function insertExecution(client: Client, executionId: string, overrides: Record<string, string | number | null> = {}) {
  return client.query(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, supersedes_execution_id,
        athlete_id, decision_id, protocol_id, protocol_version, recorded_by_account_id,
        status, planned_exposure, actual_exposure, adherence, deviations,
        stop_change_reason, correction_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, '{"rounds": 6}'::jsonb, $11::jsonb, $12, $13, $14, $15)`,
    [
      overrides.organization_id ?? ORG_ID,
      executionId,
      overrides.lineage_id ?? executionId,
      overrides.version ?? 1,
      overrides.supersedes_execution_id ?? null,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.decision_id ?? null,
      overrides.protocol_id ?? 'proto-1',
      ADMIN_ID,
      overrides.status ?? 'in_progress',
      overrides.actual_exposure ?? '{}',
      overrides.adherence ?? 'unknown',
      overrides.deviations ?? '',
      overrides.stop_change_reason ?? '',
      overrides.correction_reason ?? '',
    ],
  );
}

describe('intervention executions migration', () => {
  test('stacks on the decision-loop and protocols migrations; a decision-linked v1 execution lands; re-apply is a no-op', async () => {
    const client = await freshDatabase('executions_fresh');
    try {
      await client.query(migrationSql);
      const decisionId = await insertDecision(client, ORG_ID, ATHLETE_ID, ADMIN_ID);
      await insertExecution(client, 'exec-1', { decision_id: decisionId });

      await client.query(migrationSql);

      const rows = await client.query(
        `select execution_id, status, adherence, planned_exposure from pilot.intervention_executions where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{
        execution_id: 'exec-1',
        status: 'in_progress',
        adherence: 'unknown',
        planned_exposure: { rounds: 6 },
      }]);
    } finally {
      await client.end();
    }
  });

  test('planned facts survive deviation untouched, and one protocol/decision spans multiple executions', async () => {
    const client = await freshDatabase('executions_planned');
    try {
      await client.query(migrationSql);
      const decisionId = await insertDecision(client, ORG_ID, ATHLETE_ID, ADMIN_ID);
      await insertExecution(client, 'exec-1', { decision_id: decisionId });
      // A second execution against the same protocol AND decision is legal:
      // interventions span sessions.
      await insertExecution(client, 'exec-2', { decision_id: decisionId });

      // Execution deviates: actual differs from planned. Only actual moves.
      await client.query(
        `update pilot.intervention_executions
         set actual_exposure = '{"rounds": 3}'::jsonb, adherence = 'under_delivered',
             deviations = 'cut to 3 rounds -- athlete gassed'
         where organization_id = $1 and execution_id = 'exec-1'`,
        [ORG_ID],
      );

      const row = await client.query(
        `select planned_exposure, actual_exposure, adherence from pilot.intervention_executions
         where organization_id = $1 and execution_id = 'exec-1'`,
        [ORG_ID],
      );
      expect(row.rows[0]).toEqual({
        planned_exposure: { rounds: 6 },
        actual_exposure: { rounds: 3 },
        adherence: 'under_delivered',
      });
    } finally {
      await client.end();
    }
  });

  test('adherence honesty is structural: unknown vocab, unnamed deviations, and silent stops are refused', async () => {
    const client = await freshDatabase('executions_adherence');
    try {
      await client.query(migrationSql);

      // A percentage is not an adherence state.
      await expect(insertExecution(client, 'exec-pct', { adherence: '82%' }))
        .rejects.toMatchObject({ code: '23514' });
      // Claimed deviations must be named.
      await expect(insertExecution(client, 'exec-dev', { adherence: 'delivered_with_deviations' }))
        .rejects.toMatchObject({ code: '23514' });
      // A stop must say why.
      await expect(insertExecution(client, 'exec-stop', { status: 'stopped' }))
        .rejects.toMatchObject({ code: '23514' });
      // The same claims with their reasons land.
      await insertExecution(client, 'exec-ok', {
        adherence: 'delivered_with_deviations',
        deviations: 'swapped bag work for pads',
        status: 'stopped',
        stop_change_reason: 'equipment failure',
      });
    } finally {
      await client.end();
    }
  });

  test('corrections are supersession with a stated reason, and history is preserved', async () => {
    const client = await freshDatabase('executions_corrections');
    try {
      await client.query(migrationSql);
      await insertExecution(client, 'exec-1', { actual_exposure: '{"rounds": 5}' });

      // A correction without a reason is a rewrite: refused.
      await expect(insertExecution(client, 'exec-bad', {
        lineage_id: 'exec-1', version: 2, supersedes_execution_id: 'exec-1', status: 'superseded',
      })).rejects.toMatchObject({ code: '23514' });
      // Lineage shape holds in both directions.
      await expect(insertExecution(client, 'exec-headless', { lineage_id: 'exec-1', version: 2, correction_reason: 'typo' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertExecution(client, 'exec-v1-super', { supersedes_execution_id: 'exec-1', correction_reason: 'typo' }))
        .rejects.toMatchObject({ code: '23514' });
      // A second CURRENT record in one lineage is refused by the partial index.
      await expect(insertExecution(client, 'exec-second-current', {
        lineage_id: 'exec-1', version: 2, supersedes_execution_id: 'exec-1', correction_reason: 'typo',
      })).rejects.toMatchObject({ code: '23505' });

      // The legal path: correction born superseded, original stamped, correction current.
      await insertExecution(client, 'exec-v2', {
        lineage_id: 'exec-1', version: 2, supersedes_execution_id: 'exec-1',
        status: 'superseded', actual_exposure: '{"rounds": 4}', correction_reason: 'miscounted rounds',
      });
      await client.query(
        `update pilot.intervention_executions set status = 'superseded' where organization_id = $1 and execution_id = 'exec-1'`,
        [ORG_ID],
      );
      await client.query(
        `update pilot.intervention_executions set status = 'in_progress' where organization_id = $1 and execution_id = 'exec-v2'`,
        [ORG_ID],
      );

      // The original keeps its values forever.
      const original = await client.query(
        `select status, actual_exposure from pilot.intervention_executions where organization_id = $1 and execution_id = 'exec-1'`,
        [ORG_ID],
      );
      expect(original.rows[0]).toEqual({ status: 'superseded', actual_exposure: { rounds: 5 } });
    } finally {
      await client.end();
    }
  });

  test('cross-org claims are impossible: another org\'s decision and athlete are both refused by composite FK', async () => {
    const client = await freshDatabase('executions_tenancy');
    try {
      await client.query(migrationSql);
      const foreignDecision = await insertDecision(client, OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_ADMIN_ID);

      await expect(insertExecution(client, 'exec-foreign-decision', { decision_id: foreignDecision }))
        .rejects.toMatchObject({ code: '23503' });
      await expect(insertExecution(client, 'exec-foreign-athlete', { athlete_id: OTHER_ATHLETE_ID }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});

// The tests above prove the migration's schema. These prove the module:
// startExecution's protocol-active/athlete-scoping/hidden-not-found checks,
// recordExecutionFacts's coalesce-only-in-progress semantics,
// closeExecution's stop-reason requirement, correctExecution's two-step
// supersession, and getExecution/listExecutions's tenancy and join
// behavior -- none of which a raw-SQL insert can exercise, because none of
// it is a database constraint.
describe('the real intervention-execution lifecycle against real rows', () => {
  test('startExecution snapshots the protocol plan into a v1 row; getExecution and listExecutions surface it joined', async () => {
    const client = await freshDatabase('executions_start_snapshot');
    activeClient = client;
    try {
      await client.query(migrationSql);

      const started = await startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      });

      expect(started).toMatchObject({
        version: 1,
        status: 'in_progress',
        athlete_name: 'Executions Athlete',
        protocol_title: 'Round-3 endurance block',
        planned_exposure: { rounds: 6, sessions: 2 },
        // The seeded 'proto-1' protocol never sets intended_task_context,
        // so it carries the column default -- not the intervention
        // description text, which is a separate column.
        planned_task_context: '',
      });

      await expect(getExecution(ORG_ID, started!.execution_id)).resolves.toMatchObject({
        execution_id: started!.execution_id,
      });

      const all = await listExecutions(ORG_ID);
      expect(all.map((row) => row.execution_id)).toContain(started!.execution_id);
      const forAthlete = await listExecutions(ORG_ID, ATHLETE_ID);
      expect(forAthlete.map((row) => row.execution_id)).toContain(started!.execution_id);
    } finally {
      await client.end();
    }
  });

  test('startExecution refuses a non-active protocol, and a protocol scoped to a different athlete', async () => {
    const client = await freshDatabase('executions_start_refusals');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const OTHER_LOCAL_ATHLETE = 'ath-executions-2';
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Second Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
        [ORG_ID, OTHER_LOCAL_ATHLETE, COACH_ID],
      );
      await client.query(
        `insert into pilot.intervention_protocols
           (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
            intervention_description, expected_outcome, status, created_by_account_id)
         values ($1, 'proto-retired', 'proto-retired', 1, 'Old block', 'x', 'x', 'x', 'x', 'retired', $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await client.query(
        `insert into pilot.intervention_protocols
           (organization_id, protocol_id, lineage_id, version, athlete_id, title, target_problem, hypothesis,
            intervention_description, expected_outcome, created_by_account_id)
         values ($1, 'proto-scoped', 'proto-scoped', 1, $2, 'Scoped block', 'x', 'x', 'x', 'x', $3)`,
        [ORG_ID, OTHER_LOCAL_ATHLETE, ADMIN_ID],
      );

      await expect(startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-retired',
        recordedByAccountId: ADMIN_ID,
      })).resolves.toBeNull();

      await expect(startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-scoped',
        recordedByAccountId: ADMIN_ID,
      })).resolves.toBeNull();

      // The athlete it IS scoped to may still use it.
      await expect(startExecution({
        organizationId: ORG_ID,
        athleteId: OTHER_LOCAL_ATHLETE,
        protocolId: 'proto-scoped',
        recordedByAccountId: ADMIN_ID,
      })).resolves.toMatchObject({ protocol_id: 'proto-scoped' });
    } finally {
      await client.end();
    }
  });

  test('startExecution hides cross-tenant reality as not-found: unknown athlete, and a decision from another org', async () => {
    const client = await freshDatabase('executions_start_hidden_not_found');
    activeClient = client;
    try {
      await client.query(migrationSql);

      await expect(startExecution({
        organizationId: ORG_ID,
        athleteId: 'no-such-athlete',
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      })).resolves.toBeNull();

      const foreignDecision = await insertDecision(client, OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_ADMIN_ID);
      await expect(startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        decisionId: foreignDecision,
        recordedByAccountId: ADMIN_ID,
      })).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('recordExecutionFacts only touches fields it was given, only on an in-progress row', async () => {
    const client = await freshDatabase('executions_record_facts');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const started = await startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      });
      const executionId = started!.execution_id;

      const firstUpdate = await recordExecutionFacts({
        organizationId: ORG_ID,
        executionId,
        actualExposure: { rounds: 3 },
        adherence: 'under_delivered',
      });
      expect(firstUpdate).toMatchObject({
        actual_exposure: { rounds: 3 },
        adherence: 'under_delivered',
        trained_context: 'unknown', // untouched: coalesce, not overwrite
      });

      // A second, narrower update must not clobber what the first one set.
      const secondUpdate = await recordExecutionFacts({
        organizationId: ORG_ID,
        executionId,
        notes: 'checked in mid-block',
      });
      expect(secondUpdate).toMatchObject({
        actual_exposure: { rounds: 3 },
        adherence: 'under_delivered',
        notes: 'checked in mid-block',
      });

      await client.query(
        `update pilot.intervention_executions set status = 'completed' where organization_id = $1 and execution_id = $2`,
        [ORG_ID, executionId],
      );
      await expect(recordExecutionFacts({ organizationId: ORG_ID, executionId, notes: 'too late' })).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('closeExecution enforces the stop-reason rule, records final facts, and is a no-op once already closed', async () => {
    const client = await freshDatabase('executions_close');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const started = await startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      });
      const executionId = started!.execution_id;

      await expect(closeExecution({
        organizationId: ORG_ID,
        executionId,
        outcome: 'stopped',
      })).rejects.toThrow(/stop_reason|check constraint/i);

      const closed = await closeExecution({
        organizationId: ORG_ID,
        executionId,
        outcome: 'completed',
        notes: 'finished the block',
      });
      expect(closed).toMatchObject({ status: 'completed', notes: 'finished the block' });

      // Already closed: the guarded UPDATE's status = 'in_progress' predicate
      // matches nothing, so this is a quiet null, not an error or a second
      // close.
      await expect(closeExecution({
        organizationId: ORG_ID,
        executionId,
        outcome: 'stopped',
        stopChangeReason: 'too late anyway',
      })).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('correctExecution supersedes with a stated reason: the original keeps its values, the correction becomes current', async () => {
    const client = await freshDatabase('executions_correct');
    activeClient = client;
    try {
      await client.query(migrationSql);
      // correctExecution carries the execution's evidence links and outcome
      // reviews onto the new version, so the tables they live in must exist.
      await client.query(evidenceSql);
      const started = await startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      });
      const originalId = started!.execution_id;
      await recordExecutionFacts({
        organizationId: ORG_ID,
        executionId: originalId,
        actualExposure: { rounds: 5 },
        adherence: 'delivered_as_planned',
      });

      // What hangs off the record before it is corrected: one live link, one
      // link already removed, and a verdict that superseded an earlier one.
      await client.query(
        `insert into pilot.intervention_evidence_links
           (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, status, removed_reason, linked_by_account_id)
         values ($1, 'link-live', $2, 'baseline', 'training_attempt', 'att-1', 'active', '', $3),
                ($1, 'link-struck', $2, 'retention', 'training_attempt', 'att-2', 'removed', 'wrong drill', $3)`,
        [ORG_ID, originalId, COACH_ID],
      );
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, supersedes_review_id, performance_result,
            performance_notes, hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-old', $2, null, 'unknown', 'too early to say', 'unresolved', 'unresolved', 'superseded', $3)`,
        [ORG_ID, originalId, COACH_ID],
      );
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, supersedes_review_id, performance_result,
            performance_notes, hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-new', $2, 'rev-old', 'improved', 'held through the third', 'supported',
                 'prior_belief_strengthened', 'active', $3)`,
        [ORG_ID, originalId, COACH_ID],
      );

      // Two bystanders that must NOT move. One is another execution in the
      // same gym. The other is an execution in ANOTHER gym that happens to
      // carry the same execution_id (the key is the pair, so it can).
      await insertExecution(client, 'exec-bystander');
      await client.query(
        `insert into pilot.intervention_protocols
           (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
            intervention_description, expected_outcome, created_by_account_id)
         values ($1, 'proto-1', 'proto-1', 1, 'Elsewhere block', 'p', 'h', 'i', 'e', $2)`,
        [OTHER_ORG_ID, OTHER_ADMIN_ID],
      );
      await insertExecution(client, originalId, { organization_id: OTHER_ORG_ID, athlete_id: OTHER_ATHLETE_ID });
      await client.query(
        `insert into pilot.intervention_evidence_links
           (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, linked_by_account_id)
         values ($1, 'link-bystander', 'exec-bystander', 'baseline', 'training_attempt', 'att-1', $2),
                ($3, 'link-elsewhere', $4, 'baseline', 'training_attempt', 'att-9', $5)`,
        [ORG_ID, COACH_ID, OTHER_ORG_ID, originalId, OTHER_ADMIN_ID],
      );
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, performance_result, performance_notes,
            hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-bystander', 'exec-bystander', 'unknown', 'not this one', 'unresolved', 'unresolved', 'active', $2),
                ($3, 'rev-elsewhere', $4, 'unknown', 'not this gym', 'unresolved', 'unresolved', 'active', $5)`,
        [ORG_ID, COACH_ID, OTHER_ORG_ID, originalId, OTHER_ADMIN_ID],
      );

      const attached = async () => ({
        links: (await client.query(
          `select * from pilot.intervention_evidence_links order by organization_id, link_id`,
        )).rows as Array<Record<string, unknown>>,
        reviews: (await client.query(
          `select * from pilot.intervention_outcome_reviews order by organization_id, review_id`,
        )).rows as Array<Record<string, unknown>>,
      });
      const before = await attached();

      const corrected = await correctExecution({
        organizationId: ORG_ID,
        executionId: originalId,
        correctionReason: 'miscounted rounds during the session',
        actualExposure: { rounds: 4 },
        adherence: 'under_delivered',
        correctedByAccountId: COACH_ID,
      });

      expect(corrected).toMatchObject({
        version: 2,
        supersedes_execution_id: originalId,
        status: 'in_progress',
        actual_exposure: { rounds: 4 },
        adherence: 'under_delivered',
        planned_exposure: { rounds: 6, sessions: 2 }, // carried from the original, untouched
      });

      // The original is untouched history, not overwritten.
      await expect(getExecution(ORG_ID, originalId)).resolves.toMatchObject({
        status: 'superseded',
        actual_exposure: { rounds: 5 },
        adherence: 'delivered_as_planned',
      });

      // Only the current record shows up in a listing.
      const current = await listExecutions(ORG_ID, ATHLETE_ID);
      expect(current.map((row) => row.execution_id)).toContain(corrected!.execution_id);
      expect(current.map((row) => row.execution_id)).not.toContain(originalId);

      // The evidence and the reviews came with it: all four rows now hang
      // off the correction, and nothing about them changed but that pointer.
      // The bystanders -- the other execution, and the other gym's execution
      // of the same id -- are exactly as they were.
      const moved = await attached();
      const repointed = (rows: Array<Record<string, unknown>>) => rows.map((row) => (
        row.organization_id === ORG_ID && row.execution_id === originalId
          ? { ...row, execution_id: corrected!.execution_id }
          : row
      ));
      expect(before.links.map((row) => [row.link_id, row.execution_id])).toEqual([
        ['link-elsewhere', originalId],
        ['link-bystander', 'exec-bystander'],
        ['link-live', originalId],
        ['link-struck', originalId],
      ]);
      expect(moved.links).toEqual(repointed(before.links));
      expect(moved.reviews).toEqual(repointed(before.reviews));
      expect(moved.links.map((row) => [row.link_id, row.execution_id])).toEqual([
        ['link-elsewhere', originalId],
        ['link-bystander', 'exec-bystander'],
        ['link-live', corrected!.execution_id],
        ['link-struck', corrected!.execution_id],
      ]);

      // A superseded record cannot itself be corrected again -- and the
      // refusal leaves the evidence where the correction put it.
      await expect(correctExecution({
        organizationId: ORG_ID,
        executionId: originalId,
        correctionReason: 'trying to correct history itself',
        correctedByAccountId: COACH_ID,
      })).resolves.toBeNull();
      expect(await attached()).toEqual(moved);
    } finally {
      await client.end();
    }
  });

  // Issue #1481 (Jason, 2026-10-12: "6B"): reopening a reviewed record is
  // allowed, and its standing verdict is retired to history -- the same stamp a
  // re-review gives a verdict it replaces. This replaces the refusal PR #1472
  // added. Nothing else about corrections changes.
  test('a closed, reviewed execution reopens; its verdict is retired to history, evidence stays, and a fresh review is the one verdict', async () => {
    const client = await freshDatabase('executions_reopen');
    activeClient = client;
    try {
      await client.query(migrationSql);
      await client.query(evidenceSql);

      // Closed and reviewed, with a piece of evidence on it.
      await insertExecution(client, 'exec-reviewed', { status: 'completed' });
      await client.query(
        `update pilot.intervention_executions set actual_start = '2026-09-01T09:00:00Z', actual_end = '2026-09-01T10:00:00Z'
         where execution_id = 'exec-reviewed'`,
      );
      await client.query(
        `insert into pilot.intervention_evidence_links
           (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, linked_by_account_id)
         values ($1, 'link-reviewed', 'exec-reviewed', 'baseline', 'training_attempt', 'att-1', $2)`,
        [ORG_ID, COACH_ID],
      );
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, performance_result, performance_notes,
            hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-standing', 'exec-reviewed', 'improved', 'held through the third', 'supported',
                 'prior_belief_strengthened', 'active', $2)`,
        [ORG_ID, COACH_ID],
      );
      // Closed, and nobody has reviewed it.
      await insertExecution(client, 'exec-unreviewed', { status: 'completed' });
      // Closed, and its only review has itself been superseded: no verdict stands.
      await insertExecution(client, 'exec-withdrawn', { status: 'completed' });
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, performance_result, performance_notes,
            hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-withdrawn', 'exec-withdrawn', 'unknown', 'too early', 'unresolved', 'unresolved', 'superseded', $2)`,
        [ORG_ID, COACH_ID],
      );

      const everything = async () => ({
        executions: (await client.query(`select * from pilot.intervention_executions order by organization_id, execution_id`)).rows,
        links: (await client.query(`select * from pilot.intervention_evidence_links order by organization_id, link_id`)).rows,
        reviews: (await client.query(`select * from pilot.intervention_outcome_reviews order by organization_id, review_id`)).rows,
      });
      // Corrected and KEPT closed: the review and the evidence come with it, unchanged.
      const kept = await correctExecution({
        organizationId: ORG_ID,
        executionId: 'exec-reviewed',
        correctionReason: 'it was stopped, not completed',
        outcome: 'stopped',
        stopChangeReason: 'shoulder tightened in round four',
        correctedByAccountId: COACH_ID,
      });
      expect(kept).toMatchObject({ version: 2, status: 'stopped' });
      const carried = await everything();
      expect(carried.reviews.find((row) => row.review_id === 'rev-standing'))
        .toMatchObject({ execution_id: kept!.execution_id, status: 'active' });
      expect(carried.links.find((row) => row.link_id === 'link-reviewed'))
        .toMatchObject({ execution_id: kept!.execution_id });

      // REOPENED: the correction succeeds, in one act.
      const reopened = await correctExecution({
        organizationId: ORG_ID,
        executionId: kept!.execution_id,
        correctionReason: 'it had not actually finished',
        outcome: 'in_progress',
        correctedByAccountId: COACH_ID,
      });
      expect(reopened).toMatchObject({ version: 3, status: 'in_progress' });
      // Unfinished work has no end time (Codex P2 on #1507): the closed
      // record's end does not ride along into the reopened one.
      expect(reopened!.actual_end).toBeNull();
      const afterReopen = await everything();
      // The verdict is retired, not deleted: still there, on the current
      // record, with its reviewer, its notes and a retirement time.
      const retired = afterReopen.reviews.find((row) => row.review_id === 'rev-standing');
      expect(retired).toMatchObject({
        execution_id: reopened!.execution_id,
        status: 'superseded',
        reviewed_by_account_id: COACH_ID,
        performance_notes: 'held through the third',
      });
      expect(new Date(retired!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(retired!.reviewed_at).getTime());
      // No verdict stands on the in-progress record.
      expect(afterReopen.reviews.filter((row) => row.execution_id === reopened!.execution_id && row.status === 'active')).toEqual([]);
      // The evidence is still attached to the record.
      expect(afterReopen.links.find((row) => row.link_id === 'link-reviewed'))
        .toMatchObject({ execution_id: reopened!.execution_id });
      // History reads it as retired on reopening (no later review names it).
      const history = await listRetiredReviews(ORG_ID, reopened!.execution_id);
      expect(history.map((row) => [row.review_id, row.retired_on_reopen])).toEqual([['rev-standing', true]]);

      // CLOSED AGAIN and reviewed afresh: exactly one active verdict, which
      // supersedes nothing (the retired one stays retired on reopening).
      const closedAgain = await closeExecution({
        organizationId: ORG_ID,
        executionId: reopened!.execution_id,
        outcome: 'completed',
      });
      expect(closedAgain).toMatchObject({ status: 'completed' });
      // Closed again, it carries the new close time, not the old one.
      expect(closedAgain!.actual_end).not.toBeNull();
      expect(new Date(closedAgain!.actual_end!).getTime()).toBeGreaterThan(new Date('2026-09-01T10:00:00Z').getTime());
      const fresh = await reviewOutcome({
        organizationId: ORG_ID,
        executionId: reopened!.execution_id,
        performanceResult: 'improved',
        performanceNotes: 'held through all four rounds this time',
        hypothesisResult: 'supported',
        learningSignal: 'prior_belief_strengthened',
        reviewedByAccountId: COACH_ID,
      });
      expect(fresh).toMatchObject({ status: 'active', supersedes_review_id: null });
      const final = await everything();
      expect(final.reviews.filter((row) => row.status === 'active' && row.execution_id === reopened!.execution_id)
        .map((row) => row.review_id)).toEqual([fresh!.review_id]);
      expect((await listRetiredReviews(ORG_ID, reopened!.execution_id)).map((row) => row.review_id)).toEqual(['rev-standing']);

      // A record nobody reviewed, and one whose only review was itself
      // superseded, reopen as they always did. An already-superseded verdict
      // keeps its own retirement time: the reopen does not re-stamp it.
      const withdrawnStamp = async () => (await client.query(
        `select status, updated_at from pilot.intervention_outcome_reviews where organization_id = $1 and review_id = 'rev-withdrawn'`,
        [ORG_ID],
      )).rows;
      const withdrawnBefore = await withdrawnStamp();
      expect(withdrawnBefore).toHaveLength(1);
      await client.query('select pg_sleep(0.01)');
      for (const executionId of ['exec-unreviewed', 'exec-withdrawn']) {
        await expect(correctExecution({
          organizationId: ORG_ID,
          executionId,
          correctionReason: 'it had not actually finished',
          outcome: 'in_progress',
          correctedByAccountId: COACH_ID,
        })).resolves.toMatchObject({ version: 2, status: 'in_progress' });
      }
      expect(await withdrawnStamp()).toEqual(withdrawnBefore);

      // A correction that does not reopen leaves a review alone. A record that
      // is in progress and somehow already carries a review (nothing writes
      // that today; the database allows it) has its facts corrected and the
      // review untouched.
      await insertExecution(client, 'exec-odd');
      await client.query(
        `insert into pilot.intervention_outcome_reviews
           (organization_id, review_id, execution_id, performance_result, performance_notes,
            hypothesis_result, learning_signal, status, reviewed_by_account_id)
         values ($1, 'rev-odd', 'exec-odd', 'unknown', 'reviewed early', 'unresolved', 'unresolved', 'active', $2)`,
        [ORG_ID, COACH_ID],
      );
      const odd = await correctExecution({
        organizationId: ORG_ID,
        executionId: 'exec-odd',
        correctionReason: 'wrong round count',
        actualExposure: { rounds: 4 },
        correctedByAccountId: COACH_ID,
      });
      expect(odd).toMatchObject({ version: 2, status: 'in_progress', actual_exposure: { rounds: 4 } });
      const oddReview = await client.query(
        `select execution_id, status from pilot.intervention_outcome_reviews where organization_id = $1 and review_id = 'rev-odd'`,
        [ORG_ID],
      );
      expect(oddReview.rows).toEqual([{ execution_id: odd!.execution_id, status: 'active' }]);
    } finally {
      await client.end();
    }
  });

  test('getExecution and listExecutions never surface another organization\'s execution', async () => {
    const client = await freshDatabase('executions_tenancy_reads');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const started = await startExecution({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        protocolId: 'proto-1',
        recordedByAccountId: ADMIN_ID,
      });

      await expect(getExecution(OTHER_ORG_ID, started!.execution_id)).resolves.toBeNull();
      const otherOrgListing = await listExecutions(OTHER_ORG_ID);
      expect(otherOrgListing.map((row) => row.execution_id)).not.toContain(started!.execution_id);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-intervention-executions-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('intervention executions runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('intex_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /INTERVENTION_EXECUTIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('intex_rdy_ok');
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
