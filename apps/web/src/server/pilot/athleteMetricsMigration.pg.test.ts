// Real PostgreSQL contract test for pilot_slice_postgres_athlete_metrics_migration.sql (lane L60,
// OD-2026-10-17-026: the enjoyment tap after training and the coach-entered standing height).
//
// What needs a real database to prove: that enjoyment holds only 1-5 or "not answered" and lands
// on rows that already exist without touching them; that a height reading is written only by
// staff who hold that role in the athlete's gym, within the typing-slip bounds; that a reading is
// never changed or deleted by hand, but goes with its athlete; that a correction can only replace
// a reading of the same athlete, once; that one save key is one row; that re-applying the file is
// a no-op; that the file holds nothing destructive; and that the runner's readiness assertion
// refuses a result it did not produce. Spins up the disposable local embedded Postgres the other
// migration suites use. It never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-metrics-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-metrics-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_metrics_migration.sql';
const TEMPLATE_DB = 'athmetrics_template';

const ORG = 'org-athmetrics';
const OTHER_ORG = 'org-athmetrics-other';
const COACH = 'acct-athmetrics-coach';
const OFFICE = 'acct-athmetrics-office';
const PLATFORM_ADMIN = 'acct-athmetrics-admin';
const LAPSED_COACH = 'acct-athmetrics-lapsed';
const DELETED_COACH = 'acct-athmetrics-deleted';
const OTHER_GYM_COACH = 'acct-athmetrics-other-coach';
const GUARDIAN = 'acct-athmetrics-guardian';
const ATHLETE_LOGIN = 'acct-athmetrics-athlete';
const BOARD = 'acct-athmetrics-board';
const ATHLETE = 'ATH-ATHMETRICS-1';
const SECOND_ATHLETE = 'ATH-ATHMETRICS-2';
const SESSION = 'session-athmetrics-1';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** A clone of the template (full schema in the `all` order, which includes this migration, plus
 *  the gyms, people and one session below), or an empty database. */
async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(schema === 'full' ? `create database ${name} template ${TEMPLATE_DB}` : `create database ${name}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function seed(client: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  const accounts: Array<[string, string, string]> = [
    [COACH, 'coach', ORG],
    [OFFICE, 'organization_admin', ORG],
    [PLATFORM_ADMIN, 'admin', ORG],
    [LAPSED_COACH, 'coach', ORG],
    [DELETED_COACH, 'coach', ORG],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG],
    [GUARDIAN, 'parent', ORG],
    [ATHLETE_LOGIN, 'athlete', ORG],
    [BOARD, 'board', ORG],
  ];
  for (const [account, role, org] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [account, role, org],
    );
  }
  await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [DELETED_COACH]);
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts).
  const seats: Array<[string, string, string, boolean]> = [
    [COACH, ORG, 'coach', true],
    [OFFICE, ORG, 'organization_admin', true],
    [PLATFORM_ADMIN, ORG, 'admin', true],
    [LAPSED_COACH, ORG, 'coach', false],
    [DELETED_COACH, ORG, 'coach', true],
    [OTHER_GYM_COACH, OTHER_ORG, 'coach', true],
    [GUARDIAN, ORG, 'parent', true],
    [ATHLETE_LOGIN, ORG, 'athlete', true],
    [BOARD, ORG, 'board', true],
  ];
  for (const [account, org, role, active] of seats) {
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
      [account, org, role, active],
    );
  }
  for (const [org, athlete] of [
    [ORG, ATHLETE],
    [ORG, SECOND_ATHLETE],
    [OTHER_ORG, ATHLETE],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Metrics Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, COACH],
    );
  }
  // A completed session that predates the column: its RPE and minutes must come through untouched.
  await client.query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes,
       completed_flag, created_at, updated_at, duration_minutes)
     values ($1, $2, $3, '2026-10-16', 7, 'athlete_post_session_self_report', 'Good one.', true, now(), now(), 60)`,
    [ORG, SESSION, ATHLETE],
  );
}

interface HeightValues {
  org?: string;
  heightId?: string;
  athlete?: string;
  measuredOn?: string;
  cm?: number | string;
  recorder?: string;
  role?: string;
  requestKey?: string;
  supersedes?: string | null;
}

