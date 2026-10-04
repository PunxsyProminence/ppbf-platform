// Real PostgreSQL-backed test for assessmentResults.ts (map items 7-8: jump
// test and coach skill ratings) against the assessment-protocols migration.
//
// What only a real database can prove:
// 1. ensurePpbfAssessmentProtocols creates the gym's 14 protocol rows, is
//    idempotent, and never overwrites a row that already exists.
// 2. A jump result and a sheet of skill ratings land on pilot.assessments
//    with the protocol foreign key satisfied, and a bad rating sheet writes
//    nothing at all.
// 3. History is ONE athlete's own record: another athlete's rows, another
//    organization's rows and a soft-deleted athlete's rows never appear, and
//    a soft-deleted athlete cannot be written to.
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
  PPBF_ASSESSMENT_PROTOCOLS,
  ensurePpbfAssessmentProtocols,
  listAthleteAssessmentHistory,
  recordJumpResult,
  recordSkillRatings,
  skillRubricProtocolId,
} from './assessmentResults';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assessment-results-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_assessment_protocols_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-assessment-protocols-migration.mjs',
);

const ORG_A = 'org-assessres-a';
const ORG_B = 'org-assessres-b';
const COACH_A = 'acct-assessres-coach-a';
const COACH_B = 'acct-assessres-coach-b';
const ATHLETE_A = 'athlete-assessres-a';
const ATHLETE_A2 = 'athlete-assessres-a2';
const ATHLETE_DELETED = 'athlete-assessres-deleted';
const ATHLETE_B = 'athlete-assessres-b';
const TODAY = '2026-10-04';
const WRITER_A = { organizationId: ORG_A, accountId: COACH_A, role: 'coach' };
const WRITER_B = { organizationId: ORG_B, accountId: COACH_B, role: 'coach' };

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

