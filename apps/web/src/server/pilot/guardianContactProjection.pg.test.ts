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

import { requirePrincipal } from './http';
import { WAIVER_IDENTITY_COLUMNS, WAIVER_STAFF_COLUMNS } from './intake';
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
             now(), 'v1', 'active', $3, 'par-b')`,
    [ORG, ATHLETE, 'Countersigned after a call to 555-0200; welfare lead aware of the household situation.'],
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
  /* THE CHILD. An athlete reading their own record is the reader with the
     least business holding either parent's contact details, and the reader the
     old `select p.*` served them to first. */
  it('gives the athlete both guardians by name, and neither by number', async () => {
    const guardians = await readGuardiansVia(AS.athlete());

    expect(guardians).toHaveLength(2);
    // Equality on the whole row, not a check that some key is absent: a
    // containment assertion would pass over a row that grew a new contact
    // column tomorrow.
    expect(guardians).toEqual([
      { parent_id: 'par-a', full_name: 'Guardian A', relationship_to_athlete: 'mother' },
      { parent_id: 'par-b', full_name: 'Guardian B', relationship_to_athlete: 'father' },
    ]);
  });

  /* THE OTHER HOUSEHOLD. Guardian A is legitimately here -- they are linked to
     this athlete and the gate admits them. What they may not leave with is
     Guardian B's number. */
  it('gives Guardian A nothing of Guardian B but the name and the relationship', async () => {
    const guardians = await readGuardiansVia(AS.guardianA());
    const other = guardians.find((row) => row.full_name === 'Guardian B');

    expect(other).toEqual({ parent_id: 'par-b', full_name: 'Guardian B', relationship_to_athlete: 'father' });
    for (const key of CONTACT_KEYS) {
      expect(Object.keys(other ?? {})).not.toContain(key);
    }
    // Said as values too, because a key check alone would pass if the column
    // were renamed rather than removed.
    expect(JSON.stringify(guardians)).not.toContain('555-0200');
    expect(JSON.stringify(guardians)).not.toContain('guardian.b@example.test');
    expect(JSON.stringify(guardians)).not.toContain('acct-guardian-b');
  });

  /* And symmetrically, so this cannot pass by accident of row order. */
  it('gives Guardian B nothing of Guardian A but the name and the relationship', async () => {
    const guardians = await readGuardiansVia(AS.guardianB());

    expect(JSON.stringify(guardians)).not.toContain('555-0100');
    expect(JSON.stringify(guardians)).not.toContain('guardian.a@example.test');
    expect(JSON.stringify(guardians)).not.toContain('acct-guardian-a');
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

  /* The emergency contact by name and relationship is legitimate -- knowing
     who is called for you is your own record. The number is not. */
  it('names the emergency contact to a guardian without giving up the number or the note', async () => {
    const body = await readDomainGet(AS.guardianA());

    expect(body.emergency_contacts).toEqual([{
      contact_id: '99999999-8888-4777-8666-555555555555',
      athlete_id: ATHLETE,
      full_name: 'Guardian B',
      relationship_to_athlete: 'father',
      is_primary: true,
    }]);
    // The staff-only note is the one that says "do not call the father".
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
  it('gives a guardian the waiver itself without the staff note on it', async () => {
    const body = await readDomainGet(AS.guardianA());
    const waiver = body.waivers?.[0];

    // Everything a waiver IS, which a guardian is entitled to: what was
    // signed, by whom, when, under which version, and the media flags a
    // parent checks their child's permissions against.
    expect(waiver).toMatchObject({
      waiver_type: 'photo_media',
      signed_by_name: 'Guardian B',
      signed_by_role: 'parent',
      consent_version: 'v1',
      status: 'active',
      parent_id: 'par-b',
      covers_video: true,
      public_use_allowed: false,
    });
    expect(Object.keys(waiver ?? {})).not.toContain('notes');
  });

  it('gives the athlete the same waiver without the note', async () => {
    const body = await readDomainGet(AS.athlete());

    expect(body.waivers).toHaveLength(1);
    expect(Object.keys(body.waivers?.[0] ?? {})).not.toContain('notes');
  });

  it('keeps the waiver note for the coach and the organization admin', async () => {
    const asCoach = await readDomainGet(AS.coach());
    const asAdmin = await readDomainGet(AS.admin());

    expect(asCoach.waivers?.[0].notes).toContain('555-0200');
    expect(asAdmin.waivers?.[0].notes).toContain('555-0200');
  });
});

/* THE ALLOWLIST AGAINST THE REAL TABLE.
   waiverColumnsForReader is an allowlist, which fails closed on a column a
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

  it('keeps the staff note out of the identity set', () => {
    expect(WAIVER_IDENTITY_COLUMNS).not.toContain('notes');
    expect(WAIVER_STAFF_COLUMNS).toContain('notes');
  });
});

/* The second read of pilot.parents, on the same rows. It takes its reader as an
   argument rather than off a request, so the risk here is a caller that passes
   none -- which is why the default is asserted as identity-only. */
describe('getIntakeCaseAggregate', () => {
  it('gives the athlete identity only', async () => {
    const guardians = await readGuardiansViaAggregate(AS.athlete());

    expect(guardians).toEqual([
      { parent_id: 'par-a', full_name: 'Guardian A', relationship_to_athlete: 'mother', athlete_id: ATHLETE },
      { parent_id: 'par-b', full_name: 'Guardian B', relationship_to_athlete: 'father', athlete_id: ATHLETE },
    ]);
  });

  it('gives a guardian identity only, in both directions', async () => {
    const asA = JSON.stringify(await readGuardiansViaAggregate(AS.guardianA()));
    const asB = JSON.stringify(await readGuardiansViaAggregate(AS.guardianB()));

    for (const secret of ['555-0100', '555-0200', 'guardian.a@example.test', 'guardian.b@example.test']) {
      expect(asA).not.toContain(secret);
      expect(asB).not.toContain(secret);
    }
  });

  it('keeps the contact columns for a coach and for an organization admin', async () => {
    for (const actor of [AS.coach(), AS.admin()]) {
      const guardians = await readGuardiansViaAggregate(actor);
      expect(guardians[0].phone).toBe('555-0100');
      expect(guardians[0].email).toBe('guardian.a@example.test');
      expect(guardians[0].account_id).toBe('acct-guardian-a');
    }
  });

  /* No reader named means no reader trusted. A caller that forgets the context
     argument must not be the one path that hands out phone numbers. */
  it('falls to identity only when no reader is named at all', async () => {
    const guardians = await readGuardiansViaAggregate(null);

    expect(guardians).toEqual([
      { parent_id: 'par-a', full_name: 'Guardian A', relationship_to_athlete: 'mother', athlete_id: ATHLETE },
      { parent_id: 'par-b', full_name: 'Guardian B', relationship_to_athlete: 'father', athlete_id: ATHLETE },
    ]);
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
