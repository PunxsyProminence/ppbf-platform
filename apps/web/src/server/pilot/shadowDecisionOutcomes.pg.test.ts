// Real PostgreSQL-backed test for the decision-outcome observation-id check.
//
// pilot.shadow_decision_outcomes.observation_ids is an untyped text[]: no
// foreign key can cover an array, so evaluateDecisionOutcome is the only thing
// standing between a caller and storing another athlete's -- or another
// organization's -- observation id against a decision. That check is one SQL
// statement with an organization predicate and an athlete predicate in each of
// two branches; a mock would pass whether or not either predicate is there.
// Every refusal below sits beside a positive control built from the same
// fixtures, so a refusal cannot pass because the write was broken anyway.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-outcome-obs-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_outcome_obs';

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

const ORG_ID = 'org-outcome-obs';
const OTHER_ORG_ID = 'org-outcome-obs-other';
const COACH_ID = 'acct-outcome-obs-coach';
const OTHER_COACH_ID = 'acct-outcome-obs-other-coach';
// The other organization's athlete deliberately carries the SAME athlete_id
// string. Athlete ids are only unique per organization, so this is the case an
// athlete-only predicate would wave through.
const ATHLETE_ID = 'ATH-OO-1';
const TEAMMATE_ID = 'ATH-OO-2';

const OWN_FORMULA = 'obs-oo-own-formula';
const OWN_NOTE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE_FORMULA = 'obs-oo-teammate-formula';
const TEAMMATE_NOTE = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_FORMULA = 'obs-oo-other-org-formula';
const OTHER_ORG_NOTE = '33333333-3333-4333-8333-333333333333';
const NO_ATHLETE_FORMULA = 'obs-oo-no-athlete-formula';
const BULK_PREFIX = 'obs-oo-bulk-';
// Mirrors MAX_OUTCOME_OBSERVATION_IDS; asserted equal below. The fixtures need
// it before the module can be imported.
const MAX_IDS = 50;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let outcomes: typeof import('./shadowDecisionOutcomes');
let db: typeof import('./db');
let decisionId: string;
let teammateDecisionId: string;

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
  await athlete(ORG_ID, TEAMMATE_ID, COACH_ID);
  await athlete(OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);

  const formulaObservation = (id: string, org: string, athleteId: string | null) => migrateClient.query(
    `insert into pilot.shadow_formula_observations
       (observation_id, organization_id, athlete_id, context_id, observation_kind, numeric_value, unit,
        observed_at, source_type, source_quality, source_reference_id, idempotency_key)
     values ($1, $2, $3, 'ctx-oo', 'contact_exposure', 1, 'count', now(), 'coach_entry', 'moderate', 'ref-oo', $1)`,
    [id, org, athleteId],
  );
  await formulaObservation(OWN_FORMULA, ORG_ID, ATHLETE_ID);
  await formulaObservation(TEAMMATE_FORMULA, ORG_ID, TEAMMATE_ID);
  await formulaObservation(OTHER_ORG_FORMULA, OTHER_ORG_ID, ATHLETE_ID);
  await formulaObservation(NO_ATHLETE_FORMULA, ORG_ID, null);
  // The same string is BOTH a coach note id and a formula observation id for
  // this athlete. It must count once: counted twice, it would cover for a
  // missing id elsewhere in the array.
  await formulaObservation(OWN_NOTE, ORG_ID, ATHLETE_ID);
  for (let index = 0; index <= MAX_IDS; index += 1) {
    await formulaObservation(`${BULK_PREFIX}${index}`, ORG_ID, ATHLETE_ID);
  }

  const coachNote = (id: string, org: string, athleteId: string, coach: string) => migrateClient.query(
    `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
     values ($1, $2, $3, $4, 'behavior_standard', 'note')`,
    [org, id, athleteId, coach],
  );
  await coachNote(OWN_NOTE, ORG_ID, ATHLETE_ID, COACH_ID);
  await coachNote(TEAMMATE_NOTE, ORG_ID, TEAMMATE_ID, COACH_ID);
  await coachNote(OTHER_ORG_NOTE, OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);

  const decision = async (athleteId: string) => (await migrateClient.query<{ decision_id: string }>(
    `insert into pilot.shadow_decisions
       (organization_id, athlete_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role)
     values ($1, $2, 'Hold sparring one week', 'Contact exposure returns to baseline', $3, 'coach')
     returning decision_id`,
    [ORG_ID, athleteId, COACH_ID],
  )).rows[0].decision_id;
  decisionId = await decision(ATHLETE_ID);
  teammateDecisionId = await decision(TEAMMATE_ID);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  outcomes = await import('./shadowDecisionOutcomes');
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

async function storedCounts(): Promise<{ outcomes: number; audits: number }> {
  const rows = await db.query<{ outcomes: number; audits: number }>(
    `select
       (select count(*)::int from pilot.shadow_decision_outcomes where organization_id = $1) as outcomes,
       (select count(*)::int from pilot.shadow_audit_entries
         where organization_id = $1 and entity_type = 'outcome') as audits`,
    [ORG_ID],
  );
  return rows[0];
}

type Overrides = Partial<Parameters<typeof outcomes.evaluateDecisionOutcome>[0]>;

function evaluate(observationIds: string[], overrides: Overrides = {}) {
  return outcomes.evaluateDecisionOutcome({
    organizationId: ORG_ID,
    decisionId,
    observationIds,
    matchState: 'match',
    evaluatedByAccountId: COACH_ID,
    evaluatedByRole: 'coach',
    ...overrides,
  });
}

