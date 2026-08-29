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
   same reason, as the other migration-runner suites. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-parent-fk-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_waiver_parent_fk_migration.sql');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-waiver-parent-fk-migration.mjs',
);

const ORG_ID = 'org-waiver-parent-fk';
const OTHER_ORG_ID = 'org-waiver-parent-fk-elsewhere';
const COACH_ID = 'acct-waiver-parent-fk-coach';
const ATHLETE_ID = 'ATH-WAIVER-PARENT-FK';
const PARENT_ID = 'PAR-WAIVER-PARENT-FK';

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
 * A database with the schema as it stands BEFORE this migration: the base
 * schema plus the guardian-media-consent migration, which is what creates
 * pilot_waivers_parent_fk in its broken whole-key form.
 *
 * Seeded with one organization, one athlete, one guardian record and one
 * waiver pointing at that guardian -- the smallest arrangement in which
 * deleting a pilot.parents row has anything to cascade to.
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

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Waiver Subject', '2013-04-05', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  // account_id null on purpose: a guardian recorded from paper, with no login.
  // The defect is about the pilot.parents row, not about accounts.
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, $2, null, 'Dana Guardian', '555-0100', 'dana@example.test')`,
    [ORG_ID, PARENT_ID],
  );
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
        signed_at, consent_version, status, parent_id)
     values ($1, '5c1d0e00-1111-4222-8333-444455556666', $2, 'photo_media', 'Dana Guardian',
             'parent', now(), 'v1', 'signed', $3)`,
    [ORG_ID, ATHLETE_ID, PARENT_ID],
  );

  return client;
}

async function deleteTheGuardianRecord(client: Client) {
  return client.query(
    `delete from pilot.parents where organization_id = $1 and parent_id = $2`,
    [ORG_ID, PARENT_ID],
  );
}

async function constraintShape(client: Client) {
  const result = await client.query<{ confdeltype: string; confdelsetcols: number[] | null }>(
    `select confdeltype, confdelsetcols from pg_constraint
      where conname = 'pilot_waivers_parent_fk' and conrelid = to_regclass('pilot.waivers')`,
  );
  return result.rows[0] ?? null;
}

async function parentIdAttnum(client: Client): Promise<number> {
  const result = await client.query<{ attnum: number }>(
    `select attnum from pg_attribute
      where attrelid = to_regclass('pilot.waivers') and attname = 'parent_id'`,
  );
  return result.rows[0].attnum;
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

  /* pilot_waivers_parent_fk is created by the guardian-media-consent
     migration, in the whole-key SET NULL shape this migration corrects, so the
     "before" state needs both files. Concatenated so every freshDatabase()
     gets the same starting point. */
  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8')
    + '\n'
    + await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_guardian_media_consent_migration.sql'), 'utf8',
    );
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

describe('the defect, before anything is changed', () => {
  /* THE BEFORE STATE IS MEASURED, NOT ASSUMED. Without this, every test below
     would pass on a schema that never had the problem, and the suite would be
     proving nothing. The error is asserted by SQLSTATE and column, because
     23502 naming organization_id is the whole finding: a SET NULL over a
     composite key nulls the tenant column too. */
  it('deleting a guardian record with waivers fails on the NOT NULL tenant column', async () => {
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_before');
    try {
      const shape = await constraintShape(client);
      expect(shape).toEqual({ confdeltype: 'n', confdelsetcols: null });

      await expect(deleteTheGuardianRecord(client)).rejects.toMatchObject({
        code: '23502',
        column: 'organization_id',
      });
    } finally {
      await client.end();
    }
  });
});

