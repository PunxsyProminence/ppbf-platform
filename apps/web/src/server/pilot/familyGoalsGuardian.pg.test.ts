// Real PostgreSQL test for the guardian side of family goals (#1593, PH-06):
// who reads, adds and changes which goal, through familyGoals.ts and the real
// guardian link checks, on the full schema with the PH-05 table.
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

// Routes familyGoals.ts's and guardianAccess.ts's queries into whichever embedded database the
// current test opened. Declared before the import so jest's mock
// hoisting sees it.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-goals-guardian-pg-test-${Date.now()}`);
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

const ORG_ID = 'org-fg';
const OTHER_ORG_ID = 'org-fg-other';
const COACH = 'acct-fg-coach';
const ADMIN = 'acct-fg-admin';
const GUARDIAN_A = 'acct-fg-guardian-a';
const GUARDIAN_B = 'acct-fg-guardian-b';
const GUARDIAN_ADULT = 'acct-fg-guardian-adult';
const GUARDIAN_OTHER = 'acct-fg-guardian-other';
const GUARDIAN_X = 'acct-fg-guardian-x';
const ATHLETE = 'ATH-FG-1';
const OTHER_ATHLETE = 'ATH-FG-2';
const ADULT = 'ATH-FG-ADULT';
const DELETED = 'ATH-FG-GONE';

