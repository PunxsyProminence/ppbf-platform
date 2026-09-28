// Real PostgreSQL-backed contract test for A-FIN-06's two NEW writers:
// cancelDrillAssignment's conditional UPDATE/CTE, and the cancelled-status
// check recordCompletion takes under a row lock.
//
// WHY A REAL DATABASE, AND WHY A SUITE OF ITS OWN. A mocked pg client can
// verify statement shape and call order -- progression.test.ts already does,
// and those cases stay. What it cannot do is execute the SQL. Everything the
// owner ruled on lives inside the statement:
//
//   * THE CTE HAS TO RUN. `with a as (update ... returning ...) select
//     <projection> from a left join pilot.drills` either executes against the
//     live schema and returns the shape the assignments list renders, or it
//     does not. Only Postgres can say which. Every returned row below is
//     checked for the joined display fields, and the already-cancelled retry
//     compares the CTE's projection against getDrillAssignmentById's, so the
//     two cannot drift apart unnoticed.
//   * THE STATUS PREDICATE IS THE WHOLE GUARANTEE. `and status in
//     ('assigned', 'in_progress')` is what refuses completed work and what
//     makes a retry write nothing. A mock returns whatever rowCount it was
//     told to; a database returns what the predicate actually matched.
//   * HISTORY SURVIVING IS A FACT ABOUT ROWS. "The completions already logged
//     are kept" is only provable where the rows exist. They are written here
//     by the real recordCompletion, read back with raw SQL, and compared row
//     for row across the cancellation.
//
// XMIN, BECAUSE A READ AND A WRITE AGREEING PROVES NOTHING. Every state check
// below reads the table directly and carries the tuple's `xmin`, which
// Postgres moves on ANY update -- including one that rewrites a column to the
// value it already held. That is how "nothing was written" is proven rather
// than assumed: an UPDATE that matched the row and set status = 'cancelled'
// on already-cancelled work would leave every column identical and still fail
// these assertions.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT DO. No route, no authorization, no
// soft-delete case: the route decides who may act and is proven by its own
// mocked suite, and deleted-athlete access semantics are settled elsewhere and
// out of scope. This is the writers, against rows.
//
// './db' is mocked to route into the embedded server (the coachCards.pg.test.ts
// pattern, withTransaction included), so assignDrill, recordCompletion and
// cancelDrillAssignment below are the actual production functions executing
// their actual SQL.
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

// Routes every query into the one embedded database this suite seeds.
// Declared before the imports so jest's mock hoisting sees it.
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
  // A real BEGIN/COMMIT/ROLLBACK, so recordCompletion's lock-then-insert runs
  // its production transaction shape -- the refusal below has to roll back a
  // real transaction, not return from a stub.
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import {
  assignDrill,
  cancelDrillAssignment,
  getAssignmentCompletions,
  recordCompletion,
  type CancelDrillAssignmentResult,
} from './progression';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assignment-cancellation-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_afin06_assignment_cancellation';

const ORG_ID = 'org-afin06';
const COACH_ID = 'acct-afin06-coach';
const ATHLETE_ID = 'ATH-AFIN06-1';

/* The gym's one drill. Its wording is deliberately unlike the typed-on-the-day
   text assignDrill snapshots FROM it, so the joined display fields below are
   demonstrably coming through the CTE's left join and not from the assignment
   row's own columns. */
const DRILL_ID = 'drill-afin06-guard';
const DRILL_NAME = 'Guard discipline';
const DRILL_FOCUS = 'Three rounds mirror work';
const DRILL_CATEGORY = 'defense';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let seededClient: Client;

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

/**
 * The whole schema, then the gym: one organization, one coach, one athlete,
 * one drill.
 *
 * THE WHOLE SCHEMA, not a hand-picked subset (see scripts/lib/full-schema.mjs).
 * The projection these writers return joins pilot.drills, which arrives with
 * the drills migration, on top of the progression migration -- and picking
 * migrations by hand is how a suite ends up testing a database that has never
 * existed anywhere.
 */
async function seededDatabase(): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
     values ($1, $1 || '@ppbf.test', 'coach', $2, 'microsoft')`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact,
        active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Cancelled Work Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.drills (organization_id, drill_id, name, category, focus, difficulty, active)
     values ($1, $2, $3, $4, $5, 'intermediate', true)`,
    [ORG_ID, DRILL_ID, DRILL_NAME, DRILL_CATEGORY, DRILL_FOCUS],
  );

  return client;
}

/**
 * One open assignment, written by the REAL writer.
 *
 * The dose and the due date are set rather than left null so "only the status
 * changed" is measured against columns that carry something. `key` names the
 * case, so a fixture row is traceable to the test that made it -- every test
 * seeds its own, and none reads another's.
 */