describe('what the migration changes', () => {
  it('scopes the referential action to parent_id alone', async () => {
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_shape');
    try {
      await client.query(migrationSql);
      expect(await constraintShape(client)).toEqual({
        confdeltype: 'n',
        confdelsetcols: [await parentIdAttnum(client)],
      });
    } finally {
      await client.end();
    }
  });

  it('lets the guardian record go, and keeps the waiver whole', async () => {
    /* The behaviour the constraint always meant. Everything a waiver IS
       survives -- purging a withdrawn family must never destroy the document
       that authorised a minor's participation -- and the only thing lost is
       the pointer to a guardian record that no longer exists. */
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_after');
    try {
      await client.query(migrationSql);
      const deleted = await deleteTheGuardianRecord(client);
      expect(deleted.rowCount).toBe(1);

      const waiver = await client.query<{
        organization_id: string;
        parent_id: string | null;
        signed_by_name: string;
        waiver_type: string;
        status: string;
      }>(
        `select organization_id, parent_id, signed_by_name, waiver_type, status
           from pilot.waivers where organization_id = $1`,
        [ORG_ID],
      );
      expect(waiver.rowCount).toBe(1);
      expect(waiver.rows[0].parent_id).toBeNull();
      // The tenant column is the one that used to be nulled. It is untouched.
      expect(waiver.rows[0].organization_id).toBe(ORG_ID);
      expect(waiver.rows[0].signed_by_name).toBe('Dana Guardian');
      expect(waiver.rows[0].waiver_type).toBe('photo_media');
      expect(waiver.rows[0].status).toBe('signed');
    } finally {
      await client.end();
    }
  });

  it('re-applying is a no-op, so `all` can run it against any environment', async () => {
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_idempotent');
    try {
      await client.query(migrationSql);
      const first = await constraintShape(client);
      await client.query(migrationSql);
      expect(await constraintShape(client)).toEqual(first);

      // And the corrected behaviour survives the second application.
      expect((await deleteTheGuardianRecord(client)).rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('still refuses a waiver naming a guardian in another organization', async () => {
    /* The composite key is not being weakened, only its delete action scoped.
       Tenancy is the reason the key is composite in the first place, so this
       asserts the constraint still does the job it was added for. */
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_tenancy');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
         values ($1, 'PAR-ELSEWHERE', null, 'Other Org Guardian')`,
        [OTHER_ORG_ID],
      );

      await expect(
        client.query(
          `update pilot.waivers set parent_id = 'PAR-ELSEWHERE' where organization_id = $1`,
          [ORG_ID],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});

describe('the runner refuses a database the migration did not correct', () => {
  async function loadRunner() {
    return nativeDynamicImport(pathToFileURL(RUNNER_PATH).href) as Promise<{
      applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
    }>;
  }

  it('accepts the real migration, and accepts it twice', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_runner_ok');
    try {
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      expect(await constraintShape(client)).toEqual({
        confdeltype: 'n',
        confdelsetcols: [await parentIdAttnum(client)],
      });
    } finally {
      await client.end();
    }
  });

  it('throws when the SQL left the whole-key form in place', async () => {
    /* A constraint by this name was ALREADY present before this migration, in
       exactly the shape that is the defect. A readiness check that only asked
       whether the name exists would report success on every unmigrated
       database in the fleet. */
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_runner_unmigrated');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'WAIVER_PARENT_FK_NOT_READY',
      );
      // Rolled back rather than leaving a half-corrected database.
      expect(await constraintShape(client)).toEqual({ confdeltype: 'n', confdelsetcols: null });
    } finally {
      await client.end();
    }
  });

  it('throws when organization_id was made nullable instead', async () => {
    /* THE WRONG FIX, REFUSED. Faced with `23502: null value in column
       "organization_id"`, the reflex is to drop the NOT NULL. That trades a
       failed delete for a tenancy hole: every projection, gate and index in
       this schema keys on organization_id.

       POSTGRES ALREADY REFUSES THE EASY VERSION, and this test says so rather
       than taking credit for it: organization_id is half of
       pilot_waivers_pk, so `drop not null` on its own fails with `column
       "organization_id" is in a primary key`. Measured, not assumed -- the
       first version of this test tried exactly that and got that error.

       So the state the runner assertion actually guards is the one reachable
       only by dropping the primary key first, which is what this does. It is
       an unlikely state, and it is written out here precisely so the
       assertion is watched failing rather than carried as decoration. */
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_waiver_parent_fk_runner_nullable_org');
    try {
      await expect(
        client.query('alter table pilot.waivers alter column organization_id drop not null'),
      ).rejects.toThrow(/primary key/);

      await client.query('alter table pilot.waivers drop constraint pilot_waivers_pk');
      await client.query('alter table pilot.waivers alter column organization_id drop not null');

      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        'WAIVER_PARENT_FK_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });
});