async function insertAthlete(client: Client, org: string, athleteId: string, coach: string): Promise<void> {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1,$2,$2,'2010-01-01','120lb','active','Contact',true,$3,now(),now())`,
    [org, athleteId, coach],
  );
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
  await applyMigrationTransaction(client, migrationSql);
  // athletes.deleted_at is owned by the data-retention migration; added here
  // in that migration's own words so the soft-delete predicate is exercised.
  await client.query('alter table pilot.athletes add column if not exists deleted_at timestamptz null');

  for (const [org, coach] of [[ORG_A, COACH_A], [ORG_B, COACH_B]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
      [coach, org],
    );
  }
  await insertAthlete(client, ORG_A, ATHLETE_A, COACH_A);
  await insertAthlete(client, ORG_A, ATHLETE_A2, COACH_A);
  await insertAthlete(client, ORG_A, ATHLETE_DELETED, COACH_A);
  await insertAthlete(client, ORG_B, ATHLETE_B, COACH_B);

  activeClient = client;
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
});

describe('assessment results against real Postgres', () => {
  let client: Client;

  beforeAll(async () => {
    client = await freshDatabase('ppbf_test_assessres');
  });

  afterAll(async () => {
    activeClient = null;
    await client.end();
  });

  test('ensure creates all 14 protocols for the org only, is idempotent, and never overwrites', async () => {
    await ensurePpbfAssessmentProtocols(ORG_A);
    await client.query(
      `update pilot.assessment_protocols set protocol_summary = 'coach edited'
       where organization_id = $1 and protocol_id = 'ppbf-jump-cmj-height'`,
      [ORG_A],
    );
    await ensurePpbfAssessmentProtocols(ORG_A);

    const rows = await client.query(
      `select organization_id, protocol_id, measure_kind, protocol_summary, reliability_status,
              minimal_detectable_change, retest_interval_days
       from pilot.assessment_protocols order by protocol_id`,
    );
    expect(rows.rows).toHaveLength(PPBF_ASSESSMENT_PROTOCOLS.length);
    expect(PPBF_ASSESSMENT_PROTOCOLS).toHaveLength(14);
    expect(rows.rows.every((r) => r.organization_id === ORG_A)).toBe(true);
    expect(rows.rows.filter((r) => r.measure_kind === 'physical_test')).toHaveLength(2);
    expect(rows.rows.filter((r) => r.measure_kind === 'skill_rubric')).toHaveLength(12);
    expect(rows.rows.find((r) => r.protocol_id === 'ppbf-jump-cmj-height')?.protocol_summary).toBe('coach edited');
    // No invented measurement properties.
    for (const r of rows.rows) {
      expect(r.reliability_status).toBe('UNVALIDATED - PPBF MUST ESTABLISH');
      expect(r.minimal_detectable_change).toBeNull();
      expect(r.retest_interval_days).toBeNull();
    }

    await ensurePpbfAssessmentProtocols(ORG_B);
  });

  test('a jump result is stored against its protocol and read back', async () => {
    const entry = await recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_A,
      protocolId: 'ppbf-jump-cmj-height',
      valueCm: 41.27,
      administeredOn: '2026-10-01',
      note: 'My Jump app',
      today: TODAY,
    });
    expect(entry).toMatchObject({
      kind: 'jump',
      protocol_id: 'ppbf-jump-cmj-height',
      administered_on: '2026-10-01',
      value: 41.3,
      assessor_role: 'coach',
      note: 'My Jump app',
    });

    const broad = await recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_A,
      protocolId: 'ppbf-jump-broad-distance',
      valueCm: 198,
      today: TODAY,
    });
    expect(broad.administered_on).toBe(TODAY);
  });

  test('a rating sheet writes one row per family in one statement; a bad sheet writes nothing', async () => {
    const entries = await recordSkillRatings(WRITER_A, {
      athleteId: ATHLETE_A,
      ratings: [
        { skill_family_id: 'SKILL-01', level: 3 },
        { skill_family_id: 'SKILL-02', level: 4 },
      ],
      administeredOn: '2026-10-02',
      today: TODAY,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.skill_family_id, e.value, e.protocol_id])).toEqual(
      expect.arrayContaining([
        ['SKILL-01', 3, skillRubricProtocolId('SKILL-01')],
        ['SKILL-02', 4, skillRubricProtocolId('SKILL-02')],
      ]),
    );

    const before = await client.query('select count(*)::int as n from pilot.assessments');
    await expect(
      recordSkillRatings(WRITER_A, {
        athleteId: ATHLETE_A,
        ratings: [{ skill_family_id: 'SKILL-03', level: 2 }, { skill_family_id: 'SKILL-04', level: 6 }],
        today: TODAY,
      }),
    ).rejects.toThrow(/whole number from 1 to 5/);
    await expect(
      recordSkillRatings(WRITER_A, {
        athleteId: ATHLETE_A,
        ratings: [{ skill_family_id: 'SKILL-03', level: 2 }, { skill_family_id: 'SKILL-03', level: 3 }],
        today: TODAY,
      }),
    ).rejects.toThrow(/once per entry/);
    const after = await client.query('select count(*)::int as n from pilot.assessments');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('validation refuses future dates, unknown protocols and implausible values', async () => {
    await expect(recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_A, protocolId: 'ppbf-jump-cmj-height', valueCm: 40, administeredOn: '2026-10-05', today: TODAY,
    })).rejects.toThrow(/future/);
    await expect(recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_A, protocolId: 'imtp', valueCm: 40, today: TODAY,
    })).rejects.toThrow(/countermovement jump or the broad jump/);
    await expect(recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_A, protocolId: 'ppbf-jump-cmj-height', valueCm: 4100, today: TODAY,
    })).rejects.toThrow(/centimetres/);
    // Date.parse would roll these over; they must be a 400, not a database 500.
    for (const bad of ['2026-02-31', '2026-04-31', '0000-01-01']) {
      await expect(recordJumpResult(WRITER_A, {
        athleteId: ATHLETE_A, protocolId: 'ppbf-jump-cmj-height', valueCm: 40, administeredOn: bad, today: TODAY,
      })).rejects.toThrow(/must be a date/);
    }
    // Rounded before the bounds, so a value that rounds to 0 or 500 is refused.
    for (const bad of [0.04, 499.96]) {
      await expect(recordJumpResult(WRITER_A, {
        athleteId: ATHLETE_A, protocolId: 'ppbf-jump-cmj-height', valueCm: bad, today: TODAY,
      })).rejects.toThrow(/centimetres/);
    }
  });

  test('history is the one athlete\'s own record, newest first', async () => {
    await recordJumpResult(WRITER_A, { athleteId: ATHLETE_A2, protocolId: 'ppbf-jump-cmj-height', valueCm: 30, today: TODAY });
    await recordJumpResult(WRITER_B, { athleteId: ATHLETE_B, protocolId: 'ppbf-jump-cmj-height', valueCm: 50, today: TODAY });

    const history = await listAthleteAssessmentHistory(ORG_A, ATHLETE_A);
    expect(history).toHaveLength(4);
    expect(history.map((h) => h.administered_on)).toEqual([TODAY, '2026-10-02', '2026-10-02', '2026-10-01']);
    expect(history.some((h) => h.value === 30 || h.value === 50)).toBe(false);

    // Same athlete id asked of the wrong organization returns nothing.
    expect(await listAthleteAssessmentHistory(ORG_B, ATHLETE_A)).toEqual([]);
  });

  test('a soft-deleted athlete is neither written to nor read', async () => {
    await recordJumpResult(WRITER_A, { athleteId: ATHLETE_DELETED, protocolId: 'ppbf-jump-cmj-height', valueCm: 33, today: TODAY });
    await client.query(
      'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
      [ORG_A, ATHLETE_DELETED],
    );

    expect(await listAthleteAssessmentHistory(ORG_A, ATHLETE_DELETED)).toEqual([]);
    await expect(recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_DELETED, protocolId: 'ppbf-jump-cmj-height', valueCm: 34, today: TODAY,
    })).rejects.toThrow(/^Forbidden/);
    await expect(recordSkillRatings(WRITER_A, {
      athleteId: ATHLETE_DELETED, ratings: [{ skill_family_id: 'SKILL-01', level: 2 }], today: TODAY,
    })).rejects.toThrow(/^Forbidden/);
  });

  test('a writer cannot place a row in another organization\'s athlete', async () => {
    await expect(recordJumpResult(WRITER_A, {
      athleteId: ATHLETE_B, protocolId: 'ppbf-jump-cmj-height', valueCm: 34, today: TODAY,
    })).rejects.toThrow(/^Forbidden/);
  });
});
