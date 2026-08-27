// Real PostgreSQL proof that the Film Study accept rate measures MODEL
// PROPOSALS and nothing else.
//
// THE DEFECT THIS PINS. `getFilmStudyValidation` described itself as "how often
// a coach actually accepts what the model proposed" and then counted every
// settled row in the table, including `coach_reported` ones. A coach-reported
// observation is what the model MISSED; a coach accepting it is confirmation
// the model was wrong. Folding those in as acceptances inverts their meaning
// and inflates the exact number the missed-detection path was added to keep
// honest.
//
// WHY A DATABASE TEST AND NOT A MOCK. `filmStudyValidation.test.ts` mocks
// `query`, so it can only assert what the module does with rows it is handed --
// it cannot see which rows Postgres would have returned. The contamination
// lives entirely in the WHERE clause. Only a real insert and a real read can
// tell a correct predicate from a missing one.
//
// The sibling suite `filmStudyCoachReported.pg.test.ts` already proved that
// MODEL_PROPOSAL_SCOPE_SQL excludes coach reports -- but it proved it about
// SQL written inside the test, not about the function that ships. The
// predicate was right and unused. This file measures the caller.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-film-validation-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_film_validation';

const ORG_ID = 'org-film-validation';
const COACH_ID = 'acct-film-validation-coach';
const ATHLETE_ID = 'ATH-FILM-VAL-1';
const VIDEO_ID = 'vs-film-val-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let proposals: typeof import('./shadowFilmStudyProposals');
let validation: typeof import('./filmStudyValidation');

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
// Not exercised here (nothing is corrected), applied for parity with the
// sibling suite so a later correction-based case needs no schema change.
const REVISIONS_SQL = 'pilot_slice_postgres_film_study_revisions_migration.sql';

/** Seeds the org/account/athlete rows the proposal foreign keys require. */
async function seedTenancy(client: Client): Promise<void> {
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
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Film Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
}

/** A settled model proposal on `deployment`, left at `verdict`. */
async function settledModelProposal(
  deployment: string,
  verdict: 'accepted' | 'rejected',
  framesAnalyzed = 6,
): Promise<string> {
  const proposal = await proposals.createFilmStudyProposal({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    jobId: crypto.randomUUID(),
    observationText: 'Lead hand returns low after the jab.',
    modelDeployment: deployment,
    framesAnalyzed,
  });
  await proposals.resolveFilmStudyProposal({
    organizationId: ORG_ID,
    proposalId: proposal.proposal_id,
    verdict,
    reviewerAccountId: COACH_ID,
    reviewerRole: 'coach',
  });
  return proposal.proposal_id;
}

/** A model proposal a coach CORRECTED -- the model saw something real and
 * described it wrong. Not an acceptance and not a rejection. */
async function correctedModelProposal(
  deployment: string,
  framesAnalyzed = 6,
): Promise<string> {
  const proposal = await proposals.createFilmStudyProposal({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    jobId: crypto.randomUUID(),
    observationText: 'Lead hand returns low after the jab.',
    modelDeployment: deployment,
    framesAnalyzed,
  });
  await proposals.resolveFilmStudyProposal({
    organizationId: ORG_ID,
    proposalId: proposal.proposal_id,
    verdict: 'corrected',
    reviewerAccountId: COACH_ID,
    reviewerRole: 'coach',
    correctedObservationText: 'Lead hand returns low only on the second jab of a double.',
  });
  return proposal.proposal_id;
}

/** A settled coach-reported observation -- what the model missed. */
async function settledCoachReport(
  verdict: 'accepted' | 'rejected' = 'accepted',
): Promise<string> {
  const reported = await proposals.createCoachReportedObservation({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    observationText: 'Model said nothing about the head staying still on the slip.',
    reportedByAccountId: COACH_ID,
  });
  await proposals.resolveFilmStudyProposal({
    organizationId: ORG_ID,
    proposalId: reported.proposal_id,
    verdict,
    reviewerAccountId: COACH_ID,
    reviewerRole: 'coach',
  });
  return reported.proposal_id;
}

/** Empties the proposal table between cases so counts are exact, not cumulative. */
async function truncateProposals(): Promise<void> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    await client.query('truncate pilot.film_study_proposal_revisions, pilot.shadow_film_study_proposals');
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
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  proposals = await import('./shadowFilmStudyProposals');
  validation = await import('./filmStudyValidation');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

  // Shutdown copied from filmStudyCoachReported.pg.test.ts. The `unref()` is
  // the load-bearing part: a plain safety timer keeps Node's event loop alive
  // for its full duration, and Jest reports "did not exit one second after the
  // test run" on a suite that has in fact finished cleanly.
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

