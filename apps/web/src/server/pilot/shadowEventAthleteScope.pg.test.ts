// Real PostgreSQL-backed test: the SHADOW event feed shows an event about an
// athlete only to the roles assertActorCanAccessAthlete admits for that
// athlete -- every athlete the event names.
//
// WHY THIS SUITE EXISTS (audit CL-A1 = CL-C6, 2026-10-05). listShadowEvents
// tied a row to an athlete only through entity_type 'athlete' or a TOP-LEVEL
// payload athlete_id / owner_entity_id, and handed every other row to the
// "tied to no athlete" disjunct. Two writers name the athlete elsewhere:
//   - writePilotAuditEvent (audit.ts) mirrors every audit event as
//     { event_type, details }, so the athlete sits at payload.details.athlete_id
//     -- a PIN sign-in (auth/login/route.ts) and a film-study observation
//     (shadow/film-study/proposals/route.ts) among them;
//   - the Library emitters (shadowLibrary.ts) name it in subject_id, next to
//     the question text in knowledge_gap.
// Those rows went to every coach (assigned or not), staff, volunteers and the
// platform owner, and the coach and platform owner got the whole payload.
//
// WHY REAL POSTGRES. The boundary is a SQL predicate over jsonb; a mocked db
// cannot tell one that reads payload.details from one that does not.
//
// EVERY REFUSAL HAS A CONTROL in the same fixture: the assigned coach, the
// athlete and their parent see their own athlete's rows, the org admin sees
// everything, and the athlete-free operational row still reaches the roles
// that had it. A predicate that hid everything cannot pass this file.
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
import { bodyMassCorrectionAuditEvent } from './athleteBodyMass';
import { writePilotAuditEvent } from './audit';
import { emitShadowEvent } from './shadowEvents';
import { listShadowEvents } from './shadowReadModels';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-event-scope-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-sesc';
const ADMIN = 'acct-admin-sesc';
const COACH_A = 'acct-coach-a-sesc';
const COACH_B = 'acct-coach-b-sesc';
/** Assigned nobody; holds a live coverage grant for athlete A. */
const COACH_COVER = 'acct-coach-cover-sesc';
const STAFF = 'acct-staff-sesc';
const PLATFORM_OWNER = 'acct-owner-sesc';
const PARENT_A = 'acct-parent-a-sesc';
const ATHLETE_A = 'ATH-SESC-A';
const ATHLETE_B = 'ATH-SESC-B';
const ATHLETE_A_ACCOUNT = 'acct-ath-a-sesc';
const ATHLETE_B_ACCOUNT = 'acct-ath-b-sesc';

/*
 * One row per shape, labelled by entity_id so each assertion names exactly
 * which rows a role reads.
 */
