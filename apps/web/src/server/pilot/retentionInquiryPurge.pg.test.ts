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
        const jsonLines = (text: string) => text.split('\n').filter((entry) => entry.trim().startsWith('{'));
        // The run's own verdict is its LAST structured line on stdout; a run
        // that never reached one (refused, failed) has it on stderr instead.
        // Warnings on stderr (max_rows clamped, people over the cap) never
        // outrank a verdict.
        const lines = jsonLines(stdout).length > 0 ? jsonLines(stdout) : jsonLines(stderr);
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

/* A withdrawn family past its windows: an athlete soft-deleted 3 years ago and
   a parent account soft-deleted 2 years ago. Both are due. The inquiries-only
   run must count them and leave them exactly where they are. */
const COACH_ID = 'coach-inquiry-purge';
const EXPIRED_ATHLETE_ID = 'athlete-inquiry-purge-expired';
const EXPIRED_PARENT_ID = 'parent-inquiry-purge-expired';

async function seedExpiredFamily(): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, deleted_at)
     values ($1, 'parent', $2, 'microsoft', now() - interval '2 years') on conflict do nothing`,
    [EXPIRED_PARENT_ID, ORG],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Expired Athlete', '2013-05-06', 'fly', 'withdrawn', 'contact', false, $3, now(), now(), now() - interval '3 years')
     on conflict do nothing`,
    [ORG, EXPIRED_ATHLETE_ID, COACH_ID],
  );
}

async function removeExpiredFamily(): Promise<void> {
  await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, EXPIRED_ATHLETE_ID]);
  await client.query('delete from pilot.accounts where account_id = $1', [EXPIRED_PARENT_ID]);
}

async function expiredFamilyPresent(): Promise<{ athlete: boolean; parent: boolean }> {
  const athlete = await client.query(
    'select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2',
    [ORG, EXPIRED_ATHLETE_ID],
  );
  const parent = await client.query('select 1 from pilot.accounts where account_id = $1', [EXPIRED_PARENT_ID]);
  return { athlete: athlete.rows.length === 1, parent: parent.rows.length === 1 };
}

