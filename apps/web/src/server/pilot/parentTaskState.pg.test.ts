// Real PostgreSQL-backed contract test for parent-support task state.
//
// THE PROPERTY THIS FILE EXISTS FOR is not that a due date can be stored. It
// is that storing one does NOT turn a household errand into verified athlete
// technical work, and that the message bus it hangs off gains nothing.
//
// Both are structural claims about a schema, so both are asserted against
// information_schema and pg_constraint rather than against behaviour:
//
//   1. pilot.parent_task_state carries no verification column, and no
//      migration may add one without failing here. pilot.assignment_completions
//      has verification_status and verified_by_account_id because a coach
//      verifies an athlete's technical work; a guardian bringing gloves is not
//      that, and a coach countersigning a family errand is the masquerade this
//      table exists to avoid.
//
//   2. pilot.coach_observations is untouched. The shared bus already carries
//      four audiences and the note_type reader filters are the safety
//      mechanism; two nullable columns on it would have been the wrong answer.
//      This suite pins its column list so a later "just add due_date to the
//      notes table" fails loudly.
//
// The authorisation half is ordinary and tested as behaviour: only a coach or
// an organization admin may set a due date, only on a parent_message, and a
// guardian may complete only a task on a note about a child they hold.
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

import { readFile } from 'node:fs/promises';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes access.ts's and guardianAccess.ts's queries into whichever embedded
// database the current test opened. Declared before the import so jest's mock
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-task-state-pg-test-${Date.now()}`);
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

  parentTasks = await import('./parentTasks');
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

const ORG_ID = 'org-ptask';
const OTHER_ORG_ID = 'org-ptask-other';
const COACH = 'acct-ptask-coach';
const ADMIN_ACCOUNT = 'acct-ptask-admin';
const GUARDIAN_ACCOUNT = 'acct-ptask-guardian';
const OTHER_GUARDIAN = 'acct-ptask-guardian-b';
const ATHLETE = 'ATH-PTASK-1';
const OTHER_ATHLETE = 'ATH-PTASK-2';

const MESSAGE_NOTE = '11111111-1111-4111-8111-111111111111';
const BARRIER_NOTE = '22222222-2222-4222-8222-222222222222';
const OTHER_CHILD_NOTE = '33333333-3333-4333-8333-333333333333';

let parentTasks: typeof import('./parentTasks');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }

  for (const [accountId, role] of [
    [COACH, 'coach'],
    [ADMIN_ACCOUNT, 'organization_admin'],
    [GUARDIAN_ACCOUNT, 'parent'],
    [OTHER_GUARDIAN, 'parent'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }

  for (const athleteId of [ATHLETE, OTHER_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Task Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH],
    );
  }

  /* Three notes on the shared bus, one of each shape this module has to tell
     apart: a parent message (may carry a task), a guardian-authored barrier
     report (may not -- its audience is staff, not the household), and a
     message about a different child. */
  for (const [noteId, athleteId, noteType, text] of [
    [MESSAGE_NOTE, ATHLETE, 'parent_message', 'Bring gloves on Thursday.'],
    [BARRIER_NOTE, ATHLETE, 'home_barrier', 'No lift to the gym on Thursdays.'],
    [OTHER_CHILD_NOTE, OTHER_ATHLETE, 'parent_message', 'Medical form still outstanding.'],
  ] as const) {
    await client.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, $2::uuid, $3, $4, $5, $6)`,
      [ORG_ID, noteId, athleteId, COACH, noteType, text],
    );
  }

  return client;
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_parent_task_state');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('the shape of the table is the safety property', () => {
  test('carries no verification column, so a family errand cannot be countersigned', async () => {
    const columns = await activeClient!.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'parent_task_state'
          and (column_name like '%verif%' or column_name like '%approv%')`,
    );

    expect(columns.rows.map((row) => row.column_name)).toEqual([]);
  });

  test('holds exactly the eight columns the design allows', async () => {
    const columns = await activeClient!.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'parent_task_state'`,
    );

    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'completed_at',
      'completed_by_account_id',
      'created_at',
      'created_by_account_id',
      'due_date',
      'note_id',
      'organization_id',
      'updated_at',
    ]);
  });

  /* THE BUS IS UNTOUCHED. The whole argument for a companion table is that
     pilot.coach_observations gains nothing -- so if a later change puts
     due_date on the notes table after all, this is where that shows up. */
  test('adds nothing to pilot.coach_observations', async () => {
    const columns = await activeClient!.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'coach_observations'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    for (const forbidden of ['due_date', 'completed_at', 'completed_by_account_id', 'task_status']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('a completion timestamp and a completer move together or not at all', async () => {
    await activeClient!.query(
      `insert into pilot.parent_task_state (organization_id, note_id, created_by_account_id)
       values ($1, $2::uuid, $3)`,
      [ORG_ID, MESSAGE_NOTE, COACH],
    );

    await expect(activeClient!.query(
      `update pilot.parent_task_state set completed_at = now()
        where organization_id = $1 and note_id = $2::uuid`,
      [ORG_ID, MESSAGE_NOTE],
    )).rejects.toThrow(/completion_paired/);
  });

  test('task state dies with the note it hangs off', async () => {
    await activeClient!.query(
      `insert into pilot.parent_task_state (organization_id, note_id, created_by_account_id)
       values ($1, $2::uuid, $3)`,
      [ORG_ID, MESSAGE_NOTE, COACH],
    );

    await activeClient!.query(
      `delete from pilot.coach_observations where organization_id = $1 and note_id = $2::uuid`,
      [ORG_ID, MESSAGE_NOTE],
    );

    const left = await activeClient!.query(
      `select 1 from pilot.parent_task_state where organization_id = $1 and note_id = $2::uuid`,
      [ORG_ID, MESSAGE_NOTE],
    );
    expect(left.rows).toHaveLength(0);
  });
});

/* THE SHIPPED RUNNER'S READINESS ASSERTION, EXERCISED RATHER THAN MERELY
   WRITTEN. #781 recorded this gap: dataRetentionDeletion's runner has no
   readiness assertion at all, and a readiness query nobody drives is a
   readiness query nobody knows works. This imports applyMigrationTransaction
   out of the runner that actually ships and proves both directions. */
describe('the migration runner refuses a database that is not ready', () => {
  test('rejects a database where the table does not exist, and accepts one where it does', async () => {
    const runner = await nativeDynamicImport(
      pathToFileURL(path.resolve(__dirname, '../../../scripts/pilot-apply-parent-task-state-migration.mjs')).href,
    );
    const applyMigrationTransaction = runner.applyMigrationTransaction as
      (client: Client, sql: string) => Promise<void>;

    await activeClient!.query('drop table if exists pilot.parent_task_state');

    // A no-op "migration" leaves the table absent, so readiness must refuse.
    await expect(applyMigrationTransaction(activeClient!, 'select 1'))
      .rejects.toThrow(/PARENT_TASK_STATE_NOT_READY/);

    const sql = await readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_parent_task_state_migration.sql'),
      'utf8',
    );
    await expect(applyMigrationTransaction(activeClient!, sql)).resolves.toBeUndefined();

    // Idempotent: the runner's own `all` loop re-applies every migration.
    await expect(applyMigrationTransaction(activeClient!, sql)).resolves.toBeUndefined();
  });

  test('refuses once a verification column exists, which is the property it guards', async () => {
    const runner = await nativeDynamicImport(
      pathToFileURL(path.resolve(__dirname, '../../../scripts/pilot-apply-parent-task-state-migration.mjs')).href,
    );
    const applyMigrationTransaction = runner.applyMigrationTransaction as
      (client: Client, sql: string) => Promise<void>;

    // Exactly the change the design forbids: a column to countersign a
    // family's errand. The deploy must stop rather than carry it.
    await expect(applyMigrationTransaction(
      activeClient!,
      `alter table pilot.parent_task_state add column if not exists verified_by_account_id text null`,
    )).rejects.toThrow(/PARENT_TASK_STATE_NOT_READY/);
  });
});

