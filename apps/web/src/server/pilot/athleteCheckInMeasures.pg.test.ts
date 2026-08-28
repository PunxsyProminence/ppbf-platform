// Real PostgreSQL-backed contract test for the athlete-check-in-measures
// migration -- the six columns the extended check-in collects (owner decision
// 2026-08-28) -- AND for the module behaviour that only exists on top of them.
//
// What needs proving that reading the SQL cannot prove:
//
//   * the migration applies OVER the shipped athlete-check-ins table and
//     re-applies as a no-op, which is what the `all` chain does on every
//     dispatch;
//   * the six 1-5 bounds and the 0-24 sleep bound are DATABASE facts, not
//     application conventions -- a value the route failed to validate still
//     has to be refused;
//   * the constraints arrive even when the columns already exist, which is the
//     entire reason the migration adds them in a separate catalog-guarded
//     block rather than inline on `add column`;
//   * energy, soreness and focus survive untouched;
//   * sleep_hours reads back as a NUMBER. It is stored `numeric`, and
//     node-postgres returns numeric as a string, so the module's ::float8 cast
//     is the only thing standing between the declared `number | null` and a
//     silent "7.5";
//   * absent stays absent -- a bare check-in stores null in all nine wellness
//     columns rather than a defaulted middle.
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

import { WELLNESS_COLUMNS, checkIn, getTodayCheckIn } from './athleteCheckIns';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-checkin-measures-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const BASE_MIGRATION_FILE = 'pilot_slice_postgres_athlete_check_ins_migration.sql';
const MEASURES_MIGRATION_FILE = 'pilot_slice_postgres_athlete_check_in_measures_migration.sql';

const ORG_ID = 'org-measures';
const OTHER_ORG_ID = 'org-measures-elsewhere';
const ADMIN_ID = 'acct-measures-admin';
const COACH_ID = 'acct-measures-coach';
const ATHLETE_ID = 'ath-measures-1';