const OPS = 'ops-library-source';            // names no athlete
const PAIN_A = ATHLETE_A;                    // entity_type 'athlete' (the pain-report shape)
const LOGIN_A = ATHLETE_A_ACCOUNT;           // audit mirror, details.athlete_id = A
const LOGIN_B = ATHLETE_B_ACCOUNT;           // audit mirror, details.athlete_id = B
const FILM_B = 'film-proposal-b';            // audit mirror, details.athlete_id = B
const CLAIM_B = 'subject:claim-b';           // Library claim, subject_id = B
const PAIR_AB = 'pair-a-b';                  // names A and B
const NESTED_B = 'nested-b';                 // athlete_id = B inside an array of objects
const NAME_ONLY = 'name-only';               // names an athlete without any id
const LOGOUT_B = `logout:${ATHLETE_B_ACCOUNT}`; // audit mirror naming only B's account (details {})
const CAMEL_B = 'camel-b';                   // athleteId = B
const OBJECTS_AB = 'objects-a-b';            // athlete_id = A plus athletes: [{ id: B }]
const BODY_MASS_A = 'obs-a-corrected';      // audit row only: body-mass correction, never mirrored

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
    [COACH_COVER, 'coach'],
    [STAFF, 'staff'],
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
       values ($1, $2, 'Scoped Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, coachId],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id)
       values ($1, 'athlete', $2, $3)`,
      [accountId, ORG_ID, athleteId],
    );
  }
  await client.query(
    `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '2 hours')`,
    [ORG_ID, ATHLETE_A, COACH_COVER, ADMIN],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-sesc-a', $2, 'Guardian A')`,
    [ORG_ID, PARENT_A],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-sesc-a', $2, 'parent')`,
    [ORG_ID, ATHLETE_A],
  );

  // An operational Library event: no athlete anywhere in it.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_LIBRARY_SOURCE_REGISTERED',
    entityType: 'shadow_library_source',
    entityId: OPS,
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    payload: { source_id: OPS, title: 'Footwork primer' },
  });

  // A pain report, the shape formulas/painReportAlert.ts emits.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
    entityType: 'athlete',
    entityId: PAIN_A,
    actorAccountId: COACH_A,
    actorRole: 'coach',
    payload: { athlete_id: ATHLETE_A, severity_1_10: 6, location: 'left wrist' },
  });

  // PIN sign-ins, written through the real audit writer with the shape
  // auth/login/route.ts gives it.
  for (const [accountId, athleteId] of [
    [ATHLETE_A_ACCOUNT, ATHLETE_A],
    [ATHLETE_B_ACCOUNT, ATHLETE_B],
  ] as const) {
    await writePilotAuditEvent({
      event_type: 'login',
      actor_account_id: accountId,
      actor_role: 'athlete',
      organization_id: ORG_ID,
      entity_type: 'account',
      entity_id: accountId,
      details: { athlete_id: athleteId, hasMasterShadowAccess: false },
    });
  }

  // A film-study observation, the shape shadow/film-study/proposals/route.ts
  // audits.
  await writePilotAuditEvent({
    event_type: 'create',
    actor_account_id: COACH_B,
    actor_role: 'coach',
    organization_id: ORG_ID,
    entity_type: 'shadow_film_study_proposal',
    entity_id: FILM_B,
    details: {
      action: 'film_study_coach_reported_observation',
      origin: 'coach_reported',
      athlete_id: ATHLETE_B,
      video_session_id: 'video-b',
    },
  });

  // A Library claim about athlete B, the shape shadowLibrary.ts emits: the
  // athlete is subject_id and the question travels in knowledge_gap.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
    entityType: 'shadow_library_claim',
    entityId: CLAIM_B,
    actorAccountId: COACH_B,
    actorRole: 'coach',
    payload: { scope: 'subject', subject_id: ATHLETE_B, status: 'gap', knowledge_gap: 'Why does B keep dropping the left hand?' },
  });

  // Two athletes on one row (a mentorship-shaped audit detail).
  await writePilotAuditEvent({
    event_type: 'create',
    actor_account_id: ADMIN,
    actor_role: 'organization_admin',
    organization_id: ORG_ID,
    entity_type: 'mentorship',
    entity_id: PAIR_AB,
    details: { mentor_athlete_id: ATHLETE_A, mentee_athlete_id: ATHLETE_B },
  });

  // An athlete id one level deeper than details, inside an array of objects.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_TEST_NESTED_ROSTER',
    entityType: 'session',
    entityId: NESTED_B,
    actorAccountId: COACH_B,
    actorRole: 'coach',
    payload: { details: { roster: [{ athlete_id: ATHLETE_B, note: 'late' }] } },
  });

  // A sign-out, the shape auth/logout/route.ts audits: the athlete's account
  // and nothing else; the account row says whose it is. Written by an admin
  // here so the acting-athlete lookup is not what ties it.
  await writePilotAuditEvent({
    event_type: 'logout',
    actor_account_id: ADMIN,
    actor_role: 'organization_admin',
    organization_id: ORG_ID,
    entity_type: 'account',
    entity_id: ATHLETE_B_ACCOUNT,
    details: {},
  });

  // A camel-cased athlete key.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_TEST_CAMEL',
    entityType: 'session',
    entityId: CAMEL_B,
    actorAccountId: COACH_B,
    actorRole: 'coach',
    payload: { athleteId: ATHLETE_B },
  });

  // A second athlete inside objects under an athlete key: unresolvable, so
  // only org-wide roles read it, even though athlete_id = A is reachable.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_TEST_OBJECTS',
    entityType: 'session',
    entityId: OBJECTS_AB,
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    payload: { athlete_id: ATHLETE_A, athletes: [{ id: ATHLETE_B }] },
  });

  // Names an athlete with no id at all. Nothing can prove who may read it,
  // so it fails closed to the roles with organization-wide reach.
  await emitShadowEvent({
    organizationId: ORG_ID,
    eventName: 'SHADOW_TEST_NAME_ONLY',
    entityType: 'session',
    entityId: NAME_ONLY,
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    payload: { athlete_name: 'Scoped Athlete' },
  });

  // A body-mass correction on athlete A, the exact event athleteBodyMass.ts
  // writes (its own builder, through the real writer). Health data: it must
  // land in pilot.audit_events and in NO reader's SHADOW feed, the athlete's
  // and parent's included (lane W7, from the minor-limits review).
  await writePilotAuditEvent(bodyMassCorrectionAuditEvent({
    actor: { accountId: COACH_A, role: 'coach' },
    organizationId: ORG_ID,
    athleteId: ATHLETE_A,
    observationId: BODY_MASS_A,
    supersedesObservationId: 'obs-a-superseded',
  }));
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
  await admin.query('drop database if exists sesc_main');
  await admin.query('create database sesc_main');
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor('sesc_main') });
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
  // A sign-out and a sign-in share the account as entity_id; the label keeps
  // them apart.
  return rows.map((row) => (row.event_name.includes('LOGOUT') ? `logout:${row.entity_id}` : row.entity_id)).sort();
}

