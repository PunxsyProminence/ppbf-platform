// Real PostgreSQL-backed contract test for competenceCohorts.ts running
// against a real transaction. The migration itself is covered by
// competenceCohorts.pg.test.ts; this suite covers the READ MODULE, whose SQL
// is otherwise never executed anywhere.
//
// Four things need proving, and none can be proven by reading the SQL or by a
// mocked-query unit test:
//
// 1. getAthleteCompetence returns only the CURRENT level per domain. The
//    migration keeps history rather than overwriting, so a module that forgot
//    `superseded_by is null` would return every assessment an athlete ever had
//    and let an arbitrary one win.
// 2. pilot.v_athlete_tenure inner-joins pilot.activity_log, so an athlete with
//    no logged training has NO ROW rather than a row of zeroes. The module must
//    report that as null, and the eligibility logic must treat null as
//    "unestablished" rather than as a wildcard.
// 3. tenure_band bands on TRAINING HOURS, not the calendar: an athlete enrolled
//    a long time with few sessions must not band as experienced.
// 4. Reads are organization-scoped, including when an athlete_id is known.
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

import {
  getAthleteCohortReport,
  getAthleteCompetence,
  getAthleteTenure,
  listCohortDefinitions,
  listCompetenceLevels,
} from './competenceCohorts';

jest.setTimeout(180_000);

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

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-competence-cohorts-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-competence-cohorts-migration.mjs',
);

// pilot.athlete_competence FKs to pilot.athletes, and pilot.v_athlete_tenure
// reads pilot.activity_log -- so the activity-log migration is a genuine
// prerequisite, exactly as APPLY_ORDER.md records.
const PREREQUISITE_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
];

const ORG_A = 'org-cohort-a';
const ORG_B = 'org-cohort-b';
const COACH_A = 'acct-cohort-coach-a';
const COACH_B = 'acct-cohort-coach-b';
const ATH_A = 'ath-cohort-a';
const ATH_B = 'ath-cohort-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

async function addCompetence(opts: {
  org: string;
  competenceId: string;
  athleteId: string;
  domain: string;
  levelKey: string;
  coach: string;
  supersededBy?: string | null;
}): Promise<void> {
  await client.query(
    `insert into pilot.athlete_competence
       (organization_id, competence_id, athlete_id, domain, level_key, basis,
        assessed_by_account_id, assessed_on, superseded_by)
     values ($1,$2,$3,$4,$5,'coach_observation',$6,current_date,$7)`,
    [opts.org, opts.competenceId, opts.athleteId, opts.domain, opts.levelKey, opts.coach, opts.supersededBy ?? null],
  );
}

