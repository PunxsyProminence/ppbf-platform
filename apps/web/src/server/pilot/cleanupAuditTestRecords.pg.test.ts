// Real PostgreSQL coverage for scripts/pilot-cleanup-audit-test-records.mjs,
// the dry-run report of the audit test records left in a gym (pilot blocker
// B6; lane W5-B6, B6-1; App Overwatch's GO on #2227).
//
// The fixture is the full production schema (scripts/lib/full-schema.mjs) with
// a real gym and records of every kind the tool must tell apart:
//   - the three STRICT test classes the brief names, plus one running now with
//     a live tied run and one an activity_log row names (both refuse an apply);
//   - NEAR classes (leading space, lower case) and a real class whose title has
//     "AUDIT TEST" mid-string -- none planned;
//   - a STRICT class in another gym (out of a one-gym scope);
//   - TVs: one STRICT, one NEAR, one real;
//   - notes: one STRICT, one NEAR, one real; an athlete whose name is STRICT;
//   - Audit Test Gyms, "hiit fit" (id danielles) and Danielle's HIIT Fit.
// The test athlete's id carries a name-like sentinel. No output may contain it
// raw: the GO's "no raw person id in any output".
//
// Local-only embedded Postgres. The tool's run() is called only with a
// connection string this suite built for its own embedded server.

import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-audit-test-cleanup-pg-test-${process.pid}-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const TOOL_PATH = path.join(WEB_DIR, 'scripts/pilot-cleanup-audit-test-records.mjs');

const TEMPLATE_DB = 'ppbf_audit_test_cleanup_template';
const GYM = 'org-b6-gym';
const OTHER = 'org-b6-other';
const TEST_GYM_1 = 'audit-test-gym-b6-1';
const TEST_GYM_2 = 'audit-test-gym-b6-2';
const HIIT_FIT_ID = 'danielles';
const DANIELLES_HIIT = 'hiit_boxing_danielle';
const COACH = 'acct-b6-coach';
// Athlete ids are free text, so one may carry a name. These must never print raw.
const TEST_ATHLETE = 'athlete-SENTINEL-Avery-Example';
const NAMED_ATHLETE = 'athlete-SENTINEL-Blake-Example';
const REAL_ATHLETE = 'athlete-b6-real';
// Stands in for free text a record holds. Must never print.
const TEXT_SENTINEL = 'SENTINEL-TEXT-Casey';
const DAY = 24 * 60 * 60 * 1000;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type ClassReport = {
  organization_id: string; class_id: string; marker: string; status: string;
  registrations: Array<{ registration_id: string; athlete_ref: string; status: string }>;
  attendance: Array<{ attendance_id: string; athlete_ref: string; status: string }>;
  tied_runs: Array<{ run_id: string; run_state: string }>;
  register_marks: Array<{ run_id: string; athlete_ref: string }>;
  distinct_athletes: number;
  untracked_references: { activity_log: number; floor_plans_daily: number };
  audit_rows_about_it: number;
  apply_would_refuse: string[];
};
type Hit = { table: string; column: string; key: Record<string, string>; organization_id: string | null; marker?: string };
type Result = {
  status: string;
  kinds?: string[] | null;
  note?: string;
  expected?: string;
  class_ids?: Array<{ organization_id: string; class_id: string }>;
  tv_ids?: Array<{ organization_id: string; tv_id: string }>;
  organization_set_inactive?: string | null;
  audit_rows?: number;
  mismatches?: string[];
  triggers?: string[];
  reasons?: string[];
  table?: string;
  planned?: number;
  written?: number;
  person_ref?: string;
  reason?: string;
  plan_fingerprint?: string;
  counts?: Record<string, number | boolean>;
  unknown_foreign_keys?: string[];
  missing_foreign_keys?: string[];
  classes?: ClassReport[];
  tvs?: { marked: Array<Record<string, unknown>>; others: Array<Record<string, unknown>> };
  test_organizations?: Array<{ organization_id: string; status: string; members_by_role: Record<string, number>; rows_by_table: Record<string, number> }>;
  hiit_fit?: Record<string, unknown>;
  sweep?: {
    tables_scanned: number; columns_scanned: number; columns_not_swept_by_type: Record<string, number>;
    tables_skipped_no_organization_column: string[]; truncated_tables: string[]; strict: Hit[]; near: Hit[];
    tables_failed: Array<{ table: string; code: string }>;
  };
  missing?: string[];
};
type Options = Record<string, unknown>;
type Deps = { log?: (event: string, payload: Record<string, unknown>) => void; createClient?: (cs: string) => unknown; refKey?: string };
type ReportFn = (client: unknown, options: Options, deps?: Deps) => Promise<Result>;
type RunFn = (env: Record<string, string>, argv: string[], deps?: Deps) => Promise<Result>;
type ParseFn = (env: Record<string, string>, argv: string[]) => { ok: boolean; refusal?: { reason: string }; options?: Options };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let report: ReportFn;
let reportWithoutKey: ReportFn;
let apply: ReportFn;
let planFingerprint: (scope: unknown, kinds: string[] | undefined, material: unknown) => string;
let runTool: RunFn;
let parseOptions: ParseFn;
let printableKey: (column: string, type: string, value: unknown, key: string) => string | null;
let databaseCounter = 0;

// Stands in for the PPBF_AUDIT_TEST_CLEANUP_REF_KEY environment secret (QR A, #2227).
const TEST_REF_KEY = 'b6-test-ref-key-not-a-real-secret';
/** Computed here, not by the tool, so a broken personRef cannot agree with itself. */
const ref = (value: string) => crypto.createHmac('sha256', TEST_REF_KEY).update(value).digest('hex').slice(0, 12);

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

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

/** Captures every line the tool logs, as the JSON text it would print. */
function recorder() {
  const lines: string[] = [];
  return {
    log: (event: string, payload: Record<string, unknown>) => { lines.push(JSON.stringify({ event, ...payload })); },
    text: () => lines.join('\n'),
  };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function insertClass(target: Client, org: string, classId: string, title: string, opts: { start?: string; end?: string; status?: string } = {}) {
  await target.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $3, $4, $5, 'Main floor', 20, $6, $6, $7)`,
    [org, classId, title, opts.start ?? '2026-10-05T22:00:00Z', opts.end ?? '2026-10-05T23:00:00Z', COACH, opts.status ?? 'open'],
  );
}

async function insertAthlete(target: Client, org: string, athleteId: string, fullName: string) {
  await target.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact,
        active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $3, '2012-01-01', 'open', 'active', 'on file', true, $4, now(), now())`,
    [org, athleteId, fullName, COACH],
  );
}

async function insertTv(target: Client, org: string, tvId: string, name: string) {
  await target.query('insert into pilot.gym_tvs (organization_id, tv_id, tv_name) values ($1, $2, $3)', [org, tvId, name]);
}

async function insertNote(target: Client, noteId: string, athleteId: string, text: string) {
  await target.query(
    `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
     values ($1, $2, $3, $4, 'observation', $5)`,
    [GYM, noteId, athleteId, COACH, text],
  );
}

// The app writes registration and attendance ids as uuids (scheduler route).
const REG_TEST = 'aaaaaaaa-0000-4000-8000-000000000001';
const REG_REAL = 'aaaaaaaa-0000-4000-8000-000000000002';
const ATT_TEST = 'aaaaaaaa-0000-4000-8000-000000000003';
// An email inside a key with no person-like name (app/api/pilot/auth/password/login/route.ts).
const BUCKET_KEY = 'password_login_email:parent+zz-audit@example.org';
const NOTE_STRICT = '11111111-1111-4111-8111-111111111111';
const NOTE_NEAR = '22222222-2222-4222-8222-222222222222';
const NOTE_REAL = '33333333-3333-4333-8333-333333333333';

async function buildTemplate(target: Client): Promise<void> {
  await target.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values
       ($1, 'B6 Real Gym', 'active'), ($2, 'B6 Other Gym', 'active'),
       ($3, 'Audit Test Gym', 'inactive'), ($4, 'AUDIT TEST GYM 2', 'active'),
       ($5, 'hiit fit', 'active'), ($6, 'Danielle''s HIIT Fit', 'active')`,
    [GYM, OTHER, TEST_GYM_1, TEST_GYM_2, HIIT_FIT_ID, DANIELLES_HIIT],
  );
  await target.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, GYM],
  );
  await target.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach'), ($1, $3, 'coach')`,
    [COACH, GYM, TEST_GYM_2],
  );
  await insertAthlete(target, GYM, TEST_ATHLETE, 'Test Athlete');
  await insertAthlete(target, GYM, NAMED_ATHLETE, `ZZ-AUDIT Kid ${TEXT_SENTINEL}`);
  await insertAthlete(target, GYM, REAL_ATHLETE, 'Real Athlete');

  // The three the brief names, all past.
  await insertClass(target, GYM, 'c-strict-1', 'ZZ-AUDIT Test Class');
  await insertClass(target, GYM, 'c-strict-2', 'AUDIT TEST 2026-10-14 CANCEL TEST CLASS',
    { start: '2026-10-14T22:00:00Z', end: '2026-10-14T23:00:00Z', status: 'cancelled' });
  await insertClass(target, GYM, 'c-strict-3', 'ZZ-AUDIT LA2 2026-10-19 class', { start: '2026-10-19T22:00:00Z', end: '2026-10-19T23:00:00Z' });
  // STRICT, but an apply must refuse them.
  await insertClass(target, GYM, 'c-strict-live', 'ZZ-AUDIT running now', { start: iso(-30 * 60 * 1000), end: iso(30 * 60 * 1000) });
  await insertClass(target, GYM, 'c-strict-untracked', 'AUDIT TEST named by the activity log');
  // NEAR and real: never planned.
  await insertClass(target, GYM, 'c-near-space', ' ZZ-AUDIT with a leading space');
  await insertClass(target, GYM, 'c-near-lower', 'zz-audit lower case');
  await insertClass(target, GYM, 'c-near-audit-test', 'Audit test in title case');
  await insertClass(target, GYM, 'c-near-tab', '\tAUDIT TEST after a tab');
  await insertClass(target, GYM, 'c-near-nbsp', '\u00a0AUDIT TEST after a no-break space');
  await insertClass(target, GYM, 'c-near-emspace', '\u2003AUDIT TEST after an em space');
  await insertClass(target, GYM, 'c-near-nel', '\u0085AUDIT TEST after a next-line character');
  await insertClass(target, GYM, 'c-real', 'Tuesday boxing, not an AUDIT TEST', { start: iso(DAY), end: iso(DAY + 60 * 60 * 1000) });
  await insertClass(target, OTHER, 'c-other-strict', 'ZZ-AUDIT in another gym');

  await target.query(
    `insert into pilot.scheduler_registrations
       (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
     values ($1, $5, 'c-strict-3', $2, 'coach', $4, 'registered'),
            ($1, $6, 'c-real', $3, 'coach', $4, 'registered')`,
    [GYM, TEST_ATHLETE, REAL_ATHLETE, COACH, REG_TEST, REG_REAL],
  );
  await target.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
        checked_in_by_account_id, note, checked_in_at)
     values ($1, $5, 'c-strict-3', $2, 'present', 'coach_override', 'coach', $3, $4, '2026-10-19T22:05:00Z')`,
    [GYM, TEST_ATHLETE, COACH, `ZZ-AUDIT LA2 ${TEXT_SENTINEL}`, ATT_TEST],
  );
  await target.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, delivered_by_account_id, delivered_on, run_state, started_at, ended_at, class_id)
     values ($1, 'run-done', $2, '2026-10-19', 'completed', '2026-10-19T22:00:00Z', '2026-10-19T23:00:00Z', 'c-strict-3'),
            ($1, 'run-live', $2, current_date, 'in_progress', now() - interval '20 minutes', null, 'c-strict-live')`,
    [GYM, COACH],
  );
  await target.query(
    `insert into pilot.session_run_athletes
       (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role, register_class_id, register_written_at)
     values ($1, 'run-done', $2, $3, 'coach', 'c-strict-3', '2026-10-19T22:05:00Z')`,
    [GYM, TEST_ATHLETE, COACH],
  );
  await target.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, activity_domain, activity_type, occurred_on,
        duration_minutes, capture_method, recorded_by_role, recorded_by_account_id, class_id)
     values ($1, 'act-1', $2, 'boxing_training', 'technical_session', '2026-10-05', 60, 'coach_override', 'coach', $2, 'c-strict-untracked')`,
    [GYM, COACH],
  );
  await target.query(
    `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
     values ('update', $1, 'scheduler_class', 'c-strict-3', '{}'::jsonb),
            ('update', $1, 'scheduler_attendance', $2, '{}'::jsonb),
            ('update', $1, 'something_else', 'c-strict-3', '{}'::jsonb)`,
    [GYM, `c-strict-3:${TEST_ATHLETE}`],
  );
  await target.query(
    "insert into pilot.auth_rate_limit_buckets (bucket_key, attempt_count, blocked_until) values ($1, 1, now())",
    [BUCKET_KEY],
  );

  await insertTv(target, GYM, 'tv-strict', 'ZZ-AUDIT TV');
  await insertTv(target, GYM, 'tv-near', 'zz-audit spare screen');
  await insertTv(target, GYM, 'tv-real', `Ring TV ${TEXT_SENTINEL}`);
  await insertTv(target, OTHER, 'tv-other-strict', 'ZZ-AUDIT TV in another gym');

  await insertNote(target, NOTE_STRICT, TEST_ATHLETE, `ZZ-AUDIT LA2 2026-10-19 note ${TEXT_SENTINEL}`);
  await insertNote(target, NOTE_NEAR, TEST_ATHLETE, `Written on the zz-audit walk ${TEXT_SENTINEL}`);
  await insertNote(target, NOTE_REAL, REAL_ATHLETE, `Good jab ${TEXT_SENTINEL}`);
}

async function freshDatabase(): Promise<{ client: Client; name: string }> {
  databaseCounter += 1;
  const name = `ppbf_audit_test_cleanup_${databaseCounter}`;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return { client, name };
}

/** Row count and a content hash for every base table in the pilot schema. */
async function snapshot(target: Client): Promise<Record<string, string>> {
  const tables = await target.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'pilot' and table_type = 'BASE TABLE' order by table_name`,
  );
  const out: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const result = await target.query<{ n: number; h: string }>(
      `select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
         from pilot."${table.replace(/"/g, '""')}" t`,
    );
    out[table] = `${result.rows[0].n}:${result.rows[0].h}`;
  }
  return out;
}