async function latestAuditDetails(): Promise<Record<string, unknown> | null> {
  const audit = await client.query<{ details: Record<string, unknown> }>(
    `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
  );
  return audit.rows[0]?.details ?? null;
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
    expect(event.mode).toBe('dry_run');
    expect(event.inquiries).toBe(DUE);
    expect(event.would_delete_inquiries).toBe(DUE);
    // The dry run names what the nightly run will delete on its own, and what
    // waits for a person to dispatch APPLY.
    expect(event.nightly_deletes_inquiries).toBe(DUE);
    expect(event.apply_needed_for).toEqual({ athletes: 0, accounts: 0, videos: 0 });
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

/* THE NIGHTLY MODE. Jason, 2026-10-07 (OD-2026-10-07-010, Q2): "Nightly
   deletes enquiries itself" -- the nightly run deletes public enquiries older
   than 12 months on its own, with a cap per run; people's records stay manual.
   PPBF_RETENTION_APPLY_INQUIRIES=true is that run. Every case here seeds a
   family that is DUE, so that "stays manual" is proven on rows the full apply
   would have removed, not on an empty table. */
describe('the inquiries-only run (the nightly schedule) deletes expired inquiries and nothing else', () => {
  beforeEach(async () => {
    await seedInquiries();
    await seedExpiredFamily();
  });

  afterEach(async () => {
    await removeExpiredFamily();
  });

  test("deletes every due inquiry, counts the due family, and leaves the family's rows where they are", async () => {
    const { code, event, output } = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true' });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.mode).toBe('inquiries_only');
    expect(event.inquiries).toBe(DUE);
    expect(event.inquiries_deferred).toBe(0);
    expect(await inquiryNames()).toEqual(KEPT_NAMES);

    // Seen and reported; not touched. The purge of people's records was never
    // entered, so its counts are zero and no login, video or SHADOW row moved.
    expect(event.people_due).toEqual({ athletes: 1, accounts: 1, videos: 0 });
    expect(event.athletes).toBe(0);
    expect(event.accounts).toBe(0);
    expect(event.athlete_logins_unlinked).toBe(0);
    expect(event.total).toBe(DUE);
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });

    // The audit row says which mode ran and what it left for a person.
    const details = await latestAuditDetails();
    expect(details).toMatchObject({
      mode: 'inquiries_only',
      people_due: { athletes: 1, accounts: 1, videos: 0 },
      athletes_deleted: 0,
      accounts_deleted: 0,
      inquiries_deleted: DUE,
      total_rows_deleted: DUE,
    });
    expect(JSON.stringify(details)).not.toMatch(/example\.test|Expired Athlete/);
    expect(output).not.toMatch(/inquirer\d@example\.test|Expired Athlete|please call/);
  });

  test('the due family takes no room under the cap: inquiries get all of it, oldest first, the rest deferred', async () => {
    // Under the full apply, two due people would leave DUE-1-2 = 0 room for
    // inquiries at this cap. Here they are not deleted, so they do not count.
    const first = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true', PPBF_RETENTION_MAX_ROWS: String(DUE - 1) });

    expect(first.code).toBe(0);
    expect(first.event.event).toBe('retention.cleanup.completed');
    expect(first.event.inquiries).toBe(DUE - 1);
    expect(first.event.inquiries_deferred).toBe(1);
    expect(await inquiryNames()).toEqual(['A day past twelve months, archived', ...KEPT_NAMES].sort());
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });

    const second = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true', PPBF_RETENTION_MAX_ROWS: String(DUE - 1) });
    expect(second.event.inquiries).toBe(1);
    expect(second.event.inquiries_deferred).toBe(0);
    expect(await inquiryNames()).toEqual(KEPT_NAMES);
  });

  test('more due people than the cap does not refuse the run: it reports them and still deletes the inquiries', async () => {
    // The blast-radius guard protects people's records from a runaway sweep.
    // This run never sweeps them, so refusing it would only stop inquiry
    // retention. A full APPLY of the same database IS refused.
    const nightly = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true', PPBF_RETENTION_MAX_ROWS: '1' });

    expect(nightly.code).toBe(0);
    expect(nightly.event.event).toBe('retention.cleanup.completed');
    expect(nightly.event.inquiries).toBe(1);
    expect(nightly.event.people_due).toEqual({ athletes: 1, accounts: 1, videos: 0 });
    expect(nightly.output).toContain('"event":"retention.cleanup.people_over_cap"');
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });

    const full = await runCleanup({ PPBF_RETENTION_APPLY: 'true', PPBF_RETENTION_MAX_ROWS: '1' });
    expect(full.code).toBe(1);
    expect(full.event).toMatchObject({ event: 'retention.cleanup.refused', reason: 'BLAST_RADIUS_EXCEEDED' });
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });
  });

  test('with no inquiry due, the run deletes nothing, writes no audit row, and still reports the due family', async () => {
    await client.query(`delete from pilot.public_interest_submissions where created_at < now() - interval '12 months'`);
    const { code, event } = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true' });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.mode).toBe('inquiries_only');
    expect(event.inquiries).toBe(0);
    expect(event.people_due).toEqual({ athletes: 1, accounts: 1, videos: 0 });
    expect(await latestAuditDetails()).toBeNull();
    expect(await inquiryNames()).toEqual(KEPT_NAMES);
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });
  });

  test('the dry run, with a due family, says what the nightly run will delete and what waits for APPLY', async () => {
    const { event } = await runCleanup({ PPBF_RETENTION_MAX_ROWS: String(DUE - 1) });

    expect(event.event).toBe('retention.cleanup.dry-run');
    expect(event.nightly_deletes_inquiries).toBe(DUE - 1);
    expect(event.apply_needed_for).toEqual({ athletes: 1, accounts: 1, videos: 0 });
    expect(await inquiryNames()).toHaveLength(SEEDED.length);
    expect(await expiredFamilyPresent()).toEqual({ athlete: true, parent: true });
  });

  test('a refused inquiry delete fails the nightly run by name and deletes nothing', async () => {
    await client.query(`
      create or replace function pilot.test_refuse_inquiry_delete() returns trigger
      language plpgsql as $$ begin raise exception 'refused' using errcode = 'P0001'; end $$`);
    await client.query(`
      create trigger test_refuse_inquiry_delete before delete on pilot.public_interest_submissions
      for each row execute function pilot.test_refuse_inquiry_delete()`);
    try {
      const { code, event } = await runCleanup({ PPBF_RETENTION_APPLY_INQUIRIES: 'true' });

      expect(code).toBe(1);
      expect(event.event).toBe('retention.cleanup.incomplete');
      expect(event.mode).toBe('inquiries_only');
      expect(event.inquiries).toBe(0);
      expect(event.blocked_by).toEqual({ P0001: 1 });
      expect(await inquiryNames()).toHaveLength(SEEDED.length);
    } finally {
      await client.query('drop trigger test_refuse_inquiry_delete on pilot.public_interest_submissions');
      await client.query('drop function pilot.test_refuse_inquiry_delete()');
    }
  });
});
