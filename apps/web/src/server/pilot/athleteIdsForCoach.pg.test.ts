// Real PostgreSQL-backed contract test for athleteIdsForCoach -- the union
// that decides WHICH ATHLETES A COACH CAN SEE AT ALL, evaluated against real
// rows rather than asserted as a string.
//
// WHY THIS SUITE EXISTS. The repo already proves this six-behaviour matrix
// twice, against real rows: coachCoverage.pg.test.ts proves it for
// assertCoachAssignedToAthlete, and coachRosterFieldScope.pg.test.ts proves it
// for getAthletesForCoach. athleteIdsForCoach is a THIRD, independently
// written query -- a different second half (pilot.athletes ... coach_id = $2),
// a different fallback query, and its own 42P01 catch -- and no .pg.test.ts
// had ever pointed at it. Its only direct coverage was access.test.ts's
// `expect(sql).toContain('starts_at <= now()')`, which survives any refactor
// that keeps the substring while breaking the semantics: moving that predicate
// into the pilot.athletes half, or dropping one of the two
// `organization_id = $1` occurrences, both leave those assertions green.
//
// Three of the six behaviours had no real-database proof anywhere before this
// file: future-dated coverage excluded, cross-organization excluded, and the
// missing-table fallback. The other three were incidental byproducts of
// coachCards.pg.test.ts, which drives listCoachCards rather than this
// function.
//
// './db' is mocked to route into the embedded server, so the function below is
// the actual production code evaluating its actual SQL. The window predicates
// live in SQL; a unit mock cannot execute SQL.
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

import { athleteIdsForCoach } from './access';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-ids-for-coach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_coach_coverage_migration.sql';

const ORG_ID = 'org-aifc';
const OTHER_ORG_ID = 'org-aifc-other';
/** The coach under test: holds one athlete of record, and receives coverage. */
const SUB_COACH = 'acct-coach-sub';
/** Another coach, so a covered athlete genuinely belongs to somebody else. */
const RECORD_COACH = 'acct-coach-record';
const ADMIN_ACCOUNT = 'acct-admin-1';

/** Assigned to SUB_COACH by coach_id -- the coach-of-record half. */
const OWN_ATHLETE = 'ATH-OWN-1';
/** Assigned to RECORD_COACH; reachable by SUB_COACH only through coverage. */
const COVERED_ATHLETE = 'ATH-COVERED-1';
/** Assigned to RECORD_COACH, never covered -- the negative control. */
const STRANGER_ATHLETE = 'ATH-STRANGER-1';
/** Same athlete id, other organization -- the cross-tenant probe. */
const CROSS_ORG_ATHLETE = 'ATH-CROSS-1';

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

async function insertAthlete(
  client: Client,
  organizationId: string,
  athleteId: string,
  coachId: string,
): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Roster Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [organizationId, athleteId, coachId],
  );
}

/**
 * Direct-SQL grant, because grantCoachCoverage always anchors starts_at at
 * now() and the windows that matter here are the ones it cannot write: a
 * grant that has not started, and one that has already ended.
 */
