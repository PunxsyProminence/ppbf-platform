// Real PostgreSQL-backed contract test for BASE-06 coach attempt review.
//
// What reading SQL cannot prove and this does: a review NEVER rewrites the
// source attempt (confirm/correct/dispute all leave the training_attempts row
// byte-identical); the newest review is the current disposition; a corrected
// verdict is computed server-side from the attempt's own direction; a disputed
// attempt abstains -- effective target/achieved/made are all NULL and it counts
// as neither a make nor a miss in the transfer readout; a later confirm or
// correct resolves a dispute while the dispute stays in history; a review row
// cannot be edited in place; and the migration is idempotent with a working
// retention cascade.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attempt-reviews-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'attempt_reviews';

const BASE_SQL = 'pilot_slice_postgres.sql';
const ATTEMPTS_SQL = 'pilot_slice_postgres_training_attempts_migration.sql';
const SPARRING_SQL = 'pilot_slice_postgres_sparring_attempt_contexts_migration.sql';
const REVIEWS_SQL = 'pilot_slice_postgres_training_attempt_reviews_migration.sql';

const ORG_ID = 'org-reviews';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-reviews-admin';
const COACH_ID = 'acct-reviews-coach';
const ATHLETE_ID = 'ath-reviews-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let attempts: typeof import('./trainingAttempts');
let falseProgress: typeof import('./falseProgress');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function readMigration(name: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, name), 'utf8');
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

async function client(): Promise<Client> {
  const c = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await c.connect();
  return c;
}

async function seedTenancy(c: Client): Promise<void> {
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await c.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await c.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await c.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Reviews Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
}

async function truncateReviewsAndAttempts(): Promise<void> {
  const c = await client();
  try {
    await c.query('truncate pilot.training_attempt_reviews, pilot.training_attempts cascade');
  } finally {
    await c.end();
  }
}

async function sourceRow(attemptId: string): Promise<Record<string, unknown> | undefined> {
  const c = await client();
  try {
    const result = await c.query(
      `select organization_id, attempt_id, athlete_id, context_type, context_id, metric_kind,
              direction, target_value::text as target_value, achieved_value::text as achieved_value,
              made, note, attempted_at, recorded_by_account_id, created_at
       from pilot.training_attempts where organization_id = $1 and attempt_id = $2`,
      [ORG_ID, attemptId],
    );
    return result.rows[0];
  } finally {
    await c.end();
  }
}

