// Real PostgreSQL proof that a consent change which takes published video down
// -- a withdrawal (owner decision 2026-08-14) or a photo-only grant (Jason
// 2026-10-05: "A: Retract (Recommended)") -- commits together with that
// takedown or not at all.
//
// WHAT WAS WRONG (ChatGPT post-merge review of #1262). The consent row was
// written and committed in one transaction (grantMediaConsent /
// withdrawMediaConsent), and the retraction ran afterwards in a second one
// (suppressPublishedMediaForAthlete). When the second failed, the route
// answered 500 with the guardian's photo-only or withdrawn consent on file and
// the video still live.
//
// WHY THIS CANNOT BE A MOCKED TEST. Only a database decides what a rollback
// removes. Here the retraction's own UPDATE fails for real -- a trigger raises
// -- and the assertion is what is left in pilot.waivers, video_publications
// and research_library.
//
// Both route handlers run whole, with their real guardian and tenancy checks
// against seeded rows. Only requirePrincipal is stubbed, the same seam the
// other route-driving .pg suites use.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-consent-suppress-atomic-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB_NAME = 'ppbf_test_consent_suppress_atomic';

const ORG = 'org-consent-atomic';
const ATHLETE = 'ath-consent-atomic';
const PARENT = 'par-consent-atomic';
const PARENT_ACCOUNT = 'acct-consent-atomic-parent';
const ADMIN = 'acct-consent-atomic-admin';
const COACH = 'acct-consent-atomic-coach';
const VIDEO_SESSION = 'vs-consent-atomic';
const PUBLICATION = 'pub-consent-atomic';
const LIBRARY = 'lib-consent-atomic';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let parentConsent: typeof import('@/app/api/pilot/parent/consent/route').POST;
let staffConsent: typeof import('@/app/api/pilot/admin/athlete-consent/route').POST;

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

/* What a reader of this athlete sees: the guardian's current consent (newest
   photo_media row) and whether the video is live. These are the facts the fix
   must keep in step. */
interface State {
  waiverRows: number;
  current: { status: string; covers_video: boolean } | null;
  publication: string;
  shelfSuppressed: boolean;
}

async function state(): Promise<State> {
  const waivers = await db.query<{ status: string; covers_video: boolean }>(
    `select status, covers_video from pilot.waivers
      where organization_id = $1 and athlete_id = $2 and parent_id = $3 and waiver_type = 'photo_media'
      order by created_at desc`,
    [ORG, ATHLETE, PARENT],
  );
  const publication = await db.query<{ status: string }>(
    'select status from pilot.video_publications where organization_id = $1 and publication_id = $2',
    [ORG, PUBLICATION],
  );
  const shelf = await db.query<{ suppressed: boolean }>(
    'select suppressed_at is not null as suppressed from pilot.research_library where organization_id = $1 and library_id = $2',
    [ORG, LIBRARY],
  );
  return {
    waiverRows: waivers.rows.length,
    current: waivers.rows[0] ?? null,
    publication: publication.rows[0].status,
    shelfSuppressed: shelf.rows[0].suppressed,
  };
}

/* Every case starts from: full video consent on file, the video published and
   on the shelf. */
