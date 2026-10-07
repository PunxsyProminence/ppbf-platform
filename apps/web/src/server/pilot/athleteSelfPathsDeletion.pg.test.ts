// Real PostgreSQL-backed test: a deleted athlete's own session reaches none of
// their records through the athlete-self routes that read only the session's
// athlete id.
//
// WHY THIS SUITE EXISTS. #1153 made assertActorCanAccessAthlete's athlete arm
// read the live row (OD-2026-09-29-002 item 10, "10 C": a deleted athlete's
// own surviving session is refused). The athlete-self deletion lane closed the
// scheduler and the Shadow reads; its reviewer found these, which check the
// session's own id themselves and never reach that guard:
//   - athletes/list GET (the athlete's whole row: dob, emergency contact);
//   - floor-plans GET and PATCH (ticking a task off is a write);
//   - athlete/check-in GET and POST (POST writes a check-in and a weigh-in);
//   - athlete/check-in/body-mass GET;
//   - video/list GET;
//   - training-holds GET;
//   - coach/one-percent-club nominate, by an athlete (a write), and of a
//     deleted athlete by a live one.
// Each admitted a deleted athlete on the id alone.
//
// WHY REAL POSTGRES. The fix is "read pilot.athletes.deleted_at"; a mocked db
// cannot tell a query that reads the mark from one that does not.
//
// EVERY REFUSAL HAS A LIVE-ATHLETE CONTROL through the same call, so a change
// that broke the athlete role outright cannot pass this file. Every record
// the deleted athlete is refused is written BEFORE the deletion, through the
// route where there is one, so "refused" is never "there was nothing there".
//
// The deletion is exactly what deleteAthleteRecord writes to pilot.athletes
// (deleted_at) and nothing else, so the property pinned is "the mark alone
// closes these paths". Session revocation is the other lock and is not
// exercised here: the principal is handed to the route directly.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes every pilot query into the embedded database. Declared before the
// imports so jest's mock hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows;
    }),
    queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows[0] ?? null;
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
  };
});

// The routes take their principal from here; the rest of the module stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { GET as athletesListGET } from '@/app/api/pilot/athletes/list/route';
import { GET as bodyMassGET } from '@/app/api/pilot/athlete/check-in/body-mass/route';
import { GET as checkInGET, POST as checkInPOST } from '@/app/api/pilot/athlete/check-in/route';
import { POST as onePercentPOST } from '@/app/api/pilot/coach/one-percent-club/route';
import { GET as floorPlansGET, PATCH as floorPlansPATCH, POST as floorPlansPOST } from '@/app/api/pilot/floor-plans/route';
import { GET as trainingHoldsGET, POST as trainingHoldsPOST } from '@/app/api/pilot/training-holds/route';
import { GET as videoListGET } from '@/app/api/pilot/video/list/route';

import { checkIn } from './athleteCheckIns';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { resolveActorDisplayName } from './onePercentClub';
import { getSubjectIdentity } from './profileDb';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-self-paths-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-asp';
const COACH = 'acct-coach-asp';
/** Soft-deleted after their records are written. */
const DELETED_ATHLETE = 'ATH-ASP-DELETED';
/** Never deleted: the control. */
const LIVE_ATHLETE = 'ATH-ASP-LIVE';
const REFUSED = { status: 403, error: 'Forbidden: athlete does not belong to organization' };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

const mockRequirePrincipal = requirePrincipal as jest.Mock;

function principal(accountId: string, role: PilotPrincipal['role'], athleteId: string | null = null): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG_ID,
    athleteId,
    sessionToken: `token-${accountId}`,
    authProvider: 'ppbf_local',
  };
}

const coachPrincipal = principal(COACH, 'coach');
const athletePrincipal = (athleteId: string) => principal(`acct-${athleteId}`, 'athlete', athleteId);

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

type Handler = (request: NextRequest) => Promise<Response>;

