// Two people saving the same intervention record at the same moment, on a
// real database, through the real routes and the real connection pool.
//
// Lane N3-02 (PR #1472, findings R1-5 and R1-6) reported two lost writes it
// could not fix inside its allowlist:
//
//   A close-out that commits while a correction of the same execution is
//   being written was answered 200 and then lost: the correction copied the
//   record before the close and stamped the closed original superseded.
//
//   Evidence linked, or an outcome reviewed, while a correction of the same
//   execution was being written was answered 200 and landed on the superseded
//   version, which no screen lists.
//
// Each test below runs the two requests on two pooled connections. One of them
// is held at a named statement (the gate in the './db' wrapper, which holds a
// request BEFORE a statement and never changes what is sent), the other runs
// until it finishes or until Postgres reports it waiting on a lock, and then
// the first is let go. What is asserted is what the database holds afterwards
// and what each coach was told.
//
// The last block is the slower version of the same loss (lane L2, item two):
// a screen that was loaded before someone else's save, and sends its own save
// minutes later. No lock can see that; the screen hands back the version it
// loaded, and the server refuses a save against any other.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { closePool } from './db';
import { requirePrincipal } from './http';

interface Gate {
  pauseBefore: RegExp;
  reached: () => void;
  resume: Promise<void>;
  used: boolean;
}

/** The gate of the request running in this async context, if it has one. */
const mockGate = new AsyncLocalStorage<Gate>();

// The real module, with one addition: a request that carries a gate waits
// before the first statement its pattern matches. Statements, parameters,
// connections and transactions are the real ones.
jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  const hold = async (text: string): Promise<void> => {
    const gate = mockGate.getStore();
    if (!gate || gate.used || !gate.pauseBefore.test(text)) return;
    gate.used = true;
    gate.reached();
    await gate.resume;
  };
  return {
    ...actual,
    query: async (text: string, params: unknown[] = []) => {
      await hold(text);
      return actual.query(text, params);
    },
    queryOne: async (text: string, params: unknown[] = []) => {
      await hold(text);
      return actual.queryOne(text, params);
    },
    withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
      await hold('begin');
      return actual.withTransaction((client: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => fn({
        query: async (text: string, params?: unknown[]) => {
          await hold(text);
          return client.query(text, params);
        },
      }));
    },
  };
});

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-write-races-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DB_NAME = 'intervention_write_races';

const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_intervention_protocols_migration.sql',
  'pilot_slice_postgres_intervention_executions_migration.sql',
  'pilot_slice_postgres_training_attempts_migration.sql',
  'pilot_slice_postgres_film_study_proposals_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_intervention_evidence_migration.sql',
  // pilot.athletes.deleted_at, which the real athlete-access check reads.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-races';
const COACH_ID = 'acct-races-coach';
const ATHLETE_ID = 'ath-races-1';
const PROTOCOL_ID = 'proto-races';
const ATTEMPT_ID = 'att-races-1';

const EXECUTIONS = '/api/pilot/coach/intervention-executions';
const REVIEW = '/api/pilot/coach/intervention-review';
const PROTOCOLS = '/api/pilot/coach/intervention-protocols';

// The statements a request can be held before. Each exists in the module
// before and after the fix, so the same interleaving is driven on both.
const TRANSACTION_START = /^begin$/;
const CORRECTION_STAMPS_THE_ORIGINAL = /update pilot\.intervention_executions set status = 'superseded'/;
const CORRECTION_RAISES_THE_NEW_VERSION = /update pilot\.intervention_executions set status = \$3/;
const LINK_IS_WRITTEN = /insert into pilot\.intervention_evidence_links/;
const REVIEW_BECOMES_THE_VERDICT = /update pilot\.intervention_outcome_reviews set status = 'active'/;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let executionsRoute: typeof import('@/app/api/pilot/coach/intervention-executions/route');
let reviewRoute: typeof import('@/app/api/pilot/coach/intervention-review/route');
let protocolsRoute: typeof import('@/app/api/pilot/coach/intervention-protocols/route');

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
    }, 170_000);
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
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(DB_NAME) });
  await db.connect();
  for (const file of SCHEMA_FILES) {
    await db.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH_ID, ORG_ID],
  );
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Races Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await db.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
        intervention_description, expected_outcome, created_by_account_id)
     values ($1, $2, $2, 1, 'Round-3 endurance block', 'fades in round 3',
             'aerobic capacity limits round 3 output', 'constrained 3-round intervals',
             'round-3 work rate holds', $3)`,
    [ORG_ID, PROTOCOL_ID, COACH_ID],
  );
  await db.query(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, recorded_by_account_id, context_type,
        metric_kind, direction, achieved_value)
     values ($1, $2, $3, $4, 'session', 'reps', 'at_least', 12)`,
    [ORG_ID, ATTEMPT_ID, ATHLETE_ID, COACH_ID],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  const principal: PilotPrincipal = {
    accountId: COACH_ID,
    role: 'coach',
    organizationId: ORG_ID,
    athleteId: null,
    sessionToken: `token-${COACH_ID}`,
    authProvider: 'microsoft',
  };
  (requirePrincipal as jest.Mock).mockResolvedValue(principal);

  executionsRoute = await import('@/app/api/pilot/coach/intervention-executions/route');
  reviewRoute = await import('@/app/api/pilot/coach/intervention-review/route');
  protocolsRoute = await import('@/app/api/pilot/coach/intervention-protocols/route');
});

