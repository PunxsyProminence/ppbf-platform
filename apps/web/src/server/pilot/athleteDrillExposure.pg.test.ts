// Real PostgreSQL proof for the athlete drill-exposure read.
//
// WHY A DATABASE TEST. Every claim the read makes lives in a WHERE or a JOIN, and a mocked `query`
// cannot see which rows Postgres would return. The predicates that carry it:
//
//   1. `c.athlete_id = $2` / `v.athlete_id = $2` -- one athlete's own record, never another's.
//   2. `c.organization_id = $1` -- the tenancy boundary; athlete ids repeat across gyms.
//   3. `ath.deleted_at is null` -- a deleted athlete totals to nothing, even if reached directly.
//   4. the gym-local window `between $3 and $4`, both ends inclusive.
//   5. `effective_achieved_value is not null` -- a disputed round count abstains, a corrected one
//      counts at its corrected value.
//
// Each is mutation-tested: the suite was watched to go RED with the predicate broken, and the
// results are recorded in the PR.
//
// Spins up the same disposable, local-only embedded Postgres the other suites use. It NEVER
// connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-exposure-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_athlete_drill_exposure';

const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_progression_migration.sql',
  'pilot_slice_postgres_drills_migration.sql',
  'pilot_slice_postgres_drill_versioning_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_drill_reference_provenance_migration.sql',
  'pilot_slice_postgres_training_attempts_migration.sql',
  'pilot_slice_postgres_sparring_attempt_contexts_migration.sql',
  'pilot_slice_postgres_training_attempt_reviews_migration.sql',
];

const ORG_ID = 'org-exposure';
const OTHER_ORG_ID = 'org-exposure-elsewhere';
const COACH_ID = 'acct-exposure-coach';
const OTHER_COACH_ID = 'acct-exposure-other-coach';
const ATHLETE_ID = 'ath-exposure-1';
const OTHER_ATHLETE_ID = 'ath-exposure-2';
const DELETED_ATHLETE_ID = 'ath-exposure-deleted';

const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let exposure: typeof import('./athleteDrillExposure');
let client: Client;
let seq = 0;

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

