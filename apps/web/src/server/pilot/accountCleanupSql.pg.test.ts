// Real PostgreSQL proof for the two SQL statements the account cleanup runs
// (scripts/lib/account-cleanup-plan.mjs: ACCOUNTS_READ_SQL, RETIRE_ACCOUNTS_SQL).
//
// WHAT IT PROVES
//
//   1. The read tells the planner, per account, whether a live athlete record
//      stands behind the login -- same organization, same athlete_id,
//      deleted_at null -- and says false for a deleted record, a missing
//      record, a record of the same id in another organization, and no link.
//   2. Read -> planner -> retire, end to end: the login of a child who never
//      redeemed an activation code is not retired, and is listed as skipped.
//   3. The retire statement's own locks hold when the planner is bypassed: it
//      is handed EVERY account id and still refuses a login with a live
//      athlete record, a gate fixture, a parent, and an already-deleted row.
//
// WHY REAL POSTGRES. accountCleanupPlan.test.ts covers the planner as a pure
// function over rows somebody typed. Nothing there runs the join that produces
// athlete_record_live, the `not exists` lock, or the ILIKE escape in
// 'gate\_%' -- all three are text inside SQL strings, which tsc cannot check
// and a typed fixture cannot exercise.
//
// Spins up the same disposable, local-only embedded Postgres the other .pg
// suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-account-cleanup-sql-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const PLAN_MODULE_PATH = path.resolve(__dirname, '../../../scripts/lib/account-cleanup-plan.mjs');
const TEST_DB_NAME = 'ppbf_test_account_cleanup_sql';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.accounts.deleted_at and pilot.athletes.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG = 'org-acs';
const OTHER_ORG = 'org-acs-other';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Hiding the call inside `new Function` keeps a real
// dynamic import in the emitted code. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

interface ReadRow {
  account_id: string;
  athlete_id: string | null;
  athlete_record_live: boolean;
  deleted_at: Date | null;
}

interface Decision {
  account_id: string;
  disposition: string;
  reason: string;
}

interface Plan {
  decisions: Decision[];
  retire: Decision[];
  liveAthleteLogins: Decision[];
  gateFixtures: Decision[];
}

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let ACCOUNTS_READ_SQL: string;
let RETIRE_ACCOUNTS_SQL: string;
let planAccountCleanup: (rows: unknown[], options?: Record<string, unknown>) => Plan;

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

async function seedAccount(input: {
  accountId: string;
  role: string;
  organizationId?: string;
  active?: boolean;
  athleteId?: string;
  deleted?: boolean;
}): Promise<void> {
  // deleted_at is written by the insert itself, so no update trigger acts.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, active_flag, deleted_at)
     values ($1, $2, $3, 'ppbf_local', $4, $5, case when $6::boolean then now() else null end)`,
    [
      input.accountId,
      input.role,
      input.organizationId ?? ORG,
      input.athleteId ?? null,
      input.active ?? false,
      input.deleted ?? false,
    ],
  );
}

async function seedAthlete(input: { athleteId: string; organizationId?: string; deleted?: boolean }): Promise<void> {
  const organizationId = input.organizationId ?? ORG;
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Test Athlete', '2012-01-01', 'open', 'active', 'n/a', true, $3, now(), now(),
       case when $4::boolean then now() else null end)`,
    [organizationId, input.athleteId, organizationId === ORG ? 'acs-coach-active' : 'acs-other-coach', input.deleted ?? false],
  );
}

async function readRows(): Promise<ReadRow[]> {
  return (await client.query<ReadRow>(ACCOUNTS_READ_SQL)).rows;
}

async function deletedIds(): Promise<string[]> {
  return (await client.query<{ account_id: string }>(
    'select account_id from pilot.accounts where deleted_at is not null',
  )).rows.map((row) => row.account_id).sort();
}

// Every account id that must survive any call to the retire statement.
const PROTECTED_IDS = [
  // A child added to the roster who never redeemed an activation code.
  'acs-kid-never-activated',
  // A live athlete record behind a login that is not role 'athlete'.
  'acs-coach-with-athlete-link',
  // Gate fixtures, with and without an athlete link, and one cased differently.
  'gate_shadow_athlete',
  'gate_probe_coach',
  'GATE_Probe_Upper',
  // A parent: the statement can fire the cascade across minors' records.
  'acs-parent',
];

