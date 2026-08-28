// Real PostgreSQL-backed contract test for the coach-development migration,
// AND for the real module behavior on top of it: './db' is mocked to route
// into the embedded server (the pattern programs.pg.test.ts and
// athleteDevelopmentBlocks.pg.test.ts already use), so the functions
// exercised below are the actual production functions executing their actual
// SQL against actual rows.
//
// What needs proving that reading SQL cannot prove:
//   * the migration creates both tables from nothing, and re-applying it is a
//     no-op that leaves rows untouched;
//   * the four-state lifecycle, the non-blank title/focus rules and the
//     positive-duration rule are DATABASE facts, refused with a constraint
//     violation rather than by a caller remembering to check;
//   * TENANCY HANGS OFF THE MEMBERSHIP, NOT THE ACCOUNT. A coach whose HOME
//     organization is elsewhere but who holds an active membership here can
//     keep a record here -- the case a composite FK into pilot.accounts
//     would have refused, which is why the FK points at
//     pilot.organization_memberships. A coach with no membership at all is
//     refused by the database, not merely by the module;
//   * one coach cannot read, write or attach anything to ANOTHER COACH'S
//     goal, even in the same gym, and the two failures are
//     indistinguishable from a goal id that never existed;
//   * neither table stores a progress, percentage, score or completion
//     column, and no read here sums duration_minutes into an hours total;
//   * the runner's own readiness assertion refuses a database the migration
//     never reached (#488: the assertion that can never fail is the quiet,
//     worse half of the assertion that can never pass).
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

import {
  createCoachDevelopmentActivity,
  createCoachDevelopmentGoal,
  getCoachDevelopmentGoal,
  listCoachDevelopmentActivities,
  listCoachDevelopmentGoals,
  updateCoachDevelopmentGoal,
} from './coachDevelopment';
import { ForbiddenError, ValidationError } from './errors';
import { gymDayIso } from '../../lib/gymTime';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-development-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_coach_development_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-coach-development-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-devel';
const OTHER_ORG_ID = 'org-elsewhere';
// An ordinary coach at this gym.
const COACH_ID = 'acct-devel-coach';
// A colleague at the SAME gym. Everything this coach owns must be invisible
// to COACH_ID, which is the property the whole "no cross-coach read" posture
// rests on.
const COLLEAGUE_ID = 'acct-devel-colleague';
// Home organization here, membership deactivated: still an account, no
// longer a writer.
const LAPSED_COACH_ID = 'acct-devel-lapsed';
// Home organization ELSEWHERE, ACTIVE membership here. The multi-org case
// pilot.accounts.organization_id gets wrong, and the reason the foreign key
// points at the membership table.
const VISITING_COACH_ID = 'acct-devel-visiting';
/* Home role 'coach' in pilot.accounts, membership role 'parent' HERE. The
   principal a session builds for this account carries role='coach' (read
   from accounts) and organization=ORG_ID (read from the session token), so
   the route's requireRole sees a coach. Only the membership row says what
   they actually are in this gym. */
const PARENT_HERE_ID = 'acct-devel-parent-here';
// Home organization elsewhere, membership only there. No standing here at
// all -- the database itself must refuse this one.
const OUTSIDE_COACH_ID = 'acct-devel-outside';

const FOCUS = 'Get better at keeping the anxious kids in the room during hard rounds.';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
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
 * Two gyms and five accounts with five different standings.
 *
 * The membership rows are the entire point of this fixture: every tenancy
 * assertion below distinguishes an ACTIVE membership from a DEACTIVATED one,
 * from NO membership, and from the account's denormalized home organization.
 * A fixture where every coach's home gym happened to be their working gym
 * would pass against a composite FK into pilot.accounts and prove nothing.
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

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $6, 'microsoft'),
            ($2, 'coach', $6, 'microsoft'),
            ($3, 'coach', $6, 'microsoft'),
            ($4, 'coach', $7, 'microsoft'),
            ($5, 'coach', $7, 'microsoft'),
            ($8, 'coach', $7, 'microsoft')
     on conflict do nothing`,
    [COACH_ID, COLLEAGUE_ID, LAPSED_COACH_ID, VISITING_COACH_ID, OUTSIDE_COACH_ID, ORG_ID, OTHER_ORG_ID,
     PARENT_HERE_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $6, 'coach', true),
            ($2, $6, 'coach', true),
            ($3, $6, 'coach', false),
            ($4, $6, 'coach', true),
            ($4, $7, 'coach', true),
            ($5, $7, 'coach', true),
            ($8, $6, 'parent', true)
     on conflict do nothing`,
    [COACH_ID, COLLEAGUE_ID, LAPSED_COACH_ID, VISITING_COACH_ID, OUTSIDE_COACH_ID, ORG_ID, OTHER_ORG_ID,
     PARENT_HERE_ID],
  );

  return client;
}

