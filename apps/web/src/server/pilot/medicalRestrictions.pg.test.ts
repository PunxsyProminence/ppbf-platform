// Real PostgreSQL-backed test for the medical-restrictions migration (Backbone
// P22, lane P22a), medicalRestrictions.ts on top of it, and the staff route
// over both. './db' is mocked to route into the embedded server
// (athleteCapacityNotes.pg.test.ts pattern; withTransaction runs a real
// BEGIN/COMMIT/ROLLBACK), so the module's SQL, access.ts's and audit.ts's run
// against real rows. Only requirePrincipal is replaced, to choose the caller.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing, re-applies as a no-op,
//     and the runner refuses a database without the table or a guard;
//   * bad dates, a coach voiding, a half-recorded release and another gym's
//     athlete are DATABASE refusals;
//   * the release, LBC and void writes are set once, and a voided record
//     takes no release;
//   * the audit row commits with the write and names fields, never values;
//   * the gate's SQL probe and restrictionBlocksOn agree on every case,
//     including the pre-migration window (no restriction, transaction intact);
//   * through the route: only staff of THIS gym read or write; a coach of
//     another gym, a parent, an athlete, platform_owner and board are refused;
//     a coach cannot void;
//   * P22b: the ruled save paths refuse a sparring-level entry for a
//     restricted member and save the levels below it, each through its own
//     module against real rows (sparring exposure, drill assignments, Coach
//     Cards, completions, workout issues, training attempts, sessions,
//     competition entries). The athlete sparring log's gate is held by its
//     route test.
//
// Test data only. Disposable, local-only embedded Postgres; it NEVER connects
// to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows;
    }),
    queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows[0] ?? null;
    }),
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
  };
});

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import type { PoolClient } from 'pg';

import { GET, POST } from '../../../app/api/pilot/coach/medical-restrictions/route';
import { issueCoachCard, issueCoachCardToProgram } from './coachCards';
import type { PilotSession } from './contracts';
import { upsertSession } from './entities';
import { ConflictError } from './errors';
import { requirePrincipal } from './http';
import {
  MEDICAL_RESTRICTION_REFUSAL_CODE,
  type GateFields,
  assertCompetitionClearOfMedicalRestriction,
  assertNoMedicalRestriction,
  drillIsAtSparringLevel,
  findBlockingMedicalRestriction,
  gymDayOf,
  listMedicalRestrictions,
  medicalRestrictionGateDays,
  medicalRestrictionNote,
  membersBlockedToday,
  recordLbcInformed,
  recordMedicalRestriction,
  recordRelease,
  restrictionBlocksOn,
  voidMedicalRestriction,
} from './medicalRestrictions';
import { assignDrill, recordCompletion } from './progression';
import { recordSparringExposure, sparringExposureDay } from './sparringExposure';
import { type AttemptContextType, recordAttempt } from './trainingAttempts';
import { recordWorkoutIssue } from './workoutIssues';

jest.setTimeout(180_000);

const mockPrincipal = requirePrincipal as jest.Mock;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-medical-restrictions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_medical_restrictions_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-medical-restrictions-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-medres';
const OTHER_ORG_ID = 'org-medres-elsewhere';
const ADMIN_ID = 'acct-medres-admin';
const COACH_ID = 'acct-medres-coach';
const OTHER_COACH_ID = 'acct-medres-other-coach'; // a coach of the other gym only
const ATHLETE_ACCOUNT_ID = 'acct-medres-athlete';
const PARENT_ACCOUNT_ID = 'acct-medres-parent';
const ATHLETE_ID = 'ath-medres-1';
// The same athlete id in BOTH gyms (pilot.athletes' key is composite).
const SHARED_ATHLETE_ID = 'ath-medres-shared';

const principal = (accountId: string, role: string, organizationId = ORG_ID, athleteId: string | null = null) => ({
  accountId, role, organizationId, athleteId, sessionToken: 'test-token', authProvider: 'microsoft',
});
const ADMIN = principal(ADMIN_ID, 'organization_admin');
const COACH = principal(COACH_ID, 'coach');
const OTHER_COACH = principal(OTHER_COACH_ID, 'coach', OTHER_ORG_ID);
const ATHLETE = principal(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const PARENT = principal(PARENT_ACCOUNT_ID, 'parent');
const PLATFORM_OWNER = principal('acct-medres-owner', 'platform_owner');
const BOARD = principal('acct-medres-board', 'board');

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

async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
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
     values ($1, 'organization_admin', $6, 'microsoft', null),
            ($2, 'coach',              $6, 'microsoft', null),
            ($3, 'coach',              $7, 'microsoft', null),
            ($4, 'athlete',            $6, 'microsoft', $8),
            ($5, 'parent',             $6, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, OTHER_COACH_ID, ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, ORG_ID, OTHER_ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $6, 'organization_admin', true),
            ($2, $6, 'coach',              true),
            ($3, $7, 'coach',              true),
            ($4, $6, 'athlete',            true),
            ($5, $6, 'parent',             true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, OTHER_COACH_ID, ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, ORG_ID, OTHER_ORG_ID],
  );
  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SHARED_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, SHARED_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Test Member', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-medres-1', $2, 'Test Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-medres-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.medical_restrictions cascade');
  }
  activeClient = client;
  return client;
}

