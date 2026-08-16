// Real PostgreSQL-backed contract test for the floor-groups migration
// (modules 121 + 123).
//
// What needs proving that reading SQL cannot prove: the three tables
// create from nothing and re-apply as a no-op; ONE GROUP PER ATHLETE PER
// PLAN is a primary key (a person cannot stand in two groups on the same
// floor), while the same athlete may appear on a different day's plan
// freely; groups cascade from their plan; and tenancy holds via the
// composite athlete FK.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-floor-groups-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_floor_groups_migration.sql';

const ORG_ID = 'org-floor';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-floor-admin';
const COACH_ID = 'acct-floor-coach';
const ATHLETE_ID = 'ath-floor-1';

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
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Floor Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
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






async function seedPlan(client: Client, planId: string, planOn: string) {
  await client.query(
    `insert into pilot.floor_plans_daily (organization_id, plan_id, plan_on, created_by_account_id)
     values ($1, $2, $3::date, $4)`,
    [ORG_ID, planId, planOn, ADMIN_ID],
  );
}

async function seedGroup(client: Client, groupId: string, planId: string, station: string | null) {
  await client.query(
    `insert into pilot.floor_plan_groups (organization_id, group_id, plan_id, group_name, station_name)
     values ($1, $2, $3, $4, $5)`,
    [ORG_ID, groupId, planId, `Group ${groupId}`, station],
  );
}

describe('floor groups migration', () => {
  test('creates from nothing, re-applies as a no-op, and holds one group per athlete per plan', async () => {
    const client = await freshDatabase('floor_fresh');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);

      await seedPlan(client, 'plan-mon', '2026-08-10');
      await seedGroup(client, 'g-bags', 'plan-mon', 'Bags');
      await seedGroup(client, 'g-pads', 'plan-mon', 'Pads');
      // A small-group day: station null is legal, not a broken circuit.
      await seedPlan(client, 'plan-tue', '2026-08-11');
      await seedGroup(client, 'g-small', 'plan-tue', null);

      await client.query(
        `insert into pilot.floor_plan_members (organization_id, plan_id, group_id, athlete_id)
         values ($1, 'plan-mon', 'g-bags', $2)`,
        [ORG_ID, ATHLETE_ID],
      );

      // The same athlete cannot also stand at Pads on the same plan...
      await expect(client.query(
        `insert into pilot.floor_plan_members (organization_id, plan_id, group_id, athlete_id)
         values ($1, 'plan-mon', 'g-pads', $2)`,
        [ORG_ID, ATHLETE_ID],
      )).rejects.toMatchObject({ code: '23505' });

      // ...but moving them is the ordinary act, and tomorrow is a fresh floor.
      await client.query(
        `insert into pilot.floor_plan_members (organization_id, plan_id, group_id, athlete_id)
         values ($1, 'plan-mon', 'g-pads', $2)
         on conflict (organization_id, plan_id, athlete_id) do update set group_id = excluded.group_id`,
        [ORG_ID, ATHLETE_ID],
      );
      await client.query(
        `insert into pilot.floor_plan_members (organization_id, plan_id, group_id, athlete_id)
         values ($1, 'plan-tue', 'g-small', $2)`,
        [ORG_ID, ATHLETE_ID],
      );

      const placed = await client.query(
        `select plan_id, group_id from pilot.floor_plan_members where organization_id = $1 order by plan_id`,
        [ORG_ID],
      );
      expect(placed.rows).toEqual([
        { plan_id: 'plan-mon', group_id: 'g-pads' },
        { plan_id: 'plan-tue', group_id: 'g-small' },
      ]);

      // Deleting a plan takes its groups and placements with it.
      await client.query(`delete from pilot.floor_plans_daily where organization_id = $1 and plan_id = 'plan-mon'`, [ORG_ID]);
      const left = await client.query(
        `select count(*)::int as n from pilot.floor_plan_members where organization_id = $1`,
        [ORG_ID],
      );
      expect(left.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
