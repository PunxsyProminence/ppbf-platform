// Real PostgreSQL-backed contract test for the block-executions migration
// (module 036, slice 3 -- plan versus actual), AND for the real module
// behaviour on top of it: './db' is mocked to route into the embedded server,
// so the functions exercised below are the actual production functions
// executing their actual SQL against actual rows.
//
// What needs proving that reading SQL cannot prove:
//
//   * THE TABLE STORES NO TALLY. The column list is pinned, and the runner's
//     readiness gate refuses a database that grew one. This is the single
//     defect the whole design exists to prevent, so it is asserted against a
//     real information_schema rather than trusted to review;
//   * every count is computed at READ TIME and moves when the rows beneath it
//     move. Proven by logging a session AFTER reading the counts once and
//     watching the second read differ, with nothing written to this table;
//   * the SIX UNKNOWN STATES stay distinguishable. Collapsing any pair is how
//     this surface would start lying, and four of the six are only observable
//     against real rows: a window still open, a window that closed with
//     nothing logged, an assessment with a null administered_on, and a block
//     with a judgment versus one without;
//   * NOTHING INFERS A VERDICT. A closed window with zero activity stays
//     'no judgment recorded', never 'not_delivered' -- the schema cannot tell
//     "did not attend" from "was not logged";
//   * ONE JUDGMENT PER BLOCK (owner decision D1(a)): a second record CORRECTS
//     rather than inserts, and the unique constraint is real;
//   * access is inherited from the block, arm by arm, and a writer with no
//     ACTIVE membership in a writing role is refused;
//   * the migration creates the table from nothing and re-applying is a no-op
//     -- including the DO block, which DROPS and RE-ADDS the adherence
//     constraint on every run, so "idempotent" is a stronger claim here than
//     `if not exists` and has to be shown;
//   * the runner's readiness assertion can genuinely both pass and fail.
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

import type { ActorIdentity } from './access';
import {
  BLOCK_ADHERENCE_STATES,
  getBlockExecution,
  getBlockPlanVsActual,
  recordBlockExecution,
} from './athleteDevelopmentBlockExecutions';
import type { PilotRole } from './contracts';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-adb-executions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_block_executions_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-block-executions-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-executions';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-exe-admin';
const OTHER_ADMIN_ID = 'acct-exe-other-admin';
// Coach of record for both athletes in ORG_ID.
const COACH_ID = 'acct-exe-coach';
const LAPSED_COACH_ID = 'acct-exe-lapsed';
// Active coach membership here, coach of record for nobody, no coverage.
const UNASSIGNED_COACH_ID = 'acct-exe-unassigned';
const OTHER_COACH_ID = 'acct-exe-other-coach';
// Active memberships HERE, in roles that may not author.
const ATHLETE_ACCOUNT_ID = 'acct-exe-athlete-account';
const SECOND_ATHLETE_ACCOUNT_ID = 'acct-exe-athlete-account-2';
const PARENT_ACCOUNT_ID = 'acct-exe-parent';
const UNLINKED_PARENT_ACCOUNT_ID = 'acct-exe-parent-unlinked';
const PARENT_ROW_ID = 'parent-exe-1';
const UNLINKED_PARENT_ROW_ID = 'parent-exe-2';
const ATHLETE_ID = 'ath-exe-1';
const SECOND_ATHLETE_ID = 'ath-exe-2';
const OTHER_ATHLETE_ID = 'ath-exe-other';
const BLOCK_ID = 'block-exe-ours';
const OPEN_BLOCK_ID = 'block-exe-open';
const SECOND_BLOCK_ID = 'block-exe-sibling';
const OTHER_BLOCK_ID = 'block-exe-theirs';

/* One actor per arm of assertActorCanAccessAthlete, plus the near-miss for
   each. Access to an objective is not decided here -- it is decided on the
   parent block -- so these exist to prove the inheritance actually happens
   rather than being asserted in a comment. */
function actorFor(
  accountId: string,
  role: PilotRole,
  organizationId: string = ORG_ID,
  athleteId: string | null = null,
): ActorIdentity {
  return { accountId, role, organizationId, athleteId };
}