beforeEach(truncateProposals);

describe('the accept rate counts model proposals and nothing else', () => {
  /* The case named in the defect report, built from real rows:
   *
   *   accepted  model_proposed
   *   rejected  model_proposed
   *   accepted  coach_reported   <- the model MISSED this
   *
   * Correct: reviewed 2, accepted 1, rejected 1.
   * The defect: reviewed 3, accepted 2 -- the coach's confirmation that the
   * model failed, counted as the model succeeding. */
  test('an accepted coach report is not counted as an accepted model proposal', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    await settledModelProposal(deployment, 'accepted');
    await settledModelProposal(deployment, 'rejected');
    await settledCoachReport('accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);

    expect(report.overall.reviewedCount).toBe(2);
    expect(report.overall.acceptedCount).toBe(1);
    expect(report.overall.rejectedCount).toBe(1);

    // Two settled proposals is below FILM_STUDY_MINIMUM_REVIEWED, so the rate
    // is withheld by design. The counts are what this case is about, and they
    // are reported at every sample size.
    expect(report.overall.status).toBe('insufficient_data');
    expect(report.overall.acceptRate).toBeNull();
  });

  test('the same exclusion holds per deployment', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    await settledModelProposal(deployment, 'accepted');
    await settledModelProposal(deployment, 'rejected');
    await settledCoachReport('accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    const measured = report.byDeployment.find((entry) => entry.modelDeployment === deployment);

    expect(measured).toBeDefined();
    expect(measured?.reviewedCount).toBe(2);
    expect(measured?.acceptedCount).toBe(1);
    expect(measured?.rejectedCount).toBe(1);
  });

  /* A coach-reported row carries `model_deployment is null` -- the provenance
   * constraint requires it, because there was no inference run to name. Grouped
   * without the origin filter it therefore lands in its own bucket, which the
   * report labels 'unknown'. That is not a deployment. It is the missed-
   * detection log wearing a model's clothes, and it would appear in an
   * operator's deployment comparison as a rival to the real one. */
  test('coach reports do not surface as a deployment called "unknown"', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    await settledModelProposal(deployment, 'accepted');
    await settledCoachReport('accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);

    expect(report.byDeployment.map((entry) => entry.modelDeployment)).toEqual([deployment]);
  });

  /* Above the sample floor the contamination stops being a count and becomes
   * the number an operator acts on. Five model proposals -- 3 accepted, 2
   * rejected -- is 60%. Three accepted coach reports would drag the same
   * window to 6 of 8, or 75%: a fifteen-point improvement manufactured
   * entirely out of the model's own misses. */
  test('the reported rate is the model\'s rate, not one inflated by its misses', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i += 1) await settledModelProposal(deployment, 'accepted');
    for (let i = 0; i < 2; i += 1) await settledModelProposal(deployment, 'rejected');
    for (let i = 0; i < 3; i += 1) await settledCoachReport('accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);

    expect(report.overall.status).toBe('available');
    expect(report.overall.reviewedCount).toBe(5);
    expect(report.overall.acceptedCount).toBe(3);
    expect(report.overall.acceptRate).toBe(0.6);
    expect(report.overall.acceptRateDisplay).toBe('60%');

    // The one-line summary is what most readers see, so it is checked too --
    // a corrected query behind a sentence still quoting 6 of 8 would be half a
    // fix.
    expect(validation.describeFilmStudyValidation(report)).toContain('3 of 5');
  });

  /* A pending coach report must not reach the pending count either. Pending is
   * how a reader judges whether the sample is about to move; a queue of
   * missed-detection reports says nothing about model proposals waiting. */
  test('a pending coach report is not counted as a pending model proposal', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: 'Still waiting on a coach.',
      modelDeployment: deployment,
      framesAnalyzed: 4,
    });
    await proposals.createCoachReportedObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      observationText: 'Also waiting, and not the model\'s claim.',
      reportedByAccountId: COACH_ID,
    });

    const report = await validation.getFilmStudyValidation(ORG_ID);

    expect(report.overall.pendingCount).toBe(1);
  });

  /* The fix is a filter on a read, never a delete. Coach reports are the only
   * record of what the model failed to see; losing them would destroy the
   * false-negative evidence to tidy up a rate. This is the assertion that
   * stops a future "cleanup" doing exactly that. */
  test('the excluded coach reports are still in the table, unchanged', async () => {
    const deployment = `vision-${crypto.randomUUID().slice(0, 8)}`;
    await settledModelProposal(deployment, 'accepted');
    const reportedId = await settledCoachReport('accepted');

    await validation.getFilmStudyValidation(ORG_ID);

    const stored = await proposals.getFilmStudyProposal(ORG_ID, reportedId);
    expect(stored).not.toBeNull();
    expect(stored?.origin).toBe('coach_reported');
    expect(stored?.review_state).toBe('accepted');
    expect(stored?.reported_by_account_id).toBe(COACH_ID);
  });
});

