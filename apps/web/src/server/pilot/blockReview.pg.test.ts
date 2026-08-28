// Real PostgreSQL-backed contract test for the block-review migration AND for
// the plan-versus-actual evidence read.
//
// The schema is built by applyFullSchema, for the reason its header gives:
// the evidence read touches SEVEN tables this slice does not own, across five
// different migrations, and hand-picking that chain is how a suite ends up
// testing a database that has never existed. The runner-readiness REFUSAL
// case is the one thing applyFullSchema cannot give, so it uses a
// base-schema-only database.
//
// What needs proving that reading SQL cannot prove:
//   * the five human-selected adherence states are a DATABASE fact, and
//     'unknown' is the default -- a coach who has not decided has not decided;
//   * SAYING "delivered with deviations" MEANS SAYING WHAT THEY WERE. The
//     constraint is copied from the intervention ledger and has to bite here
//     too, or an unreviewable judgement is storable;
//   * the table holds no percentage, ratio, score or completion column;
//   * every evidence source actually reads the table it claims to, against
//     real rows -- six SELECTs across seven tables is where a column name is
//     silently wrong and a source quietly returns nothing forever;
//   * a source with nothing in the window returns ZERO rather than throwing,
//     and a zero is a count of records rather than a judgement;
//   * the window is a window: rows outside the block's dates are excluded,
//     and rows belonging to another athlete or another gym never appear;
//   * a review does not survive its block, and does not block the retention
//     purge.
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

import { blockEvidence, listBlockReviews, recordBlockReview } from './blockReview';
import { ValidationError } from './errors';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-block-review-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_block_review_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-block-review-migration.mjs',
);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-review';
const OTHER_ORG_ID = 'org-elsewhere';
const COACH_ID = 'acct-review-coach';
const OTHER_COACH_ID = 'acct-review-other';
const ATHLETE_ID = 'ath-review-1';
const OTHER_ATHLETE_ID = 'ath-review-2';

// The block's window. Every evidence fixture below is placed relative to
// these two dates on purpose.
const STARTS_ON = '2026-08-01';
const ENDS_ON = '2026-09-30';
const INSIDE = '2026-08-15';
const BEFORE = '2026-07-01';
const AFTER = '2026-11-01';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function seededDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.disciplines
         (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')
       on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'coach', $4, 'microsoft')
     on conflict do nothing`,
    [COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $3, 'coach', true), ($2, $4, 'coach', true)
     on conflict do nothing`,
    [COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
  );

  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, OTHER_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, 'ath-elsewhere', OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Review Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  await client.query(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, 'blk-1', $2, 'Late summer block', 'Round-three work rate.',
             $3::date, $4::date, 'active', $5)
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, STARTS_ON, ENDS_ON, COACH_ID],
  );

  activeClient = client;
  return client;
}

/**
 * One row in every evidence source: inside the window for this athlete, plus
 * a decoy outside the window, a decoy for another athlete, and a decoy in
 * another gym wherever the table allows one.
 *
 * The decoys are the point. A read that returned everything, or that dropped
 * its window, would still show 1 for each source against a fixture with only
 * the wanted row -- so each source gets something it must NOT return.
 */
