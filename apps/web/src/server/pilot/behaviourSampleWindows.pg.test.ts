// Real PostgreSQL proof of PATTERN-1d's storage (PunxsyProminence/ppbf-platform#2082;
// Q2 A): the window table and its migration. The migration applies over itself
// and its apply script finds every part ready; the table's guard holds what the
// server will rely on (no direct delete; close once; the opener's set-null and
// the purge's de-identify of a deleted athlete, and nothing else; inserts need
// a live athlete, an active opener of this gym in its role and an active
// behaviour name); a window still naming an athlete goes with the athlete row;
// the purge gives a window the same token as the child's reports. And
// PATTERN-1d-2's window functions: a window opens through the writer's run,
// presence and drill checks; a chance's episode is fixed by window and chance,
// so two coaches' taps of one chance are one attempt of one moment, even at
// once; a coach's second tap of a chance revises their first; the writer holds
// a window chance to the window and to a bare tap, and no full report joins a
// chance; a close waits for a tap in flight; only staff of this gym close or
// read back, and each coach reads back only their own taps.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { closePool } from './db';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-behaviour-windows-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const APPLY_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-behaviour-sample-windows-migration.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_behaviour_sample_windows_migration.sql');
const TEST_DB_NAME = 'ppbf_test_behaviour_windows';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-bsw-1';
const OTHER_ORG = 'org-bsw-2';
const COACH_A = 'acct-bsw-coach-a';
const COACH_B = 'acct-bsw-coach-b';
const OTHER_GYM_COACH = 'acct-bsw-other';
const ATHLETE = 'ath-bsw-1';
const OTHER_ATHLETE = 'ath-bsw-2';
const LEAVING = 'ath-bsw-3';
const SOFT = 'ath-bsw-4';
const COACH_LAPSED = 'acct-bsw-lapsed';
const COACH_GONE = 'acct-bsw-gone';
const BOARD_MEMBER = 'acct-bsw-board';
const RETIRED_KEY = 'bk_fixture_bsw_retired';
const RUN = 'run-bsw-1';
const PLANNED_RUN = 'run-bsw-2';
const OTHER_RUN = 'run-bsw-3';
const DRILL = 'drill-bsw-1';
// A fixture key written straight to the table; keys the app makes are minted (bk_<hex>).
const KEY = 'bk_fixture_bsw_guard';
const OTHER_KEY = 'bk_fixture_bsw_other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let windows: typeof import('./behaviourSampleWindows');
let writer: typeof import('./behaviourObservations');
let runs: typeof import('./sessionScriptRuns');

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

/** The database's refusal, as code and constraint. */
async function refusalOf(sql: string, params: unknown[]): Promise<{ code?: string; constraint?: string }> {
  try {
    await db.query(sql, params);
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    return { code: pgError.code, constraint: pgError.constraint };
  }
  return {};
}

/** An insert attempt with every column named; the database's refusal, or {} when it was taken. */
function tryInsert(o: {
  athlete?: string; opener?: string; role?: string; key?: string; run?: string; kind?: string; id?: string;
  closedAt?: string | null; deidentifiedAt?: string | null;
} = {}) {
  return refusalOf(
    `insert into pilot.behaviour_observations_windows
       (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
        opened_by_account_id, opened_by_role, closed_at, deidentified_at)
     values ($1, $2, $3, $4, $5, $6, 'controlled', $7, $8, $9, $10)`,
    [ORG, o.athlete ?? ATHLETE, o.key ?? KEY, o.run ?? RUN, o.kind ?? 'drill', o.id ?? DRILL, o.opener ?? COACH_A,
      o.role ?? 'coach', o.closedAt ?? null, o.deidentifiedAt ?? null],
  );
}

