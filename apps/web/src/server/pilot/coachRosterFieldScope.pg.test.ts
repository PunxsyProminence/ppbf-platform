// Real PostgreSQL-backed test for the coach roster field split
// (entities.ts#getAthletesForCoach).
//
// This one CANNOT be proven with a mock, by construction. The redaction is a
// `case when <relationship> then dob end` evaluated by Postgres, and the
// relationship predicate includes now() window comparisons against
// pilot.coach_coverage. A fake db client answers the query with whatever rows
// the test hands it, so a unit test would assert its own fixture and pass
// just as happily against a predicate that redacts nothing. Every assertion
// below reads the columns back out of a real database.
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

// Routes entities.ts's queries into whichever embedded database the current
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

import { getAthletesByOrganization, getAthletesForCoach } from './entities';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-roster-scope-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-roster';
const OTHER_ORG_ID = 'org-roster-other';
const RECORD_COACH = 'acct-coach-record';
const OTHER_COACH = 'acct-coach-other';
const ADMIN_ACCOUNT = 'acct-admin-roster';

/** Coached by RECORD_COACH: the relationship that reveals the fields. */
const ATH_MINE = 'ATH-MINE';
/** Coached by OTHER_COACH, no grant: the redacted case. */
const ATH_THEIRS = 'ATH-THEIRS';
/** Coached by OTHER_COACH, the one coverage grants are written against. */
const ATH_COVERED = 'ATH-COVERED';

const CONTACT_MINE = 'Rosa Vance 814-555-0110';
const CONTACT_THEIRS = 'Ada Pike 814-555-0111';
const CONTACT_COVERED = 'Ivan Sokol 814-555-0112';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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
 * Fresh database: two orgs, two coaches, an admin, and three athletes -- one
 * belonging to the reading coach and two belonging to the other coach. The
 * other org gets an athlete carrying the SAME athlete_id as a covered one, so
 * a cross-tenant leak has something to leak.
 *
 * `dropCoverageTable` reproduces the database an operator has not applied the
 * coach_coverage migration to yet, which is the state the 42P01 fallback
 * exists for.
 */
async function freshDatabase(name: string, { dropCoverageTable = false }: { dropCoverageTable?: boolean } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (dropCoverageTable) {
    await client.query('drop table if exists pilot.coach_coverage cascade');
  }

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
    for (const coach of [RECORD_COACH, OTHER_COACH]) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [organizationId === ORG_ID ? coach : `${coach}-other`, organizationId],
      );
    }
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ACCOUNT, ORG_ID],
  );

  const athletes: Array<[string, string, string, string]> = [
    [ATH_MINE, RECORD_COACH, CONTACT_MINE, '2011-05-06'],
    [ATH_THEIRS, OTHER_COACH, CONTACT_THEIRS, '2012-06-07'],
    [ATH_COVERED, OTHER_COACH, CONTACT_COVERED, '2013-07-08'],
  ];
  for (const [athleteId, coachId, contact, dob] of athletes) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'fly', 'active', $5, true, $6, now(), now())`,
      [ORG_ID, athleteId, `Name ${athleteId}`, dob, contact, coachId],
    );
  }

  // Same athlete_id, different organization. Nothing this coach reads may
  // ever surface it, and a grant written against it must not open the door
  // to the row in ORG_ID either.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Other Org Child', '2014-08-09', 'fly', 'active', 'other org contact', true, $3, now(), now())`,
    [OTHER_ORG_ID, ATH_COVERED, `${RECORD_COACH}-other`],
  );

  return client;
}

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
    athlete_id: ATH_COVERED,
    covering_coach_id: RECORD_COACH,
    starts_at: "now() - interval '1 hour'",
    expires_at: "now() + interval '1 hour'",
    ...overrides,
  };
  // covering_coach_id and granted_by_account_id are FK'd on accounts(account_id)
  // ALONE -- not composite with organization_id -- so a grant row in another
  // organization naming THIS coach really is insertable. That is the whole
  // point of the cross-org case: the coach id matches, the athlete id matches,
  // the window is live, and only the organization_id comparison in the
  // relationship predicate stands between this coach and another gym's child.
  await client.query(
    `insert into pilot.coach_coverage (
       organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at
     ) values ($1,$2,$3,$4, ${grant.starts_at}, ${grant.expires_at})`,
    [grant.organization_id, grant.athlete_id, grant.covering_coach_id, ADMIN_ACCOUNT],
  );
}

/** The row for one athlete out of a roster read, by id. */
function rowFor<T extends { athlete_id: string }>(items: T[], athleteId: string): T {
  const found = items.find((item) => item.athlete_id === athleteId);
  if (!found) throw new Error(`test bug: ${athleteId} missing from the roster`);
  return found;
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

describe('the list stays whole', () => {
  test('a coach still sees every athlete in the organization, including the ones they do not coach', async () => {
    const client = await freshDatabase('ppbf_test_roster_whole');
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);

      expect(items.map((item) => item.athlete_id).sort()).toEqual([ATH_COVERED, ATH_MINE, ATH_THEIRS]);
      // Name and gym status are what a coach plans a floor and picks up cover
      // from, so they are present for every row, related or not.
      for (const item of items) {
        expect(item.full_name).toBe(`Name ${item.athlete_id}`);
        expect(item.gym_status).toBe('active');
        expect(item.weight_class).toBe('fly');
        expect(item.active_flag).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  test('the roster is org-scoped: another gym\'s child never appears', async () => {
    const client = await freshDatabase('ppbf_test_roster_tenancy');
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);

      expect(items).toHaveLength(3);
      expect(items.map((item) => item.full_name)).not.toContain('Other Org Child');
    } finally {
      await client.end();
    }
  });
});

describe('the fields narrow', () => {
  test('the coach of record reads dob and emergency_contact for their own athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_mine');
    activeClient = client;
    try {
      const mine = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_MINE);

      expect(mine.dob).not.toBeNull();
      expect(mine.emergency_contact).toBe(CONTACT_MINE);
    } finally {
      await client.end();
    }
  });

  // The finding this change exists to close.
  test('an athlete this coach has no relationship to comes back with both fields null', async () => {
    const client = await freshDatabase('ppbf_test_roster_theirs');
    activeClient = client;
    try {
      const theirs = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_THEIRS);

      expect(theirs.dob).toBeNull();
      expect(theirs.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the guardian phone number is absent from the whole payload, not merely from the field', async () => {
    const client = await freshDatabase('ppbf_test_roster_no_leak');
    activeClient = client;
    try {
      const serialized = JSON.stringify(await getAthletesForCoach(ORG_ID, RECORD_COACH));

      expect(serialized).toContain(CONTACT_MINE);
      expect(serialized).not.toContain(CONTACT_THEIRS);
      expect(serialized).not.toContain(CONTACT_COVERED);
    } finally {
      await client.end();
    }
  });
});

