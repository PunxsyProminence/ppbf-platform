// Real PostgreSQL proof that a guardian's contact details do not leave the
// building through an intake read.
//
// WHY THIS CANNOT BE A MOCKED TEST. The sibling route tests assert the SQL
// STRING the route builds -- which is worth having, and caught the original
// `select p.*` -- but a string assertion cannot tell you what a database
// actually hands back. The property under test is the shape of the returned
// ROW: that `phone`, `email` and `account_id` are not keys on the object an
// athlete or a guardian receives, and that they still are for the staff who
// make the emergency call. Only a real Postgres answering a real query can
// show that, because only Postgres decides what a projection returns.
//
// Both intake reads that join pilot.parents are driven here, end to end:
//   * POST /api/pilot/intake/domain-get -- the real route handler, with the
//     real authorization gate (assertActorCanAccessAthlete) running against
//     seeded rows. Only requirePrincipal is stubbed, the same seam the other
//     route-driving .pg suites use, because a session cookie is not what this
//     file is about.
//   * getIntakeCaseAggregate -- called directly, since it takes its reader as
//     an argument.
//
// The households are the point. Guardian A and Guardian B are both linked to
// one athlete, which is the ordinary shape of a split household and also the
// shape of a household under a protective order. Neither may read the other's
// number here.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { FAMILY_SESSION_FIELDS, SESSION_WITHHELD_FROM_FAMILY_FIELDS } from './familyRecordView';
import {
  GUARDIAN_FAMILY_COLUMNS,
  GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS,
  WAIVER_FAMILY_COLUMNS,
} from './familyGuardianView';
import { requirePrincipal } from './http';
import {
  ASSESSMENT_IDENTITY_COLUMNS,
  ASSESSMENT_STAFF_COLUMNS,
  COACH_OBSERVATION_IDENTITY_COLUMNS,
  COACH_OBSERVATION_STAFF_COLUMNS,
  READINESS_IDENTITY_COLUMNS,
  READINESS_STAFF_COLUMNS,
  WAIVER_IDENTITY_COLUMNS,
  WAIVER_STAFF_COLUMNS,
} from './intake';
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-contact-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB_NAME = 'ppbf_test_guardian_contact';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ATHLETE = 'ath-1';
const OTHER_ATHLETE = 'ath-2';
const CASE_ID = '11111111-2222-4333-8444-555555555555';

/** The three columns this whole file exists to keep out of the wrong hands. */
const CONTACT_KEYS = ['phone', 'email', 'account_id'] as const;

/* Guardian B's details, in every spelling they could leave the building in.
   Asserted against the SERIALIZED response rather than key-by-key, because the
   disclosure this file is about was assembled from two different fields of one
   response body -- so the only honest question is whether the string appears
   anywhere in what the reader receives. */
const GUARDIAN_B_SECRETS = ['555-0200', 'guardian.b@example.test', 'acct-guardian-b'] as const;
const GUARDIAN_A_SECRETS = ['555-0100', 'guardian.a@example.test', 'acct-guardian-a'] as const;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let domainGet: typeof import('@/app/api/pilot/intake/domain-get/route').POST;
let getIntakeCaseAggregate: typeof import('./intake').getIntakeCaseAggregate;
let casesGet: typeof import('@/app/api/pilot/intake/cases/get/route').POST;
let holdsGet: typeof import('@/app/api/pilot/training-holds/route').GET;
let safetyGet: typeof import('@/app/api/pilot/parent/safety/route').GET;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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
  admin: () => principal({ accountId: 'acct-admin', role: 'organization_admin' }),
  coach: () => principal({ accountId: 'acct-coach', role: 'coach' }),
  athlete: () => principal({ accountId: 'acct-athlete', role: 'athlete', athleteId: ATHLETE }),
  guardianA: () => principal({ accountId: 'acct-guardian-a', role: 'parent' }),
  guardianB: () => principal({ accountId: 'acct-guardian-b', role: 'parent' }),
  otherOrgCoach: () => principal({ accountId: 'acct-coach-org2', role: 'coach', organizationId: OTHER_ORG }),
  platformOwner: () => principal({ accountId: 'acct-owner', role: 'platform_owner' }),
} as const;

interface DomainGetBody {
  guardians?: Record<string, unknown>[];
  emergency_contacts?: Record<string, unknown>[];
  waivers?: Record<string, unknown>[];
  medical_intake?: Record<string, unknown>[];
  attendance?: Record<string, unknown>[];
  assessments?: Record<string, unknown>[];
  readiness?: Record<string, unknown>[];
  coach_observations?: Record<string, unknown>[];
  error?: string;
}

/** The route's WHOLE response body, parsed. */
async function readDomainGet(actor: PilotPrincipal, athleteId = ATHLETE): Promise<DomainGetBody> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await domainGet(new NextRequest('http://localhost/api/pilot/intake/domain-get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ athlete_id: athleteId }),
  }));
  const payload = await response.json() as DomainGetBody;
  if (response.status !== 200) {
    throw new Error(`refused ${response.status}: ${payload.error ?? ''}`);
  }
  return payload;
}

/** POST /api/pilot/intake/cases/get, the real handler and its real gate. */
async function readCase(actor: PilotPrincipal): Promise<{ found?: boolean; aggregate?: Record<string, unknown[]> }> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await casesGet(new NextRequest('http://localhost/api/pilot/intake/cases/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intake_case_id: CASE_ID }),
  }));
  if (response.status !== 200) {
    throw new Error(`refused ${response.status}`);
  }
  return response.json();
}

async function readGuardiansVia(actor: PilotPrincipal, athleteId = ATHLETE): Promise<Record<string, unknown>[]> {
  return (await readDomainGet(actor, athleteId)).guardians ?? [];
}

async function readAggregate(actor: PilotPrincipal | null) {
  return getIntakeCaseAggregate(
    ORG,
    CASE_ID,
    actor ? { actorAccountId: actor.accountId, actorRole: actor.role } : undefined,
  );
}

