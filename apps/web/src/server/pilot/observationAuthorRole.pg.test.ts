import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module. Building it through Function keeps a real dynamic import
   in the emitted code, honored under --experimental-vm-modules. Same helper,
   same reason, as softDeletedAthleteAccess.pg.test.ts. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_observation_author_role';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-observation-author-role-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const BASE_SCHEMA_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

const ORG_ID = 'org-obs-author';
const OTHER_ORG_ID = 'org-obs-author-elsewhere';
const ADMIN_ID = 'acct-obs-admin';
const GUARDIAN_ACCOUNT_ID = 'acct-obs-parent';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type IntakeModule = typeof import('./intake');
let intake: IntakeModule;
let closePool: () => Promise<void>;

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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  await client.query(await fs.readFile(BASE_SCHEMA_PATH, 'utf8'));

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'parent', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, GUARDIAN_ACCOUNT_ID],
  );

  // Env before import: db.ts reads the connection string when its pool is
  // first built, so the dynamic import has to come after this.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  intake = await import('./intake');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
  await client?.end();
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

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../../../infra/azure/pilot_slice_postgres_observation_author_role_migration.sql',
);
const ATHLETE_ID = 'ATH-OBS-AUTHOR';

/* Each runner test needs its own database: one that never saw the migration
   (to prove the readiness assertion refuses) and one that did (to prove it
   accepts, twice). The shared `client` above is already migrated by the time
   they run, so it cannot answer the first question. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const fresh = new Client({ connectionString: connectionStringFor(name) });
  await fresh.connect();
  await fresh.query(await fs.readFile(BASE_SCHEMA_PATH, 'utf8'));
  return fresh;
}

// Returns the query result rather than void so a caller can assert the
// re-apply actually resolved to something, the way the other migration
// suites do.
async function applyMigration(): Promise<unknown> {
  return client.query(await fs.readFile(MIGRATION_PATH, 'utf8'));
}

describe('the author_role migration', () => {
  test('the base schema does not carry author_role, so this suite cannot pass vacuously', async () => {
    // Dropping and rebuilding the table from the base schema is what makes the
    // "before" state real rather than assumed.
    await client.query('drop table if exists pilot.coach_observations cascade');
    await client.query(`
      create table pilot.coach_observations (
        organization_id text not null references pilot.organizations(organization_id),
        note_id uuid not null,
        athlete_id text not null,
        coach_account_id text not null references pilot.accounts(account_id),
        note_type text not null,
        note_text text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_coach_observations_pk primary key (organization_id, note_id)
      )`);

    const before = await client.query(
      `select 1 from information_schema.columns
        where table_schema = 'pilot' and table_name = 'coach_observations'
          and column_name = 'author_role'`,
    );
    expect(before.rowCount).toBe(0);
  });

  test('applies, and adds a NULLABLE author_role', async () => {
    await applyMigration();
    const column = await client.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'pilot' and table_name = 'coach_observations'
          and column_name = 'author_role'`,
    );
    expect(column.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });

  test('re-applying is a no-op, so `all` can run it against any environment', async () => {
    await expect(applyMigration()).resolves.toBeDefined();
  });

  test('the CHECK admits the role vocabulary and refuses anything else', async () => {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Obs Athlete', '2013-01-01', 'fly', 'active', 'x', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, ATHLETE_ID, ADMIN_ID],
    );

    for (const role of ['parent', 'coach', 'organization_admin', 'staff']) {
      await expect(
        client.query(
          `insert into pilot.coach_observations
           (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
           values ($1, gen_random_uuid(), $2, $3, $4, 'coach_observation', 'text')`,
          [ORG_ID, ATHLETE_ID, ADMIN_ID, role],
        ),
      ).resolves.toBeDefined();
    }

    // A typo must not enter the vocabulary. Free text here would let one in
    // and the column would read as recorded provenance while being noise.
    await expect(
      client.query(
        `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
         values ($1, gen_random_uuid(), $2, $3, 'guardain', 'coach_observation', 'text')`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      ),
    ).rejects.toThrow();
  });

  test('a row written before the column existed keeps a null role, and is not backfilled', async () => {
    // The pre-migration row is inserted with the column already present but
    // left unset -- the same end state a row written before the migration has.
    // Nothing may invent a value for it later: the account's role today is
    // exactly the value that cannot be trusted to describe the past.
    const historical = await client.query<{ author_role: string | null }>(
      `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, gen_random_uuid(), $2, $3, 'home_barrier', 'no lift to the gym')
       returning author_role`,
      [ORG_ID, ATHLETE_ID, ADMIN_ID],
    );
    expect(historical.rows[0].author_role).toBeNull();

    await applyMigration();
    const after = await client.query<{ count: string }>(
      `select count(*)::text as count from pilot.coach_observations
        where note_type = 'home_barrier' and author_role is null`,
    );
    expect(Number(after.rows[0].count)).toBe(1);
  });
});

describe('createCoachObservation records the role it was given', () => {
  test('a guardian-authored barrier report is stored as parent, not as the account role', async () => {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Obs Athlete', '2013-01-01', 'fly', 'active', 'x', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, ATHLETE_ID, ADMIN_ID],
    );

    const noteId = await intake.createCoachObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      coachAccountId: GUARDIAN_ACCOUNT_ID,
      authorRole: 'parent',
      noteType: 'home_barrier',
      noteText: 'No lift to the gym on Thursdays.',
    });

    const stored = await client.query<{ author_role: string; coach_account_id: string }>(
      'select author_role, coach_account_id from pilot.coach_observations where note_id = $1',
      [noteId],
    );
    expect(stored.rows[0].author_role).toBe('parent');
    expect(stored.rows[0].coach_account_id).toBe(GUARDIAN_ACCOUNT_ID);
  });

  test('the recorded role does not move when the account role later changes', async () => {
    // This is the whole point, and it is the case that failed before the
    // column existed: the same untouched row reported a different author.
    const noteId = await intake.createCoachObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      coachAccountId: GUARDIAN_ACCOUNT_ID,
      authorRole: 'parent',
      noteType: 'home_barrier',
      noteText: 'Still no lift.',
    });

    await client.query(`update pilot.accounts set role = 'coach' where account_id = $1`, [
      GUARDIAN_ACCOUNT_ID,
    ]);

    const stored = await client.query<{ author_role: string; account_role_now: string }>(
      `select co.author_role, a.role as account_role_now
         from pilot.coach_observations co
         join pilot.accounts a on a.account_id = co.coach_account_id
        where co.note_id = $1`,
      [noteId],
    );
    // The account really did change -- otherwise this asserts nothing.
    expect(stored.rows[0].account_role_now).toBe('coach');
    expect(stored.rows[0].author_role).toBe('parent');

    await client.query(`update pilot.accounts set role = 'parent' where account_id = $1`, [
      GUARDIAN_ACCOUNT_ID,
    ]);
  });
});

/* The readiness assertion in the shipped runner is the thing that stops a
   half-applied migration reading as a successful dispatch. Writing one is not
   the same as having one that works, so these drive the REAL runner rather
   than restating its query here -- `applyMigrationTransaction` is imported
   out of the shipped file, so this cannot stay green while that rots. */