function envFor(database: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(database),
    PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
    PPBF_EXPECTED_POSTGRES_DATABASE: database,
    PPBF_AUDIT_TEST_CLEANUP_REF_KEY: TEST_REF_KEY,
    ...overrides,
  };
}

/** No raw person id and no record text, anywhere in `text`. */
function expectNothingRaw(text: string) {
  for (const raw of [TEST_ATHLETE, NAMED_ATHLETE, REAL_ATHLETE, TEXT_SENTINEL, 'SENTINEL', 'example.org']) expect(text).not.toContain(raw);
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 240_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (c: Client, o?: { infraDir?: string }) => Promise<unknown>;
  const tool = await nativeDynamicImport(pathToFileURL(TOOL_PATH).href);
  reportWithoutKey = tool.reportAuditTestRecords as ReportFn;
  report = (client, options, deps) => reportWithoutKey(client, options, { refKey: TEST_REF_KEY, ...deps } as Deps);
  apply = (client, options, deps) => (tool.applyAuditTestRecords as ReportFn)(client, options, { refKey: TEST_REF_KEY, ...deps } as Deps);
  runTool = tool.run as RunFn;
  planFingerprint = tool.planFingerprint as typeof planFingerprint;
  parseOptions = tool.parseOptions as ParseFn;
  printableKey = tool.printableKey as (column: string, type: string, value: unknown, key: string) => string | null;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB} encoding 'UTF8' template template0`);
  await admin.end();
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await buildTemplate(template);
  } finally {
    // A template must have no open sessions when it is cloned.
    await template.end();
  }
});

afterAll(async () => {
  if (!serverProcess) return;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('K1 classes, one gym', () => {
  test('plans exactly the STRICT classes, with what hangs off them and what an apply would refuse; writes nothing', async () => {
    const { client } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const out = recorder();
      const result = await report(client, { organizationId: GYM }, { log: out.log });
      expect(result.status).toBe('dry-run');
      expect(result.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      const classes = result.classes!;
      expect(classes.map((c) => [c.class_id, c.marker])).toEqual([
        ['c-strict-1', 'ZZ-AUDIT'], ['c-strict-2', 'AUDIT TEST'], ['c-strict-3', 'ZZ-AUDIT'],
        ['c-strict-live', 'ZZ-AUDIT'], ['c-strict-untracked', 'AUDIT TEST'],
      ]);
      const la2 = classes.find((c) => c.class_id === 'c-strict-3')!;
      expect(la2.registrations).toEqual([{ registration_id: REG_TEST, athlete_ref: ref(TEST_ATHLETE), status: 'registered' }]);
      expect(la2.attendance).toEqual([{ attendance_id: ATT_TEST, athlete_ref: ref(TEST_ATHLETE), status: 'present' }]);
      expect(la2.tied_runs).toEqual([{ run_id: 'run-done', run_state: 'completed' }]);
      expect(la2.register_marks).toEqual([{ run_id: 'run-done', athlete_ref: ref(TEST_ATHLETE) }]);
      expect(la2.distinct_athletes).toBe(1);
      // Its own scheduler_class row and the "<class>:<athlete>" row; not the unrelated one.
      expect(la2.audit_rows_about_it).toBe(2);
      expect(la2.apply_would_refuse).toEqual([]);
      expect(classes.find((c) => c.class_id === 'c-strict-2')!.status).toBe('cancelled');
      expect(classes.find((c) => c.class_id === 'c-strict-live')!.apply_would_refuse).toEqual(['TIED_RUN_LIVE', 'CLASS_RUNNING_NOW']);
      const untracked = classes.find((c) => c.class_id === 'c-strict-untracked')!;
      expect(untracked.untracked_references).toEqual({ activity_log: 1, floor_plans_daily: 0 });
      expect(untracked.apply_would_refuse).toEqual(['UNTRACKED_REFERENCE']);
      expect(result.unknown_foreign_keys).toEqual([]);
      expect(result.counts).toMatchObject({ classes: 5, registrations: 1, attendance: 1 });
      expectNothingRaw(out.text());
      expect(out.text()).toContain(ref(TEST_ATHLETE));
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('every organization: the other gym\'s STRICT class is planned too', async () => {
    const { client } = await freshDatabase();
    try {
      const result = await report(client, { allOrganizations: true }, { log: () => {} });
      expect(result.classes!.map((c) => c.class_id)).toEqual([
        // Ordered by organization, then class: org-b6-gym sorts before org-b6-other.
        'c-strict-1', 'c-strict-2', 'c-strict-3', 'c-strict-live', 'c-strict-untracked', 'c-other-strict',
      ]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a new table', `create table pilot.zz_b6_probe (organization_id text, class_id text,
       foreign key (organization_id, class_id) references pilot.scheduler_classes(organization_id, class_id))`,
    'pilot.zz_b6_probe(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) a()'],
    ['a second key between known tables', `alter table pilot.scheduler_registrations add constraint zz_b6_second
       foreign key (organization_id, class_id) references pilot.scheduler_classes(organization_id, class_id) on delete restrict`,
    'pilot.scheduler_registrations(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) r()'],
    ['the run tie changed to cascade', `alter table pilot.session_script_runs drop constraint pilot_ssrun_class_fk;
       alter table pilot.session_script_runs add constraint pilot_ssrun_class_fk foreign key (organization_id, class_id)
         references pilot.scheduler_classes(organization_id, class_id) on delete cascade`,
    'pilot.session_script_runs(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) c()'],
  ])('a foreign key into the class tables the tool does not know (%s) refuses every class', async (_label, ddl, named) => {
    const { client } = await freshDatabase();
    try {
      const before = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(before.unknown_foreign_keys).toEqual([]);
      await client.query(ddl);
      const result = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(result.unknown_foreign_keys).toEqual([named]);
      for (const c of result.classes!) expect(c.apply_would_refuse).toContain('UNKNOWN_FOREIGN_KEY');
      expect(result.plan_fingerprint).not.toBe(before.plan_fingerprint);
    } finally {
      await client.end();
    }
  });
});

describe('the STRICT break (QS A)', () => {
  test('a marker must be followed by the end or a character that is not a letter or digit', async () => {
    const { client } = await freshDatabase();
    try {
      const titles: Array<[string, string, boolean]> = [
        ['c-edge-bare', 'ZZ-AUDIT', true],
        ['c-edge-hyphen', 'ZZ-AUDIT-LA2 rerun', true],
        ['c-edge-colon', 'AUDIT TEST: rerun', true],
        ['c-edge-underscore', 'AUDIT TEST_rerun', true],
        ['c-edge-testing', 'AUDIT TESTING day for coaches', false],
        ['c-edge-auditorium', 'ZZ-AUDITORIUM booking', false],
        ['c-edge-digit', 'ZZ-AUDIT2 class', false],
        ['c-edge-accent', 'AUDIT TEST\u00e9 class', false],
        ['c-edge-nbsp', 'ZZ-AUDIT\u00a0class', false],
      ];
      for (const [id, title] of titles) await insertClass(client, OTHER, id, title);
      const result = await report(client, { organizationId: OTHER }, { log: () => {} });
      const planned = result.classes!.map((c) => c.class_id);
      const near = result.sweep!.near.filter((h) => h.table === 'scheduler_classes').map((h) => h.key.class_id);
      for (const [id, , strict] of titles) {
        expect(planned.includes(id)).toBe(strict);
        expect(near.includes(id)).toBe(!strict);
      }
    } finally {
      await client.end();
    }
  });
});

describe('known foreign keys', () => {
  test.each([
    ['the run tie', 'alter table pilot.session_script_runs drop constraint pilot_ssrun_class_fk',
      'pilot.session_script_runs(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) n(class_id)'],
    ['the register pointer', 'alter table pilot.session_run_athletes drop constraint pilot_session_run_athletes_register_fk',
      'pilot.session_run_athletes(organization_id,register_class_id,athlete_id)->pilot.scheduler_attendance(organization_id,class_id,athlete_id) n(register_class_id)'],
    ['the registrations cascade', 'alter table pilot.scheduler_registrations drop constraint scheduler_registrations_organization_id_class_id_fkey',
      'pilot.scheduler_registrations(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) c()'],
  ])('one missing (%s) refuses every class and moves the fingerprint', async (_label, ddl, named) => {
    const { client } = await freshDatabase();
    try {
      const before = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(before.missing_foreign_keys).toEqual([]);
      await client.query(ddl);
      const result = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(result.missing_foreign_keys).toEqual([named]);
      expect(result.unknown_foreign_keys).toEqual([]);
      for (const c of result.classes!) expect(c.apply_would_refuse).toContain('KNOWN_FOREIGN_KEY_MISSING');
      expect(result.plan_fingerprint).not.toBe(before.plan_fingerprint);
    } finally {
      await client.end();
    }
  });
});

describe('the fingerprint', () => {
  const print = async (client: Client, options: Options) => (await report(client, options, { log: () => {} })).plan_fingerprint;

  test('is stable, and does not move with NEAR rows, sweep-only rows, audit history, members or other gyms\' data', async () => {
    const { client } = await freshDatabase();
    try {
      const gym = await print(client, { organizationId: GYM });
      const all = await print(client, { allOrganizations: true });
      expect(await print(client, { organizationId: GYM })).toBe(gym);
      expect(all).not.toBe(gym);

      await insertClass(client, GYM, 'c-near-new', 'zz-audit another near miss');
      await insertTv(client, GYM, 'tv-near-new', 'Audit test spare');
      await insertNote(client, '44444444-4444-4444-8444-444444444444', REAL_ATHLETE, 'ZZ-AUDIT new note');
      await client.query(
        `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
         values ('login', $1, 'account', 'acct-x', '{}'::jsonb), ('login', $2, 'account', 'acct-y', '{}'::jsonb)`,
        [TEST_GYM_2, HIIT_FIT_ID],
      );
      await client.query("update pilot.organization_memberships set role = 'organization_admin' where organization_id = $1", [TEST_GYM_2]);
      await client.query(
        `insert into pilot.activity_log (organization_id, activity_id, person_account_id, activity_domain, activity_type, occurred_on,
           duration_minutes, capture_method, recorded_by_role, recorded_by_account_id, class_id)
         values ($1, 'act-2', $2, 'boxing_training', 'technical_session', '2026-10-06', 30, 'coach_override', 'coach', $2, 'c-strict-untracked')`,
        [GYM, COACH],
      );
      expect(await print(client, { organizationId: GYM })).toBe(gym);
      expect(await print(client, { allOrganizations: true })).toBe(all);
    } finally {
      await client.end();
    }
  });

  test('moves when a planned class stops running, with its times unchanged (only the clock moves)', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        "update pilot.scheduler_classes set start_at = now() - interval '1 hour', end_at = now() + interval '2 seconds' where class_id = 'c-strict-1'",
      );
      const before = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(before.classes!.find((c) => c.class_id === 'c-strict-1')!.apply_would_refuse).toEqual(['CLASS_RUNNING_NOW']);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const after = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(after.classes!.find((c) => c.class_id === 'c-strict-1')!.apply_would_refuse).toEqual([]);
      expect(after.plan_fingerprint).not.toBe(before.plan_fingerprint);
    } finally {
      await client.end();
    }
  });

  test('does not move with a login in a "hiit fit" that already holds rows: only which tables hold rows counts', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ('acct-b6-hiit', 'coach', $1, 'microsoft')`,
        [HIIT_FIT_ID],
      );
      await client.query(
        "insert into pilot.session_tokens (token_hash, account_id, organization_id) values ('t1', 'acct-b6-hiit', $1)", [HIIT_FIT_ID],
      );
      const before = await print(client, { allOrganizations: true });
      await client.query(
        "insert into pilot.session_tokens (token_hash, account_id, organization_id) values ('t2', 'acct-b6-hiit', $1)", [HIIT_FIT_ID],
      );
      expect(await print(client, { allOrganizations: true })).toBe(before);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a registration on a planned class', `insert into pilot.scheduler_registrations
       (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
     values ('${GYM}', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'c-strict-1', '${REAL_ATHLETE}', 'coach', '${COACH}', 'registered')`],
    ['a planned class\'s end time', "update pilot.scheduler_classes set end_at = end_at + interval '5 minutes' where class_id = 'c-strict-1'"],
    ['a planned class\'s end time, by half a second', "update pilot.scheduler_classes set end_at = end_at + interval '500 milliseconds' where class_id = 'c-strict-1'"],
    ['a planned class\'s title, same marker', "update pilot.scheduler_classes set title = 'ZZ-AUDIT renamed' where class_id = 'c-strict-1'"],
    ['a tied run\'s state', "update pilot.session_script_runs set run_state = 'abandoned' where run_id = 'run-done'"],
    ['"hiit fit"\'s name', `update pilot.organizations set organization_name = 'hiit fit studio' where organization_id = '${HIIT_FIT_ID}'`],
    ['the session on a STRICT TV', "update pilot.gym_tvs set current_run_id = 'run-live' where tv_id = 'tv-strict'",
      "update pilot.gym_tvs set device_key_hash = 'k', paired_at = '2026-10-19T22:00:00Z', current_run_id = 'run-done' where tv_id = 'tv-strict'"],
    ['a register mark let go', "update pilot.session_run_athletes set register_class_id = null where run_id = 'run-done'"],
    ['a floor plan naming a planned class', `insert into pilot.floor_plans_daily (organization_id, plan_id, plan_on, created_by_account_id, class_id)
       values ('${GYM}', 'plan-b6', '2026-10-05', '${COACH}', 'c-strict-1')`],
    ['a STRICT TV paired', "update pilot.gym_tvs set device_key_hash = 'k', paired_at = now() where tv_id = 'tv-strict'"],
    // Each alone, with pairing already done: a code issued, or a session put on the TV.
    ['a pair code issued to a STRICT TV',
      "update pilot.gym_tvs set pair_code_hash = 'h', pair_code_expires_at = now() + interval '1 hour' where tv_id = 'tv-strict'"],
    ['a session put on a paired STRICT TV', "update pilot.gym_tvs set current_run_id = 'run-done' where tv_id = 'tv-strict'",
      "update pilot.gym_tvs set device_key_hash = 'k', paired_at = '2026-10-19T22:00:00Z' where tv_id = 'tv-strict'"],
    ['a STRICT TV re-paired within the same second', "update pilot.gym_tvs set paired_at = '2026-10-19T22:00:00.4Z' where tv_id = 'tv-strict'",
      "update pilot.gym_tvs set device_key_hash = 'k', paired_at = '2026-10-19T22:00:00Z' where tv_id = 'tv-strict'"],
    ['a test gym\'s status', `update pilot.organizations set status = 'active' where organization_id = '${TEST_GYM_1}'`],
    ['"hiit fit" holding a row', `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-b6-hiit', 'coach', '${HIIT_FIT_ID}', 'microsoft')`],
    // A rest parameter: jest reads a test function's declared arity, and one
    // more named parameter than a row has values is taken as a done callback.
  ])('moves when %s changes', async (_label, sql, ...setup: string[]) => {
    const { client } = await freshDatabase();
    try {
      const options = { allOrganizations: true };
      for (const statement of setup) await client.query(statement);
      const before = await print(client, options);
      await client.query(sql);
      expect(await print(client, options)).not.toBe(before);
    } finally {
      await client.end();
    }
  });
});