async function readGuardiansViaAggregate(actor: PilotPrincipal | null): Promise<Record<string, unknown>[]> {
  return ((await readAggregate(actor))?.guardians ?? []) as Record<string, unknown>[];
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
  /* THE WHOLE SCHEMA, not the base file plus a hand-picked migration.
     The principle the previous version stated is right and is why this
     changed: "a fixture without it is not a smaller production -- it is a
     schema nobody runs." A hand-maintained list only holds that line for the
     migrations somebody remembered. This suite named the data-retention
     migration (for pilot.athletes.deleted_at) and not the guardian-media-
     consent one, so pilot.waivers here was missing parent_id, covers_video
     and public_use_allowed -- three columns production has. A projection over
     that table cannot be tested against a shape production does not run.

     applyFullSchema resolves and applies every migration in dependency order,
     which is the same thing without the list to forget. */
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
  await applyFullSchema(db, { infraDir: INFRA_DIR });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [ORG, OTHER_ORG],
  );

  const accounts: Array<[string, string, string, string | null]> = [
    ['acct-admin', 'organization_admin', ORG, null],
    ['acct-coach', 'coach', ORG, null],
    ['acct-athlete', 'athlete', ORG, ATHLETE],
    ['acct-guardian-a', 'parent', ORG, null],
    ['acct-guardian-b', 'parent', ORG, null],
    ['acct-coach-org2', 'coach', OTHER_ORG, null],
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
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian A', true, 'acct-coach', now(), now()),
       ($3, $4, 'Someone Else', '2011-01-01', 'youth-65', 'active', 'Nobody', true, 'acct-coach-org2', now(), now())`,
    [ORG, ATHLETE, OTHER_ORG, OTHER_ATHLETE],
  );

  // TWO HOUSEHOLDS, ONE CHILD. Both rows carry a real phone, a real email and
  // a real account_id, so a leak in either direction shows up as a value and
  // not as a null that could be mistaken for a narrowed projection.
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values
       ($1, 'par-a', 'acct-guardian-a', 'Guardian A', '555-0100', 'guardian.a@example.test'),
       ($1, 'par-b', 'acct-guardian-b', 'Guardian B', '555-0200', 'guardian.b@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-a', $2, 'mother'), ($1, 'par-b', $2, 'father')`,
    [ORG, ATHLETE],
  );

  // THE SAME ADULT IN BOTH TABLES. This is not a contrived fixture: one intake
  // promotion request carries a `guardian` block and an `emergency_contact`
  // block side by side, and the other parent is the ordinary emergency
  // contact. The full_name is byte-identical to the pilot.parents row on
  // purpose -- that identity is what let a narrowed guardian list and an
  // unnarrowed emergency-contact list be joined back together by a reader.
  await db.query(
    `insert into pilot.emergency_contacts
       (organization_id, contact_id, athlete_id, full_name, relationship_to_athlete, phone, email, is_primary, notes)
     values ($1, '99999999-8888-4777-8666-555555555555', $2, 'Guardian B', 'father',
             '555-0200', 'guardian.b@example.test', true, $3)`,
    [ORG, ATHLETE, 'Do not call this contact without speaking to the welfare lead first.'],
  );

  // A medical intake and an attendance row, each carrying a staff free-text
  // note. Both tables sit in the same response body as the guardians and the
  // waiver, under the same gate, and both were still on `select *`.
  await db.query(
    `insert into pilot.medical_intake
       (organization_id, medical_id, athlete_id, conditions, medications, allergies,
        physician_name, physician_phone, clearance_status, notes)
     values ($1, '88888888-7777-4666-8555-444444444444', $2, 'asthma', 'inhaler', 'none',
             'Dr Reyes', '555-0300', 'cleared', $3)`,
    [ORG, ATHLETE, 'Mother asked that the welfare lead call her, not 555-0200, about this.'],
  );

  await db.query(
    `insert into pilot.attendance
       (organization_id, attendance_id, athlete_id, attendance_date, status, notes)
     values ($1, '66666666-5555-4444-8333-222222222222', $2, current_date, 'present', $3)`,
    [ORG, ATHLETE, 'Arrived upset; welfare lead spoke to them.'],
  );

  /* An assessment and a readiness row, each carrying the staff-internal
     columns their migrations added AFTER both reads of the table were
     written. The assessment names a second rater and their independent score
     -- an unreconciled disagreement between two staff about this child -- and
     a free-text note in the same shape as the three above. Both tables sit in
     the same response body, under the same gate. */
  await db.query(
    `insert into pilot.assessments
       (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
        assessor_role, second_rater_account_id, second_rater_result, conditions_note)
     values ($1, '55555555-4444-4333-8222-111111111111', $2, $3, 'intake_assessment', '{"score": 4}'::jsonb,
             'coach', $4, 'rated 2 - disagrees with the first rater', $5)`,
    [ORG, ATHLETE, 'acct-coach', 'acct-admin', 'Ran late; welfare lead was in the room. Call 555-0200 first.'],
  );

  await db.query(
    `insert into pilot.readiness
       (organization_id, readiness_id, athlete_id, score, category, measured_at, method, recorded_by_account_id)
     values ($1, '44444444-3333-4222-8111-000000000000', $2, 7, 'green', now(), 'staff_entered_intake', $3)`,
    [ORG, ATHLETE, 'acct-coach'],
  );

  // A waiver signed by Guardian B, carrying a staff note about Guardian B.
  //
  // pilot.waivers was absent from this fixture, which is why the end-to-end
  // sweeps below passed: `select * from pilot.waivers` returned no rows, so
  // there was nothing for them to find. The table was never narrowed, only
  // never populated here.
  //
  // The row is shaped the way a real one is. signed_by_name is byte-identical
  // to the pilot.parents row for the same reason the emergency contact above
  // is, and parent_id names Guardian B outright -- so a note on this row is
  // already keyed to the guardian it concerns without a reader having to join
  // anything.
  await db.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
        signed_at, consent_version, status, notes, parent_id)
     values ($1, '77777777-6666-4555-8444-333333333333', $2, 'photo_media', 'Guardian B', 'parent',
             now(), 'v1', 'signed', $3, 'par-b')`,
    [ORG, ATHLETE, 'Countersigned after a call to 555-0200; welfare lead aware of the household situation.'],
  );

  // #1558: Guardian A's OWN consent row, and a paper form staff entered that
  // is keyed to no guardian record but signed in Guardian B's name. Older
  // than the row above, so that one stays first in every read.
  await db.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
        signed_at, consent_version, status, notes, parent_id, created_at)
     values
       ($1, '77777777-6666-4555-8444-aaaaaaaaaaaa', $2, 'photo_media', 'Guardian A', 'parent',
        now(), 'v1', 'declined', 'Guardian A declined on the phone.', 'par-a', now() - interval '1 day'),
       ($1, '77777777-6666-4555-8444-bbbbbbbbbbbb', $2, 'general', 'Guardian B', 'parent',
        now(), 'v1', 'signed', 'Paper form, filed by the front desk.', null, now() - interval '2 days'),
       -- Guardian B's EARLIER decision: history, which the co-guardian must not read.
       ($1, '77777777-6666-4555-8444-cccccccccccc', $2, 'photo_media', 'Guardian B', 'parent',
        now() - interval '3 days', 'v1', 'withdrawn', 'Withdrawn at the desk.', 'par-b', now() - interval '3 days')`,
    [ORG, ATHLETE],
  );

  // The shared coach_observations bus, with one row of each audience: a
  // guardian-authored barrier report written to a coach in confidence, a
  // message addressed to a guardian, and an ordinary training note.
  await db.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
     values
       ($1, '10000000-0000-4000-8000-000000000001', $2, 'acct-coach', 'home_barrier',
        'Guardian B reports no transport on Tuesdays; reachable on 555-0200.'),
       ($1, '10000000-0000-4000-8000-000000000002', $2, 'acct-coach', 'parent_message',
        'Please bring the medical form on Thursday.'),
       ($1, '10000000-0000-4000-8000-000000000003', $2, 'acct-coach', 'coach_observation',
        'Guard drops on the exit in round three.')`,
    [ORG, ATHLETE],
  );

  await db.query(
    `insert into pilot.intake_cases
       (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id)
     values ($1, $2, 'pending_review', $3, 'Registration', 'acct-admin')`,
    [ORG, CASE_ID, ATHLETE],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  domainGet = (await import('@/app/api/pilot/intake/domain-get/route')).POST;
  getIntakeCaseAggregate = (await import('./intake')).getIntakeCaseAggregate;
  casesGet = (await import('@/app/api/pilot/intake/cases/get/route')).POST;
  holdsGet = (await import('@/app/api/pilot/training-holds/route')).GET;
  safetyGet = (await import('@/app/api/pilot/parent/safety/route')).GET;
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

/* ── The row really does carry contact data ──────────────────────────────────
   A negative assertion is only worth as much as the proof that the thing it
   denies exists at all. If the seed were wrong -- no phone, no email -- every
   "must not contain" below would pass over an empty table and prove nothing. */
describe('the fixture', () => {
  it('stores a real phone, email and account_id on both guardians', async () => {
    const rows = await db.query<{ full_name: string; phone: string; email: string; account_id: string }>(
      'select full_name, phone, email, account_id from pilot.parents where organization_id = $1 order by parent_id',
      [ORG],
    );

    expect(rows.rows).toEqual([
      { full_name: 'Guardian A', phone: '555-0100', email: 'guardian.a@example.test', account_id: 'acct-guardian-a' },
      { full_name: 'Guardian B', phone: '555-0200', email: 'guardian.b@example.test', account_id: 'acct-guardian-b' },
    ]);
  });
});

describe('POST /api/pilot/intake/domain-get', () => {
  /* THE CHILD (#1558). An athlete reading their own record gets both
     guardians by name and relationship -- and no record id: parent_id is
     `par-` plus an email-shaped account id. */
  it('gives the athlete both guardians by name, with no id and no number', async () => {
    const guardians = await readGuardiansVia(AS.athlete());

    // Equality on the whole row, not a check that some key is absent: a
    // containment assertion would pass over a row that grew a new column
    // tomorrow.
    expect(guardians).toEqual([
      { full_name: 'Guardian B', relationship_to_athlete: 'father' },
      { full_name: 'Guardian A', relationship_to_athlete: 'mother' },
    ]);
  });

  /* THE OTHER HOUSEHOLD (#1558; OD-2026-10-12-024: each guardian sees only
     their own). Guardian A is legitimately here. What they leave with is their
     own row, and that a co-guardian exists and is the child's father -- not
     the name, and not the id the email used to ride out in. */
  it('gives Guardian A their own row marked you, and of Guardian B only the relationship', async () => {
    const guardians = await readGuardiansVia(AS.guardianA());

    expect(guardians).toEqual([
      { you: true, full_name: 'Guardian A', relationship_to_athlete: 'mother' },
      { you: false, relationship_to_athlete: 'father' },
    ]);
    for (const leaked of ['Guardian B', 'par-', '555-0200', 'guardian.b@example.test', 'acct-guardian-b']) {
      expect(JSON.stringify(guardians)).not.toContain(leaked);
    }
  });

  /* And symmetrically, so this cannot pass by accident of row order. */
  it('gives Guardian B their own row marked you, and of Guardian A only the relationship', async () => {
    const guardians = await readGuardiansVia(AS.guardianB());

    expect(guardians).toEqual([
      { you: true, full_name: 'Guardian B', relationship_to_athlete: 'father' },
      { you: false, relationship_to_athlete: 'mother' },
    ]);
    for (const leaked of ['Guardian A', 'par-', '555-0100', 'guardian.a@example.test', 'acct-guardian-a']) {
      expect(JSON.stringify(guardians)).not.toContain(leaked);
    }
  });

  /* A guardian cannot read their OWN number back here either. That is not the
     point of the fix, but it is what the narrowing does, and it is stated so
     that a later widening "so a parent can see their own details" has to
     change a test that says why the column list is shared. */
  it('does not hand a guardian their own contact details back through this route', async () => {
    const guardians = await readGuardiansVia(AS.guardianA());

    expect(JSON.stringify(guardians)).not.toContain('555-0100');
  });

  /* THE OTHER HALF. Narrowing that also takes the number away from the person
     who has to make the call is not a fix, it is an outage with better press. */
  it('keeps the contact columns for the coach of record', async () => {
    const guardians = await readGuardiansVia(AS.coach());

    expect(guardians).toEqual([
      {
        parent_id: 'par-a',
        full_name: 'Guardian A',
        account_id: 'acct-guardian-a',
        phone: '555-0100',
        email: 'guardian.a@example.test',
        relationship_to_athlete: 'mother',
      },
      {
        parent_id: 'par-b',
        full_name: 'Guardian B',
        account_id: 'acct-guardian-b',
        phone: '555-0200',
        email: 'guardian.b@example.test',
        relationship_to_athlete: 'father',
      },
    ]);
  });

  it('keeps the contact columns for the organization admin', async () => {
    const guardians = await readGuardiansVia(AS.admin());

    for (const key of CONTACT_KEYS) {
      expect(Object.keys(guardians[0])).toContain(key);
    }
    expect(guardians[0].phone).toBe('555-0100');
  });

  /* CROSS-ORGANIZATION. A coach at another gym is refused before any
     projection question arises -- the gate, not the column list, is what stops
     this one, and it is asserted here so a change to either is visible. */
  it('refuses a coach from another organization outright', async () => {
    await expect(readGuardiansVia(AS.otherOrgCoach())).rejects.toThrow(/refused 4\d\d/);
  });

  it('refuses an athlete asking for a different athlete record', async () => {
    await expect(readGuardiansVia(AS.athlete(), OTHER_ATHLETE)).rejects.toThrow(/refused 4\d\d/);
  });

  /* THE PLATFORM OWNER is stopped twice over and reaches no guardian row at
     all: requireRole does not list the role, and assertActorCanAccessAthlete
     refuses it by name. Asserted rather than assumed, because "identity only"
     would be the wrong answer here -- the right answer is nothing. */
  it('refuses the platform owner, who has no business in one family record', async () => {
    await expect(readGuardiansVia(AS.platformOwner())).rejects.toThrow(/refused 4\d\d/);
  });
});

/* ── THE WHOLE RESPONSE, NOT THE GUARDIAN LIST ───────────────────────────────
   The narrowing above is worth nothing on its own if the same body carries the
   same numbers under another key. These assert the payload end to end. */
describe('the whole domain-get body', () => {
  it('contains no trace of the co-guardian anywhere, for Guardian A', async () => {
    const body = JSON.stringify(await readDomainGet(AS.guardianA()));

    for (const secret of GUARDIAN_B_SECRETS) {
      expect(body).not.toContain(secret);
    }
  });

  it('contains no trace of either guardian, for the athlete', async () => {
    const body = JSON.stringify(await readDomainGet(AS.athlete()));

    for (const secret of [...GUARDIAN_A_SECRETS, ...GUARDIAN_B_SECRETS]) {
      expect(body).not.toContain(secret);
    }
  });

  /* #1558 DONE-WHEN, on the whole body: no family reader receives any
     parent_id, in any key of any table of this answer. */
  it.each([
    ['Guardian A', AS.guardianA],
    ['Guardian B', AS.guardianB],
    ['the athlete', AS.athlete],
  ] as const)('contains no guardian id anywhere, for %s', async (_label, actor) => {
    const body = JSON.stringify(await readDomainGet(actor()));

    for (const id of ['par-a', 'par-b', 'parent_id']) {
      expect(body).not.toContain(id);
    }
  });

  /* ... and neither guardian receives the other's NAME, anywhere in the body:
     not from the guardian list, not from a waiver the other signed, not from a
     paper form, and not from the emergency contacts -- where the other parent
     is the ordinary entry, and is in this fixture. */
  it.each([
    ['Guardian A', AS.guardianA, 'Guardian B'],
    ['Guardian B', AS.guardianB, 'Guardian A'],
  ] as const)('contains the co-guardian\'s name nowhere, for %s', async (_label, actor, otherName) => {
    const body = await readDomainGet(actor());

    // Not vacuous: the tables the name used to arrive in are all populated.
    expect(body.guardians).toHaveLength(2);
    expect(body.emergency_contacts).toHaveLength(1);
    expect(body.waivers?.length).toBeGreaterThan(1);
    expect(JSON.stringify(body)).not.toContain(otherName);
  });

  /* Jason 2026-10-13, question card: "A: Relationship only (Recommended)". A
     parent reads that a contact is on file, how they are related to the child
     and whether they are the primary one -- not the name: the emergency
     contact here IS the other guardian. */
  it('tells a guardian the emergency contact\'s relationship and primary flag only', async () => {
    const body = await readDomainGet(AS.guardianA());

    expect(body.emergency_contacts).toEqual([{ relationship_to_athlete: 'father', is_primary: true }]);
    // The staff-only note is the one that says "do not call the father".
    expect(JSON.stringify(body.emergency_contacts)).not.toContain('welfare lead');
  });

  /* The emergency contact by name and relationship is the athlete's own
     record -- knowing who is called for you. The number is not. */
  it('names the emergency contact to the athlete without giving up the number or the note', async () => {
    const body = await readDomainGet(AS.athlete());

    expect(body.emergency_contacts).toEqual([{
      contact_id: '99999999-8888-4777-8666-555555555555',
      athlete_id: ATHLETE,
      full_name: 'Guardian B',
      relationship_to_athlete: 'father',
      is_primary: true,
    }]);
    expect(JSON.stringify(body.emergency_contacts)).not.toContain('welfare lead');
  });

  it('keeps the emergency number, email and note for the coach who has to make the call', async () => {
    const body = await readDomainGet(AS.coach());

    expect(body.emergency_contacts?.[0]).toEqual({
      contact_id: '99999999-8888-4777-8666-555555555555',
      athlete_id: ATHLETE,
      full_name: 'Guardian B',
      relationship_to_athlete: 'father',
      is_primary: true,
      phone: '555-0200',
      email: 'guardian.b@example.test',
      notes: 'Do not call this contact without speaking to the welfare lead first.',
    });
  });

  it('keeps them for the organization admin too', async () => {
    const body = await readDomainGet(AS.admin());

    expect(body.emergency_contacts?.[0].phone).toBe('555-0200');
    expect(body.emergency_contacts?.[0].email).toBe('guardian.b@example.test');
  });

  /* THE WAIVER, which is the third table of this body carrying a free-text
     staff note beside a guardian's name -- and the one the narrowing missed.
     The two sweeps above are what caught it, once this fixture carried a
     waiver at all. These say the same thing directly, so the property does
     not depend on a secret happening to be spelled into a note. */
  it('gives a guardian their own waiver whole, and of every other waiver the current status only', async () => {
    const body = await readDomainGet(AS.guardianA());

    // Equality on every row. Guardian A's own first; then what else is on
    // file, by type, as a status. OD-2026-10-05-024 item 4: the other
    // guardian's consent STATUS only -- no record id, date, scope flags or
    // name -- and the CURRENT one: Guardian B's earlier withdrawal is not
    // listed. The paper form is a status too: nothing on an unkeyed row says
    // it is not the other guardian's (the retention purge clears parent_id).
    expect(body.waivers).toEqual([
      {
        you: true,
        waiver_id: '77777777-6666-4555-8444-aaaaaaaaaaaa',
        athlete_id: ATHLETE,
        waiver_type: 'photo_media',
        signed_by_name: 'Guardian A',
        signed_by_role: 'parent',
        signed_at: expect.anything(),
        consent_version: 'v1',
        status: 'declined',
        covers_video: true,
        public_use_allowed: false,
        created_at: expect.anything(),
        updated_at: expect.anything(),
      },
      { you: false, waiver_type: 'general', status: 'signed' },
      { you: false, waiver_type: 'photo_media', status: 'signed' },
    ]);
    /* Named, as well as looped, and the loop is why. It reads the same list an
       edit would move a column OUT of, so it cannot see a column that has been
       promoted into the guardian's own set. These survive an edit to either
       list. */
    for (const waiver of body.waivers ?? []) {
      for (const column of [...WAIVER_STAFF_COLUMNS, 'notes', 'recorded_by_account_id', 'parent_id', 'organization_id']) {
        expect(Object.keys(waiver)).not.toContain(column);
      }
    }
  });

  it('gives Guardian B the mirror image: their own history whole, Guardian A\'s as a status', async () => {
    const body = await readDomainGet(AS.guardianB());

    expect(body.waivers?.map((waiver) => [waiver.you, waiver.waiver_type, waiver.status, waiver.signed_by_name])).toEqual([
      [true, 'photo_media', 'signed', 'Guardian B'],
      [true, 'photo_media', 'withdrawn', 'Guardian B'],
      [false, 'general', 'signed', undefined],
      [false, 'photo_media', 'declined', undefined],
    ]);
    expect(Object.keys(body.waivers?.[3] ?? {}).sort()).toEqual(['status', 'waiver_type', 'you']);
  });

  it('gives the athlete every waiver by the name it was signed under, with no guardian id and no note', async () => {
    const body = await readDomainGet(AS.athlete());

    expect(body.waivers).toHaveLength(4);
    for (const waiver of body.waivers ?? []) {
      expect(Object.keys(waiver).sort()).toEqual([...WAIVER_FAMILY_COLUMNS].sort());
    }
    expect(body.waivers?.map((waiver) => waiver.signed_by_name)).toEqual(['Guardian B', 'Guardian A', 'Guardian B', 'Guardian B']);
  });

  /* STAFF, UNCHANGED (#1558 stop condition): every column of the table, the
     record id and the note included, exactly as `select <all columns>` reads. */
  it.each([['the coach', AS.coach], ['the organization admin', AS.admin]] as const)(
    'gives %s every waiver column, parent_id and the staff note included',
    async (_label, actor) => {
      const body = await readDomainGet(actor());

      expect(body.waivers).toHaveLength(4);
      for (const waiver of body.waivers ?? []) {
        expect(Object.keys(waiver).sort()).toEqual([...WAIVER_IDENTITY_COLUMNS, ...WAIVER_STAFF_COLUMNS].sort());
      }
      expect(body.waivers?.map((waiver) => waiver.parent_id)).toEqual(['par-b', 'par-a', null, 'par-b']);
    },
  );

  /* THE MEDICAL INTAKE, and the reader who makes it different: this route
     admits 'athlete', and access.ts resolves that to a strict self-read. So
     the staff note about a child reached the child. */
  it('gives a guardian the medical record without the staff note on it', async () => {
    const body = await readDomainGet(AS.guardianA());
    const medical = body.medical_intake?.[0];

    // The child's own medical facts and their clinician stay: that is what a
    // guardian needs in order to act.
    expect(medical).toMatchObject({
      conditions: 'asthma',
      medications: 'inhaler',
      physician_name: 'Dr Reyes',
      physician_phone: '555-0300',
      clearance_status: 'cleared',
    });
    expect(Object.keys(medical ?? {})).not.toContain('notes');
  });

  it('gives the athlete their own record without the staff note either', async () => {
    const body = await readDomainGet(AS.athlete());

    expect(body.medical_intake).toHaveLength(1);
    expect(Object.keys(body.medical_intake?.[0] ?? {})).not.toContain('notes');
  });

  it('keeps the medical note for the coach and the organization admin', async () => {
    const asCoach = await readDomainGet(AS.coach());
    const asAdmin = await readDomainGet(AS.admin());

    expect(asCoach.medical_intake?.[0].notes).toContain('welfare lead');
    expect(asAdmin.medical_intake?.[0].notes).toContain('welfare lead');
  });

  it('gives a guardian and an athlete attendance without the staff note', async () => {
    const asGuardian = await readDomainGet(AS.guardianA());
    const asAthlete = await readDomainGet(AS.athlete());

    // Still a real attendance row: the date and whether they were there.
    expect(asGuardian.attendance?.[0]).toMatchObject({ status: 'present' });
    expect(Object.keys(asGuardian.attendance?.[0] ?? {})).not.toContain('notes');
    expect(Object.keys(asAthlete.attendance?.[0] ?? {})).not.toContain('notes');
  });

  it('keeps the attendance note for the coach', async () => {
    const asCoach = await readDomainGet(AS.coach());
    expect(asCoach.attendance?.[0].notes).toContain('welfare lead');
  });

  /* THE SECOND RATER, which is not a note and is the reason this table needed
     more than a notes column moved. The row records that one staff member
     scored this child 4 and another scored them 2. It exists so the
     reliability study collects itself from live use; it was never a result
     issued to anyone, and it reached the family and the child. */
  it('gives a guardian and an athlete the assessment without the raters or the second rating', async () => {
    const asGuardian = await readDomainGet(AS.guardianA());
    const asAthlete = await readDomainGet(AS.athlete());

    for (const body of [asGuardian, asAthlete]) {
      const assessment = body.assessments?.[0];
      // Still a real assessment: the result and what it was.
      expect(assessment).toMatchObject({ assessment_type: 'intake_assessment', assessor_role: 'coach' });
      expect(assessment?.result).toEqual({ score: 4 });

      const keys = Object.keys(assessment ?? {});
      expect(keys).not.toContain('conditions_note');
      expect(keys).not.toContain('second_rater_result');
      expect(keys).not.toContain('second_rater_account_id');
      expect(keys).not.toContain('assessor_account_id');
    }

    // Said as values too, because that is how these actually escape: the
    // note carries a phone number and the second rating carries a
    // contradiction of the score the family is reading.
    expect(JSON.stringify(asGuardian.assessments)).not.toContain('555-0200');
    expect(JSON.stringify(asGuardian.assessments)).not.toContain('disagrees');
    expect(JSON.stringify(asAthlete.assessments)).not.toContain('555-0200');
    expect(JSON.stringify(asAthlete.assessments)).not.toContain('disagrees');
  });

  it('keeps the whole assessment for the coach and the organization admin', async () => {
    const asCoach = await readDomainGet(AS.coach());
    const asAdmin = await readDomainGet(AS.admin());

    expect(asCoach.assessments?.[0].conditions_note).toContain('welfare lead');
    expect(asCoach.assessments?.[0].second_rater_result).toContain('disagrees');
    expect(asAdmin.assessments?.[0].second_rater_result).toContain('disagrees');
  });

  it('gives a guardian and an athlete readiness without the staff account that entered it', async () => {
    const asGuardian = await readDomainGet(AS.guardianA());
    const asAthlete = await readDomainGet(AS.athlete());

    for (const body of [asGuardian, asAthlete]) {
      const readiness = body.readiness?.[0];
      // Still a real readiness row: the score and the category.
      expect(readiness).toMatchObject({ category: 'green' });
      expect(Object.keys(readiness ?? {})).not.toContain('recorded_by_account_id');
    }

    expect(JSON.stringify(asGuardian.readiness)).not.toContain('acct-coach');
    expect(JSON.stringify(asAthlete.readiness)).not.toContain('acct-coach');
  });

  it('keeps recorded_by_account_id for the coach', async () => {
    const asCoach = await readDomainGet(AS.coach());
    expect(asCoach.readiness?.[0].recorded_by_account_id).toBe('acct-coach');
  });

  it('keeps the waiver note for the coach and the organization admin', async () => {
    const asCoach = await readDomainGet(AS.coach());
    const asAdmin = await readDomainGet(AS.admin());

    expect(asCoach.waivers?.[0].notes).toContain('555-0200');
    expect(asAdmin.waivers?.[0].notes).toContain('555-0200');
  });
});

/* THE ALLOWLIST AGAINST THE REAL TABLE.
   The waiver column lists are an allowlist, which fails closed on a column a
   later migration adds: the column simply stops reaching a guardian. That is
   the right direction and the wrong way to find out. This pins the two column
   sets against pilot.waivers as the database actually has it, so adding a
   column to that table fails HERE -- with a message naming it -- instead of
   silently dropping a field from every guardian and athlete response. */
describe('the waiver allowlist covers the whole table', () => {
  it('names every column of pilot.waivers exactly once, and no column twice', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'waivers'`,
    );
    const liveColumns = live.rows.map((row) => row.column_name).sort();

    const declared = [...WAIVER_IDENTITY_COLUMNS, ...WAIVER_STAFF_COLUMNS].sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(liveColumns);
  });

  it('keeps every staff column out of the identity set', () => {
    /* Written per-column against 'notes', which meant it watched the one
       column somebody thought of. It did not watch DIRECTION: when
       recorded_by_account_id was added, moving it into the guardian-visible
       list passed all 41 tests here. The coverage test above only asks that a
       column be listed SOMEWHERE, so the two together said nothing about
       which side of the line a new column landed on.

       Driven off WAIVER_STAFF_COLUMNS now, so it covers whatever is added to
       it next rather than only what was named the day it was written. */
    expect(WAIVER_STAFF_COLUMNS.length).toBeGreaterThan(0);
    for (const column of WAIVER_STAFF_COLUMNS) {
      expect(WAIVER_IDENTITY_COLUMNS).not.toContain(column);
    }
    expect(WAIVER_STAFF_COLUMNS).toContain('notes');
    // A staff account_id resolves to a login email on this platform, so this
    // one is a staff member's address, not just an opaque key.
    expect(WAIVER_STAFF_COLUMNS).toContain('recorded_by_account_id');
  });
});

