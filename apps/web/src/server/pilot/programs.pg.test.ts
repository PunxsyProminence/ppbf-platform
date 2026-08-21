// Real PostgreSQL-backed contract test for the programs-catalog migration,
// AND for the REAL module behavior on top of it: './db' is mocked to route
// into the embedded server (see programMemberships.pg.test.ts for the same
// pattern), so createProgram, listPrograms, listProgramsWithCounts,
// archiveProgram, and reactivateProgram below are the actual production
// functions executing their actual SQL against actual rows -- not the
// hand-written raw-SQL inserts the schema tests use.
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing; re-applying it is a no-op; the status vocabulary
// and non-blank name are database facts; the org-scoped CANONICAL name --
// unique on lower(btrim(program_name)), the whole reason this table
// exists, since free-text program_name silently split one group across
// spellings and capitalizations -- refuses exact and case/whitespace
// variants alike. On top of that:
// createProgram's trim and its translation of the unique violation into a
// typed ConflictError, the org isolation of every read and status flip, the
// active-members count joining pilot.program_memberships by name, and the
// guarantee that archiving a program touches NO membership row -- none of
// which a raw-SQL insert can exercise.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import { ConflictError } from './errors';
import {
  archiveProgram,
  createProgram,
  listPrograms,
  listProgramsWithCounts,
  reactivateProgram,
} from './programs';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-programs-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_programs_migration.sql';
// Memberships join the catalog by (organization_id, program_name); the
// counts tests need both tables, and the base schema carries neither.
const MEMBERSHIPS_MIGRATION_FILE = 'pilot_slice_postgres_program_memberships_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-programs-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-programs';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-programs-admin';
const COACH_ID = 'acct-programs-coach';
const ATHLETE_ID = 'ath-programs-1';
const OTHER_ATHLETE_ID = 'ath-programs-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let membershipsMigrationSql: string;
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
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Programs Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH_ID],
    );
  }
  return client;
}

function insertProgram(client: Client, programId: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.programs
       (organization_id, program_id, program_name, status, created_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [
      overrides.organization_id ?? ORG_ID,
      programId,
      overrides.program_name ?? 'Junior Boxing',
      overrides.status ?? 'active',
      ADMIN_ID,
    ],
  );
}