describe('K2 TVs', () => {
  test('STRICT-named TVs are planned; every other TV is listed by id and dates only', async () => {
    const { client } = await freshDatabase();
    try {
      const out = recorder();
      const result = await report(client, { organizationId: GYM }, { log: out.log });
      expect(result.tvs!.marked.map((tv) => [tv.tv_id, tv.marker])).toEqual([['tv-strict', 'ZZ-AUDIT']]);
      // The other gym's STRICT TV is out of a one-gym scope, and in an every-organization one.
      const all = await report(client, { allOrganizations: true }, { log: () => {} });
      expect(all.tvs!.marked.map((tv) => tv.tv_id)).toEqual(['tv-strict', 'tv-other-strict']);
      expect(result.tvs!.others.map((tv) => [tv.tv_id, tv.marker])).toEqual([['tv-near', 'NEAR'], ['tv-real', null]]);
      for (const tv of [...result.tvs!.marked, ...result.tvs!.others]) expect(tv).not.toHaveProperty('tv_name');
      expect(out.text()).not.toContain('Ring TV');
    } finally {
      await client.end();
    }
  });
});

describe('K3 Audit Test Gyms and K4 "hiit fit"', () => {
  test('lists the Audit Test Gyms with counts only, and finds "hiit fit" by id and name, never Danielle\'s HIIT Fit', async () => {
    const { client } = await freshDatabase();
    try {
      const result = await report(client, { allOrganizations: true }, { log: () => {} });
      expect(result.test_organizations).toEqual([
        { organization_id: TEST_GYM_1, status: 'inactive', members_by_role: {}, rows_by_table: { organizations: 1 } },
        {
          organization_id: TEST_GYM_2, status: 'active', members_by_role: { coach: 1 },
          rows_by_table: { organization_memberships: 1, organizations: 1 },
        },
      ]);
      expect(result.hiit_fit).toEqual({
        found_id: true, name_matches: true, status: 'active',
        rows_by_table: { organizations: 1 }, holding_tables: [], apply_would_refuse: [],
      });
      expect(JSON.stringify(result)).not.toContain(DANIELLES_HIIT);
      // A one-gym scope reads neither.
      const gymOnly = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(gymOnly.test_organizations).toEqual([]);
      expect(gymOnly.hiit_fit).toEqual({ found_id: false });
    } finally {
      await client.end();
    }
  });

  test('"hiit fit" under another name, or holding rows, would refuse', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query("update pilot.organizations set organization_name = 'Hiit Fit Studio' where organization_id = $1", [HIIT_FIT_ID]);
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ('acct-b6-hiit', 'coach', $1, 'microsoft')`,
        [HIIT_FIT_ID],
      );
      const result = await report(client, { organizationId: HIIT_FIT_ID }, { log: () => {} });
      expect(result.hiit_fit).toMatchObject({
        found_id: true, name_matches: false, note: 'id found, name differs',
        holding_tables: ['accounts'], apply_would_refuse: ['NAME_DIFFERS', 'NOT_EMPTY'],
      });
    } finally {
      await client.end();
    }
  });
});

describe('K5 the sweep', () => {
  test('finds STRICT and NEAR text in any table, prints keys only, hashes person keys, and skips unmarked rows', async () => {
    const { client } = await freshDatabase();
    try {
      const out = recorder();
      const result = await report(client, { organizationId: GYM }, { log: out.log });
      const sweep = result.sweep!;
      const where = (hits: Hit[]) => hits.map((h) => `${h.table}.${h.column}:${JSON.stringify(h.key)}`).sort();
      expect(where(sweep.strict)).toEqual(expect.arrayContaining([
        `athletes.full_name:${JSON.stringify({ organization_id: GYM, athlete_id: ref(NAMED_ATHLETE) })}`,
        `coach_observations.note_text:${JSON.stringify({ organization_id: GYM, note_id: NOTE_STRICT })}`,
        `gym_tvs.tv_name:${JSON.stringify({ organization_id: GYM, tv_id: 'tv-strict' })}`,
        `scheduler_attendance.note:${JSON.stringify({ organization_id: GYM, attendance_id: ATT_TEST })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-strict-1' })}`,
      ]));
      expect(where(sweep.near)).toEqual(expect.arrayContaining([
        `coach_observations.note_text:${JSON.stringify({ organization_id: GYM, note_id: NOTE_NEAR })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-audit-test' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-lower' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-space' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-tab' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-nbsp' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-emspace' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-nel' })}`,
      ]));
      expect(result.classes!.map((c) => c.class_id)).not.toEqual(expect.arrayContaining(['c-near-tab']));
      expect(sweep.columns_not_swept_by_type).toMatchObject({ jsonb: expect.any(Number), _text: expect.any(Number) });
      const everywhere = JSON.stringify([...sweep.strict, ...sweep.near]);
      expect(everywhere).not.toContain(NOTE_REAL);
      expect(everywhere).not.toContain('c-real');
      expect(everywhere).not.toContain('c-other-strict');
      expect(sweep.strict.every((h) => h.organization_id === GYM)).toBe(true);
      expect(sweep.tables_skipped_no_organization_column.length).toBeGreaterThan(0);
      expect(sweep.tables_scanned).toBeGreaterThan(100);
      expectNothingRaw(out.text());
      expect(everywhere).not.toContain('auth_rate_limit_buckets');
      const allOut = recorder();
      const all = await report(client, { allOrganizations: true }, { log: allOut.log });
      expect(all.sweep!.tables_skipped_no_organization_column).toEqual([]);
      // A key with no person-like name that holds an email: hashed, never raw.
      expect(all.sweep!.near).toContainEqual({
        table: 'auth_rate_limit_buckets', column: 'bucket_key', key: { bucket_key: ref(BUCKET_KEY) }, organization_id: null,
      });
      expectNothingRaw(allOut.text());
    } finally {
      await client.end();
    }
  });
});

