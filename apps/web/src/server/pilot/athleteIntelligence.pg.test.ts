// Real PostgreSQL proof for the Athlete Intelligence read model.
//
// WHY A DATABASE TEST AND NOT A MOCK. Every claim this suite makes lives in a
// WHERE or an ORDER BY, and a mocked `query` can only assert what a module does
// with rows it was handed -- it cannot see which rows Postgres would have
// returned. Three predicates carry the whole read model:
//
//   1. `distinct on (formula_id, output_key)` -- the difference between "the
//      latest value of every formula output" and "the latest N rows", which are
//      the same answer only until one formula is recomputed more often than
//      another.
//   2. `review_state = 'accepted'` -- the difference between Film Study
//      material a coach has actually signed off on and everything still
//      awaiting one, including a 'corrected' row a coach has reworded but not
//      yet settled. Accepted-only is an owner decision (2026-08-27).
//   3. `organization_id = $1` on every read -- the tenancy boundary.
//
// Each is mutation-tested: the suite was watched to go RED with the predicate
// broken, and the mutation results are recorded in the PR.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-intelligence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_athlete_intelligence';

const ORG_ID = 'org-athlete-intel';
const OTHER_ORG_ID = 'org-athlete-intel-elsewhere';
const COACH_ID = 'acct-intel-coach';
const OTHER_COACH_ID = 'acct-intel-other-coach';
const ATHLETE_ID = 'ATH-INTEL-1';
const OTHER_ATHLETE_ID = 'ATH-INTEL-2';
// Same athlete_id string in a different organization. The tenancy cases below
// rest on this: a predicate that forgets organization_id still finds a row.
const TWIN_ATHLETE_ID = ATHLETE_ID;
const VIDEO_ID = 'vs-intel-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let intelligence: typeof import('./athleteIntelligence');
let proposals: typeof import('./shadowFilmStudyProposals');
let formulaRepository: typeof import('./formulas/repository');
let attempts: typeof import('./trainingAttempts');

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

async function readMigration(name: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, name), 'utf8');
}

const BASE_SQL = 'pilot_slice_postgres.sql';
const PROPOSALS_SQL = 'pilot_slice_postgres_film_study_proposals_migration.sql';
const COACH_REPORTED_SQL = 'pilot_slice_postgres_film_study_coach_reported_migration.sql';
const REVISIONS_SQL = 'pilot_slice_postgres_film_study_revisions_migration.sql';
const TRAINING_ATTEMPTS_SQL = 'pilot_slice_postgres_training_attempts_migration.sql';
const SPARRING_CONTEXTS_SQL = 'pilot_slice_postgres_sparring_attempt_contexts_migration.sql';

async function seedTenancy(client: Client): Promise<void> {
  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [OTHER_COACH_ID, OTHER_ORG_ID],
  );
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  const athlete = async (organizationId: string, athleteId: string, coachId: string, name: string) => {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
                                   emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $4, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [organizationId, athleteId, coachId, name],
    );
  };
  await athlete(ORG_ID, ATHLETE_ID, COACH_ID, 'Intel Athlete');
  await athlete(ORG_ID, OTHER_ATHLETE_ID, COACH_ID, 'Intel Athlete Two');
  await athlete(OTHER_ORG_ID, TWIN_ATHLETE_ID, OTHER_COACH_ID, 'Same Id Different Gym');
}

/** One persisted formula result, written straight to the table.
 *
 * The engine is not used on purpose: this is a READ-model suite, and going
 * through the engine would tie every case to whichever observations a given
 * formula happens to require. The columns below are exactly the ones
 * `rowToFormulaResult` hydrates. */
