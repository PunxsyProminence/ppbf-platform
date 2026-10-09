/**
 * A disputed completion does not count toward its assignment until it is
 * resolved (owner ruling 2026-10-05), against real PostgreSQL.
 *
 * The real recordCompletion and verifyCompletion run their real SQL and
 * transactions on a disposable embedded database. The assignment's
 * percentage and status are read back with raw SQL.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

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
  recordCompletion,
  verifyCompletion,
} from './progression';

jest.setTimeout(180_000);

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-progression-dispute-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_progression_dispute';

const ORG_ID = 'org-dispute';
const COACH_ID = 'acct-dispute-coach';
const ATHLETE_ID = 'ATH-DISPUTE-1';

/* The gym's one drill; assignDrill requires an active operational drill. */
const DRILL_ID = 'drill-dispute-guard';
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
     values ($1, $2, 'Dispute Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.drills (organization_id, drill_id, name, category, focus, difficulty, active, cues)
     values ($1, $2, $3, $4, $5, 'intermediate', true, '{"Fixture cue"}')`,
    [ORG_ID, DRILL_ID, DRILL_NAME, DRILL_CATEGORY, DRILL_FOCUS],
  );

  return client;
}

/**
 * One open assignment, written by the REAL writer.
 *
 * `key` names the case, so a fixture row is traceable to the test that made
 * it -- every test seeds its own, and none reads another's.
 */
async function seedOpenAssignment(key: string, frequencyPerWeek?: number): Promise<string> {
  const gapId = `gap-dispute-${key}`;
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

async function progress(assignmentId: string): Promise<{ completion_percentage: number; status: string }> {
  const { rows } = await seededClient.query<{ completion_percentage: number; status: string }>(
    `select completion_percentage, status from pilot.drill_assignments
     where organization_id = $1 and assignment_id = $2`,
    [ORG_ID, assignmentId],
  );
  return rows[0];
}

async function logCompletion(assignmentId: string): Promise<string> {
  const completion = await recordCompletion({ organizationId: ORG_ID, assignmentId, athleteId: ATHLETE_ID });
  return completion.completion_id;
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

describe('disputed completions (real database)', () => {
  test('CONTROL: one pending log on a once-a-week card completes it', async () => {
    const assignmentId = await seedOpenAssignment('control', 1);
    await logCompletion(assignmentId);

    expect(await progress(assignmentId)).toEqual({ completion_percentage: 100, status: 'completed' });
  });

  test('disputing the only log takes it off the work: completed reopens as assigned at 0%', async () => {
    const assignmentId = await seedOpenAssignment('dispute-only', 1);
    const completionId = await logCompletion(assignmentId);

    const disputed = await verifyCompletion(completionId, COACH_ID, false, ORG_ID);

    expect(disputed?.verification_status).toBe('disputed');
    expect(await progress(assignmentId)).toEqual({ completion_percentage: 0, status: 'assigned' });
  });

  test('a disputed log does not count toward later logs either', async () => {
    const assignmentId = await seedOpenAssignment('dispute-then-log', 2);
    const first = await logCompletion(assignmentId);
    await verifyCompletion(first, COACH_ID, false, ORG_ID);

    // A second, undisputed log is one of two sessions, not the second of two.
    await logCompletion(assignmentId);
    expect(await progress(assignmentId)).toEqual({ completion_percentage: 50, status: 'in_progress' });
  });

  test('resolving the dispute by verifying the log counts it again', async () => {
    const assignmentId = await seedOpenAssignment('dispute-resolved', 1);
    const completionId = await logCompletion(assignmentId);
    await verifyCompletion(completionId, COACH_ID, false, ORG_ID);

    const verified = await verifyCompletion(completionId, COACH_ID, true, ORG_ID);

    expect(verified?.verification_status).toBe('verified');
    expect(await progress(assignmentId)).toEqual({ completion_percentage: 100, status: 'completed' });
  });
});
