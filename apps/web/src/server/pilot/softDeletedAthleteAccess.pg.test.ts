// Real PostgreSQL-backed contract test for the ONE question this repo had no
// answer to: after an organization admin deletes an athlete, can anybody still
// reach them?
//
// WHY THIS SUITE EXISTS. deleteAthleteRecord writes deleted_at and stops.
// Nothing in the authorization layer read it. access.test.ts and
// guardianAccess.test.ts hold 88 passing tests between them and every one of
// them passed both before and after the fix in this change -- because not one
// of them had ever inserted a deleted athlete. The bug was not that a test was
// wrong; it was that the state existed and no test had ever created it.
//
// This is the same shape as #690, which found that deleting a GUARDIAN wrote
// deleted_at while every read path ignored it. That one shipped to production
// on 2026-08-27. This is its other half.
//
// WHY REAL POSTGRES. The filter is a SQL predicate, and the whole failure mode
// is "the predicate is not in the query". A mocked db can only be asked
// whether the string contains 'deleted_at is null', which stays green for a
// query that puts the predicate on the wrong side of a join, or filters the
// coverage half and not the roster half. Only a real row can answer.
//
// EVERY EXCLUSION TEST IS PAIRED WITH A LIVE-ATHLETE CONTROL. A change that
// broke access outright would satisfy every "is excluded" assertion in here.
// The controls are what make the exclusions mean something.
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

// Routes access.ts's and guardianAccess.ts's queries into whichever embedded
// database the current test opened. Declared before the import so jest's mock
// hoisting sees it.
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

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
  type ActorIdentity,
} from './access';
import { guardianAthleteIds, isGuardianLinkedToAthlete } from './guardianAccess';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-soft-deleted-athlete-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const COVERAGE_MIGRATION = 'pilot_slice_postgres_coach_coverage_migration.sql';
/** deleted_at does not exist in the base schema -- this migration adds it. */
const RETENTION_MIGRATION = 'pilot_slice_postgres_data_retention_deletion_migration.sql';

const ORG_ID = 'org-sda';
const COACH = 'acct-coach-sda';
const ADMIN_ACCOUNT = 'acct-admin-sda';
const GUARDIAN_ACCOUNT = 'acct-guardian-sda';
const PARENT_ID = 'parent-sda-1';

/** Soft-deleted during the test. Assigned to COACH, linked to GUARDIAN. */
const DELETED_ATHLETE = 'ATH-DELETED-1';
/** Never deleted. The control that proves the filter is not a blanket refusal. */
const LIVE_ATHLETE = 'ATH-LIVE-1';
/** Assigned to RECORD_COACH and deleted; COACH reaches it ONLY through an
    active coverage grant. Exists because the coverage half of
    athleteIdsForCoach is a separate query branch: a first version of this
    suite filtered the roster half only, and every test still passed because
    no fixture ever made coverage the sole path to a deleted athlete. */
const COVERED_DELETED_ATHLETE = 'ATH-COVERED-DELETED-1';
/** Same, not deleted -- the control for the coverage half. */
const COVERED_LIVE_ATHLETE = 'ATH-COVERED-LIVE-1';
/** Holds the covered athletes of record, so coverage is genuinely the only
    route COACH has to them. */
const RECORD_COACH = 'acct-coach-record-sda';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let coverageMigrationSql: string;
let retentionMigrationSql: string;

