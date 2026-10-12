// Real-PostgreSQL proof for issuing a workout template (lane P7, #1401):
// issueWorkoutTemplate in workoutTemplates.ts, and the optional transaction
// client it relies on in promoteReferenceDrill (drills.ts) and issueCoachCard
// (coachCards.ts).
//
// What only a real database can prove, and a faked query cannot:
//
//   * ALL OR NOTHING. A template is issued in one transaction. When a write
//     fails part-way -- an adoption that collides, a card that cannot be
//     written -- every earlier write of that issue is gone: no adopted drill,
//     no assignment, no audit row.
//   * THE CLIENT PARAMETER JOINS THE CALLER'S TRANSACTION. A drill promoted
//     and a card issued on a caller's client are invisible to every other
//     connection until that caller commits, and leave nothing when it rolls
//     back.
//   * A DRILL ADOPTED IN THE TRANSACTION CAN BE CARDED IN IT. The card is
//     inserted FROM pilot.drills; the adopted row exists only on that
//     connection at that moment.
//   * A REFUSAL WRITES NOTHING, decided by the production lifecycle and
//     readiness SQL rather than by a mock's idea of it.
//
// './db' is mocked the way drillLifecycle.pg.test.ts mocks it: query and
// queryOne go to one connection (the "pool"), and withTransaction opens ITS OWN
// connection per call, as db.ts's pool does. So a pooled read made while a
// transaction is open sees only committed rows -- which is production's shape,
// and the shape the writer's comments make claims about.
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
import { query, queryOne, withTransaction } from './db';
import { markDrillFloorTested } from './drillFloorValidations';
import { promoteReferenceDrill, updateDrill } from './drills';
import { issueWorkoutTemplate, type TemplateIssueResult } from './workoutTemplates';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-workout-template-issue-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_p7_workout_template_issue';

const DRAFT = 'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const TEMPLATE_ID = 'wtp_issue';
const ATHLETE_ID = 'athlete-issue';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
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

