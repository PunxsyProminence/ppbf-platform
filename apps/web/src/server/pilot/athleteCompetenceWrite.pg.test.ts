// Real PostgreSQL-backed test for competenceWrite.ts, the one writer of
// pilot.athlete_competence (OD-2026-10-03-002 section 6: a coach sets an
// athlete's level by hand).
//
// What only a real database can prove:
// 1. History is kept: a change supersedes the current row and inserts a new
//    one, and the one-current-row partial index is never violated.
// 2. The audit row commits and rolls back with the write.
// 3. Who may write is the existing guard: assigned coach, covering coach, the
//    athlete's own organization admin -- and nobody else, with nothing written
//    on a refusal.
// 4. Two saves at once leave exactly one current row (the athlete-row lock),
//    and a delete that lands mid-save is seen and refused.
// 5. Cohort placement reads the written level.
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

import type { ActorIdentity } from './access';
import { getAthleteCohortReport, gymToday } from './competenceCohorts';
import { setAthleteCompetence } from './competenceWrite';

jest.setTimeout(180_000);

let activeClient: Client | null = null;
let databaseUrl = '';

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  // A FRESH connection per transaction, as the pool gives production, so two
  // concurrent saves really are two sessions contending for the same lock.
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const { Client: PgClient } = jest.requireActual('pg') as typeof import('pg');
    const tx = new PgClient({ connectionString: databaseUrl });
    await tx.connect();
    try {
      await tx.query('BEGIN');
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await tx.end();
    }
  }),
}));

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-competence-write-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-competence-cohorts-migration.mjs',
);
const DATABASE = 'ppbf_test_athlete_competence_write';

// athlete_competence FKs to athletes; the cohort view reads activity_log;
// the access guard reads athletes.deleted_at (data-retention migration).
const PREREQUISITE_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG = 'org-comp-write-a';
const OTHER_ORG = 'org-comp-write-b';
const COACH = 'acct-comp-coach';
const OTHER_COACH = 'acct-comp-coach-other';
const COVER_COACH = 'acct-comp-coach-cover';
const ADMIN = 'acct-comp-admin';
const OTHER_ADMIN = 'acct-comp-admin-b';
const ATH = 'ath-comp-1';

const coach: ActorIdentity = { accountId: COACH, role: 'coach', organizationId: ORG, athleteId: null };
const otherCoach: ActorIdentity = { accountId: OTHER_COACH, role: 'coach', organizationId: ORG, athleteId: null };
const coverCoach: ActorIdentity = { accountId: COVER_COACH, role: 'coach', organizationId: ORG, athleteId: null };
const orgAdmin: ActorIdentity = { accountId: ADMIN, role: 'organization_admin', organizationId: ORG, athleteId: null };
const otherOrgAdmin: ActorIdentity = { accountId: OTHER_ADMIN, role: 'organization_admin', organizationId: OTHER_ORG, athleteId: null };

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

async function competenceRows() {
  return (await client.query<{
    competence_id: string; domain: string; level_key: string; basis: string;
    assessed_by_account_id: string; assessed_on: string; evidence_note: string; superseded_by: string | null;
  }>(
    `select competence_id, domain, level_key, basis, assessed_by_account_id,
            to_char(assessed_on, 'YYYY-MM-DD') as assessed_on, evidence_note, superseded_by
     from pilot.athlete_competence where organization_id = $1 and athlete_id = $2
     order by assessed_on, competence_id`,
    [ORG, ATH],
  )).rows;
}

async function auditRows() {
  return (await client.query<{ event_type: string; actor_account_id: string; entity_id: string; details: Record<string, unknown> }>(
    `select event_type, actor_account_id, entity_id, details from pilot.audit_events
     where entity_type = 'athlete_competence' order by audit_id`,
  )).rows;
}

