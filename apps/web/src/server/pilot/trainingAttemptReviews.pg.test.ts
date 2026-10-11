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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

// Lane N3-01's route-level block (bottom of this file) drives the real routes.
// They take their principal from here; everything else in the module -- and
// every other module, access.ts included -- stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

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
// pilot.athletes.deleted_at, which the real athlete-access check reads.
const DELETION_SQL = 'pilot_slice_postgres_data_retention_deletion_migration.sql';

const ORG_ID = 'org-reviews';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-reviews-admin';
const COACH_ID = 'acct-reviews-coach';
const ATHLETE_ID = 'ath-reviews-1';
// Same gym as COACH_ID, coach of record for nobody and holding no cover.
const UNASSIGNED_COACH_ID = 'acct-reviews-coach-unassigned';
// A coach in the other gym.
const FOREIGN_COACH_ID = 'acct-elsewhere-coach';

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
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft'), ($3, 'coach', $4, 'microsoft')
     on conflict do nothing`,
    [UNASSIGNED_COACH_ID, ORG_ID, FOREIGN_COACH_ID, OTHER_ORG_ID],
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
  await migrate.query(await readMigration(DELETION_SQL));
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

describe('data minimization: reviewer identity is coach-only', () => {
  test('listAttempts (the athlete-visible projection) omits reviewed_by_account_id, listReviews keeps it', async () => {
    const attemptId = await recordControlledMiss();
    await attempts.recordReview({ organizationId: ORG_ID, attemptId, reviewState: 'confirmed', reviewedByAccountId: COACH_ID });

    const [row] = await attempts.listAttempts(ORG_ID, ATHLETE_ID);
    expect(row.review_state).toBe('confirmed');
    // The general attempt DTO an athlete receives must not carry the coach's
    // internal account id. review_reason/corrected values may show; the
    // reviewer account id may not.
    expect(row).not.toHaveProperty('reviewed_by_account_id');

    // Coach-only review history keeps reviewer provenance.
    const history = await attempts.listReviews(ORG_ID, attemptId);
    expect(history[0].reviewed_by_account_id).toBe(COACH_ID);
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

// Lane N3-01 (work order DONE WHEN). Everything above calls the modules. This
// block is the coach's whole path through the REAL routes -- record, list,
// review, review history, transfer check -- with the REAL access.ts deciding
// which athlete each coach may reach, on a real database. Only the session
// lookup is stood in for. What it proves and the mocked route tests cannot:
// the readout a coach is handed follows the reviews they wrote, and a coach
// who is not this athlete's coach gets nothing and writes nothing.
describe('through the routes: record, correct, dispute, and the transfer readout that follows', () => {
  const mockRequirePrincipal = requirePrincipal as jest.Mock;

  let attemptsRoute: typeof import('@/app/api/pilot/training-attempts/route');
  let reviewRoute: typeof import('@/app/api/pilot/training-attempts/review/route');
  let transferRoute: typeof import('@/app/api/pilot/coach/transfer-check/route');

  interface AttemptItem {
    attempt_id: string;
    achieved_value: string;
    made: boolean | null;
    review_state: string | null;
    corrected_achieved_value: string | null;
    corrected_made: boolean | null;
    effective_made: boolean | null;
  }
  interface ReadoutItem {
    metric_kind: string;
    controlled_makes: number;
    controlled_misses: number;
    live_makes: number;
    live_misses: number;
    state: string;
  }

  beforeAll(async () => {
    attemptsRoute = await import('@/app/api/pilot/training-attempts/route');
    reviewRoute = await import('@/app/api/pilot/training-attempts/review/route');
    transferRoute = await import('@/app/api/pilot/coach/transfer-check/route');
  });

  function signInAs(accountId: string, organizationId: string): void {
    const principal: PilotPrincipal = {
      accountId,
      role: 'coach',
      organizationId,
      athleteId: null,
      sessionToken: `token-${accountId}`,
      authProvider: 'microsoft',
    };
    mockRequirePrincipal.mockResolvedValue(principal);
  }

  const get = (pathAndQuery: string) => new NextRequest(`http://localhost${pathAndQuery}`);
  const post = (pathname: string, body: unknown) =>
    new NextRequest(`http://localhost${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Records one targeted reps attempt (target 10) through the route. */
  async function record(contextType: string, achieved: number): Promise<AttemptItem> {
    const response = await attemptsRoute.POST(post('/api/pilot/training-attempts', {
      athlete_id: ATHLETE_ID,
      metric_kind: 'reps',
      context_type: contextType,
      target_value: 10,
      achieved_value: achieved,
    }));
    expect(response.status).toBe(200);
    return ((await response.json()) as { item: AttemptItem }).item;
  }

  async function review(body: Record<string, unknown>): Promise<Response> {
    return reviewRoute.POST(post('/api/pilot/training-attempts/review', body));
  }

  async function repsReadout(): Promise<ReadoutItem | undefined> {
    const response = await transferRoute.GET(get(`/api/pilot/coach/transfer-check?athlete_id=${ATHLETE_ID}`));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: ReadoutItem[] };
    return items.find((item) => item.metric_kind === 'reps');
  }

  async function listed(): Promise<AttemptItem[]> {
    const response = await attemptsRoute.GET(get(`/api/pilot/training-attempts?athlete_id=${ATHLETE_ID}`));
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: AttemptItem[] }).items;
  }

  async function rowCounts(): Promise<{ attempts: number; reviews: number }> {
    const c = await client();
    try {
      const result = await c.query(
        `select (select count(*)::int from pilot.training_attempts) as attempts,
                (select count(*)::int from pilot.training_attempt_reviews) as reviews`,
      );
      return result.rows[0] as { attempts: number; reviews: number };
    } finally {
      await c.end();
    }
  }

  test('the assigned coach records, corrects and disputes, and each readout is built from the right evidence', async () => {
    signInAs(COACH_ID, ORG_ID);

    // Practice: three makes and one miss. The verdict is the server's.
    expect((await record('assessment', 10)).made).toBe(true);
    await record('assessment', 11);
    await record('assessment', 10);
    expect((await record('assessment', 8)).made).toBe(false);

    // Strong in practice, never tried live: untested, not failing.
    expect(await repsReadout()).toMatchObject({
      controlled_makes: 3, controlled_misses: 1, live_makes: 0, live_misses: 0, state: 'untested_live',
    });

    // Three live misses: the gain is not transferring.
    const liveA = await record('open_sparring', 4);
    const liveB = await record('open_sparring', 5);
    await record('open_sparring', 6);
    expect(await repsReadout()).toMatchObject({ live_makes: 0, live_misses: 3, state: 'not_transferring' });

    // CORRECT one live miss: the coach counted ten on film. It now counts as a
    // make (1 of 3 clears the weak line), and the athlete's own number stays.
    const corrected = await review({
      attempt_id: liveA.attempt_id,
      review_state: 'corrected',
      corrected_target_value: 10,
      corrected_achieved_value: 10,
      reason: 'ten clean reps on the film of this round',
    });
    expect(corrected.status).toBe(200);
    expect(((await corrected.json()) as { item: { corrected_made: boolean } }).item.corrected_made).toBe(true);
    expect(await repsReadout()).toMatchObject({ live_makes: 1, live_misses: 2, state: 'transferring' });

    const afterCorrection = (await listed()).find((item) => item.attempt_id === liveA.attempt_id);
    expect(afterCorrection).toMatchObject({
      achieved_value: '4', made: false,
      review_state: 'corrected', corrected_achieved_value: '10', corrected_made: true,
      effective_made: true,
    });

    // DISPUTE another live miss: it is evidence for neither side now, which
    // leaves two live attempts -- too few to say anything.
    const disputed = await review({
      attempt_id: liveB.attempt_id,
      review_state: 'disputed',
      reason: 'this round was logged against the wrong athlete',
    });
    expect(disputed.status).toBe(200);
    expect(await repsReadout()).toMatchObject({ live_makes: 1, live_misses: 1, state: 'insufficient_evidence' });

    const afterDispute = (await listed()).find((item) => item.attempt_id === liveB.attempt_id);
    expect(afterDispute).toMatchObject({ achieved_value: '5', made: false, review_state: 'disputed', effective_made: null });

    // CONFIRM it after all: the dispute is resolved back to the source miss,
    // and the dispute is still in the history.
    expect((await review({ attempt_id: liveB.attempt_id, review_state: 'confirmed' })).status).toBe(200);
    expect(await repsReadout()).toMatchObject({ live_makes: 1, live_misses: 2, state: 'transferring' });

    const history = await reviewRoute.GET(get(`/api/pilot/training-attempts/review?attempt_id=${liveB.attempt_id}`));
    expect(history.status).toBe(200);
    const states = ((await history.json()) as { items: Array<{ review_state: string }> }).items.map((item) => item.review_state);
    expect(states.sort()).toEqual(['confirmed', 'disputed']);

    expect(await rowCounts()).toEqual({ attempts: 7, reviews: 3 });
  });

  describe('a coach who is not this athlete\'s coach', () => {
    let attemptId: string;

    beforeEach(async () => {
      signInAs(COACH_ID, ORG_ID);
      attemptId = (await record('assessment', 8)).attempt_id;
    });

    async function expectNothingReadAndNothingWritten(refusals: Response[]): Promise<void> {
      for (const response of refusals) {
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('items');
        expect(body).not.toHaveProperty('item');
      }
      expect(await rowCounts()).toEqual({ attempts: 1, reviews: 0 });
    }

    test('in the same gym: refused on every route, and nothing is written', async () => {
      signInAs(UNASSIGNED_COACH_ID, ORG_ID);

      const refusals = [
        await attemptsRoute.GET(get(`/api/pilot/training-attempts?athlete_id=${ATHLETE_ID}`)),
        await attemptsRoute.POST(post('/api/pilot/training-attempts', {
          athlete_id: ATHLETE_ID, metric_kind: 'reps', context_type: 'assessment', target_value: 10, achieved_value: 10,
        })),
        await review({ attempt_id: attemptId, review_state: 'confirmed' }),
        await review({
          attempt_id: attemptId, review_state: 'corrected', corrected_target_value: 10, corrected_achieved_value: 10,
          reason: 'not my athlete, but trying anyway',
        }),
        await reviewRoute.GET(get(`/api/pilot/training-attempts/review?attempt_id=${attemptId}`)),
        await transferRoute.GET(get(`/api/pilot/coach/transfer-check?athlete_id=${ATHLETE_ID}`)),
      ];

      expect(refusals.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
      await expectNothingReadAndNothingWritten(refusals);
    });

    test('in another gym: the athlete is refused and the attempt does not exist', async () => {
      signInAs(FOREIGN_COACH_ID, OTHER_ORG_ID);

      const refusals = [
        await attemptsRoute.GET(get(`/api/pilot/training-attempts?athlete_id=${ATHLETE_ID}`)),
        await attemptsRoute.POST(post('/api/pilot/training-attempts', {
          athlete_id: ATHLETE_ID, metric_kind: 'reps', context_type: 'assessment', target_value: 10, achieved_value: 10,
        })),
        // The attempt is loaded inside the caller's own gym first, so another
        // gym's attempt id is a hidden not-found, never a "forbidden".
        await review({ attempt_id: attemptId, review_state: 'confirmed' }),
        await reviewRoute.GET(get(`/api/pilot/training-attempts/review?attempt_id=${attemptId}`)),
        await transferRoute.GET(get(`/api/pilot/coach/transfer-check?athlete_id=${ATHLETE_ID}`)),
      ];

      expect(refusals.map((response) => response.status)).toEqual([403, 403, 404, 404, 403]);
      await expectNothingReadAndNothingWritten(refusals);
    });
  });
});
