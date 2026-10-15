// Real PostgreSQL-backed test for who reads an athlete's goals (lane L10,
// issue #1527, the coach half of lane N8-05).
//
// Owner ruling 2026-10-12 (OD-2026-10-12-011, "A: Coach and parent
// (Recommended)"): an athlete's goals, their reported progress and "I did it"
// show read-only to the coach and to the parent; the athlete's "why it
// matters" line shows to the coach only. A coach's reach is the whole gym
// (OD-2026-10-11-007), and the organization admin reads as staff (lane L10
// brief). Nobody but the athlete writes.
//
// WHY REAL POSTGRES. goalsAudience.test.ts proves the same rules over a
// stood-in database, where "another gym" is whatever the mock says. Here the
// gym is a real organization_id on a real row, the coach reading is NOT the
// athlete's coach of record (so whole-gym reach is what admits them, not an
// assignment), and every goal is written through the athlete's own routes.
// Only the principal is stood in.
//
// EVERY REFUSAL HAS A CONTROL. The gym-2 staff are refused the same athlete
// gym 1's staff read in full; a staff write is refused on the same goal the
// athlete then updates. A change that broke reads or writes outright would
// otherwise satisfy every refusal in here.
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

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes every query the goal routes, access.ts and guardianAccess.ts make
// into the embedded database. Declared before the imports for jest's hoisting.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

// The routes take their principal from here; the rest of http stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { NextRequest } from 'next/server';

import { GET as personalGET, PATCH as personalPATCH, POST as personalPOST } from '@/app/api/pilot/goals/personal/route';
import { GET as listGET } from '@/app/api/pilot/goals/list/route';
import { POST as getGoalPOST } from '@/app/api/pilot/goals/get/route';
import { POST as goalPOST } from '@/app/api/pilot/goals/route';
import { POST as goalUpdatePOST } from '@/app/api/pilot/goals/update/route';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-goals-staff-reach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const GYM = 'org-goals-reach';
const OTHER_GYM = 'org-goals-reach-other';
/** The athlete's coach of record. Never an actor here. */
const RECORD_COACH = 'acct-goals-record-coach';
/** A coach of the same gym who is NOT this athlete's coach of record. */
const GYM_COACH = 'acct-goals-gym-coach';
const GYM_ADMIN = 'acct-goals-gym-admin';
const OTHER_COACH = 'acct-goals-other-coach';
const OTHER_ADMIN = 'acct-goals-other-admin';
const GUARDIAN = 'acct-goals-guardian';
const PARENT_ID = 'parent-goals-1';
const ATHLETE = 'ATH-GOALS-REACH-1';
const ATHLETE_ACCOUNT = 'acct-goals-athlete';

const OWN_WORDS = 'Go three rounds without dropping my hands';
const WHY = 'My brother quit and I want to show him it can be done';
const SMART_ID = 'goal-smart-reach-1';
const SMART_TITLE = 'Skip rope five rounds';
/** A second own-words goal, never marked reached: the target of the staff
    "I did it" write, so a refused write that slipped through would show. */
const STILL_OPEN_WORDS = 'Keep my guard up when I am tired';
/** ONE athlete_id, TWO children: a live athlete in each gym, each with their
    own goal. pilot.athletes' key is (organization_id, athlete_id), so only the
    gym half of every goal query keeps each gym's staff on its own child. */
const SHARED_ID_ATHLETE = 'ATH-GOALS-SHARED-ID';
const GYM_CHILD_GOAL = 'Gym one child: hold my stance';
const OTHER_GYM_CHILD_GOAL = 'Gym two child: finish every round';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let ownWordsGoalId = '';
let stillOpenGoalId = '';

const mockRequirePrincipal = requirePrincipal as jest.Mock;

function principal(accountId: string, role: string, organizationId = GYM, athleteId: string | null = null): PilotPrincipal {
  return { accountId, role, organizationId, athleteId, sessionToken: `token-${accountId}`, authProvider: 'microsoft' } as PilotPrincipal;
}

