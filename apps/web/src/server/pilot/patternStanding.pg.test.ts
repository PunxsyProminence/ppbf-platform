// Real PostgreSQL proof of PATTERN-1b (patternStanding.ts): stored behaviour
// reports and the gym's bars in force reach the tier engine. The read is this
// gym's reports of this behaviour only, every athlete, with no note and no
// de-identified row; two coaches' reports of the same stored episodes are a
// paired judgment, so a ratified calibration bar can calibrate them; no
// pattern bar in force means no evaluation, and the reason.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { closePool } from './db';
import {
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from './learningPolicyApprovedV1';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-pattern-standing-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_pattern_standing';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-ps-1';
const OTHER_ORG = 'org-ps-2';
const COACH_A = 'acct-ps-coach-a';
const COACH_B = 'acct-ps-coach-b';
const OFFICE = 'acct-ps-office';
const OTHER_GYM_COACH = 'acct-ps-other';
const ATHLETE = 'ath-ps-1';
const TEAMMATE = 'ath-ps-2';
const PURGED = 'ath-ps-3';
const OTHER_GYM_ATHLETE = 'ath-ps-x';
// Fixture keys written straight to the table; keys the app makes are minted (bk_<hex>).
const KEY = 'bk_fixture_ps_guard';
const OTHER_KEY = 'bk_fixture_ps_other';
const AS_OF = '2026-07-01T00:00:00.000Z';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let standing: typeof import('./patternStanding');
let reports: typeof import('./behaviourObservations');
let policies: typeof import('./learningPolicies');
let revision: string;
let superseded: string;

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

/** One stored report, written straight to the table as the writer would leave it. */
async function report(input: {
  athleteId: string; coach: string; day: string; episodeId?: string; polarity?: 'occurrence' | 'counterexample';
  organizationId?: string; behaviourKey?: string; supersedes?: string;
}): Promise<string> {
  const result = await db.query<{ observation_id: string }>(
    `insert into pilot.behaviour_observations
       (organization_id, athlete_id, behaviour_key, episode_id, session_key, task_context_key, task_constraint,
        polarity, attribution_target, attribution_certainty, source_type, source_quality, interpretation,
        observer_account_id, author_role, note, observed_at, supersedes_observation_id)
     values ($1, $2, $3, $4, $5, 'context:session', 'controlled', $6, 'athlete', 'probable', 'coach_tag', 'moderate',
             'human_observed', $7, 'coach', 'a note the reader must not return', $8, $9)
     returning observation_id`,
    [
      input.organizationId ?? ORG, input.athleteId, input.behaviourKey ?? KEY, input.episodeId ?? `ep:${randomUUID()}`,
      `day:${input.day}`, input.polarity ?? 'occurrence', input.coach, `${input.day}T22:00:00.000Z`, input.supersedes ?? null,
    ],
  );
  return result.rows[0].observation_id;
}

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
     values ($1, 'Fixture Gym', 'active'), ($2, 'Other Fixture Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [COACH_A, 'coach', ORG], [COACH_B, 'coach', ORG], [OFFICE, 'organization_admin', ORG],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG],
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
  for (const [organizationId, athleteId, coach] of [
    [ORG, ATHLETE, COACH_A], [ORG, TEAMMATE, COACH_A], [ORG, PURGED, COACH_A], [OTHER_ORG, OTHER_GYM_ATHLETE, OTHER_GYM_COACH],
  ]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Fixture Athlete', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now(), null)`,
      [organizationId, athleteId, coach],
    );
  }
  for (const [organizationId, key, coach] of [[ORG, KEY, COACH_A], [ORG, OTHER_KEY, COACH_A], [OTHER_ORG, KEY, OTHER_GYM_COACH]]) {
    await db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, $2, 'Fixture behaviour', 'SK-JAB-01', $3)`,
      [organizationId, key, coach],
    );
  }

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  standing = await import('./patternStanding');
  reports = await import('./behaviourObservations');
  policies = await import('./learningPolicies');

  // The athlete: five reports by coach-a over three gym days (emerging evidence).
  for (const day of ['2026-06-01', '2026-06-01', '2026-06-05', '2026-06-05', '2026-06-10']) {
    await report({ athleteId: ATHLETE, coach: COACH_A, day });
  }
  // The teammate: thirty episodes both coaches reported, in January (the pair's calibration record).
  for (let i = 0; i < 30; i += 1) {
    const episodeId = `ep:${randomUUID()}`;
    const polarity = i < 20 ? 'occurrence' : 'counterexample';
    await report({ athleteId: TEAMMATE, coach: COACH_A, day: '2026-01-10', episodeId, polarity });
    await report({ athleteId: TEAMMATE, coach: COACH_B, day: '2026-01-10', episodeId, polarity });
  }
  // A coach's own revision: the read returns the revision, not the call it replaced. (Should the
  // coach's account go, both rows lose their observer and the engine could no longer tell.)
  const revisedEpisode = `ep:${randomUUID()}`;
  const original = await report({ athleteId: TEAMMATE, coach: COACH_B, day: '2026-01-11', episodeId: revisedEpisode, polarity: 'counterexample' });
  revision = await report({ athleteId: TEAMMATE, coach: COACH_B, day: '2026-01-11', episodeId: revisedEpisode, supersedes: original });
  superseded = original;
  // Rows the read must not return: another behaviour, another gym, and a de-identified report.
  await report({ athleteId: ATHLETE, coach: COACH_A, day: '2026-06-02', behaviourKey: OTHER_KEY });
  await report({ organizationId: OTHER_ORG, athleteId: OTHER_GYM_ATHLETE, coach: OTHER_GYM_COACH, day: '2026-06-02' });
  // De-identified as the purge does it: only a deleted athlete's reports, once.
  const purged = await report({ athleteId: PURGED, coach: COACH_B, day: '2026-06-03' });
  await db.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, PURGED]);
  await db.query(
    `update pilot.behaviour_observations
        set athlete_id = 'anon_' || gen_random_uuid()::text, note = '', deidentified_at = now()
      where organization_id = $1 and observation_id = $2`,
    [ORG, purged],
  );
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

const ratify = (kind: 'pattern_formation' | 'observer_calibration') => policies.ratifyLearningPolicy({
  organizationId: ORG,
  kind,
  parameters: kind === 'pattern_formation' ? APPROVED_PATTERN_FORMATION_V1 : APPROVED_OBSERVER_CALIBRATION_V1,
  citations: APPROVED_CITATIONS_V1[kind],
  ratifiedByAccountId: OFFICE,
  ratifiedByRole: 'organization_admin',
});

describe('the read', () => {
  test('this gym\'s live reports of this behaviour, every athlete, oldest first, with no note', async () => {
    const rows = await reports.listBehaviourReadingsForEvaluation(ORG, KEY);
    expect(rows).toHaveLength(66);
    expect(rows.map((row) => row.observation_id)).toContain(revision);
    expect(rows.map((row) => row.observation_id)).not.toContain(superseded);
    expect(new Set(rows.map((row) => row.organization_id))).toEqual(new Set([ORG]));
    expect(new Set(rows.map((row) => row.behaviour_key))).toEqual(new Set([KEY]));
    expect(new Set(rows.map((row) => row.athlete_id))).toEqual(new Set([ATHLETE, TEAMMATE]));
    expect(rows.some((row) => 'note' in row)).toBe(false);
    const times = rows.map((row) => new Date(row.observed_at).getTime());
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(rows[0]).toEqual(expect.objectContaining({ source_type: 'coach_tag', interpretation: 'human_observed' }));
  });
});

describe('the standing', () => {
  test('no pattern bar in force: no evaluation, the reason, and no report read', async () => {
    const read = jest.spyOn(reports, 'listBehaviourReadingsForEvaluation');
    const result = await standing.evaluatePatternStanding({ organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, asOf: AS_OF });
    expect(result.evaluation).toBeNull();
    expect(result.notEvaluated).toBe('no_pattern_bar_in_force');
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  test('with the pattern bar alone nothing counts and it says so; with the calibration bar too, the paired coach\'s readings count', async () => {
    const pattern = await ratify('pattern_formation');
    const alone = await standing.evaluatePatternStanding({ organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, asOf: AS_OF });
    expect(alone.evaluation?.calibrationBarInForce).toBe(false);
    expect(alone.evaluation?.tier).toBeNull();
    expect(alone.evaluation?.unverifiedObservationIds).toHaveLength(5);

    const calibration = await ratify('observer_calibration');
    const both = await standing.evaluatePatternStanding({ organizationId: ORG, athleteId: ATHLETE, behaviourKey: KEY, asOf: AS_OF });
    expect(both.bars).toEqual({
      pattern: { policyId: pattern.policy_id, version: 1 },
      calibration: { policyId: calibration.policy_id, version: 1 },
    });
    expect(both.evaluation?.tier).toBe('emerging');
    expect(both.evaluation?.counts.codedChances).toBe(5);
    expect(both.evaluation?.unverifiedObservationIds).toEqual([]);
  });

  test('the bars in force are this gym\'s alone', async () => {
    const result = await standing.evaluatePatternStanding({
      organizationId: OTHER_ORG, athleteId: OTHER_GYM_ATHLETE, behaviourKey: KEY, asOf: AS_OF,
    });
    expect(result.notEvaluated).toBe('no_pattern_bar_in_force');
    expect(await policies.listActiveLearningPolicies(OTHER_ORG)).toEqual([]);
  });
});
