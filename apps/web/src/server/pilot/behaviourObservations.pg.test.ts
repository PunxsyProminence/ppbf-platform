// Real PostgreSQL proof of the learning loop's writer (lane L49,
// behaviourObservations.ts): a report's session, drill and episode keys are
// built from records of this gym; a second coach's report of the same moment
// joins its episode; a coach's own second report revises their first; a
// training attempt is its own episode and must be this athlete's; the
// database's refusals come back as the coach-readable reason.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { closePool } from './db';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-behaviour-writer-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_behaviour_writer';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-bw-1';
const OTHER_ORG = 'org-bw-2';
const COACH = 'acct-bw-coach';
const SECOND_COACH = 'acct-bw-coach-2';
const OTHER_GYM_COACH = 'acct-bw-other';
const ATHLETE = 'ath-bw-1';
const TEAMMATE = 'ath-bw-2';
const KEY = 'drops_lead_hand_after_jab';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let writer: typeof import('./behaviourObservations');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

const base = {
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: KEY,
  observerAccountId: COACH,
  authorRole: 'coach',
  session: { runId: 'run-bw-1' },
  context: { drillId: 'drill-bw-1' },
  taskConstraint: 'controlled',
  polarity: 'occurrence',
  attributionTarget: 'athlete',
  attributionCertainty: 'probable',
};

