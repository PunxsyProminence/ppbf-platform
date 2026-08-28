// Real PostgreSQL-backed contract test for the athlete-check-ins
// migration (Phase 2 slice 1), AND for the REAL module behavior on top of
// it: './db' is mocked to route into the embedded server (see
// trainingHolds.pg.test.ts for the same pattern), so checkIn,
// getTodayCheckIn, and listRecentCheckIns below are the actual production
// functions executing their actual SQL against actual rows -- not the
// hand-written raw-SQL inserts the rest of this file uses to prove
// schema-level constraints.
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing and re-applies as a no-op; one check-in per
// athlete per day is a unique index, not a convention; wellness bounds
// (1-5 or null) are database facts; and tenancy holds via the composite
// athlete FK. On top of that: checkIn's hidden-not-found for a cross-org
// athlete, and its idempotent-by-day behavior (a second call the same day
// returns the SAME row with created:false, including the concurrent
// double-tap race the on-conflict-do-nothing + re-read pattern is meant to
// survive) only exist in the TS module.
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

import { checkIn, getTodayCheckIn, listRecentCheckIns, wellnessValueError } from './athleteCheckIns';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-check-ins-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_check_ins_migration.sql';
const MEASURES_MIGRATION_FILE = 'pilot_slice_postgres_athlete_check_in_measures_migration.sql';

const ORG_ID = 'org-checkins';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-checkins-admin';
const COACH_ID = 'acct-checkins-coach';
const ATHLETE_ID = 'ath-checkins-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let measuresMigrationSql: string;
let baseSchemaSql: string;

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
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Check-in Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  measuresMigrationSql = await fs.readFile(path.join(INFRA_DIR, MEASURES_MIGRATION_FILE), 'utf8');
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

afterEach(() => {
  activeClient = null;
});
function insertCheckIn(client: Client, checkInId: string, overrides: Record<string, string | number | null> = {}) {
  return client.query(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id, checked_in_on, energy)
     values ($1, $2, $3, coalesce($4::date, current_date), $5)`,
    [
      overrides.organization_id ?? ORG_ID,
      checkInId,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.checked_in_on ?? null,
      overrides.energy ?? null,
    ],
  );
}

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every test below applies `migrationSql` directly, which proves the schema
// but never runs `applyMigrationTransaction` -- so the runner's post-apply
// verification was untested, and shipped a check that could not pass on any
// database: it looked for the literal `between 1 and 5`, while Postgres
// deparses BETWEEN back as `>= 1 AND <= 5`. That reached a real staging
// dispatch (run 32257652780) and blocked the whole `all` chain behind it.
//
// This exercises the real runner against real Postgres so the assertion has
// to survive the same deparsing the database actually does.
describe('athlete check-ins runner readiness assertion', () => {
  test('the real runner accepts a correctly migrated database', async () => {
    const client = await freshDatabase('checkins_readiness');
    try {
      await client.query(migrationSql);

      // The runner's query is READ OUT OF THE RUNNER rather than restated
      // here. Restating it would let the copy in this test stay correct
      // while the shipped one rots -- which is the exact failure being
      // regression-tested, so a duplicated query would defeat the point.
      const runnerSource = await fs.readFile(
        path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-check-ins-migration.mjs'),
        'utf8',
      );
      const match = runnerSource.match(/const READINESS_QUERY = `([\s\S]*?)`;/);
      expect(match).not.toBeNull();

      const readiness = await client.query(match![1]);
      // Every field true is exactly what assertReadiness() demands.
      expect(readiness.rows[0]).toEqual({
        check_ins_ready: true,
        one_per_day_ready: true,
        wellness_bounds_ready: true,
      });

      // And the bound it verifies is a real database fact, not just a string
      // match -- 0 and 6 are refused after the runner says it is ready.
      await expect(insertCheckIn(client, 'ci-low', { energy: 0 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertCheckIn(client, 'ci-high', { checked_in_on: '2030-02-01', energy: 6 }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});

describe('athlete check-ins migration', () => {
  test('creates from nothing, re-applies as a no-op, and enforces one check-in per athlete per day', async () => {
    const client = await freshDatabase('checkins_fresh');
    try {
      await client.query(migrationSql);
      await insertCheckIn(client, 'ci-1', { energy: 4 });
      await client.query(migrationSql);

      // The same athlete on the same day is a fact already recorded.
      await expect(insertCheckIn(client, 'ci-dup')).rejects.toMatchObject({ code: '23505' });
      // A different day is a new fact.
      await insertCheckIn(client, 'ci-tomorrow', { checked_in_on: '2030-01-01' });

      // Wellness bounds are database facts: 0 and 6 are refused, null is legal.
      await expect(insertCheckIn(client, 'ci-zero', { checked_in_on: '2030-01-02', energy: 0 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertCheckIn(client, 'ci-six', { checked_in_on: '2030-01-02', energy: 6 }))
        .rejects.toMatchObject({ code: '23514' });

      // Tenancy: another org cannot claim this athlete.
      await expect(insertCheckIn(client, 'ci-cross', { organization_id: OTHER_ORG_ID, checked_in_on: '2030-01-03' }))
        .rejects.toMatchObject({ code: '23503' });

      const rows = await client.query(
        `select count(*)::int as n from pilot.athlete_check_ins where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });
});