async function recordControlledMiss(): Promise<string> {
  // A controlled-context miss (assessment) so it lands in the transfer
  // readout's controlled side and its verdict is falsifiable by a correction.
  const row = await attempts.recordAttempt({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    contextType: 'assessment',
    metricKind: 'reps',
    targetValue: 10,
    achievedValue: 8,
    recordedByAccountId: COACH_ID,
  });
  if (!row) throw new Error('setup: attempt not recorded');
  return row.attempt_id;
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

  const migrate = await client();
  await migrate.query(await readMigration(BASE_SQL));
  await migrate.query(await readMigration(ATTEMPTS_SQL));
  await migrate.query(await readMigration(SPARRING_SQL));
  await migrate.query(await readMigration(REVIEWS_SQL));
  await seedTenancy(migrate);
  await migrate.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  attempts = await import('./trainingAttempts');
  falseProgress = await import('./falseProgress');
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

  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(truncateReviewsAndAttempts);

describe('the source attempt is never rewritten by a review', () => {
  test.each(['confirmed', 'disputed'] as const)('%s leaves the source row byte-identical', async (state) => {
    const attemptId = await recordControlledMiss();
    const before = await sourceRow(attemptId);

    await attempts.recordReview({
      organizationId: ORG_ID,
      attemptId,
      reviewState: state,
      reason: state === 'confirmed' ? undefined : 'the rep count on video was clearly wrong',
      reviewedByAccountId: COACH_ID,
    });

    expect(await sourceRow(attemptId)).toEqual(before);
  });

  test('correct leaves the source row byte-identical', async () => {
    const attemptId = await recordControlledMiss();
    const before = await sourceRow(attemptId);

    await attempts.recordReview({
      organizationId: ORG_ID,
      attemptId,
      reviewState: 'corrected',
      correctedTargetValue: 10,
      correctedAchievedValue: 10,
      reason: 'miscount on the last two reps, confirmed on film',
      reviewedByAccountId: COACH_ID,
    });

    expect(await sourceRow(attemptId)).toEqual(before);
  });
});

describe('current disposition and effective interpretation', () => {
  test('unreviewed: effective equals source, no review state', async () => {
    const attemptId = await recordControlledMiss();
    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.attempt_id).toBe(attemptId);
    expect(row.review_state).toBeNull();
    expect(row.effective_made).toBe(false);
    expect(row.effective_achieved_value).toBe('8');
    expect(row.effective_target_value).toBe('10');
  });

  test('confirmed: current disposition confirmed, effective equals source', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('confirmed');
    expect(row.effective_made).toBe(false);
    expect(row.effective_achieved_value).toBe('8');
  });

  test('corrected: corrected values become effective and the verdict is server-derived (at_least)', async () => {
    const attemptId = await recordControlledMiss();
    const review = await attempts.recordReview({
      organizationId: ORG_ID,
      attemptId,
      reviewState: 'corrected',
      correctedTargetValue: 10,
      correctedAchievedValue: 10,
      reason: 'miscount confirmed on film, athlete hit all ten',
      reviewedByAccountId: COACH_ID,
    });
    // The client sent no verdict; the server computed made = (10 >= 10) = true.
    expect(review?.corrected_made).toBe(true);

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('corrected');
    expect(row.made).toBe(false); // source untouched
    expect(row.effective_made).toBe(true); // effective is the correction
    expect(row.effective_achieved_value).toBe('10');
  });

  test('corrected: the server verdict honours the attempt\'s own at_most direction', async () => {
    const row0 = await attempts.recordAttempt({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextType: 'assessment',
      metricKind: 'time_seconds', // defaults to at_most
      targetValue: 90,
      achievedValue: 95,
      recordedByAccountId: COACH_ID,
    });
    const review = await attempts.recordReview({
      organizationId: ORG_ID,
      attemptId: row0!.attempt_id,
      reviewState: 'corrected',
      correctedTargetValue: 90,
      correctedAchievedValue: 88, // faster than target under at_most => made
      reason: 'timing gate glitched; hand time was 88 seconds',
      reviewedByAccountId: COACH_ID,
    });
    expect(review?.corrected_made).toBe(true);
  });

  test('disputed: effective target/achieved/made are all NULL (abstention), source stays readable', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({
      organizationId: ORG_ID,
      attemptId,
      reviewState: 'disputed',
      reason: 'this attempt was logged against the wrong athlete',
      reviewedByAccountId: COACH_ID,
    });

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('disputed');
    expect(row.effective_made).toBeNull();
    expect(row.effective_target_value).toBeNull();
    expect(row.effective_achieved_value).toBeNull();
    // Source evidence remains visible.
    expect(row.made).toBe(false);
    expect(row.achieved_value).toBe('8');
  });
});

describe('false-progress counts the effective verdict', () => {
  test('a corrected miss counts as a make; a disputed miss counts as neither', async () => {
    const corrected = await recordControlledMiss();
    const disputed = await recordControlledMiss();
    const untouched = await recordControlledMiss();

    await attempts.recordReview({
      organizationId: ORG_ID, attemptId: corrected, reviewState: 'corrected',
      correctedTargetValue: 10, correctedAchievedValue: 10,
      reason: 'miscount confirmed on film for this set', reviewedByAccountId: COACH_ID,
    });
    await attempts.recordReview({
      organizationId: ORG_ID, attemptId: disputed, reviewState: 'disputed',
      reason: 'wrong athlete on this row, disputing it', reviewedByAccountId: COACH_ID,
    });
    void untouched;

    const readout = await falseProgress.getTransferReadout(ORG_ID, ATHLETE_ID);
    const reps = readout.find((r) => r.metric_kind === 'reps');
    // Three source misses. corrected -> a make; disputed -> abstains; untouched
    // -> a miss. So exactly one make and one miss counted in the controlled side.
    expect(reps?.controlled_makes).toBe(1);
    expect(reps?.controlled_misses).toBe(1);
  });
});