/**
 * A fresh gym for one test: an organization, the boxing discipline the
 * reference drills hang off, a coach account, and one athlete of that coach.
 * Ids repeat across gyms on purpose -- the organization is the boundary.
 */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-p7-${label}-${gymCount}`;
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
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Template Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
    [organizationId, ATHLETE_ID, coachId],
  );
  return { organizationId, coachId };
}

/**
 * One reference drill that passes adoption readiness: A/B/C scale levels with
 * one starting point, a stop rule of its own and a coaching cue. `draft` gives
 * it a REQUIRES FLOOR VALIDATION provenance; `cues: false` leaves it cue-less.
 */
async function insertReference(
  gym: Gym,
  drillId: string,
  name: string,
  opts: {
    draft?: boolean;
    cues?: boolean;
    stopRules?: boolean;
    lineageId?: string;
    version?: number;
    active?: boolean;
    superseded?: boolean;
  } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        field_provenance, active, superseded_at)
     values ($1,$2,$3,$4,$5,'boxing','footwork','advanced', $5 || ' target.', $5 || ' purpose.',
             $5 || ' setup.', $5 || ' execution.', $5 || ' good.', $5 || ' bad.',
             coalesce($6::text, 'PPBF source manual v3'), $7, case when $8::boolean then now() else null end)`,
    [
      gym.organizationId,
      drillId,
      opts.lineageId ?? drillId,
      opts.version ?? 1,
      name,
      opts.draft ? DRAFT : null,
      opts.active ?? true,
      opts.superseded ?? false,
    ],
  );
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description,
        constraint_applied, contact_level, coach_watch_point, authoring_state)
     values ($1, $2 || '-a', $2, 'A', false, 'easier',   '', 'none', 'watch', 'authored'),
            ($1, $2 || '-b', $2, 'B', true,  'standard', '', 'none', 'watch', 'authored'),
            ($1, $2 || '-c', $2, 'C', false, 'harder',   '', 'none', 'watch', 'authored')`,
    [gym.organizationId, drillId],
  );
  if (opts.stopRules !== false) {
    await client.query(
      `insert into pilot.drill_stop_rules
         (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
       values ($1, $2 || '-stop-1', $2, 1, 'Stop when the guard drops.', 'universal', 'safety')`,
      [gym.organizationId, drillId],
    );
  }
  if (opts.cues !== false) {
    await client.query(
      `insert into pilot.drill_cues
         (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref)
       values ($1, $2 || '-cue-1', $2, $3 || ' cue', 'guard', 'external', 'note', 'batch-7')`,
      [gym.organizationId, drillId, name],
    );
  }
}

/** The template and its steps: one step per reference drill id, in order. */
async function insertTemplate(gym: Gym, drillIds: string[]): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, name, session_type, difficulty, age_band, active,
        duration_minutes, intent)
     values ($1,$2,$2,'Issue Fixture','technical','intermediate','any',true,45,'Test intent')`,
    [gym.organizationId, TEMPLATE_ID],
  );
  for (const [index, drillId] of drillIds.entries()) {
    const ordinal = index + 1;
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, scale_level, duration_minutes,
          rep_count, contact_level, coach_note)
       values ($1, $2, $3, $4, 'technical', $5, 'B', $6, $7, 'none', 'A note the assignment cannot carry.')`,
      // Odd steps carry minutes, even steps carry reps, so both columns are proven to travel.
      [gym.organizationId, `wti_${ordinal}`, TEMPLATE_ID, ordinal, drillId, ordinal % 2 === 1 ? 5 + ordinal : null, ordinal % 2 === 0 ? 10 * ordinal : null],
    );
  }
}

/** A promotion through the production writer, committed. Returns the operational drill id. */
async function adopt(gym: Gym, referenceDrillId: string, name: string): Promise<string> {
  const drill = await promoteReferenceDrill({
    organizationId: gym.organizationId,
    referenceDrillId,
    name,
    category: 'footwork',
    focus: `${name} purpose.`,
    cues: [`${name} cue`],
  });
  return drill.drill_id;
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

interface Written {
  drills: number;
  assignments: number;
  audit: number;
  shadowEvents: number;
  telemetry: number;
  // The issued workout's shape (lane P7c): written on the same transaction,
  // so every rollback proven below is proven for these rows too.
  issues: number;
  issueSteps: number;
}

const NOTHING: Written = { drills: 0, assignments: 0, audit: 0, shadowEvents: 0, telemetry: 0, issues: 0, issueSteps: 0 };

/**
 * Everything an issue can write, counted for one gym on the committed ("pool")
 * connection -- including the two mirrors writePilotAuditEvent writes beside
 * each audit row, which ride the same transaction and must roll back with it.
 */
async function written(gym: Gym): Promise<Written> {
  const { rows } = await client.query<Written>(
    `select (select count(*)::int from pilot.drills where organization_id = $1) as drills,
            (select count(*)::int from pilot.drill_assignments where organization_id = $1) as assignments,
            (select count(*)::int from pilot.audit_events where organization_id = $1) as audit,
            (select count(*)::int from pilot.shadow_events where organization_id = $1) as "shadowEvents",
            (select count(*)::int from pilot.shadow_telemetry_events where organization_id = $1) as telemetry,
            (select count(*)::int from pilot.workout_issues where organization_id = $1) as issues,
            (select count(*)::int from pilot.workout_issue_steps where organization_id = $1) as "issueSteps"`,
    [gym.organizationId],
  );
  return rows[0];
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  // The whole schema production runs (scripts/lib/full-schema.mjs): an issue
  // crosses the drills, provenance, v3 library, floor-validation, coach-card,
  // template and audit migrations.
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

describe('issuing a template', () => {
  test('adopted, unadopted and floor-tested-draft steps are issued together: drills adopted, one card per step, audited', async () => {
    const gym = await newGym('issue');
    await insertReference(gym, 'ref-run', 'Running Drill');
    await insertReference(gym, 'ref-new', 'New Drill');
    await insertReference(gym, 'ref-draft', 'Tested Draft', { draft: true });
    const runningId = await adopt(gym, 'ref-run', 'Running Drill');
    await markDrillFloorTested({
      organizationId: gym.organizationId,
      drillId: 'ref-draft',
      validatedByAccountId: gym.coachId,
      validatedByRole: 'coach',
      note: '',
    });
    await insertTemplate(gym, ['ref-run', 'ref-new', 'ref-draft', 'ref-new']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result.outcome).toBe('issued');
    if (result.outcome !== 'issued') return;

    // Two drills adopted -- 'ref-new' once, though two steps name it.
    expect(result.adopted.map((drill) => drill.reference_drill_id)).toEqual(['ref-draft', 'ref-new']);
    const drills = await client.query<{ drill_id: string; name: string; reference_drill_id: string; focus: string; cues: string[]; difficulty: string; active: boolean }>(
      `select drill_id, name, reference_drill_id, focus, cues, difficulty, active
       from pilot.drills where organization_id = $1 order by name`,
      [gym.organizationId],
    );
    expect(drills.rows.map((row) => [row.name, row.reference_drill_id, row.active])).toEqual([
      ['New Drill', 'ref-new', true],
      ['Running Drill', 'ref-run', true],
      ['Tested Draft', 'ref-draft', true],
    ]);
    // The promote route's mapping, landed: focus <- purpose, the reference's cue and difficulty.
    expect(drills.rows[0]).toMatchObject({ focus: 'New Drill purpose.', cues: ['New Drill cue'], difficulty: 'advanced' });
    const newId = drills.rows[0].drill_id;
    const draftId = drills.rows[2].drill_id;

    // One gap-free card per step, in step order, each built FROM the gym's drill.
    const cards = await client.query(
      `select assignment_id, gap_id, athlete_id, assigned_by_account_id, drill_id, drill_name, drill_description,
              drill_difficulty, rep_count, duration_minutes, issuance_id, status
       from pilot.drill_assignments where organization_id = $1`,
      [gym.organizationId],
    );
    expect(cards.rows).toHaveLength(4);
    const byId = new Map(cards.rows.map((row) => [row.assignment_id, row]));
    const issued = result.steps.map((step) => ({ step: step.step, ...byId.get(step.assignment.assignment_id) }));
    expect(issued).toEqual([
      // The gym's own drill keeps the difficulty the gym gave it; an adopted one takes the reference's.
      expect.objectContaining({ step: 1, drill_id: runningId, drill_name: 'Running Drill', drill_difficulty: 'intermediate', duration_minutes: 6, rep_count: null }),
      expect.objectContaining({ step: 2, drill_id: newId, drill_name: 'New Drill', drill_difficulty: 'advanced', duration_minutes: null, rep_count: 20 }),
      expect.objectContaining({ step: 3, drill_id: draftId, drill_name: 'Tested Draft', drill_difficulty: 'advanced', duration_minutes: 8, rep_count: null }),
      expect.objectContaining({ step: 4, drill_id: newId, drill_name: 'New Drill', drill_difficulty: 'advanced', duration_minutes: null, rep_count: 40 }),
    ]);
    for (const row of cards.rows) {
      expect(row).toMatchObject({
        gap_id: null,
        athlete_id: ATHLETE_ID,
        assigned_by_account_id: gym.coachId,
        issuance_id: null,
        status: 'assigned',
      });
    }
    expect(byId.get(result.steps[1].assignment.assignment_id).drill_description).toBe('New Drill purpose.');

    // Audit: one 'drill' create per adoption, and the issue itself, which holds the template link.
    const audit = await client.query(
      `select entity_type, entity_id, actor_account_id, actor_role, details
       from pilot.audit_events where organization_id = $1
       order by audit_id`,
      [gym.organizationId],
    );
    const fromIssue = audit.rows.slice(before.audit);
    expect(fromIssue.map((row) => [row.entity_type, row.entity_id])).toEqual([
      ['drill', draftId],
      ['drill', newId],
      ['workout_template_issue', TEMPLATE_ID],
    ]);
    expect(fromIssue[1].details).toMatchObject({
      reference_drill_id: 'ref-new',
      adopted_by: 'workout_template_issue',
      template_id: TEMPLATE_ID,
    });
    expect(fromIssue[2]).toMatchObject({ actor_account_id: gym.coachId, actor_role: 'coach' });
    expect(fromIssue[2].details).toMatchObject({
      athlete_id: ATHLETE_ID,
      adopted_drill_ids: [draftId, newId],
      steps: result.steps.map((step) => ({
        step: step.step,
        item_id: step.item_id,
        assignment_id: step.assignment.assignment_id,
        drill_id: step.assignment.drill_id,
      })),
    });
  });

  test('inside its transaction an issue takes NO second connection: every statement between BEGIN and COMMIT is on the transaction', async () => {
    const gym = await newGym('no-pool-in-transaction');
    await insertReference(gym, 'ref-run', 'Running Drill');
    await insertReference(gym, 'ref-new', 'New Drill');
    await adopt(gym, 'ref-run', 'Running Drill');
    await insertTemplate(gym, ['ref-run', 'ref-new']);

    // The pool here is max 10 with no acquire timeout in production (db.ts),
    // so a pooled statement made while the transaction holds a connection is
    // a hang waiting to happen under load. Counted across the whole callback.
    const pooled = () => (query as jest.Mock).mock.calls.length + (queryOne as jest.Mock).mock.calls.length;
    const mockedTransaction = withTransaction as jest.Mock;
    const realTransaction = mockedTransaction.getMockImplementation() as (fn: unknown) => Promise<unknown>;
    let duringTransaction = -1;
    mockedTransaction.mockImplementationOnce(async (fn: unknown) => {
      const before = pooled();
      try {
        return await realTransaction(fn);
      } finally {
        duringTransaction = pooled() - before;
      }
    });

    await expect(issue(gym)).resolves.toMatchObject({ outcome: 'issued', adopted: [{ reference_drill_id: 'ref-new' }] });

    expect(duringTransaction).toBe(0);
  });

  test('the template is never rewritten: its rows are byte-for-byte what they were', async () => {
    const gym = await newGym('template-untouched');
    await insertReference(gym, 'ref-a', 'Drill A');
    await insertTemplate(gym, ['ref-a']);
    const snapshot = async () => (await client.query(
      `select to_jsonb(t) as template,
              (select jsonb_agg(to_jsonb(i) order by i.ordinal) from pilot.workout_template_items i
               where i.organization_id = t.organization_id and i.template_id = t.template_id) as items
       from pilot.workout_templates t where t.organization_id = $1`,
      [gym.organizationId],
    )).rows;
    const before = await snapshot();

    await expect(issue(gym)).resolves.toMatchObject({ outcome: 'issued' });

    expect(await snapshot()).toEqual(before);
  });
});

// Jason, 2026-10-11: "B" -- "Let a workout be issued with untested drills,
// shown to the coach as untested" (issue #1473). Replaces OD-2026-10-08-002
// item 2 at template issue; the drills stay drafts and stay unmarked.
describe('an untested DRAFT is issued and named', () => {
  const issueAuditDetails = async (gym: Gym) => (await client.query(
    `select details from pilot.audit_events
     where organization_id = $1 and entity_type = 'workout_template_issue' order by audit_id`,
    [gym.organizationId],
  )).rows.map((row) => row.details);

  test('an unadopted untested draft among tested steps: every step an assignment, the draft adopted, the result and the audit name it', async () => {
    const gym = await newGym('untested-draft');
    await insertReference(gym, 'ref-ok', 'Ready Drill');
    await insertReference(gym, 'ref-draft', 'Untested Draft', { draft: true });
    await insertTemplate(gym, ['ref-ok', 'ref-draft']);

    const result = await issue(gym);

    expect(result).toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-draft', name: 'Untested Draft', steps: [2] }],
    });
    if (result.outcome !== 'issued') return;
    expect(result.steps).toHaveLength(2);
    expect(result.adopted.map((drill) => drill.reference_drill_id).sort()).toEqual(['ref-draft', 'ref-ok']);
    expect(await written(gym)).toMatchObject({ drills: 2, assignments: 2, issues: 1, issueSteps: 2 });
    expect(await issueAuditDetails(gym)).toEqual([
      expect.objectContaining({ untested_reference_drill_ids: ['ref-draft'] }),
    ]);
    // Still a draft, still unmarked: issuing is not a floor test.
    const { rows: marks } = await client.query(
      `select count(*)::int as n from pilot.drill_floor_validations where organization_id = $1`,
      [gym.organizationId],
    );
    expect(marks).toEqual([{ n: 0 }]);
  });

  test("another gym's floor test of the same drill id does not clear it here", async () => {
    const here = await newGym('draft-here');
    const there = await newGym('draft-there');
    for (const gym of [here, there]) {
      await insertReference(gym, 'ref-draft', 'Shared Draft', { draft: true });
      await insertTemplate(gym, ['ref-draft']);
    }
    await markDrillFloorTested({
      organizationId: there.organizationId,
      drillId: 'ref-draft',
      validatedByAccountId: there.coachId,
      validatedByRole: 'coach',
      note: '',
    });

    await expect(issue(here)).resolves.toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-draft' }],
    });
    await expect(issue(there)).resolves.toMatchObject({ outcome: 'issued', untested: [] });
  });

  test('a DRAFT the gym already adopted, with no mark, is assigned and named; once marked it is not named', async () => {
    const gym = await newGym('adopted-untested-draft');
    await insertReference(gym, 'ref-draft', 'Adopted Before The Gate', { draft: true });
    // Adopted before the floor-test gate existed. The promote ROUTE would
    // refuse this today, so the writer is called directly, past that check.
    const drillId = await adopt(gym, 'ref-draft', 'Adopted Before The Gate');
    await insertTemplate(gym, ['ref-draft']);

    const first = await issue(gym);

    expect(first).toMatchObject({
      outcome: 'issued',
      adopted: [],
      untested: [{ reference_drill_id: 'ref-draft', name: 'Adopted Before The Gate', steps: [1] }],
    });
    if (first.outcome !== 'issued') return;
    expect(first.steps[0].assignment.drill_id).toBe(drillId);

    await markDrillFloorTested({
      organizationId: gym.organizationId,
      drillId: 'ref-draft',
      validatedByAccountId: gym.coachId,
      validatedByRole: 'coach',
      note: '',
    });

    await expect(issue(gym)).resolves.toMatchObject({ outcome: 'issued', adopted: [], untested: [] });
  });

  test('a newer untested version of a drill the gym runs: the gym drill is updated in place and named', async () => {
    const gym = await newGym('untested-newer-version');
    await insertReference(gym, 'ref-v1', 'Versioned Drill', { lineageId: 'lin-1', version: 1 });
    const oldId = await adopt(gym, 'ref-v1', 'Versioned Drill');
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-v1'`,
      [gym.organizationId],
    );
    await insertReference(gym, 'ref-v2', 'Versioned Drill II', { lineageId: 'lin-1', version: 2, draft: true });
    await insertTemplate(gym, ['ref-v2']);

    const result = await issue(gym);

    expect(result).toMatchObject({
      outcome: 'issued',
      adopted: [],
      updated: [{ reference_drill_id: 'ref-v2', updated_from_drill_id: oldId }],
      untested: [{ reference_drill_id: 'ref-v2', name: 'Versioned Drill II', steps: [1] }],
    });
    expect(await issueAuditDetails(gym)).toEqual([
      expect.objectContaining({ untested_reference_drill_ids: ['ref-v2'] }),
    ]);
  });

  test('untested AND without a stop rule: refused for the stop rule alone, and nothing is written', async () => {
    const gym = await newGym('untested-no-stop');
    await insertReference(gym, 'ref-ok', 'Ready Drill');
    await insertReference(gym, 'ref-draft', 'Half Built Draft', { draft: true, stopRules: false });
    await insertTemplate(gym, ['ref-ok', 'ref-draft']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Half Built Draft.',
      drills: [{ steps: [2], drill_id: 'ref-draft', name: 'Half Built Draft', reason: 'It has no stop rules.' }],
    });
    expect(await written(gym)).toEqual(before);
  });

  test('a template mixing a retired drill and an untested draft is refused, only the retired one named, nothing written', async () => {
    const gym = await newGym('retired-and-untested');
    await insertReference(gym, 'ref-a', 'Retired Drill');
    const retiredId = await adopt(gym, 'ref-a', 'Retired Drill');
    await updateDrill({ organizationId: gym.organizationId, drillId: retiredId, active: false });
    await insertReference(gym, 'ref-draft', 'Untested Draft', { draft: true });
    await insertTemplate(gym, ['ref-a', 'ref-draft']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'refused' });
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => drill.drill_id)).toEqual(['ref-a']);
    expect(result.drills[0].reason).toBe('This gym adopted this drill and then retired it. Restore it in the drill library first.');
    expect(await written(gym)).toEqual(before);
  });
});

