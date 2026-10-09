// Real PostgreSQL-backed test: the SHADOW event feed applies audit/get's
// role and entity-type gate to the audit events writePilotAuditEvent mirrors
// into pilot.shadow_events.
//
// WHY THIS SUITE EXISTS. audit.ts copies every audit row with an organization
// into shadow_events as SHADOW_AUDIT_<TYPE>_<ENTITY> with payload
// { event_type, details }. listShadowEvents scoped those copies by athlete
// only, so a row naming no athlete fell into the "tied to no athlete"
// disjunct and reached every coach, staff member, volunteer and the platform
// owner: payment account connections, board seats, media-consent changes,
// calibration work. A row naming the coach's own athlete reached that coach
// whatever its type, safety flags included. audit/get, the reader built for
// those rows, admits organization admins and coaches only, limits coaches to
// an allow-list of training-floor types (auditReadAllowlist.ts), hides an
// athlete-owned row it cannot tie to an athlete, and withholds calibration
// rows from everyone. The SHADOW feed was a way around all of it.
//
// EVERY REFUSAL HAS A CONTROL: the organization admin still reads every
// non-calibration mirror, a coach still reads allow-listed gym-wide and
// own-athlete rows, every role still reads the non-audit operational event,
// and athletes and parents keep exactly what they had (Overwatch, 2026-10-09:
// "Athlete/parent: leave unchanged").
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
  };
});

import type { PilotRole } from './contracts';
import { type PilotAuditEvent, writePilotAuditEvent } from './audit';
import { emitShadowEvent } from './shadowEvents';
import { listShadowEvents } from './shadowReadModels';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-audit-mirror-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-samc';
const ADMIN = 'acct-admin-samc';
const COACH_A = 'acct-coach-a-samc';
const COACH_B = 'acct-coach-b-samc';
const STAFF = 'acct-staff-samc';
const VOLUNTEER = 'acct-volunteer-samc';
const PLATFORM_OWNER = 'acct-owner-samc';
const PARENT_A = 'acct-parent-a-samc';
const ATHLETE_A = 'ATH-SAMC-A';
const ATHLETE_B = 'ATH-SAMC-B';
const ATHLETE_A_ACCOUNT = 'acct-ath-a-samc';
const ATHLETE_B_ACCOUNT = 'acct-ath-b-samc';

/* One row per shape, labelled by entity_id. */
const OPS = 'ops-library-source';      // not an audit mirror; names no athlete
const PAYMENT = 'org-samc:boxing';     // audit: payment_account, names no athlete
const BOARD = 'board-seat-1';          // audit: board_seat, names no athlete
const CONSENT = 'consent-1';           // audit: guardian_media_consent, names no athlete
const SAFETY_A = 'safety-flag-a';      // audit: safety_flag naming athlete A
const CALIBRATION = 'cal-set-1';       // audit: calibration_annotation_set, names no athlete
const DRILL = 'drill-1';               // audit: drill (allow-listed, gym-wide)
const GOAL_A = 'goal-a';               // audit: goal naming athlete A (allow-listed, athlete-owned)
const GOAL_NOBODY = 'goal-nobody';     // audit: goal naming nobody (athlete-owned, unresolved)
const LOGIN_A = ATHLETE_A_ACCOUNT;     // audit: account sign-in naming athlete A
const GOAL_MOVED = 'goal-moved';       // audit names athlete A; the goal now belongs to athlete B
const GOAL_OWNED_A = 'goal-owned-a';   // audit names nobody; the goal belongs to athlete A

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function seed(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  for (const [accountId, role] of [
    [ADMIN, 'organization_admin'],
    [COACH_A, 'coach'],
    [COACH_B, 'coach'],
    [STAFF, 'staff'],
    [VOLUNTEER, 'volunteer'],
    [PARENT_A, 'parent'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG_ID],
    );
  }
  for (const [athleteId, coachId, accountId] of [
    [ATHLETE_A, COACH_A, ATHLETE_A_ACCOUNT],
    [ATHLETE_B, COACH_B, ATHLETE_B_ACCOUNT],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Mirror Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, coachId],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id)
       values ($1, 'athlete', $2, $3)`,
      [accountId, ORG_ID, athleteId],
    );
  }
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-samc-a', $2, 'Guardian A')`,
    [ORG_ID, PARENT_A],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-samc-a', $2, 'parent')`,
    [ORG_ID, ATHLETE_A],
  );

  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_LIBRARY_SOURCE_REGISTERED',
    entityType: 'shadow_library_source',
    entityId: OPS,
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    payload: { source_id: OPS, title: 'Footwork primer' },
  });

  const audit = (
    eventType: PilotAuditEvent['event_type'],
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
    [actorAccountId, actorRole]: [string, PilotRole] = [ADMIN, 'organization_admin'],
  ) =>
    writePilotAuditEvent({
      event_type: eventType,
      actor_account_id: actorAccountId,
      actor_role: actorRole,
      organization_id: ORG_ID,
      entity_type: entityType,
      entity_id: entityId,
      details,
    });

  // The shape payments/connect/callback/route.ts audits.
  await audit('payment_account_connected', 'payment_account', PAYMENT, { lane: 'boxing', stripe_account_id: 'acct_secret_123' });
  await audit('create', 'board_seat', BOARD, { seat: 'treasurer', holder_name: 'Board Member' });
  await audit('update', 'guardian_media_consent', CONSENT, { status: 'withdrawn', guardian_name: 'Guardian A' });
  await audit('create', 'safety_flag', SAFETY_A, { athlete_id: ATHLETE_A, severity: 'high' }, [COACH_A, 'coach']);
  await audit('create', 'calibration_annotation_set', CALIBRATION, { event_count: 4 }, [COACH_A, 'coach']);
  await audit('create', 'drill', DRILL, { name: 'Slip line' }, [COACH_A, 'coach']);
  await audit('update', 'goal', GOAL_A, { athlete_id: ATHLETE_A, status: 'met' }, [COACH_A, 'coach']);
  await audit('update', 'goal', GOAL_NOBODY, { status: 'met' }, [COACH_B, 'coach']);
  await audit('login', 'account', LOGIN_A, { athlete_id: ATHLETE_A }, [ATHLETE_A_ACCOUNT, 'athlete']);

  // Goals whose live owner audit/get resolves through pilot.goals. One was
  // written for A and has since been moved to B (entities.ts can move a
  // goal); the other's audit row names nobody, the goal says A.
  for (const [goalId, athleteId] of [
    [GOAL_MOVED, ATHLETE_B],
    [GOAL_OWNED_A, ATHLETE_A],
  ] as const) {
    await client.query(
      `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
       values ($1, $2, $3, 'Goal', '2026-12-01', 'rounds', 'open', now(), now())`,
      [ORG_ID, goalId, athleteId],
    );
  }
  await audit('create', 'goal', GOAL_MOVED, { athlete_id: ATHLETE_A, status: 'open' }, [COACH_A, 'coach']);
  await audit('update', 'goal', GOAL_OWNED_A, { status: 'met' }, [COACH_A, 'coach']);
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
  await admin.query('drop database if exists samc_main');
  await admin.query('create database samc_main');
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor('samc_main') });
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