/* #1558 DONE-WHEN: A NEW GUARDIAN COLUMN IS A DECISION.
   A family reader's guardian is built from GUARDIAN_FAMILY_COLUMNS and
   nothing else. Every column of pilot.parents and pilot.guardian_links has to
   be on that list or on the withheld list, so a migration that adds one fails
   HERE, with the column named, until somebody places it. */
describe('the family guardian lists cover both guardian tables', () => {
  it('places every column of pilot.parents and pilot.guardian_links on exactly one list', async () => {
    const live = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'pilot' and table_name in ('parents', 'guardian_links')`,
    );
    const columnsOf = (table: string) =>
      live.rows.filter((row) => row.table_name === table).map((row) => row.column_name).sort();

    // Each table by name, so a new column whose name the OTHER table already
    // has (an athlete_id on pilot.parents, say) is still a new column here.
    expect(columnsOf('parents')).toEqual(
      ['account_id', 'created_at', 'email', 'full_name', 'organization_id', 'parent_id', 'phone', 'updated_at'],
    );
    expect(columnsOf('guardian_links')).toEqual(
      ['athlete_id', 'created_at', 'organization_id', 'parent_id', 'relationship_to_athlete', 'updated_at'],
    );

    const declared = [...GUARDIAN_FAMILY_COLUMNS, ...GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS].sort();
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual([...new Set(live.rows.map((row) => row.column_name))].sort());
  });

  it('keeps every identifier and contact column on the withheld side', () => {
    expect([...GUARDIAN_FAMILY_COLUMNS]).toEqual(['full_name', 'relationship_to_athlete']);
    for (const column of ['parent_id', 'account_id', 'phone', 'email']) {
      expect(GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS).toContain(column);
    }
  });

  it('builds the family waiver from columns pilot.waivers really has', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'waivers'`,
    );
    const liveColumns = live.rows.map((row) => row.column_name);

    for (const column of WAIVER_FAMILY_COLUMNS) {
      expect(liveColumns).toContain(column);
      expect(WAIVER_STAFF_COLUMNS as readonly string[]).not.toContain(column);
    }
    expect(WAIVER_FAMILY_COLUMNS as readonly string[]).not.toContain('parent_id');
    expect(WAIVER_FAMILY_COLUMNS as readonly string[]).not.toContain('organization_id');
  });
});

