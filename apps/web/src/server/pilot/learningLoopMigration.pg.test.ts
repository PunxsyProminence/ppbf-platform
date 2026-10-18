// Real PostgreSQL proof of the learning-loop migration (lane L49,
// infra/azure/pilot_slice_postgres_learning_loop_migration.sql) and of the
// retention purge's step for it (scripts/pilot-cleanup-deleted-data.mjs,
// deidentifyBehaviourObservations): behaviour reports are append-only, one
// episode is one athlete/behaviour/session/drill, a behaviour name keeps its
// meaning, a bar is stored only with a citation and a gym admin's name (Jason
// 2026-10-18 Q3, "Needs to be backed by research"), and a purged child's
// reports stay under their one token with the child's name scrubbed from the
// coach's notes, theirs and other children's (Jason 2026-10-06; 2026-10-07
// "Scrub the child's name, keep", "Gym-wide").
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-learning-loop-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const APPLY_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-apply-learning-loop-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = path.join(INFRA_DIR, 'pilot_slice_postgres_learning_loop_migration.sql');
const TEST_DB_NAME = 'ppbf_test_learning_loop';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-ll-1';
const OTHER_ORG = 'org-ll-2';
const ATHLETE_A = 'ath-ll-a'; // purged: deleted three years ago (after its reports were made)
const ATHLETE_B = 'ath-ll-b'; // live
const ATHLETE_X = 'ath-ll-x'; // the other gym's
const COACH = 'acct-ll-coach';
const SECOND_COACH = 'acct-ll-coach-2';
const OFFICE = 'acct-ll-office'; // organization_admin
const LAPSED_COACH = 'acct-ll-lapsed'; // membership inactive
const LEAVING_COACH = 'acct-ll-leaving'; // account deleted mid-suite
const OTHER_GYM_COACH = 'acct-ll-other';
const KEY = 'drops_lead_hand_after_jab';
const RETIRED_KEY = 'old_name_for_it';
const NOTE_A = 'NOTE-LL-A-5521 Rosa dropped it again after the double jab';
const NOTE_B_NAMING_A = 'NOTE-LL-B-7702 paired with Rosa on the pads';
const LIVE_TOKEN = 'anon_00000000-0000-4000-8000-000000000000';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

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

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

interface Report {
  observationId?: string;
  organizationId?: string;
  athleteId?: string;
  behaviourKey?: string;
  episodeId?: string;
  sessionKey?: string;
  taskContextKey?: string;
  polarity?: string;
  observer?: string;
  authorRole?: string;
  supersedes?: string | null;
  note?: string;
  sourceType?: string;
  interpretation?: string;
}

const EPISODE_1 = 'ep:11111111-1111-4111-8111-111111111111';
const EPISODE_2 = 'ep:22222222-2222-4222-8222-222222222222';

async function report(r: Report = {}): Promise<string> {
  const result = await db.query<{ observation_id: string }>(
    `insert into pilot.behaviour_observations
       (observation_id, organization_id, athlete_id, behaviour_key, episode_id, session_key, task_context_key,
        task_constraint, polarity, attribution_target, attribution_certainty, source_type,
        source_quality, interpretation, observer_account_id, author_role, supersedes_observation_id,
        note, observed_at)
     values (coalesce($14::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, 'controlled', $7, 'athlete',
             'probable', $8, 'moderate', $9, $10, $11, $12, $13, now())
     returning observation_id`,
    [
      r.organizationId ?? ORG, r.athleteId ?? ATHLETE_B, r.behaviourKey ?? KEY, r.episodeId ?? EPISODE_1,
      r.sessionKey ?? 'run:run-ll-1', r.taskContextKey ?? 'drill:drill-ll-1', r.polarity ?? 'occurrence',
      r.sourceType ?? 'coach_tag', r.interpretation ?? 'human_observed', r.observer ?? COACH,
      r.authorRole ?? 'coach', r.supersedes ?? null, r.note ?? '', r.observationId ?? null,
    ],
  );
  return result.rows[0].observation_id;
}

