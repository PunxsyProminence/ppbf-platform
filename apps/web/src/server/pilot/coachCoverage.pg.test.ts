// Real PostgreSQL-backed contract test for the coach-coverage migration
// (pilot.coach_coverage) and -- unlike the sibling suites -- for the REAL
// access-gate and grant/revoke behavior on top of it: './db' is mocked to
// route into the embedded server, so assertCoachAssignedToAthlete,
// grantCoachCoverage, and revokeCoachCoverage below are the actual
// production functions evaluating their actual SQL against actual rows.
// The ticket's acceptance criteria (active grant passes, expired grant
// refuses, no grant refuses, revocation ends access) are proven here at the
// only altitude that can prove them -- the window predicates live in SQL,
// and a unit mock cannot execute SQL.
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

// Routes access.ts's queries into whichever embedded database the current
// test opened. Declared before the import so jest's mock hoisting sees it.
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

import { assertCoachAssignedToAthlete, grantCoachCoverage, revokeCoachCoverage } from './access';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-coverage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_coach_coverage_migration.sql';
/* The data-retention migration is applied here because PRODUCTION HAS IT.
   It adds pilot.athletes.deleted_at, which the authorization queries in
   access.ts now require, and deploy-production's schema check (which parses
   `add column` out of every migration and asserts it exists) passed against
   the live production database on the 2026-08-27 release. A fixture built
   without it is not a smaller production -- it is a database that has never
   existed, and it was quietly asserting that authorization works on a schema
   nobody runs. */
const RETENTION_MIGRATION_FILE = 'pilot_slice_postgres_data_retention_deletion_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-coach-coverage-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-coverage';
const OTHER_ORG_ID = 'org-coverage-other';
const RECORD_COACH = 'acct-coach-record';
const SUB_COACH = 'acct-coach-sub';
const ADMIN_ACCOUNT = 'acct-admin-1';
const ATHLETE_ID = 'ATH-COVERAGE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let retentionMigrationSql: string;
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

/**
 * Fresh database: two orgs, a coach of record, a substitute coach, an admin,
 * and one athlete assigned to the coach of record. `dropCoverageTableFirst`
 * reproduces the pre-migration shape (the only database the increment
 * exists for), exactly as the escalations suite does.
 */
async function freshDatabase(
  name: string,
  { applyIncrement = false, dropCoverageTableFirst = false }: { applyIncrement?: boolean; dropCoverageTableFirst?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(retentionMigrationSql);
  if (dropCoverageTableFirst) {
    await client.query('drop table if exists pilot.coach_coverage cascade');
  }
  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  for (const coach of [RECORD_COACH, SUB_COACH]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [coach, ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ACCOUNT, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Coverage Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, RECORD_COACH],
  );
  if (applyIncrement) {
    await client.query(migrationSql);
  }
  return client;
}

/**
 * Direct-SQL grant for windows the application function cannot write
 * (expired, not-yet-started, other-org): grantCoachCoverage always anchors
 * starts_at at now(), so the odd windows are inserted by hand.
 */
async function insertGrant(
  client: Client,
  overrides: Partial<{
    organization_id: string;
    athlete_id: string;
    covering_coach_id: string;
    starts_at: string;
    expires_at: string;
  }> = {},
): Promise<void> {
  const grant = {
    organization_id: ORG_ID,
    athlete_id: ATHLETE_ID,
    covering_coach_id: SUB_COACH,
    starts_at: "now() - interval '1 hour'",
    expires_at: "now() + interval '1 hour'",
    ...overrides,
  };
  // If the grant targets the other org, that org needs the athlete row too
  // (composite FK), created lazily so most tests stay two-row simple.
  if (grant.organization_id !== ORG_ID) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Other Org Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [grant.organization_id, grant.athlete_id, RECORD_COACH],
    );
  }
  await client.query(
    `insert into pilot.coach_coverage (
       organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at
     ) values ($1,$2,$3,$4, ${grant.starts_at}, ${grant.expires_at})`,
    [grant.organization_id, grant.athlete_id, grant.covering_coach_id, ADMIN_ACCOUNT],
  );
}

