// Real PostgreSQL-backed contract test for the safety flags / return-to-
// training migration (pilot.safety_flags, pilot.v_flag_calibration,
// pilot.return_to_training_plans, pilot.return_to_training_steps) and for
// safetyFlags.ts's functions running against a real transaction.
//
// Six things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_safety_flags_external_not_bypassed actually holds: an
//    external_rule flag cannot be resolved with status='bypassed', at the
//    database level, not just in application code.
// 2. pilot_safety_flags_note_required holds: a resolution note under 10
//    characters is rejected; 10+ with a resolver and a timestamp passes.
// 3. pilot_safety_flags_medical_human_only holds: a medical-vocabulary
//    flag_code (concussion_rest_period) raised with
//    triggered_by='shadow_inference' is rejected -- SHADOW may not raise a
//    medical flag.
// 4. pilot_rtt_steps_advance holds: advanced_at set without an
//    advancement_note (or vice versa) is rejected.
// 5. v_flag_calibration computes a real false-positive percentage from
//    real rows, not a hand-coded value.
// 6. The readiness check actually fails when the migration did not land.
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

import {
  addReturnToTrainingStep,
  advanceReturnToTrainingStep,
  createReturnToTrainingPlan,
  getFlagCalibration,
  raiseSafetyFlag,
  resolveSafetyFlag,
} from './safetyFlags';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-safety-flags-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_safety_flags_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-safety-flags-migration.mjs',
);

const ORG_A = 'org-safetyflags-a';
const ATHLETE_A = 'athlete-safetyflags-a';
const COACH_A = 'acct-safetyflags-coach-a';

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
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1,$2,'Athlete A','2010-01-01','120lb','active','Contact',true,$3,now(),now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, COACH_A],
  );

  activeClient = client;
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
});