async function seedOpenAssignment(key: string, frequencyPerWeek?: number): Promise<string> {
  const gapId = `gap-afin06-${key}`;
  await seededClient.query(
    `insert into pilot.progression_gaps
       (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
     values ($1, $2, $3, $4, 'technique', 'Drops the right hand', 'coach_observation')`,
    [gapId, ORG_ID, ATHLETE_ID, COACH_ID],
  );
  const assignment = await assignDrill({
    organizationId: ORG_ID,
    gapId,
    athleteId: ATHLETE_ID,
    assignedByAccountId: COACH_ID,
    drillId: DRILL_ID,
    repCount: 30,
    durationMinutes: 15,
    frequencyPerWeek,
    dueDate: '2026-10-01',
  });
  return assignment.assignment_id;
}

/**
 * The assignment row as Postgres holds it, `xmin` included -- read with raw
 * SQL rather than through the module, because a read and a write that agree
 * with each other are exactly the failure mode being guarded against.
 */
async function assignmentRow(assignmentId: string): Promise<Record<string, unknown>> {
  const { rows } = await seededClient.query<Record<string, unknown>>(
    `select a.xmin::text as row_version, a.*
     from pilot.drill_assignments a
     where a.organization_id = $1 and a.assignment_id = $2`,
    [ORG_ID, assignmentId],
  );
  if (!rows[0]) throw new Error(`test bug: ${assignmentId} has no row in ${ORG_ID}`);
  return rows[0];
}

/** Every completion logged against this assignment, same raw reading, in a stable order. */
async function completionRows(assignmentId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await seededClient.query<Record<string, unknown>>(
    `select c.xmin::text as row_version, c.*
     from pilot.assignment_completions c
     where c.organization_id = $1 and c.assignment_id = $2
     order by c.completion_id`,
    [ORG_ID, assignmentId],
  );
  return rows;
}

/** One completion by the real writer, so the work advances the way it does in production. */
async function logCompletion(assignmentId: string, repsCompleted: number, notes: string): Promise<void> {
  await recordCompletion({ organizationId: ORG_ID, assignmentId, athleteId: ATHLETE_ID, repsCompleted, notes });
}

/**
 * cancelDrillAssignment for an assignment that exists.
 *
 * The null return means "no such assignment for this athlete in this gym",
 * which is not one of the properties here and is never the case below -- so it
 * is refused loudly rather than narrowed away with a non-null assertion.
 */
async function cancel(assignmentId: string): Promise<CancelDrillAssignmentResult> {
  const result = await cancelDrillAssignment({
    organizationId: ORG_ID,
    assignmentId,
    athleteId: ATHLETE_ID,
  });
  if (!result) throw new Error(`test bug: ${assignmentId} is not readable in ${ORG_ID}`);
  return result;
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

  seededClient = await seededDatabase();
  activeClient = seededClient;
});

