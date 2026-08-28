// Real PostgreSQL-backed contract test for coachAuthorizedRoster -- the
// projection that decides WHICH ATHLETES APPEAR IN A COACH'S PICKER, evaluated
// against real rows rather than asserted against a mock.
//
// WHY THIS SUITE EXISTS. coachAuthorizedRoster composes two reads that mean
// opposite things:
//
//   athleteIdsForCoach   the access contract. Membership.
//   getAthletesForCoach  a DISPLAY projection that returns EVERY athlete in the
//                        organization, redacting two fields for the ones this
//                        coach is unrelated to. Names only.
//
// Both halves already have their own real-database proofs
// (athleteIdsForCoach.pg.test.ts, coachRosterFieldScope.pg.test.ts,
// coachCoverage.pg.test.ts). What had no proof is the COMPOSITION, and the
// composition is where this can go wrong in the one way that matters: drop the
// intersection and the function still returns rows, still returns real names,
// still looks correct in a route test whose mock returns three athletes -- and
// now offers a coach every child in the gym on a control that files sparring
// contact against them.
//
// A mocked test cannot catch that. The intersection is over ids produced by two
// different SQL queries against the same rows; mocking either half is assuming
// the answer. So the whole adversarial matrix runs here against real rows:
// two coaches, an athlete each, a coverage grant in every window state, a second
// organization, and a soft-deleted athlete.
//
// The harness is the sibling suite's, deliberately: same embedded server, same
// full-schema fixture, same disposable local-only database. It NEVER connects
// to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

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

import { coachAuthorizedRoster } from './coachAthleteRoster';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-authorized-roster-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
/* The data-retention migration is applied here because PRODUCTION HAS IT.
   It adds pilot.athletes.deleted_at, which the authorization queries in
   access.ts now require, and deploy-production's schema check (which parses
   `add column` out of every migration and asserts it exists) passed against
   the live production database on the 2026-08-27 release. A fixture built
   without it is not a smaller production -- it is a database that has never
   existed, and it was quietly asserting that authorization works on a schema
   nobody runs. */

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
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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
  fullName = 'Roster Athlete',
): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $4, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [organizationId, athleteId, coachId, fullName],
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
  /* THE WHOLE SCHEMA, not a hand-picked subset. This suite drives
     athleteIdsForCoach, which is feature code -- it does not test any
     migration, so there is no reason for it to decide which migrations exist.
     Picking a subset is what left fourteen suites testing a database that has
     never existed anywhere (see scripts/lib/full-schema.mjs). */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
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

  await insertAthlete(client, ORG_ID, OWN_ATHLETE, SUB_COACH, 'Rosa Delgado');
  await insertAthlete(client, ORG_ID, COVERED_ATHLETE, RECORD_COACH, 'Marcus Webb');
  await insertAthlete(client, ORG_ID, STRANGER_ATHLETE, RECORD_COACH, 'Dani Ortiz');
  await insertAthlete(client, OTHER_ORG_ID, CROSS_ORG_ATHLETE, SUB_COACH, 'Other Gym Athlete');

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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
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


/**
 * The ids a coach may act on, in the order-independent form every assertion
 * below wants.
 */
async function pickerIds(coachAccountId: string, organizationId = ORG_ID): Promise<string[]> {
  const roster = await coachAuthorizedRoster(organizationId, coachAccountId);
  return roster.map((athlete) => athlete.athlete_id).sort();
}