let goals: typeof import('./familyGoals');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org, login] of [
    [COACH, 'coach', ORG_ID, 'pat.smith@ppbf.test'],
    [ADMIN, 'organization_admin', ORG_ID, 'office@ppbf.test'],
    [GUARDIAN_A, 'parent', ORG_ID, 'a@family.test'],
    [GUARDIAN_B, 'parent', ORG_ID, 'b@family.test'],
    [GUARDIAN_ADULT, 'parent', ORG_ID, 'adult@family.test'],
    [GUARDIAN_OTHER, 'parent', ORG_ID, 'other@family.test'],
    [GUARDIAN_X, 'parent', OTHER_ORG_ID, 'x@family.test'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
      [accountId, role, org, login],
    );
  }
  for (const [org, athleteId, dob, deleted] of [
    [ORG_ID, ATHLETE, '2012-03-04', false],
    [ORG_ID, OTHER_ATHLETE, '2012-03-04', false],
    [ORG_ID, ADULT, '2000-01-01', false],
    [ORG_ID, DELETED, '2012-03-04', true],
    [OTHER_ORG_ID, ATHLETE, '2012-03-04', false],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Goal Athlete', $3, 'fly', 'active', 'contact', true, $4, now(), now(), $5)`,
      [org, athleteId, dob, COACH, deleted ? new Date().toISOString() : null],
    );
  }
  for (const [account, parentId, org, athleteId] of [
    [GUARDIAN_A, 'P-A', ORG_ID, ATHLETE],
    [GUARDIAN_A, 'P-A', ORG_ID, DELETED],
    [GUARDIAN_B, 'P-B', ORG_ID, ATHLETE],
    [GUARDIAN_ADULT, 'P-ADULT', ORG_ID, ADULT],
    [GUARDIAN_OTHER, 'P-OTHER', ORG_ID, OTHER_ATHLETE],
    [GUARDIAN_X, 'P-X', OTHER_ORG_ID, ATHLETE],
  ] as const) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'A Guardian')
       on conflict do nothing`,
      [org, parentId, account],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
      [org, parentId, athleteId],
    );
  }
  // Staff goals for the child, written as staff would be (the staff screen is PH-06b).
  for (const [author, role, title, at] of [
    [COACH, 'coach', 'Shadowbox at home', '2026-10-10T15:00:00Z'],
    [ADMIN, 'organization_admin', 'Bring the signed waiver', '2026-10-09T15:00:00Z'],
  ] as const) {
    await client.query(
      `insert into pilot.family_goals (organization_id, athlete_id, title, support_action, created_by_account_id, created_by_role, created_at)
       values ($1, $2, $3, 'Clear space in the garage.', $4, $5, $6::timestamptz)`,
      [ORG_ID, ATHLETE, title, author, role, at],
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
  activeClient = await freshDatabase('ppbf_test_family_goals_guardian');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

function add(account: string, athleteId = ATHLETE, title = 'Get to the gym twice a week', org = ORG_ID) {
  return goals.createFamilyGoal({
    organizationId: org, accountId: account, athleteId, title, supportAction: 'Arrange transportation Tuesdays and Thursdays.', targetDate: '2026-11-30',
  });
}

describe('family goals for a guardian (#1593, PH-06)', () => {
  test('a guardian adds a goal, reads it back, edits, ticks, unticks and retires it', async () => {
    const created = await add(GUARDIAN_A);
    expect(created).toMatchObject({ title: 'Get to the gym twice a week', target_date: '2026-11-30', state: 'active', completed_at: null, set_by: 'You', mine: true });

    // A fresh read, as after a reload: own goal first (newest), then the staff goals, named.
    const listed = await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE);
    expect(listed.map(({ title, set_by, mine }) => ({ title, set_by, mine }))).toEqual([
      { title: 'Get to the gym twice a week', set_by: 'You', mine: true },
      { title: 'Shadowbox at home', set_by: 'Coach Pat Smith', mine: false },
      { title: 'Bring the signed waiver', set_by: 'Your gym', mine: false },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/acct-|@ppbf\.test|@family\.test/);

    const edited = await goals.updateFamilyGoal({
      organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id,
      change: { kind: 'edit', title: 'Gym three times a week', supportAction: 'Carpool with the Smiths.', targetDate: null },
    });
    expect(edited).toMatchObject({ title: 'Gym three times a week', support_action: 'Carpool with the Smiths.', target_date: null });

    const done = await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(done?.state).toBe('completed');
    expect(done?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Ticking again keeps the first time.
    const again = await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'done', done: true } });
    expect(again?.completed_at).toBe(done?.completed_at);
    const undone = await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'done', done: false } });
    expect(undone).toMatchObject({ state: 'active', completed_at: null });

    await goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'retire' } });
    expect((await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE)).map((goal) => goal.title))
      .toEqual(['Shadowbox at home', 'Bring the signed waiver']);
    const stored = await activeClient!.query('select retired_at is not null as retired, updated_by_account_id from pilot.family_goals where goal_id = $1::uuid', [created.goal_id]);
    expect(stored.rows).toEqual([{ retired: true, updated_by_account_id: GUARDIAN_A }]);
  });

  test("the second guardian of the same child does not see, edit or tick the first guardian's goal", async () => {
    const created = await add(GUARDIAN_A);
    const seenByB = await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_B, ATHLETE);
    expect(seenByB.map((goal) => goal.title)).toEqual(['Shadowbox at home', 'Bring the signed waiver']);
    for (const change of [{ kind: 'done', done: true }, { kind: 'retire' }, { kind: 'edit', title: 'x', supportAction: 'y' }] as const) {
      await expect(goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_B, goalId: created.goal_id, change }))
        .rejects.toThrow(/^Not found/);
    }
    const stored = await activeClient!.query('select state, title, retired_at from pilot.family_goals where goal_id = $1::uuid', [created.goal_id]);
    expect(stored.rows).toEqual([{ state: 'active', title: 'Get to the gym twice a week', retired_at: null }]);
  });

  test('a guardian whose link has ended cannot change a goal they wrote', async () => {
    const created = await add(GUARDIAN_A);
    await activeClient!.query(`delete from pilot.guardian_links where organization_id = $1 and parent_id = 'P-A' and athlete_id = $2`, [ORG_ID, ATHLETE]);
    await expect(goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: created.goal_id, change: { kind: 'done', done: true } }))
      .rejects.toThrow(/^Not found/);
    const stored = await activeClient!.query('select state from pilot.family_goals where goal_id = $1::uuid', [created.goal_id]);
    expect(stored.rows).toEqual([{ state: 'active' }]);
  });

  test('a staff goal is read-only to every guardian', async () => {
    const [staffGoal] = await goals.listFamilyGoalsForGuardian(ORG_ID, GUARDIAN_A, ATHLETE);
    expect(staffGoal?.mine).toBe(false);
    for (const account of [GUARDIAN_A, GUARDIAN_B]) {
      await expect(goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: account, goalId: staffGoal!.goal_id, change: { kind: 'done', done: true } }))
        .rejects.toThrow(/^Not found/);
    }
    const stored = await activeClient!.query(`select count(*)::int as n from pilot.family_goals where state = 'completed'`);
    expect(stored.rows[0].n).toBe(0);
  });

  test('another family, an athlete aged 18 or over, a deleted athlete and another gym get nothing', async () => {
    for (const [account, athleteId, org] of [
      [GUARDIAN_OTHER, ATHLETE, ORG_ID],
      [GUARDIAN_ADULT, ADULT, ORG_ID],
      [GUARDIAN_A, DELETED, ORG_ID],
      [GUARDIAN_X, ATHLETE, ORG_ID],
      [GUARDIAN_A, ATHLETE, OTHER_ORG_ID],
    ] as const) {
      await expect(goals.listFamilyGoalsForGuardian(org, account, athleteId)).rejects.toThrow(/^Not found/);
      await expect(add(account, athleteId, 'Nope', org)).rejects.toThrow(/^Not found/);
    }
    // The other gym's guardian of a same-id child reads only their gym's (none).
    expect(await goals.listFamilyGoalsForGuardian(OTHER_ORG_ID, GUARDIAN_X, ATHLETE)).toEqual([]);
    const count = await activeClient!.query(`select count(*)::int as n from pilot.family_goals where created_by_role = 'parent'`);
    expect(count.rows[0].n).toBe(0);
  });

  test('a blank goal, a blank support action and a bad date are refused with a reason', async () => {
    await expect(goals.createFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, athleteId: ATHLETE, title: '  ', supportAction: 'x' }))
      .rejects.toThrow('Write the goal before saving.');
    await expect(goals.createFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, athleteId: ATHLETE, title: 'x', supportAction: '' }))
      .rejects.toThrow('Write the family support action before saving.');
    await expect(goals.createFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, athleteId: ATHLETE, title: 'x', supportAction: 'y', targetDate: '30/11/2026' }))
      .rejects.toThrow('The target date must be a date (YYYY-MM-DD).');
    await expect(goals.updateFamilyGoal({ organizationId: ORG_ID, accountId: GUARDIAN_A, goalId: 'not-a-uuid', change: { kind: 'retire' } }))
      .rejects.toThrow(/^Not found/);
  });
});