afterAll(async () => {
  activeClient = null;
  await seededClient?.end().catch(() => {});
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('cancelling open work (real database)', () => {
  test('an assigned card cancels: the row says cancelled, and the statement wrote nothing else', async () => {
    const assignmentId = await seedOpenAssignment('cancels');

    // CONTROL: the real writer left it open, so the predicate below is being
    // asked about work that genuinely matches it.
    const before = await assignmentRow(assignmentId);
    expect(before.status).toBe('assigned');

    const result = await cancel(assignmentId);
    expect(result.alreadyCancelled).toBe(false);
    expect(result.assignment.assignment_id).toBe(assignmentId);
    expect(result.assignment.status).toBe('cancelled');
    // The CTE really joined pilot.drills: these three fields exist only on the
    // drill row, so a returning list that never reached the join could not
    // carry them.
    expect(result.assignment.drill_display_name).toBe(DRILL_NAME);
    expect(result.assignment.drill_display_description).toBe(DRILL_FOCUS);
    expect(result.assignment.drill_category).toBe(DRILL_CATEGORY);

    const after = await assignmentRow(assignmentId);
    // The table, not the projection that just claimed it.
    expect(after.status).toBe('cancelled');
    // A write really happened -- without this, "nothing else changed" would
    // also pass on a statement that did nothing at all.
    expect(after.row_version).not.toBe(before.row_version);
    // ...and status was the only column it touched. Putting the two known
    // differences back and comparing whole rows covers every column the table
    // has, including ones added after this test was written.
    expect({ ...after, status: before.status, row_version: before.row_version }).toEqual(before);
  });

  test('work already in progress cancels the same way: the predicate names both open statuses', async () => {
    const assignmentId = await seedOpenAssignment('in-progress', 4);
    await logCompletion(assignmentId, 30, 'First session.');

    // CONTROL: one real completion against a four-per-week cadence moved the
    // work to the SECOND open status, so this case is not the first one again.
    const before = await assignmentRow(assignmentId);
    expect(before.status).toBe('in_progress');
    expect(before.completion_percentage).toBe(25);

    const result = await cancel(assignmentId);
    expect(result.alreadyCancelled).toBe(false);
    expect(result.assignment.status).toBe('cancelled');

    const after = await assignmentRow(assignmentId);
    expect(after.status).toBe('cancelled');
    // The gauge is history too: a quarter of the work was done and the row
    // still says so.
    expect(after.completion_percentage).toBe(25);
    expect({ ...after, status: before.status, row_version: before.row_version }).toEqual(before);
  });
});

describe('history survives the cancellation (real database)', () => {
  test('completions logged before the cancel are all still there afterwards, row for row, untouched', async () => {
    const assignmentId = await seedOpenAssignment('history', 4);
    await logCompletion(assignmentId, 30, 'Felt sharp.');
    await logCompletion(assignmentId, 24, 'Slower, cleaner.');

    const completionsBefore = await completionRows(assignmentId);
    expect(completionsBefore).toHaveLength(2);
    expect(completionsBefore.map((row) => row.notes).sort()).toEqual(['Felt sharp.', 'Slower, cleaner.']);

    await cancel(assignmentId);

    // Every column of both rows, xmin included: the cancel did not rewrite
    // them, not even to the same values.
    expect(await completionRows(assignmentId)).toEqual(completionsBefore);
    // And they are still readable the way the product reads them -- present in
    // the table is not the same as still served.
    const served = await getAssignmentCompletions(ORG_ID, assignmentId);
    expect(served.map((row) => row.notes).sort()).toEqual(['Felt sharp.', 'Slower, cleaner.']);
    expect(served.map((row) => row.verification_status)).toEqual(['pending', 'pending']);
  });

  test('a new completion after the cancel is refused as ASSIGNMENT_CANCELLED, and writes nothing', async () => {
    const assignmentId = await seedOpenAssignment('no-new-logs', 4);
    // One log BEFORE the cancel, so "no new row" is counted against something
    // rather than against an empty table.
    await logCompletion(assignmentId, 30, 'Logged before the cancel.');
    await cancel(assignmentId);

    const assignmentBefore = await assignmentRow(assignmentId);
    const completionsBefore = await completionRows(assignmentId);
    expect(assignmentBefore.status).toBe('cancelled');
    expect(completionsBefore).toHaveLength(1);

    await expect(
      recordCompletion({
        organizationId: ORG_ID,
        assignmentId,
        athleteId: ATHLETE_ID,
        repsCompleted: 12,
        notes: 'Tried to log after the cancel.',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_CANCELLED' });

    // The transaction rolled back whole: no new completion, and the parent row
    // untouched -- xmin says even the gauge was not rewritten.
    expect(await completionRows(assignmentId)).toEqual(completionsBefore);
    expect(await assignmentRow(assignmentId)).toEqual(assignmentBefore);
  });
});

describe('work that cannot be cancelled, and cancelling twice (real database)', () => {
  test('completed work stays completed: the cancel is refused and the row does not move', async () => {
    // A one-per-week cadence, so ONE real completion closes the work at 100%
    // through the production writer -- the status is not hand-written here.
    const assignmentId = await seedOpenAssignment('completed', 1);
    await logCompletion(assignmentId, 30, 'Finished it.');

    const before = await assignmentRow(assignmentId);
    expect(before.status).toBe('completed');
    expect(before.completion_percentage).toBe(100);

    await expect(
      cancelDrillAssignment({ organizationId: ORG_ID, assignmentId, athleteId: ATHLETE_ID }),
    ).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_CLOSED' });

    // Whole row, xmin included. The refusal came from the predicate matching
    // nothing, not from a check that read the row after writing it.
    expect(await assignmentRow(assignmentId)).toEqual(before);
  });

  test('cancelling already-cancelled work is idempotent: the same row comes back and nothing is written', async () => {
    const assignmentId = await seedOpenAssignment('retry');

    const first = await cancel(assignmentId);
    expect(first.alreadyCancelled).toBe(false);
    const afterFirst = await assignmentRow(assignmentId);

    const second = await cancel(assignmentId);
    expect(second.alreadyCancelled).toBe(true);
    // The retry's row comes from getDrillAssignmentById and the first from the
    // CTE. They are the same projection, so they must agree field for field --
    // which is also what keeps the two from drifting apart.
    expect(second.assignment).toEqual(first.assignment);

    // The whole point of the conditional UPDATE: already-cancelled work
    // matches nothing, so nothing is written. An UPDATE with the status
    // predicate removed would set status = 'cancelled' again, leave every
    // column identical, and still move xmin.
    expect(await assignmentRow(assignmentId)).toEqual(afterFirst);
  });
});