async function seedEvidence(client: Client) {
  // A script and three delivered runs; one linked to the block, two not.
  await client.query(
    `insert into pilot.session_scripts
       (organization_id, script_id, lineage_id, version, name, created_by_account_id)
     values ($1, 'scr-1', 'scr-1', 1, 'Tuesday Technical', $2)
     on conflict do nothing`,
    [ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on)
     values ($1, 'run-linked', 'scr-1', 1, $2, $3::date),
            ($1, 'run-unlinked', 'scr-1', 1, $2, $3::date)
     on conflict do nothing`,
    [ORG_ID, COACH_ID, INSIDE],
  );
  await client.query(
    `insert into pilot.session_run_development_block_links
       (organization_id, run_id, block_id, linked_by_account_id)
     values ($1, 'run-linked', 'blk-1', $2) on conflict do nothing`,
    [ORG_ID, COACH_ID],
  );

  // Training attempts: one inside, one before, one for the other athlete.
  for (const [attemptId, athleteId, when] of [
    ['att-in', ATHLETE_ID, INSIDE],
    ['att-before', ATHLETE_ID, BEFORE],
    ['att-other', OTHER_ATHLETE_ID, INSIDE],
  ] as const) {
    await client.query(
      `insert into pilot.training_attempts
         (organization_id, attempt_id, athlete_id, context_type, metric_kind,
          achieved_value, attempted_at, recorded_by_account_id)
       values ($1, $2, $3, 'session', 'reps', 8, $4::date, $5)
       on conflict do nothing`,
      [ORG_ID, attemptId, athleteId, when, COACH_ID],
    );
  }

  /* Activity log: one boxing entry inside the window, one after it, and one
     SCHOOLWORK entry inside it.

     The schoolwork row is the decoy that matters most in this fixture.
     pilot.activity_log is cross-domain -- tutoring, community service and
     work-study hours sit in it beside training -- and every domain a block's
     objectives can name is athletic. A read that counted it would report a
     tutoring session as evidence that a TRAINING plan was carried out: a true
     record answering a question nobody asked, which is the quietest way this
     panel could mislead. */
  for (const [activityId, domain, when] of [
    ['act-in', 'boxing_training', INSIDE],
    ['act-after', 'boxing_training', AFTER],
    ['act-schoolwork', 'schoolwork', INSIDE],
  ] as const) {
    await client.query(
      `insert into pilot.activity_log
         (organization_id, activity_id, person_account_id, athlete_id,
          activity_domain, activity_type, occurred_on, duration_minutes,
          what_was_worked_on, capture_method, recorded_by_role,
          recorded_by_account_id)
       values ($1, $2, $6, $3, $4, 'technical_session', $5::date,
               60, 'Guard recovery', 'coach_override', 'coach', $6)
       on conflict do nothing`,
      [ORG_ID, activityId, ATHLETE_ID, domain, when, COACH_ID],
    );
  }

  /* Assessments: one administered inside the window, one before it, and one
     SCHEDULED AND NEVER ADMINISTERED -- administered_on null, created inside
     the window.

     That third row is the one that matters. Its created_at sits squarely in
     the block, so a read windowed on when the ROW was written would count a
     test nobody has given as evidence that a plan was carried out: the most
     flattering possible way to be wrong about a child's training record. It
     is neither in the window nor outside it -- no window can place it -- so
     it is counted apart, as `undated`. */
  for (const [assessmentId, administeredOn] of [
    ['11111111-1111-1111-1111-111111111111', INSIDE],
    ['22222222-2222-2222-2222-222222222222', BEFORE],
    ['33333333-3333-3333-3333-333333333333', null],
  ] as const) {
    await client.query(
      `insert into pilot.assessments
         (organization_id, assessment_id, athlete_id, assessment_type,
          administered_on, created_at, updated_at)
       values ($1, $2::uuid, $3, 'movement_screen', $4::date, $5::date, $5::date)
       on conflict do nothing`,
      [ORG_ID, assessmentId, ATHLETE_ID, administeredOn, INSIDE],
    );
  }

  /* Intervention executions: one started inside the window, one before it,
     and one NOT YET STARTED -- actual_start null, created inside the window.
     Same shape and same reason as the assessments above: a plan that has not
     begun is not evidence that it was delivered. Each execution heads its own
     lineage, because idx_intervention_executions_one_current admits only one
     live row per lineage. */
  await client.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, title, target_problem,
        hypothesis, intervention_description, expected_outcome, created_by_account_id)
     values ($1, 'prot-1', 'prot-1', 'Round three work rate',
             'Output falls away in the third.', 'Pacing, not conditioning.',
             'Constrained live rounds with an output floor.',
             'Third-round output holds within ten percent of the first.', $2)
     on conflict do nothing`,
    [ORG_ID, COACH_ID],
  );
  for (const [executionId, actualStart] of [
    ['exec-in', INSIDE],
    ['exec-before', BEFORE],
    ['exec-unstarted', null],
  ] as const) {
    await client.query(
      `insert into pilot.intervention_executions
         (organization_id, execution_id, lineage_id, athlete_id, protocol_id,
          protocol_version, recorded_by_account_id, adherence, actual_start,
          created_at, updated_at)
       values ($1, $2, $2, $3, 'prot-1', 1, $4, 'delivered_as_planned', $5::date,
               $6::date, $6::date)
       on conflict do nothing`,
      [ORG_ID, executionId, ATHLETE_ID, COACH_ID, actualStart, INSIDE],
    );
  }

  // A session and a coach review of it, windowed on the SESSION's date.
  await client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes,
        completed_flag, created_at, updated_at)
     values ($1, 'ses-1', $2, $3::date, 6, 'athlete_post_session_self_report', '',
             true, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, INSIDE],
  );
  await client.query(
    `insert into pilot.coach_reviews
       (organization_id, review_id, session_id, coach_id, decision, notes,
        approved_flag, created_at, updated_at)
     values ($1, 'crev-1', 'ses-1', $2, 'approved', '', true, now(), now())
     on conflict do nothing`,
    [ORG_ID, COACH_ID],
  );
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
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
});

