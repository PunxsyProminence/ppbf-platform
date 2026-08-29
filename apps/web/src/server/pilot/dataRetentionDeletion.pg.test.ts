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


  test('a co-guardianed athlete is not withdrawn when one of their guardians retires', async () => {
    // The cascade's justification is that a child whose guardian is gone has
    // nobody left to act for them. That reasoning does not reach a child who
    // still has a second guardian: stamping deleted_at on them anyway withdraws
    // a currently enrolled athlete because of an unrelated adult's account
    // action, and takes the remaining guardian's access to their own child with
    // it. Split households are the ordinary case, not the edge one.
    const SHARED_ATHLETE_ID = 'ATH-RET-SHARED';
    const SOLE_ATHLETE_ID = 'ATH-RET-SOLE';
    const RETIRING_ACCOUNT_ID = 'acct-retention-guardian-a';
    const REMAINING_ACCOUNT_ID = 'acct-retention-guardian-b';
    const RETIRING_PARENT_ID = 'parent-retention-a';
    const REMAINING_PARENT_ID = 'parent-retention-b';

    await seedAthlete(SHARED_ATHLETE_ID, ORG_ID);
    await seedAthlete(SOLE_ATHLETE_ID, ORG_ID);

    for (const [accountId, parentId, name] of [
      [RETIRING_ACCOUNT_ID, RETIRING_PARENT_ID, 'Retiring Guardian'],
      [REMAINING_ACCOUNT_ID, REMAINING_PARENT_ID, 'Remaining Guardian'],
    ] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'parent', $2, 'microsoft')`,
        [accountId, ORG_ID],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
         values ($1, $2, $3, $4)`,
        [ORG_ID, parentId, accountId, name],
      );
    }

    // Both guardians hold the shared child; only the retiring one holds the other.
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother'), ($1, $4, $3, 'father'), ($1, $2, $5, 'mother')`,
      [ORG_ID, RETIRING_PARENT_ID, SHARED_ATHLETE_ID, REMAINING_PARENT_ID, SOLE_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      RETIRING_ACCOUNT_ID,
    ]);

    const shared = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, SHARED_ATHLETE_ID],
    );
    expect(shared.rows[0].deleted_at).toBeNull();

    // The narrowing must not become a blanket refusal: the child this guardian
    // held alone is still withdrawn, which is the behaviour the cascade exists
    // for.
    const sole = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, SOLE_ATHLETE_ID],
    );
    expect(sole.rows[0].deleted_at).not.toBeNull();
  });

  test('a co-guardian who has already retired does not keep the athlete enrolled', async () => {
    // "Another guardian exists" is not the test -- "another guardian is still
    // here" is. A guard that counted rows rather than live accounts would let
    // the last remaining guardian's departure pass silently because a guardian
    // who left months ago still has a link row.
    const STALE_ATHLETE_ID = 'ATH-RET-STALE-CO';
    const STALE_ACCOUNT_ID = 'acct-retention-guardian-stale';
    const LAST_ACCOUNT_ID = 'acct-retention-guardian-last';
    const STALE_PARENT_ID = 'parent-retention-stale';
    const LAST_PARENT_ID = 'parent-retention-last';

    await seedAthlete(STALE_ATHLETE_ID, ORG_ID);

    for (const [accountId, parentId, name] of [
      [STALE_ACCOUNT_ID, STALE_PARENT_ID, 'Already Retired Guardian'],
      [LAST_ACCOUNT_ID, LAST_PARENT_ID, 'Last Guardian'],
    ] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'parent', $2, 'microsoft')`,
        [accountId, ORG_ID],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
         values ($1, $2, $3, $4)`,
        [ORG_ID, parentId, accountId, name],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'guardian')`,
        [ORG_ID, parentId, STALE_ATHLETE_ID],
      );
    }

    // The first guardian retires while the second still holds the child, so the
    // child stays.
    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      STALE_ACCOUNT_ID,
    ]);
    const afterFirst = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, STALE_ATHLETE_ID],
    );
    expect(afterFirst.rows[0].deleted_at).toBeNull();

    // The second retires and there is now nobody, so the cascade runs.
    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      LAST_ACCOUNT_ID,
    ]);
    const afterSecond = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, STALE_ATHLETE_ID],
    );
    expect(afterSecond.rows[0].deleted_at).not.toBeNull();
  });

  test('one account holding two parent records is still that athlete only guardian', async () => {
    // guardianAccess.guardianParentIds already treats a single account as able
    // to back several pilot.parents rows. A guard that counted parent records
    // rather than accounts would read this account's own second record as "a
    // second guardian" and cancel a cascade that has nobody left to justify it.
    const TWO_ROW_ATHLETE_ID = 'ATH-RET-TWOROW';
    const TWO_ROW_ACCOUNT_ID = 'acct-retention-guardian-tworow';

    await seedAthlete(TWO_ROW_ATHLETE_ID, ORG_ID);
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [TWO_ROW_ACCOUNT_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, 'parent-retention-tworow-1', $2, 'Two Row Guardian'),
              ($1, 'parent-retention-tworow-2', $2, 'Two Row Guardian')`,
      [ORG_ID, TWO_ROW_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'parent-retention-tworow-1', $2, 'mother'),
              ($1, 'parent-retention-tworow-2', $2, 'guardian')`,
      [ORG_ID, TWO_ROW_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      TWO_ROW_ACCOUNT_ID,
    ]);

    const athlete = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, TWO_ROW_ATHLETE_ID],
    );
    expect(athlete.rows[0].deleted_at).not.toBeNull();
  });

  test('a guardian record with no account at all still counts as a remaining guardian', async () => {
    // pilot.parents.account_id is nullable: intake records a guardian before,
    // or without, that adult ever holding a login. Such a record cannot itself
    // be retired, so it can never be cleared out of the way -- and this suite
    // states the resulting behaviour rather than leaving it to fall out of a
    // null comparison. Retaining the athlete row is the recoverable direction;
    // an explicit athlete withdrawal remains available either way.
    const CONTACT_ATHLETE_ID = 'ATH-RET-CONTACT-CO';
    const CONTACT_ACCOUNT_ID = 'acct-retention-guardian-contact';

    await seedAthlete(CONTACT_ATHLETE_ID, ORG_ID);
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [CONTACT_ACCOUNT_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, 'parent-retention-contact-acct', $2, 'Signed In Guardian'),
              ($1, 'parent-retention-contact-only', null, 'Contact Only Guardian')`,
      [ORG_ID, CONTACT_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'parent-retention-contact-acct', $2, 'mother'),
              ($1, 'parent-retention-contact-only', $2, 'father')`,
      [ORG_ID, CONTACT_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      CONTACT_ACCOUNT_ID,
    ]);

    const athlete = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, CONTACT_ATHLETE_ID],
    );
    expect(athlete.rows[0].deleted_at).toBeNull();
  });


  test('two co-guardians retiring at the same instant do not both skip the cascade', async () => {
    // The narrowing above introduced a read the old cascade never made, and a
    // conditional read is a race. Under READ COMMITTED each transaction sees
    // the other guardian's deleted_at as still null, so "another live guardian
    // exists" can answer yes on BOTH sides. Both skip, both commit, and the
    // athlete is left enrolled with nobody holding them -- precisely the state
    // the cascade exists to prevent, reached by making the cascade conditional.
    //
    // Interleaved deliberately rather than by timing. The losing order is
    // "both triggers evaluate before either commits", so this drives exactly
    // that: A retires and stays open, B's retirement is issued while A is
    // uncommitted, and A commits underneath it. B's statement is not awaited
    // before A commits, because a correct trigger BLOCKS there -- awaiting it
    // first would hang the test rather than fail it. Instead we wait until
    // pg_stat_activity shows B either blocked on a lock or finished, so the
    // interleaving is observed rather than assumed.
    const RACE_ATHLETE_ID = 'ATH-RET-RACE';
    const RACE_A_ACCOUNT = 'acct-retention-race-a';
    const RACE_B_ACCOUNT = 'acct-retention-race-b';

    await seedAthlete(RACE_ATHLETE_ID, ORG_ID);
    for (const [accountId, parentId] of [
      [RACE_A_ACCOUNT, 'parent-retention-race-a'],
      [RACE_B_ACCOUNT, 'parent-retention-race-b'],
    ] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'parent', $2, 'microsoft')`,
        [accountId, ORG_ID],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
         values ($1, $2, $3, 'Racing Guardian')`,
        [ORG_ID, parentId, accountId],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'guardian')`,
        [ORG_ID, parentId, RACE_ATHLETE_ID],
      );
    }

    const sessionA = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    const sessionB = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await sessionA.connect();
    await sessionB.connect();

    try {
      const backendB = await sessionB.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pidB = backendB.rows[0].pid;

      await sessionA.query('begin');
      await sessionB.query('begin');

      // A retires and holds its transaction open.
      await sessionA.query('update pilot.accounts set deleted_at = now() where account_id = $1', [
        RACE_A_ACCOUNT,
      ]);

      let settled = false;
      const bRetires = sessionB
        .query('update pilot.accounts set deleted_at = now() where account_id = $1', [RACE_B_ACCOUNT])
        .finally(() => {
          settled = true;
        });

      // Wait for B to be observably blocked on a lock, or to have finished.
      // A trigger that does not serialize finishes here; one that does blocks,
      // and blocking is the behaviour that makes the assertion below reachable.
      for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
        const blocked = await client.query<{ waiting: boolean }>(
          `select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1`,
          [pidB],
        );
        if (blocked.rows[0]?.waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await sessionA.query('commit');
      await bRetires;
      await sessionB.query('commit');
    } finally {
      await sessionA.end();
      await sessionB.end();
    }

    // Whichever guardian commits last is the one with nobody behind them, so
    // exactly one of the two retirements must have cascaded.
    const athlete = await client.query<{ deleted_at: Date | null }>(
      'select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2',
      [ORG_ID, RACE_ATHLETE_ID],
    );
    expect(athlete.rows[0].deleted_at).not.toBeNull();
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

  test('a cascade-withdrawn athlete loses the login an explicitly-withdrawn one loses', async () => {
    // deleteAthleteRecord closes three doors when it withdraws an athlete:
    // athletes.deleted_at, accounts.active_flag, and every live session token.
    // Its own comment records why -- writing deleted_at alone left "a withdrawn
    // athlete with a working login to their own record for the entire two-year
    // retention window", because the self-access branch of
    // assertActorCanAccessAthlete compares actor.athleteId to the requested id
    // and reads no row at all.
    //
    // The cascade reaches the same end state -- an athlete withdrawn from the
    // program -- through the trigger instead, and the trigger writes exactly one
    // of the three. So the hole that path closed stayed open on this one, for
    // the athletes nobody chose individually.
    const CASCADE_ATHLETE_ID = 'ATH-RET-CASCADE-LOGIN';
    const CASCADE_ACCOUNT_ID = 'acct-retention-cascade-athlete';
    const CASCADE_GUARDIAN_ACCOUNT_ID = 'acct-retention-cascade-guardian';
    const CASCADE_PARENT_ID = 'parent-retention-cascade';

    await seedAthlete(CASCADE_ATHLETE_ID, ORG_ID);
    // The minor's own login. auth.ts creates exactly this shape: role 'athlete'
    // with athlete_id pointing at the record.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag)
       values ($1, 'athlete', $2, 'ppbf_local', $3, true)`,
      [CASCADE_ACCOUNT_ID, ORG_ID, CASCADE_ATHLETE_ID],
    );
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id)
       values ($1, $2, $3)`,
      [`hash-${CASCADE_ATHLETE_ID}`, CASCADE_ACCOUNT_ID, ORG_ID],
    );

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [CASCADE_GUARDIAN_ACCOUNT_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Cascade Guardian')`,
      [ORG_ID, CASCADE_PARENT_ID, CASCADE_GUARDIAN_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_ID, CASCADE_PARENT_ID, CASCADE_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      CASCADE_GUARDIAN_ACCOUNT_ID,
    ]);

    const athlete = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, CASCADE_ATHLETE_ID],
    );
    expect(athlete.rows[0].deleted_at).not.toBeNull();

    const account = await client.query<{ active_flag: boolean; deleted_at: Date | null }>(
      `select active_flag, deleted_at from pilot.accounts where account_id = $1`,
      [CASCADE_ACCOUNT_ID],
    );
    expect(account.rows[0].active_flag).toBe(false);
    expect(account.rows[0].deleted_at).not.toBeNull();

    const sessions = await client.query<{ revoked_at: Date | null }>(
      `select revoked_at from pilot.session_tokens where account_id = $1`,
      [CASCADE_ACCOUNT_ID],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0].revoked_at).not.toBeNull();
  });

  test('an athlete the cascade left enrolled keeps their login', async () => {
    // The mirror of the case above, and the one that makes it a real assertion
    // rather than "deactivate every athlete account in reach". A co-guardianed
    // child is NOT withdrawn when one guardian retires, so nothing about their
    // own access may change either -- otherwise the narrowing PR #770 made to
    // the row would be undone through the account.
    const KEPT_ATHLETE_ID = 'ATH-RET-KEPT-LOGIN';
    const KEPT_ACCOUNT_ID = 'acct-retention-kept-athlete';
    const KEPT_RETIRING_ACCOUNT_ID = 'acct-retention-kept-retiring';
    const KEPT_REMAINING_ACCOUNT_ID = 'acct-retention-kept-remaining';
    const KEPT_RETIRING_PARENT_ID = 'parent-retention-kept-a';
    const KEPT_REMAINING_PARENT_ID = 'parent-retention-kept-b';

    await seedAthlete(KEPT_ATHLETE_ID, ORG_ID);
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag)
       values ($1, 'athlete', $2, 'ppbf_local', $3, true)`,
      [KEPT_ACCOUNT_ID, ORG_ID, KEPT_ATHLETE_ID],
    );
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id)
       values ($1, $2, $3)`,
      [`hash-${KEPT_ATHLETE_ID}`, KEPT_ACCOUNT_ID, ORG_ID],
    );

    for (const [accountId, parentId, name] of [
      [KEPT_RETIRING_ACCOUNT_ID, KEPT_RETIRING_PARENT_ID, 'Kept Retiring Guardian'],
      [KEPT_REMAINING_ACCOUNT_ID, KEPT_REMAINING_PARENT_ID, 'Kept Remaining Guardian'],
    ] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'parent', $2, 'microsoft')`,
        [accountId, ORG_ID],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
         values ($1, $2, $3, $4)`,
        [ORG_ID, parentId, accountId, name],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'parent')`,
        [ORG_ID, parentId, KEPT_ATHLETE_ID],
      );
    }

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      KEPT_RETIRING_ACCOUNT_ID,
    ]);

    const athlete = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, KEPT_ATHLETE_ID],
    );
    expect(athlete.rows[0].deleted_at).toBeNull();

    const account = await client.query<{ active_flag: boolean; deleted_at: Date | null }>(
      `select active_flag, deleted_at from pilot.accounts where account_id = $1`,
      [KEPT_ACCOUNT_ID],
    );
    expect(account.rows[0].active_flag).toBe(true);
    expect(account.rows[0].deleted_at).toBeNull();

    const sessions = await client.query<{ revoked_at: Date | null }>(
      `select revoked_at from pilot.session_tokens where account_id = $1`,
      [KEPT_ACCOUNT_ID],
    );
    expect(sessions.rows[0].revoked_at).toBeNull();
  });

  test('the cascade does not reach an athlete account in another organization', async () => {
    // pilot.accounts is keyed by account_id alone, so an athlete-account update
    // written without an organization predicate would be free to cross gyms.
    // Two organizations may hold athletes under the same athlete_id -- the
    // uniqueness constraint is (organization_id, athlete_id), not athlete_id --
    // which is exactly the collision that makes an unscoped update reach the
    // wrong minor.
    const SHARED_ATHLETE_ID = 'ATH-RET-CROSS-ORG';
    const HOME_ACCOUNT_ID = 'acct-retention-cross-home';
    const AWAY_ACCOUNT_ID = 'acct-retention-cross-away';
    const CROSS_GUARDIAN_ACCOUNT_ID = 'acct-retention-cross-guardian';
    const CROSS_PARENT_ID = 'parent-retention-cross';

    await seedAthlete(SHARED_ATHLETE_ID, ORG_ID);
    await seedAthlete(SHARED_ATHLETE_ID, OTHER_ORG_ID);

    for (const [accountId, organizationId] of [
      [HOME_ACCOUNT_ID, ORG_ID],
      [AWAY_ACCOUNT_ID, OTHER_ORG_ID],
    ] as const) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag)
         values ($1, 'athlete', $2, 'ppbf_local', $3, true)`,
        [accountId, organizationId, SHARED_ATHLETE_ID],
      );
    }

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [CROSS_GUARDIAN_ACCOUNT_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Cross Org Guardian')`,
      [ORG_ID, CROSS_PARENT_ID, CROSS_GUARDIAN_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_ID, CROSS_PARENT_ID, SHARED_ATHLETE_ID],
    );

    await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [
      CROSS_GUARDIAN_ACCOUNT_ID,
    ]);

    const home = await client.query<{ active_flag: boolean }>(
      `select active_flag from pilot.accounts where account_id = $1`,
      [HOME_ACCOUNT_ID],
    );
    expect(home.rows[0].active_flag).toBe(false);

    const away = await client.query<{ active_flag: boolean; deleted_at: Date | null }>(
      `select active_flag, deleted_at from pilot.accounts where account_id = $1`,
      [AWAY_ACCOUNT_ID],
    );
    expect(away.rows[0].active_flag).toBe(true);
    expect(away.rows[0].deleted_at).toBeNull();

    const awayAthlete = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [OTHER_ORG_ID, SHARED_ATHLETE_ID],
    );
    expect(awayAthlete.rows[0].deleted_at).toBeNull();
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

