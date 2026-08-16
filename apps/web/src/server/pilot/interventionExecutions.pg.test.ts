// Real PostgreSQL-backed contract test for the intervention-executions
// migration (module 026 slice 2).
//
// What needs proving that reading SQL cannot prove: the migration stacks
// cleanly on the decision-loop and protocols migrations and is a no-op on
// re-apply; PLANNED columns survive actual-fact updates untouched; one
// protocol/decision legally spans multiple executions; the adherence and
// context vocabularies, the named-deviations and stop-reason rules, and
// the correction lineage (reason required, one current record) are
// database facts; and the composite FKs make cross-org decision or athlete
// claims impossible, not merely unqueried.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-executions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_intervention_executions_migration.sql';

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