afterEach(() => {
  activeClient = null;
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

describe('the judgement the order asked for, and the number it refused', () => {
  test('the five human-selected states are a database fact, and unknown is the default', async () => {
    const client = await seededDatabase('br_vocab');
    try {
      for (const state of [
        'delivered_as_planned', 'under_delivered', 'not_delivered', 'unknown',
      ]) {
        await client.query(
          `insert into pilot.athlete_development_block_reviews
             (organization_id, review_id, block_id, adherence_state, reviewed_by_account_id)
           values ($1, $2, 'blk-1', $3, $4)`,
          [ORG_ID, `rev-${state}`, state, COACH_ID],
        );
      }
      // A state from outside the vocabulary -- including a plausible-sounding
      // one -- is refused by the database, not by a caller remembering.
      await expect(client.query(
        `insert into pilot.athlete_development_block_reviews
           (organization_id, review_id, block_id, adherence_state, reviewed_by_account_id)
         values ($1, 'rev-bad', 'blk-1', 'partially_delivered', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23514' });

      await client.query(
        `insert into pilot.athlete_development_block_reviews
           (organization_id, review_id, block_id, reviewed_by_account_id)
         values ($1, 'rev-default', 'blk-1', $2)`,
        [ORG_ID, COACH_ID],
      );
      const defaulted = await client.query(
        `select adherence_state from pilot.athlete_development_block_reviews
         where review_id = 'rev-default'`,
      );
      // Not 'not_delivered'. A coach who has not decided has not decided.
      expect(defaulted.rows[0].adherence_state).toBe('unknown');
    } finally {
      await client.end();
    }
  });

  test('saying "delivered with deviations" means saying what they were', async () => {
    const client = await seededDatabase('br_deviations');
    try {
      const insert = (reviewId: string, deviations: string) => client.query(
        `insert into pilot.athlete_development_block_reviews
           (organization_id, review_id, block_id, adherence_state, deviations,
            reviewed_by_account_id)
         values ($1, $2, 'blk-1', 'delivered_with_deviations', $3, $4)`,
        [ORG_ID, reviewId, deviations, COACH_ID],
      );

      await expect(insert('rev-blank', '')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('rev-spaces', '   ')).rejects.toMatchObject({ code: '23514' });
      // The tab case: btrim/1 trims spaces only, so the one-argument spelling
      // would accept this while every JavaScript caller calls it empty.
      await expect(insert('rev-tab', '\t\n')).rejects.toMatchObject({ code: '23514' });

      await insert('rev-ok', 'Dropped the Thursday session two weeks running.');

      // And the rule applies ONLY to that state: an under-delivered block with
      // no deviations text is a legitimate thing to record.
      await client.query(
        `insert into pilot.athlete_development_block_reviews
           (organization_id, review_id, block_id, adherence_state, reviewed_by_account_id)
         values ($1, 'rev-under', 'blk-1', 'under_delivered', $2)`,
        [ORG_ID, COACH_ID],
      );
    } finally {
      await client.end();
    }
  });

  test('the table holds no percentage, ratio, score or completion column', async () => {
    const client = await seededDatabase('br_columns');
    try {
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'athlete_development_block_reviews'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      /* The order's own refusal: "Do not invent an adherence percentage." A
         column that could hold one is how it comes back. */
      for (const forbidden of [
        'adherence_percent', 'adherence_pct', 'percent', 'percentage', 'ratio',
        'coverage', 'completion', 'completion_pct', 'score', 'rating', 'grade',
        'sessions_delivered', 'sessions_planned', 'compliance',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      expect(names).toContain('adherence_state');
      expect(names).toContain('next_adjustment');
    } finally {
      await client.end();
    }
  });

  test('a review does not outlive its block, or block the retention purge', async () => {
    const client = await seededDatabase('br_purge');
    try {
      await recordBlockReview({
        organizationId: ORG_ID, blockId: 'blk-1',
        adherenceState: 'delivered_as_planned', reviewedByAccountId: COACH_ID,
      });
      await client.query(
        `update pilot.athletes set deleted_at = now() - interval '3 years'
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );

      // The purge's exact statement. It relies entirely on cascades.
      const purged = await client.query(
        `delete from pilot.athletes
         where deleted_at is not null and deleted_at < (now() - interval '2 years')
         returning athlete_id`,
      );
      expect(purged.rows.map((row) => row.athlete_id)).toEqual([ATHLETE_ID]);

      const reviews = await client.query(
        `select count(*)::int as n from pilot.athlete_development_block_reviews`,
      );
      expect(reviews.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('the module recording a review', () => {
  test('a coach records one, and the words come back exactly as written', async () => {
    const client = await seededDatabase('br_mod_write');
    try {
      const review = await recordBlockReview({
        organizationId: ORG_ID,
        blockId: 'blk-1',
        adherenceState: 'delivered_with_deviations',
        deviations: '  Dropped the Thursday session twice.  ',
        reason: 'Hall was double-booked.',
        whatWorked: 'The Tuesday work held up.',
        whatDidNot: 'Volume never recovered.',
        nextAdjustment: 'Move the second session to Friday.',
        reviewedByAccountId: COACH_ID,
      });

      expect(review).toMatchObject({
        adherence_state: 'delivered_with_deviations',
        deviations: 'Dropped the Thursday session twice.',
        reason: 'Hall was double-booked.',
        what_worked: 'The Tuesday work held up.',
        what_did_not: 'Volume never recovered.',
        next_adjustment: 'Move the second session to Friday.',
        reviewed_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  test('an unsound review is refused before it reaches the database', async () => {
    const client = await seededDatabase('br_mod_shape');
    try {
      await expect(recordBlockReview({
        organizationId: ORG_ID, blockId: 'blk-1',
        adherenceState: 'delivered_with_deviations', deviations: '   ',
        reviewedByAccountId: COACH_ID,
      })).rejects.toBeInstanceOf(ValidationError);

      await expect(recordBlockReview({
        organizationId: ORG_ID, blockId: 'blk-1',
        adherenceState: 'mostly_fine' as never, reviewedByAccountId: COACH_ID,
      })).rejects.toBeInstanceOf(ValidationError);

      const rows = await client.query(
        `select count(*)::int as n from pilot.athlete_development_block_reviews`,
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('reviews accumulate rather than overwrite, newest first', async () => {
    const client = await seededDatabase('br_mod_history');
    try {
      /* A block reviewed mid-way and again at the end has two true readings.
         Showing only the second erases the more useful half -- which is why
         nothing here amends a review in place. */
      await recordBlockReview({
        organizationId: ORG_ID, blockId: 'blk-1',
        adherenceState: 'under_delivered', reason: 'Hall closed for two weeks.',
        reviewedByAccountId: COACH_ID,
      });
      await client.query(
        `update pilot.athlete_development_block_reviews
         set created_at = now() - interval '10 days'`,
      );
      await recordBlockReview({
        organizationId: ORG_ID, blockId: 'blk-1',
        adherenceState: 'delivered_as_planned', reason: 'Recovered in September.',
        reviewedByAccountId: COACH_ID,
      });

      const reviews = await listBlockReviews(ORG_ID, 'blk-1');
      expect(reviews).toHaveLength(2);
      expect(reviews[0].adherence_state).toBe('delivered_as_planned');
      expect(reviews[1].adherence_state).toBe('under_delivered');
      // The earlier judgement is untouched.
      expect(reviews[1].reason).toBe('Hall closed for two weeks.');

      // Another organization's read sees none of it.
      expect(await listBlockReviews(OTHER_ORG_ID, 'blk-1')).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('the evidence read: what was actually recorded', () => {
  test('every source reads its own table, against real rows', async () => {
    const client = await seededDatabase('br_evidence');
    try {
      await seedEvidence(client);

      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);
      const by = Object.fromEntries(sources.map((s) => [s.key, s]));

      /* Six SELECTs across seven tables is exactly where a column name is
         silently wrong and a source returns nothing forever. Each is asserted
         to have found its ONE seeded row -- not merely to have not thrown. */
      expect(by.sessions.recorded).toBe(1);
      expect(by.sessions.recent[0]).toMatchObject({ when: INSIDE, detail: 'Tuesday Technical' });
      expect(by.training_attempts.recorded).toBe(1);
      expect(by.training_attempts.recent[0]).toMatchObject({ when: INSIDE, detail: 'session' });
      expect(by.activity_log.recorded).toBe(1);
      expect(by.activity_log.recent[0]).toMatchObject({ when: INSIDE, detail: 'Guard recovery' });
      expect(by.assessments.recorded).toBe(1);
      expect(by.assessments.recent[0]).toMatchObject({ when: INSIDE, detail: 'movement_screen' });
      expect(by.coach_reviews.recorded).toBe(1);
      expect(by.coach_reviews.recent[0]).toMatchObject({ when: INSIDE, detail: 'approved' });
      expect(by.intervention_executions.recorded).toBe(1);
      expect(by.intervention_executions.recent[0])
        .toMatchObject({ when: INSIDE, detail: 'delivered_as_planned' });
    } finally {
      await client.end();
    }
  });

  test('the window is a window, and the athlete is the athlete', async () => {
    const client = await seededDatabase('br_window');
    try {
      await seedEvidence(client);

      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);
      const by = Object.fromEntries(sources.map((s) => [s.key, s]));

      /* Each source was seeded with a decoy it must NOT return: an attempt
         before the window and one for another athlete, a boxing activity entry
         after the window AND a schoolwork entry inside it, an assessment and
         an intervention execution before it, and a delivered session that was
         never linked to this block. A read that dropped its filters would
         show 2 or 3 here. */
      expect(by.training_attempts.recorded).toBe(1);
      /* One, not two. The schoolwork entry sits inside the window, for this
         athlete, and is not evidence about a training plan -- the same rule
         CT-13's reconciled view applies at rank 1, for the same reason. */
      expect(by.activity_log.recorded).toBe(1);
      expect(by.assessments.recorded).toBe(1);
      expect(by.intervention_executions.recorded).toBe(1);
      // The unlinked run is the sessions decoy: this source is scoped by the
      // coach's LINK, not by the date, so a date-scoped read would return 2.
      expect(by.sessions.recorded).toBe(1);

      // Another gym's read of the same block id finds nothing at all.
      const elsewhere = await blockEvidence(OTHER_ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);
      for (const source of elsewhere) {
        expect([source.key, source.recorded]).toEqual([source.key, 0]);
        // The undated counts are org-scoped too. They carry no date to filter
        // on, so their tenancy predicate is the only thing holding them.
        expect([source.key, source.undated]).toEqual([source.key, 0]);
      }
    } finally {
      await client.end();
    }
  });

  test('a count is of every row, not of the few it shows', async () => {
    const client = await seededDatabase('br_count');
    try {
      /* SEVEN attempts, against a RECENT_LIMIT of five. The gap is the whole
         test: `recorded` answers "how many are on record" and `recent`
         answers "show me some", and a count quietly capped at the number of
         entries it displays would report seven attempts as five. That is not
         a rendering bug -- it is the surface understating a child's training
         record while looking exactly as authoritative as the truth. A
         mutation that computed the count from the shown slice survived every
         other test here, because nothing else seeded more than five. */
      for (let index = 1; index <= 7; index += 1) {
        await client.query(
          `insert into pilot.training_attempts
             (organization_id, attempt_id, athlete_id, context_type, metric_kind,
              achieved_value, attempted_at, recorded_by_account_id)
           values ($1, $2, $3, 'session', 'reps', 8, $4::date, $5)`,
          [ORG_ID, `att-${index}`, ATHLETE_ID, `2026-09-0${index}`, COACH_ID],
        );
      }

      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);
      const attempts = sources.find((item) => item.key === 'training_attempts');

      expect(attempts?.recorded).toBe(7);
      // Five shown, newest first -- and the count above still says seven.
      expect(attempts?.recent).toHaveLength(5);
      expect(attempts?.recent.map((entry) => entry.when)).toEqual([
        '2026-09-07', '2026-09-06', '2026-09-05', '2026-09-04', '2026-09-03',
      ]);
    } finally {
      await client.end();
    }
  });

  test('an empty record is six zeroes, not an error and not a judgement', async () => {
    const client = await seededDatabase('br_empty');
    try {
      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);

      expect(sources).toHaveLength(6);
      for (const source of sources) {
        expect([source.key, source.recorded]).toEqual([source.key, 0]);
        expect([source.key, source.undated]).toEqual([source.key, 0]);
        expect(source.recent).toEqual([]);
        // The label says "recorded" on every source. A zero means nobody
        // recorded anything -- never that the athlete did not train.
        expect(source.label.toLowerCase()).not.toMatch(/missing|none|gap|neglect|failed/);
      }
    } finally {
      await client.end();
    }
  });

  test('a row with no event date is counted apart, never in and never gone', async () => {
    const client = await seededDatabase('br_undated');
    try {
      await seedEvidence(client);

      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);
      const by = Object.fromEntries(sources.map((s) => [s.key, s]));

      /* THE THIRD STATE. pilot.assessments.administered_on is null for a test
         that was scheduled and never given, and
         pilot.intervention_executions.actual_start is null for a plan that
         has not begun. Both fixtures were CREATED inside the window, so a
         read windowed on created_at would count them -- reporting work that
         has not happened as evidence that a plan was carried out.

         They are also not nothing: the rows exist and a coach looking for
         them should see them. So neither count absorbs the other. */
      expect(by.assessments.recorded).toBe(1);
      expect(by.assessments.undated).toBe(1);
      expect(by.intervention_executions.recorded).toBe(1);
      expect(by.intervention_executions.undated).toBe(1);

      // The four sources whose event date is NOT NULL can never have one.
      for (const key of ['sessions', 'training_attempts', 'activity_log', 'coach_reviews']) {
        expect([key, by[key].undated]).toEqual([key, 0]);
      }

      // And an undated row is never shown as a dated entry.
      expect(by.assessments.recent.every((entry) => entry.when)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('nothing in the evidence read computes a ratio or a verdict', async () => {
    const client = await seededDatabase('br_no_verdict');
    try {
      await seedEvidence(client);
      const sources = await blockEvidence(ORG_ID, ATHLETE_ID, 'blk-1', STARTS_ON, ENDS_ON);

      for (const source of sources) {
        const keys = Object.keys(source);
        for (const forbidden of [
          'percent', 'percentage', 'ratio', 'expected', 'planned', 'target',
          'shortfall', 'coverage', 'adherence', 'score', 'verdict', 'status',
        ]) {
          expect([source.key, forbidden, keys.includes(forbidden)])
            .toEqual([source.key, forbidden, false]);
        }
        /* `recorded` is a count of rows and there is no denominator anywhere
           in this shape to divide it by -- which is the structural reason no
           percentage can be assembled from what this returns. */
        expect(typeof source.recorded).toBe('number');
      }
    } finally {
      await client.end();
    }
  });
});

describe('block review runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await emptyDatabase('br_rdy_no');
    try {
      await client.query(baseSchemaSql);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /BLOCK_REVIEW_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await seededDatabase('br_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the readiness gate refuses a table missing the deviations rule', async () => {
    /* Without that constraint a coach can record "delivered with deviations"
       and never say what they were -- an unreviewable judgement, storable.
       The runner checks for it; this proves the check bites rather than
       decorating the query. */
    const client = await seededDatabase('br_rdy_deviations');
    try {
      await client.query(
        `alter table pilot.athlete_development_block_reviews
         drop constraint pilot_adb_reviews_deviations_check`,
      );
      // The migration is idempotent, so `create table if not exists` leaves
      // the weakened table in place -- exactly the state the gate must catch.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /BLOCK_REVIEW_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
