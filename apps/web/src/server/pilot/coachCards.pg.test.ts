// Real PostgreSQL-backed contract test for the Coach Cards migration, AND
// for the REAL module behavior on top of it: './db' is mocked to route into
// the embedded server (the programs.pg.test.ts pattern), so issueCoachCard,
// issueCoachCardToProgram, and listCoachCards below are the actual
// production functions executing their actual SQL against actual rows --
// including the real accessibleAthleteIds authorization filter and the real
// assignDrill/recordCompletion spine the cards share their table with.
//
// What needs proving that reading SQL cannot prove:
//   * the migration relaxes gap_id and adds issuance_id on a database built
//     by the progression migration (where gap_id is NOT NULL), and is a
//     no-op when re-applied;
//   * the runner's readiness assertion REFUSES a database the migration
//     never reached and accepts a migrated one, twice over;
//   * a gap-free card survives gap deletion while a gap-linked assignment
//     on the same table cascades away -- the exact guarantee the relaxation
//     was written for;
//   * a group issuance writes one row per AUTHORIZED ACTIVE member, all
//     sharing one issuance_id, skipping members off the coach's roster and
//     excluding lapsed/ended memberships entirely;
//   * listCoachCards returns only gap-free rows, scoped to the issuer,
//     with completion state aggregated per card.
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
  // A real BEGIN/COMMIT/ROLLBACK (the trainingHolds.pg.test.ts pattern), so
  // assignDrill and recordCompletion run their production transaction shape.
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { issueCoachCard, issueCoachCardToProgram, listCoachCards } from './coachCards';
import {
  assignDrill,
  getAssignmentCompletions,
  getAthleteAssignments,
  getDrillAssignmentById,
  recordCompletion,
  verifyCompletion,
} from './progression';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-cards-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_coach_cards_migration.sql';
const PROGRESSION_MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
/* Applied because PRODUCTION HAS IT: it adds pilot.athletes.deleted_at, which
   the authorization queries in access.ts now require. deploy-production's
   schema check parses `add column` out of every migration and asserts it
   exists, and it passed against the live production database on the
   2026-08-27 release. A fixture without it is not a smaller production; it is
   a schema nobody runs. */
const RETENTION_MIGRATION_FILE = 'pilot_slice_postgres_data_retention_deletion_migration.sql';
const DRILLS_MIGRATION_FILE = 'pilot_slice_postgres_drills_migration.sql';
const MEMBERSHIPS_MIGRATION_FILE = 'pilot_slice_postgres_program_memberships_migration.sql';
const PROGRAMS_MIGRATION_FILE = 'pilot_slice_postgres_programs_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-coach-cards-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as programs.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-cards';
const OTHER_ORG_ID = 'org-cards-elsewhere';
const ADMIN_ID = 'acct-cards-admin';
const COACH_ID = 'acct-cards-coach';
const OTHER_COACH_ID = 'acct-cards-other-coach';
// Athletes: A1/A3/A4/A5 belong to COACH, A2 to OTHER_COACH. Names sort
// Anna < Bela < Cora < Dana < Ede so ordering assertions are deterministic.
const ATHLETES: Array<{ id: string; name: string; coach: string }> = [
  { id: 'ath-cards-1', name: 'Anna Cards', coach: COACH_ID },
  { id: 'ath-cards-2', name: 'Bela Cards', coach: OTHER_COACH_ID },
  { id: 'ath-cards-3', name: 'Cora Cards', coach: COACH_ID },
  { id: 'ath-cards-4', name: 'Dana Cards', coach: COACH_ID },
  { id: 'ath-cards-5', name: 'Ede Cards', coach: COACH_ID },
];
const PROGRAM_ID = 'prog-cards-1';
const PROGRAM_NAME = 'Junior Boxing';

const coachActor: ActorIdentity = {
  accountId: COACH_ID,
  role: 'coach',
  organizationId: ORG_ID,
  athleteId: null,
};

const adminActor: ActorIdentity = {
  accountId: ADMIN_ID,
  role: 'organization_admin',
  organizationId: ORG_ID,
  athleteId: null,
};

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let migrationSql: string;
let retentionMigrationSql: string;
let progressionMigrationSql: string;
let drillsMigrationSql: string;
let membershipsMigrationSql: string;
let programsMigrationSql: string;
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
 * Base schema plus the progression migration ONLY -- the state every
 * pre-coach-cards environment is in, where drill_assignments.gap_id is
 * still NOT NULL. The migration tests start here.
 */
