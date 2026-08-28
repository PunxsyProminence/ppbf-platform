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
const PG_DATABASE = 'ppbf_test_waiver_recorded_by';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-recorded-by-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const BASE_SCHEMA_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

const ORG_ID = 'org-waiver-rec';
const OTHER_ORG_ID = 'org-waiver-rec-elsewhere';
const ADMIN_ID = 'acct-waiver-rec-admin';
const GUARDIAN_ACCOUNT_ID = 'acct-waiver-rec-parent';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type IntakeModule = typeof import('./intake');
let intake: IntakeModule;
type DataDeletionModule = typeof import('./dataDeletion');
let dataDeletion: DataDeletionModule;
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

  /* upsertWaiver inserts parent_id, covers_video and public_use_allowed, which
     the base schema does not define -- they arrive with the guardian
     media-consent migration. Applied here so the writer tests exercise the
     real INSERT rather than a trimmed one. The runner tests below deliberately
     do NOT get it: they build their own databases from the base schema alone,
     because what they measure is this migration's own readiness assertion. */
  await client.query(
    await fs.readFile(
      path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_guardian_media_consent_migration.sql'),
      'utf8',
    ),
  );

  /* pilot.accounts.deleted_at, which the retention purge selects on, arrives
     with the data-retention migration. Applied so the retention test below
     can run the REAL purgeExpiredDeletedData() rather than a hand-written
     delete that resembles it. */
  await client.query(
    await fs.readFile(
      path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql'),
      'utf8',
    ),
  );

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

  // pilot.waivers has a foreign key onto (organization_id, athlete_id), and
  // pilot.athletes.coach_id has one onto an account -- so the subject of every
  // waiver below has to be a real athlete of a real coach.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Waiver Subject', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, 'ATH-WAIVER-REC', ADMIN_ID],
  );

  // Env before import: db.ts reads the connection string when its pool is
  // first built, so the dynamic import has to come after this.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  intake = await import('./intake');
  dataDeletion = await import('./dataDeletion');
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
  '../../../../../infra/azure/pilot_slice_postgres_waiver_recorded_by_migration.sql',
);
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-waiver-recorded-by-migration.mjs',
);
const ATHLETE_ID = 'ATH-WAIVER-REC';

/* Each runner test needs its own database: one that never saw the migration
   (to prove the readiness assertion refuses) and one that did (to prove it
   accepts, twice). The shared `client` above is migrated by the time they
   run, so it cannot answer the first question. */
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

async function applyMigration(): Promise<unknown> {
  return client.query(await fs.readFile(MIGRATION_PATH, 'utf8'));
}

async function columnRow(target: Client, column: string) {
  const result = await target.query<{ data_type: string; is_nullable: string }>(
    `select data_type, is_nullable from information_schema.columns
      where table_schema = 'pilot' and table_name = 'waivers' and column_name = $1`,
    [column],
  );
  return result.rows[0] ?? null;
}

describe('the column the migration adds', () => {
  /* THE BEFORE STATE IS ASSERTED, NOT ASSUMED. Without this, every test below
     would pass on a database that already had the column for some other
     reason, and the suite would be measuring nothing. The base schema is
     rebuilt from pilot_slice_postgres.sql, which is where pilot.waivers is
     defined without it. */
  it('is genuinely absent before the migration runs', async () => {
    const fresh = await freshDatabase('ppbf_test_waiver_rec_absent');
    try {
      expect(await columnRow(fresh, 'recorded_by_account_id')).toBeNull();
      // The column it must NOT be confused with is present from the start.
      expect(await columnRow(fresh, 'signed_by_name')).not.toBeNull();
    } finally {
      await fresh.end();
    }
  });

  it('arrives nullable, as text, and re-applying is a no-op', async () => {
    await applyMigration();
    expect(await columnRow(client, 'recorded_by_account_id')).toEqual({
      data_type: 'text',
      is_nullable: 'YES',
    });

    // Idempotent: the runner may be dispatched against an already-migrated
    // environment, and must not fail there.
    await applyMigration();
    expect(await columnRow(client, 'recorded_by_account_id')).toEqual({
      data_type: 'text',
      is_nullable: 'YES',
    });
  });

  it('NULLABLE is the point, not an oversight', async () => {
    /* Every row written before this migration has no recorded entrant, and
       there is no honest way to invent one. A future edit tightening this to
       NOT NULL could only be satisfied by backfilling an account nobody
       recorded -- the single thing this column exists to avoid. The runner's
       readiness query asserts the same property, so that edit fails twice. */
    expect((await columnRow(client, 'recorded_by_account_id'))?.is_nullable).toBe('YES');
  });

  it('carries a foreign key, so an entrant cannot be a string nobody has', async () => {
    const constraint = await client.query<{ conname: string }>(
      `select conname from pg_constraint
        where conname = 'pilot_waivers_recorded_by_fk'
          and conrelid = to_regclass('pilot.waivers') and contype = 'f'`,
    );
    expect(constraint.rowCount).toBe(1);

    await expect(
      client.query(
        `insert into pilot.waivers
           (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
            signed_at, consent_version, status, recorded_by_account_id)
         values ($1, gen_random_uuid(), $2, 'travel', 'Paper Signature', 'guardian',
                 now(), 'v1', 'signed', 'acct-nobody-has-this')`,
        [ORG_ID, ATHLETE_ID],
      ),
    ).rejects.toThrow();
  });
});

