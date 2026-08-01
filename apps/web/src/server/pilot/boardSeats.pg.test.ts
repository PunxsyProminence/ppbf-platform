// Real PostgreSQL-backed contract test for the board seats migration.
//
// The eight board seats have never existed in the database. pilot.accounts.role
// and pilot.organization_memberships.role each admit exactly one board value,
// 'board', and the seat names live only in
// apps/web/app/board/boardWorkspaceConfig.ts as display copy -- so President
// versus Treasurer has been a URL slug and nothing more.
//
// Four things need proving, and none can be proven by reading SQL:
//
// 1. The database, not application code, refuses a second primary holder of one
//    seat. Two concurrent assignments each read no existing primary and both
//    write, so a check in TypeScript loses that race by construction. The
//    rejection is asserted for INSERT and for a promoting UPDATE.
//
// 2. Co-holders stay legal. Co-chairs, a successor shadowing an outgoing
//    officer and someone covering an absence are rows with is_primary = false,
//    and a partial index is the only shape that forbids the first while
//    allowing any number of the second.
//
// 3. The vocabulary is the app's. The slugs are imported from the board
//    workspace config rather than retyped, so a seat the pages can route to and
//    a seat the database accepts cannot drift apart.
//
// 4. The runner's readiness check actually fails when the migration did not
//    land. An all-green suite whose readiness passes on an unmigrated database
//    proves nothing, so that case -- and the case where only the single-primary
//    index is missing -- are asserted directly against the real runner.
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

import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-board-seats-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_board_seats_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-board-seats-migration.mjs',
);

const ORG_A = 'org-seats-a';
const ORG_B = 'org-seats-b';
const ADMIN_ID = 'acct-seats-admin';
const PRESIDENT_ID = 'acct-seats-president';
const VICE_ID = 'acct-seats-vice';
const TREASURER_ID = 'acct-seats-treasurer';
const ORG_B_PRESIDENT_ID = 'acct-seats-b-president';

// The authority for the slug list is the file the /board/[seat] pages route on.
const SEAT_SLUGS = boardSeatConfigs.map((seat) => seat.slug);

// The read that lands a member on their own seat, and the read that lists a
// seat's holders with the person who holds it outright first.
const ACCOUNT_SEATS_SQL = `
  select seat, is_primary
  from pilot.board_seats
  where organization_id = $1 and account_id = $2
  order by seat`;

const SEAT_HOLDERS_SQL = `
  select account_id, is_primary
  from pilot.board_seats
  where organization_id = $1 and seat = $2
  order by is_primary desc, account_id`;

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let boardRoleSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
 * Fresh database with the base schema, the board role vocabulary, two
 * organizations and the accounts the foreign keys need. This migration is NOT
 * applied here -- each test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  // Without this, role = 'board' violates the base schema's role CHECK and no
  // board member can exist to hold a seat.
  await client.query(boardRoleSql);

  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  const accounts: Array<[string, string, string]> = [
    [ADMIN_ID, 'organization_admin', ORG_A],
    [PRESIDENT_ID, 'board', ORG_A],
    [VICE_ID, 'board', ORG_A],
    [TREASURER_ID, 'board', ORG_A],
    [ORG_B_PRESIDENT_ID, 'board', ORG_B],
  ];
  for (const [accountId, role, organizationId] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'ppbf_local') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }
  return client;
}