async function seedFixture(target: Client): Promise<void> {
  // athletes.deleted_at belongs to the data-retention migration, which drags in most of the
  // schema. This is its exact column statement (data_retention_deletion_migration.sql:34) and the
  // only part of it the read touches.
  await target.query('alter table pilot.athletes add column if not exists deleted_at timestamptz null');

  for (const [org, coach] of [[ORG_ID, COACH_ID], [OTHER_ORG_ID, OTHER_COACH_ID]]) {
    await target.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await target.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft')`,
      [coach, org],
    );
  }
  const athlete = async (org: string, id: string, coach: string) => target.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
                                 emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2010-01-01', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [org, id, coach],
  );
  await athlete(ORG_ID, ATHLETE_ID, COACH_ID);
  await athlete(ORG_ID, OTHER_ATHLETE_ID, COACH_ID);
  await athlete(ORG_ID, DELETED_ATHLETE_ID, COACH_ID);
  // Same athlete id, different gym: the tenancy predicate is the only thing separating them.
  await athlete(OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID);

  // Reference drills: contact level and skill code live here.
  const reference = async (org: string, id: string, contact: string, skill: string | null) => target.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, $2, $2, $2, 'technical', 'b', 'p', 's', 'e', 'g', 'bad', $3, $4)`,
    [org, id, contact, skill],
  );
  await reference(ORG_ID, 'ref-stance', 'none', 'SK-STANCE-01');
  await reference(ORG_ID, 'ref-spar', 'controlled_sparring', 'SK-SPAR-01');
  await reference(ORG_ID, 'ref-noskill', 'light_technical', null);
  await reference(OTHER_ORG_ID, 'ref-stance', 'open_sparring', 'SK-STANCE-01');

  // Operational drills that assignments point at.
  const drill = async (org: string, id: string, referenceId: string | null) => target.query(
    `insert into pilot.drills (organization_id, drill_id, name, category, focus, reference_drill_id)
     values ($1, $2, $2, 'technical', 'focus', $3)`,
    [org, id, referenceId],
  );
  await drill(ORG_ID, 'drill-stance', 'ref-stance');
  await drill(ORG_ID, 'drill-spar', 'ref-spar');
  await drill(ORG_ID, 'drill-handmade', null);
  await drill(ORG_ID, 'drill-noskill', 'ref-noskill');
  await drill(OTHER_ORG_ID, 'drill-stance', 'ref-stance');
}

async function assignment(input: {
  org?: string;
  athleteId?: string;
  drillId: string | null;
  minutes?: number | null;
}): Promise<string> {
  const org = input.org ?? ORG_ID;
  const athleteId = input.athleteId ?? ATHLETE_ID;
  const coach = org === ORG_ID ? COACH_ID : OTHER_COACH_ID;
  seq += 1;
  const gapId = `gap-${seq}`;
  const assignmentId = `asg-${seq}`;
  await client.query(
    `insert into pilot.progression_gaps (gap_id, organization_id, athlete_id, coach_account_id, gap_type,
                                         gap_description, detected_from)
     values ($1, $2, $3, $4, 'technique', 'gap', 'coach')`,
    [gapId, org, athleteId, coach],
  );
  await client.query(
    `insert into pilot.drill_assignments (assignment_id, organization_id, gap_id, athlete_id,
                                          assigned_by_account_id, drill_name, drill_description,
                                          duration_minutes, drill_id)
     values ($1, $2, $3, $4, $5, 'name', 'description', $6, $7)`,
    [assignmentId, org, gapId, athleteId, coach, input.minutes === undefined ? 15 : input.minutes, input.drillId],
  );
  return assignmentId;
}

async function completion(assignmentId: string, input: {
  org?: string;
  athleteId?: string;
  at: string;
  reps?: number | null;
  status?: 'pending' | 'verified' | 'disputed';
}): Promise<void> {
  seq += 1;
  await client.query(
    `insert into pilot.assignment_completions (completion_id, organization_id, assignment_id, athlete_id,
                                               completed_at, reps_completed, verification_status)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [`cmp-${seq}`, input.org ?? ORG_ID, assignmentId, input.athleteId ?? ATHLETE_ID, input.at,
      input.reps === undefined ? 10 : input.reps, input.status ?? 'verified'],
  );
}

async function roundsAttempt(input: {
  org?: string;
  athleteId?: string;
  context?: string;
  rounds: number;
  at: string;
  review?: { state: 'corrected' | 'disputed'; corrected?: number };
}): Promise<void> {
  const org = input.org ?? ORG_ID;
  const coach = org === ORG_ID ? COACH_ID : OTHER_COACH_ID;
  seq += 1;
  const attemptId = `att-${seq}`;
  await client.query(
    `insert into pilot.training_attempts (organization_id, attempt_id, athlete_id, context_type, metric_kind,
                                          achieved_value, attempted_at, recorded_by_account_id)
     values ($1, $2, $3, $4, 'rounds', $5, $6, $7)`,
    [org, attemptId, input.athleteId ?? ATHLETE_ID, input.context ?? 'technical_sparring', input.rounds,
      input.at, coach],
  );
  if (input.review) {
    await client.query(
      `insert into pilot.training_attempt_reviews (organization_id, review_id, attempt_id, review_state,
                                                   corrected_achieved_value, reason, reviewed_by_account_id)
       values ($1, $2, $3, $4, $5, 'coach review reason', $6)`,
      [org, `rev-${seq}`, attemptId, input.review.state, input.review.corrected ?? null, coach],
    );
  }
}

async function read(athleteId = ATHLETE_ID, window = WINDOW, org = ORG_ID) {
  return exposure.getAthleteDrillExposure({ organizationId: org, athleteId, window });
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

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await seedFixture(client);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  exposure = await import('./athleteDrillExposure');
});