describe('a refusal writes nothing', () => {
  test('a drill the gym adopted and then retired is named, and is not revived', async () => {
    const gym = await newGym('retired');
    await insertReference(gym, 'ref-a', 'Retired Drill');
    const drillId = await adopt(gym, 'ref-a', 'Retired Drill');
    await updateDrill({ organizationId: gym.organizationId, drillId, active: false });
    await insertTemplate(gym, ['ref-a']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{ drill_id: 'ref-a', name: 'Retired Drill' }],
    });
    expect(await written(gym)).toEqual(before);
    const { rows } = await client.query(`select active from pilot.drills where organization_id = $1`, [gym.organizationId]);
    expect(rows).toEqual([{ active: false }]);
  });

  test('a technique drill with no coaching cue, and one with no stop rule, are both named', async () => {
    const gym = await newGym('not-ready');
    await insertReference(gym, 'ref-nocue', 'Cue-less Drill', { cues: false });
    await insertReference(gym, 'ref-nostop', 'Stop-less Drill', { stopRules: false });
    await insertTemplate(gym, ['ref-nocue', 'ref-nostop']);

    const result = await issue(gym);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => [drill.name, drill.reason])).toEqual([
      ['Cue-less Drill', 'It has no coaching cue. A technique drill needs at least one; a conditioning drill does not.'],
      ['Stop-less Drill', 'It has no stop rules.'],
    ]);
    expect(await written(gym)).toEqual(NOTHING);
  });

  test('an adopted, running drill is assigned although its reference was later WITHDRAWN', async () => {
    const gym = await newGym('adopted-then-withdrawn');
    await insertReference(gym, 'ref-a', 'Outlives Its Reference');
    const drillId = await adopt(gym, 'ref-a', 'Outlives Its Reference');
    await client.query(`update pilot.drill_library set active = false where organization_id = $1 and drill_id = 'ref-a'`, [
      gym.organizationId,
    ]);
    await insertTemplate(gym, ['ref-a']);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'issued', adopted: [] });
    if (result.outcome !== 'issued') return;
    expect(result.steps[0].assignment.drill_id).toBe(drillId);
    expect(await written(gym)).toMatchObject({ drills: 1, assignments: 1 });
  });

  test('an adopted, running drill is assigned although its reference was later SUPERSEDED', async () => {
    const gym = await newGym('adopted-then-superseded');
    await insertReference(gym, 'ref-v1', 'Superseded Under It', { lineageId: 'lin-1', version: 1 });
    const drillId = await adopt(gym, 'ref-v1', 'Superseded Under It');
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-v1'`,
      [gym.organizationId],
    );
    await insertReference(gym, 'ref-v2', 'Superseded Under It II', { lineageId: 'lin-1', version: 2 });
    await insertTemplate(gym, ['ref-v1']);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'issued', adopted: [] });
    if (result.outcome !== 'issued') return;
    expect(result.steps[0].assignment.drill_id).toBe(drillId);
  });

  test('a running drill of this gym that breaks the cue rule is named, by the production cue-rule read', async () => {
    const gym = await newGym('running-no-cue');
    await insertReference(gym, 'ref-a', 'Cue-less Running Drill', { cues: false });
    // Adopted before the cue rule: a technique drill the gym runs with no cue.
    await client.query(
      `insert into pilot.drills (organization_id, drill_id, name, category, focus, cues, reference_drill_id)
       values ($1, 'op-nocue', 'Cue-less Running Drill', 'footwork', 'Focus.', '{}', 'ref-a')`,
      [gym.organizationId],
    );
    await insertTemplate(gym, ['ref-a']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{ steps: [1], drill_id: 'ref-a', name: 'Cue-less Running Drill' }],
    });
    if (result.outcome !== 'refused') return;
    expect(result.drills[0].reason).toContain('has no coaching cue');
    expect(await written(gym)).toEqual(before);
  });

  test('a withdrawn reference and a superseded one the gym has NOT adopted are both named and neither is adopted', async () => {
    const gym = await newGym('withdrawn-superseded');
    await insertReference(gym, 'ref-gone', 'Withdrawn Drill', { active: false });
    await insertReference(gym, 'ref-old', 'Old Version', { lineageId: 'lin-1', version: 1, superseded: true });
    await insertReference(gym, 'ref-head', 'New Version', { lineageId: 'lin-1', version: 2 });
    await insertTemplate(gym, ['ref-gone', 'ref-old']);

    const result = await issue(gym);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => [drill.name, drill.reason])).toEqual([
      ['Withdrawn Drill', 'The reference drill has been withdrawn.'],
      ['Old Version', 'A newer version of this reference drill exists.'],
    ]);
    expect(await written(gym)).toEqual(NOTHING);
  });

  test("a step naming the newer version updates the gym's drill in place while issuing, then assigns it (Jason, question card 2026-10-11)", async () => {
    const gym = await newGym('other-version');
    await insertReference(gym, 'ref-v1', 'Versioned Drill', { lineageId: 'lin-1', version: 1 });
    const oldId = await adopt(gym, 'ref-v1', 'Versioned Drill');
    // The library then gains v2 under a new name; the template names v2.
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-v1'`,
      [gym.organizationId],
    );
    await insertReference(gym, 'ref-v2', 'Versioned Drill II', { lineageId: 'lin-1', version: 2 });
    await insertTemplate(gym, ['ref-v2']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'issued' });
    if (result.outcome !== 'issued') return;
    const newId = result.updated[0]?.drill_id;
    expect(result.adopted).toEqual([]);
    expect(result.updated).toEqual([
      { drill_id: newId, reference_drill_id: 'ref-v2', name: 'Versioned Drill II', updated_from_drill_id: oldId },
    ]);
    expect(result.steps[0].assignment).toMatchObject({ drill_id: newId, drill_description: 'Versioned Drill II purpose.' });

    // The SAME gym drill, one version on: the pointer moved, the old version kept.
    const { rows: versions } = await client.query(
      `select drill_id, version, active, reference_drill_id from pilot.drills
       where organization_id = $1 and lineage_id = $2 order by version`,
      [gym.organizationId, oldId],
    );
    expect(versions).toEqual([
      { drill_id: oldId, version: 1, active: false, reference_drill_id: 'ref-v1' },
      { drill_id: newId, version: 2, active: true, reference_drill_id: 'ref-v2' },
    ]);
    // One new drill row, one card, the update's audit row and the issue's, one issue.
    expect(await written(gym)).toEqual({
      drills: before.drills + 1,
      assignments: before.assignments + 1,
      audit: before.audit + 2,
      shadowEvents: before.shadowEvents + 2,
      telemetry: before.telemetry + 2,
      issues: before.issues + 1,
      issueSteps: before.issueSteps + 1,
    });
    const { rows: audit } = await client.query(
      `select details from pilot.audit_events
       where organization_id = $1 and event_type = 'update' and entity_id = $2`,
      [gym.organizationId, newId],
    );
    expect(audit.map((row) => row.details)).toEqual([expect.objectContaining({
      action: 'reference_version_update',
      from_drill_id: oldId,
      from_reference_drill_id: 'ref-v1',
      reference_drill_id: 'ref-v2',
      adopted_by: 'workout_template_issue',
      template_id: TEMPLATE_ID,
    })]);
    // The issue's own audit row: an update is not counted as an adoption.
    const { rows: issueAudit } = await client.query(
      `select details from pilot.audit_events
       where organization_id = $1 and entity_type = 'workout_template_issue'`,
      [gym.organizationId],
    );
    expect(issueAudit.map((row) => row.details)).toEqual([
      expect.objectContaining({ adopted_drill_ids: [], updated_drill_ids: [newId] }),
    ]);

    // A template still naming the version the gym moved on from issues the
    // drill the gym runs now: no "retired, restore it", no second update.
    await client.query(
      `update pilot.workout_template_items set drill_id = 'ref-v1' where organization_id = $1`,
      [gym.organizationId],
    );
    const again = await issue(gym);
    expect(again).toMatchObject({ outcome: 'issued', adopted: [] });
    if (again.outcome !== 'issued') return;
    expect(again.steps[0].assignment.drill_id).toBe(newId);
  });

  test('a template naming BOTH versions issues: the update moves the older-version step onto the new drill too', async () => {
    const gym = await newGym('both-versions');
    await insertReference(gym, 'ref-v1', 'Versioned Drill', { lineageId: 'lin-1', version: 1 });
    const oldId = await adopt(gym, 'ref-v1', 'Versioned Drill');
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-v1'`,
      [gym.organizationId],
    );
    await insertReference(gym, 'ref-v2', 'Versioned Drill II', { lineageId: 'lin-1', version: 2 });
    await insertTemplate(gym, ['ref-v1', 'ref-v2']);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'issued' });
    if (result.outcome !== 'issued') return;
    const newId = result.updated[0]?.drill_id;
    expect(result.adopted).toEqual([]);
    expect(result.updated).toEqual([
      { drill_id: newId, reference_drill_id: 'ref-v2', name: 'Versioned Drill II', updated_from_drill_id: oldId },
    ]);
    expect(result.steps.map((step) => step.assignment.drill_id)).toEqual([newId, newId]);
  });

  test('a step naming the newer version of a drill the gym retired is refused and named; nothing is written', async () => {
    const gym = await newGym('other-version-retired');
    await insertReference(gym, 'ref-v1', 'Versioned Drill', { lineageId: 'lin-1', version: 1 });
    const oldId = await adopt(gym, 'ref-v1', 'Versioned Drill');
    await updateDrill({ organizationId: gym.organizationId, drillId: oldId, active: false });
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-v1'`,
      [gym.organizationId],
    );
    await insertReference(gym, 'ref-v2', 'Versioned Drill II', { lineageId: 'lin-1', version: 2 });
    await insertTemplate(gym, ['ref-v2']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{
        drill_id: 'ref-v2',
        name: 'Versioned Drill II',
        reason: 'This gym adopted an earlier version of this drill and then retired it. Restore it in the drill library first.',
      }],
    });
    expect(await written(gym)).toEqual(before);
  });

  test("a drill the gym refined is assigned as its CURRENT version, the gym's active row for that reference", async () => {
    const gym = await newGym('refined');
    await insertReference(gym, 'ref-a', 'Refined Drill');
    const firstId = await adopt(gym, 'ref-a', 'Refined Drill');
    // A refinement, written the way adoptDrillChangeProposal writes it: v1
    // deactivated and superseded, v2 active in the same lineage with the SAME
    // reference pointer.
    const { rows } = await client.query<{ lineage_id: string }>(
      `update pilot.drills set active = false, superseded_at = now() where organization_id = $1 and drill_id = $2
       returning lineage_id`,
      [gym.organizationId, firstId],
    );
    await client.query(
      `insert into pilot.drills
         (organization_id, drill_id, name, category, focus, cues, active, lineage_id, supersedes_drill_id, reference_drill_id, version)
       values ($1, 'op-v2', 'Refined Drill', 'footwork', 'Refined focus.', '{cue}', true, $2, $3, 'ref-a', 2)`,
      [gym.organizationId, rows[0].lineage_id, firstId],
    );
    await insertTemplate(gym, ['ref-a']);

    const result = await issue(gym);

    expect(result).toMatchObject({ outcome: 'issued', adopted: [] });
    if (result.outcome !== 'issued') return;
    expect(result.steps[0].assignment).toMatchObject({ drill_id: 'op-v2', drill_description: 'Refined focus.' });
  });

  test("another gym's template id reads as not_found, and neither gym is written to", async () => {
    const here = await newGym('tenant-here');
    const there = await newGym('tenant-there');
    await insertReference(there, 'ref-a', 'Their Drill');
    await insertTemplate(there, ['ref-a']);

    await expect(issue(here)).resolves.toEqual({ outcome: 'not_found' });

    expect(await written(here)).toEqual(NOTHING);
    expect(await written(there)).toEqual(NOTHING);
  });
});

