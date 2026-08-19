// Real PostgreSQL-backed contract test for the club-members migration.
//
// What needs proving that reading SQL cannot prove: the migration creates
// pilot.club_members from nothing; re-applying it is a no-op that leaves
// rows untouched; the membership_type vocabulary is enforced by the
// database; the name-lives-in-one-place split is enforced by the database
// (an athlete-linked row cannot carry its own full_name, a non-athlete row
// must); an athlete can be linked from at most one club_members row; and
// tenancy holds -- a club_members row can only reference an athlete in the
// SAME organization.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-club-members-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_club_members_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-club-members-migration.mjs',
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

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
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
  return client;
}

function insertNonAthleteMember(client: Client, memberId: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.club_members
       (organization_id, member_id, full_name, membership_type, address_line1, city, state, postal_code, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      memberId,
      overrides.full_name ?? 'Jason Neale',
      overrides.membership_type ?? 'non_athlete',
      overrides.address_line1 ?? '1 Main St',
      overrides.city ?? 'Punxsutawney',
      overrides.state ?? 'PA',
      overrides.postal_code ?? '15767',
      ADMIN_ID,
    ],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
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

describe('club members migration', () => {
  test('creates the table from nothing and accepts both a linked and an unlinked row', async () => {
    const client = await freshDatabase('club_fresh');
    try {
      await client.query(migrationSql);

      // Non-athlete member: no athlete_id, full_name required and present.
      await insertNonAthleteMember(client, 'mbr-owner');

      // Athlete-linked member: full_name null, name comes from the join.
      await client.query(
        `insert into pilot.club_members
           (organization_id, member_id, athlete_id, membership_type, address_line1, city, state, postal_code, created_by_account_id)
         values ($1, $2, $3, 'athlete', '', '', '', '', $4)`,
        [ORG_ID, ATHLETE_ID, ATHLETE_ID, ADMIN_ID],
      );

      const rows = await client.query(
        `select m.member_id, m.athlete_id, m.membership_type,
                coalesce(m.full_name, a.full_name) as resolved_name
         from pilot.club_members m
         left join pilot.athletes a
           on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
         where m.organization_id = $1
         order by m.member_id`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([
        { member_id: ATHLETE_ID, athlete_id: ATHLETE_ID, membership_type: 'athlete', resolved_name: 'Club Athlete' },
        { member_id: 'mbr-owner', athlete_id: null, membership_type: 'non_athlete', resolved_name: 'Jason Neale' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('club_noop');
    try {
      await client.query(migrationSql);
      await insertNonAthleteMember(client, 'mbr-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select member_id from pilot.club_members where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.member_id)).toEqual(['mbr-keep']);
    } finally {
      await client.end();
    }
  });

  test('membership_type is a database-enforced vocabulary', async () => {
    const client = await freshDatabase('club_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertNonAthleteMember(client, 'mbr-bad', { membership_type: 'board_member' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the name-lives-in-one-place split is enforced by the database', async () => {
    const client = await freshDatabase('club_name_split');
    try {
      await client.query(migrationSql);

      // A non-athlete row with a blank name is refused -- it has no other
      // record to join through.
      await expect(insertNonAthleteMember(client, 'mbr-noname', { full_name: '   ' }))
        .rejects.toMatchObject({ code: '23514' });

      // An athlete-linked row that ALSO carries its own full_name duplicates
      // a name the migration says must live in exactly one place.
      await expect(client.query(
        `insert into pilot.club_members
           (organization_id, member_id, athlete_id, full_name, membership_type, created_by_account_id)
         values ($1, $2, $3, 'Duplicate Name', 'athlete', $4)`,
        [ORG_ID, ATHLETE_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('at most one club_members row per athlete link', async () => {
    const client = await freshDatabase('club_one_per_athlete');
    try {
      await client.query(migrationSql);

      await client.query(
        `insert into pilot.club_members
           (organization_id, member_id, athlete_id, membership_type, created_by_account_id)
         values ($1, $2, $3, 'athlete', $4)`,
        [ORG_ID, ATHLETE_ID, ATHLETE_ID, ADMIN_ID],
      );

      await expect(client.query(
        `insert into pilot.club_members
           (organization_id, member_id, athlete_id, membership_type, created_by_account_id)
         values ($1, 'mbr-second-row', $2, 'athlete', $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ constraint: 'idx_club_members_one_per_athlete' });
    } finally {
      await client.end();
    }
  });

  test('tenancy is structural: a club_members row cannot link an athlete from another organization', async () => {
    const client = await freshDatabase('club_tenancy');
    try {
      await client.query(migrationSql);

      await expect(client.query(
        `insert into pilot.club_members
           (organization_id, member_id, athlete_id, membership_type, created_by_account_id)
         values ($1, $2, $3, 'athlete', $4)`,
        [OTHER_ORG_ID, 'mbr-cross', ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-club-members-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('club members runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('clubm_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CLUB_MEMBERS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('clubm_rdy_ok');
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