describe('keys and limits', () => {
  test('printableKey: raw only for class, run, TV and organization ids and non-person uuid or integer keys', () => {
    const uuid = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    expect(printableKey('class_id', 'text', 'Any text at all', TEST_REF_KEY)).toBe('Any text at all');
    expect(printableKey('note_id', 'uuid', uuid, TEST_REF_KEY)).toBe(uuid);
    expect(printableKey('registration_id', 'text', uuid, TEST_REF_KEY)).toBe(uuid);
    expect(printableKey('audit_id', 'int8', '42', TEST_REF_KEY)).toBe(ref('42'));
    expect(printableKey('athlete_id', 'text', uuid, TEST_REF_KEY)).toBe(ref(uuid));
    expect(printableKey('capture_participant_id', 'uuid', uuid, TEST_REF_KEY)).toBe(ref(uuid));
    expect(printableKey('bucket_key', 'text', BUCKET_KEY, TEST_REF_KEY)).toBe(ref(BUCKET_KEY));
    expect(printableKey('code', 'text', '1234567', TEST_REF_KEY)).toBe(ref('1234567'));
    expect(printableKey('registration_id', 'text', 'reg-test', TEST_REF_KEY)).toBe(ref('reg-test'));
    // A person's record by another name: an emergency contact, a SHADOW user profile.
    expect(printableKey('contact_id', 'uuid', uuid, TEST_REF_KEY)).toBe(ref(uuid));
    expect(printableKey('profile_id', 'int8', '1', TEST_REF_KEY)).toBe(ref('1'));
  });

  test('the sweep limit counts hits only: 600 notes with "audit test" mid-text do not hide a STRICT one', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
         select $1, gen_random_uuid(), $2, $3, 'observation', 'Round ' || g || ', not an audit test' from generate_series(1, 600) g`,
        [GYM, REAL_ATHLETE, COACH],
      );
      const result = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(result.sweep!.truncated_tables).toEqual([]);
      expect(result.sweep!.strict.filter((h) => h.table === 'coach_observations').map((h) => h.key.note_id)).toEqual([NOTE_STRICT]);
    } finally {
      await client.end();
    }
  });

  test('over the limit, STRICT hits come first: 600 NEAR notes keyed ahead of a STRICT one do not hide it', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
         select $1, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $2, $3, 'observation', 'zz-audit near ' || g
           from generate_series(1, 600) g`,
        [GYM, REAL_ATHLETE, COACH],
      );
      const result = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(result.sweep!.truncated_tables).toEqual(['coach_observations']);
      expect(result.sweep!.strict.filter((h) => h.table === 'coach_observations').map((h) => h.key.note_id)).toEqual([NOTE_STRICT]);
    } finally {
      await client.end();
    }
  });

  test('a sweep table that cannot be read is listed by its code, and the rest of the report stands', async () => {
    const { client, name } = await freshDatabase();
    const locker = new Client({ connectionString: connectionStringFor(name) });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('lock table pilot.auth_rate_limit_buckets in access exclusive mode');
      const result = await report(client, { allOrganizations: true }, { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(result.sweep!.tables_failed).toEqual([{ table: 'auth_rate_limit_buckets', code: '55P03' }]);
      expect(result.counts).toMatchObject({ classes: 6, sweep_tables_failed: 1 });
    } finally {
      await locker.query('rollback').catch(() => {});
      await locker.end();
      await client.end();
    }
  });

  test('a failure prints no constraint field it does not have', async () => {
    const out = recorder();
    const failing = {
      on: () => {},
      connect: async () => { throw Object.assign(new Error('no'), { code: '08006', constraint: undefined }); },
      end: async () => {},
    };
    const result = await runTool(envFor('unused'), ['--all-organizations'], { createClient: () => failing, log: out.log });
    expect(result).toMatchObject({ status: 'failed', reason: 'DATABASE_ERROR', code: '08006' });
    expect(out.text()).not.toContain('"constraint"');
  });

  test('a column the report reads directly is missing: refused, naming it', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query('alter table pilot.floor_plans_daily drop column class_id');
      expect(await report(client, { organizationId: GYM }, { log: () => {} }))
        .toEqual({ status: 'refused', reason: 'SCHEMA_MISSING', missing: ['floor_plans_daily.class_id'] });
    } finally {
      await client.end();
    }
  });
});

