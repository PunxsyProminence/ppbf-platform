// Real PostgreSQL contract test for undoPersonalGoalReached (lane U3 L5b, the
// UXB Q1 B "one tap plus a short Undo line" ruling, on Overwatch's conditions):
//
//   1. it never touches a mark that is not the athlete's own own-words mark
//      (another athlete's goal, a SMART goal);
//   2. it is a reversal, not a delete: the row stays, reached_at goes back to
//      null and status to 'active';
//   3. the server checks the window and the owner, in the statement itself.
//
// Each property is asserted against the real schema, because the SQL is the
// whole guarantee: the route only forwards the athlete it cleared.
//
// Spins up the same disposable, local-only embedded Postgres the other
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

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

import {
  PERSONAL_GOAL_UNDO_WINDOW_MS,
  createPersonalGoal,
  markPersonalGoalReached,
  undoPersonalGoalReached,
} from './achievements';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-goal-undo-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-undo';
const COACH = 'acct-undo-coach';
const ATHLETE = 'ATH-UNDO-1';
const OTHER_ATHLETE = 'ATH-UNDO-2';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let databaseCounter = 0;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(): Promise<Client> {
  databaseCounter += 1;
  const name = `goal_undo_${databaseCounter}`;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  for (const athleteId of [ATHLETE, OTHER_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Undo Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, athleteId, COACH],
    );
  }
  return client;
}

async function ownWordsGoal(athleteId: string): Promise<string> {
  const goal = await createPersonalGoal({ organizationId: ORG, athleteId, ownWords: 'Run a mile without stopping', setByRole: 'athlete' });
  return goal.goal_id;
}

async function row(goalId: string): Promise<{ reached_at: Date | null; status: string } | undefined> {
  const result = await activeClient!.query(
    `select reached_at, status from pilot.goals where organization_id = $1 and goal_id = $2`,
    [ORG, goalId],
  );
  return result.rows[0];
}

async function goalCount(): Promise<number> {
  const result = await activeClient!.query(`select count(*)::int as n from pilot.goals where organization_id = $1`, [ORG]);
  return result.rows[0].n as number;
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
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  activeClient = await freshDatabase();
});

afterAll(async () => {
  await activeClient?.end().catch(() => {});
  activeClient = null;
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

describe('undoPersonalGoalReached on the real schema', () => {
  test('the athlete takes back their own fresh mark: reversed, not deleted, and the mark it reversed is returned', async () => {
    const goalId = await ownWordsGoal(ATHLETE);
    const marked = await markPersonalGoalReached(ORG, goalId, ATHLETE);
    const before = await goalCount();

    const undone = await undoPersonalGoalReached(ORG, goalId, ATHLETE);

    expect(undone?.goal_id).toBe(goalId);
    expect(new Date(undone!.undone_reached_at).toISOString()).toBe(new Date(marked!.reached_at!).toISOString());
    expect(await row(goalId)).toEqual({ reached_at: null, status: 'active' });
    // Condition 2: a reversal, never a delete.
    expect(await goalCount()).toBe(before);
    // And it can be marked again.
    expect((await markPersonalGoalReached(ORG, goalId, ATHLETE))?.reached_at).not.toBeNull();
  });

  test('a mark older than the window stands: the server\'s clock decides, not the button', async () => {
    const goalId = await ownWordsGoal(ATHLETE);
    await markPersonalGoalReached(ORG, goalId, ATHLETE);
    const late = new Date(Date.now() + PERSONAL_GOAL_UNDO_WINDOW_MS + 60_000);

    expect(await undoPersonalGoalReached(ORG, goalId, ATHLETE, late)).toBeNull();
    expect((await row(goalId))?.status).toBe('completed');
    expect((await row(goalId))?.reached_at).not.toBeNull();
  });

  test('just inside the window still counts', async () => {
    const goalId = await ownWordsGoal(ATHLETE);
    await markPersonalGoalReached(ORG, goalId, ATHLETE);
    const almost = new Date(Date.now() + PERSONAL_GOAL_UNDO_WINDOW_MS - 60_000);

    expect((await undoPersonalGoalReached(ORG, goalId, ATHLETE, almost))?.goal_id).toBe(goalId);
  });

  test('another athlete\'s mark is never reached, even by its goal id', async () => {
    const theirs = await ownWordsGoal(OTHER_ATHLETE);
    await markPersonalGoalReached(ORG, theirs, OTHER_ATHLETE);

    expect(await undoPersonalGoalReached(ORG, theirs, ATHLETE)).toBeNull();
    expect((await row(theirs))?.status).toBe('completed');
  });

  test('a SMART goal (which a coach can set and track) is never un-reached here', async () => {
    await activeClient!.query(
      `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status,
         reached_at, created_at, updated_at)
       values ($1, 'goal-smart-1', $2, 'Jab speed', '2099-01-01', '10 in 5s', 'completed', now(), now(), now())`,
      [ORG, ATHLETE],
    );

    expect(await undoPersonalGoalReached(ORG, 'goal-smart-1', ATHLETE)).toBeNull();
    expect((await row('goal-smart-1'))?.status).toBe('completed');
  });

  test('a goal that was never marked has nothing to undo', async () => {
    const goalId = await ownWordsGoal(ATHLETE);
    expect(await undoPersonalGoalReached(ORG, goalId, ATHLETE)).toBeNull();
    expect((await row(goalId))?.status).toBe('active');
  });
});
