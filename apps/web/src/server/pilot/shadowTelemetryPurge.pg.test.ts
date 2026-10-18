// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) deletes a purged person's rows in
// SHADOW's metric log, pilot.shadow_telemetry_events (F-106). The event log's
// ruling applies (Overwatch 2026-10-16, option A, under Jason 2026-10-06:
// "delete any thing that personally Identifys the person"): its one reader,
// listShadowTelemetry, shows a row tied to no athlete to every role that sees
// unscoped rows, so a row naming the person -- as actor, or in its dimensions
// by login, athlete id, an entity id built from them, their guardian record,
// or a record of the child's -- is deleted. Kept: a row tied to a conversation
// or review entry still under the safeguarding hold, another gym's rows for
// the same login, a live child's rows, and rows naming no one.
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

import { listShadowTelemetry } from './shadowReadModels';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-telemetry-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_telemetry_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-st-1';
const OTHER_ORG = 'org-st-2';
// An underscore on purpose: a LIKE pattern built from it would also match "athXa".
const ATHLETE_A = 'ath_a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-st-b'; // live, coached by COACH
const COACH = 'acct-st-coach';
const ADMIN = 'acct-st-admin';
const LOGIN_A = 'acct-st-athlete-a';
const LOGIN_B = 'acct-st-athlete-b';
const GUARDIAN = 'acct-st-guardian'; // purged: deleted 13 months ago, nothing flagged
const GUARDIAN_PARENT_ID = `par-${GUARDIAN}`;
const LIVE_PARENT_ID = 'par-acct-st-live';

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

