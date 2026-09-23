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

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

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
import { guardianAthleteIds, guardianParentIdForAthlete, isGuardianLinkedToAthlete } from './guardianAccess';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-soft-deleted-athlete-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');


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
    no fixture ever made coverage the sole path to a deleted athlete. The
    coverage lookup inside assertCoachAssignedToAthlete is a separate branch
    too, and went unfiltered the same way until this fixture was aimed at it. */
const COVERED_DELETED_ATHLETE = 'ATH-COVERED-DELETED-1';
/** Same, not deleted -- the control for the coverage half. */
const COVERED_LIVE_ATHLETE = 'ATH-COVERED-LIVE-1';
/** Holds the covered athletes of record, so coverage is genuinely the only
    route COACH has to them. */
const RECORD_COACH = 'acct-coach-record-sda';

/* THE SECOND GYM. pilot.athletes' key is composite
   (organization_id, athlete_id), so one athlete_id names a DIFFERENT child in
   every organization that issues it -- intake numbering is per gym, not
   global. Both coverage lookups in access.ts join pilot.athletes on BOTH
   halves of that key for exactly this reason. The fixture below builds the
   collision on purpose: everything else in this file lives in one
   organization, where the organization_id half of those joins makes no
   difference to any answer. */
const OTHER_ORG_ID = 'org-sda-other';
/** Organization B's covering coach -- the actor the cross-organization tests
    run as. */
const OTHER_ORG_COACH = 'acct-coach-other-sda';
/** Coach of record for both of organization B's athletes, so coverage is the
    only route OTHER_ORG_COACH has to either -- RECORD_COACH's job, next door. */
const OTHER_ORG_RECORD_COACH = 'acct-coach-other-record-sda';
/** Issues organization B's grants, as ADMIN_ACCOUNT issues organization A's. */
const OTHER_ORG_ADMIN = 'acct-admin-other-sda';
/** ONE athlete_id, TWO children: live in organization A, soft-deleted in
    organization B, and it is organization B's grant that names it. */
const CROSS_ORG_ATHLETE = 'ATH-CROSS-ORG-1';
/** Organization B's own athlete, live, existing in no other gym -- the control
    that proves a grant in organization B admits anybody at all. */