const ADMIN = actorFor(ADMIN_ID, 'organization_admin');
const OTHER_ADMIN = actorFor(OTHER_ADMIN_ID, 'organization_admin', OTHER_ORG_ID);
const COACH = actorFor(COACH_ID, 'coach');
const LAPSED_COACH = actorFor(LAPSED_COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const SECOND_ATHLETE = actorFor(SECOND_ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, SECOND_ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const UNLINKED_GUARDIAN = actorFor(UNLINKED_PARENT_ACCOUNT_ID, 'parent');
// Refused unconditionally by the chokepoint, so they need no account row.
const PLATFORM_OWNER = actorFor('acct-exe-owner', 'platform_owner');
const BOARD = actorFor('acct-exe-board', 'board');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/**
 * THE WHOLE SCHEMA, then this slice's own table dropped back off when a case
 * needs to watch it get created.
 *
 * Why the whole schema: this suite drives feature code that resolves access
 * through the parent block, and that path reads pilot.athletes.deleted_at --
 * a column belonging to the data-retention migration, which the hand-picked
 * hand-picked migration list would never have named. A suite that picks its
 * own migrations is testing a database that has never existed anywhere. See
 * scripts/lib/full-schema.mjs and #706.
 *
 * `preMigration` leaves everything else standing -- two gyms, three blocks,
 * every account and link -- so the runner's refusal case has a database that
 * is correct in every respect except this one table.
 */
async function freshDatabase(
  name: string,
  { preMigration = false }: { preMigration?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'organization_admin', $10, 'microsoft', null),
            ($2, 'coach',              $10, 'microsoft', null),
            ($3, 'coach',              $10, 'microsoft', null),
            ($4, 'coach',              $10, 'microsoft', null),
            ($5, 'coach',              $11, 'microsoft', null),
            ($6, 'athlete',            $10, 'microsoft', $12),
            ($7, 'athlete',            $10, 'microsoft', $13),
            ($8, 'parent',             $10, 'microsoft', null),
            ($9, 'parent',             $10, 'microsoft', null),
            ($14, 'organization_admin', $11, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     ORG_ID, OTHER_ORG_ID, ATHLETE_ID, SECOND_ATHLETE_ID, OTHER_ADMIN_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1,  $11, 'organization_admin', true),
            ($2,  $11, 'coach',              true),
            ($3,  $11, 'coach',              false),
            ($4,  $11, 'coach',              true),
            ($5,  $12, 'coach',              true),
            ($6,  $11, 'athlete',            true),
            ($7,  $11, 'athlete',            true),
            ($8,  $11, 'parent',             true),
            ($9,  $11, 'parent',             true),
            ($10, $12, 'organization_admin', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     OTHER_ADMIN_ID, ORG_ID, OTHER_ORG_ID],
  );
  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Executions Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  // One parent LINKED to ATHLETE_ID, one parent of the same gym linked to
  // nobody. Without the second, every guardian assertion below would also
  // pass for an implementation that let any parent read any athlete.
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Linked Guardian'), ($1, $4, $5, 'Unlinked Guardian')
     on conflict do nothing`,
    [ORG_ID, PARENT_ROW_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ROW_ID, UNLINKED_PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'parent') on conflict do nothing`,
    [ORG_ID, PARENT_ROW_ID, ATHLETE_ID],
  );

  /* WINDOWS RELATIVE TO current_date, NOT LITERAL DATES. Whether a block's
     window has closed is one of the six UNKNOWN states, so a suite with
     hard-coded dates would quietly stop testing it the day those dates fell
     into the past. CLOSED_BLOCK_ID ended 30 days ago; OPEN_BLOCK_ID is still
     running. Both belong to the same athlete, so the difference under test is
     the window and nothing else. */
  for (const [org, blockId, athleteId, coachId, startOffset, endOffset] of [
    [ORG_ID, BLOCK_ID, ATHLETE_ID, COACH_ID, 72, 30],
    [ORG_ID, OPEN_BLOCK_ID, ATHLETE_ID, COACH_ID, 5, -30],
    [ORG_ID, SECOND_BLOCK_ID, SECOND_ATHLETE_ID, COACH_ID, 72, 30],
    [OTHER_ORG_ID, OTHER_BLOCK_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID, 72, 30],
  ] as const) {
    await client.query(
      `insert into pilot.athlete_development_blocks
         (organization_id, block_id, athlete_id, title, training_emphasis,
          starts_on, ends_on, created_by_account_id)
       values ($1, $2, $3, 'Fall strength block', 'Round-3 work rate',
               current_date - ($5::int), current_date - ($6::int), $4)
       on conflict do nothing`,
      [org, blockId, athleteId, coachId, startOffset, endOffset],
    );
  }

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_development_block_executions cascade');
  }

  return client;
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