describe('a coverage grant is the second way in, and only while it is live', () => {
  test('an active grant reveals both fields on the covered athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_active');
    activeClient = client;
    try {
      await insertGrant(client);

      const covered = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_COVERED);

      expect(covered.dob).not.toBeNull();
      expect(covered.emergency_contact).toBe(CONTACT_COVERED);
    } finally {
      await client.end();
    }
  });

  test('an active grant reveals nothing about the athletes it does not name', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_narrow');
    activeClient = client;
    try {
      await insertGrant(client);

      const theirs = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_THEIRS);

      expect(theirs.dob).toBeNull();
      expect(theirs.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('an expired grant redacts again, with no cleanup job having run', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_expired');
    activeClient = client;
    try {
      await insertGrant(client, {
        starts_at: "now() - interval '4 hours'",
        expires_at: "now() - interval '1 hour'",
      });

      const covered = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_COVERED);

      expect(covered.dob).toBeNull();
      expect(covered.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a grant that has not started yet reveals nothing', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_future');
    activeClient = client;
    try {
      await insertGrant(client, {
        starts_at: "now() + interval '1 hour'",
        expires_at: "now() + interval '4 hours'",
      });

      const covered = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_COVERED);

      expect(covered.dob).toBeNull();
      expect(covered.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });

  // Revocation forces expires_at to now(). It must stop the roster read the
  // same instant it stops the per-athlete gate, or a revoked coach keeps
  // reading a child's birth date off a list.
  test('a revoked grant stops revealing the fields immediately', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_revoked');
    activeClient = client;
    try {
      await insertGrant(client);
      await client.query(
        `update pilot.coach_coverage set expires_at = now()
         where organization_id = $1 and athlete_id = $2 and covering_coach_id = $3`,
        [ORG_ID, ATH_COVERED, RECORD_COACH],
      );

      const covered = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_COVERED);

      expect(covered.dob).toBeNull();
      expect(covered.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a grant in another organization does not unlock this one\'s row', async () => {
    const client = await freshDatabase('ppbf_test_roster_cov_cross_org');
    activeClient = client;
    try {
      await insertGrant(client, { organization_id: OTHER_ORG_ID });

      const covered = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_COVERED);

      expect(covered.dob).toBeNull();
      expect(covered.emergency_contact).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('a database the coverage migration has not reached', () => {
  // Migrations are operator-applied, so this database really exists in the
  // wild. The roster must not 500, and the failure must land on the safe side.
  test('the roster still reads, and redacts everything the coach is not coach of record for', async () => {
    const client = await freshDatabase('ppbf_test_roster_no_cov_table', { dropCoverageTable: true });
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);

      expect(items).toHaveLength(3);
      expect(rowFor(items, ATH_MINE).emergency_contact).toBe(CONTACT_MINE);
      expect(rowFor(items, ATH_THEIRS).emergency_contact).toBeNull();
      expect(rowFor(items, ATH_COVERED).emergency_contact).toBeNull();
      expect(rowFor(items, ATH_COVERED).dob).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The fallback is scoped to exactly one Postgres error. Anything else must
  // still surface, or a genuine database fault becomes a silently redacted
  // roster that looks like a working feature.
  test('a database error that is not a missing relation still propagates', async () => {
    const client = await freshDatabase('ppbf_test_roster_other_error');
    activeClient = client;
    try {
      // Break a column ONLY the coverage lookup reads. A fault in
      // pilot.athletes would break the record-only fallback query too, so the
      // error would surface from the fallback and the assertion would hold
      // even against a catch that swallowed everything -- proving nothing.
      // Renaming coach_coverage.expires_at fails the first query with 42703
      // while leaving the fallback perfectly able to succeed, so this can only
      // pass if the catch really is scoped to 42P01.
      await client.query('alter table pilot.coach_coverage rename column expires_at to expires_at_moved');

      await expect(getAthletesForCoach(ORG_ID, RECORD_COACH)).rejects.toThrow(/expires_at/);
    } finally {
      await client.end();
    }
  });
});

describe('the admin read is untouched', () => {
  // The split is coach-only. If this ever starts redacting, the admin athlete
  // console (which renders dob into a date input) silently loses the field.
  test('an organization-wide read still carries dob and emergency_contact for every athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_admin');
    activeClient = client;
    try {
      const items = await getAthletesByOrganization(ORG_ID);

      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.dob).not.toBeNull();
        expect(item.emergency_contact).toBeTruthy();
      }
    } finally {
      await client.end();
    }
  });
});
