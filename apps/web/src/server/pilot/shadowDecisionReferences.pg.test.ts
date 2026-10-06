// Real PostgreSQL-backed test for the cross-athlete references a SHADOW
// decision or near miss may carry (CL-A16).
//
// recordDecision looked up the referenced recommendation by organization and
// id alone, and flagNearMiss stored whatever decisionId it was handed. The
// routes only clear the athlete named in the body, so a coach could pin their
// own athlete's decision to another child's recommendation (and read that
// recommendation's status off the 409), or their own athlete's near miss to
// another child's decision. The fix is one athlete predicate per lookup; a
// mock would pass whether or not it is there, so this runs real SQL. Every
// refusal sits beside a positive control built from the same fixtures.
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

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-refs-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_refs';

// Mirror of MIGRATION_FILES in scripts/pilot-apply-shadow-runtime-migration.mjs.
const SHADOW_RUNTIME_MIGRATION_FILES = [
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_job_lease_migration.sql',
  'pilot_slice_postgres_board_role_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
];

const ORG_ID = 'org-shadow-refs';
const OTHER_ORG_ID = 'org-shadow-refs-other';
const COACH_ID = 'acct-shadow-refs-coach';
const OTHER_COACH_ID = 'acct-shadow-refs-other-coach';
// The other organization's athlete deliberately carries the SAME athlete_id
// string: athlete ids are only unique per organization.
const ATHLETE_ID = 'ATH-SR-1';
const OTHER_ATHLETE_ID = 'ATH-SR-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let decisions: typeof import('./shadowDecisions');
let nearMisses: typeof import('./shadowNearMisses');
let db: typeof import('./db');
let ownRecommendationId: string;
let otherAthleteRecommendationId: string;
let otherOrgRecommendationId: string;
let ownDecisionId: string;
let otherAthleteDecisionId: string;
let otherOrgDecisionId: string;

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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  for (const file of SHADOW_RUNTIME_MIGRATION_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  // recordDecision checks the athlete's medical clearance first, and that
  // read needs expires_at.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_medical_clearance_expiry_migration.sql'), 'utf8'),
  );
  for (const [org, coach] of [[ORG_ID, COACH_ID], [OTHER_ORG_ID, OTHER_COACH_ID]]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [coach, org],
    );
  }

  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  const athlete = (org: string, athleteId: string, coach: string) => migrateClient.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [org, athleteId, coach],
  );
  await athlete(ORG_ID, ATHLETE_ID, COACH_ID);
  await athlete(ORG_ID, OTHER_ATHLETE_ID, COACH_ID);
  await athlete(OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);
  // Cleared, so a refusal below can only come from the reference check and
  // never from the clearance gate that runs ahead of it.
  await migrateClient.query(
    `insert into pilot.shadow_medical_administrative_status
       (organization_id, athlete_id, status, set_by_account_id, set_by_role)
     values ($1, $2, 'cleared', $3, 'coach')`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );

  const recommendation = async (org: string, athleteId: string, coach: string) => (
    await migrateClient.query<{ recommendation_id: string }>(
      `insert into pilot.shadow_recommendations
         (organization_id, athlete_id, recommendation_text, expected_outcome, created_by_account_id, expires_at)
       values ($1, $2, 'Lighter week', 'Readiness recovers', $3, now() + interval '7 days')
       returning recommendation_id`,
      [org, athleteId, coach],
    )
  ).rows[0].recommendation_id;
  ownRecommendationId = await recommendation(ORG_ID, ATHLETE_ID, COACH_ID);
  otherAthleteRecommendationId = await recommendation(ORG_ID, OTHER_ATHLETE_ID, COACH_ID);
  otherOrgRecommendationId = await recommendation(OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);

  const decision = async (org: string, athleteId: string, coach: string) => (
    await migrateClient.query<{ decision_id: string }>(
      `insert into pilot.shadow_decisions
         (organization_id, athlete_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role)
       values ($1, $2, 'Hold sparring one week', 'Contact exposure returns to baseline', $3, 'coach')
       returning decision_id`,
      [org, athleteId, coach],
    )
  ).rows[0].decision_id;
  ownDecisionId = await decision(ORG_ID, ATHLETE_ID, COACH_ID);
  otherAthleteDecisionId = await decision(ORG_ID, OTHER_ATHLETE_ID, COACH_ID);
  otherOrgDecisionId = await decision(OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  decisions = await import('./shadowDecisions');
  nearMisses = await import('./shadowNearMisses');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

async function count(table: 'shadow_decisions' | 'shadow_near_misses'): Promise<number> {
  const row = await db.queryOne<{ n: string }>(`select count(*)::text as n from pilot.${table}`);
  return Number(row?.n ?? 0);
}

function decide(recommendationId: string) {
  return decisions.recordDecision({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    recommendationId,
    decisionText: 'Take the lighter week',
    expectedOutcome: 'Readiness recovers',
    decidedByAccountId: COACH_ID,
    decidedByRole: 'coach',
  });
}

function flag(decisionId: string) {
  return nearMisses.flagNearMiss({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    decisionId,
    description: 'Sparred while the hold was being discussed',
    severity: 'low',
    detectedByAccountId: COACH_ID,
    detectedByRole: 'coach',
  });
}

describe('recordDecision: the referenced recommendation must be about the same athlete', () => {
  test("refuses another athlete's recommendation exactly as it refuses a missing one", async () => {
    const before = await count('shadow_decisions');
    const refusal = await decide(otherAthleteRecommendationId).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(decisions.RecommendationNotActionableError);
    // 'not_found', not 'provisional': the 409 must not read out the status of
    // a recommendation about a child the caller was never cleared for.
    expect((refusal as InstanceType<typeof decisions.RecommendationNotActionableError>).recommendationStatus)
      .toBe('not_found');
    expect(await count('shadow_decisions')).toBe(before);
  });

  test("refuses another organization's recommendation for a same-named athlete", async () => {
    const before = await count('shadow_decisions');
    const refusal = await decide(otherOrgRecommendationId).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(decisions.RecommendationNotActionableError);
    expect(await count('shadow_decisions')).toBe(before);
  });

  test("positive control: the athlete's own recommendation is accepted", async () => {
    const row = await decide(ownRecommendationId);
    expect(row.recommendation_id).toBe(ownRecommendationId);
    expect(row.athlete_id).toBe(ATHLETE_ID);
  });
});

describe('flagNearMiss: the referenced decision must be about the same athlete', () => {
  test("refuses another athlete's decision and writes nothing", async () => {
    const before = await count('shadow_near_misses');
    await expect(flag(otherAthleteDecisionId)).rejects.toMatchObject({ status: 404 });
    expect(await count('shadow_near_misses')).toBe(before);
  });

  test("refuses another organization's decision and writes nothing", async () => {
    const before = await count('shadow_near_misses');
    await expect(flag(otherOrgDecisionId)).rejects.toMatchObject({ status: 404 });
    expect(await count('shadow_near_misses')).toBe(before);
  });

  test('refuses a decision id that does not exist, the same way', async () => {
    await expect(flag('99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ status: 404 });
  });

  test("positive control: the athlete's own decision is accepted", async () => {
    const row = await flag(ownDecisionId);
    expect(row.decision_id).toBe(ownDecisionId);
  });

  test('positive control: a near miss with no decision is still accepted', async () => {
    const row = await nearMisses.flagNearMiss({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      description: 'No decision attached',
      severity: 'low',
      detectedByAccountId: COACH_ID,
      detectedByRole: 'coach',
    });
    expect(row.decision_id).toBeNull();
  });
});
