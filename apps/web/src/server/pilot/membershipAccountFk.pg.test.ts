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
   in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-membership-account-fk-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_membership_account_fk_migration.sql');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-membership-account-fk-migration.mjs',
);

const ORG_ID = 'org-membership-fk';
const PARENT_ACCOUNT = 'parent.guardian@example.test';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/**
 * A guardian as the platform really holds one: an account, and the membership
 * row resolvePrincipal() joins to authenticate them. The account id is written
 * as an email address on purpose -- that is what an account_id resolves to on
 * this platform unless an admin supplied a hint -- because what this migration
 * is about is that address surviving the purge.
 */
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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft')`,
    [PARENT_ACCOUNT, ORG_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'parent', true)`,
    [PARENT_ACCOUNT, ORG_ID],
  );

  return client;
}

async function membershipRows(client: Client): Promise<string[]> {
  const result = await client.query<{ account_id: string }>(
    `select account_id from pilot.organization_memberships where organization_id = $1`,
    [ORG_ID],
  );
  return result.rows.map((row) => row.account_id);
}

async function constraintShape(client: Client) {
  const result = await client.query<{ confdeltype: string; convalidated: boolean }>(
    `select confdeltype, convalidated from pg_constraint
      where conname = 'pilot_organization_memberships_account_fk'
        and conrelid = to_regclass('pilot.organization_memberships')`,
  );
  return result.rows[0] ?? null;
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
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');
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

describe('the leak, before anything is changed', () => {
  /* THE BEFORE STATE IS MEASURED, NOT ASSUMED. Without this the migration
     below would be a tidy-up with no demonstrated cause, and a reader could
     not tell whether the foreign key was ever load-bearing. */
  it('purging the account leaves the account id behind in a membership row', async () => {
    const client = await freshDatabase('ppbf_test_membership_fk_before');
    try {
      // The column really is unconstrained today.
      expect(await constraintShape(client)).toBeNull();

      await client.query('delete from pilot.accounts where account_id = $1', [PARENT_ACCOUNT]);

      const account = await client.query('select 1 from pilot.accounts where account_id = $1', [
        PARENT_ACCOUNT,
      ]);
      expect(account.rowCount).toBe(0);

      /* And here is the finding: the account is gone and the row that names
         them is not. An account_id resolves to a login email, so what survives
         a purge meant to remove that person's details IS that person's email
         address, in a table nobody would think to look in. */
      expect(await membershipRows(client)).toEqual([PARENT_ACCOUNT]);
    } finally {
      await client.end();
    }
  });
});

describe('what the migration changes', () => {
  it('adds a validated cascading foreign key', async () => {
    const client = await freshDatabase('ppbf_test_membership_fk_shape');
    try {
      await client.query(migrationSql);
      // 'c' is CASCADE. 'a' (no action) or 'r' (restrict) would turn a
      // missing-cascade problem into a blocked-purge problem, which is the
      // defect pilot.parents already had.
      expect(await constraintShape(client)).toEqual({ confdeltype: 'c', convalidated: true });
    } finally {
      await client.end();
    }
  });

  it('takes the membership row with the account', async () => {
    const client = await freshDatabase('ppbf_test_membership_fk_after');
    try {
      await client.query(migrationSql);
      await client.query('delete from pilot.accounts where account_id = $1', [PARENT_ACCOUNT]);
      expect(await membershipRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('re-applying is a no-op, so `all` can run it against any environment', async () => {
    const client = await freshDatabase('ppbf_test_membership_fk_idempotent');
    try {
      await client.query(migrationSql);
      const first = await constraintShape(client);
      await client.query(migrationSql);
      expect(await constraintShape(client)).toEqual(first);
    } finally {
      await client.end();
    }
  });

  it('refuses a membership naming an account that does not exist', async () => {
    /* The forward-looking half. The cascade cleans up after a delete; this is
       the constraint refusing to let the bad row be written in the first
       place, which is what "validated" buys over `not valid`. */
    const client = await freshDatabase('ppbf_test_membership_fk_forward');
    try {
      await client.query(migrationSql);
      await expect(
        client.query(
          `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
           values ('nobody@example.test', $1, 'parent', true)`,
          [ORG_ID],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  it('refuses to apply at all against a database that already holds an orphan', async () => {
    /* Deliberate, and the alternative was worse. A `not valid` constraint
       would apply cleanly here and then record for ever that the existing rows
       were never checked -- the state
       pilot_slice_postgres_discipline_fk_validation exists to clean up
       elsewhere in this schema. Failing loudly with a countable cause is the
       better outcome, and deleting the orphan is a data decision this
       migration does not take. */
    const client = await freshDatabase('ppbf_test_membership_fk_orphan');
    try {
      await client.query('delete from pilot.accounts where account_id = $1', [PARENT_ACCOUNT]);
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: '23503' });
      // Nothing was created, so a later run can try again once the orphan is
      // dealt with.
      expect(await constraintShape(client)).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('the runner refuses a database the migration did not reach', () => {
  async function loadRunner() {
    return nativeDynamicImport(pathToFileURL(RUNNER_PATH).href) as Promise<{
      applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
    }>;
  }

  it('accepts the real migration, and accepts it twice', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_membership_fk_runner_ok');
    try {
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      expect(await constraintShape(client)).toEqual({ confdeltype: 'c', convalidated: true });
    } finally {
      await client.end();
    }
  });

  it('throws when the SQL did not create the constraint', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_membership_fk_runner_unmigrated');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'MEMBERSHIP_ACCOUNT_FK_NOT_READY',
      );
      expect(await constraintShape(client)).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('throws when the constraint was created without the cascade', async () => {
    /* The dangerous near-miss. A foreign key that RESTRICTS here reads as
       migrated, satisfies "the column is constrained now", and makes retention
       WORSE than the missing constraint did -- the purge would start failing
       on the membership row instead of leaving it. The readiness query pins
       the delete action so that database is refused. */
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_membership_fk_runner_restrict');
    try {
      await expect(
        applyMigrationTransaction(
          client,
          `alter table pilot.organization_memberships
             add constraint pilot_organization_memberships_account_fk
             foreign key (account_id) references pilot.accounts(account_id);`,
        ),
      ).rejects.toThrow('MEMBERSHIP_ACCOUNT_FK_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
