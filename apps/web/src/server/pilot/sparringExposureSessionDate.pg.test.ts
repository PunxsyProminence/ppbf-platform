// Real PostgreSQL-backed contract test for
// pilot_slice_postgres_sparring_exposure_session_date_migration.sql and for the
// unlinked (no activity_log row) write and read paths in sparringExposure.ts.
//
// What needs proving, none of it provable by reading SQL or a mocked driver:
//
//  1. The runner refuses a database the migration has not reached, and the
//     migration refuses to run without pilot.sparring_exposure.
//  2. Re-running is a no-op, the activity_log foreign key and the original
//     segment key are KEPT, and a row written before the migration is not
//     rewritten.
//  3. An athlete with NO sign-in account can be recorded (the whole point).
//  4. An unlinked row needs session_date; unlinked segment numbers are unique
//     per (org, athlete, gym day); auto-numbering counts per day and survives
//     a concurrent insert of the same number.
//  5. The foreign key still holds when activity_id is set.
//  6. If unlinked duplicates exist, a re-run refuses by name and alters nothing.
//  7. Readers never return a deleted athlete's rows.
//  8. The stop-rule list is the current, active rules of the caller's gym only.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production or
// staging.

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
  getSparringExposureCounts,
  listActiveUniversalStopRules,
  listSparringExposure,
  recordSparringExposure,
  type RecordSparringExposureInput,
} from './sparringExposure';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-session-date-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');

const ORG_A = 'org-sparsess-a';
const ORG_B = 'org-sparsess-b';
const COACH_A = 'acct-sparsess-coach-a';
const COACH_B = 'acct-sparsess-coach-b';
/** Has an athlete account, so it can also carry an activity_log row. */
const ATHLETE_LINKED = 'athlete-sparsess-linked';
/** No account row at all: the athlete the old schema could not record. */
const ATHLETE_NO_ACCOUNT = 'athlete-sparsess-no-account';
const ATHLETE_DELETED = 'athlete-sparsess-deleted';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type ApplyFn = (client: Client, sql: string) => Promise<void>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let activityLogSql: string;
let sparringSql: string;
let sessionDateSql: string;
let stopRuleSchemaSql: string;
let applyActivityLog: ApplyFn;
let applySparring: ApplyFn;
let applySessionDate: ApplyFn;

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