async function progressionOnlyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(retentionMigrationSql);
  await client.query(progressionMigrationSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $4, 'microsoft'),
            ($2, 'coach', $4, 'microsoft'),
            ($3, 'coach', $4, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, OTHER_COACH_ID, ORG_ID],
  );
  for (const athlete of ATHLETES) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())
       on conflict do nothing`,
      [ORG_ID, athlete.id, athlete.name, athlete.coach],
    );
  }
  return client;
}

/** The fully migrated state the module functions run against. */
async function freshDatabase(name: string): Promise<Client> {
  const client = await progressionOnlyDatabase(name);
  await client.query(drillsMigrationSql);
  await client.query(membershipsMigrationSql);
  await client.query(programsMigrationSql);
  await client.query(migrationSql);
  return client;
}

async function insertProgramWithMembers(
  client: Client,
  memberships: Array<{ athleteId: string; status: string }>,
  organizationId: string = ORG_ID,
): Promise<void> {
  await client.query(
    `insert into pilot.programs (organization_id, program_id, program_name, created_by_account_id)
     values ($1, $2, $3, $4)`,
    [organizationId, PROGRAM_ID, PROGRAM_NAME, ADMIN_ID],
  );
  for (const [index, membership] of memberships.entries()) {
    await client.query(
      `insert into pilot.program_memberships
         (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
       values ($1, $2, $3, $4, $5, '2026-06-01'::date, $6)`,
      [ORG_ID, `mem-cards-${index}`, membership.athleteId, PROGRAM_NAME, membership.status, ADMIN_ID],
    );
  }
}

async function gapIdIsNullable(client: Client): Promise<boolean> {
  const result = await client.query<{ nullable: boolean }>(
    `select (attnotnull = false) as nullable
     from pg_attribute
     where attrelid = to_regclass('pilot.drill_assignments')
       and attname = 'gap_id' and not attisdropped`,
  );
  return result.rows[0]?.nullable ?? false;
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
  progressionMigrationSql = await fs.readFile(path.join(INFRA_DIR, PROGRESSION_MIGRATION_FILE), 'utf8');
  retentionMigrationSql = await fs.readFile(path.join(INFRA_DIR, RETENTION_MIGRATION_FILE), 'utf8');
  drillsMigrationSql = await fs.readFile(path.join(INFRA_DIR, DRILLS_MIGRATION_FILE), 'utf8');
  membershipsMigrationSql = await fs.readFile(path.join(INFRA_DIR, MEMBERSHIPS_MIGRATION_FILE), 'utf8');
  programsMigrationSql = await fs.readFile(path.join(INFRA_DIR, PROGRAMS_MIGRATION_FILE), 'utf8');

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

describe('coach-cards migration', () => {
  test('relaxes gap_id and adds issuance_id on a progression-built database, idempotently', async () => {
    const client = await progressionOnlyDatabase('cards_fresh');
    try {
      // The starting state IS the constraint being relaxed: the progression
      // migration declares gap_id NOT NULL, and a gap-free insert must fail
      // there. If this ever passes pre-migration, the relaxation would be
      // asserting nothing.
      expect(await gapIdIsNullable(client)).toBe(false);
      await expect(
        client.query(
          `insert into pilot.drill_assignments
             (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description)
           values ('asg-pre', $1, null, $2, $3, 'Card', 'Work')`,
          [ORG_ID, ATHLETES[0].id, COACH_ID],
        ),
      ).rejects.toThrow(/null value|not-null/i);

      await applyMigrationTransaction(client, migrationSql);
      // Re-run: the `all` chain re-applies every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      expect(await gapIdIsNullable(client)).toBe(true);
      const index = await client.query(
        `select indexdef from pg_indexes
         where schemaname = 'pilot' and tablename = 'drill_assignments'
           and indexname = 'idx_pilot_drill_assignments_issuance'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain('issuance_id IS NOT NULL');

      await client.query(
        `insert into pilot.drill_assignments
           (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description, issuance_id)
         values ('asg-post', $1, null, $2, $3, 'Card', 'Work', 'iss-1')`,
        [ORG_ID, ATHLETES[0].id, COACH_ID],
      );
      const row = await client.query(
        `select gap_id, issuance_id from pilot.drill_assignments where assignment_id = 'asg-post'`,
      );
      expect(row.rows[0]).toEqual({ gap_id: null, issuance_id: 'iss-1' });
    } finally {
      await client.end();
    }
  });

  test('the runner readiness pair: refuses a database the migration never reached, accepts a migrated one twice', async () => {
    const client = await progressionOnlyDatabase('cards_readiness');
    try {
      // 'select 1' stands in for the migration SQL: the transaction opens,
      // no migration runs, and the readiness query must refuse -- this is
      // the #488-class guard being watched to fail.
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow('COACH_CARDS_NOT_READY');
      // The refusal rolled back, leaving the database exactly un-migrated.
      expect(await gapIdIsNullable(client)).toBe(false);

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      expect(await gapIdIsNullable(client)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('a card survives gap deletion; the gap-linked assignment beside it cascades away', async () => {
    const client = await freshDatabase('cards_cascade');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ('gap-cards-1', $1, $2, $3, 'technique', 'Drops the right hand', 'coach_observation')`,
        [ORG_ID, ATHLETES[0].id, COACH_ID],
      );
      const gapLinked = await assignDrill({
        organizationId: ORG_ID,
        gapId: 'gap-cards-1',
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Guard discipline',
        drillDescription: 'Three rounds mirror work',
        drillDifficulty: 'intermediate',
      });
      const card = await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Shadowbox',
        drillDescription: 'Three rounds before Friday',
        drillDifficulty: 'intermediate',
      });
      expect(card.gap_id).toBeNull();

      await client.query(`delete from pilot.progression_gaps where gap_id = 'gap-cards-1'`);

      const remaining = await client.query<{ assignment_id: string }>(
        `select assignment_id from pilot.drill_assignments where organization_id = $1 order by assignment_id`,
        [ORG_ID],
      );
      const ids = remaining.rows.map((row) => row.assignment_id);
      expect(ids).toContain(card.assignment_id);
      expect(ids).not.toContain(gapLinked.assignment_id);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('group issuance against real memberships and real authorization', () => {
  test('issues to authorized ACTIVE members under one issuance_id, skips off-roster members, excludes lapsed/ended', async () => {
    const client = await freshDatabase('cards_group');
    activeClient = client;
    try {
      await insertProgramWithMembers(client, [
        { athleteId: ATHLETES[0].id, status: 'active' }, // Anna -- coach's
        { athleteId: ATHLETES[1].id, status: 'active' }, // Bela -- other coach's
        { athleteId: ATHLETES[2].id, status: 'active' }, // Cora -- coach's
        { athleteId: ATHLETES[3].id, status: 'lapsed' }, // Dana -- coach's, lapsed
        { athleteId: ATHLETES[4].id, status: 'ended' }, // Ede -- coach's, ended
      ]);

      const result = await issueCoachCardToProgram({
        actor: coachActor,
        programId: PROGRAM_ID,
        drillName: 'Jump rope',
        drillDescription: 'Ten minutes, no misses',
        drillDifficulty: 'beginner',
        frequencyPerWeek: 3,
      });

      expect(result).not.toBeNull();
      expect(result!.program_name).toBe(PROGRAM_NAME);
      expect(result!.issued.map((entry) => entry.athlete_id)).toEqual([ATHLETES[0].id, ATHLETES[2].id]);
      expect(result!.skipped).toEqual([{ athlete_id: ATHLETES[1].id, athlete_name: 'Bela Cards' }]);

      const rows = await client.query<{
        athlete_id: string;
        issuance_id: string;
        gap_id: string | null;
        assigned_by_account_id: string;
        frequency_per_week: number;
      }>(
        `select athlete_id, issuance_id, gap_id, assigned_by_account_id, frequency_per_week
         from pilot.drill_assignments where organization_id = $1 order by athlete_id`,
        [ORG_ID],
      );
      // Exactly the two authorized active members -- Dana (lapsed) and Ede
      // (ended) never appear, in the report or on the table.
      expect(rows.rows.map((row) => row.athlete_id)).toEqual([ATHLETES[0].id, ATHLETES[2].id]);
      expect(new Set(rows.rows.map((row) => row.issuance_id)).size).toBe(1);
      expect(rows.rows[0].issuance_id).toBe(result!.issuance_id);
      for (const row of rows.rows) {
        expect(row.gap_id).toBeNull();
        expect(row.assigned_by_account_id).toBe(COACH_ID);
        expect(row.frequency_per_week).toBe(3);
      }
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an organization admin reaches every active member: nothing skipped', async () => {
    const client = await freshDatabase('cards_group_admin');
    activeClient = client;
    try {
      await insertProgramWithMembers(client, [
        { athleteId: ATHLETES[0].id, status: 'active' },
        { athleteId: ATHLETES[1].id, status: 'active' },
      ]);

      const result = await issueCoachCardToProgram({
        actor: adminActor,
        programId: PROGRAM_ID,
        drillName: 'Roadwork',
        drillDescription: 'Two miles',
        drillDifficulty: 'intermediate',
      });

      expect(result!.issued.map((entry) => entry.athlete_id)).toEqual([ATHLETES[0].id, ATHLETES[1].id]);
      expect(result!.skipped).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('another organization\'s program_id resolves to null, exactly like one that does not exist', async () => {
    const client = await freshDatabase('cards_group_cross_org');
    activeClient = client;
    try {
      await insertProgramWithMembers(client, [], OTHER_ORG_ID);

      const crossOrg = await issueCoachCardToProgram({
        actor: coachActor,
        programId: PROGRAM_ID,
        drillName: 'Jump rope',
        drillDescription: 'Ten minutes',
        drillDifficulty: 'beginner',
      });
      const unknown = await issueCoachCardToProgram({
        actor: coachActor,
        programId: 'prog-cards-never-existed',
        drillName: 'Jump rope',
        drillDescription: 'Ten minutes',
        drillDifficulty: 'beginner',
      });

      expect(crossOrg).toBeNull();
      expect(unknown).toBeNull();
      const rows = await client.query(`select 1 from pilot.drill_assignments`);
      expect(rows.rows).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('the coach card list', () => {
  test('returns only gap-free cards, scoped to the issuer, with completions aggregated', async () => {
    const client = await freshDatabase('cards_list');
    activeClient = client;
    try {
      // A gap-driven assignment on the same table, which must NOT appear.
      await client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ('gap-cards-list', $1, $2, $3, 'technique', 'Flat rear foot', 'coach_observation')`,
        [ORG_ID, ATHLETES[0].id, COACH_ID],
      );
      await assignDrill({
        organizationId: ORG_ID,
        gapId: 'gap-cards-list',
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Pivot drill',
        drillDescription: 'Rounds on the line',
        drillDifficulty: 'intermediate',
      });

      const mine = await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Shadowbox',
        drillDescription: 'Three rounds',
        drillDifficulty: 'intermediate',
      });
      const theirs = await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[1].id,
        assignedByAccountId: OTHER_COACH_ID,
        drillName: 'Bag work',
        drillDescription: 'Four rounds',
        drillDifficulty: 'intermediate',
      });

      await recordCompletion({
        organizationId: ORG_ID,
        assignmentId: mine.assignment_id,
        athleteId: ATHLETES[0].id,
        notes: 'Done before school',
      });

      const coachView = await listCoachCards(coachActor);
      expect(coachView.map((row) => row.assignment_id)).toEqual([mine.assignment_id]);
      expect(coachView[0].athlete_name).toBe('Anna Cards');
      expect(coachView[0].completions).toHaveLength(1);
      expect(coachView[0].completions[0].verification_status).toBe('pending');
      expect(coachView[0].completions[0].notes).toBe('Done before school');
      // One log with no frequency set is 25%, per touchAssignmentProgress.
      expect(coachView[0].completion_percentage).toBe(25);

      const adminView = await listCoachCards(adminActor);
      expect(adminView.map((row) => row.assignment_id).sort()).toEqual(
        [mine.assignment_id, theirs.assignment_id].sort(),
      );
      // The gap-driven assignment never surfaces as a card in either view.
      expect(adminView.map((row) => row.drill_name)).not.toContain('Pivot drill');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// P1 (#553 Codex finding). The card list is a READ of an athlete's name,
// their completion notes, and their verification state. Scoping it by
// assigned_by_account_id alone derives authorization from an identity that
// never changes: the coach who issued a card keeps reading that athlete
// forever, through a roster reassignment and past the expiry of temporary
// coverage -- while assertActorCanAccessAthlete refuses them, and the
// verify endpoint (which DOES recheck) refuses the write. #546 fixed this
// defect class platform-wide; the fix is the same one, athleteIdsForCoach.
describe('a card read is bounded by CURRENT access, not by who issued it', () => {
  async function seedIssuedCard(athleteId: string) {
    return issueCoachCard({
      organizationId: ORG_ID,
      athleteId,
      assignedByAccountId: COACH_ID,
      drillName: 'Shadowbox',
      drillDescription: 'Three rounds before Friday',
      drillDifficulty: 'intermediate',
    });
  }

  test('a reassigned athlete drops out of the issuing coach list, while the admin keeps seeing it', async () => {
    const client = await freshDatabase('cards_scope_reassign');
    activeClient = client;
    try {
      const card = await seedIssuedCard(ATHLETES[0].id);
      await recordCompletion({
        organizationId: ORG_ID,
        assignmentId: card.assignment_id,
        athleteId: ATHLETES[0].id,
        notes: 'Notes the coach must stop reading once the athlete moves',
      });

      // While the athlete is still theirs, the issuing coach reads it.
      expect((await listCoachCards(coachActor)).map((row) => row.assignment_id)).toEqual([card.assignment_id]);

      // The gym moves the athlete to another coach. Nothing about the card
      // changes -- assigned_by_account_id still names the original issuer.
      await client.query(
        `update pilot.athletes set coach_id = $1 where organization_id = $2 and athlete_id = $3`,
        [OTHER_COACH_ID, ORG_ID, ATHLETES[0].id],
      );

      expect(await listCoachCards(coachActor)).toEqual([]);
      // Not a deletion: the record stands, and the organization admin --
      // whose access did not change -- still reads it in full.
      const adminView = await listCoachCards(adminActor);
      expect(adminView.map((row) => row.assignment_id)).toEqual([card.assignment_id]);
      expect(adminView[0].completions[0].notes).toBe('Notes the coach must stop reading once the athlete moves');

      // And the athlete's own read is untouched: their work does not vanish
      // because the gym changed who coaches them.
      const athleteView = await getAthleteAssignments(ORG_ID, ATHLETES[0].id);
      expect(athleteView.map((row) => row.assignment_id)).toEqual([card.assignment_id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('expired coverage ends the read the same way an assignment change does', async () => {
    const client = await freshDatabase('cards_scope_coverage');
    activeClient = client;
    try {
      // ATHLETES[1] is the OTHER coach's athlete; this coach reaches them
      // only through a live coverage grant.
      await client.query(
        `insert into pilot.coach_coverage
           (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
         values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 hour')`,
        [ORG_ID, ATHLETES[1].id, COACH_ID, ADMIN_ID],
      );

      const card = await seedIssuedCard(ATHLETES[1].id);
      expect((await listCoachCards(coachActor)).map((row) => row.assignment_id)).toEqual([card.assignment_id]);

      // Coverage lapses. Same rule the access gate applies at read time:
      // expires_at > now() is false, so the grant is simply over.
      await client.query(
        `update pilot.coach_coverage set starts_at = now() - interval '3 hours', expires_at = now() - interval '1 minute'
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETES[1].id],
      );

      expect(await listCoachCards(coachActor)).toEqual([]);
      expect((await listCoachCards(adminActor)).map((row) => row.assignment_id)).toEqual([card.assignment_id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('issuer scoping survives as a convenience: one coach does not read another coach card for a shared athlete', async () => {
    const client = await freshDatabase('cards_scope_issuer');
    activeClient = client;
    try {
      // Both cards are for an athlete THIS coach may currently reach, so
      // only the issuer filter can separate them -- proving the athlete
      // bound was added alongside it rather than in place of it.
      const mine = await seedIssuedCard(ATHLETES[0].id);
      await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[0].id,
        assignedByAccountId: OTHER_COACH_ID,
        drillName: 'Bag work',
        drillDescription: 'Four rounds',
        drillDifficulty: 'intermediate',
      });

      expect((await listCoachCards(coachActor)).map((row) => row.assignment_id)).toEqual([mine.assignment_id]);
      expect(await listCoachCards(adminActor)).toHaveLength(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// P2 (#553 Codex finding). Archiving a program deliberately leaves its
// membership rows intact -- enrollment history outlives the group. That is
// exactly why the issuance lookup has to check status: without it, active
// memberships are still found under an archived program and real work is
// issued to a group the gym has closed and the UI no longer offers.
describe('an archived program cannot receive new work', () => {
  test('a same-org archived program_id is refused by name, and writes nothing', async () => {
    const client = await freshDatabase('cards_archived_program');
    activeClient = client;
    try {
      await insertProgramWithMembers(client, [
        { athleteId: ATHLETES[0].id, status: 'active' },
        { athleteId: ATHLETES[2].id, status: 'active' },
      ]);
      await client.query(
        `update pilot.programs set status = 'archived' where organization_id = $1 and program_id = $2`,
        [ORG_ID, PROGRAM_ID],
      );
      // The memberships really do survive archiving -- otherwise this test
      // would pass for the wrong reason (nobody to issue to).
      const stillMembers = await client.query(
        `select 1 from pilot.program_memberships where organization_id = $1 and status = 'active'`,
        [ORG_ID],
      );
      expect(stillMembers.rows).toHaveLength(2);

      await expect(
        issueCoachCardToProgram({
          actor: coachActor,
          programId: PROGRAM_ID,
          drillName: 'Jump rope',
          drillDescription: 'Ten minutes',
          drillDifficulty: 'beginner',
        }),
      ).rejects.toThrow(/archived/i);

      const written = await client.query(`select 1 from pilot.drill_assignments`);
      expect(written.rows).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('reactivating the program makes it issuable again', async () => {
    const client = await freshDatabase('cards_reactivated_program');
    activeClient = client;
    try {
      await insertProgramWithMembers(client, [{ athleteId: ATHLETES[0].id, status: 'active' }]);
      await client.query(
        `update pilot.programs set status = 'archived' where organization_id = $1 and program_id = $2`,
        [ORG_ID, PROGRAM_ID],
      );
      await client.query(
        `update pilot.programs set status = 'active' where organization_id = $1 and program_id = $2`,
        [ORG_ID, PROGRAM_ID],
      );

      const result = await issueCoachCardToProgram({
        actor: coachActor,
        programId: PROGRAM_ID,
        drillName: 'Jump rope',
        drillDescription: 'Ten minutes',
        drillDifficulty: 'beginner',
      });
      expect(result!.issued.map((entry) => entry.athlete_id)).toEqual([ATHLETES[0].id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// THE DEPLOY-ORDERING GUARANTEE, as a test rather than a comment.
//
// Coach Cards added a column to pilot.drill_assignments, and the first cut
// of this branch put it straight into progression.ts's SHARED
// ASSIGNMENT_FIELDS projection -- the one every assignment surface that
// predates Coach Cards reads through. On any database that had not yet
// taken the coach-cards migration, every one of those reads failed with
// `column "issuance_id" does not exist`. drillsPersistence.pg.test.ts is
// what caught it, because it builds exactly that database; in production
// the same mistake is a deploy that 500s the athlete's own drill list until
// the migration lands.
//
// This pins the rule directly rather than relying on another suite noticing
// again: the pre-existing assignment reads must work on a pre-cards
// database. Adding a new column to a shared projection breaks this test at
// the moment it is written.
describe('assignment reads that predate Coach Cards do not require its migration', () => {
  test('a pre-cards database still serves assignDrill and the assignment reads', async () => {
    // Base schema + progression + drills, and deliberately NOT coach-cards.
    const client = await progressionOnlyDatabase('cards_predeploy');
    await client.query(drillsMigrationSql);
    activeClient = client;
    try {
      const columns = await client.query(
        `select 1 from pg_attribute
         where attrelid = to_regclass('pilot.drill_assignments')
           and attname = 'issuance_id' and not attisdropped`,
      );
      // Guards the guard: if the column were already here the assertions
      // below would prove nothing about a pre-cards database.
      expect(columns.rows).toHaveLength(0);

      await client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ('gap-predeploy', $1, $2, $3, 'technique', 'Flat rear foot', 'coach_observation')`,
        [ORG_ID, ATHLETES[0].id, COACH_ID],
      );

      const assignment = await assignDrill({
        organizationId: ORG_ID,
        gapId: 'gap-predeploy',
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Pivot drill',
        drillDescription: 'Rounds on the line',
        drillDifficulty: 'intermediate',
      });
      expect(assignment.assignment_id).toBeTruthy();

      const listed = await getAthleteAssignments(ORG_ID, ATHLETES[0].id);
      expect(listed.map((row) => row.assignment_id)).toEqual([assignment.assignment_id]);

      const single = await getDrillAssignmentById(ORG_ID, assignment.assignment_id);
      expect(single?.assignment_id).toBe(assignment.assignment_id);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// THE TWO ENDPOINTS MUST NOT DISAGREE ABOUT WHO A COACH MAY REACH.
//
// The verify branch of /api/pilot/progression/completions has always
// rechecked with assertActorCanAccessAthlete before it flips anything. The
// listing did not, so the pair had drifted apart: one refused the write
// while the other kept handing over the athlete's name, notes and
// verification state. A divergence like that is the bug -- whichever side
// is looser is the one that decides what actually leaks -- so this pins
// them together in both directions rather than testing the list alone.
describe('the listing and the verification endpoint agree about current access', () => {
  async function canVerify(actor: ActorIdentity, athleteId: string): Promise<boolean> {
    try {
      await assertActorCanAccessAthlete(actor, athleteId);
      return true;
    } catch {
      return false;
    }
  }

  test('authorized: both allow -- and after reassignment: both refuse, for the same athlete', async () => {
    const client = await freshDatabase('cards_agreement');
    activeClient = client;
    try {
      const card = await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Shadowbox',
        drillDescription: 'Three rounds',
        drillDifficulty: 'intermediate',
      });
      const completion = await recordCompletion({
        organizationId: ORG_ID,
        assignmentId: card.assignment_id,
        athleteId: ATHLETES[0].id,
        notes: 'Logged while the athlete was still theirs',
      });

      // (1) Currently authorized: the coach lists the card AND may verify.
      expect((await listCoachCards(coachActor)).map((row) => row.assignment_id)).toEqual([card.assignment_id]);
      expect(await canVerify(coachActor, ATHLETES[0].id)).toBe(true);
      const verified = await verifyCompletion(completion.completion_id, COACH_ID, true, ORG_ID);
      expect(verified?.verification_status).toBe('verified');

      // (2) The athlete is reassigned to another coach.
      await client.query(
        `update pilot.athletes set coach_id = $1 where organization_id = $2 and athlete_id = $3`,
        [OTHER_COACH_ID, ORG_ID, ATHLETES[0].id],
      );

      // (3) + (5) Both sides refuse now, and they refuse together.
      expect(await listCoachCards(coachActor)).toEqual([]);
      expect(await canVerify(coachActor, ATHLETES[0].id)).toBe(false);

      // The coach who now HOLDS the athlete is allowed by the access gate --
      // so "nobody can reach this record" is not why the list came back
      // empty. The other coach simply issued no card of their own.
      expect(await canVerify(
        { accountId: OTHER_COACH_ID, role: 'coach', organizationId: ORG_ID, athleteId: null },
        ATHLETES[0].id,
      )).toBe(true);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('and neither side is reachable from another organization', async () => {
    const client = await freshDatabase('cards_agreement_cross_org');
    activeClient = client;
    try {
      const card = await issueCoachCard({
        organizationId: ORG_ID,
        athleteId: ATHLETES[0].id,
        assignedByAccountId: COACH_ID,
        drillName: 'Shadowbox',
        drillDescription: 'Three rounds',
        drillDifficulty: 'intermediate',
      });

      // A coach in another gym, carrying the SAME account id and the same
      // athlete id -- only the organization differs. Every read is scoped
      // by organization_id, so both sides must come up empty.
      const foreignActor: ActorIdentity = {
        accountId: COACH_ID,
        role: 'coach',
        organizationId: OTHER_ORG_ID,
        athleteId: null,
      };
      expect(await listCoachCards(foreignActor)).toEqual([]);
      expect(await canVerify(foreignActor, ATHLETES[0].id)).toBe(false);

      // An organization admin of the other gym is no different: the record
      // belongs to a gym that is not theirs.
      expect(await listCoachCards({
        accountId: ADMIN_ID, role: 'organization_admin', organizationId: OTHER_ORG_ID, athleteId: null,
      })).toEqual([]);

      // The verification write is scoped too, not just the read: the same
      // completion_id is untouchable from the other gym.
      const completion = await recordCompletion({
        organizationId: ORG_ID,
        assignmentId: card.assignment_id,
        athleteId: ATHLETES[0].id,
        notes: 'ours',
      });
      expect(await verifyCompletion(completion.completion_id, COACH_ID, true, OTHER_ORG_ID)).toBeNull();
      // Still pending in the gym that owns it -- the foreign attempt changed nothing.
      const [own] = await getAssignmentCompletions(ORG_ID, card.assignment_id);
      expect(own.verification_status).toBe('pending');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
