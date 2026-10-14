// Real PostgreSQL proof that a coach's behaviour note stays staff only (F-070;
// OD-2026-10-10-003 item 3: no athlete or parent view, item 4: the
// organization admin reads coach notes).
//
// WHY THIS IS NOT A MOCKED TEST. The list-membership checks in
// behaviourNotes.test.ts prove what the readers' allow-lists contain. They
// cannot prove that a reader's SQL honours its own list. This seeds a
// behavior_standard coach note (what the Decision Loop's Behavior & Habit
// Note writes) for an athlete with TWO guardians and drives the real route
// handlers, with the real authorization gates running against the seeded
// rows. Only requirePrincipal is stubbed (the seam the other route-driving
// .pg suites use).
//
// The family routes that select from pilot.coach_observations and that an
// athlete or a guardian can reach, all driven below:
//   POST /api/pilot/intake/domain-get      (athlete, guardians, coach, admin)
//   POST /api/pilot/intake/cases/get       (athlete, guardians, coach, admin)
//   GET  /api/pilot/passbook               (athlete, guardians, coach, admin)
//   GET  /api/pilot/parent/messages        (guardians)
//   GET  /api/pilot/parent/observations    (guardians; own-author rows only)
// Other readers of the table checked by reading (not driven here, because
// each returns no note text or is staff-gated): drills/proposals (existence
// check, staff gate), parentTasks.ts (hard-coded parent_message, staff
// gate), audit/get (staff allow-list), sessionAutoClose / shadowDecisionOutcomes
// (internal, no text returned), wallDisplayDb / wallOfNamesDb (do not query it).
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-behaviour-notes-staff-only-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_behaviour_notes_staff_only';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-bn-1';
const OTHER_ORG = 'org-bn-2';
const ATHLETE = 'ath-bn-1';
const OTHER_ATHLETE = 'ath-bn-2';
const CASE_ID = '11111111-2222-4333-8444-555555555566';

/** Distinctive text, so a leak anywhere in a serialized body is a string match. */
const NOTE_MARKER = 'BEHAVIOUR-NOTE-MARKER-7731 skipped warm-up twice and argued with the referee';
const NOTE_FRAGMENTS = ['BEHAVIOUR-NOTE-MARKER-7731', 'argued with the referee'] as const;
const MESSAGE_TEXT = 'Please bring the medical form on Thursday.';
const OBSERVATION_TEXT = 'Guard drops on the exit in round three.';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let domainGet: (request: NextRequest) => Promise<Response>;
let casesGet: (request: NextRequest) => Promise<Response>;
let passbookGet: (request: NextRequest) => Promise<Response>;
let parentMessagesGet: (request: NextRequest) => Promise<Response>;
let parentObservationsGet: (request: NextRequest) => Promise<Response>;
let behaviourNotesGet: (request: NextRequest) => Promise<Response>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

