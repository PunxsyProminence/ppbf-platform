// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) deletes a purged person's entries
// in SHADOW's event log, pilot.shadow_events (Overwatch 2026-10-16, option A;
// Jason 2026-10-06: "delete any thing that personally Identifys the person but
// we keep data that [makes] the Ai and ML better"). A row names the person as
// its actor, as its entity (their login, athlete id, "<athlete>:<key>",
// "par-<account>", "<parent>:<athlete>"), or anywhere in its payload. Kept: a
// row tied to a conversation or review entry still under the safeguarding hold
// (Q7), another gym's rows for the same login, a live child's rows, rows
// naming no one, and pilot.audit_events. Read through the real read model, a
// coach sees none of the purged rows afterwards (de-identifying them instead
// would have made them athlete-free, and visible).
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

// Routes the read model's queries into the embedded database. Declared before
// the imports so jest's mock hoisting sees it.
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

import { listShadowEvents } from './shadowReadModels';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-events-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_events_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-se-1';
const OTHER_ORG = 'org-se-2';
// An underscore on purpose: a LIKE pattern built from it would also match "athXa".
const ATHLETE_A = 'ath_a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-se-b'; // live, coached by COACH
const COACH = 'acct-se-coach';
const ADMIN = 'acct-se-admin';
const LOGIN_A = 'acct-se-athlete-a';
const LOGIN_B = 'acct-se-athlete-b';
const GUARDIAN = 'acct-se-guardian'; // purged: deleted 13 months ago, nothing flagged
const GUARDIAN_PARENT_ID = `par-${GUARDIAN}`;
const LIVE_PARENT_ID = 'par-acct-se-live';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let heldConversationId: string;
let heldReviewId: string;

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

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

