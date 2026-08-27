// Real PostgreSQL-backed contract test for the floor-groups migration
// (modules 121 + 123), AND for the REAL module behavior on top of it:
// './db' is mocked to route into the embedded server (see
// trainingHolds.pg.test.ts for the same pattern), so createPlan, addGroup,
// listGroups, placeAthlete, and removeAthlete below are the actual
// production functions executing their actual SQL against actual rows --
// not the hand-written raw-SQL inserts the rest of this file uses to prove
// schema-level constraints.
//
// What needs proving that reading SQL cannot prove: the three tables
// create from nothing and re-apply as a no-op; ONE GROUP PER ATHLETE PER
// PLAN is a primary key (a person cannot stand in two groups on the same
// floor), while the same athlete may appear on a different day's plan
// freely; groups cascade from their plan; and tenancy holds via the
// composite athlete FK. On top of that: addGroup's not-found-plan check,
// placeAthlete's move-not-duplicate semantics (the on-conflict-do-update)
// and its group/athlete existence checks, and the member-join in
// listGroups only exist in the TS module.
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

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

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

import { addGroup, createPlan, isCircuit, listGroups, placeAthlete, removeAthlete } from './floorGroups';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-floor-groups-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_floor_groups_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-floor-groups-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-floor';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-floor-admin';
const COACH_ID = 'acct-floor-coach';
const ATHLETE_ID = 'ath-floor-1';

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

/* `preMigration` reproduces a database where the floor-groups migration never
   ran. It has to be reproduced by DROPPING, because the fixture now builds the
   whole schema -- which is the point: production has every migration, so a
   fixture that simply omits one is not a smaller production. The readiness
   assertion still needs that world to exist, so it is constructed explicitly
   here rather than obtained by accident from a partial build. */
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
  /* THE WHOLE SCHEMA, not the base file alone. This suite drives feature
     code, so it has no business deciding which migrations exist -- and the
     column it was missing (athletes.deleted_at) belongs to a migration it
     never picked. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
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
  if (preMigration) {
    await client.query(
      'drop table if exists pilot.floor_plan_members, pilot.floor_plan_groups, pilot.floor_plans_daily cascade',
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

afterEach(() => {
  activeClient = null;
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

describe('isCircuit', () => {
  test('is true only when at least one group names a station', () => {
    expect(isCircuit([{ station_name: 'Bags' }, { station_name: null }])).toBe(true);
    expect(isCircuit([{ station_name: null }, { station_name: '  ' }])).toBe(false);
    expect(isCircuit([])).toBe(false);
  });
});

// The tests above prove the migration's schema. These prove the module:
// addGroup's not-found-plan guard, placeAthlete's group/athlete existence
// checks and its move-not-duplicate on-conflict-do-update, removeAthlete,
// and listGroups's member join -- none of which a raw-SQL insert can
// exercise, because none of it is a database constraint.
describe('the real floor-group lifecycle against real rows', () => {
  test('addGroup returns null for an unknown plan, and creates a group joined with an empty member list otherwise', async () => {
    const client = await freshDatabase('floor_add_group');
    activeClient = client;
    try {
      await client.query(migrationSql);

      await expect(addGroup({
        organizationId: ORG_ID,
        planId: 'no-such-plan',
        groupName: 'Bags',
      })).resolves.toBeNull();

      const plan = await createPlan({ organizationId: ORG_ID, planOn: '2026-08-10', createdByAccountId: ADMIN_ID });
      const group = await addGroup({
        organizationId: ORG_ID,
        planId: plan!.plan_id,
        groupName: 'Bags',
        stationName: 'Station 1',
      });
      expect(group).toMatchObject({ group_name: 'Bags', station_name: 'Station 1', members: [] });
    } finally {
      await client.end();
    }
  });

  test('placeAthlete moves an athlete rather than duplicating them, and refuses an unknown group or athlete', async () => {
    const client = await freshDatabase('floor_place_athlete');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const plan = await createPlan({ organizationId: ORG_ID, planOn: '2026-08-10', createdByAccountId: ADMIN_ID });
      const bags = await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'Bags' });
      const pads = await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'Pads' });

      await expect(placeAthlete({
        organizationId: ORG_ID,
        planId: plan!.plan_id,
        groupId: 'no-such-group',
        athleteId: ATHLETE_ID,
      })).resolves.toBeNull();

      await expect(placeAthlete({
        organizationId: ORG_ID,
        planId: plan!.plan_id,
        groupId: bags!.group_id,
        athleteId: 'no-such-athlete',
      })).resolves.toBeNull();

      const afterBags = await placeAthlete({
        organizationId: ORG_ID,
        planId: plan!.plan_id,
        groupId: bags!.group_id,
        athleteId: ATHLETE_ID,
      });
      expect(afterBags!.find((g) => g.group_id === bags!.group_id)!.members).toEqual([
        { athlete_id: ATHLETE_ID, athlete_name: 'Floor Athlete' },
      ]);

      // Re-placing moves them -- Bags loses the member, Pads gains it, not both.
      const afterPads = await placeAthlete({
        organizationId: ORG_ID,
        planId: plan!.plan_id,
        groupId: pads!.group_id,
        athleteId: ATHLETE_ID,
      });
      expect(afterPads!.find((g) => g.group_id === bags!.group_id)!.members).toEqual([]);
      expect(afterPads!.find((g) => g.group_id === pads!.group_id)!.members).toEqual([
        { athlete_id: ATHLETE_ID, athlete_name: 'Floor Athlete' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('removeAthlete takes them off the floor for that plan', async () => {
    const client = await freshDatabase('floor_remove_athlete');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const plan = await createPlan({ organizationId: ORG_ID, planOn: '2026-08-10', createdByAccountId: ADMIN_ID });
      const bags = await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'Bags' });
      await placeAthlete({ organizationId: ORG_ID, planId: plan!.plan_id, groupId: bags!.group_id, athleteId: ATHLETE_ID });

      const after = await removeAthlete({ organizationId: ORG_ID, planId: plan!.plan_id, athleteId: ATHLETE_ID });
      expect(after.find((g) => g.group_id === bags!.group_id)!.members).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('listGroups orders stationed groups by rotation_order, unordered groups last', async () => {
    const client = await freshDatabase('floor_list_groups');
    activeClient = client;
    try {
      await client.query(migrationSql);
      const plan = await createPlan({ organizationId: ORG_ID, planOn: '2026-08-10', createdByAccountId: ADMIN_ID });
      await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'Z-no-order' });
      await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'Second', rotationOrder: 2 });
      await addGroup({ organizationId: ORG_ID, planId: plan!.plan_id, groupName: 'First', rotationOrder: 1 });

      const groups = await listGroups(ORG_ID, plan!.plan_id);
      expect(groups.map((g) => g.group_name)).toEqual(['First', 'Second', 'Z-no-order']);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-floor-groups-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('floor groups runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('flrgrp_rdy_no', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FLOOR_GROUPS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('flrgrp_rdy_ok');
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