const sorted = (ids: string[]) => [...ids].sort();

describe('SHADOW event feed: an athlete-tied event reaches only roles cleared for every athlete it names', () => {
  test('fixture: every row is in the table', async () => {
    const stored = await activeClient!.query<{ entity_id: string }>(
      `select entity_id from pilot.shadow_events where organization_id = $1`,
      [ORG_ID],
    );
    expect(stored.rows).toHaveLength(12);
  });

  test('a body-mass correction is audited and reaches no SHADOW feed at all', async () => {
    // The audit row is there, so the writer ran and the record is kept.
    const audited = await activeClient!.query(
      `select details from pilot.audit_events
        where organization_id = $1 and entity_type = 'athlete_body_mass' and entity_id = $2`,
      [ORG_ID, BODY_MASS_A],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0].details).toMatchObject({ athlete_id: ATHLETE_A });

    // No mirror row exists -- the proof does not rest on the read model's
    // scoping, which would still hand the row to the athlete and parent.
    const mirrored = await activeClient!.query(
      `select 1 from pilot.shadow_events where organization_id = $1 and entity_id = $2`,
      [ORG_ID, BODY_MASS_A],
    );
    expect(mirrored.rows).toHaveLength(0);

    // And the family feed, read as the athlete and as the parent, never
    // lists it; nor does the admin's, which reads everything that exists.
    for (const feed of [
      await visibleTo(ATHLETE_A_ACCOUNT, 'athlete', ATHLETE_A),
      await visibleTo(PARENT_A, 'parent'),
      await visibleTo(COACH_A, 'coach'),
      await visibleTo(ADMIN, 'organization_admin'),
    ]) {
      expect(feed).not.toContain(BODY_MASS_A);
    }
  });

  test('control: the organization admin reads every row', async () => {
    expect(await visibleTo(ADMIN, 'organization_admin')).toEqual(
      sorted([OPS, PAIN_A, LOGIN_A, LOGIN_B, LOGOUT_B, FILM_B, CLAIM_B, PAIR_AB, NESTED_B, NAME_ONLY, CAMEL_B, OBJECTS_AB]),
    );
  });

  test("a coach reads their own athlete's rows and the operational feed, not another coach's athlete", async () => {
    expect(await visibleTo(COACH_A, 'coach')).toEqual(sorted([OPS, PAIN_A, LOGIN_A]));
  });

  test("the other coach reads B's rows, including the nested, Library, sign-out and camel-cased ones, but not a row that also names A", async () => {
    expect(await visibleTo(COACH_B, 'coach')).toEqual(sorted([OPS, LOGIN_B, LOGOUT_B, FILM_B, CLAIM_B, NESTED_B, CAMEL_B]));
  });

  test('a coach covering athlete A reads what the assigned coach reads', async () => {
    expect(await visibleTo(COACH_COVER, 'coach')).toEqual(sorted([OPS, PAIN_A, LOGIN_A]));
  });

  test('the platform owner reads no athlete-tied row', async () => {
    expect(await visibleTo(PLATFORM_OWNER, 'platform_owner')).toEqual([OPS]);
  });

  test('staff read no athlete-tied row', async () => {
    expect(await visibleTo(STAFF, 'staff')).toEqual([OPS]);
  });

  test('an athlete reads only their own rows', async () => {
    expect(await visibleTo(ATHLETE_A_ACCOUNT, 'athlete', ATHLETE_A)).toEqual(sorted([PAIN_A, LOGIN_A]));
  });

  test("a parent reads only their child's rows", async () => {
    expect(await visibleTo(PARENT_A, 'parent')).toEqual(sorted([PAIN_A, LOGIN_A]));
  });
});
