// Real PostgreSQL-backed contract test for the 1% Club migration (module
// 127).
//
// What needs proving that reading SQL cannot prove: the tables create from
// nothing and re-apply as a no-op; a nomination requires a real athlete in
// the SAME organization; a withdrawn nomination is REQUIRED to carry a
// reason (the check constraint, not just the application); a vote cannot be
// cast twice by the same account (the primary key, not just the
// application); a confirmed nomination's row survives with its votes
// intact; and -- the point of the module -- there is no numeric
// "worthiness" column anywhere in either table.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-one-percent-club-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_one_percent_club_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-one-percent-club-migration.mjs',
);
// OD-2026-08-29-007: the nomination's foreign key onto pilot.athletes becomes
// ON DELETE CASCADE. A separate migration with its own runner, tested here
// because it changes a constraint this suite's migration creates.
const CASCADE_MIGRATION_FILE = 'pilot_slice_postgres_one_percent_nomination_athlete_cascade_migration.sql';
const CASCADE_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-one-percent-nomination-athlete-cascade-migration.mjs',
);
// The achievements migration is this file's prerequisite, and its runner had
// no suite driving it anywhere in the repository, so its readiness assertion
// is exercised here too rather than left to a dispatch to discover.
const ACHIEVEMENTS_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-achievements-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-club';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-club-admin';
const COACH_ID = 'acct-club-coach';
const ATHLETE_ID = 'ath-club-1';
const OTHER_ORG_ATHLETE_ID = 'ath-elsewhere-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyAchievementsMigration: (client: Client, sql: string) => Promise<void>;
let achievementsSql: string;
let cascadeSql: string;
let applyCascadeMigration: (client: Client, sql: string) => Promise<void>;
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
  await client.query(achievementsSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', true), ($3, 'coach', $2, 'microsoft', true)
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Club Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Elsewhere Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [OTHER_ORG_ID, OTHER_ORG_ATHLETE_ID, ADMIN_ID],
  );
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  achievementsSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_achievements_migration.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  cascadeSql = await fs.readFile(path.join(INFRA_DIR, CASCADE_MIGRATION_FILE), 'utf8');
  const cascadeRunner = await nativeDynamicImport(pathToFileURL(CASCADE_RUNNER_PATH).href);
  applyCascadeMigration = cascadeRunner.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

  const achievementsRunner = await nativeDynamicImport(pathToFileURL(ACHIEVEMENTS_RUNNER_PATH).href);
  applyAchievementsMigration = achievementsRunner.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('1% Club migration', () => {
  test('creates its tables from nothing, re-applies as a no-op, and holds no worthiness column', async () => {
    const client = await freshDatabase('one_percent_club_fresh');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);

      const columns = await client.query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'pilot' and table_name in ('one_percent_nominations', 'one_percent_votes')`,
      );
      const columnNames = columns.rows.map((row) => row.column_name);
      // THE POINT: nothing computes or stores a rank, score, or worthiness.
      // Word-bounded matches: 'expires_at' legitimately contains the letters
      // "xp", and a bare substring check would misfire on it.
      for (const forbidden of ['score', 'rank', 'worthiness', 'points', 'leaderboard']) {
        expect(columnNames.some((name: string) => new RegExp(`(^|_)${forbidden}(_|$)`).test(name))).toBe(false);
      }
    } finally {
      await client.end();
    }
  });

  test('a nomination requires a real athlete in the SAME organization', async () => {
    const client = await freshDatabase('one_percent_club_org_scope');
    try {
      await client.query(migrationSql);

      await expect(client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-cross-org', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, OTHER_ORG_ATHLETE_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });

      await client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-1', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      const rows = await client.query(
        `select nomination_id from pilot.one_percent_nominations where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ nomination_id: 'nom-1' }]);
    } finally {
      await client.end();
    }
  });

  test('a milestone_surfaced nomination without a milestone_key is refused by the constraint itself', async () => {
    const client = await freshDatabase('one_percent_club_milestone_check');
    try {
      await client.query(migrationSql);

      await expect(client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-bad-milestone', $2, 'milestone_surfaced', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23514' });

      await client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, milestone_key, expires_at)
         values ($1, 'nom-good-milestone', $2, 'milestone_surfaced', $3, 'coach', 'consistency.233', now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
    } finally {
      await client.end();
    }
  });

  test('a withdrawn nomination is REFUSED by the database itself if it carries no reason', async () => {
    const client = await freshDatabase('one_percent_club_withdrawal_reason');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-1', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );

      await expect(client.query(
        `update pilot.one_percent_nominations set status = 'withdrawn' where organization_id = $1 and nomination_id = 'nom-1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      // Nothing was deleted by the failed attempt -- it is still 'open'.
      const row = await client.query(
        `select status from pilot.one_percent_nominations where organization_id = $1 and nomination_id = 'nom-1'`,
        [ORG_ID],
      );
      expect(row.rows).toEqual([{ status: 'open' }]);

      await client.query(
        `update pilot.one_percent_nominations set status = 'withdrawn', withdrawal_reason = 'filed by mistake'
         where organization_id = $1 and nomination_id = 'nom-1'`,
        [ORG_ID],
      );
      const withdrawn = await client.query(
        `select status, withdrawal_reason from pilot.one_percent_nominations where organization_id = $1 and nomination_id = 'nom-1'`,
        [ORG_ID],
      );
      expect(withdrawn.rows).toEqual([{ status: 'withdrawn', withdrawal_reason: 'filed by mistake' }]);
    } finally {
      await client.end();
    }
  });

  test('the same account cannot vote twice on one nomination -- the primary key refuses it, not just the application', async () => {
    const client = await freshDatabase('one_percent_club_vote_pk');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-1', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      await client.query(
        `insert into pilot.one_percent_votes (organization_id, nomination_id, voter_account_id, voter_role, vote)
         values ($1, 'nom-1', $2, 'organization_admin', 'yes')`,
        [ORG_ID, ADMIN_ID],
      );

      await expect(client.query(
        `insert into pilot.one_percent_votes (organization_id, nomination_id, voter_account_id, voter_role, vote)
         values ($1, 'nom-1', $2, 'organization_admin', 'no')`,
        [ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.end();
    }
  });

  test('a confirmed nomination and its votes survive together, and votes cascade if the nomination is ever removed', async () => {
    const client = await freshDatabase('one_percent_club_cascade');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, status, decided_at, expires_at)
         values ($1, 'nom-1', $2, 'coach_nomination', $3, 'coach', 'confirmed', now(), now() + interval '30 days')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      await client.query(
        `insert into pilot.one_percent_votes (organization_id, nomination_id, voter_account_id, voter_role, vote)
         values ($1, 'nom-1', $2, 'organization_admin', 'yes'), ($1, 'nom-1', $3, 'coach', 'yes')`,
        [ORG_ID, ADMIN_ID, COACH_ID],
      );

      const votes = await client.query(
        `select voter_account_id, vote from pilot.one_percent_votes where organization_id = $1 and nomination_id = 'nom-1' order by voter_account_id`,
        [ORG_ID],
      );
      expect(votes.rows).toHaveLength(2);

      await client.query(`delete from pilot.one_percent_nominations where organization_id = $1 and nomination_id = 'nom-1'`, [ORG_ID]);
      const remainingVotes = await client.query(
        `select voter_account_id from pilot.one_percent_votes where organization_id = $1 and nomination_id = 'nom-1'`,
        [ORG_ID],
      );
      expect(remainingVotes.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-one-percent-club-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('one percent club runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('onepct_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ONE_PERCENT_CLUB_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('onepct_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});

// OD-2026-08-29-007, the option the owner selected: "Delete it with the athlete
// (Recommended)". The retention purge hard-deletes an athlete two years after
// withdrawal with a bare `delete from pilot.athletes`; these cases issue that
// same statement, so what is measured is the referential action the purge
// depends on. The purge job itself is driven end to end in
// dataRetentionDeletion.pg.test.ts.
describe('nomination-athlete cascade migration', () => {
  const SECOND_ATHLETE_ID = 'ath-club-2';

  async function athleteFkDeleteActions(client: Client): Promise<string[]> {
    const result = await client.query<{ confdeltype: string }>(
      `select c.confdeltype from pg_constraint c
        where c.conrelid = 'pilot.one_percent_nominations'::regclass
          and c.confrelid = 'pilot.athletes'::regclass
          and c.contype = 'f'`,
    );
    return result.rows.map((row) => row.confdeltype);
  }

  // One nomination with one vote on each of two athletes in the same gym.
  async function seedTwoNominations(client: Client): Promise<void> {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Second Club Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, SECOND_ATHLETE_ID, COACH_ID],
    );
    await client.query(
      `insert into pilot.one_percent_nominations
         (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, status, decided_at, expires_at)
       values ($1, 'nom-1', $2, 'coach_nomination', $4, 'coach', 'confirmed', now(), now() + interval '30 days'),
              ($1, 'nom-2', $3, 'coach_nomination', $4, 'coach', 'open', null, now() + interval '30 days')`,
      [ORG_ID, ATHLETE_ID, SECOND_ATHLETE_ID, COACH_ID],
    );
    await client.query(
      `insert into pilot.one_percent_votes (organization_id, nomination_id, voter_account_id, voter_role, vote)
       values ($1, 'nom-1', $2, 'organization_admin', 'yes'), ($1, 'nom-2', $2, 'organization_admin', 'yes')`,
      [ORG_ID, ADMIN_ID],
    );
  }

  test('BEFORE it, deleting a nominated athlete is refused by the foreign key, by name', async () => {
    // The state the retention purge reported as a blocker. Pinned so the
    // cases below are known to start from a refusal, not from a schema that
    // already cascaded.
    const client = await freshDatabase('onepct_cascade_before');
    try {
      await client.query(migrationSql);
      await seedTwoNominations(client);
      expect(await athleteFkDeleteActions(client)).toEqual(['a']);

      await expect(client.query(
        `delete from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      )).rejects.toMatchObject({ code: '23503', constraint: 'pilot_one_percent_nominations_athlete_fk' });
    } finally {
      await client.end();
    }
  });

  test('AFTER it, the nomination and its votes are deleted with the athlete, and no other athlete loses theirs', async () => {
    const client = await freshDatabase('onepct_cascade_after');
    try {
      await client.query(migrationSql);
      await seedTwoNominations(client);

      await client.query(cascadeSql);
      expect(await athleteFkDeleteActions(client)).toEqual(['c']);

      // Changing the constraint removed nothing by itself.
      const untouched = await client.query(
        `select nomination_id from pilot.one_percent_nominations where organization_id = $1 order by nomination_id`,
        [ORG_ID],
      );
      expect(untouched.rows).toEqual([{ nomination_id: 'nom-1' }, { nomination_id: 'nom-2' }]);

      await client.query(
        `delete from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );

      // Gone: the deleted athlete's nomination, confirmed or not, and its vote.
      // Still here: the other athlete's nomination and its vote.
      const nominations = await client.query(
        `select nomination_id, athlete_id from pilot.one_percent_nominations where organization_id = $1`,
        [ORG_ID],
      );
      expect(nominations.rows).toEqual([{ nomination_id: 'nom-2', athlete_id: SECOND_ATHLETE_ID }]);
      const votes = await client.query(
        `select nomination_id from pilot.one_percent_votes where organization_id = $1`,
        [ORG_ID],
      );
      expect(votes.rows).toEqual([{ nomination_id: 'nom-2' }]);
    } finally {
      await client.end();
    }
  });

  test('it re-applies as a no-op, survives the club migration re-running after it, and keeps one foreign key', async () => {
    const client = await freshDatabase('onepct_cascade_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(cascadeSql);
      const first = await client.query<{ oid: number }>(
        `select oid from pg_constraint
          where conname = 'pilot_one_percent_nominations_athlete_fk'
            and conrelid = 'pilot.one_percent_nominations'::regclass`,
      );
      expect(first.rowCount).toBe(1);

      // The `all` chain re-runs every migration on every dispatch: this one
      // again, and the club migration that first created the restricting key.
      await client.query(cascadeSql);
      await client.query(migrationSql);
      await client.query(cascadeSql);

      const second = await client.query<{ oid: number }>(
        `select oid from pg_constraint
          where conname = 'pilot_one_percent_nominations_athlete_fk'
            and conrelid = 'pilot.one_percent_nominations'::regclass`,
      );
      // Same oid: the later passes did not drop and re-add it.
      expect(second.rows).toEqual(first.rows);
      expect(await athleteFkDeleteActions(client)).toEqual(['c']);
    } finally {
      await client.end();
    }
  });

  test('the key still refuses a nomination naming an athlete in another organization', async () => {
    // Re-adding a foreign key is a chance to re-add the wrong one. A scalar
    // key on athlete_id alone would accept this row.
    const client = await freshDatabase('onepct_cascade_org_scope');
    try {
      await client.query(migrationSql);
      await client.query(cascadeSql);
      await expect(client.query(
        `insert into pilot.one_percent_nominations
           (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
         values ($1, 'nom-cross-org', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
        [ORG_ID, OTHER_ORG_ATHLETE_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503', constraint: 'pilot_one_percent_nominations_athlete_fk' });
    } finally {
      await client.end();
    }
  });

  test('the SQL refuses a database that has no nominations table', async () => {
    const client = await freshDatabase('onepct_cascade_no_table');
    try {
      await expect(client.query(cascadeSql)).rejects.toThrow(
        /ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the key still restricts', async () => {
    // The constraint's NAME is already there after the club migration, so a
    // readiness check on the name alone would pass here.
    const client = await freshDatabase('onepct_cascade_rdy_no');
    try {
      await client.query(migrationSql);
      await expect(applyCascadeMigration(client, 'select 1')).rejects.toThrow(
        /ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY/,
      );
      expect(await athleteFkDeleteActions(client)).toEqual(['a']);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a second, restricting key onto pilot.athletes, and rolls its own work back', async () => {
    // The named key cascades after the SQL runs, so `athlete_fk_cascades` is
    // true here; only `no_restricting_athlete_fk` can refuse. The second key
    // is added by the SQL the runner is handed, after the real migration, so
    // the migration's own drop loop has already run and cannot remove it.
    const client = await freshDatabase('onepct_cascade_rdy_second_key');
    try {
      await client.query(migrationSql);
      const sql = `${cascadeSql}
        alter table pilot.one_percent_nominations
          add constraint test_second_athlete_fk
          foreign key (organization_id, athlete_id)
          references pilot.athletes(organization_id, athlete_id);`;
      await expect(applyCascadeMigration(client, sql)).rejects.toThrow(
        /ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY/,
      );
      // Refusing rolled the whole transaction back, the migration included.
      expect(await athleteFkDeleteActions(client)).toEqual(['a']);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the votes no longer cascade from the nomination', async () => {
    // The athlete delete reaches the votes through the nomination. If that
    // key restricted, the purge would be refused one table further down.
    const client = await freshDatabase('onepct_cascade_rdy_votes');
    try {
      await client.query(migrationSql);
      await client.query(
        `alter table pilot.one_percent_votes drop constraint pilot_one_percent_votes_nomination_fk`,
      );
      await client.query(
        `alter table pilot.one_percent_votes
           add constraint pilot_one_percent_votes_nomination_fk
           foreign key (organization_id, nomination_id)
           references pilot.one_percent_nominations(organization_id, nomination_id)`,
      );
      await expect(applyCascadeMigration(client, cascadeSql)).rejects.toThrow(
        /ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a migrated database when pilot is on the search_path', async () => {
    // pg_get_constraintdef() drops the schema qualifier for a schema on the
    // search_path, so a readiness check that matched its text would refuse
    // here. The check compares column numbers instead.
    const client = await freshDatabase('onepct_cascade_rdy_search_path');
    try {
      await client.query(migrationSql);
      await client.query(`set search_path to pilot, public`);
      await applyCascadeMigration(client, cascadeSql);
      expect(await athleteFkDeleteActions(client)).toEqual(['c']);
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('onepct_cascade_rdy_ok');
    try {
      await client.query(migrationSql);
      await applyCascadeMigration(client, cascadeSql);
      await applyCascadeMigration(client, cascadeSql);
      expect(await athleteFkDeleteActions(client)).toEqual(['c']);
    } finally {
      await client.end();
    }
  });
});

// The achievements runner's readiness assertion has the exact shape that
// failed in #488: eleven of its clauses match pg_get_constraintdef() output
// against literal quoted vocabulary terms, and five more assert the ABSENCE
// of scoring/severity columns. Nothing in the repository executed it. It is
// this suite's prerequisite migration, so it is executed here.
describe('achievements runner readiness assertion', () => {
  test('the real achievements runner REFUSES a database where its migration never ran', async () => {
    const client = await freshDatabase('onepct_ach_no');
    try {
      // freshDatabase() applies the achievements migration, so one of the
      // tables its readiness check demands has to come back off to reach the
      // pre-migration state a dispatch actually meets.
      await client.query('drop table if exists pilot.recognitions cascade');
      await expect(applyAchievementsMigration(client, 'select 1')).rejects.toThrow(
        /ACHIEVEMENTS_NOT_READY/,
      );
      // Refusing rolled back rather than leaving the table half-restored.
      const table = await client.query(`select to_regclass('pilot.recognitions') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the real achievements runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('onepct_ach_ok');
    try {
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the runner has to survive finding its own work already done.
      await applyAchievementsMigration(client, achievementsSql);
      await applyAchievementsMigration(client, achievementsSql);
    } finally {
      await client.end();
    }
  });
});