describe('what upsertWaiver records', () => {
  async function latestWaiver() {
    const row = await client.query<{ signed_by_name: string; recorded_by_account_id: string | null }>(
      `select signed_by_name, recorded_by_account_id from pilot.waivers
        where organization_id = $1 and athlete_id = $2
        order by created_at desc limit 1`,
      [ORG_ID, ATHLETE_ID],
    );
    return row.rows[0];
  }

  it('stores the entrant and the signer as two different facts', async () => {
    /* The whole point of the column, in one assertion. A staff member types
       what a guardian signed on paper: the signer has no account here, the
       entrant does, and conflating them is what this ends. */
    await intake.upsertWaiver({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      waiverType: 'travel',
      signedByName: 'Dana Guardian (from the paper form)',
      signedByRole: 'guardian',
      signedAt: new Date().toISOString(),
      consentVersion: 'v1',
      status: 'signed',
      recordedByAccountId: ADMIN_ID,
    });

    const waiver = await latestWaiver();
    expect(waiver.recorded_by_account_id).toBe(ADMIN_ID);
    expect(waiver.signed_by_name).toBe('Dana Guardian (from the paper form)');
    // Said explicitly: the entrant is NOT claimed to be the signer.
    expect(waiver.recorded_by_account_id).not.toBe(waiver.signed_by_name);
  });

  it('a row written before the migration keeps a null entrant, and is not backfilled', async () => {
    /* Pre-existing rows are the reason this column is nullable. Inserted
       directly, the way a row that predates the migration exists, and then
       re-applying the migration must leave it alone -- a backfill would
       manufacture provenance indistinguishable from the real thing. */
    const waiverId = '11111111-2222-4333-8444-555555555555';
    await client.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
          signed_at, consent_version, status)
       values ($1, $2, $3, 'medical_release', 'Older Record', 'guardian', now(), 'v1', 'signed')`,
      [ORG_ID, waiverId, ATHLETE_ID],
    );

    await applyMigration();

    const row = await client.query<{ recorded_by_account_id: string | null }>(
      `select recorded_by_account_id from pilot.waivers where organization_id = $1 and waiver_id = $2`,
      [ORG_ID, waiverId],
    );
    expect(row.rows[0].recorded_by_account_id).toBeNull();
  });
});

describe('what happens when the recording account is purged', () => {
  /* THIS IS THE TEST THAT CHANGED THE MIGRATION. The first draft of this
     foreign key had no ON DELETE clause, on the reasoning that an audit column
     should refuse to lose its author. That reasoning was wrong on this
     platform, and only running the real purge showed it: pilot.accounts rows
     for parents ARE hard-deleted once past the retention window, and a
     restricting foreign key would have raised inside the purge transaction --
     taking the athlete delete and the audit insert down with it and leaving
     retention silently doing nothing. */

  const PURGED_PARENT = 'acct-waiver-rec-purged-parent';
  const PURGED_WAIVER_ID = '99999999-8888-4777-8666-555544443333';

  it('nulls the entrant, keeps the waiver, and lets the purge finish', async () => {
    await applyMigration();

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft') on conflict do nothing`,
      [PURGED_PARENT, ORG_ID],
    );
    await client.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
          signed_at, consent_version, status, recorded_by_account_id)
       values ($1, $2, $3, 'media_consent', 'Dana Guardian', 'parent', now(), 'v1', 'signed', $4)`,
      [ORG_ID, PURGED_WAIVER_ID, ATHLETE_ID, PURGED_PARENT],
    );

    // Soft-deleted past the one-year account window the purge selects on.
    await client.query(
      `update pilot.accounts set deleted_at = now() - interval '2 years' where account_id = $1`,
      [PURGED_PARENT],
    );

    const result = await dataDeletion.purgeExpiredDeletedData();

    // Not vacuous: the purge really did remove the account. Without this, a
    // purge that silently matched nothing would pass every assertion below.
    expect(result.rowsDeleted).toBeGreaterThanOrEqual(1);
    const account = await client.query(
      `select 1 from pilot.accounts where account_id = $1`,
      [PURGED_PARENT],
    );
    expect(account.rowCount).toBe(0);

    // The waiver survives -- purging a parent account must never delete the
    // document that authorises a minor's participation -- and what it lost is
    // exactly the identifier the purge exists to remove.
    const waiver = await client.query<{
      signed_by_name: string;
      status: string;
      recorded_by_account_id: string | null;
    }>(
      `select signed_by_name, status, recorded_by_account_id from pilot.waivers
        where organization_id = $1 and waiver_id = $2`,
      [ORG_ID, PURGED_WAIVER_ID],
    );
    expect(waiver.rowCount).toBe(1);
    expect(waiver.rows[0].recorded_by_account_id).toBeNull();
    expect(waiver.rows[0].signed_by_name).toBe('Dana Guardian');
    expect(waiver.rows[0].status).toBe('signed');
  });

  it('declares SET NULL in the catalog, not merely by observed behaviour', async () => {
    /* The behaviour above is what matters, but the catalog value is what a
       future reader diffing two databases can compare. confdeltype: 'n' is
       SET NULL, 'a' is the no-clause default this migration must not go back
       to, and 'c' is the cascade that would delete the waiver itself. */
    const fk = await client.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conname = 'pilot_waivers_recorded_by_fk'
          and conrelid = to_regclass('pilot.waivers')`,
    );
    expect(fk.rows[0].confdeltype).toBe('n');
  });
});

