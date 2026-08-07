// Real PostgreSQL-backed test for the data retention / cascade deletion migration.
//
// This suite exists because the migration failed twice against staging and both
// failures were reachable locally in seconds:
//
//   1. The file wrapped everything in `do $$ ... $$` while the plpgsql function
//      body inside it was also dollar-quoted with `$$`. The inner quote closed
//      the outer block and Postgres rejected the file outright (42601).
//   2. The cascade joined `guardian_links.parent_id` directly against
//      `accounts.account_id`. Those are different identifier spaces --
//      guardian_links.parent_id references pilot.parents(parent_id), and
//      pilot.parents.account_id is what points back at an account. The trigger
//      would have matched zero rows, updated nothing, and reported success.
//
// The second is the dangerous one: a silent no-op in the code path whose entire
// job is making sure a deleted guardian's children are deleted too. Nothing
// short of executing the trigger against real rows catches it, which is what
// this does.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-data-retention-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_data_retention';
const MIGRATION_FILE = 'pilot_slice_postgres_data_retention_deletion_migration.sql';

const ORG_ID = 'org-retention';
const OTHER_ORG_ID = 'org-retention-other';
const COACH_ID = 'acct-retention-coach';
const GUARDIAN_ACCOUNT_ID = 'acct-retention-guardian';
const PARENT_ID = 'parent-retention-1';
const LINKED_ATHLETE_ID = 'ATH-RET-LINKED';
const UNLINKED_ATHLETE_ID = 'ATH-RET-UNLINKED';

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

async function seedAthlete(athleteId: string, organizationId: string): Promise<void> {
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Retention Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [organizationId, athleteId, COACH_ID],
  );
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
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
});

afterAll(async () => {
  if (client) {
    await client.end();
  }

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

const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

/**
 * Runs the real cleanup script as its own process, the way the scheduled job
 * does, and returns the single JSON line it emits. Testing the exported
 * function instead would skip every guard that lives in the script -- the write
 * target assertion, the dry-run default, the blast-radius cap -- which are the
 * parts that matter for a job that permanently deletes minors' records
 * unattended.
 */
async function runCleanup(extraEnv: Record<string, string>): Promise<{
  code: number;
  event: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, event: JSON.parse(line) as Record<string, unknown> });
      },
    );
  });
}

describe('the retention cleanup job refuses to be casually destructive', () => {
  const EXPIRED_ATHLETE_ID = 'ATH-RET-EXPIRED';

  beforeAll(async () => {
    // This block runs before the migration suite below, so apply the migration
    // here too. It is idempotent by design, which is the property the rebuild
    // path depends on anyway.
    await client.query(await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8'));
    await seedAthlete(EXPIRED_ATHLETE_ID, ORG_ID);
    await client.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years'
        where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EXPIRED_ATHLETE_ID],
    );
  });

  test('a dry run is the default and deletes nothing', async () => {
    // A destructive default would make a mistyped command, or a copy-pasted CI
    // step, unrecoverable.
    const { event } = await runCleanup({});
    expect(event.event).toBe('retention.cleanup.dry-run');
    expect(event.athletes).toBe(1);

    const survived = await client.query(
      `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EXPIRED_ATHLETE_ID],
    );
    expect(survived.rowCount).toBe(1);
  });

  test('an unexpectedly large purge stops instead of enacting itself', async () => {
    const { code, event } = await runCleanup({
      PPBF_RETENTION_APPLY: 'true',
      PPBF_RETENTION_MAX_ROWS: '0',
    });
    expect(event.event).toBe('retention.cleanup.refused');
    expect(event.reason).toBe('BLAST_RADIUS_EXCEEDED');
    expect(code).not.toBe(0);

    const survived = await client.query(
      `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EXPIRED_ATHLETE_ID],
    );
    expect(survived.rowCount).toBe(1);
  });

  test('it refuses a database the operator did not name', async () => {
    const { code, event } = await runCleanup({
      PPBF_RETENTION_APPLY: 'true',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'some_other_database',
    });
    expect(event.event).toBe('retention.cleanup.refused');
    expect(event.reason).toBe('POSTGRES_TARGET_MISMATCH');
    expect(code).not.toBe(0);

    const survived = await client.query(
      `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EXPIRED_ATHLETE_ID],
    );
    expect(survived.rowCount).toBe(1);
  });

  test('applying deletes the expired row and records that it did', async () => {
    const { event } = await runCleanup({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.athletes).toBe(1);

    const gone = await client.query(
      `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EXPIRED_ATHLETE_ID],
    );
    expect(gone.rowCount).toBe(0);

    // The audit row is the only surviving evidence the deletion happened, and
    // 'data_purged' was not in the vocabulary when this shipped -- so this
    // insert would have failed, after the rows were already gone, had the two
    // not been made a single transaction.
    const audited = await client.query<{ details: { athletes_deleted: number } }>(
      `select details from pilot.audit_events
        where event_type = 'data_purged' order by audit_id desc limit 1`,
    );
    expect(audited.rows[0].details.athletes_deleted).toBe(1);
  });
});

