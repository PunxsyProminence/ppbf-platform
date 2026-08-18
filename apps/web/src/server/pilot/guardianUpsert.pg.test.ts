// Real PostgreSQL-backed contract test for upsertGuardian's on-conflict
// behaviour (capability-network audit, 2026-08-18 -- "a coach can overwrite
// another family's guardian record").
//
// What needs proving that reading SQL cannot prove: an INSERT ... ON CONFLICT
// DO UPDATE with a plain `= excluded.column` clause overwrites unconditionally
// -- including with NULL when the caller omitted the field -- and that is
// exactly the behaviour this suite pins is now GONE. account_id, phone and
// email must survive an upsert that omits them; full_name must still update,
// since both real callers always supply one.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_guardian_upsert';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-upsert-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const BASE_SCHEMA_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

const ORG_ID = 'org-guardian-upsert';
const OTHER_ORG_ID = 'org-guardian-upsert-elsewhere';
const ADMIN_ID = 'acct-guardian-upsert-admin';
const GUARDIAN_ACCOUNT_ID = 'acct-guardian-upsert-parent';

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

async function readParent(organizationId: string, parentId: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    'select * from pilot.parents where organization_id = $1 and parent_id = $2',
    [organizationId, parentId],
  );
  return result.rows[0];
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

beforeEach(async () => {
  // cascade: pilot.athlete_guardian_links (and any other FK referencing
  // pilot.parents) is truncated along with it. This suite only asserts
  // against pilot.parents rows, so the cascade is harmless here.
  await client.query('truncate pilot.parents cascade');
});

describe('upsertGuardian', () => {
  test('creates a new guardian row with every field supplied', async () => {
    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-1',
      accountId: GUARDIAN_ACCOUNT_ID,
      fullName: 'Guardian One',
      phone: '555-0100',
      email: 'guardian-one@example.test',
    });

    const row = await readParent(ORG_ID, 'parent-1');
    expect(row).toMatchObject({
      account_id: GUARDIAN_ACCOUNT_ID,
      full_name: 'Guardian One',
      phone: '555-0100',
      email: 'guardian-one@example.test',
    });
  });

  test('an upsert that omits account_id, phone and email preserves the existing values, not NULLs them', async () => {
    // This is the audit finding, pinned directly: a second write to the same
    // parent_id that does not carry these fields -- exactly what happens when
    // a caller's request body simply did not include them -- used to wipe a
    // real guardian's account link and contact details.
    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-2',
      accountId: GUARDIAN_ACCOUNT_ID,
      fullName: 'Guardian Two',
      phone: '555-0200',
      email: 'guardian-two@example.test',
    });

    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-2',
      fullName: 'Guardian Two',
      // account_id, phone, email all omitted -- undefined, not empty string.
    });

    const row = await readParent(ORG_ID, 'parent-2');
    expect(row).toMatchObject({
      account_id: GUARDIAN_ACCOUNT_ID,
      phone: '555-0200',
      email: 'guardian-two@example.test',
    });
  });

  test('a supplied value still overwrites the previous one', async () => {
    // Preserving on omission must not mean the field can never change again.
    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-3',
      fullName: 'Guardian Three',
      phone: '555-0300',
      email: 'old@example.test',
    });

    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-3',
      fullName: 'Guardian Three',
      phone: '555-0301',
      email: 'new@example.test',
    });

    const row = await readParent(ORG_ID, 'parent-3');
    expect(row).toMatchObject({ phone: '555-0301', email: 'new@example.test' });
  });

  test('full_name still overwrites unconditionally, since it is not optional at either call site', async () => {
    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-4',
      fullName: 'Original Name',
    });

    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-4',
      fullName: 'Corrected Name',
    });

    const row = await readParent(ORG_ID, 'parent-4');
    expect(row.full_name).toBe('Corrected Name');
  });

  test('a guardian record in one organization is untouched by the same parent_id in another', async () => {
    await intake.upsertGuardian({
      organizationId: ORG_ID,
      parentId: 'parent-shared-id',
      accountId: GUARDIAN_ACCOUNT_ID,
      fullName: 'Org A Guardian',
      phone: '555-0400',
    });

    await intake.upsertGuardian({
      organizationId: OTHER_ORG_ID,
      parentId: 'parent-shared-id',
      fullName: 'Org B Guardian',
    });

    const rowA = await readParent(ORG_ID, 'parent-shared-id');
    expect(rowA).toMatchObject({ full_name: 'Org A Guardian', phone: '555-0400' });
  });
});
