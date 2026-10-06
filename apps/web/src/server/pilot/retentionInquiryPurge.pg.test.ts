// Real PostgreSQL-backed test: the retention purge deletes public interest-form
// inquiries once they are 12 months old.
//
// WHY. /privacy tells everyone who sends the interest form: "We keep it for 12
// months, then delete it, unless you join." Nothing deleted them. Jason's
// ruling (2026-10-06, relayed by overwatch): "Delete all after 12 mo" -- every
// inquiry older than 12 months goes, whatever its review state and whether or
// not the person later joined. A member's records live in the member tables;
// the inquiry is not one of them.
//
// The real script runs as its own process, as the schedule runs it, against an
// embedded Postgres on localhost. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retention-inquiry-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_retention_inquiry';

const ORG = 'org-inquiry-purge';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('NO_PORT')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function applyMigration(file: string): Promise<void> {
  await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
}

async function runCleanup(extraEnv: Record<string, string>): Promise<{
  code: number;
  event: Record<string, unknown>;
  output: string;
}> {
  // Unset, not blanked: an empty PPBF_RETENTION_MAX_ROWS is refused as
  // INVALID_MAX_ROWS, and an inherited APPLY would turn a dry-run test live.
  const inherited = { ...process.env };
  delete inherited.PPBF_RETENTION_APPLY;
  delete inherited.PPBF_RETENTION_MAX_ROWS;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...inherited,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          // Never real storage from a test, whatever the developer's shell holds.
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          PPBF_RETENTION_BLOB_STUB_DIR: '',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        const lines = output.split('\n').filter((entry) => entry.trim().startsWith('{'));
        // The run's own verdict is its LAST structured line.
        const line = lines[lines.length - 1];
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, event: JSON.parse(line) as Record<string, unknown>, output });
      },
    );
  });
}

/* Ages are written as intervals so the boundary is the database's own
   arithmetic, the same `now() - interval '12 months'` the script uses. */
const SEEDED = [
  { name: 'Two years old', age: `interval '2 years'`, state: 'new', due: true },
  { name: 'Thirteen months, contacted', age: `interval '13 months'`, state: 'contacted', due: true },
  { name: 'A day past twelve months, archived', age: `interval '12 months 1 day'`, state: 'archived', due: true },
  { name: 'A day short of twelve months', age: `interval '12 months' - interval '1 day'`, state: 'new', due: false },
  { name: 'Sent today', age: `interval '0 days'`, state: 'new', due: false },
] as const;

const DUE = SEEDED.filter((row) => row.due).length;
const KEPT_NAMES = SEEDED.filter((row) => !row.due).map((row) => row.name).sort();

async function seedInquiries(): Promise<void> {
  await client.query('delete from pilot.public_interest_submissions');
  await client.query(`delete from pilot.audit_events where event_type = 'data_purged'`);
  for (const [index, row] of SEEDED.entries()) {
    await client.query(
      `insert into pilot.public_interest_submissions
         (organization_id, full_name, email, phone, visitor_type, program_interest,
          preferred_contact_method, message, consent_to_contact, review_state, created_at)
       values ($1, $2, $3, '555-0100', 'Parent / Guardian', 'Youth Development',
               'Email', 'please call', true, $4, now() - (${row.age}))`,
      [ORG, row.name, `inquirer${index}@example.test`, row.state],
    );
  }
}