async function call(
  actor: PilotPrincipal,
  handler: Handler,
  url: string,
  method = 'GET',
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await handler(
    new NextRequest(`http://localhost${url}`, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** status + error only, for comparing a refusal against REFUSED. */
const outcome = (result: { status: number; body: Record<string, unknown> }) => ({
  status: result.status,
  error: result.body.error,
});

async function expectOk(result: Promise<{ status: number; body: Record<string, unknown> }>): Promise<Record<string, unknown>> {
  const settled = await result;
  expect({ status: settled.status, body: settled.body }).toEqual({ status: 200, body: expect.anything() });
  return settled.body;
}

/** Every row this suite's routes can write for one athlete. */
async function snapshot(athleteId: string): Promise<Record<string, unknown>> {
  const { rows } = await activeClient!.query(
    `select
       (select json_agg(c order by c.check_in_id) from pilot.athlete_check_ins c
         where c.organization_id = $1 and c.athlete_id = $2)::text as check_ins,
       (select count(*) from pilot.shadow_formula_observations o
         where o.organization_id = $1 and o.athlete_id = $2 and o.observation_kind = 'body_weight')::text as weigh_ins,
       (select json_agg(f.payload order by f.plan_id) from pilot.athlete_floor_plans f
         where f.organization_id = $1 and f.athlete_id = $2)::text as floor_plans,
       (select count(*) from pilot.one_percent_nominations n
         where n.organization_id = $1 and (n.athlete_id = $2 or n.nominated_by_account_id = 'acct-' || $2))::text as nominations,
       (select count(*) from pilot.audit_events e
         where e.organization_id = $1 and e.actor_account_id = 'acct-' || $2)::text as audit_events`,
    [ORG_ID, athleteId],
  );
  return rows[0];
}

/**
 * One gym, one coach, two athletes that differ only in deleted_at. Each
 * athlete's own records are written through the routes while both are live:
 * a check-in with a weigh-in, a floor plan, a training hold (by the coach),
 * and one ready video.
 */
async function seed(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG_ID],
  );
  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Deleted Or Not', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, COACH],
    );
    // The athlete's own login: a nomination names its account.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
       values ($1, 'athlete', $2, 'ppbf_local', $3)`,
      [`acct-${athleteId}`, ORG_ID, athleteId],
    );
  }

  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    const athlete = athletePrincipal(athleteId);
    await expectOk(call(athlete, checkInPOST, '/api/pilot/athlete/check-in', 'POST', {
      energy: 4,
      body_mass: 60,
      body_mass_unit: 'kg',
    }));
    await expectOk(call(athlete, floorPlansPOST, '/api/pilot/floor-plans', 'POST', {
      plan: { athleteName: 'Deleted Or Not', readiness: 'GREEN', tasks: [{ id: 't1', title: 'Warmup' }] },
    }));
    await expectOk(call(coachPrincipal, trainingHoldsPOST, '/api/pilot/training-holds', 'POST', {
      action: 'place',
      athlete_id: athleteId,
      scope: 'all_training',
      reason_category: 'medical',
      reason_text: 'Seeded hold.',
      athlete_explanation: 'Rest this week.',
      lift_condition_text: 'Coach says so.',
    }));
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status)
       values ($1, $2, $3, $4, 'Sparring', $5, 'v.mp4', 2048, 'video/mp4', 'ready')`,
      [`video-${athleteId}`, ORG_ID, COACH, athleteId, `p/${athleteId}.mp4`],
    );
  }

  // The seeded check-ins move to yesterday. A same-day repeat check-in is
  // idempotent (no new row, no audit, no new weigh-in), so a refusal today
  // would be indistinguishable from an admitted repeat; from yesterday, an
  // admitted POST today writes all three, which the snapshot sees.
  await client.query(
    `update pilot.athlete_check_ins set checked_in_on = checked_in_on - 1 where organization_id = $1`,
    [ORG_ID],
  );

  // The deletion: what deleteAthleteRecord writes to the athlete row.
  await client.query(
    `update pilot.athletes set deleted_at = now(), updated_at = now()
     where organization_id = $1 and athlete_id = $2`,
    [ORG_ID, DELETED_ATHLETE],
  );
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists asp_main');
  await admin.query('create database asp_main');
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor('asp_main') });
  await client.connect();
  /* THE WHOLE SCHEMA -- this suite drives feature code and tests no
     migration. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  await seed(client);
});

afterAll(async () => {
  if (activeClient) {
    await activeClient.end();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test("the seeded records exist for both athletes, so a refusal below is not \"there was nothing\"", async () => {
  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    const stored = await snapshot(athleteId);
    expect({ weighIns: stored.weigh_ins, nominations: stored.nominations }).toEqual({ weighIns: '1', nominations: '0' });
    expect(stored.check_ins).not.toBeNull();
    expect(stored.floor_plans).not.toBeNull();
  }
  const { rows } = await activeClient!.query<{ athlete_id: string }>(
    `select athlete_id from pilot.training_holds where organization_id = $1 and status = 'active'
     union all
     select athlete_id from pilot.video_sessions where organization_id = $1
     order by athlete_id`,
    [ORG_ID],
  );
  expect(rows.map((row) => row.athlete_id)).toEqual([DELETED_ATHLETE, DELETED_ATHLETE, LIVE_ATHLETE, LIVE_ATHLETE]);
});

describe('reads: the live athlete gets their own record; the deleted athlete is refused', () => {
  const reads: Array<{ name: string; handler: Handler; url: string; live: (body: Record<string, unknown>) => void }> = [
    {
      name: 'athletes/list (their whole row)',
      handler: athletesListGET,
      url: '/api/pilot/athletes/list',
      live: (body) => expect((body.items as Array<{ athlete_id: string }>).map((row) => row.athlete_id)).toEqual([LIVE_ATHLETE]),
    },
    {
      name: 'floor-plans GET',
      handler: floorPlansGET,
      url: '/api/pilot/floor-plans',
      live: (body) => expect(body.items).toHaveLength(1),
    },
    {
      name: 'athlete/check-in GET',
      handler: checkInGET,
      url: '/api/pilot/athlete/check-in',
      live: (body) => expect(body.recent).toHaveLength(1),
    },
    {
      name: 'athlete/check-in/body-mass GET',
      handler: bodyMassGET,
      url: '/api/pilot/athlete/check-in/body-mass',
      live: (body) => expect(body.body_mass).toEqual(expect.objectContaining({ latest: expect.objectContaining({ kilograms: 60 }) })),
    },
    {
      name: 'video/list GET',
      handler: videoListGET,
      url: '/api/pilot/video/list',
      live: (body) => expect((body.items as Array<{ athlete_id: string }>).map((row) => row.athlete_id)).toEqual([LIVE_ATHLETE]),
    },
    {
      name: 'training-holds GET',
      handler: trainingHoldsGET,
      url: '/api/pilot/training-holds',
      live: (body) => expect(body.hold).toEqual(expect.objectContaining({ athlete_explanation: 'Rest this week.' })),
    },
  ];

  test.each(reads)('$name: live control', async ({ handler, url, live }) => {
    live(await expectOk(call(athletePrincipal(LIVE_ATHLETE), handler, url)));
  });

  test.each(reads)('$name: the deleted athlete is refused at the live-row check', async ({ handler, url }) => {
    // The message pins WHICH check refused: the live-row read.
    expect(outcome(await call(athletePrincipal(DELETED_ATHLETE), handler, url))).toEqual(REFUSED);
  });
});

describe('writes: the deleted athlete is refused and nothing is written', () => {
  test('check-in POST (a check-in, a weigh-in and an audit row)', async () => {
    const before = await snapshot(DELETED_ATHLETE);
    const result = await call(athletePrincipal(DELETED_ATHLETE), checkInPOST, '/api/pilot/athlete/check-in', 'POST', {
      energy: 2,
      body_mass: 58,
      body_mass_unit: 'kg',
    });
    expect(outcome(result)).toEqual(REFUSED);
    expect(await snapshot(DELETED_ATHLETE)).toEqual(before);
  });

  test("live control: the same POST writes a new check-in, weigh-in and audit row, so the snapshot above would see a write", async () => {
    const before = await snapshot(LIVE_ATHLETE);
    const body = await expectOk(call(athletePrincipal(LIVE_ATHLETE), checkInPOST, '/api/pilot/athlete/check-in', 'POST', {
      energy: 2,
      body_mass: 58,
      body_mass_unit: 'kg',
    }));
    expect(body.body_mass_saved).toBe(true);
    const after = await snapshot(LIVE_ATHLETE);
    expect(JSON.parse(after.check_ins as string)).toHaveLength(JSON.parse(before.check_ins as string).length + 1);
    expect(Number(after.weigh_ins)).toBe(Number(before.weigh_ins) + 1);
    expect(Number(after.audit_events)).toBe(Number(before.audit_events) + 1);
  });

  test('checkIn itself, below the route, takes no check-in for a deleted athlete', async () => {
    // The route refuses first; this pins the writer's own lookup, so a second
    // caller of checkIn cannot write for a deleted athlete either.
    const before = await snapshot(DELETED_ATHLETE);
    expect(await checkIn({ organizationId: ORG_ID, athleteId: DELETED_ATHLETE, energy: 3 })).toBeNull();
    expect(await snapshot(DELETED_ATHLETE)).toEqual(before);
  });

  test('floor-plans PATCH (ticking a task off)', async () => {
    const before = await snapshot(DELETED_ATHLETE);
    const result = await call(athletePrincipal(DELETED_ATHLETE), floorPlansPATCH, '/api/pilot/floor-plans', 'PATCH', {
      task_id: 't1',
      completed: true,
    });
    expect(outcome(result)).toEqual(REFUSED);
    expect(await snapshot(DELETED_ATHLETE)).toEqual(before);
  });

  test('live control: the live athlete may tick the same task off', async () => {
    await expectOk(call(athletePrincipal(LIVE_ATHLETE), floorPlansPATCH, '/api/pilot/floor-plans', 'PATCH', {
      task_id: 't1',
      completed: true,
    }));
    const [plan] = JSON.parse((await snapshot(LIVE_ATHLETE)).floor_plans as string);
    expect(plan.tasks[0].completed).toBe(true);
  });

  test('one-percent-club: a deleted athlete nominates no one', async () => {
    const before = await snapshot(DELETED_ATHLETE);
    const result = await call(athletePrincipal(DELETED_ATHLETE), onePercentPOST, '/api/pilot/coach/one-percent-club', 'POST', {
      action: 'nominate',
      athlete_id: LIVE_ATHLETE,
    });
    expect(outcome(result)).toEqual(REFUSED);
    expect(await snapshot(DELETED_ATHLETE)).toEqual(before);
    expect((await snapshot(LIVE_ATHLETE)).nominations).toBe('0');
  });

  test('one-percent-club: a live athlete cannot nominate a deleted one (not found, nothing written)', async () => {
    const before = await snapshot(DELETED_ATHLETE);
    const result = await call(athletePrincipal(LIVE_ATHLETE), onePercentPOST, '/api/pilot/coach/one-percent-club', 'POST', {
      action: 'nominate',
      athlete_id: DELETED_ATHLETE,
    });
    expect({ status: result.status, error: result.body.error }).toEqual({ status: 404, error: 'Not found' });
    expect(await snapshot(DELETED_ATHLETE)).toEqual(before);
  });

  test('live control: a live athlete may nominate themselves', async () => {
    await expectOk(call(athletePrincipal(LIVE_ATHLETE), onePercentPOST, '/api/pilot/coach/one-percent-club', 'POST', {
      action: 'nominate',
      athlete_id: LIVE_ATHLETE,
    }));
    expect((await snapshot(LIVE_ATHLETE)).nominations).toBe('1');
  });
});

// The two display-name reads that read no deletion mark (ACTIVE_WORK, the
// athlete-self deletion lane's reviewer): getSubjectIdentity (profileDb.ts),
// which names a person on the fight card, the portrait queue, a training
// hold's placer and the video-compliance queue; and resolveActorDisplayName
// (onePercentClub.ts), which names whoever nominated or voted. Each is called
// below exactly as its callers call it. The deleted athlete here is the
// harder case: only the athlete row is marked, the login was left open, so a
// read that filtered the login alone would still fall through to the staff
// branch and print the account id.
describe('display-name reads: a deleted person is named by neither', () => {
  const LIVE_ADMIN = 'acct-admin-asp';
  const DELETED_ADMIN = 'acct-admin-asp-gone';

  beforeAll(async () => {
    for (const [accountId, email] of [[LIVE_ADMIN, 'pat.admin@example.org'], [DELETED_ADMIN, 'gone.admin@example.org']]) {
      await activeClient!.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email)
         values ($1, 'organization_admin', $2, 'microsoft', $3)`,
        [accountId, ORG_ID, email],
      );
    }
    // What deleteAccount writes to the login (dataDeletion.ts).
    await activeClient!.query(
      `update pilot.accounts set deleted_at = now(), active_flag = false, updated_at = now() where account_id = $1`,
      [DELETED_ADMIN],
    );
  });

  test('getSubjectIdentity: live control, the athlete by name and the admin by email stem', async () => {
    await expect(getSubjectIdentity(ORG_ID, `acct-${LIVE_ATHLETE}`)).resolves.toEqual(
      expect.objectContaining({ fullName: 'Deleted Or Not', athleteId: LIVE_ATHLETE }),
    );
    await expect(getSubjectIdentity(ORG_ID, LIVE_ADMIN)).resolves.toEqual(
      expect.objectContaining({ fullName: 'Pat Admin', athleteId: null }),
    );
  });

  test('getSubjectIdentity: the deleted athlete (login left open) and the deleted login are nobody', async () => {
    await expect(getSubjectIdentity(ORG_ID, `acct-${DELETED_ATHLETE}`)).resolves.toBeNull();
    await expect(getSubjectIdentity(ORG_ID, DELETED_ADMIN)).resolves.toBeNull();
  });

  test('resolveActorDisplayName: live control, the athlete by name and the admin by email stem', async () => {
    await expect(resolveActorDisplayName({
      organizationId: ORG_ID, accountId: `acct-${LIVE_ATHLETE}`, role: 'athlete', selfAthleteId: LIVE_ATHLETE,
    })).resolves.toBe('Deleted Or Not');
    await expect(resolveActorDisplayName({
      organizationId: ORG_ID, accountId: LIVE_ADMIN, role: 'organization_admin',
    })).resolves.toBe('Admin Pat Admin');
  });

  test('resolveActorDisplayName: the deleted athlete and the deleted login get the phrases a nameless record already got', async () => {
    await expect(resolveActorDisplayName({
      organizationId: ORG_ID, accountId: `acct-${DELETED_ATHLETE}`, role: 'athlete', selfAthleteId: DELETED_ATHLETE,
    })).resolves.toBe('An athlete');
    await expect(resolveActorDisplayName({
      organizationId: ORG_ID, accountId: DELETED_ADMIN, role: 'organization_admin',
    })).resolves.toBe('An administrator');
  });
});