/** A training attempt N days before today, i.e. inside or outside a window. */
function insertAttempt(client: Client, attemptId: string, daysAgo: number, athleteId = ATHLETE_ID) {
  return client.query(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, metric_kind, achieved_value,
        attempted_at, recorded_by_account_id)
     values ($1, $2, $3, 'reps', 12, now() - ($4::int * interval '1 day'), $5)`,
    [ORG_ID, attemptId, athleteId, daysAgo, COACH_ID],
  );
}

/** An activity-log row N days before today, carrying real minutes. */
function insertActivity(
  client: Client, activityId: string, daysAgo: number, minutes = 45, athleteId = ATHLETE_ID,
  startedHoursAgo: number | null = null,
) {
  /* person_account_id follows the athlete, because pilot_activity_log_one_per_occurrence
     is unique on (organization, PERSON, day, domain, class, start) -- keying two
     athletes' rows to one account would collide on the same day rather than
     record two people training. */
  const personAccountId = athleteId === ATHLETE_ID ? ATHLETE_ACCOUNT_ID : SECOND_ATHLETE_ACCOUNT_ID;
  return client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
        activity_type, occurred_on, duration_minutes, capture_method, recorded_by_role,
        recorded_by_account_id, started_at)
     values ($1, $2, $3, $4, 'boxing_training', 'technical_session',
             current_date - ($5::int), $6, 'coach_override', 'coach', $7,
             case when $8::int is null then null
                  else now() - ($8::int * interval '1 hour') end)`,
    [ORG_ID, activityId, personAccountId, athleteId, daysAgo, minutes, COACH_ID, startedHoursAgo],
  );
}

/**
 * An assessment, either administered on a given day or -- the case that
 * matters -- with administered_on left NULL.
 *
 * DRIFT 1. The assessment-protocols migration adds administered_on as
 * `date null` and indexes the null rows as the not-yet-administered case, so
 * this state is real and reachable, not hypothetical.
 */
function insertAssessment(
  client: Client, assessmentId: string, daysAgo: number | null, dueDaysAgo: number | null = null,
) {
  /* dueDaysAgo places an UNDATED assessment in a window. administered_on null
     with due_on null is a row no window can claim, and the query excludes it
     rather than counting it against every block. */
  return client.query(
    `insert into pilot.assessments
       (organization_id, assessment_id, athlete_id, assessment_type, administered_on, due_on)
     values ($1, $2::uuid, $3, 'movement_screen',
             case when $4::int is null then null else current_date - ($4::int) end,
             case when $5::int is null then null else current_date - ($5::int) end)`,
    [ORG_ID, assessmentId, ATHLETE_ID, daysAgo, dueDaysAgo],
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
});