const asAthlete = () => principal(ATHLETE_ACCOUNT, 'athlete', GYM, ATHLETE);
const asGymCoach = () => principal(GYM_COACH, 'coach');
const asGymAdmin = () => principal(GYM_ADMIN, 'organization_admin');
const asOtherCoach = () => principal(OTHER_COACH, 'coach', OTHER_GYM);
const asOtherAdmin = () => principal(OTHER_ADMIN, 'organization_admin', OTHER_GYM);
const asGuardian = () => principal(GUARDIAN, 'parent');

function get(pathAndQuery: string): NextRequest {
  return new NextRequest(`http://localhost${pathAndQuery}`);
}

function send(pathname: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readAs(who: PilotPrincipal, athleteId = ATHLETE) {
  mockRequirePrincipal.mockResolvedValue(who);
  const personal = await personalGET(get(`/api/pilot/goals/personal?athlete_id=${athleteId}`));
  const list = await listGET(get(`/api/pilot/goals/list?athlete_id=${athleteId}`));
  return {
    personalStatus: personal.status,
    personalText: await personal.text(),
    listStatus: list.status,
    listText: await list.text(),
  };
}

function smartPayload(progress: number) {
  return {
    goal_id: SMART_ID,
    athlete_id: ATHLETE,
    title: SMART_TITLE,
    target_date: '2026-12-01',
    metric: 'rounds',
    status: 'active',
    category: 'Fitness',
    progress_percent: progress,
    created_at: '2026-10-01T15:00:00.000Z',
    updated_at: '2026-10-01T15:00:00.000Z',
  };
}

async function writeOwnWords(who: PilotPrincipal, athleteId: string, ownWords: string, why: string): Promise<string> {
  mockRequirePrincipal.mockResolvedValue(who);
  const response = await personalPOST(send('/api/pilot/goals/personal', 'POST', {
    athlete_id: athleteId,
    own_words: ownWords,
    why_it_matters: why,
    target_date: '',
  }));
  if (response.status !== 201) throw new Error(`fixture: own-words goal not written (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { goal: { goal_id: string } }).goal.goal_id;
}

async function storedGoals() {
  const result = await activeClient!.query(
    `select goal_id, title, why_it_matters, progress_percent, reached_at
       from pilot.goals where organization_id = $1 and athlete_id = $2 order by goal_id`,
    [GYM, ATHLETE],
  );
  return result.rows;
}

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

/** Two gyms. The athlete, their guardian and gym 1's staff in one; a coach
    and an admin of gym 2 in the other. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [GYM, OTHER_GYM]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  for (const [accountId, role, organizationId] of [
    [RECORD_COACH, 'coach', GYM],
    [GYM_COACH, 'coach', GYM],
    [GYM_ADMIN, 'organization_admin', GYM],
    [GUARDIAN, 'parent', GYM],
    [OTHER_COACH, 'coach', OTHER_GYM],
    [OTHER_ADMIN, 'organization_admin', OTHER_GYM],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Goal Setter', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [GYM, ATHLETE, RECORD_COACH],
  );
  for (const organizationId of [GYM, OTHER_GYM]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Shared Id', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, SHARED_ID_ATHLETE, organizationId === GYM ? RECORD_COACH : OTHER_COACH],
    );
  }
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
     values ($1, $2, $3, 'Guardian Name', 'guardian@example.test')`,
    [GYM, PARENT_ID, GUARDIAN],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother')`,
    [GYM, PARENT_ID, ATHLETE],
  );
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

  activeClient = await freshDatabase('goals_staff_reach');

  // Every goal is written the way the athlete writes it, through their routes.
  ownWordsGoalId = await writeOwnWords(asAthlete(), ATHLETE, OWN_WORDS, WHY);
  stillOpenGoalId = await writeOwnWords(asAthlete(), ATHLETE, STILL_OPEN_WORDS, 'So I do not get caught');
  await writeOwnWords(principal('acct-goals-shared-1', 'athlete', GYM, SHARED_ID_ATHLETE), SHARED_ID_ATHLETE, GYM_CHILD_GOAL, 'one');
  await writeOwnWords(principal('acct-goals-shared-2', 'athlete', OTHER_GYM, SHARED_ID_ATHLETE), SHARED_ID_ATHLETE, OTHER_GYM_CHILD_GOAL, 'two');
  mockRequirePrincipal.mockResolvedValue(asAthlete());
  const smart = await goalPOST(send('/api/pilot/goals', 'POST', smartPayload(40)));
  if (smart.status !== 200) throw new Error(`fixture: SMART goal not written (${smart.status}): ${await smart.text()}`);
});

