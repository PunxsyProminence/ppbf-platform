// Real PostgreSQL-backed contract test for the goal category/progress migration.
//
// The negative control comes first and matters most: it asserts that WITHOUT
// this migration, `select category, progress_percent from pilot.goals` is an
// error. That is the state staging and production are in as this lands, and it
// is why the athlete workspace was reading undefined for both fields and
// substituting 'Boxing' and 0 for them on every goal in the gym.
//
// The rest of the file proves the properties the migration was written for and
// that no amount of reading the SQL can establish:
//
//   * pre-existing goals keep NULL rather than being backfilled with a category
//     nobody chose and a progress reading nobody gave
//   * NULL and 0 remain distinguishable in the column, because they mean
//     different things to the athlete looking at the bar
//   * the vocabulary is enforced by the database, not only by the validator
//   * re-running is a no-op, since `all` re-applies every increment
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

import { GOAL_CATEGORIES } from './contracts';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-goal-category-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_goal_category_progress_migration.sql';

const ORG_ID = 'org-goals';
const COACH_ID = 'acct-goals-coach';
const ATHLETE_ID = 'ATH-GOALS-1';

// The two values deliberately held out of the vocabulary. Named here rather
// than inlined so the reason travels with the assertion: body-composition
// intent must not become a queryable row about a minor before the Privacy-Tier
// System exists to govern who can read it. See the migration header.
const WITHHELD_CATEGORIES = ['Weight Loss', 'Weight Gain'];

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

/** Fresh database with the base schema and the org/coach/athlete rows the FKs need. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Goals Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

/** A goal of the shape the app wrote before either column existed. */
async function insertLegacyGoal(client: Client, goalId: string): Promise<void> {
  await client.query(
    `insert into pilot.goals
       (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
     values ($1, $2, $3, 'Land 100 clean jabs', '2026-09-01', '100 reps logged', 'active', now(), now())`,
    [ORG_ID, goalId, ATHLETE_ID],
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

describe('goal category/progress migration against real Postgres', () => {
  test('the gap is real: without the migration neither column exists', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_absent');
    try {
      await expect(
        client.query('select category, progress_percent from pilot.goals'),
      ).rejects.toThrow(/column .* does not exist/i);
    } finally {
      await client.end();
    }
  });

  test('the migration adds both columns, nullable', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_fresh');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, data_type, is_nullable
         from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'goals'
           and column_name in ('category', 'progress_percent')
         order by column_name`,
      );

      expect(columns.rows).toEqual([
        { column_name: 'category', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'progress_percent', data_type: 'integer', is_nullable: 'YES' },
      ]);
    } finally {
      await client.end();
    }
  });

  // The property the whole design rests on. A `not null default` variant of
  // this migration passes a column-existence check and silently states a
  // category and a progress reading for every athlete who predates it.
  test('a goal written before the migration keeps NULL for both, not a backfilled value', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_legacy');
    try {
      await insertLegacyGoal(client, 'goal-legacy');
      await client.query(migrationSql);

      const row = await client.query(
        'select category, progress_percent from pilot.goals where goal_id = $1',
        ['goal-legacy'],
      );
      expect(row.rows[0]).toEqual({ category: null, progress_percent: null });
    } finally {
      await client.end();
    }
  });

  test('NULL and 0 stay distinguishable in the column', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_zero');
    try {
      await client.query(migrationSql);
      await insertLegacyGoal(client, 'goal-unreported');
      await insertLegacyGoal(client, 'goal-zero');
      await client.query(
        'update pilot.goals set progress_percent = 0 where goal_id = $1',
        ['goal-zero'],
      );

      const rows = await client.query(
        `select goal_id, progress_percent from pilot.goals
         where goal_id in ('goal-unreported', 'goal-zero')
         order by goal_id`,
      );
      expect(rows.rows).toEqual([
        { goal_id: 'goal-unreported', progress_percent: null },
        { goal_id: 'goal-zero', progress_percent: 0 },
      ]);
    } finally {
      await client.end();
    }
  });

  test('every category the app offers is storable', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_vocabulary');
    try {
      await client.query(migrationSql);

      for (const [index, category] of GOAL_CATEGORIES.entries()) {
        const goalId = `goal-cat-${index}`;
        await insertLegacyGoal(client, goalId);
        await client.query(
          'update pilot.goals set category = $2 where goal_id = $1',
          [goalId, category],
        );
        const row = await client.query(
          'select category from pilot.goals where goal_id = $1',
          [goalId],
        );
        expect(row.rows[0].category).toBe(category);
      }
    } finally {
      await client.end();
    }
  });

  test('the database refuses a category outside the vocabulary, including the two withheld ones', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_refuses');
    try {
      await client.query(migrationSql);
      await insertLegacyGoal(client, 'goal-refuse');

      for (const category of [...WITHHELD_CATEGORIES, 'Underwater Basket Weaving']) {
        await expect(
          client.query('update pilot.goals set category = $2 where goal_id = $1', ['goal-refuse', category]),
        ).rejects.toThrow(/pilot_goals_category_check/);
      }
    } finally {
      await client.end();
    }
  });

  test('the database refuses a percentage outside 0-100 at both ends', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_bounds');
    try {
      await client.query(migrationSql);
      await insertLegacyGoal(client, 'goal-bounds');

      for (const percent of [-1, 101]) {
        await expect(
          client.query('update pilot.goals set progress_percent = $2 where goal_id = $1', ['goal-bounds', percent]),
        ).rejects.toThrow(/pilot_goals_progress_percent_check/);
      }

      // Both ends of the admitted range still store.
      for (const percent of [0, 100]) {
        await client.query('update pilot.goals set progress_percent = $2 where goal_id = $1', ['goal-bounds', percent]);
      }
    } finally {
      await client.end();
    }
  });

  // `all` re-applies every increment on every dispatch, so this is the property
  // that makes dispatching it safe rather than merely convenient.
  test('re-running is a no-op and does not disturb stored values', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_rerun');
    try {
      await client.query(migrationSql);
      await insertLegacyGoal(client, 'goal-rerun');
      await client.query(
        `update pilot.goals set category = 'Recovery', progress_percent = 40 where goal_id = $1`,
        ['goal-rerun'],
      );

      await client.query(migrationSql);

      const row = await client.query(
        'select category, progress_percent from pilot.goals where goal_id = $1',
        ['goal-rerun'],
      );
      expect(row.rows[0]).toEqual({ category: 'Recovery', progress_percent: 40 });
    } finally {
      await client.end();
    }
  });

  // upsertGoal writes the columns positionally. If the migration ever produced
  // a different shape than entities.ts expects, this is where it surfaces.
  test('the real write path stores what it was given', async () => {
    const client = await freshDatabase('ppbf_test_goalcat_writepath');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.goals
           (organization_id, goal_id, athlete_id, title, target_date, metric, status, category, progress_percent, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          ORG_ID,
          'goal-write',
          ATHLETE_ID,
          'Read one chapter a night',
          '2026-10-01',
          'chapters logged',
          'active',
          'Academics',
          25,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      const row = await client.query(
        'select category, progress_percent from pilot.goals where goal_id = $1',
        ['goal-write'],
      );
      expect(row.rows[0]).toEqual({ category: 'Academics', progress_percent: 25 });
    } finally {
      await client.end();
    }
  });
});