afterEach(() => {
  activeClient = null;
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

describe('block executions migration', () => {
  test('creates the table from nothing and accepts a coach-recorded verdict', async () => {
    const client = await freshDatabase('adb_exec_create', { preMigration: true });
    try {
      await expect(
        client.query('select 1 from pilot.athlete_development_block_executions'),
      ).rejects.toThrow(/does not exist/);

      await applyMigrationTransaction(client, migrationSql);

      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, deviations,
            deviation_reason, recorded_by_account_id)
         values ($1, 'exe-1', $2, 'delivered_with_deviations',
                 'Missed the last two weeks of sparring.',
                 'Athlete had a school trip.', $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      );

      const { rows } = await client.query(
        `select adherence, deviations, deviation_reason
         from pilot.athlete_development_block_executions where execution_id = 'exe-1'`,
      );
      expect(rows[0]).toEqual({
        adherence: 'delivered_with_deviations',
        deviations: 'Missed the last two weeks of sparring.',
        deviation_reason: 'Athlete had a school trip.',
      });
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    /* Stronger than `if not exists`: the DO block DROPS and RE-ADDS the
       adherence constraint on every run, so this proves the drop/re-add cycle
       does not disturb data already stored under it. */
    const client = await freshDatabase('adb_exec_reapply');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, recorded_by_account_id)
         values ($1, 'exe-keep', $2, 'under_delivered', $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      );

      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select execution_id, adherence from pilot.athlete_development_block_executions`,
      );
      expect(rows).toEqual([{ execution_id: 'exe-keep', adherence: 'under_delivered' }]);
    } finally {
      await client.end();
    }
  });

  test('THE TABLE STORES NO TALLY -- the column list is exactly these ten', async () => {
    /* The single defect this whole design exists to prevent. If a later change
       adds attempt_count, minutes_total, adherence_score or completion_pct,
       this fails rather than shipping a number that silently stops matching
       the rows beneath it. Asserted against information_schema, not against a
       reading of the migration. */
    const client = await freshDatabase('adb_exec_no_tally');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'athlete_development_block_executions'
         order by column_name`,
      );
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
        'adherence',
        'block_id',
        'created_at',
        'deviation_reason',
        'deviations',
        'execution_id',
        'organization_id',
        'recorded_at',
        'recorded_by_account_id',
        'updated_at',
      ]);
    } finally {
      await client.end();
    }
  });

  test('the adherence vocabulary is a database fact, and unknown is the default', async () => {
    const client = await freshDatabase('adb_exec_vocab');
    try {
      await applyMigrationTransaction(client, migrationSql);

      /* Every value the module offers is accepted by the constraint. The two
         lists cannot drift apart without this failing.

         deviations is supplied for all five rather than only where it is
         required: 'delivered_with_deviations' is refused without it by
         pilot_adb_executions_deviations_check, and that pairing has its own
         case above. This one is about the VOCABULARY, so it holds the other
         variable still. */
      for (const [index, state] of BLOCK_ADHERENCE_STATES.entries()) {
        await client.query(
          `insert into pilot.athlete_development_block_executions
             (organization_id, execution_id, block_id, adherence, deviations,
              recorded_by_account_id)
           values ($1, $2, $3, $4, 'Sparring dropped in week 5.', $5)
           on conflict (organization_id, block_id) do update set adherence = excluded.adherence`,
          [ORG_ID, `exe-v-${index}`, BLOCK_ID, state, COACH_ID],
        );
      }

      await expect(client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, recorded_by_account_id)
         values ($1, 'exe-bad', $2, 'mostly_fine', $3)`,
        [ORG_ID, SECOND_BLOCK_ID, COACH_ID],
      )).rejects.toThrow(/adherence_check/);

      // The default is the honest answer, not a flattering one.
      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, recorded_by_account_id)
         values ($1, 'exe-default', $2, $3)`,
        [ORG_ID, SECOND_BLOCK_ID, COACH_ID],
      );
      const { rows } = await client.query(
        `select adherence, deviations, deviation_reason
         from pilot.athlete_development_block_executions where execution_id = 'exe-default'`,
      );
      expect(rows[0]).toEqual({ adherence: 'unknown', deviations: '', deviation_reason: '' });
    } finally {
      await client.end();
    }
  });

  test('claimed deviations must be named -- the other half of the vocabulary', async () => {
    /* pilot_intervention_executions_deviations_check ships BESIDE the five
       words this table copied, and the first version of this migration took
       the words without it. Half a copy accepts "the plan bent" with no
       statement of how, which is the one combination the vocabulary exists to
       rule out. Found by reading #804's competing table, which copied both
       halves.

       The trim set is explicit rather than btrim/1: a lone tab would pass a
       spaces-only check that every JavaScript caller's .trim() calls empty. */
    const client = await freshDatabase('adb_exec_deviations');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, recorded_by_account_id)
         values ($1, 'exe-bare', $2, 'delivered_with_deviations', $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      )).rejects.toThrow(/deviations_check/);

      // A tab is not a statement of anything.
      await expect(client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, deviations, recorded_by_account_id)
         values ($1, 'exe-tab', $2, 'delivered_with_deviations', E'\t\n', $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      )).rejects.toThrow(/deviations_check/);

      // Stated, and it goes in.
      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, deviations, recorded_by_account_id)
         values ($1, 'exe-named', $2, 'delivered_with_deviations', 'Sparring dropped in week 5.', $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      );

      // And every OTHER state is free to leave deviations empty -- the
      // constraint is about one claim, not about the field being required.
      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, adherence, recorded_by_account_id)
         values ($1, 'exe-other', $2, 'under_delivered', $3)`,
        [ORG_ID, SECOND_BLOCK_ID, COACH_ID],
      );
    } finally {
      await client.end();
    }
  });

  test('one judgment per block is a database fact, not a convention', async () => {
    // Owner decision D1(a). Two live verdicts on one block is a discrepancy
    // someone would want resolved by arithmetic.
    const client = await freshDatabase('adb_exec_unique');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, recorded_by_account_id)
         values ($1, 'exe-a', $2, $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      );
      await expect(client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, recorded_by_account_id)
         values ($1, 'exe-b', $2, $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      )).rejects.toThrow(/one_per_block/);
    } finally {
      await client.end();
    }
  });

  test('an execution cannot hang off another organization\'s block, or outlive it', async () => {
    const client = await freshDatabase('adb_exec_tenancy');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // The composite FK is what makes block_id alone useless as a key.
      await expect(client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, recorded_by_account_id)
         values ($1, 'exe-cross', $2, $3)`,
        [ORG_ID, OTHER_BLOCK_ID, COACH_ID],
      )).rejects.toThrow(/block_fk/);

      await client.query(
        `insert into pilot.athlete_development_block_executions
           (organization_id, execution_id, block_id, recorded_by_account_id)
         values ($1, 'exe-cascade', $2, $3)`,
        [ORG_ID, BLOCK_ID, COACH_ID],
      );
      await client.query(
        `delete from pilot.athlete_development_blocks
         where organization_id = $1 and block_id = $2`,
        [ORG_ID, BLOCK_ID],
      );
      const { rows } = await client.query(
        'select count(*)::int as n from pilot.athlete_development_block_executions',
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('the module recording and reading a verdict', () => {
  let client: Client;

  beforeEach(async () => {
    client = await migratedDatabase('adb_exec_module');
    await applyMigrationTransaction(client, migrationSql);
  });

  afterEach(async () => {
    await client.end();
  });

  test('a coach records a verdict, and their words come back exactly as written', async () => {
    const written = await recordBlockExecution({
      actor: COACH,
      blockId: BLOCK_ID,
      adherence: 'delivered_with_deviations',
      deviations: '  Sparring dropped out of weeks 5 and 6.  ',
      deviationReason: 'Hand injury, cleared before the block ended.',
    });

    expect(written?.adherence).toBe('delivered_with_deviations');
    // Trimmed at the edges like every other coach-authored field here, and
    // otherwise untouched -- no reflow, no truncation, no sentence casing.
    expect(written?.deviations).toBe('Sparring dropped out of weeks 5 and 6.');
    expect(written?.deviation_reason).toBe('Hand injury, cleared before the block ended.');
    expect(written?.recorded_by_account_id).toBe(COACH_ID);
  });

  test('a second recording CORRECTS the verdict rather than filing another', async () => {
    // D1(a) again, this time through the module: the upsert is what makes the
    // unique constraint a design rather than an error a caller has to handle.
    await recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID, adherence: 'under_delivered',
      deviations: 'First reading.',
    });
    const corrected = await recordBlockExecution({
      actor: ADMIN, blockId: BLOCK_ID, adherence: 'delivered_as_planned',
      deviations: 'Second reading, after talking to the athlete.',
    });

    expect(corrected?.adherence).toBe('delivered_as_planned');
    expect(corrected?.deviations).toBe('Second reading, after talking to the athlete.');
    /* Re-stamped, deliberately: the row records WHO CONCLUDED THIS, and after
       a correction that is the person who corrected it. Naming the original
       author beside somebody else's words would attribute a judgment to
       someone who did not make it. */
    expect(corrected?.recorded_by_account_id).toBe(ADMIN_ID);

    const { rows } = await client.query(
      'select count(*)::int as n from pilot.athlete_development_block_executions',
    );
    expect(rows[0].n).toBe(1);
  });

  test('only admins and coaches may record one, and an invented state is refused', async () => {
    // Owner decision D2(a). The SAME list the block itself uses -- no new
    // taxonomy, and a lapsed membership is not an active one.
    for (const actor of [ATHLETE, GUARDIAN, LAPSED_COACH]) {
      await expect(recordBlockExecution({
        actor, blockId: BLOCK_ID, adherence: 'delivered_as_planned',
      })).rejects.toBeInstanceOf(ForbiddenError);
    }

    await expect(recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID,
      adherence: 'mostly_fine' as never,
    })).rejects.toBeInstanceOf(ValidationError);
  });

  test('the module refuses unnamed deviations with a sentence, not a SQLSTATE', async () => {
    /* Checked in both places on purpose: the constraint is what cannot be
       bypassed, this is what gives a coach something to read. A caller that
       reached the database here would get 23514. */
    await expect(recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID, adherence: 'delivered_with_deviations',
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID, adherence: 'delivered_with_deviations',
      deviations: '   ',
    })).rejects.toBeInstanceOf(ValidationError);

    const written = await recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID, adherence: 'delivered_with_deviations',
      deviations: 'Sparring dropped in week 5.',
    });
    expect(written?.adherence).toBe('delivered_with_deviations');
  });

  test('a verdict on a block still running is refused -- it would be a prediction', async () => {
    /* CODEX FINDING, #829. The header said an adherence judgment on an open
       window is "a prediction, not a record", and the write did not enforce
       it -- and getBlockExecution returns the row with no window state beside
       it, so a later reader could not tell the two apart. */
    await expect(recordBlockExecution({
      actor: COACH, blockId: OPEN_BLOCK_ID, adherence: 'delivered_as_planned',
    })).rejects.toBeInstanceOf(ValidationError);

    const { rows } = await client.query(
      'select count(*)::int as n from pilot.athlete_development_block_executions',
    );
    expect(rows[0].n).toBe(0);
  });

  test('a cancelled block can be judged immediately, whatever its dates say', async () => {
    /* THE ESCAPE HATCH, and it is not a loophole. A cancelled block's ends_on
       is routinely still in the future; refusing "not_delivered" on it would
       be refusing the truest verdict this table can hold. A gate written as
       "ends_on < today" alone -- which is what the finding literally proposed
       -- would have got this wrong. */
    for (const terminal of ['cancelled', 'completed']) {
      await client.query(
        `update pilot.athlete_development_blocks set status = $3
         where organization_id = $1 and block_id = $2`,
        [ORG_ID, OPEN_BLOCK_ID, terminal],
      );

      const written = await recordBlockExecution({
        actor: COACH, blockId: OPEN_BLOCK_ID, adherence: 'not_delivered',
      });
      expect(written?.adherence).toBe('not_delivered');
    }
  });

  test('a coach of this gym who cannot open the block cannot judge it', async () => {
    // Not a ForbiddenError: a hidden not-found, so an unassigned coach cannot
    // use this path to learn that a block id exists.
    await expect(recordBlockExecution({
      actor: UNASSIGNED_COACH, blockId: BLOCK_ID, adherence: 'delivered_as_planned',
    })).resolves.toBeNull();

    const { rows } = await client.query(
      'select count(*)::int as n from pilot.athlete_development_block_executions',
    );
    expect(rows[0].n).toBe(0);
  });

  test('reads reach exactly the people who can already reach the athlete', async () => {
    await recordBlockExecution({
      actor: COACH, blockId: BLOCK_ID, adherence: 'delivered_as_planned',
    });

    for (const actor of [ADMIN, COACH, ATHLETE, GUARDIAN]) {
      expect((await getBlockExecution(actor, BLOCK_ID))?.adherence)
        .toBe('delivered_as_planned');
    }
    // And the near-miss for each arm, which is what gives the four above their
    // meaning: same gym, no path to this athlete.
    for (const actor of [UNASSIGNED_COACH, UNLINKED_GUARDIAN, SECOND_ATHLETE, OTHER_ADMIN]) {
      expect(await getBlockExecution(actor, BLOCK_ID)).toBeNull();
    }
    /* Null, not a throw. The chokepoint refuses these two roles outright and
       getDevelopmentBlock turns that refusal into the same hidden not-found
       every other unreachable block gets -- so a platform owner cannot tell a
       block that exists from one that does not. Asserted the way the
       objectives suite asserts it, because it is the same behaviour. */
    for (const actor of [PLATFORM_OWNER, BOARD]) {
      expect(await getBlockExecution(actor, BLOCK_ID)).toBeNull();
      expect(await getBlockPlanVsActual(actor, BLOCK_ID)).toBeNull();
    }
  });
});