async function event(
  organizationId: string, eventName: string, entityType: string, entityId: string,
  actor: string | null, actorRole: string | null, payload: Record<string, unknown> = {},
) {
  await db.query(
    `insert into pilot.shadow_events (organization_id, event_name, entity_type, entity_id, actor_account_id, actor_role, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [organizationId, eventName, entityType, entityId, actor, actorRole, JSON.stringify(payload)],
  );
}

/** The event names left in a gym, sorted here, not by the server's collation (each seeded name is unique). */
async function eventsIn(organizationId: string): Promise<string[]> {
  return (await db.query<{ event_name: string }>(
    'select event_name from pilot.shadow_events where organization_id = $1',
    [organizationId],
  )).rows.map((row) => row.event_name).sort();
}

// Each PURGED-* row names A or the guardian one way; each KEEP-* row must stay.
const PURGED_IN_ORG = [
  'PURGED-1 actor is A (a typed Library question)',
  'PURGED-2 entity is A login (account row)',
  'PURGED-3 entity is A athlete id',
  'PURGED-4 entity is A milestone',
  'PURGED-5 payload names A (video upload)',
  'PURGED-6 payload names A at depth (pain report)',
  'PURGED-7 entity is a live guardian link to A',
  'PURGED-8 actor is the guardian',
  'PURGED-9 entity is the guardian record',
  'PURGED-10 entity is the guardian link to live B',
  'PURGED-11 payload names A login',
  'PURGED-12 entity is the guardian gym membership',
  'PURGED-13 an upload filed under an intake case about A',
  'PURGED-14 entity is an intake case about A',
  'PURGED-15 promotion of a case about B that names A',
  'PURGED-16 upload of that case, naming no one, so the queue reads the case own status',
];
const KEPT_IN_ORG = [
  'KEEP-1 tied to a held conversation',
  'KEEP-2 entity is a held review entry',
  'KEEP-3 live B row',
  'KEEP-4 names no one (library source)',
  'KEEP-5 milestone of another athlete whose id a LIKE pattern would match',
  'KEEP-6 a guardian link of another parent whose id a LIKE pattern would match',
];

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
  activeClient = db;
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, athleteId] of [
    [COACH, 'coach', null],
    [ADMIN, 'organization_admin', null],
    [LOGIN_A, 'athlete', ATHLETE_A],
    [LOGIN_B, 'athlete', ATHLETE_B],
    [GUARDIAN, 'parent', null],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, ORG, athleteId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', false, $4, now(), now(), now() - interval '3 years'),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now(), null)`,
    [ORG, ATHLETE_A, ATHLETE_B, COACH],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, $2, $3, 'Gale Pike', '555-0100', 'g@example.test')`,
    [ORG, GUARDIAN_PARENT_ID, GUARDIAN],
  );
  await db.query(`update pilot.accounts set deleted_at = now() - interval '13 months' where account_id = $1`, [GUARDIAN]);

  // A conversation of a live parent's still held for safeguarding, with its review entry.
  heldConversationId = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  heldReviewId = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, subject_deleted_at)
     values ($1, $2, $3, now() - interval '1 month')`,
    [heldConversationId, ORG, COACH],
  );
  await db.query(
    `insert into pilot.shadow_human_review_queue
       (review_id, organization_id, conversation_id, account_id, category, severity, summary, subject_deleted_at)
     values ($1, $2, $3, $4, 'safeguarding', 'high', 'held', now() - interval '1 month')`,
    [heldReviewId, ORG, heldConversationId, COACH],
  );

  await event(ORG, PURGED_IN_ORG[0], 'shadow_library', 'claims:1', LOGIN_A, 'athlete', { knowledge_gap: 'WORDS-A how do I cut weight' });
  await event(ORG, PURGED_IN_ORG[1], 'account', LOGIN_A, ADMIN, 'organization_admin', { event_type: 'update', details: {} });
  await event(ORG, PURGED_IN_ORG[2], 'athlete', ATHLETE_A, COACH, 'coach');
  await event(ORG, PURGED_IN_ORG[3], 'athlete_milestone', `${ATHLETE_A}:first_bout`, COACH, 'coach');
  await event(ORG, PURGED_IN_ORG[4], 'video_session', 'vid-se-1', COACH, 'coach', { athlete_id: ATHLETE_A, title: 'WORDS-A sparring' });
  await event(ORG, PURGED_IN_ORG[5], 'pain_report', 'pain-se-1', COACH, 'coach', { context: { athletes: [ATHLETE_A] }, location: 'wrist' });
  await event(ORG, PURGED_IN_ORG[6], 'intake_guardian_link', `${LIVE_PARENT_ID}:${ATHLETE_A}`, ADMIN, 'organization_admin');
  await event(ORG, PURGED_IN_ORG[7], 'intake_case', 'case-se-1', GUARDIAN, 'parent', { notes: 'WORDS-G my son' });
  await event(ORG, PURGED_IN_ORG[8], 'guardian', GUARDIAN_PARENT_ID, ADMIN, 'organization_admin');
  await event(ORG, PURGED_IN_ORG[9], 'intake_guardian_link', `${GUARDIAN_PARENT_ID}:${ATHLETE_B}`, ADMIN, 'organization_admin');
  await event(ORG, PURGED_IN_ORG[10], 'shadow_human_review', 'rev-se-1', ADMIN, 'organization_admin', { details: { subjectAccountId: LOGIN_A } });

  await event(ORG, KEPT_IN_ORG[0], 'shadow_chat', 'turn-se-1', LOGIN_A, 'athlete', { conversation_id: heldConversationId });
  await event(ORG, KEPT_IN_ORG[1], 'shadow_human_review', heldReviewId, LOGIN_A, 'athlete');
  await event(ORG, KEPT_IN_ORG[2], 'athlete', ATHLETE_B, LOGIN_B, 'athlete', { athlete_id: ATHLETE_B });
  await event(ORG, KEPT_IN_ORG[3], 'shadow_library_source', 'src-se-1', COACH, 'coach', { title: 'Footwork basics' });
  await event(ORG, KEPT_IN_ORG[4], 'athlete_milestone', 'athXa:first_bout', COACH, 'coach');
  await event(ORG, KEPT_IN_ORG[5], 'intake_guardian_link', 'par-acct-seXguardian:ath-se-b', ADMIN, 'organization_admin');

  // The other gym: A's login is active there too; the guardian's account is deleted everywhere.
  await event(OTHER_ORG, 'OTHER-KEEP A in the other gym', 'shadow_library', 'claims:2', LOGIN_A, 'athlete');
  await event(OTHER_ORG, 'OTHER-PURGED the guardian in the other gym', 'intake_case', 'case-se-2', GUARDIAN, 'parent');
  // A guardian record id is unique only within its gym: the other gym's own "par-..." record stays.
  await event(OTHER_ORG, 'OTHER-KEEP a guardian record with the same id in the other gym', 'guardian', GUARDIAN_PARENT_ID, null, null);

  await event(ORG, PURGED_IN_ORG[11], 'organization_membership', `${ORG}:${GUARDIAN}`, ADMIN, 'organization_admin', { role: 'parent' });
  const caseId = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  await db.query(
    `insert into pilot.intake_cases (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id)
     values ($1, $2::uuid, 'approved', $3, 'intake', $4)`,
    [ORG, caseId, ATHLETE_A, ADMIN],
  );
  await event(ORG, PURGED_IN_ORG[12], 'shadow_intake', 'intake-se-1', ADMIN, 'organization_admin', {
    intake_case_id: caseId, file_name: 'WORDS-A physical.pdf',
  });
  await event(ORG, PURGED_IN_ORG[13], 'intake_case', caseId, ADMIN, 'organization_admin');
  const caseB = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  await db.query(
    `insert into pilot.intake_cases (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id)
     values ($1, $2::uuid, 'promoted', $3, 'intake', $4)`,
    [ORG, caseB, ATHLETE_B, ADMIN],
  );
  await event(ORG, PURGED_IN_ORG[15], 'shadow_intake', 'intake-se-2', ADMIN, 'organization_admin', { intake_case_id: caseB });
  await event(ORG, PURGED_IN_ORG[14], 'intake_case', caseB, ADMIN, 'organization_admin', { athlete_ids: [ATHLETE_B, ATHLETE_A] });

  // The legal record, which this purge does not touch.
  await db.query(
    `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, actor_account_id, details)
     values ('update', $1, 'account', $2, $3, '{}'::jsonb)`,
    [ORG, LOGIN_A, ADMIN],
  );
});

