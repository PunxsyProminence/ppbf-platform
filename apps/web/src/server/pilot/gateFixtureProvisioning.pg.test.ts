/*
  The gate fixture provisioner had no test, while creating an organization, an
  athlete, memberships, and privileged accounts -- and it now creates two more,
  one of them a platform_owner, the most privileged role in the vocabulary.

  These run the real script as a subprocess against a real Postgres rather than
  importing it: the file executes on import and calls process.exit on failure,
  so the subprocess IS the unit. That also means what is exercised here is the
  actual entry point the workflow invokes, not a re-implementation of it.

  What matters most and is asserted hardest: neither probe fixture may carry a
  pin_hash. They are Microsoft-authenticated by construction, reachable only by
  a caller that can already read the database. A PIN on either would put a
  privileged credential on a publicly reachable staging login -- which is
  audit PPBF-SEC-002, already paid for once.
*/

import { type ChildProcessByStdio, spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { Client } from 'pg';

const execFileAsync = promisify(execFile);

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gate-fixtures-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const PROVISIONER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-provision-gate-fixtures.mjs',
);

const ORG = 'gate-fixture-org';
const ADMIN_ID = 'org_admin_shadow';
const ATHLETE_ACCOUNT_ID = 'gate_shadow_athlete';
const ATHLETE_ID = 'GATE-SHADOW-ATH-1';
const ATHLETE_PIN = '481902';
const COACH_ID = 'gate_probe_coach';
const OWNER_ID = 'gate_probe_platform_owner';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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
  return client;
}

/** Runs the real provisioner against `database`, with the probe vars optional. */
async function provision(
  database: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string }> {
  const connectionString = connectionStringFor(database);
  const { stdout } = await execFileAsync(process.execPath, [PROVISIONER_PATH], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
      AZURE_POSTGRES_CONNECTION_STRING: connectionString,
      // The write-target guard parses the connection string and demands the
      // caller named the same host and database.
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
      PPBF_EXPECTED_POSTGRES_DATABASE: database,
      PPBF_PILOT_DEFAULT_ORG_ID: ORG,
      PILOT_ADMIN_ACCOUNT_ID: ADMIN_ID,
      PILOT_SHADOW_ATHLETE_ACCOUNT_ID: ATHLETE_ACCOUNT_ID,
      PILOT_SHADOW_ATHLETE_ID: ATHLETE_ID,
      PILOT_SHADOW_ATHLETE_PIN: ATHLETE_PIN,
      ...extraEnv,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout };
}

const PROBE_ENV = {
  PILOT_PROBE_COACH_ACCOUNT_ID: COACH_ID,
  PILOT_PROBE_PLATFORM_OWNER_ACCOUNT_ID: OWNER_ID,
};

async function accountRow(client: Client, accountId: string) {
  const { rows } = await client.query(
    `select role, auth_provider, pin_hash, active_flag, must_change_pin, organization_id
     from pilot.accounts where account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
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

describe('probe fixtures', () => {
  test('provisions a coach and a platform_owner that gate-session can use', async () => {
    const client = await freshDatabase('ppbf_test_gate_fixtures_probe');
    try {
      await provision('ppbf_test_gate_fixtures_probe', PROBE_ENV);

      for (const [accountId, role] of [[COACH_ID, 'coach'], [OWNER_ID, 'platform_owner']]) {
        const account = await accountRow(client, accountId);
        expect(account).not.toBeNull();
        expect(account.role).toBe(role);
        expect(account.active_flag).toBe(true);
        expect(account.organization_id).toBe(ORG);

        // gate-session.mjs refuses any privileged ppbf_local account, because
        // resolvePrincipal revokes such a session on sight. A fixture that is
        // not 'microsoft' would be destroyed by its own first use.
        expect(account.auth_provider).toBe('microsoft');

        // The one that would be a real incident.
        expect(account.pin_hash).toBeNull();

        const { rows } = await client.query(
          `select role, active_flag from pilot.organization_memberships
           where account_id = $1 and organization_id = $2`,
          [accountId, ORG],
        );
        // resolvePrincipal joins memberships; without an active one every
        // request answers 401 with nothing indicating why.
        expect(rows).toEqual([{ role, active_flag: true }]);
      }
    } finally {
      await client.end();
    }
  });

  test('is idempotent, and a re-run does not reintroduce a PIN', async () => {
    const client = await freshDatabase('ppbf_test_gate_fixtures_idempotent');
    try {
      await provision('ppbf_test_gate_fixtures_idempotent', PROBE_ENV);
      await provision('ppbf_test_gate_fixtures_idempotent', PROBE_ENV);

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.accounts where account_id = any($1)`,
        [[COACH_ID, OWNER_ID]],
      );
      expect(rows[0].n).toBe(2);
      expect((await accountRow(client, OWNER_ID)).pin_hash).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The reason they are optional: this script runs in a working pipeline, and a
  // required variable would fail the next staging deploy for anyone who has not
  // set it. Skipping must leave no partial account behind.
  test('creates neither fixture when the variables are unset, and says so', async () => {
    const client = await freshDatabase('ppbf_test_gate_fixtures_absent');
    try {
      const { stdout } = await provision('ppbf_test_gate_fixtures_absent');

      expect(await accountRow(client, COACH_ID)).toBeNull();
      expect(await accountRow(client, OWNER_ID)).toBeNull();

      // Silence would read as "provisioned"; the skip has to be visible.
      expect(stdout).toContain('SKIPPED the coach probe fixture');
      expect(stdout).toContain('SKIPPED the platform_owner probe fixture');

      // The pre-existing fixtures are unaffected by the new code path.
      expect((await accountRow(client, ADMIN_ID)).role).toBe('organization_admin');
      expect((await accountRow(client, ATHLETE_ACCOUNT_ID)).role).toBe('athlete');
    } finally {
      await client.end();
    }
  });

  test('still refuses a database the caller did not name', async () => {
    await expect(
      provision('ppbf_test_gate_fixtures_absent', {
        PPBF_EXPECTED_POSTGRES_DATABASE: 'some_other_database',
      }),
    ).rejects.toThrow(/POSTGRES_TARGET_MISMATCH/);
  });
});