async function connect(name: string): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** Base + retention (athletes.deleted_at) + activity-log + sparring-exposure, with fixtures. */
async function freshDatabase(name: string, options: { sessionDate?: boolean } = {}): Promise<Client> {
  const admin = await connect('postgres');
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = await connect(name);
  await client.query(baseSchemaSql);
  await applyActivityLog(client, activityLogSql);
  await applySparring(client, sparringSql);

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
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'athlete', $2, 'microsoft', $1)`,
    [ATHLETE_LINKED, ORG_A],
  );
  for (const athlete of [ATHLETE_LINKED, ATHLETE_NO_ACCOUNT, ATHLETE_DELETED]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1,$2,$2,'2012-01-01','90lb','active','Contact',true,$3,now(),now())`,
      [ORG_A, athlete, COACH_A],
    );
  }
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
        occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
     values ($1,'activity-1',$2,$2,'boxing_training','sparring_session','2026-10-01',60,'door_terminal','coach',$3)`,
    [ORG_A, ATHLETE_LINKED, COACH_A],
  );

  if (options.sessionDate !== false) {
    await applySessionDate(client, sessionDateSql);
  }
  activeClient = client;
  return client;
}

function entry(overrides: Partial<RecordSparringExposureInput> = {}): RecordSparringExposureInput {
  return {
    organizationId: ORG_A,
    athleteId: ATHLETE_NO_ACCOUNT,
    sessionDate: '2026-10-02',
    sparringType: 'technical',
    timeUnderImpactSec: 45,
    coachObservedIntensity: 'light',
    coachObservedHeadContact: 'incidental',
    athletePresentation: 'normal',
    supervisingCoachAccountId: COACH_A,
    ...overrides,
  };
}

async function closeClient(client: Client): Promise<void> {
  activeClient = null;
  await client.end();
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

  const read = (file: string) => fs.readFile(path.join(INFRA_DIR, file), 'utf8');
  baseSchemaSql = (await read('pilot_slice_postgres.sql'))
    + (await read('pilot_slice_postgres_data_retention_deletion_migration.sql'));
  activityLogSql = await read('pilot_slice_postgres_activity_log_migration.sql');
  sparringSql = await read('pilot_slice_postgres_sparring_exposure_and_load_migration.sql');
  sessionDateSql = await read('pilot_slice_postgres_sparring_exposure_session_date_migration.sql');
  // pilot.universal_stop_rules, built the way drillLibraryV3.pg.test.ts builds
  // it: the content-import migration and what it refuses to run without, in
  // the workflow's `all` order.
  stopRuleSchemaSql = (await Promise.all([
    'pilot_slice_postgres_progression_migration.sql',
    'pilot_slice_postgres_drills_migration.sql',
    'pilot_slice_postgres_drill_versioning_migration.sql',
    'pilot_slice_postgres_drill_library_v3_migration.sql',
    'pilot_slice_postgres_drill_reference_provenance_migration.sql',
    'pilot_slice_postgres_drill_vocabulary_widening_migration.sql',
    'pilot_slice_postgres_workout_templates_v2_migration.sql',
    'pilot_slice_postgres_content_import_migration.sql',
  ].map(read))).join('\n');

  const runner = async (file: string) =>
    (await nativeDynamicImport(pathToFileURL(path.join(SCRIPTS_DIR, file)).href)).applyMigrationTransaction as ApplyFn;
  applyActivityLog = await runner('pilot-apply-activity-log-migration.mjs');
  applySparring = await runner('pilot-apply-sparring-exposure-migration.mjs');
  applySessionDate = await runner('pilot-apply-sparring-exposure-session-date-migration.mjs');
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

describe('runner and migration guards', () => {
  test('readiness REFUSES a database the migration has not reached', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_not_reached', { sessionDate: false });
    try {
      await expect(applySessionDate(client, 'select 1')).rejects.toThrow('SPARRING_EXPOSURE_SESSION_DATE_NOT_READY');
      const nullable = await client.query(
        `select is_nullable from information_schema.columns
         where table_schema='pilot' and table_name='sparring_exposure' and column_name='activity_id'`,
      );
      expect(nullable.rows[0].is_nullable).toBe('NO');
    } finally {
      await closeClient(client);
    }
  });

  test('the migration refuses to run without pilot.sparring_exposure', async () => {
    const admin = await connect('postgres');
    await admin.query('drop database if exists ppbf_test_sparsess_no_table');
    await admin.query('create database ppbf_test_sparsess_no_table');
    await admin.end();
    const client = await connect('ppbf_test_sparsess_no_table');
    try {
      await client.query(baseSchemaSql);
      await expect(applySessionDate(client, sessionDateSql)).rejects.toThrow(
        'SPARRING_EXPOSURE_SESSION_DATE_REQUIRES_SPARRING_EXPOSURE',
      );
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op; the activity_log FK and the linked segment key are kept; a pre-existing row is not rewritten', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_rerun', { sessionDate: false });
    try {
      // A linked row written BEFORE this migration, under the old shape.
      await client.query(
        `insert into pilot.sparring_exposure
           (organization_id, exposure_id, activity_id, athlete_id, segment_number, sparring_type,
            time_under_impact_sec, coach_observed_intensity, coach_observed_head_contact,
            supervising_coach_account_id)
         values ($1,'pre-1','activity-1',$2,1,'hard',40,'firm','regular',$3)`,
        [ORG_A, ATHLETE_LINKED, COACH_A],
      );
      const before = await client.query(`select row_to_json(e)::text as j from pilot.sparring_exposure e`);

      await applySessionDate(client, sessionDateSql);
      await applySessionDate(client, sessionDateSql);
      await applySessionDate(client, sessionDateSql);
      // The original migration re-run (every `all` dispatch does this) must
      // not put NOT NULL back.
      await applySparring(client, sparringSql);
      await applySessionDate(client, 'select 1');

      const after = await client.query(
        `select (row_to_json(e)::jsonb - 'session_date')::text as j, session_date from pilot.sparring_exposure e`,
      );
      expect(after.rows).toHaveLength(1);
      expect(JSON.parse(after.rows[0].j)).toEqual(JSON.parse(before.rows[0].j));
      expect(after.rows[0].session_date).toBeNull();

      const objects = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.sparring_exposure'::regclass
           and conname in ('pilot_sparring_exposure_activity_fk', 'pilot_sparring_exposure_segment_uq',
                           'pilot_sparring_exposure_session_date_or_activity')
         order by conname`,
      );
      expect(objects.rows.map((row) => row.conname)).toEqual([
        'pilot_sparring_exposure_activity_fk',
        'pilot_sparring_exposure_segment_uq',
        'pilot_sparring_exposure_session_date_or_activity',
      ]);
      const indexes = await client.query(
        `select count(*)::int as n from pg_indexes where indexname = 'pilot_sparring_exposure_session_segment_uq'`,
      );
      expect(indexes.rows[0].n).toBe(1);
    } finally {
      await closeClient(client);
    }
  });

  test('unlinked duplicates already present: a re-run refuses by name and alters nothing', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_dupes');
    try {
      await client.query('drop index pilot.pilot_sparring_exposure_session_segment_uq');
      for (const id of ['dup-1', 'dup-2']) {
        await client.query(
          `insert into pilot.sparring_exposure
             (organization_id, exposure_id, athlete_id, session_date, segment_number, sparring_type,
              time_under_impact_sec, coach_observed_intensity, coach_observed_head_contact,
              supervising_coach_account_id)
           values ($1,$2,$3,'2026-10-02',1,'play',20,'light','none',$4)`,
          [ORG_A, id, ATHLETE_NO_ACCOUNT, COACH_A],
        );
      }
      const before = await client.query(`select exposure_id from pilot.sparring_exposure order by exposure_id`);

      await expect(applySessionDate(client, sessionDateSql)).rejects.toThrow(
        'SPARRING_EXPOSURE_SESSION_SEGMENT_DUPLICATES_EXIST',
      );

      const after = await client.query(`select exposure_id from pilot.sparring_exposure order by exposure_id`);
      expect(after.rows).toEqual(before.rows);
      const indexes = await client.query(
        `select count(*)::int as n from pg_indexes where indexname = 'pilot_sparring_exposure_session_segment_uq'`,
      );
      expect(indexes.rows[0].n).toBe(0);
    } finally {
      await closeClient(client);
    }
  });
});