describe('the six UNKNOWN states stay distinguishable', () => {
  let client: Client;

  beforeEach(async () => {
    client = await migratedDatabase('adb_exec_unknowns');
    await applyMigrationTransaction(client, migrationSql);
  });

  afterEach(async () => {
    await client.end();
  });

  test('STATE 1 -- a block this actor cannot open is null, not an empty comparison', async () => {
    /* "No development block recorded for this period" and "not yours" are
       different sentences, and only the caller knows which question was
       asked. The module answers null to both rather than inventing an empty
       comparison that would read as "nothing was planned". */
    expect(await getBlockPlanVsActual(UNASSIGNED_COACH, BLOCK_ID)).toBeNull();
    expect(await getBlockPlanVsActual(COACH, 'block-that-never-existed')).toBeNull();
  });

  test('STATE 2 -- a block with no judgment is null, and is NOT not_delivered', async () => {
    /* The inference this capability refuses, stated as a test. The window has
       closed and nothing was logged, which is exactly the shape that tempts a
       system into concluding the block did not happen. */
    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);

    expect(view?.execution).toBeNull();
    expect(view?.window_has_closed).toBe(true);
    expect(view?.has_recorded_activity).toBe(false);
    // Nothing wrote a verdict on the way past.
    const { rows } = await client.query(
      'select count(*)::int as n from pilot.athlete_development_block_executions',
    );
    expect(rows[0].n).toBe(0);
  });

  test('a stored unknown is a human having looked, and reads differently from no row', async () => {
    // The pair that must not collapse: `execution === null` is "nobody has
    // judged this"; `execution.adherence === 'unknown'` is "a coach looked and
    // said so". Same word on screen, different facts.
    await recordBlockExecution({ actor: COACH, blockId: BLOCK_ID, adherence: 'unknown' });

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(view?.execution).not.toBeNull();
    expect(view?.execution?.adherence).toBe('unknown');
    expect(view?.execution?.recorded_by_account_id).toBe(COACH_ID);
  });

  test('STATE 3 -- a window that closed with nothing logged is its own answer', async () => {
    /* Distinct from not_delivered, because the schema cannot tell "the athlete
       did not attend" from "attendance was not logged". Neither writes a row,
       so neither is knowable from here. */
    const empty = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(empty?.has_recorded_activity).toBe(false);
    expect(empty?.counts).toEqual({
      training_attempts: 0,
      training_days_present: 0,
      assessments_administered: 0,
      assessments_without_administered_date: 0,
    });

    // One real row inside the window flips it, and nothing else.
    await insertAttempt(client, 'att-in', 45);
    const after = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(after?.has_recorded_activity).toBe(true);
    expect(after?.counts.training_attempts).toBe(1);
  });

  test('STATE 6 -- a block still running says so rather than showing a part-verdict', async () => {
    /* Module 036's own prerequisite: a block has nothing honest to show until
       its window has closed. An adherence judgment on a block that is still
       running is a prediction, not a record. */
    const open = await getBlockPlanVsActual(COACH, OPEN_BLOCK_ID);
    const closed = await getBlockPlanVsActual(COACH, BLOCK_ID);

    expect(open?.window_has_closed).toBe(false);
    expect(closed?.window_has_closed).toBe(true);
  });

  test('STATE 5 -- an assessment with no administered date is counted separately', async () => {
    /* Drift 1, found by checking the schema rather than trusting module 036's
       prose. administered_on is nullable and the protocols migration indexes
       the null rows as not-yet-administered, so this row is neither "none in
       this window" nor evidence the window contains. Folding it into either
       would make this surface lie in a small, plausible way. */
    await insertAssessment(client, '11111111-1111-4111-8111-111111111111', 45);  // inside
    await insertAssessment(client, '22222222-2222-4222-8222-222222222222', 400); // outside
    // Not administered, but DUE inside this window -- placeable, so counted.
    await insertAssessment(client, '33333333-3333-4333-8333-333333333333', null, 45);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);

    expect(view?.counts.assessments_administered).toBe(1);
    expect(view?.counts.assessments_without_administered_date).toBe(1);
    /* And the dateless one is NOT evidence the window contains: it does not
       make an otherwise-empty window look like it had activity. */
    await client.query(
      `delete from pilot.assessments where administered_on is not null`,
    );
    const dateless = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(dateless?.counts.assessments_without_administered_date).toBe(1);
    expect(dateless?.has_recorded_activity).toBe(false);
  });

  test('an undated assessment outside the window is not counted against this block', async () => {
    /* CODEX FINDING, #829. The undated subquery carried no date predicate at
       all, so every block for this athlete reported the same number: an
       assessment due next month counted against a block that closed last
       year, and the figure moved whenever unrelated work was scheduled. A
       per-athlete total wearing a per-block label. */
    // Due inside the window: placeable here, counted here.
    await insertAssessment(client, '44444444-4444-4444-8444-444444444444', null, 45);
    // Due long after this block closed: not this block's.
    await insertAssessment(client, '55555555-5555-4555-8555-555555555555', null, -400);
    // Neither administered nor due: no window can claim it, so none does.
    await insertAssessment(client, '66666666-6666-4666-8666-666666666666', null, null);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);

    expect(view?.counts.assessments_without_administered_date).toBe(1);
    // And it is still not evidence the window contains.
    expect(view?.has_recorded_activity).toBe(false);
  });

  test('STATE 4 -- the target the block named comes back with its status', async () => {
    // So a cancelled competition can never read as still live. A block with no
    // target says null rather than inventing one.
    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(view?.target).toBeNull();
  });
});

