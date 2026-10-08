// Real PostgreSQL proof of the paper-only guardian (Jason 2026-10-07,
// OD-2026-10-07-009, question card 2: "Yes, name and relationship"): a
// guardian record with no login and no email, so a family that deals with
// the gym on paper can have its photo/video consent recorded against a named
// guardian -- and that record cannot sign in or be claimed by an invite.
//
// THE WRITE IS THE ONE INTAKE ALREADY HAD. POST /api/pilot/intake/domain-upsert
// with entity_type 'guardian_link' (organization_admin only) creates the
// pilot.parents row and the guardian_links row in one transaction under the
// consent-set lock. The consent desk (/admin/athlete-consent) now calls it;
// nothing new was written on the server for the record itself.
//
// Both route handlers run whole against seeded rows, with only requirePrincipal
// stubbed -- the same seam consentSuppressionAtomic.pg.test.ts uses. The
// rollup at the end is waiverCompliance.getOrganizationWaiverStatus through
// the real db module, so the photo_media column is read the way the admin
// worklist reads it.
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
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-paper-only-guardian-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB_NAME = 'ppbf_test_paper_only_guardian';

const ORG = 'org-paper-only';
const OTHER_ORG = 'org-paper-only-other';
const ATHLETE = 'ath-paper-only';
const REGISTER_ATHLETE = 'ath-paper-only-register';
const ADMIN = 'acct-paper-only-admin';
const COACH = 'acct-paper-only-coach';
// The id shape the consent desk mints: par-paper-<uuid>, kept out of the
// par-<account id> space an invited guardian's record uses.
const PAPER_PARENT = 'par-paper-7f1c2a4e-0000-4000-8000-000000000001';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let domainUpsert: typeof import('@/app/api/pilot/intake/domain-upsert/route').POST;
let consentDeskGet: typeof import('@/app/api/pilot/admin/athlete-consent/route').GET;
let consentDeskPost: typeof import('@/app/api/pilot/admin/athlete-consent/route').POST;
let consent: typeof import('./guardianConsent');
let waiverCompliance: typeof import('./waiverCompliance');
let staffProvisioning: typeof import('./staffProvisioning');

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
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