describe('unlinked entries (no activity_log row)', () => {
  test('an athlete with NO account is recorded, auto-numbered per gym day', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_no_account');
    try {
      const first = await recordSparringExposure(entry());
      const second = await recordSparringExposure(entry({ sparringType: 'hard', coachObservedIntensity: 'firm' }));
      const nextDay = await recordSparringExposure(entry({ sessionDate: '2026-10-03' }));

      expect(first).toMatchObject({
        activity_id: null,
        session_date: '2026-10-02',
        athlete_id: ATHLETE_NO_ACCOUNT,
        segment_number: 1,
        athlete_presentation: 'normal',
        supervising_coach_account_id: COACH_A,
      });
      expect(second.segment_number).toBe(2);
      expect(nextDay.segment_number).toBe(1);

      const accounts = await client.query(
        `select count(*)::int as n from pilot.accounts where athlete_id = $1 or account_id = $1`,
        [ATHLETE_NO_ACCOUNT],
      );
      expect(accounts.rows[0].n).toBe(0);
      // No activity_log row was written for it -- attendance and tenure untouched.
      const activity = await client.query(
        `select count(*)::int as n from pilot.activity_log where athlete_id = $1`,
        [ATHLETE_NO_ACCOUNT],
      );
      expect(activity.rows[0].n).toBe(0);
    } finally {
      await closeClient(client);
    }
  });

  test('linked and unlinked numbering are separate keys', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_linked_vs_unlinked');
    try {
      const linked = await recordSparringExposure(entry({ athleteId: ATHLETE_LINKED, activityId: 'activity-1', sessionDate: null }));
      const unlinked = await recordSparringExposure(entry({ athleteId: ATHLETE_LINKED }));
      const linked2 = await recordSparringExposure(entry({ athleteId: ATHLETE_LINKED, activityId: 'activity-1', sessionDate: null }));
      expect([linked.segment_number, unlinked.segment_number, linked2.segment_number]).toEqual([1, 1, 2]);
      expect(linked.activity_id).toBe('activity-1');
    } finally {
      await closeClient(client);
    }
  });

  test('an unlinked entry without session_date is refused by name', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_needs_date');
    try {
      await expect(recordSparringExposure(entry({ sessionDate: null }))).rejects.toThrow(
        'SPARRING_EXPOSURE_SESSION_DATE_REQUIRED',
      );
    } finally {
      await closeClient(client);
    }
  });

  test('an explicit duplicate unlinked segment is SPARRING_EXPOSURE_SEGMENT_DUPLICATE', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_explicit_dup');
    try {
      await recordSparringExposure(entry({ segmentNumber: 3 }));
      await expect(recordSparringExposure(entry({ segmentNumber: 3 }))).rejects.toThrow(
        'SPARRING_EXPOSURE_SEGMENT_DUPLICATE',
      );
    } finally {
      await closeClient(client);
    }
  });

  test('the activity_log foreign key still holds when activity_id is set', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_fk');
    try {
      await expect(
        recordSparringExposure(entry({ athleteId: ATHLETE_LINKED, activityId: 'no-such-activity' })),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_sparring_exposure_activity_fk' });
    } finally {
      await closeClient(client);
    }
  });

  test('auto-numbering survives a concurrent insert of the same number (retried, not overwritten)', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_race');
    const rival = await connect('ppbf_test_sparsess_race');
    try {
      await rival.query('begin');
      await rival.query(
        `insert into pilot.sparring_exposure
           (organization_id, exposure_id, athlete_id, session_date, segment_number, sparring_type,
            time_under_impact_sec, coach_observed_intensity, coach_observed_head_contact,
            supervising_coach_account_id)
         values ($1,'rival-1',$2,'2026-10-02',1,'play',20,'light','none',$3)`,
        [ORG_A, ATHLETE_NO_ACCOUNT, COACH_A],
      );

      // Computes 1 (the rival is uncommitted), then blocks on the unique index.
      const pending = recordSparringExposure(entry());
      for (let i = 0; i < 100; i += 1) {
        const waiting = await rival.query(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (waiting.rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await rival.query('commit');

      const saved = await pending;
      expect(saved.segment_number).toBe(2);
      const rows = await client.query(
        `select exposure_id, segment_number from pilot.sparring_exposure order by segment_number`,
      );
      expect(rows.rows).toEqual([
        { exposure_id: 'rival-1', segment_number: 1 },
        { exposure_id: saved.exposure_id, segment_number: 2 },
      ]);
    } finally {
      await rival.end();
      await closeClient(client);
    }
  });
});