/* The same guard for the two tables whose migrations outgrew their reads.
   These two are the reason the guard matters: pilot.assessments went from
   seven columns to eighteen and pilot.readiness from seven to twelve, all
   after both reads of each were written, and every added column reached a
   family the day its migration applied. A list checked against the live table
   turns the NEXT such migration into a red test with the column named in it,
   instead of a silent disclosure or a silently dropped field. */
describe('the assessment and readiness allowlists cover their whole tables', () => {
  it('names every column of pilot.assessments exactly once, and no column twice', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'assessments'`,
    );
    const liveColumns = live.rows.map((row) => row.column_name).sort();
    const declared = [...ASSESSMENT_IDENTITY_COLUMNS, ...ASSESSMENT_STAFF_COLUMNS].sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(liveColumns);
  });

  it('names every column of pilot.readiness exactly once, and no column twice', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'readiness'`,
    );
    const liveColumns = live.rows.map((row) => row.column_name).sort();
    const declared = [...READINESS_IDENTITY_COLUMNS, ...READINESS_STAFF_COLUMNS].sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(liveColumns);
  });

  it('keeps the rater identities and the second rating out of the identity set', () => {
    for (const column of [
      'assessor_account_id',
      'second_rater_account_id',
      'second_rater_result',
      'conditions_note',
    ]) {
      expect(ASSESSMENT_IDENTITY_COLUMNS).not.toContain(column);
      expect(ASSESSMENT_STAFF_COLUMNS).toContain(column);
    }
    expect(READINESS_IDENTITY_COLUMNS).not.toContain('recorded_by_account_id');
    expect(READINESS_STAFF_COLUMNS).toContain('recorded_by_account_id');
  });
});