// Runs the write, asserts it was refused and that NOTHING was written, and
// returns what the caller would be told so refusals can be compared.
async function refusal(
  observationIds: string[],
  overrides: Overrides = {},
): Promise<{ status: unknown; message: string; name: string }> {
  const before = await storedCounts();
  let caught: unknown;
  try {
    await evaluate(observationIds, overrides);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(await storedCounts()).toEqual(before);
  const error = caught as Error & { status?: unknown };
  return { status: error.status, message: error.message, name: error.name };
}

const bulkIds = (count: number) => Array.from({ length: count }, (_, index) => `${BULK_PREFIX}${index}`);

const REFUSED = { status: 400, message: 'Decision outcome observation ids are invalid.', name: 'ValidationError' };

describe('evaluateDecisionOutcome observation ids against the real schema', () => {
  test('positive control: stores ids from both observation tables for the decision athlete, with one audit entry', async () => {
    const before = await storedCounts();
    const row = await evaluate([OWN_FORMULA, OWN_NOTE]);
    expect(row.observation_ids).toEqual([OWN_FORMULA, OWN_NOTE]);
    expect(await storedCounts()).toEqual({ outcomes: before.outcomes + 1, audits: before.audits + 1 });
  });

  test('positive control: an empty array and a repeated valid id are still accepted', async () => {
    expect((await evaluate([])).observation_ids).toEqual([]);
    expect((await evaluate([OWN_FORMULA, OWN_FORMULA])).observation_ids).toEqual([OWN_FORMULA, OWN_FORMULA]);
  });

  test.each([
    ['an id that does not exist', 'obs-oo-does-not-exist'],
    ['a well-formed note id that does not exist', '99999999-9999-4999-8999-999999999999'],
    ['another organization formula observation (same athlete_id string)', OTHER_ORG_FORMULA],
    ['another organization coach note (same athlete_id string)', OTHER_ORG_NOTE],
    ['a teammate formula observation in the same organization', TEAMMATE_FORMULA],
    ['a teammate coach note in the same organization', TEAMMATE_NOTE],
    ['a formula observation with no athlete', NO_ATHLETE_FORMULA],
  ])('refuses %s, alone and mixed with valid ids, and writes nothing', async (_label, badId) => {
    expect(await refusal([badId])).toEqual(REFUSED);
    expect(await refusal([OWN_FORMULA, badId, OWN_NOTE])).toEqual(REFUSED);
    // Same fixtures, bad id removed: the write itself works.
    await expect(evaluate([OWN_FORMULA, OWN_NOTE])).resolves.toMatchObject({ decision_id: decisionId });
  });

  test('every refusal is the same refusal, so it cannot be used to learn that a foreign id exists', async () => {
    const seen = new Set<string>();
    for (const ids of [
      ['obs-oo-does-not-exist'],
      [OTHER_ORG_FORMULA],
      [OTHER_ORG_NOTE],
      [TEAMMATE_FORMULA],
      [TEAMMATE_NOTE],
      [NO_ATHLETE_FORMULA],
      bulkIds(MAX_IDS + 1),
    ]) {
      seen.add(JSON.stringify(await refusal(ids)));
    }
    expect([...seen]).toHaveLength(1);
  });

  test('the athlete is the DECISION athlete: a teammate decision accepts the teammate ids and refuses this athlete ids', async () => {
    const teammate = { decisionId: teammateDecisionId };
    await expect(evaluate([TEAMMATE_FORMULA, TEAMMATE_NOTE], teammate)).resolves.toMatchObject({
      decision_id: teammateDecisionId,
    });
    expect(await refusal([OWN_FORMULA], teammate)).toEqual(REFUSED);
    expect(await refusal([OWN_NOTE], teammate)).toEqual(REFUSED);
  });

  test('the check does not depend on role, match state or notes', async () => {
    const other = { evaluatedByRole: 'organization_admin', matchState: 'miss' as const, notes: 'Did not hold.' };
    expect(await refusal([TEAMMATE_FORMULA], other)).toEqual(REFUSED);
    await expect(evaluate([OWN_FORMULA], other)).resolves.toMatchObject({ match_state: 'miss' });
  });

  test('an id present in both tables counts once and cannot cover for a missing id', async () => {
    await expect(evaluate([OWN_NOTE])).resolves.toMatchObject({ observation_ids: [OWN_NOTE] });
    expect(await refusal([OWN_NOTE, 'obs-oo-does-not-exist'])).toEqual(REFUSED);
  });

  test('caps the array as sent: the maximum is accepted, one more is refused, repeats included', async () => {
    expect(outcomes.MAX_OUTCOME_OBSERVATION_IDS).toBe(MAX_IDS);
    const atCap = await evaluate(bulkIds(MAX_IDS));
    expect(atCap.observation_ids).toHaveLength(MAX_IDS);
    expect(await refusal(bulkIds(MAX_IDS + 1))).toEqual(REFUSED);
    // One valid id repeated past the cap is a single distinct id, and is still refused.
    expect(await refusal(Array.from({ length: MAX_IDS + 1 }, () => OWN_FORMULA))).toEqual(REFUSED);
    await expect(evaluate(Array.from({ length: MAX_IDS }, () => OWN_FORMULA))).resolves.toBeDefined();
  });
});