describe('the data retention migration applies and cascades', () => {
  test('the migration file parses and applies against the real schema', async () => {
    // The first staging attempt never got past this: nested dollar-quoting made
    // the whole file a syntax error.
    await expect(
      client.query(await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8')),
    ).resolves.toBeDefined();

    // Containment, not equality: pilot.shadow_chat_sessions already carried a
    // deleted_at before this migration existed, and asserting the exact set
    // would make this test fail the next time an unrelated table gains one.
    const columns = await client.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'pilot' and column_name = 'deleted_at'
        order by table_name`,
    );
    expect(columns.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['accounts', 'athletes']),
    );
  });

  test('re-applying it is a no-op, so `all` can run it against any environment', async () => {
    await expect(
      client.query(await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8')),
    ).resolves.toBeDefined();
  });

  test('deleting a guardian soft-deletes their linked athletes and nobody else', async () => {
    await seedAthlete(LINKED_ATHLETE_ID, ORG_ID);
    await seedAthlete(UNLINKED_ATHLETE_ID, ORG_ID);

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [GUARDIAN_ACCOUNT_ID, ORG_ID],
    );
    // parent_id is its own identifier space; account_id is the pointer back to
    // pilot.accounts. Making them deliberately different values here is what
    // makes this test able to fail on the join bug -- if they matched, a trigger
    // comparing gl.parent_id to new.account_id would pass by coincidence.
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Retention Guardian')`,
      [ORG_ID, PARENT_ID, GUARDIAN_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_ID, PARENT_ID, LINKED_ATHLETE_ID],
    );

    await client.query(
      `update pilot.accounts set deleted_at = now() where account_id = $1`,
      [GUARDIAN_ACCOUNT_ID],
    );

    const linked = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, LINKED_ATHLETE_ID],
    );
    expect(linked.rows[0].deleted_at).not.toBeNull();

    const unlinked = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, UNLINKED_ATHLETE_ID],
    );
    expect(unlinked.rows[0].deleted_at).toBeNull();
  });

  test('an athlete deleted before their guardian keeps their earlier clock', async () => {
    const EARLY_ATHLETE_ID = 'ATH-RET-EARLY';
    const EARLY_GUARDIAN_ID = 'acct-retention-guardian-2';
    const EARLY_PARENT_ID = 'parent-retention-2';

    await seedAthlete(EARLY_ATHLETE_ID, ORG_ID);
    await client.query(
      `update pilot.athletes set deleted_at = now() - interval '200 days'
        where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EARLY_ATHLETE_ID],
    );
    const before = await client.query<{ deleted_at: Date }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EARLY_ATHLETE_ID],
    );

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [EARLY_GUARDIAN_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Late Guardian')`,
      [ORG_ID, EARLY_PARENT_ID, EARLY_GUARDIAN_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'father')`,
      [ORG_ID, EARLY_PARENT_ID, EARLY_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      EARLY_GUARDIAN_ID,
    ]);

    const after = await client.query<{ deleted_at: Date }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, EARLY_ATHLETE_ID],
    );
    expect(after.rows[0].deleted_at.toISOString()).toBe(before.rows[0].deleted_at.toISOString());
  });

  test('the audit vocabulary admits the event types the deletion path writes', async () => {
    // dataDeletion.ts writes 'data_deletion_initiated' and 'data_purged'. Neither
    // was in the check constraint when T-007 shipped, so every call to the admin
    // deletion endpoint died on SQLSTATE 23514 in production -- the feature had
    // never once worked. The unit tests could not see it: they assert on shapes
    // and never reach a database.
    for (const eventType of ['data_deletion_initiated', 'data_purged']) {
      await expect(
        client.query(
          `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
           values ($1, $2, 'vocabulary_probe', 'probe', '{}'::jsonb)`,
          [eventType, ORG_ID],
        ),
      ).resolves.toBeDefined();
    }
    await client.query(`delete from pilot.audit_events where entity_type = 'vocabulary_probe'`);
  });

  test('the cascade count reflects the athletes actually stamped', async () => {
    // The count compared deleted_at against a timestamp minted in JavaScript,
    // which never equals the now() the trigger copies, so it reported zero
    // cascaded athletes however many it had just deleted.
    const COUNT_ATHLETE_ID = 'ATH-RET-COUNT';
    const COUNT_GUARDIAN_ID = 'acct-retention-guardian-3';
    const COUNT_PARENT_ID = 'parent-retention-3';

    await seedAthlete(COUNT_ATHLETE_ID, ORG_ID);
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [COUNT_GUARDIAN_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Counted Guardian')`,
      [ORG_ID, COUNT_PARENT_ID, COUNT_GUARDIAN_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_ID, COUNT_PARENT_ID, COUNT_ATHLETE_ID],
    );

    const updated = await client.query<{ deleted_at: string }>(
      `update pilot.accounts set deleted_at = now(), updated_at = now()
        where account_id = $1 returning deleted_at::text as deleted_at`,
      [COUNT_GUARDIAN_ID],
    );
    const counted = await client.query<{ count: string }>(
      `select count(*)::text as count from pilot.athletes
        where deleted_at = $1::timestamptz and organization_id = $2`,
      [updated.rows[0].deleted_at, ORG_ID],
    );

    expect(Number(counted.rows[0].count)).toBe(1);
  });

  test('a second update to an already-deleted guardian does not re-cascade', async () => {
    // The trigger fires on every UPDATE of a parent row. Only the transition
    // from NULL to NOT NULL is a deletion; anything else must leave athletes
    // alone, or an unrelated profile edit would restamp their retention clock.
    const before = await client.query<{ deleted_at: Date }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, LINKED_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set login_email = $2 where account_id = $1`, [
      GUARDIAN_ACCOUNT_ID,
      'edited@example.org',
    ]);

    const after = await client.query<{ deleted_at: Date }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, LINKED_ATHLETE_ID],
    );
    expect(after.rows[0].deleted_at.toISOString()).toBe(before.rows[0].deleted_at.toISOString());
  });
});