async function resetToPublishedWithVideoConsent(): Promise<void> {
  await db.query(`delete from pilot.waivers where organization_id = $1 and waiver_type = 'photo_media'`, [ORG]);
  await db.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at,
        consent_version, status, parent_id, covers_video, public_use_allowed)
     values ($1, gen_random_uuid(), $2, 'photo_media', 'Pat Guardian', 'parent', now(), 'v1', 'signed', $3, true, false)`,
    [ORG, ATHLETE, PARENT],
  );
  await db.query(
    `update pilot.video_publications set status = 'published' where organization_id = $1 and publication_id = $2`,
    [ORG, PUBLICATION],
  );
  await db.query(
    `update pilot.research_library
        set suppressed_at = null, suppressed_by_account_id = null, suppressed_reason = null
      where organization_id = $1 and library_id = $2`,
    [ORG, LIBRARY],
  );
}

/* A REAL failure in the takedown, raised by Postgres on one of its own
   UPDATEs -- both come after the consent row. 'video_publications' fails the
   retraction itself; 'research_library' fails the shelf suppression after the
   retraction has already run, so the rollback also has to undo a half-done
   takedown. Not a rejected mock: what is left afterwards is what the database
   kept. */
type TakedownTable = 'video_publications' | 'research_library';

async function failTakedown(table: TakedownTable = 'video_publications'): Promise<void> {
  await db.query(
    `create trigger consent_atomic_injected_failure before update on pilot.${table}
       for each row execute function pilot.consent_atomic_injected_failure()`,
  );
}

async function stopFailing(): Promise<void> {
  await db.query('drop trigger if exists consent_atomic_injected_failure on pilot.video_publications');
  await db.query('drop trigger if exists consent_atomic_injected_failure on pilot.research_library');
}

/* The failure audit is written after the rolled-back transaction, on its own
   connection, so it must survive the rollback. */
async function rolledBackAuditRows(): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from pilot.audit_events
      where organization_id = $1 and entity_type = 'guardian_media_consent' and entity_id = $2
        and details->>'rolled_back' = 'true'`,
    [ORG, ATHLETE],
  );
  return Number(rows.rows[0].n);
}

function postTo(handler: typeof parentConsent, url: string, body: Record<string, unknown>) {
  return handler(new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/* The four consent changes that take published video down: a withdrawal and a
   photo-only grant, each from the guardian's own console and from staff. */
const CHANGES = [
  {
    name: 'guardian withdrawal',
    as: () => principal(PARENT_ACCOUNT, 'parent'),
    send: () => postTo(parentConsent, '/api/pilot/parent/consent', { athlete_id: ATHLETE, decision: 'withdraw' }),
    after: { status: 'withdrawn', covers_video: false },
  },
  {
    name: 'guardian photo-only grant',
    as: () => principal(PARENT_ACCOUNT, 'parent'),
    send: () => postTo(parentConsent, '/api/pilot/parent/consent', { athlete_id: ATHLETE, decision: 'grant', covers_video: false }),
    after: { status: 'signed', covers_video: false },
  },
  {
    name: 'staff-recorded withdrawal',
    as: () => principal(ADMIN, 'organization_admin'),
    send: () => postTo(staffConsent, '/api/pilot/admin/athlete-consent', { athlete_id: ATHLETE, parent_id: PARENT, decision: 'withdraw' }),
    after: { status: 'withdrawn', covers_video: false },
  },
  {
    name: 'staff-recorded photo-only grant',
    as: () => principal(ADMIN, 'organization_admin'),
    send: () =>
      postTo(staffConsent, '/api/pilot/admin/athlete-consent', {
        athlete_id: ATHLETE,
        parent_id: PARENT,
        decision: 'grant',
        covers_video: false,
      }),
    after: { status: 'signed', covers_video: false },
  },
];

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

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Consent Atomic Gym', 'active')`,
    [ORG],
  );
  for (const [accountId, role] of [[ADMIN, 'organization_admin'], [COACH, 'coach'], [PARENT_ACCOUNT, 'parent']]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Pat Guardian')`,
    [ORG, PARENT, PARENT_ACCOUNT],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother')`,
    [ORG, PARENT, ATHLETE],
  );
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Session tape', '', $2 || '/tape.mp4', 'tape.mp4', 1024, 'video/mp4', 'ready', now(), now())`,
    [VIDEO_SESSION, ORG, COACH, ATHLETE],
  );
  await db.query(
    `insert into pilot.video_publications
       (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
        publication_type, title, description, status, compliance_check_status)
     values ($1, $2, $3, $4, $5, 'research_library', 'Jab mechanics', 'Six rounds.', 'published', 'passed')`,
    [PUBLICATION, ORG, VIDEO_SESSION, ATHLETE, COACH],
  );
  await db.query(
    `insert into pilot.research_library (library_id, organization_id, publication_id, video_session_id, title, description)
     values ($1, $2, $3, $4, 'Jab mechanics', 'Six rounds.')`,
    [LIBRARY, ORG, PUBLICATION, VIDEO_SESSION],
  );
  await db.query(
    `create function pilot.consent_atomic_injected_failure() returns trigger language plpgsql as $$
     begin
       raise exception 'injected failure on %', tg_table_name;
     end $$`,
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  parentConsent = (await import('@/app/api/pilot/parent/consent/route')).POST;
  staffConsent = (await import('@/app/api/pilot/admin/athlete-consent/route')).POST;
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

let errorSpy: jest.SpyInstance | undefined;

beforeEach(async () => {
  await stopFailing();
  await resetToPublishedWithVideoConsent();
  // The failure path logs on purpose; silenced so a real diagnostic is not buried.
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy?.mockRestore();
  await stopFailing();
});

/* ── The baseline: unhindered, each change records the consent AND takes the
   video down. Without this, a request the route refused outright would pass
   the rollback cases below. */
describe('with nothing failing', () => {
  test.each(CHANGES)('$name records the consent change and retracts the published video', async (change) => {
    mockRequirePrincipal.mockResolvedValue(change.as());
    const before = await state();

    const response = await change.send();
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, retracted_publication_ids: [PUBLICATION] });
    expect(response.status).toBe(200);
    expect(await state()).toEqual({
      waiverRows: before.waiverRows + 1,
      current: change.after,
      publication: 'retracted',
      shelfSuppressed: true,
    });
  });
});