function insertRaw(client: Client, overrides: Record<string, unknown> = {}) {
  const row = {
    organization_id: ORG_ID,
    athlete_id: ATHLETE_ID,
    source: 'ringside_affidavit',
    loss_of_consciousness: 'none',
    start_date: '2026-10-01',
    minimum_end_date: '2026-10-30',
    release_signed_on: null,
    release_recorded_by_account_id: null,
    release_recorded_by_role: null,
    release_recorded_at: null,
    recorded_by_role: 'coach',
    voided_at: null,
    voided_by_account_id: null,
    voided_by_role: null,
    void_reason: null,
    ...overrides,
  };
  return client.query(
    `insert into pilot.medical_restrictions
       (organization_id, restriction_id, athlete_id, source, loss_of_consciousness, start_date, minimum_end_date,
        release_signed_on, release_recorded_by_account_id, release_recorded_by_role, release_recorded_at,
        recorded_by_account_id, recorded_by_role, voided_at, voided_by_account_id, voided_by_role, void_reason)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, 'acct-medres-coach', $11, $12, $13, $14, $15)
     returning restriction_id::text`,
    [row.organization_id, row.athlete_id, row.source, row.loss_of_consciousness, row.start_date, row.minimum_end_date,
     row.release_signed_on, row.release_recorded_by_account_id, row.release_recorded_by_role, row.release_recorded_at,
     row.recorded_by_role, row.voided_at, row.voided_by_account_id, row.voided_by_role, row.void_reason],
  );
}