/** The refusal a statement raises: its SQLSTATE and the constraint it names. */
async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    return { code: pgError.code, constraint: pgError.constraint };
  }
  return { code: 'NO_REFUSAL' };
}

async function policy(input: {
  kind?: string; version?: number; citations?: unknown; by?: string; role?: string; supersedes?: string | null;
}): Promise<string> {
  const result = await db.query<{ policy_id: string }>(
    `insert into pilot.learning_policies
       (organization_id, policy_kind, version, parameters, citations, ratified_by_account_id, ratified_by_role,
        supersedes_policy_id)
     values ($1, $2, $3, '{"minimumOccurrences": 3}'::jsonb, $4::jsonb, $5, $6, $7)
     returning policy_id`,
    [
      ORG, input.kind ?? 'pattern_formation', input.version ?? 1,
      JSON.stringify(input.citations ?? [{ source: 'Kratochwill et al. 2013, single-case design standards', note: 'phase length' }]),
      input.by ?? OFFICE, input.role ?? 'organization_admin', input.supersedes ?? null,
    ],
  );
  return result.rows[0].policy_id;
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
  // The schema production runs, this migration included through the workflow's `all` list.
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
    [COACH, 'coach', ORG], [SECOND_COACH, 'coach', ORG], [OFFICE, 'organization_admin', ORG],
    [LAPSED_COACH, 'coach', ORG], [LEAVING_COACH, 'coach', ORG], [OTHER_GYM_COACH, 'coach', OTHER_ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
  }
  await db.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $7, 'coach', true), ($2, $7, 'coach', true), ($3, $7, 'organization_admin', true),
            ($4, $7, 'coach', false), ($5, $7, 'coach', true), ($6, $8, 'coach', true)`,
    [COACH, SECOND_COACH, OFFICE, LAPSED_COACH, LEAVING_COACH, OTHER_GYM_COACH, ORG, OTHER_ORG],
  );
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $4, now(), now(), null),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now(), null)`,
    [ORG, ATHLETE_A, ATHLETE_B, COACH],
  );
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Other Kid', '2012-01-01', 'youth-60', 'active', 'Guardian', true, $3, now(), now(), null)`,
    [OTHER_ORG, ATHLETE_X, OTHER_GYM_COACH],
  );
  await db.query(
    `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, status, created_by_account_id)
     values ($1, $3, 'Drops lead hand after the jab', 'SK-JAB-01', 'active', $4),
            ($1, $5, 'Old name for it', 'SK-JAB-01', 'retired', $4),
            ($2, $3, 'Drops lead hand after the jab', 'SK-JAB-01', 'active', $6)`,
    [ORG, OTHER_ORG, KEY, COACH, RETIRED_KEY, OTHER_GYM_COACH],
  );
});

