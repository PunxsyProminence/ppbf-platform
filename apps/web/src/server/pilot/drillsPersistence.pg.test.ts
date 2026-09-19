// Real PostgreSQL-backed test for drills.ts and the drill anchor on
// progression.ts.
//
// Three things here cannot be proven by a mocked db:
//
// 1. The SQL runs. listDrills' retired predicate, the partial UPDATE built one
//    field at a time, and the data-modifying CTE that returns a new assignment
//    through the drill join are all statements Postgres either accepts or does
//    not.
//
// 2. DrillNameTakenError actually fires. It keys on SQLSTATE 23505 AND the
//    constraint name pilot_drills_one_name_per_org -- a mock asserts the branch,
//    only the database proves the branch is reachable.
//
// 3. Renaming a drill does not rewrite history. drill_name on an assignment is
//    the drill's name snapshotted the day it was assigned; drill_display_name
//    is the drill as it stands now. The two must diverge after a rename, in the
//    database, not in a fixture.
//
// 4. Since W-D3 (OD-2026-09-18-001) the writer builds every new assignment
//    FROM an active drill in the same gym, in one INSERT ... SELECT. An
//    unknown, cross-org, reference-library or retired drill_id selects nothing,
//    so nothing is written -- only a real database proves that.
//
// Spins up the same disposable, local-only embedded Postgres the other
// PostgreSQL suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drills-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_drills_module';

const ORG_A = 'org-drill-mod-a';
const ORG_B = 'org-drill-mod-b';
const COACH_A = 'acct-drill-mod-coach-a';
const ATHLETE_A = 'ATH-DRILL-MOD-A';
const GAP_A = 'gap-drill-mod-a';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let drills: typeof import('./drills');
let progression: typeof import('./progression');

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
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // pilot.drill_assignments has to exist before the drills migration can put
  // drill_id on it; the `all` loop orders these two the same way.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_progression_migration.sql'), 'utf8'),
  );
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_drills_migration.sql'), 'utf8'),
  );
  // drills.ts now reads and writes pilot.drills.reference_drill_id (promotion,
  // per OD-2026-09-16-001), so the fixture has to carry the rest of that
  // column's dependency chain in the same order the workflow's `all` list runs
  // it: drill-versioning supplies supersedes_drill_id, which the provenance
  // migration's root-scoped partial unique index predicates on;
  // drill-library-v3 supplies pilot.drill_library, which its foreign key
  // targets. Without these three, every statement in this file fails with
  // `column "reference_drill_id" does not exist` -- not a smaller production,
  // a schema nobody runs.
  await migrateClient.query(
    await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_drill_versioning_migration.sql'), 'utf8',
    ),
  );
  await migrateClient.query(
    await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_v3_migration.sql'), 'utf8',
    ),
  );
  await migrateClient.query(
    await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_drill_reference_provenance_migration.sql'), 'utf8',
    ),
  );

  for (const organizationId of [ORG_A, ORG_B]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await migrateClient.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Drills Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_A, ATHLETE_A, COACH_A],
  );
  await migrateClient.query(
    `insert into pilot.progression_gaps
       (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
     values ($1, $2, $3, $4, 'technique', 'Guard drops after the jab.', 'coach_observation')`,
    [GAP_A, ORG_A, ATHLETE_A, COACH_A],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  drills = await import('./drills');
  progression = await import('./progression');
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
});