afterAll(async () => {
  activeClient = null;
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

const coach = { organizationId: ORG, actorAccountId: COACH, actorRole: 'coach' as const };
const orgAdmin = { organizationId: ORG, actorAccountId: ADMIN, actorRole: 'organization_admin' as const };

describe("the retention purge and a purged person's SHADOW event log rows", () => {
  test('a dry run counts the rows it would delete and changes nothing', async () => {
    // Before the purge a coach can read the guardian's rows and the one naming
    // A's login: tied to no athlete, they are shown to every coach.
    const before = (await listShadowEvents(coach, { limit: 200 })).map((row) => row.event_name);
    for (const name of [PURGED_IN_ORG[7], PURGED_IN_ORG[8], PURGED_IN_ORG[10]]) expect(before).toContain(name);
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_delete_shadow_events).toBe(PURGED_IN_ORG.length + 1);
    expect(await eventsIn(ORG)).toEqual([...PURGED_IN_ORG, ...KEPT_IN_ORG].sort());
  });

  test('the purge deletes every row that names A or the guardian, and keeps the rest', async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.accounts).toBe(1);
    expect(event.shadow_events_deleted).toBe(PURGED_IN_ORG.length + 1);
    expect(await eventsIn(ORG)).toEqual([...KEPT_IN_ORG].sort());
    expect(await eventsIn(OTHER_ORG)).toEqual(['OTHER-KEEP A in the other gym', 'OTHER-KEEP a guardian record with the same id in the other gym']);
    const words = await db.query(
      `select count(*) as n from pilot.shadow_events where payload::text like '%WORDS-%'`,
    );
    expect(Number(words.rows[0].n)).toBe(0);
  });

  test('read through the real read model, a coach sees none of the purged rows; the live and athlete-free rows still show', async () => {
    const seen = (await listShadowEvents(coach, { limit: 200 })).map((row) => row.event_name);
    for (const name of PURGED_IN_ORG) expect(seen).not.toContain(name);
    expect(seen).toContain('KEEP-3 live B row');
    expect(seen).toContain('KEEP-4 names no one (library source)');
    const adminSeen = (await listShadowEvents(orgAdmin, { limit: 200 })).map((row) => row.event_name);
    for (const name of PURGED_IN_ORG) expect(adminSeen).not.toContain(name);
  });

  test('the audit log is untouched', async () => {
    const audit = await db.query(
      `select count(*) as n from pilot.audit_events where organization_id = $1 and entity_id = $2 and event_type = 'update'`,
      [ORG, LOGIN_A],
    );
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  test('the data_purged audit row carries the count and no login', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({ shadow_events_deleted: PURGED_IN_ORG.length + 1 });
    const text = JSON.stringify(audit.rows[0].details);
    for (const secret of [LOGIN_A, GUARDIAN, ATHLETE_A]) expect(text).not.toContain(secret);
  });
});
