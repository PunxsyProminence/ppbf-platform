// Real PostgreSQL-backed contract test for the coach-coverage migration
// (pilot.coach_coverage) and -- unlike the sibling suites -- for the REAL
// access-gate behavior on top of it: './db' is mocked to route into the
// embedded server, so assertCoachAssignedToAthlete below is the actual
// production function evaluating its actual SQL against actual rows. The
// ticket's acceptance criteria (active grant passes, expired grant refuses,
// no grant refuses) are proven here at the only altitude that can prove
// them -- the window predicates live in SQL, and a unit mock cannot execute
// SQL.
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

import { assertCoachAssignedToAthlete } from './access';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-coverage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_coach_coverage_migration.sql';

const ORG_ID = 'org-coverage';
const OTHER_ORG_ID = 'org-coverage-other';
const RECORD_COACH = 'acct-coach-record';
const SUB_COACH = 'acct-coach-sub';
const ATHLETE_ID = 'ATH-COVERAGE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
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
 * Fresh database: two orgs, a coach of record, a substitute coach, and one
 * athlete assigned to the coach of record. `dropCoverageTableFirst`
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
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Coverage Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, RECORD_COACH],
  );
  if (applyIncrement) {
    await client.query(migrationSql);
  }
  return client;
}

async function grantCoverage(
  client: Client,
  overrides: Partial<{
    coverage_id: string;
    organization_id: string;
    athlete_id: string;
    covering_coach_account_id: string;
    starts_at: string;
    expires_at: string;
    revoked: boolean;
  }> = {},
): Promise<void> {
  const grant = {
    coverage_id: 'cov-1',
    organization_id: ORG_ID,
    athlete_id: ATHLETE_ID,
    covering_coach_account_id: SUB_COACH,
    starts_at: "now() - interval '1 hour'",
    expires_at: "now() + interval '1 hour'",
    revoked: false,
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
       organization_id, coverage_id, athlete_id, covering_coach_account_id,
       granted_by_account_id, granted_by_role, starts_at, expires_at, revoked_at
     ) values ($1,$2,$3,$4,'acct-admin-1','organization_admin', ${grant.starts_at}, ${grant.expires_at}, ${grant.revoked ? 'now()' : 'null'})`,
    [grant.organization_id, grant.coverage_id, grant.athlete_id, grant.covering_coach_account_id],
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

  test('a coach with an ACTIVE grant passes', async () => {
    const client = await freshDatabase('ppbf_test_cov_active', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await grantCoverage(client);
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('a coach with an EXPIRED grant gets Forbidden', async () => {
    const client = await freshDatabase('ppbf_test_cov_expired', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await grantCoverage(client, {
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

  test('a REVOKED grant gets Forbidden even inside its time window', async () => {
    const client = await freshDatabase('ppbf_test_cov_revoked', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await grantCoverage(client, { revoked: true });
      await expect(assertCoachAssignedToAthlete(SUB_COACH, ATHLETE_ID, ORG_ID)).rejects.toThrow('Forbidden');
    } finally {
      await client.end();
    }
  });

  test('a grant that has not STARTED yet gets Forbidden', async () => {
    const client = await freshDatabase('ppbf_test_cov_future', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await grantCoverage(client, {
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
      await grantCoverage(client, { organization_id: OTHER_ORG_ID, athlete_id: ATHLETE_ID });
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

describe('coach coverage schema against real Postgres', () => {
  test('the window constraint refuses a grant whose expiry does not follow its start', async () => {
    const client = await freshDatabase('ppbf_test_cov_window', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(
        grantCoverage(client, {
          starts_at: "now() + interval '1 hour'",
          expires_at: "now() + interval '1 hour'",
        }),
      ).rejects.toThrow(/pilot_coach_coverage_window/);
    } finally {
      await client.end();
    }
  });

  test('granted_by_role admits coach for the future handoff case but refuses arbitrary roles', async () => {
    const client = await freshDatabase('ppbf_test_cov_grantor_vocab', { dropCoverageTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.coach_coverage (
           organization_id, coverage_id, athlete_id, covering_coach_account_id,
           granted_by_account_id, granted_by_role, expires_at
         ) values ($1,'cov-coach-granted',$2,$3,$4,'coach', now() + interval '1 hour')`,
        [ORG_ID, ATHLETE_ID, SUB_COACH, RECORD_COACH],
      );
      await expect(
        client.query(
          `insert into pilot.coach_coverage (
             organization_id, coverage_id, athlete_id, covering_coach_account_id,
             granted_by_account_id, granted_by_role, expires_at
           ) values ($1,'cov-parent-granted',$2,$3,'acct-parent-1','parent', now() + interval '1 hour')`,
          [ORG_ID, ATHLETE_ID, SUB_COACH],
        ),
      ).rejects.toThrow(/violates check constraint/i);
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