const footwork = (levelKey: string, evidenceNote = '') => ({
  athleteId: ATH, domain: 'footwork' as const, levelKey, evidenceNote,
});

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
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();

  databaseUrl = connectionStringFor(DATABASE);
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }
  await applyMigrationTransaction(client, migrationSql);

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1,$1,'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.competence_levels (organization_id, level_key, ordinal, display_name, observable_test)
       values ($1,'exploring',1,'Exploring','sees it'), ($1,'adapting',4,'Adapting','adapts under pressure')`,
      [org],
    );
  }
  // A level only the other gym has: the write must not accept it here.
  await client.query(
    `insert into pilot.competence_levels (organization_id, level_key, ordinal, display_name, observable_test)
     values ($1,'other_gym_only',9,'Other','n/a')`,
    [OTHER_ORG],
  );
  for (const [account, role, org] of [
    [COACH, 'coach', ORG], [OTHER_COACH, 'coach', ORG], [COVER_COACH, 'coach', ORG],
    [ADMIN, 'organization_admin', ORG], [OTHER_ADMIN, 'organization_admin', OTHER_ORG],
  ]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1,$2,$3,'microsoft')`,
      [account, role, org],
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
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  // On Windows kill() terminates the server script outright, so Postgres may
  // still hold files here for a moment (the drillLifecycle.pg.test.ts pattern;
  // a leftover folder is swept by the next run's sweepStaleDataDirs).
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