afterAll(async () => {
  if (activeClient) {
    await activeClient.end().catch(() => undefined);
    activeClient = null;
  }
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
  // Windows can hold the folder a moment after postgres exits (EBUSY); the
  // embedded server's start-up sweep clears anything left behind.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('the gym\'s staff read an athlete\'s goals, progress and the "why it matters" line', () => {
  test.each([
    ['a coach of the gym who is not the athlete\'s coach of record', asGymCoach],
    ['the organization admin of the gym', asGymAdmin],
  ])('%s reads both kinds of goal, the reported progress and the why line', async (_who, as) => {
    const read = await readAs(as());
    expect(read.personalStatus).toBe(200);
    expect(read.listStatus).toBe(200);

    const personal = JSON.parse(read.personalText) as { items: Array<Record<string, unknown>> };
    expect(personal.items.map((goal) => goal.goal_id).sort()).toEqual([ownWordsGoalId, stillOpenGoalId].sort());
    expect(personal.items.find((goal) => goal.goal_id === ownWordsGoalId)).toMatchObject({ title: OWN_WORDS, why_it_matters: WHY });

    const list = JSON.parse(read.listText) as { items: Array<Record<string, unknown>> };
    const smart = list.items.find((row) => row.goal_id === SMART_ID);
    expect(smart).toMatchObject({ title: SMART_TITLE, progress_percent: 40, metric: 'rounds' });
  });

  test('"I did it" reaches the staff once the athlete marks it', async () => {
    mockRequirePrincipal.mockResolvedValue(asAthlete());
    const marked = await personalPATCH(send('/api/pilot/goals/personal', 'PATCH', { athlete_id: ATHLETE, goal_id: ownWordsGoalId }));
    expect(marked.status).toBe(200);

    for (const as of [asGymCoach, asGymAdmin]) {
      const read = await readAs(as());
      const personal = JSON.parse(read.personalText) as { items: Array<Record<string, unknown>> };
      expect(typeof personal.items.find((goal) => goal.goal_id === ownWordsGoalId)?.reached_at).toBe('string');
    }
  });

  test('POST /goals/get sends the gym coach the goal with its why line (the control for its refusals below)', async () => {
    mockRequirePrincipal.mockResolvedValue(asGymCoach());
    const response = await getGoalPOST(send('/api/pilot/goals/get', 'POST', { goal_id: ownWordsGoalId }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(WHY);
  });
});

describe("one athlete id in two gyms: each gym's staff read only their own child", () => {
  test.each([
    ['gym 1 coach', asGymCoach, GYM_CHILD_GOAL, OTHER_GYM_CHILD_GOAL],
    ['gym 1 org admin', asGymAdmin, GYM_CHILD_GOAL, OTHER_GYM_CHILD_GOAL],
    ['gym 2 coach', asOtherCoach, OTHER_GYM_CHILD_GOAL, GYM_CHILD_GOAL],
    ['gym 2 org admin', asOtherAdmin, OTHER_GYM_CHILD_GOAL, GYM_CHILD_GOAL],
  ])('%s', async (_who, as, own, other) => {
    const read = await readAs(as(), SHARED_ID_ATHLETE);
    expect(read.personalStatus).toBe(200);
    expect(read.listStatus).toBe(200);
    expect(read.personalText).toContain(own);
    expect(read.personalText).not.toContain(other);
    expect(read.listText).toContain(own);
    expect(read.listText).not.toContain(other);
  });
});

describe('another gym reads nothing', () => {
  test.each([
    ['a coach of another gym', asOtherCoach],
    ['the organization admin of another gym', asOtherAdmin],
  ])('%s is refused on both reads and is sent none of the goal', async (_who, as) => {
    const read = await readAs(as());
    expect(read.personalStatus).toBe(403);
    expect(read.listStatus).toBe(403);
    for (const text of [read.personalText, read.listText]) {
      expect(text).not.toContain(OWN_WORDS);
      expect(text).not.toContain(WHY);
      expect(text).not.toContain(SMART_TITLE);
    }
  });

  test.each([
    ['a coach of another gym', asOtherCoach],
    ['the organization admin of another gym', asOtherAdmin],
  ])('%s asking POST /goals/get for the goal by its id is sent none of it', async (_who, as) => {
    mockRequirePrincipal.mockResolvedValue(as());
    const response = await getGoalPOST(send('/api/pilot/goals/get', 'POST', { goal_id: ownWordsGoalId }));
    const text = await response.text();
    expect(text).not.toContain(OWN_WORDS);
    expect(text).not.toContain(WHY);
  });
});

describe('the guardian reads the goals without the why line', () => {
  test('their own child\'s goals and progress arrive; the why line is in neither answer', async () => {
    const read = await readAs(asGuardian());
    expect(read.personalStatus).toBe(200);
    expect(read.listStatus).toBe(200);
    expect(read.personalText).toContain(OWN_WORDS);
    expect(read.listText).toContain(SMART_TITLE);
    expect(read.listText).toContain('"progress_percent":40');
    expect(read.personalText).not.toContain(WHY);
    expect(read.listText).not.toContain(WHY);
    expect(read.personalText).not.toContain('why_it_matters');
    expect(read.listText).not.toContain('why_it_matters');
    // "I did it" reaches the family too.
    const personal = JSON.parse(read.personalText) as { items: Array<Record<string, unknown>> };
    expect(typeof personal.items.find((goal) => goal.goal_id === ownWordsGoalId)?.reached_at).toBe('string');
  });

  test('POST /goals/get refuses the guardian and sends no why line', async () => {
    mockRequirePrincipal.mockResolvedValue(asGuardian());
    const response = await getGoalPOST(send('/api/pilot/goals/get', 'POST', { goal_id: ownWordsGoalId }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(WHY);
  });
});

describe('nobody but the athlete writes', () => {
  test.each([
    ['a coach of the gym', asGymCoach],
    ['the organization admin of the gym', asGymAdmin],
    ['the guardian', asGuardian],
  ])('%s is refused on every goal write and nothing changes', async (_who, as) => {
    const before = await storedGoals();
    mockRequirePrincipal.mockResolvedValue(as());

    const responses = [
      await personalPOST(send('/api/pilot/goals/personal', 'POST', { athlete_id: ATHLETE, own_words: 'Written by staff', why_it_matters: 'x' })),
      await personalPATCH(send('/api/pilot/goals/personal', 'PATCH', { athlete_id: ATHLETE, goal_id: stillOpenGoalId })),
      await goalPOST(send('/api/pilot/goals', 'POST', { ...smartPayload(90), goal_id: 'goal-staff-written' })),
      await goalUpdatePOST(send('/api/pilot/goals/update', 'POST', smartPayload(90))),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(await storedGoals()).toEqual(before);
  });

  test('CONTROL: the athlete still reports progress on the same goal', async () => {
    mockRequirePrincipal.mockResolvedValue(asAthlete());
    const response = await goalUpdatePOST(send('/api/pilot/goals/update', 'POST', smartPayload(60)));
    expect(response.status).toBe(200);
    const smart = (await storedGoals()).find((row) => row.goal_id === SMART_ID);
    expect(smart?.progress_percent).toBe(60);
  });
});
