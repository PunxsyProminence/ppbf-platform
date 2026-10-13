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
import { FAMILY_ALLOWED_AUDIT_ENTITY_TYPES } from './auditReadAllowlist';
import { emitShadowEvent } from './shadowEvents';
import { getShadowKnowledgeProjection, getShadowObservationProjection, listShadowEvents, listShadowTelemetry } from './shadowReadModels';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

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

/*
 * #1558: A GUARDIAN'S ID AS entity_id. A second organization, so nothing above
 * changes: one child, two guardians with logins, and the four rows whose
 * entity_id is a guardian's account id or parent_id and which name the child
 * -- written in the shapes their real writers use -- plus the child's own
 * pain report as the control that an id the family may have still arrives.
 */
const ORG_G = 'org-sesc-guardians';
const ADMIN_G = 'acct-admin-g-sesc';
const COACH_G = 'acct-coach-g-sesc';
const ATHLETE_G = 'ATH-SESC-G';
const ATHLETE_G_ACCOUNT = 'acct-ath-g-sesc';
const GUARDIAN_ONE = 'guardian.one.sesc@example.test';
const GUARDIAN_TWO = 'guardian.two.sesc@example.test';
const PAR_ONE = `par-${GUARDIAN_ONE}`;
const PAR_TWO = `par-${GUARDIAN_TWO}`;
const PAR_PAPER = 'par-paper-guardian-sesc';