describe('drills.ts against the real schema', () => {
  test('a created drill reads back through the gym library', async () => {
    const created = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Slip and Lateral Pivot Step',
      category: 'Defense',
      focus: 'Move outside a straight punch while generating counter angles.',
      cues: ['Slip with head off-center', 'Step 45 degrees'],
      difficulty: 'advanced',
    });

    expect(created.drill_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.cues).toEqual(['Slip with head off-center', 'Step 45 degrees']);
    expect(created.active).toBe(true);

    const fetched = await drills.getDrill(ORG_A, created.drill_id);
    expect(fetched?.name).toBe('Slip and Lateral Pivot Step');

    // A drill nobody has written cues for has no cues, not a null to render.
    const bare = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Stance Width Stability',
      category: 'Footwork',
      focus: 'Wide base under movement.',
    });
    expect(bare.cues).toEqual([]);
    expect(bare.difficulty).toBe('intermediate');
  });

  test('the library is one gym only, and a drill_id from another gym is absent', async () => {
    await drills.createDrill({
      organizationId: ORG_B,
      name: 'Slip and Lateral Pivot Step',
      category: 'Defense',
      focus: 'The same name is another gym own drill.',
    });

    const orgB = await drills.listDrills(ORG_B);
    expect(orgB.map((drill) => drill.name)).toEqual(['Slip and Lateral Pivot Step']);

    expect(await drills.getDrill(ORG_A, orgB[0].drill_id)).toBeNull();
    expect(await drills.updateDrill({
      organizationId: ORG_A,
      drillId: orgB[0].drill_id,
      active: false,
    })).toBeNull();

    // The other gym's drill is untouched by the attempt.
    expect((await drills.getDrill(ORG_B, orgB[0].drill_id))?.active).toBe(true);
  });

  // Two concurrent creates each read no existing row and both write, so only
  // the unique index can hold this -- and the module has to recognize what the
  // index throws.
  test('a name the gym already uses is refused as a named outcome', async () => {
    await expect(
      drills.createDrill({
        organizationId: ORG_A,
        name: 'Slip and Lateral Pivot Step',
        category: 'Defense',
        focus: 'A second drill of the same name.',
      }),
    ).rejects.toBeInstanceOf(drills.DrillNameTakenError);

    const taken = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Straight Jab Retraction Snap',
      category: 'Striking',
      focus: 'Quick fist return.',
    });
    await expect(
      drills.updateDrill({
        organizationId: ORG_A,
        drillId: taken.drill_id,
        name: 'Slip and Lateral Pivot Step',
      }),
    ).rejects.toBeInstanceOf(drills.DrillNameTakenError);
  });

  test('an edit writes only the fields it names', async () => {
    const created = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Pivot Out of the Corner',
      category: 'Footwork',
      focus: 'Leave the corner on an angle rather than straight back.',
      cues: ['Pivot on the lead foot'],
    });

    const edited = await drills.updateDrill({
      organizationId: ORG_A,
      drillId: created.drill_id,
      cues: ['Pivot on the lead foot', 'Hands stay up through the turn'],
    });

    expect(edited?.cues).toEqual(['Pivot on the lead foot', 'Hands stay up through the turn']);
    expect(edited?.focus).toBe('Leave the corner on an angle rather than straight back.');
    expect(edited?.name).toBe('Pivot Out of the Corner');
  });

  test('retiring takes a drill out of the library and keeps the record', async () => {
    const created = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Double-End Bag Rhythm',
      category: 'Timing',
      focus: 'Hold rhythm against a moving target.',
    });

    const retired = await drills.updateDrill({
      organizationId: ORG_A,
      drillId: created.drill_id,
      active: false,
    });
    expect(retired?.active).toBe(false);

    const library = await drills.listDrills(ORG_A);
    expect(library.map((drill) => drill.drill_id)).not.toContain(created.drill_id);

    // The coach editing surface still has to be able to find it to restore it.
    const withRetired = await drills.listDrills(ORG_A, { includeRetired: true });
    expect(withRetired.map((drill) => drill.drill_id)).toContain(created.drill_id);

    const restored = await drills.updateDrill({
      organizationId: ORG_A,
      drillId: created.drill_id,
      active: true,
    });
    expect(restored?.active).toBe(true);
    expect((await drills.listDrills(ORG_A)).map((drill) => drill.drill_id)).toContain(created.drill_id);
  });
});

