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
//   * READINESS IS RED when any one guard is missing or looser.
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
import { promoteReferenceDrill } from './drills';
import { recordWorkoutIssue, type WorkoutIssueStepInput } from './workoutIssues';
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

/** A reference drill that passes adoption readiness, adopted by the gym. Returns the gym's drill id. */
async function runningDrill(gym: Gym, referenceId: string, name: string): Promise<string> {
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
  { drill: 'ref-c', block: 'technical', scale: 'C', contact: 'controlled_sparring', note: 'Two rounds, coach watching.', minutes: null, reps: null },
  { drill: 'ref-a', block: 'warmup', scale: 'B', contact: 'none', note: null, minutes: 3, reps: null },
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

function issue(gym: Gym, athleteId = ATHLETE_ID): Promise<TemplateIssueResult> {
  return issueWorkoutTemplate({
    organizationId: gym.organizationId,
    templateId: TEMPLATE_ID,
    athleteId,
    actorAccountId: gym.coachId,
    actorRole: 'coach',
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
async function record(gym: Gym, steps: WorkoutIssueStepInput[], athleteId = ATHLETE_ID): Promise<string> {
  const own = await ownConnection();
  try {
    await own.query('BEGIN');
    const issueId = await recordWorkoutIssue(own as never, {
      organizationId: gym.organizationId,
      athleteId,
      template: { template_id: TEMPLATE_ID, name: 'Shape Fixture', version: 3 },
      issuedByAccountId: gym.coachId,
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
       join pilot.drill_assignments a on a.assignment_id = s.assignment_id
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
