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
  register_marks_pointing_here: number;
  untracked_references: { activity_log: number; floor_plans_daily: number };
  audit_rows_naming_it: number;
  apply_would_refuse: string[];
};
type Hit = { table: string; column: string; key: Record<string, string>; organization_id: string | null; marker?: string };
type Result = {
  status: string;
  reason?: string;
  plan_fingerprint?: string;
  counts?: Record<string, number | boolean>;
  unknown_foreign_keys?: string[];
  classes?: ClassReport[];
  tvs?: { marked: Array<Record<string, unknown>>; others: Array<Record<string, unknown>> };
  test_organizations?: Array<{ organization_id: string; status: string; members_by_role: Record<string, number>; rows_by_table: Record<string, number> }>;
  hiit_fit?: Record<string, unknown>;
  sweep?: { tables_scanned: number; columns_scanned: number; tables_skipped_no_organization_column: string[]; truncated_tables: string[]; strict: Hit[]; near: Hit[] };
};
type Options = Record<string, unknown>;
type Deps = { log?: (event: string, payload: Record<string, unknown>) => void; createClient?: (cs: string) => unknown };
type ReportFn = (client: unknown, options: Options, deps?: Deps) => Promise<Result>;
type RunFn = (env: Record<string, string>, argv: string[], deps?: Deps) => Promise<Result>;
type ParseFn = (env: Record<string, string>, argv: string[]) => { ok: boolean; refusal?: { reason: string }; options?: Options };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let report: ReportFn;
let runTool: RunFn;
let parseOptions: ParseFn;
let databaseCounter = 0;

/** Computed here, not by the tool, so a broken personRef cannot agree with itself. */
const ref = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

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
  await insertClass(target, GYM, 'c-real', 'Tuesday boxing, not an AUDIT TEST', { start: iso(DAY), end: iso(DAY + 60 * 60 * 1000) });
  await insertClass(target, OTHER, 'c-other-strict', 'ZZ-AUDIT in another gym');

  await target.query(
    `insert into pilot.scheduler_registrations
       (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
     values ($1, 'reg-test', 'c-strict-3', $2, 'coach', $4, 'registered'),
            ($1, 'reg-real', 'c-real', $3, 'coach', $4, 'registered')`,
    [GYM, TEST_ATHLETE, REAL_ATHLETE, COACH],
  );
  await target.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
        checked_in_by_account_id, note, checked_in_at)
     values ($1, 'att-test', 'c-strict-3', $2, 'present', 'coach_override', 'coach', $3, $4, '2026-10-19T22:05:00Z')`,
    [GYM, TEST_ATHLETE, COACH, `ZZ-AUDIT LA2 ${TEXT_SENTINEL}`],
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
     values ('update', $1, 'scheduler_class', 'c-strict-3', '{}'::jsonb)`,
    [GYM],
  );

  await insertTv(target, GYM, 'tv-strict', 'ZZ-AUDIT TV');
  await insertTv(target, GYM, 'tv-near', 'zz-audit spare screen');
  await insertTv(target, GYM, 'tv-real', `Ring TV ${TEXT_SENTINEL}`);

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
    ...overrides,
  };
}

/** No raw person id and no record text, anywhere in `text`. */
function expectNothingRaw(text: string) {
  for (const raw of [TEST_ATHLETE, NAMED_ATHLETE, REAL_ATHLETE, TEXT_SENTINEL, 'SENTINEL']) expect(text).not.toContain(raw);
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
  report = tool.reportAuditTestRecords as ReportFn;
  runTool = tool.run as RunFn;
  parseOptions = tool.parseOptions as ParseFn;

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
      expect(la2.registrations).toEqual([{ registration_id: 'reg-test', athlete_ref: ref(TEST_ATHLETE), status: 'registered' }]);
      expect(la2.attendance).toEqual([{ attendance_id: 'att-test', athlete_ref: ref(TEST_ATHLETE), status: 'present' }]);
      expect(la2.tied_runs).toEqual([{ run_id: 'run-done', run_state: 'completed' }]);
      expect(la2.register_marks_pointing_here).toBe(1);
      expect(la2.audit_rows_naming_it).toBe(1);
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

  test('a foreign key into the class tables the tool does not know refuses every class', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(
        `create table pilot.zz_b6_probe (organization_id text, class_id text,
           foreign key (organization_id, class_id) references pilot.scheduler_classes(organization_id, class_id))`,
      );
      const result = await report(client, { organizationId: GYM }, { log: () => {} });
      expect(result.unknown_foreign_keys).toEqual(['zz_b6_probe->scheduler_classes']);
      for (const c of result.classes!) expect(c.apply_would_refuse).toContain('UNKNOWN_FOREIGN_KEY');
    } finally {
      await client.end();
    }
  });
});