beforeEach(async () => {
  await client.query('drop trigger if exists fail_competence_audit on pilot.audit_events');
  await client.query('delete from pilot.audit_events');
  await client.query('delete from pilot.cohort_definitions');
  await client.query('delete from pilot.coach_coverage');
  await client.query('delete from pilot.athletes'); // cascades athlete_competence
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,'Test Athlete','2012-06-15','novice','active','n/a',true,$3,now(),now())`,
    [ORG, ATH, COACH],
  );
});

describe('setAthleteCompetence: recording and history', () => {
  test('the assigned coach sets a first level: coach_observation, today, audited as create', async () => {
    const result = await setAthleteCompetence(coach, footwork('exploring', 'stays on the balls of the feet'));

    expect(result).toMatchObject({ changed: true, level_key: 'exploring', previous_level_key: null });
    const rows = await competenceRows();
    expect(rows).toEqual([expect.objectContaining({
      competence_id: result.competence_id,
      domain: 'footwork',
      level_key: 'exploring',
      basis: 'coach_observation',
      assessed_by_account_id: COACH,
      assessed_on: gymToday(),
      evidence_note: 'stays on the balls of the feet',
      superseded_by: null,
    })]);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: 'create', actor_account_id: COACH, entity_id: result.competence_id });
    expect(audit[0].details).toMatchObject({
      athlete_id: ATH, domain: 'footwork', level_key: 'exploring', previous_level_key: null, has_evidence_note: true,
    });
    // The free-text note about a child is not copied into the audit stream.
    expect(JSON.stringify(audit[0].details)).not.toContain('balls of the feet');
  });

  test('a change supersedes the current row, keeps it, and is audited as update', async () => {
    const first = await setAthleteCompetence(coach, footwork('exploring'));
    const second = await setAthleteCompetence(coach, footwork('adapting'));

    expect(second).toMatchObject({ changed: true, previous_level_key: 'exploring' });
    const rows = await competenceRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.competence_id === first.competence_id)?.superseded_by).toBe(second.competence_id);
    expect(rows.find((r) => r.competence_id === second.competence_id)?.superseded_by).toBeNull();

    const audit = await auditRows();
    expect(audit.map((a) => a.event_type)).toEqual(['create', 'update']);
    expect(audit[1].details).toMatchObject({ previous_level_key: 'exploring', previous_competence_id: first.competence_id });
  });

  test('saving the level already held writes nothing', async () => {
    const first = await setAthleteCompetence(coach, footwork('exploring'));
    const again = await setAthleteCompetence(coach, footwork('exploring', 'new note'));

    expect(again).toMatchObject({ changed: false, competence_id: first.competence_id });
    expect(await competenceRows()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  test('a level not on this gym ladder is refused, including one from another gym', async () => {
    await expect(setAthleteCompetence(coach, footwork('no_such_level'))).rejects.toMatchObject({ status: 400 });
    await expect(setAthleteCompetence(coach, footwork('other_gym_only'))).rejects.toMatchObject({ status: 400 });
    expect(await competenceRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  test('an audit failure rolls the level back with it', async () => {
    await client.query(`create or replace function pg_temp_fail_audit() returns trigger language plpgsql as
      $$ begin raise exception 'audit refused'; end $$`);
    await client.query(`create trigger fail_competence_audit before insert on pilot.audit_events
      for each row execute function pg_temp_fail_audit()`);

    await expect(setAthleteCompetence(coach, footwork('exploring'))).rejects.toThrow('audit refused');
    expect(await competenceRows()).toHaveLength(0);
  });
});

describe('setAthleteCompetence: who may', () => {
  test('a coach actively covering the athlete may set a level', async () => {
    await client.query(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1,$2,$3,$4, now() - interval '1 hour', now() + interval '2 hours')`,
      [ORG, ATH, COVER_COACH, ADMIN],
    );

    await expect(setAthleteCompetence(coverCoach, footwork('exploring'))).resolves.toMatchObject({ changed: true });
  });

  test('a coach whose coverage has expired is refused, and nothing is written', async () => {
    await client.query(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1,$2,$3,$4, now() - interval '3 hours', now() - interval '1 hour')`,
      [ORG, ATH, COVER_COACH, ADMIN],
    );

    await expect(setAthleteCompetence(coverCoach, footwork('exploring'))).rejects.toThrow(/^Forbidden/);
    expect(await competenceRows()).toHaveLength(0);
  });

  test('a coach in the same gym with no relationship to the athlete is refused', async () => {
    await expect(setAthleteCompetence(otherCoach, footwork('exploring'))).rejects.toThrow(/^Forbidden/);
    expect(await competenceRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  test('the athlete own organization admin may set a level', async () => {
    await expect(setAthleteCompetence(orgAdmin, footwork('adapting'))).resolves.toMatchObject({ changed: true });
    expect((await competenceRows())[0].assessed_by_account_id).toBe(ADMIN);
  });

  test('another gym organization admin is refused', async () => {
    await expect(setAthleteCompetence(otherOrgAdmin, footwork('exploring'))).rejects.toThrow(/^Forbidden/);
    expect(await competenceRows()).toHaveLength(0);
  });

  test.each([
    ['the athlete themselves', { accountId: 'acct-ath', role: 'athlete', organizationId: ORG, athleteId: ATH }],
    ['a parent', { accountId: 'acct-parent', role: 'parent', organizationId: ORG, athleteId: null }],
    ['the platform owner', { accountId: 'acct-owner', role: 'platform_owner', organizationId: ORG, athleteId: null }],
  ] as [string, ActorIdentity][])('%s is refused by role before any read', async (_label, actor) => {
    await expect(setAthleteCompetence(actor, footwork('exploring'))).rejects.toMatchObject({ status: 403 });
    expect(await competenceRows()).toHaveLength(0);
  });

  test('a deleted athlete is refused', async () => {
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATH]);

    await expect(setAthleteCompetence(coach, footwork('exploring'))).rejects.toThrow(/^Forbidden/);
    expect(await competenceRows()).toHaveLength(0);
  });
});

describe('setAthleteCompetence: concurrency', () => {
  test('two saves at once for the same area queue on the athlete lock and leave exactly one current row', async () => {
    // Hold the athlete row so both saves are provably in flight together:
    // without the writer's own lock they would not wait here at all.
    const holder = new Client({ connectionString: databaseUrl });
    await holder.connect();
    let results;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for no key update`,
        [ORG, ATH],
      );
      const saves = Promise.all([
        setAthleteCompetence(coach, footwork('exploring')),
        setAthleteCompetence(orgAdmin, footwork('adapting')),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await competenceRows()).toHaveLength(0);
      await holder.query('COMMIT');
      results = await saves;
    } finally {
      await holder.end();
    }

    expect(results.every((r) => r.changed)).toBe(true);
    const rows = await competenceRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.superseded_by === null)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(2);
  });

  test('a delete that commits while a save waits on the lock is seen, and the save is refused', async () => {
    // Pass the guard first, then hold the athlete row the way a deletion does.
    const deleter = new Client({ connectionString: databaseUrl });
    await deleter.connect();
    try {
      await deleter.query('BEGIN');
      await deleter.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATH]);

      // The guard reads committed state (not yet deleted) and admits the coach;
      // the transaction then blocks on the row lock until the delete commits.
      const save = setAthleteCompetence(coach, footwork('exploring'));
      const outcome = save.then(() => 'saved', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await deleter.query('COMMIT');

      await expect(outcome).resolves.toMatch(/^Forbidden/);
    } finally {
      await deleter.end();
    }
    expect(await competenceRows()).toHaveLength(0);
  });
});

