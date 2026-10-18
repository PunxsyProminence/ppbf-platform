// Real PostgreSQL test for the staff side of family goals (PH-06b): staff read
// every live goal of a child, change only staff goals, and the family sees those
// read-only; through familyGoals.ts, the real athlete gate and the PH-05 guard.
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

// Routes familyGoals.ts's, access.ts's and guardianAccess.ts's queries into whichever embedded database the
// current test opened. Declared before the import so jest's mock
// hoisting sees it.
let activeClient: Client | null = null;
// Runs before each module query, so a test can change the database between a
// check and its write (the race test). Cleared after every test.
let beforeQuery: ((text: string) => Promise<void>) | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await beforeQuery?.(text);
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await beforeQuery?.(text);
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-goals-staff-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');


let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

const ORG_ID = 'org-fgs';
const OTHER_ORG_ID = 'org-fgs-other';
const COACH = 'acct-fgs-coach';
const ADMIN = 'acct-fgs-admin';
const LEGACY_ADMIN = 'acct-fgs-legacy-admin';
const OTHER_COACH = 'acct-fgs-other-coach';
const GUARDIAN_A = 'acct-fgs-guardian-a';
const GUARDIAN_B = 'acct-fgs-guardian-b';
const ATHLETE = 'ATH-FGS-1';
// Only in this gym: another gym's staff are refused it by the gate.
const HERE_ONLY = 'ATH-FGS-HERE';

let goals: typeof import('./familyGoals');
let access: typeof import('./access');

type Actor = { accountId: string; role: 'coach' | 'organization_admin' | 'admin' | 'parent'; organizationId: string; athleteId: null };
const coach: Actor = { accountId: COACH, role: 'coach', organizationId: ORG_ID, athleteId: null };
const admin: Actor = { accountId: ADMIN, role: 'organization_admin', organizationId: ORG_ID, athleteId: null };
const legacyAdmin: Actor = { accountId: LEGACY_ADMIN, role: 'admin', organizationId: ORG_ID, athleteId: null };
const otherCoach: Actor = { accountId: OTHER_COACH, role: 'coach', organizationId: OTHER_ORG_ID, athleteId: null };

async function freshDatabase(name: string): Promise<Client> {
  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${name} with (force)`);
  await adminClient.query(`create database ${name}`);
  await adminClient.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org, login] of [
    [COACH, 'coach', ORG_ID, 'pat.smith@ppbf.test'],
    [ADMIN, 'organization_admin', ORG_ID, 'office@ppbf.test'],
    [LEGACY_ADMIN, 'admin', ORG_ID, 'lee.legacy@ppbf.test'],
    [OTHER_COACH, 'coach', OTHER_ORG_ID, 'sam.jones@other.test'],
    [GUARDIAN_A, 'parent', ORG_ID, 'a@family.test'],
    [GUARDIAN_B, 'parent', ORG_ID, 'b@family.test'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
      [accountId, role, org, login],
    );
    // Authority is an active seat in the gym, as sign-in grants it (PH-05's guard).
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, $3)`,
      [accountId, org, role],
    );
  }
  for (const [org, athleteId] of [
    [ORG_ID, ATHLETE],
    [ORG_ID, HERE_ONLY],
    [OTHER_ORG_ID, ATHLETE],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Goal Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now(), null)`,
      [org, athleteId, COACH],
    );
  }
  for (const [account, parentId] of [
    [GUARDIAN_A, 'P-A'],
    [GUARDIAN_B, 'P-B'],
  ] as const) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'A Guardian')`,
      [ORG_ID, parentId, account],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
      [ORG_ID, parentId, ATHLETE],
    );
  }
  return client;
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

  goals = await import('./familyGoals');
  access = await import('./access');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});


beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_family_goals_staff');
});

afterEach(async () => {
  beforeQuery = null;
  await activeClient?.end();
  activeClient = null;
});


function guardianGoal(account: string, title: string) {
  return goals.createFamilyGoal({
    organizationId: ORG_ID, accountId: account, athleteId: ATHLETE, title, supportAction: 'Arrange transportation.', targetDate: '2026-11-30',
  });
}

function staffGoal(actor: Actor, title: string, athleteId = ATHLETE) {
  return goals.createStaffFamilyGoal({ actor, athleteId, title, supportAction: 'Clear space in the garage.', targetDate: '2026-12-01' });
}

