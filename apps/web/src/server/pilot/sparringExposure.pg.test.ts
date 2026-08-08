// Real PostgreSQL-backed contract test for the sparring exposure / session
// load migration (pilot.sparring_exposure, pilot.session_load) and for
// sparringExposure.ts's functions running against a real transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_sparring_exposure_stop actually holds: stopped_early=true with a
//    null stop_reason is rejected, not silently accepted.
// 2. pilot_sparring_exposure_segment_uq is real and named: a duplicate
//    (activity, athlete, segment_number) is rejected and translated to
//    SPARRING_EXPOSURE_SEGMENT_DUPLICATE, not a raw Postgres error.
// 3. pilot_session_load_rated_by_uq allows the SAME activity/athlete to be
//    rated independently by 'athlete' and by 'coach_proxy' -- the
//    uniqueness is per rater, not per session.
// 4. getSparringExposureCounts returns raw counts and a raw seconds sum
//    only -- no computed score, matching the migration's own refusal.
// 5. The readiness check actually fails when the migration did not land.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import {
  getSparringExposureCounts,
  recordSessionLoad,
  recordSparringExposure,
} from './sparringExposure';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-exposure-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const ACTIVITY_LOG_MIGRATION_FILE = 'pilot_slice_postgres_activity_log_migration.sql';
const MIGRATION_FILE = 'pilot_slice_postgres_sparring_exposure_and_load_migration.sql';
const ACTIVITY_LOG_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-activity-log-migration.mjs',
);
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-sparring-exposure-migration.mjs',
);

const ORG_A = 'org-sparringexp-a';
const ATHLETE_A = 'athlete-sparringexp-a';
const COACH_A = 'acct-sparringexp-coach-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let activityLogMigrationSql: string;
let migrationSql: string;
let baseSchemaSql: string;
let applyActivityLogMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await applyActivityLogMigrationTransaction(client, activityLogMigrationSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'athlete', $2, 'microsoft') on conflict do nothing`,
    [ATHLETE_A, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1,$2,'Athlete A','2010-01-01','120lb','active','Contact',true,$3,now(),now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, COACH_A],
  );

  activeClient = client;
  return client;
}

async function insertActivity(client: Client, activityId: string): Promise<void> {
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
        occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
     values ($1,$2,$3,$4,'boxing_training','sparring_session','2026-08-01',60,'door_terminal','coach',$5)`,
    [ORG_A, activityId, ATHLETE_A, ATHLETE_A, COACH_A],
  );
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  activityLogMigrationSql = await fs.readFile(path.join(INFRA_DIR, ACTIVITY_LOG_MIGRATION_FILE), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const activityLogRunnerModule = await nativeDynamicImport(pathToFileURL(ACTIVITY_LOG_RUNNER_PATH).href);
  applyActivityLogMigrationTransaction = activityLogRunnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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
});

