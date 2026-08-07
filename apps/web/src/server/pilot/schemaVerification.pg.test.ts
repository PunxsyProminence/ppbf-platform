// Real PostgreSQL-backed test for the pre-deploy schema verifier.
//
// The verifier replaces the one gate in this pipeline that nothing checks. Both
// deploy workflows ask an operator to attest `migrations_complete`, and both say
// in their own comments that it is an attestation rather than a check. It was
// attested ahead of the migration twice in two days, and on 2026-08-07 a
// production deploy went out that way -- the code shipped, the constraint it
// needed did not exist, and the only thing that prevented an incident was that
// the affected endpoint was already broken.
//
// A verifier that cannot actually detect a missing migration would be worse
// than the attestation, because it would look like a control. So the test that
// matters here is the negative one: drop something a migration created and
// confirm the verifier fails and names it.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-schema-verify-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const VERIFY_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-verify-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_schema_verify';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

async function runVerifier(): Promise<{ code: number; result: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [VERIFY_SCRIPT],
      {
        maxBuffer: 10_000_000,
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_SCHEMA_VERIFY_SKIP_MAIN: 'false',
        },
      },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr}`;
        const start = combined.indexOf('{');
        if (start === -1) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, result: JSON.parse(combined.slice(start)) as Record<string, unknown> });
      },
    );
  });
}

async function applyEverything(): Promise<void> {
  const files = (await fs.readdir(INFRA_DIR))
    .filter((name) => /^pilot_slice_postgres.*\.sql$/.test(name))
    .sort();

  // Base schema first; the increments alter what it creates.
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

  // Several increments depend on earlier ones, and a handful will fail on a
  // first pass because of it. Repeat until nothing new applies -- every
  // migration here is idempotent, which is the property the rebuild path
  // already relies on.
  let remaining = files.filter((name) => name !== 'pilot_slice_postgres.sql');
  for (let pass = 0; pass < 4 && remaining.length > 0; pass += 1) {
    const failed: string[] = [];
    for (const name of remaining) {
      try {
        await client.query(await fs.readFile(path.join(INFRA_DIR, name), 'utf8'));
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === remaining.length) break;
    remaining = failed;
  }
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await applyEverything();
});

afterAll(async () => {
  if (client) await client.end();

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

describe('the pre-deploy schema verifier', () => {
  test('passes against a database with every migration applied', async () => {
    const { code, result } = await runVerifier();
    expect(result.event).toBe('schema.verify.ok');
    expect(code).toBe(0);
  });

  test('the check is not vacuous -- it asserts a real number of objects', async () => {
    const { result } = await runVerifier();
    const checked = result.checked as Record<string, number>;
    expect(checked.tables).toBeGreaterThan(30);
    expect(checked.columns).toBeGreaterThan(20);
    expect(checked.constraints).toBeGreaterThan(20);
  });

  test('fails and names the object when a migration has not been applied', async () => {
    // Exactly the production situation on 2026-08-07: the code was deployed and
    // the column it depended on was not there.
    await client.query(`alter table pilot.athletes drop column deleted_at`);
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect(result.reason).toBe('MIGRATIONS_NOT_APPLIED');
      expect((result.missing as { columns: string[] }).columns).toContain('athletes.deleted_at');
      expect(code).not.toBe(0);
    } finally {
      await client.query(`alter table pilot.athletes add column deleted_at timestamptz null`);
    }
  });

  test('fails when a constraint the code writes against is missing', async () => {
    // The audit vocabulary case: the deploy went out, the widened constraint had
    // not been applied, and every write of the new event type failed.
    await client.query(`alter table pilot.audit_events drop constraint audit_events_event_type_check`);
    try {
      const { code, result } = await runVerifier();
      expect((result.missing as { constraints: string[] }).constraints)
        .toContain('audit_events_event_type_check');
      expect(code).not.toBe(0);
    } finally {
      await client.query(
        `alter table pilot.audit_events add constraint audit_events_event_type_check
           check (event_type in ('create','update','login','logout','shadow_classification',
             'shadow_routing','shadow_research_upload_requirement','data_deletion_initiated','data_purged'))`,
      );
    }
  });
});