/** A migrated database, with `activeClient` pointed at it so the mocked
 * './db' routes the module's real SQL here. The migration's OWN tests
 * deliberately do not use this -- they call freshDatabase and apply exactly
 * the one file they are asserting about, because the runner-readiness cases
 * need the state a migrated database by definition cannot show. */
async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  await client.query(migrationSql);
  activeClient = client;
  return client;
}

function insertGoal(
  client: Client,
  goalId: string,
  overrides: Record<string, string | null> = {},
) {
  return client.query(
    `insert into pilot.coach_development_goals
       (organization_id, goal_id, coach_account_id, title, development_focus,
        target_on, status)
     values ($1, $2, $3, $4, $5, $6::date, coalesce($7, 'draft'))`,
    [
      overrides.organization_id ?? ORG_ID,
      goalId,
      overrides.coach_account_id ?? COACH_ID,
      overrides.title ?? 'Corner work under pressure',
      overrides.development_focus ?? FOCUS,
      'target_on' in overrides ? overrides.target_on : '2026-12-01',
      overrides.status ?? null,
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

describe('the coach development migration itself', () => {
  test('creates both tables from nothing and accepts a coach-authored goal', async () => {
    const client = await freshDatabase('cd_fresh');
    try {
      // Neither table is in the base schema, so these are real creations
      // rather than re-declarations of something already present.
      const before = await client.query(
        `select to_regclass('pilot.coach_development_goals') as goals,
                to_regclass('pilot.coach_development_activities') as activities`,
      );
      expect(before.rows[0].goals).toBeNull();
      expect(before.rows[0].activities).toBeNull();

      await client.query(migrationSql);
      await insertGoal(client, 'goal-1');
      await client.query(
        `insert into pilot.coach_development_activities
           (organization_id, activity_id, coach_account_id, goal_id, title,
            provider, occurred_on, duration_minutes)
         values ($1, 'act-1', $2, 'goal-1', 'Youth coaching clinic',
                 'USA Boxing', '2026-03-12', 180)`,
        [ORG_ID, COACH_ID],
      );

      const stored = await client.query(
        `select g.title, g.development_focus, g.status, g.target_on::text as target_on,
                a.title as activity_title, a.provider, a.duration_minutes,
                a.occurred_on::text as occurred_on
         from pilot.coach_development_goals g
         join pilot.coach_development_activities a
           on a.organization_id = g.organization_id and a.goal_id = g.goal_id
         where g.organization_id = $1`,
        [ORG_ID],
      );
      expect(stored.rows).toHaveLength(1);
      // Verbatim, both ways. The focus is the coach's own sentence and comes
      // back as the coach's own sentence.
      expect(stored.rows[0]).toMatchObject({
        development_focus: FOCUS,
        status: 'draft',
        target_on: '2026-12-01',
        activity_title: 'Youth coaching clinic',
        provider: 'USA Boxing',
        duration_minutes: 180,
        occurred_on: '2026-03-12',
      });
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('cd_noop');
    try {
      await client.query(migrationSql);
      await insertGoal(client, 'goal-keep');
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await client.query(migrationSql);
      await client.query(migrationSql);

      const rows = await client.query(
        `select goal_id, development_focus from pilot.coach_development_goals`,
      );
      expect(rows.rows).toEqual([{ goal_id: 'goal-keep', development_focus: FOCUS }]);
    } finally {
      await client.end();
    }
  });

  test('neither table stores a computed development figure', async () => {
    const client = await freshDatabase('cd_columns');
    try {
      await client.query(migrationSql);
      const columns = await client.query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'pilot'
           and table_name in ('coach_development_goals', 'coach_development_activities')`,
      );
      const names = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);

      // The specific shapes this build refuses. The Coach Goals tab shipped
      // with hardcoded progress bars reading "68%" for everybody; a column
      // that could hold one is how they come back.
      for (const forbidden of [
        'progress', 'percent', 'percent_complete', 'completion', 'completion_pct',
        'score', 'level', 'rank', 'rating', 'points', 'streak',
        'hours_total', 'total_hours', 'ceu', 'ceus', 'credits',
      ]) {
        expect(names.some((name) => name.endsWith(`.${forbidden}`))).toBe(false);
      }

      // And the credential shapes, which belong to pilot.person_clearances
      // and must never be mirrored here: a self-entered row carrying a
      // verifier or an expiry would be a safeguarding record nobody checked.
      for (const forbidden of [
        'verified_by_account_id', 'verified_at', 'expires_on', 'issued_on',
        'document_ref', 'clearance_type_id',
      ]) {
        expect(names.some((name) => name.endsWith(`.${forbidden}`))).toBe(false);
      }

      // Guards the guard: a query returning nothing would make every
      // assertion above vacuously true.
      expect(names).toContain('coach_development_goals.development_focus');
      expect(names).toContain('coach_development_activities.duration_minutes');
    } finally {
      await client.end();
    }
  });

  test('the lifecycle vocabulary is a database fact, and draft is the default', async () => {
    const client = await freshDatabase('cd_status');
    try {
      await client.query(migrationSql);

      for (const status of ['draft', 'active', 'completed', 'cancelled']) {
        await insertGoal(client, `goal-${status}`, { status });
      }
      await expect(insertGoal(client, 'goal-bad', { status: 'abandoned' }))
        .rejects.toMatchObject({ code: '23514' });

      // Omitting the column entirely lands on 'draft' -- a goal is written
      // before it is worked.
      await client.query(
        `insert into pilot.coach_development_goals
           (organization_id, goal_id, coach_account_id, title, development_focus)
         values ($1, 'goal-default', $2, 'Untitled', $3)`,
        [ORG_ID, COACH_ID, FOCUS],
      );
      const defaulted = await client.query(
        `select status from pilot.coach_development_goals where goal_id = 'goal-default'`,
      );
      expect(defaulted.rows[0].status).toBe('draft');
    } finally {
      await client.end();
    }
  });

  test('a goal with no title or no stated focus is refused, whitespace included', async () => {
    const client = await freshDatabase('cd_content');
    try {
      await client.query(migrationSql);

      await expect(insertGoal(client, 'goal-blank-title', { title: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertGoal(client, 'goal-blank-focus', { development_focus: '' }))
        .rejects.toMatchObject({ code: '23514' });
      // The tab case: btrim/1 trims SPACES ONLY, so the one-argument spelling
      // used elsewhere in infra/azure would accept this while every
      // JavaScript caller's .trim() calls it empty.
      await expect(insertGoal(client, 'goal-tab-title', { title: '\t\n' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('a duration of zero or less is refused, and no duration at all is fine', async () => {
    const client = await freshDatabase('cd_duration');
    try {
      await client.query(migrationSql);
      await insertGoal(client, 'goal-d');

      const insertActivity = (id: string, minutes: number | null) => client.query(
        `insert into pilot.coach_development_activities
           (organization_id, activity_id, coach_account_id, title, occurred_on, duration_minutes)
         values ($1, $2, $3, 'Clinic', '2026-03-12', $4)`,
        [ORG_ID, id, COACH_ID, minutes],
      );

      await expect(insertActivity('act-zero', 0)).rejects.toMatchObject({ code: '23514' });
      await expect(insertActivity('act-neg', -30)).rejects.toMatchObject({ code: '23514' });
      // Null is the honest "nobody recorded how long", and stays allowed.
      await insertActivity('act-null', null);
      const stored = await client.query(
        `select duration_minutes from pilot.coach_development_activities where activity_id = 'act-null'`,
      );
      expect(stored.rows[0].duration_minutes).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('tenancy is the membership: a coach with no standing here cannot be named at all', async () => {
    const client = await freshDatabase('cd_tenancy');
    try {
      await client.query(migrationSql);

      // OUTSIDE_COACH_ID is a real account with a real membership -- in the
      // OTHER gym. The row is refused by the database, not by a caller
      // remembering to check.
      await expect(insertGoal(client, 'goal-outsider', { coach_account_id: OUTSIDE_COACH_ID }))
        .rejects.toMatchObject({ code: '23503' });

      // The visiting coach's HOME organization is OTHER_ORG_ID and their
      // membership here is active, so they may be named here. This is the
      // case a composite FK into pilot.accounts(organization_id, account_id)
      // -- which exists, as uq_pilot_accounts_org_account -- would have
      // refused, and it is why the FK points at the membership table.
      await insertGoal(client, 'goal-visitor', { coach_account_id: VISITING_COACH_ID });

      // A DEACTIVATED membership still exists, so the FK still accepts it:
      // the constraint proves belonging, not permission. Refusing the write
      // is the data layer's job, asserted further down.
      await insertGoal(client, 'goal-lapsed', { coach_account_id: LAPSED_COACH_ID });

      const stored = await client.query(
        `select coach_account_id from pilot.coach_development_goals order by goal_id`,
      );
      expect(stored.rows.map((row) => row.coach_account_id)).toEqual([
        LAPSED_COACH_ID, VISITING_COACH_ID,
      ]);
    } finally {
      await client.end();
    }
  });

  test('an activity cannot be attached to a goal that is not in the same gym', async () => {
    const client = await freshDatabase('cd_goal_fk');
    try {
      await client.query(migrationSql);
      await insertGoal(client, 'goal-here');

      await expect(client.query(
        `insert into pilot.coach_development_activities
           (organization_id, activity_id, coach_account_id, goal_id, title, occurred_on)
         values ($1, 'act-x', $2, 'goal-nowhere', 'Clinic', '2026-03-12')`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  /* THIS TEST EXISTS BECAUSE IT FOUND A BUG, and the bug is worth keeping a
     guard against.

     The FK was written `on delete set null`, intending "the seminar still
     happened, so clear the link and keep the activity". On a MULTI-COLUMN
     foreign key, SET NULL nulls every referencing column -- organization_id
     among them -- so the delete died with `null value in column
     "organization_id" ... violates not-null constraint`. It applied cleanly
     and only failed here, at delete time.

     The clause is gone; the FK now carries no ON DELETE action, which is what
     this asserts. Nothing in this slice deletes a goal (a goal nobody wants
     is 'cancelled'), so the refusal below is unreachable in production today
     -- and it is deliberately loud for whoever adds a delete path, because
     they are the person who should decide what happens to the work that was
     done against it. */
  test('a goal with work logged against it cannot simply be deleted', async () => {
    const client = await freshDatabase('cd_goal_delete');
    try {
      await client.query(migrationSql);
      await insertGoal(client, 'goal-gone');
      await client.query(
        `insert into pilot.coach_development_activities
           (organization_id, activity_id, coach_account_id, goal_id, title, occurred_on)
         values ($1, 'act-survives', $2, 'goal-gone', 'Ringside seminar', '2026-02-02')`,
        [ORG_ID, COACH_ID],
      );

      await expect(client.query(
        `delete from pilot.coach_development_goals where organization_id = $1 and goal_id = 'goal-gone'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // And the record of what the coach actually did is untouched.
      const survivor = await client.query(
        `select goal_id, title from pilot.coach_development_activities where activity_id = 'act-survives'`,
      );
      expect(survivor.rows).toEqual([{ goal_id: 'goal-gone', title: 'Ringside seminar' }]);

      // A goal nobody logged against still deletes, so the refusal above is
      // about the child rows and not about the table being undeletable.
      await insertGoal(client, 'goal-unused');
      await client.query(
        `delete from pilot.coach_development_goals where organization_id = $1 and goal_id = 'goal-unused'`,
        [ORG_ID],
      );
    } finally {
      await client.end();
    }
  });
});

describe('the module writing and reading a coach\'s own development', () => {
  test('a coach records a goal, and their words come back exactly as written', async () => {
    const client = await migratedDatabase('cd_mod_create');
    try {
      const goal = await createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: '  Corner work under pressure  ',
        developmentFocus: `  ${FOCUS}  `,
        targetOn: '2026-12-01',
      });

      expect(goal).toMatchObject({
        organization_id: ORG_ID,
        coach_account_id: COACH_ID,
        title: 'Corner work under pressure',
        development_focus: FOCUS,
        target_on: '2026-12-01',
        status: 'draft',
      });
      // A calendar day the coach typed, read back as the same calendar day.
      // Routing it through a JS Date would move it in some timezones.
      expect(goal.target_on).toBe('2026-12-01');
    } finally {
      await client.end();
    }
  });

  test('a goal needs no target date, and omitting one is not an error', async () => {
    const client = await migratedDatabase('cd_mod_no_target');
    try {
      const goal = await createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Read the room better',
        developmentFocus: FOCUS,
      });
      expect(goal.target_on).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the author must hold an ACTIVE membership in this organization', async () => {
    const client = await migratedDatabase('cd_mod_membership');
    try {
      await expect(createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: LAPSED_COACH_ID,
        title: 'Anything',
        developmentFocus: FOCUS,
      })).rejects.toBeInstanceOf(ForbiddenError);

      // Nothing was written. The FK would have accepted this row -- the
      // membership exists, it is merely deactivated -- so this is the module's
      // refusal, not the database's, and it has to leave the table empty.
      const rows = await client.query(`select count(*)::int as n from pilot.coach_development_goals`);
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a coach whose home organization is elsewhere may keep a record here, if their membership is active', async () => {
    const client = await migratedDatabase('cd_mod_visiting');
    try {
      const goal = await createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: VISITING_COACH_ID,
        title: 'Learn the Saturday class',
        developmentFocus: FOCUS,
      });
      expect(goal.coach_account_id).toBe(VISITING_COACH_ID);

      // The account's own home column still says otherwise -- which is
      // exactly why the module must not be reading it.
      const home = await client.query(
        `select organization_id from pilot.accounts where account_id = $1`,
        [VISITING_COACH_ID],
      );
      expect(home.rows[0].organization_id).toBe(OTHER_ORG_ID);
    } finally {
      await client.end();
    }
  });

  test('an unsound goal is refused before it reaches the database', async () => {
    const client = await migratedDatabase('cd_mod_shape');
    try {
      const base = { organizationId: ORG_ID, coachAccountId: COACH_ID, developmentFocus: FOCUS };
      await expect(createCoachDevelopmentGoal({ ...base, title: '   ' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentGoal({ ...base, title: 'A', developmentFocus: '  ' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentGoal({ ...base, title: 'A', targetOn: '2026-02-30' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentGoal({
        ...base, title: 'A', status: 'abandoned' as never,
      })).rejects.toBeInstanceOf(ValidationError);

      const rows = await client.query(`select count(*)::int as n from pilot.coach_development_goals`);
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a development activity cannot be filed before it has happened', async () => {
    /* THESE ROWS RENDER UNDER "What you have done". A future date there does
       not read as a plan -- it reads as history that has not occurred, and a
       coach who types next month's clinic while booking it would have filed
       attending it. Found by a review bot on the pull request.

       Planned development is a real thing to want and is deliberately not
       modelled here: a goal carries target_on for that. */
    const client = await migratedDatabase('cd_mod_future');
    try {
      const base = { organizationId: ORG_ID, coachAccountId: COACH_ID, title: 'Clinic' };

      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: '2099-01-01' }))
        .rejects.toBeInstanceOf(ValidationError);

      // The other direction: today itself is not the future, and yesterday is
      // the ordinary case. A guard that refused either would stop a coach
      // filing the session they have just finished.
      const today = gymDayIso();
      expect(today).not.toBeNull();
      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: today as string }))
        .resolves.toMatchObject({ occurred_on: today });
      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: '2026-03-12' }))
        .resolves.toMatchObject({ occurred_on: '2026-03-12' });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the future boundary is the gym\'s midnight, not UTC\'s', async () => {
    /* 01:30 UTC is 21:30 the previous evening at the gym -- the middle of a
       training night. A coach filing that night's work would be filing a date
       that is already "tomorrow" in UTC, and a UTC comparison would refuse
       the record they just earned. */
    const client = await migratedDatabase('cd_mod_future_tz');
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T01:30:00Z'));
    try {
      const base = { organizationId: ORG_ID, coachAccountId: COACH_ID, title: 'Evening clinic' };
      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: '2026-08-28' }))
        .resolves.toMatchObject({ occurred_on: '2026-08-28' });

      /* THE DATE THAT DISCRIMINATES, and without it this test proves nothing:
         2026-08-29 is the gym's TOMORROW and UTC's TODAY. A gym-time guard
         refuses it; a UTC guard compares it against itself, finds it not
         greater, and files a clinic that has not happened. My first version
         of this test used 08-30, which both guards refuse -- so the UTC
         mutation survived it. */
      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: '2026-08-29' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentActivity({ ...base, occurredOn: '2026-08-30' }))
        .rejects.toBeInstanceOf(ValidationError);
    } finally {
      jest.useRealTimers();
      activeClient = null;
      await client.end();
    }
  });

  test('an activity records what happened, and an unsound one is refused', async () => {
    const client = await migratedDatabase('cd_mod_activity');
    try {
      const activity = await createCoachDevelopmentActivity({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Youth coaching clinic',
        provider: '  USA Boxing  ',
        occurredOn: '2026-03-12',
        durationMinutes: 180,
        notes: '  Two sessions.  ',
      });
      expect(activity).toMatchObject({
        title: 'Youth coaching clinic',
        provider: 'USA Boxing',
        occurred_on: '2026-03-12',
        duration_minutes: 180,
        notes: 'Two sessions.',
        goal_id: null,
      });

      const base = { organizationId: ORG_ID, coachAccountId: COACH_ID, occurredOn: '2026-03-12' };
      await expect(createCoachDevelopmentActivity({ ...base, title: ' ' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentActivity({ ...base, title: 'A', occurredOn: 'last tuesday' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentActivity({ ...base, title: 'A', durationMinutes: 0 }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createCoachDevelopmentActivity({ ...base, title: 'A', durationMinutes: 90.5 }))
        .rejects.toBeInstanceOf(ValidationError);
    } finally {
      await client.end();
    }
  });

  test('an unrecorded provider is empty, never the string "null" and never invented', async () => {
    const client = await migratedDatabase('cd_mod_provider');
    try {
      const activity = await createCoachDevelopmentActivity({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Watched the Tuesday class',
        occurredOn: '2026-03-12',
      });
      expect(activity?.provider).toBe('');
      expect(activity?.notes).toBe('');
      expect(activity?.duration_minutes).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the activity list is ordered by when the work happened, not when it was typed', async () => {
    const client = await migratedDatabase('cd_mod_order');
    try {
      // Entered in the wrong order on purpose: a coach catching up on last
      // month's clinic today is recording when it HAPPENED.
      await createCoachDevelopmentActivity({
        organizationId: ORG_ID, coachAccountId: COACH_ID,
        title: 'February clinic', occurredOn: '2026-02-02',
      });
      await createCoachDevelopmentActivity({
        organizationId: ORG_ID, coachAccountId: COACH_ID,
        title: 'April seminar', occurredOn: '2026-04-04',
      });
      await createCoachDevelopmentActivity({
        organizationId: ORG_ID, coachAccountId: COACH_ID,
        title: 'March workshop', occurredOn: '2026-03-03',
      });

      const list = await listCoachDevelopmentActivities(ORG_ID, COACH_ID);
      expect(list.map((row) => row.title)).toEqual([
        'April seminar', 'March workshop', 'February clinic',
      ]);
    } finally {
      await client.end();
    }
  });

  test('nothing sums a duration into an hours total', async () => {
    const client = await migratedDatabase('cd_mod_no_total');
    try {
      for (const [title, minutes] of [['A', 60], ['B', 120], ['C', 30]] as const) {
        await createCoachDevelopmentActivity({
          organizationId: ORG_ID, coachAccountId: COACH_ID,
          title, occurredOn: '2026-03-12', durationMinutes: minutes,
        });
      }

      const list = await listCoachDevelopmentActivities(ORG_ID, COACH_ID);
      // Each row carries its own minutes and nothing else does. A total would
      // be a compliance figure assembled from unverified self-report, sitting
      // next to a certification band -- which is the reading this refuses.
      expect(list.map((row) => row.duration_minutes).sort()).toEqual([120, 30, 60]);
      for (const row of list) {
        expect(Object.keys(row)).not.toContain('total_minutes');
        expect(Object.keys(row)).not.toContain('hours');
      }
    } finally {
      await client.end();
    }
  });
});

describe('one coach cannot reach another coach through any read this slice adds', () => {
  test('a colleague\'s goal in the same gym is a hidden not-found', async () => {
    const client = await migratedDatabase('cd_colleague');
    try {
      await insertGoal(client, 'goal-mine', { coach_account_id: COACH_ID });
      await insertGoal(client, 'goal-theirs', { coach_account_id: COLLEAGUE_ID });

      // Same organization, real goal id, different coach. Indistinguishable
      // from a goal id that never existed -- which is the point: a
      // distinguishable not-found lets any coach enumerate their colleagues'
      // goals.
      expect(await getCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-theirs')).toBeNull();
      expect(await getCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-never-existed')).toBeNull();
      expect(await getCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-mine')).not.toBeNull();

      const mine = await listCoachDevelopmentGoals(ORG_ID, COACH_ID);
      expect(mine.map((row) => row.goal_id)).toEqual(['goal-mine']);
    } finally {
      await client.end();
    }
  });

  test('a coach cannot hang their activity on a colleague\'s goal', async () => {
    const client = await migratedDatabase('cd_colleague_goal');
    try {
      await insertGoal(client, 'goal-theirs', { coach_account_id: COLLEAGUE_ID });

      // The composite FK would accept this: the goal DOES exist in this
      // organization. Only the module's own ownership check refuses it, and
      // it refuses it the same way it refuses a goal id that never existed.
      const attached = await createCoachDevelopmentActivity({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Clinic',
        occurredOn: '2026-03-12',
        goalId: 'goal-theirs',
      });
      expect(attached).toBeNull();

      const invented = await createCoachDevelopmentActivity({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Clinic',
        occurredOn: '2026-03-12',
        goalId: 'goal-never-existed',
      });
      expect(invented).toBeNull();

      // And nothing was written on either attempt.
      const rows = await client.query(
        `select count(*)::int as n from pilot.coach_development_activities`,
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('every read path is organization-scoped as well as coach-scoped', async () => {
    const client = await migratedDatabase('cd_isolation');
    try {
      // The SAME account id, working in both gyms. Organization scope is the
      // only thing separating these two records, so an unscoped read returns
      // both and this test says so.
      await insertGoal(client, 'goal-here', {
        organization_id: ORG_ID, coach_account_id: VISITING_COACH_ID,
      });
      await insertGoal(client, 'goal-there', {
        organization_id: OTHER_ORG_ID, coach_account_id: VISITING_COACH_ID,
      });

      const here = await listCoachDevelopmentGoals(ORG_ID, VISITING_COACH_ID);
      expect(here.map((row) => row.goal_id)).toEqual(['goal-here']);

      expect(await getCoachDevelopmentGoal(ORG_ID, VISITING_COACH_ID, 'goal-there')).toBeNull();

      const there = await listCoachDevelopmentGoals(OTHER_ORG_ID, VISITING_COACH_ID);
      expect(there.map((row) => row.goal_id)).toEqual(['goal-there']);
    } finally {
      await client.end();
    }
  });

  test('a colleague\'s goal cannot be corrected, and the attempt writes nothing', async () => {
    const client = await migratedDatabase('cd_colleague_update');
    try {
      await insertGoal(client, 'goal-theirs', {
        coach_account_id: COLLEAGUE_ID, title: 'Their title',
      });

      expect(await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-theirs', {
        title: 'Mine now',
      })).toBeNull();

      const stored = await client.query(
        `select title, coach_account_id from pilot.coach_development_goals where goal_id = 'goal-theirs'`,
      );
      expect(stored.rows[0]).toEqual({ title: 'Their title', coach_account_id: COLLEAGUE_ID });
    } finally {
      await client.end();
    }
  });
});

// READINESS_QUERY -- the assertion that gates the dispatch, and the code
// whose first real execution would otherwise be against a live environment at
// the most expensive possible moment. #488 is what that costs: an assertion
// that could not pass on ANY database, found only by a staging dispatch it
// then blocked. The inverse -- an assertion that can never FAIL -- is quieter
// and worse, so the refusal case comes first.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots.
describe('coach development runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('cd_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /COACH_DEVELOPMENT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('cd_rdy_ok');
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

/*
 * CORRECTING A GOAL.
 *
 * updateCoachDevelopmentGoal is the one write here that reads the row before
 * writing it, and three properties need real rows to prove:
 *
 *   - the merged row is validated, so a rule cannot be escaped by omitting
 *     the field it applies to;
 *   - a patch omitting a field leaves it alone rather than blanking it --
 *     the failure a whole-row write has by construction;
 *   - the coach is part of the key, so a colleague's goal is not found and
 *     cannot be probed for (asserted above, with the isolation cases).
 */
describe('the module correcting a goal (real database)', () => {
  test('a partial patch changes only what it names', async () => {
    const client = await migratedDatabase('cd_upd_partial');
    try {
      await insertGoal(client, 'goal-1', { title: 'Original', status: 'draft' });

      const updated = await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {
        status: 'active',
      });

      expect(updated).toMatchObject({
        title: 'Original',
        development_focus: FOCUS,
        target_on: '2026-12-01',
        status: 'active',
      });
    } finally {
      await client.end();
    }
  });

  test('a focus cannot be blanked, by patch or by whitespace', async () => {
    const client = await migratedDatabase('cd_upd_blank');
    try {
      await insertGoal(client, 'goal-1');

      await expect(updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {
        developmentFocus: '   ',
      })).rejects.toBeInstanceOf(ValidationError);
      await expect(updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {
        title: '\t\n',
      })).rejects.toBeInstanceOf(ValidationError);

      const stored = await client.query(
        `select title, development_focus from pilot.coach_development_goals where goal_id = 'goal-1'`,
      );
      expect(stored.rows[0]).toEqual({
        title: 'Corner work under pressure',
        development_focus: FOCUS,
      });
    } finally {
      await client.end();
    }
  });

  test('a target date can be cleared with an explicit null, and left alone by omission', async () => {
    const client = await migratedDatabase('cd_upd_target');
    try {
      await insertGoal(client, 'goal-1');

      // Omission leaves it.
      const untouched = await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {
        title: 'Renamed',
      });
      expect(untouched?.target_on).toBe('2026-12-01');

      // An explicit null clears it. The two have to be distinguishable, or a
      // coach could never remove a deadline they no longer want.
      const cleared = await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {
        targetOn: null,
      });
      expect(cleared?.target_on).toBeNull();
      expect(cleared?.title).toBe('Renamed');
    } finally {
      await client.end();
    }
  });

  test('an empty patch is a no-op that still returns the row', async () => {
    const client = await migratedDatabase('cd_upd_empty');
    try {
      await insertGoal(client, 'goal-1');
      const before = await getCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1');

      const after = await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-1', {});
      expect(after).toMatchObject({
        title: before!.title,
        development_focus: before!.development_focus,
        status: before!.status,
        target_on: before!.target_on,
      });
    } finally {
      await client.end();
    }
  });

  test('a goal id that does not exist is not found either -- the two are indistinguishable', async () => {
    const client = await migratedDatabase('cd_upd_missing');
    try {
      expect(await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-nope', { title: 'x' }))
        .toBeNull();
    } finally {
      await client.end();
    }
  });

  test('nothing advances a status on its own, however long ago the target passed', async () => {
    const client = await migratedDatabase('cd_upd_no_auto');
    try {
      await insertGoal(client, 'goal-old', { target_on: '2020-01-01', status: 'active' });

      // Read it several ways. A goal whose target date is years past is still
      // 'active' until a human says otherwise: the platform does not decide
      // that somebody finished, or failed to.
      expect((await getCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-old'))?.status).toBe('active');
      expect((await listCoachDevelopmentGoals(ORG_ID, COACH_ID))[0].status).toBe('active');
      expect((await updateCoachDevelopmentGoal(ORG_ID, COACH_ID, 'goal-old', {}))?.status)
        .toBe('active');
    } finally {
      await client.end();
    }
  });
});

/*
 * THE ROLE ON THE MEMBERSHIP ROW, WHICH IS THE ONLY ONE THAT SAYS WHAT
 * SOMEBODY IS IN THIS GYM.
 *
 * This module shipped with a write floor of "an ACTIVE membership", no role
 * predicate -- the exact floor athleteDevelopmentBlocks.ts records having
 * raised, in a comment this file's own header pointed at. The route was no
 * backstop: a principal's role comes from pilot.accounts (the account's HOME
 * role) while its organization comes from the session token, so the two are
 * read from different rows and can disagree.
 *
 * Found by a code review after the PR was green. No test here had covered
 * it, which is why it survived to be found.
 */
describe('a membership admits a write only in a role that may write', () => {
  test('an account whose membership HERE is parent cannot record development here', async () => {
    const client = await migratedDatabase('cd_membership_role');
    try {
      /* pilot.accounts.role for this account is 'coach', so requireRole at
         the route would admit it. pilot.organization_memberships says
         'parent' for THIS organization, and that is the row that decides. */
      await expect(createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: PARENT_HERE_ID,
        title: 'Corner work',
        developmentFocus: 'Something a parent should not be filing.',
      })).rejects.toBeInstanceOf(ForbiddenError);

      await expect(createCoachDevelopmentActivity({
        organizationId: ORG_ID,
        coachAccountId: PARENT_HERE_ID,
        title: 'Youth coaching clinic',
        occurredOn: '2026-03-12',
      })).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a coaching membership in the same gym still writes', async () => {
    /* The other direction, and it is not decoration: a role predicate that
       refused everyone would satisfy the test above while breaking the
       feature. Staff and volunteers hold credentials and do courses too, so
       the set is the credential-holder set, not the narrower one that
       authors plans for children. */
    const client = await migratedDatabase('cd_membership_role_ok');
    try {
      await expect(createCoachDevelopmentGoal({
        organizationId: ORG_ID,
        coachAccountId: COACH_ID,
        title: 'Corner work under pressure',
        developmentFocus: 'Keep the anxious kids in the room.',
      })).resolves.toMatchObject({ title: 'Corner work under pressure' });
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