describe('readers', () => {
  test('a deleted athlete\'s rows are never returned, by the list or the counts', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_deleted');
    try {
      await recordSparringExposure(entry({ athleteId: ATHLETE_DELETED }));
      await recordSparringExposure(entry());
      await client.query(
        `update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`,
        [ORG_A, ATHLETE_DELETED],
      );

      expect(await listSparringExposure(ORG_A, { athleteId: ATHLETE_DELETED })).toEqual([]);
      expect((await listSparringExposure(ORG_A)).map((row) => row.athlete_id)).toEqual([ATHLETE_NO_ACCOUNT]);
      expect((await getSparringExposureCounts(ORG_A, ATHLETE_DELETED)).total_segments).toBe(0);
    } finally {
      await closeClient(client);
    }
  });

  test('list is organization-scoped and honours limit; counts stay raw', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_list');
    try {
      await recordSparringExposure(entry({ timeUnderImpactSec: 30 }));
      await recordSparringExposure(entry({ timeUnderImpactSec: 50, sparringType: 'hard' }));
      await recordSparringExposure(entry({ timeUnderImpactSec: 20, sessionDate: '2026-10-01' }));

      expect(await listSparringExposure(ORG_B, { athleteId: ATHLETE_NO_ACCOUNT })).toEqual([]);
      expect(await listSparringExposure(ORG_A, { athleteId: ATHLETE_NO_ACCOUNT, limit: 2 })).toHaveLength(2);
      expect(await getSparringExposureCounts(ORG_A, ATHLETE_NO_ACCOUNT)).toEqual({
        total_segments: 3,
        total_time_under_impact_sec: 100,
        segments_by_type: { hard: 1, play: 0, technical: 2, game: 0, conditioned: 0 },
      });
    } finally {
      await closeClient(client);
    }
  });

  test('stop rules: current, active rules of the caller\'s gym only, in ordinal order', async () => {
    const client = await freshDatabase('ppbf_test_sparsess_stop_rules');
    try {
      await client.query(stopRuleSchemaSql);
      const insert = (org: string, id: string, ordinal: number, active: boolean, superseded: boolean) =>
        client.query(
          `insert into pilot.universal_stop_rules
             (organization_id, universal_rule_id, lineage_id, version, ordinal, condition_text, rule_kind, active,
              superseded_at)
           values ($1,$2,$2,1,$3,$4,'safety',$5, case when $6 then now() else null end)`,
          [org, id, ordinal, `rule ${id}`, active, superseded],
        );
      await insert(ORG_A, 'ust_b', 2, true, false);
      await insert(ORG_A, 'ust_a', 1, true, false);
      await insert(ORG_A, 'ust_withdrawn', 3, false, false);
      await insert(ORG_A, 'ust_superseded', 4, true, true);
      await insert(ORG_B, 'ust_other_gym', 1, true, false);

      const rules = await listActiveUniversalStopRules(ORG_A);
      expect(rules.map((rule) => rule.universal_rule_id)).toEqual(['ust_a', 'ust_b']);
      expect(rules[0]).toEqual({ universal_rule_id: 'ust_a', ordinal: 1, condition_text: 'rule ust_a', rule_kind: 'safety' });
    } finally {
      await closeClient(client);
    }
  });
});