describe('wellnessValueError', () => {
  test('accepts 1-5 and the absent values, refuses anything else', () => {
    expect(wellnessValueError('energy', undefined)).toBeNull();
    expect(wellnessValueError('energy', null)).toBeNull();
    expect(wellnessValueError('energy', 1)).toBeNull();
    expect(wellnessValueError('energy', 5)).toBeNull();
    expect(wellnessValueError('energy', 0)).toContain('energy');
    expect(wellnessValueError('energy', 6)).toContain('energy');
    expect(wellnessValueError('energy', 2.5)).toContain('energy');
    expect(wellnessValueError('energy', '3')).toContain('energy');
  });
});

// checkIn writes every column the extended-check-in measures migration adds,
// so the module tests need BOTH migrations applied. The schema tests above
// deliberately keep applying only the first: what that one migration does on
// its own -- create from nothing, re-apply as a no-op, enforce its own bounds
// -- is precisely what they exist to prove, and stacking a second migration
// into them would stop them proving it.
async function applyModuleSchema(client: Client): Promise<void> {
  await client.query(migrationSql);
  await client.query(measuresMigrationSql);
}

// The tests above prove the migration's schema. These prove the module:
// checkIn's hidden-not-found for a cross-org athlete, and its
// idempotent-by-day behavior (including the concurrent double-tap race) --
// none of which a raw-SQL insert can exercise, because none of it is a
// database constraint.
describe('the real check-in lifecycle against real rows', () => {
  test('checkIn creates the first check-in of the day and hides a cross-org athlete as not-found', async () => {
    const client = await freshDatabase('checkins_create');
    activeClient = client;
    try {
      await applyModuleSchema(client);

      const result = await checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID, energy: 4, soreness: 2 });
      expect(result).toMatchObject({ created: true, row: { energy: 4, soreness: 2, focus: null } });

      await expect(checkIn({ organizationId: ORG_ID, athleteId: 'no-such-athlete' })).resolves.toBeNull();
      await expect(checkIn({ organizationId: OTHER_ORG_ID, athleteId: ATHLETE_ID })).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('checkIn is idempotent by day: a second call the same day returns the SAME row with created:false', async () => {
    const client = await freshDatabase('checkins_idempotent');
    activeClient = client;
    try {
      await applyModuleSchema(client);

      const first = await checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID, energy: 3 });
      const second = await checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID, energy: 5 });

      expect(second).toMatchObject({ created: false, row: { check_in_id: first!.row.check_in_id, energy: 3 } });
    } finally {
      await client.end();
    }
  });

  // Concurrent double-tap: two calls racing before either has read the
  // other's insert. The unique index (organization_id, athlete_id,
  // checked_in_on) lets exactly one INSERT ... ON CONFLICT DO NOTHING win;
  // checkIn's re-read-after-insert is what makes the LOSING caller still
  // resolve to a real row instead of null. Both callers sharing one
  // connection still exercises the real code path: each fires its own
  // select-existing / insert-on-conflict / re-read sequence, and node-pg
  // serializes them query-by-query in submission order, so the second
  // caller's insert genuinely hits the first caller's already-committed row.
  test('a concurrent double-tap resolves both callers to the SAME row, only one of them created:true', async () => {
    const client = await freshDatabase('checkins_race');
    activeClient = client;
    try {
      await applyModuleSchema(client);

      const [a, b] = await Promise.all([
        checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID, energy: 3 }),
        checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID, energy: 5 }),
      ]);

      expect(a!.row.check_in_id).toBe(b!.row.check_in_id);
      expect([a!.created, b!.created].sort()).toEqual([false, true]);

      const rows = await client.query(
        `select count(*)::int as n from pilot.athlete_check_ins where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('listRecentCheckIns returns only this athlete\'s own history, newest first, bounded by limit', async () => {
    const client = await freshDatabase('checkins_history');
    activeClient = client;
    try {
      await applyModuleSchema(client);
      await insertCheckIn(client, 'ci-old', { checked_in_on: '2026-01-01', energy: 1 });
      await insertCheckIn(client, 'ci-mid', { checked_in_on: '2026-01-02', energy: 2 });
      await insertCheckIn(client, 'ci-new', { checked_in_on: '2026-01-03', energy: 3 });
      const otherAthlete = 'ath-checkins-other';
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Other Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
        [ORG_ID, otherAthlete, COACH_ID],
      );
      await client.query(
        `insert into pilot.athlete_check_ins (organization_id, check_in_id, athlete_id, checked_in_on, energy)
         values ($1, 'ci-other-athlete', $2, '2026-01-03', 5)`,
        [ORG_ID, otherAthlete],
      );

      const history = await listRecentCheckIns(ORG_ID, ATHLETE_ID, 2);
      expect(history.map((row) => row.check_in_id)).toEqual(['ci-new', 'ci-mid']);
    } finally {
      await client.end();
    }
  });

  test('getTodayCheckIn returns null before any check-in exists today', async () => {
    const client = await freshDatabase('checkins_today_empty');
    activeClient = client;
    try {
      await applyModuleSchema(client);
      await expect(getTodayCheckIn(ORG_ID, ATHLETE_ID)).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });
});
