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
  opts: { draft?: boolean; cues?: boolean; stopRules?: boolean; lineageId?: string; version?: number } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        field_provenance)
     values ($1,$2,$3,$4,$5,'boxing','footwork','advanced', $5 || ' target.', $5 || ' purpose.',
             $5 || ' setup.', $5 || ' execution.', $5 || ' good.', $5 || ' bad.',
             coalesce($6::text, 'PPBF source manual v3'))`,
    [gym.organizationId, drillId, opts.lineageId ?? drillId, opts.version ?? 1, name, opts.draft ? DRAFT : null],
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

/** Everything an issue can write, counted for one gym on the committed ("pool") connection. */
async function written(gym: Gym): Promise<{ drills: number; assignments: number; audit: number }> {
  const { rows } = await client.query<{ drills: number; assignments: number; audit: number }>(
    `select (select count(*)::int from pilot.drills where organization_id = $1) as drills,
            (select count(*)::int from pilot.drill_assignments where organization_id = $1) as assignments,
            (select count(*)::int from pilot.audit_events where organization_id = $1) as audit`,
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
    expect(result.adopted.map((drill) => drill.reference_drill_id)).toEqual(['ref-new', 'ref-draft']);
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
      ['drill', newId],
      ['drill', draftId],
      ['workout_template_issue', TEMPLATE_ID],
    ]);
    expect(fromIssue[0].details).toMatchObject({
      reference_drill_id: 'ref-new',
      adopted_by: 'workout_template_issue',
      template_id: TEMPLATE_ID,
    });
    expect(fromIssue[2]).toMatchObject({ actor_account_id: gym.coachId, actor_role: 'coach' });
    expect(fromIssue[2].details).toMatchObject({
      athlete_id: ATHLETE_ID,
      adopted_drill_ids: [newId, draftId],
      steps: result.steps.map((step) => ({
        step: step.step,
        item_id: step.item_id,
        assignment_id: step.assignment.assignment_id,
        drill_id: step.assignment.drill_id,
      })),
    });
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

describe('a refusal writes nothing', () => {
  test('an untested DRAFT drill refuses the whole issue by name, though the other steps were fine', async () => {
    const gym = await newGym('untested-draft');
    await insertReference(gym, 'ref-ok', 'Ready Drill');
    await insertReference(gym, 'ref-draft', 'Untested Draft', { draft: true });
    await insertTemplate(gym, ['ref-ok', 'ref-draft']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Not floor-tested by a coach of this gym yet: Untested Draft.',
      drills: [{
        steps: [2],
        drill_id: 'ref-draft',
        name: 'Untested Draft',
        untested_draft: true,
        reason: 'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.',
      }],
    });
    expect(await written(gym)).toEqual(before);
  });

  test("another gym's floor test of the same drill id does not unlock it here", async () => {
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

    await expect(issue(here)).resolves.toMatchObject({ outcome: 'refused', drills: [{ untested_draft: true }] });
    await expect(issue(there)).resolves.toMatchObject({ outcome: 'issued' });
    expect(await written(here)).toMatchObject({ drills: 0, assignments: 0 });
  });

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
      drills: [{ drill_id: 'ref-a', name: 'Retired Drill', untested_draft: false }],
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
    expect(await written(gym)).toEqual({ drills: 0, assignments: 0, audit: 0 });
  });

  test("another gym's template id reads as not_found, and neither gym is written to", async () => {
    const here = await newGym('tenant-here');
    const there = await newGym('tenant-there');
    await insertReference(there, 'ref-a', 'Their Drill');
    await insertTemplate(there, ['ref-a']);

    await expect(issue(here)).resolves.toEqual({ outcome: 'not_found' });

    expect(await written(here)).toEqual({ drills: 0, assignments: 0, audit: 0 });
    expect(await written(there)).toEqual({ drills: 0, assignments: 0, audit: 0 });
  });
});

describe('all or nothing: a failure inside the transaction leaves no part of the issue behind', () => {
  test('a second adoption that collides on a drill name rolls back the first adoption too, and names the drill', async () => {
    const gym = await newGym('name-collision');
    await insertReference(gym, 'ref-first', 'First Drill');
    await insertReference(gym, 'ref-clash', 'Taken Name');
    // A drill the gym wrote itself, already holding the name the second adoption needs.
    await client.query(
      `insert into pilot.drills (organization_id, drill_id, name, category, focus) values ($1, 'own-drill', 'Taken Name', 'bagwork', 'Focus.')`,
      [gym.organizationId],
    );
    await insertTemplate(gym, ['ref-first', 'ref-clash']);
    const before = await written(gym);

    const result = await issue(gym);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Taken Name.',
      drills: [{
        steps: [2],
        drill_id: 'ref-clash',
        name: 'Taken Name',
        untested_draft: false,
        reason: 'This gym already has a drill named "Taken Name", so this one cannot be adopted under that name.',
      }],
    });
    // 'First Drill' was inserted on the transaction before the collision. It is gone with it.
    expect(await written(gym)).toEqual(before);
    const { rows } = await client.query(`select name from pilot.drills where organization_id = $1`, [gym.organizationId]);
    expect(rows).toEqual([{ name: 'Taken Name' }]);
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

    expect(await written(gym)).toEqual({ drills: 0, assignments: 0, audit: 0 });

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

    expect(await written(gym)).toEqual({ drills: 0, assignments: 0, audit: 0 });
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
      expect(await written(gym)).toEqual({ drills: 0, assignments: 0, audit: 0 });

      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }

    expect(await written(gym)).toEqual({ drills: 0, assignments: 0, audit: 0 });
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