beforeAll(async () => {
  PG_PORT = await freePort();
  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [COACH, 'coach', ORG], [SECOND_COACH, 'coach', ORG], [OTHER_GYM_COACH, 'coach', OTHER_ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
      [accountId, organizationId, role],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $4, now(), now(), null),
            ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now(), null)`,
    [ORG, ATHLETE, TEAMMATE, COACH],
  );
  await db.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, 'drill-bw-1', 'drill-bw-1', 'Jab return', 'technical', 'b', 'p', 's', 'e', 'g', 'bad', 'none', 'SK-JAB-01')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, ended_at)
     values ($1, 'run-bw-1', null, null, $2, current_date, 'completed', now() - interval '1 hour', now())`,
    [ORG, COACH],
  );
  await db.query(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, recorded_by_account_id, context_type, metric_kind, direction, achieved_value)
     values ($1, 'att-bw-1', $2, $3, 'session', 'reps', 'at_least', 12),
            ($1, 'att-bw-teammate', $4, $3, 'session', 'reps', 'at_least', 10)`,
    [ORG, ATHLETE, COACH, TEAMMATE],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  writer = await import('./behaviourObservations');
});

afterAll(async () => {
  await closePool().catch(() => {});
  await db?.end().catch(() => {});
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

describe('the behaviour-name list', () => {
  test('a coach adds a name under a skill; the same key twice, or no skill code, is refused by name', async () => {
    const key = await writer.createBehaviourKey({
      organizationId: ORG, behaviourKey: KEY, label: '  Drops lead hand after the jab ', skillId: 'SK-JAB-01',
      createdByAccountId: COACH,
    });
    expect(key).toEqual(expect.objectContaining({ behaviour_key: KEY, label: 'Drops lead hand after the jab', status: 'active' }));
    await expect(writer.createBehaviourKey({
      organizationId: ORG, behaviourKey: KEY, label: 'Again', skillId: 'SK-JAB-01', createdByAccountId: COACH,
    })).rejects.toThrow('already on the list');
    await expect(writer.createBehaviourKey({
      organizationId: ORG, behaviourKey: 'no_skill', label: 'No skill', skillId: 'jab', createdByAccountId: COACH,
    })).rejects.toThrow('skill code');
    await expect(writer.createBehaviourKey({
      organizationId: ORG, behaviourKey: 'visitor_name', label: 'From elsewhere', skillId: 'SK-JAB-01',
      createdByAccountId: OTHER_GYM_COACH,
    })).rejects.toThrow('Only staff of this gym');
    expect((await writer.listBehaviourKeys(ORG)).map((row) => row.behaviour_key)).toEqual([KEY]);
  });
});

describe('a behaviour report', () => {
  test('carries run, drill and a fresh episode, at the unmarked view quality', async () => {
    const row = await writer.recordBehaviourObservation({ ...base, note: 'NOTE-BW-1 dropped it twice' });
    expect(row).toEqual(expect.objectContaining({
      session_key: 'run:run-bw-1',
      task_context_key: 'drill:drill-bw-1',
      episode_id: expect.stringMatching(/^ep:[0-9a-f-]{36}$/),
      source_quality: 'moderate',
      fatigue_context: 'unknown',
      behaviour_label: 'Drops lead hand after the jab',
      supersedes_observation_id: null,
    }));
  });

  test("a second coach joins the moment; the first coach's second report revises their first", async () => {
    const first = await writer.recordBehaviourObservation({ ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' } });
    const second = await writer.recordBehaviourObservation({
      ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' },
      observerAccountId: SECOND_COACH, sameMomentAs: first.observation_id, polarity: 'counterexample', viewQuality: 'clear',
    });
    expect(second.episode_id).toBe(first.episode_id);
    expect(second.supersedes_observation_id).toBeNull();
    expect(second.source_quality).toBe('high');
    const revision = await writer.recordBehaviourObservation({
      ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' },
      sameMomentAs: first.observation_id, polarity: 'counterexample',
    });
    expect(revision.episode_id).toBe(first.episode_id);
    expect(revision.supersedes_observation_id).toBe(first.observation_id);
    // A third call by the same coach revises the revision, never the original twice.
    const again = await writer.recordBehaviourObservation({
      ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' },
      sameMomentAs: first.observation_id,
    });
    expect(again.supersedes_observation_id).toBe(revision.observation_id);
  });

  test("a logged attempt is its own episode, and must be this athlete's", async () => {
    const row = await writer.recordBehaviourObservation({ ...base, trainingAttemptId: 'att-bw-1' });
    expect(row.episode_id).toBe('attempt:att-bw-1');
    await expect(writer.recordBehaviourObservation({ ...base, trainingAttemptId: 'att-bw-teammate' }))
      .rejects.toThrow("not this athlete's");
    await expect(writer.recordBehaviourObservation({ ...base, trainingAttemptId: 'att-bw-1', sameMomentAs: row.observation_id }))
      .rejects.toThrow('not both');
  });

  test("the same moment must be this athlete's moment", async () => {
    const mine = await writer.recordBehaviourObservation(base);
    await expect(writer.recordBehaviourObservation({ ...base, athleteId: TEAMMATE, sameMomentAs: mine.observation_id }))
      .rejects.toThrow("not this athlete's");
  });

  test('refusals come back as reasons', async () => {
    await expect(writer.recordBehaviourObservation({ ...base, session: { runId: 'run-nowhere' } })).rejects.toThrow('session run');
    await expect(writer.recordBehaviourObservation({ ...base, context: { drillId: 'drill-nowhere' } })).rejects.toThrow('drill');
    await expect(writer.recordBehaviourObservation({ ...base, context: { attemptContext: 'backyard' } })).rejects.toThrow('context must be one of');
    await expect(writer.recordBehaviourObservation({ ...base, session: { date: '18/10/2026' } })).rejects.toThrow('YYYY-MM-DD');
    await expect(writer.recordBehaviourObservation({ ...base, polarity: 'bad' })).rejects.toThrow('polarity must be one of');
    await expect(writer.recordBehaviourObservation({ ...base, behaviourKey: 'not_on_the_list' })).rejects.toThrow('active list');
    await expect(writer.recordBehaviourObservation({ ...base, observerAccountId: OTHER_GYM_COACH })).rejects.toThrow('Only staff of this gym');
    await expect(writer.recordBehaviourObservation({ ...base, note: 'x'.repeat(2001) })).rejects.toThrow('at most 2000');
  });

  test("the athlete's reports list newest first, as written", async () => {
    const rows = await writer.listBehaviourObservations(ORG, ATHLETE);
    expect(rows.length).toBe(7);
    const times = rows.map((row) => Date.parse(row.observed_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(await writer.listBehaviourObservations(ORG, TEAMMATE)).toEqual([]);
    expect(await writer.listBehaviourObservations(OTHER_ORG, ATHLETE)).toEqual([]);
  });
});