async function insertFormulaResult(input: {
  organizationId?: string;
  athleteId?: string;
  formulaId: string;
  outputKey?: string;
  computedAt: string;
  value: number | null;
  validationState?: string;
  hardBlocks?: string[];
  warnings?: string[];
  confidence?: string;
  completeness?: number;
  worstSourceQuality?: string | null;
  unavailableReason?: string | null;
  humanReviewRequired?: boolean;
  provenance?: unknown[];
  inputObservationIds?: string[];
}): Promise<string> {
  const resultId = `res-${crypto.randomUUID()}`;
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    await client.query(
      `insert into pilot.shadow_formula_results
         (result_id, calculation_key, formula_id, formula_version, output_key, policy_version,
          parameters, organization_id, athlete_id, context_id, numeric_value, unit, computed_at,
          input_observation_ids, provenance, validation_state, hard_blocks, warnings,
          confidence, completeness, worst_source_quality, unavailable_reason, human_review_required)
       values ($1, $1, $2, '1.0.0', $3, 'policy-1', '{}'::jsonb, $4, $5, 'ctx-1', $6, 'ratio', $7,
               $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        resultId,
        input.formulaId,
        input.outputKey ?? 'value',
        input.organizationId ?? ORG_ID,
        input.athleteId ?? ATHLETE_ID,
        input.value,
        input.computedAt,
        input.inputObservationIds ?? [],
        JSON.stringify(input.provenance ?? []),
        input.validationState ?? 'valid',
        input.hardBlocks ?? [],
        input.warnings ?? [],
        input.confidence ?? 'HIGH',
        input.completeness ?? 1,
        input.worstSourceQuality ?? 'high',
        input.unavailableReason ?? null,
        input.humanReviewRequired ?? false,
      ],
    );
  } finally {
    await client.end();
  }
  return resultId;
}

async function truncateAll(): Promise<void> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    await client.query(
      `truncate pilot.film_study_proposal_revisions, pilot.shadow_film_study_proposals,
                pilot.shadow_formula_results, pilot.training_attempts`,
    );
  } finally {
    await client.end();
  }
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
  await migrateClient.query(await readMigration(BASE_SQL));
  await migrateClient.query(await readMigration(PROPOSALS_SQL));
  await migrateClient.query(await readMigration(COACH_REPORTED_SQL));
  await migrateClient.query(await readMigration(REVISIONS_SQL));
  await migrateClient.query(await readMigration(TRAINING_ATTEMPTS_SQL));
  await migrateClient.query(await readMigration(SPARRING_CONTEXTS_SQL));
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  intelligence = await import('./athleteIntelligence');
  proposals = await import('./shadowFilmStudyProposals');
  formulaRepository = await import('./formulas/repository');
  attempts = await import('./trainingAttempts');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

  // Shutdown copied from filmStudyValidationOriginScope.pg.test.ts. The
  // `unref()` is the load-bearing part: a plain safety timer keeps Node's event
  // loop alive for its full duration, and Jest reports "did not exit one second
  // after the test run" on a suite that has in fact finished cleanly.
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

  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(truncateAll);

describe('the gap in listActiveFormulaResults, measured rather than asserted', () => {
  /* `listActiveFormulaResults` orders by computed_at desc and takes the newest
   * N ROWS. Nothing in it is per-output, so a formula that recomputes often
   * buries every formula that does not -- and the caller cannot tell the
   * difference between "MVP-05 has no value" and "MVP-05's value fell off the
   * end of the page". This test pins the existing behaviour so the new reader
   * is measured against a defect that was observed, not assumed. */
  test('newest-N-rows buries an output that recomputes less often', async () => {
    const base = Date.parse('2026-08-01T00:00:00.000Z');
    // The quiet output, computed once and long ago.
    await insertFormulaResult({
      formulaId: 'MVP-05',
      computedAt: new Date(base).toISOString(),
      value: 0.42,
    });
    // The noisy output, recomputed five times since.
    for (let i = 1; i <= 5; i += 1) {
      await insertFormulaResult({
        formulaId: 'MVP-01',
        computedAt: new Date(base + i * 60_000).toISOString(),
        value: i,
      });
    }

    const buried = await formulaRepository.listActiveFormulaResults({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      limit: 5,
    });

    expect(buried).toHaveLength(5);
    expect(buried.map((row) => row.formulaId)).toEqual(['MVP-01', 'MVP-01', 'MVP-01', 'MVP-01', 'MVP-01']);
    // The defect, stated as a fact about the existing reader: MVP-05 has a
    // value, and this reader does not return it.
    expect(buried.some((row) => row.formulaId === 'MVP-05')).toBe(false);

    // The new reader answers the question the caller was actually asking.
    const latest = await formulaRepository.listLatestFormulaResultsPerOutput({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(latest.map((row) => row.formulaId).sort()).toEqual(['MVP-01', 'MVP-05']);
    expect(latest.find((row) => row.formulaId === 'MVP-05')?.value).toBe(0.42);
    // ...and the MVP-01 it returns is the NEWEST one, not just any one.
    expect(latest.find((row) => row.formulaId === 'MVP-01')?.value).toBe(5);
  });

  /* Two outputs of the SAME formula are two answers, not one. A reader keyed on
   * formula_id alone would collapse them and report whichever was computed
   * last as though it were the formula's only result. */
  test('two output keys of one formula are two rows, each at its own latest', async () => {
    const base = Date.parse('2026-08-01T00:00:00.000Z');
    await insertFormulaResult({
      formulaId: 'MVP-02', outputKey: 'acute', computedAt: new Date(base).toISOString(), value: 1,
    });
    await insertFormulaResult({
      formulaId: 'MVP-02', outputKey: 'acute', computedAt: new Date(base + 120_000).toISOString(), value: 2,
    });
    await insertFormulaResult({
      formulaId: 'MVP-02', outputKey: 'chronic', computedAt: new Date(base + 60_000).toISOString(), value: 9,
    });

    const latest = await formulaRepository.listLatestFormulaResultsPerOutput({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(latest.map((row) => [row.outputKey, row.value])).toEqual([['acute', 2], ['chronic', 9]]);
  });

  /* The superseded-input exclusion is the one piece of `listActiveFormulaResults`
   * that must survive the rewrite: a result computed from an observation that
   * has since been corrected is not the athlete's current value. */
  test('a result built on a superseded observation is still excluded', async () => {
    const originalId = `obs-${crypto.randomUUID()}`;
    const successorId = `obs-${crypto.randomUUID()}`;
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await client.query('delete from pilot.shadow_formula_observations where organization_id = $1', [ORG_ID]);
      for (const [id, supersedes] of [[originalId, null], [successorId, originalId]] as const) {
        await client.query(
          `insert into pilot.shadow_formula_observations
             (observation_id, organization_id, athlete_id, context_id, observation_kind, numeric_value,
              unit, dimensions, observed_at, source_type, source_quality, source_reference_id,
              idempotency_key, supersedes_observation_id)
           values ($1, $2, $3, 'ctx-1', 'session_rpe', 5, 'rpe_0_10', '{}'::jsonb, now(),
                   'manual', 'high', 'ref-1', $1, $4)`,
          [id, ORG_ID, ATHLETE_ID, supersedes],
        );
      }
    } finally {
      await client.end();
    }

    await insertFormulaResult({
      formulaId: 'MVP-03',
      computedAt: '2026-08-01T00:00:00.000Z',
      value: 7,
      inputObservationIds: [originalId],
    });

    const latest = await formulaRepository.listLatestFormulaResultsPerOutput({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(latest.map((row) => row.formulaId)).not.toContain('MVP-03');
  });
});

describe('reviewed-only Film Study material', () => {
  async function proposalIn(state: 'pending_review' | 'accepted' | 'rejected' | 'corrected'): Promise<string> {
    const proposal = await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: `model text for ${state}`,
      modelDeployment: 'vision-1',
      framesAnalyzed: 6,
    });
    if (state !== 'pending_review') {
      await proposals.resolveFilmStudyProposal({
        organizationId: ORG_ID,
        proposalId: proposal.proposal_id,
        verdict: state,
        reviewerAccountId: COACH_ID,
        reviewerRole: 'coach',
        correctedObservationText: state === 'corrected' ? 'coach text for corrected' : null,
      });
    }
    return proposal.proposal_id;
  }

  /* THE PREDICATE. A pending proposal is an unreviewed AI claim about an
   * identifiable minor, and a rejected one is a claim a coach looked at and
   * said no to. Neither is evidence. This is the case that goes red when the
   * filter is broken, and it was watched doing so. */
  test('only accepted appears; pending, rejected and corrected do not', async () => {
    const pendingId = await proposalIn('pending_review');
    const rejectedId = await proposalIn('rejected');
    const acceptedId = await proposalIn('accepted');
    const correctedId = await proposalIn('corrected');

    const reviewed = await proposals.listReviewedFilmStudyMaterial({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    const ids = reviewed.map((row) => row.proposal_id);
    expect(ids).toEqual([acceptedId]);
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(rejectedId);
    // The owner decision. 'corrected' is a coach's replacement wording on a
    // proposal still sitting in their queue -- work in progress, not a verdict.
    expect(ids).not.toContain(correctedId);
    expect(reviewed.every((row) => row.review_state === 'accepted')).toBe(true);
  });

  /* The rows excluded above are excluded from a READ, never deleted. A pending
   * proposal still has to reach the coach's queue, and a rejected one is the
   * record that the model was wrong. */
  test('the excluded rows are still in the table, unchanged', async () => {
    const pendingId = await proposalIn('pending_review');
    const rejectedId = await proposalIn('rejected');

    await proposals.listReviewedFilmStudyMaterial({ organizationId: ORG_ID, athleteId: ATHLETE_ID });

    expect((await proposals.getFilmStudyProposal(ORG_ID, pendingId))?.review_state).toBe('pending_review');
    expect((await proposals.getFilmStudyProposal(ORG_ID, rejectedId))?.review_state).toBe('rejected');
  });

  /* A corrected proposal is excluded from the READ and left in the table --
   * the same treatment pending and rejected get, for the same reason. It is
   * still owed a coach decision, and it stays in the queue that owes it.
   *
   * Asserting the row survives matters as much as asserting it is unread: an
   * exclusion implemented by deleting would lose a coach's authored wording. */
  test('a corrected row is withheld from the read and left in the queue', async () => {
    const correctedId = await proposalIn('corrected');

    const reviewed = await proposals.listReviewedFilmStudyMaterial({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(reviewed).toHaveLength(0);

    const stored = await proposals.getFilmStudyProposal(ORG_ID, correctedId);
    expect(stored?.review_state).toBe('corrected');
    expect(stored?.corrected_observation_text).toBe('coach text for corrected');
  });

  /* Origin is never collapsed. A coach-reported observation that a coach then
   * accepted is evidence the MODEL MISSED something; flattened into the same
   * shape as an accepted model proposal it reads as the model succeeding. */
  test('coach-reported and model-proposed stay distinguishable', async () => {
    await proposalIn('accepted');
    const reported = await proposals.createCoachReportedObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      observationText: 'the model said nothing about this',
      reportedByAccountId: COACH_ID,
    });
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: reported.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const reviewed = await proposals.listReviewedFilmStudyMaterial({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    const byOrigin = new Map(reviewed.map((row) => [row.origin, row]));
    expect([...byOrigin.keys()].sort()).toEqual(['coach_reported', 'model_proposed']);
    // Provenance travels with each: a model row names its deployment and frame
    // count, a coach row names the coach and carries neither.
    expect(byOrigin.get('model_proposed')?.model_deployment).toBe('vision-1');
    expect(byOrigin.get('model_proposed')?.frames_analyzed).toBe(6);
    expect(byOrigin.get('model_proposed')?.reported_by_account_id).toBeNull();
    expect(byOrigin.get('coach_reported')?.model_deployment).toBeNull();
    expect(byOrigin.get('coach_reported')?.frames_analyzed).toBeNull();
    expect(byOrigin.get('coach_reported')?.reported_by_account_id).toBe(COACH_ID);
  });

  /* `listFilmStudyProposals` returns the whole organization when athleteId is
   * omitted. This reader has no such mode: the athlete is required, so there is
   * no argument list that reads another athlete's film by accident. */
  test('another athlete in the same gym is not returned', async () => {
    await proposalIn('accepted');
    const otherAthlete = await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: OTHER_ATHLETE_ID,
      videoSessionId: 'vs-intel-other',
      jobId: crypto.randomUUID(),
      observationText: 'about a different child',
      modelDeployment: 'vision-1',
      framesAnalyzed: 3,
    });
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: otherAthlete.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const reviewed = await proposals.listReviewedFilmStudyMaterial({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(reviewed.every((row) => row.athlete_id === ATHLETE_ID)).toBe(true);
    expect(reviewed.map((row) => row.proposal_id)).not.toContain(otherAthlete.proposal_id);
  });
});

describe('the tenancy boundary, with the same athlete id in two gyms', () => {
  /* Every source in the read model filters organization_id. The fixture makes
   * that testable rather than assumed: ATH-INTEL-1 exists in BOTH gyms, so a
   * predicate that matches on athlete_id alone returns the other gym's row and
   * the case goes red. */
  test('no source crosses the organization boundary', async () => {
    await insertFormulaResult({ formulaId: 'MVP-07', computedAt: '2026-08-01T00:00:00.000Z', value: 1 });
    await insertFormulaResult({
      organizationId: OTHER_ORG_ID,
      athleteId: TWIN_ATHLETE_ID,
      formulaId: 'MVP-08',
      computedAt: '2026-08-02T00:00:00.000Z',
      value: 2,
    });

    await attempts.recordAttempt({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextType: 'session',
      metricKind: 'reps',
      targetValue: 10,
      achievedValue: 12,
      recordedByAccountId: COACH_ID,
    });
    await attempts.recordAttempt({
      organizationId: OTHER_ORG_ID,
      athleteId: TWIN_ATHLETE_ID,
      contextType: 'session',
      metricKind: 'rounds',
      targetValue: 3,
      achievedValue: 4,
      recordedByAccountId: OTHER_COACH_ID,
    });

    const theirs = await proposals.createFilmStudyProposal({
      organizationId: OTHER_ORG_ID,
      athleteId: TWIN_ATHLETE_ID,
      videoSessionId: 'vs-other-org',
      jobId: crypto.randomUUID(),
      observationText: 'another gym entirely',
      modelDeployment: 'vision-9',
      framesAnalyzed: 2,
    });
    await proposals.resolveFilmStudyProposal({
      organizationId: OTHER_ORG_ID,
      proposalId: theirs.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: OTHER_COACH_ID,
      reviewerRole: 'coach',
    });

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(model.formulaOutputs.items.map((entry) => entry.result.formulaId)).toEqual(['MVP-07']);
    expect(model.formulaOutputs.items.every((entry) => entry.result.organizationId === ORG_ID)).toBe(true);
    expect(model.trainingAttempts.items.map((row) => row.metric_kind)).toEqual(['reps']);
    expect(model.trainingAttempts.items.every((row) => row.organization_id === ORG_ID)).toBe(true);
    expect(model.reviewedFilmStudy.items.map((row) => row.proposal_id)).not.toContain(theirs.proposal_id);
    expect(model.metricTransfer.items.map((row) => row.metric_kind)).toEqual(['reps']);
  });
});

describe('the assembled read model', () => {
  test('an athlete with nothing recorded reads none_recorded on every source, not zero', async () => {
    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(model.formulaOutputs.availability).toBe('none_recorded');
    expect(model.trainingAttempts.availability).toBe('none_recorded');
    expect(model.metricTransfer.availability).toBe('none_recorded');
    expect(model.reviewedFilmStudy.availability).toBe('none_recorded');
    expect(model.formulaOutputs.items).toEqual([]);
    expect(model.trainingAttempts.items).toEqual([]);
    expect(model.metricTransfer.items).toEqual([]);
    expect(model.reviewedFilmStudy.items).toEqual([]);
  });

  /* `made: null` means there was NO TARGET -- a measurement, not a failure.
   * Collapsing it to false would turn every open measurement into a miss. */
  test('a target-less attempt keeps made null, distinct from false', async () => {
    await attempts.recordAttempt({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextType: 'open_floor',
      metricKind: 'reps',
      targetValue: null,
      achievedValue: 12,
      recordedByAccountId: COACH_ID,
    });
    await attempts.recordAttempt({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextType: 'session',
      metricKind: 'reps',
      targetValue: 20,
      achievedValue: 12,
      recordedByAccountId: COACH_ID,
    });

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    const verdicts = model.trainingAttempts.items.map((row) => row.made);
    expect(verdicts).toContain(null);
    expect(verdicts).toContain(false);
    expect(verdicts).not.toContain(true);
  });

  /* open_floor and film_study attempts are in NEITHER transfer class. They
   * appear in the attempts ledger and must not be folded into the transfer
   * counts, or the comparison the transfer readout exists to sharpen is blurred
   * by unsupervised and observational work. */
  test('open_floor and film_study attempts appear in attempts and not in transfer counts', async () => {
    for (const contextType of ['open_floor', 'film_study'] as const) {
      await attempts.recordAttempt({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        contextType,
        metricKind: 'hold_seconds',
        targetValue: 30,
        achievedValue: 40,
        recordedByAccountId: COACH_ID,
      });
    }

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(model.trainingAttempts.items).toHaveLength(2);
    const holds = model.metricTransfer.items.find((row) => row.metric_kind === 'hold_seconds');
    expect(holds).toBeDefined();
    expect(holds?.controlled_makes).toBe(0);
    expect(holds?.controlled_misses).toBe(0);
    expect(holds?.live_makes).toBe(0);
    expect(holds?.live_misses).toBe(0);
    expect(holds?.state).toBe('insufficient_evidence');
  });

  /* All four raw counts travel with every transfer flag, unchanged, so a coach
   * can disagree with the rule by looking at the same facts. */
  test('the transfer readout arrives with its four raw counts intact', async () => {
    for (let i = 0; i < 4; i += 1) {
      await attempts.recordAttempt({
        organizationId: ORG_ID, athleteId: ATHLETE_ID, contextType: 'drill_assignment',
        metricKind: 'rounds', targetValue: 3, achievedValue: 4, recordedByAccountId: COACH_ID,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      await attempts.recordAttempt({
        organizationId: ORG_ID, athleteId: ATHLETE_ID, contextType: 'open_sparring',
        metricKind: 'rounds', targetValue: 3, achievedValue: 1, recordedByAccountId: COACH_ID,
      });
    }

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(model.metricTransfer.items).toEqual([
      {
        metric_kind: 'rounds',
        controlled_makes: 4,
        controlled_misses: 0,
        live_makes: 0,
        live_misses: 4,
        state: 'not_transferring',
      },
    ]);
  });

  /* The same predicate, measured at the read model rather than at the reader.
   * The reviewed-only filter is the difference between coach-reviewed material
   * and a pile of unreviewed AI claims about an identifiable minor, so it is
   * guarded at both levels: breaking it must red the assembled payload too, not
   * only the function underneath. */
  test('no pending or rejected Film Study row reaches the read model', async () => {
    const pending = await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: 'nobody has looked at this yet',
      modelDeployment: 'vision-1',
      framesAnalyzed: 4,
    });
    const refused = await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: 'a coach looked at this and said no',
      modelDeployment: 'vision-1',
      framesAnalyzed: 4,
    });
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: refused.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    expect(model.reviewedFilmStudy.items).toEqual([]);
    // Two proposals exist for this athlete and NONE of them is evidence, so
    // the honest answer is none_recorded -- not a count of what is waiting.
    expect(model.reviewedFilmStudy.availability).toBe('none_recorded');
    expect((await proposals.getFilmStudyProposal(ORG_ID, pending.proposal_id))?.review_state)
      .toBe('pending_review');
  });

  /* MVP-10 can carry confidence INSUFFICIENT beside a REAL value and
   * state 'valid' (engine.ts confidenceOverride). A reader that shows bare
   * confidence reports "insufficient" over a number that is fine. The read
   * model never separates the two. */
  test('confidence never travels without the validation state beside it', async () => {
    await insertFormulaResult({
      formulaId: 'MVP-10',
      computedAt: '2026-08-01T00:00:00.000Z',
      value: 0.5,
      validationState: 'valid',
      confidence: 'INSUFFICIENT',
      warnings: ['PARTIAL_FIELDS'],
      completeness: 0.5,
    });

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    const [entry] = model.formulaOutputs.items;
    expect(entry.result.value).toBe(0.5);
    expect(entry.result.quality.confidence).toBe('INSUFFICIENT');
    expect(entry.result.validation.state).toBe('valid');
    expect(entry.result.validation.warnings).toEqual(['PARTIAL_FIELDS']);
  });

  /* Provenance, hard blocks, warnings and the observation ids arrive
   * structurally intact. Nothing here is flattened into a summary, because a
   * flattened field is the one nobody can un-flatten later. */
  test('validation, quality and provenance arrive structurally intact', async () => {
    const provenance = [{
      observationId: 'obs-1',
      kind: 'session_rpe',
      unit: 'rpe_0_10',
      observedAt: '2026-07-31T00:00:00.000Z',
      sourceType: 'manual',
      sourceQuality: 'moderate',
      sourceReferenceId: 'ref-9',
      dimensions: { round: 2 },
    }];
    await insertFormulaResult({
      formulaId: 'MVP-04',
      computedAt: '2026-08-01T00:00:00.000Z',
      value: null,
      validationState: 'insufficient',
      hardBlocks: ['INSUFFICIENT_DATA'],
      warnings: ['SOURCE_QUALITY_WARNING'],
      confidence: 'INSUFFICIENT',
      completeness: 0.25,
      worstSourceQuality: 'moderate',
      unavailableReason: 'INSUFFICIENT_DATA',
      provenance,
      humanReviewRequired: true,
    });

    const model = await intelligence.getAthleteIntelligence({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
    });

    const [entry] = model.formulaOutputs.items;
    expect(entry.result.validation).toEqual({
      state: 'insufficient',
      hardBlocks: ['INSUFFICIENT_DATA'],
      warnings: ['SOURCE_QUALITY_WARNING'],
    });
    expect(entry.result.quality).toEqual({
      confidence: 'INSUFFICIENT',
      completeness: 0.25,
      worstSourceQuality: 'moderate',
    });
    expect(entry.result.provenance).toEqual(provenance);
    expect(entry.result.unavailableReason).toBe('INSUFFICIENT_DATA');

    // The registry constant, under the name that says what it is. Nothing
    // computes or clears it, so it is not a review state and must never be
    // rendered as "awaiting review".
    expect(entry.formulaRequiresHumanReview).toBe(true);
    expect(entry.formulaRequiresHumanReview).toBe(entry.result.humanReviewRequired);
    // The DATA GAP, present in the payload rather than absent from it: there is
    // no per-result review state anywhere in the schema.
    expect(entry.perResultReviewState).toBeNull();
  });
});
