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
//    what the coach typed that day; drill_display_name is the drill as it
//    stands now. The two must diverge after a rename, in the database, not in a
//    fixture.
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
  test('carries the drill for display and the typed text as the record', async () => {
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
      drillName: 'Jab retraction (Tuesday floor)',
      drillDescription: 'Three rounds, focus on the elbow.',
      drillDifficulty: 'advanced',
    });

    expect(assignment.drill_id).toBe(drill.drill_id);
    expect(assignment.drill_name).toBe('Jab retraction (Tuesday floor)');
    expect(assignment.drill_display_name).toBe('Jab Retraction Snap');
    expect(assignment.drill_display_description).toBe('Return the fist to the chin on every jab.');
    expect(assignment.drill_cues).toEqual(['Elbow tucked', 'Snap on contact']);
    expect(assignment.drill_category).toBe('Striking');

    // Renaming the drill changes what a surface draws now. It must not touch
    // what the coach typed on the day, which is the record of what was assigned.
    await drills.updateDrill({
      organizationId: ORG_A,
      drillId: drill.drill_id,
      name: 'Jab Retraction Snap (Revised)',
    });

    const reread = await progression.getDrillAssignmentById(ORG_A, assignment.assignment_id);
    expect(reread?.drill_name).toBe('Jab retraction (Tuesday floor)');
    expect(reread?.drill_display_name).toBe('Jab Retraction Snap (Revised)');
  });

  // Every assignment written before drills had identity carries only free text,
  // and all of them must keep reading.
  test('a typed assignment reads back with no anchor and its own text', async () => {
    const assignment = await progression.assignDrill({
      organizationId: ORG_A,
      gapId: GAP_A,
      athleteId: ATHLETE_A,
      assignedByAccountId: COACH_A,
      drillName: 'Shadow boxing, three rounds',
      drillDescription: 'Hands high, work the pivot.',
      drillDifficulty: 'intermediate',
    });

    expect(assignment.drill_id).toBeNull();
    expect(assignment.drill_display_name).toBe('Shadow boxing, three rounds');
    expect(assignment.drill_display_description).toBe('Hands high, work the pivot.');
    // No drill to describe, so a reader renders nothing rather than a shell.
    expect(assignment.drill_category).toBeNull();
    expect(assignment.drill_cues).toBeNull();

    const listed = await progression.getAthleteAssignments(ORG_A, ATHLETE_A);
    const found = listed.find((item) => item.assignment_id === assignment.assignment_id);
    expect(found?.drill_id).toBeNull();
    expect(found?.drill_display_name).toBe('Shadow boxing, three rounds');
  });

  // The composite foreign key is the boundary; the module must not be able to
  // write across it even when handed another gym's drill_id.
  test('cannot anchor to another organization drill', async () => {
    const [orgBDrill] = await drills.listDrills(ORG_B);

    await expect(
      progression.assignDrill({
        organizationId: ORG_A,
        gapId: GAP_A,
        athleteId: ATHLETE_A,
        assignedByAccountId: COACH_A,
        drillId: orgBDrill.drill_id,
        drillName: 'Borrowed drill',
        drillDescription: 'Should never be written.',
        drillDifficulty: 'intermediate',
      }),
    ).rejects.toThrow(/pilot_drill_assignments_fk_drill|foreign key/);
  });
});