async function height(client: Client, values: HeightValues = {}): Promise<string> {
  const heightId = values.heightId ?? randomUUID();
  await client.query(
    `insert into pilot.athlete_heights (organization_id, height_id, athlete_id, measured_on, height_cm,
       recorded_by_account_id, recorded_by_role, request_key, supersedes_height_id)
     values ($1, $2::uuid, $3, $4::date, $5, $6, $7, $8, $9::uuid)`,
    [
      values.org ?? ORG,
      heightId,
      values.athlete ?? ATHLETE,
      values.measuredOn ?? '2026-10-16',
      values.cm ?? 151.4,
      values.recorder ?? COACH,
      values.role ?? 'coach',
      values.requestKey ?? `save-${heightId}`,
      values.supersedes ?? null,
    ],
  );
  return heightId;
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
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  // The full schema once, then every test clones it.
  await adminQuery(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await seed(template);
  } finally {
    await template.end();
  }
});

afterAll(async () => {
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('athlete metrics migration: enjoyment (OD-2026-10-17-026 (a))', () => {
  test('lands on an existing session as "not answered" and leaves its RPE, minutes and note alone; re-applying is a no-op', async () => {
    const client = await freshDatabase('athm_enjoy_existing');
    try {
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);
      const rows = await client.query(
        `select enjoyment, rpe::text as rpe, rpe_method, duration_minutes, notes from pilot.sessions
          where organization_id = $1 and session_id = $2`,
        [ORG, SESSION],
      );
      expect(rows.rows).toEqual([
        { enjoyment: null, rpe: '7', rpe_method: 'athlete_post_session_self_report', duration_minutes: 60, notes: 'Good one.' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('holds 1 to 5 or not answered, and nothing else', async () => {
    const client = await freshDatabase('athm_enjoy_range');
    try {
      const set = (value: number | null) =>
        client.query('update pilot.sessions set enjoyment = $3 where organization_id = $1 and session_id = $2', [
          ORG,
          SESSION,
          value,
        ]);
      for (const value of [1, 2, 3, 4, 5, null]) {
        await set(value);
      }
      for (const value of [0, 6, -1, 10]) {
        await expect(set(value)).rejects.toMatchObject({ code: '23514', constraint: 'pilot_sessions_enjoyment_range' });
      }
    } finally {
      await client.end();
    }
  });

  test('a new session row gets no enjoyment by default', async () => {
    const client = await freshDatabase('athm_enjoy_default');
    try {
      await client.query(
        `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes,
           completed_flag, created_at, updated_at)
         values ($1, 'session-athmetrics-new', $2, '2026-10-17', null, 'UNKNOWN', '', false, now(), now())`,
        [ORG, ATHLETE],
      );
      const row = await client.query(`select enjoyment from pilot.sessions where session_id = 'session-athmetrics-new'`);
      expect(row.rows[0].enjoyment).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('athlete metrics migration: standing height (OD-2026-10-17-026 (b))', () => {
  test('a coach, the office and an admin of the gym each record a reading, stored as typed to one decimal', async () => {
    const client = await freshDatabase('athm_height_staff');
    try {
      await height(client, { cm: 151.4 });
      await height(client, { recorder: OFFICE, role: 'organization_admin', cm: '152.0', measuredOn: '2026-10-17' });
      await height(client, { recorder: PLATFORM_ADMIN, role: 'admin', cm: 150.05, measuredOn: '2026-10-15' });
      const rows = await client.query(
        `select recorded_by_role, height_cm::text as cm, measured_on::text as measured_on
           from pilot.athlete_heights order by measured_on`,
      );
      expect(rows.rows).toEqual([
        { recorded_by_role: 'admin', cm: '150.1', measured_on: '2026-10-15' },
        { recorded_by_role: 'coach', cm: '151.4', measured_on: '2026-10-16' },
        { recorded_by_role: 'organization_admin', cm: '152.0', measured_on: '2026-10-17' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('nobody but staff holding that role in this gym can be the recorder', async () => {
    const client = await freshDatabase('athm_height_who');
    try {
      // Not staff roles at all: refused by the role check, by name.
      for (const [recorder, role] of [
        [ATHLETE_LOGIN, 'athlete'],
        [GUARDIAN, 'parent'],
        [BOARD, 'board'],
        [COACH, 'platform_owner'],
      ] as const) {
        await expect(height(client, { recorder, role })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_athlete_heights_role_check',
        });
      }
      // A staff role the account does not hold here.
      for (const [recorder, role] of [
        [GUARDIAN, 'coach'],
        [ATHLETE_LOGIN, 'coach'],
        [COACH, 'organization_admin'],
        [OTHER_GYM_COACH, 'coach'],
        [LAPSED_COACH, 'coach'],
        [DELETED_COACH, 'coach'],
        ['acct-athmetrics-nobody', 'coach'],
      ] as const) {
        await expect(height(client, { recorder, role })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_athlete_heights_recorder_of_this_gym',
        });
      }
      const left = await client.query('select count(*)::int as n from pilot.athlete_heights');
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('refuses typing slips, an empty save key and a pre-2000 date, each by name', async () => {
    const client = await freshDatabase('athm_height_bounds');
    try {
      await height(client, { cm: 50 });
      await height(client, { cm: 250 });
      for (const cm of [49.9, 250.1, 0, -150]) {
        await expect(height(client, { cm })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_athlete_heights_cm_range',
        });
      }
      // Millimetres typed into the cm box do not even fit the column (numeric(4,1)).
      await expect(height(client, { cm: 1514 })).rejects.toMatchObject({ code: '22003' });
      await expect(height(client, { requestKey: '   ' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_request_key_check',
      });
      await expect(height(client, { requestKey: 'x'.repeat(201) })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_request_key_check',
      });
      await expect(height(client, { measuredOn: '1999-12-31' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_measured_on_check',
      });
    } finally {
      await client.end();
    }
  });

  test('binds only to a real athlete of this gym', async () => {
    const client = await freshDatabase('athm_height_binds');
    try {
      await expect(height(client, { athlete: 'ATH-NOBODY' })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_athlete_heights_athlete_fk',
      });
      // The other gym's athlete row exists under the same id, but this gym's coach cannot write there.
      await expect(height(client, { org: OTHER_ORG })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_recorder_of_this_gym',
      });
    } finally {
      await client.end();
    }
  });

  test('one save key is one row: a retry lands on the first attempt', async () => {
    const client = await freshDatabase('athm_height_retry');
    try {
      const first = await height(client, { requestKey: 'test-day-1:ATH-ATHMETRICS-1:height' });
      await expect(height(client, { requestKey: 'test-day-1:ATH-ATHMETRICS-1:height', cm: 152 })).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_athlete_heights_request_key_unique',
      });
      await client.query(
        `insert into pilot.athlete_heights (organization_id, height_id, athlete_id, measured_on, height_cm,
           recorded_by_account_id, recorded_by_role, request_key)
         values ($1, $2::uuid, $3, '2026-10-16', 152, $4, 'coach', 'test-day-1:ATH-ATHMETRICS-1:height')
         on conflict (organization_id, request_key) do nothing`,
        [ORG, randomUUID(), ATHLETE, COACH],
      );
      const rows = await client.query('select height_id, height_cm::text as cm from pilot.athlete_heights');
      expect(rows.rows).toEqual([{ height_id: first, cm: '151.4' }]);
    } finally {
      await client.end();
    }
  });

  test('a reading is never changed: a correction is a new row naming it, and the original stays', async () => {
    const client = await freshDatabase('athm_height_correct');
    try {
      const original = await height(client, { cm: 115.4 });
      for (const change of ['height_cm = 151.4', "measured_on = '2026-10-01'", `recorded_by_account_id = '${OFFICE}'`]) {
        await expect(client.query(`update pilot.athlete_heights set ${change}`)).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_athlete_heights_append_only',
        });
      }
      const correction = await height(client, { cm: 151.4, supersedes: original });
      const rows = await client.query(
        `select height_id, height_cm::text as cm, supersedes_height_id from pilot.athlete_heights order by recorded_at`,
      );
      expect(rows.rows).toEqual([
        { height_id: original, cm: '115.4', supersedes_height_id: null },
        { height_id: correction, cm: '151.4', supersedes_height_id: original },
      ]);
      // In force: the reading nothing supersedes.
      const current = await client.query(
        `select h.height_id from pilot.athlete_heights h
          where not exists (select 1 from pilot.athlete_heights s
                             where s.organization_id = h.organization_id and s.supersedes_height_id = h.height_id)`,
      );
      expect(current.rows).toEqual([{ height_id: correction }]);
    } finally {
      await client.end();
    }
  });

  test('a correction replaces a reading of the same athlete only, and only once', async () => {
    const client = await freshDatabase('athm_height_correct_bounds');
    try {
      const original = await height(client);
      // Another athlete's reading named as the one replaced.
      await expect(height(client, { athlete: SECOND_ATHLETE, supersedes: original })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_athlete_heights_supersedes_fk',
      });
      await expect(height(client, { supersedes: randomUUID() })).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_athlete_heights_supersedes_fk',
      });
      const selfId = randomUUID();
      await expect(height(client, { heightId: selfId, supersedes: selfId })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_not_self_check',
      });
      const correction = await height(client, { supersedes: original });
      await expect(height(client, { supersedes: original })).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_athlete_heights_one_correction',
      });
      // A correction of the correction is a chain, not a fork.
      await height(client, { supersedes: correction });
      const n = await client.query('select count(*)::int as n from pilot.athlete_heights');
      expect(n.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a reading is not deleted by hand, but goes with its athlete, corrections included', async () => {
    const client = await freshDatabase('athm_height_cascade');
    try {
      const original = await height(client);
      await height(client, { supersedes: original });
      await height(client, { athlete: SECOND_ATHLETE, recorder: OFFICE, role: 'organization_admin' });
      await expect(client.query('delete from pilot.athlete_heights')).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_athlete_heights_no_delete',
      });

      // The recording coach's account removed: the readings are about the athlete and stay.
      await client.query('delete from pilot.organization_memberships where account_id = $1', [OFFICE]);
      await client.query('delete from pilot.accounts where account_id = $1', [OFFICE]);
      const afterAccount = await client.query('select count(*)::int as n from pilot.athlete_heights');
      expect(afterAccount.rows[0].n).toBe(3);

      // The athlete removed (the retention purge deletes pilot.athletes): their readings go,
      // the correction with the original; the other athlete's stays.
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const afterAthlete = await client.query('select athlete_id from pilot.athlete_heights');
      expect(afterAthlete.rows).toEqual([{ athlete_id: SECOND_ATHLETE }]);
    } finally {
      await client.end();
    }
  });
});

describe('athlete metrics migration: the file and the runner', () => {
  test('the file holds nothing destructive, and alters only pilot.sessions', async () => {
    // Comments and string literals (the column comments, error names) are prose, not statements.
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function|constraint)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\binsert\s+into\b/);
    expect(sql).not.toMatch(/\bnot\s+valid\b/);
    expect(sql).not.toMatch(/\bdefault\s+(?!clock_timestamp\(\))/);
    const altered = [...sql.matchAll(/alter\s+table\s+([a-z_.]+)/g)].map((match) => match[1]);
    expect(new Set(altered)).toEqual(new Set(['pilot.sessions']));
    expect(sql).not.toMatch(/\bbegin\s*;|\bcommit\s*;/);
  });

  test('the runner refuses an enjoyment column with a default, or a widened range of the same name', async () => {
    const client = await freshDatabase('athm_runner_enjoy');
    try {
      await client.query('alter table pilot.sessions alter column enjoyment set default 3');
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: enjoyment_column_ready');
      await client.query('alter table pilot.sessions alter column enjoyment drop default');

      await client.query('alter table pilot.sessions drop constraint pilot_sessions_enjoyment_range');
      await client.query(
        'alter table pilot.sessions add constraint pilot_sessions_enjoyment_range check (enjoyment is null or enjoyment between 0 and 10)',
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: enjoyment_range_ready');

      await client.query('alter table pilot.sessions drop constraint pilot_sessions_enjoyment_range');
      await client.query(
        'alter table pilot.sessions add constraint pilot_sessions_enjoyment_range check (enjoyment is null or enjoyment between 1 and 5) not valid',
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: enjoyment_range_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing heights table whose role check of that name admits an athlete', async () => {
    const client = await freshDatabase('athm_runner_role');
    try {
      await client.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_role_check');
      await client.query(`
        alter table pilot.athlete_heights add constraint pilot_athlete_heights_role_check
          check (recorded_by_role in ('coach', 'organization_admin', 'admin') or recorded_by_role = 'athlete')`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: role_check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses widened height bounds, a nullable height, or a default reading', async () => {
    const client = await freshDatabase('athm_runner_cm');
    try {
      await client.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_cm_range');
      await client.query(
        'alter table pilot.athlete_heights add constraint pilot_athlete_heights_cm_range check (height_cm between 0 and 999)',
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: cm_range_ready');
    } finally {
      await client.end();
    }
    const nullable = await freshDatabase('athm_runner_cm_null');
    try {
      await nullable.query('alter table pilot.athlete_heights alter column height_cm drop not null');
      await expect(applyRunner(nullable, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: heights_columns_ready');
      await nullable.query('alter table pilot.athlete_heights alter column height_cm set not null');
      await nullable.query('alter table pilot.athlete_heights alter column height_cm set default 150');
      await expect(applyRunner(nullable, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: heights_columns_ready');
    } finally {
      await nullable.end();
    }
  });

  test('the runner refuses a correction key that does not pin the athlete, and an athlete key without the cascade', async () => {
    const client = await freshDatabase('athm_runner_fks');
    try {
      await client.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_supersedes_fk');
      await client.query(`
        alter table pilot.athlete_heights add constraint pilot_athlete_heights_supersedes_fk
          foreign key (organization_id, supersedes_height_id)
          references pilot.athlete_heights(organization_id, height_id) on delete cascade`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: supersedes_fk_ready');
    } finally {
      await client.end();
    }
    const restrict = await freshDatabase('athm_runner_athlete_fk');
    try {
      await restrict.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_athlete_fk');
      await restrict.query(`
        alter table pilot.athlete_heights add constraint pilot_athlete_heights_athlete_fk
          foreign key (organization_id, athlete_id)
          references pilot.athletes(organization_id, athlete_id) on delete restrict`);
      await expect(applyRunner(restrict, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: athlete_fk_ready');
    } finally {
      await restrict.end();
    }
  });

  test('the runner refuses a save-key or correction uniqueness that is missing or widened', async () => {
    const client = await freshDatabase('athm_runner_unique');
    try {
      await client.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_request_key_unique');
      await client.query(`
        alter table pilot.athlete_heights add constraint pilot_athlete_heights_request_key_unique
          unique (organization_id, athlete_id, request_key)`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: request_key_unique_ready');
    } finally {
      await client.end();
    }
    const correction = await freshDatabase('athm_runner_one_correction');
    try {
      await correction.query('alter table pilot.athlete_heights drop constraint pilot_athlete_heights_one_correction');
      // The file's if-not-exists on the table keeps this state, so only readiness can say so.
      await expect(applyRunner(correction, migrationSql)).rejects.toThrow('ATHLETE_METRICS_NOT_READY: one_correction_ready');
    } finally {
      await correction.end();
    }
  });

  test('the runner refuses a guard that is there by name but disabled, or replica-only', async () => {
    const client = await freshDatabase('athm_runner_guard');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.athlete_heights disable trigger trg_athlete_heights_guard'),
      ).rejects.toThrow('ATHLETE_METRICS_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.athlete_heights enable replica trigger trg_athlete_heights_guard'),
      ).rejects.toThrow('ATHLETE_METRICS_NOT_READY: guard_ready');
      // Rolled back: the guard is still enabled after both refusals.
      const enabled = await client.query(
        `select tgenabled from pg_trigger where tgrelid = to_regclass('pilot.athlete_heights') and tgname = 'trg_athlete_heights_guard'`,
      );
      expect(enabled.rows).toEqual([{ tgenabled: 'O' }]);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce, and commits nothing', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('athm_runner_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'create table refused_marker (id int)')).rejects.toThrow('ATHLETE_METRICS_NOT_READY');
      const marker = await client.query(`select to_regclass('public.refused_marker') is null as absent`);
      expect(marker.rows[0].absent).toBe(true);
    } finally {
      await client.end();
    }
  });
});
