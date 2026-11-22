// Real PostgreSQL proof of PATTERN-1d's storage (PunxsyProminence/ppbf-platform#2082;
// Q2 A): the window table and its migration. The migration applies over itself
// and its apply script finds every part ready; the table's guard holds what the
// server will rely on (no direct delete; close once; the opener's set-null and
// the purge's de-identify of a deleted athlete, and nothing else; inserts need
// a live athlete, an active opener of this gym in its role and an active
// behaviour name); a window still naming an athlete goes with the athlete row;
// the purge gives a window the same token as the child's reports. Taps and the
// window functions arrive with the writer change in PATTERN-1d-2.
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
const RUN = 'run-bsw-1';
const DRILL = 'drill-bsw-1';
// A fixture key written straight to the table; keys the app makes are minted (bk_<hex>).
const KEY = 'bk_fixture_bsw_guard';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

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
  for (const athleteId of [ATHLETE, OTHER_ATHLETE, LEAVING]) {
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
     values ($1, $2, null, null, $3, current_date, 'completed', now() - interval '1 hour', now())`,
    [ORG, RUN, COACH_A],
  );
  await db.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $5, 'coach'), ($1, $2, $4, $5, 'coach')`,
    [ORG, RUN, ATHLETE, LEAVING, COACH_A],
  );
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
     values ($1, $2, 'Fixture behaviour', 'SK-JAB-01', $3)`,
    [ORG, KEY, COACH_A],
  );

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

  test('a window under a run that is not this gym\'s is refused', async () => {
    expect(await refusalOf(
      `insert into pilot.behaviour_observations_windows
         (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
          opened_by_account_id, opened_by_role)
       values ($1, $2, $3, 'run-nowhere', 'drill', $4, 'controlled', $5, 'coach')`,
      [ORG, ATHLETE, KEY, DRILL, COACH_A],
    )).toEqual({ code: '23503', constraint: 'pilot_behaviour_windows_run_fk' });
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
  ])('refuses a window from %s', async (_label, given, constraint) => {
    const input = { opener: COACH_A, athlete: ATHLETE, ...given };
    expect(await refusalOf(
      `insert into pilot.behaviour_observations_windows
         (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint,
          opened_by_account_id, opened_by_role)
       values ($1, $2, $3, $4, 'drill', $5, 'controlled', $6, 'coach')`,
      [ORG, input.athlete, KEY, RUN, DRILL, input.opener],
    )).toEqual({ code: '23514', constraint });
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
    const before = await db.query<{ n: number }>(
      'select count(*)::int as n from pilot.behaviour_observations_windows where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE],
    );
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.behaviour_observations_windows_deidentified).toBe(before.rows[0].n);
    const tokens = await db.query<{ athlete_id: string; stamped: boolean }>(
      `select distinct athlete_id, deidentified_at is not null as stamped from pilot.behaviour_observations_windows
        where organization_id = $1 and athlete_id <> $2
       union
       select distinct athlete_id, deidentified_at is not null as stamped from pilot.behaviour_observations
        where organization_id = $1 and behaviour_key = $3`,
      [ORG, ATHLETE, KEY],
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].athlete_id).toMatch(/^anon_[0-9a-f-]{36}$/);
    expect(tokens.rows[0].stamped).toBe(true);
  });
});