describe('the runner refuses a database the migration never reached', () => {
  /* Writing a readiness query is not the same as having one that works. This
     imports the SHIPPED runner and drives it against a real database, so the
     assertion is exercised rather than merely written. */
  async function loadRunner() {
    return nativeDynamicImport(pathToFileURL(RUNNER_PATH).href) as Promise<{
      applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
    }>;
  }

  it('throws WAIVER_RECORDED_BY_NOT_READY when the SQL did not create the column', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const fresh = await freshDatabase('ppbf_test_waiver_rec_unready');
    try {
      // A no-op statement stands in for a migration that silently did nothing.
      await expect(applyMigrationTransaction(fresh, 'select 1')).rejects.toThrow(
        'WAIVER_RECORDED_BY_NOT_READY',
      );
      // And it rolled back rather than leaving a half-applied database.
      expect(await columnRow(fresh, 'recorded_by_account_id')).toBeNull();
    } finally {
      await fresh.end();
    }
  });

  it('accepts the real migration, and accepts it twice', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    const fresh = await freshDatabase('ppbf_test_waiver_rec_ready');
    try {
      await expect(applyMigrationTransaction(fresh, sql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(fresh, sql)).resolves.toBeUndefined();
      expect(await columnRow(fresh, 'recorded_by_account_id')).toEqual({
        data_type: 'text',
        is_nullable: 'YES',
      });
    } finally {
      await fresh.end();
    }
  });

  it('refuses a database carrying a restricting version of the constraint', async () => {
    /* The migration creates the constraint inside `if not exists (conname
       ...)`. A database that already had an earlier, no-ON-DELETE version of
       this same constraint would keep it and the migration would report
       success -- while the retention purge stayed broken there. The readiness
       query pins confdeltype so that database is refused instead.

       Named identically to the real constraint on purpose: what is being
       tested is that a match on the NAME is not accepted as a match on the
       PROPERTY. */
    const { applyMigrationTransaction } = await loadRunner();
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    const fresh = await freshDatabase('ppbf_test_waiver_rec_restrict');
    try {
      await fresh.query(
        `alter table pilot.waivers add column if not exists recorded_by_account_id text null;
         alter table pilot.waivers add constraint pilot_waivers_recorded_by_fk
           foreign key (recorded_by_account_id) references pilot.accounts(account_id);`,
      );
      await expect(applyMigrationTransaction(fresh, sql)).rejects.toThrow(
        'WAIVER_RECORDED_BY_NOT_READY',
      );
    } finally {
      await fresh.end();
    }
  });

  it('refuses a database that got the column but not the foreign key', async () => {
    /* The column and its constraint are two statements. A database that got
       the first without the second would accept any string as an account id
       while reading as migrated, which is why fk_ready is checked separately. */
    const { applyMigrationTransaction } = await loadRunner();
    const fresh = await freshDatabase('ppbf_test_waiver_rec_no_fk');
    try {
      await expect(
        applyMigrationTransaction(
          fresh,
          'alter table pilot.waivers add column if not exists recorded_by_account_id text null;',
        ),
      ).rejects.toThrow('WAIVER_RECORDED_BY_NOT_READY');
    } finally {
      await fresh.end();
    }
  });
});