const adminActor: ActorIdentity = {
  accountId: ADMIN_ACCOUNT,
  role: 'organization_admin',
  organizationId: ORG_ID,
  // Only meaningful for the athlete role; these three actors are not athletes.
  athleteId: null,
};
const coachActor: ActorIdentity = {
  accountId: COACH,
  role: 'coach',
  organizationId: ORG_ID,
  // Only meaningful for the athlete role; these three actors are not athletes.
  athleteId: null,
};
const guardianActor: ActorIdentity = {
  accountId: GUARDIAN_ACCOUNT,
  role: 'parent',
  organizationId: ORG_ID,
  // Only meaningful for the athlete role; these three actors are not athletes.
  athleteId: null,
};

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
 * Fresh database with one gym, one coach, one admin, one guardian, and two
 * athletes that differ in exactly one column: deleted_at. Both are assigned to
 * the same coach and linked to the same guardian, so any difference in what
 * the authorization layer returns is attributable to the deletion and nothing
 * else.
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
  await client.query(coverageMigrationSql);
  await client.query(retentionMigrationSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [accountId, role] of [
    [COACH, 'coach'],
    [RECORD_COACH, 'coach'],
    [ADMIN_ACCOUNT, 'organization_admin'],
    [GUARDIAN_ACCOUNT, 'parent'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }

  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Deleted Or Not', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH],
    );
  }
  // Coach of record is somebody else, so COACH reaches these two only via the
  // coverage half of the union -- the branch a roster-only filter leaves open.
  for (const athleteId of [COVERED_DELETED_ATHLETE, COVERED_LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Covered Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, RECORD_COACH],
    );
    await client.query(
      `insert into pilot.coach_coverage (
         organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at
       ) values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 hour')`,
      [ORG_ID, athleteId, COACH, ADMIN_ACCOUNT],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
     values ($1, $2, $3, 'Guardian Name', 'guardian@example.test')
     on conflict do nothing`,
    [ORG_ID, PARENT_ID, GUARDIAN_ACCOUNT],
  );
  for (const athleteId of [DELETED_ATHLETE, LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother') on conflict do nothing`,
      [ORG_ID, PARENT_ID, athleteId],
    );
  }

  // The deletion itself -- exactly what deleteAthleteRecord writes, and
  // nothing more. If a future change makes deletion do more (deactivate the
  // account, revoke sessions), this test still pins that deleted_at ALONE is
  // sufficient to close access, which is the property that was missing.
  for (const athleteId of [DELETED_ATHLETE, COVERED_DELETED_ATHLETE]) {
    await client.query(
      `update pilot.athletes set deleted_at = now(), updated_at = now()
       where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, athleteId],
    );
  }

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
  coverageMigrationSql = await fs.readFile(path.join(INFRA_DIR, COVERAGE_MIGRATION), 'utf8');
  retentionMigrationSql = await fs.readFile(path.join(INFRA_DIR, RETENTION_MIGRATION), 'utf8');
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

async function withDatabase(name: string, run: () => Promise<void>): Promise<void> {
  const client = await freshDatabase(name);
  activeClient = client;
  try {
    await run();
  } finally {
    await client.end();
  }
}

describe('a deleted athlete is unreachable through the coach path', () => {
  test('assertCoachAssignedToAthlete refuses the deleted athlete and allows the live one', async () => {
    await withDatabase('sda_coach_assert', async () => {
      // Control first: both athletes are assigned to this coach by coach_id,
      // so a refusal below cannot be "the coach was never assigned".
      await expect(assertCoachAssignedToAthlete(COACH, LIVE_ATHLETE, ORG_ID)).resolves.toBeUndefined();
      await expect(assertCoachAssignedToAthlete(COACH, DELETED_ATHLETE, ORG_ID)).rejects.toThrow();
    });
  });

  test('athleteIdsForCoach drops the deleted athlete from the roster', async () => {
    await withDatabase('sda_coach_roster', async () => {
      const roster = await athleteIdsForCoach(ORG_ID, COACH);
      expect([...roster].sort()).toEqual([COVERED_LIVE_ATHLETE, LIVE_ATHLETE].sort());
    });
  });

  test('a deleted athlete reached ONLY through coverage is dropped too', async () => {
    await withDatabase('sda_coverage_half', async () => {
      const roster = await athleteIdsForCoach(ORG_ID, COACH);
      // Control: the live covered athlete IS reachable, so an active grant
      // genuinely puts an athlete on this roster. Without this line, the
      // exclusion below would also pass if coverage were broken outright.
      expect(roster).toContain(COVERED_LIVE_ATHLETE);
      expect(roster).not.toContain(COVERED_DELETED_ATHLETE);
    });
  });

  test('accessibleAthleteIds does not return the deleted athlete to the coach', async () => {
    await withDatabase('sda_coach_batch', async () => {
      const reachable = await accessibleAthleteIds(coachActor, [LIVE_ATHLETE, DELETED_ATHLETE]);
      expect(reachable.has(LIVE_ATHLETE)).toBe(true);
      expect(reachable.has(DELETED_ATHLETE)).toBe(false);
    });
  });
});

describe('a deleted athlete is unreachable through the organization-admin path', () => {
  test('assertAthleteBelongsToOrganization refuses the deleted athlete', async () => {
    await withDatabase('sda_admin_assert', async () => {
      await expect(assertAthleteBelongsToOrganization(ORG_ID, LIVE_ATHLETE)).resolves.toBeUndefined();
      await expect(assertAthleteBelongsToOrganization(ORG_ID, DELETED_ATHLETE)).rejects.toThrow();
    });
  });

  test('accessibleAthleteIds does not return the deleted athlete to the admin', async () => {
    await withDatabase('sda_admin_batch', async () => {
      const reachable = await accessibleAthleteIds(adminActor, [LIVE_ATHLETE, DELETED_ATHLETE]);
      expect(reachable.has(LIVE_ATHLETE)).toBe(true);
      expect(reachable.has(DELETED_ATHLETE)).toBe(false);
    });
  });
});

describe('a deleted athlete is unreachable through the guardian path', () => {
  test('isGuardianLinkedToAthlete goes false once the athlete is deleted', async () => {
    await withDatabase('sda_guardian_link', async () => {
      // Both links exist in guardian_links and neither was touched by the
      // deletion -- guardian_links has no deleted_at of its own. That is
      // exactly why the join onto pilot.athletes is what closes this.
      await expect(isGuardianLinkedToAthlete(ORG_ID, GUARDIAN_ACCOUNT, LIVE_ATHLETE)).resolves.toBe(true);
      await expect(isGuardianLinkedToAthlete(ORG_ID, GUARDIAN_ACCOUNT, DELETED_ATHLETE)).resolves.toBe(false);
    });
  });

  test('guardianAthleteIds drops the deleted athlete from the guardian scope', async () => {
    await withDatabase('sda_guardian_scope', async () => {
      await expect(guardianAthleteIds(ORG_ID, GUARDIAN_ACCOUNT)).resolves.toEqual([LIVE_ATHLETE]);
    });
  });
});

describe('assertActorCanAccessAthlete, the chokepoint 92 files call', () => {
  test('refuses every role for the deleted athlete and allows each for the live one', async () => {
    await withDatabase('sda_chokepoint', async () => {
      for (const actor of [adminActor, coachActor, guardianActor]) {
        await expect(assertActorCanAccessAthlete(actor, LIVE_ATHLETE)).resolves.toBeUndefined();
        await expect(assertActorCanAccessAthlete(actor, DELETED_ATHLETE)).rejects.toThrow();
      }
    });
  });
});

describe('the deleted row is still there, which is the point of a soft delete', () => {
  test('deletion marked the row rather than removing it', async () => {
    await withDatabase('sda_row_retained', async () => {
      // Retention reporting reads pilot.athletes directly (getDeletionStatus
      // in dataDeletion.ts), never through the helpers above. If this
      // assertion ever fails, the change stopped being a soft delete.
      const result = await activeClient!.query(
        `select deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, DELETED_ATHLETE],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].deleted_at).not.toBeNull();
    });
  });
});
