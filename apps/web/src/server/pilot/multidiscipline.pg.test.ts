// Real PostgreSQL-backed contract test for the multi-discipline migration
// (pilot.disciplines, pilot.grappling_exposure, pilot.athlete_discipline_participation,
// pilot.mixed_age_session_records, and the four additive drill_library columns)
// and multidiscipline.ts's functions running against a real transaction.
//
// What needs proving, and cannot be proven by reading SQL or a mocked-query unit test:
//
// 1. pilot_grappling_exposure_choke_note holds: a neck_exposure='choke_completed' row
//    with no coach note is rejected.
// 2. pilot_mixed_age_unrelated holds: relationship='unrelated_adult' with a note under
//    15 characters is rejected.
// 3. pilot.disciplines seeds exactly 5 rows via seed-disciplines.mjs, idempotently.
// 4. The readiness check actually fails when the migration did not land.
//
// Spins up the same disposable, local-only embedded Postgres the other migration
// suites use. It NEVER connects to production or staging.

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
  listDisciplines,
  recordGrapplingExposure,
  recordMixedAgeSession,
} from './multidiscipline';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-multidiscipline-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_multidiscipline_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-multidiscipline-migration.mjs',
);
const SEED_LOADER_PATH = path.resolve(__dirname, '../../../scripts/seed-disciplines.mjs');
const SEED_DIR = path.resolve(__dirname, '../../../seed-data/multidiscipline');
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
];

const ORG_A = 'org-multidiscipline-a';
const COACH_A = 'acct-multidiscipline-coach-a';
const ATHLETE_A = 'athlete-multidiscipline-a';
const YOUTH_A = 'athlete-multidiscipline-youth-a';
const ACTIVITY_A = 'activity-multidiscipline-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string[];
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let seedAll: (
  client: Client,
  seedDir: string,
  placeholders: { organizationId: string },
  opts?: { dryRun?: boolean },
) => Promise<void>;

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
  for (const sql of baseSchemaSql) {
    await client.query(sql);
  }

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
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Test Athlete', '2005-01-01', 'unassigned', 'active', 'n/a', true, $4, now(), now()),
       ($1, $3, 'Test Youth', '2015-01-01', 'unassigned', 'active', 'n/a', true, $4, now(), now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, YOUTH_A, COACH_A],
  );
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
        occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
     values ($1, $2, $4, $3, 'boxing_training', 'technical_session', current_date, 60,
             'coach_override', 'coach', $4)
     on conflict do nothing`,
    [ORG_A, ACTIVITY_A, ATHLETE_A, COACH_A],
  );

  activeClient = client;
  return client;
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

  baseSchemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const seedModule = await nativeDynamicImport(pathToFileURL(SEED_LOADER_PATH).href);
  seedAll = seedModule.seedAll as typeof seedAll;
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

describe('multidiscipline migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /MULTIDISCIPLINE_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.disciplines') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_disciplines_pkey', 'pilot_grappling_exposure_choke_note',
                            'pilot_mixed_age_unrelated')`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_grappling_exposure_choke_note', () => {
  test('a completed choke with no coach note is rejected', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_choke_no_note');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      await expect(
        recordGrapplingExposure({
          organizationId: ORG_A,
          activityId: ACTIVITY_A,
          athleteId: ATHLETE_A,
          discipline: 'bjj',
          segmentNumber: 1,
          roundType: 'positional',
          durationSec: 120,
          neckExposure: 'choke_completed',
          coachObservedIntensity: 'moderate',
          supervisingCoachAccountId: COACH_A,
        }),
      ).rejects.toThrow('GRAPPLING_CHOKE_NOTE_REQUIRED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a completed choke WITH a coach note is accepted', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_choke_with_note');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const row = await recordGrapplingExposure({
        organizationId: ORG_A,
        activityId: ACTIVITY_A,
        athleteId: ATHLETE_A,
        discipline: 'bjj',
        segmentNumber: 1,
        roundType: 'positional',
        durationSec: 120,
        neckExposure: 'choke_completed',
        coachNote: 'Tapped clean, coach observed the whole exchange, athlete fine after.',
        coachObservedIntensity: 'moderate',
        supervisingCoachAccountId: COACH_A,
      });
      expect(row.neck_exposure).toBe('choke_completed');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_mixed_age_unrelated', () => {
  test('an unrelated adult paired with a youth athlete needs a note of at least 15 characters', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_unrelated_short_note');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        recordMixedAgeSession({
          organizationId: ORG_A,
          activityId: ACTIVITY_A,
          youthAthleteId: YOUTH_A,
          adultAccountId: COACH_A,
          relationship: 'unrelated_adult',
          pairingPermittedByAccountId: COACH_A,
          supervisingCoachAccountId: COACH_A,
          note: 'too short',
        }),
      ).rejects.toThrow('MIXED_AGE_UNRELATED_NOTE_REQUIRED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a parent/guardian pairing needs no note at all', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_parent_no_note');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const row = await recordMixedAgeSession({
        organizationId: ORG_A,
        activityId: ACTIVITY_A,
        youthAthleteId: YOUTH_A,
        adultAccountId: COACH_A,
        relationship: 'parent_guardian',
        pairingPermittedByAccountId: COACH_A,
        supervisingCoachAccountId: COACH_A,
      });
      expect(row.relationship).toBe('parent_guardian');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('seed-disciplines.mjs against real Postgres', () => {
  test('seeds exactly 5 discipline rows, boxing and conditioning active', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_seed');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const all = await listDisciplines(ORG_A);
      expect(all).toHaveLength(5);
      expect(all.map((d) => d.discipline).sort()).toEqual(
        ['bjj', 'boxing', 'combatives', 'conditioning', 'wrestling'],
      );

      const active = await listDisciplines(ORG_A, { activeOnly: true });
      expect(active.map((d) => d.discipline).sort()).toEqual(['boxing', 'conditioning']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is idempotent: no duplicates, no error', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_seed_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });
      await seedAll(client, SEED_DIR, { organizationId: ORG_A });

      const all = await listDisciplines(ORG_A);
      expect(all).toHaveLength(5);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('--dry-run writes nothing', async () => {
    const client = await freshDatabase('ppbf_test_multidiscipline_seed_dry_run');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await seedAll(client, SEED_DIR, { organizationId: ORG_A }, { dryRun: true });

      const all = await listDisciplines(ORG_A);
      expect(all).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