describe('every count is computed now, and stored nowhere', () => {
  let client: Client;

  beforeEach(async () => {
    client = await migratedDatabase('adb_exec_counts');
    await applyMigrationTransaction(client, migrationSql);
  });

  afterEach(async () => {
    await client.end();
  });

  test('a session logged AFTER the first read changes the second read', async () => {
    /* The property the whole design rests on. A stored count would still say
       one here, and would go on saying one -- disagreeing with the rows
       beneath it on a record about a child. */
    await insertActivity(client, 'act-1', 45, 60);
    const first = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(first?.counts.training_days_present).toBe(1);

    // The late-logged session: it happened during the window, it was entered
    // after the block closed and after somebody already looked.
    await insertActivity(client, 'act-late', 40, 30);

    const second = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(second?.counts.training_days_present).toBe(2);

    // And nothing was written to this slice's table by either read.
    const { rows } = await client.query(
      'select count(*)::int as n from pilot.athlete_development_block_executions',
    );
    expect(rows[0].n).toBe(0);
  });

  test('the window is inclusive at both ends, and excludes what falls outside', async () => {
    // A coach who wrote those dates meant the days they name.
    const { rows: bounds } = await client.query(
      `select (current_date - starts_on) as start_days, (current_date - ends_on) as end_days
       from pilot.athlete_development_blocks where organization_id = $1 and block_id = $2`,
      [ORG_ID, BLOCK_ID],
    );
    const startDays = Number(bounds[0].start_days);
    const endDays = Number(bounds[0].end_days);

    await insertActivity(client, 'act-first-day', startDays, 10);
    await insertActivity(client, 'act-last-day', endDays, 10);
    await insertActivity(client, 'act-day-before', startDays + 1, 10);
    await insertActivity(client, 'act-day-after', endDays - 1, 10);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(view?.counts.training_days_present).toBe(2);
  });

  test('two logged sessions on ONE day are ONE training day, not two', async () => {
    /* THE CT-13 PROPERTY, proven rather than assumed. An athlete who trains
       twice in a day has two activity_log rows; counting those raw turns one
       training day into two, and a participation figure about a child that is
       quietly doubled is the defect pilot.attendance_reconciled exists to
       prevent. This module reads that view, so the answer is 1.

       This module's first version DID count the raw rows, and
       attendancePrecedence.test.ts refused it. This is the case that would
       have caught the same mistake from the other side. */
    await insertActivity(client, 'act-morning', 45, 60, ATHLETE_ID, 8);
    await insertActivity(client, 'act-evening', 45, 45, ATHLETE_ID, 2);

    const { rows } = await client.query(
      `select count(*)::int as n from pilot.activity_log
       where organization_id = $1 and athlete_id = $2`,
      [ORG_ID, ATHLETE_ID],
    );
    expect(rows[0].n).toBe(2);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(view?.counts.training_days_present).toBe(1);
  });

  test('another athlete\'s rows never reach this block\'s counts', async () => {
    await insertActivity(client, 'act-mine', 45, 30, ATHLETE_ID);
    await insertActivity(client, 'act-theirs', 45, 30, SECOND_ATHLETE_ID);
    await insertAttempt(client, 'att-theirs', 45, SECOND_ATHLETE_ID);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    expect(view?.counts.training_days_present).toBe(1);
    expect(view?.counts.training_attempts).toBe(0);
  });

  test('the comparison returns no combined figure of any kind', async () => {
    /* Owner decision D5, asserted rather than promised. No percentage, no
       index, no grade, no single "adherence number" -- the counts are five
       separate tallies and there is deliberately not even a total. */
    await insertActivity(client, 'act-1', 45, 60);
    await insertAttempt(client, 'att-1', 45);

    const view = await getBlockPlanVsActual(COACH, BLOCK_ID);
    const serialized = JSON.stringify(view);

    expect(Object.keys(view?.counts ?? {}).sort()).toEqual([
      'assessments_administered',
      'assessments_without_administered_date',
      'training_attempts',
      'training_days_present',
    ]);
    for (const forbidden of [
      'score', 'percent', 'pct', 'index', 'grade', 'rating', 'total',
      'compliance', 'on_track', 'readiness',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('block executions runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('adb_exec_gate_refuses', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCK_EXECUTIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and re-apply stays a no-op', async () => {
    /* THIS CASE ALREADY EARNED ITS KEEP. The tally gate below first matched
       column names as SUBSTRINGS, which reads 'recorded_by_account_id' as
       containing "count" -- so the runner refused every correctly migrated
       database, including this one. It now matches whole underscore-separated
       words. A revert to substring matching fails here, before it could
       refuse a deploy. */
    const client = await freshDatabase('adb_exec_gate_accepts', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('the gate refuses a database that grew a tally column', async () => {
    /* The readiness query asserts an ABSENCE, which is unusual for a deploy
       gate and deliberate here: the surfaces above this table promise that no
       stored count exists, so a deployed database that grew one is a database
       this runner should refuse to call ready. */
    const client = await freshDatabase('adb_exec_gate_tally');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `alter table pilot.athlete_development_block_executions
         add column attempt_count integer not null default 0`,
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCK_EXECUTIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