function principal(overrides: Partial<PilotPrincipal> & Pick<PilotPrincipal, 'accountId' | 'role'>): PilotPrincipal {
  return {
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const AS = {
  admin: () => principal({ accountId: 'acct-bn-admin', role: 'organization_admin' }),
  coach: () => principal({ accountId: 'acct-bn-coach', role: 'coach' }),
  athlete: () => principal({ accountId: 'acct-bn-athlete', role: 'athlete', athleteId: ATHLETE }),
  guardianA: () => principal({ accountId: 'acct-bn-guardian-a', role: 'parent' }),
  guardianB: () => principal({ accountId: 'acct-bn-guardian-b', role: 'parent' }),
  otherOrgCoach: () => principal({ accountId: 'acct-bn-coach-org2', role: 'coach', organizationId: OTHER_ORG }),
  otherOrgAdmin: () => principal({ accountId: 'acct-bn-admin-org2', role: 'organization_admin', organizationId: OTHER_ORG }),
} as const;

interface Called {
  status: number;
  /** The WHOLE response body, as the reader receives it. */
  text: string;
}

async function call(
  handler: (request: NextRequest) => Promise<Response>,
  actor: PilotPrincipal,
  url: string,
  body?: Record<string, unknown>,
): Promise<Called> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const request = new NextRequest(`http://localhost${url}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' });
  const response = await handler(request);
  return { status: response.status, text: await response.text() };
}

const domainGetAs = (actor: PilotPrincipal, athleteId = ATHLETE) =>
  call(domainGet, actor, '/api/pilot/intake/domain-get', { athlete_id: athleteId });
const caseAs = (actor: PilotPrincipal) =>
  call(casesGet, actor, '/api/pilot/intake/cases/get', { intake_case_id: CASE_ID });
const passbookAs = (actor: PilotPrincipal, athleteId = ATHLETE) =>
  call(passbookGet, actor, `/api/pilot/passbook?athlete_id=${athleteId}`);
const parentMessagesAs = (actor: PilotPrincipal) =>
  call(parentMessagesGet, actor, '/api/pilot/parent/messages');
const parentObservationsAs = (actor: PilotPrincipal, athleteId = ATHLETE) =>
  call(parentObservationsGet, actor, `/api/pilot/parent/observations?athlete_id=${athleteId}`);
const notesAs = (actor: PilotPrincipal) =>
  call(behaviourNotesGet, actor, '/api/pilot/coach/behavior-notes');

function expectNoNote(result: Called): void {
  for (const fragment of NOTE_FRAGMENTS) {
    expect(result.text).not.toContain(fragment);
  }
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [ORG, OTHER_ORG],
  );

  const accounts: Array<[string, string, string, string | null]> = [
    ['acct-bn-admin', 'organization_admin', ORG, null],
    ['acct-bn-coach', 'coach', ORG, null],
    ['acct-bn-athlete', 'athlete', ORG, ATHLETE],
    ['acct-bn-guardian-a', 'parent', ORG, null],
    ['acct-bn-guardian-b', 'parent', ORG, null],
    ['acct-bn-coach-org2', 'coach', OTHER_ORG, null],
    ['acct-bn-admin-org2', 'organization_admin', OTHER_ORG, null],
  ];
  for (const [accountId, role, organizationId, athleteId] of accounts) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, organizationId, athleteId],
    );
  }

  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian A', true, 'acct-bn-coach', now(), now()),
       ($3, $4, 'Someone Else', '2011-01-01', 'youth-65', 'active', 'Nobody', true, 'acct-bn-coach-org2', now(), now())`,
    [ORG, ATHLETE, OTHER_ORG, OTHER_ATHLETE],
  );

  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values
       ($1, 'par-bn-a', 'acct-bn-guardian-a', 'Guardian A', '555-0100', 'guardian.a@example.test'),
       ($1, 'par-bn-b', 'acct-bn-guardian-b', 'Guardian B', '555-0200', 'guardian.b@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-bn-a', $2, 'mother'), ($1, 'par-bn-b', $2, 'father')`,
    [ORG, ATHLETE],
  );

  // The behaviour note, written the way the Decision Loop writes it, beside
  // the two rows a family reader IS allowed to see (a positive control).
  await db.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
     values
       ($1, '10000000-0000-4000-8000-0000000000a1', $2, 'acct-bn-coach', 'coach', 'behavior_standard', $3),
       ($1, '10000000-0000-4000-8000-0000000000a2', $2, 'acct-bn-coach', 'coach', 'parent_message', $4),
       ($1, '10000000-0000-4000-8000-0000000000a3', $2, 'acct-bn-coach', 'coach', 'coach_observation', $5)`,
    [ORG, ATHLETE, NOTE_MARKER, MESSAGE_TEXT, OBSERVATION_TEXT],
  );

  await db.query(
    `insert into pilot.intake_cases
       (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id)
     values ($1, $2, 'pending_review', $3, 'Registration', 'acct-bn-admin')`,
    [ORG, CASE_ID, ATHLETE],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  domainGet = (await import('@/app/api/pilot/intake/domain-get/route')).POST;
  casesGet = (await import('@/app/api/pilot/intake/cases/get/route')).POST;
  passbookGet = (await import('@/app/api/pilot/passbook/route')).GET;
  parentMessagesGet = (await import('@/app/api/pilot/parent/messages/route')).GET;
  parentObservationsGet = (await import('@/app/api/pilot/parent/observations/route')).GET;
  behaviourNotesGet = (await import('@/app/api/pilot/coach/behavior-notes/route')).GET;
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await db?.end().catch(() => {});

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
});