afterAll(async () => {
  await client?.end();
  const { closePool } = await import('./db');
  await closePool();
  // Shutdown copied from athleteIntelligence.pg.test.ts; the unref() keeps the safety timer from
  // holding Jest open after a clean finish.
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

beforeEach(async () => {
  await client.query(`truncate pilot.training_attempt_reviews, pilot.training_attempts,
                               pilot.assignment_completions, pilot.drill_assignments, pilot.progression_gaps`);
  await client.query('update pilot.athletes set deleted_at = null');
});

test('an athlete with no records totals to zero, and group sessions are declared uncounted', async () => {
  const result = await read();
  expect(result.drillSessions.total.sessions).toBe(0);
  expect(result.drillSessions.byContactLevel).toEqual([]);
  expect(result.rounds).toEqual({ total: 0, attempts: 0, byContext: [], disputedExcluded: 0 });
  expect(result.groupSessionsCounted).toBe(false);
  expect(result.window).toEqual(WINDOW);
});

test('completions total by contact level and skill family, with reps and planned minutes kept apart', async () => {
  const stance = await assignment({ drillId: 'drill-stance', minutes: 20 });
  const spar = await assignment({ drillId: 'drill-spar', minutes: null });
  const handmade = await assignment({ drillId: 'drill-handmade', minutes: 10 });
  await completion(stance, { at: '2026-09-02T22:00:00Z', reps: 30 });
  await completion(stance, { at: '2026-09-03T22:00:00Z', reps: null, status: 'pending' });
  await completion(spar, { at: '2026-09-04T22:00:00Z', reps: 5 });
  await completion(handmade, { at: '2026-09-05T22:00:00Z', reps: 12 });

  const { drillSessions } = await read();
  expect(drillSessions.total).toMatchObject({
    sessions: 4, reps: 47, sessionsWithReps: 3, plannedMinutes: 50, sessionsWithPlannedMinutes: 3,
  });
  expect(drillSessions.pendingVerification).toBe(1);
  expect(drillSessions.byContactLevel.map((b) => [b.key, b.sessions, b.plannedMinutes])).toEqual([
    ['none', 2, 40],
    ['controlled_sparring', 1, 0],
    ['not_recorded', 1, 10],
  ]);
  expect(drillSessions.bySkillFamily.map((b) => [b.key, b.label, b.sessions])).toEqual([
    ['SKILL-01', 'SKILL-01 Stance / Guard / Reset', 2],
    // SK-SPAR-01 has no decided family: reported as unmapped, never guessed into one.
    ['family_not_mapped', 'Skill family not mapped yet', 1],
    // drill-handmade has no library link: not the same gap as a library drill with no skill code.
    ['not_recorded', 'Drill not linked to the library', 1],
  ]);
});

test('a library drill with no skill code is its own bucket, apart from an unlinked drill', async () => {
  const noskill = await assignment({ drillId: 'drill-noskill' });
  const handmade = await assignment({ drillId: 'drill-handmade' });
  await completion(noskill, { at: '2026-09-02T22:00:00Z' });
  await completion(handmade, { at: '2026-09-02T22:00:00Z' });

  const { drillSessions } = await read();
  expect(drillSessions.bySkillFamily.map((b) => [b.key, b.sessions])).toEqual([
    ['no_skill_recorded', 1],
    ['not_recorded', 1],
  ]);
  expect(drillSessions.byContactLevel.map((b) => [b.key, b.sessions])).toEqual([
    ['light_technical', 1],
    ['not_recorded', 1],
  ]);
});

test('disputed completions are excluded from totals and counted on their own', async () => {
  const stance = await assignment({ drillId: 'drill-stance' });
  await completion(stance, { at: '2026-09-02T22:00:00Z' });
  await completion(stance, { at: '2026-09-03T22:00:00Z', status: 'disputed' });

  const { drillSessions } = await read();
  expect(drillSessions.total.sessions).toBe(1);
  expect(drillSessions.disputedExcluded).toBe(1);
});

test('only this athlete, only this gym', async () => {
  const mine = await assignment({ drillId: 'drill-stance' });
  const teammate = await assignment({ athleteId: OTHER_ATHLETE_ID, drillId: 'drill-stance' });
  const twin = await assignment({ org: OTHER_ORG_ID, drillId: 'drill-stance' });
  await completion(mine, { at: '2026-09-02T22:00:00Z' });
  await completion(teammate, { athleteId: OTHER_ATHLETE_ID, at: '2026-09-02T22:00:00Z' });
  await completion(twin, { org: OTHER_ORG_ID, at: '2026-09-02T22:00:00Z' });
  await roundsAttempt({ rounds: 3, at: '2026-09-02T22:00:00Z' });
  await roundsAttempt({ athleteId: OTHER_ATHLETE_ID, rounds: 7, at: '2026-09-02T22:00:00Z' });
  await roundsAttempt({ org: OTHER_ORG_ID, rounds: 11, at: '2026-09-02T22:00:00Z' });

  const result = await read();
  expect(result.drillSessions.total.sessions).toBe(1);
  expect(result.drillSessions.byContactLevel.map((b) => b.key)).toEqual(['none']);
  expect(result.rounds.total).toBe(3);

  const other = await read(ATHLETE_ID, WINDOW, OTHER_ORG_ID);
  expect(other.drillSessions.byContactLevel.map((b) => b.key)).toEqual(['open_sparring']);
  expect(other.rounds.total).toBe(11);
});

test('a deleted athlete totals to nothing', async () => {
  const stance = await assignment({ athleteId: DELETED_ATHLETE_ID, drillId: 'drill-stance' });
  await completion(stance, { athleteId: DELETED_ATHLETE_ID, at: '2026-09-02T22:00:00Z' });
  await roundsAttempt({ athleteId: DELETED_ATHLETE_ID, rounds: 4, at: '2026-09-02T22:00:00Z' });

  expect((await read(DELETED_ATHLETE_ID)).drillSessions.total.sessions).toBe(1);
  await client.query(`update pilot.athletes set deleted_at = now() where athlete_id = $1`, [DELETED_ATHLETE_ID]);

  const result = await read(DELETED_ATHLETE_ID);
  expect(result.drillSessions.total.sessions).toBe(0);
  expect(result.rounds.total).toBe(0);
});

test('the window is gym-local calendar days, both ends inclusive', async () => {
  const stance = await assignment({ drillId: 'drill-stance' });
  // 2026-09-01 01:00 UTC is still 2026-08-31 in the gym: outside.
  await completion(stance, { at: '2026-09-01T01:00:00Z' });
  // 2026-09-01 05:00 UTC is 01:00 on the first day: inside.
  await completion(stance, { at: '2026-09-01T05:00:00Z' });
  // 2026-10-01 03:00 UTC is still 2026-09-30 23:00 in the gym: inside.
  await completion(stance, { at: '2026-10-01T03:00:00Z' });
  // 2026-10-01 05:00 UTC is 2026-10-01 in the gym: outside.
  await completion(stance, { at: '2026-10-01T05:00:00Z' });
  await roundsAttempt({ rounds: 2, at: '2026-09-01T01:00:00Z' });
  await roundsAttempt({ rounds: 3, at: '2026-10-01T03:00:00Z' });

  const result = await read();
  expect(result.drillSessions.total.sessions).toBe(2);
  expect(result.rounds.total).toBe(3);
});

test('rounds use the effective value: a correction wins, a dispute abstains', async () => {
  await roundsAttempt({ rounds: 4, at: '2026-09-02T22:00:00Z', context: 'technical_sparring' });
  await roundsAttempt({ rounds: 6, at: '2026-09-03T22:00:00Z', context: 'open_sparring',
    review: { state: 'corrected', corrected: 3 } });
  await roundsAttempt({ rounds: 9, at: '2026-09-04T22:00:00Z', context: 'open_sparring',
    review: { state: 'disputed' } });

  const { rounds } = await read();
  expect(rounds.total).toBe(7);
  expect(rounds.attempts).toBe(2);
  expect(rounds.disputedExcluded).toBe(1);
  expect(rounds.byContext).toEqual([
    { contextType: 'open_sparring', rounds: 3, attempts: 1 },
    { contextType: 'technical_sparring', rounds: 4, attempts: 1 },
  ]);
});
