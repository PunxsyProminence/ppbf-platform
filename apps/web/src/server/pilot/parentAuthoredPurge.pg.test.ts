import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-authored-purge-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_parent_authored_purge_migration.sql');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-parent-authored-purge-migration.mjs',
);

const ORG_ID = 'org-parent-authored';
const COACH_ID = 'acct-parent-authored-coach';
const GUARDIAN_ID = 'guardian.purged@example.test';
const ATHLETE_ID = 'ATH-PARENT-AUTHORED';
const NOTE_ID = '7a1c9f00-2222-4333-8444-555566667777';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string;
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
 * The exact state this decision is about: a guardian who filed a barrier
 * report about their own child, and ticked a task off, and whose child is
 * STILL ENROLLED. The athlete is deliberately not soft-deleted -- if they were,
 * coach_observations would cascade from pilot.athletes and none of this would
 * arise.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(schemaSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft'), ($3, 'parent', $2, 'microsoft')`,
    [COACH_ID, ORG_ID, GUARDIAN_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Still Enrolled', '2013-02-03', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );

  // The barrier report. author_role is 'parent' because that is what
  // POST /api/pilot/parent/barrier-report passes (principal.role).
  await client.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
     values ($1, $2, $3, $4, 'parent', 'parent_barrier_transport', 'no ride on Thursdays')`,
    [ORG_ID, NOTE_ID, ATHLETE_ID, GUARDIAN_ID],
  );

  // A task a coach set on that message, which the guardian then ticked off.
  await client.query(
    `insert into pilot.parent_task_state
       (organization_id, note_id, due_date, completed_at, completed_by_account_id, created_by_account_id)
     values ($1, $2, current_date, now(), $3, $4)`,
    [ORG_ID, NOTE_ID, GUARDIAN_ID, COACH_ID],
  );

  return client;
}

const purgeGuardian = (client: Client) =>
  client.query('delete from pilot.accounts where account_id = $1', [GUARDIAN_ID]);

async function observation(client: Client) {
  const r = await client.query<{
    coach_account_id: string | null; author_role: string | null; note_text: string;
  }>(
    `select coach_account_id, author_role, note_text from pilot.coach_observations
      where organization_id = $1 and note_id = $2`,
    [ORG_ID, NOTE_ID],
  );
  return r.rows[0] ?? null;
}

const taskStateCount = async (client: Client) =>
  (await client.query('select 1 from pilot.parent_task_state where organization_id = $1', [ORG_ID]))
    .rowCount;

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) { clearTimeout(timeout); rl.close(); resolve(); }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  /* Three migrations make the before-state real: author_role is what survives
     the detach, and parent_task_state is the second half of the decision. */
  schemaSql = [
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'),
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_observation_author_role_migration.sql'), 'utf8'),
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_parent_task_state_migration.sql'), 'utf8'),
  ].join('\n');
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(safety); resolve(); };
    const safety = setTimeout(finish, 15_000);
    safety.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('before the migration, the guardian cannot be purged at all', () => {
  it('the barrier report blocks the delete', async () => {
    const client = await freshDatabase('ppbf_test_pap_before');
    try {
      await expect(purgeGuardian(client)).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  it('and SET NULL on the task completer alone is impossible, which is why it cascades', async () => {
    /* The constraint that made "one rule for both tables" unavailable. Quoted
       in the migration and measured here: nulling the completer while
       completed_at stands raises against the paired CHECK, so "keep it, forget
       who" is not a shape this table permits. */
    const client = await freshDatabase('ppbf_test_pap_paired');
    try {
      await expect(
        client.query(
          `update pilot.parent_task_state set completed_by_account_id = null
            where organization_id = $1 and note_id = $2`,
          [ORG_ID, NOTE_ID],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});

describe('after the migration', () => {
  it('purges the guardian, keeps the report, and says a guardian filed it', async () => {
    const client = await freshDatabase('ppbf_test_pap_after');
    try {
      await client.query(migrationSql);
      await expect(purgeGuardian(client)).resolves.toBeDefined();

      const row = await observation(client);
      expect(row).not.toBeNull();
      expect(row?.coach_account_id).toBeNull();
      // The whole reason "detached" is not "anonymous".
      expect(row?.author_role).toBe('parent');
      expect(row?.note_text).toBe('no ride on Thursdays');
    } finally {
      await client.end();
    }
  });

  it('takes the task-state row with them', async () => {
    const client = await freshDatabase('ppbf_test_pap_task');
    try {
      await client.query(migrationSql);
      expect(await taskStateCount(client)).toBe(1);
      await purgeGuardian(client);
      expect(await taskStateCount(client)).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('leaves the paired CHECK exactly as it was', async () => {
    /* Weakening this was offered to the owner and declined. A migration that
       quietly dropped it would make the rejected option true after the fact. */
    const client = await freshDatabase('ppbf_test_pap_check_intact');
    try {
      await client.query(migrationSql);
      await expect(
        client.query(
          `update pilot.parent_task_state set completed_by_account_id = null
            where organization_id = $1 and note_id = $2`,
          [ORG_ID, NOTE_ID],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  it('does not widen the task creator, which no guardian can ever be', async () => {
    const client = await freshDatabase('ppbf_test_pap_creator');
    try {
      await client.query(migrationSql);
      const col = await client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_schema = 'pilot' and table_name = 'parent_task_state'
            and column_name = 'created_by_account_id'`,
      );
      expect(col.rows[0].is_nullable).toBe('NO');

      // And deleting the creator is still refused, not cascaded.
      await expect(
        client.query('delete from pilot.accounts where account_id = $1', [COACH_ID]),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  it('still removes the observation when the athlete goes', async () => {
    /* The pre-existing cascade from pilot.athletes is what makes this decision
       narrow. If it ever stopped working, a fully withdrawn family would keep
       these rows for ever and the migration's reasoning would be wrong. */
    const client = await freshDatabase('ppbf_test_pap_athlete');
    try {
      await client.query(migrationSql);
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, ATHLETE_ID]);
      expect(await observation(client)).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('re-applying is a no-op, so `all` can run it against any environment', async () => {
    const client = await freshDatabase('ppbf_test_pap_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      await expect(purgeGuardian(client)).resolves.toBeDefined();
      expect((await observation(client))?.coach_account_id).toBeNull();
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
    const client = await freshDatabase('ppbf_test_pap_runner_ok');
    try {
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  it('throws when the SQL changed nothing', async () => {
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_pap_runner_unmigrated');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        'PARENT_AUTHORED_PURGE_NOT_READY',
      );
    } finally {
      await client.end();
    }
  });

  it('throws when the paired CHECK was dropped to force SET NULL', async () => {
    /* The rejected option, refused at the gate. A database where someone
       removed the constraint reads as "more migrated", not less, so nothing
       else here would notice. */
    const { applyMigrationTransaction } = await loadRunner();
    const client = await freshDatabase('ppbf_test_pap_runner_check_dropped');
    try {
      await expect(
        applyMigrationTransaction(
          client,
          `${migrationSql}
           alter table pilot.parent_task_state
             drop constraint pilot_parent_task_state_completion_paired;`,
        ),
      ).rejects.toThrow('PARENT_AUTHORED_PURGE_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