describe('read-only and refusals', () => {
  test('one repeatable-read snapshot, then one short transaction per sweep table: all read-only, all rolled back, no write', async () => {
    const { client } = await freshDatabase();
    try {
      const statements: string[] = [];
      const spy = { query: (text: string, values?: unknown[]) => { statements.push(text.trim()); return client.query(text, values); } };
      const result = await report(spy, { allOrganizations: true }, { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(statements[0]).toBe('begin transaction isolation level repeatable read read only');
      expect(statements[statements.length - 1]).toBe('rollback');
      // K1 to K4 are read inside that first snapshot, before its rollback.
      const firstRollback = statements.indexOf('rollback');
      for (const read of [/from pilot\.scheduler_classes\b/, /from pilot\."scheduler_registrations"/, /from pilot\.gym_tvs\b/,
        /organization_name[\s\S]*from pilot\.organizations\b/, /from pilot\.organization_memberships\b/]) {
        const at = statements.findIndex((s) => read.test(s));
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(firstRollback);
      }
      const begins = statements.filter((s) => /^begin\b/i.test(s));
      expect(begins.length).toBe(1 + result.sweep!.tables_scanned);
      expect(begins.every((s) => s.endsWith('read only'))).toBe(true);
      expect(statements.filter((s) => s === 'rollback').length).toBe(begins.length);
      expect(statements.filter((s) => /^(insert|update|delete|truncate|alter|create|drop|grant|copy)\b/i.test(s))).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('no scope, and an unknown organization, are refused', async () => {
    const { client } = await freshDatabase();
    try {
      expect(await report(client, {}, { log: () => {} })).toEqual({ status: 'refused', reason: 'ORGANIZATION_SCOPE_REQUIRED' });
      expect(await report(client, { organizationId: GYM, allOrganizations: true }, { log: () => {} }))
        .toEqual({ status: 'refused', reason: 'ORGANIZATION_SCOPE_REQUIRED' });
      expect(await report(client, { organizationId: 'org-b6-missing' }, { log: () => {} }))
        .toEqual({ status: 'refused', reason: 'ORGANIZATION_NOT_FOUND' });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['no scope', [], 'ORGANIZATION_SCOPE_REQUIRED'],
    ['both scopes', ['--organization', GYM, '--all-organizations'], 'ORGANIZATION_SCOPE_AMBIGUOUS'],
    ['two organizations', ['--organization', GYM, '--organization', OTHER], 'ORGANIZATION_SCOPE_AMBIGUOUS'],
    ['--organization with no value', ['--organization'], 'INVALID_ORGANIZATION'],
    ['--organization followed by a flag', ['--organization', '--all-organizations'], 'INVALID_ORGANIZATION'],
    ['an organization with spaces around it', ['--organization', ` ${GYM}`], 'INVALID_ORGANIZATION'],
    ['an unknown argument', ['--all-organizations', '--apply'], 'UNKNOWN_ARGUMENT'],
  ])('%s is refused before a client is created', async (_label, argv, reason) => {
    const createClient = jest.fn();
    const result = await runTool(envFor('unused'), argv as string[], { createClient, log: () => {} });
    expect(result).toEqual({ status: 'refused', reason });
    expect(createClient).not.toHaveBeenCalled();
  });

  test.each([
    ['an apply request with no kinds', { PPBF_AUDIT_TEST_CLEANUP_APPLY: 'true' }, 'APPLY_WITHOUT_KINDS'],
    ['a mismatched hostname', { PPBF_EXPECTED_POSTGRES_HOSTNAME: 'ppbf-pg-195892.postgres.database.azure.com' }, 'POSTGRES_TARGET_MISMATCH'],
    ['a mismatched database', { PPBF_EXPECTED_POSTGRES_DATABASE: 'postgres' }, 'POSTGRES_TARGET_MISMATCH'],
    ['no declared hostname', { PPBF_EXPECTED_POSTGRES_HOSTNAME: '' }, 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME'],
    ['no connection string', { AZURE_POSTGRES_CONNECTION_STRING: '' }, 'MISSING_CONNECTION_STRING'],
  ])('%s is refused before a client is created', async (_label, overrides, reason) => {
    const createClient = jest.fn();
    const result = await runTool(envFor('unused', overrides as Record<string, string>), ['--all-organizations'], { createClient, log: () => {} });
    expect(result).toEqual({ status: 'refused', reason });
    expect(createClient).not.toHaveBeenCalled();
  });

  test('PPBF_AUDIT_TEST_CLEANUP_APPLY other than exactly "true" is still only a dry run', () => {
    for (const value of ['TRUE', '1', 'yes', '']) {
      expect(parseOptions({ PPBF_AUDIT_TEST_CLEANUP_APPLY: value }, ['--all-organizations']))
        .toEqual({ ok: true, options: { allOrganizations: true } });
    }
  });
});

describe('the command line, end to end', () => {
  test('the script\'s own stdout and stderr carry a person id only as its hash', async () => {
    const { client, name } = await freshDatabase();
    await client.end();
    const child = spawnSync(process.execPath, [TOOL_PATH, '--all-organizations'], {
      cwd: WEB_DIR, env: { ...process.env, ...envFor(name) }, encoding: 'utf8', timeout: 300_000,
    });
    expect(child.status).toBe(0);
    const printed = `${child.stdout}\n${child.stderr}`;
    expect(printed).toContain('"event": "audit_test_cleanup.plan"');
    expect(printed).toContain('"event":"audit_test_cleanup.dry-run"');
    expect(printed).toContain(ref(TEST_ATHLETE));
    expect(printed).toContain(ref(NAMED_ATHLETE));
    expect(printed).toContain(ref(BUCKET_KEY));
    expect(printed).toContain('"person_ref": "environment key"');
    expect(printed).not.toContain(TEST_REF_KEY);
    expectNothingRaw(printed);
  });

  test('with no key set, the run uses a per-run key, says so, and still prints no raw id', async () => {
    const { client, name } = await freshDatabase();
    await client.end();
    const printedBy = () => {
      const child = spawnSync(process.execPath, [TOOL_PATH, '--all-organizations'], {
        cwd: WEB_DIR, env: { ...process.env, ...envFor(name, { PPBF_AUDIT_TEST_CLEANUP_REF_KEY: '' }) }, encoding: 'utf8', timeout: 300_000,
      });
      expect(child.status).toBe(0);
      return `${child.stdout}\n${child.stderr}`;
    };
    const first = printedBy();
    const second = printedBy();
    for (const printed of [first, second]) {
      expect(printed).toContain('"person_ref": "per-run key"');
      expect(printed).not.toContain(ref(TEST_ATHLETE));
      expectNothingRaw(printed);
    }
    // A fresh key each run: the same athlete's reference differs between runs.
    const athleteRefs = (printed: string) => [...printed.matchAll(/"athlete_ref": "([0-9a-f]{12})"/g)].map((m) => m[1]);
    expect(athleteRefs(first).length).toBeGreaterThan(0);
    expect(athleteRefs(first)).not.toEqual(athleteRefs(second));
  });

  test('the fingerprint does not depend on the key', async () => {
    const { client } = await freshDatabase();
    try {
      const withKey = await report(client, { allOrganizations: true }, { log: () => {} });
      const withoutKey = await reportWithoutKey(client, { allOrganizations: true }, { log: () => {} });
      expect(withKey.person_ref).toBe('environment key');
      expect(withoutKey.person_ref).toBe('per-run key');
      expect(withoutKey.plan_fingerprint).toBe(withKey.plan_fingerprint);
    } finally {
      await client.end();
    }
  });

  test('run() on this suite\'s own database returns the dry run', async () => {
    const { client, name } = await freshDatabase();
    await client.end();
    const out = recorder();
    const result = await runTool(envFor(name), ['--all-organizations'], { log: out.log });
    expect(result.status).toBe('dry-run');
    expectNothingRaw(out.text());
  });
});

// ---------------------------------------------------------------------------
// The apply (B6-3). Each refusal must leave every pilot table byte-identical,
// and must come before the first write.
// ---------------------------------------------------------------------------

// Typed here, not imported: a changed phrase in the tool must fail these tests.
const CONFIRM = 'DELETE AUDIT TEST RECORDS';
const NO_FINGERPRINT = `sha256:${'0'.repeat(64)}`;
const WRITE = /^(insert|update|delete)\b/i;
const APPLY_TABLES_FOR_CLASSES = ['audit_events', 'scheduler_attendance', 'scheduler_classes', 'scheduler_registrations',
  'session_run_athletes', 'session_script_runs'];

/** The running class, its live run and the activity row: what refuses a class apply in the template. */
async function clearBlockers(target: Client) {
  await target.query("delete from pilot.session_script_runs where run_id = 'run-live'");
  await target.query("delete from pilot.activity_log where activity_id = 'act-1'");
  await target.query("delete from pilot.scheduler_classes where class_id = 'c-strict-live'");
}

/** The dry run's fingerprint for this scope and, when given, these kinds. */
async function fingerprintOf(target: Client, scope: Options, kinds?: string[]): Promise<string> {
  return (await report(target, { ...scope, ...(kinds ? { kinds } : {}) }, { log: () => {} })).plan_fingerprint!;
}

const applyOptions = (scope: Options, kinds: string[], expectFingerprint: string): Options =>
  ({ ...scope, apply: true, kinds, confirm: CONFIRM, expectFingerprint });

/** The tables whose content differs between two snapshots. */
function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((table) => before[table] !== after[table]).sort();
}

async function rowsText(target: Client, table: string, where: string, values: unknown[] = []): Promise<string[]> {
  return (await target.query<{ r: string }>(`select t::text as r from pilot.${table} t where ${where} order by 1`, values)).rows.map((row) => row.r);
}

async function auditRows(target: Client) {
  return (await target.query<{ event_type: string; organization_id: string; entity_id: string; actor_account_id: string | null; details: Record<string, unknown> }>(
    `select event_type, organization_id, entity_id, actor_account_id, details from pilot.audit_events
      where entity_type = 'audit_test_record_cleanup' order by organization_id`,
  )).rows;
}

async function statusOf(target: Client, organizationId: string): Promise<string> {
  return (await target.query<{ status: string }>('select status from pilot.organizations where organization_id = $1', [organizationId])).rows[0].status;
}

/** A fault: before a statement matching `match`, run `before`; rewrite its text or values. */
type Hook = { match: RegExp; before?: () => Promise<unknown>; text?: (t: string) => string; values?: (v: unknown[]) => unknown[] };

/** A client that records every statement and applies the hooks. */
function faulty(target: Client, hooks: Hook[] = [], statements: string[] = []) {
  return {
    query: async (text: string, values?: unknown[]) => {
      let t = text;
      let v = values;
      for (const hook of hooks.filter((h) => h.match.test(text.trim()))) {
        if (hook.before) await hook.before();
        if (hook.text) t = hook.text(t);
        if (hook.values && v) v = hook.values(v);
      }
      statements.push(t.trim());
      return target.query(t, v);
    },
  };
}

/** A second session on the same database, giving up on a lock after a second. */
async function otherSession(name: string): Promise<Client> {
  const other = new Client({ connectionString: connectionStringFor(name) });
  await other.connect();
  await other.query("set lock_timeout = '1s'");
  return other;
}

const addKey = (key: Record<string, string>) => (v: unknown[]) => [JSON.stringify([...JSON.parse(String(v[0])), key]), ...v.slice(1)];

describe('the apply, by kind', () => {
  test('classes: deletes the STRICT classes with their sign-ups and attendance, unties the run and the register mark, audits data_purged', async () => {
    const { client } = await freshDatabase();
    try {
      await clearBlockers(client);
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['classes']);
      const before = await snapshot(client);
      const out = recorder();
      const result = await apply(client, applyOptions({ organizationId: GYM }, ['classes'], fp), { log: out.log });
      expect(result).toMatchObject({
        status: 'applied', plan_fingerprint: fp, kinds: ['classes'], audit_rows: 1, organization_set_inactive: null,
        counts: { classes: 4, registrations: 1, attendance: 1, tied_runs_untied: 1, register_marks_untied: 1, tvs: 0, sessions_revoked: 0 },
      });
      expect(result.class_ids!.map((c) => c.class_id)).toEqual(['c-strict-1', 'c-strict-2', 'c-strict-3', 'c-strict-untracked']);
      // Only the class tables and the audit trail changed: the athletes, notes, TVs and every other row are untouched.
      expect(changedTables(before, await snapshot(client))).toEqual(APPLY_TABLES_FOR_CLASSES);
      const left = (await client.query<{ class_id: string }>('select class_id from pilot.scheduler_classes order by 1')).rows.map((r) => r.class_id);
      expect(left).toEqual(['c-near-audit-test', 'c-near-emspace', 'c-near-lower', 'c-near-nbsp', 'c-near-nel', 'c-near-space',
        'c-near-tab', 'c-other-strict', 'c-real']);
      expect((await client.query('select registration_id from pilot.scheduler_registrations')).rows).toEqual([{ registration_id: REG_REAL }]);
      expect((await client.query('select 1 from pilot.scheduler_attendance')).rowCount).toBe(0);
      expect((await client.query("select class_id, run_state from pilot.session_script_runs where run_id = 'run-done'")).rows)
        .toEqual([{ class_id: null, run_state: 'completed' }]);
      expect((await client.query("select register_class_id from pilot.session_run_athletes where run_id = 'run-done'")).rows)
        .toEqual([{ register_class_id: null }]);
      const [audit] = await auditRows(client);
      expect(audit).toMatchObject({ event_type: 'data_purged', organization_id: GYM, entity_id: GYM, actor_account_id: null });
      expect(audit.details).toMatchObject({
        plan_fingerprint: fp, scope: { organization_id: GYM }, kinds: ['classes'], tv_ids: [], organization_set_inactive: null,
        class_ids: ['c-strict-1', 'c-strict-2', 'c-strict-3', 'c-strict-untracked'],
        counts: { classes_deleted: 4, registrations_deleted: 1, attendance_deleted: 1, tied_runs_untied: 1, register_marks_untied: 1,
          tvs_disconnected: 0, sessions_revoked: 0 },
      });
      expect((audit.details.rulings as string[]).length).toBe(3);
      expectNothingRaw(`${out.text()}\n${JSON.stringify(audit)}`);
    } finally {
      await client.end();
    }
  });

  test('tvs: the app\'s own Disconnect on the STRICT TV only; the NEAR, real and other gym\'s TVs are byte-identical', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `update pilot.gym_tvs set device_key_hash = 'dk-b6', paired_at = now(), current_run_id = 'run-done',
                current_run_set_by_account_id = $1 where tv_id = 'tv-strict'`, [COACH]);
      const others = await rowsText(client, 'gym_tvs', "tv_id <> 'tv-strict'");
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['tvs']);
      const before = await snapshot(client);
      const result = await apply(client, applyOptions({ organizationId: GYM }, ['tvs'], fp), { log: () => {} });
      expect(result).toMatchObject({ status: 'applied', counts: { classes: 0, tvs: 1 }, tv_ids: [{ organization_id: GYM, tv_id: 'tv-strict' }] });
      expect(changedTables(before, await snapshot(client))).toEqual(['audit_events', 'gym_tvs']);
      expect((await client.query(
        `select revoked_at is not null as revoked, current_run_id, current_run_set_by_account_id, pair_code_hash, pair_code_expires_at,
                device_key_hash from pilot.gym_tvs where tv_id = 'tv-strict'`)).rows).toEqual([{
        revoked: true, current_run_id: null, current_run_set_by_account_id: null, pair_code_hash: null, pair_code_expires_at: null,
        device_key_hash: 'dk-b6',
      }]);
      expect(await rowsText(client, 'gym_tvs', "tv_id <> 'tv-strict'")).toEqual(others);
      expect(await auditRows(client)).toEqual([expect.objectContaining({
        event_type: 'update', organization_id: GYM, details: expect.objectContaining({ tv_ids: ['tv-strict'], class_ids: [] }),
      })]);
    } finally {
      await client.end();
    }
  });

  test('tvs: a STRICT TV already disconnected is left as it is and reported apart; only the connected one counts', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query("update pilot.gym_tvs set revoked_at = now() - interval '1 day' where tv_id = 'tv-strict'");
      await insertTv(client, GYM, 'tv-strict-2', 'ZZ-AUDIT TV two');
      const already = await rowsText(client, 'gym_tvs', "tv_id = 'tv-strict'");
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['tvs']);
      const result = await apply(client, applyOptions({ organizationId: GYM }, ['tvs'], fp), { log: () => {} });
      expect(result).toMatchObject({
        status: 'applied', counts: { tvs: 1, tvs_already_disconnected: 1 },
        tv_ids: [{ organization_id: GYM, tv_id: 'tv-strict-2' }], tvs_already_disconnected: [{ organization_id: GYM, tv_id: 'tv-strict' }],
      });
      expect(await rowsText(client, 'gym_tvs', "tv_id = 'tv-strict'")).toEqual(already);
      expect(await auditRows(client)).toEqual([expect.objectContaining({
        organization_id: GYM, details: expect.objectContaining({ tv_ids: ['tv-strict-2'], counts: expect.objectContaining({ tvs_disconnected: 1 }) }),
      })]);
    } finally {
      await client.end();
    }
  });

  test('tvs: only already-disconnected STRICT TVs: nothing to apply, no audit row, nothing written', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query("update pilot.gym_tvs set revoked_at = now() - interval '1 day' where tv_id = 'tv-strict'");
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['tvs']);
      const before = await snapshot(client);
      expect(await apply(client, applyOptions({ organizationId: GYM }, ['tvs'], fp), { log: () => {} }))
        .toMatchObject({ status: 'nothing-to-apply', tvs_already_disconnected: [{ organization_id: GYM, tv_id: 'tv-strict' }] });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('test-organizations: the named test gym set inactive with its live sessions revoked; never deleted, nobody else touched', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `insert into pilot.session_tokens (token_hash, account_id, organization_id, revoked_at) values
           ('tok-test-gym-live', $1, $2, null), ('tok-test-gym-old', $1, $2, now() - interval '1 day'), ('tok-real-gym', $1, $3, null)`,
        [COACH, TEST_GYM_2, GYM]);
      const fp = await fingerprintOf(client, { organizationId: TEST_GYM_2 }, ['test-organizations']);
      const before = await snapshot(client);
      const old = await rowsText(client, 'session_tokens', "token_hash <> 'tok-test-gym-live'");
      const result = await apply(client, applyOptions({ organizationId: TEST_GYM_2 }, ['test-organizations'], fp), { log: () => {} });
      expect(result).toMatchObject({ status: 'applied', organization_set_inactive: TEST_GYM_2, counts: { sessions_revoked: 1 } });
      expect(changedTables(before, await snapshot(client))).toEqual(['audit_events', 'organizations', 'session_tokens']);
      expect(await statusOf(client, TEST_GYM_2)).toBe('inactive');
      expect((await client.query("select revoked_at is not null as r from pilot.session_tokens where token_hash = 'tok-test-gym-live'")).rows).toEqual([{ r: true }]);
      expect(await rowsText(client, 'session_tokens', "token_hash <> 'tok-test-gym-live'")).toEqual(old);
      expect(await auditRows(client)).toEqual([expect.objectContaining({
        event_type: 'update', organization_id: TEST_GYM_2,
        details: expect.objectContaining({ organization_set_inactive: 'test-organizations', counts: expect.objectContaining({ sessions_revoked: 1 }) }),
      })]);
    } finally {
      await client.end();
    }
  });

  test('hiit-fit: "hiit fit" set inactive while it is empty; Danielle\'s HIIT Fit untouched', async () => {
    const { client } = await freshDatabase();
    try {
      const fp = await fingerprintOf(client, { organizationId: HIIT_FIT_ID }, ['hiit-fit']);
      const other = await rowsText(client, 'organizations', 'organization_id <> $1', [HIIT_FIT_ID]);
      const result = await apply(client, applyOptions({ organizationId: HIIT_FIT_ID }, ['hiit-fit'], fp), { log: () => {} });
      expect(result).toMatchObject({ status: 'applied', organization_set_inactive: HIIT_FIT_ID });
      expect(await statusOf(client, HIIT_FIT_ID)).toBe('inactive');
      expect(await rowsText(client, 'organizations', 'organization_id <> $1', [HIIT_FIT_ID])).toEqual(other);
    } finally {
      await client.end();
    }
  });

  test('every organization: STRICT classes and TVs in both gyms; every NEAR and real class and TV byte-identical; one audit row per gym', async () => {
    const { client } = await freshDatabase();
    try {
      await clearBlockers(client);
      const near = async () => [
        ...await rowsText(client, 'scheduler_classes', "class_id like 'c-near-%' or class_id = 'c-real'"),
        ...await rowsText(client, 'gym_tvs', "tv_id in ('tv-near', 'tv-real')"),
        ...await rowsText(client, 'coach_observations', 'true'),
      ];
      const nearBefore = await near();
      const fp = await fingerprintOf(client, { allOrganizations: true }, ['classes', 'tvs']);
      const result = await apply(client, applyOptions({ allOrganizations: true }, ['tvs', 'classes'], fp), { log: () => {} });
      expect(result).toMatchObject({ status: 'applied', counts: { classes: 5, tvs: 2 }, audit_rows: 2 });
      expect(await near()).toEqual(nearBefore);
      expect((await auditRows(client)).map((row) => [row.organization_id, row.event_type])).toEqual([[GYM, 'data_purged'], [OTHER, 'data_purged']]);
    } finally {
      await client.end();
    }
  });

  test('nothing planned for the kinds asked: nothing written, no audit row', async () => {
    const { client } = await freshDatabase();
    try {
      const fp = await fingerprintOf(client, { organizationId: DANIELLES_HIIT }, ['classes', 'tvs']);
      const before = await snapshot(client);
      expect(await apply(client, applyOptions({ organizationId: DANIELLES_HIIT }, ['classes', 'tvs'], fp), { log: () => {} }))
        .toMatchObject({ status: 'nothing-to-apply', plan_fingerprint: fp });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});

describe('kinds and the fingerprint', () => {
  test('with no kinds the fingerprint is B6-1\'s formula, byte for byte; named kinds are bound in, sorted', () => {
    const scope = { organization_id: GYM };
    const material = { classes: [[GYM, 'c-1', 'title', 'open']], tvs: [[GYM, 'tv-1']], hiit_fit_holding: [] };
    // B6-1's expression (a0403dee), written out here so a change to the tool cannot agree with itself.
    const b61 = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
      markers: ['ZZ-AUDIT', 'AUDIT TEST'], strict_rule: 'a marker first, exact case, then the end or a character that is not a letter or digit',
      scope, ...material,
    })).digest('hex')}`;
    expect(planFingerprint(scope, undefined, material)).toBe(b61);
    const bound = planFingerprint(scope, ['tvs', 'classes'], material);
    expect(bound).not.toBe(b61);
    expect(planFingerprint(scope, ['classes', 'tvs'], material)).toBe(bound);
    expect(planFingerprint(scope, ['classes'], material)).not.toBe(bound);
  });

  test('on the database: kinds change the dry run\'s fingerprint, their order does not, and the plan and dry-run line name them', async () => {
    const { client } = await freshDatabase();
    try {
      const plain = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(plain.kinds).toBeNull();
      const out = recorder();
      const named = await report(client, { organizationId: GYM, kinds: ['tvs', 'classes'] }, { log: out.log });
      expect(named.kinds).toEqual(['classes', 'tvs']);
      expect(named.plan_fingerprint).not.toBe(plain.plan_fingerprint);
      expect(await fingerprintOf(client, { organizationId: GYM }, ['classes', 'tvs'])).toBe(named.plan_fingerprint);
      expect(out.text()).toContain('"event":"dry-run","plan_fingerprint"');
      expect(out.text().match(/"kinds":\["classes","tvs"\]/g)?.length).toBe(2);
      expect(await report(client, { organizationId: GYM, kinds: ['sweep'] }, { log: () => {} }))
        .toEqual({ status: 'refused', reason: 'INVALID_KINDS' });
    } finally {
      await client.end();
    }
  });

  test('APPLY other than exactly "true", with kinds, is a dry run that writes nothing', async () => {
    const { client, name } = await freshDatabase();
    try {
      const before = await snapshot(client);
      for (const value of ['TRUE', '1', '']) {
        const result = await runTool(envFor(name, { PPBF_AUDIT_TEST_CLEANUP_APPLY: value, PPBF_AUDIT_TEST_CLEANUP_CONFIRM: CONFIRM }),
          ['--organization', GYM, '--kinds', 'classes'], { log: () => {} });
        expect(result).toMatchObject({ status: 'dry-run', kinds: ['classes'] });
      }
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('a refused apply never prints the fingerprint the changed plan now has: only a fresh, reviewed dry run gives it', async () => {
    const { client } = await freshDatabase();
    try {
      await clearBlockers(client);
      const reviewed = await fingerprintOf(client, { organizationId: GYM }, ['classes']);
      await client.query("update pilot.scheduler_classes set status = 'cancelled' where class_id = 'c-strict-1'");
      const now = await fingerprintOf(client, { organizationId: GYM }, ['classes']);
      const out = recorder();
      const result = await apply(client, applyOptions({ organizationId: GYM }, ['classes'], reviewed), { log: out.log });
      expect(result).toEqual({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH', expected: reviewed,
        note: 'run a fresh dry run of the same scope and kinds, and have it reviewed' });
      expect(out.text()).not.toContain(now);
    } finally {
      await client.end();
    }
  });
});

describe('the apply refuses before its first write, writing nothing', () => {
  type Setup = (c: Client) => Promise<unknown>;
  type Row = { scope: Options; kinds: string[]; dryKinds?: string[] | null; before?: Setup; after?: Setup; expected: Record<string, unknown> };
  const rows: Array<[string, Row]> = [
    ['a fingerprint that is not the reviewed plan\'s', { scope: { organizationId: GYM }, kinds: ['tvs'], dryKinds: null,
      expected: { reason: 'PLAN_FINGERPRINT_MISMATCH' } }],
    ['a sign-up added after the dry run', { scope: { organizationId: GYM }, kinds: ['classes'], before: clearBlockers,
      after: (c) => c.query(`insert into pilot.scheduler_registrations (organization_id, registration_id, class_id, athlete_id,
          requested_by_role, requested_by_account_id, status) values ($1, 'aaaaaaaa-0000-4000-8000-0000000000ff', 'c-strict-1', $2, 'coach', $3,
          'registered')`, [GYM, REAL_ATHLETE, COACH]),
      expected: { reason: 'PLAN_FINGERPRINT_MISMATCH' } }],
    ['kinds that differ from the dry run\'s', { scope: { organizationId: GYM }, kinds: ['classes', 'tvs'], dryKinds: ['tvs'],
      before: clearBlockers, expected: { reason: 'PLAN_FINGERPRINT_MISMATCH' } }],
    ['a class running now, a live run and an untracked reference', { scope: { organizationId: GYM }, kinds: ['classes'], expected: {
      reason: 'CLASS_APPLY_REFUSED', classes: [
        { organization_id: GYM, class_id: 'c-strict-live', reasons: ['TIED_RUN_LIVE', 'CLASS_RUNNING_NOW'] },
        { organization_id: GYM, class_id: 'c-strict-untracked', reasons: ['UNTRACKED_REFERENCE'] },
      ] } }],
    ['a trigger the tool does not know on a table it writes', { scope: { organizationId: GYM }, kinds: ['tvs'], before: async (c) => {
      await c.query('create function pilot.b6_noop() returns trigger language plpgsql as $$ begin return new; end $$');
      await c.query('create trigger b6_noop before update on pilot.gym_tvs for each row execute function pilot.b6_noop()');
    }, expected: { reason: 'UNKNOWN_TRIGGER', triggers: ['gym_tvs.b6_noop'] } }],
    ['test-organizations on a gym that is not a test gym', { scope: { organizationId: GYM }, kinds: ['test-organizations'],
      expected: { reason: 'TEST_ORGANIZATION_NOT_NAMED' } }],
    ['test-organizations on "hiit fit"', { scope: { organizationId: HIIT_FIT_ID }, kinds: ['test-organizations'],
      expected: { reason: 'TEST_ORGANIZATION_NOT_NAMED' } }],
    ['hiit-fit on Danielle\'s HIIT Fit', { scope: { organizationId: DANIELLES_HIIT }, kinds: ['hiit-fit'],
      expected: { reason: 'HIIT_FIT_NOT_NAMED' } }],
    ['hiit-fit while "hiit fit" holds a membership', { scope: { organizationId: HIIT_FIT_ID }, kinds: ['hiit-fit'],
      before: (c) => c.query("insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach')", [COACH, HIIT_FIT_ID]),
      expected: { reason: 'HIIT_FIT_APPLY_REFUSED', reasons: ['NOT_EMPTY'] } }],
    ['hiit-fit when the name differs', { scope: { organizationId: HIIT_FIT_ID }, kinds: ['hiit-fit'],
      before: (c) => c.query("update pilot.organizations set organization_name = 'HIIT Fit Two' where organization_id = $1", [HIIT_FIT_ID]),
      expected: { reason: 'HIIT_FIT_APPLY_REFUSED', reasons: ['NAME_DIFFERS'] } }],
    ['an organization that does not exist', { scope: { organizationId: 'org-b6-missing' }, kinds: ['classes'], dryKinds: null,
      expected: { reason: 'ORGANIZATION_NOT_FOUND' } }],
    ['a column the apply reads directly is missing', { scope: { organizationId: GYM }, kinds: ['classes'], dryKinds: null,
      before: (c) => c.query('alter table pilot.floor_plans_daily drop column class_id'),
      expected: { reason: 'SCHEMA_MISSING', missing: ['floor_plans_daily.class_id'] } }],
  ];

  test.each(rows)('%s', async (_label, row) => {
    const { client } = await freshDatabase();
    try {
      await row.before?.(client);
      const fp = row.dryKinds === null ? NO_FINGERPRINT : await fingerprintOf(client, row.scope, row.dryKinds ?? row.kinds);
      await row.after?.(client);
      const before = await snapshot(client);
      const statements: string[] = [];
      const out = recorder();
      const result = await apply(faulty(client, [], statements), applyOptions(row.scope, row.kinds, fp), { log: out.log });
      expect(result).toMatchObject({ status: 'refused', ...row.expected });
      expect(statements.length).toBeGreaterThan(1);
      expect(statements.filter((s) => WRITE.test(s))).toEqual([]);
      expect(await snapshot(client)).toEqual(before);
      expectNothingRaw(out.text());
    } finally {
      await client.end();
    }
  });

  test('an apply that was not asked for, or with invalid options, issues no statement at all', async () => {
    const statements: string[] = [];
    const spy = { query: async (text: string) => { statements.push(text); return { rows: [], rowCount: 0 }; } };
    expect(await apply(spy, { organizationId: GYM }, { log: () => {} })).toEqual({ status: 'refused', reason: 'APPLY_NOT_REQUESTED' });
    expect(await apply(spy, { ...applyOptions({ organizationId: GYM }, ['classes'], NO_FINGERPRINT), apply: 'true' }, { log: () => {} }))
      .toEqual({ status: 'refused', reason: 'INVALID_APPLY' });
    expect(await apply(spy, { ...applyOptions({ organizationId: GYM }, ['classes'], NO_FINGERPRINT), kinds: undefined }, { log: () => {} }))
      .toEqual({ status: 'refused', reason: 'APPLY_WITHOUT_KINDS' });
    // The command line cannot make an empty list ('' is [''], INVALID_KINDS); a caller can.
    expect(await apply(spy, applyOptions({ organizationId: GYM }, [], NO_FINGERPRINT), { log: () => {} }))
      .toEqual({ status: 'refused', reason: 'INVALID_KINDS' });
    expect(statements).toEqual([]);
  });
});

describe('the apply\'s checks, each proved by a fault', () => {
  /** Applies with `hooks` and expects `expected`, every pilot table unchanged and nothing raw printed. */
  async function refusedWithFault(setup: Setup0, scope: Options, kinds: string[], hooks: (c: Client) => Hook[], expected: Record<string, unknown>) {
    const { client } = await freshDatabase();
    try {
      await setup(client);
      const fp = await fingerprintOf(client, scope, kinds);
      const before = await snapshot(client);
      const out = recorder();
      expect(await apply(faulty(client, hooks(client)), applyOptions(scope, kinds, fp), { log: out.log }))
        .toEqual({ status: 'refused', ...expected });
      expect(await snapshot(client)).toEqual(before);
      expectNothingRaw(out.text());
    } finally {
      await client.end();
    }
  }
  type Setup0 = (c: Client) => Promise<unknown>;
  const GYM_SCOPE = { organizationId: GYM };
  const andFalse = (t: string) => `${t} and false`;
  const liveToken = (c: Client, hash: string) => c.query(
    'insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)', [hash, COACH, TEST_GYM_2]);
  const tokenSetup = (c: Client) => liveToken(c, 'tok-b6-live');

  test.each([
    ['attendance', /^delete from pilot\.scheduler_attendance/, { table: 'scheduler_attendance', planned: 1, written: 0 }],
    ['registrations', /^delete from pilot\.scheduler_registrations/, { table: 'scheduler_registrations', planned: 1, written: 0 }],
    ['classes', /^delete from pilot\.scheduler_classes/, { table: 'scheduler_classes', planned: 4, written: 0 }],
  ])('WRITE_COUNT_MISMATCH: the %s delete removes nothing', async (_label, match, detail) => {
    await refusedWithFault(clearBlockers, GYM_SCOPE, ['classes'], () => [{ match, text: andFalse }],
      { reason: 'WRITE_COUNT_MISMATCH', ...detail });
  });

  test('WRITE_COUNT_MISMATCH: a tied run that does not come out untied', async () => {
    await refusedWithFault(clearBlockers, GYM_SCOPE, ['classes'], (c) => [{ match: /^delete from pilot\.scheduler_classes/,
      before: () => c.query("update pilot.session_script_runs set class_id = 'c-real' where run_id = 'run-done'") }],
    { reason: 'WRITE_COUNT_MISMATCH', table: 'session_script_runs', planned: 1, written: 0 });
  });

  test('WRITE_COUNT_MISMATCH: a register mark that does not come out untied', async () => {
    await refusedWithFault(clearBlockers, GYM_SCOPE, ['classes'], (c) => [{ match: /^delete from pilot\.scheduler_registrations/, before: async () => {
      await c.query(`insert into pilot.scheduler_attendance (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at) values ($1, 'aaaaaaaa-0000-4000-8000-0000000000fe', 'c-real', $2,
        'present', 'coach_override', 'coach', $3, now())`, [GYM, TEST_ATHLETE, COACH]);
      await c.query("update pilot.session_run_athletes set register_class_id = 'c-real' where run_id = 'run-done'");
    } }], { reason: 'WRITE_COUNT_MISMATCH', table: 'session_run_athletes', planned: 1, written: 0 });
  });

  test('WRITE_COUNT_MISMATCH: the TV Disconnect changes nothing', async () => {
    await refusedWithFault(async () => {}, GYM_SCOPE, ['tvs'], () => [{ match: /^update pilot\.gym_tvs/, text: andFalse }],
      { reason: 'WRITE_COUNT_MISMATCH', table: 'gym_tvs', planned: 1, written: 0 });
  });

  test('WRITE_COUNT_MISMATCH: the organization update changes nothing', async () => {
    await refusedWithFault(tokenSetup, { organizationId: TEST_GYM_2 }, ['test-organizations'],
      () => [{ match: /^update pilot\.organizations/, text: andFalse }],
      { reason: 'WRITE_COUNT_MISMATCH', table: 'organizations', planned: 1, written: 0 });
  });

  test('WRITE_COUNT_MISMATCH: more sessions revoked than were locked', async () => {
    await refusedWithFault(tokenSetup, { organizationId: TEST_GYM_2 }, ['test-organizations'],
      (c) => [{ match: /^update pilot\.session_tokens/, before: () => liveToken(c, 'tok-b6-late') }],
      { reason: 'WRITE_COUNT_MISMATCH', table: 'session_tokens', planned: 1, written: 2 });
  });

  const END_STATE = /^with k as/;
  test.each([
    ['a planned class is back', (c: Client) => insertClass(c, GYM, 'c-strict-1', 'ZZ-AUDIT Test Class'), 'scheduler_classes_left=1'],
    ['an activity_log row names a planned class', (c: Client) => c.query(
      `insert into pilot.activity_log (organization_id, activity_id, person_account_id, activity_domain, activity_type, occurred_on,
         duration_minutes, capture_method, recorded_by_role, recorded_by_account_id, class_id)
       values ($1, 'act-b6-late', $2, 'boxing_training', 'technical_session', '2026-10-06', 60, 'coach_override', 'coach', $2, 'c-strict-1')`,
      [GYM, COACH]), 'activity_log_left=1'],
    ['a floor_plans_daily row names a planned class', (c: Client) => c.query(
      `insert into pilot.floor_plans_daily (organization_id, plan_id, plan_on, class_id, created_by_account_id)
       values ($1, 'fp-b6-late', '2026-10-05', 'c-strict-1', $2)`, [GYM, COACH]), 'floor_plans_daily_left=1'],
  ])('END_STATE_MISMATCH: %s', async (_label, fault, mismatch) => {
    await refusedWithFault(clearBlockers, GYM_SCOPE, ['classes'], (c) => [{ match: END_STATE, before: () => fault(c) }],
      { reason: 'END_STATE_MISMATCH', mismatches: [mismatch] });
  });

  test('END_STATE_MISMATCH: a TV left connected', async () => {
    await refusedWithFault(async () => {}, GYM_SCOPE, ['tvs'], () => [{ match: /^update pilot\.gym_tvs/,
      text: (t) => t.replace(/set revoked_at = coalesce[\s\S]*?pair_code_expires_at = null/, 'set tv_name = t.tv_name') }],
    { reason: 'END_STATE_MISMATCH', mismatches: ['tvs_not_disconnected=1'] });
  });

  test('END_STATE_MISMATCH: the organization active again', async () => {
    await refusedWithFault(tokenSetup, { organizationId: TEST_GYM_2 }, ['test-organizations'], (c) => [{
      match: /^select count\(\*\)::int as n from pilot\.organizations where organization_id = \$1 and status <> 'inactive'/,
      before: () => c.query("update pilot.organizations set status = 'active' where organization_id = $1", [TEST_GYM_2]) }],
    { reason: 'END_STATE_MISMATCH', mismatches: ['organization_not_inactive=1'] });
  });

  test('END_STATE_MISMATCH: a live session left', async () => {
    await refusedWithFault(tokenSetup, { organizationId: TEST_GYM_2 }, ['test-organizations'], (c) => [{
      match: /^select count\(\*\)::int as n from pilot\.session_tokens/, before: () => liveToken(c, 'tok-b6-after') }],
    { reason: 'END_STATE_MISMATCH', mismatches: ['sessions_left=1'] });
  });

  test.each([
    ['a class delete', /^delete from pilot\.scheduler_classes/, "update pilot.scheduler_classes set title = ' ZZ-AUDIT Test Class' where class_id = 'c-strict-1'",
      ['classes'], { table: 'scheduler_classes', planned: 4, written: 3 }],
    ['an attendance delete', /^delete from pilot\.scheduler_attendance/, "update pilot.scheduler_classes set title = 'zz-audit LA2' where class_id = 'c-strict-3'",
      ['classes'], { table: 'scheduler_attendance', planned: 1, written: 0 }],
    ['a TV Disconnect', /^update pilot\.gym_tvs/, "update pilot.gym_tvs set tv_name = 'zz-audit TV' where tv_id = 'tv-strict'",
      ['tvs'], { table: 'gym_tvs', planned: 1, written: 0 }],
  ])('the STRICT marker restated on %s: a row retitled NEAR before it is written is left alone', async (_label, match, retitle, kinds, detail) => {
    await refusedWithFault(clearBlockers, GYM_SCOPE, kinds, (c) => [{ match, before: () => c.query(retitle) }],
      { reason: 'WRITE_COUNT_MISMATCH', ...detail });
  });

  test.each([
    ['class delete', /^delete from pilot\.scheduler_classes/, { o: OTHER, c: 'c-other-strict' }, ['classes'], 'scheduler_classes', "class_id = 'c-other-strict'"],
    ['TV Disconnect', /^update pilot\.gym_tvs/, { o: OTHER, v: 'tv-other-strict' }, ['tvs'], 'gym_tvs', "tv_id = 'tv-other-strict'"],
  ])('the scope restated on the %s: a STRICT row in another gym slipped into the keys is left alone', async (_label, match, key, kinds, table, where) => {
    const { client } = await freshDatabase();
    try {
      await clearBlockers(client);
      const fp = await fingerprintOf(client, GYM_SCOPE, kinds);
      const other = await rowsText(client, table, where);
      const result = await apply(faulty(client, [{ match, values: addKey(key) }]), applyOptions(GYM_SCOPE, kinds, fp), { log: () => {} });
      expect(result.status).toBe('applied');
      expect(await rowsText(client, table, where)).toEqual(other);
    } finally {
      await client.end();
    }
  });
});

test('the Disconnect restates "still connected": an already-disconnected TV slipped into its keys is not counted', async () => {
  const { client } = await freshDatabase();
  try {
    await client.query("update pilot.gym_tvs set revoked_at = now() - interval '1 day' where tv_id = 'tv-strict'");
    await insertTv(client, GYM, 'tv-strict-2', 'ZZ-AUDIT TV two');
    const fp = await fingerprintOf(client, { organizationId: GYM }, ['tvs']);
    const hooks = [{ match: /^update pilot\.gym_tvs/, values: addKey({ o: GYM, v: 'tv-strict' }) }];
    expect(await apply(faulty(client, hooks), applyOptions({ organizationId: GYM }, ['tvs'], fp), { log: () => {} }))
      .toMatchObject({ status: 'applied', counts: { tvs: 1, tvs_already_disconnected: 1 } });
  } finally {
    await client.end();
  }
});

describe('the apply\'s locks', () => {
  test('timeouts first, then a FOR UPDATE on every row it will write, all before the first write', async () => {
    for (const [scope, kinds, locks] of [
      [{ organizationId: GYM }, ['classes', 'tvs'], [/^lock table pilot\.activity_log, pilot\.floor_plans_daily in share mode$/,
        /from pilot\.scheduler_classes c\s+where [\s\S]* for update$/,
        ...['scheduler_registrations', 'scheduler_attendance', 'session_script_runs', 'session_run_athletes']
          .map((t) => new RegExp(`^select 1 from pilot\\.${t} t where [\\s\\S]* for update of t$`)),
        /^select 1 from pilot\.gym_tvs t where [\s\S]*for update$/]],
      [{ organizationId: TEST_GYM_2 }, ['test-organizations'], [/^select 1 from pilot\.organizations where organization_id = \$1 for update$/,
        /^select 1 from pilot\.session_tokens where organization_id = \$1 and revoked_at is null for update$/]],
      // OBSERVED on the full schema: the organization tables no foreign key on organization_id holds back.
      [{ organizationId: HIIT_FIT_ID }, ['hiit-fit'], [/^select 1 from pilot\.organizations where organization_id = \$1 for update$/,
        /^lock table pilot\."recording_sessions", pilot\."shadow_evidence_claims", pilot\."shadow_evidence_items", pilot\."shadow_message_citations", pilot\."video_sessions" in share mode$/]],
    ] as Array<[Options, string[], RegExp[]]>) {
      const { client } = await freshDatabase();
      try {
        await clearBlockers(client);
        const fp = await fingerprintOf(client, scope, kinds);
        const statements: string[] = [];
        expect((await apply(faulty(client, [], statements), applyOptions(scope, kinds, fp), { log: () => {} })).status).toBe('applied');
        const at = (re: RegExp) => statements.findIndex((s) => re.test(s));
        const firstWrite = at(WRITE);
        expect(firstWrite).toBeGreaterThan(0);
        expect(at(/^set local lock_timeout = '10s'$/)).toBe(1);
        expect(at(/^set local statement_timeout = '5min'$/)).toBe(2);
        for (const lock of locks) {
          expect({ lock: String(lock), at: at(lock) > 2 && at(lock) < firstWrite }).toEqual({ lock: String(lock), at: true });
        }
      } finally {
        await client.end();
      }
    }
  });

  test('a planned class is locked: another session cannot retitle it while the apply runs', async () => {
    const { client, name } = await freshDatabase();
    const other = await otherSession(name);
    try {
      await clearBlockers(client);
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['classes']);
      let code: string | undefined;
      const hooks = [{ match: /^delete from pilot\.scheduler_classes/, before: () => other
        .query("update pilot.scheduler_classes set title = ' ZZ-AUDIT Test Class' where class_id = 'c-strict-1'")
        .catch((error: { code?: string }) => { code = error.code; }) }];
      expect(await apply(faulty(client, hooks), applyOptions({ organizationId: GYM }, ['classes'], fp), { log: () => {} }))
        .toMatchObject({ status: 'applied', counts: { classes: 4 } });
      expect(code).toBe('55P03');
    } finally {
      await other.end();
      await client.end();
    }
  });

  test('"hiit fit" is locked: another session cannot add a row that names it while the apply runs', async () => {
    const { client, name } = await freshDatabase();
    const other = await otherSession(name);
    try {
      const fp = await fingerprintOf(client, { organizationId: HIIT_FIT_ID }, ['hiit-fit']);
      let code: string | undefined;
      const hooks = [{ match: /^update pilot\.organizations/, before: () => other
        .query("insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach')", [COACH, HIIT_FIT_ID])
        .catch((error: { code?: string }) => { code = error.code; }) }];
      expect((await apply(faulty(client, hooks), applyOptions({ organizationId: HIIT_FIT_ID }, ['hiit-fit'], fp), { log: () => {} })).status)
        .toBe('applied');
      expect(code).toBe('55P03');
      expect((await client.query('select 1 from pilot.organization_memberships where organization_id = $1', [HIIT_FIT_ID])).rowCount).toBe(0);
    } finally {
      await other.end();
      await client.end();
    }
  });

  // The reviewer's race: a row arrives from another session after the end-state re-count, just
  // before the audit insert. The tables no key holds back are held whole, so it waits and fails.
  test.each([
    ['recording_sessions', `insert into pilot.recording_sessions (recording_session_id, organization_id, created_by_account_id,
       training_context, join_code) values ('rs-b6', $1, $2, 'mitts', 'B6JOIN')`],
    ['video_sessions (both composite-key partners null)', `insert into pilot.video_sessions (video_session_id, organization_id,
       uploaded_by_account_id, title, blob_path, file_name, file_size_bytes, mime_type)
       values ('vs-b6', $1, $2, 'clip', 'blob/vs-b6', 'vs-b6.mp4', 1, 'video/mp4')`],
  ])('"hiit fit" cannot gain a %s row before the commit: it waits and fails, and "hiit fit" is closed empty', async (table, insert) => {
    const { client, name } = await freshDatabase();
    const other = await otherSession(name);
    try {
      const fp = await fingerprintOf(client, { organizationId: HIIT_FIT_ID }, ['hiit-fit']);
      let code: string | undefined;
      const hooks = [{ match: /^insert into pilot\.audit_events/, before: () => other.query(insert, [HIIT_FIT_ID, COACH])
        .catch((error: { code?: string }) => { code = error.code; }) }];
      expect((await apply(faulty(client, hooks), applyOptions({ organizationId: HIIT_FIT_ID }, ['hiit-fit'], fp), { log: () => {} })).status)
        .toBe('applied');
      expect(code).toBe('55P03');
      const base = table.split(' ')[0];
      expect((await client.query(`select 1 from pilot.${base} where organization_id = $1`, [HIIT_FIT_ID])).rowCount).toBe(0);
    } finally {
      await other.end();
      await client.end();
    }
  });

  test.each([
    ['activity_log', `insert into pilot.activity_log (organization_id, activity_id, person_account_id, activity_domain, activity_type,
       occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id, class_id)
       values ($1, 'act-b6-race', $2, 'boxing_training', 'technical_session', '2026-10-07', 60, 'coach_override', 'coach', $2, 'c-strict-1')`],
    ['floor_plans_daily', `insert into pilot.floor_plans_daily (organization_id, plan_id, plan_on, class_id, created_by_account_id)
       values ($1, 'fp-b6-race', '2026-10-05', 'c-strict-1', $2)`],
  ])('no %s row can come to name a planned class before the commit: it waits and fails', async (table, insert) => {
    const { client, name } = await freshDatabase();
    const other = await otherSession(name);
    try {
      await clearBlockers(client);
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['classes']);
      let code: string | undefined;
      const hooks = [{ match: /^insert into pilot\.audit_events/, before: () => other.query(insert, [GYM, COACH])
        .catch((error: { code?: string }) => { code = error.code; }) }];
      expect((await apply(faulty(client, hooks), applyOptions({ organizationId: GYM }, ['classes'], fp), { log: () => {} })).status)
        .toBe('applied');
      expect(code).toBe('55P03');
      expect((await client.query(`select 1 from pilot.${table} where class_id = 'c-strict-1'`)).rowCount).toBe(0);
    } finally {
      await other.end();
      await client.end();
    }
  });

  test('the end-state re-count of "hiit fit" is a check of its own: a row it finds rolls everything back', async () => {
    const { client } = await freshDatabase();
    try {
      const fp = await fingerprintOf(client, { organizationId: HIIT_FIT_ID }, ['hiit-fit']);
      const before = await snapshot(client);
      // Fault injection, in the apply's own transaction (no lock holds it back): a row just before the re-count.
      const hooks = [{ match: /^select t, n from \(/, before: () => client.query(
        "insert into pilot.recording_sessions (recording_session_id, organization_id, created_by_account_id, training_context, join_code) values ('rs-b6', $1, $2, 'mitts', 'B6JOIN')",
        [HIIT_FIT_ID, COACH]) }];
      expect(await apply(faulty(client, hooks), applyOptions({ organizationId: HIIT_FIT_ID }, ['hiit-fit'], fp), { log: () => {} }))
        .toEqual({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: ['hiit_fit_rows:recording_sessions=1'] });
      expect(await statusOf(client, HIIT_FIT_ID)).toBe('active');
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});

describe('the apply on the command line', () => {
  const applyEnv = (fp: string, overrides: Record<string, string> = {}) => ({
    PPBF_AUDIT_TEST_CLEANUP_APPLY: 'true', PPBF_AUDIT_TEST_CLEANUP_CONFIRM: CONFIRM, PPBF_AUDIT_TEST_CLEANUP_EXPECT_FINGERPRINT: fp, ...overrides,
  });

  test('kinds on a dry run are a report parameter: parsed, not an apply', () => {
    for (const value of [undefined, 'TRUE', '1']) {
      expect(parseOptions(value === undefined ? {} : { PPBF_AUDIT_TEST_CLEANUP_APPLY: value }, ['--organization', GYM, '--kinds', 'tvs,classes']))
        .toEqual({ ok: true, options: { organizationId: GYM, kinds: ['tvs', 'classes'] } });
    }
    expect(parseOptions({}, ['--organization', GYM, '--kinds', 'sweep'])).toEqual({ ok: false, refusal: { reason: 'INVALID_KINDS' } });
  });

  test.each([
    ['an apply with no kinds', applyEnv(NO_FINGERPRINT), ['--organization', GYM], 'APPLY_WITHOUT_KINDS'],
    ['the sweep as a kind', applyEnv(NO_FINGERPRINT), ['--organization', GYM, '--kinds', 'sweep'], 'INVALID_KINDS'],
    ['a kind twice', applyEnv(NO_FINGERPRINT), ['--organization', GYM, '--kinds', 'classes,classes'], 'INVALID_KINDS'],
    ['an empty kind', applyEnv(NO_FINGERPRINT), ['--organization', GYM, '--kinds', 'classes,'], 'INVALID_KINDS'],
    ['--kinds with no value', applyEnv(NO_FINGERPRINT), ['--organization', GYM, '--kinds'], 'INVALID_KINDS'],
    ['--kinds twice', applyEnv(NO_FINGERPRINT), ['--organization', GYM, '--kinds', 'tvs', '--kinds', 'classes'], 'INVALID_KINDS'],
    ['no confirm phrase', applyEnv(NO_FINGERPRINT, { PPBF_AUDIT_TEST_CLEANUP_CONFIRM: '' }), ['--organization', GYM, '--kinds', 'tvs'], 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['a confirm phrase in lower case', applyEnv(NO_FINGERPRINT, { PPBF_AUDIT_TEST_CLEANUP_CONFIRM: CONFIRM.toLowerCase() }),
      ['--organization', GYM, '--kinds', 'tvs'], 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['no expected fingerprint', applyEnv(''), ['--organization', GYM, '--kinds', 'tvs'], 'APPLY_WITHOUT_EXPECTED_FINGERPRINT'],
    ['a malformed fingerprint', applyEnv('sha256:abc'), ['--organization', GYM, '--kinds', 'tvs'], 'INVALID_EXPECTED_FINGERPRINT'],
    ['a test gym kind for every organization', applyEnv(NO_FINGERPRINT), ['--all-organizations', '--kinds', 'test-organizations'],
      'ORGANIZATION_KIND_NEEDS_ONE_ORGANIZATION'],
    ['"hiit fit" for every organization', applyEnv(NO_FINGERPRINT), ['--all-organizations', '--kinds', 'tvs,hiit-fit'],
      'ORGANIZATION_KIND_NEEDS_ONE_ORGANIZATION'],
  ])('%s is refused before a client is created', async (_label, overrides, argv, reason) => {
    const createClient = jest.fn();
    const result = await runTool(envFor('unused', overrides as Record<string, string>), argv as string[], { createClient, log: () => {} });
    expect(result).toEqual({ status: 'refused', reason });
    expect(createClient).not.toHaveBeenCalled();
  });

  test('a full apply through the script: exit 0, the applied line, no raw person id, the rows gone', async () => {
    const { client, name } = await freshDatabase();
    try {
      await clearBlockers(client);
      const fp = await fingerprintOf(client, { organizationId: GYM }, ['classes', 'tvs']);
      const child = spawnSync(process.execPath, [TOOL_PATH, '--organization', GYM, '--kinds', 'classes,tvs'], {
        cwd: WEB_DIR, env: { ...process.env, ...envFor(name), ...applyEnv(fp) }, encoding: 'utf8', timeout: 300_000,
      });
      const printed = `${child.stdout}\n${child.stderr}`;
      expect(child.status).toBe(0);
      expect(printed).toContain('"event":"audit_test_cleanup.applied"');
      expect(printed).toContain(fp);
      expectNothingRaw(printed);
      expect((await client.query("select 1 from pilot.scheduler_classes where class_id like 'c-strict-%'")).rowCount).toBe(0);
      expect((await client.query("select 1 from pilot.gym_tvs where tv_id = 'tv-strict' and revoked_at is not null")).rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a refused apply through the script exits 1 and writes nothing', async () => {
    const { client, name } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const child = spawnSync(process.execPath, [TOOL_PATH, '--organization', GYM, '--kinds', 'classes'], {
        cwd: WEB_DIR, env: { ...process.env, ...envFor(name), ...applyEnv(NO_FINGERPRINT) }, encoding: 'utf8', timeout: 300_000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('"reason":"PLAN_FINGERPRINT_MISMATCH"');
      expectNothingRaw(`${child.stdout}\n${child.stderr}`);
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