/** The six this migration adds, with the bound the database must enforce. */
const ADDED_SCALE_COLUMNS = ['hydration', 'motivation', 'mental_clarity', 'stress', 'nutrition_compliance'] as const;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let baseMigrationSql: string;
let measuresMigrationSql: string;

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
     values ($1, $2, 'Measures Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

/** The shipped table, then the measures on top -- the order the `all` chain
 * applies them in, and the order this migration's ALTERs require. */
async function applyBoth(client: Client): Promise<void> {
  await client.query(baseMigrationSql);
  await client.query(measuresMigrationSql);
}

function insertRaw(client: Client, checkInId: string, values: Record<string, number | string | null> = {}) {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 4}`);
  return client.query(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id${columns.length ? `, ${columns.join(', ')}` : ''})
     values ($1, $2, $3${placeholders.length ? `, ${placeholders.join(', ')}` : ''})`,
    [ORG_ID, checkInId, ATHLETE_ID, ...columns.map((column) => values[column])],
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
  baseMigrationSql = await fs.readFile(path.join(INFRA_DIR, BASE_MIGRATION_FILE), 'utf8');
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

describe('athlete check-in measures migration', () => {
  test('adds the six columns over the shipped table and re-applies as a no-op', async () => {
    const client = await freshDatabase('measures_fresh');
    try {
      await applyBoth(client);
      // The `all` chain re-runs every migration on every dispatch, so a
      // second application is the NORMAL case, not an edge one.
      await client.query(measuresMigrationSql);

      const { rows } = await client.query(
        `select attname, atttypid::regtype::text as type_name
         from pg_attribute
         where attrelid = to_regclass('pilot.athlete_check_ins')
           and attnum > 0 and not attisdropped
         order by attname`,
      );
      const types = Object.fromEntries(rows.map((row) => [row.attname, row.type_name]));

      for (const column of ADDED_SCALE_COLUMNS) {
        expect(types[column]).toBe('integer');
      }
      // Sleep is a quantity, so it is numeric rather than an integer rating:
      // half-hours have to survive, and 7.5 stored as an integer is 7 or 8.
      expect(types.sleep_hours).toBe('numeric');
    } finally {
      await client.end();
    }
  });

  test('leaves energy, soreness and focus exactly as they were', async () => {
    const client = await freshDatabase('measures_preexisting');
    try {
      await applyBoth(client);

      const { rows } = await client.query(
        `select attname, atttypid::regtype::text as type_name, attnotnull
         from pg_attribute
         where attrelid = to_regclass('pilot.athlete_check_ins')
           and attname in ('energy', 'soreness', 'focus')`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.type_name).toBe('integer');
        expect(row.attnotnull).toBe(false);
      }

      // And their bound still bites -- this migration must not have widened
      // or dropped the check it found.
      await expect(insertRaw(client, 'm-energy-6', { energy: 6 }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test.each(ADDED_SCALE_COLUMNS)('%s is bounded 1-5 by the database, not by the route', async (column) => {
    const client = await freshDatabase(`measures_bound_${column}`);
    try {
      await applyBoth(client);

      await expect(insertRaw(client, `${column}-zero`, { [column]: 0 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertRaw(client, `${column}-six`, { [column]: 6, checked_in_on: '2030-03-01' }))
        .rejects.toMatchObject({ code: '23514' });

      // The legal ends are accepted, so the constraint is a range and not a
      // blanket refusal that would pass the two assertions above.
      await insertRaw(client, `${column}-one`, { [column]: 1, checked_in_on: '2030-03-02' });
      await insertRaw(client, `${column}-five`, { [column]: 5, checked_in_on: '2030-03-03' });
      // Absent is legal too: skipping a question is not an error.
      await insertRaw(client, `${column}-null`, { [column]: null, checked_in_on: '2030-03-04' });
    } finally {
      await client.end();
    }
  });

  test('sleep_hours is bounded 0-24 and keeps its half hours', async () => {
    const client = await freshDatabase('measures_sleep');
    try {
      await applyBoth(client);

      await expect(insertRaw(client, 'sleep-negative', { sleep_hours: -1 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertRaw(client, 'sleep-25', { sleep_hours: 25, checked_in_on: '2030-04-01' }))
        .rejects.toMatchObject({ code: '23514' });

      await insertRaw(client, 'sleep-ok', { sleep_hours: 7.5, checked_in_on: '2030-04-02' });
      const { rows } = await client.query(
        `select sleep_hours::text as stored from pilot.athlete_check_ins where check_in_id = 'sleep-ok'`,
      );
      // numeric(3,1) -- the half hour survives rather than rounding to 8.
      expect(rows[0].stored).toBe('7.5');
    } finally {
      await client.end();
    }
  });

  test('the range constraints arrive even when the columns already exist', async () => {
    // THE REASON THE MIGRATION SPLITS COLUMNS FROM CONSTRAINTS.
    //
    // `add column if not exists x integer check (...)` adds NOTHING when the
    // column is already there -- not the column, and not the check. An
    // environment that gained the columns by any other route would then be
    // permanently unconstrained, silently, and every later re-run of the `all`
    // chain would agree it was fine. Adding the constraints in their own
    // catalog-guarded block is what makes the migration converge from that
    // state instead of ratifying it.
    const client = await freshDatabase('measures_convergence');
    try {
      await client.query(baseMigrationSql);
      // Simulate the columns existing WITHOUT their checks.
      await client.query(`
        alter table pilot.athlete_check_ins add column sleep_hours numeric(3,1) null;
        alter table pilot.athlete_check_ins add column hydration integer null;
        alter table pilot.athlete_check_ins add column motivation integer null;
        alter table pilot.athlete_check_ins add column mental_clarity integer null;
        alter table pilot.athlete_check_ins add column stress integer null;
        alter table pilot.athlete_check_ins add column nutrition_compliance integer null;
      `);
      // Before the migration, the unconstrained column accepts nonsense.
      await insertRaw(client, 'pre-migration-47', { hydration: 47 });
      await client.query(`delete from pilot.athlete_check_ins where check_in_id = 'pre-migration-47'`);

      await client.query(measuresMigrationSql);

      await expect(insertRaw(client, 'post-migration-47', { hydration: 47 }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});

describe('the code and the schema name the same measures', () => {
  test('WELLNESS_COLUMNS is exactly the set of 1-5 constrained columns on the table', async () => {
    // THE LOOP-CLOSING CASE, and the reason it lives in the pg suite rather
    // than beside the constant.
    //
    // The route validates by sweeping WELLNESS_COLUMNS, and wellnessScales
    // asserts the scales match that same constant. Both of those compare code
    // against code: a measure added to the DATABASE and to checkIn, but never
    // to the constant, satisfies every one of them while reaching the route
    // unvalidated and the athlete undescribed. Only the schema itself can
    // catch that, so the set is read back out of pg_constraint here.
    //
    // Derived from the CHECK constraints rather than from a hand-written list,
    // because a hand-written list in this file would be the same class of
    // parallel-maintained copy the constant already is.
    const client = await freshDatabase('measures_constant_matches_schema');
    try {
      await applyBoth(client);

      const { rows } = await client.query(`
        select a.attname
        from pg_constraint c
        join pg_attribute a
          on a.attrelid = c.conrelid
         and a.attnum = c.conkey[1]
        where c.conrelid = to_regclass('pilot.athlete_check_ins')
          and c.contype = 'c'
          and array_length(c.conkey, 1) = 1
          and pg_get_constraintdef(c.oid) like '%>= 1%'
          and pg_get_constraintdef(c.oid) like '%<= 5%'
      `);
      const constrainedOneToFive = rows.map((row) => row.attname).sort();

      expect(constrainedOneToFive).toEqual([...WELLNESS_COLUMNS].sort());
    } finally {
      await client.end();
    }
  });
});

describe('the runner readiness assertion', () => {
  test('accepts a migrated database and REFUSES an un-migrated one', async () => {
    // Guards the guard. A readiness query that returns true unconditionally
    // would pass the positive case and let a failed migration report success
    // -- which is how a readiness assertion shipped that could not pass on any
    // database (run 32257652780, the BETWEEN-deparsing incident). The negative
    // case is what makes the positive one mean something.
    const client = await freshDatabase('measures_readiness');
    try {
      // READ OUT OF THE RUNNER, never restated here: a copy in this test could
      // stay correct while the shipped query rots, defeating the point.
      const runnerSource = await fs.readFile(
        path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-check-in-measures-migration.mjs'),
        'utf8',
      );
      const match = runnerSource.match(/const READINESS_QUERY = `([\s\S]*?)`;/);
      expect(match).not.toBeNull();

      await client.query(baseMigrationSql);
      const before = await client.query(match![1]);
      // Un-migrated: assertReadiness() demands every field true, so at least
      // one must not be.
      expect(Object.values(before.rows[0]).every((value) => value === true)).toBe(false);

      await client.query(measuresMigrationSql);
      const after = await client.query(match![1]);
      expect(after.rows[0]).toEqual({
        table_ready: true,
        measure_columns_ready: true,
        sleep_hours_is_numeric: true,
        range_constraints_ready: true,
        pre_existing_intact: true,
      });
    } finally {
      await client.end();
    }
  });
});

describe('the module round-trips every measure', () => {
  test('stores and reads back all nine wellness values, with sleep_hours as a NUMBER', async () => {
    const client = await freshDatabase('measures_roundtrip');
    activeClient = client;
    try {
      await applyBoth(client);

      const result = await checkIn({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        energy: 4,
        soreness: 2,
        focus: 3,
        sleepHours: 7.5,
        hydration: 5,
        motivation: 4,
        mentalClarity: 3,
        stress: 2,
        nutritionCompliance: 5,
        note: 'slept well',
      });

      expect(result).toMatchObject({
        created: true,
        row: {
          energy: 4,
          soreness: 2,
          focus: 3,
          sleep_hours: 7.5,
          hydration: 5,
          motivation: 4,
          mental_clarity: 3,
          stress: 2,
          nutrition_compliance: 5,
          note: 'slept well',
        },
      });

      // THE CAST, ASSERTED AS A TYPE RATHER THAN A VALUE. `sleep_hours: 7.5`
      // above passes on the string "7.5" under toMatchObject's loose equality
      // in neither direction -- but a future reader could reasonably "simplify"
      // the ::float8 away and only this line would notice. numeric comes back
      // from node-postgres as a string unless it is cast.
      expect(typeof result!.row.sleep_hours).toBe('number');

      const readBack = await getTodayCheckIn(ORG_ID, ATHLETE_ID);
      expect(typeof readBack!.sleep_hours).toBe('number');
      expect(readBack!.sleep_hours).toBe(7.5);
    } finally {
      await client.end();
    }
  });

  test('a bare check-in stores null everywhere, never a defaulted middle', async () => {
    // The contract's load-bearing rule: "Omitted means omitted -- the UI must
    // not default a skipped slider to a value, and must render stored null as
    // 'not reported', never as 0 or 3." The nine columns are asserted
    // individually rather than as a count, so a value appearing in exactly one
    // of them cannot hide.
    const client = await freshDatabase('measures_absent');
    activeClient = client;
    try {
      await applyBoth(client);

      const result = await checkIn({ organizationId: ORG_ID, athleteId: ATHLETE_ID });

      expect(result).toMatchObject({
        created: true,
        row: {
          energy: null,
          soreness: null,
          focus: null,
          sleep_hours: null,
          hydration: null,
          motivation: null,
          mental_clarity: null,
          stress: null,
          nutrition_compliance: null,
          note: '',
        },
      });
    } finally {
      await client.end();
    }
  });
});