describe('dispute resolution keeps history', () => {
  test('a later confirm resolves the dispute back to the source verdict', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'disputed', reason: 'unsure this happened as logged', reviewedByAccountId: COACH_ID });
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('confirmed');
    expect(row.effective_made).toBe(false); // source verdict restored as effective

    const history = await attempts.listReviews(ORG_ID, attemptId);
    expect(history.map((r) => r.review_state)).toEqual(['confirmed', 'disputed']);
  });

  test('a later correct resolves the dispute and history still contains the dispute', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'disputed', reason: 'disputing pending a film review', reviewedByAccountId: COACH_ID });
    await attempts.recordReview({
      organizationId: ORG_ID, attemptId, reviewState: 'corrected',
      correctedTargetValue: 10, correctedAchievedValue: 10,
      reason: 'film review settled it: all ten reps were good', reviewedByAccountId: COACH_ID,
    });

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('corrected');
    expect(row.effective_made).toBe(true);

    const history = await attempts.listReviews(ORG_ID, attemptId);
    expect(history).toHaveLength(2);
    expect(history.some((r) => r.review_state === 'disputed')).toBe(true);
  });
});

describe('database invariants', () => {
  test('a review row cannot be edited in place (append-only trigger)', async () => {
    const attemptId = await recordControlledMiss();
    const review = await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const c = await client();
    try {
      await expect(
        c.query(`update pilot.training_attempt_reviews set review_state = 'disputed' where review_id = $1`, [review!.review_id]),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await c.end();
    }
  });

  test('a corrected review with no achieved value is refused by the database', async () => {
    const attemptId = await recordControlledMiss();
    const c = await client();
    try {
      await expect(
        c.query(
          `insert into pilot.training_attempt_reviews
             (organization_id, review_id, attempt_id, review_state, reason, reviewed_by_account_id)
           values ($1, 'rev-bad', $2, 'corrected', 'no achieved value supplied here', $3)`,
          [ORG_ID, attemptId, COACH_ID],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await c.end();
    }
  });

  test('a corrected/disputed review with a too-short reason is refused by the database', async () => {
    const attemptId = await recordControlledMiss();
    const c = await client();
    try {
      await expect(
        c.query(
          `insert into pilot.training_attempt_reviews
             (organization_id, review_id, attempt_id, review_state, reason, reviewed_by_account_id)
           values ($1, 'rev-short', $2, 'disputed', 'nope', $3)`,
          [ORG_ID, attemptId, COACH_ID],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await c.end();
    }
  });

  test('a review cannot reference an attempt from another organization', async () => {
    const attemptId = await recordControlledMiss();
    const c = await client();
    try {
      await expect(
        c.query(
          `insert into pilot.training_attempt_reviews
             (organization_id, review_id, attempt_id, review_state, reviewed_by_account_id)
           values ($1, 'rev-cross', $2, 'confirmed', $3)`,
          [OTHER_ORG_ID, attemptId, COACH_ID],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await c.end();
    }
  });

  test('deleting the source attempt cascades to its reviews (retention keeps working)', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const c = await client();
    try {
      await c.query('delete from pilot.training_attempts where organization_id = $1 and attempt_id = $2', [ORG_ID, attemptId]);
      const remaining = await c.query('select count(*)::int as n from pilot.training_attempt_reviews where attempt_id = $1', [attemptId]);
      expect(remaining.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  test('re-applying the migration is a no-op that leaves rows untouched', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const c = await client();
    try {
      await c.query(await readMigration(REVIEWS_SQL));
      const rows = await c.query('select review_id from pilot.training_attempt_reviews where attempt_id = $1', [attemptId]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await c.end();
    }
  });

  test('recordReview on a nonexistent attempt is a hidden null, not a thrown error', async () => {
    expect(await attempts.recordReview({ organizationId: ORG_ID, attemptId: 'no-such-attempt', reviewState: 'confirmed', reviewedByAccountId: COACH_ID })).toBeNull();
  });
});