describe('who may put a due date on a message', () => {
  test('a coach may', async () => {
    const task = await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID,
      noteId: MESSAGE_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: COACH,
      actorRole: 'coach',
    });

    expect(task.dueDate).toBe('2026-09-10');
    expect(task.completedAt).toBeNull();
  });

  test('an organization admin may', async () => {
    const task = await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID,
      noteId: MESSAGE_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    });

    expect(task.dueDate).toBe('2026-09-10');
  });

  test('a guardian may not, so a task always has a gym-side author', async () => {
    await expect(parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID,
      noteId: MESSAGE_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: GUARDIAN_ACCOUNT,
      actorRole: 'parent',
    })).rejects.toThrow(/Forbidden/);
  });

  /* A barrier report is a guardian writing to staff in confidence. Putting a
     due date on one would make the family's own disclosure into an item on a
     list, addressed back at them. */
  test('only a parent message can carry one, never a barrier report', async () => {
    await expect(parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID,
      noteId: BARRIER_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: COACH,
      actorRole: 'coach',
    })).rejects.toThrow(/only a parent message/);
  });

  /* THE NOTE AND THE ATHLETE MUST BE THE SAME CHILD.

     The route authorises a caller-supplied athlete_id with
     assertActorCanAccessAthlete and then passes a caller-supplied note_id
     here. Those are two different objects, and nothing bound them: a coach
     assigned to child A could put a due date on a parent_message about child
     B, and read B's completed_at back out of the returning clause. The route
     comment claimed the two checks together prevented that. They did not. */
  test('refuses a note about a different child than the one authorised', async () => {
    await expect(parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID,
      noteId: OTHER_CHILD_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: COACH,
      actorRole: 'coach',
    })).rejects.toThrow(/Not found/);

    const untouched = await activeClient!.query(
      `select 1 from pilot.parent_task_state where organization_id = $1 and note_id = $2::uuid`,
      [ORG_ID, OTHER_CHILD_NOTE],
    );
    expect(untouched.rows).toHaveLength(0);
  });

  test('a note in another organization is not found', async () => {
    await expect(parentTasks.setParentTaskDueDate({
      organizationId: OTHER_ORG_ID,
      noteId: MESSAGE_NOTE,
      athleteId: ATHLETE,
      dueDate: '2026-09-10',
      actorAccountId: COACH,
      actorRole: 'coach',
    })).rejects.toThrow(/Not found/);
  });

  test('clearing the date leaves the task rather than deleting the record', async () => {
    await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, athleteId: ATHLETE, dueDate: '2026-09-10',
      actorAccountId: COACH, actorRole: 'coach',
    });

    const cleared = await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, athleteId: ATHLETE, dueDate: null,
      actorAccountId: COACH, actorRole: 'coach',
    });

    expect(cleared.dueDate).toBeNull();
  });
});