function grantParams(overrides: Partial<Parameters<typeof grantCoachCoverage>[0]> = {}) {
  return {
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    coveringCoachId: SUB_COACH,
    grantedByAccountId: ADMIN_ACCOUNT,
    ...overrides,
  };
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
  retentionMigrationSql = await fs.readFile(path.join(INFRA_DIR, RETENTION_MIGRATION_FILE), 'utf8');

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

afterEach(() => {
  activeClient = null;
});

describe('the real access gate against real coverage rows (T-002 acceptance)', () => {
  test('the coach of record passes, exactly as before', async () => {
    const client = await freshDatabase('ppbf_test_cov_record', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(assertCoachAssignedToAthlete(RECORD_COACH, ATHLETE_ID, ORG_ID)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('a coach with NO coverage still gets Forbidden (the pre-T-002 behavior, unweakened)', async () => {
    const client = await freshDatabase('ppbf_test_cov_none', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
    } finally {
      await client.end();
    }
  });

  test('a grant issued by the real grantCoachCoverage opens the gate', async () => {
    const client = await freshDatabase('ppbf_test_cov_active', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await grantCoachCoverage(grantParams());
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('a coach with an EXPIRED grant gets Forbidden', async () => {
    const client = await freshDatabase('ppbf_test_cov_expired', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await insertGrant(client, {
        starts_at: "now() - interval '2 hours'",
        expires_at: "now() - interval '1 hour'",
      });
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
    } finally {
      await client.end();
    }
  });

  test('the real revokeCoachCoverage closes the gate a live grant had opened', async () => {
    const client = await freshDatabase('ppbf_test_cov_revoked', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const granted = await grantCoachCoverage(grantParams());
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).resolves.toBeUndefined();

      await expect(revokeCoachCoverage({ organizationId: ORG_ID, coverageId: granted.coverageId })).resolves.toEqual({
        revoked: true,
      });
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow('Forbidden');
    } finally {
      await client.end();
    }
  });

  test('a grant that has not STARTED yet gets Forbidden', async () => {
    const client = await freshDatabase('ppbf_test_cov_future', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await insertGrant(client, {
        starts_at: "now() + interval '1 hour'",
        expires_at: "now() + interval '2 hours'",
      });
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow('Forbidden');
    } finally {
      await client.end();
    }
  });

  test('a grant in another organization does not cross the tenant boundary', async () => {
    const client = await freshDatabase('ppbf_test_cov_crossorg', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      // SAME athlete_id string, other organization -- pilot.athletes' key is
      // composite (organization_id, athlete_id), so the same id can exist in
      // two orgs. With identical athlete_id and coach, the ONLY predicate
      // standing between this grant and cross-tenant access is
      // organization_id -- which makes this control able to detect that
      // predicate's loss. (A different-athlete_id variant would pass even
      // with the org filter deleted: the athlete_id predicate would exclude
      // the row on its own, proving nothing about the tenant boundary.)
      await insertGrant(client, { organization_id: OTHER_ORG_ID, athlete_id: ATHLETE_ID });
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow('Forbidden');
    } finally {
      await client.end();
    }
  });

  // The pre-migration window is real: migrations are operator-applied, so
  // this exact code ships before the table exists anywhere. A missing
  // relation must mean what the pre-T-002 code meant -- Forbidden -- not a
  // 42P01 surfacing as a 500 through every route on this gate.
  test('a database without the coverage table still refuses with Forbidden, not a relation error', async () => {
    const client = await freshDatabase('ppbf_test_cov_missing_table', { dropCoverageTableFirst: true });
    activeClient = client;
    try {
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
      // And the coach of record is entirely unaffected by the table's absence.
      await expect(assertCoachAssignedToAthlete(RECORD_COACH, ATHLETE_ID, ORG_ID)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});

describe('the real grant path against real rows', () => {
  test('refuses a grantee that is not a coach: the account named by a typo gets nothing', async () => {
    const client = await freshDatabase('ppbf_test_cov_grantee_role', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-parent-1', 'parent', $1, 'microsoft')`,
        [ORG_ID],
      );
      await expect(grantCoachCoverage(grantParams({ coveringCoachId: 'acct-parent-1' }))).rejects.toThrow(
        'Missing covering_coach_id: must be an active coach account in this organization',
      );
    } finally {
      await client.end();
    }
  });

  test('refuses a deactivated coach', async () => {
    const client = await freshDatabase('ppbf_test_cov_grantee_inactive', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await client.query(`update pilot.accounts set active_flag = false where account_id = $1`, [SUB_COACH]);
      await expect(grantCoachCoverage(grantParams())).rejects.toThrow('Missing covering_coach_id');
    } finally {
      await client.end();
    }
  });

  test('refuses a second grant while the first is live, then admits it once the first is revoked', async () => {
    const client = await freshDatabase('ppbf_test_cov_overlap', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const first = await grantCoachCoverage(grantParams());
      await expect(grantCoachCoverage(grantParams())).rejects.toThrow(/^Coverage already exists: grant /);

      // Revocation clears the overlap -- the two protections compose instead
      // of deadlocking the admin who granted to the right coach for the
      // wrong duration.
      await revokeCoachCoverage({ organizationId: ORG_ID, coverageId: first.coverageId });
      await expect(grantCoachCoverage(grantParams())).resolves.toMatchObject({ coverageId: expect.any(String) });
    } finally {
      await client.end();
    }
  });
});

describe('coach coverage schema against real Postgres', () => {
  test('the window constraint refuses a grant whose expiry does not follow its start', async () => {
    const client = await freshDatabase('ppbf_test_cov_window', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(
        insertGrant(client, {
          starts_at: "now() + interval '1 hour'",
          expires_at: "now() + interval '1 hour'",
        }),
      ).rejects.toThrow(/pilot_coach_coverage_window_check/);
    } finally {
      await client.end();
    }
  });

  // The org column is trustworthy only because of the composite FK: without
  // it a row could name org A while pointing at org B's athlete, and every
  // org-scoped read would still look correct.
  test('a coverage row cannot name one org while pointing at another org\'s athlete', async () => {
    const client = await freshDatabase('ppbf_test_cov_composite_fk', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(
        client.query(
          `insert into pilot.coach_coverage (
             organization_id, athlete_id, covering_coach_id, granted_by_account_id, expires_at
           ) values ($1, $2, $3, $4, now() + interval '1 hour')`,
          // OTHER_ORG_ID has no athlete row at all -- the athlete exists only
          // under ORG_ID, so this insert can only succeed if the FK is gone.
          [OTHER_ORG_ID, ATHLETE_ID, SUB_COACH, ADMIN_ACCOUNT],
        ),
      ).rejects.toThrow(/pilot_coach_coverage_athlete_fk|foreign key/i);
    } finally {
      await client.end();
    }
  });

  test('a grant referencing a nonexistent coach account is refused by the FK', async () => {
    const client = await freshDatabase('ppbf_test_cov_coach_fk', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(insertGrant(client, { covering_coach_id: 'acct-ghost' })).rejects.toThrow(/foreign key/i);
    } finally {
      await client.end();
    }
  });

  test('the pre-migration shape is reproducible: dropped table, increment not applied, table absent', async () => {
    const client = await freshDatabase('ppbf_test_cov_premigration', { dropCoverageTableFirst: true });
    activeClient = client;
    try {
      await expect(client.query('select 1 from pilot.coach_coverage')).rejects.toThrow(
        /relation "pilot.coach_coverage" does not exist/i,
      );
    } finally {
      await client.end();
    }
  });

  // The table is defined twice by hand (base schema for fresh environments,
  // increment for existing ones); this is the drift alarm, same as the
  // escalations suite's.
  test('the base-schema table and the migration-built table are the same shape', async () => {
    const baseBuilt = await freshDatabase('ppbf_test_cov_shape_base');
    const migrationBuilt = await freshDatabase('ppbf_test_cov_shape_migrated', {
      dropCoverageTableFirst: true,
      applyIncrement: true,
    });
    try {
      async function shape(client: Client) {
        const columns = await client.query(
          `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
           from information_schema.columns
           where table_schema = 'pilot' and table_name = 'coach_coverage'
           order by column_name`,
        );
        const checks = await client.query(
          `select pg_get_constraintdef(oid) as def
           from pg_constraint
           where conrelid = to_regclass('pilot.coach_coverage')
           order by pg_get_constraintdef(oid)`,
        );
        const indexes = await client.query(
          // indexdef, not just indexname: two files can agree on a name while
          // disagreeing on columns, order, or DESC -- the drift this test exists
          // to catch.
          `select indexname, indexdef from pg_indexes
           where schemaname = 'pilot' and tablename = 'coach_coverage'
           order by indexname`,
        );
        return { columns: columns.rows, checks: checks.rows, indexes: indexes.rows };
      }
      const baseShape = await shape(baseBuilt);
      const migratedShape = await shape(migrationBuilt);
      expect(migratedShape.columns).toEqual(baseShape.columns);
      expect(migratedShape.checks).toEqual(baseShape.checks);
      expect(migratedShape.indexes).toEqual(baseShape.indexes);
    } finally {
      await baseBuilt.end();
      await migrationBuilt.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-coach-coverage-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('coach coverage runner readiness assertion', () => {
  // The `dropCoverageTableFirst: true` is load-bearing, not tidiness.
  // pilot_slice_postgres.sql already ships pilot.coach_coverage, so against a
  // plain base-schema database this runner's readiness check returns all
  // true and reports ready whether or not the migration ever ran -- a gate
  // that cannot fail is a gate that gates nothing. Dropping the table first
  // is the only way to reach the state where the assertion has to do work.
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('coachcov_rdy_no', { dropCoverageTableFirst: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /COACH_COVERAGE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('coachcov_rdy_ok', { dropCoverageTableFirst: true });
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
