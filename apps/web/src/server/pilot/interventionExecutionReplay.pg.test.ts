// Real PostgreSQL proof that one tap of Log intervention logs one intervention (finding F-135,
// lane L55), driven through POST /api/pilot/coach/intervention-executions.
//
// THE FAILURE. The live session screen logs an intervention with one POST. When that POST gets
// no clear answer, the screen reads the ledger back (lane L40, #1707); a read that finds nothing
// tells the coach "not logged, try again". But a write still in flight can commit AFTER that
// read, and the retry then logged the same intervention a second time. The screen now sends one
// request key per tap and the same key on its retry; the server answers a repeated key with the
// execution the first send started.
//
// HOW IT IS DRIVEN. db.ts is wrapped so a request can be held in front of one statement (the
// interventionWriteRaces.pg.test.ts gate). Holding the first send in front of its INSERT is the
// lost answer whose write commits late: the recovery read runs while it is held and finds
// nothing; the write commits when it is released. Spins up the disposable local embedded
// Postgres the other suites use. It never connects to production or staging.

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
  };
});

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-replay-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DB_NAME = 'intervention_replay';

// The interventionWriteRaces.pg.test.ts list, and the request-key migration after the
// executions table it alters.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_intervention_protocols_migration.sql',
  'pilot_slice_postgres_intervention_executions_migration.sql',
  'pilot_slice_postgres_intervention_execution_request_key_migration.sql',
  'pilot_slice_postgres_training_attempts_migration.sql',
  'pilot_slice_postgres_film_study_proposals_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_intervention_evidence_migration.sql',
  // pilot.athletes.deleted_at, which the real athlete-access check reads.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG_ID = 'org-replay';
const COACH_ID = 'acct-replay-coach';
const ATHLETE_ID = 'ath-replay-1';
const OTHER_ATHLETE_ID = 'ath-replay-2';
const PROTOCOL_ID = 'proto-replay';
const OTHER_PROTOCOL_ID = 'proto-replay-other';

const EXECUTIONS = '/api/pilot/coach/intervention-executions';
const START_IS_WRITTEN = /insert into pilot\.intervention_executions/;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let executionsRoute: typeof import('@/app/api/pilot/coach/intervention-executions/route');

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
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Replay Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, COACH_ID],
    );
  }
  for (const protocolId of [PROTOCOL_ID, OTHER_PROTOCOL_ID]) {
    await db.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
          intervention_description, expected_outcome, created_by_account_id)
       values ($1, $2, $2, 1, 'Round-3 endurance block', 'fades in round 3',
               'aerobic capacity limits round 3 output', 'constrained 3-round intervals',
               'round-3 work rate holds', $3)`,
      [ORG_ID, protocolId, COACH_ID],
    );
  }

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

beforeEach(async () => {
  await db.query('delete from pilot.intervention_executions where organization_id = $1', [ORG_ID]);
  await db.query(`delete from pilot.audit_events where organization_id = $1 and entity_type = 'intervention_execution'`, [ORG_ID]);
});

/* ---------------------------------------------------------- the requests -- */

interface Answer {
  status: number;
  body: { item?: Record<string, unknown>; items?: Array<Record<string, unknown>>; replayed?: boolean; error?: string; code?: string };
}

async function answer(response: Promise<Response>): Promise<Answer> {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as Answer['body'] };
}

/** The tap, as the live screen sends it. */
const logTap = (body: Record<string, unknown>) => answer(executionsRoute.POST(new NextRequest(`http://localhost${EXECUTIONS}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ athlete_id: ATHLETE_ID, protocol_id: PROTOCOL_ID, ...body }),
})));

/** The screen's recovery read: this athlete's executions. */
const ledger = () => answer(executionsRoute.GET(new NextRequest(
  `http://localhost${EXECUTIONS}?athlete_id=${ATHLETE_ID}`,
)));

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

async function rowsFor(requestKey: string): Promise<Array<{ execution_id: string }>> {
  const rows = await db.query<{ execution_id: string }>(
    'select execution_id from pilot.intervention_executions where organization_id = $1 and request_key = $2',
    [ORG_ID, requestKey],
  );
  return rows.rows;
}

async function executionCount(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'select count(*)::int as n from pilot.intervention_executions where organization_id = $1',
    [ORG_ID],
  );
  return rows.rows[0].n;
}