afterAll(async () => {
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

describe('the learning-loop migration', () => {
  test('re-applies cleanly through its runner, readiness included', async () => {
    const runner = await nativeDynamicImport(pathToFileURL(APPLY_SCRIPT).href);
    const sql = await fs.readFile(MIGRATION_FILE, 'utf8');
    await expect(
      (runner.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>)(db, sql),
    ).resolves.toBeUndefined();
  });

  test('a behaviour name is a slug under one skill code', async () => {
    const insertKey = (key: string, skill: string) => () => db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, $2, 'A name', $3, $4)`,
      [ORG, key, skill, COACH],
    );
    expect(await refusal(insertKey('Drops Hand', 'SK-JAB-01'))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_key_check' });
    expect(await refusal(insertKey('drops_hand', 'SKILL-01'))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_skill_check' });
    expect(await refusal(() => db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, 'tabs_only', E'\t\t\t', 'SK-JAB-01', $2)`,
      [ORG, COACH],
    ))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_label_check' });
    // A new name is always someone's.
    expect(await refusal(() => db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id) values ($1, 'nobodys', 'A name', 'SK-JAB-01')`,
      [ORG],
    ))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_creator_of_this_gym' });
    expect(await refusal(() => db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, 'visitor_named', 'A name', 'SK-JAB-01', $2)`,
      [ORG, OTHER_GYM_COACH],
    ))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_creator_of_this_gym' });
  });

  test('a behaviour name keeps its meaning: retire it, never re-word, re-file or delete it', async () => {
    await db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, 'squares_up_on_the_hook', 'Squares up on the hook', 'SK-HOOK-01', $2)`,
      [ORG, COACH],
    );
    const fixed = { code: '23514', constraint: 'pilot_behaviour_keys_meaning_fixed' };
    expect(await refusal(() => db.query(
      `update pilot.behaviour_keys set label = 'Something else' where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    ))).toEqual(fixed);
    expect(await refusal(() => db.query(
      `update pilot.behaviour_keys set skill_id = 'SK-JAB-01' where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    ))).toEqual(fixed);
    await db.query(
      `update pilot.behaviour_keys set status = 'retired' where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    );
    // The purge's name scrub is the one change to a label, and only EXACTLY
    // what the purge's own pattern makes of it: a rewrite that merely adds a
    // [name] is still a rewrite.
    await db.query('begin');
    await db.query(`select set_config('pilot.name_scrub_pattern', $1, true)`, ['\\mSquares\\M']);
    expect(await refusal(() => db.query(
      `update pilot.behaviour_keys set label = '[name] throws the jab'
        where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    ))).toEqual(fixed);
    await db.query('rollback');
    await db.query('begin');
    await db.query(`select set_config('pilot.name_scrub_pattern', $1, true)`, ['\\mSquares\\M']);
    await db.query(
      `update pilot.behaviour_keys set label = '[name] up on the hook'
        where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    );
    await db.query('commit');
    // With no pattern set, not even the exact scrub is admitted.
    expect(await refusal(() => db.query(
      `update pilot.behaviour_keys set label = 'x' where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    ))).toEqual(fixed);
    expect(await refusal(() => db.query(
      `delete from pilot.behaviour_keys where organization_id = $1 and behaviour_key = 'squares_up_on_the_hook'`, [ORG],
    ))).toEqual({ code: '23514', constraint: 'pilot_behaviour_keys_no_delete' });
  });

  test('two coaches report one rep as one episode; the same coach revises their own call', async () => {
    const first = await report({ athleteId: ATHLETE_A, observer: COACH, note: NOTE_A });
    await report({ athleteId: ATHLETE_A, observer: SECOND_COACH, polarity: 'counterexample' });
    const revision = await report({ athleteId: ATHLETE_A, observer: COACH, supersedes: first, polarity: 'counterexample' });
    expect(revision).toEqual(expect.any(String));
    const rows = await db.query(
      `select count(*)::int as n from pilot.behaviour_observations where organization_id = $1 and episode_id = $2`,
      [ORG, EPISODE_1],
    );
    expect(rows.rows[0].n).toBe(3);
  });

  test('each refusal names itself', async () => {
    const cases: [string, Report, { code: string; constraint: string }][] = [
      ["another gym's athlete", { athleteId: ATHLETE_X, episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_live_athlete' }],
      ['an observer from another gym', { observer: OTHER_GYM_COACH, episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_observer_of_this_gym' }],
      ['a lapsed membership', { observer: LAPSED_COACH, episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_observer_of_this_gym' }],
      ['a role the observer does not hold', { observer: COACH, authorRole: 'organization_admin', episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_observer_of_this_gym' }],
      ['a retired behaviour name', { behaviourKey: RETIRED_KEY, episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_active_key' }],
      ['one episode, two sessions', { athleteId: ATHLETE_A, sessionKey: 'day:2026-10-18' }, { code: '23514', constraint: 'pilot_behaviour_observations_one_episode' }],
      ['one episode, two athletes', { athleteId: ATHLETE_B }, { code: '23514', constraint: 'pilot_behaviour_observations_one_episode' }],
      ['a session key of no known shape', { sessionKey: 'tuesday', episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_session_check' }],
      ['a model proposal', { interpretation: 'ai_proposed', episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_interpretation_check' }],
      ['film as the source', { sourceType: 'computer_vision', episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_source_check' }],
      ['a new row under a token', { athleteId: 'anon_123', episodeId: EPISODE_2 }, { code: '23514', constraint: 'pilot_behaviour_observations_live_athlete' }],
    ];
    for (const [label, input, expected] of cases) {
      expect({ label, ...(await refusal(() => report(input))) }).toEqual({ label, ...expected });
    }
  });

  test("a revision is the observer's own, and a report is revised once", async () => {
    const original = await report({ athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: COACH });
    expect(await refusal(() => report({
      athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: SECOND_COACH, supersedes: original,
    }))).toEqual({ code: '23514', constraint: 'pilot_behaviour_observations_own_revision' });
    // The same person's second report of the moment must revise their first.
    expect(await refusal(() => report({ athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: COACH })))
      .toEqual({ code: '23514', constraint: 'pilot_behaviour_observations_own_revision' });
    await report({ athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: COACH, supersedes: original });
    // And revises their LATEST: the original is already revised.
    expect(await refusal(() => report({
      athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: COACH, supersedes: original,
    }))).toEqual({ code: '23514', constraint: 'pilot_behaviour_observations_own_revision' });
    // Never itself: the row is not there yet for its own trigger to find.
    const self = '33333333-3333-4333-8333-333333333333';
    expect(await refusal(() => report({
      observationId: self, athleteId: ATHLETE_B, episodeId: EPISODE_2, observer: COACH, supersedes: self,
    }))).toEqual({ code: '23514', constraint: 'pilot_behaviour_observations_own_revision' });
  });

  test('a report is never edited or deleted by hand, nor de-identified with anything else moved', async () => {
    const id = await report({ athleteId: ATHLETE_B, episodeId: 'attempt:att-ll-1', observer: COACH });
    const appendOnly = { code: '23514', constraint: 'pilot_behaviour_observations_append_only' };
    expect(await refusal(() => db.query(
      `update pilot.behaviour_observations set polarity = 'counterexample' where observation_id = $1`, [id],
    ))).toEqual(appendOnly);
    expect(await refusal(() => db.query(
      `update pilot.behaviour_observations
          set athlete_id = 'anon_x', note = '', deidentified_at = now(), polarity = 'counterexample'
        where observation_id = $1`, [id],
    ))).toEqual(appendOnly);
    expect(await refusal(() => db.query(
      `delete from pilot.behaviour_observations where observation_id = $1`, [id],
    ))).toEqual({ code: '23514', constraint: 'pilot_behaviour_observations_no_delete' });
    // A live child's report cannot be de-identified, even in the purge's own shape.
    expect(await refusal(() => db.query(
      `update pilot.behaviour_observations set athlete_id = $2, note = '', deidentified_at = now()
        where observation_id = $1`, [id, LIVE_TOKEN],
    ))).toEqual(appendOnly);
    // The observer is struck only by their account going, not by hand.
    expect(await refusal(() => db.query(
      `update pilot.behaviour_observations set observer_account_id = null where observation_id = $1`, [id],
    ))).toEqual(appendOnly);
    // A note changes only as the purge's exact name scrub.
    expect(await refusal(() => db.query(
      `update pilot.behaviour_observations set note = 'rewritten [name]' where observation_id = $1`, [id],
    ))).toEqual(appendOnly);
  });

  test("an observer's account going leaves the report, without the observer", async () => {
    const id = await report({ athleteId: ATHLETE_B, episodeId: 'attempt:att-ll-2', observer: LEAVING_COACH });
    await db.query('delete from pilot.organization_memberships where account_id = $1', [LEAVING_COACH]);
    await db.query('delete from pilot.accounts where account_id = $1', [LEAVING_COACH]);
    const row = await db.query(
      'select observer_account_id, author_role from pilot.behaviour_observations where observation_id = $1', [id],
    );
    expect(row.rows).toEqual([{ observer_account_id: null, author_role: 'coach' }]);
  });

  test('a bar needs a cited source, a gym admin, and a clean version chain', async () => {
    expect(await refusal(() => policy({ citations: [] })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_citations_check' });
    expect(await refusal(() => policy({ citations: [{ note: 'no source' }] })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_citation_source' });
    expect(await refusal(() => policy({ citations: [{ source: '\t\n ' }] })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_citation_source' });
    expect(await refusal(() => policy({ by: COACH, role: 'coach' })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_role_check' });
    expect(await refusal(() => policy({ by: COACH, role: 'organization_admin' })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_ratifier_of_this_gym' });

    const v1 = await policy({});
    expect(await refusal(() => policy({ version: 2 })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_version_chain' });
    expect(await refusal(() => policy({ version: 2, supersedes: v1 })))
      .toEqual({ code: '23505', constraint: 'idx_learning_policies_one_active' });
    await db.query(`update pilot.learning_policies set status = 'superseded' where policy_id = $1`, [v1]);
    const v2 = await policy({ version: 2, supersedes: v1 });

    expect(await refusal(() => db.query(
      `update pilot.learning_policies set parameters = '{}'::jsonb where policy_id = $1`, [v2],
    ))).toEqual({ code: '23514', constraint: 'pilot_learning_policies_versioned' });
    expect(await refusal(() => db.query('delete from pilot.learning_policies where policy_id = $1', [v2])))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_no_delete' });
    // A new version is born in force: never inserted already superseded.
    expect(await refusal(() => db.query(
      `insert into pilot.learning_policies
         (organization_id, policy_kind, version, parameters, citations, ratified_by_account_id, ratified_by_role, status)
       values ($1, 'observer_calibration', 1, '{}'::jsonb, '[{"source":"s"}]'::jsonb, $2, 'organization_admin', 'superseded')`,
      [ORG, OFFICE],
    ))).toEqual({ code: '23514', constraint: 'pilot_learning_policies_new_is_active' });
    // Each other kind has its own chain and its own bar in force.
    await expect(policy({ kind: 'athlete_lesson' })).resolves.toEqual(expect.any(String));
    await expect(policy({ kind: 'observer_calibration' })).resolves.toEqual(expect.any(String));
    expect(await refusal(() => policy({ kind: 'something_else' })))
      .toEqual({ code: '23514', constraint: 'pilot_learning_policies_kind_check' });
  });

  test('the new intervention columns hold real behaviour names and the observation context shape', async () => {
    const shape = await db.query(
      `select
         (select confrelid::regclass::text from pg_constraint
           where conname = 'pilot_intervention_protocols_behaviour_key_fk') as fk_target,
         (select pg_get_constraintdef(oid) from pg_constraint
           where conname = 'pilot_intervention_executions_trained_context_key_check') as context_check`,
    );
    expect(shape.rows[0].fk_target).toBe('pilot.behaviour_keys');
    expect(shape.rows[0].context_check).toContain('(drill|block|context)');
  });
});

describe('the retention purge and a purged child\'s behaviour reports', () => {
  const namingA = async () => Number((await db.query(
    `select count(*) as n from pilot.behaviour_observations where organization_id = $1 and athlete_id = $2`,
    [ORG, ATHLETE_A],
  )).rows[0].n);

  beforeAll(async () => {
    // Another child's report whose note names A (a drill partner): A's name
    // leaves it too, gym-wide.
    await report({ athleteId: ATHLETE_B, episodeId: 'attempt:att-ll-3', observer: COACH, note: NOTE_B_NAMING_A });
    // A behaviour name typed with A's name in it: the name goes, the behaviour stays.
    await db.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, 'bk_fixture_low_guard', 'Rosa keeps a low guard', 'SK-GUARD-01', $2)`,
      [ORG, COACH],
    );
    // A coach's chat turn about A, so A's two tokens can be compared.
    await db.query(
      `insert into pilot.shadow_chat_audit (organization_id, user_id, user_role, athlete_id, user_message, shadow_response)
       values ($1, $2, 'coach', $3, 'what should Rosa work on', 'Her guard after the jab.')`,
      [ORG, COACH, ATHLETE_A],
    );
    // A was deleted three years ago, after the reports above were made.
    await db.query(
      `update pilot.athletes set active_flag = false, deleted_at = now() - interval '3 years'
        where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_A],
    );
  });

  test('a dry run counts the reports it would de-identify and changes nothing', async () => {
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_deidentify_behaviour_observations).toBe(3);
    expect(dry.would_scrub_behaviour_observation_notes_names).toBe(1);
    expect(dry.would_scrub_behaviour_key_labels_names).toBe(1);
    expect(await namingA()).toBe(3);
  });

  test("the purge keeps A's reports under A's one token, with A's name scrubbed from every note", async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.behaviour_observations_deidentified).toBe(3);
    expect(event.behaviour_observation_notes_names_scrubbed).toBe(1);
    expect(event.behaviour_key_labels_names_scrubbed).toBe(1);
    const label = await db.query(
      `select label from pilot.behaviour_keys where organization_id = $1 and behaviour_key = 'bk_fixture_low_guard'`, [ORG],
    );
    expect(label.rows).toEqual([{ label: '[name] keeps a low guard' }]);
    expect(await namingA()).toBe(0);

    const kept = await db.query(
      `select distinct athlete_id, behaviour_key, episode_id, deidentified_at is not null as stamped
         from pilot.behaviour_observations where organization_id = $1 and episode_id = $2`,
      [ORG, EPISODE_1],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]).toEqual({
      athlete_id: expect.stringMatching(/^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      behaviour_key: KEY, episode_id: EPISODE_1, stamped: true,
    });
    // The coach's words stay, without the child's name.
    const notes = await db.query(
      `select note from pilot.behaviour_observations where organization_id = $1 and note like 'NOTE-LL-%' order by note`,
      [ORG],
    );
    expect(notes.rows.map((row) => row.note)).toEqual([
      'NOTE-LL-A-5521 [name] dropped it again after the double jab',
      'NOTE-LL-B-7702 paired with [name] on the pads',
    ]);
    const audit = await db.query(
      `select athlete_id from pilot.shadow_chat_audit where organization_id = $1 and user_id = $2`, [ORG, COACH],
    );
    expect(audit.rows.map((row) => row.athlete_id)).toEqual([kept.rows[0].athlete_id]);
    const anywhere = await db.query(
      `select count(*)::int as n from pilot.behaviour_observations where note ~* 'rosa|ortiz'`,
    );
    expect(anywhere.rows[0].n).toBe(0);
    // B's reports stay B's.
    const others = await db.query(
      `select count(*)::int as n from pilot.behaviour_observations where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_B],
    );
    expect(others.rows[0].n).toBe(5);
  });

  test('an athlete deleted without the purge takes their reports with them', async () => {
    await db.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE_B]);
    const left = await db.query(
      `select count(*)::int as n from pilot.behaviour_observations where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_B],
    );
    expect(left.rows[0].n).toBe(0);
    // The de-identified rows were never the athlete's to take.
    const kept = await db.query(
      `select count(*)::int as n from pilot.behaviour_observations where organization_id = $1 and deidentified_at is not null`,
      [ORG],
    );
    expect(kept.rows[0].n).toBe(3);
  });
});
