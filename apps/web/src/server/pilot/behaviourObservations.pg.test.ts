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
// A fixture key written straight to the table; keys the app makes are minted (bk_<hex>).
const KEY = 'bk_fixture_drops_hand';

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
  // The drill's discipline must exist for this gym (drill_library_discipline_fk).
  await db.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, 'drill-bw-1', 'lineage-bw-1', 'Jab return', 'technical', 'b', 'p', 's', 'e', 'g', 'bad', 'none', 'SK-JAB-01')`,
    [ORG],
  );
  // Another gym's real run, drill and attempt: each must read as "not in this gym", as a missing one does.
  await db.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [OTHER_ORG],
  );
  await db.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, contact_level, skill_id)
     values ($1, 'drill-bw-x', 'lineage-bw-x', 'Theirs', 'technical', 'b', 'p', 's', 'e', 'g', 'bad', 'none', 'SK-JAB-01')`,
    [OTHER_ORG],
  );
  await db.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, ended_at)
     values ($1, 'run-bw-x', null, null, $2, current_date, 'completed', now() - interval '1 hour', now())`,
    [OTHER_ORG, OTHER_GYM_COACH],
  );
  await db.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, ended_at)
     values ($1, 'run-bw-1', null, null, $2, current_date, 'completed', now() - interval '1 hour', now())`,
    [ORG, COACH],
  );
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
     values ($1, $2, 'Drops lead hand after the jab', 'SK-JAB-01', $3)`,
    [ORG, KEY, COACH],
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
  test('a coach adds a name under a skill and the server mints its key; no skill code, or a visitor, is refused', async () => {
    const key = await writer.createBehaviourKey({
      organizationId: ORG, label: '  Keeps a low guard ', skillId: 'SK-GUARD-01', createdByAccountId: COACH,
    });
    expect(key).toEqual(expect.objectContaining({ label: 'Keeps a low guard', status: 'active' }));
    expect(key.behaviour_key).toMatch(/^bk_[0-9a-f]{16}$/);
    await expect(writer.createBehaviourKey({
      organizationId: ORG, label: 'No skill', skillId: 'jab', createdByAccountId: COACH,
    })).rejects.toThrow('skill code');
    await expect(writer.createBehaviourKey({
      organizationId: ORG, label: 'Made-up skill', skillId: 'SK-FAKE-99', createdByAccountId: COACH,
    })).rejects.toThrow('skill graph');
    // One name, one key: the same words under the same skill, from another
    // coach or a retried save, return the name already on the list.
    const again = await writer.createBehaviourKey({
      organizationId: ORG, label: 'keeps a LOW guard', skillId: 'SK-GUARD-01', createdByAccountId: SECOND_COACH,
    });
    expect(again.behaviour_key).toBe(key.behaviour_key);
    const otherSkill = await writer.createBehaviourKey({
      organizationId: ORG, label: 'Keeps a low guard', skillId: 'SK-GUARD-02', createdByAccountId: COACH,
    });
    expect(otherSkill.behaviour_key).not.toBe(key.behaviour_key);
    await expect(writer.createBehaviourKey({
      organizationId: ORG, label: 'From elsewhere', skillId: 'SK-JAB-01', createdByAccountId: OTHER_GYM_COACH,
    })).rejects.toThrow('Only staff of this gym');
    expect((await writer.listBehaviourKeys(ORG)).map((row) => row.behaviour_key).sort())
      .toEqual([KEY, key.behaviour_key, otherSkill.behaviour_key].sort());
  });
});

describe('a behaviour report', () => {
  test('carries run, drill and a fresh episode, at the unmarked view quality', async () => {
    const row = await writer.recordBehaviourObservation({ ...base, note: 'NOTE-BW-1 dropped it twice' });
    expect(row).toEqual(expect.objectContaining({
      session_key: 'run:run-bw-1',
      // Keyed by the drill's lineage, so a re-versioned drill stays one context.
      task_context_key: 'drill:lineage-bw-1',
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
    // The revision keeps the moment's own time, not the time it was written.
    expect(revision.observed_at).toEqual(first.observed_at);
    // Even when a time is sent with it.
    const sentLate = await writer.recordBehaviourObservation({
      ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' },
      observerAccountId: SECOND_COACH, sameMomentAs: first.observation_id, observedAt: '2030-01-01T00:00:00Z',
    });
    expect(sentLate.observed_at).toEqual(first.observed_at);
    // A third call by the same coach revises the revision, never the original twice.
    const again = await writer.recordBehaviourObservation({
      ...base, session: { date: '2026-10-18' }, context: { attemptContext: 'open_floor' },
      sameMomentAs: first.observation_id,
    });
    expect(again.supersedes_observation_id).toBe(revision.observation_id);
  });

  test("a logged attempt is its own episode, and must be this athlete's", async () => {
    const row = await writer.recordBehaviourObservation({ ...base, trainingAttemptId: 'att-bw-1' });
    expect(row.episode_id).toBe(`attempt:att-bw-1:${KEY}`);
    // The same attempt can show a second behaviour: its own episode.
    const hook = await writer.createBehaviourKey({
      organizationId: ORG, label: 'Squares up on the hook', skillId: 'SK-HOOK-01', createdByAccountId: COACH,
    });
    const other = await writer.recordBehaviourObservation({
      ...base, behaviourKey: hook.behaviour_key, trainingAttemptId: 'att-bw-1',
    });
    expect(other.episode_id).toBe(`attempt:att-bw-1:${hook.behaviour_key}`);
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
    await expect(writer.recordBehaviourObservation({ ...base, session: { date: '2026-02-31' } })).rejects.toThrow('YYYY-MM-DD');
    await expect(writer.recordBehaviourObservation({ ...base, observedAt: 'March 7' })).rejects.toThrow('ISO 8601');
    await expect(writer.recordBehaviourObservation({ ...base, observedAt: '2026-10-18T17:30:00' })).rejects.toThrow('with its offset');
    await expect(writer.recordBehaviourObservation({ ...base, observedAt: '2026-02-31T10:00:00Z' })).rejects.toThrow('ISO 8601');
    await expect(writer.recordBehaviourObservation({ ...base, observedAt: '2096-10-18T17:30:00Z' })).rejects.toThrow('in the future');
    // Another gym's real records read exactly as missing ones.
    await expect(writer.recordBehaviourObservation({ ...base, session: { runId: 'run-bw-x' } })).rejects.toThrow('session run is not in this gym');
    await expect(writer.recordBehaviourObservation({ ...base, context: { drillId: 'drill-bw-x' } })).rejects.toThrow('not in this gym');
    await expect(writer.recordBehaviourObservation({ ...base, polarity: 'bad' })).rejects.toThrow('polarity must be one of');
    await expect(writer.recordBehaviourObservation({ ...base, behaviourKey: 'not_on_the_list' })).rejects.toThrow('active list');
    await expect(writer.recordBehaviourObservation({ ...base, observerAccountId: OTHER_GYM_COACH })).rejects.toThrow('Only staff of this gym');
    await expect(writer.recordBehaviourObservation({ ...base, note: 'x'.repeat(2001) })).rejects.toThrow('at most 2000');
  });

  test("the athlete's reports list newest first, as written", async () => {
    const rows = await writer.listBehaviourObservations(ORG, ATHLETE);
    expect(rows.length).toBe(9);
    const times = rows.map((row) => Date.parse(row.observed_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(await writer.listBehaviourObservations(ORG, TEAMMATE)).toEqual([]);
    expect(await writer.listBehaviourObservations(OTHER_ORG, ATHLETE)).toEqual([]);
  });
});
