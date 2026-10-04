// Real PostgreSQL-backed test for athleteInjuries.ts and its migration.
//
// Proves, against base schema + the migrations whose tables the injury record
// links to (data retention, decision loop, safety flags) + this migration:
// organization scoping on every read and write; that a link to a hold, plan,
// clearance or pain report is accepted only when it is THIS athlete's; the
// one-return-source and date guards (module and database); that a deleted
// athlete's injuries leave every read and refuse every write; that entered-in-
// error rows leave the list; and that the retention purge (delete from
// pilot.athletes) removes the rows with the athlete. Spins up the same
// disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.

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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-injuries-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_injuries_migration.sql';
const FLOOR_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_safety_flags_migration.sql',
];
const TEST_DB_NAME = 'ppbf_test_injuries';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-injuries-migration.mjs',
);

const ORG_A = 'org-injuries-a';
const ORG_B = 'org-injuries-b';
const COACH = 'coach-injuries';
const ATHLETE = 'ath-injured';
const OTHER_ATHLETE = 'ath-other';

// Same pattern as orgQuotes.pg.test.ts: keeps a real dynamic import for the ESM runner.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let injuries: typeof import('./athleteInjuries');
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let floorSql: string;
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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
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

  floorSql = '';
  for (const file of FLOOR_FILES) {
    floorSql += `${await fs.readFile(path.join(INFRA_DIR, file), 'utf8')}\n`;
  }
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