describe('the fingerprint', () => {
  test('is stable, changes with a planned row, and ignores NEAR rows and sweep-only (K5) rows', async () => {
    const { client } = await freshDatabase();
    try {
      const first = (await report(client, { organizationId: GYM }, { log: () => {} })).plan_fingerprint;
      expect((await report(client, { organizationId: GYM }, { log: () => {} })).plan_fingerprint).toBe(first);
      expect((await report(client, { allOrganizations: true }, { log: () => {} })).plan_fingerprint).not.toBe(first);

      await insertClass(client, GYM, 'c-near-new', 'zz-audit another near miss');
      await insertTv(client, GYM, 'tv-near-new', 'Audit test spare');
      await insertNote(client, '44444444-4444-4444-8444-444444444444', REAL_ATHLETE, 'ZZ-AUDIT new note');
      expect((await report(client, { organizationId: GYM }, { log: () => {} })).plan_fingerprint).toBe(first);

      await client.query(
        `insert into pilot.scheduler_registrations
           (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
         values ($1, 'reg-new', 'c-strict-1', $2, 'coach', $3, 'registered')`,
        [GYM, REAL_ATHLETE, COACH],
      );
      expect((await report(client, { organizationId: GYM }, { log: () => {} })).plan_fingerprint).not.toBe(first);
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
        `scheduler_attendance.note:${JSON.stringify({ organization_id: GYM, attendance_id: 'att-test' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-strict-1' })}`,
      ]));
      expect(where(sweep.near)).toEqual(expect.arrayContaining([
        `coach_observations.note_text:${JSON.stringify({ organization_id: GYM, note_id: NOTE_NEAR })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-audit-test' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-lower' })}`,
        `scheduler_classes.title:${JSON.stringify({ organization_id: GYM, class_id: 'c-near-space' })}`,
      ]));
      const everywhere = JSON.stringify([...sweep.strict, ...sweep.near]);
      expect(everywhere).not.toContain(NOTE_REAL);
      expect(everywhere).not.toContain('c-real');
      expect(everywhere).not.toContain('c-other-strict');
      expect(sweep.strict.every((h) => h.organization_id === GYM)).toBe(true);
      expect(sweep.tables_skipped_no_organization_column.length).toBeGreaterThan(0);
      expect(sweep.tables_scanned).toBeGreaterThan(100);
      expectNothingRaw(out.text());
      const all = await report(client, { allOrganizations: true }, { log: () => {} });
      expect(all.sweep!.tables_skipped_no_organization_column).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('read-only and refusals', () => {
  test('one read-only transaction, rolled back, with no write statement', async () => {
    const { client } = await freshDatabase();
    try {
      const statements: string[] = [];
      const spy = { query: (text: string, values?: unknown[]) => { statements.push(text.trim()); return client.query(text, values); } };
      const result = await report(spy, { organizationId: GYM }, { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(statements[0]).toBe('begin transaction read only');
      expect(statements[statements.length - 1]).toBe('rollback');
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
    ['an apply request (no write path exists)', { PPBF_AUDIT_TEST_CLEANUP_APPLY: 'true' }, 'APPLY_NOT_AVAILABLE'],
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
    const child = spawnSync(process.execPath, [TOOL_PATH, '--organization', GYM], {
      cwd: WEB_DIR, env: { ...process.env, ...envFor(name) }, encoding: 'utf8', timeout: 300_000,
    });
    expect(child.status).toBe(0);
    const printed = `${child.stdout}\n${child.stderr}`;
    expect(printed).toContain('"event": "audit_test_cleanup.plan"');
    expect(printed).toContain('"event":"audit_test_cleanup.dry-run"');
    expect(printed).toContain(ref(TEST_ATHLETE));
    expect(printed).toContain(ref(NAMED_ATHLETE));
    expectNothingRaw(printed);
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