describe('who may tick one off', () => {
  beforeEach(async () => {
    await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, athleteId: ATHLETE, dueDate: '2026-09-10',
      actorAccountId: COACH, actorRole: 'coach',
    });
    await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: OTHER_CHILD_NOTE, athleteId: OTHER_ATHLETE, dueDate: '2026-09-11',
      actorAccountId: COACH, actorRole: 'coach',
    });
  });

  test('a guardian may complete a task about their own child', async () => {
    const task = await parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID,
      noteId: MESSAGE_NOTE,
      completed: true,
      actorAccountId: GUARDIAN_ACCOUNT,
      athleteIdsInScope: [ATHLETE],
    });

    expect(task.completedAt).not.toBeNull();
    expect(task.completedByAccountId).toBe(GUARDIAN_ACCOUNT);
  });

  test('and may untick it, because a wrong tick must be undoable', async () => {
    await parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, completed: true,
      actorAccountId: GUARDIAN_ACCOUNT, athleteIdsInScope: [ATHLETE],
    });

    const reopened = await parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, completed: false,
      actorAccountId: GUARDIAN_ACCOUNT, athleteIdsInScope: [ATHLETE],
    });

    expect(reopened.completedAt).toBeNull();
    expect(reopened.completedByAccountId).toBeNull();
  });

  /* THE ONE THAT MATTERS. A guardian holding a note_id for another family's
     child -- guessed, or left over from a link that has since been removed --
     must not be able to act on it. */
  test('a guardian cannot complete a task about a child they do not hold', async () => {
    await expect(parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID,
      noteId: OTHER_CHILD_NOTE,
      completed: true,
      actorAccountId: GUARDIAN_ACCOUNT,
      athleteIdsInScope: [ATHLETE],
    })).rejects.toThrow(/Not found/);

    const untouched = await activeClient!.query<{ completed_at: string | null }>(
      `select completed_at from pilot.parent_task_state
        where organization_id = $1 and note_id = $2::uuid`,
      [ORG_ID, OTHER_CHILD_NOTE],
    );
    expect(untouched.rows[0].completed_at).toBeNull();
  });

  test('an account holding no children at all is refused before any query', async () => {
    await expect(parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, completed: true,
      actorAccountId: OTHER_GUARDIAN, athleteIdsInScope: [],
    })).rejects.toThrow(/Forbidden/);
  });

  test('a task in another organization is not reachable', async () => {
    await expect(parentTasks.setParentTaskCompletion({
      organizationId: OTHER_ORG_ID, noteId: MESSAGE_NOTE, completed: true,
      actorAccountId: GUARDIAN_ACCOUNT, athleteIdsInScope: [ATHLETE],
    })).rejects.toThrow(/Not found/);
  });
});

describe('reading task state back onto messages', () => {
  test('answers nothing for a message with no task', async () => {
    const state = await parentTasks.parentTaskStateForNotes(ORG_ID, [MESSAGE_NOTE]);
    expect(state.size).toBe(0);
  });

  test('asks the database nothing when given no notes', async () => {
    const state = await parentTasks.parentTaskStateForNotes(ORG_ID, []);
    expect(state.size).toBe(0);
  });

  test('returns due and done keyed by note', async () => {
    await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, athleteId: ATHLETE, dueDate: '2026-09-10',
      actorAccountId: COACH, actorRole: 'coach',
    });
    await parentTasks.setParentTaskCompletion({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, completed: true,
      actorAccountId: GUARDIAN_ACCOUNT, athleteIdsInScope: [ATHLETE],
    });

    const state = await parentTasks.parentTaskStateForNotes(ORG_ID, [MESSAGE_NOTE, BARRIER_NOTE]);

    expect(state.get(MESSAGE_NOTE)?.dueDate).toBe('2026-09-10');
    expect(state.get(MESSAGE_NOTE)?.completedAt).not.toBeNull();
    expect(state.has(BARRIER_NOTE)).toBe(false);
  });

  test('does not reach another organization task state', async () => {
    await parentTasks.setParentTaskDueDate({
      organizationId: ORG_ID, noteId: MESSAGE_NOTE, athleteId: ATHLETE, dueDate: '2026-09-10',
      actorAccountId: COACH, actorRole: 'coach',
    });

    const state = await parentTasks.parentTaskStateForNotes(OTHER_ORG_ID, [MESSAGE_NOTE]);
    expect(state.size).toBe(0);
  });
});
