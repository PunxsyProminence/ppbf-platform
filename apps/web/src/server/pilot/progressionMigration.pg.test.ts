// Real PostgreSQL-backed contract test for the progression migration.
//
// Three things need proving, and none can be proven by reading SQL:
//
// 1. It CREATES the schema from nothing. That is the whole point -- these
//    three tables were reachable only through /api/pilot/admin/migrate-multiorg,
//    a bootstrap-key HTTP route, so a rebuilt environment had no way to get
//    them and /coach/progression-intelligence failed at the database.
//
// 2. It is a NO-OP against a database that already has them. Production ran
//    the legacy route, so this migration must not redefine, alter or drop
//    anything -- it has to apply cleanly over an existing install and leave
//    the rows untouched.
//
// 3. It matches the legacy route's DDL. If the two ever diverge, an
//    environment built by migration behaves differently from one built by the
//    route, which is worse than the gap being fixed. The legacy DDL is
//    reproduced here from the route and applied FIRST in the no-op case, so
//    drift shows up as a failure in this file.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-progression-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-progression-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-prog';
const COACH_ID = 'acct-prog-coach';
const ATHLETE_ID = 'ATH-PROG-1';

// Verbatim from app/api/pilot/admin/migrate-multiorg/route.ts. Copied rather
// than imported because it lives inside a Next route handler as an array of
// template strings; if the route's DDL ever changes, the no-op test below
// stops matching and the divergence surfaces here.
const LEGACY_DDL = [
  `create table if not exists pilot.progression_gaps (
    gap_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    athlete_id text not null,
    coach_account_id text not null references pilot.accounts(account_id),
    gap_type text not null check (gap_type in ('technique', 'strength', 'endurance', 'skill', 'mental', 'tactical')),
    gap_description text not null,
    severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
    detected_from text not null,
    detected_from_id text null,
    detection_data jsonb not null default '{}'::jsonb,
    status text not null default 'identified' check (status in ('identified', 'assigned', 'in_progress', 'completed', 'deferred')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_progression_gaps_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
  )`,
  `create table if not exists pilot.drill_assignments (
    assignment_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    gap_id text not null references pilot.progression_gaps(gap_id) on delete cascade,
    athlete_id text not null,
    assigned_by_account_id text not null references pilot.accounts(account_id),
    drill_name text not null,
    drill_description text not null,
    drill_difficulty text not null default 'intermediate' check (drill_difficulty in ('beginner', 'intermediate', 'advanced', 'elite')),
    rep_count integer null,
    duration_minutes integer null,
    frequency_per_week integer null,
    assigned_at timestamptz not null default now(),
    due_date date null,
    status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'incomplete', 'cancelled')),
    completion_percentage integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_drill_assignments_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
  )`,
  `create table if not exists pilot.assignment_completions (
    completion_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    assignment_id text not null references pilot.drill_assignments(assignment_id) on delete cascade,
    athlete_id text not null,
    completed_at timestamptz not null,
    reps_completed integer null,
    notes text not null default '',
    verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'disputed')),
    verified_by_account_id text null references pilot.accounts(account_id),
    verified_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_assignment_completions_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
  )`,
  `create index if not exists idx_progression_gaps_athlete on pilot.progression_gaps(organization_id, athlete_id, created_at desc)`,
  `create index if not exists idx_drill_assignments_status on pilot.drill_assignments(organization_id, status, due_date)`,
  `create index if not exists idx_assignment_completions_assignment on pilot.assignment_completions(organization_id, assignment_id)`,
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/** Fresh database with the base schema and the org/coach/athlete rows the FKs need. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Progression Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

async function insertGap(client: Client, gapId: string): Promise<void> {
  await client.query(
    `insert into pilot.progression_gaps
       (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
     values ($1, $2, $3, $4, 'technique', 'Guard drops after the jab.', 'coach_observation')`,
    [gapId, ORG_ID, ATHLETE_ID, COACH_ID],
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
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

describe('progression migration against real Postgres', () => {
  test('the gap is real: without the migration the tables do not exist', async () => {
    const client = await freshDatabase('ppbf_test_prog_absent');
    try {
      const row = await client.query(`select to_regclass('pilot.progression_gaps') as t`);
      expect(row.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a fresh install creates all three tables and all three indexes', async () => {
    const client = await freshDatabase('ppbf_test_prog_fresh');
    try {
      await client.query(migrationSql);

      for (const table of ['progression_gaps', 'drill_assignments', 'assignment_completions']) {
        const row = await client.query(`select to_regclass($1) as t`, [`pilot.${table}`]);
        expect(row.rows[0].t).not.toBeNull();
      }

      const indexes = await client.query(
        `select indexname from pg_indexes
         where schemaname = 'pilot'
           and tablename in ('progression_gaps', 'drill_assignments', 'assignment_completions')`,
      );
      const names = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(names).toContain('idx_progression_gaps_athlete');
      expect(names).toContain('idx_drill_assignments_status');
      expect(names).toContain('idx_assignment_completions_assignment');
    } finally {
      await client.end();
    }
  });

  test('the real read path works after the migration', async () => {
    // progression.ts joins gaps to assignments to completions; a table that
    // exists but rejects the app's own insert would still be broken.
    const client = await freshDatabase('ppbf_test_prog_readpath');
    try {
      await client.query(migrationSql);
      await insertGap(client, 'gap-1');
      await client.query(
        `insert into pilot.drill_assignments
           (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description)
         values ('asg-1', $1, 'gap-1', $2, $3, 'Jab return', 'Ten rounds of jab-and-return.')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      await client.query(
        `insert into pilot.assignment_completions
           (completion_id, organization_id, assignment_id, athlete_id, completed_at)
         values ('cmp-1', $1, 'asg-1', $2, now())`,
        [ORG_ID, ATHLETE_ID],
      );

      const joined = await client.query(
        `select g.gap_id, a.assignment_id, c.completion_id
         from pilot.progression_gaps g
         join pilot.drill_assignments a on a.gap_id = g.gap_id
         join pilot.assignment_completions c on c.assignment_id = a.assignment_id
         where g.organization_id = $1`,
        [ORG_ID],
      );
      expect(joined.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('NO-OP: applies cleanly over the legacy route-created tables and keeps their rows', async () => {
    // The case that matters for production, which ran the legacy HTTP route.
    // The migration must not redefine or disturb what is already there.
    const client = await freshDatabase('ppbf_test_prog_legacy');
    try {
      for (const statement of LEGACY_DDL) await client.query(statement);
      await insertGap(client, 'gap-legacy');

      await client.query(migrationSql);

      const row = await client.query(
        `select gap_id, gap_description from pilot.progression_gaps where gap_id = 'gap-legacy'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].gap_description).toBe('Guard drops after the jab.');
    } finally {
      await client.end();
    }
  });

  test('NO-OP: the legacy install and a fresh install agree on columns and constraints', async () => {
    // Drift between the two would mean an environment built by migration
    // behaves differently from one built by the route -- worse than the gap
    // this migration closes.
    const legacy = await freshDatabase('ppbf_test_prog_shape_legacy');
    const fresh = await freshDatabase('ppbf_test_prog_shape_fresh');
    try {
      for (const statement of LEGACY_DDL) await legacy.query(statement);
      await fresh.query(migrationSql);

      const columnQuery = `
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'pilot'
          and table_name in ('progression_gaps', 'drill_assignments', 'assignment_completions')
        order by table_name, column_name`;
      const constraintQuery = `
        select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where connamespace = 'pilot'::regnamespace
          and conrelid::regclass::text in ('pilot.progression_gaps', 'pilot.drill_assignments', 'pilot.assignment_completions')
        order by tbl, conname`;

      expect((await fresh.query(columnQuery)).rows).toEqual((await legacy.query(columnQuery)).rows);
      expect((await fresh.query(constraintQuery)).rows).toEqual((await legacy.query(constraintQuery)).rows);
    } finally {
      await legacy.end();
      await fresh.end();
    }
  });

  test('re-running is idempotent', async () => {
    const client = await freshDatabase('ppbf_test_prog_idempotent');
    try {
      await client.query(migrationSql);
      await insertGap(client, 'gap-keep');
      await client.query(migrationSql);
      await client.query(migrationSql);

      const row = await client.query(`select count(*)::int as n from pilot.progression_gaps`);
      expect(row.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the athlete foreign key is real: an unknown athlete cannot have a gap', async () => {
    const client = await freshDatabase('ppbf_test_prog_fk');
    try {
      await client.query(migrationSql);
      await expect(
        client.query(
          `insert into pilot.progression_gaps
             (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
           values ('gap-x', $1, 'ATH-NOT-REAL', $2, 'technique', 'x', 'coach_observation')`,
          [ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_progression_gaps_fk_athlete|foreign key/);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-progression-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('progression runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('progr_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PROGRESSION_TABLES_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('progr_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