async function stored(goalId: string) {
  const result = await activeClient!.query(
    `select state, title, retired_at is not null as retired, updated_by_account_id, updated_by_role
       from pilot.family_goals where goal_id = $1::uuid`,
    [goalId],
  );
  return result.rows[0];
}

async function wholeRow(goalId: string) {
  const result = await activeClient!.query(`select * from pilot.family_goals where goal_id = $1::uuid`, [goalId]);
  return result.rows[0];
}

describe('family goals for staff (PH-06b)', () => {
  test("staff read every live goal of the child, both guardians' and staff's, with no guardian named and no account id", async () => {
    const fromA = await guardianGoal(GUARDIAN_A, 'Get to the gym twice a week');
    await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: fromA.goal_id, change: { kind: 'done', done: true } });
    await guardianGoal(GUARDIAN_B, 'Pack a water bottle');
    const retired = await guardianGoal(GUARDIAN_B, 'Taken down');
    await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_B, goalId: retired.goal_id, change: { kind: 'retire' } });
    await staffGoal(admin, 'Bring the signed waiver');
    await staffGoal(coach, 'Shadowbox at home');

    for (const reader of [coach, admin]) {
      await access.assertActorCanAccessAthlete(reader, ATHLETE);
      const listed = await goals.listFamilyGoalsForStaff(reader.organizationId, ATHLETE);
      // Newest first; the retired goal is not listed.
      expect(listed.map(({ title, set_by, mine_to_change, state, target_date }) => ({ title, set_by, mine_to_change, state, target_date }))).toEqual([
        { title: 'Shadowbox at home', set_by: 'Coach Pat Smith', mine_to_change: true, state: 'active', target_date: '2026-12-01' },
        { title: 'Bring the signed waiver', set_by: 'Admin Office', mine_to_change: true, state: 'active', target_date: '2026-12-01' },
        { title: 'Pack a water bottle', set_by: 'A guardian', mine_to_change: false, state: 'active', target_date: '2026-11-30' },
        { title: 'Get to the gym twice a week', set_by: 'A guardian', mine_to_change: false, state: 'completed', target_date: '2026-11-30' },
      ]);
      // The done time is the database's, as the guardian ticked it.
      expect(listed[3]!.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(listed[0]!.completed_at).toBeNull();
      expect(JSON.stringify(listed)).not.toMatch(/acct-|@ppbf\.test|@family\.test|P-A|P-B/);
    }
  });

  test("staff cannot edit, tick, untick or retire a guardian's goal", async () => {
    const fromA = await guardianGoal(GUARDIAN_A, 'Get to the gym twice a week');
    for (const actor of [coach, admin]) {
      for (const change of [
        { kind: 'done', done: true },
        { kind: 'done', done: false },
        { kind: 'retire' },
        { kind: 'edit', title: 'x', supportAction: 'y' },
      ] as const) {
        await expect(goals.updateStaffFamilyGoal({ actor, goalId: fromA.goal_id, change })).rejects.toThrow(/^Not found/);
      }
    }
    expect(await stored(fromA.goal_id)).toEqual({
      state: 'active', title: 'Get to the gym twice a week', retired: false, updated_by_account_id: null, updated_by_role: null,
    });
  });

  test('staff create, edit, tick, untick and retire a staff goal, and the family sees it read-only', async () => {
    const created = await staffGoal(coach, 'Shadowbox at home');
    expect(created).toMatchObject({ title: 'Shadowbox at home', state: 'active', completed_at: null, set_by: 'Coach Pat Smith', mine_to_change: true });

    // Any staff member of the gym may change a staff goal; the write names them.
    const ticked = await goals.updateStaffFamilyGoal({ actor: admin, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(ticked?.state).toBe('completed');
    expect(ticked?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await stored(created.goal_id)).toMatchObject({ updated_by_account_id: ADMIN, updated_by_role: 'organization_admin' });

    // The guardian sees the staff goal and its done state, and cannot change it.
    const seen = (await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE)).find((goal) => goal.goal_id === created.goal_id);
    expect(seen).toMatchObject({ state: 'completed', completed_at: ticked?.completed_at, mine: false, set_by: 'Coach Pat Smith' });
    await expect(goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'done', done: false } }))
      .rejects.toThrow(/^Not found/);

    const unticked = await goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'done', done: false } });
    expect(unticked).toMatchObject({ state: 'active', completed_at: null });
    const edited = await goals.updateStaffFamilyGoal({
      actor: coach, goalId: created.goal_id, change: { kind: 'edit', title: 'Shadowbox three rounds', supportAction: 'Time the rounds.', targetDate: null },
    });
    expect(edited).toMatchObject({ title: 'Shadowbox three rounds', support_action: 'Time the rounds.', target_date: null });
    expect(await stored(created.goal_id)).toMatchObject({ updated_by_account_id: COACH, updated_by_role: 'coach' });

    expect(await goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'retire' } })).toBeNull();
    expect(await goals.listFamilyGoalsForStaff(ORG_ID, ATHLETE)).toEqual([]);
    expect(await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE)).toEqual([]);
    // Retired is kept, not deleted, and final.
    expect(await stored(created.goal_id)).toMatchObject({ retired: true });
    await expect(goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'done', done: true } }))
      .rejects.toThrow(/^Not found/);
  });

  test("another gym's staff get nothing", async () => {
    const created = await staffGoal(coach, 'Shadowbox at home');
    const hereOnly = await staffGoal(coach, 'Here only', HERE_ONLY);

    await expect(access.assertActorCanAccessAthlete(otherCoach, HERE_ONLY)).rejects.toThrow(/^Forbidden/);
    // The same athlete id in their own gym has no goals of this gym's.
    expect(await goals.listFamilyGoalsForStaff(OTHER_ORG_ID, ATHLETE)).toEqual([]);
    expect(await goals.listFamilyGoalsForStaff(OTHER_ORG_ID, HERE_ONLY)).toEqual([]);
    for (const change of [{ kind: 'done', done: true }, { kind: 'retire' }, { kind: 'edit', title: 'x', supportAction: 'y' }] as const) {
      await expect(goals.updateStaffFamilyGoal({ actor: otherCoach, goalId: created.goal_id, change })).rejects.toThrow(/^Not found/);
    }
    expect(await stored(created.goal_id)).toMatchObject({ state: 'active', title: 'Shadowbox at home', retired: false });

    // A change finds its goal's athlete and gates it: a deleted athlete's goal is refused even in the same gym.
    await activeClient!.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG_ID, HERE_ONLY]);
    await expect(goals.updateStaffFamilyGoal({ actor: coach, goalId: hereOnly.goal_id, change: { kind: 'done', done: true } }))
      .rejects.toThrow(/^Forbidden/);
    expect(await stored(hereOnly.goal_id)).toMatchObject({ state: 'active' });
  });

  test('a coach whose seat is switched off is refused by the database', async () => {
    const created = await staffGoal(coach, 'Shadowbox at home');
    await activeClient!.query(`update pilot.organization_memberships set active_flag = false where account_id = $1`, [COACH]);

    await expect(staffGoal(coach, 'After the seat ended')).rejects.toMatchObject({ constraint: 'pilot_family_goals_writer_of_this_gym' });
    await expect(goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'done', done: true } }))
      .rejects.toMatchObject({ constraint: 'pilot_family_goals_writer_of_this_gym' });
    expect(await stored(created.goal_id)).toMatchObject({ state: 'active', updated_by_account_id: null });
    const count = await activeClient!.query(`select count(*)::int as n from pilot.family_goals`);
    expect(count.rows[0].n).toBe(1);
  });

  test('a guardian cannot use the staff writes, and blank fields are refused', async () => {
    const guardian: Actor = { accountId: GUARDIAN_A, role: 'parent', organizationId: ORG_ID, athleteId: null };
    await expect(staffGoal(guardian, 'Nope')).rejects.toThrow(/^Forbidden/);
    await expect(goals.createStaffFamilyGoal({ actor: coach, athleteId: ATHLETE, title: ' ', supportAction: 'y' }))
      .rejects.toThrow('Write the goal before saving.');
    await expect(goals.createStaffFamilyGoal({ actor: coach, athleteId: ATHLETE, title: 'x', supportAction: '' }))
      .rejects.toThrow('Write the family support action before saving.');
    await expect(goals.updateStaffFamilyGoal({ actor: coach, goalId: 'not-a-uuid', change: { kind: 'retire' } })).rejects.toThrow(/^Not found/);
    const count = await activeClient!.query(`select count(*)::int as n from pilot.family_goals`);
    expect(count.rows[0].n).toBe(0);
  });

  test('a coach changes a goal an organization admin wrote and one a legacy admin wrote; the family sees both', async () => {
    const fromOffice = await staffGoal(admin, 'Bring the signed waiver');
    // Written straight into the table, so only the staff-role list in the
    // queries decides whether a legacy admin's goal is a staff goal.
    const { rows: [{ goal_id: fromLegacy }] } = await activeClient!.query(
      `insert into pilot.family_goals (organization_id, athlete_id, title, support_action, created_by_account_id, created_by_role)
       values ($1, $2, 'Bring the medical form', 'Sign page two.', $3, 'admin') returning goal_id::text as goal_id`,
      [ORG_ID, ATHLETE, LEGACY_ADMIN],
    );

    for (const goalId of [fromOffice.goal_id, fromLegacy]) {
      const ticked = await goals.updateStaffFamilyGoal({ actor: coach, goalId, change: { kind: 'done', done: true } });
      expect(ticked).toMatchObject({ state: 'completed', mine_to_change: true });
      expect(await stored(goalId)).toMatchObject({ state: 'completed', updated_by_account_id: COACH, updated_by_role: 'coach' });
    }
    expect((await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE)).map(({ title, mine }) => ({ title, mine }))).toEqual([
      { title: 'Bring the medical form', mine: false },
      { title: 'Bring the signed waiver', mine: false },
    ]);
  });

  test('a legacy admin with an active seat creates, ticks and lists a goal, named as staff', async () => {
    const created = await staffGoal(legacyAdmin, 'Bring the medical form');
    expect(created).toMatchObject({ set_by: 'Admin Lee Legacy', mine_to_change: true, state: 'active' });

    const ticked = await goals.updateStaffFamilyGoal({ actor: legacyAdmin, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(ticked?.state).toBe('completed');
    expect(await stored(created.goal_id)).toMatchObject({ updated_by_account_id: LEGACY_ADMIN, updated_by_role: 'admin' });

    await access.assertActorCanAccessAthlete(legacyAdmin, ATHLETE);
    expect((await goals.listFamilyGoalsForStaff(ORG_ID, ATHLETE)).map(({ title, set_by, state }) => ({ title, set_by, state }))).toEqual([
      { title: 'Bring the medical form', set_by: 'Admin Lee Legacy', state: 'completed' },
    ]);
  });

  test('a goal retired between the check and the write is the same 404, and the write changes nothing', async () => {
    const created = await staffGoal(coach, 'Shadowbox at home');
    let retiredRow: unknown = null;
    beforeQuery = async (text) => {
      if (retiredRow || !/^\s*update pilot\.family_goals/.test(text)) return;
      // Another staff member retires it after this change's check has passed.
      await activeClient!.query(
        `update pilot.family_goals set retired_at = now(), updated_by_account_id = $2, updated_by_role = 'organization_admin'
          where goal_id = $1::uuid`,
        [created.goal_id, ADMIN],
      );
      retiredRow = await wholeRow(created.goal_id);
    };

    await expect(goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'done', done: true } }))
      .rejects.toThrow(/^Not found/);
    expect(retiredRow).toMatchObject({ state: 'active', updated_by_account_id: ADMIN });
    expect(await wholeRow(created.goal_id)).toEqual(retiredRow);
  });

  test('staff: ticking twice keeps the first done time; an edit without a date keeps it, one with a date sets it', async () => {
    const created = await staffGoal(coach, 'Shadowbox at home');
    const done = await goals.updateStaffFamilyGoal({ actor: coach, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(done?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await goals.updateStaffFamilyGoal({ actor: admin, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(again?.completed_at).toBe(done?.completed_at);

    const dated = await goals.updateStaffFamilyGoal({
      actor: coach, goalId: created.goal_id, change: { kind: 'edit', title: 'Shadowbox three rounds', supportAction: 'Time the rounds.', targetDate: '2026-12-15' },
    });
    expect(dated).toMatchObject({ title: 'Shadowbox three rounds', target_date: '2026-12-15' });
    const kept = await goals.updateStaffFamilyGoal({
      actor: coach, goalId: created.goal_id, change: { kind: 'edit', title: 'Shadowbox four rounds', supportAction: 'Time the rounds.' },
    });
    expect(kept).toMatchObject({ title: 'Shadowbox four rounds', target_date: '2026-12-15' });
  });
});