const RECORD = {
  organizationId: ORG_ID,
  athleteId: ATHLETE_ID,
  source: 'training_knockout_or_concussion' as const,
  lossOfConsciousness: 'under_1_min' as const,
  startDate: '2026-10-01',
  minimumEndDate: '2026-10-30',
  linkedIncidentId: 'incident-test-1',
  note: 'Test note text',
  actorAccountId: COACH_ID,
  actorRole: 'coach' as const,
};

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/medical-restrictions${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/coach/medical-restrictions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const RECORD_BODY = {
  action: 'record',
  athlete_id: ATHLETE_ID,
  source: 'ringside_affidavit',
  loss_of_consciousness: 'none',
  start_date: '2026-10-01',
  minimum_end_date: '2026-10-30',
};

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
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(() => {
  activeClient = null;
  mockPrincipal.mockReset();
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

describe('medical restrictions migration', () => {
  test('creates the table from nothing, and a re-apply leaves rows untouched', async () => {
    const client = await freshDatabase('medres_fresh', { preMigration: true });
    try {
      expect((await client.query(`select to_regclass('pilot.medical_restrictions') as t`)).rows[0].t).toBeNull();
      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query('select source, minimum_end_date::text from pilot.medical_restrictions');
      expect(rows).toEqual([{ source: 'ringside_affidavit', minimum_end_date: '2026-10-30' }]);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a database without the table, or with a guard dropped', async () => {
    const none = await freshDatabase('medres_none', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(none, 'select 1')).rejects.toThrow(/MEDICAL_RESTRICTIONS_TABLE_NOT_READY/);
    } finally {
      await none.end();
    }
    const broken = await freshDatabase('medres_broken');
    try {
      await broken.query('alter table pilot.medical_restrictions drop constraint pilot_medical_restrictions_void_check');
      await expect(applyMigrationTransaction(broken, 'select 1')).rejects.toThrow(/MEDICAL_RESTRICTIONS_TABLE_NOT_READY/);
    } finally {
      await broken.end();
    }
  });

  test('the database refuses bad dates, a coach voiding, a half-recorded release and another gym\'s athlete', async () => {
    const client = await freshDatabase('medres_checks');
    try {
      await expect(insertRaw(client, { minimum_end_date: '2026-09-30' })).rejects.toThrow(/dates_check/);
      await expect(insertRaw(client, {
        release_signed_on: '2026-09-15', release_recorded_by_account_id: COACH_ID,
        release_recorded_by_role: 'coach', release_recorded_at: '2026-10-02T00:00:00Z',
      })).rejects.toThrow(/dates_check/);
      await expect(insertRaw(client, { release_signed_on: '2026-10-15' })).rejects.toThrow(/release_check/);
      await expect(insertRaw(client, {
        voided_at: '2026-10-02T00:00:00Z', voided_by_account_id: COACH_ID, voided_by_role: 'coach', void_reason: 'wrong member',
      })).rejects.toThrow(/void_check/);
      await expect(insertRaw(client, {
        voided_at: '2026-10-02T00:00:00Z', voided_by_account_id: ADMIN_ID, voided_by_role: 'organization_admin', void_reason: '  ',
      })).rejects.toThrow(/void_check/);
      await expect(insertRaw(client, { source: 'rumour' })).rejects.toThrow(/source_check/);
      await expect(insertRaw(client, { loss_of_consciousness: 'maybe' })).rejects.toThrow(/loc_check/);
      await expect(insertRaw(client, { recorded_by_role: 'parent' })).rejects.toThrow(/recorded_role_check/);
      await expect(insertRaw(client, { athlete_id: 'ath-not-here' })).rejects.toThrow(/athlete_fk/);
    } finally {
      await client.end();
    }
  });
});

describe("the row's own rules, held by the database", () => {
  test('facts never change, the release is set once and never in the future, and a row is never deleted directly', async () => {
    const client = await freshDatabase('medres_guard');
    try {
      const { rows } = await insertRaw(client);
      const id = rows[0].restriction_id;
      await expect(client.query(
        `update pilot.medical_restrictions set minimum_end_date = '2026-10-05' where restriction_id = $1`, [id],
      )).rejects.toThrow(/MEDICAL_RESTRICTION_FIXED_FIELDS/);
      await expect(client.query(
        `update pilot.medical_restrictions set loss_of_consciousness = 'unknown' where restriction_id = $1`, [id],
      )).rejects.toThrow(/MEDICAL_RESTRICTION_FIXED_FIELDS/);
      await expect(client.query(
        `update pilot.medical_restrictions
            set release_signed_on = current_date + 30, release_recorded_by_account_id = $2,
                release_recorded_by_role = 'coach', release_recorded_at = now()
          where restriction_id = $1`, [id, COACH_ID],
      )).rejects.toThrow(/MEDICAL_RESTRICTION_RELEASE_IN_FUTURE/);
      await client.query(
        `update pilot.medical_restrictions
            set release_signed_on = '2026-10-20', release_recorded_by_account_id = $2,
                release_recorded_by_role = 'coach', release_recorded_at = now()
          where restriction_id = $1`, [id, COACH_ID],
      );
      await expect(client.query(
        `update pilot.medical_restrictions set release_signed_on = '2026-10-02' where restriction_id = $1`, [id],
      )).rejects.toThrow(/MEDICAL_RESTRICTION_SET_ONCE/);
      await expect(client.query('delete from pilot.medical_restrictions where restriction_id = $1', [id]))
        .rejects.toThrow(/MEDICAL_RESTRICTION_NOT_DELETABLE/);
      await expect(insertRaw(client, {
        release_signed_on: '2099-01-01', release_recorded_by_account_id: COACH_ID,
        release_recorded_by_role: 'coach', release_recorded_at: '2026-10-02T00:00:00Z',
      })).rejects.toThrow(/MEDICAL_RESTRICTION_RELEASE_IN_FUTURE/);
    } finally {
      await client.end();
    }
  });

  test('the row still goes with its member (the foreign-key cascade the retention purge relies on)', async () => {
    const client = await freshDatabase('medres_cascade');
    try {
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
            emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, 'ath-medres-purge', 'Test Member', '2012-01-01', '100', 'active', 'contact', true, $2, now(), now())`,
        [ORG_ID, COACH_ID],
      );
      await insertRaw(client, { athlete_id: 'ath-medres-purge' });
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = 'ath-medres-purge'`, [ORG_ID]);
      const { rows } = await client.query(`select count(*)::int as n from pilot.medical_restrictions where athlete_id = 'ath-medres-purge'`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a table whose guard trigger is missing', async () => {
    const client = await freshDatabase('medres_no_trigger');
    try {
      await client.query('drop trigger trg_medical_restrictions_guard on pilot.medical_restrictions');
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(/MEDICAL_RESTRICTIONS_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });
});

describe('medicalRestrictions.ts writes', () => {
  test('record, release and LBC are set once; the audit names fields, never values', async () => {
    const client = await freshDatabase('medres_writes');
    try {
      const row = await recordMedicalRestriction(RECORD);
      expect(row).toMatchObject({ source: 'training_knockout_or_concussion', release_signed_on: null, voided_at: null });

      const released = await recordRelease({
        organizationId: ORG_ID, restrictionId: row.restriction_id, releaseSignedOn: '2026-10-20',
        actorAccountId: ADMIN_ID, actorRole: 'organization_admin',
      });
      expect(released).toMatchObject({ release_signed_on: '2026-10-20', release_recorded_by_role: 'organization_admin' });
      await expect(recordRelease({
        organizationId: ORG_ID, restrictionId: row.restriction_id, releaseSignedOn: '2026-10-21',
        actorAccountId: COACH_ID, actorRole: 'coach',
      })).rejects.toBeInstanceOf(ConflictError);

      await recordLbcInformed({
        organizationId: ORG_ID, restrictionId: row.restriction_id, lbcInformedOn: '2026-10-03',
        actorAccountId: COACH_ID, actorRole: 'coach',
      });
      await expect(recordLbcInformed({
        organizationId: ORG_ID, restrictionId: row.restriction_id, lbcInformedOn: '2026-10-04',
        actorAccountId: COACH_ID, actorRole: 'coach',
      })).rejects.toBeInstanceOf(ConflictError);

      const { rows: audits } = await client.query(
        `select event_type, entity_id, details from pilot.audit_events
          where entity_type = 'medical_restriction' order by created_at, event_type`,
      );
      expect(audits.map((a) => a.details.action)).toEqual(['record', 'release', 'lbc_informed']);
      const text = JSON.stringify(audits);
      for (const value of ['training_knockout_or_concussion', 'under_1_min', '2026-10-01', '2026-10-30', '2026-10-20', 'Test note text', 'incident-test-1']) {
        expect(text).not.toContain(value);
      }
      // Never mirrored to the SHADOW event feed.
      const { rows: mirrored } = await client.query(
        `select count(*)::int as n from pilot.shadow_events where entity_type = 'medical_restriction'`,
      );
      expect(mirrored[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a voided record takes no release and cannot be voided twice; a release before the start is refused', async () => {
    const client = await freshDatabase('medres_void');
    try {
      const row = await recordMedicalRestriction(RECORD);
      await expect(recordRelease({
        organizationId: ORG_ID, restrictionId: row.restriction_id, releaseSignedOn: '2026-09-01',
        actorAccountId: COACH_ID, actorRole: 'coach',
      })).rejects.toThrow(/before the restriction started/);
      await voidMedicalRestriction({
        organizationId: ORG_ID, restrictionId: row.restriction_id, reason: 'Entered on the wrong member',
        actorAccountId: ADMIN_ID, actorRole: 'organization_admin',
      });
      await expect(voidMedicalRestriction({
        organizationId: ORG_ID, restrictionId: row.restriction_id, reason: 'again',
        actorAccountId: ADMIN_ID, actorRole: 'organization_admin',
      })).rejects.toBeInstanceOf(ConflictError);
      await expect(recordRelease({
        organizationId: ORG_ID, restrictionId: row.restriction_id, releaseSignedOn: '2026-10-20',
        actorAccountId: COACH_ID, actorRole: 'coach',
      })).rejects.toThrow(/entered in error/);
      // Kept, not deleted.
      expect(await listMedicalRestrictions(ORG_ID, ATHLETE_ID)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('one gym never reads another gym\'s rows for the same athlete id', async () => {
    const client = await freshDatabase('medres_scope');
    try {
      await recordMedicalRestriction({ ...RECORD, athleteId: SHARED_ATHLETE_ID });
      expect(await listMedicalRestrictions(ORG_ID, SHARED_ATHLETE_ID)).toHaveLength(1);
      expect(await listMedicalRestrictions(OTHER_ORG_ID, SHARED_ATHLETE_ID)).toHaveLength(0);
      expect(await findBlockingMedicalRestriction(OTHER_ORG_ID, SHARED_ATHLETE_ID, '2026-10-10')).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('the gate probe', () => {
  // [label, row, day, blocks]
  const START = '2026-10-01';
  const END = '2026-10-30';
  const cases: Array<[string, Partial<GateFields>, string, boolean]> = [
    ['before the start', {}, '2026-09-30', false],
    ['on the start day', {}, START, true],
    ['during, no release', {}, '2026-10-15', true],
    ['during, release already on file', { release_signed_on: '2026-10-10' }, '2026-10-15', true],
    ['on the minimum end date, release on file', { release_signed_on: '2026-10-10' }, END, true],
    ['after the end, no release', {}, '2026-11-05', true],
    ['after the end, release signed later than that day', { release_signed_on: '2026-11-10' }, '2026-11-05', true],
    ['after the end, release on file', { release_signed_on: '2026-10-10' }, '2026-10-31', false],
    ['after the end, release signed that day', { release_signed_on: '2026-11-05' }, '2026-11-05', false],
    ['voided', { voided_at: '2026-10-02 00:00:00+00' }, '2026-10-15', false],
  ];

  test.each(cases)('%s: SQL and restrictionBlocksOn agree', async (_label, overrides, day, blocks) => {
    const client = await freshDatabase('medres_gate');
    try {
      const fields: GateFields = {
        start_date: START, minimum_end_date: END, release_signed_on: null, voided_at: null, ...overrides,
      };
      expect(restrictionBlocksOn(fields, day)).toBe(blocks);
      await insertRaw(client, {
        start_date: START,
        minimum_end_date: END,
        ...(fields.release_signed_on ? {
          release_signed_on: fields.release_signed_on, release_recorded_by_account_id: COACH_ID,
          release_recorded_by_role: 'coach', release_recorded_at: '2026-10-10T12:00:00Z',
        } : {}),
        ...(fields.voided_at ? {
          voided_at: fields.voided_at, voided_by_account_id: ADMIN_ID, voided_by_role: 'organization_admin', void_reason: 'test',
        } : {}),
      });
      const found = await findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, day);
      expect(found !== null).toBe(blocks);
    } finally {
      await client.end();
    }
  });

  test('a missing day or member is refused, never read as "no restriction"', async () => {
    const client = await freshDatabase('medres_gate_badinput');
    try {
      await insertRaw(client);
      for (const day of [null, undefined, '', '10/05/2026']) {
        await expect(findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, day as never)).rejects.toThrow(/PROBE_BAD_INPUT/);
      }
      await expect(findBlockingMedicalRestriction(ORG_ID, '' as never, '2026-10-05')).rejects.toThrow(/PROBE_BAD_INPUT/);
      await expect(findBlockingMedicalRestriction(null as never, ATHLETE_ID, '2026-10-05')).rejects.toThrow(/PROBE_BAD_INPUT/);
    } finally {
      await client.end();
    }
  });

  test('one lifted and one in force: the one in force blocks', async () => {
    const client = await freshDatabase('medres_gate_two');
    try {
      await insertRaw(client, {
        start_date: '2026-08-01', minimum_end_date: '2026-08-30', release_signed_on: '2026-09-01',
        release_recorded_by_account_id: COACH_ID, release_recorded_by_role: 'coach', release_recorded_at: '2026-09-01T12:00:00Z',
      });
      await insertRaw(client, { start_date: '2026-10-01', minimum_end_date: '2026-10-30' });
      const found = await findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, '2026-10-05');
      expect(found).toMatchObject({ minimum_end_date: '2026-10-30', release_signed_on: null });
      expect(Object.keys(found ?? {}).sort()).toEqual(['minimum_end_date', 'release_signed_on', 'restriction_id']);
    } finally {
      await client.end();
    }
  });

  test('before the migration: no restriction, and the caller\'s transaction carries on', async () => {
    const client = await freshDatabase('medres_gate_premigration', { preMigration: true });
    try {
      expect(await findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, '2026-10-05')).toBeNull();
      await client.query('BEGIN');
      expect(await findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, '2026-10-05', client as never)).toBeNull();
      const after = await client.query('select 1 as ok');
      expect(after.rows[0].ok).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});

describe('the staff route against real rows', () => {
  test('a coach and an admin of this gym record, read and release', async () => {
    const client = await freshDatabase('medres_route');
    try {
      mockPrincipal.mockResolvedValue(COACH);
      const created = await post(RECORD_BODY);
      expect(created.status).toBe(201);
      const { restriction } = await created.json();
      expect(restriction).toMatchObject({ athlete_id: ATHLETE_ID, recorded_by_account_id: COACH_ID });

      mockPrincipal.mockResolvedValue(ADMIN);
      const read = await get(`?athlete_id=${ATHLETE_ID}`);
      expect(read.status).toBe(200);
      expect(read.headers.get('cache-control')).toContain('no-store');
      expect((await read.json()).restrictions).toHaveLength(1);

      mockPrincipal.mockResolvedValue(COACH);
      const released = await post({ action: 'release', restriction_id: restriction.restriction_id, release_signed_on: '2026-10-31' });
      expect(released.status).toBe(200);
      const again = await post({ action: 'release', restriction_id: restriction.restriction_id, release_signed_on: '2026-11-01' });
      expect(again.status).toBe(409);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a coach of another gym', OTHER_COACH],
    ['a parent', PARENT],
    ['the athlete', ATHLETE],
    ['platform_owner', PLATFORM_OWNER],
    ['board', BOARD],
  ])('%s can neither read nor write', async (_label, who) => {
    const client = await freshDatabase('medres_route_refused');
    try {
      const { rows } = await insertRaw(client);
      const id = rows[0].restriction_id;
      mockPrincipal.mockResolvedValue(who);
      expect((await get(`?athlete_id=${ATHLETE_ID}`)).status).toBeGreaterThanOrEqual(403);
      expect((await post(RECORD_BODY)).status).toBeGreaterThanOrEqual(403);
      const release = await post({ action: 'release', restriction_id: id, release_signed_on: '2026-10-31' });
      expect([403, 404]).toContain(release.status);
      const { rows: after } = await client.query('select count(*)::int as n, count(release_signed_on)::int as r from pilot.medical_restrictions');
      expect(after[0]).toEqual({ n: 1, r: 0 });
    } finally {
      await client.end();
    }
  });

  test('a coach cannot void; an admin can, with a reason, and the row stays', async () => {
    const client = await freshDatabase('medres_route_void');
    try {
      const { rows } = await insertRaw(client);
      const id = rows[0].restriction_id;
      mockPrincipal.mockResolvedValue(COACH);
      expect((await post({ action: 'void', restriction_id: id, reason: 'wrong member' })).status).toBe(403);
      mockPrincipal.mockResolvedValue(ADMIN);
      expect((await post({ action: 'void', restriction_id: id })).status).toBe(400);
      const voided = await post({ action: 'void', restriction_id: id, reason: 'wrong member' });
      expect(voided.status).toBe(200);
      expect((await voided.json()).restriction.state).toBe('voided');
      const { rows: after } = await client.query('select count(*)::int as n from pilot.medical_restrictions where voided_at is not null');
      expect(after[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// P22b: the gate on every boxing save path, against real rows. Each save
// path's own module is called for real (its './db' is this file's mock, so
// its SQL runs on the embedded server); only the restriction rows are arranged.
// Dates are relative to the gym's today, because the gate's "today" is real.
// ---------------------------------------------------------------------------

describe('P22b: the gate on the save paths', () => {
  const TODAY = gymDayOf(new Date());
  const day = (offset: number) => {
    const at = new Date(`${TODAY}T12:00:00Z`);
    at.setUTCDate(at.getUTCDate() + offset);
    return at.toISOString().slice(0, 10);
  };
  let db: Client;

  /** A restriction for ATHLETE_ID: in force from 5 days ago to 10 days ahead, no release, unless overridden. */
  async function restrict(overrides: Record<string, unknown> = {}) {
    await insertRaw(db, { start_date: day(-5), minimum_end_date: day(10), ...overrides });
  }
  const released = (on: string) => ({
    release_signed_on: on,
    release_recorded_by_account_id: COACH_ID,
    release_recorded_by_role: 'coach',
    release_recorded_at: new Date().toISOString(),
  });
  async function refusal(work: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
    try {
      await work();
    } catch (error) {
      const e = error as { status?: number; code?: string; message: string };
      return { status: e.status ?? 0, code: e.code, message: e.message };
    }
    throw new Error('expected a refusal; the save went through');
  }
  const count = async (table: string) => (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

  async function referenceDrill(drillId: string, contactLevel: string | null) {
    if (contactLevel) {
      await db.query(
        `insert into pilot.drill_library
           (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
            standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level)
         values ($1, $2, $2, $2, 'technical', 'b', 'p', 's', 'e', 'g', 'bad', $3)`,
        [ORG_ID, `ref-${drillId}`, contactLevel],
      );
    }
    await db.query(
      `insert into pilot.drills (organization_id, drill_id, name, category, focus, difficulty, active, cues, reference_drill_id)
       values ($1, $2, $2, 'technical', 'focus', 'intermediate', true, '{"Test cue"}', $3)`,
      [ORG_ID, drillId, contactLevel ? `ref-${drillId}` : null],
    );
  }

  beforeAll(async () => {
    db = await freshDatabase('medres_save_paths');
    await db.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact') on conflict do nothing`,
      [ORG_ID],
    );
    await referenceDrill('drill-open', 'open_sparring');
    await referenceDrill('drill-controlled', 'controlled_sparring');
    await referenceDrill('drill-conditioned', 'conditioned');
    await referenceDrill('drill-plain', null);
    await db.query(
      `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
       values ($1, 'comp-soon', 'Test Bout Night', $2::date, $3)`,
      [ORG_ID, day(20), ADMIN_ID],
    );
    await db.query(
      `insert into pilot.activity_log
         (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type, occurred_on,
          duration_minutes, attendance_status, capture_method, recorded_by_role, recorded_by_account_id)
       values ($1, 'act-before', $2, $3, 'boxing_training', 'technical_session', $4::date, 60, 'present',
               'coach_override', 'coach', $2)`,
      [ORG_ID, COACH_ID, ATHLETE_ID, day(-20)],
    );
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    activeClient = db;
    await db.query("set session_replication_role = replica"); // lets the cleanup delete past the no-delete trigger
    await db.query('delete from pilot.medical_restrictions');
    await db.query("set session_replication_role = origin");
  });

  test('which days are checked: the entry day; today as well when the entry is in the future', () => {
    expect(medicalRestrictionGateDays(null, TODAY)).toEqual([TODAY]);
    expect(medicalRestrictionGateDays(day(-3), TODAY)).toEqual([day(-3)]);
    expect(medicalRestrictionGateDays(day(3), TODAY)).toEqual([day(3), TODAY]);
    expect(() => medicalRestrictionGateDays('soon', TODAY)).toThrow('MEDICAL_RESTRICTION_PROBE_BAD_INPUT');
  });

  test('a future-dated entry is refused while today is restricted, even when its own day would be clear', async () => {
    // Release on file, minimum end date still ahead: day(20) alone would pass.
    await restrict(released(day(-1)));
    expect(await findBlockingMedicalRestriction(ORG_ID, ATHLETE_ID, day(20))).toBeNull();
    const refused = await refusal(() => assertNoMedicalRestriction({ organizationId: ORG_ID, athleteId: ATHLETE_ID, entryDay: day(20) }));
    expect(refused).toMatchObject({ status: 403, code: MEDICAL_RESTRICTION_REFUSAL_CODE });
    expect(refused.message).toContain(day(10));
    expect(refused.message).not.toMatch(/physician's release is on file/); // the release is on file; only the date is ahead
    // Dated before the restriction started: a record of sparring before the injury, and it saves.
    await expect(assertNoMedicalRestriction({ organizationId: ORG_ID, athleteId: ATHLETE_ID, entryDay: day(-10) })).resolves.toBeUndefined();
  });

  test('the note says on file, the minimum end date and release needed -- never the source or loss of consciousness', async () => {
    await restrict({ source: 'training_knockout_or_concussion', loss_of_consciousness: 'over_1_min' });
    const note = await medicalRestrictionNote({ organizationId: ORG_ID, athleteId: ATHLETE_ID });
    expect(note).toEqual({
      on_file: true,
      minimum_end_date: day(10),
      release_needed: true,
      message: expect.stringContaining(day(10)),
    });
    expect(JSON.stringify(note)).not.toMatch(/knockout|concussion|over_1_min|ringside|conscious/i);
    // Two in force: the one with the later minimum end date is named.
    await restrict({ minimum_end_date: day(30) });
    expect((await medicalRestrictionNote({ organizationId: ORG_ID, athleteId: ATHLETE_ID }))?.minimum_end_date).toBe(day(30));
  });

  test('A, sparring exposure: open or controlled sparring and a blank stage are refused; conditioned saves', async () => {
    await restrict();
    const entry = {
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      sessionDate: TODAY,
      sparringType: 'technical' as const,
      timeUnderImpactSec: 120,
      coachObservedIntensity: 'light' as const,
      coachObservedHeadContact: 'none' as const,
      supervisingCoachAccountId: COACH_ID,
    };
    for (const contactStage of ['open_sparring', 'controlled_sparring'] as const) {
      expect(await refusal(() => recordSparringExposure({ ...entry, contactStage }))).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    }
    const blank = await refusal(() => recordSparringExposure(entry));
    expect(blank.message).toMatch(/say the contact stage/);
    expect(await count('pilot.sparring_exposure')).toBe(0);

    await recordSparringExposure({ ...entry, contactStage: 'conditioned' });
    expect(await count('pilot.sparring_exposure')).toBe(1);
    expect(await medicalRestrictionNote({ organizationId: ORG_ID, athleteId: ATHLETE_ID, entryDay: await sparringExposureDay(entry) }))
      .toMatchObject({ on_file: true });
    expect(await sparringExposureDay({ organizationId: ORG_ID, activityId: 'act-before' })).toBe(day(-20));

    // Q9: 'hard' is open sparring, whatever the stage says.
    const hard = await refusal(() => recordSparringExposure({ ...entry, sparringType: 'hard', contactStage: 'conditioned' }));
    expect(hard).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    expect(hard.message).toMatch(/hard sparring counts as open sparring/);

    // Q10: the restricted member cannot be the partner either; an unrestricted partner is fine.
    const asPartner = { ...entry, athleteId: SHARED_ATHLETE_ID, partnerAthleteId: ATHLETE_ID };
    const partner = await refusal(() => recordSparringExposure({ ...asPartner, contactStage: 'open_sparring' }));
    expect(partner).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    expect(partner.message).toMatch(/on file for the sparring partner named on this entry/);
    expect((await refusal(() => recordSparringExposure({ ...asPartner, sparringType: 'hard', contactStage: 'none' }))).status).toBe(403);
    expect(await count('pilot.sparring_exposure')).toBe(1);
    await recordSparringExposure({ ...asPartner, contactStage: 'light_technical' }); // below sparring: saves
    await recordSparringExposure({ ...entry, athleteId: SHARED_ATHLETE_ID, contactStage: 'open_sparring' }); // no partner named
    expect(await count('pilot.sparring_exposure')).toBe(3);

    // Linked to an activity dated before the restriction: that is the day sparred, and it saves.
    await recordSparringExposure({ ...entry, sessionDate: null, activityId: 'act-before', contactStage: 'open_sparring' });
    expect(await count('pilot.sparring_exposure')).toBe(4);
  });

  test('C/D, drill work: a sparring-level drill is not issued or logged; work below it is', async () => {
    const card = (drillId: string) => issueCoachCard({ organizationId: ORG_ID, athleteId: ATHLETE_ID, assignedByAccountId: COACH_ID, drillId });
    // Assigned before the restriction was recorded; the completion is checked on its own day.
    const earlier = await card('drill-open');
    await restrict();
    for (const drillId of ['drill-open', 'drill-controlled']) {
      expect(await refusal(() => card(drillId))).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    }
    await card('drill-conditioned');
    await card('drill-plain'); // no reference drill = no contact level
    expect(await refusal(() => recordCompletion({
      organizationId: ORG_ID, assignmentId: earlier.assignment_id, athleteId: ATHLETE_ID, repsCompleted: 1,
    }))).toMatchObject({ status: 403 });
    expect((await db.query('select count(*)::int as n from pilot.assignment_completions')).rows[0].n).toBe(0);
  });

  test('C, gap-driven assignment: a sparring-level drill is not assigned; a lower one is', async () => {
    await restrict();
    for (const gapId of ['gap-medres-1', 'gap-medres-2']) {
      await db.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ($1, $2, $3, $4, 'technique', 'Test gap', 'coach_observation') on conflict do nothing`,
        [gapId, ORG_ID, ATHLETE_ID, COACH_ID],
      );
    }
    const assign = (gapId: string, drillId: string) => assignDrill({
      organizationId: ORG_ID, gapId, athleteId: ATHLETE_ID, assignedByAccountId: COACH_ID, drillId,
    });
    const before = await count('pilot.drill_assignments');
    expect(await refusal(() => assign('gap-medres-1', 'drill-open'))).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    expect(await count('pilot.drill_assignments')).toBe(before);
    expect((await db.query(`select status from pilot.progression_gaps where gap_id = 'gap-medres-1'`)).rows[0].status).not.toBe('assigned');
    await assign('gap-medres-2', 'drill-conditioned');
    expect(await count('pilot.drill_assignments')).toBe(before + 1);
  });

  test('C, group card (Q3): the restricted member is skipped and listed; a lower card reaches them', async () => {
    await restrict();
    expect(await drillIsAtSparringLevel(ORG_ID, 'drill-controlled')).toBe(true);
    expect(await drillIsAtSparringLevel(ORG_ID, 'drill-conditioned')).toBe(false);
    expect(await drillIsAtSparringLevel(ORG_ID, 'drill-plain')).toBe(false);
    expect([...(await membersBlockedToday(ORG_ID, [ATHLETE_ID, SHARED_ATHLETE_ID]))]).toEqual([ATHLETE_ID]);

    await db.query(
      `insert into pilot.programs (organization_id, program_id, program_name, created_by_account_id)
       values ($1, 'prog-medres', 'Test Program', $2) on conflict do nothing`,
      [ORG_ID, ADMIN_ID],
    );
    for (const [index, athleteId] of [ATHLETE_ID, SHARED_ATHLETE_ID].entries()) {
      await db.query(
        `insert into pilot.program_memberships
           (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
         values ($1, $2, $3, 'Test Program', 'active', '2026-06-01'::date, $4) on conflict do nothing`,
        [ORG_ID, `mem-medres-${index}`, athleteId, ADMIN_ID],
      );
    }
    await db.query('delete from pilot.drill_assignments');
    const coachActor = { accountId: COACH_ID, role: 'coach', organizationId: ORG_ID } as Parameters<typeof issueCoachCardToProgram>[0]['actor'];
    const sparring = await issueCoachCardToProgram({ actor: coachActor, programId: 'prog-medres', drillId: 'drill-controlled' });
    expect(sparring!.issued.map((entry) => entry.athlete_id)).toEqual([SHARED_ATHLETE_ID]);
    expect(sparring!.skipped).toEqual([]);
    expect(sparring!.skipped_medical_restriction).toEqual([{ athlete_id: ATHLETE_ID, athlete_name: 'Test Member' }]);
    const lower = await issueCoachCardToProgram({ actor: coachActor, programId: 'prog-medres', drillId: 'drill-conditioned' });
    expect(lower!.issued.map((entry) => entry.athlete_id).sort()).toEqual([ATHLETE_ID, SHARED_ATHLETE_ID].sort());
    expect(lower).not.toHaveProperty('skipped_medical_restriction');
    const { rows } = await db.query(
      `select athlete_id, drill_id from pilot.drill_assignments order by drill_id, athlete_id`,
    );
    expect(rows).toEqual([
      { athlete_id: ATHLETE_ID, drill_id: 'drill-conditioned' },
      { athlete_id: SHARED_ATHLETE_ID, drill_id: 'drill-conditioned' },
      { athlete_id: SHARED_ATHLETE_ID, drill_id: 'drill-controlled' },
    ]);
  });

  test('E, workout issue: a sparring step is refused before anything is written', async () => {
    await restrict();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) } as unknown as PoolClient;
    const step = { ordinal: 1, block: 'main', scale_level: null, coach_note: null, template_item_id: 'item-1', assignment_id: 'none' };
    await db.query('BEGIN'); // the probe runs under a SAVEPOINT on the caller's transaction
    const refused = await refusal(() => recordWorkoutIssue(client, {
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      template: { template_id: 'tpl-1', name: 'Test', version: 1 },
      issuedByAccountId: COACH_ID,
      requestKey: null,
      steps: [{ ...step, contact_level: 'light_technical' }, { ...step, ordinal: 2, contact_level: 'controlled_sparring' }],
    }));
    await db.query('ROLLBACK');
    expect(refused).toMatchObject({ status: 403, code: 'MEDICAL_RESTRICTION' });
    expect(await count('pilot.workout_issues')).toBe(0);
  });

  test('F, training attempts (Q4): open, technical and game sparring refused; sparring drills save', async () => {
    await restrict();
    const attempt = (contextType: AttemptContextType) => recordAttempt({
      organizationId: ORG_ID, athleteId: ATHLETE_ID, contextType, metricKind: 'reps', targetValue: null,
      achievedValue: 3, recordedByAccountId: COACH_ID,
    });
    for (const contextType of ['open_sparring', 'technical_sparring', 'sparring_games'] as const) {
      expect(await refusal(() => attempt(contextType))).toMatchObject({ status: 403 });
    }
    await attempt('sparring_drills');
    await attempt('open_floor');
    expect(await count('pilot.training_attempts')).toBe(2);
  });

  test('G, sessions (Q5): the sparring tag is refused; an edit is refused only when it raises', async () => {
    const session = (id: string, date: string, sessionType: PilotSession['session_type']): PilotSession => ({
      session_id: id, athlete_id: ATHLETE_ID, date, rpe: null, rpe_method: 'UNKNOWN', notes: '', completed_flag: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session_type: sessionType,
    });
    const update = { mode: 'update' as const, expectedAthleteId: ATHLETE_ID, noteWriter: true };
    await upsertSession(ORG_ID, session('s-before', day(-20), 'sparring'), { mode: 'create' }); // before the restriction
    await upsertSession(ORG_ID, session('s-cond', TODAY, 'conditioning'), { mode: 'create' });
    await restrict();

    expect(await refusal(() => upsertSession(ORG_ID, session('s-new', TODAY, 'sparring'), { mode: 'create' }))).toMatchObject({ status: 403 });
    await upsertSession(ORG_ID, session('s-new2', TODAY, 'technique'), { mode: 'create' });
    // Raising conditioning to sparring: refused.
    expect(await refusal(() => upsertSession(ORG_ID, session('s-cond', TODAY, 'sparring'), update))).toMatchObject({ status: 403 });
    // Editing the old sparring row in place (RPE, type unsent): saves.
    await upsertSession(ORG_ID, {
      ...session('s-before', day(-20), undefined), rpe: 6, rpe_method: 'athlete_post_session_self_report', completed_flag: true,
    }, update);
    // Moving it into the restriction: refused.
    expect(await refusal(() => upsertSession(ORG_ID, session('s-before', TODAY, undefined), update))).toMatchObject({ status: 403 });
    // Moving another member's sparring session onto the restricted member: refused.
    await upsertSession(ORG_ID, { ...session('s-other', TODAY, 'sparring'), athlete_id: SHARED_ATHLETE_ID }, { mode: 'create' });
    expect(await refusal(() => upsertSession(
      ORG_ID,
      session('s-other', TODAY, undefined),
      { mode: 'update', expectedAthleteId: SHARED_ATHLETE_ID, noteWriter: true },
    ))).toMatchObject({ status: 403 });
    const { rows } = await db.query(`select session_id, session_type, date::text as d from pilot.sessions order by session_id`);
    expect(rows).toEqual([
      { session_id: 's-before', session_type: 'sparring', d: day(-20) },
      { session_id: 's-cond', session_type: 'conditioning', d: TODAY },
      { session_id: 's-new2', session_type: 'technique', d: TODAY },
      { session_id: 's-other', session_type: 'sparring', d: TODAY },
    ]);
  });

  test('H, competition entry (Q6): the bout date, plus today when the bout is ahead', async () => {
    const check = () => assertCompetitionClearOfMedicalRestriction({ organizationId: ORG_ID, athleteId: ATHLETE_ID, competitionId: 'comp-soon' });
    await expect(check()).resolves.toBeUndefined();
    // Starts after today but before the bout: today is clear, the bout date is not.
    await restrict({ start_date: day(15), minimum_end_date: day(40) });
    expect(await refusal(check)).toMatchObject({ status: 403 });
    // A bout already past, entered after the fact: its own day decides, not today.
    await db.query(
      `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
       values ($1, 'comp-past', 'Test Past Bout', $2::date, $3) on conflict do nothing`,
      [ORG_ID, day(-30), ADMIN_ID],
    );
    await db.query('set session_replication_role = replica');
    await db.query('delete from pilot.medical_restrictions');
    await db.query('set session_replication_role = origin');
    await restrict(); // from day(-5): today is restricted, day(-30) is not
    await expect(assertCompetitionClearOfMedicalRestriction({
      organizationId: ORG_ID, athleteId: ATHLETE_ID, competitionId: 'comp-past',
    })).resolves.toBeUndefined();
  });

  test('a lifted or voided restriction blocks nothing', async () => {
    await restrict({ start_date: day(-40), minimum_end_date: day(-10), ...released(day(-12)) });
    await restrict({
      voided_at: new Date().toISOString(), voided_by_account_id: ADMIN_ID, voided_by_role: 'organization_admin', void_reason: 'wrong member',
    });
    await expect(assertNoMedicalRestriction({ organizationId: ORG_ID, athleteId: ATHLETE_ID })).resolves.toBeUndefined();
    expect(await medicalRestrictionNote({ organizationId: ORG_ID, athleteId: ATHLETE_ID })).toBeNull();
  });
});

describe('P22b before the migration', () => {
  test('every path saves as before: no table, no restriction', async () => {
    const client = await freshDatabase('medres_save_paths_premigration', { preMigration: true });
    try {
      await recordAttempt({
        organizationId: ORG_ID, athleteId: ATHLETE_ID, contextType: 'open_sparring', metricKind: 'reps',
        targetValue: null, achievedValue: 1, recordedByAccountId: COACH_ID,
      });
      expect(await medicalRestrictionNote({ organizationId: ORG_ID, athleteId: ATHLETE_ID })).toBeNull();
      expect((await client.query('select count(*)::int as n from pilot.training_attempts')).rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