async function seedGuardianIdRows(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_G],
  );
  for (const [accountId, role] of [[ADMIN_G, 'organization_admin'], [COACH_G, 'coach'], [GUARDIAN_ONE, 'parent'], [GUARDIAN_TWO, 'parent']] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG_G],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Guarded Athlete', '2012-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_G, ATHLETE_G, ADMIN_G],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, athlete_id) values ($1, 'athlete', $2, $3)`,
    [ATHLETE_G_ACCOUNT, ORG_G, ATHLETE_G],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Guardian One'), ($1, $4, $5, 'Guardian Two')`,
    [ORG_G, PAR_ONE, GUARDIAN_ONE, PAR_TWO, GUARDIAN_TWO],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $4, 'mother'), ($1, $3, $4, 'father')`,
    [ORG_G, PAR_ONE, PAR_TWO, ATHLETE_G],
  );

  // admin/staff/route.ts, giving Guardian Two a login.
  await writePilotAuditEvent({
    event_type: 'create',
    actor_account_id: ADMIN_G,
    actor_role: 'organization_admin',
    organization_id: ORG_G,
    entity_type: 'account',
    entity_id: GUARDIAN_TWO,
    details: {
      action: 'organization_admin_provision_staff',
      role: 'parent',
      login_email: GUARDIAN_TWO,
      auth_provider: 'microsoft',
      guardian_parent_id: PAR_TWO,
      guardian_athlete_id: ATHLETE_G,
    },
  });
  // admin/staff/route.ts, removing a paper-only guardian's link.
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: ADMIN_G,
    actor_role: 'organization_admin',
    organization_id: ORG_G,
    entity_type: 'guardian',
    entity_id: PAR_PAPER,
    details: {
      action: 'organization_admin_remove_guardian_link',
      guardian_parent_id: PAR_PAPER,
      guardian_athlete_id: ATHLETE_G,
      paper_only: true,
    },
  });
  // guardianLoginMove.ts.
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: ADMIN_G,
    actor_role: 'organization_admin',
    organization_id: ORG_G,
    entity_type: 'guardian',
    entity_id: PAR_TWO,
    details: {
      action: 'organization_admin_move_guardian_login',
      from_account_id: 'guardian.two.old.sesc@example.test',
      to_account_id: GUARDIAN_TWO,
      to_login_created: false,
      athlete_ids: [ATHLETE_G],
      old_login_switched_off: true,
    },
  });
  // intake/domain-upsert/route.ts, entity_type 'guardian'.
  await emitShadowEvent({
    organizationId: ORG_G,
    eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED',
    entityType: 'intake_guardian',
    entityId: `${PAR_TWO}:${ATHLETE_G}`,
    actorAccountId: ADMIN_G,
    actorRole: 'organization_admin',
    payload: { athlete_id: ATHLETE_G, automation_mode: 'manual' },
  });
  // The control: the child's own pain report.
  await emitShadowEvent({
    organizationId: ORG_G,
    eventName: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
    entityType: 'athlete',
    entityId: ATHLETE_G,
    actorAccountId: ADMIN_G,
    actorRole: 'organization_admin',
    payload: { athlete_id: ATHLETE_G, severity_1_10: 3, location: 'right hand' },
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
  await seedGuardianIdRows(client);
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
  // Labelled by the STORED entity_id, looked up by row id: a non-staff reader
  // is no longer sent the id for most entity types (#1558), and which rows a
  // role reads is a separate question from what each row carries.
  const stored = await activeClient!.query<{ shadow_event_id: string; entity_id: string }>(
    `select shadow_event_id, entity_id from pilot.shadow_events where organization_id = $1`,
    [ORG_ID],
  );
  const storedId = new Map(stored.rows.map((row) => [String(row.shadow_event_id), row.entity_id]));
  // A sign-out and a sign-in share the account as entity_id; the label keeps
  // them apart.
  return rows.map((row) => {
    const entityId = storedId.get(String(row.shadow_event_id));
    return row.event_name.includes('LOGOUT') ? `logout:${entityId}` : String(entityId);
  }).sort();
}

const sorted = (ids: string[]) => [...ids].sort();

/** A mirrored audit row reaches an athlete or parent only when its entity type
 *  is on the family list (#1558 item two; the list is the owner's Q-1). */
const familyMirror = (label: string, entityType: string) =>
  (FAMILY_ALLOWED_AUDIT_ENTITY_TYPES.has(entityType) ? [label] : []);

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

  // A coach no longer reads the audit mirrors here (LOGIN_*, LOGOUT_B,
  // FILM_B) even for their own athlete: 'account' and
  // 'shadow_film_study_proposal' are not on audit/get's coach allow-list, and
  // the feed now applies it to mirrors (shadowAuditMirrorScope.pg.test.ts).
  // The athletes and parent below still prove those mirrors are tied to the
  // right athlete.
  // Issue #1480 (Jason, 2026-10-12): a coach's reach is the whole gym. Every
  // coach of the gym -- assigned, covering, or neither -- reads every
  // athlete-tied row of the gym, including rows naming two athletes. Still not
  // the audit mirrors off audit/get's coach allow-list (LOGIN_*, LOGOUT_B,
  // FILM_B), and still not a row whose athletes cannot all be resolved -- one
  // named by name alone (NAME_ONLY) or inside objects (OBJECTS_AB): those fail
  // closed to the admin, whose scope is unrestricted.
  const EVERY_COACH_READS = sorted([OPS, PAIN_A, CLAIM_B, NESTED_B, CAMEL_B, PAIR_AB]);

  test("a coach reads every athlete's rows of the gym and the operational feed", async () => {
    expect(await visibleTo(COACH_A, 'coach')).toEqual(EVERY_COACH_READS);
  });

  test('the other coach reads exactly the same rows, rows naming both athletes included', async () => {
    expect(await visibleTo(COACH_B, 'coach')).toEqual(EVERY_COACH_READS);
  });

  test('a coach holding a coverage grant reads the same rows as every other coach of the gym', async () => {
    expect(await visibleTo(COACH_COVER, 'coach')).toEqual(EVERY_COACH_READS);
  });

  test('the platform owner reads no athlete-tied row', async () => {
    expect(await visibleTo(PLATFORM_OWNER, 'platform_owner')).toEqual([OPS]);
  });

  test('staff read no athlete-tied row', async () => {
    expect(await visibleTo(STAFF, 'staff')).toEqual([OPS]);
  });

  // The audit mirrors below (sign-in, sign-out, film study) are tied to the
  // right athlete -- the admin and coach controls above read them -- and
  // reach the athlete or the parent only for entity types on the family list
  // (#1558 item two). The rows that are not mirrors are unchanged.
  test('an athlete reads only their own rows', async () => {
    expect(await visibleTo(ATHLETE_A_ACCOUNT, 'athlete', ATHLETE_A)).toEqual(
      sorted([PAIN_A, ...familyMirror(LOGIN_A, 'account')]),
    );
  });

  test("athlete B reads B's rows, and B's audit mirrors only for the types on the family list", async () => {
    expect(await visibleTo(ATHLETE_B_ACCOUNT, 'athlete', ATHLETE_B)).toEqual(
      sorted([
        ...familyMirror(LOGIN_B, 'account'),
        ...familyMirror(LOGOUT_B, 'account'),
        ...familyMirror(FILM_B, 'shadow_film_study_proposal'),
        CLAIM_B,
        NESTED_B,
        CAMEL_B,
      ]),
    );
  });

  test("a parent reads only their child's rows", async () => {
    expect(await visibleTo(PARENT_A, 'parent')).toEqual(sorted([PAIN_A, ...familyMirror(LOGIN_A, 'account')]));
  });
});

describe('SHADOW event feed: a guardian id never reaches a family reader as entity_id (#1558)', () => {
  const feed = (actorAccountId: string, actorRole: PilotRole, athleteId: string | null = null) =>
    listShadowEvents({ organizationId: ORG_G, actorAccountId, actorRole, athleteId }, { limit: 200 });

  const GUARDIAN_IDS = [GUARDIAN_ONE, GUARDIAN_TWO, PAR_ONE, PAR_TWO, PAR_PAPER, 'guardian.two.old.sesc@example.test'];

  test('control: the organization admin reads all five rows with their ids, as before', async () => {
    const rows = await feed(ADMIN_G, 'organization_admin');

    expect(rows.map((row) => `${row.entity_type}|${row.entity_id}`).sort()).toEqual([
      `account|${GUARDIAN_TWO}`,
      `athlete|${ATHLETE_G}`,
      `guardian|${PAR_PAPER}`,
      `guardian|${PAR_TWO}`,
      `intake_guardian|${PAR_TWO}:${ATHLETE_G}`,
    ].sort());
  });

  // A coach does not read the account and guardian audit mirrors at all (they
  // are off audit/get's coach list); the two rows a coach does read arrive
  // with their ids, the guardian's included. Staff are unchanged.
  test('control: a coach of the gym reads their rows with the ids, as before', async () => {
    const rows = await feed(COACH_G, 'coach');

    expect(rows.map((row) => `${row.entity_type}|${row.entity_id}`).sort()).toEqual([
      `athlete|${ATHLETE_G}`,
      `intake_guardian|${PAR_TWO}:${ATHLETE_G}`,
    ].sort());
  });

  // The two projections built on the same feed, as the other guardian.
  test('the knowledge and observation projections carry no guardian id for Guardian One either', async () => {
    const reader = { organizationId: ORG_G, actorAccountId: GUARDIAN_ONE, actorRole: 'parent' as PilotRole, athleteId: null };
    const knowledge = await getShadowKnowledgeProjection(reader, { limit: 200 });
    const observation = await getShadowObservationProjection(reader, { limit: 200 });

    // Not vacuous: both projections have rows to show.
    expect(knowledge.length).toBeGreaterThan(0);
    expect(observation.length).toBeGreaterThan(0);
    const body = JSON.stringify({ knowledge, observation });
    for (const id of GUARDIAN_IDS) {
      expect(body).not.toContain(id);
    }
    expect(body).not.toContain('par-');
  });

  // The other guardian, the guardian the rows are about, and the child.
  test.each([
    ['Guardian One', GUARDIAN_ONE, 'parent', null],
    ['Guardian Two', GUARDIAN_TWO, 'parent', null],
    ['the athlete', ATHLETE_G_ACCOUNT, 'athlete', ATHLETE_G],
  ] as Array<[string, string, PilotRole, string | null]>)(
    '%s reads the child\'s own row and none of the four rows about a guardian',
    async (_label, accountId, role, athleteId) => {
      const rows = await feed(accountId, role, athleteId);

      // Item two. Until it, all five rows reached the family (first with the
      // guardian's id, then, after #1566, without it). The three audit
      // mirrors are of types that are never on the family list, and the
      // intake "a guardian record was saved" line is one a family reader is
      // not sent at all (Jason, Q-2: "B: Hide all of them (Recommended)").
      expect(rows.map((row) => `${row.entity_type}|${row.entity_id}`).sort()).toEqual([`athlete|${ATHLETE_G}`]);
      const body = JSON.stringify(rows);
      for (const id of GUARDIAN_IDS) {
        expect(body).not.toContain(id);
      }
      expect(body).not.toContain('par-');
    },
  );
});

/*
 * ITEM TWO (#1558 follow-on): WHAT A GUARDIAN DID MUST NOT REACH THE OTHER
 * GUARDIAN'S FEED OR THE CHILD'S. A third organization, so nothing above
 * changes: one child, two guardians, and the rows Guardian One's own actions
 * write through the real audit writer, in the shapes parent/barrier-report and
 * parent/observations use.
 */
const ORG_H = 'org-sesc-household';
const ADMIN_H = 'acct-admin-h-sesc';
const ATHLETE_H = 'ATH-SESC-H';
const ATHLETE_H_ACCOUNT = 'acct-ath-h-sesc';
const GUARDIAN_H1 = 'guardian.one.h.sesc@example.test';
const GUARDIAN_H2 = 'guardian.two.h.sesc@example.test';

describe('ITEM TWO: a guardian\'s own report does not reach the other guardian or the child', () => {
  beforeAll(async () => {
    const client = activeClient!;
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [ORG_H],
    );
    for (const [accountId, role] of [[ADMIN_H, 'organization_admin'], [GUARDIAN_H1, 'parent'], [GUARDIAN_H2, 'parent']] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
        [accountId, role, ORG_H],
      );
    }
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Household Athlete', '2012-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_H, ATHLETE_H, ADMIN_H],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id) values ($1, 'athlete', $2, $3)`,
      [ATHLETE_H_ACCOUNT, ORG_H, ATHLETE_H],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, 'par-h1', $2, 'Guardian One'), ($1, 'par-h2', $3, 'Guardian Two')`,
      [ORG_H, GUARDIAN_H1, GUARDIAN_H2],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'par-h1', $2, 'mother'), ($1, 'par-h2', $2, 'father')`,
      [ORG_H, ATHLETE_H],
    );

    // Both rows are MIRRORED here, which the two routes no longer do
    // (shadow_mirror: false, their route tests pin it): rows written before
    // that change are still in pilot.shadow_events, and the read rule is what
    // keeps them from a family reader.
    // parent/barrier-report/route.ts, as Guardian One.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: GUARDIAN_H1,
      actor_role: 'parent',
      organization_id: ORG_H,
      entity_type: 'parent_barrier_report',
      entity_id: '20000000-0000-4000-8000-000000000001',
      details: { athlete_id: ATHLETE_H, barrier_type: 'home' },
    });
    // parent/observations/route.ts, as Guardian One.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: GUARDIAN_H1,
      actor_role: 'parent',
      organization_id: ORG_H,
      entity_type: 'parent_observation',
      entity_id: '20000000-0000-4000-8000-000000000002',
      details: { athlete_id: ATHLETE_H, category: 'sleep', rated: true },
    });
  });

  const reader = (actorAccountId: string, actorRole: PilotRole, athleteId: string | null = null) =>
    ({ organizationId: ORG_H, actorAccountId, actorRole, athleteId });

  test('control: both rows are mirrored, and the organization admin reads them', async () => {
    const rows = await listShadowEvents(reader(ADMIN_H, 'organization_admin'), { limit: 200 });
    expect(rows.map((row) => row.event_name).sort()).toEqual([
      'SHADOW_AUDIT_CREATE_PARENT_BARRIER_REPORT',
      'SHADOW_AUDIT_CREATE_PARENT_OBSERVATION',
    ]);
  });

  test.each([
    ['the other guardian', GUARDIAN_H2, 'parent', null],
    ['the child', ATHLETE_H_ACCOUNT, 'athlete', ATHLETE_H],
  ] as Array<[string, string, PilotRole, string | null]>)('%s reads neither row in the feed', async (_label, accountId, role, athleteId) => {
    const rows = await listShadowEvents(reader(accountId, role, athleteId), { limit: 200 });
    expect(rows.map((row) => row.event_name)).toEqual([]);
  });

  test('the child\'s "SHADOW notes" list (observation projection) does not name a barrier report', async () => {
    const items = await getShadowObservationProjection(reader(ATHLETE_H_ACCOUNT, 'athlete', ATHLETE_H), { limit: 20 });
    expect(items.map((item) => item.label)).toEqual([]);
  });

  test('nor does the guardian who filed them read their own report back through the feed', async () => {
    const rows = await listShadowEvents(reader(GUARDIAN_H1, 'parent'), { limit: 200 });
    expect(rows.map((row) => row.event_name)).toEqual([]);
  });
});