describe('an assignment anchored to a drill', () => {
  // W-D3, OD-2026-09-18-001: every NEW assignment is built from an active
  // operational drill in the gym, and its wording is snapshotted from that
  // drill by the INSERT itself. What the SQL refuses can only be proven here.

  /** Assignment rows in ORG_A, counted directly -- not through the module under test. */
  async function assignmentCount(): Promise<number> {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const result = await client.query<{ n: string }>(
        `select count(*)::text as n from pilot.drill_assignments where organization_id = $1`,
        [ORG_A],
      );
      return Number(result.rows[0].n);
    } finally {
      await client.end();
    }
  }

  test("snapshots the drill's own wording, and a later rename does not rewrite it", async () => {
    const drill = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Jab Retraction Snap',
      category: 'Striking',
      focus: 'Return the fist to the chin on every jab.',
      cues: ['Elbow tucked', 'Snap on contact'],
      difficulty: 'advanced',
    });

    const assignment = await progression.assignDrill({
      organizationId: ORG_A,
      gapId: GAP_A,
      athleteId: ATHLETE_A,
      assignedByAccountId: COACH_A,
      drillId: drill.drill_id,
    });

    expect(assignment.drill_id).toBe(drill.drill_id);
    // The snapshot IS the drill: name and focus, on the day it was assigned.
    expect(assignment.drill_name).toBe('Jab Retraction Snap');
    expect(assignment.drill_description).toBe('Return the fist to the chin on every jab.');
    // No difficulty supplied, so the drill's own.
    expect(assignment.drill_difficulty).toBe('advanced');
    expect(assignment.drill_display_name).toBe('Jab Retraction Snap');
    expect(assignment.drill_display_description).toBe('Return the fist to the chin on every jab.');
    expect(assignment.drill_cues).toEqual(['Elbow tucked', 'Snap on contact']);
    expect(assignment.drill_category).toBe('Striking');

    // Renaming the drill changes what a surface draws now. It must not touch
    // the snapshot, which is the record of what was assigned.
    await drills.updateDrill({
      organizationId: ORG_A,
      drillId: drill.drill_id,
      name: 'Jab Retraction Snap (Revised)',
    });

    const reread = await progression.getDrillAssignmentById(ORG_A, assignment.assignment_id);
    expect(reread?.drill_name).toBe('Jab Retraction Snap');
    expect(reread?.drill_display_name).toBe('Jab Retraction Snap (Revised)');
  });

  test("an explicit difficulty overrides the drill's own", async () => {
    const drill = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Rear Hand Return',
      category: 'Striking',
      focus: 'The cross comes home on the same line it went out.',
      difficulty: 'advanced',
    });

    const assignment = await progression.assignDrill({
      organizationId: ORG_A,
      gapId: GAP_A,
      athleteId: ATHLETE_A,
      assignedByAccountId: COACH_A,
      drillId: drill.drill_id,
      drillDifficulty: 'beginner',
    });

    expect(assignment.drill_difficulty).toBe('beginner');
  });

  // Every assignment written before W-D3 may carry only free text, and all of
  // them must keep reading. The writer can no longer create one, so the row
  // goes in as a raw fixture -- exactly as the historical data sits.
  test('a legacy assignment with no drill anchor still reads back with its own text', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await client.query(
        `insert into pilot.drill_assignments
           (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description)
         values ('asg-legacy-typed', $1, $2, $3, $4, 'Shadow boxing, three rounds', 'Hands high, work the pivot.')`,
        [ORG_A, GAP_A, ATHLETE_A, COACH_A],
      );
    } finally {
      await client.end();
    }

    const legacy = await progression.getDrillAssignmentById(ORG_A, 'asg-legacy-typed');
    expect(legacy?.drill_id).toBeNull();
    expect(legacy?.drill_name).toBe('Shadow boxing, three rounds');
    expect(legacy?.drill_display_name).toBe('Shadow boxing, three rounds');
    expect(legacy?.drill_display_description).toBe('Hands high, work the pivot.');
    // No drill to describe, so a reader renders nothing rather than a shell.
    expect(legacy?.drill_category).toBeNull();
    expect(legacy?.drill_cues).toBeNull();

    const listed = await progression.getAthleteAssignments(ORG_A, ATHLETE_A);
    const found = listed.find((item) => item.assignment_id === 'asg-legacy-typed');
    expect(found?.drill_id).toBeNull();
    expect(found?.drill_display_name).toBe('Shadow boxing, three rounds');
  });

  test('a direct call with no drill_id is refused before anything is written', async () => {
    const before = await assignmentCount();

    await expect(
      progression.assignDrill({
        organizationId: ORG_A,
        gapId: GAP_A,
        athleteId: ATHLETE_A,
        assignedByAccountId: COACH_A,
        drillId: '' as string,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'DRILL_ID_REQUIRED' });

    expect(await assignmentCount()).toBe(before);
  });

  // The composite foreign key is the last boundary; the writer now refuses
  // before reaching it, because it selects the drill from this gym only.
  test('cannot anchor to another organization drill', async () => {
    const [orgBDrill] = await drills.listDrills(ORG_B);
    const before = await assignmentCount();

    await expect(
      progression.assignDrill({
        organizationId: ORG_A,
        gapId: GAP_A,
        athleteId: ATHLETE_A,
        assignedByAccountId: COACH_A,
        drillId: orgBDrill.drill_id,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'DRILL_NOT_ASSIGNABLE' });

    expect(await assignmentCount()).toBe(before);
  });

  test('a reference-library drill_id is not assignable, even in the same gym', async () => {
    // A real pilot.drill_library row in ORG_A. It is the reference corpus, not
    // an operational drill: to be assigned it has to be promoted first.
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await client.query(
        `insert into pilot.drill_library
           (organization_id, drill_id, lineage_id, name, category, target_behavior,
            purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like)
         values ($1, 'drl_wd3_reference', 'lin_wd3_reference', 'Reference Jab', 'Striking', 'Jab returns',
                 'purpose', 'setup', 'execution', 'good', 'bad')`,
        [ORG_A],
      );
    } finally {
      await client.end();
    }
    const before = await assignmentCount();

    await expect(
      progression.assignDrill({
        organizationId: ORG_A,
        gapId: GAP_A,
        athleteId: ATHLETE_A,
        assignedByAccountId: COACH_A,
        drillId: 'drl_wd3_reference',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'DRILL_NOT_ASSIGNABLE' });

    expect(await assignmentCount()).toBe(before);
  });

  test('a retired drill cannot be newly assigned, and what it already anchors keeps reading', async () => {
    const drill = await drills.createDrill({
      organizationId: ORG_A,
      name: 'Catch and Return',
      category: 'Defense',
      focus: 'Catch the jab on the glove and answer with your own.',
    });
    const existing = await progression.assignDrill({
      organizationId: ORG_A,
      gapId: GAP_A,
      athleteId: ATHLETE_A,
      assignedByAccountId: COACH_A,
      drillId: drill.drill_id,
    });
    await drills.updateDrill({ organizationId: ORG_A, drillId: drill.drill_id, active: false });
    const before = await assignmentCount();

    await expect(
      progression.assignDrill({
        organizationId: ORG_A,
        gapId: GAP_A,
        athleteId: ATHLETE_A,
        assignedByAccountId: COACH_A,
        drillId: drill.drill_id,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'DRILL_NOT_ASSIGNABLE' });

    expect(await assignmentCount()).toBe(before);
    const reread = await progression.getDrillAssignmentById(ORG_A, existing.assignment_id);
    expect(reread?.drill_name).toBe('Catch and Return');
  });
});