describe('a corrected proposal is a verdict, not a gap in the numbers', () => {
  beforeEach(truncateProposals);

  // THE DEFECT THIS SUITE WAS EXTENDED FOR.
  //
  // review_state has four values. Every count in getFilmStudyValidation
  // filters on three of them: reviewedCount is `in ('accepted','rejected')`,
  // pendingCount is `= 'pending_review'`. A corrected row matches none, so it
  // is in no count at all -- while listFilmStudyProposals treats it as still
  // outstanding (its working view is `in ('pending_review','corrected')`).
  // Two shipped reads disagree about the same row, and the one an operator
  // reads reports it as though it did not exist.
  //
  // A correction is also the most informative label the queue produces: the
  // model saw something real and described it wrong. That is neither an
  // acceptance nor a rejection, and it is the row an evaluation dataset most
  // wants.
  test('a corrected proposal is counted, and not as an acceptance', async () => {
    await correctedModelProposal('gpt-vision-1');
    await settledModelProposal('gpt-vision-1', 'accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    expect(report.overall.correctedCount).toBe(1);
    // reviewedCount keeps its shipped meaning -- settled as accepted or
    // rejected. Folding corrections in would change a number already on a
    // coach's screen.
    expect(report.overall.reviewedCount).toBe(1);
    expect(report.overall.acceptedCount).toBe(1);
    expect(report.overall.rejectedCount).toBe(0);
  });

  test('a corrected proposal counts as outstanding, matching the proposal list', async () => {
    await correctedModelProposal('gpt-vision-1');
    await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: 'Chin rises when the right hand goes.',
      modelDeployment: 'gpt-vision-1',
      framesAnalyzed: 6,
    });

    const report = await validation.getFilmStudyValidation(ORG_ID);
    // pendingCount keeps its shipped meaning: never reviewed.
    expect(report.overall.pendingCount).toBe(1);
    // outstandingCount is the working queue, which is what
    // listFilmStudyProposals returns and what a coach still has to open.
    expect(report.overall.outstandingCount).toBe(2);
  });

  test('every model proposal lands in exactly one of the four states', async () => {
    // The arithmetic that makes the report readable: nothing falls through.
    await settledModelProposal('gpt-vision-1', 'accepted');
    await settledModelProposal('gpt-vision-1', 'rejected');
    await correctedModelProposal('gpt-vision-1');
    await proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      jobId: crypto.randomUUID(),
      observationText: 'Feet cross on the retreat.',
      modelDeployment: 'gpt-vision-1',
      framesAnalyzed: 6,
    });
    await settledCoachReport('accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    const { overall } = report;
    expect(overall.modelProposalCount).toBe(4);
    expect(
      overall.acceptedCount + overall.rejectedCount
      + overall.correctedCount + overall.pendingCount,
    ).toBe(overall.modelProposalCount);
    // And the coach report is still excluded from the model's denominator.
    expect(report.coachReportedCount).toBe(1);
  });

  test('corrections are counted per deployment too', async () => {
    await correctedModelProposal('gpt-vision-1');
    await settledModelProposal('gpt-vision-2', 'accepted');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    const one = report.byDeployment.find((d) => d.modelDeployment === 'gpt-vision-1');
    const two = report.byDeployment.find((d) => d.modelDeployment === 'gpt-vision-2');
    expect(one?.correctedCount).toBe(1);
    expect(two?.correctedCount).toBe(0);
  });
});