describe('athlete_injuries migration and athleteInjuries.ts against the real schema', () => {
  let db: Client;

  async function addAthlete(org: string, athleteId: string): Promise<void> {
    await db.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
  }

  async function addHold(org: string, athleteId: string): Promise<string> {
    const holdId = randomUUID();
    await db.query(
      `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category,
         athlete_explanation, placed_by_account_id, placed_by_role, status)
       values ($1, $2, $3, 'contact_only', 'medical', 'Resting your wrist.', $4, 'coach', 'lifted')`,
      [org, holdId, athleteId, COACH],
    );
    return holdId;
  }

  async function addPlan(org: string, athleteId: string, earliestReturn: string | null): Promise<string> {
    const planId = randomUUID();
    await db.query(
      `insert into pilot.return_to_training_plans (organization_id, plan_id, athlete_id, triggering_event,
         event_date, authority_source, earliest_return_date, entered_by_account_id, entered_by_role)
       values ($1, $2, $3, 'confirmed_concussion', '2026-09-01', 'physician', $4, $5, 'coach')`,
      [org, planId, athleteId, earliestReturn, COACH],
    );
    return planId;
  }

  async function addClearance(org: string, athleteId: string): Promise<string> {
    const result = await db.query<{ status_id: string }>(
      `insert into pilot.shadow_medical_administrative_status (organization_id, athlete_id, status,
         set_by_account_id, set_by_role)
       values ($1, $2, 'cleared', $3, 'coach') returning status_id::text`,
      [org, athleteId, COACH],
    );
    return result.rows[0].status_id;
  }

  async function addNearMiss(org: string, athleteId: string, trigger: string): Promise<string> {
    const result = await db.query<{ near_miss_id: string }>(
      `insert into pilot.shadow_near_misses (organization_id, athlete_id, description, severity,
         detected_by, metadata)
       values ($1, $2, 'Wrist hurts', 'moderate', 'system', jsonb_build_object('trigger', $3::text))
       returning near_miss_id::text`,
      [org, athleteId, trigger],
    );
    return result.rows[0].near_miss_id;
  }

  const base = {
    injuryDate: '2026-09-01',
    bodyArea: 'wrist',
    injuryType: 'sprain_strain',
    context: 'training',
    reportedBy: 'athlete',
    staffNote: 'Said it twisted on a hook.',
  };

  function record(org: string, athleteId: string, extra: Record<string, unknown> = {}) {
    return injuries.recordInjury({
      organizationId: org,
      athleteId,
      recordedByAccountId: COACH,
      recordedByRole: 'coach',
      ...base,
      ...extra,
    });
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${TEST_DB_NAME}`);
    await admin.query(`create database ${TEST_DB_NAME}`);
    await admin.end();

    db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await db.connect();
    await db.query(floorSql);
    for (const org of [ORG_A, ORG_B]) {
      await db.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active') on conflict do nothing`,
        [org],
      );
    }
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft')`,
      [COACH, ORG_A],
    );
    await addAthlete(ORG_A, ATHLETE);
    await addAthlete(ORG_A, OTHER_ATHLETE);
    await addAthlete(ORG_B, ATHLETE); // same id, a different child in another gym

    await applyMigrationTransaction(db, migrationSql);

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    injuries = await import('./athleteInjuries');
  });

  afterAll(async () => {
    await db.end();
    const { closePool } = await import('./db');
    await closePool();
  });

  test('the migration is idempotent through its runner', async () => {
    await expect(applyMigrationTransaction(db, migrationSql)).resolves.toBeUndefined();
  });

  test('a recorded injury reads back, staff note included, and lists newest first', async () => {
    const older = await record(ORG_A, ATHLETE, { injuryDate: '2026-08-01', returnedOn: '2026-08-10' });
    const newer = await record(ORG_A, ATHLETE, { injuryDate: '2026-09-02', expectedReturnDate: '2026-09-20' });
    expect(older).toMatchObject({
      athlete_id: ATHLETE,
      injury_date: '2026-08-01',
      body_area: 'wrist',
      injury_type: 'sprain_strain',
      context: 'training',
      reported_by: 'athlete',
      staff_note: 'Said it twisted on a hook.',
      returned_on: '2026-08-10',
      recorded_by_account_id: COACH,
      entered_in_error: false,
    });
    const listed = await injuries.listInjuriesForAthlete(ORG_A, ATHLETE);
    const ids = listed.map((row) => row.injury_id);
    expect(ids.indexOf(newer.injury_id)).toBeLessThan(ids.indexOf(older.injury_id));
  });

  test('another organization cannot read, edit or void the row, even for an athlete with the same id', async () => {
    const row = await record(ORG_A, ATHLETE);
    expect(await injuries.getInjuryById(ORG_B, row.injury_id)).toBeNull();
    expect((await injuries.listInjuriesForAthlete(ORG_B, ATHLETE)).map((r) => r.injury_id)).not.toContain(
      row.injury_id,
    );
    await expect(
      injuries.updateInjury({ organizationId: ORG_B, injuryId: row.injury_id, fields: base, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
    await expect(
      injuries.markInjuryEnteredInError({ organizationId: ORG_B, injuryId: row.injury_id, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
    expect((await injuries.getInjuryById(ORG_A, row.injury_id))?.entered_in_error).toBe(false);
  });

  test("links are accepted only when the linked record is this athlete's", async () => {
    const hold = await addHold(ORG_A, ATHLETE);
    const plan = await addPlan(ORG_A, ATHLETE, '2026-09-21');
    const clearance = await addClearance(ORG_A, ATHLETE);
    const pain = await addNearMiss(ORG_A, ATHLETE, 'athlete_pain_report');
    const linked = await record(ORG_A, ATHLETE, {
      injuryType: 'head_injury',
      bodyArea: 'head',
      linkedHoldId: hold,
      linkedRttPlanId: plan,
      linkedClearanceStatusId: clearance,
      linkedPainReportId: pain,
    });
    expect(linked).toMatchObject({
      linked_hold_id: hold,
      linked_rtt_plan_id: plan,
      linked_clearance_status_id: clearance,
      linked_pain_report_id: pain,
      expected_return_date: null,
      plan_earliest_return_date: '2026-09-21',
    });

    const othersHold = await addHold(ORG_A, OTHER_ATHLETE);
    const othersPlan = await addPlan(ORG_A, OTHER_ATHLETE, null);
    const othersClearance = await addClearance(ORG_A, OTHER_ATHLETE);
    const othersPain = await addNearMiss(ORG_A, OTHER_ATHLETE, 'athlete_pain_report');
    const handFlagged = await addNearMiss(ORG_A, ATHLETE, 'coach_flag');
    for (const [field, id, label] of [
      ['linkedHoldId', othersHold, 'training hold'],
      ['linkedRttPlanId', othersPlan, 'return-to-training plan'],
      ['linkedClearanceStatusId', othersClearance, 'clearance record'],
      ['linkedPainReportId', othersPain, 'pain report'],
      ['linkedPainReportId', handFlagged, 'pain report'],
    ] as const) {
      await expect(record(ORG_A, ATHLETE, { [field]: id })).rejects.toThrow(
        `The linked ${label} is not one of this athlete's records.`,
      );
    }

    // Editing onto someone else's record is refused too.
    await expect(
      injuries.updateInjury({
        organizationId: ORG_A,
        injuryId: linked.injury_id,
        fields: { ...base, linkedHoldId: othersHold },
        updatedByAccountId: COACH,
      }),
    ).rejects.toThrow("The linked training hold is not one of this athlete's records.");
  });

  test("another gym's record for a child with the same athlete id cannot be linked", async () => {
    const theirs = {
      linkedHoldId: await addHold(ORG_B, ATHLETE),
      linkedRttPlanId: await addPlan(ORG_B, ATHLETE, null),
      linkedClearanceStatusId: await addClearance(ORG_B, ATHLETE),
      linkedPainReportId: await addNearMiss(ORG_B, ATHLETE, 'athlete_pain_report'),
    };
    for (const [field, id] of Object.entries(theirs)) {
      await expect(record(ORG_A, ATHLETE, { [field]: id })).rejects.toThrow("is not one of this athlete's records.");
    }
  });

  test("the plan's return date is read from this gym's plan, never another gym's plan with the same id", async () => {
    const planId = await addPlan(ORG_A, ATHLETE, '2026-09-21');
    await db.query(
      `insert into pilot.return_to_training_plans (organization_id, plan_id, athlete_id, triggering_event,
         event_date, authority_source, earliest_return_date, entered_by_account_id, entered_by_role)
       values ($1, $2, $3, 'injury', '2026-09-01', 'physician', '2027-01-01', $4, 'coach')`,
      [ORG_B, planId, ATHLETE, COACH],
    );
    const row = await record(ORG_A, ATHLETE, { linkedRttPlanId: planId });
    const listed = (await injuries.listInjuriesForAthlete(ORG_A, ATHLETE)).filter((r) => r.injury_id === row.injury_id);
    expect(listed).toHaveLength(1);
    expect(listed[0].plan_earliest_return_date).toBe('2026-09-21');
  });

  test('a linked plan is the only expected-return source, in the module and in the database', async () => {
    const plan = await addPlan(ORG_A, ATHLETE, '2026-09-30');
    await expect(record(ORG_A, ATHLETE, { linkedRttPlanId: plan, expectedReturnDate: '2026-09-25' })).rejects.toThrow(
      'A linked return-to-training plan already holds the expected return date',
    );
    await expect(
      db.query(
        `insert into pilot.athlete_injuries (organization_id, injury_id, athlete_id, injury_date, body_area,
           injury_type, context, reported_by, expected_return_date, linked_rtt_plan_id,
           recorded_by_account_id, recorded_by_role, updated_by_account_id)
         values ($1, $2, $3, '2026-09-01', 'head', 'head_injury', 'training', 'clinician', '2026-09-25', $4,
           $5, 'coach', $5)`,
        [ORG_A, randomUUID(), ATHLETE, plan, COACH],
      ),
    ).rejects.toThrow(/pilot_athlete_injuries_one_return_source/);
  });

  test("a plan whose earliest return is before the injury cannot be linked, on record or on edit", async () => {
    const oldPlan = await addPlan(ORG_A, ATHLETE, '2026-08-15');
    const message = "The linked return-to-training plan's earliest return date is before this injury's date.";
    await expect(record(ORG_A, ATHLETE, { linkedRttPlanId: oldPlan })).rejects.toThrow(message);
    const row = await record(ORG_A, ATHLETE);
    await expect(
      injuries.updateInjury({
        organizationId: ORG_A,
        injuryId: row.injury_id,
        fields: { ...base, linkedRttPlanId: oldPlan },
        updatedByAccountId: COACH,
      }),
    ).rejects.toThrow(message);
    // The same plan is fine for an injury that happened before it ended.
    await expect(record(ORG_A, ATHLETE, { linkedRttPlanId: oldPlan, injuryDate: '2026-08-10' })).resolves.toMatchObject({
      plan_earliest_return_date: '2026-08-15',
    });
  });

  test('return dates before the injury date and unknown vocabulary are refused', async () => {
    await expect(record(ORG_A, ATHLETE, { returnedOn: '2026-08-31' })).rejects.toThrow(
      'returnedOn cannot be before injuryDate.',
    );
    await expect(record(ORG_A, ATHLETE, { expectedReturnDate: '2026-08-31' })).rejects.toThrow(
      'expectedReturnDate cannot be before injuryDate.',
    );
    for (const impossible of ['2026-02-31', '2026-04-31', '0000-01-01', '2026-13-01', '2026-9-1']) {
      await expect(record(ORG_A, ATHLETE, { injuryDate: impossible })).rejects.toThrow(
        'injuryDate must be a date (YYYY-MM-DD).',
      );
    }
    await expect(record(ORG_A, ATHLETE, { injuryType: 'concussion' })).rejects.toThrow('injuryType must be one of');
    await expect(record(ORG_A, ATHLETE, { reportedBy: 'shadow' })).rejects.toThrow('reportedBy must be one of');
    await expect(
      db.query(
        `insert into pilot.athlete_injuries (organization_id, injury_id, athlete_id, injury_date, body_area,
           injury_type, context, reported_by, returned_on, recorded_by_account_id, recorded_by_role,
           updated_by_account_id)
         values ($1, $2, $3, '2026-09-01', 'wrist', 'cut', 'training', 'athlete', '2026-08-01', $4, 'coach', $4)`,
        [ORG_A, randomUUID(), ATHLETE, COACH],
      ),
    ).rejects.toThrow(/pilot_athlete_injuries_return_after_injury/);
    await expect(
      db.query(
        `insert into pilot.athlete_injuries (organization_id, injury_id, athlete_id, injury_date, body_area,
           injury_type, context, reported_by, recorded_by_account_id, recorded_by_role, updated_by_account_id)
         values ($1, $2, $3, '2026-09-01', 'wrist', 'concussion', 'training', 'athlete', $4, 'coach', $4)`,
        [ORG_A, randomUUID(), ATHLETE, COACH],
      ),
    ).rejects.toThrow(/pilot_athlete_injuries_type_check/);
  });

  test('an update replaces the recorded fields and keeps who recorded it', async () => {
    const row = await record(ORG_A, ATHLETE);
    const updated = await injuries.updateInjury({
      organizationId: ORG_A,
      injuryId: row.injury_id,
      fields: { ...base, returnedOn: '2026-09-15', reportedBy: 'clinician', staffNote: 'Doctor: sprain.' },
      updatedByAccountId: 'admin-injuries',
    });
    expect(updated).toMatchObject({
      returned_on: '2026-09-15',
      reported_by: 'clinician',
      staff_note: 'Doctor: sprain.',
      recorded_by_account_id: COACH,
      updated_by_account_id: 'admin-injuries',
    });
  });

  test('a row entered in error leaves the list, cannot be edited, and a second mark changes nothing', async () => {
    const row = await record(ORG_A, ATHLETE);
    await injuries.markInjuryEnteredInError({ organizationId: ORG_A, injuryId: row.injury_id, updatedByAccountId: COACH });
    expect((await injuries.listInjuriesForAthlete(ORG_A, ATHLETE)).map((r) => r.injury_id)).not.toContain(row.injury_id);
    expect((await injuries.getInjuryById(ORG_A, row.injury_id))?.entered_in_error).toBe(true);
    await expect(
      injuries.updateInjury({ organizationId: ORG_A, injuryId: row.injury_id, fields: base, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
    await expect(
      injuries.markInjuryEnteredInError({ organizationId: ORG_A, injuryId: row.injury_id, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
  });

  test("a deleted athlete's injuries leave every read and refuse every write", async () => {
    const athleteId = 'ath-deleted';
    await addAthlete(ORG_A, athleteId);
    const row = await record(ORG_A, athleteId);
    await db.query(
      `update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`,
      [ORG_A, athleteId],
    );
    expect(await injuries.listInjuriesForAthlete(ORG_A, athleteId)).toEqual([]);
    expect(await injuries.getInjuryById(ORG_A, row.injury_id)).toBeNull();
    await expect(record(ORG_A, athleteId)).rejects.toThrow('Athlete not found.');
    await expect(
      injuries.updateInjury({ organizationId: ORG_A, injuryId: row.injury_id, fields: base, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
    await expect(
      injuries.markInjuryEnteredInError({ organizationId: ORG_A, injuryId: row.injury_id, updatedByAccountId: COACH }),
    ).rejects.toThrow('Injury record not found.');
  });

  test('an athlete deleted while an injury is being recorded is refused, not written', async () => {
    const athleteId = 'ath-deleted-mid-write';
    await addAthlete(ORG_A, athleteId);
    const deleter = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await deleter.connect();
    try {
      await deleter.query('begin');
      await deleter.query(
        `update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`,
        [ORG_A, athleteId],
      );
      const write = record(ORG_A, athleteId);
      const settled = write.then(() => 'written', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await deleter.query('commit');
      expect(await settled).toBe('Athlete not found.');
    } finally {
      await deleter.end();
    }
    const left = await db.query(
      'select count(*)::int as n from pilot.athlete_injuries where organization_id = $1 and athlete_id = $2',
      [ORG_A, athleteId],
    );
    expect(left.rows[0].n).toBe(0);
  });

  test('an edit that races an entered-in-error mark is refused, not reported as saved', async () => {
    const row = await record(ORG_A, ATHLETE);
    const marker = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await marker.connect();
    try {
      await marker.query('begin');
      await marker.query(
        `update pilot.athlete_injuries set entered_in_error = true where organization_id = $1 and injury_id = $2`,
        [ORG_A, row.injury_id],
      );
      const edit = injuries.updateInjury({
        organizationId: ORG_A,
        injuryId: row.injury_id,
        fields: { ...base, staffNote: 'late edit' },
        updatedByAccountId: COACH,
      });
      const settled = edit.then(() => 'saved', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await marker.query('commit');
      expect(await settled).toBe('Injury record not found.');
    } finally {
      await marker.end();
    }
  });

  test('an edit that meets a purge in progress waits, then is refused cleanly, and the purge completes', async () => {
    const athleteId = 'ath-purged-mid-edit';
    await addAthlete(ORG_A, athleteId);
    const row = await record(ORG_A, athleteId);
    const purger = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await purger.connect();
    try {
      await purger.query('begin');
      await purger.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_A, athleteId]);
      const edit = injuries.updateInjury({
        organizationId: ORG_A,
        injuryId: row.injury_id,
        fields: base,
        updatedByAccountId: COACH,
      });
      const settled = edit.then(() => 'saved', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await purger.query('commit');
      expect(await settled).toBe('Injury record not found.');
    } finally {
      await purger.end();
    }
  });

  test('the runner refuses to commit against a database the migration did not make ready', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists ppbf_test_injuries_bare');
    await admin.query('create database ppbf_test_injuries_bare');
    await admin.end();
    const bare = new Client({ connectionString: connectionStringFor('ppbf_test_injuries_bare') });
    await bare.connect();
    try {
      await expect(applyMigrationTransaction(bare, 'select 1')).rejects.toThrow('ATHLETE_INJURIES_TABLE_NOT_READY');
    } finally {
      await bare.end();
    }
  });

  test('the retention purge removes the rows with the athlete, every kind of link included', async () => {
    const athleteId = 'ath-purged';
    await addAthlete(ORG_A, athleteId);
    const hold = await addHold(ORG_A, athleteId);
    const plan = await addPlan(ORG_A, athleteId, null);
    await record(ORG_A, athleteId, {
      linkedHoldId: hold,
      linkedRttPlanId: plan,
      linkedClearanceStatusId: await addClearance(ORG_A, athleteId),
      linkedPainReportId: await addNearMiss(ORG_A, athleteId, 'athlete_pain_report'),
    });
    // The same statement pilot-cleanup-deleted-data.mjs runs.
    await db.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_A, athleteId]);
    const left = await db.query(
      'select count(*)::int as n from pilot.athlete_injuries where organization_id = $1 and athlete_id = $2',
      [ORG_A, athleteId],
    );
    expect(left.rows[0].n).toBe(0);
  });
});