describe('safety flags migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SAFETY_FLAGS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.safety_flags') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_safety_flags_note_required', 'pilot_safety_flags_external_not_bypassed',
                            'pilot_safety_flags_medical_human_only', 'pilot_rtt_steps_advance')`,
      );
      expect(constraints.rows[0].n).toBe(4);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_safety_flags_medical_human_only', () => {
  test('a medical-vocabulary flag_code raised by shadow_inference is rejected', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_medical_human_only');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        raiseSafetyFlag({
          organizationId: ORG_A,
          athleteId: ATHLETE_A,
          flagClass: 'external_rule',
          flagCode: 'concussion_rest_period',
          triggeredBy: 'shadow_inference',
        }),
      ).rejects.toThrow('SAFETY_FLAG_MEDICAL_CODE_REQUIRES_HUMAN_ENTRY');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a medical-vocabulary flag_code raised by human_entry is accepted', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_medical_human_entry_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const flag = await raiseSafetyFlag({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        flagClass: 'external_rule',
        flagCode: 'concussion_rest_period',
        triggeredBy: 'human_entry',
      });
      expect(flag.triggered_by).toBe('human_entry');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_safety_flags_external_not_bypassed', () => {
  test('an external_rule flag resolved with status=bypassed is rejected', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_external_no_bypass');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const flag = await raiseSafetyFlag({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        flagClass: 'external_rule',
        flagCode: 'clearance_expired',
        triggeredBy: 'rule_evaluation',
      });

      await expect(
        resolveSafetyFlag({
          organizationId: ORG_A,
          flagId: flag.flag_id,
          status: 'bypassed',
          resolution: 'acted_on',
          coachNote: 'Attempting to bypass an external constraint.',
          resolvedByAccountId: COACH_A,
          resolvedByRole: 'coach',
        }),
      ).rejects.toThrow('SAFETY_FLAG_EXTERNAL_RULE_CANNOT_BYPASS');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an external_rule flag resolved with status=acknowledged is accepted', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_external_ack_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const flag = await raiseSafetyFlag({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        flagClass: 'external_rule',
        flagCode: 'clearance_expired',
        triggeredBy: 'rule_evaluation',
      });

      const resolved = await resolveSafetyFlag({
        organizationId: ORG_A,
        flagId: flag.flag_id,
        status: 'acknowledged',
        resolution: 'acknowledged_external_constraint',
        coachNote: 'Confirmed clearance is expired, athlete held pending renewal.',
        resolvedByAccountId: COACH_A,
        resolvedByRole: 'coach',
      });
      expect(resolved.status).toBe('acknowledged');
      expect(resolved.resolved_by_account_id).toBe(COACH_A);
      expect(resolved.resolved_at).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_safety_flags_note_required', () => {
  test('resolving with a note under 10 characters is rejected', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_note_too_short');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const flag = await raiseSafetyFlag({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        flagClass: 'system_guidance',
        flagCode: 'load_spike',
        triggeredBy: 'shadow_inference',
      });

      await expect(
        resolveSafetyFlag({
          organizationId: ORG_A,
          flagId: flag.flag_id,
          status: 'acknowledged',
          resolution: 'false_positive',
          coachNote: 'short',
          resolvedByAccountId: COACH_A,
          resolvedByRole: 'coach',
        }),
      ).rejects.toThrow('SAFETY_FLAG_NOTE_TOO_SHORT');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('resolving with a 10+ character note, resolver and timestamp passes', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_note_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const flag = await raiseSafetyFlag({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        flagClass: 'system_guidance',
        flagCode: 'load_spike',
        triggeredBy: 'shadow_inference',
      });

      const resolved = await resolveSafetyFlag({
        organizationId: ORG_A,
        flagId: flag.flag_id,
        status: 'acknowledged',
        resolution: 'false_positive',
        coachNote: 'Reviewed the week -- load was normal, sensor miscount.',
        resolvedByAccountId: COACH_A,
        resolvedByRole: 'coach',
      });
      expect(resolved.coach_note).toBe('Reviewed the week -- load was normal, sensor miscount.');
      expect(resolved.resolved_by_account_id).toBe(COACH_A);
      expect(resolved.resolved_at).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_flag_calibration', () => {
  test('computes a real false-positive percentage from real rows', async () => {
    const client = await freshDatabase('ppbf_test_safetyflags_calibration');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const flag1 = await raiseSafetyFlag({
        organizationId: ORG_A, athleteId: ATHLETE_A, flagClass: 'system_guidance',
        flagCode: 'load_spike', triggeredBy: 'shadow_inference',
      });
      const flag2 = await raiseSafetyFlag({
        organizationId: ORG_A, athleteId: ATHLETE_A, flagClass: 'system_guidance',
        flagCode: 'load_spike', triggeredBy: 'shadow_inference',
      });
      await raiseSafetyFlag({
        organizationId: ORG_A, athleteId: ATHLETE_A, flagClass: 'system_guidance',
        flagCode: 'load_spike', triggeredBy: 'shadow_inference',
      });

      await resolveSafetyFlag({
        organizationId: ORG_A, flagId: flag1.flag_id, status: 'acknowledged', resolution: 'false_positive',
        coachNote: 'False alarm, load was fine that week.', resolvedByAccountId: COACH_A, resolvedByRole: 'coach',
      });
      await resolveSafetyFlag({
        organizationId: ORG_A, flagId: flag2.flag_id, status: 'acknowledged', resolution: 'acted_on',
        coachNote: 'Real spike, reduced volume that week.', resolvedByAccountId: COACH_A, resolvedByRole: 'coach',
      });

      const calibration = await getFlagCalibration(ORG_A);
      const row = calibration.find((r) => r.flag_code === 'load_spike');
      expect(row).toBeDefined();
      expect(row?.total_raised).toBe(3);
      expect(row?.called_false_positive).toBe(1);
      expect(row?.acted_on).toBe(1);
      expect(row?.still_open).toBe(1);
      expect(row?.false_positive_pct).toBe('50.0');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_rtt_steps_advance', () => {
  test('a step advanced without an advancement note is rejected', async () => {
    const client = await freshDatabase('ppbf_test_rtt_advance_note_required');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const plan = await createReturnToTrainingPlan({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        triggeringEvent: 'confirmed_concussion',
        eventDate: '2026-08-01',
        authoritySource: 'USA Boxing rulebook rest period',
        restPeriodDays: 14,
        earliestReturnDate: '2026-08-15',
        enteredByAccountId: COACH_A,
        enteredByRole: 'coach',
      });
      const step = await addReturnToTrainingStep({
        organizationId: ORG_A,
        planId: plan.plan_id,
        weekNumber: 1,
        intensityLabel: 'Technical only, no contact.',
        permittedContact: 'light_technical',
      });

      await expect(
        client.query(
          `update pilot.return_to_training_steps
             set advanced_by_account_id = $3, advanced_at = now()
           where organization_id = $1 and step_id = $2`,
          [ORG_A, step.step_id, COACH_A],
        ),
      ).rejects.toThrow(/pilot_rtt_steps_advance/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('advanceReturnToTrainingStep refuses a note under 10 characters', async () => {
    const client = await freshDatabase('ppbf_test_rtt_advance_note_too_short');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const plan = await createReturnToTrainingPlan({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        triggeringEvent: 'confirmed_concussion',
        eventDate: '2026-08-01',
        authoritySource: 'USA Boxing rulebook rest period',
        enteredByAccountId: COACH_A,
        enteredByRole: 'coach',
      });
      const step = await addReturnToTrainingStep({
        organizationId: ORG_A,
        planId: plan.plan_id,
        weekNumber: 1,
        intensityLabel: 'Technical only, no contact.',
      });

      await expect(
        advanceReturnToTrainingStep({
          organizationId: ORG_A,
          stepId: step.step_id,
          advancedByAccountId: COACH_A,
          advancementNote: 'ok',
        }),
      ).rejects.toThrow('RTT_STEP_ADVANCEMENT_NOTE_REQUIRED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('advanceReturnToTrainingStep with a real note stamps advanced_by and advanced_at together', async () => {
    const client = await freshDatabase('ppbf_test_rtt_advance_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const plan = await createReturnToTrainingPlan({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        triggeringEvent: 'confirmed_concussion',
        eventDate: '2026-08-01',
        authoritySource: 'USA Boxing rulebook rest period',
        enteredByAccountId: COACH_A,
        enteredByRole: 'coach',
      });
      const step = await addReturnToTrainingStep({
        organizationId: ORG_A,
        planId: plan.plan_id,
        weekNumber: 1,
        intensityLabel: 'Technical only, no contact.',
      });

      const advanced = await advanceReturnToTrainingStep({
        organizationId: ORG_A,
        stepId: step.step_id,
        advancedByAccountId: COACH_A,
        advancementNote: 'Athlete cleared symptom checklist, moving to week 2.',
      });
      expect(advanced.advanced_by_account_id).toBe(COACH_A);
      expect(advanced.advanced_at).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a duplicate week_number on the same plan is rejected', async () => {
    const client = await freshDatabase('ppbf_test_rtt_week_dup');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const plan = await createReturnToTrainingPlan({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        triggeringEvent: 'confirmed_concussion',
        eventDate: '2026-08-01',
        authoritySource: 'USA Boxing rulebook rest period',
        enteredByAccountId: COACH_A,
        enteredByRole: 'coach',
      });
      await addReturnToTrainingStep({
        organizationId: ORG_A, planId: plan.plan_id, weekNumber: 1, intensityLabel: 'Week 1.',
      });

      await expect(
        addReturnToTrainingStep({
          organizationId: ORG_A, planId: plan.plan_id, weekNumber: 1, intensityLabel: 'Duplicate week 1.',
        }),
      ).rejects.toThrow('RTT_STEP_WEEK_DUPLICATE');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