function principal(accountId: string, role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function post(handler: typeof domainUpsert, url: string, body: Record<string, unknown>) {
  return handler(new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** The desk's own request, as app/admin/athlete-consent/page.tsx sends it. */
function addPaperGuardian(parentId = PAPER_PARENT, fullName = 'Lee Paper') {
  return post(domainUpsert, '/api/pilot/intake/domain-upsert', {
    entity_type: 'guardian_link',
    athlete_id: ATHLETE,
    payload: { parent_id: parentId, full_name: fullName, relationship_to_athlete: 'mother' },
  });
}

async function parentRow(parentId: string) {
  const rows = await db.query<{ account_id: string | null; email: string | null; full_name: string }>(
    'select account_id, email, full_name from pilot.parents where organization_id = $1 and parent_id = $2',
    [ORG, parentId],
  );
  return rows.rows[0] ?? null;
}

async function linkRow(parentId: string) {
  const rows = await db.query<{ relationship_to_athlete: string }>(
    'select relationship_to_athlete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3',
    [ORG, parentId, ATHLETE],
  );
  return rows.rows[0] ?? null;
}

async function deskRowFor(athleteId: string) {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
  const response = await consentDeskGet(new NextRequest('http://localhost/api/pilot/admin/athlete-consent'));
  const body = (await response.json()) as {
    items: Array<{
      athlete_id: string;
      consent_ok: boolean;
      guardian_count: number;
      per_guardian: Array<{ parent_id: string; parent_name: string; has_login: boolean; consented: boolean }>;
    }>;
  };
  return body.items.find((item) => item.athlete_id === athleteId)!;
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  const applyFullSchema = helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  await applyFullSchema(db, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [organizationId],
    );
  }
  for (const [accountId, role] of [[ADMIN, 'organization_admin'], [COACH, 'coach']]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [accountId, ORG, role],
    );
  }
  for (const [athleteId, name] of [[ATHLETE, 'Rosa Ortiz'], [REGISTER_ATHLETE, 'Sam Register']]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-04-03', 'youth-60', 'active', 'Guardian', true, $4, now(), now())`,
      [ORG, athleteId, name, COACH],
    );
  }
  // The register row the old /admin/consent form filed: photo_media, no
  // parent_id, 'Signed'. Nobody is linked to this athlete.
  await db.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at,
        consent_version, status)
     values ($1, gen_random_uuid(), $2, 'photo_media', 'A Parent', 'guardian', now(), 'v1', 'signed')`,
    [ORG, REGISTER_ATHLETE],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  domainUpsert = (await import('@/app/api/pilot/intake/domain-upsert/route')).POST;
  ({ GET: consentDeskGet, POST: consentDeskPost } = await import('@/app/api/pilot/admin/athlete-consent/route'));
  consent = await import('./guardianConsent');
  waiverCompliance = await import('./waiverCompliance');
  staffProvisioning = await import('./staffProvisioning');
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

/* The cases build on one another in order: a record is added, then labelled,
   then consented against, then shown to be unreachable by sign-in and invite.
   Each reads the database for its facts; none re-seeds. */

test('a coach cannot add a guardian from the desk -- the write is organization_admin only', async () => {
  mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));

  const response = await addPaperGuardian();

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await parentRow(PAPER_PARENT)).toBeNull();
  expect(await linkRow(PAPER_PARENT)).toBeNull();
});

test('an organization admin adds a guardian who exists only on paper: no account, no email, linked in one write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));

  const response = await addPaperGuardian();
  const body = (await response.json()) as Record<string, unknown>;

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ ok: true, entity_type: 'guardian_link' });
  expect(await parentRow(PAPER_PARENT)).toEqual({ account_id: null, email: null, full_name: 'Lee Paper' });
  expect(await linkRow(PAPER_PARENT)).toEqual({ relationship_to_athlete: 'mother' });

  // Audited, with the athlete named: who gained standing over which child.
  const audit = await db.query(
    `select 1 from pilot.audit_events
      where organization_id = $1 and actor_account_id = $2 and entity_type = 'intake_guardian_link'
        and entity_id = $3 and details->>'athlete_id' = $4`,
    [ORG, ADMIN, `${PAPER_PARENT}:${ATHLETE}`, ATHLETE],
  );
  expect(audit.rowCount).toBe(1);
});

test('the desk lists the new guardian as paper only, with nothing on file yet', async () => {
  const row = await deskRowFor(ATHLETE);

  expect(row.guardian_count).toBe(1);
  expect(row.consent_ok).toBe(false);
  expect(row.per_guardian).toEqual([
    expect.objectContaining({ parent_id: PAPER_PARENT, parent_name: 'Lee Paper', has_login: false, consented: false }),
  ]);
});

test('consent recorded against the paper-only guardian is consent to every reader', async () => {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));

  const response = await post(consentDeskPost, '/api/pilot/admin/athlete-consent', {
    athlete_id: ATHLETE,
    parent_id: PAPER_PARENT,
    decision: 'grant',
    covers_video: true,
    public_use_allowed: false,
    signed_at: '2026-10-01T12:00:00.000Z',
    notes: 'Office cabinet, drawer 2',
  });
  expect(response.status).toBe(200);

  // The gate the approval, publish and playback paths read.
  const check = await consent.checkGuardianMediaConsent(ORG, ATHLETE);
  expect(check.ok).toBe(true);
  expect(check.perGuardian).toEqual([
    expect.objectContaining({ parentId: PAPER_PARENT, status: 'signed', coversVideo: true }),
  ]);

  // The desk.
  const row = await deskRowFor(ATHLETE);
  expect(row.consent_ok).toBe(true);
  expect(row.per_guardian[0]).toMatchObject({ has_login: false, consented: true });

  // The admin worklist: photo_media is this check's answer, not a stored row.
  const rollup = await waiverCompliance.getOrganizationWaiverStatus(ORG);
  expect(rollup.find((entry) => entry.athleteId === ATHLETE)?.waivers.photo_media).toBe('signed');
});

test('the old register row -- photo_media with no guardian -- no longer reads as Signed on the worklist', async () => {
  const rollup = await waiverCompliance.getOrganizationWaiverStatus(ORG);

  expect(rollup.find((entry) => entry.athleteId === REGISTER_ATHLETE)?.waivers.photo_media).toBe('missing');
  // The row itself is untouched: this is a reading, not a migration.
  const stored = await db.query(
    `select status from pilot.waivers where organization_id = $1 and athlete_id = $2 and waiver_type = 'photo_media'`,
    [ORG, REGISTER_ATHLETE],
  );
  expect(stored.rows).toEqual([{ status: 'signed' }]);
  // And the desk says what the worklist says.
  const row = await deskRowFor(REGISTER_ATHLETE);
  expect(row).toMatchObject({ consent_ok: false, guardian_count: 0 });
});

test('nothing can sign in as the paper-only guardian: no account row names the record and no login carries its name', async () => {
  const accounts = await db.query(
    `select 1 from pilot.accounts a
      where exists (select 1 from pilot.parents p where p.organization_id = $1 and p.parent_id = $2 and p.account_id = a.account_id)`,
    [ORG, PAPER_PARENT],
  );
  expect(accounts.rowCount).toBe(0);
  // Every parent-facing read resolves children through pilot.parents.account_id
  // (guardianAccess.ts); a NULL there resolves to nobody.
  const byAccount = await db.query(
    'select 1 from pilot.parents where organization_id = $1 and parent_id = $2 and account_id is not null',
    [ORG, PAPER_PARENT],
  );
  expect(byAccount.rowCount).toBe(0);
});

test('a later invite of a guardian with the same name does not claim the paper-only record', async () => {
  // The invite claim step matches unclaimed records on a normalised EMAIL
  // (staffProvisioning.ts). The paper record has none, so it is never a
  // candidate -- by accident or otherwise. The cost is stated in the PR: the
  // invite makes a SECOND record for the same person, and both then count.
  const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
    loginEmail: 'lee.paper@example.com',
    organizationId: ORG,
    role: 'parent',
    guardian: { athleteId: ATHLETE, fullName: 'Lee Paper', relationshipToAthlete: 'mother' },
  });

  expect(result.guardianLink?.parentId).not.toBe(PAPER_PARENT);
  expect(await parentRow(PAPER_PARENT)).toEqual({ account_id: null, email: null, full_name: 'Lee Paper' });

  const invited = await parentRow(result.guardianLink!.parentId);
  expect(invited).toMatchObject({ account_id: result.accountId, email: 'lee.paper@example.com' });

  // Two records, so two consents are now needed; the paper one is signed, the
  // invited one is not. The desk shows both, one labelled.
  const row = await deskRowFor(ATHLETE);
  expect(row.guardian_count).toBe(2);
  expect(row.consent_ok).toBe(false);
  expect(row.per_guardian).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ parent_id: PAPER_PARENT, has_login: false, consented: true }),
      expect.objectContaining({ parent_id: result.guardianLink!.parentId, has_login: true, consented: false }),
    ]),
  );
});