// Inactive, on no list, nothing live behind them: what the cleanup is for.
const RESIDUE_IDS = [
  'acs-coach-residue',
  // The athlete record is marked deleted.
  'acs-kid-record-deleted',
  // The login names an athlete_id with no athlete row at all.
  'acs-kid-record-missing',
  // A live athlete of the SAME athlete_id exists, but in another organization.
  'acs-kid-other-org-record',
  // Starts with "gate" but not "gate_": `_` must be a literal in the ILIKE.
  'gatekeeper',
];

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

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${TEST_DB_NAME}`);
  await adminClient.query(`create database ${TEST_DB_NAME}`);
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }

  const planModule = await nativeDynamicImport(pathToFileURL(PLAN_MODULE_PATH).href);
  ACCOUNTS_READ_SQL = planModule.ACCOUNTS_READ_SQL as string;
  RETIRE_ACCOUNTS_SQL = planModule.RETIRE_ACCOUNTS_SQL as string;
  planAccountCleanup = planModule.planAccountCleanup as typeof planAccountCleanup;

  for (const organizationId of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [organizationId],
    );
  }

  // pilot.athletes.coach_id references an account. Active, so the planner
  // holds them and they stay out of every retire list below.
  await seedAccount({ accountId: 'acs-coach-active', role: 'coach', active: true });
  await seedAccount({ accountId: 'acs-other-coach', role: 'coach', organizationId: OTHER_ORG, active: true });

  await seedAthlete({ athleteId: 'ATH-LIVE-1' });
  await seedAthlete({ athleteId: 'ATH-LIVE-2' });
  await seedAthlete({ athleteId: 'ATH-LIVE-3' });
  await seedAthlete({ athleteId: 'ATH-DELETED', deleted: true });
  await seedAthlete({ athleteId: 'ATH-ELSEWHERE', organizationId: OTHER_ORG });

  await seedAccount({ accountId: 'acs-kid-never-activated', role: 'athlete', athleteId: 'ATH-LIVE-1' });
  await seedAccount({ accountId: 'acs-coach-with-athlete-link', role: 'coach', athleteId: 'ATH-LIVE-2' });
  await seedAccount({ accountId: 'gate_shadow_athlete', role: 'athlete', athleteId: 'ATH-LIVE-3' });
  await seedAccount({ accountId: 'gate_probe_coach', role: 'coach' });
  await seedAccount({ accountId: 'GATE_Probe_Upper', role: 'coach' });
  await seedAccount({ accountId: 'acs-parent', role: 'parent' });

  await seedAccount({ accountId: 'acs-coach-residue', role: 'coach' });
  await seedAccount({ accountId: 'acs-kid-record-deleted', role: 'athlete', athleteId: 'ATH-DELETED' });
  await seedAccount({ accountId: 'acs-kid-record-missing', role: 'athlete', athleteId: 'ATH-NO-ROW' });
  await seedAccount({ accountId: 'acs-kid-other-org-record', role: 'athlete', athleteId: 'ATH-ELSEWHERE' });
  await seedAccount({ accountId: 'gatekeeper', role: 'coach' });

  await seedAccount({ accountId: 'acs-already-deleted', role: 'coach', deleted: true });
});

afterAll(async () => {
  await client?.end();
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
  // Swallowed as most .pg suites do: on Windows the killed server can still
  // hold the folder (EBUSY), and test-embedded-pg-server.mjs sweeps leftovers.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('ACCOUNTS_READ_SQL', () => {
  test('returns one row per account: the athlete join never multiplies or drops a row', async () => {
    const rows = await readRows();
    const count = (await client.query<{ n: string }>('select count(*) as n from pilot.accounts')).rows[0].n;
    expect(rows).toHaveLength(Number(count));
    expect(new Set(rows.map((row) => row.account_id)).size).toBe(rows.length);
  });

  test('says which logins have a live athlete record behind them, as a boolean on every row', async () => {
    const live = Object.fromEntries((await readRows()).map((row) => [row.account_id, row.athlete_record_live]));
    expect(live).toEqual({
      'acs-coach-active': false,
      'acs-other-coach': false,
      'acs-kid-never-activated': true,
      'acs-coach-with-athlete-link': true,
      gate_shadow_athlete: true,
      gate_probe_coach: false,
      GATE_Probe_Upper: false,
      'acs-parent': false,
      'acs-coach-residue': false,
      // Record marked deleted; no record; record only in another organization.
      'acs-kid-record-deleted': false,
      'acs-kid-record-missing': false,
      'acs-kid-other-org-record': false,
      gatekeeper: false,
      'acs-already-deleted': false,
    });
  });
});

describe('read -> plan, over real rows', () => {
  test('THE POINT: the never-activated child is skipped and listed, and only residue is planned', async () => {
    const plan = planAccountCleanup(await readRows());

    expect(plan.retire.map((decision) => decision.account_id).sort()).toEqual([...RESIDUE_IDS].sort());
    expect(plan.liveAthleteLogins.map((decision) => decision.account_id).sort()).toEqual([
      'acs-coach-with-athlete-link',
      'acs-kid-never-activated',
    ]);
    expect(plan.gateFixtures.map((decision) => decision.account_id).sort()).toEqual([
      'GATE_Probe_Upper',
      'gate_probe_coach',
      'gate_shadow_athlete',
    ]);
  });
});

describe('RETIRE_ACCOUNTS_SQL', () => {
  test('handed EVERY account id, it retires only residue: each lock holds without the planner', async () => {
    const everyId = (await client.query<{ account_id: string }>('select account_id from pilot.accounts')).rows
      .map((row) => row.account_id);

    await client.query('begin');
    try {
      const retired = (await client.query<{ account_id: string }>(RETIRE_ACCOUNTS_SQL, [everyId])).rows
        .map((row) => row.account_id)
        .sort();

      // The two active coaches are not protected by any SQL lock -- keeping
      // active accounts out is the planner's job -- so they are retired here.
      // That is the control showing the statement was really handed everything.
      expect(retired).toEqual([...RESIDUE_IDS, 'acs-coach-active', 'acs-other-coach'].sort());
      for (const accountId of PROTECTED_IDS) expect(retired).not.toContain(accountId);
      expect(retired).not.toContain('acs-already-deleted');

      const stillLive = (await client.query<{ account_id: string }>(
        'select account_id from pilot.accounts where deleted_at is null',
      )).rows.map((row) => row.account_id).sort();
      expect(stillLive).toEqual([...PROTECTED_IDS].sort());
    } finally {
      await client.query('rollback');
    }

    expect(await deletedIds()).toEqual(['acs-already-deleted']);
  });

  test('once the athlete record is marked deleted, the same login is no longer protected', async () => {
    // The lock follows the athlete record, not the login: this is the negative
    // control for the two tests around it.
    await client.query('begin');
    try {
      await client.query(
        `update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = 'ATH-LIVE-1'`,
        [ORG],
      );
      const live = (await readRows()).find((row) => row.account_id === 'acs-kid-never-activated');
      expect(live?.athlete_record_live).toBe(false);

      const retired = (await client.query<{ account_id: string }>(
        RETIRE_ACCOUNTS_SQL,
        [['acs-kid-never-activated']],
      )).rows.map((row) => row.account_id);
      expect(retired).toEqual(['acs-kid-never-activated']);
    } finally {
      await client.query('rollback');
    }
  });

  test('applying the plan retires the residue and leaves the child\'s login whole', async () => {
    const plan = planAccountCleanup(await readRows());
    const retired = (await client.query<{ account_id: string }>(
      RETIRE_ACCOUNTS_SQL,
      [plan.retire.map((decision) => decision.account_id)],
    )).rows.map((row) => row.account_id).sort();

    expect(retired).toEqual([...RESIDUE_IDS].sort());
    expect(await deletedIds()).toEqual([...RESIDUE_IDS, 'acs-already-deleted'].sort());

    const kid = (await client.query<{ deleted_at: Date | null; active_flag: boolean; athlete_id: string }>(
      `select deleted_at, active_flag, athlete_id from pilot.accounts where account_id = 'acs-kid-never-activated'`,
    )).rows[0];
    expect(kid).toEqual({ deleted_at: null, active_flag: false, athlete_id: 'ATH-LIVE-1' });
  });
});