describe('drill names are decided before anything is written', () => {
  test('every drill whose name an ACTIVE gym drill holds is named at once; a retired holder does not block', async () => {
    const gym = await newGym('names');
    await insertReference(gym, 'ref-a', 'Taken One');
    await insertReference(gym, 'ref-b', 'Taken Two');
    await insertReference(gym, 'ref-c', 'Held By Retired');
    await client.query(
      `insert into pilot.drills (organization_id, drill_id, name, category, focus, active)
       values ($1, 'own-1', 'Taken One', 'bagwork', 'Focus.', true),
              ($1, 'own-2', 'Taken Two', 'bagwork', 'Focus.', true),
              ($1, 'own-3', 'Held By Retired', 'bagwork', 'Focus.', false)`,
      [gym.organizationId],
    );
    await insertTemplate(gym, ['ref-a', 'ref-b', 'ref-c']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => [drill.steps, drill.name, drill.reason])).toEqual([
      [[1], 'Taken One', 'This gym already has a drill named "Taken One", so this one cannot be adopted under that name.'],
      [[2], 'Taken Two', 'This gym already has a drill named "Taken Two", so this one cannot be adopted under that name.'],
    ]);
    expect(await written(gym)).toEqual(before);
  });
});

describe('all or nothing: a failure inside the transaction leaves no part of the issue behind', () => {
  test('an adoption that loses a race inside the transaction rolls back the adoption made before it', async () => {
    const gym = await newGym('adoption-race');
    await insertReference(gym, 'ref-a-first', 'First Drill');
    await insertReference(gym, 'ref-b-raced', 'Raced Drill');
    await insertTemplate(gym, ['ref-a-first', 'ref-b-raced']);

    // Another coach adopts the second drill AFTER this issue has planned and
    // BEFORE its transaction writes: committed on the pool connection at the
    // moment the transaction opens. The issue then adopts 'First Drill' on its
    // transaction and collides on 'Raced Drill'.
    const mockedTransaction = withTransaction as jest.Mock;
    const realTransaction = mockedTransaction.getMockImplementation() as (fn: unknown) => Promise<unknown>;
    mockedTransaction.mockImplementationOnce(async (fn: unknown) => {
      await adopt(gym, 'ref-b-raced', 'Raced Drill');
      return realTransaction(fn);
    });

    await expect(issue(gym)).rejects.toMatchObject({ status: 409, code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED' });

    // Only the other coach's drill exists. 'First Drill' went with the rollback,
    // and so did its audit row and both mirrors.
    const { rows } = await client.query(`select name from pilot.drills where organization_id = $1`, [gym.organizationId]);
    expect(rows).toEqual([{ name: 'Raced Drill' }]);
    expect(await written(gym)).toEqual({ ...NOTHING, drills: 1 });

    // The retry plans against what is there now, and issues.
    await expect(issue(gym)).resolves.toMatchObject({
      outcome: 'issued',
      adopted: [{ reference_drill_id: 'ref-a-first' }],
    });
    expect(await written(gym)).toMatchObject({ drills: 2, assignments: 2 });
  });

  test('a failure at COMMIT leaves nothing: not the drills, not the cards, not the audit rows or their mirrors', async () => {
    const gym = await newGym('commit-fails');
    await insertReference(gym, 'ref-a', 'Drill A');
    await insertTemplate(gym, ['ref-a']);
    // Deferred to commit, so EVERY write of the issue -- the last audit row
    // included -- has been made on the transaction when the failure arrives.
    await client.query(
      `create or replace function pilot.p7_test_fail_at_commit() returns trigger language plpgsql as $$
       begin
         if new.organization_id = '${gym.organizationId}' then
           raise exception 'p7 test: commit refused';
         end if;
         return new;
       end $$`,
    );
    await client.query(
      `create constraint trigger p7_test_fail_at_commit after insert on pilot.drill_assignments
       deferrable initially deferred for each row execute function pilot.p7_test_fail_at_commit()`,
    );
    try {
      await expect(issue(gym)).rejects.toThrow('p7 test: commit refused');
    } finally {
      await client.query('drop trigger p7_test_fail_at_commit on pilot.drill_assignments');
      await client.query('drop function pilot.p7_test_fail_at_commit()');
    }

    expect(await written(gym)).toEqual(NOTHING);
  });

  test('a card that fails after an adoption and an earlier card rolls both back', async () => {
    const gym = await newGym('card-fails');
    await insertReference(gym, 'ref-a', 'Drill A');
    await insertReference(gym, 'ref-b', 'Drill B');
    await insertTemplate(gym, ['ref-a', 'ref-b']);
    // The second card for this gym's athlete is refused by the database itself.
    // A trigger rather than a mock, so the first card and both adoptions really
    // were written on the transaction before the failure.
    await client.query(
      `create or replace function pilot.p7_test_refuse_second_card() returns trigger language plpgsql as $$
       begin
         if new.organization_id = '${gym.organizationId}' and exists (
           select 1 from pilot.drill_assignments a
           where a.organization_id = new.organization_id and a.athlete_id = new.athlete_id
         ) then
           raise exception 'p7 test: second card refused';
         end if;
         return new;
       end $$`,
    );
    await client.query(
      `create trigger p7_test_refuse_second_card before insert on pilot.drill_assignments
       for each row execute function pilot.p7_test_refuse_second_card()`,
    );
    try {
      await expect(issue(gym)).rejects.toThrow('p7 test: second card refused');
    } finally {
      await client.query('drop trigger p7_test_refuse_second_card on pilot.drill_assignments');
      await client.query('drop function pilot.p7_test_refuse_second_card()');
    }

    expect(await written(gym)).toEqual(NOTHING);

    // And the same template issues cleanly once nothing refuses it: the failed
    // attempt left no half-adopted drill to trip over.
    await expect(issue(gym)).resolves.toMatchObject({ outcome: 'issued' });
    expect(await written(gym)).toMatchObject({ drills: 2, assignments: 2 });
  });

  test('an athlete id that is not an athlete of this gym fails the write and leaves no adopted drill', async () => {
    const gym = await newGym('no-athlete');
    await insertReference(gym, 'ref-a', 'Drill A');
    await insertTemplate(gym, ['ref-a']);

    // The route's reach gate refuses this before the writer runs; the writer
    // itself is still held by the athlete foreign key, inside the transaction.
    await expect(issue(gym, 'athlete-of-nobody')).rejects.toThrow(/pilot_drill_assignments_fk_athlete/);

    expect(await written(gym)).toEqual(NOTHING);
  });
});

describe("the optional client on promoteReferenceDrill and issueCoachCard joins the caller's transaction", () => {
  async function ownConnection(): Promise<Client> {
    const own = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await own.connect();
    return own;
  }

  test('rolled back: the adopted drill and the card are never visible to another connection, and nothing remains', async () => {
    const gym = await newGym('client-rollback');
    await insertReference(gym, 'ref-a', 'Drill A');
    const own = await ownConnection();
    try {
      await own.query('BEGIN');
      const drill = await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-a', name: 'Drill A', category: 'footwork', focus: 'Focus.', cues: ['cue'] },
        own as never,
      );
      // Carded from a drill that exists only on this transaction.
      const card = await issueCoachCard(
        { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.drill_id },
        own as never,
      );
      expect(card).toMatchObject({ drill_id: drill.drill_id, drill_name: 'Drill A', gap_id: null });

      // Uncommitted: the "pool" connection sees neither row.
      expect(await written(gym)).toEqual(NOTHING);

      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }

    expect(await written(gym)).toEqual(NOTHING);
  });

  test('committed: both rows land together', async () => {
    const gym = await newGym('client-commit');
    await insertReference(gym, 'ref-a', 'Drill A');
    const own = await ownConnection();
    try {
      await own.query('BEGIN');
      const drill = await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-a', name: 'Drill A', category: 'footwork', focus: 'Focus.', cues: ['cue'] },
        own as never,
      );
      await issueCoachCard(
        { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.drill_id },
        own as never,
      );
      expect(await written(gym)).toMatchObject({ drills: 0, assignments: 0 });
      await own.query('COMMIT');
    } finally {
      await own.end();
    }

    expect(await written(gym)).toMatchObject({ drills: 1, assignments: 1 });
  });

  test('the cue rule SEES a drill adopted earlier in the same transaction: a cue-less technique drill is refused there', async () => {
    const gym = await newGym('client-cue-rule');
    await insertReference(gym, 'ref-a', 'Cue-less In Transaction', { cues: false });
    const own = await ownConnection();
    try {
      await own.query('BEGIN');
      // Adopted with NO cue, on this transaction only. Readiness would refuse
      // this adoption; the writer is called directly so the card's own rule
      // is what is on trial.
      const drill = await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-a', name: 'Cue-less In Transaction', category: 'footwork', focus: 'Focus.', cues: [] },
        own as never,
      );

      // The pooled rule cannot see the uncommitted drill, so it has nothing to
      // judge and leaves the row to the insert -- which cannot see it either.
      await expect(
        issueCoachCard({ organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.drill_id }),
      ).rejects.toMatchObject({ code: 'DRILL_NOT_ASSIGNABLE' });

      // On the transaction the rule reads the drill, and its boxing reference, and refuses it.
      await expect(
        issueCoachCard(
          { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.drill_id },
          own as never,
        ),
      ).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED' });

      const { rows } = await own.query(`select count(*)::int as n from pilot.drill_assignments where organization_id = $1`, [gym.organizationId]);
      expect(rows[0].n).toBe(0);
      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }
  });

  test('a card issued on a client makes NO pooled statement at all, read or write', async () => {
    const gym = await newGym('client-no-pool');
    await insertReference(gym, 'ref-a', 'Drill A', { cues: false });
    const pooled = () => (query as jest.Mock).mock.calls.length + (queryOne as jest.Mock).mock.calls.length;
    const own = await ownConnection();
    try {
      await own.query('BEGIN');
      const before = pooled();
      // A cue-less drill adopted from a boxing reference takes the rule down
      // its longest path: the drill read AND the reference read.
      const drill = await promoteReferenceDrill(
        { organizationId: gym.organizationId, referenceDrillId: 'ref-a', name: 'Drill A', category: 'footwork', focus: 'Focus.', cues: [] },
        own as never,
      );
      await expect(
        issueCoachCard(
          { organizationId: gym.organizationId, athleteId: ATHLETE_ID, assignedByAccountId: gym.coachId, drillId: drill.drill_id },
          own as never,
        ),
      ).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED' });
      expect(pooled() - before).toBe(0);
      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }
  });

  test('with no client each is the single pooled, immediately committed write it always was', async () => {
    const gym = await newGym('client-omitted');
    await insertReference(gym, 'ref-a', 'Drill A');

    const drillId = await adopt(gym, 'ref-a', 'Drill A');
    expect(await written(gym)).toMatchObject({ drills: 1, assignments: 0 });

    await issueCoachCard({
      organizationId: gym.organizationId,
      athleteId: ATHLETE_ID,
      assignedByAccountId: gym.coachId,
      drillId,
    });
    expect(await written(gym)).toMatchObject({ drills: 1, assignments: 1 });
  });
});
