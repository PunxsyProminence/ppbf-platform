// Real PostgreSQL-backed test for pilot-check-stranded-guardians.mjs.
//
// Spins up a disposable, local-only embedded Postgres instance (see
// scripts/test-embedded-pg-server.mjs). This NEVER connects to production or
// staging.
//
// The condition under test is exactly the one the pre-#46 intake path
// produced: a role='parent' account row whose auth_provider is 'ppbf_local'.
// Today's base schema still permits that combination -- the accounts table
// constrains auth_provider to the two known values and role to the known
// roles, but nothing relates the two columns -- so a fresh database can hold
// stranded rows and the check has to find them by data inspection, not rely
// on the schema having made them impossible.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-stranded-guardian-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECKER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-stranded-guardians.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

interface StrandedAccountRow {
  account_id: string;
  login_email: string | null;
  role: string;
  organization_id: string;
  active_flag: boolean;
  has_pin: boolean;
  parent_ids: string[];
  linked_athlete_count: number;
}

interface StrandedGuardianReport {
  accounts: StrandedAccountRow[];
  byRole: Array<{ role: string; account_count: number; active_count: number }>;
}

// A plain `await import(specifier)` gets downleveled by ts-jest's CommonJS
// transform into require(), which cannot load a real ESM-only .mjs file.
// Constructing the import() call inside `new Function` hides it from that
// downleveling, so it remains a genuine dynamic import Node's own ESM loader
// executes at runtime -- the same technique multiorgOrphanCheck.pg.test.ts
// uses for the same reason.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{
  checkStrandedGuardians: (client: Client) => Promise<StrandedGuardianReport>;
  maskEmail: (email: string | null) => string;
}>;

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

async function newTestDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
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

describe('checkStrandedGuardians', () => {
  let client: Client;
  const ORG = 'gym-1';

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_stranded_guardians');
    await client.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status, created_at, updated_at)
       values ($1, 'Gym One', 'active', now(), now())`,
      [ORG],
    );

    // A healthy population that must NOT be reported:
    //   - a Microsoft-provisioned parent (the post-#46 forward path),
    //   - a PIN athlete (ppbf_local is the correct provider for athletes),
    //   - a Microsoft coach (also the athlete fixture's required coach FK).
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values
         ('parent-ms', 'healthy.parent@example.com', 'microsoft', 'parent', $1, false, null, null, true),
         ('athlete-1', null, 'ppbf_local', 'athlete', $1, false, 'ath-1', 'hash', true),
         ('coach-ms', 'coach@example.com', 'microsoft', 'coach', $1, false, null, null, true)`,
      [ORG],
    );
    // pilot.athletes declares created_at/updated_at NOT NULL with no defaults,
    // so they are passed explicitly (the omission broke the gate in #60).
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values
         ($1, 'ath-1', 'Athlete One', '2012-01-01', 'bantam', 'active', 'contact', true, 'coach-ms', now(), now()),
         ($1, 'ath-2', 'Athlete Two', '2011-06-15', 'fly', 'active', 'contact', true, 'coach-ms', now(), now())`,
      [ORG],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  test('a healthy database reports no stranded accounts', async () => {
    const { checkStrandedGuardians } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const report = await checkStrandedGuardians(client);

    expect(report.accounts).toEqual([]);
    expect(report.byRole).toEqual([]);
  });

  test('finds a pre-#46 guardian: parent role on ppbf_local, with its athlete links counted', async () => {
    // Exactly what createParentAccount used to write: a parent with a PIN
    // hash and the ppbf_local provider, plus the guardian records the intake
    // path also created around it.
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values ('parent-stranded', 'stranded.parent@example.com', 'ppbf_local', 'parent', $1, false, null, 'hash', true)`,
      [ORG],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, 'par-1', 'parent-stranded', 'Stranded Parent')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'par-1', 'ath-1', 'guardian'), ($1, 'par-1', 'ath-2', 'guardian')`,
      [ORG],
    );

    const { checkStrandedGuardians } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const report = await checkStrandedGuardians(client);

    expect(report.accounts).toHaveLength(1);
    const [stranded] = report.accounts;
    expect(stranded.account_id).toBe('parent-stranded');
    expect(stranded.role).toBe('parent');
    expect(stranded.has_pin).toBe(true);
    expect(stranded.parent_ids).toEqual(['par-1']);
    // ::int in the query, because count(*) is a bigint and node-postgres
    // serializes bigint as a string -- the same wire-format trap #67 fixed.
    expect(stranded.linked_athlete_count).toBe(2);

    expect(report.byRole).toEqual([{ role: 'parent', account_count: 1, active_count: 1 }]);
  });

  test('reports any non-athlete role on ppbf_local, not only parents -- and never the athletes', async () => {
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values ('coach-legacy', null, 'ppbf_local', 'coach', $1, false, null, 'hash', false)`,
      [ORG],
    );

    const { checkStrandedGuardians } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const report = await checkStrandedGuardians(client);

    expect(report.accounts.map((a) => a.account_id).sort()).toEqual(['coach-legacy', 'parent-stranded']);
    const coachRow = report.accounts.find((a) => a.account_id === 'coach-legacy');
    expect(coachRow?.active_flag).toBe(false);
    expect(coachRow?.parent_ids).toEqual([]);
    expect(coachRow?.linked_athlete_count).toBe(0);

    // The PIN athlete is the one legitimate ppbf_local population; it must
    // stay out of the report no matter how the rest of the data looks.
    expect(report.accounts.some((a) => a.role === 'athlete')).toBe(false);

    expect(report.byRole).toEqual([
      { role: 'coach', account_count: 1, active_count: 0 },
      { role: 'parent', account_count: 1, active_count: 1 },
    ]);
  });
});

describe('maskEmail', () => {
  test('keeps only the first character of the local part and the domain', async () => {
    const { maskEmail } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    expect(maskEmail('stranded.parent@example.com')).toBe('s**************@example.com');
  });

  test('a null email renders as a placeholder instead of crashing', async () => {
    const { maskEmail } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    expect(maskEmail(null)).toBe('(none)');
  });
});