/* THE BRANCH NOTHING EVER RAN.
 *
 * Every apply-path test above purges an ATHLETE. `accounts` is 0 in all of
 * them and never asserted, so the account arm of this job -- the one the
 * policy calls "one year for a guardian account" -- had never deleted a row
 * in any test, and could not: pilot.parents.account_id is a restricting
 * foreign key onto pilot.accounts, and a guardian who has been recorded as a
 * parent always has that row. `delete from pilot.accounts ... role='parent'`
 * raised 23503 for all of them.
 *
 * Because the deletes and the audit insert were one transaction, that raise
 * took the athlete purge down with it: the sweep deleted NOTHING and reported
 * `{"event":"retention.cleanup.failed","code":"23503"}`. And the nightly
 * schedule could not see it, because a dry run only counted.
 *
 * Its own database, so the counts these tests assert are exact rather than
 * whatever the describes above happen to have left behind.
 */
describe('a guardian who was actually recorded as one', () => {
  const GUARDIAN_DB = 'ppbf_test_retention_guardian';
  const G_ORG = 'org-guardian-purge';
  const G_COACH = 'acct-guardian-purge-coach';
  const PURGEABLE = 'acct-guardian-purgeable';
  const BLOCKED = 'acct-guardian-blocked';
  /* A THIRD GUARDIAN WHO IS STILL HERE, and the fixture does not work without
     them. The data-retention migration installs
     pilot_cascade_parent_deletion_trigger, which soft-deletes a guardian's
     linked athletes -- copying the guardian's own deleted_at onto them -- but
     only where no other live guardian remains. Without this account, expiring
     the two guardians below would withdraw the athlete two years ago as well,
     the athlete would be purged in the same sweep, and their waivers and
     observations would cascade away with them. Both properties these tests
     exist to measure would then hold for the wrong reason: nothing would
     block, because nothing would be left to block. Measured, not reasoned
     about -- the first version of this fixture omitted this guardian and
     reported both accounts purgeable. */
  const REMAINING = 'acct-guardian-remaining';
  const G_ATHLETE = 'ATH-GUARDIAN-PURGE';
  const WAIVER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  let guardianClient: Client;

  const guardianEnv = {
    AZURE_POSTGRES_CONNECTION_STRING: '',
    PPBF_EXPECTED_POSTGRES_DATABASE: GUARDIAN_DB,
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${GUARDIAN_DB}`);
    await admin.query(`create database ${GUARDIAN_DB}`);
    await admin.end();

    guardianClient = new Client({ connectionString: connectionStringFor(GUARDIAN_DB) });
    await guardianClient.connect();
    await guardianClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
    await guardianClient.query(await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8'));
    // pilot.waivers.parent_id arrives with this one, and the waiver-survives
    // assertion below is the safeguarding-critical half of the change.
    await guardianClient.query(
      await fs.readFile(
        path.join(INFRA_DIR, 'pilot_slice_postgres_guardian_media_consent_migration.sql'), 'utf8',
      ),
    );
    // pilot.one_percent_nominations is the one restricting foreign key onto
    // pilot.athletes, and the athlete-isolation test below needs it to exist.
    await guardianClient.query(
      await fs.readFile(
        path.join(INFRA_DIR, 'pilot_slice_postgres_one_percent_club_migration.sql'), 'utf8',
      ),
    );
    guardianEnv.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(GUARDIAN_DB);

    await guardianClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [G_ORG],
    );
    await guardianClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft'), ($3, 'parent', $2, 'microsoft'),
              ($4, 'parent', $2, 'microsoft'), ($5, 'parent', $2, 'microsoft')`,
      [G_COACH, G_ORG, PURGEABLE, BLOCKED, REMAINING],
    );
    await guardianClient.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Guardian Purge Athlete', '2014-01-02', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [G_ORG, G_ATHLETE, G_COACH],
    );

    // Both guardians are real: a parents row with their contact details, and a
    // link to the child. This is the shape the purge could not touch.
    await guardianClient.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
       values ($1, 'PAR-PURGEABLE', $2, 'Purgeable Guardian', '555-0100', 'purgeable@example.test'),
              ($1, 'PAR-BLOCKED', $3, 'Blocked Guardian', '555-0101', 'blocked@example.test'),
              ($1, 'PAR-REMAINING', $4, 'Remaining Guardian', '555-0102', 'remaining@example.test')`,
      [G_ORG, PURGEABLE, BLOCKED, REMAINING],
    );
    await guardianClient.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'PAR-PURGEABLE', $2, 'mother'), ($1, 'PAR-BLOCKED', $2, 'father'),
              ($1, 'PAR-REMAINING', $2, 'aunt')`,
      [G_ORG, G_ATHLETE],
    );
    await guardianClient.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
          signed_at, consent_version, status, parent_id)
       values ($1, $2, $3, 'photo_media', 'Purgeable Guardian', 'parent', now(), 'v1', 'signed', 'PAR-PURGEABLE')`,
      [G_ORG, WAIVER_ID, G_ATHLETE],
    );

    // The blocked guardian filed a barrier report. POST /api/pilot/parent/
    // barrier-report writes pilot.coach_observations.coach_account_id with the
    // PARENT's own account id, and that foreign key restricts.
    await guardianClient.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, gen_random_uuid(), $2, $3, 'parent_barrier_transport', 'no ride on Thursdays')`,
      [G_ORG, G_ATHLETE, BLOCKED],
    );

    await guardianClient.query(
      `update pilot.accounts set deleted_at = now() - interval '2 years'
        where account_id = any($1::text[])`,
      [[PURGEABLE, BLOCKED]],
    );
  });

  afterAll(async () => {
    await guardianClient?.end();
  });

  test('the dry run still deletes nothing, though it now performs the delete', async () => {
    /* THE MOST DANGEROUS PROPERTY OF THIS CHANGE. The dry run used to run
       `select count(*)`; it now runs the real deletes and rolls them back, so
       that the number it reports is one it has earned. If that rollback were
       ever lost, the safest mode of the only permanently destructive job in
       the platform would silently become the most destructive. Asserted before
       anything else in this describe. */
    const { event } = await runCleanup(guardianEnv);
    expect(event.event).toBe('retention.cleanup.dry-run');
    expect(event.accounts).toBe(2);
    // It attempted, and reports what it found: one purgeable, one refused.
    expect(event.would_delete_accounts).toBe(1);
    expect(event.blocked).toBe(1);

    const survived = await guardianClient.query(
      `select account_id from pilot.accounts where account_id = any($1::text[])`,
      [[PURGEABLE, BLOCKED]],
    );
    expect(survived.rowCount).toBe(2);
    const parentsSurvived = await guardianClient.query(
      `select parent_id from pilot.parents where organization_id = $1`,
      [G_ORG],
    );
    expect(parentsSurvived.rowCount).toBe(3);
  });

  test('a dry run that found rows it cannot delete fails, so the schedule says so', async () => {
    /* This is the monitor. Counting could not report this, and did not: the
       nightly job reported a plausible number every night while the delete
       those rows were counted for could not execute at all. */
    const { code, event } = await runCleanup(guardianEnv);
    expect(code).not.toBe(0);
    expect(event.blocked_by).toEqual({ coach_observations_coach_account_id_fkey: 1 });
  });

  test('applying removes the guardian record with the account, and the waiver survives', async () => {
    const { code, event } = await runCleanup({ ...guardianEnv, PPBF_RETENTION_APPLY: 'true' });

    // One guardian purged, one refused -- and the run is not green, because
    // retention did not fully happen.
    expect(event.event).toBe('retention.cleanup.incomplete');
    expect(event.accounts).toBe(1);
    expect(event.blocked).toBe(1);
    expect(code).not.toBe(0);

    // The account is gone, and so is the personal data that blocked it.
    const account = await guardianClient.query(
      `select 1 from pilot.accounts where account_id = $1`, [PURGEABLE],
    );
    expect(account.rowCount).toBe(0);
    const parents = await guardianClient.query(
      `select parent_id from pilot.parents where organization_id = $1 order by parent_id`,
      [G_ORG],
    );
    expect(parents.rows.map((r: { parent_id: string }) => r.parent_id)).toEqual(['PAR-BLOCKED', 'PAR-REMAINING']);

    // guardian_links cascades off pilot.parents, so the purged guardian's link
    // to the child goes with them -- and the other guardian's does not.
    const links = await guardianClient.query(
      `select parent_id from pilot.guardian_links where organization_id = $1`, [G_ORG],
    );
    expect(links.rows.map((r: { parent_id: string }) => r.parent_id).sort()).toEqual(['PAR-BLOCKED', 'PAR-REMAINING']);

    /* AND THE WAIVER SURVIVES. Purging a withdrawn family must never destroy
       the document that authorised a minor's participation. parent_id is ON
       DELETE SET NULL, so the row keeps its signer, type, status and dates and
       loses only the pointer to a guardian record that no longer exists. */
    const waiver = await guardianClient.query<{
      signed_by_name: string; status: string; waiver_type: string; parent_id: string | null;
    }>(
      `select signed_by_name, status, waiver_type, parent_id from pilot.waivers
        where organization_id = $1 and waiver_id = $2`,
      [G_ORG, WAIVER_ID],
    );
    expect(waiver.rowCount).toBe(1);
    expect(waiver.rows[0].parent_id).toBeNull();
    expect(waiver.rows[0].signed_by_name).toBe('Purgeable Guardian');
    expect(waiver.rows[0].status).toBe('signed');
    expect(waiver.rows[0].waiver_type).toBe('photo_media');
  });

  test('the blocked guardian is left intact, not half-deleted', async () => {
    /* The savepoint has to roll back the parents delete too. Without it the
       guardian would lose their name, phone and email while their account
       stayed -- the worst of both, and unrecoverable. */
    const account = await guardianClient.query(
      `select 1 from pilot.accounts where account_id = $1`, [BLOCKED],
    );
    expect(account.rowCount).toBe(1);
    const parent = await guardianClient.query<{ full_name: string; email: string }>(
      `select full_name, email from pilot.parents where organization_id = $1 and parent_id = 'PAR-BLOCKED'`,
      [G_ORG],
    );
    expect(parent.rows[0].full_name).toBe('Blocked Guardian');
    expect(parent.rows[0].email).toBe('blocked@example.test');
  });

  test('the audit row records what was blocked, not just what was deleted', async () => {
    const audited = await guardianClient.query<{
      details: { accounts_deleted: number; blocked: number; blocked_by: Record<string, number> };
    }>(
      `select details from pilot.audit_events
        where event_type = 'data_purged' order by audit_id desc limit 1`,
    );
    expect(audited.rows[0].details.accounts_deleted).toBe(1);
    expect(audited.rows[0].details.blocked).toBe(1);
    expect(audited.rows[0].details.blocked_by).toEqual({ coach_observations_coach_account_id_fkey: 1 });
  });

  test('one athlete the platform cannot purge does not take the others with it', async () => {
    /* pilot.athletes is the healthy half -- 60 of the 61 foreign keys pointing
       at it cascade -- but pilot.one_percent_nominations RESTRICTS, and
       onePercentClub.ts writes those by athlete_id. As one statement the
       athlete delete was all-or-nothing, so a single nominated athlete would
       have blocked every other athlete's purge in the same sweep. Same
       savepoint treatment as the accounts. */
    const NOMINATED = 'ATH-GUARDIAN-NOMINATED';
    const PURGEABLE_ATHLETE = 'ATH-GUARDIAN-PURGEABLE';
    for (const athleteId of [NOMINATED, PURGEABLE_ATHLETE]) {
      await guardianClient.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Purge Subject', '2013-07-08', 'fly', 'active', 'contact', true, $3, now(), now())`,
        [G_ORG, athleteId, G_COACH],
      );
    }
    await guardianClient.query(
      `insert into pilot.one_percent_nominations
         (organization_id, nomination_id, athlete_id, source, nominated_by_account_id,
          nominated_by_role, expires_at)
       values ($1, 'NOM-1', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
      [G_ORG, NOMINATED, G_COACH],
    );
    await guardianClient.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years'
        where organization_id = $1 and athlete_id = any($2::text[])`,
      [G_ORG, [NOMINATED, PURGEABLE_ATHLETE]],
    );

    const { event } = await runCleanup({ ...guardianEnv, PPBF_RETENTION_APPLY: 'true' });
    expect(event.athletes).toBe(1);

    const gone = await guardianClient.query(
      `select athlete_id from pilot.athletes
        where organization_id = $1 and athlete_id = any($2::text[])`,
      [G_ORG, [NOMINATED, PURGEABLE_ATHLETE]],
    );
    expect(gone.rows.map((r: { athlete_id: string }) => r.athlete_id)).toEqual([NOMINATED]);
    expect(event.blocked_by).toMatchObject({ pilot_one_percent_nominations_athlete_fk: 1 });
  });
});