/*
 * ITEM TWO, part C: A FILTER MUST NOT CONFIRM WHAT THE ANSWER WITHHOLDS.
 * The guardian fixture above (ORG_G) holds a row whose stored entity_id is
 * `par-<Guardian Two's address>:<child>`. Guardian One is not sent that id.
 * Before this rule they could post it as a filter and learn from the row
 * coming back that the address was right.
 */
describe('ITEM TWO: a guessed id cannot be confirmed through the feed\'s filters', () => {
  const asGuardianOne = { organizationId: ORG_G, actorAccountId: GUARDIAN_ONE, actorRole: 'parent' as PilotRole, athleteId: null };
  const asAthlete = { organizationId: ORG_G, actorAccountId: ATHLETE_G_ACCOUNT, actorRole: 'athlete' as PilotRole, athleteId: ATHLETE_G };
  const asAdmin = { organizationId: ORG_G, actorAccountId: ADMIN_G, actorRole: 'organization_admin' as PilotRole, athleteId: null };

  // Every stored id of the rows a family reader is NOT sent the id of.
  const WITHHELD_IDS = [`${PAR_TWO}:${ATHLETE_G}`, PAR_TWO, PAR_PAPER, GUARDIAN_TWO, 'session-g-1'];

  beforeAll(async () => {
    // A row whose payload carries a correlation_id, a key only staff are sent,
    // and a telemetry row carrying the guardian's id and the same keys.
    await emitShadowEvent({
      organizationId: ORG_G,
      eventName: 'SHADOW_TEST_CORRELATED',
      entityType: 'session',
      entityId: 'session-g-1',
      actorAccountId: ADMIN_G,
      actorRole: 'organization_admin',
      payload: { athlete_id: ATHLETE_G, correlation_id: 'corr-g-secret' },
    });
    await writeShadowTelemetryEvent({
      organizationId: ORG_G,
      metricName: 'shadow.test.guardian_metric',
      actorAccountId: ADMIN_G,
      actorRole: 'organization_admin',
      dimensions: {
        athlete_id: ATHLETE_G,
        entity_type: 'intake_guardian',
        entity_id: `${PAR_TWO}:${ATHLETE_G}`,
        correlation_id: 'corr-g-secret',
        intake_case_id: 'case-g-1',
      },
    });
    // intake/domain-upsert's own metric, in the shape that route writes it.
    await writeShadowTelemetryEvent({
      organizationId: ORG_G,
      metricName: 'shadow.intake.domain_upsert',
      actorAccountId: ADMIN_G,
      actorRole: 'organization_admin',
      dimensions: { entity_type: 'guardian', automation_mode: 'manual', athlete_id: ATHLETE_G },
    });
  });

  test.each(WITHHELD_IDS)('control: the organization admin finds the row by %s, as entity_id and as correlation_id', async (id) => {
    expect((await listShadowEvents(asAdmin, { entityId: id, limit: 200 })).length).toBeGreaterThan(0);
    expect((await listShadowEvents(asAdmin, { correlationId: id, limit: 200 })).length).toBeGreaterThan(0);
  });

  describe.each([
    ['the other guardian', asGuardianOne],
    ['the child', asAthlete],
  ] as const)('%s', (_label, reader) => {
    test('reads the session row without a filter (so an empty answer below is the filter, not the scope)', async () => {
      const rows = await listShadowEvents(reader, { limit: 200 });
      expect(rows.filter((row) => row.entity_type === 'session').map((row) => row.entity_id)).toEqual([null]);
    });

    test.each(WITHHELD_IDS)('gets nothing back for the guessed entity_id %s', async (id) => {
      expect(await listShadowEvents(reader, { entityId: id, limit: 200 })).toEqual([]);
      expect(await listShadowEvents(reader, { entityId: id, entityType: 'intake_guardian', limit: 200 })).toEqual([]);
    });

    test.each(WITHHELD_IDS)('gets nothing back for the guessed correlation_id %s', async (id) => {
      expect(await listShadowEvents(reader, { correlationId: id, limit: 200 })).toEqual([]);
    });

    test('cannot match payload.correlation_id, a key only staff are sent', async () => {
      expect(await listShadowEvents(reader, { correlationId: 'corr-g-secret', limit: 200 })).toEqual([]);
    });

    test('still finds the child\'s own row by the id it IS sent', async () => {
      const byEntity = await listShadowEvents(reader, { entityId: ATHLETE_G, limit: 200 });
      expect(byEntity.map((row) => `${row.entity_type}|${row.entity_id}`)).toEqual([`athlete|${ATHLETE_G}`]);
      const byCorrelation = await listShadowEvents(reader, { correlationId: ATHLETE_G, limit: 200 });
      expect(byCorrelation.map((row) => `${row.entity_type}|${row.entity_id}`)).toEqual([`athlete|${ATHLETE_G}`]);
    });

    test('telemetry: reads the row unfiltered and cannot find it by any key it is not sent', async () => {
      // One row: the test metric, without the id. intake/domain-upsert's own
      // metric is a line a family reader is not sent at all (Q-2 B).
      const unfiltered = await listShadowTelemetry(reader, { limit: 200 });
      expect(unfiltered.map((row) => [row.metric_name, row.dimensions])).toEqual([
        ['shadow.test.guardian_metric', { entity_type: 'intake_guardian' }],
      ]);
      for (const guess of [`${PAR_TWO}:${ATHLETE_G}`, 'corr-g-secret', 'case-g-1']) {
        expect(await listShadowTelemetry(reader, { correlationId: guess, limit: 200 })).toEqual([]);
      }
    });
  });

  test('control: the organization admin still finds the correlated row and the telemetry row by every key', async () => {
    expect((await listShadowEvents(asAdmin, { correlationId: 'corr-g-secret', limit: 200 })).map((row) => row.entity_id)).toEqual(['session-g-1']);
    for (const key of [`${PAR_TWO}:${ATHLETE_G}`, 'corr-g-secret', 'case-g-1']) {
      expect(await listShadowTelemetry(asAdmin, { correlationId: key, limit: 200 })).toHaveLength(1);
    }
  });

  test('control: staff still read the intake "a record was saved" event and metric (Q-2 hides them from family only)', async () => {
    const adminEvents = await listShadowEvents(asAdmin, { eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED', limit: 200 });
    expect(adminEvents.map((row) => row.entity_type)).toEqual(['intake_guardian']);
    const coachEvents = await listShadowEvents(
      { organizationId: ORG_G, actorAccountId: COACH_G, actorRole: 'coach', athleteId: null },
      { eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED', limit: 200 },
    );
    expect(coachEvents.map((row) => row.entity_type)).toEqual(['intake_guardian']);
    const adminMetrics = (await listShadowTelemetry(asAdmin, { limit: 200 })).map((row) => row.metric_name);
    expect(adminMetrics).toContain('shadow.intake.domain_upsert');
    expect(adminMetrics).toContain('shadow.test.guardian_metric');

    for (const reader of [asGuardianOne, asAthlete]) {
      expect(await listShadowEvents(reader, { eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED', limit: 200 })).toEqual([]);
    }
  });
});