describe('coach of record (real database)', () => {
  test('Coach A is offered their own athlete', async () => {
    const client = await freshDatabase('car_own');
    activeClient = client;
    try {
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test("Coach A is NOT offered Coach B's athlete", async () => {
    // The whole-gym roster read knows both. Only the access contract decides.
    const client = await freshDatabase('car_stranger');
    activeClient = client;
    try {
      const ids = await pickerIds(SUB_COACH);
      expect(ids).not.toContain(COVERED_ATHLETE);
      expect(ids).not.toContain(STRANGER_ATHLETE);
    } finally {
      await client.end();
    }
  });

  test('Coach B is offered the athletes assigned to Coach B', async () => {
    const client = await freshDatabase('car_other_coach');
    activeClient = client;
    try {
      expect(await pickerIds(RECORD_COACH)).toEqual([COVERED_ATHLETE, STRANGER_ATHLETE].sort());
    } finally {
      await client.end();
    }
  });

  test('the display projection is not the boundary: every athlete is visible to it, one is offered', async () => {
    // Stated as its own case because it is the defect. getAthletesForCoach
    // returns all three rows here; the picker must return one.
    const client = await freshDatabase('car_projection_is_not_boundary');
    activeClient = client;
    try {
      const { getAthletesForCoach } = await import('./entities');
      const displayed = await getAthletesForCoach(ORG_ID, SUB_COACH);

      expect(displayed.map((athlete) => athlete.athlete_id).sort())
        .toEqual([COVERED_ATHLETE, OWN_ATHLETE, STRANGER_ATHLETE].sort());
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });
});

describe('coverage windows (real database)', () => {
  test('an active grant puts the covered athlete on Coach A\'s picker', async () => {
    const client = await freshDatabase('car_coverage_live');
    activeClient = client;
    try {
      await insertGrant(client);
      expect(await pickerIds(SUB_COACH)).toEqual([COVERED_ATHLETE, OWN_ATHLETE].sort());
    } finally {
      await client.end();
    }
  });

  test('a grant that has not started yet does not', async () => {
    const client = await freshDatabase('car_coverage_future');
    activeClient = client;
    try {
      await insertGrant(client, {
        startsAt: "now() + interval '1 hour'",
        expiresAt: "now() + interval '2 hours'",
      });
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('an expired grant takes the athlete back off', async () => {
    const client = await freshDatabase('car_coverage_expired');
    activeClient = client;
    try {
      await insertGrant(client, {
        startsAt: "now() - interval '2 hours'",
        expiresAt: "now() - interval '1 hour'",
      });
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('a revoked grant takes the athlete back off', async () => {
    // Revocation is written as an expiry in the past, which is what the real
    // revokeCoachCoverage does.
    const client = await freshDatabase('car_coverage_revoked');
    activeClient = client;
    try {
      await insertGrant(client);
      expect(await pickerIds(SUB_COACH)).toContain(COVERED_ATHLETE);

      await client.query(
        `update pilot.coach_coverage set expires_at = now() - interval '1 second'
         where organization_id = $1 and athlete_id = $2 and covering_coach_id = $3`,
        [ORG_ID, COVERED_ATHLETE, SUB_COACH],
      );

      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test("another coach's live grant does not reach this coach's picker", async () => {
    const client = await freshDatabase('car_coverage_other_coach');
    activeClient = client;
    try {
      await insertGrant(client, { athleteId: OWN_ATHLETE, coveringCoachId: RECORD_COACH });
      // RECORD_COACH gains it; SUB_COACH gains nothing from somebody else's grant.
      expect(await pickerIds(RECORD_COACH)).toContain(OWN_ATHLETE);
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });
});

describe('the organization boundary (real database)', () => {
  test('an athlete assigned to this coach in ANOTHER organization is never offered', async () => {
    const client = await freshDatabase('car_cross_org');
    activeClient = client;
    try {
      const ids = await pickerIds(SUB_COACH);
      expect(ids).not.toContain(CROSS_ORG_ATHLETE);
      expect(ids).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('asking as the other organization does not reach this one\'s athletes either', async () => {
    // Both halves are scoped by organization_id; neither takes it from a
    // caller who could widen it. The route never passes anything but the
    // principal's own organization, and this is what that buys.
    const client = await freshDatabase('car_cross_org_reverse');
    activeClient = client;
    try {
      const ids = await pickerIds(SUB_COACH, OTHER_ORG_ID);
      expect(ids).toEqual([CROSS_ORG_ATHLETE]);
      expect(ids).not.toContain(OWN_ATHLETE);
    } finally {
      await client.end();
    }
  });

  test("a live grant in another organization naming this coach does not leak in", async () => {
    const client = await freshDatabase('car_cross_org_grant');
    activeClient = client;
    try {
      await insertGrant(client, { organizationId: OTHER_ORG_ID, athleteId: CROSS_ORG_ATHLETE });
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });
});

describe('deleted athletes (real database)', () => {
  test('a soft-deleted athlete of record disappears from the picker', async () => {
    const client = await freshDatabase('car_deleted_own');
    activeClient = client;
    try {
      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);

      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, OWN_ATHLETE],
      );

      expect(await pickerIds(SUB_COACH)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a soft-deleted athlete under a live coverage grant disappears too', async () => {
    // The grant row survives the deletion; the athlete must not come back
    // through it. This is the half a coverage-only check would miss.
    const client = await freshDatabase('car_deleted_covered');
    activeClient = client;
    try {
      await insertGrant(client);
      expect(await pickerIds(SUB_COACH)).toContain(COVERED_ATHLETE);

      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, COVERED_ATHLETE],
      );

      expect(await pickerIds(SUB_COACH)).toEqual([OWN_ATHLETE]);
    } finally {
      await client.end();
    }
  });
});

describe('what the picker carries (real database)', () => {
  test('the name comes from the athlete row, matched to the id the contract returned', async () => {
    const client = await freshDatabase('car_names');
    activeClient = client;
    try {
      await insertGrant(client);
      const roster = await coachAuthorizedRoster(ORG_ID, SUB_COACH);

      expect(roster.map((athlete) => [athlete.athlete_id, athlete.full_name]).sort())
        .toEqual([
          [COVERED_ATHLETE, 'Marcus Webb'],
          [OWN_ATHLETE, 'Rosa Delgado'],
        ].sort());
      // Dani Ortiz is on the gym's roster and on nobody's picker here.
      expect(roster.some((athlete) => athlete.full_name === 'Dani Ortiz')).toBe(false);
    } finally {
      await client.end();
    }
  });
});