/** One window, written straight to the table as the window functions will. */
async function insertWindow(input: { athlete?: string; opener?: string; chances?: number } = {}): Promise<{ window_id: string; chances: number; closed_at: Date | null }> {
  const result = await db.query<{ window_id: string; chances: number; closed_at: Date | null }>(
    `insert into pilot.behaviour_observations_windows
       (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
        opened_by_account_id, opened_by_role${input.chances === undefined ? '' : ', chances'})
     values ($1, $2, $3, $4, 'drill', $5, 'controlled', $6, 'coach'${input.chances === undefined ? '' : ', $7'})
     returning window_id, chances, closed_at`,
    [ORG, input.athlete ?? ATHLETE, KEY, RUN, DRILL, input.opener ?? COACH_A, ...(input.chances === undefined ? [] : [input.chances])],
  );
  return result.rows[0];
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
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Fixture Gym', 'active'), ($2, 'Other Fixture Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [COACH_A, 'coach', ORG], [COACH_B, 'coach', ORG], [OTHER_GYM_COACH, 'coach', OTHER_ORG],
    [COACH_LAPSED, 'coach', ORG], [COACH_GONE, 'coach', ORG], [BOARD_MEMBER, 'board', ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [accountId, organizationId, role],
    );
  }
  for (const athleteId of [ATHLETE, OTHER_ATHLETE, LEAVING, SOFT]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Fixture Athlete', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now(), null)`,
      [ORG, athleteId, COACH_A],
    );
  }
  await db.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, $2, 'lineage-bsw-1', 'Jab return', 'technical', 'b', 'p', 's', 'e', 'g', 'bad', 'none', 'SK-JAB-01')`,
    [ORG, DRILL],
  );
  await db.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, ended_at)
     values ($1, $2, null, null, $3, current_date, 'completed', now() - interval '1 hour', now()),
            ($1, $4, null, null, $3, current_date, 'completed', now() - interval '1 hour', now())`,
    [ORG, RUN, COACH_A, OTHER_RUN],
  );
  // Another unplanned run the athlete was at: a report there differs from the window by its run alone.
  await db.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $4, 'coach')`,
    [ORG, OTHER_RUN, ATHLETE, COACH_A],
  );
  await db.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $6, 'coach'), ($1, $2, $4, $6, 'coach'), ($1, $2, $5, $6, 'coach')`,
    [ORG, RUN, ATHLETE, LEAVING, SOFT, COACH_A],
  );
  await db.query(
    'update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = $2',
    [COACH_LAPSED, ORG],
  );
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
     values ($1, $2, 'Fixture behaviour', 'SK-JAB-01', $3)`,
    [ORG, KEY, COACH_A],
  );
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
     values ($1, $2, 'Fixture retired behaviour', 'SK-JAB-01', $3)`,
    [ORG, RETIRED_KEY, COACH_A],
  );
  await db.query(`update pilot.behaviour_keys set status = 'retired' where organization_id = $1 and behaviour_key = $2`, [ORG, RETIRED_KEY]);
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
     values ($1, $2, 'Fixture other behaviour', 'SK-JAB-01', $3)`,
    [ORG, OTHER_KEY, COACH_A],
  );

  // A run that delivered a plan whose one block runs another drill: the window's drill was not part of it.
  await db.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, 'drill-bsw-2', 'lineage-bsw-2', 'Slip and counter', 'technical', 'b', 'p', 's', 'e', 'g', 'bad', 'none', 'SK-JAB-01')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, total_minutes, created_by_account_id)
     values ($1, 'scr-bsw-1', 'scr-bsw-1', 1, 'Plan', 10, $2)`,
    [ORG, COACH_A],
  );
  await db.query(
    `insert into pilot.session_script_blocks
       (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, what_to_say, block_kind, drill_id)
     values ($1, 'blk-bsw-1', 'scr-bsw-1', 1, 0, 10, 'Block', 'say', 'drill_round', 'drill-bsw-2')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, ended_at)
     values ($1, $2, 'scr-bsw-1', 1, $3, current_date, 'completed', now() - interval '1 hour', now())`,
    [ORG, PLANNED_RUN, COACH_A],
  );
  await db.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $4, 'coach')`,
    [ORG, PLANNED_RUN, ATHLETE, COACH_A],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  windows = await import('./behaviourSampleWindows');
  writer = await import('./behaviourObservations');
  runs = await import('./sessionScriptRuns');

});

afterAll(async () => {
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

describe('the migration', () => {
  test('applies again over itself, and its apply script finds every part ready', async () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await db.query(sql);
    const apply = await nativeDynamicImport(pathToFileURL(APPLY_SCRIPT_PATH).href);
    await expect((apply.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>)(db, sql)).resolves.toBeUndefined();
  });
});

describe('a window row', () => {
  test('opens with ten chances unless set, and the table keeps its numbers in bounds', async () => {
    expect(await insertWindow()).toEqual(expect.objectContaining({ chances: 10, closed_at: null }));
    expect((await insertWindow({ chances: 3 })).chances).toBe(3);
    expect(await refusalOf(
      `insert into pilot.behaviour_observations_windows
         (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
          opened_by_account_id, opened_by_role, chances)
       values ($1, $2, $3, $4, 'drill', $5, 'controlled', $6, 'coach', 51)`,
      [ORG, ATHLETE, KEY, RUN, DRILL, COACH_A],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_chances_check' });
  });

  test('a window is for a child marked present on that run of this gym (Q5 A)', async () => {
    expect(await tryInsert({ run: 'run-nowhere' })).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_present_on_run' });
    expect(await tryInsert({ athlete: OTHER_ATHLETE })).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_present_on_run' });
  });

  test('the drill or block is this gym\'s, and a context is one of the fixed nine: no free text', async () => {
    expect(await tryInsert({ kind: 'context', id: 'open_floor' })).toEqual({});
    expect(await tryInsert({ kind: 'context', id: 'Fixture_free_text' })).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_context_check' });
    expect(await tryInsert({ id: 'drill-nowhere' })).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_context_of_this_gym' });
    expect(await tryInsert({ kind: 'block', id: 'block-nowhere' })).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_context_of_this_gym' });
  });

  test('the open and close times are the database\'s, not the caller\'s', async () => {
    const row = await db.query<{ window_id: string; opened_at: Date }>(
      `insert into pilot.behaviour_observations_windows
         (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
          opened_by_account_id, opened_by_role, opened_at)
       values ($1, $2, $3, $4, 'drill', $5, 'controlled', $6, 'coach', '2099-01-01T00:00:00Z')
       returning window_id, opened_at`,
      [ORG, ATHLETE, KEY, RUN, DRILL, COACH_A],
    );
    expect(Math.abs(row.rows[0].opened_at.getTime() - Date.now())).toBeLessThan(60_000);
    const closed = await db.query<{ closed_at: Date }>(
      `update pilot.behaviour_observations_windows set closed_at = '9999-01-01T00:00:00Z'
        where organization_id = $1 and window_id = $2 returning closed_at`,
      [ORG, row.rows[0].window_id],
    );
    expect(Math.abs(closed.rows[0].closed_at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

describe('the table\'s guard', () => {
  let windowId: string;
  beforeAll(async () => {
    windowId = (await insertWindow()).window_id;
  });

  test.each([
    ['delete', 'delete from pilot.behaviour_observations_windows where organization_id = $1 and window_id = $2', 'pilot_behaviour_windows_no_delete'],
    ['change the number of chances', 'update pilot.behaviour_observations_windows set chances = 20 where organization_id = $1 and window_id = $2', 'pilot_behaviour_windows_append_only'],
    ['name another athlete', `update pilot.behaviour_observations_windows set athlete_id = 'ath-bsw-2' where organization_id = $1 and window_id = $2`, 'pilot_behaviour_windows_append_only'],
  ])('refuses to %s', async (_label, sql, constraint) => {
    expect(await refusalOf(sql, [ORG, windowId])).toEqual({ code: '23514', constraint });
  });

  test('closes once, and refuses to reopen or close again', async () => {
    const close = 'update pilot.behaviour_observations_windows set closed_at = now() where organization_id = $1 and window_id = $2';
    await db.query(close, [ORG, windowId]);
    expect(await refusalOf(close, [ORG, windowId])).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
    expect(await refusalOf(
      'update pilot.behaviour_observations_windows set closed_at = null where organization_id = $1 and window_id = $2', [ORG, windowId],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
  });

  test.each([
    ['an opener from another gym', { opener: OTHER_GYM_COACH }, 'pilot_behaviour_windows_opener_of_this_gym'],
    ['an athlete not on the roster', { athlete: 'ath-nowhere' }, 'pilot_behaviour_windows_live_athlete'],
    ['an anon token', { athlete: 'anon_00000000-0000-4000-8000-000000000000' }, 'pilot_behaviour_windows_live_athlete'],
    ['an athlete marked deleted', { athlete: SOFT, soft: true }, 'pilot_behaviour_windows_live_athlete'],
    ['an opener whose membership lapsed', { opener: COACH_LAPSED }, 'pilot_behaviour_windows_opener_of_this_gym'],
    ['a role the opener does not hold', { role: 'organization_admin' }, 'pilot_behaviour_windows_opener_of_this_gym'],
    ['a retired behaviour name', { key: RETIRED_KEY }, 'pilot_behaviour_windows_active_key'],
    ['a row already closed', { closedAt: '2026-01-01T00:00:00Z' }, 'pilot_behaviour_windows_live_athlete'],
    ['a row already de-identified', { deidentifiedAt: '2026-01-01T00:00:00Z' }, 'pilot_behaviour_windows_live_athlete'],
  ])('refuses a window from %s', async (_label, given, constraint) => {
    const { soft, ...overrides } = given as typeof given & { soft?: boolean };
    if (soft) await db.query('update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2', [ORG, SOFT]);
    expect(await tryInsert(overrides)).toEqual({ code: '23514', constraint });
    if (soft) await db.query('update pilot.athletes set deleted_at = null where organization_id = $1 and athlete_id = $2', [ORG, SOFT]);
  });

  test('closing moves nothing else', async () => {
    const { window_id: other } = await insertWindow();
    expect(await refusalOf(
      'update pilot.behaviour_observations_windows set closed_at = now(), chances = 5 where organization_id = $1 and window_id = $2',
      [ORG, other],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
  });

  test('the opener\'s account going clears the opener and nothing else', async () => {
    const { window_id: theirs } = await insertWindow({ opener: COACH_GONE });
    await db.query('delete from pilot.organization_memberships where account_id = $1', [COACH_GONE]);
    await db.query('delete from pilot.accounts where account_id = $1', [COACH_GONE]);
    const row = await db.query<{ opened_by_account_id: string | null; athlete_id: string }>(
      'select opened_by_account_id, athlete_id from pilot.behaviour_observations_windows where organization_id = $1 and window_id = $2',
      [ORG, theirs],
    );
    expect(row.rows).toEqual([{ opened_by_account_id: null, athlete_id: ATHLETE }]);
  });

  test('refuses de-identification to anything but a token', async () => {
    const { window_id: softWindow } = await insertWindow({ athlete: SOFT });
    await db.query('update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2', [ORG, SOFT]);
    expect(await refusalOf(
      `update pilot.behaviour_observations_windows set athlete_id = 'anon_bad', deidentified_at = now()
        where organization_id = $1 and window_id = $2`,
      [ORG, softWindow],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
    await db.query('update pilot.athletes set deleted_at = null where organization_id = $1 and athlete_id = $2', [ORG, SOFT]);
  });

  test('refuses de-identification while the athlete is on the roster', async () => {
    expect(await refusalOf(
      `update pilot.behaviour_observations_windows
          set athlete_id = 'anon_00000000-0000-4000-8000-000000000001', deidentified_at = now()
        where organization_id = $1 and window_id = $2`,
      [ORG, windowId],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
  });
});

const open = (overrides: Partial<Parameters<typeof windows.openBehaviourWindow>[0]> = {}) => windows.openBehaviourWindow({
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: KEY,
  runId: RUN,
  context: { drillId: DRILL },
  taskConstraint: 'controlled',
  openedByAccountId: COACH_A,
  openedByRole: 'coach',
  ...overrides,
});

const tap = (windowId: string, chance: number, observer: string, polarity: 'occurrence' | 'counterexample') => windows.recordWindowTap({
  organizationId: ORG, windowId, chance, polarity, observerAccountId: observer, authorRole: 'coach',
});

describe('opening a window (PATTERN-1d-2; Q5 A, Q7 A)', () => {
  test('opens under the run, for a present athlete, with ten chances unless set', async () => {
    const row = await open();
    expect(row).toEqual(expect.objectContaining({
      athlete_id: ATHLETE, behaviour_key: KEY, run_id: RUN, context_kind: 'drill', context_id: DRILL,
      task_constraint: 'controlled', chances: 10, opened_by_account_id: COACH_A, closed_at: null,
    }));
    expect((await open({ chances: 3 })).chances).toBe(3);
  });

  test('is refused for an athlete not marked present, a drill not in the gym, or a bad number', async () => {
    await expect(open({ athleteId: OTHER_ATHLETE })).rejects.toThrow('not marked present');
    await expect(open({ context: { drillId: 'drill-nowhere' } })).rejects.toThrow('not in this gym');
    await expect(open({ chances: 51 })).rejects.toThrow('A window has 1 to 50 chances.');
    await expect(open({ taskConstraint: 'sparring' })).rejects.toThrow('taskConstraint must be one of');
    await expect(open({ behaviourKey: RETIRED_KEY })).rejects.toThrow('not on the active list');
  });

  test('a drill that was not part of the run\'s plan is refused (the writer\'s check, which the table cannot make)', async () => {
    await expect(open({ runId: PLANNED_RUN })).rejects.toThrow('That drill was not part of that session run.');
    expect(await open({ runId: PLANNED_RUN, context: { blockId: 'blk-bsw-1' } })).toEqual(expect.objectContaining({ context_kind: 'block' }));
  });
});

/** The reports on one chance of a window, oldest first, as written. */
async function readingsOf(windowId: string, chance: number) {
  return (await db.query<{
    observation_id: string; observer_account_id: string; episode_id: string; session_key: string; task_constraint: string;
    attribution_target: string; attribution_certainty: string; polarity: string; supersedes_observation_id: string | null;
    observed_at: Date; created_at: Date;
  }>(
    `select observation_id, observer_account_id, episode_id, session_key, task_constraint, attribution_target,
            attribution_certainty, polarity, supersedes_observation_id, observed_at, created_at
       from pilot.behaviour_observations where organization_id = $1 and episode_id = $2
      order by created_at, observation_id`,
    [ORG, writer.windowEpisodeId(ORG, windowId, chance)],
  )).rows;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (up to 10 s) until `count` lock requests are queued; false if they never are. */
async function waiters(count: number): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from pg_locks where not granted');
    if (rows[0].n >= count) return true;
    await sleep(50);
  }
  return false;
}

/** Holds a chance's episode lock from another connection, as a tap in flight would. */
async function holdEpisode(windowId: string, chance: number): Promise<Client> {
  const holder = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await holder.connect();
  await holder.query('begin');
  await holder.query(
    `select pg_advisory_xact_lock(hashtextextended('pilot.behaviour_observations|' || $1 || '|' || $2, 0))`,
    [ORG, writer.windowEpisodeId(ORG, windowId, chance)],
  );
  return holder;
}

async function release(holder: Client): Promise<void> {
  await holder.query('commit');
  await holder.end();
}

const close = (windowId: string, by = COACH_A) => windows.closeBehaviourWindow({ organizationId: ORG, windowId, closedByAccountId: by });

/** A report straight through the writer on a window chance: a bare tap unless overridden. */
const direct = (windowId: string, chance: number, overrides: Partial<Parameters<typeof writer.recordBehaviourObservation>[0]> = {}) =>
  writer.recordBehaviourObservation({
    organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, observerAccountId: COACH_A, authorRole: 'coach',
    session: { runId: RUN }, context: { drillId: DRILL }, windowChance: { windowId, chance }, taskConstraint: 'controlled',
    polarity: 'occurrence', attributionTarget: 'unresolved', attributionCertainty: 'uncertain', ...overrides,
  });

describe('taps (PATTERN-1d-2; Q2 A, Q3 A, Q8 A)', () => {
  let windowId: string;
  beforeAll(async () => {
    windowId = (await open()).window_id;
  });

  test('two coaches\' taps of one chance are one episode, fixed by window and chance, with the window\'s task and an unsaid cause', async () => {
    // A tap returns what was tapped and nothing else: not the chance's time, which may be another coach's.
    expect(await tap(windowId, 1, COACH_A, 'occurrence')).toEqual({ chance: 1, polarity: 'occurrence' });
    expect(await tap(windowId, 1, COACH_B, 'counterexample')).toEqual({ chance: 1, polarity: 'counterexample' });
    const [first, second] = await readingsOf(windowId, 1);
    expect([first.observer_account_id, second.observer_account_id]).toEqual([COACH_A, COACH_B]);
    expect(first.episode_id).toMatch(/^ep:[0-9a-f]{8}-[0-9a-f]{4}-5/);
    expect(first).toEqual(expect.objectContaining({
      session_key: `run:${RUN}`, task_constraint: 'controlled',
      attribution_target: 'unresolved', attribution_certainty: 'uncertain',
    }));
    expect(second.observed_at.toISOString()).toBe(first.observed_at.toISOString());
  });

  test('a coach\'s second tap of a chance revises their first and keeps its moment', async () => {
    const [before] = (await readingsOf(windowId, 1)).filter((row) => row.observer_account_id === COACH_A);
    await tap(windowId, 1, COACH_A, 'counterexample');
    const changed = (await readingsOf(windowId, 1)).slice(-1)[0];
    expect(changed).toEqual(expect.objectContaining({
      observer_account_id: COACH_A, supersedes_observation_id: before.observation_id, polarity: 'counterexample',
    }));
    expect(changed.observed_at.toISOString()).toBe(before.observed_at.toISOString());
  });

  test('each coach reads back only their own taps, as they stand; only staff of this gym read back', async () => {
    await tap(windowId, 2, COACH_B, 'occurrence');
    expect(await windows.listMyWindowTaps({ organizationId: ORG, windowId, observerAccountId: COACH_A }))
      .toEqual([{ chance: 1, polarity: 'counterexample' }]);
    expect(await windows.listMyWindowTaps({ organizationId: ORG, windowId, observerAccountId: COACH_B }))
      .toEqual([{ chance: 1, polarity: 'counterexample' }, { chance: 2, polarity: 'occurrence' }]);
    for (const outsider of [COACH_LAPSED, OTHER_GYM_COACH, BOARD_MEMBER]) {
      await expect(windows.listMyWindowTaps({ organizationId: ORG, windowId, observerAccountId: outsider }))
        .rejects.toThrow('Only staff of this gym can read back window taps.');
    }
  });

  test('a chance outside the window, or another gym\'s window, is refused', async () => {
    await expect(tap(windowId, 11, COACH_A, 'occurrence')).rejects.toThrow('A chance in this window is 1 to 10.');
    await expect(tap(windowId, 0, COACH_A, 'occurrence')).rejects.toThrow('A chance in this window is 1 to 10.');
    await expect(windows.recordWindowTap({
      organizationId: OTHER_ORG, windowId, chance: 1, polarity: 'occurrence', observerAccountId: OTHER_GYM_COACH, authorRole: 'coach',
    })).rejects.toThrow('That window is not in this gym.');
  });

  test('the writer holds a window chance to the window (athlete, behaviour, run, drill, task) and to a bare tap', async () => {
    const mismatch = 'That window is about another athlete, behaviour, session, drill or task.';
    await expect(direct(windowId, 4, { athleteId: LEAVING })).rejects.toThrow(mismatch);
    await expect(direct(windowId, 4, { behaviourKey: OTHER_KEY })).rejects.toThrow(mismatch);
    await expect(direct(windowId, 4, { session: { runId: OTHER_RUN } })).rejects.toThrow(mismatch);
    await expect(direct(windowId, 4, { session: { runId: PLANNED_RUN }, context: { blockId: 'blk-bsw-1' } })).rejects.toThrow(mismatch);
    await expect(direct(windowId, 4, { context: { attemptContext: 'open_floor' } })).rejects.toThrow(mismatch);
    await expect(direct(windowId, 4, { taskConstraint: 'live' })).rejects.toThrow(mismatch);
    const bare = 'A window tap is shown or not shown, with no cause, note, time, fatigue or view.';
    await expect(direct(windowId, 4, { attributionTarget: 'athlete', attributionCertainty: 'stated' })).rejects.toThrow(bare);
    await expect(direct(windowId, 4, { note: 'free text' })).rejects.toThrow(bare);
    await expect(direct(windowId, 4, { observedAt: new Date(Date.now() - 3_600_000).toISOString() })).rejects.toThrow(bare);
    await expect(direct(windowId, 4, { sameMomentAs: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toThrow('A window tap names its window chance and no other moment.');
    expect(await readingsOf(windowId, 4)).toEqual([]);
  });

  test('a full report cannot join a tap\'s chance as a report of the same moment', async () => {
    const [tapped] = await readingsOf(windowId, 2);
    await expect(writer.recordBehaviourObservation({
      organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, observerAccountId: COACH_A, authorRole: 'coach',
      session: { runId: RUN }, context: { drillId: DRILL }, sameMomentAs: tapped.observation_id, taskConstraint: 'live',
      polarity: 'counterexample', attributionTarget: 'athlete', attributionCertainty: 'stated',
    })).rejects.toThrow('That report is a tap in a sampled window; tap the window instead.');
    expect(await readingsOf(windowId, 2)).toHaveLength(1);
  });

  test('two first taps of one chance at once still take one moment', async () => {
    const holder = await holdEpisode(windowId, 5);
    const first = tap(windowId, 5, COACH_A, 'occurrence');
    const second = tap(windowId, 5, COACH_B, 'counterexample');
    // Both taps queued on the chance's lock before it is let go; let go whatever happens, so a failure cannot hang.
    let queued = false;
    try {
      queued = await waiters(2);
    } finally {
      await release(holder);
    }
    await Promise.all([first, second]);
    expect(queued).toBe(true);
    const readings = await readingsOf(windowId, 5);
    expect(readings).toHaveLength(2);
    expect(readings[1].observed_at.toISOString()).toBe(readings[0].observed_at.toISOString());
  });

  test('a close waits for a tap in flight, so the tap lands while the window is open', async () => {
    const other = (await open()).window_id;
    const holder = await holdEpisode(other, 1);
    let closedEarly = false;
    let tapQueued = false;
    let closedWhileTapping = true;
    let letGo = new Date(0);
    const tapping = tap(other, 1, COACH_A, 'occurrence');
    let closing: ReturnType<typeof close> = Promise.reject(new Error('the close never started'));
    closing.catch(() => undefined);
    try {
      // The tap holds the window and waits on the chance's lock; then the close queues behind the tap.
      tapQueued = await waiters(1);
      closing = close(other).then((row) => {
        closedEarly = true;
        return row;
      });
      await waiters(2);
      closedWhileTapping = closedEarly;
      letGo = (await db.query<{ at: Date }>('select clock_timestamp() as at')).rows[0].at;
    } finally {
      // Let go whatever happens, so a failure cannot hang the run.
      await release(holder);
    }
    const [, closed] = await Promise.all([tapping, closing]);
    expect(tapQueued).toBe(true);
    expect(closedWhileTapping).toBe(false);
    // The close is stamped when it takes the row, after the tap it waited for, not when it began.
    const [reading] = await readingsOf(other, 1);
    expect(new Date(closed.closed_at as string).getTime()).toBeGreaterThanOrEqual(letGo.getTime());
    expect(new Date(closed.closed_at as string).getTime()).toBeGreaterThanOrEqual(reading.created_at.getTime());
  });

  test('a closed window takes no tap; only staff of this gym close it, and only once', async () => {
    await expect(windows.closeBehaviourWindow({ organizationId: OTHER_ORG, windowId, closedByAccountId: OTHER_GYM_COACH }))
      .rejects.toThrow('That window is not in this gym.');
    for (const outsider of [COACH_LAPSED, BOARD_MEMBER]) {
      await expect(close(windowId, outsider)).rejects.toThrow('Only staff of this gym can close a window.');
    }
    expect((await close(windowId)).closed_at).not.toBeNull();
    await expect(tap(windowId, 3, COACH_A, 'occurrence')).rejects.toThrow('That window is closed.');
    await expect(close(windowId)).rejects.toThrow('That window is already closed.');
  });
});

describe('joining a window, and the reports route (PATTERN-1e; Overwatch 7084899452 points 1 and 2)', () => {
  const change = (windowId: string, polarity: 'occurrence' | 'counterexample', observer = COACH_A) => windows.changeLastWindowTap({
    organizationId: ORG, windowId, polarity, observerAccountId: observer, authorRole: 'coach',
  });

  test('the open windows of a run, for a second coach to join: that run\'s open ones only; staff of this gym only', async () => {
    const joinable = (await open()).window_id;
    const closedOne = (await open()).window_id;
    await close(closedOne);
    const elsewhere = (await open({ runId: PLANNED_RUN, context: { blockId: 'blk-bsw-1' } })).window_id;
    const listed = (await windows.listOpenBehaviourWindows({ organizationId: ORG, runId: RUN, readerAccountId: COACH_B }))
      .map((row) => row.window_id);
    expect(listed).toContain(joinable);
    expect(listed).not.toContain(closedOne);
    expect(listed).not.toContain(elsewhere);
    expect(await windows.listOpenBehaviourWindows({ organizationId: OTHER_ORG, runId: RUN, readerAccountId: OTHER_GYM_COACH }))
      .toEqual([]);
    for (const outsider of [COACH_LAPSED, OTHER_GYM_COACH, BOARD_MEMBER]) {
      await expect(windows.listOpenBehaviourWindows({ organizationId: ORG, runId: RUN, readerAccountId: outsider }))
        .rejects.toThrow('Only staff of this gym can read a window.');
    }
  });

  test('a joining coach gets the chance the count stands at -- the highest anyone has tapped, plus one -- and nothing of the taps', async () => {
    const windowId = (await open()).window_id;
    const current = (reader = COACH_B) => windows.currentWindowChance({ organizationId: ORG, windowId, readerAccountId: reader });
    expect(await current()).toBe(1);
    await tap(windowId, 1, COACH_A, 'occurrence');
    await tap(windowId, 3, COACH_A, 'counterexample');
    expect(await current()).toBe(4);
    // A later tap of a lower chance, or a revision, does not move it back.
    await tap(windowId, 2, COACH_B, 'occurrence');
    await tap(windowId, 3, COACH_A, 'occurrence');
    expect(await current(COACH_A)).toBe(4);
    // Point 2 as ruled: past the last chance it reads chances + 1; the screen (1f) shows the window full.
    await tap(windowId, 10, COACH_B, 'occurrence');
    expect(await current()).toBe(11);
    await expect(current(BOARD_MEMBER)).rejects.toThrow('Only staff of this gym can read a window.');
    await expect(windows.currentWindowChance({ organizationId: OTHER_ORG, windowId, readerAccountId: OTHER_GYM_COACH }))
      .rejects.toThrow('That window is not in this gym.');
  });

  test('change last tap revises the coach\'s most recent tap (Q8 A), not their highest chance nor another coach\'s', async () => {
    const windowId = (await open()).window_id;
    await expect(change(windowId, 'occurrence')).rejects.toThrow('You have no tap on this window to change.');
    await tap(windowId, 2, COACH_A, 'occurrence');
    await tap(windowId, 1, COACH_A, 'occurrence');
    await tap(windowId, 3, COACH_B, 'occurrence');
    expect(await change(windowId, 'counterexample')).toEqual({ chance: 1, polarity: 'counterexample' });
    expect(await windows.listMyWindowTaps({ organizationId: ORG, windowId, observerAccountId: COACH_A }))
      .toEqual([{ chance: 1, polarity: 'counterexample' }, { chance: 2, polarity: 'occurrence' }]);
    // Changed again, the same tap is still the last; it revises, never adds.
    expect(await change(windowId, 'occurrence')).toEqual({ chance: 1, polarity: 'occurrence' });
    expect(await readingsOf(windowId, 1)).toHaveLength(3);
    await close(windowId);
    await expect(change(windowId, 'counterexample')).rejects.toThrow('That window is closed.');
  });

  test('the reports route leaves out the taps of a window still open, every chance and coach, and shows them once it closes', async () => {
    const windowId = (await open()).window_id;
    await tap(windowId, 1, COACH_A, 'occurrence');
    await tap(windowId, 5, COACH_B, 'counterexample');
    await tap(windowId, 10, COACH_A, 'occurrence');
    await tap(windowId, 10, COACH_B, 'occurrence');
    const tappedAll = [1, 5, 10].map((chance) => writer.windowEpisodeId(ORG, windowId, chance));
    const tapped = tappedAll[0];
    const plain = await writer.recordBehaviourObservation({
      organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, observerAccountId: COACH_B, authorRole: 'coach',
      session: { runId: RUN }, context: { drillId: DRILL }, taskConstraint: 'live',
      polarity: 'occurrence', attributionTarget: 'athlete', attributionCertainty: 'probable',
    });
    const listed = async () => (await writer.listBehaviourObservations(ORG, ATHLETE, 500)).map((row) => row.episode_id);
    for (const episode of tappedAll) expect(await listed()).not.toContain(episode);
    expect(await listed()).toContain(plain.episode_id);
    await close(windowId);
    for (const episode of tappedAll) expect(await listed()).toContain(episode);
    expect(await listed()).toContain(tapped);
  });

  test('the reports route still answers where the window table is not yet applied', async () => {
    await db.query('alter table pilot.behaviour_observations_windows rename to behaviour_observations_windows_away');
    try {
      expect((await writer.listBehaviourObservations(ORG, ATHLETE, 500)).length).toBeGreaterThan(0);
    } finally {
      await db.query('alter table pilot.behaviour_observations_windows_away rename to behaviour_observations_windows');
    }
  });
});

describe('a settling run closes its windows; the tier engine reads no open window (PATTERN-1e-2; Overwatch 7085598624 points 1 and 2)', () => {
  const LIVE_RUN = 'run-bsw-live';
  const IDLE_RUN = 'run-bsw-idle';
  const closedAtOf = async (windowId: string) => (await db.query<{ closed_at: Date | null }>(
    'select closed_at from pilot.behaviour_observations_windows where organization_id = $1 and window_id = $2', [ORG, windowId],
  )).rows[0].closed_at;
  const liveRun = async (runId: string, coach: string) => {
    await db.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on, run_state, started_at)
       values ($1, $2, null, null, $3, current_date, 'in_progress', now() - interval '1 minute')`,
      [ORG, runId, coach],
    );
    await db.query(
      `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
       values ($1, $2, $3, $4, 'coach')`,
      [ORG, runId, ATHLETE, coach],
    );
  };

  let otherGymWindow: string;

  beforeAll(async () => {
    await liveRun(LIVE_RUN, COACH_A);
    await liveRun(IDLE_RUN, COACH_B);
    // Another gym with a run of the same id, and an open window on it: a settle here must not touch it.
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, 'ath-bsw-elsewhere', 'Fixture Athlete', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $2, now(), now(), null)`,
      [OTHER_ORG, OTHER_GYM_COACH],
    );
    await db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, $2, 'Fixture behaviour', 'SK-JAB-01', $3)`,
      [OTHER_ORG, KEY, OTHER_GYM_COACH],
    );
    await db.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on, run_state, started_at)
       values ($1, $2, null, null, $3, current_date, 'in_progress', now() - interval '1 minute')`,
      [OTHER_ORG, LIVE_RUN, OTHER_GYM_COACH],
    );
    await db.query(
      `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
       values ($1, $2, 'ath-bsw-elsewhere', $3, 'coach')`,
      [OTHER_ORG, LIVE_RUN, OTHER_GYM_COACH],
    );
    otherGymWindow = (await db.query<{ window_id: string }>(
      `insert into pilot.behaviour_observations_windows
         (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
          opened_by_account_id, opened_by_role)
       values ($1, 'ath-bsw-elsewhere', $2, $3, 'context', 'session', 'controlled', $4, 'coach')
       returning window_id`,
      [OTHER_ORG, KEY, LIVE_RUN, OTHER_GYM_COACH],
    )).rows[0].window_id;
  });

  const otherGymWindowOpen = async () => (await db.query<{ closed_at: Date | null }>(
    'select closed_at from pilot.behaviour_observations_windows where organization_id = $1 and window_id = $2',
    [OTHER_ORG, otherGymWindow],
  )).rows[0].closed_at === null;

  test('a coach finishing the run closes its open windows, and only its own; a tap is then refused and the taps show', async () => {
    const windowId = (await open({ runId: LIVE_RUN })).window_id;
    const closedFirst = (await open({ runId: LIVE_RUN })).window_id;
    const elsewhere = (await open()).window_id;
    await tap(windowId, 1, COACH_A, 'occurrence');
    await close(closedFirst);
    const firstClose = await closedAtOf(closedFirst);
    await runs.finishSessionScriptRun(ORG, COACH_A, LIVE_RUN, { runState: 'completed' });
    expect(await closedAtOf(windowId)).not.toBeNull();
    expect((await closedAtOf(closedFirst))?.toISOString()).toBe(firstClose?.toISOString());
    expect(await closedAtOf(elsewhere)).toBeNull();
    expect(await otherGymWindowOpen()).toBe(true);
    await expect(tap(windowId, 2, COACH_A, 'occurrence')).rejects.toThrow('That window is closed.');
    expect((await writer.listBehaviourObservations(ORG, ATHLETE, 500)).map((row) => row.episode_id))
      .toContain(writer.windowEpisodeId(ORG, windowId, 1));
    await close(elsewhere);
  });

  test('the idle sweep settling a forgotten run closes its open windows too', async () => {
    const windowId = (await open({ runId: IDLE_RUN })).window_id;
    await tap(windowId, 1, COACH_B, 'occurrence');
    expect(await runs.closeIdleSessionRuns(ORG, { now: new Date(Date.now() + 4 * 3_600_000) })).toContain(IDLE_RUN);
    expect(await closedAtOf(windowId)).not.toBeNull();
    expect(await otherGymWindowOpen()).toBe(true);
  });

  test('the tier engine reads no tap of a window still open, and every tap once it closes', async () => {
    const windowId = (await open({ chances: 50 })).window_id;
    await tap(windowId, 2, COACH_A, 'occurrence');
    await tap(windowId, 7, COACH_B, 'counterexample');
    await tap(windowId, 50, COACH_A, 'occurrence');
    const tapped = [2, 7, 50].map((chance) => writer.windowEpisodeId(ORG, windowId, chance));
    const read = async () => (await writer.listBehaviourReadingsForEvaluation(ORG, KEY)).map((row) => row.episode_id);
    const before = await read();
    expect(before.length).toBeGreaterThan(0);
    for (const episode of tapped) expect(before).not.toContain(episode);
    await close(windowId);
    const after = await read();
    for (const episode of tapped) expect(after).toContain(episode);
  });

  test('settling a run and the tier engine still work where the window table is not yet applied', async () => {
    await liveRun('run-bsw-away', COACH_A);
    await liveRun('run-bsw-away-idle', COACH_B);
    await db.query('alter table pilot.behaviour_observations_windows rename to behaviour_observations_windows_away');
    try {
      expect((await runs.finishSessionScriptRun(ORG, COACH_A, 'run-bsw-away', { runState: 'abandoned' })).run_state).toBe('abandoned');
      expect(await runs.closeIdleSessionRuns(ORG, { now: new Date(Date.now() + 4 * 3_600_000) })).toEqual(['run-bsw-away-idle']);
      expect((await writer.listBehaviourReadingsForEvaluation(ORG, KEY)).length).toBeGreaterThan(0);
    } finally {
      await db.query('alter table pilot.behaviour_observations_windows_away rename to behaviour_observations_windows');
    }
  });

  test('the run settles and its windows close together, or neither happens', async () => {
    await liveRun('run-bsw-atomic', COACH_A);
    const windowId = (await open({ runId: 'run-bsw-atomic' })).window_id;
    const runState = async () => (await db.query<{ run_state: string }>(
      'select run_state from pilot.session_script_runs where organization_id = $1 and run_id = $2', [ORG, 'run-bsw-atomic'],
    )).rows[0].run_state;
    // A window close that fails: the settle around it must roll back with it.
    await db.query(`create function pilot.test_refuse_window_close() returns trigger language plpgsql as $f$
      begin raise exception 'TEST_REFUSES_WINDOW_CLOSE'; end $f$`);
    await db.query(`create trigger test_refuse_window_close before update on pilot.behaviour_observations_windows
      for each row execute function pilot.test_refuse_window_close()`);
    try {
      await expect(runs.finishSessionScriptRun(ORG, COACH_A, 'run-bsw-atomic', { runState: 'completed' }))
        .rejects.toThrow('TEST_REFUSES_WINDOW_CLOSE');
      expect(await runState()).toBe('in_progress');
      await expect(runs.closeIdleSessionRuns(ORG, { now: new Date(Date.now() + 4 * 3_600_000) }))
        .rejects.toThrow('TEST_REFUSES_WINDOW_CLOSE');
      expect(await runState()).toBe('in_progress');
      expect(await closedAtOf(windowId)).toBeNull();
    } finally {
      await db.query('drop trigger test_refuse_window_close on pilot.behaviour_observations_windows');
      await db.query('drop function pilot.test_refuse_window_close()');
    }
    await runs.finishSessionScriptRun(ORG, COACH_A, 'run-bsw-atomic', { runState: 'completed' });
    expect(await runState()).toBe('completed');
    expect(await closedAtOf(windowId)).not.toBeNull();
  });
});

describe('when the athlete goes', () => {
  test('a window still naming an athlete goes with the athlete row', async () => {
    const { window_id: windowId } = await insertWindow({ athlete: LEAVING });
    await db.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, LEAVING]);
    const left = await db.query(
      'select 1 from pilot.behaviour_observations_windows where organization_id = $1 and window_id = $2', [ORG, windowId],
    );
    expect(left.rows).toHaveLength(0);
  });

  test('the purge keeps the athlete\'s windows under the same token as their reports', async () => {
    await db.query(
      `insert into pilot.behaviour_observations
         (organization_id, athlete_id, behaviour_key, episode_id, session_key, task_context_key, task_constraint,
          polarity, attribution_target, attribution_certainty, source_type, source_quality, interpretation,
          observer_account_id, author_role, observed_at)
       values ($1, $2, $3, 'ep:00000000-0000-4000-8000-0000000000a1', $4, 'drill:lineage-bsw-1', 'controlled',
               'occurrence', 'unresolved', 'uncertain', 'coach_tag', 'moderate', 'human_observed', $5, 'coach', now())`,
      [ORG, ATHLETE, KEY, `run:${RUN}`, COACH_A],
    );
    await db.query(
      `update pilot.athletes set active_flag = false, deleted_at = now() - interval '3 years'
        where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE],
    );
    const before = await db.query<{ n: number; ids: string[] }>(
      `select count(*)::int as n, array_agg(window_id::text) as ids from pilot.behaviour_observations_windows
        where organization_id = $1 and athlete_id = $2`, [ORG, ATHLETE],
    );
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.would_deidentify_behaviour_observations_windows).toBe(before.rows[0].n);
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.behaviour_observations_windows_deidentified).toBe(before.rows[0].n);
    const tokens = await db.query<{ athlete_id: string; stamped: boolean }>(
      `select distinct athlete_id, deidentified_at is not null as stamped from pilot.behaviour_observations_windows
        where organization_id = $1 and window_id::text = any($2::text[])
       union
       select distinct athlete_id, deidentified_at is not null as stamped from pilot.behaviour_observations
        where organization_id = $1 and behaviour_key = $3`,
      [ORG, before.rows[0].ids, KEY],
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].athlete_id).toMatch(/^anon_[0-9a-f-]{36}$/);
    expect(tokens.rows[0].stamped).toBe(true);
    // Once only.
    expect(await refusalOf(
      `update pilot.behaviour_observations_windows
          set athlete_id = 'anon_00000000-0000-4000-8000-000000000002', deidentified_at = now()
        where organization_id = $1 and athlete_id = $2`,
      [ORG, tokens.rows[0].athlete_id],
    )).toEqual({ code: '23514', constraint: 'pilot_behaviour_windows_append_only' });
  });
});