afterAll(async () => {
  await closePool();
  await db?.end();
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

/* ---------------------------------------------------------- the requests -- */

interface Answer {
  status: number;
  body: { item?: Record<string, unknown>; error?: string; code?: string };
}

async function answer(response: Promise<Response>): Promise<Answer> {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as Answer['body'] };
}

const send = (method: 'POST' | 'PATCH', pathname: string, body: unknown) =>
  new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function startExecution(): Promise<string> {
  const started = await answer(executionsRoute.POST(send('POST', EXECUTIONS, {
    athlete_id: ATHLETE_ID, protocol_id: PROTOCOL_ID, actual_start: '2026-09-01T22:00:00Z',
  })));
  expect(started.status).toBe(200);
  return started.body.item?.execution_id as string;
}

// The close-out and the correction are sent in the shape their screens send
// them: every field the form shows, the optional ones as empty strings.
type Extra = Record<string, unknown>;

const closeOut = (executionId: string, extra: Extra = {}) => answer(executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
  ...extra,
  action: 'close',
  execution_id: executionId,
  outcome: 'completed',
  adherence: 'delivered_as_planned',
  trained_context: 'live',
  deviations: '',
  stop_change_reason: '',
  notes: 'closing note',
  actual_exposure: { rounds: 5 },
})));

const recordFacts = (executionId: string, notes: string, extra: Extra = {}) => answer(executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
  ...extra, action: 'record', execution_id: executionId, notes,
})));

const correct = (executionId: string, outcome?: 'completed', extra: Extra = {}) => answer(executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
  ...extra,
  action: 'correct',
  execution_id: executionId,
  correction_reason: 'the context was controlled, not unknown',
  ...(outcome ? { outcome } : {}),
  adherence: 'unknown',
  trained_context: 'controlled',
  deviations: '',
  stop_change_reason: '',
  notes: 'corrected note',
  actual_exposure: {},
})));

const linkEvidence = (executionId: string) => answer(reviewRoute.POST(send('POST', REVIEW, {
  action: 'link_evidence',
  execution_id: executionId,
  evidence_role: 'immediate_post',
  source_kind: 'training_attempt',
  source_id: ATTEMPT_ID,
})));

const reviewOutcome = (executionId: string, performanceNotes: string, extra: Extra = {}) => answer(reviewRoute.POST(send('POST', REVIEW, {
  ...extra,
  action: 'review_outcome',
  execution_id: executionId,
  performance_result: 'improved',
  performance_notes: performanceNotes,
  hypothesis_result: 'supported',
  learning_signal: 'prior_belief_strengthened',
})));

/* ------------------------------------------------------ the interleaving -- */

/** Every request this test is holding, so a failed assertion cannot leave one
 * parked on a pooled connection with its transaction open. */
const held: Array<{ release: () => void; result: Promise<unknown> }> = [];

afterEach(async () => {
  const stillHeld = held.splice(0);
  stillHeld.forEach((entry) => entry.release());
  await Promise.allSettled(stillHeld.map((entry) => entry.result));
});

/** Runs a request that waits before the first statement matching `pauseBefore`. */
function heldBefore(pauseBefore: RegExp, request: () => Promise<Answer>) {
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const result = mockGate.run({ pauseBefore, reached, resume, used: false }, request);
  held.push({ release, result });
  const waiting = Promise.race([
    atGate,
    result.then(() => {
      throw new Error(`test bug: the request finished without reaching ${pauseBefore}`);
    }),
  ]);
  return { waiting, release, result };
}

/** Resolves once the request has finished, or Postgres has it waiting on a
 * lock another session holds -- whichever the code under test makes true. */
async function finishedOrWaitingOnALock(request: Promise<unknown>): Promise<'finished' | 'waiting on a lock'> {
  let finished = false;
  const mark = () => { finished = true; };
  request.then(mark, mark);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (finished) return 'finished';
    const waiters = await db.query<{ waiting: number }>(
      'select count(*)::int as waiting from pg_locks where not granted',
    );
    if (waiters.rows[0].waiting > 0) return 'waiting on a lock';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('test bug: the second request neither finished nor waited on a lock');
}

/* -------------------------------------------------------- what is stored -- */

interface VersionRow {
  execution_id: string;
  version: number;
  status: string;
  notes: string;
  trained_context: string;
  actual_exposure: Record<string, number>;
}