async function insertGrant(
  client: Client,
  {
    organizationId = ORG_ID,
    athleteId = COVERED_ATHLETE,
    coveringCoachId = SUB_COACH,
    startsAt = "now() - interval '1 hour'",
    expiresAt = "now() + interval '1 hour'",
  }: {
    organizationId?: string;
    athleteId?: string;
    coveringCoachId?: string;
    startsAt?: string;
    expiresAt?: string;
  } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.coach_coverage (
       organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at
     ) values ($1,$2,$3,$4, ${startsAt}, ${expiresAt})`,
    [organizationId, athleteId, coveringCoachId, ADMIN_ACCOUNT],
  );
}

/**
 * Fresh database: two organizations, two coaches in each, and a roster where
 * every athlete's relationship to SUB_COACH is different. `dropCoverageTable`
 * reproduces the pre-migration world -- the only database the 42P01 branch
 * exists for.
 */
async function freshDatabase(
  name: string,
  { dropCoverageTable = false }: { dropCoverageTable?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(migrationSql);
  if (dropCoverageTable) {
    await client.query('drop table if exists pilot.coach_coverage cascade');
  }

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
    for (const coach of [RECORD_COACH, SUB_COACH]) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [`${coach}-${organizationId}`, organizationId],
      );
    }
  }
  // The coaches under test live in ORG_ID under their bare ids.
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

  await insertAthlete(client, ORG_ID, OWN_ATHLETE, SUB_COACH);
  await insertAthlete(client, ORG_ID, COVERED_ATHLETE, RECORD_COACH);
  await insertAthlete(client, ORG_ID, STRANGER_ATHLETE, RECORD_COACH);

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  activeClient = null;
});

describe('the coach-of-record half (real database)', () => {
  test('an athlete assigned by coach_id is included', async () => {
    const client = await freshDatabase('aifc_own');
    activeClient = client;
    try {
      await expect(athleteIdsForCoach(ORG_ID, SUB_COACH)).resolves.toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test("another coach's athlete is not included without a grant", async () => {
    const client = await freshDatabase('aifc_stranger');
    activeClient = client;
    try {
      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).not.toContain(STRANGER_ATHLETE);
      expect(ids).not.toContain(COVERED_ATHLETE);
    } finally {
      await client.end();
    }
  });
});

describe('the coverage half (real database)', () => {
  test('an actively covered athlete is included alongside the assigned one', async () => {
    const client = await freshDatabase('aifc_active');
    activeClient = client;
    try {
      await insertGrant(client);

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids.sort()).toEqual([COVERED_ATHLETE, OWN_ATHLETE].sort());
    } finally {
      await client.end();
    }
  });

  /**
   * No real-database proof existed for this before. `starts_at <= now()` is
   * the only thing standing between a coach and an athlete they are scheduled
   * to cover NEXT WEEK -- a substitute reading a child's safety record before
   * the cover begins.
   */
  test('a grant that has not started yet is excluded', async () => {
    const client = await freshDatabase('aifc_future');
    activeClient = client;
    try {
      await insertGrant(client, {
        startsAt: "now() + interval '1 day'",
        expiresAt: "now() + interval '2 days'",
      });

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
      expect(ids).not.toContain(COVERED_ATHLETE);
    } finally {
      await client.end();
    }
  });

  test('a grant that has already ended is excluded', async () => {
    const client = await freshDatabase('aifc_expired');
    activeClient = client;
    try {
      await insertGrant(client, {
        startsAt: "now() - interval '2 days'",
        expiresAt: "now() - interval '1 day'",
      });

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
      expect(ids).not.toContain(COVERED_ATHLETE);
    } finally {
      await client.end();
    }
  });

  /**
   * THE COACH PREDICATE ITSELF, which nothing here proved before.
   *
   * Every other test in this describe block grants coverage TO SUB_COACH, so
   * `covering_coach_id = $2` was never the thing under test -- the window
   * predicates and the organization predicate did all the work. Deleting
   * `covering_coach_id = $2` outright left all eleven tests green, which
   * means this file's header claim to prove the coverage half independently
   * was false. Without that predicate every coach in the gym inherits every
   * live grant in the gym.
   *
   * This is the same shape as the organization mutation below: a predicate is
   * only proven by a row that would come back if it were gone. So the grant
   * here names the OTHER coach, in this organization, inside a live window --
   * everything correct except whose grant it is.
   */
  test('a live grant belonging to another coach does not leak to this one', async () => {
    const client = await freshDatabase('aifc_other_coach');
    activeClient = client;
    try {
      await insertGrant(client, {
        athleteId: STRANGER_ATHLETE,
        coveringCoachId: RECORD_COACH,
      });

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
      expect(ids).not.toContain(STRANGER_ATHLETE);

      // And the grant is genuinely live, so the exclusion is the coach
      // predicate doing it rather than a window that had already closed.
      await expect(athleteIdsForCoach(ORG_ID, RECORD_COACH)).resolves.toEqual(
        expect.arrayContaining([STRANGER_ATHLETE]),
      );
    } finally {
      await client.end();
    }
  });

  /**
   * `union` de-duplicates and `union all` does not, and no test had an athlete
   * on BOTH sides of it -- assigned to this coach AND covered by this coach.
   * A rewrite to `union all` (the usual "it is faster" edit) would have gone
   * green and then handed every caller a duplicate row. `getPerformanceRollup`
   * maps over these ids, so the duplicate surfaces as a doubled athlete on the
   * coach's own analytics.
   */
  test('an athlete both assigned and covered is returned once, not twice', async () => {
    const client = await freshDatabase('aifc_dedupe');
    activeClient = client;
    try {
      await insertGrant(client, { athleteId: OWN_ATHLETE });

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
      expect(ids.filter((id) => id === OWN_ATHLETE)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  /**
   * Revocation is modelled by forcing `expires_at` to `now()` rather than by
   * a status column, so this is the revocation path: a grant revoked a moment
   * ago is gone now.
   *
   * THE UPPER BOUND IS EXCLUSIVE, and proving that needs one transaction.
   *
   * `now()` is `transaction_timestamp()`, so across two separate statements
   * the INSERT's `now()` is strictly earlier than the SELECT's and the row is
   * already past by the time it is read -- both `>` and `>=` exclude it, and
   * mutating one to the other leaves such a test green. An earlier draft of
   * this comment concluded from that the gap was "not closable from here".
   * That was wrong, and wrong in the worst direction: it taught a future
   * reader a false impossibility.
   *
   * It is closable. Inside a single explicit transaction both statements share
   * one `transaction_timestamp()`, so `expires_at = now()` is exact equality
   * rather than a value that has already slipped into the past. The `begin`
   * below is the whole fix; with it, mutating `>` to `>=` turns this red.
   *
   * The second half of the earlier reasoning does hold, and is worth keeping:
   * this cannot arise in production either way, because `athleteIdsForCoach`
   * calls the module-level `query()`, which borrows its own pooled connection
   * and so cannot be enlisted into a caller's transaction. That is a reason
   * the case is unreachable in production -- it was never a reason the test
   * could not be written.
   */
  test('a grant revoked a moment ago is already excluded', async () => {
    const client = await freshDatabase('aifc_boundary');
    activeClient = client;
    try {
      // One transaction, so the grant's `now()` and the read's `now()` are the
      // same instant and `expires_at = now()` is genuine equality.
      await client.query('begin');
      await insertGrant(client, {
        startsAt: "now() - interval '1 hour'",
        expiresAt: 'now()',
      });

      // The equality is real, not assumed -- if this ever came back false the
      // test below would be proving the ordinary already-past case again.
      const [{ exactly_now: exactlyNow }] = (
        await client.query<{ exactly_now: boolean }>(
          `select expires_at = now() as exactly_now from pilot.coach_coverage
           where organization_id = $1 and athlete_id = $2`,
          [ORG_ID, COVERED_ATHLETE],
        )
      ).rows;
      expect(exactlyNow).toBe(true);

      await expect(athleteIdsForCoach(ORG_ID, SUB_COACH)).resolves.toEqual([OWN_ATHLETE]);

      await client.query('rollback');
    } finally {
      await client.end();
    }
  });
});

describe('the organization boundary (real database)', () => {
  /**
   * No real-database proof existed for this before either. The query repeats
   * `organization_id = $1` in BOTH halves of the union, and a single-half
   * regression is invisible to a substring assertion: the string is still
   * present, just not everywhere it has to be.
   *
   * THE GRANT NAMES *THIS* COACH DELIBERATELY, and that detail is the whole
   * test. `pilot.accounts.account_id` is a global primary key and
   * `coach_coverage.covering_coach_id` references it with no organization
   * component, so a row carrying another organization's id and this coach's
   * account id is FK-legal. `organization_id = $1` is then the ONLY thing
   * excluding it.
   *
   * An earlier draft of this test used a different coach id in the other
   * organization and passed with the organization predicate deleted -- the
   * coach predicate was doing all the work and the test proved nothing. It
   * was caught by mutating the source and watching this stay green.
   */
  test('a live grant in another organization naming this coach does not leak in', async () => {
    const client = await freshDatabase('aifc_cross_org');
    activeClient = client;
    try {
      await insertAthlete(client, OTHER_ORG_ID, CROSS_ORG_ATHLETE, `${RECORD_COACH}-${OTHER_ORG_ID}`);
      await insertGrant(client, {
        organizationId: OTHER_ORG_ID,
        athleteId: CROSS_ORG_ATHLETE,
        coveringCoachId: SUB_COACH,
      });

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
      expect(ids).not.toContain(CROSS_ORG_ATHLETE);
    } finally {
      await client.end();
    }
  });

  test('an athlete assigned in another organization does not leak in either', async () => {
    const client = await freshDatabase('aifc_cross_org_assigned');
    activeClient = client;
    try {
      // Same coach id, other organization, athlete assigned directly to it:
      // this probes the pilot.athletes half of the union.
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [SUB_COACH, OTHER_ORG_ID],
      );
      await insertAthlete(client, OTHER_ORG_ID, CROSS_ORG_ATHLETE, SUB_COACH);

      const ids = await athleteIdsForCoach(ORG_ID, SUB_COACH);

      expect(ids).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });
});

describe('the pre-migration fallback (real database)', () => {
  /**
   * Migrations are dispatched by an operator SEPARATELY from deploy, so a
   * live database without pilot.coach_coverage is a real state and not a
   * hypothetical. The contract is assigned-only, never a 500 on a coach
   * surface -- and never a widened set.
   *
   * No real-database proof existed for this branch before. coachCards.pg.test
   * always ships the table, so the catch never executed.
   */
  test('a missing coverage table falls back to assigned-only, not an error', async () => {
    const client = await freshDatabase('aifc_no_table', { dropCoverageTable: true });
    activeClient = client;
    try {
      await expect(athleteIdsForCoach(ORG_ID, SUB_COACH)).resolves.toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('the fallback is still organization-scoped', async () => {
    const client = await freshDatabase('aifc_no_table_cross_org', { dropCoverageTable: true });
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [SUB_COACH, OTHER_ORG_ID],
      );
      await insertAthlete(client, OTHER_ORG_ID, CROSS_ORG_ATHLETE, SUB_COACH);

      await expect(athleteIdsForCoach(ORG_ID, SUB_COACH)).resolves.toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  /**
   * The catch is scoped to 42P01 alone. A different database fault must
   * propagate rather than be silently answered with a narrower roster --
   * degrading quietly on an unknown error is how a coach ends up trusting an
   * incomplete list. Modelled by renaming the column the coverage half reads,
   * which breaks that query with 42703 and leaves everything else intact.
   */
  test('a non-42P01 failure propagates instead of degrading', async () => {
    const client = await freshDatabase('aifc_other_error');
    activeClient = client;
    try {
      await client.query('alter table pilot.coach_coverage rename column expires_at to expires_at_renamed');

      await expect(athleteIdsForCoach(ORG_ID, SUB_COACH)).rejects.toMatchObject({ code: '42703' });
    } finally {
      await client.end();
    }
  });
});