describe('sparring exposure migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SPARRING_EXPOSURE_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.sparring_exposure') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_sparring_exposure_segment_uq', 'pilot_session_load_rated_by_uq')`,
      );
      expect(constraints.rows[0].n).toBe(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_sparring_exposure_stop', () => {
  test('stopped_early=true with a null stop_reason is rejected', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_stop_reason_required');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      await expect(
        recordSparringExposure({
          organizationId: ORG_A,
          activityId: 'activity-1',
          athleteId: ATHLETE_A,
          segmentNumber: 1,
          sparringType: 'hard',
          timeUnderImpactSec: 40,
          coachObservedIntensity: 'firm',
          coachObservedHeadContact: 'regular',
          supervisingCoachAccountId: COACH_A,
          stoppedEarly: true,
        }),
      ).rejects.toThrow('SPARRING_EXPOSURE_STOP_REASON_REQUIRED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('stopped_early=true WITH a stop_reason is accepted', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_stop_reason_given');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      const row = await recordSparringExposure({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        segmentNumber: 1,
        sparringType: 'hard',
        timeUnderImpactSec: 40,
        coachObservedIntensity: 'firm',
        coachObservedHeadContact: 'regular',
        supervisingCoachAccountId: COACH_A,
        stoppedEarly: true,
        stopReason: 'Athlete presented unsteady after an exchange.',
      });
      expect(row.stopped_early).toBe(true);
      expect(row.stop_reason).toBe('Athlete presented unsteady after an exchange.');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_sparring_exposure_segment_uq', () => {
  test('a duplicate (activity, athlete, segment_number) is rejected as SPARRING_EXPOSURE_SEGMENT_DUPLICATE', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_segment_dup');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      await recordSparringExposure({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        segmentNumber: 1,
        sparringType: 'technical',
        timeUnderImpactSec: 30,
        coachObservedIntensity: 'light',
        coachObservedHeadContact: 'none',
        supervisingCoachAccountId: COACH_A,
      });

      await expect(
        recordSparringExposure({
          organizationId: ORG_A,
          activityId: 'activity-1',
          athleteId: ATHLETE_A,
          segmentNumber: 1,
          sparringType: 'hard',
          timeUnderImpactSec: 50,
          coachObservedIntensity: 'firm',
          coachObservedHeadContact: 'frequent',
          supervisingCoachAccountId: COACH_A,
        }),
      ).rejects.toThrow('SPARRING_EXPOSURE_SEGMENT_DUPLICATE');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('getSparringExposureCounts', () => {
  test('returns raw counts and a raw seconds sum only, no computed score', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_counts');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      await recordSparringExposure({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        segmentNumber: 1,
        sparringType: 'hard',
        timeUnderImpactSec: 40,
        coachObservedIntensity: 'firm',
        coachObservedHeadContact: 'regular',
        supervisingCoachAccountId: COACH_A,
      });
      await recordSparringExposure({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        segmentNumber: 2,
        sparringType: 'technical',
        timeUnderImpactSec: 25,
        coachObservedIntensity: 'moderate',
        coachObservedHeadContact: 'incidental',
        supervisingCoachAccountId: COACH_A,
      });

      const counts = await getSparringExposureCounts(ORG_A, ATHLETE_A);
      expect(counts).toEqual({
        total_segments: 2,
        total_time_under_impact_sec: 65,
        segments_by_type: { hard: 1, play: 0, technical: 1, game: 0, conditioned: 0 },
      });
      expect(Object.keys(counts)).toEqual(['total_segments', 'total_time_under_impact_sec', 'segments_by_type']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_session_load_rated_by_uq', () => {
  test('the same activity/athlete can be independently rated by athlete AND coach_proxy', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_session_load_both_raters');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      const athleteRating = await recordSessionLoad({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        rpePhysical: 7,
        rpeCognitive: 4,
        ratedBy: 'athlete',
      });
      const coachRating = await recordSessionLoad({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        rpePhysical: 6,
        rpeCognitive: 5,
        ratedBy: 'coach_proxy',
      });

      expect(athleteRating.rated_by).toBe('athlete');
      expect(coachRating.rated_by).toBe('coach_proxy');

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.session_load where organization_id = $1 and activity_id = $2`,
        [ORG_A, 'activity-1'],
      );
      expect(rows[0].n).toBe(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the same rater rating the same activity/athlete twice is rejected', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_session_load_dup_rater');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1');

      await recordSessionLoad({
        organizationId: ORG_A,
        activityId: 'activity-1',
        athleteId: ATHLETE_A,
        rpePhysical: 7,
        ratedBy: 'athlete',
      });

      await expect(
        recordSessionLoad({
          organizationId: ORG_A,
          activityId: 'activity-1',
          athleteId: ATHLETE_A,
          rpePhysical: 8,
          ratedBy: 'athlete',
        }),
      ).rejects.toThrow('SESSION_LOAD_ALREADY_RATED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.session_load has no stored derived-load column', () => {
  test('rpe_physical and rpe_cognitive stay separate, and no computed column exists', async () => {
    const client = await freshDatabase('ppbf_test_sparringexp_no_stored_derived');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_load'`,
      );
      const columns = rows.map((row: { column_name: string }) => row.column_name);
      expect(columns).toContain('rpe_physical');
      expect(columns).toContain('rpe_cognitive');
      expect(columns).not.toContain('derived_load');
      expect(columns).not.toContain('srpe_load');
      expect(columns).not.toContain('computed_load');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