describe('observation author role runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const { applyMigrationTransaction } = await nativeDynamicImport(
      pathToFileURL(
        path.resolve(__dirname, '../../../scripts/pilot-apply-observation-author-role-migration.mjs'),
      ).href,
    ) as { applyMigrationTransaction: (client: Client, sql: string) => Promise<void> };

    const fresh = await freshDatabase('obsrole_rdy_no');
    try {
      // `select 1` stands in for a migration that did nothing: the runner must
      // judge the DATABASE, not whether some SQL happened to execute.
      await expect(applyMigrationTransaction(fresh, 'select 1')).rejects.toThrow(
        /OBSERVATION_AUTHOR_ROLE_NOT_READY/,
      );
    } finally {
      await fresh.end();
    }
  });

  test('the real runner ACCEPTS a migrated database, and a re-apply stays a no-op', async () => {
    const { applyMigrationTransaction } = await nativeDynamicImport(
      pathToFileURL(
        path.resolve(__dirname, '../../../scripts/pilot-apply-observation-author-role-migration.mjs'),
      ).href,
    ) as { applyMigrationTransaction: (client: Client, sql: string) => Promise<void> };

    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    const fresh = await freshDatabase('obsrole_rdy_ok');
    try {
      await applyMigrationTransaction(fresh, sql);
      // The `all` chain re-runs every migration on every dispatch, so the
      // second pass has to survive its own first pass.
      await applyMigrationTransaction(fresh, sql);
    } finally {
      await fresh.end();
    }
  });
});
