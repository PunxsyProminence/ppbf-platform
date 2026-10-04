// Real PostgreSQL-backed contract test for the athlete-pathway migration
// (map item 17, B1a): three append-only tables -- a coach's stage placement,
// a coach's goal confirmation, and the coach-set allowance that lets a minor
// be placed at all.
//
// What needs proving that reading SQL cannot prove: the migration creates the
// tables from nothing through the real runner and re-applies as a no-op; the
// runner's readiness check refuses an environment missing a piece; "one live
// row" holds for each table while history accumulates; a blank allowance
// reason and an unknown stage/goal pair are refused; every row goes with its
// athlete; and the database's stage/goal vocabulary is exactly the app's
// (adultPathwayStages.ts), so neither can drift without this failing.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { ADULT_PATHWAY_STAGES, ADULT_PATHWAY_STAGE_KEYS } from '@/src/shared/adultPathwayStages';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-pathway-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_pathway_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-pathway-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Same workaround as programPhases.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-pathway';
const COACH_ID = 'acct-pathway-coach';
const ATHLETE_ID = 'ath-pathway-1';
const OTHER_ATHLETE_ID = 'ath-pathway-2';

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

/** A fresh database with the base schema, one org, one coach, two athletes. */
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
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Pathway Athlete', '1990-01-01', '150', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, COACH_ID],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

function place(
  client: Client,
  stageKey: string,
  athleteId = ATHLETE_ID,
  role = 'coach',
  id: string = randomUUID(),
  accountId = COACH_ID,
) {
  return client
    .query(
      `insert into pilot.athlete_pathway_stages
         (organization_id, placement_id, athlete_id, stage_key, set_by_account_id, set_by_role)
       values ($1, $2, $3, $4, $5, $6)`,
      [ORG_ID, id, athleteId, stageKey, accountId, role],
    )
    .then(() => id);
}

function confirm(client: Client, stageKey: string, goalKey: string, athleteId = ATHLETE_ID) {
  const id = randomUUID();
  return client
    .query(
      `insert into pilot.athlete_pathway_checkpoints
         (organization_id, confirmation_id, athlete_id, stage_key, goal_key, confirmed_by_account_id, confirmed_by_role)
       values ($1, $2, $3, $4, $5, $6, 'coach')`,
      [ORG_ID, id, athleteId, stageKey, goalKey, COACH_ID],
    )
    .then(() => id);
}

function allow(client: Client, reason: string, athleteId = ATHLETE_ID) {
  const id = randomUUID();
  return client
    .query(
      `insert into pilot.athlete_pathway_minor_allowances
         (organization_id, allowance_id, athlete_id, reason, granted_by_account_id, granted_by_role)
       values ($1, $2, $3, $4, $5, 'coach')`,
      [ORG_ID, id, athleteId, reason, COACH_ID],
    )
    .then(() => id);
}

async function withMigratedDb(name: string, body: (client: Client) => Promise<void>) {
  const client = await freshDatabase(name);
  try {
    await applyMigrationTransaction(client, migrationSql);
    await body(client);
  } finally {
    await client.end();
  }
}