const OTHER_ORG_LIVE_ATHLETE = 'ATH-OTHER-LIVE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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
// The only actor in this file whose organization is not ORG_ID.
const otherOrgCoachActor: ActorIdentity = {
  accountId: OTHER_ORG_COACH,
  role: 'coach',
  organizationId: OTHER_ORG_ID,
  // Only meaningful for the athlete role; this one is not an athlete either.
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
 *
 * Plus a SECOND gym, which exists for one reason: to put the same athlete_id
 * in two organizations at once, live in one and deleted in the other. See the
 * organization B block below.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  /* THE WHOLE SCHEMA, not a hand-picked subset -- this suite drives feature
     code and tests no migration, so it has no business deciding which
     migrations exist. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });

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

  // ORGANIZATION B, and the athlete_id collision. CROSS_ORG_ATHLETE gets one
  // row in each gym: organization A's stays live and is RECORD_COACH's of
  // record, so it belongs to no assertion elsewhere in this file;
  // organization B's is deleted below. OTHER_ORG_LIVE_ATHLETE is organization
  // B's own live athlete and exists in no other gym -- the control.
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [OTHER_ORG_ID],
  );
  for (const [accountId, role] of [
    [OTHER_ORG_COACH, 'coach'],
    [OTHER_ORG_RECORD_COACH, 'coach'],
    [OTHER_ORG_ADMIN, 'organization_admin'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, OTHER_ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Gym A Child', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, CROSS_ORG_ATHLETE, RECORD_COACH],
  );
  // Both of organization B's athletes are covered by OTHER_ORG_COACH on an
  // active grant, and neither is theirs of record -- so coverage is the only
  // route to either, and the two tests differ in nothing but which gym holds
  // the live row for the id.
  for (const athleteId of [CROSS_ORG_ATHLETE, OTHER_ORG_LIVE_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Gym B Child', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [OTHER_ORG_ID, athleteId, OTHER_ORG_RECORD_COACH],
    );
    await client.query(
      `insert into pilot.coach_coverage (
         organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at
       ) values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 hour')`,
      [OTHER_ORG_ID, athleteId, OTHER_ORG_COACH, OTHER_ORG_ADMIN],
    );
  }

  // The deletion itself -- exactly what deleteAthleteRecord writes, and
  // nothing more. If a future change makes deletion do more (deactivate the
  // account, revoke sessions), this test still pins that deleted_at ALONE is
  // sufficient to close access, which is the property that was missing.
  for (const [organizationId, athleteId] of [
    [ORG_ID, DELETED_ATHLETE],
    [ORG_ID, COVERED_DELETED_ATHLETE],
    // Organization B's copy ONLY. Organization A's row carrying the same
    // athlete_id is deliberately left live: it is the row a join that had
    // lost its organization_id half would read instead.
    [OTHER_ORG_ID, CROSS_ORG_ATHLETE],
  ] as const) {
    await client.query(
      `update pilot.athletes set deleted_at = now(), updated_at = now()
       where organization_id = $1 and athlete_id = $2`,
      [organizationId, athleteId],
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

async function withDatabase(name: string, run: () => Promise<void>): Promise<void> {
  const client = await freshDatabase(name);
  activeClient = client;
  try {
    await run();
  } finally {
    await client.end();
  }
}

/** The error a refused call threw -- so two refusals can be compared whole,
    not only by a substring of their message. */
async function refusalOf(promise: Promise<void>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('test bug: expected a refusal');
    },
    (error: unknown) => error as Error,
  );
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

  /* THE COVERAGE HALF OF THE PER-ATHLETE GATE. athleteIdsForCoach's coverage
     branch was filtered; assertCoachAssignedToAthlete's own coverage lookup
     was not -- it read pilot.coach_coverage alone and never joined
     pilot.athletes, and deleting an athlete ends none of their grants. So a
     covering coach whose grant had not lapsed still reached a deleted athlete
     through the gate every athlete-scoped route calls.

     The grants are read back first, straight from the table: both are live
     RIGHT NOW. Without that, the refusal below would pass just as well if the
     fixture's grant had simply expired, and would prove nothing about
     deletion. */
  test('assertCoachAssignedToAthlete refuses a deleted athlete whose coverage grant is still live, and admits the live one', async () => {
    await withDatabase('sda_coverage_assert', async () => {
      const liveGrants = await activeClient!.query<{ athlete_id: string }>(
        `select athlete_id from pilot.coach_coverage
         where organization_id = $1 and covering_coach_id = $2
           and starts_at <= now() and expires_at > now()`,
        [ORG_ID, COACH],
      );
      expect(liveGrants.rows.map((row) => row.athlete_id).sort()).toEqual(
        [COVERED_DELETED_ATHLETE, COVERED_LIVE_ATHLETE].sort(),
      );

      await expect(assertCoachAssignedToAthlete(COACH, COVERED_LIVE_ATHLETE, ORG_ID)).resolves.toBeUndefined();
      await expect(assertCoachAssignedToAthlete(COACH, COVERED_DELETED_ATHLETE, ORG_ID)).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
    });
  });

  test('accessibleAthleteIds does not return the deleted athlete to the coach', async () => {
    await withDatabase('sda_coach_batch', async () => {
      const reachable = await accessibleAthleteIds(coachActor, [LIVE_ATHLETE, DELETED_ATHLETE]);
      expect(reachable.has(LIVE_ATHLETE)).toBe(true);
      expect(reachable.has(DELETED_ATHLETE)).toBe(false);
    });
  });

  /* THE COVERAGE HALF OF THE BATCHED GATE -- the third coverage branch, and
     the last one to be filtered. accessibleAthleteIds runs the roster query
     first and asks a SECOND query about whatever it missed; that second query
     read pilot.coach_coverage alone. Since deletion ends no grants, a covering
     coach's batched answer kept containing a deleted athlete after the
     per-candidate gate had stopped admitting them -- and this function's
     contract is that `result.has(id)` equals what that gate would have said.

     Only COVERED_* are passed in, and only the coverage branch can return
     them: both are RECORD_COACH's of record, so the roster half sees neither.
     Both facts are read back from the table first, because a refusal proves
     nothing about deletion if the grant had simply lapsed or the roster half
     had silently answered instead. */
  test('accessibleAthleteIds gives a covering coach the live athlete and not the deleted one', async () => {
    await withDatabase('sda_coverage_batch', async () => {
      const setup = await activeClient!.query<{ athlete_id: string; coach_id: string; covered: boolean }>(
        `select a.athlete_id, a.coach_id,
                exists (
                  select 1 from pilot.coach_coverage cc
                  where cc.organization_id = a.organization_id
                    and cc.athlete_id = a.athlete_id
                    and cc.covering_coach_id = $2
                    and cc.starts_at <= now() and cc.expires_at > now()
                ) as covered
         from pilot.athletes a
         where a.organization_id = $1 and a.athlete_id = any($3::text[])`,
        [ORG_ID, COACH, [COVERED_LIVE_ATHLETE, COVERED_DELETED_ATHLETE]],
      );
      expect(setup.rows).toHaveLength(2);
      for (const row of setup.rows) {
        expect(row.coach_id).toBe(RECORD_COACH);
        expect(row.covered).toBe(true);
      }

      const reachable = await accessibleAthleteIds(coachActor, [COVERED_LIVE_ATHLETE, COVERED_DELETED_ATHLETE]);
      // Control: coverage does put an athlete in this set, so the exclusion is
      // the deletion and not a branch that stopped returning anything.
      expect(reachable.has(COVERED_LIVE_ATHLETE)).toBe(true);
      expect(reachable.has(COVERED_DELETED_ATHLETE)).toBe(false);
    });
  });

  /* The batched answer and the per-candidate gate must agree id for id --
     that equivalence is what lets a caller swap a loop of
     assertActorCanAccessAthlete for one accessibleAthleteIds call. A filter
     applied to one and not the other would pass both tests above and still
     break it. */
  test('the batched answer matches the per-candidate gate on every covered id', async () => {
    await withDatabase('sda_coverage_batch_agrees', async () => {
      const candidates = [COVERED_LIVE_ATHLETE, COVERED_DELETED_ATHLETE, LIVE_ATHLETE, DELETED_ATHLETE];
      const reachable = await accessibleAthleteIds(coachActor, candidates);

      for (const athleteId of candidates) {
        const gateAllows = await assertActorCanAccessAthlete(coachActor, athleteId).then(
          () => true,
          () => false,
        );
        expect({ athleteId, batched: reachable.has(athleteId) }).toEqual({ athleteId, batched: gateAllows });
      }
    });
  });
});

