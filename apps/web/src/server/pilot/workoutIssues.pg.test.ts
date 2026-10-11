// Real-PostgreSQL proof for the issued workout's shape (lane P7c, #1419):
// pilot.workout_issues and pilot.workout_issue_steps, their migration and
// runner, recordWorkoutIssue (workoutIssues.ts), and issueWorkoutTemplate
// writing them in the transaction that writes the assignments.
//
// What only a real database can prove:
//
//   * THE SHAPE LANDS AS THE COACH WROTE IT. Each step's block, ordinal, scale
//     level, contact level and note are the template item's, tied to the
//     assignment that step became.
//   * ONE TRANSACTION. A failure after the shape is written (at COMMIT), or
//     while it is being written, leaves no issue row, no step row and no
//     assignment.
//   * THE ROWS LEAVE WITH THE ATHLETE. The retention purge deletes
//     pilot.athletes; the cascades are the only thing that removes these rows.
//   * THE DATABASE REFUSES what the module never writes: an unknown level, an
//     assignment in two workouts, a repeated request key in one gym.
//   * THE READ ANSWERS ONLY WHAT IT IS ASKED, in the coach's order, and a step
//     tied (by hand, past the writer) to another gym's or another athlete's
//     assignment is returned to nobody.
//   * READINESS IS RED when any one of the guards it names (four checks, four
//     foreign keys, three indexes) is missing or looser. It does not look at
//     primary keys, column types or the organization and account foreign keys.
//
// That workoutTemplateIssue.pg.test.ts's four rollback cases also count these
// two tables is the wider all-or-nothing proof; this suite does not repeat
// them.
//
// './db' is mocked as in workoutTemplateIssue.pg.test.ts: pooled reads go to
// one connection, withTransaction opens its own per call.
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

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-workout-issues-migration.mjs');

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const own = new Client({ connectionString: activeConnectionString });
    await own.connect();
    try {
      await own.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => own.query(text, values) });
        await own.query('COMMIT');
        return result;
      } catch (error) {
        await own.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await own.end();
    }
  }),
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

import { issueCoachCard } from './coachCards';
import { query } from './db';
import { promoteReferenceDrill } from './drills';
import {
  findWorkoutIssueByRequestKey,
  listIssuedWorkoutsForAssignments,
  recordWorkoutIssue,
  toFamilyIssuedWorkouts,
  WorkoutIssueRequestKeyTakenError,
  type WorkoutIssueStepInput,
} from './workoutIssues';
import { issueWorkoutTemplate, type TemplateIssueResult } from './workoutTemplates';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-workout-issues-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_workout_issues_migration.sql');
const DATABASE_NAME = 'ppbf_test_p7c_workout_issues';

const TEMPLATE_ID = 'wtp_shape';
const ATHLETE_ID = 'athlete-shape';
const OTHER_ATHLETE_ID = 'athlete-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let migrationSql: string;
let client: Client;
let gymCount = 0;

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

interface Gym {
  organizationId: string;
  coachId: string;
}

/** A fresh gym: an organization, boxing, a coach and two athletes of that coach. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-p7c-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
    coachId,
    organizationId,
  ]);
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Shape Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, athleteId, coachId],
    );
  }
  return { organizationId, coachId };
}

/** A reference drill that passes adoption readiness, not yet adopted by the gym. */
async function referenceDrill(gym: Gym, referenceId: string, name: string): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        field_provenance, active)
     values ($1,$2,$2,1,$3,'boxing','footwork','advanced', $3 || ' target.', $3 || ' purpose.',
             $3 || ' setup.', $3 || ' execution.', $3 || ' good.', $3 || ' bad.', 'PPBF source manual v3', true)`,
    [gym.organizationId, referenceId, name],
  );
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description,
        constraint_applied, contact_level, coach_watch_point, authoring_state)
     values ($1, $2 || '-a', $2, 'A', false, 'easier',   '', 'none', 'watch', 'authored'),
            ($1, $2 || '-b', $2, 'B', true,  'standard', '', 'none', 'watch', 'authored'),
            ($1, $2 || '-c', $2, 'C', false, 'harder',   '', 'none', 'watch', 'authored')`,
    [gym.organizationId, referenceId],
  );
  await client.query(
    `insert into pilot.drill_stop_rules
       (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
     values ($1, $2 || '-stop-1', $2, 1, 'Stop when the guard drops.', 'universal', 'safety')`,
    [gym.organizationId, referenceId],
  );
  await client.query(
    `insert into pilot.drill_cues
       (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref)
     values ($1, $2 || '-cue-1', $2, $3 || ' cue', 'guard', 'external', 'note', 'batch-7')`,
    [gym.organizationId, referenceId, name],
  );
}

/** A reference drill that passes adoption readiness, adopted by the gym. Returns the gym's drill id. */
async function runningDrill(gym: Gym, referenceId: string, name: string): Promise<string> {
  await referenceDrill(gym, referenceId, name);
  const drill = await promoteReferenceDrill({
    organizationId: gym.organizationId,
    referenceDrillId: referenceId,
    name,
    category: 'footwork',
    focus: `${name} purpose.`,
    cues: [`${name} cue`],
  });
  return drill.drill_id;
}

interface StepFixture {
  drill: string;
  block: string;
  scale: string | null;
  contact: string;
  note: string | null;
  minutes: number | null;
  reps: number | null;
}

/**
 * The workout as a coach wrote it. The blocks are not in one run each (warmup
 * comes back at the end), one level is left open, one note is missing, and one
 * step is controlled sparring -- which a template may not give minutes or reps.
 */
const WORKOUT: StepFixture[] = [
  { drill: 'ref-a', block: 'warmup', scale: 'A', contact: 'none', note: 'Easy pace.', minutes: 5, reps: null },
  { drill: 'ref-b', block: 'technical', scale: null, contact: 'light_technical', note: null, minutes: null, reps: 20 },
  // Text an array parameter could mangle: quotes, braces, a comma, a
  // backslash, a line break. It must come back character for character.
  {
    drill: 'ref-c',
    block: 'technical, pads',
    scale: 'C',
    contact: 'controlled_sparring',
    note: 'He said "relax", {8,9}\\ two rounds\nCoach watching.',
    minutes: null,
    reps: null,
  },
  // A note that is the WORD null is a note, not a missing one.
  { drill: 'ref-a', block: 'warmup', scale: 'B', contact: 'none', note: 'NULL', minutes: 3, reps: null },
];