async function visibleTo(actorAccountId: string, actorRole: PilotRole, athleteId: string | null = null): Promise<string[]> {
  const rows = await listShadowEvents({ organizationId: ORG_ID, actorAccountId, actorRole, athleteId }, { limit: 200 });
  return rows.map((row) => row.entity_id).sort();
}

const sorted = (ids: string[]) => [...ids].sort();

describe("SHADOW event feed: mirrored audit events follow audit/get's role and entity-type gate", () => {
  test('fixture: every row is in the table', async () => {
    const stored = await activeClient!.query<{ entity_id: string }>(
      `select entity_id from pilot.shadow_events where organization_id = $1`,
      [ORG_ID],
    );
    expect(stored.rows).toHaveLength(12);
  });

  test('the organization admin reads every mirror except calibration rows, which audit/get withholds from everyone', async () => {
    expect(await visibleTo(ADMIN, 'organization_admin')).toEqual(
      sorted([OPS, PAYMENT, BOARD, CONSENT, SAFETY_A, DRILL, GOAL_A, GOAL_NOBODY, LOGIN_A, GOAL_MOVED, GOAL_OWNED_A]),
    );
  });

  test("the legacy 'admin' role reads what the organization admin reads", async () => {
    expect(await visibleTo(ADMIN, 'admin')).toEqual(
      sorted([OPS, PAYMENT, BOARD, CONSENT, SAFETY_A, DRILL, GOAL_A, GOAL_NOBODY, LOGIN_A, GOAL_MOVED, GOAL_OWNED_A]),
    );
  });

  test('a coach reads allow-listed mirrors for their own athlete and gym-wide types; no payment, board, consent, safety, calibration or account row', async () => {
    expect(await visibleTo(COACH_A, 'coach')).toEqual(sorted([OPS, DRILL, GOAL_A, GOAL_OWNED_A]));
  });

  test("a goal moved to another coach's athlete leaves the first coach's feed, as audit/get; one that names nobody but resolves to the coach's athlete stays", async () => {
    const coachA = await visibleTo(COACH_A, 'coach');
    expect(coachA).not.toContain(GOAL_MOVED);
    expect(coachA).toContain(GOAL_OWNED_A);
  });

  test("another coach reads neither athlete A's goal nor an athlete-owned row that names nobody", async () => {
    expect(await visibleTo(COACH_B, 'coach')).toEqual(sorted([OPS, DRILL]));
  });

  test('staff read no mirrored audit row', async () => {
    expect(await visibleTo(STAFF, 'staff')).toEqual([OPS]);
  });

  test('volunteers read no mirrored audit row', async () => {
    expect(await visibleTo(VOLUNTEER, 'volunteer')).toEqual([OPS]);
  });

  test('the board role reads no mirrored audit row', async () => {
    expect(await visibleTo(STAFF, 'board')).toEqual([OPS]);
  });

  test('the platform owner reads no mirrored audit row', async () => {
    expect(await visibleTo(PLATFORM_OWNER, 'platform_owner')).toEqual([OPS]);
  });

  test("athletes and parents keep what they had: only their own athlete's rows, mirrors included", async () => {
    expect(await visibleTo(ATHLETE_A_ACCOUNT, 'athlete', ATHLETE_A)).toEqual(sorted([SAFETY_A, GOAL_A, LOGIN_A, GOAL_MOVED]));
    expect(await visibleTo(PARENT_A, 'parent')).toEqual(sorted([SAFETY_A, GOAL_A, LOGIN_A, GOAL_MOVED]));
  });
});
