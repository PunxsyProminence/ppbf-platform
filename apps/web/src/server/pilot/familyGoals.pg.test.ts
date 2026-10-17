// Real PostgreSQL contract test for pilot_slice_postgres_family_goals_migration.sql (PH-05,
// issue #1593: what a family and the gym agree the family will do to support one child).
//
// What needs a real database to prove: that a goal binds to its own gym's athlete; that done is a
// recorded time and not a number; that its child, gym and writer never change by hand; that it is
// never deleted by hand, stays when its writer's account goes, and goes with its athlete; that
// re-applying the file is a no-op; that the file holds nothing destructive; and that the runner's
// readiness assertion refuses a result it did not produce. Spins up the disposable local embedded
// Postgres the other migration suites use. It never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-goals-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-family-goals-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_family_goals_migration.sql';

const ORG = 'org-goals';
const OTHER_ORG = 'org-goals-other';
const COACH = 'acct-goals-coach';
const GUARDIAN = 'acct-goals-guardian';
const SECOND_GUARDIAN = 'acct-goals-guardian-b';
const ATHLETE = 'ATH-GOALS-1';
const OTHER_ATHLETE = 'ATH-GOALS-2';
const OTHER_ONLY = 'ATH-GOALS-X';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $4, 'microsoft'), ($2, 'parent', $4, 'microsoft'), ($3, 'parent', $4, 'microsoft')`,
    [COACH, GUARDIAN, SECOND_GUARDIAN, ORG],
  );
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts); the
  // account's home role alone is not a seat.
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $4, 'coach', true), ($2, $4, 'parent', true), ($3, $4, 'parent', true)`,
    [COACH, GUARDIAN, SECOND_GUARDIAN, ORG],
  );
  for (const [org, athleteId] of [[ORG, ATHLETE], [ORG, OTHER_ATHLETE], [OTHER_ORG, OTHER_ONLY]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Goal Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
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
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

function goal(
  client: Client,
  values: {
    org?: string;
    athleteId?: string;
    title?: string;
    support?: string;
    state?: string;
    completedAt?: string | null;
    creator?: string | null;
    role?: string;
  } = {},
) {
  return client.query(
    `insert into pilot.family_goals
       (organization_id, athlete_id, title, support_action, target_date, state, completed_at, created_by_account_id, created_by_role)
     values ($1, $2, $3, $4, '2026-11-30', $5, $6::timestamptz, $7, $8)
     returning goal_id::text as goal_id`,
    [
      values.org ?? ORG,
      values.athleteId ?? ATHLETE,
      values.title ?? 'Get to the gym twice a week',
      values.support ?? 'Arrange transportation every Tuesday and Thursday.',
      values.state ?? 'active',
      values.completedAt === undefined ? null : values.completedAt,
      values.creator === undefined ? GUARDIAN : values.creator,
      values.role ?? 'parent',
    ],
  );
}

describe('family goals migration (PH-05)', () => {
  test('a family goal is stored and read back, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('fgoal_store');
    try {
      await goal(client);
      await goal(client, { creator: COACH, role: 'coach', title: 'Shadowbox at home', support: 'Clear space in the garage.' });
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query(
        `select athlete_id, title, support_action, to_char(target_date, 'YYYY-MM-DD') as target_date, state,
                completed_at, retired_at, created_by_account_id, created_by_role, updated_by_account_id
           from pilot.family_goals order by created_by_role desc`,
      );
      expect(rows.rows).toEqual([
        {
          athlete_id: ATHLETE, title: 'Get to the gym twice a week', support_action: 'Arrange transportation every Tuesday and Thursday.',
          target_date: '2026-11-30', state: 'active', completed_at: null, retired_at: null,
          created_by_account_id: GUARDIAN, created_by_role: 'parent', updated_by_account_id: null,
        },
        {
          athlete_id: ATHLETE, title: 'Shadowbox at home', support_action: 'Clear space in the garage.',
          target_date: '2026-11-30', state: 'active', completed_at: null, retired_at: null,
          created_by_account_id: COACH, created_by_role: 'coach', updated_by_account_id: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('done is a recorded event: completed exactly when completed_at is set', async () => {
    const client = await freshDatabase('fgoal_done');
    try {
      await expect(goal(client, { state: 'completed' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_completed_check',
      });
      await expect(goal(client, { completedAt: '2026-10-20T15:00:00Z' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_completed_check',
      });
      await expect(goal(client, { state: 'half-done' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_state_check',
      });

      const { rows: [{ goal_id: goalId }] } = await goal(client);
      await client.query(
        `update pilot.family_goals set state = 'completed', completed_at = '2026-10-20T15:00:00Z',
                updated_by_account_id = $2, updated_by_role = 'parent'
          where goal_id = $1::uuid`,
        [goalId, GUARDIAN],
      );
      // The time is the database's: what the writer sent is replaced by now().
      const done = await client.query(
        `select state, completed_at > now() - interval '5 minutes' as stamped_now, updated_at > created_at as touched
           from pilot.family_goals`,
      );
      expect(done.rows[0]).toEqual({ state: 'completed', stamped_now: true, touched: true });
    } finally {
      await client.end();
    }
  });

  test('a blank or overlong title or support action, an unknown writer role, and no author at all, are refused', async () => {
    const client = await freshDatabase('fgoal_checks');
    try {
      await expect(goal(client, { creator: null })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_author_named' });
      await expect(goal(client, { title: '   ' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_title_check' });
      await expect(goal(client, { title: 'x'.repeat(201) })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_title_check' });
      await expect(goal(client, { support: '' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_support_action_check' });
      await expect(goal(client, { support: 'y'.repeat(501) })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_support_action_check' });
      for (const role of ['athlete', 'board', 'platform_owner']) {
        await expect(goal(client, { role })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_created_by_role_check' });
      }
      const { rows: [{ goal_id: goalId }] } = await goal(client);
      await expect(
        client.query(
          `update pilot.family_goals set updated_by_account_id = $2, updated_by_role = 'athlete' where goal_id = $1::uuid`,
          [goalId, GUARDIAN],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_updated_by_role_check' });
      const left = await client.query('select count(*)::int as n from pilot.family_goals');
      expect(left.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("a goal names only its own gym's athlete", async () => {
    const client = await freshDatabase('fgoal_gym');
    try {
      await expect(goal(client, { athleteId: 'ATH-NOWHERE' })).rejects.toMatchObject({
        code: '23503', constraint: 'pilot_family_goals_athlete_fk',
      });
      // OTHER_ONLY exists only in the other gym.
      await expect(goal(client, { athleteId: OTHER_ONLY })).rejects.toMatchObject({
        code: '23503', constraint: 'pilot_family_goals_athlete_fk',
      });
      // The other gym's goal is written by someone of that gym: here this gym's
      // coach, who also coaches there by membership.
      await expect(goal(client, { org: OTHER_ORG, athleteId: OTHER_ONLY, creator: COACH, role: 'coach' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_writer_of_this_gym',
      });
      await client.query(`insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach')`, [COACH, OTHER_ORG]);
      await goal(client, { org: OTHER_ORG, athleteId: OTHER_ONLY, creator: COACH, role: 'coach' });
    } finally {
      await client.end();
    }
  });

  test('an author or editor holds the role written in this gym', async () => {
    const client = await freshDatabase('fgoal_gym_writer');
    try {
      // The right gym, the wrong role.
      await expect(goal(client, { creator: GUARDIAN, role: 'coach' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_writer_of_this_gym',
      });
      const { rows: [{ goal_id: goalId }] } = await goal(client);
      await expect(client.query(
        `update pilot.family_goals set title = 'x', updated_by_account_id = $2, updated_by_role = 'coach' where goal_id = $1::uuid`,
        [goalId, GUARDIAN],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_writer_of_this_gym' });
      await client.query(
        `update pilot.family_goals set title = 'x', updated_by_account_id = $2, updated_by_role = 'coach' where goal_id = $1::uuid`,
        [goalId, COACH],
      );
    } finally {
      await client.end();
    }
  });

  test('a goal never moves to another child or gym, and its writer is kept', async () => {
    const client = await freshDatabase('fgoal_fixed');
    try {
      await goal(client);
      for (const change of [`athlete_id = '${OTHER_ATHLETE}'`, `organization_id = '${OTHER_ORG}'`, 'goal_id = gen_random_uuid()']) {
        await expect(client.query(`update pilot.family_goals set ${change}`)).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_family_goals_fixed_child',
        });
      }
      for (const change of [`created_by_account_id = '${SECOND_GUARDIAN}'`, 'created_by_account_id = null', "created_by_role = 'coach'", "created_at = now() - interval '1 day'"]) {
        await expect(client.query(`update pilot.family_goals set ${change}`)).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_family_goals_fixed_writer',
        });
      }
      // What the family may change does change, naming who changed it.
      await client.query(
        `update pilot.family_goals set title = 'Get to the gym three times a week', target_date = null, retired_at = now(),
                updated_by_account_id = $1, updated_by_role = 'parent'`,
        [GUARDIAN],
      );
      const row = await client.query('select title, target_date, retired_at is not null as retired from pilot.family_goals');
      expect(row.rows).toEqual([{ title: 'Get to the gym three times a week', target_date: null, retired: true }]);
    } finally {
      await client.end();
    }
  });

  test('a change names its editor; a retired goal does not change; a done time is not rewritten, and unticking records a new one', async () => {
    const client = await freshDatabase('fgoal_history');
    try {
      const { rows: [{ goal_id: goalId }] } = await goal(client);
      const edit = (set: string) => client.query(
        `update pilot.family_goals set ${set}, updated_by_account_id = $2, updated_by_role = 'parent' where goal_id = $1::uuid`,
        [goalId, GUARDIAN],
      );

      // No editor named: refused, by hand, whatever the change.
      await expect(client.query(`update pilot.family_goals set title = 'New title'`)).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_editor_named',
      });

      await edit(`state = 'completed', completed_at = '2026-10-20T15:00:00Z'`);
      const first = await client.query('select completed_at from pilot.family_goals');
      expect(first.rows[0].completed_at.toISOString()).not.toBe('2026-10-20T15:00:00.000Z');
      await expect(edit(`completed_at = '2026-09-01T15:00:00Z'`)).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_completed_kept',
      });
      // Unticked, then ticked again: the new time is the one recorded, and it is now.
      await edit(`state = 'active', completed_at = null`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await edit(`state = 'completed', completed_at = '2026-10-22T15:00:00Z'`);
      const done = await client.query('select completed_at from pilot.family_goals');
      expect(done.rows[0].completed_at.toISOString()).not.toBe('2026-10-22T15:00:00.000Z');
      expect(done.rows[0].completed_at.getTime()).toBeGreaterThan(first.rows[0].completed_at.getTime());

      await edit(`retired_at = '2026-10-23T15:00:00Z'`);
      const retired = await client.query(`select retired_at > now() - interval '5 minutes' as stamped_now from pilot.family_goals`);
      expect(retired.rows[0].stamped_now).toBe(true);
      for (const set of ['retired_at = null', `retired_at = '2026-10-24T15:00:00Z'`, `title = 'Back again'`, `state = 'active', completed_at = null`]) {
        await expect(edit(set)).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_retired_kept' });
      }
    } finally {
      await client.end();
    }
  });

  test('a writer needs an active seat in this gym on a live account; the home role alone is not one', async () => {
    const client = await freshDatabase('fgoal_seat');
    try {
      const FORMER = 'acct-goals-former';
      const HOME_ONLY = 'acct-goals-home-only';
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $3, 'microsoft'), ($2, 'coach', $3, 'microsoft')`,
        [FORMER, HOME_ONLY, ORG],
      );
      await client.query(`insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach')`, [FORMER, ORG]);
      const refused = { code: '23514', constraint: 'pilot_family_goals_writer_of_this_gym' };

      // A home coach with no seat in the gym.
      await expect(goal(client, { creator: HOME_ONLY, role: 'coach' })).rejects.toMatchObject(refused);
      // A seated coach writes; then the seat is switched off, the account switched off, or deleted.
      await goal(client, { creator: FORMER, role: 'coach' });
      await client.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [FORMER]);
      await expect(goal(client, { creator: FORMER, role: 'coach' })).rejects.toMatchObject(refused);
      await client.query('update pilot.organization_memberships set active_flag = true where account_id = $1', [FORMER]);
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [FORMER]);
      await expect(goal(client, { creator: FORMER, role: 'coach' })).rejects.toMatchObject(refused);
      await client.query('update pilot.accounts set active_flag = true, deleted_at = now() where account_id = $1', [FORMER]);
      await expect(goal(client, { creator: FORMER, role: 'coach' })).rejects.toMatchObject(refused);

      // The same for an editor.
      const { rows: [{ goal_id: goalId }] } = await goal(client);
      await expect(client.query(
        `update pilot.family_goals set title = 'x', updated_by_account_id = $2, updated_by_role = 'coach' where goal_id = $1::uuid`,
        [goalId, FORMER],
      )).rejects.toMatchObject(refused);
    } finally {
      await client.end();
    }
  });

  test('a goal is born unedited, with the times the database gives it', async () => {
    const client = await freshDatabase('fgoal_born');
    try {
      await expect(client.query(
        `insert into pilot.family_goals (organization_id, athlete_id, title, support_action, created_by_account_id, created_by_role,
                                         updated_by_account_id, updated_by_role)
         values ($1, $2, 'T', 'S', $3, 'parent', $3, 'parent')`,
        [ORG, ATHLETE, GUARDIAN],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_born_unedited' });

      await client.query(
        `insert into pilot.family_goals (organization_id, athlete_id, title, support_action, created_by_account_id, created_by_role,
                                         state, completed_at, retired_at, created_at, updated_at)
         values ($1, $2, 'T', 'S', $3, 'parent', 'completed', '2020-01-01', '2020-01-02', '2020-01-01', '2020-01-01')`,
        [ORG, ATHLETE, GUARDIAN],
      );
      const row = await client.query(
        `select created_at > now() - interval '5 minutes' as created_now, updated_at > now() - interval '5 minutes' as updated_now,
                completed_at > now() - interval '5 minutes' as completed_now, retired_at > now() - interval '5 minutes' as retired_now
           from pilot.family_goals`,
      );
      expect(row.rows[0]).toEqual({ created_now: true, updated_now: true, completed_now: true, retired_now: true });
    } finally {
      await client.end();
    }
  });

  test("a guardian changes only a goal they wrote: not another guardian's, not the coach's", async () => {
    const client = await freshDatabase('fgoal_own');
    try {
      const { rows: [{ goal_id: mine }] } = await goal(client);
      const { rows: [{ goal_id: coachs }] } = await goal(client, { creator: COACH, role: 'coach' });
      const tick = (goalId: string, editor: string) => client.query(
        `update pilot.family_goals set state = 'completed', completed_at = now(), updated_by_account_id = $2, updated_by_role = 'parent'
          where goal_id = $1::uuid`,
        [goalId, editor],
      );
      const refused = { code: '23514', constraint: 'pilot_family_goals_guardian_edits_own' };
      await expect(tick(mine, SECOND_GUARDIAN)).rejects.toMatchObject(refused);
      await expect(tick(coachs, GUARDIAN)).rejects.toMatchObject(refused);
      await tick(mine, GUARDIAN);
      // Staff may still change the coach's goal.
      await client.query(
        `update pilot.family_goals set state = 'completed', completed_at = now(), updated_by_account_id = $2, updated_by_role = 'coach'
          where goal_id = $1::uuid`,
        [coachs, COACH],
      );
      const done = await client.query(`select count(*)::int as n from pilot.family_goals where state = 'completed'`);
      expect(done.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('an update from inside another trigger may only detach a writer', async () => {
    const client = await freshDatabase('fgoal_depth');
    try {
      await goal(client);
      // A stand-in for any future trigger that writes this table: it fires on an organization
      // update and rewrites a goal's title from inside itself.
      await client.query(`
        create function pilot.test_rewrite_family_goal() returns trigger language plpgsql as $f$
        begin
          update pilot.family_goals set title = 'Rewritten' where organization_id = new.organization_id;
          return new;
        end;
        $f$`);
      await client.query(`create trigger trg_test_rewrite after update on pilot.organizations
                          for each row execute function pilot.test_rewrite_family_goal()`);
      await expect(client.query(`update pilot.organizations set organization_name = 'Renamed' where organization_id = $1`, [ORG]))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_family_goals_cascade_detaches_only' });
      const row = await client.query('select title from pilot.family_goals');
      expect(row.rows[0].title).toBe('Get to the gym twice a week');
    } finally {
      await client.end();
    }
  });

  test('a goal is not deleted by hand; it stays when its writer account goes, and goes with its athlete', async () => {
    const client = await freshDatabase('fgoal_cascade');
    try {
      const { rows: [{ goal_id: goalId }] } = await goal(client, { creator: SECOND_GUARDIAN });
      await client.query(
        `update pilot.family_goals set updated_by_account_id = $2, updated_by_role = 'parent' where goal_id = $1::uuid`,
        [goalId, SECOND_GUARDIAN],
      );
      await expect(client.query('delete from pilot.family_goals')).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_family_goals_no_delete',
      });

      await client.query('delete from pilot.accounts where account_id = $1', [SECOND_GUARDIAN]);
      const kept = await client.query('select created_by_account_id, created_by_role, updated_by_account_id, title from pilot.family_goals');
      expect(kept.rows).toEqual([{ created_by_account_id: null, created_by_role: 'parent', updated_by_account_id: null, title: 'Get to the gym twice a week' }]);

      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const left = await client.query('select count(*)::int as n from pilot.family_goals');
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\balter\s+table\b/);
  });

  test('the runner refuses a guard that is there by name but disabled, or replica-only', async () => {
    const client = await freshDatabase('fgoal_guard_disabled');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.family_goals disable trigger trg_family_goals_guard'),
      ).rejects.toThrow('FAMILY_GOALS_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.family_goals enable replica trigger trg_family_goals_guard'),
      ).rejects.toThrow('FAMILY_GOALS_NOT_READY: guard_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing table whose writer keys cascade instead of setting null', async () => {
    const client = await freshDatabase('fgoal_writer_cascade');
    try {
      await client.query('drop table pilot.family_goals');
      await client.query(`
        create table pilot.family_goals (
          organization_id text not null references pilot.organizations(organization_id) on delete cascade,
          goal_id uuid not null default gen_random_uuid(),
          athlete_id text not null,
          title text not null,
          support_action text not null,
          target_date date,
          state text not null default 'active',
          completed_at timestamptz,
          retired_at timestamptz,
          created_by_account_id text references pilot.accounts(account_id) on delete cascade,
          created_by_role text not null,
          updated_by_account_id text references pilot.accounts(account_id) on delete cascade,
          updated_by_role text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          constraint pilot_family_goals_pkey primary key (organization_id, goal_id),
          constraint pilot_family_goals_athlete_fk foreign key (organization_id, athlete_id)
            references pilot.athletes(organization_id, athlete_id) on delete cascade
        )`);

      await expect(applyRunner(client, migrationSql)).rejects.toThrow(/FAMILY_GOALS_NOT_READY: .*writer_fks_set_null/);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses an index of that name over other columns', async () => {
    const client = await freshDatabase('fgoal_index_shape');
    try {
      // The file's if-not-exists keeps a same-named index, so only readiness can say it is wrong.
      await client.query('drop index pilot.idx_family_goals_athlete');
      await client.query('create index idx_family_goals_athlete on pilot.family_goals(athlete_id, organization_id)');

      await expect(applyRunner(client, migrationSql)).rejects.toThrow('FAMILY_GOALS_NOT_READY: athlete_index_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named check that does not say what the real one says', async () => {
    const client = await freshDatabase('fgoal_weak_check');
    try {
      await client.query('alter table pilot.family_goals drop constraint pilot_family_goals_title_check');
      await client.query('alter table pilot.family_goals add constraint pilot_family_goals_title_check check (true)');
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('FAMILY_GOALS_NOT_READY: checks_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named writer-role check that admits more roles than Q-E', async () => {
    const client = await freshDatabase('fgoal_wide_roles');
    try {
      await client.query('alter table pilot.family_goals drop constraint pilot_family_goals_created_by_role_check');
      await client.query(`alter table pilot.family_goals add constraint pilot_family_goals_created_by_role_check
                            check (created_by_role in ('parent', 'coach', 'organization_admin', 'admin', 'athlete'))`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('FAMILY_GOALS_NOT_READY: checks_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    const client = await freshDatabase('fgoal_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('FAMILY_GOALS_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