/* THE ORGANIZATION_ID HALF OF THE COVERAGE JOIN, which nothing above can see.
   Every fixture before this one lives in a single organization, so
   `join pilot.athletes ath on ath.organization_id = cc.organization_id and
   ath.athlete_id = cc.athlete_id` answers identically with or without its
   first half: delete that half and all sixteen tests above stay green. What
   held it in place was a string assertion in access.test.ts that reads the
   SQL back -- and a query can satisfy a string and still authorize the wrong
   child.

   pilot.athletes' primary key is (organization_id, athlete_id), so one
   athlete_id is a different child in every gym that issues it. Matched on
   athlete_id alone, organization B's grant joins organization A's row,
   `ath.deleted_at is null` then asks about organization A's child, and
   organization B's coach is admitted on the strength of a row belonging to a
   gym they have no relationship with. Both call sites are covered here
   because the join is written out twice, and a fix to one is not a fix to the
   other. */
describe('a coverage grant is answered by its own organization row, not another gym', () => {
  test('assertActorCanAccessAthlete refuses a covering coach whose athlete_id is live only in another organization', async () => {
    await withDatabase('sda_cross_org_assert', async () => {
      // The collision itself, read straight from the table: ONE athlete_id,
      // two rows, and the live one is the other gym's. Neither row is this
      // coach's of record, so the roster half of the gate answers neither.
      const copies = await activeClient!.query<{
        organization_id: string;
        coach_id: string;
        deleted: boolean;
      }>(
        `select organization_id, coach_id, deleted_at is not null as deleted
         from pilot.athletes where athlete_id = $1 order by organization_id`,
        [CROSS_ORG_ATHLETE],
      );
      expect(copies.rows).toHaveLength(2);
      const [gymA, gymB] = copies.rows;
      expect({ org: gymA.organization_id, coach: gymA.coach_id, deleted: gymA.deleted }).toEqual({
        org: ORG_ID,
        coach: RECORD_COACH,
        deleted: false,
      });
      expect({ org: gymB.organization_id, coach: gymB.coach_id, deleted: gymB.deleted }).toEqual({
        org: OTHER_ORG_ID,
        coach: OTHER_ORG_RECORD_COACH,
        deleted: true,
      });

      // And organization B's grants are live RIGHT NOW -- without this the
      // refusal below would pass just as well against a lapsed grant, and
      // would say nothing about which organization's row answered it.
      const liveGrants = await activeClient!.query<{ athlete_id: string }>(
        `select athlete_id from pilot.coach_coverage
         where organization_id = $1 and covering_coach_id = $2
           and starts_at <= now() and expires_at > now()`,
        [OTHER_ORG_ID, OTHER_ORG_COACH],
      );
      expect(liveGrants.rows.map((row) => row.athlete_id).sort()).toEqual(
        [CROSS_ORG_ATHLETE, OTHER_ORG_LIVE_ATHLETE].sort(),
      );

      // Two controls, because this exclusion has two ways of meaning nothing.
      // First: a grant in organization B does admit somebody, so the refusal
      // is not coverage having stopped working in this gym.
      await expect(assertActorCanAccessAthlete(otherOrgCoachActor, OTHER_ORG_LIVE_ATHLETE)).resolves.toBeUndefined();
      // Second: organization A's row really is live and really is
      // authorizable -- it is a row the join WOULD accept, if it were asked
      // about the right organization.
      await expect(assertAthleteBelongsToOrganization(ORG_ID, CROSS_ORG_ATHLETE)).resolves.toBeUndefined();

      const crossOrg = await refusalOf(assertActorCanAccessAthlete(otherOrgCoachActor, CROSS_ORG_ATHLETE));
      // Which gym holds a live row for an id is no more the error channel's
      // to disclose than a deletion or an expired grant is.
      const neverExisted = await refusalOf(assertActorCanAccessAthlete(otherOrgCoachActor, 'ATH-NEVER-EXISTED'));
      expect(crossOrg.message).toBe('Forbidden: coach not assigned to athlete');
      expect(crossOrg.constructor).toBe(neverExisted.constructor);
      expect({ name: crossOrg.name, message: crossOrg.message }).toEqual({
        name: neverExisted.name,
        message: neverExisted.message,
      });
    });
  });

  test('accessibleAthleteIds withholds an athlete_id that is live only in another organization', async () => {
    await withDatabase('sda_cross_org_batch', async () => {
      const reachable = await accessibleAthleteIds(otherOrgCoachActor, [OTHER_ORG_LIVE_ATHLETE, CROSS_ORG_ATHLETE]);
      // Control: coverage does put organization B's own athlete in this set,
      // so the exclusion below is the organization key and not a branch that
      // stopped returning anything.
      expect(reachable.has(OTHER_ORG_LIVE_ATHLETE)).toBe(true);
      expect(reachable.has(CROSS_ORG_ATHLETE)).toBe(false);

      // The same id, at this same moment, IS reachable -- in organization A,
      // where the live row is. So the withholding above cannot be read as the
      // row being gone everywhere.
      const inGymA = await accessibleAthleteIds(adminActor, [CROSS_ORG_ATHLETE]);
      expect(inGymA.has(CROSS_ORG_ATHLETE)).toBe(true);
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

  /* THE THIRD ATHLETE-SCOPED FUNCTION IN THIS MODULE, which carried no such
     join. isGuardianLinkedToAthlete and guardianAthleteIds both join
     pilot.athletes for the reason the first records: guardian_links has no
     deleted_at of its own, so a link to a withdrawn child stays true forever
     and only the join can close it. guardianParentIdForAthlete takes an
     athlete_id and answers a guardian question about it, and joined
     pilot.parents to guardian_links and stopped.

     NOT REACHABLE TODAY, and this test says so rather than implying a hole
     that is not there: its one caller chain
     (resolveActingParent -> POST /api/pilot/parent/consent) checks
     guardianAthleteIds first, and that check already excludes a deleted
     athlete. What this pins is that the function is safe on its own, so the
     next caller does not have to know to pre-check -- which is the property
     the other two already have and the reason they have it. */
  test('guardianParentIdForAthlete answers nothing for a deleted athlete', async () => {
    await withDatabase('sda_guardian_parent_row', async () => {
      // The control: the same account, the same guardian_links shape, a live
      // child. Without this the assertion below would pass just as well
      // against a function that had stopped working entirely.
      await expect(guardianParentIdForAthlete(ORG_ID, GUARDIAN_ACCOUNT, LIVE_ATHLETE))
        .resolves.toMatchObject({ parentId: PARENT_ID });

      await expect(guardianParentIdForAthlete(ORG_ID, GUARDIAN_ACCOUNT, DELETED_ATHLETE))
        .resolves.toBeNull();
    });
  });

  // The guardian's child list does not go through guardianAccess. It is on
  // that consolidation sweep's reasoned allowlist -- "projects full athlete
  // rows through the link in one statement" -- and the reason given there is
  // organization scoping, which says nothing about deleted_at. So the two
  // assertions above prove nothing about this route, and it is the one every
  // parent surface builds its child list from.
  //
  // Reading the statement out of the route file rather than restating it here
  // is the point: a copy in this file would keep passing while the route
  // drifted. This executes what the route actually sends.
  test('the athletes/list statement the route really sends drops the deleted athlete', async () => {
    const routeSource = await fs.readFile(
      path.resolve(__dirname, '../../../app/api/pilot/athletes/list/route.ts'),
      'utf8',
    );

    // Odd indices are the inside of backtick literals. The SQL here carries
    // no ${} interpolation -- $1/$2 are Postgres placeholders, plain text --
    // so a split is enough, and exactly one literal may match.
    const guardianStatements = routeSource
      .split('`')
      .filter((_, index) => index % 2 === 1)
      .filter((literal) => literal.includes('pilot.guardian_links') && literal.includes('pilot.athletes'));

    expect(guardianStatements).toHaveLength(1);

    await withDatabase('sda_roster_route_sql', async () => {
      const rows = await activeClient!.query<{ athlete_id: string }>(guardianStatements[0], [
        ORG_ID,
        GUARDIAN_ACCOUNT,
      ]);
      const listed = rows.rows.map((row) => row.athlete_id);

      // Control: the guardian genuinely reaches a child through this
      // statement, so the exclusion below cannot be "the join is broken".
      expect(listed).toContain(LIVE_ATHLETE);
      expect(listed).not.toContain(DELETED_ATHLETE);
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

  // The coach above reaches DELETED_ATHLETE as coach of record. This is the
  // other door: a covering coach, a grant that is still live, an athlete who
  // is gone. The refusal must also say nothing the other refusals do not --
  // "this athlete was deleted" is not the error channel's to disclose, any
  // more than "your grant expired" is.
  test('refuses a covering coach for a deleted athlete, exactly as it refuses no relationship at all', async () => {
    await withDatabase('sda_chokepoint_coverage', async () => {
      // Control: the same coach, the same kind of grant, a live athlete.
      await expect(assertActorCanAccessAthlete(coachActor, COVERED_LIVE_ATHLETE)).resolves.toBeUndefined();

      const deleted = await refusalOf(assertActorCanAccessAthlete(coachActor, COVERED_DELETED_ATHLETE));
      // RECORD_COACH is not LIVE_ATHLETE's coach and holds no grant on them.
      const unrelated = await refusalOf(
        assertActorCanAccessAthlete({ ...coachActor, accountId: RECORD_COACH }, LIVE_ATHLETE),
      );
      const neverExisted = await refusalOf(assertActorCanAccessAthlete(coachActor, 'ATH-NEVER-EXISTED'));

      expect(deleted.message).toBe('Forbidden: coach not assigned to athlete');
      for (const other of [unrelated, neverExisted]) {
        expect(deleted.constructor).toBe(other.constructor);
        expect({ name: deleted.name, message: deleted.message }).toEqual({ name: other.name, message: other.message });
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