async function metric(
  organizationId: string, metricName: string, actor: string | null, actorRole: string | null,
  dimensions: Record<string, unknown> = {},
) {
  await db.query(
    `insert into pilot.shadow_telemetry_events (organization_id, metric_name, actor_account_id, actor_role, dimensions)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [organizationId, metricName, actor, actorRole, JSON.stringify(dimensions)],
  );
}

/** The metric names left in a gym, sorted here (each seeded name is unique). */
async function metricsIn(organizationId: string): Promise<string[]> {
  return (await db.query<{ metric_name: string }>(
    'select metric_name from pilot.shadow_telemetry_events where organization_id = $1',
    [organizationId],
  )).rows.map((row) => row.metric_name).sort();
}

// Each PURGED-* row names A or the guardian one way; each KEEP-* row must stay.
const PURGED_IN_ORG = [
  'PURGED-1 actor is A login',
  'PURGED-2 dimensions athlete_id is A',
  'PURGED-3 dimensions entity is A athlete',
  'PURGED-4 dimensions owner_entity_id is A',
  'PURGED-5 dimensions entity is A milestone',
  'PURGED-6 dimensions name A login at depth',
  'PURGED-7 dimensions entity is a live guardian link to A',
  'PURGED-8 actor is the guardian',
  'PURGED-9 dimensions entity is the guardian record',
  'PURGED-10 dimensions entity is the guardian gym membership',
  'PURGED-11 dimensions intake_case_id is a case about A',
];
const KEPT_IN_ORG = [
  'KEEP-1 tied to a held conversation',
  'KEEP-2 tied to a held review entry',
  'KEEP-3 live B row',
  'KEEP-4 names no one',
  'KEEP-5 milestone of another athlete whose id a LIKE pattern would match',
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

  await metric(ORG, PURGED_IN_ORG[0], LOGIN_A, 'athlete', { feature: 'chat' });
  await metric(ORG, PURGED_IN_ORG[1], COACH, 'coach', { athlete_id: ATHLETE_A });
  await metric(ORG, PURGED_IN_ORG[2], COACH, 'coach', { entity_type: 'athlete', entity_id: ATHLETE_A });
  await metric(ORG, PURGED_IN_ORG[3], COACH, 'coach', { owner_entity_id: ATHLETE_A });
  await metric(ORG, PURGED_IN_ORG[4], COACH, 'coach', { entity_type: 'athlete_milestone', entity_id: `${ATHLETE_A}:first_bout` });
  await metric(ORG, PURGED_IN_ORG[5], ADMIN, 'organization_admin', { details: { subject: [LOGIN_A] } });
  await metric(ORG, PURGED_IN_ORG[6], ADMIN, 'organization_admin', { entity_type: 'intake_guardian_link', entity_id: `${LIVE_PARENT_ID}:${ATHLETE_A}` });
  await metric(ORG, PURGED_IN_ORG[7], GUARDIAN, 'parent', { feature: 'upload' });
  await metric(ORG, PURGED_IN_ORG[8], ADMIN, 'organization_admin', { entity_type: 'guardian', entity_id: GUARDIAN_PARENT_ID });
  await metric(ORG, PURGED_IN_ORG[9], ADMIN, 'organization_admin', { entity_type: 'organization_membership', entity_id: `${ORG}:${GUARDIAN}` });
  const caseId = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  await db.query(
    `insert into pilot.intake_cases (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id)
     values ($1, $2::uuid, 'approved', $3, 'intake', $4)`,
    [ORG, caseId, ATHLETE_A, ADMIN],
  );
  await metric(ORG, PURGED_IN_ORG[10], ADMIN, 'organization_admin', { intake_case_id: caseId });

  await metric(ORG, KEPT_IN_ORG[0], LOGIN_A, 'athlete', { conversation_id: heldConversationId });
  await metric(ORG, KEPT_IN_ORG[1], LOGIN_A, 'athlete', { review_id: heldReviewId });
  await metric(ORG, KEPT_IN_ORG[2], LOGIN_B, 'athlete', { athlete_id: ATHLETE_B });
  await metric(ORG, KEPT_IN_ORG[3], COACH, 'coach', { feature: 'library' });
  await metric(ORG, KEPT_IN_ORG[4], COACH, 'coach', { entity_type: 'athlete_milestone', entity_id: 'athXa:first_bout' });

  // The other gym. A control: sign-in opens sessions only in A's home gym, so no writer
  // puts A's login here today; the athlete purge is per gym. The guardian's account is deleted everywhere.
  await metric(OTHER_ORG, 'OTHER-KEEP A in the other gym', LOGIN_A, 'athlete');
  await metric(OTHER_ORG, 'OTHER-PURGED the guardian in the other gym', GUARDIAN, 'parent');
  // A guardian record id is unique only within its gym: the other gym's own record stays.
  await metric(OTHER_ORG, 'OTHER-KEEP a guardian record with the same id in the other gym', null, null, {
    entity_type: 'guardian', entity_id: GUARDIAN_PARENT_ID,
  });
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

describe("the retention purge and a purged person's SHADOW metric rows (F-106)", () => {
  test('a dry run counts the rows it would delete and changes nothing', async () => {
    // Before the purge a coach reads the guardian's row and the one naming A's
    // login: tied to no athlete, they are shown to every coach.
    const before = (await listShadowTelemetry(coach, { limit: 200 })).map((row) => row.metric_name);
    for (const name of [PURGED_IN_ORG[5], PURGED_IN_ORG[7]]) expect(before).toContain(name);
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_delete_shadow_telemetry_events).toBe(PURGED_IN_ORG.length + 1);
    expect(await metricsIn(ORG)).toEqual([...PURGED_IN_ORG, ...KEPT_IN_ORG].sort());
  });

  test('the purge deletes every row that names A or the guardian, and keeps the rest', async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.accounts).toBe(1);
    expect(event.shadow_telemetry_events_deleted).toBe(PURGED_IN_ORG.length + 1);
    expect(await metricsIn(ORG)).toEqual([...KEPT_IN_ORG].sort());
    expect(await metricsIn(OTHER_ORG)).toEqual(['OTHER-KEEP A in the other gym', 'OTHER-KEEP a guardian record with the same id in the other gym']);
  });

  test('read through the real read model, a coach and an admin see none of the purged rows', async () => {
    for (const reader of [coach, orgAdmin]) {
      const seen = (await listShadowTelemetry(reader, { limit: 200 })).map((row) => row.metric_name);
      for (const name of PURGED_IN_ORG) expect(seen).not.toContain(name);
      expect(seen).toContain('KEEP-4 names no one');
    }
  });

  test('the data_purged audit row carries the count and no login', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({ shadow_telemetry_events_deleted: PURGED_IN_ORG.length + 1 });
    const text = JSON.stringify(audit.rows[0].details);
    for (const secret of [LOGIN_A, GUARDIAN, ATHLETE_A]) expect(text).not.toContain(secret);
  });
});