describe('setAthleteCompetence: the guard is re-checked under the lock', () => {
  test('a reassignment that commits while the save waits is seen, with the guard own refusal', async () => {
    const other = new Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`update pilot.athletes set coach_id = $3 where organization_id = $1 and athlete_id = $2`, [ORG, ATH, OTHER_COACH]);

      const outcome = setAthleteCompetence(coach, footwork('exploring')).then(() => 'saved', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await other.query('COMMIT');

      await expect(outcome).resolves.toBe('Forbidden: coach not assigned to athlete');
    } finally {
      await other.end();
    }
    expect(await competenceRows()).toHaveLength(0);
  });

  test('a coverage revocation that commits while the save waits is seen', async () => {
    await client.query(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1,$2,$3,$4, now() - interval '1 hour', now() + interval '2 hours')`,
      [ORG, ATH, COVER_COACH, ADMIN],
    );
    // The athlete row is held so the save passes the guard and then waits;
    // the revocation commits before the save reaches the coverage re-check.
    const holder = new Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for no key update`, [ORG, ATH]);

      const outcome = setAthleteCompetence(coverCoach, footwork('exploring')).then(() => 'saved', (error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query(`delete from pilot.coach_coverage where organization_id = $1 and athlete_id = $2`, [ORG, ATH]);
      await holder.query('COMMIT');

      await expect(outcome).resolves.toBe('Forbidden: coach not assigned to athlete');
    } finally {
      await holder.end();
    }
    expect(await competenceRows()).toHaveLength(0);
  });
});

describe('cohort placement reads the written level', () => {
  test('setting the required levels moves the athlete into the room', async () => {
    await client.query(
      `insert into pilot.cohort_definitions (organization_id, cohort_id, cohort_name, min_level_ordinal, required_domains)
       values ($1,'coh-pressure','Pressure Group',4,'footwork,composure')`,
      [ORG],
    );

    const before = await getAthleteCohortReport(ORG, ATH);
    expect(before?.fits.find((f) => f.cohort_id === 'coh-pressure')?.eligible).toBe(false);

    await setAthleteCompetence(coach, footwork('adapting'));
    await setAthleteCompetence(coach, { athleteId: ATH, domain: 'composure', levelKey: 'adapting', evidenceNote: '' });

    const after = await getAthleteCohortReport(ORG, ATH);
    expect(after?.competence.map((c) => `${c.domain}:${c.level_key}`).sort()).toEqual(['composure:adapting', 'footwork:adapting']);
    expect(after?.fits.find((f) => f.cohort_id === 'coh-pressure')).toMatchObject({ eligible: true, unmet: [] });
  });
});