async function assignSeat(
  client: Client,
  values: { organizationId?: string; seat: string; accountId: string; isPrimary?: boolean },
): Promise<void> {
  await client.query(
    `insert into pilot.board_seats
       (organization_id, seat, account_id, is_primary, assigned_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [
      values.organizationId ?? ORG_A,
      values.seat,
      values.accountId,
      values.isPrimary ?? false,
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
  boardRoleSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_board_role_migration.sql'), 'utf8');
  // Like the announcements and volunteer-program runners, this runner opens the
  // transaction itself, so the file applies here as plain statements exactly as
  // the runner sends it.
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
});

describe('board seats migration against real Postgres', () => {
  test('the gap is real: without the migration no seat can be recorded or read', async () => {
    const client = await freshDatabase('ppbf_test_seats_absent');
    try {
      const table = await client.query(`select to_regclass('pilot.board_seats') as t`);
      expect(table.rows[0].t).toBeNull();

      await expect(client.query(ACCOUNT_SEATS_SQL, [ORG_A, PRESIDENT_ID])).rejects.toThrow(
        /board_seats|does not exist/,
      );
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // migration silently did nothing.
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_seats_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /BOARD_SEATS_NOT_READY/,
      );

      const table = await client.query(`select to_regclass('pilot.board_seats') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The readiness check has to measure the single-primary rule specifically. A
  // table-only check would pass on an environment that admits two Presidents.
  test('the readiness check REFUSES a database whose single-primary index is missing', async () => {
    const client = await freshDatabase('ppbf_test_seats_readiness_index');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('drop index pilot.pilot_board_seats_one_primary_per_seat');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /BOARD_SEATS_NOT_READY/,
      );

      // Re-running restores it, so a damaged environment is repaired rather
      // than left needing hand surgery.
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select indisunique, indpred is not null as is_partial
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         where c.relname = 'pilot_board_seats_one_primary_per_seat'`,
      );
      expect(rows).toEqual([{ indisunique: true, is_partial: true }]);
    } finally {
      await client.end();
    }
  });

  test('every seat the board pages route on is accepted, and nothing else is', async () => {
    const client = await freshDatabase('ppbf_test_seats_vocabulary');
    try {
      await applyMigrationTransaction(client, migrationSql);

      expect(SEAT_SLUGS).toHaveLength(8);
      for (const seat of SEAT_SLUGS) {
        await assignSeat(client, { seat, accountId: PRESIDENT_ID, isPrimary: true });
      }
      const held = await client.query(ACCOUNT_SEATS_SQL, [ORG_A, PRESIDENT_ID]);
      expect(held.rows.map((row: { seat: string }) => row.seat).sort())
        .toEqual([...SEAT_SLUGS].sort());

      // A slug no page can render is an assignment nobody could open.
      await expect(
        assignSeat(client, { seat: 'vice-president', accountId: VICE_ID, isPrimary: false }),
      ).rejects.toThrow(/pilot_board_seats_seat_check/);
    } finally {
      await client.end();
    }
  });

  test('a seat holds one primary and any number of additional holders', async () => {
    const client = await freshDatabase('ppbf_test_seats_co_holders');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await assignSeat(client, { seat: 'chair', accountId: PRESIDENT_ID, isPrimary: true });
      await assignSeat(client, { seat: 'chair', accountId: VICE_ID, isPrimary: false });
      await assignSeat(client, { seat: 'chair', accountId: TREASURER_ID, isPrimary: false });

      const holders = await client.query(SEAT_HOLDERS_SQL, [ORG_A, 'chair']);
      expect(holders.rows).toEqual([
        { account_id: PRESIDENT_ID, is_primary: true },
        { account_id: TREASURER_ID, is_primary: false },
        { account_id: VICE_ID, is_primary: false },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a SECOND primary on one seat is refused by the database', async () => {
    const client = await freshDatabase('ppbf_test_seats_second_primary');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'treasurer', accountId: TREASURER_ID, isPrimary: true });

      await expect(
        assignSeat(client, { seat: 'treasurer', accountId: VICE_ID, isPrimary: true }),
      ).rejects.toThrow(/pilot_board_seats_one_primary_per_seat|duplicate key/);

      // Promoting an existing co-holder is the same violation by another route.
      await assignSeat(client, { seat: 'treasurer', accountId: VICE_ID, isPrimary: false });
      await expect(
        client.query(
          `update pilot.board_seats set is_primary = true
           where organization_id = $1 and seat = 'treasurer' and account_id = $2`,
          [ORG_A, VICE_ID],
        ),
      ).rejects.toThrow(/pilot_board_seats_one_primary_per_seat|duplicate key/);

      const holders = await client.query(SEAT_HOLDERS_SQL, [ORG_A, 'treasurer']);
      expect(holders.rows).toEqual([
        { account_id: TREASURER_ID, is_primary: true },
        { account_id: VICE_ID, is_primary: false },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a handover demotes the outgoing holder and promotes the incoming one', async () => {
    // The transition the seat exists to survive: both statements in one
    // transaction, and the index still holds at commit.
    const client = await freshDatabase('ppbf_test_seats_handover');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'secretary', accountId: PRESIDENT_ID, isPrimary: true });
      await assignSeat(client, { seat: 'secretary', accountId: VICE_ID, isPrimary: false });

      await client.query('BEGIN');
      await client.query(
        `update pilot.board_seats set is_primary = false, updated_at = now()
         where organization_id = $1 and seat = 'secretary' and account_id = $2`,
        [ORG_A, PRESIDENT_ID],
      );
      await client.query(
        `update pilot.board_seats set is_primary = true, updated_at = now()
         where organization_id = $1 and seat = 'secretary' and account_id = $2`,
        [ORG_A, VICE_ID],
      );
      await client.query('COMMIT');

      const holders = await client.query(SEAT_HOLDERS_SQL, [ORG_A, 'secretary']);
      expect(holders.rows).toEqual([
        { account_id: VICE_ID, is_primary: true },
        { account_id: PRESIDENT_ID, is_primary: false },
      ]);
    } finally {
      await client.end();
    }
  });

  test('the same seat in a different organization is unaffected', async () => {
    const client = await freshDatabase('ppbf_test_seats_cross_org');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'president', accountId: PRESIDENT_ID, isPrimary: true });
      await assignSeat(client, {
        organizationId: ORG_B,
        seat: 'president',
        accountId: ORG_B_PRESIDENT_ID,
        isPrimary: true,
      });

      const orgA = await client.query(SEAT_HOLDERS_SQL, [ORG_A, 'president']);
      const orgB = await client.query(SEAT_HOLDERS_SQL, [ORG_B, 'president']);
      expect(orgA.rows).toEqual([{ account_id: PRESIDENT_ID, is_primary: true }]);
      expect(orgB.rows).toEqual([{ account_id: ORG_B_PRESIDENT_ID, is_primary: true }]);

      // Each gym still gets exactly one, independently.
      await expect(
        assignSeat(client, {
          organizationId: ORG_B,
          seat: 'president',
          accountId: PRESIDENT_ID,
          isPrimary: true,
        }),
      ).rejects.toThrow(/pilot_board_seats_one_primary_per_seat|duplicate key/);
    } finally {
      await client.end();
    }
  });

  test('one account holds a seat once, and may hold more than one seat', async () => {
    const client = await freshDatabase('ppbf_test_seats_holder_key');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'at-large', accountId: VICE_ID, isPrimary: true });

      await expect(
        assignSeat(client, { seat: 'at-large', accountId: VICE_ID, isPrimary: false }),
      ).rejects.toThrow(/pilot_board_seats_pkey|duplicate key/);

      // Small boards double up, so a second seat for the same person is legal.
      await assignSeat(client, { seat: 'vice-chair', accountId: VICE_ID, isPrimary: true });
      const held = await client.query(ACCOUNT_SEATS_SQL, [ORG_A, VICE_ID]);
      expect(held.rows).toEqual([
        { seat: 'at-large', is_primary: true },
        { seat: 'vice-chair', is_primary: true },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a seat outlives the administrator who recorded it', async () => {
    const client = await freshDatabase('ppbf_test_seats_assigner');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'community-director', accountId: TREASURER_ID, isPrimary: true });

      await client.query(`delete from pilot.accounts where account_id = $1`, [ADMIN_ID]);

      const { rows } = await client.query(
        `select account_id, is_primary, assigned_by_account_id, assigned_at is not null as dated
         from pilot.board_seats
         where organization_id = $1 and seat = 'community-director'`,
        [ORG_A],
      );
      expect(rows).toEqual([
        {
          account_id: TREASURER_ID,
          is_primary: true,
          assigned_by_account_id: null,
          dated: true,
        },
      ]);

      // The holder's own account leaving does end the appointment.
      await client.query(`delete from pilot.accounts where account_id = $1`, [TREASURER_ID]);
      const remaining = await client.query(
        `select count(*)::int as n from pilot.board_seats where organization_id = $1`,
        [ORG_A],
      );
      expect(remaining.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the migration creates the read-path indexes it claims', async () => {
    const client = await freshDatabase('ppbf_test_seats_indexes');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const indexes = await client.query(
        `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'board_seats'`,
      );
      const names = indexes.rows.map((row: { indexname: string }) => row.indexname);
      expect(names).toContain('pilot_board_seats_one_primary_per_seat');
      expect(names).toContain('idx_pilot_board_seats_org_account');
      // Listing a seat's holders rides the primary key's leading columns.
      expect(names).toContain('pilot_board_seats_pkey');
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op and keeps every assignment', async () => {
    const client = await freshDatabase('ppbf_test_seats_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await assignSeat(client, { seat: 'safety-director', accountId: PRESIDENT_ID, isPrimary: true });
      await assignSeat(client, { seat: 'safety-director', accountId: VICE_ID, isPrimary: false });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const holders = await client.query(SEAT_HOLDERS_SQL, [ORG_A, 'safety-director']);
      expect(holders.rows).toEqual([
        { account_id: PRESIDENT_ID, is_primary: true },
        { account_id: VICE_ID, is_primary: false },
      ]);

      // Re-running must not multiply the constraint or the indexes either.
      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conrelid = 'pilot.board_seats'::regclass and conname = 'pilot_board_seats_seat_check'`,
      );
      expect(constraints.rows[0].n).toBe(1);
      const indexes = await client.query(
        `select count(*)::int as n from pg_indexes
         where schemaname = 'pilot' and tablename = 'board_seats'`,
      );
      expect(indexes.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a seat cannot be recorded for an organization or an account that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_seats_foreign_keys');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        assignSeat(client, { organizationId: 'org-not-real', seat: 'chair', accountId: VICE_ID }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        assignSeat(client, { seat: 'chair', accountId: 'acct-not-real' }),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.end();
    }
  });
});