/** Every version of the record, oldest first. */
async function versionsOf(executionId: string): Promise<VersionRow[]> {
  const rows = await db.query<VersionRow>(
    `select execution_id, version, status, notes, trained_context, actual_exposure
     from pilot.intervention_executions
     where organization_id = $1 and lineage_id = $2 order by version`,
    [ORG_ID, executionId],
  );
  return rows.rows;
}

interface ChainItem {
  execution: { execution_id: string; version: number; status: string };
  evidence: Array<{ link_id: string; status: string }>;
  review: { review_id: string; performance_notes: string } | null;
}

/** The record as the review screen lists it now: its current version only. */
async function onTheReviewScreen(lineageId: string): Promise<ChainItem> {
  const response = await reviewRoute.GET(new NextRequest(`http://localhost${REVIEW}`));
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as { items: Array<ChainItem & { execution: { lineage_id: string } }> };
  const listed = items.filter((entry) => entry.execution.lineage_id === lineageId);
  expect(listed).toHaveLength(1);
  return listed[0];
}

async function rowCount(table: string, lineageId: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from pilot.${table} t
     join pilot.intervention_executions e
       on e.organization_id = t.organization_id and e.execution_id = t.execution_id
     where e.organization_id = $1 and e.lineage_id = $2`,
    [ORG_ID, lineageId],
  );
  return rows.rows[0].n;
}

/** Audit rows written for writes of one kind on any version of the record. */
async function auditCount(entityType: string, entityIds: string[]): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from pilot.audit_events
     where organization_id = $1 and entity_type = $2 and entity_id = any($3::text[])`,
    [ORG_ID, entityType, entityIds],
  );
  return rows.rows[0].n;
}

/** Audit rows for links or reviews, found by the execution they name -- so a
 * refused write, which has no id of its own, is counted too if it wrote one. */