async function inquiryNames(): Promise<string[]> {
  const rows = await client.query<{ full_name: string }>(
    'select full_name from pilot.public_interest_submissions',
  );
  return rows.rows.map((row) => row.full_name).sort();
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
  await applyMigration('pilot_slice_postgres.sql');
  await applyMigration('pilot_slice_postgres_data_retention_deletion_migration.sql');
  await applyMigration('pilot_slice_postgres_public_interest_migration.sql');

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
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

describe('the retention purge deletes interest-form inquiries after 12 months', () => {
  test('a dry run reports the inquiries it would delete, and deletes none', async () => {
    await seedInquiries();
    const { code, event } = await runCleanup({});

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.dry-run');
    expect(event.inquiries).toBe(DUE);
    expect(event.would_delete_inquiries).toBe(DUE);
    expect(await inquiryNames()).toHaveLength(SEEDED.length);
  });

  test('applying deletes every inquiry older than 12 months, whatever its review state, and no newer one', async () => {
    await seedInquiries();
    const { code, event, output } = await runCleanup({ PPBF_RETENTION_APPLY: 'true' });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.inquiries).toBe(DUE);
    expect(await inquiryNames()).toEqual(KEPT_NAMES);

    // Counts only: nothing the inquirer wrote reaches the log.
    expect(output).not.toMatch(/inquirer\d@example\.test|please call|555-0100|Two years old/);
  });

  test('the deletion is recorded in the audit trail, as counts', async () => {
    await seedInquiries();
    await runCleanup({ PPBF_RETENTION_APPLY: 'true' });

    const audit = await client.query<{ details: Record<string, unknown> }>(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ inquiries_deleted: DUE, total_rows_deleted: DUE });
    expect(JSON.stringify(audit.rows[0].details)).not.toMatch(/example\.test/);
  });

  test('a backlog never trips the cap: the oldest go first, the rest are deferred to the next run', async () => {
    await seedInquiries();
    const first = await runCleanup({
      PPBF_RETENTION_APPLY: 'true',
      PPBF_RETENTION_MAX_ROWS: String(DUE - 1),
    });

    // Not refused: a public form's backlog must not stop the families' purge,
    // and must not make its own retention impossible past the cap.
    expect(first.code).toBe(0);
    expect(first.event.event).toBe('retention.cleanup.completed');
    expect(first.event.inquiries).toBe(DUE - 1);
    expect(first.event.inquiries_deferred).toBe(1);
    // The youngest due one waits; the two oldest are gone.
    expect(await inquiryNames()).toEqual(['A day past twelve months, archived', ...KEPT_NAMES].sort());

    const second = await runCleanup({ PPBF_RETENTION_APPLY: 'true', PPBF_RETENTION_MAX_ROWS: String(DUE - 1) });
    expect(second.code).toBe(0);
    expect(second.event.inquiries).toBe(1);
    expect(second.event.inquiries_deferred).toBe(0);
    expect(await inquiryNames()).toEqual(KEPT_NAMES);
  });

  test('a refused delete is reported by name, fails the run, and deletes nothing', async () => {
    await seedInquiries();
    await client.query(`
      create or replace function pilot.test_refuse_inquiry_delete() returns trigger
      language plpgsql as $$ begin raise exception 'refused' using errcode = 'P0001'; end $$`);
    await client.query(`
      create trigger test_refuse_inquiry_delete before delete on pilot.public_interest_submissions
      for each row execute function pilot.test_refuse_inquiry_delete()`);
    try {
      const { code, event } = await runCleanup({ PPBF_RETENTION_APPLY: 'true' });

      expect(code).toBe(1);
      expect(event.event).toBe('retention.cleanup.incomplete');
      expect(event.inquiries).toBe(0);
      expect(event.blocked_by).toEqual({ P0001: 1 });
      expect(await inquiryNames()).toHaveLength(SEEDED.length);
    } finally {
      await client.query('drop trigger test_refuse_inquiry_delete on pilot.public_interest_submissions');
      await client.query('drop function pilot.test_refuse_inquiry_delete()');
    }
  });

  test('with nothing due, an applied run deletes nothing and says so', async () => {
    await seedInquiries();
    await client.query(`delete from pilot.public_interest_submissions where created_at < now() - interval '12 months'`);
    const { code, event } = await runCleanup({ PPBF_RETENTION_APPLY: 'true' });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.inquiries).toBe(0);
    expect(await inquiryNames()).toEqual(KEPT_NAMES);
  });
});