describe('athlete pathway migration', () => {
  test('applies from nothing through the runner and re-applies as a no-op', async () => {
    await withMigratedDb('pathway_fresh', async (client) => {
      await place(client, 'foundation');
      await applyMigrationTransaction(client, migrationSql);
      const rows = await client.query('select count(*)::int as n from pilot.athlete_pathway_stages');
      expect(rows.rows[0].n).toBe(1);
    });
  });

  test("the runner's readiness check refuses an environment missing a piece", async () => {
    const client = await freshDatabase('pathway_not_ready');
    try {
      const withoutIndex = migrationSql.replace(
        /create unique index if not exists idx_athlete_pathway_minor_allowances_live[\s\S]*?;/,
        '',
      );
      expect(withoutIndex).not.toBe(migrationSql);
      await expect(applyMigrationTransaction(client, withoutIndex)).rejects.toThrow('ATHLETE_PATHWAY_NOT_READY');
      // Rolled back: nothing half-applied is left behind.
      const t = await client.query(`select to_regclass('pilot.athlete_pathway_stages') as t`);
      expect(t.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('one current placement per athlete; superseded history is a real chain', async () => {
    await withMigratedDb('pathway_stages', async (client) => {
      const first = await place(client, 'foundation');
      await expect(place(client, 'intermediate')).rejects.toMatchObject({ code: '23505' });

      // The writer's order: stamp the old row, then insert its replacement, in
      // one transaction. The chain FK is checked at commit.
      const second = randomUUID();
      await client.query('begin');
      await client.query(
        `update pilot.athlete_pathway_stages set superseded_at = now(), superseded_by_placement_id = $2
         where organization_id = $1 and placement_id = $3`,
        [ORG_ID, second, first],
      );
      await place(client, 'intermediate', ATHLETE_ID, 'coach', second);
      await client.query('commit');

      // A superseded row naming a placement that never arrives is refused at commit.
      await client.query('begin');
      await client.query(
        `update pilot.athlete_pathway_stages set superseded_at = now(), superseded_by_placement_id = $2
         where organization_id = $1 and placement_id = $3`,
        [ORG_ID, randomUUID(), second],
      );
      await expect(client.query('commit')).rejects.toMatchObject({ code: '23503' });

      // Another athlete has their own current placement, and cannot be named
      // as the replacement of this athlete's.
      const other = await place(client, 'foundation', OTHER_ATHLETE_ID);
      await client.query('begin');
      await client.query(
        `update pilot.athlete_pathway_stages set superseded_at = now(), superseded_by_placement_id = $2
         where organization_id = $1 and placement_id = $3`,
        [ORG_ID, other, second],
      );
      await expect(client.query('commit')).rejects.toMatchObject({ code: '23503' });

      // Not self-superseded; stamp all or none; not before it was set.
      await expect(client.query(
        `update pilot.athlete_pathway_stages set superseded_at = now(), superseded_by_placement_id = placement_id
         where organization_id = $1 and placement_id = $2`,
        [ORG_ID, second],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `update pilot.athlete_pathway_stages set superseded_at = null
         where organization_id = $1 and placement_id = $2`,
        [ORG_ID, first],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `update pilot.athlete_pathway_stages set superseded_at = set_at - interval '1 day'
         where organization_id = $1 and placement_id = $2`,
        [ORG_ID, first],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(place(client, 'youth', OTHER_ATHLETE_ID)).rejects.toMatchObject({ code: '23514' });
      await expect(place(client, 'advanced', OTHER_ATHLETE_ID, 'athlete')).rejects.toMatchObject({ code: '23514' });
      await expect(place(client, 'advanced', ATHLETE_ID, 'coach', randomUUID(), '  ')).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('one live confirmation per goal; only real stage/goal pairs; withdrawal is a stamp', async () => {
    await withMigratedDb('pathway_checkpoints', async (client) => {
      const id = await confirm(client, 'foundation', 'footwork');
      await expect(confirm(client, 'foundation', 'footwork')).rejects.toMatchObject({ code: '23505' });

      // A goal under the wrong stage, and an invented goal, are refused.
      await expect(confirm(client, 'foundation', 'own_style')).rejects.toMatchObject({ code: '23514' });
      await expect(confirm(client, 'elite', 'world_title')).rejects.toMatchObject({ code: '23514' });

      // A half-stamped withdrawal is refused.
      await expect(client.query(
        `update pilot.athlete_pathway_checkpoints set withdrawn_at = now()
         where organization_id = $1 and confirmation_id = $2`,
        [ORG_ID, id],
      )).rejects.toMatchObject({ code: '23514' });

      await client.query(
        `update pilot.athlete_pathway_checkpoints
         set withdrawn_at = now(), withdrawn_by_account_id = $3, withdrawn_by_role = 'coach'
         where organization_id = $1 and confirmation_id = $2`,
        [ORG_ID, id, COACH_ID],
      );
      await confirm(client, 'foundation', 'footwork');
      const rows = await client.query(
        `select count(*)::int as n from pilot.athlete_pathway_checkpoints where goal_key = 'footwork'`,
      );
      expect(rows.rows[0].n).toBe(2);
    });
  });

  test('a minor allowance needs a reason; one live allowance per athlete', async () => {
    await withMigratedDb('pathway_allowances', async (client) => {
      await expect(allow(client, '')).rejects.toMatchObject({ code: '23514' });
      await expect(allow(client, '   ')).rejects.toMatchObject({ code: '23514' });

      const id = await allow(client, 'Competing in adult open class; guardian agreed.');
      await expect(allow(client, 'Second reason')).rejects.toMatchObject({ code: '23505' });

      await client.query(
        `update pilot.athlete_pathway_minor_allowances
         set withdrawn_at = now(), withdrawn_by_account_id = $3, withdrawn_by_role = 'organization_admin'
         where organization_id = $1 and allowance_id = $2`,
        [ORG_ID, id, COACH_ID],
      );
      await allow(client, 'Re-granted after review.');
    });
  });

  test('every row goes with its athlete', async () => {
    await withMigratedDb('pathway_cascade', async (client) => {
      await place(client, 'foundation');
      await confirm(client, 'foundation', 'aerobic_base');
      await allow(client, 'Reason');
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [
        ORG_ID,
        ATHLETE_ID,
      ]);
      for (const table of ['athlete_pathway_stages', 'athlete_pathway_checkpoints', 'athlete_pathway_minor_allowances']) {
        const rows = await client.query(`select count(*)::int as n from pilot.${table}`);
        expect(rows.rows[0].n).toBe(0);
      }
    });
  });

  // Behaviour, not constraint text: Postgres rewrites a row-IN-list CHECK into
  // an OR chain, so reading pg_get_constraintdef would test its formatting.
  test("the database's stage and goal vocabulary is exactly the app's", async () => {
    await withMigratedDb('pathway_vocab', async (client) => {
      for (const stage of ADULT_PATHWAY_STAGES) {
        for (const goal of stage.goals) {
          await confirm(client, stage.key, goal.key);
        }
      }
      const live = await client.query('select count(*)::int as n from pilot.athlete_pathway_checkpoints');
      expect(live.rows[0].n).toBe(ADULT_PATHWAY_STAGES.flatMap((s) => s.goals).length);

      // Every goal under every OTHER stage is refused.
      for (const stage of ADULT_PATHWAY_STAGES) {
        for (const other of ADULT_PATHWAY_STAGES.filter((s) => s.key !== stage.key)) {
          for (const goal of other.goals) {
            await expect(confirm(client, stage.key, goal.key, OTHER_ATHLETE_ID)).rejects.toMatchObject({ code: '23514' });
          }
        }
      }

      for (const key of ADULT_PATHWAY_STAGE_KEYS) {
        await place(client, key, OTHER_ATHLETE_ID).then((id) => client.query(
          'delete from pilot.athlete_pathway_stages where placement_id = $1',
          [id],
        ));
      }
    });
  });
});