async function auditCountAbout(entityType: string, lineageId: string): Promise<number> {
  const versionIds = (await versionsOf(lineageId)).map((row) => row.execution_id);
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from pilot.audit_events
     where organization_id = $1 and entity_type = $2 and details->>'execution_id' = any($3::text[])`,
    [ORG_ID, entityType, versionIds],
  );
  return rows.rows[0].n;
}

/** Every column of every version of the record, for "a refused write changed nothing". */
async function everyColumnOf(lineageId: string): Promise<string> {
  const rows = await db.query(
    `select * from pilot.intervention_executions
     where organization_id = $1 and lineage_id = $2 order by version`,
    [ORG_ID, lineageId],
  );
  return JSON.stringify(rows.rows);
}

/** The writes a coach was told were saved that the record does not show. */
function savedButNotOnTheRecord(writes: Array<{ write: string; answer: Answer; onTheRecord: boolean }>): string[] {
  return writes
    .filter((entry) => entry.answer.status === 200 && !entry.onTheRecord)
    .map((entry) => `${entry.write} was answered 200 and is not on the current record`);
}

/** The loser is told, in words a coach can act on, and not with a 404 or 500. */
function expectToldToReload(loser: Answer): void {
  expect(loser.status).toBe(409);
  expect(loser.body.error).toMatch(/changed/i);
  expect(loser.body.error).toMatch(/reload/i);
  expect(loser.body.code).toBe('INTERVENTION_RECORD_CHANGED');
  expect(loser.body.item).toBeUndefined();
}

/* --------------------------------------------- a close-out and a correction -- */

describe('a close-out and a correction of the same execution at the same moment', () => {
  test('a close-out sent while the correction is being written is not lost', async () => {
    const executionId = await startExecution();

    // The correction has copied the record and is about to stamp the original.
    const correction = heldBefore(CORRECTION_STAMPS_THE_ORIGINAL, () => correct(executionId));
    await correction.waiting;
    const closing = closeOut(executionId);
    expect(await finishedOrWaitingOnALock(closing)).toBe('waiting on a lock');
    correction.release();
    const [corrected, closed] = await Promise.all([correction.result, closing]);

    const versions = await versionsOf(executionId);
    const current = versions.filter((row) => row.status !== 'superseded');
    expect(current).toHaveLength(1);
    expect(savedButNotOnTheRecord([
      { write: 'the close-out', answer: closed, onTheRecord: current[0].status === 'completed' },
      { write: 'the correction', answer: corrected, onTheRecord: current[0].notes === 'corrected note' },
    ])).toEqual([]);

    // The correction held the record first, so the close-out is the one told.
    expect(corrected.status).toBe(200);
    expectToldToReload(closed);
    // Nothing of the refused close-out landed on either version.
    expect(versions).toEqual([
      { execution_id: executionId, version: 1, status: 'superseded', notes: '', trained_context: 'unknown', actual_exposure: {} },
      {
        execution_id: corrected.body.item?.execution_id, version: 2, status: 'in_progress',
        notes: 'corrected note', trained_context: 'controlled', actual_exposure: {},
      },
    ]);
    // One write, one audit row: the refused one wrote none.
    expect(await auditCount('intervention_execution', versions.map((row) => row.execution_id))).toBe(2);
  });

  test('a close-out that lands just before the correction starts writing is not lost', async () => {
    const executionId = await startExecution();

    // The correction has read the record as in progress and not yet begun.
    const correction = heldBefore(TRANSACTION_START, () => correct(executionId));
    await correction.waiting;
    const closed = await closeOut(executionId);
    correction.release();
    const corrected = await correction.result;

    const versions = await versionsOf(executionId);
    const current = versions.filter((row) => row.status !== 'superseded');
    expect(current).toHaveLength(1);
    expect(savedButNotOnTheRecord([
      { write: 'the close-out', answer: closed, onTheRecord: current[0].status === 'completed' },
      { write: 'the correction', answer: corrected, onTheRecord: current[0].notes === 'corrected note' },
    ])).toEqual([]);

    // The close-out was saved first, so the correction is the one told.
    expect(closed.status).toBe(200);
    expectToldToReload(corrected);
    // The closed record stands exactly as closed; no second version exists.
    expect(versions).toEqual([{
      execution_id: executionId, version: 1, status: 'completed',
      notes: 'closing note', trained_context: 'live', actual_exposure: { rounds: 5 },
    }]);
    expect(await auditCount('intervention_execution', [executionId])).toBe(2);
  });

  test('a fact recorded just before the correction starts writing is not lost, though the status never changed', async () => {
    const executionId = await startExecution();

    const correction = heldBefore(TRANSACTION_START, () => correct(executionId));
    await correction.waiting;
    const recorded = await recordFacts(executionId, 'a note recorded meanwhile');
    correction.release();
    const corrected = await correction.result;

    expect(recorded.status).toBe(200);
    expectToldToReload(corrected);
    expect((await versionsOf(executionId)).map((row) => [row.version, row.status, row.notes]))
      .toEqual([[1, 'in_progress', 'a note recorded meanwhile']]);
  });

  test('a close-out still being written when the correction reaches the record: the correction waits, then is told', async () => {
    const executionId = await startExecution();

    // A close-out's UPDATE that has run and not yet committed, held open on a
    // second connection so the correction meets the row while it is locked.
    const inFlight = new Client({ connectionString: connectionStringFor(DB_NAME) });
    await inFlight.connect();
    try {
      await inFlight.query('begin');
      await inFlight.query(
        `update pilot.intervention_executions
         set status = 'completed', notes = 'closing note', actual_end = now(), updated_at = now()
         where organization_id = $1 and execution_id = $2 and status = 'in_progress'`,
        [ORG_ID, executionId],
      );
      const correcting = correct(executionId);
      expect(await finishedOrWaitingOnALock(correcting)).toBe('waiting on a lock');
      await inFlight.query('commit');

      expectToldToReload(await correcting);
    } finally {
      await inFlight.end();
    }
    // The close-out stands; the correction left no second version behind.
    expect((await versionsOf(executionId)).map((row) => [row.version, row.status, row.notes]))
      .toEqual([[1, 'completed', 'closing note']]);
  });

  test('two close-outs at once: one is saved, the other is told', async () => {
    const executionId = await startExecution();

    const [first, second] = await Promise.all([closeOut(executionId), closeOut(executionId)]);

    const [winner, loser] = first.status === 200 ? [first, second] : [second, first];
    expect(winner.status).toBe(200);
    expectToldToReload(loser);
    expect(await versionsOf(executionId)).toEqual([{
      execution_id: executionId, version: 1, status: 'completed',
      notes: 'closing note', trained_context: 'live', actual_exposure: { rounds: 5 },
    }]);
    expect(await auditCount('intervention_execution', [executionId])).toBe(2);
  });

  test('two corrections at once: one becomes the record, the other is told', async () => {
    const executionId = await startExecution();

    const first = heldBefore(CORRECTION_RAISES_THE_NEW_VERSION, () => correct(executionId));
    await first.waiting;
    const second = correct(executionId);
    expect(await finishedOrWaitingOnALock(second)).toBe('waiting on a lock');
    first.release();
    const [winner, loser] = await Promise.all([first.result, second]);

    expect(winner.status).toBe(200);
    expectToldToReload(loser);
    const versions = await versionsOf(executionId);
    expect(versions.map((row) => [row.version, row.status])).toEqual([[1, 'superseded'], [2, 'in_progress']]);
    expect(await auditCount('intervention_execution', versions.map((row) => row.execution_id))).toBe(2);
  });
});

/* ------------------------------------------ a screen that is out of date -- */

describe('a write aimed at a version of the record that has already been replaced', () => {
  const NOWHERE = 'no-such-execution';

  test('the executions screen: record, close out and correct are each told, and write nothing', async () => {
    const replacedId = await startExecution();
    const corrected = await correct(replacedId);
    expect(corrected.status).toBe(200);
    const before = await everyColumnOf(replacedId);

    expectToldToReload(await recordFacts(replacedId, 'a late note'));
    expectToldToReload(await closeOut(replacedId));
    expectToldToReload(await correct(replacedId));

    expect(await everyColumnOf(replacedId)).toBe(before);
    // One audit row for the start and one for the correction that stood.
    expect(await auditCount('intervention_execution', [replacedId, String(corrected.body.item?.execution_id)])).toBe(2);
  });

  test('the review screen: a link and a review are each told, and write nothing', async () => {
    const replacedId = await startExecution();
    expect((await closeOut(replacedId)).status).toBe(200);
    expect((await correct(replacedId, 'completed')).status).toBe(200);

    expectToldToReload(await linkEvidence(replacedId));
    expectToldToReload(await reviewOutcome(replacedId, 'a review of the replaced version'));

    expect(await rowCount('intervention_evidence_links', replacedId)).toBe(0);
    expect(await rowCount('intervention_outcome_reviews', replacedId)).toBe(0);
    expect(await auditCountAbout('intervention_evidence_link', replacedId)).toBe(0);
    expect(await auditCountAbout('intervention_outcome_review', replacedId)).toBe(0);
    const screen = await onTheReviewScreen(replacedId);
    expect(screen.evidence).toEqual([]);
    expect(screen.review).toBeNull();
  });

  test('a record that does not exist is still answered Not found, not "changed"', async () => {
    for (const refused of [
      await closeOut(NOWHERE),
      await correct(NOWHERE),
      await linkEvidence(NOWHERE),
      await reviewOutcome(NOWHERE, 'nothing to review'),
    ]) {
      expect(refused).toEqual({ status: 404, body: { error: 'Not found' } });
    }
  });

  test('reviewing work that is still in progress stays Not found: nothing changed, it is not reviewable yet', async () => {
    const executionId = await startExecution();

    expect(await reviewOutcome(executionId, 'too early')).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(0);
  });
});

/* ------------------------------------- evidence, a review, and a correction -- */

describe('evidence or a review written while the same execution is being corrected', () => {
  async function closedExecution(): Promise<string> {
    const executionId = await startExecution();
    expect((await closeOut(executionId)).status).toBe(200);
    return executionId;
  }

  test('evidence linked just after a correction lands is not left on the replaced version', async () => {
    const executionId = await closedExecution();

    // The link has checked the execution and its source and is about to write.
    const linking = heldBefore(LINK_IS_WRITTEN, () => linkEvidence(executionId));
    await linking.waiting;
    const corrected = await correct(executionId, 'completed');
    linking.release();
    const linked = await linking.result;

    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(screen.execution.execution_id).toBe(corrected.body.item?.execution_id);
    expect(savedButNotOnTheRecord([{
      write: 'the evidence link',
      answer: linked,
      onTheRecord: screen.evidence.some((entry) => entry.link_id === linked.body.item?.link_id),
    }])).toEqual([]);

    expectToldToReload(linked);
    expect(await rowCount('intervention_evidence_links', executionId)).toBe(0);
    expect(await auditCountAbout('intervention_evidence_link', executionId)).toBe(0);
  });

  test('evidence linked while the correction is still being written waits for it, and is told', async () => {
    const executionId = await closedExecution();

    // The correction has moved the links it found and has not committed.
    const correction = heldBefore(CORRECTION_RAISES_THE_NEW_VERSION, () => correct(executionId, 'completed'));
    await correction.waiting;
    const linking = linkEvidence(executionId);
    expect(await finishedOrWaitingOnALock(linking)).toBe('waiting on a lock');
    correction.release();
    const [corrected, linked] = await Promise.all([correction.result, linking]);

    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(savedButNotOnTheRecord([{
      write: 'the evidence link',
      answer: linked,
      onTheRecord: screen.evidence.some((entry) => entry.link_id === linked.body.item?.link_id),
    }])).toEqual([]);

    expectToldToReload(linked);
    expect(await rowCount('intervention_evidence_links', executionId)).toBe(0);
    expect(await auditCountAbout('intervention_evidence_link', executionId)).toBe(0);
  });

  test('evidence linked just before the correction starts writing is carried onto the corrected version', async () => {
    const executionId = await closedExecution();

    // The correction has read the record. The link then locks that row and
    // commits -- which must not read to the correction as a changed record.
    const correction = heldBefore(TRANSACTION_START, () => correct(executionId, 'completed'));
    await correction.waiting;
    const linked = await linkEvidence(executionId);
    correction.release();
    const corrected = await correction.result;

    expect(linked.status).toBe(200);
    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(screen.execution.execution_id).toBe(corrected.body.item?.execution_id);
    expect(screen.evidence.map((entry) => [entry.link_id, entry.status])).toEqual([[linked.body.item?.link_id, 'active']]);
    expect(await rowCount('intervention_evidence_links', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_evidence_link', executionId)).toBe(1);
  });

  test('a review written just before the correction starts writing is carried onto the corrected version', async () => {
    const executionId = await closedExecution();

    const correction = heldBefore(TRANSACTION_START, () => correct(executionId, 'completed'));
    await correction.waiting;
    const reviewed = await reviewOutcome(executionId, 'reviewed just before the correction');
    correction.release();
    const corrected = await correction.result;

    expect(reviewed.status).toBe(200);
    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(screen.execution.execution_id).toBe(corrected.body.item?.execution_id);
    expect(screen.review?.review_id).toBe(reviewed.body.item?.review_id);
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_outcome_review', executionId)).toBe(1);
  });

  test('an evidence link removed while a correction is carrying it across: the coach is told, and the link stands', async () => {
    const executionId = await closedExecution();
    const linked = await linkEvidence(executionId);
    expect(linked.status).toBe(200);
    const remove = () => answer(reviewRoute.PATCH(send('PATCH', REVIEW, {
      action: 'remove_evidence', link_id: linked.body.item?.link_id, removed_reason: 'wrong drill',
    })));

    // The correction has moved the link to the new version and not committed.
    const correction = heldBefore(CORRECTION_RAISES_THE_NEW_VERSION, () => correct(executionId, 'completed'));
    await correction.waiting;
    const removing = remove();
    expect(await finishedOrWaitingOnALock(removing)).toBe('waiting on a lock');
    correction.release();
    const [corrected, removed] = await Promise.all([correction.result, removing]);

    expect(corrected.status).toBe(200);
    expectToldToReload(removed);
    expect((await onTheReviewScreen(executionId)).evidence.map((entry) => entry.status)).toEqual(['active']);

    // From the reloaded screen the removal goes through; a second one is told.
    expect((await remove()).status).toBe(200);
    expectToldToReload(await remove());
    expect((await onTheReviewScreen(executionId)).evidence.map((entry) => entry.status)).toEqual(['removed']);
  });

  test('the same evidence linked twice at once: one link is written, the other coach is told', async () => {
    const executionId = await closedExecution();

    const [first, second] = await Promise.all([linkEvidence(executionId), linkEvidence(executionId)]);

    const [winner, loser] = first.status === 200 ? [first, second] : [second, first];
    expect(winner.status).toBe(200);
    expectToldToReload(loser);
    expect(await rowCount('intervention_evidence_links', executionId)).toBe(1);
    // And again later, from a screen that has not reloaded.
    expectToldToReload(await linkEvidence(executionId));
    expect(await rowCount('intervention_evidence_links', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_evidence_link', executionId)).toBe(1);
  });

  test('a re-review sent just after a correction lands does not leave the record without its verdict', async () => {
    const executionId = await closedExecution();
    const standing = await reviewOutcome(executionId, 'the standing verdict');
    expect(standing.status).toBe(200);

    // The re-review has read the execution and the standing verdict.
    const reviewing = heldBefore(TRANSACTION_START, () => reviewOutcome(executionId, 'the re-review'));
    await reviewing.waiting;
    const corrected = await correct(executionId, 'completed');
    reviewing.release();
    const reviewed = await reviewing.result;

    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(savedButNotOnTheRecord([{
      write: 'the standing verdict',
      answer: standing,
      onTheRecord: screen.review !== null,
    }, {
      write: 'the re-review',
      answer: reviewed,
      onTheRecord: screen.review?.review_id === reviewed.body.item?.review_id,
    }])).toEqual([]);

    expectToldToReload(reviewed);
    // The standing verdict moved with the record and is still the verdict.
    expect(screen.review).toMatchObject({ review_id: standing.body.item?.review_id, performance_notes: 'the standing verdict' });
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_outcome_review', executionId)).toBe(1);
  });

  test('a first review sent while the correction is still being written waits for it, and is told', async () => {
    const executionId = await closedExecution();

    const correction = heldBefore(CORRECTION_RAISES_THE_NEW_VERSION, () => correct(executionId, 'completed'));
    await correction.waiting;
    const reviewing = reviewOutcome(executionId, 'a first review');
    expect(await finishedOrWaitingOnALock(reviewing)).toBe('waiting on a lock');
    correction.release();
    const [corrected, reviewed] = await Promise.all([correction.result, reviewing]);

    expect(corrected.status).toBe(200);
    const screen = await onTheReviewScreen(executionId);
    expect(savedButNotOnTheRecord([{
      write: 'the review',
      answer: reviewed,
      onTheRecord: screen.review?.review_id === reviewed.body.item?.review_id,
    }])).toEqual([]);

    expectToldToReload(reviewed);
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(0);
    expect(await auditCountAbout('intervention_outcome_review', executionId)).toBe(0);
  });

  test('two first reviews at once: one verdict stands, the other reviewer is told', async () => {
    const executionId = await closedExecution();

    // The first review is written and about to become the verdict.
    const first = heldBefore(REVIEW_BECOMES_THE_VERDICT, () => reviewOutcome(executionId, 'the first reviewer'));
    await first.waiting;
    const second = reviewOutcome(executionId, 'the second reviewer');
    expect(await finishedOrWaitingOnALock(second)).toBe('waiting on a lock');
    first.release();
    const [firstAnswer, secondAnswer] = await Promise.all([first.result, second]);

    const [winner, loser] = firstAnswer.status === 200 ? [firstAnswer, secondAnswer] : [secondAnswer, firstAnswer];
    expect(winner.status).toBe(200);
    expectToldToReload(loser);
    const screen = await onTheReviewScreen(executionId);
    expect(screen.review?.review_id).toBe(winner.body.item?.review_id);
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_outcome_review', executionId)).toBe(1);
  });
});

/* ------------------------------------- a screen loaded before someone's save -- */

describe('a save from a screen that was loaded before someone else changed the record', () => {
  /** The version of the record a screen loading The Work right now would hold. */
  async function versionOnScreen(executionId: string): Promise<string> {
    const response = await executionsRoute.GET(new NextRequest(`http://localhost${EXECUTIONS}`));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Array<{ execution_id: string; row_version: string }> };
    const version = items.find((item) => item.execution_id === executionId)?.row_version;
    expect(typeof version).toBe('string');
    return version as string;
  }

  test('a correction of work someone has closed out since is told, and the close-out stands', async () => {
    const executionId = await startExecution();
    const loaded = await versionOnScreen(executionId);
    expect((await closeOut(executionId)).status).toBe(200);
    const before = await everyColumnOf(executionId);

    const auditBefore = await auditCount('intervention_execution', [executionId]);

    // Minutes later, from the screen that still shows work in progress.
    expectToldToReload(await correct(executionId, undefined, { expected_row_version: loaded }));

    expect(await everyColumnOf(executionId)).toBe(before);
    expect(await auditCount('intervention_execution', [executionId])).toBe(auditBefore);
    expect((await versionsOf(executionId)).map((row) => [row.version, row.status, row.notes]))
      .toEqual([[1, 'completed', 'closing note']]);
    // Reloaded, the same correction goes through against the record as it stands.
    const reloaded = await versionOnScreen(executionId);
    expect(reloaded).not.toBe(loaded);
    expect((await correct(executionId, 'completed', { expected_row_version: reloaded })).status).toBe(200);
  });

  test('a close-out or a recorded fact from a screen loaded before a fact was added is told, and the fact stands', async () => {
    const executionId = await startExecution();
    const loaded = await versionOnScreen(executionId);
    const added = await recordFacts(executionId, 'added by another coach');
    expect(added.status).toBe(200);
    const before = await everyColumnOf(executionId);

    const auditBefore = await auditCount('intervention_execution', [executionId]);

    expectToldToReload(await closeOut(executionId, { expected_row_version: loaded }));
    expectToldToReload(await recordFacts(executionId, 'from the stale screen', { expected_row_version: loaded }));

    expect(await everyColumnOf(executionId)).toBe(before);
    expect(await auditCount('intervention_execution', [executionId])).toBe(auditBefore);
    // The save's own answer carries the new version, and a save holding it goes through.
    expect(added.body.item?.row_version).toBe(await versionOnScreen(executionId));
    expect((await closeOut(executionId, { expected_row_version: added.body.item?.row_version })).status).toBe(200);
  });

  test('a save naming a version, sent while another save of the record is still being written, waits and is told', async () => {
    const executionId = await startExecution();
    const loaded = await versionOnScreen(executionId);

    // Someone else's save has run and not yet committed, held open on a second
    // connection, so the two saves below meet the row while it is locked.
    const inFlight = new Client({ connectionString: connectionStringFor(DB_NAME) });
    await inFlight.connect();
    try {
      await inFlight.query('begin');
      await inFlight.query(
        `update pilot.intervention_executions set notes = 'saved first', updated_at = now()
         where organization_id = $1 and execution_id = $2`,
        [ORG_ID, executionId],
      );
      const recording = recordFacts(executionId, 'from the stale screen', { expected_row_version: loaded });
      const closing = closeOut(executionId, { expected_row_version: loaded });
      expect(await finishedOrWaitingOnALock(recording)).toBe('waiting on a lock');
      expect(await finishedOrWaitingOnALock(closing)).toBe('waiting on a lock');
      await inFlight.query('commit');

      expectToldToReload(await recording);
      expectToldToReload(await closing);
    } finally {
      await inFlight.end();
    }
    expect((await versionsOf(executionId)).map((row) => [row.version, row.status, row.notes]))
      .toEqual([[1, 'in_progress', 'saved first']]);
  });

  test('evidence linked since does not make the screen out of date: the record itself has not changed', async () => {
    const executionId = await startExecution();
    expect((await closeOut(executionId)).status).toBe(200);
    const loaded = await versionOnScreen(executionId);
    expect((await linkEvidence(executionId)).status).toBe(200);

    expect(await versionOnScreen(executionId)).toBe(loaded);
    expect((await correct(executionId, 'completed', { expected_row_version: loaded })).status).toBe(200);
    expect((await onTheReviewScreen(executionId)).evidence).toHaveLength(1);
  });

  test('a caller that names no version is judged on the record as it stands, as before', async () => {
    const executionId = await startExecution();
    expect((await recordFacts(executionId, 'a first note')).status).toBe(200);

    expect((await recordFacts(executionId, 'a second note')).status).toBe(200);
    expect((await correct(executionId)).status).toBe(200);
  });

  test('a review from a screen that showed no verdict does not replace one recorded since', async () => {
    const executionId = await startExecution();
    expect((await closeOut(executionId)).status).toBe(200);
    const standing = await reviewOutcome(executionId, 'recorded by another coach', { expected_review_id: null });
    expect(standing.status).toBe(200);

    // The second reviewer's screen still says "Not yet reviewed".
    expectToldToReload(await reviewOutcome(executionId, 'from the stale screen', { expected_review_id: null }));

    const screen = await onTheReviewScreen(executionId);
    expect(screen.review).toMatchObject({ review_id: standing.body.item?.review_id, performance_notes: 'recorded by another coach' });
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(1);
    expect(await auditCountAbout('intervention_outcome_review', executionId)).toBe(1);
  });

  test('a re-review names the verdict it replaces: the one on screen goes through, an older one is told', async () => {
    const executionId = await startExecution();
    expect((await closeOut(executionId)).status).toBe(200);
    const first = await reviewOutcome(executionId, 'the first verdict');
    const second = await reviewOutcome(executionId, 'the second verdict', { expected_review_id: first.body.item?.review_id });
    expect(second.status).toBe(200);

    // A screen still showing the first verdict.
    expectToldToReload(await reviewOutcome(executionId, 'from the stale screen', { expected_review_id: first.body.item?.review_id }));

    expect((await onTheReviewScreen(executionId)).review?.review_id).toBe(second.body.item?.review_id);
    expect(await rowCount('intervention_outcome_reviews', executionId)).toBe(2);
    // A caller with no screen replaces whatever stands, as before.
    expect((await reviewOutcome(executionId, 'no version named')).status).toBe(200);
  });

  test('a protocol revised or retired since the screen loaded it: the coach is told, not "Not found"', async () => {
    const content = {
      title: 'Guard recovery', target_problem: 'guard drops when tired', hypothesis: 'it is a habit, not fatigue',
      intervention_description: 'cue on every exit', expected_outcome: 'guard returns unprompted',
      intended_task_context: '', contradicting_evidence: '', alternative_explanations: '', evaluation_plan: '',
      intended_exposure: { rounds: 4 },
    };
    const patchProtocol = (body: Extra) => answer(protocolsRoute.PATCH(send('PATCH', PROTOCOLS, body)));
    const filed = await answer(protocolsRoute.POST(send('POST', PROTOCOLS, { ...content, athlete_id: ATHLETE_ID })));
    expect(filed.status).toBe(200);
    const firstId = filed.body.item?.protocol_id;

    const revised = await patchProtocol({ action: 'revise', protocol_id: firstId, ...content, hypothesis: 'it is fatigue' });
    expect(revised.status).toBe(200);
    // From a screen still showing version 1.
    expectToldToReload(await patchProtocol({ action: 'revise', protocol_id: firstId, ...content, hypothesis: 'a stale revision' }));
    expectToldToReload(await patchProtocol({ action: 'retire', protocol_id: firstId }));

    expect((await patchProtocol({ action: 'retire', protocol_id: revised.body.item?.protocol_id })).status).toBe(200);
    expectToldToReload(await patchProtocol({ action: 'retire', protocol_id: revised.body.item?.protocol_id }));
    expectToldToReload(await patchProtocol({ action: 'revise', protocol_id: revised.body.item?.protocol_id, ...content }));

    const versions = await db.query(
      `select version, status, hypothesis from pilot.intervention_protocols
       where organization_id = $1 and lineage_id = $2 order by version`,
      [ORG_ID, firstId],
    );
    expect(versions.rows).toEqual([
      { version: 1, status: 'superseded', hypothesis: 'it is a habit, not fatigue' },
      { version: 2, status: 'retired', hypothesis: 'it is fatigue' },
    ]);
    // Filed, revised, retired: three audit rows, and none for the four refusals.
    expect(await auditCount('intervention_protocol', [String(firstId), String(revised.body.item?.protocol_id)])).toBe(3);
    // A protocol that does not exist is still Not found.
    expect(await patchProtocol({ action: 'retire', protocol_id: 'no-such-protocol' }))
      .toEqual({ status: 404, body: { error: 'Not found' } });
    expect(await patchProtocol({ action: 'revise', protocol_id: 'no-such-protocol', ...content }))
      .toEqual({ status: 404, body: { error: 'Not found' } });
  });
});