async function createAudits(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from pilot.audit_events
     where organization_id = $1 and entity_type = 'intervention_execution' and event_type = 'create'`,
    [ORG_ID],
  );
  return rows.rows[0].n;
}

describe('one tap, one intervention (F-135)', () => {
  test('a write that commits after the recovery read, then a retry with the same key: one row, answered as logged', async () => {
    const key = 'tap-delayed-commit';
    // The first send: its answer is lost, and its write has not committed yet.
    const first = heldBefore(START_IS_WRITTEN, () => logTap({ request_key: key }));
    await first.waiting;

    // The screen's recovery read finds nothing -- the "not logged, try again" moment.
    const recovery = await ledger();
    expect(recovery.status).toBe(200);
    expect(recovery.body.items).toEqual([]);

    // Then the first write commits.
    first.release();
    const firstAnswer = (await first.result) as Answer;
    expect(firstAnswer.status).toBe(200);
    const executionId = firstAnswer.body.item?.execution_id as string;

    // The coach taps again; the screen sends the same key.
    const retry = await logTap({ request_key: key });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.item?.execution_id).toBe(executionId);

    expect(await rowsFor(key)).toEqual([{ execution_id: executionId }]);
    expect(await executionCount()).toBe(1);
    expect(await createAudits()).toBe(1);
  });

  test('two sends of one tap at the same moment: the one that loses the race is answered with the winner', async () => {
    const key = 'tap-race';
    // The first send has looked for its key, found none, and is about to write.
    const first = heldBefore(START_IS_WRITTEN, () => logTap({ request_key: key }));
    await first.waiting;

    // The second send of the same tap runs to the end.
    const second = await logTap({ request_key: key });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBeUndefined();
    const executionId = second.body.item?.execution_id as string;

    // The first one's write is refused by the key's index and answered as the repeat.
    first.release();
    const firstAnswer = (await first.result) as Answer;
    expect(firstAnswer.status).toBe(200);
    expect(firstAnswer.body.replayed).toBe(true);
    expect(firstAnswer.body.item?.execution_id).toBe(executionId);

    expect(await rowsFor(key)).toEqual([{ execution_id: executionId }]);
    expect(await executionCount()).toBe(1);
    expect(await createAudits()).toBe(1);
  });

  test.each([
    ['another athlete', { athlete_id: OTHER_ATHLETE_ID }],
    ['another protocol', { protocol_id: OTHER_PROTOCOL_ID }],
    ['another session', { session_run_id: 'run-replay-other' }],
    ['another decision', { decision_id: '00000000-0000-4000-8000-000000000001' }],
  ])('the same key sent for %s is refused and writes nothing', async (_label, change) => {
    const key = `tap-reused-${_label}`;
    const first = await logTap({ request_key: key });
    expect(first.status).toBe(200);

    const reused = await logTap({ request_key: key, ...change });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('INTERVENTION_EXECUTION_REQUEST_KEY_REUSED');

    expect(await rowsFor(key)).toEqual([{ execution_id: first.body.item?.execution_id }]);
    expect(await executionCount()).toBe(1);
    expect(await createAudits()).toBe(1);
  });

  test('starts sent without a key are each their own execution, as before', async () => {
    const one = await logTap({});
    const two = await logTap({});
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.body.item?.execution_id).not.toBe(two.body.item?.execution_id);
    expect(one.body.replayed).toBeUndefined();
    expect(two.body.replayed).toBeUndefined();
    expect(await executionCount()).toBe(2);
    expect(await createAudits()).toBe(2);
  });

  test('a correction does not carry the key; a retry is answered with the record as it stands now', async () => {
    const key = 'tap-then-corrected';
    const first = await logTap({ request_key: key });
    const executionId = first.body.item?.execution_id as string;

    const corrected = await answer(executionsRoute.PATCH(new NextRequest(`http://localhost${EXECUTIONS}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'correct', execution_id: executionId,
        correction_reason: 'the context was controlled, not unknown', trained_context: 'controlled',
      }),
    })));
    expect(corrected.status).toBe(200);
    expect(corrected.body.item?.execution_id).not.toBe(executionId);

    expect(await rowsFor(key)).toEqual([{ execution_id: executionId }]);
    const before = await executionCount();
    const retry = await logTap({ request_key: key });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.item?.execution_id).toBe(corrected.body.item?.execution_id);
    expect(retry.body.item?.lineage_id).toBe(executionId);
    expect(await executionCount()).toBe(before);
  });
});