/* ── The defect: the takedown fails after the consent row is written ─────────
   Before this change the consent row had already committed in its own
   transaction: the guardian's "no video" was on file while the video stayed
   live, and the route answered 500. Now the two roll back together. */
const FAILURE_POINTS = CHANGES.flatMap((change) =>
  (['video_publications', 'research_library'] as const).map((table) => ({ ...change, table })),
);

describe('when the takedown fails', () => {
  test.each(FAILURE_POINTS)('$name, failing on $table: 500, and neither the consent nor the video changed', async (change) => {
    mockRequirePrincipal.mockResolvedValue(change.as());
    const before = await state();
    expect(before).toEqual({
      waiverRows: 1,
      current: { status: 'signed', covers_video: true },
      publication: 'published',
      shelfSuppressed: false,
    });
    const auditsBefore = await rolledBackAuditRows();
    await failTakedown(change.table);

    const response = await change.send();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ ok: false });
    // The injected failure is what happened, not some other 500.
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'P0001' }));

    expect(await state()).toEqual(before);
    expect(await rolledBackAuditRows()).toBe(auditsBefore + 1);
  });

  test.each(CHANGES)('$name: repeated once the takedown works, it is recorded exactly once', async (change) => {
    mockRequirePrincipal.mockResolvedValue(change.as());
    const before = await state();
    await failTakedown();
    expect((await change.send()).status).toBe(500);
    await stopFailing();

    const response = await change.send();

    expect(response.status).toBe(200);
    expect(await state()).toEqual({
      waiverRows: before.waiverRows + 1,
      current: change.after,
      publication: 'retracted',
      shelfSuppressed: true,
    });
  });
});

/* -- Nothing published: the combined path still records the consent ---------
   An athlete with no live video must not have the consent change refused or
   dropped because there was nothing to take down. */
describe('with no published video', () => {
  test.each(CHANGES)('$name records the consent change and retracts nothing', async (change) => {
    mockRequirePrincipal.mockResolvedValue(change.as());
    await db.query(
      `update pilot.video_publications set status = 'archived' where organization_id = $1 and publication_id = $2`,
      [ORG, PUBLICATION],
    );
    const before = await state();

    const response = await change.send();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, retracted_publication_ids: [] });
    expect(await state()).toEqual({
      waiverRows: before.waiverRows + 1,
      current: change.after,
      publication: 'archived',
      shelfSuppressed: false,
    });
  });
});
