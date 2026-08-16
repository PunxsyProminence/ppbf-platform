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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-one-percent-club-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_one_percent_club_migration.sql';

const ORG_ID = 'org-club';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-club-admin';
const COACH_ID = 'acct-club-coach';
const ATHLETE_ID = 'ath-club-1';
const OTHER_ORG_ATHLETE_ID = 'ath-elsewhere-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let achievementsSql: string;
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