/* The second read of pilot.parents, on the same rows. It takes its reader as an
   argument rather than off a request, so the risk here is a caller that passes
   none -- which is why the default is asserted as identity-only. */
describe('getIntakeCaseAggregate', () => {
  it('gives the athlete both guardians by name, with no id', async () => {
    const guardians = await readGuardiansViaAggregate(AS.athlete());

    expect(guardians).toEqual([
      { full_name: 'Guardian B', relationship_to_athlete: 'father' },
      { full_name: 'Guardian A', relationship_to_athlete: 'mother' },
    ]);
  });

  it('gives each guardian their own row and only the relationship of the other, in both directions', async () => {
    expect(await readGuardiansViaAggregate(AS.guardianA())).toEqual([
      { you: true, full_name: 'Guardian A', relationship_to_athlete: 'mother' },
      { you: false, relationship_to_athlete: 'father' },
    ]);
    expect(await readGuardiansViaAggregate(AS.guardianB())).toEqual([
      { you: true, full_name: 'Guardian B', relationship_to_athlete: 'father' },
      { you: false, relationship_to_athlete: 'mother' },
    ]);
  });

  it('keeps the contact columns for a coach and for an organization admin', async () => {
    for (const actor of [AS.coach(), AS.admin()]) {
      const guardians = await readGuardiansViaAggregate(actor);
      expect(guardians[0].phone).toBe('555-0100');
      expect(guardians[0].email).toBe('guardian.a@example.test');
      expect(guardians[0].account_id).toBe('acct-guardian-a');
    }
  });

  /* STAFF, UNCHANGED: the whole row, in the shape this read has always had. */
  it('gives the coach the same guardian rows as before, athlete_id included', async () => {
    expect(await readGuardiansViaAggregate(AS.coach())).toEqual([
      {
        parent_id: 'par-a', full_name: 'Guardian A', account_id: 'acct-guardian-a', phone: '555-0100',
        email: 'guardian.a@example.test', relationship_to_athlete: 'mother', athlete_id: ATHLETE,
      },
      {
        parent_id: 'par-b', full_name: 'Guardian B', account_id: 'acct-guardian-b', phone: '555-0200',
        email: 'guardian.b@example.test', relationship_to_athlete: 'father', athlete_id: ATHLETE,
      },
    ]);
  });

  /* No reader named means no reader trusted. A caller that forgets the context
     argument learns that two guardians exist and how they are related: no
     name, no id, and the waivers as a status. */
  it('falls to the closed answer when no reader is named at all', async () => {
    const aggregate = await readAggregate(null);

    expect(aggregate?.guardians).toEqual([
      { you: false, relationship_to_athlete: 'father' },
      { you: false, relationship_to_athlete: 'mother' },
    ]);
    expect(aggregate?.emergency_contacts).toEqual([{ relationship_to_athlete: 'father', is_primary: true }]);
    for (const leaked of ['par-a', 'par-b', 'parent_id', 'Guardian A', 'Guardian B']) {
      expect(JSON.stringify(aggregate)).not.toContain(leaked);
    }
  });

  /* #1558 done-when on the whole aggregate, as on the route. */
  it.each([
    ['Guardian A', AS.guardianA],
    ['Guardian B', AS.guardianB],
    ['the athlete', AS.athlete],
  ] as const)('contains no guardian id anywhere, for %s', async (_label, actor) => {
    const body = JSON.stringify(await readAggregate(actor()));

    for (const id of ['par-a', 'par-b', 'parent_id']) {
      expect(body).not.toContain(id);
    }
  });

  it.each([
    ['Guardian A', AS.guardianA, 'Guardian B'],
    ['Guardian B', AS.guardianB, 'Guardian A'],
  ] as const)('contains the co-guardian\'s name nowhere, for %s', async (_label, actor, otherName) => {
    const aggregate = await readAggregate(actor());

    expect(aggregate?.guardians).toHaveLength(2);
    expect(aggregate?.emergency_contacts).toEqual([{ relationship_to_athlete: 'father', is_primary: true }]);
    expect(JSON.stringify(aggregate)).not.toContain(otherName);
  });

  /* The same three scopings the route applies, on the same rows. This function
     had one of the three. */
  /* THE WHOLE AGGREGATE, NOT ONE KEY OF IT.
     domain-get has had an end-to-end sweep since this file was written; this
     function never did, and only its guardian list and emergency contacts
     were ever asserted. That is exactly how pilot.waivers stayed on `select *`
     here after the route was narrowed: no test read the rest of the body. A
     sweep costs one assertion and covers every table the aggregate grows. */
  it('contains no trace of the co-guardian anywhere, for Guardian A', async () => {
    const body = JSON.stringify(await readAggregate(AS.guardianA()));

    for (const secret of GUARDIAN_B_SECRETS) {
      expect(body).not.toContain(secret);
    }
  });

  it('contains no trace of either guardian, for the athlete', async () => {
    const body = JSON.stringify(await readAggregate(AS.athlete()));

    for (const secret of [...GUARDIAN_A_SECRETS, ...GUARDIAN_B_SECRETS]) {
      expect(body).not.toContain(secret);
    }
  });

  it('narrows the waiver for a guardian and an athlete, and keeps the note for a coach', async () => {
    const asGuardian = await readAggregate(AS.guardianA());
    const asAthlete = await readAggregate(AS.athlete());
    const asCoach = await readAggregate(AS.coach());

    const waiverOf = (aggregate: Awaited<ReturnType<typeof readAggregate>>) =>
      ((aggregate?.waivers ?? []) as Record<string, unknown>[])[0] ?? {};

    expect(Object.keys(waiverOf(asGuardian))).not.toContain('notes');
    expect(Object.keys(waiverOf(asAthlete))).not.toContain('notes');
    // Still a real waiver, not an empty object.
    expect(waiverOf(asGuardian).waiver_type).toBe('photo_media');
    expect(waiverOf(asCoach).notes).toContain('555-0200');
  });

  it('narrows the emergency contact for a guardian and keeps it for a coach', async () => {
    const asGuardian = await readAggregate(AS.guardianA());
    const asCoach = await readAggregate(AS.coach());

    expect(JSON.stringify(asGuardian?.emergency_contacts)).not.toContain('555-0200');
    expect(JSON.stringify(asGuardian?.emergency_contacts)).not.toContain('welfare lead');
    expect(JSON.stringify(asCoach?.emergency_contacts)).toContain('555-0200');
  });

  /* The note-type filter the sibling route has had since it was written, and
     this function never received -- so the guardian-authored barrier report
     went to the other household and to the child. */
  it('filters the shared coach_observations bus by reader, as the route does', async () => {
    const asGuardian = await readAggregate(AS.guardianA());
    const asAthlete = await readAggregate(AS.athlete());
    const asCoach = await readAggregate(AS.coach());

    const noteTypes = (aggregate: Awaited<ReturnType<typeof readAggregate>>) =>
      ((aggregate?.coach_observations ?? []) as Array<{ note_type: string }>)
        .map((row) => row.note_type).sort();

    // A guardian gets the message addressed to guardians, and nothing else.
    expect(noteTypes(asGuardian)).toEqual(['parent_message']);
    // The athlete gets training content only -- not the barrier report their
    // guardian wrote about the home, and not the message to the household.
    expect(noteTypes(asAthlete)).toEqual(['coach_observation']);
    // Staff still see the whole bus, which is what it is for.
    expect(noteTypes(asCoach)).toEqual(['coach_observation', 'home_barrier', 'parent_message']);

    // The barrier report carries a phone number in its free text. Said as a
    // value, because that is how this one actually escapes.
    expect(JSON.stringify(asGuardian?.coach_observations)).not.toContain('555-0200');
    expect(JSON.stringify(asAthlete?.coach_observations)).not.toContain('555-0200');
  });
});