/** A gym that runs the three drills and holds the template above. Returns reference id -> gym drill id. */
async function gymWithWorkout(label: string): Promise<{ gym: Gym; drills: Record<string, string> }> {
  const gym = await newGym(label);
  const drills: Record<string, string> = {};
  for (const [referenceId, name] of [['ref-a', 'Drill A'], ['ref-b', 'Drill B'], ['ref-c', 'Drill C']]) {
    drills[referenceId] = await runningDrill(gym, referenceId, name);
  }
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
        duration_minutes, intent)
     values ($1,$2,$2,3,'Shape Fixture','technical','intermediate','any',true,45,'Test intent')`,
    [gym.organizationId, TEMPLATE_ID],
  );
  for (const [index, step] of WORKOUT.entries()) {
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, scale_level, duration_minutes,
          rep_count, contact_level, coach_note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [gym.organizationId, `wti_${index + 1}`, TEMPLATE_ID, index + 1, step.block, step.drill, step.scale, step.minutes, step.reps, step.contact, step.note],
    );
  }
  return { gym, drills };
}

function issue(gym: Gym, athleteId = ATHLETE_ID, requestKey: string | null = null): Promise<TemplateIssueResult> {
  return issueWorkoutTemplate({
    organizationId: gym.organizationId,
    templateId: TEMPLATE_ID,
    athleteId,
    actorAccountId: gym.coachId,
    actorRole: 'coach',
    requestKey,
  });
}

async function counts(gym: Gym): Promise<{ issues: number; steps: number; assignments: number }> {
  const { rows } = await client.query(
    `select (select count(*)::int from pilot.workout_issues where organization_id = $1) as issues,
            (select count(*)::int from pilot.workout_issue_steps where organization_id = $1) as steps,
            (select count(*)::int from pilot.drill_assignments where organization_id = $1) as assignments`,
    [gym.organizationId],
  );
  return rows[0];
}

/**
 * Waits until a transaction in this suite's database is waiting for another
 * to finish (a unique-index wait is a wait on the other transaction's id), and
 * returns how many are. Zero after five seconds.
 */
async function waitingOnAnotherTransaction(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { rows } = await client.query(
      `select count(*)::int as n from pg_locks where not granted and locktype = 'transactionid'`,
    );
    if (rows[0].n > 0) return rows[0].n;
  }
  return 0;
}

async function ownConnection(): Promise<Client> {
  const own = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await own.connect();
  return own;
}

/** One committed card for an athlete, through the production writer. */
async function card(gym: Gym, drillId: string, athleteId = ATHLETE_ID): Promise<string> {
  const assignment = await issueCoachCard({
    organizationId: gym.organizationId,
    athleteId,
    assignedByAccountId: gym.coachId,
    drillId,
  });
  return assignment.assignment_id;
}

function step(assignmentId: string, ordinal = 1, overrides: Partial<WorkoutIssueStepInput> = {}): WorkoutIssueStepInput {
  return {
    ordinal,
    block: 'technical',
    scale_level: null,
    contact_level: 'none',
    coach_note: null,
    template_item_id: `wti_${ordinal}`,
    assignment_id: assignmentId,
    ...overrides,
  };
}

/** recordWorkoutIssue on its own committed transaction. */
async function record(
  gym: Gym,
  steps: WorkoutIssueStepInput[],
  athleteId = ATHLETE_ID,
  requestKey: string | null = null,
): Promise<string> {
  const own = await ownConnection();
  try {
    await own.query('BEGIN');
    const issueId = await recordWorkoutIssue(own as never, {
      organizationId: gym.organizationId,
      athleteId,
      template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
      issuedByAccountId: gym.coachId,
      requestKey,
      steps,
    });
    await own.query('COMMIT');
    return issueId;
  } catch (error) {
    await own.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await own.end();
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  // The whole schema production runs (scripts/lib/full-schema.mjs), which
  // applies this migration in its place in apply-migrations.yml's `all` list.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  activeConnectionString = connectionStringFor(DATABASE_NAME);
});

afterAll(async () => {
  activeClient = null;
  activeConnectionString = null;
  await client?.end().catch(() => {});
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
  // On Windows kill() terminates the server script outright, so its own
  // cleanup never runs and Postgres may still hold files here for a moment.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

describe('issuing a template writes the workout as the coach wrote it', () => {
  test('one issue row, and one step per template item with its block, order, levels, note and assignment', async () => {
    const { gym, drills } = await gymWithWorkout('shape');

    const result = await issue(gym);

    expect(result.outcome).toBe('issued');
    if (result.outcome !== 'issued') return;

    const issues = await client.query(
      `select issue_id::text, athlete_id, template_id, template_name, template_version, issued_by_account_id,
              request_key, issued_at is not null as stamped
       from pilot.workout_issues where organization_id = $1`,
      [gym.organizationId],
    );
    expect(issues.rows).toEqual([
      {
        issue_id: result.issue_id,
        athlete_id: ATHLETE_ID,
        template_id: TEMPLATE_ID,
        template_name: 'Shape Fixture',
        template_version: 3,
        issued_by_account_id: gym.coachId,
        request_key: null,
        stamped: true,
      },
    ]);

    // Each step beside the assignment it points at, read through that pointer.
    const steps = await client.query(
      `select s.issue_id::text, s.ordinal, s.block, s.scale_level, s.contact_level, s.coach_note, s.template_item_id,
              s.assignment_id, a.drill_id, a.athlete_id, a.duration_minutes, a.rep_count
       from pilot.workout_issue_steps s
       join pilot.drill_assignments a on a.organization_id = s.organization_id and a.assignment_id = s.assignment_id
       where s.organization_id = $1
       order by s.ordinal`,
      [gym.organizationId],
    );
    expect(steps.rows).toEqual(
      WORKOUT.map((fixture, index) => ({
        issue_id: result.issue_id,
        ordinal: index + 1,
        block: fixture.block,
        scale_level: fixture.scale,
        contact_level: fixture.contact,
        coach_note: fixture.note,
        template_item_id: `wti_${index + 1}`,
        assignment_id: result.steps[index].assignment.assignment_id,
        // The step's own drill and volume are on the assignment it names.
        drill_id: drills[fixture.drill],
        athlete_id: ATHLETE_ID,
        duration_minutes: fixture.minutes,
        rep_count: fixture.reps,
      })),
    );
    expect(await counts(gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });

    // The audit event names the issued workout.
    const audit = await client.query(
      `select details from pilot.audit_events
       where organization_id = $1 and entity_type = 'workout_template_issue'`,
      [gym.organizationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details.issue_id).toBe(result.issue_id);
    expect(audit.rows[0].details).not.toHaveProperty('not_carried');
  });

  test('issuing the same template again is a second, separate workout with its own assignments', async () => {
    const { gym } = await gymWithWorkout('twice');

    const first = await issue(gym);
    const second = await issue(gym);

    expect(first.outcome).toBe('issued');
    expect(second.outcome).toBe('issued');
    if (first.outcome !== 'issued' || second.outcome !== 'issued') return;
    expect(second.issue_id).not.toBe(first.issue_id);
    expect(await counts(gym)).toEqual({ issues: 2, steps: 8, assignments: 8 });
    const perIssue = await client.query(
      `select issue_id::text, count(*)::int as steps, count(distinct assignment_id)::int as assignments
       from pilot.workout_issue_steps where organization_id = $1 group by issue_id`,
      [gym.organizationId],
    );
    expect(perIssue.rows.sort((a, b) => a.issue_id.localeCompare(b.issue_id))).toEqual(
      [first.issue_id, second.issue_id].sort().map((issueId) => ({ issue_id: issueId, steps: 4, assignments: 4 })),
    );
  });

  test('the shape is uncommitted while the transaction is open: another connection sees none of it until COMMIT', async () => {
    const { gym } = await gymWithWorkout('isolation');
    let seenDuring: { issues: number; steps: number; assignments: number } | null = null;
    // A card and its shape written on one open transaction, then counted from
    // the suite's OTHER connection before that transaction ends.
    const own = await ownConnection();
    try {
      await own.query('BEGIN');
      const drill = await client.query(`select drill_id from pilot.drills where organization_id = $1 limit 1`, [gym.organizationId]);
      const assignment = await issueCoachCard(
        { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.rows[0].drill_id },
        own as never,
      );
      await recordWorkoutIssue(own as never, {
        organizationId: gym.organizationId,
        athleteId: ATHLETE_ID,
        template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
        issuedByAccountId: gym.coachId,
        requestKey: null,
        steps: [step(assignment.assignment_id)],
      });
      seenDuring = await counts(gym);
      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }
    expect(seenDuring).toEqual({ issues: 0, steps: 0, assignments: 0 });
    // Rolled back with the card it described.
    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });
  });
});

describe('all or nothing: the shape commits with the assignments or not at all', () => {
  test('a failure at COMMIT, after the issue and every step are written, leaves no issue, step or assignment', async () => {
    const { gym } = await gymWithWorkout('commit-fails');
    await client.query(
      `create or replace function pilot.p7c_test_fail_at_commit() returns trigger language plpgsql as $$
       begin
         if new.organization_id = '${gym.organizationId}' then
           raise exception 'p7c test: commit refused';
         end if;
         return new;
       end $$`,
    );
    // On the LAST table the issue writes to, so the shape really was written.
    await client.query(
      `create constraint trigger p7c_test_fail_at_commit after insert on pilot.workout_issue_steps
       deferrable initially deferred for each row execute function pilot.p7c_test_fail_at_commit()`,
    );
    try {
      await expect(issue(gym)).rejects.toThrow('p7c test: commit refused');
    } finally {
      await client.query('drop trigger p7c_test_fail_at_commit on pilot.workout_issue_steps');
      await client.query('drop function pilot.p7c_test_fail_at_commit()');
    }

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });

    // And it issues cleanly once nothing refuses it.
    await expect(issue(gym)).resolves.toMatchObject({ outcome: 'issued' });
    expect(await counts(gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });
  });

  test('a step the database refuses rolls back the issue row and every assignment written before it', async () => {
    const { gym } = await gymWithWorkout('step-fails');
    await client.query(
      `create or replace function pilot.p7c_test_refuse_step() returns trigger language plpgsql as $$
       begin
         if new.organization_id = '${gym.organizationId}' and new.ordinal = 3 then
           raise exception 'p7c test: step refused';
         end if;
         return new;
       end $$`,
    );
    await client.query(
      `create trigger p7c_test_refuse_step before insert on pilot.workout_issue_steps
       for each row execute function pilot.p7c_test_refuse_step()`,
    );
    try {
      await expect(issue(gym)).rejects.toThrow('p7c test: step refused');
    } finally {
      await client.query('drop trigger p7c_test_refuse_step on pilot.workout_issue_steps');
      await client.query('drop function pilot.p7c_test_refuse_step()');
    }

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });
    const audit = await client.query(
      `select count(*)::int as n from pilot.audit_events where organization_id = $1 and entity_type = 'workout_template_issue'`,
      [gym.organizationId],
    );
    expect(audit.rows[0].n).toBe(0);
  });
});

describe('recordWorkoutIssue ties a step only to this athlete\'s assignment in this gym', () => {
  test('an assignment of ANOTHER athlete of the same gym is refused and nothing is left', async () => {
    const { gym, drills } = await gymWithWorkout('other-athlete');
    const mine = await card(gym, drills['ref-a']);
    const theirs = await card(gym, drills['ref-b'], OTHER_ATHLETE_ID);

    await expect(record(gym, [step(mine, 1), step(theirs, 2)])).rejects.toThrow('not this athlete');

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 2 });
  });

  test('an assignment of ANOTHER gym is refused and neither gym gains a row', async () => {
    const here = await gymWithWorkout('here');
    const there = await gymWithWorkout('there');
    const foreign = await card(there.gym, there.drills['ref-a']);

    await expect(record(here.gym, [step(foreign)])).rejects.toThrow('not this athlete');

    expect(await counts(here.gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });
    expect(await counts(there.gym)).toEqual({ issues: 0, steps: 0, assignments: 1 });
  });

  test('an issue with no steps is refused before anything is written', async () => {
    const { gym } = await gymWithWorkout('empty');

    await expect(record(gym, [])).rejects.toThrow('at least one step');

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });
  });
});

describe('the database refuses what the module never writes', () => {
  const BAD_STEPS: Array<[string, Partial<WorkoutIssueStepInput>, string]> = [
    ['a scale level outside A, B, C', { scale_level: 'D' }, 'pilot_workout_issue_steps_scale_level_check'],
    ['a contact level outside the ladder', { contact_level: 'full_contact' }, 'pilot_workout_issue_steps_contact_level_check'],
    ['an ordinal of zero', { ordinal: 0 }, 'pilot_workout_issue_steps_ordinal_check'],
  ];

  test.each(BAD_STEPS)('%s', async (_label, overrides, constraint) => {
    const { gym, drills } = await gymWithWorkout('bad-step');
    const assignmentId = await card(gym, drills['ref-a']);

    await expect(record(gym, [step(assignmentId, 1, overrides)])).rejects.toMatchObject({ constraint });

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 1 });
  });

  test('every level of the contact ladder is accepted as written, and an open scale level stays null', async () => {
    const { gym, drills } = await gymWithWorkout('ladder');
    const ladder = ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'];
    const steps: WorkoutIssueStepInput[] = [];
    for (const [index, contact] of ladder.entries()) {
      steps.push(step(await card(gym, drills['ref-a']), index + 1, { contact_level: contact }));
    }

    await record(gym, steps);

    const { rows } = await client.query(
      `select contact_level, scale_level from pilot.workout_issue_steps where organization_id = $1 order by ordinal`,
      [gym.organizationId],
    );
    expect(rows).toEqual(ladder.map((contact) => ({ contact_level: contact, scale_level: null })));
  });

  test('two steps of one workout cannot share an ordinal, and a step must have a block', async () => {
    const { gym, drills } = await gymWithWorkout('step-key');
    const first = await card(gym, drills['ref-a']);
    const second = await card(gym, drills['ref-b']);

    await expect(record(gym, [step(first, 1), step(second, 1)])).rejects.toMatchObject({
      constraint: 'pilot_workout_issue_steps_pkey',
    });
    // 23502: not-null violation.
    await expect(record(gym, [step(first, 1, { block: null as never })])).rejects.toMatchObject({
      code: '23502',
      column: 'block',
    });

    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 2 });
  });

  test('one assignment cannot be a step of two workouts', async () => {
    const { gym, drills } = await gymWithWorkout('one-workout');
    const assignmentId = await card(gym, drills['ref-a']);
    await record(gym, [step(assignmentId)]);

    await expect(record(gym, [step(assignmentId)])).rejects.toMatchObject({
      constraint: 'pilot_workout_issue_steps_one_per_assignment',
    });

    expect(await counts(gym)).toEqual({ issues: 1, steps: 1, assignments: 1 });
  });

  test('an issue must name a template of this gym, and that template cannot be deleted from under it', async () => {
    const { gym, drills } = await gymWithWorkout('template-link');
    const assignmentId = await card(gym, drills['ref-a']);
    await expect(
      client.query(
        `insert into pilot.workout_issues
           (organization_id, issue_id, athlete_id, template_id, template_name, template_version, issued_by_account_id)
         values ($1, gen_random_uuid(), $2, 'wtp_missing', 'Missing', 1, $3)`,
        [gym.organizationId, ATHLETE_ID, gym.coachId],
      ),
    ).rejects.toMatchObject({ constraint: 'pilot_workout_issues_template_fk' });

    await record(gym, [step(assignmentId)]);
    await expect(
      client.query(`delete from pilot.workout_templates where organization_id = $1 and template_id = $2`, [
        gym.organizationId,
        TEMPLATE_ID,
      ]),
    ).rejects.toMatchObject({ constraint: 'pilot_workout_issues_template_fk' });
  });

  test('a request key is unique within a gym, free across gyms, and absent keys never collide', async () => {
    const here = await gymWithWorkout('key-here');
    const there = await gymWithWorkout('key-there');
    const insert = (gym: Gym, key: string | null) =>
      client.query(
        `insert into pilot.workout_issues
           (organization_id, issue_id, athlete_id, template_id, template_name, template_version, issued_by_account_id, request_key)
         values ($1, gen_random_uuid(), $2, $3, 'Shape Fixture', 3, $4, $5)`,
        [gym.organizationId, ATHLETE_ID, TEMPLATE_ID, gym.coachId, key],
      );

    await insert(here.gym, 'key-1');
    await expect(insert(here.gym, 'key-1')).rejects.toMatchObject({ constraint: 'pilot_workout_issues_one_per_request_key' });
    await insert(there.gym, 'key-1');
    await insert(here.gym, null);
    await insert(here.gym, null);
    await expect(insert(here.gym, '   ')).rejects.toMatchObject({ constraint: 'pilot_workout_issues_request_key_check' });
    await expect(insert(here.gym, 'k'.repeat(201))).rejects.toMatchObject({ constraint: 'pilot_workout_issues_request_key_check' });

    expect((await counts(here.gym)).issues).toBe(3);
    expect((await counts(there.gym)).issues).toBe(1);
  });
});

// ONE ISSUE PER REQUEST KEY (lane P7c, PR F). The coach's screen sends a random
// id with a press of Issue and sends the same one again when that press got no
// answer. The second send must answer with the first issue and write nothing.
describe('a request key names one issue', () => {
  const auditCount = async (gym: Gym): Promise<number> => {
    const { rows } = await client.query(
      `select count(*)::int as n from pilot.audit_events
       where organization_id = $1 and entity_type = 'workout_template_issue'`,
      [gym.organizationId],
    );
    return rows[0].n;
  };

  /** A second current template in the gym, with one step. */
  async function secondTemplate(gym: Gym): Promise<string> {
    await client.query(
      `insert into pilot.workout_templates
         (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
          duration_minutes, intent)
       values ($1,'wtp_second','wtp_second',1,'Second Fixture','technical','intermediate','any',true,30,'Test intent')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, scale_level, duration_minutes,
          rep_count, contact_level, coach_note)
       values ($1,'wti_second_1','wtp_second',1,'warmup','ref-a',null,5,null,'none',null)`,
      [gym.organizationId],
    );
    return 'wtp_second';
  }

  test('the key is stored on the issue; an issue sent without one stores null', async () => {
    const { gym } = await gymWithWorkout('key-stored');

    const keyed = await issue(gym, ATHLETE_ID, 'key-stored-1');
    const unkeyed = await issue(gym);

    if (keyed.outcome !== 'issued' || unkeyed.outcome !== 'issued') throw new Error('both must issue');
    const { rows } = await client.query(
      `select issue_id::text, request_key from pilot.workout_issues where organization_id = $1`,
      [gym.organizationId],
    );
    expect(rows.sort((a, b) => String(a.request_key).localeCompare(String(b.request_key)))).toEqual([
      { issue_id: keyed.issue_id, request_key: 'key-stored-1' },
      { issue_id: unkeyed.issue_id, request_key: null },
    ]);
  });

  test('the same request sent again writes nothing and is answered with the first issue', async () => {
    const { gym } = await gymWithWorkout('key-repeat');

    const first = await issue(gym, ATHLETE_ID, 'key-repeat-1');
    if (first.outcome !== 'issued') throw new Error('the first send must issue');
    const before = await counts(gym);
    const again = await issue(gym, ATHLETE_ID, 'key-repeat-1');
    const andAgain = await issue(gym, ATHLETE_ID, 'key-repeat-1');

    const repeat = {
      outcome: 'already_issued',
      issue_id: first.issue_id,
      template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
      step_count: 4,
    };
    expect(again).toEqual(repeat);
    expect(andAgain).toEqual(repeat);
    // One workout, its four steps and four assignments, and one audit event: nothing was added.
    expect(before).toEqual({ issues: 1, steps: 4, assignments: 4 });
    expect(await counts(gym)).toEqual(before);
    expect(await auditCount(gym)).toBe(1);
  });

  test('a different key is a different issue: the same template issued again on purpose is still a second workout', async () => {
    const { gym } = await gymWithWorkout('key-two');

    const first = await issue(gym, ATHLETE_ID, 'key-two-1');
    const second = await issue(gym, ATHLETE_ID, 'key-two-2');

    expect(first.outcome).toBe('issued');
    expect(second.outcome).toBe('issued');
    expect(await counts(gym)).toEqual({ issues: 2, steps: 8, assignments: 8 });
    // A repeat of the first names the first, and counts only its own steps.
    const repeat = await issue(gym, ATHLETE_ID, 'key-two-1');
    expect(repeat).toMatchObject({ outcome: 'already_issued', step_count: 4 });
    expect(repeat.outcome === 'already_issued' && first.outcome === 'issued' && repeat.issue_id === first.issue_id).toBe(true);
  });

  test('a repeat is answered with the workout as it was issued, even after the template is withdrawn; a new request is refused', async () => {
    const { gym } = await gymWithWorkout('key-withdrawn');
    const first = await issue(gym, ATHLETE_ID, 'key-withdrawn-1');
    if (first.outcome !== 'issued') throw new Error('the first send must issue');
    await client.query(
      `update pilot.workout_templates set active = false, name = 'Renamed Since' where organization_id = $1 and template_id = $2`,
      [gym.organizationId, TEMPLATE_ID],
    );

    expect(await issue(gym, ATHLETE_ID, 'key-withdrawn-1')).toEqual({
      outcome: 'already_issued',
      issue_id: first.issue_id,
      // The name the workout was issued under, not the template's name today.
      template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
      step_count: 4,
    });
    await expect(issue(gym, ATHLETE_ID, 'key-withdrawn-2')).rejects.toMatchObject({ code: 'WORKOUT_TEMPLATE_NOT_CURRENT' });
    expect(await counts(gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });
  });

  test('a key sent again for another athlete or another template is refused, and nothing is written', async () => {
    const { gym } = await gymWithWorkout('key-reused');
    const other = await secondTemplate(gym);
    const first = await issue(gym, ATHLETE_ID, 'key-reused-1');
    expect(first.outcome).toBe('issued');
    const before = await counts(gym);

    await expect(issue(gym, OTHER_ATHLETE_ID, 'key-reused-1')).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
    });
    await expect(
      issueWorkoutTemplate({
        organizationId: gym.organizationId,
        templateId: other,
        athleteId: ATHLETE_ID,
        actorAccountId: gym.coachId,
        actorRole: 'coach',
        requestKey: 'key-reused-1',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED' });

    expect(await counts(gym)).toEqual(before);
    expect(await auditCount(gym)).toBe(1);
  });

  test("another gym's use of the same key is that gym's own issue, and neither gym is answered with the other's", async () => {
    const here = await gymWithWorkout('key-here');
    const there = await gymWithWorkout('key-there');

    const mine = await issue(here.gym, ATHLETE_ID, 'key-shared');
    const theirs = await issue(there.gym, ATHLETE_ID, 'key-shared');

    if (mine.outcome !== 'issued' || theirs.outcome !== 'issued') throw new Error('each gym issues its own');
    expect(theirs.issue_id).not.toBe(mine.issue_id);
    expect(await counts(here.gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });
    expect(await counts(there.gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });
    const repeat = await issue(there.gym, ATHLETE_ID, 'key-shared');
    expect(repeat.outcome === 'already_issued' && repeat.issue_id).toBe(theirs.issue_id);
  });

  test('two sends of one request at the same moment issue once: the one that loses rolls back whole and is answered as the repeat', async () => {
    const { gym, drills } = await gymWithWorkout('key-race');
    // The request that wins, held OPEN on its own transaction: one card and
    // its issue, under the key, not yet committed.
    const own = await ownConnection();
    let winner = '';
    let losing: Promise<TemplateIssueResult> | null = null;
    try {
      await own.query('BEGIN');
      const assignment = await issueCoachCard(
        { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drills['ref-a'] },
        own as never,
      );
      winner = await recordWorkoutIssue(own as never, {
        organizationId: gym.organizationId,
        athleteId: ATHLETE_ID,
        template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
        issuedByAccountId: gym.coachId,
        requestKey: 'key-race-1',
        steps: [step(assignment.assignment_id)],
      });

      // The same request again. Its lookup sees nothing (the winner has not
      // committed), so it runs its whole transaction and then waits on the
      // unique index for the winner to finish.
      losing = issue(gym, ATHLETE_ID, 'key-race-1');
      expect(await waitingOnAnotherTransaction()).toBeGreaterThan(0);
      await own.query('COMMIT');
    } catch (error) {
      await own.query('ROLLBACK').catch(() => {});
      // Never left running into the next case.
      await losing?.catch(() => {});
      throw error;
    } finally {
      await own.end();
    }

    expect(await losing).toEqual({
      outcome: 'already_issued',
      issue_id: winner,
      template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
      step_count: 1,
    });
    // Only the winner's rows: the loser's four assignments went with its transaction.
    expect(await counts(gym)).toEqual({ issues: 1, steps: 1, assignments: 1 });
    expect(await auditCount(gym)).toBe(0);
  });

  test('two sends at the same moment of a template that ADOPTS a drill: the loser meets the winner at the drill library, not the key, and is still answered as the repeat', async () => {
    const { gym } = await gymWithWorkout('key-race-adopt');
    // A drill the gym has not adopted, and a template whose one step is that drill.
    await referenceDrill(gym, 'ref-d', 'Drill D');
    await client.query(
      `insert into pilot.workout_templates
         (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
          duration_minutes, intent)
       values ($1,'wtp_adopts','wtp_adopts',1,'Adopts Fixture','technical','intermediate','any',true,30,'Test intent')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, scale_level, duration_minutes,
          rep_count, contact_level, coach_note)
       values ($1,'wti_adopts_1','wtp_adopts',1,'warmup','ref-d',null,5,null,'none',null)`,
      [gym.organizationId],
    );
    const send = () =>
      issueWorkoutTemplate({
        organizationId: gym.organizationId,
        templateId: 'wtp_adopts',
        athleteId: ATHLETE_ID,
        actorAccountId: gym.coachId,
        actorRole: 'coach',
        requestKey: 'key-race-adopt-1',
      });

    // The winner, held open: the adoption, one card and its issue under the key.
    const own = await ownConnection();
    let winner = '';
    let losing: Promise<TemplateIssueResult> | null = null;
    try {
      await own.query('BEGIN');
      const adopted = await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-d', name: 'Drill D', category: 'footwork', focus: 'Drill D purpose.', cues: ['Drill D cue'] },
        own as never,
      );
      const assignment = await issueCoachCard(
        { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: adopted.drill_id },
        own as never,
      );
      winner = await recordWorkoutIssue(own as never, {
        organizationId: gym.organizationId,
        athleteId: ATHLETE_ID,
        template: { template_id: 'wtp_adopts', name: 'Adopts Fixture', version: 1 },
        issuedByAccountId: gym.coachId,
        requestKey: 'key-race-adopt-1',
        steps: [step(assignment.assignment_id, 1, { template_item_id: 'wti_adopts_1' })],
      });

      // The same request again. It sees neither the key nor the adoption, so
      // it plans its own adoption and waits at the drill library's unique
      // index -- before it ever reaches the key's.
      losing = send();
      expect(await waitingOnAnotherTransaction()).toBeGreaterThan(0);
      await own.query('COMMIT');
    } catch (error) {
      await own.query('ROLLBACK').catch(() => {});
      await losing?.catch(() => {});
      throw error;
    } finally {
      await own.end();
    }

    // Not "the drill library changed ... nothing was issued": it WAS issued, by the winner.
    expect(await losing).toEqual({
      outcome: 'already_issued',
      issue_id: winner,
      template: { template_id: 'wtp_adopts', name: 'Adopts Fixture', version: 1 },
      step_count: 1,
    });
    expect(await counts(gym)).toEqual({ issues: 1, steps: 1, assignments: 1 });
    // One adoption of the drill, the winner's.
    const { rows } = await client.query(
      `select count(*)::int as n from pilot.drills where organization_id = $1 and reference_drill_id = 'ref-d'`,
      [gym.organizationId],
    );
    expect(rows[0].n).toBe(1);
    // And a later press with the same key is still the repeat.
    expect(await send()).toMatchObject({ outcome: 'already_issued', issue_id: winner });
  });

  test("a drill-library collision that is NOT this request's own repeat is still the conflict to retry, and nothing is issued", async () => {
    const { gym } = await gymWithWorkout('key-collide');
    await referenceDrill(gym, 'ref-e', 'Drill E');
    await client.query(
      `insert into pilot.workout_templates
         (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
          duration_minutes, intent)
       values ($1,'wtp_collides','wtp_collides',1,'Collides Fixture','technical','intermediate','any',true,30,'Test intent')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, scale_level, duration_minutes,
          rep_count, contact_level, coach_note)
       values ($1,'wti_collides_1','wtp_collides',1,'warmup','ref-e',null,5,null,'none',null)`,
      [gym.organizationId],
    );

    // Somebody else adopts the drill, on an open transaction, and issues nothing.
    const own = await ownConnection();
    let losing: Promise<TemplateIssueResult> | null = null;
    try {
      await own.query('BEGIN');
      await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-e', name: 'Drill E', category: 'footwork', focus: 'Drill E purpose.', cues: ['Drill E cue'] },
        own as never,
      );
      losing = issueWorkoutTemplate({
        organizationId: gym.organizationId,
        templateId: 'wtp_collides',
        athleteId: ATHLETE_ID,
        actorAccountId: gym.coachId,
        actorRole: 'coach',
        requestKey: 'key-collide-1',
      });
      // Marked handled now, so a rejection while this case waits is not an unhandled one.
      losing.catch(() => {});
      expect(await waitingOnAnotherTransaction()).toBeGreaterThan(0);
      await own.query('COMMIT');
    } catch (error) {
      await own.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await own.end();
    }

    await expect(losing).rejects.toMatchObject({ status: 409, code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED' });
    expect(await counts(gym)).toEqual({ issues: 0, steps: 0, assignments: 0 });
  });

  test('recordWorkoutIssue names the taken key as its own error and lets every other refusal through as it was', async () => {
    const { gym, drills } = await gymWithWorkout('key-error');
    await record(gym, [step(await card(gym, drills['ref-a']))], ATHLETE_ID, 'key-error-1');

    await expect(record(gym, [step(await card(gym, drills['ref-b']))], ATHLETE_ID, 'key-error-1'))
      .rejects.toBeInstanceOf(WorkoutIssueRequestKeyTakenError);
    // A key the column's own check refuses is not reported as "taken".
    const blank = record(gym, [step(await card(gym, drills['ref-c']))], ATHLETE_ID, '   ');
    await expect(blank).rejects.toMatchObject({ constraint: 'pilot_workout_issues_request_key_check' });
    await expect(blank).rejects.not.toBeInstanceOf(WorkoutIssueRequestKeyTakenError);
    expect((await counts(gym)).issues).toBe(1);
  });

  test('the lookup answers only in its own gym and only for the key asked', async () => {
    const here = await gymWithWorkout('key-find-here');
    const there = await gymWithWorkout('key-find-there');
    const first = await issue(here.gym, ATHLETE_ID, 'key-find-1');
    if (first.outcome !== 'issued') throw new Error('must issue');

    expect(await findWorkoutIssueByRequestKey(here.gym.organizationId, 'key-find-1')).toEqual({
      issue_id: first.issue_id,
      athlete_id: ATHLETE_ID,
      template_id: TEMPLATE_ID,
      template_name: 'Shape Fixture',
      template_version: 3,
      step_count: 4,
    });
    expect(await findWorkoutIssueByRequestKey(there.gym.organizationId, 'key-find-1')).toBeNull();
    expect(await findWorkoutIssueByRequestKey(here.gym.organizationId, 'key-find-2')).toBeNull();
  });
});

describe('the rows leave only by cascade', () => {
  test("the retention purge's delete of the athlete removes the issue, its steps and the assignments, and nobody else's", async () => {
    const { gym } = await gymWithWorkout('purge');
    await issue(gym);
    await issue(gym, OTHER_ATHLETE_ID);
    expect(await counts(gym)).toEqual({ issues: 2, steps: 8, assignments: 8 });

    // The statement scripts/pilot-cleanup-deleted-data.mjs runs.
    await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2 returning athlete_id', [
      gym.organizationId,
      ATHLETE_ID,
    ]);

    expect(await counts(gym)).toEqual({ issues: 1, steps: 4, assignments: 4 });
    const left = await client.query(`select distinct athlete_id from pilot.workout_issues where organization_id = $1`, [gym.organizationId]);
    expect(left.rows).toEqual([{ athlete_id: OTHER_ATHLETE_ID }]);
  });

  test('deleting one assignment removes its step and leaves the workout and its other steps', async () => {
    const { gym } = await gymWithWorkout('one-assignment');
    const result = await issue(gym);
    if (result.outcome !== 'issued') throw new Error('fixture did not issue');

    await client.query(`delete from pilot.drill_assignments where assignment_id = $1`, [result.steps[1].assignment.assignment_id]);

    const { rows } = await client.query(
      `select ordinal from pilot.workout_issue_steps where organization_id = $1 order by ordinal`,
      [gym.organizationId],
    );
    expect(rows.map((row) => row.ordinal)).toEqual([1, 3, 4]);
    expect(await counts(gym)).toEqual({ issues: 1, steps: 3, assignments: 3 });
  });

  test('cancelling a step\'s assignment keeps the step in its place', async () => {
    const { gym } = await gymWithWorkout('cancel');
    const result = await issue(gym);
    if (result.outcome !== 'issued') throw new Error('fixture did not issue');

    await client.query(`update pilot.drill_assignments set status = 'cancelled' where assignment_id = $1`, [
      result.steps[2].assignment.assignment_id,
    ]);

    const { rows } = await client.query(
      `select s.ordinal, a.status from pilot.workout_issue_steps s
       join pilot.drill_assignments a on a.organization_id = s.organization_id and a.assignment_id = s.assignment_id
       where s.organization_id = $1 order by s.ordinal`,
      [gym.organizationId],
    );
    expect(rows).toEqual([
      { ordinal: 1, status: 'assigned' },
      { ordinal: 2, status: 'assigned' },
      { ordinal: 3, status: 'cancelled' },
      { ordinal: 4, status: 'assigned' },
    ]);
  });
});

describe('reading an issued workout back (listIssuedWorkoutsForAssignments)', () => {
  /** A step row written by hand, past the module's own join, to stage a row the writer refuses. */
  async function rawStep(organizationId: string, issueId: string, ordinal: number, assignmentId: string): Promise<void> {
    await client.query(
      `insert into pilot.workout_issue_steps
         (organization_id, issue_id, ordinal, block, scale_level, contact_level, coach_note, template_item_id, assignment_id)
       values ($1, $2::uuid, $3, 'planted', null, 'none', 'planted note', 'wti_planted', $4)`,
      [organizationId, issueId, ordinal, assignmentId],
    );
  }

  async function issued(gym: Gym, athleteId = ATHLETE_ID) {
    const result = await issue(gym, athleteId);
    if (result.outcome !== 'issued') throw new Error('fixture did not issue');
    return result;
  }

  const idsOf = (result: { steps: Array<{ assignment: { assignment_id: string } }> }) =>
    result.steps.map((entry) => entry.assignment.assignment_id);

  test('the workout comes back as the coach wrote it: every step in order with its block, levels, note and assignment', async () => {
    const { gym } = await gymWithWorkout('read');
    const result = await issued(gym);
    // Asked in an order that is not the workout's.
    const asked = [...idsOf(result)].reverse();

    const workouts = await listIssuedWorkoutsForAssignments(gym.organizationId, asked);

    expect(workouts).toHaveLength(1);
    expect(workouts[0]).toMatchObject({
      issue_id: result.issue_id,
      athlete_id: ATHLETE_ID,
      template_name: 'Shape Fixture',
      template_version: 3,
      issued_by_account_id: gym.coachId,
    });
    expect(new Date(workouts[0].issued_at).getTime()).toBeGreaterThan(0);
    expect(workouts[0].steps).toEqual(
      WORKOUT.map((fixture, index) => ({
        ordinal: index + 1,
        block: fixture.block,
        scale_level: fixture.scale,
        contact_level: fixture.contact,
        coach_note: fixture.note,
        assignment_id: result.steps[index].assignment.assignment_id,
      })),
    );
  });

  test('it answers only about the assignments it is asked about: some steps, none, or no ids at all', async () => {
    const { gym, drills } = await gymWithWorkout('read-asked');
    const result = await issued(gym);
    const ids = idsOf(result);
    const loose = await card(gym, drills['ref-a']);

    const some = await listIssuedWorkoutsForAssignments(gym.organizationId, [ids[2], ids[0], loose]);
    expect(some).toHaveLength(1);
    expect(some[0].steps.map((entry) => [entry.ordinal, entry.assignment_id])).toEqual([[1, ids[0]], [3, ids[2]]]);

    // A Coach Card is a step of no workout, and a workout none of whose steps
    // was asked about is not returned.
    await expect(listIssuedWorkoutsForAssignments(gym.organizationId, [loose])).resolves.toEqual([]);

    // No ids: nothing, and no statement at all -- never "every workout".
    const pooled = () => (query as jest.Mock).mock.calls.length;
    const before = pooled();
    await expect(listIssuedWorkoutsForAssignments(gym.organizationId, [])).resolves.toEqual([]);
    expect(pooled()).toBe(before);
  });

  test("another gym's reader gets nothing for these assignment ids, and this gym gets nothing for another gym's", async () => {
    const here = await gymWithWorkout('read-here');
    const there = await gymWithWorkout('read-there');
    const mine = idsOf(await issued(here.gym));
    const theirs = idsOf(await issued(there.gym));

    await expect(listIssuedWorkoutsForAssignments(there.gym.organizationId, mine)).resolves.toEqual([]);
    await expect(listIssuedWorkoutsForAssignments(here.gym.organizationId, theirs)).resolves.toEqual([]);
    // Each reads its own, all four steps.
    expect((await listIssuedWorkoutsForAssignments(here.gym.organizationId, [...mine, ...theirs]))[0].steps).toHaveLength(4);
  });

  test("a step planted in one gym on another gym's assignment is returned to neither", async () => {
    const here = await gymWithWorkout('planted-here');
    const there = await gymWithWorkout('planted-there');
    const result = await issued(here.gym);
    const foreign = await card(there.gym, there.drills['ref-a']);
    // The database allows it (the foreign key is on assignment_id alone); the
    // read's join on the organization is what keeps it out.
    await rawStep(here.gym.organizationId, result.issue_id, 99, foreign);

    const mine = await listIssuedWorkoutsForAssignments(here.gym.organizationId, [...idsOf(result), foreign]);
    expect(mine).toHaveLength(1);
    expect(mine[0].steps.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(mine)).not.toContain('planted note');
    await expect(listIssuedWorkoutsForAssignments(there.gym.organizationId, [foreign])).resolves.toEqual([]);
  });

  test("a step planted on ANOTHER athlete's assignment of the same gym is not part of this athlete's workout", async () => {
    const { gym, drills } = await gymWithWorkout('planted-athlete');
    const result = await issued(gym);
    const theirs = await card(gym, drills['ref-b'], OTHER_ATHLETE_ID);
    await rawStep(gym.organizationId, result.issue_id, 99, theirs);

    // Asked as the other athlete's reader would be (their own assignment id):
    // the planted step belongs to a workout issued to someone else, so the
    // other athlete is shown nothing of it -- not the note, not the workout.
    await expect(listIssuedWorkoutsForAssignments(gym.organizationId, [theirs])).resolves.toEqual([]);
    const mine = await listIssuedWorkoutsForAssignments(gym.organizationId, [...idsOf(result), theirs]);
    expect(mine[0].steps.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
  });

  test('two workouts come back newest first, each with only its own steps', async () => {
    const { gym } = await gymWithWorkout('read-two');
    const older = await issued(gym);
    const newer = await issued(gym);
    await client.query(`update pilot.workout_issues set issued_at = now() - interval '2 days' where issue_id = $1::uuid`, [older.issue_id]);

    const workouts = await listIssuedWorkoutsForAssignments(gym.organizationId, [...idsOf(older), ...idsOf(newer)]);

    expect(workouts.map((workout) => workout.issue_id)).toEqual([newer.issue_id, older.issue_id]);
    expect(workouts[0].steps.map((entry) => entry.assignment_id)).toEqual(idsOf(newer));
    expect(workouts[1].steps.map((entry) => entry.assignment_id)).toEqual(idsOf(older));
  });

  test('a cancelled step is still returned in its place', async () => {
    const { gym } = await gymWithWorkout('read-cancelled');
    const result = await issued(gym);
    await client.query(`update pilot.drill_assignments set status = 'cancelled' where assignment_id = $1`, [idsOf(result)[1]]);

    const [workout] = await listIssuedWorkoutsForAssignments(gym.organizationId, idsOf(result));

    expect(workout.steps.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
  });

  test('the family projection of a real read names the coach and carries no account id', async () => {
    const { gym } = await gymWithWorkout('read-family');
    const result = await issued(gym);
    const workouts = await listIssuedWorkoutsForAssignments(gym.organizationId, idsOf(result));
    const nameFor = jest.fn(async () => 'Coach J Rivera');

    const family = await toFamilyIssuedWorkouts(workouts, nameFor);

    expect(nameFor).toHaveBeenCalledTimes(1);
    expect(nameFor).toHaveBeenCalledWith(gym.coachId);
    expect(family[0]).toMatchObject({ issue_id: result.issue_id, issued_by_name: 'Coach J Rivera' });
    expect(family[0].steps).toEqual(workouts[0].steps);
    expect(family[0]).not.toHaveProperty('issued_by_account_id');
    expect(JSON.stringify(family)).not.toContain(gym.coachId);
  });
});

// LAST ON PURPOSE: these cases drop and rebuild the two tables, so every row
// the cases above wrote to them is gone by the time they finish.
describe('the migration and its readiness check', () => {
  async function rebuild(): Promise<void> {
    await client.query('drop table if exists pilot.workout_issue_steps');
    await client.query('drop table if exists pilot.workout_issues');
    await applyMigrationTransaction(client, migrationSql);
  }

  test('applying it again on a database that already has it changes nothing and keeps the rows', async () => {
    const { gym } = await gymWithWorkout('reapply');
    await issue(gym);
    const before = await counts(gym);

    await applyMigrationTransaction(client, migrationSql);
    await applyMigrationTransaction(client, migrationSql);

    expect(await counts(gym)).toEqual(before);
    expect(before).toEqual({ issues: 1, steps: 4, assignments: 4 });
  });

  const BROKEN: Array<[string, string[]]> = [
    ['the request key check is missing', ['alter table pilot.workout_issues drop constraint pilot_workout_issues_request_key_check']],
    ['the ordinal check is missing', ['alter table pilot.workout_issue_steps drop constraint pilot_workout_issue_steps_ordinal_check']],
    [
      'the scale level check is looser',
      [
        'alter table pilot.workout_issue_steps drop constraint pilot_workout_issue_steps_scale_level_check',
        `alter table pilot.workout_issue_steps add constraint pilot_workout_issue_steps_scale_level_check
           check (scale_level is null or scale_level in ('A', 'B', 'C', 'D'))`,
      ],
    ],
    [
      'the contact level check is looser',
      [
        'alter table pilot.workout_issue_steps drop constraint pilot_workout_issue_steps_contact_level_check',
        `alter table pilot.workout_issue_steps add constraint pilot_workout_issue_steps_contact_level_check
           check (contact_level in ('none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring', 'full_contact'))`,
      ],
    ],
    [
      'the athlete foreign key does not cascade',
      [
        'alter table pilot.workout_issues drop constraint pilot_workout_issues_athlete_fk',
        `alter table pilot.workout_issues add constraint pilot_workout_issues_athlete_fk
           foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id)`,
      ],
    ],
    ['the template foreign key is missing', ['alter table pilot.workout_issues drop constraint pilot_workout_issues_template_fk']],
    [
      'the template foreign key cascades',
      [
        'alter table pilot.workout_issues drop constraint pilot_workout_issues_template_fk',
        `alter table pilot.workout_issues add constraint pilot_workout_issues_template_fk
           foreign key (organization_id, template_id) references pilot.workout_templates(organization_id, template_id)
           on delete cascade`,
      ],
    ],
    [
      'the step-to-issue foreign key does not cascade',
      [
        'alter table pilot.workout_issue_steps drop constraint pilot_workout_issue_steps_issue_fk',
        `alter table pilot.workout_issue_steps add constraint pilot_workout_issue_steps_issue_fk
           foreign key (organization_id, issue_id) references pilot.workout_issues(organization_id, issue_id)`,
      ],
    ],
    [
      'the step-to-assignment foreign key does not cascade',
      [
        'alter table pilot.workout_issue_steps drop constraint pilot_workout_issue_steps_assignment_fk',
        `alter table pilot.workout_issue_steps add constraint pilot_workout_issue_steps_assignment_fk
           foreign key (assignment_id) references pilot.drill_assignments(assignment_id)`,
      ],
    ],
    [
      'the one-workout-per-assignment index is not unique',
      [
        'drop index pilot.pilot_workout_issue_steps_one_per_assignment',
        'create index pilot_workout_issue_steps_one_per_assignment on pilot.workout_issue_steps(assignment_id)',
      ],
    ],
    [
      'the request key index covers every row instead of only keyed ones',
      [
        'drop index pilot.pilot_workout_issues_one_per_request_key',
        'create unique index pilot_workout_issues_one_per_request_key on pilot.workout_issues(organization_id, request_key)',
      ],
    ],
    [
      'the athlete read index is on other columns',
      ['drop index pilot.idx_workout_issues_athlete', 'create index idx_workout_issues_athlete on pilot.workout_issues(organization_id)'],
    ],
  ];

  test.each(BROKEN)('readiness refuses a database where %s', async (_label, statements) => {
    await rebuild();
    for (const statement of statements) {
      await client.query(statement);
    }

    await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('WORKOUT_ISSUES_NOT_READY');
  });

  test('a rebuilt database passes readiness, so each refusal above is its one broken piece', async () => {
    await rebuild();

    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
  });
});