async function logSessions(org: string, athleteId: string, count: number, minutesEach: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await client.query(
      `insert into pilot.activity_log
         (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
          activity_type, occurred_on, duration_minutes, capture_method, recorded_by_role,
          recorded_by_account_id)
       values ($1,$2,$3,$4,'boxing_training','technical_session', current_date - $5::int, $6,
               'coach_override','coach',$3)`,
      [org, `act-${athleteId}-${i}`, org === ORG_A ? COACH_A : COACH_B, athleteId, i, minutesEach],
    );
  }
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

  const prerequisiteSql = await Promise.all(
    PREREQUISITE_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  const migrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_competence_cohorts_migration.sql'),
    'utf8',
  );

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  const applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    c: Client,
    sql: string,
  ) => Promise<void>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_test_competence_cohorts_module');
  await admin.query('create database ppbf_test_competence_cohorts_module');
  await admin.end();

  client = new Client({
    connectionString: connectionStringFor('ppbf_test_competence_cohorts_module'),
  });
  await client.connect();
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }
  await applyMigrationTransaction(client, migrationSql);

  for (const [org, coach, athlete] of [[ORG_A, COACH_A, ATH_A], [ORG_B, COACH_B, ATH_B]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1,$1,'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1,'coach',$2,'microsoft') on conflict do nothing`,
      [coach, org],
    );
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1,$2,'Test Athlete','2008-06-15','novice','active','n/a',true,$3,now(),now())
       on conflict do nothing`,
      [org, athlete, coach],
    );
    await client.query(
      `insert into pilot.competence_levels (organization_id, level_key, ordinal, display_name, observable_test)
       values ($1,'exploring',1,'Exploring','sees it'),
              ($1,'adapting',4,'Adapting','adapts under pressure'),
              ($1,'owning',6,'Owning','owns it')
       on conflict do nothing`,
      [org],
    );
  }

  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  if (client) await client.end();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.query('delete from pilot.athlete_competence');
  await client.query('delete from pilot.activity_log');
  await client.query('delete from pilot.cohort_definitions');
});

describe('getAthleteCompetence against real Postgres', () => {
  test('returns only the current level per domain, not the whole history', async () => {
    // The superseded row is the OLD one; history is kept rather than overwritten.
    await addCompetence({ org: ORG_A, competenceId: 'c-old', athleteId: ATH_A, domain: 'defense', levelKey: 'exploring', coach: COACH_A, supersededBy: 'c-new' });
    await addCompetence({ org: ORG_A, competenceId: 'c-new', athleteId: ATH_A, domain: 'defense', levelKey: 'adapting', coach: COACH_A });

    const rows = await getAthleteCompetence(ORG_A, ATH_A);

    expect(rows).toHaveLength(1);
    expect(rows[0].level_key).toBe('adapting');
    expect(rows[0].ordinal).toBe(4);
  });

  test('joins the ladder so the ordinal comes from competence_levels, not the caller', async () => {
    await addCompetence({ org: ORG_A, competenceId: 'c-1', athleteId: ATH_A, domain: 'composure', levelKey: 'owning', coach: COACH_A });

    const rows = await getAthleteCompetence(ORG_A, ATH_A);

    expect(rows[0].ordinal).toBe(6);
    expect(rows[0].display_name).toBe('Owning');
  });

  test('does not read another organization\'s assessments', async () => {
    await addCompetence({ org: ORG_B, competenceId: 'c-b', athleteId: ATH_B, domain: 'defense', levelKey: 'owning', coach: COACH_B });

    expect(await getAthleteCompetence(ORG_A, ATH_B)).toEqual([]);
  });
});

describe('getAthleteTenure against real Postgres', () => {
  test('returns null for an athlete with no logged training, not a row of zeroes', async () => {
    // v_athlete_tenure inner-joins activity_log. A caller that expected zeroes
    // would read this absence as an error rather than as "no history yet".
    expect(await getAthleteTenure(ORG_A, ATH_A)).toBeNull();
  });

  test('bands on training hours, not on the calendar', async () => {
    // Five sessions is below the 6-session floor, so however long ago the first
    // one was, this athlete has insufficient history rather than experience.
    await logSessions(ORG_A, ATH_A, 5, 120);

    const tenure = await getAthleteTenure(ORG_A, ATH_A);

    expect(tenure?.tenure_band).toBe('insufficient_history');
    expect(tenure?.sessions_logged).toBe(5);
  });

  test('a long-enrolled but rarely-attending athlete does not band as experienced', async () => {
    // 10 sessions of 30 minutes is 300 minutes -- under the 900-minute
    // 'introduction' ceiling, despite the sessions spanning ten days.
    await logSessions(ORG_A, ATH_A, 10, 30);

    expect((await getAthleteTenure(ORG_A, ATH_A))?.tenure_band).toBe('introduction');
  });

  test('accumulated hours move the band up', async () => {
    // 40 sessions x 120 minutes = 4800 minutes, past the 3600 'development' floor.
    await logSessions(ORG_A, ATH_A, 40, 120);

    expect((await getAthleteTenure(ORG_A, ATH_A))?.tenure_band).toBe('development');
  });

  test('does not read another organization\'s activity', async () => {
    await logSessions(ORG_B, ATH_B, 40, 120);

    expect(await getAthleteTenure(ORG_A, ATH_B)).toBeNull();
  });
});

describe('listCohortDefinitions and listCompetenceLevels against real Postgres', () => {
  async function addCohort(org: string, cohortId: string, overrides: Record<string, unknown> = {}) {
    const row = {
      cohort_name: cohortId,
      min_level_ordinal: null,
      active_flag: true,
      min_age_regulatory: null,
      regulatory_basis: '',
      ...overrides,
    };
    await client.query(
      `insert into pilot.cohort_definitions
         (organization_id, cohort_id, cohort_name, min_level_ordinal, active_flag,
          min_age_regulatory, regulatory_basis)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [org, cohortId, row.cohort_name, row.min_level_ordinal, row.active_flag,
        row.min_age_regulatory, row.regulatory_basis],
    );
  }

  test('hides inactive cohorts by default but keeps them', async () => {
    await addCohort(ORG_A, 'coh-live');
    await addCohort(ORG_A, 'coh-dead', { active_flag: false });

    expect((await listCohortDefinitions(ORG_A)).map((c) => c.cohort_id)).toEqual(['coh-live']);
    expect(await listCohortDefinitions(ORG_A, { includeInactive: true })).toHaveLength(2);
  });

  test('an unset discipline filter does not narrow the result set', async () => {
    await addCohort(ORG_A, 'coh-1');

    expect(await listCohortDefinitions(ORG_A)).toHaveLength(1);
    expect(await listCohortDefinitions(ORG_A, {})).toHaveLength(1);
  });

  test('the ladder comes back lowest rung first', async () => {
    const levels = await listCompetenceLevels(ORG_A);
    expect(levels.map((l) => l.ordinal)).toEqual([1, 4, 6]);
  });

  test('the database refuses an age bound with no cited rulebook', async () => {
    // pilot_cohortdef_reg_basis. Proven here rather than assumed, because the
    // module surfaces the citation on the strength of this constraint holding.
    await expect(
      addCohort(ORG_A, 'coh-bad', { min_age_regulatory: 15, regulatory_basis: '' }),
    ).rejects.toThrow(/pilot_cohortdef_reg_basis/);
  });
});