/* Issue #1475 Part C. pilot.coach_observations was the last table in both
   intake reads still on `select *`: every note a guardian or an athlete could
   read arrived with coach_account_id, the author's account id. Read here from
   the real table, so the column list is proven to be SQL the database accepts
   and the values are proven absent from what a family receives. */
describe('the coach-observation projection, against the real table', () => {
  const rows = (body: unknown): Record<string, unknown>[] =>
    ((body as { coach_observations?: Record<string, unknown>[] } | null)?.coach_observations ?? []);

  it('gives a guardian and an athlete the note without the account that wrote it, on both reads', async () => {
    const bodies = [
      await readDomainGet(AS.guardianA()),
      await readDomainGet(AS.athlete()),
      await readAggregate(AS.guardianA()),
      await readAggregate(AS.athlete()),
    ];

    for (const body of bodies) {
      // Each of these readers has exactly one note of their own audience.
      expect(rows(body)).toHaveLength(1);
      expect(Object.keys(rows(body)[0]).sort()).toEqual([...COACH_OBSERVATION_IDENTITY_COLUMNS].sort());
      expect(JSON.stringify(rows(body))).not.toContain('acct-coach');
    }
  });

  it('keeps the author and every other column for the coach and the organization admin, on both reads', async () => {
    const bodies = [
      await readDomainGet(AS.coach()),
      await readDomainGet(AS.admin()),
      await readAggregate(AS.coach()),
      await readAggregate(AS.admin()),
    ];

    for (const body of bodies) {
      expect(rows(body)).toHaveLength(3);
      for (const row of rows(body)) {
        expect(row.coach_account_id).toBe('acct-coach');
        expect(Object.keys(row).sort()).toEqual(
          [...COACH_OBSERVATION_IDENTITY_COLUMNS, ...COACH_OBSERVATION_STAFF_COLUMNS].sort(),
        );
      }
    }
  });

  it('names every column of pilot.coach_observations exactly once, so staff read what `select *` read', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'coach_observations'`,
    );
    const liveColumns = live.rows.map((row) => row.column_name).sort();

    const declared = [...COACH_OBSERVATION_IDENTITY_COLUMNS, ...COACH_OBSERVATION_STAFF_COLUMNS].sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(liveColumns);
  });

  it('keeps the author columns out of the identity set', () => {
    for (const column of COACH_OBSERVATION_STAFF_COLUMNS) {
      expect(COACH_OBSERVATION_IDENTITY_COLUMNS).not.toContain(column);
    }
    expect(COACH_OBSERVATION_STAFF_COLUMNS).toContain('coach_account_id');
    expect(COACH_OBSERVATION_STAFF_COLUMNS).toContain('author_role');
  });
});

/* #1558: THE OTHER FIXED ROUTE, END TO END. getIntakeCaseAggregate is driven
   directly above; this is POST /api/pilot/intake/cases/get itself, with its
   real gate, as each of the two guardians and as the athlete. */
describe('POST /api/pilot/intake/cases/get', () => {
  it.each([
    ['Guardian A', AS.guardianA, 'Guardian B', { you: true, full_name: 'Guardian A', relationship_to_athlete: 'mother' }, 'father'],
    ['Guardian B', AS.guardianB, 'Guardian A', { you: true, full_name: 'Guardian B', relationship_to_athlete: 'father' }, 'mother'],
  ] as const)(
    'gives %s their own guardian row, no guardian id, and the other guardian\'s name nowhere',
    async (_label, actor, otherName, ownRow, otherRelationship) => {
      const body = await readCase(actor());

      expect(body.found).toBe(true);
      expect(body.aggregate?.guardians).toEqual([ownRow, { you: false, relationship_to_athlete: otherRelationship }]);
      expect(body.aggregate?.emergency_contacts).toEqual([{ relationship_to_athlete: 'father', is_primary: true }]);
      expect(body.aggregate?.waivers.length).toBeGreaterThan(1);
      for (const leaked of ['par-a', 'par-b', 'parent_id', otherName]) {
        expect(JSON.stringify(body)).not.toContain(leaked);
      }
    },
  );

  it('gives the athlete both guardians by name and no guardian id', async () => {
    const body = await readCase(AS.athlete());

    expect(body.aggregate?.guardians).toEqual([
      { full_name: 'Guardian B', relationship_to_athlete: 'father' },
      { full_name: 'Guardian A', relationship_to_athlete: 'mother' },
    ]);
    for (const leaked of ['par-a', 'par-b', 'parent_id']) {
      expect(JSON.stringify(body)).not.toContain(leaked);
    }
  });

  it('gives the coach the guardian rows whole, as before', async () => {
    const body = await readCase(AS.coach());

    expect(body.aggregate?.guardians).toEqual([
      {
        parent_id: 'par-a', full_name: 'Guardian A', account_id: 'acct-guardian-a', phone: '555-0100',
        email: 'guardian.a@example.test', relationship_to_athlete: 'mother', athlete_id: ATHLETE,
      },
      {
        parent_id: 'par-b', full_name: 'Guardian B', account_id: 'acct-guardian-b', phone: '555-0200',
        email: 'guardian.b@example.test', relationship_to_athlete: 'father', athlete_id: ATHLETE,
      },
    ]);
  });
});

/* #1558 ITEM THREE, T1: THE NAME OF THE STAFF MEMBER WHO PLACED A HOLD.
   The staff name falls back to the account id when the login email gives no
   name, and keeps the login's digits; the account id is the login email unless
   somebody chose otherwise. An athlete or a guardian reading the hold is given
   the family name reader's name instead (OD-2026-10-06-025 ruling 2): digits
   dropped, "Your coach" when nothing is left. The placers here are real account
   rows, read by the real reader. */
describe('the staff name on a training hold, for a family reader', () => {
  const NAMELESS = 'nameless.4411@example.test';
  const LETTERLESS = 'letterless.9911@example.test';
  const NAMED = 'named.coach@example.test';
  const HANDLE = 'mike1987';
  const ADMIN_NAMED = 'admin.named@example.test';
  const ADMIN_NAMELESS = 'admin.nameless.5521@example.test';

  /* The placer's digits must be in no part of the reply a person could read,
     but a timestamp's microseconds or a generated uuid can hold any four
     digits: "placed_at ... 36.991175+00" failed #1663 with correct code
     (F-124). So the digits are looked for in every key and string value
     except those two shapes; the whole id is still looked for everywhere. */
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function readableStrings(raw: string): string[] {
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (!TIMESTAMP.test(value) && !UUID.test(value)) found.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          found.push(key);
          walk(inner);
        }
      }
    };
    walk(JSON.parse(raw));
    return found;
  }
  function digitsShown(raw: string, digits: RegExp): string[] {
    return readableStrings(raw).filter((text) => digits.test(text));
  }

  it('the digit check skips a timestamp and a uuid, and still finds the digits anywhere else', () => {
    const raw = JSON.stringify({
      placed_at: '2026-10-17 12:34:36.991175+00',
      updated_at: '2026-10-17T12:34:36.441100Z',
      event_id: '0f3a4411-9911-4c1e-8a55-215521000000',
      hold: { placed_by_name: 'Coach 4411' },
    });
    expect(raw).toMatch(/4411|9911/);
    expect(digitsShown(raw, /4411|9911/)).toEqual(['Coach 4411']);
  });

  beforeAll(async () => {
    for (const [accountId, loginEmail, role] of [
      [NAMELESS, null, 'coach'],
      [LETTERLESS, '9911-07@example.test', 'coach'],
      [NAMED, 'jane.okafor@example.test', 'coach'],
      [HANDLE, 'mike1987@example.test', 'coach'],
      [ADMIN_NAMED, 'pat.reyes@example.test', 'organization_admin'],
      [ADMIN_NAMELESS, null, 'organization_admin'],
    ] as const) {
      await db.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email)
         values ($1, $4, $2, 'microsoft', $3)`,
        [accountId, ORG, loginEmail, role],
      );
    }
    // The placers' digits are put in the hold's own timestamps on purpose
    // (".441199", ".5521"), so the digit checks below cannot pass by luck of
    // the clock (F-124).
    await db.query(
      `insert into pilot.training_holds
         (organization_id, hold_id, athlete_id, scope, reason_category, reason_text, athlete_explanation,
          lift_condition_text, placed_by_account_id, placed_by_role, placed_at, expires_at)
       values ($1, 'hold-names-1', $2, 'contact_only', 'medical', 'Staff detail.', 'Rest the hand this week.',
               'Clearance from the doctor.', $3, 'coach',
               date_trunc('second', now()) - interval '1 minute' + interval '441199 microseconds',
               date_trunc('second', now()) + interval '30 days' + interval '552100 microseconds')`,
      [ORG, ATHLETE, NAMELESS],
    );
  });

  async function readHold(actor: PilotPrincipal): Promise<{ status: number; raw: string }> {
    mockRequirePrincipal.mockResolvedValue(actor);
    const response = await holdsGet(new NextRequest(`http://localhost/api/pilot/training-holds?athlete_id=${ATHLETE}`));
    return { status: response.status, raw: await response.text() };
  }

  async function placedBy(accountId: string, role: 'coach' | 'organization_admin' = 'coach') {
    await db.query(
      `update pilot.training_holds set placed_by_account_id = $3, placed_by_role = $4
       where organization_id = $1 and hold_id = $2`,
      [ORG, 'hold-names-1', accountId, role],
    );
  }

  async function readSafetyHoldName(actor: PilotPrincipal): Promise<{ name: unknown; raw: string }> {
    mockRequirePrincipal.mockResolvedValue(actor);
    const response = await safetyGet(new NextRequest('http://localhost/api/pilot/parent/safety'));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const item = (JSON.parse(raw).items as Array<{ hold: { placed_by_name: unknown } | null }>)
      .find((i) => i.hold !== null);
    return { name: item?.hold?.placed_by_name, raw };
  }

  it.each([
    ['no login email', NAMELESS],
    ['a login email with no letters in it', LETTERLESS],
  ])('a placer with %s is "Your coach" to the athlete and to each guardian, never the id', async (_label, placer) => {
    await placedBy(placer);

    for (const actor of [AS.athlete(), AS.guardianA(), AS.guardianB()]) {
      const { status, raw } = await readHold(actor);
      expect(status).toBe(200);
      expect(JSON.parse(raw).hold.placed_by_name).toBe('Your coach');
      expect(raw).not.toContain(placer);
      // The digits are really there, in the timestamp the check must skip.
      expect(raw).toMatch(/\.441199/);
      expect(digitsShown(raw, /4411|9911/)).toEqual([]);
    }
  });

  it('a placer whose account id IS their login handle is named without its digits, never by the id', async () => {
    await placedBy(HANDLE);

    for (const actor of [AS.athlete(), AS.guardianA()]) {
      const { raw } = await readHold(actor);
      expect(JSON.parse(raw).hold.placed_by_name).toBe('Coach Mike');
      expect(raw).not.toMatch(/mike1987/i);
    }
  });

  it('control: a placer whose email gives a name is named by it, to the same readers', async () => {
    await placedBy(NAMED);

    for (const actor of [AS.athlete(), AS.guardianA()]) {
      const { raw } = await readHold(actor);
      expect(JSON.parse(raw).hold.placed_by_name).toBe('Coach Jane Okafor');
      expect(raw).not.toContain(NAMED);
    }
  });

  /* Codex on #1592: a hold an ORGANIZATION ADMIN placed is not "Coach ..." to
     the family -- that sends them to the wrong person about a safety decision.
     Named without the title, or "The gym" (PROPOSED) when nothing is left. */
  it('an organization admin placer is named without "Coach", on training-holds and on parent/safety', async () => {
    await placedBy(ADMIN_NAMED, 'organization_admin');

    for (const actor of [AS.athlete(), AS.guardianA(), AS.guardianB()]) {
      const { raw } = await readHold(actor);
      expect(JSON.parse(raw).hold.placed_by_name).toBe('Pat Reyes');
      expect(raw).not.toContain(ADMIN_NAMED);
    }
    for (const actor of [AS.guardianA(), AS.guardianB()]) {
      const { name, raw } = await readSafetyHoldName(actor);
      expect(name).toBe('Pat Reyes');
      expect(raw).not.toContain(ADMIN_NAMED);
    }
  });

  it('an organization admin placer with no usable name is "The gym", never "Your coach" and never the id', async () => {
    await placedBy(ADMIN_NAMELESS, 'organization_admin');

    for (const actor of [AS.athlete(), AS.guardianA()]) {
      const { raw } = await readHold(actor);
      expect(JSON.parse(raw).hold.placed_by_name).toBe('The gym');
      expect(raw).not.toContain(ADMIN_NAMELESS);
      expect(raw).not.toMatch(/admin\.nameless/);
      expect(raw).toMatch(/\.5521/);
      expect(digitsShown(raw, /5521/)).toEqual([]);
    }
    const { name, raw } = await readSafetyHoldName(AS.guardianB());
    expect(name).toBe('The gym');
    expect(raw).not.toContain(ADMIN_NAMELESS);
    expect(raw).not.toMatch(/admin\.nameless/);
    expect(digitsShown(raw, /5521/)).toEqual([]);
  });

  it('control: the coach reads the hold as before, the placer\'s account id included', async () => {
    await placedBy(NAMELESS);

    const { status, raw } = await readHold(AS.coach());
    expect(status).toBe(200);
    expect(raw).toContain(NAMELESS);
  });
});

/* #1558 ITEM THREE, T5: THE SESSION AN ATHLETE IS SENT. A named list
   (familyRecordView.ts FAMILY_SESSION_FIELDS); every column of pilot.sessions is
   on it or on the withheld list, so a migration that adds one fails HERE until
   somebody places it. */
describe('the family session list covers pilot.sessions', () => {
  it('places every column of pilot.sessions on exactly one list', async () => {
    const live = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'sessions'`,
    );
    const declared = [...FAMILY_SESSION_FIELDS, ...SESSION_WITHHELD_FROM_FAMILY_FIELDS].sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(live.rows.map((row) => row.column_name).sort());
    expect(FAMILY_SESSION_FIELDS as readonly string[]).not.toContain('organization_id');
  });
});