describe('the fixture', () => {
  test('stores the behaviour note, a parent message and a coach observation for the athlete', async () => {
    const rows = await db.query<{ note_type: string; note_text: string }>(
      `select note_type, note_text from pilot.coach_observations
        where organization_id = $1 and athlete_id = $2 order by note_type`,
      [ORG, ATHLETE],
    );
    expect(rows.rows.map((row) => row.note_type)).toEqual(['behavior_standard', 'coach_observation', 'parent_message']);
    expect(rows.rows.find((row) => row.note_type === 'behavior_standard')?.note_text).toBe(NOTE_MARKER);
  });
});

describe('the family reads return no row and no text of a behaviour note', () => {
  test('the athlete: domain-get, case aggregate, passbook', async () => {
    const domain = await domainGetAs(AS.athlete());
    expect(domain.status).toBe(200);
    expectNoNote(domain);
    // Positive control: the read works and does return what the athlete may see.
    expect(domain.text).toContain(OBSERVATION_TEXT);

    const aggregate = await caseAs(AS.athlete());
    expectNoNote(aggregate);

    const book = await passbookAs(AS.athlete());
    expect(book.status).toBe(200);
    expectNoNote(book);
  });

  test.each([
    ['guardian A', AS.guardianA],
    ['guardian B', AS.guardianB],
  ])('%s: domain-get, case aggregate, passbook, messages, observations', async (_label, actor) => {
    const domain = await domainGetAs(actor());
    expect(domain.status).toBe(200);
    expectNoNote(domain);
    // Positive control: the guardian does get the parent message.
    expect(domain.text).toContain(MESSAGE_TEXT);

    expectNoNote(await caseAs(actor()));

    const book = await passbookAs(actor());
    expect(book.status).toBe(200);
    expectNoNote(book);

    const messages = await parentMessagesAs(actor());
    expect(messages.status).toBe(200);
    expect(messages.text).toContain(MESSAGE_TEXT);
    expectNoNote(messages);

    const observations = await parentObservationsAs(actor());
    expect(observations.status).toBe(200);
    expectNoNote(observations);
  });

  test('a coach of another gym gets no note, and is refused the athlete', async () => {
    for (const reader of [
      () => domainGetAs(AS.otherOrgCoach()),
      () => caseAs(AS.otherOrgCoach()),
      () => passbookAs(AS.otherOrgCoach()),
      () => parentMessagesAs(AS.otherOrgCoach()),
      () => parentObservationsAs(AS.otherOrgCoach()),
      () => notesAs(AS.otherOrgCoach()),
    ]) {
      const result = await reader();
      expectNoNote(result);
    }
    expect((await domainGetAs(AS.otherOrgCoach())).status).toBeGreaterThanOrEqual(400);
    expect((await notesAs(AS.otherOrgCoach())).text).toContain('"items":[]');
  });

  test('the other gym\'s organization admin reads no note either', async () => {
    expectNoNote(await notesAs(AS.otherOrgAdmin()));
    expectNoNote(await domainGetAs(AS.otherOrgAdmin()));
  });

  test('neither the athlete nor a guardian can open the staff notes list', async () => {
    for (const actor of [AS.athlete(), AS.guardianA(), AS.guardianB()]) {
      const result = await notesAs(actor);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expectNoNote(result);
    }
  });
});

describe('staff of that gym do read it', () => {
  test.each([
    ['the coach', AS.coach],
    ['the organization admin', AS.admin],
  ])('%s gets the note from the new list', async (_label, actor) => {
    const result = await notesAs(actor());
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as { items: Array<{ athlete_id: string; athlete_name: string; note_text: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ athlete_id: ATHLETE, athlete_name: 'Rosa Ortiz', note_text: NOTE_MARKER });
  });

  test('the staff intake read keeps the note too (staff lists are unrestricted)', async () => {
    const result = await domainGetAs(AS.coach());
    expect(result.status).toBe(200);
    expect(result.text).toContain('BEHAVIOUR-NOTE-MARKER-7731');
  });
});