function insertMembership(client: Client, membershipId: string, programName: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.program_memberships
       (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
     values ($1, $2, $3, $4, $5, '2026-06-01'::date, $6)`,
    [
      ORG_ID,
      membershipId,
      overrides.athlete_id ?? ATHLETE_ID,
      programName,
      overrides.status ?? 'active',
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
  membershipsMigrationSql = await fs.readFile(path.join(INFRA_DIR, MEMBERSHIPS_MIGRATION_FILE), 'utf8');

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

afterEach(() => {
  activeClient = null;
});

describe('programs migration', () => {
  test('creates the table from nothing and accepts a valid program', async () => {
    const client = await freshDatabase('programs_fresh');
    try {
      await client.query(migrationSql);
      await insertProgram(client, 'prog-1');

      const rows = await client.query(
        `select program_name, status, notes from pilot.programs where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ program_name: 'Junior Boxing', status: 'active', notes: '' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('programs_noop');
    try {
      await client.query(migrationSql);
      await insertProgram(client, 'prog-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select program_id from pilot.programs where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.program_id)).toEqual(['prog-keep']);
    } finally {
      await client.end();
    }
  });

  test('the status vocabulary, non-blank name, and org-scoped unique name are database facts', async () => {
    const client = await freshDatabase('programs_shape');
    try {
      await client.query(migrationSql);

      await expect(insertProgram(client, 'prog-bad-status', { status: 'paused' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertProgram(client, 'prog-blank', { program_name: '   ' }))
        .rejects.toMatchObject({ code: '23514' });

      // One name, one group, per gym: the drift this table exists to refuse.
      await insertProgram(client, 'prog-1');
      await expect(insertProgram(client, 'prog-2'))
        .rejects.toMatchObject({ code: '23505' });
      // Uniqueness is on lower(btrim(program_name)) -- a case or whitespace
      // variant is the SAME group, refused by the database itself, not by
      // module courtesy. A per-column unique would accept this insert and
      // recreate the split roster.
      await expect(insertProgram(client, 'prog-case', { program_name: '  junior BOXING  ' }))
        .rejects.toMatchObject({ code: '23505' });
      // The SAME name in a DIFFERENT organization is a different group.
      await insertProgram(client, 'prog-other-org', { organization_id: OTHER_ORG_ID });
    } finally {
      await client.end();
    }
  });
});

// The tests above prove the migration's schema. These prove the module:
// createProgram's trim and its translation of the unique violation into a
// typed 409, the org isolation of listing and status flips, the counts
// join, and archiving leaving memberships untouched -- none of which is a
// database constraint.
describe('the real programs catalog against real rows', () => {
  test('createProgram trims the name and refuses a duplicate with a typed 409, not a raw SQL error', async () => {
    const client = await freshDatabase('programs_create');
    activeClient = client;
    try {
      await client.query(migrationSql);

      const created = await createProgram({
        organizationId: ORG_ID,
        programName: '  Junior Boxing  ',
        createdByAccountId: ADMIN_ID,
      });
      expect(created).toMatchObject({ program_name: 'Junior Boxing', status: 'active' });

      const duplicate = createProgram({
        organizationId: ORG_ID,
        programName: 'Junior Boxing',
        createdByAccountId: ADMIN_ID,
      });
      await expect(duplicate).rejects.toBeInstanceOf(ConflictError);
      await expect(createProgram({
        organizationId: ORG_ID,
        programName: 'Junior Boxing',
        createdByAccountId: ADMIN_ID,
      })).rejects.toMatchObject({ status: 409, code: 'PROGRAM_NAME_TAKEN' });

      // The same name is free in the other organization.
      await expect(createProgram({
        organizationId: OTHER_ORG_ID,
        programName: 'Junior Boxing',
        createdByAccountId: ADMIN_ID,
      })).resolves.toMatchObject({ organization_id: OTHER_ORG_ID });
    } finally {
      await client.end();
    }
  });

  test('a case variant of an existing name is the same group: typed 409, and the original casing lists back', async () => {
    const client = await freshDatabase('programs_case');
    activeClient = client;
    try {
      await client.query(migrationSql);

      await createProgram({
        organizationId: ORG_ID,
        programName: 'Junior Boxing',
        createdByAccountId: ADMIN_ID,
      });
      await expect(createProgram({
        organizationId: ORG_ID,
        programName: 'junior boxing',
        createdByAccountId: ADMIN_ID,
      })).rejects.toMatchObject({ status: 409, code: 'PROGRAM_NAME_TAKEN' });
      await expect(createProgram({
        organizationId: ORG_ID,
        programName: '  JUNIOR BOXING  ',
        createdByAccountId: ADMIN_ID,
      })).rejects.toBeInstanceOf(ConflictError);

      // The display name stays exactly as the admin first typed it.
      const rows = await listPrograms(ORG_ID);
      expect(rows.map((row) => row.program_name)).toEqual(['Junior Boxing']);
    } finally {
      await client.end();
    }
  });

  test('org isolation: org A never sees org B programs, and cannot archive them', async () => {
    const client = await freshDatabase('programs_isolation');
    activeClient = client;
    try {
      await client.query(migrationSql);
      await insertProgram(client, 'prog-a', { program_name: 'Fight Camp' });
      await insertProgram(client, 'prog-b', { organization_id: OTHER_ORG_ID, program_name: 'Elsewhere Team' });

      const visible = await listPrograms(ORG_ID);
      expect(visible.map((row) => row.program_name)).toEqual(['Fight Camp']);

      // Org A naming org B's program_id reads as "no such program" -- the
      // caller answers with a hidden not-found, and org B's row is untouched.
      await expect(archiveProgram(ORG_ID, 'prog-b')).resolves.toBeNull();
      const theirs = await client.query(
        `select status from pilot.programs where organization_id = $1 and program_id = 'prog-b'`,
        [OTHER_ORG_ID],
      );
      expect(theirs.rows).toEqual([{ status: 'active' }]);
    } finally {
      await client.end();
    }
  });

  test('listProgramsWithCounts counts ACTIVE memberships by name, zero for an unenrolled program, active programs first', async () => {
    const client = await freshDatabase('programs_counts');
    activeClient = client;
    try {
      await client.query(migrationSql);
      await client.query(membershipsMigrationSql);
      await insertProgram(client, 'prog-jr', { program_name: 'Junior Boxing' });
      await insertProgram(client, 'prog-camp', { program_name: 'Fight Camp' });
      await insertProgram(client, 'prog-old', { program_name: 'Old Guard', status: 'archived' });

      // Two live enrollments and one ended one: the count is a live
      // headcount, not a history total.
      await insertMembership(client, 'mem-1', 'Junior Boxing');
      await insertMembership(client, 'mem-2', 'Junior Boxing', { athlete_id: OTHER_ATHLETE_ID });
      await insertMembership(client, 'mem-3', 'Fight Camp', { status: 'ended' });

      const rows = await listProgramsWithCounts(ORG_ID);
      expect(rows.map((row) => [row.program_name, row.status, row.active_member_count])).toEqual([
        ['Fight Camp', 'active', 0],
        ['Junior Boxing', 'active', 2],
        ['Old Guard', 'archived', 0],
      ]);
    } finally {
      await client.end();
    }
  });

  test('archive and reactivate flip the catalog status and touch NO membership row', async () => {
    const client = await freshDatabase('programs_lifecycle');
    activeClient = client;
    try {
      await client.query(migrationSql);
      await client.query(membershipsMigrationSql);
      await insertProgram(client, 'prog-1', { program_name: 'Junior Boxing' });
      await insertMembership(client, 'mem-1', 'Junior Boxing');

      const before = await client.query(
        `select membership_id, status, updated_at from pilot.program_memberships where organization_id = $1`,
        [ORG_ID],
      );

      await expect(archiveProgram(ORG_ID, 'prog-1')).resolves.toMatchObject({ status: 'archived' });
      await expect(reactivateProgram(ORG_ID, 'prog-1')).resolves.toMatchObject({ status: 'active' });
      await expect(archiveProgram(ORG_ID, 'no-such-program')).resolves.toBeNull();

      // Enrollment history is untouched by catalog housekeeping: byte-for-byte
      // the same membership rows, including updated_at.
      const after = await client.query(
        `select membership_id, status, updated_at from pilot.program_memberships where organization_id = $1`,
        [ORG_ID],
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies. Every
// case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-programs-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// would otherwise be against a live environment at the most expensive
// possible moment (#488). The query is never restated here:
// `applyMigrationTransaction` is imported out of the shipped runner and
// executes the shipped READINESS_QUERY, so this cannot stay green while the
// runner rots.
describe('programs runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('programs_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PROGRAMS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('programs_rdy_ok');
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