describe('a correction survives the proposal being finished', () => {
  beforeEach(truncateProposals);

  // Found by the Codex reviewer on this PR. `corrected` is NOT terminal --
  // resolveFilmStudyProposal's guard admits `in ('pending_review','corrected')`
  // -- so a coach who corrects a proposal and then accepts it moves
  // review_state off 'corrected' entirely. A state-only count therefore drops
  // the correction, and the correction rate IMPROVES because the coach
  // finished the queue. That is the exact opposite of what the metric means.
  //
  // pilot.film_study_proposal_revisions keeps every pass, so "was ever
  // corrected" is answerable. Both numbers are kept because they answer
  // different questions: the STATE count is what makes outstandingCount and
  // the four-state arithmetic correct; the HISTORY count is the model
  // evaluation.
  test('a corrected-then-accepted proposal still counts as ever corrected', async () => {
    const proposalId = await correctedModelProposal('gpt-vision-1');
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const { overall } = await validation.getFilmStudyValidation(ORG_ID);
    // No longer paused in the corrected state...
    expect(overall.correctedCount).toBe(0);
    // ...but the model still needed correcting on this proposal.
    expect(overall.everCorrectedCount).toBe(1);
    expect(overall.acceptedCount).toBe(1);
  });

  test('the correction rate does not improve when a coach clears the queue', async () => {
    // Five proposals, one of which needed correcting before it was accepted.
    for (let i = 0; i < 4; i += 1) {
      await settledModelProposal('gpt-vision-1', 'accepted');
    }
    const proposalId = await correctedModelProposal('gpt-vision-1');

    const before = await validation.getFilmStudyValidation(ORG_ID);
    expect(before.overall.correctionRateAmongProposals).toBe(0.2);

    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const after = await validation.getFilmStudyValidation(ORG_ID);
    expect(after.overall.correctionRateAmongProposals).toBe(0.2);
  });

  test('a proposal corrected twice is one correction, not two', async () => {
    // revision_number increments per pass; the metric is proposals that needed
    // correcting, not passes made.
    const proposalId = await correctedModelProposal('gpt-vision-1');
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId,
      verdict: 'corrected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
      correctedObservationText: 'Second pass: only on the double jab, and only off the back foot.',
    });

    const { overall } = await validation.getFilmStudyValidation(ORG_ID);
    expect(overall.everCorrectedCount).toBe(1);
  });
});

describe('the summary line never claims an absence that is not there', () => {
  beforeEach(truncateProposals);

  // Codex P2. With one corrected proposal, reviewedCount and pendingCount are
  // both 0, and describeFilmStudyValidation returned "No Film Study proposals
  // exist yet -- the model has not been asked for anything." The route sends
  // that string straight to the coach page. It is false, and it is false about
  // an absence, which is the shape of claim this module exists to refuse.
  test('a single corrected proposal is not described as no proposals at all', async () => {
    await correctedModelProposal('gpt-vision-1');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    const line = validation.describeFilmStudyValidation(report);
    expect(line).not.toContain('No Film Study proposals exist yet');
    expect(line).toContain('1');
  });

  test('genuinely empty still says so', async () => {
    const report = await validation.getFilmStudyValidation(ORG_ID);
    expect(validation.describeFilmStudyValidation(report))
      .toContain('No Film Study proposals exist yet');
  });
});

describe('a coach report is a claimed miss until a coach confirms it', () => {
  beforeEach(truncateProposals);

  // Codex P2. coachReportedCount was origin-only, so a report still awaiting
  // review -- or one another coach REJECTED -- counted toward what the report
  // documents as "the false-negative record". A mistaken report that was
  // rejected would permanently inflate the model's advertised miss count.
  test('a rejected coach report is not a confirmed miss', async () => {
    await settledCoachReport('accepted');
    await settledCoachReport('rejected');

    const report = await validation.getFilmStudyValidation(ORG_ID);
    expect(report.coachReportedCount).toBe(2);
    expect(report.coachReportedConfirmedCount).toBe(1);
  });

  test('a coach report nobody has reviewed is not a confirmed miss either', async () => {
    await proposals.createCoachReportedObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_ID,
      observationText: 'Model said nothing about the feet crossing.',
      reportedByAccountId: COACH_ID,
    });

    const report = await validation.getFilmStudyValidation(ORG_ID);
    expect(report.coachReportedCount).toBe(1);
    expect(report.coachReportedConfirmedCount).toBe(0);
  });
});