describe('getAthleteCohortReport against real Postgres', () => {
  test('returns null for an athlete in another organization', async () => {
    expect(await getAthleteCohortReport(ORG_A, ATH_B)).toBeNull();
  });

  test('assembles competence, tenure and fits for a real athlete', async () => {
    await addCompetence({ org: ORG_A, competenceId: 'c-1', athleteId: ATH_A, domain: 'defense', levelKey: 'adapting', coach: COACH_A });
    await logSessions(ORG_A, ATH_A, 40, 120);
    await client.query(
      `insert into pilot.cohort_definitions
         (organization_id, cohort_id, cohort_name, min_level_ordinal, required_domains, tenure_bands)
       values ($1,'coh-1','Pressure Group',4,'defense','development,established')`,
      [ORG_A],
    );

    const report = await getAthleteCohortReport(ORG_A, ATH_A);

    expect(report?.tenure?.tenure_band).toBe('development');
    expect(report?.competence).toHaveLength(1);
    expect(report?.fits).toHaveLength(1);
    expect(report?.fits[0].eligible).toBe(true);
  });

  test('an athlete with no training is excluded from a room that requires tenure', async () => {
    await addCompetence({ org: ORG_A, competenceId: 'c-1', athleteId: ATH_A, domain: 'defense', levelKey: 'adapting', coach: COACH_A });
    await client.query(
      `insert into pilot.cohort_definitions
         (organization_id, cohort_id, cohort_name, min_level_ordinal, required_domains, tenure_bands)
       values ($1,'coh-1','Pressure Group',4,'defense','development,established')`,
      [ORG_A],
    );

    const report = await getAthleteCohortReport(ORG_A, ATH_A);

    expect(report?.tenure).toBeNull();
    expect(report?.fits[0].eligible).toBe(false);
    expect(report?.fits[0].unmet[0]).toMatch(/No logged training yet/);
  });

  test('derives an age rather than reading an age column', async () => {
    // There is no age or age-band column anywhere; age is derived from dob at
    // read time. A fixed `now` keeps this assertion stable.
    const report = await getAthleteCohortReport(ORG_A, ATH_A, { now: new Date('2026-06-16T12:00:00Z') });

    expect(report?.age_years).toBe(18);
  });
});
