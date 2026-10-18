// Real PostgreSQL contract test for pilot_slice_postgres_athlete_self_report_measures_migration.sql
// (lane L58: mood, session type, sparring symptom flag, cycle tracking).
//
// What needs a real database to prove: that each new value is refused outside its scale or
// vocabulary and absent stays absent; that a symptom report is a list and nothing else, one per
// athlete per day per context; that 'sparring_symptom' reaches the escalation ladder from a
// database that predates it, and that re-running the older escalations file does not narrow it
// back; that a cycle entry cannot exist without the athlete's opt-in and goes when the opt-in goes;
// that every athlete row here goes with the athlete; that rows already stored keep their values;
// that the file holds nothing destructive; and that the runner's readiness refuses a result it did
// not produce. Spins up the disposable local embedded Postgres the other migration suites use. It
// never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);
// initdb alone has taken ~170 s on a loaded Windows laptop (2026-10-18); CI starts in seconds.
const STARTUP_TIMEOUT_MS = 300_000;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-self-report-measures-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-self-report-measures-migration.mjs');
const ESCALATIONS_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-safety-escalations-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_self_report_measures_migration.sql';
const ESCALATIONS_FILE = 'pilot_slice_postgres_safety_escalations_migration.sql';

const ORG = 'org-selfreport';
const OTHER_ORG = 'org-selfreport-other';
const COACH = 'acct-selfreport-coach';
const ATHLETE = 'ATH-SELFREPORT-1';
const OTHER_ATHLETE = 'ATH-SELFREPORT-2';

// The escalation vocabulary before this migration, as the escalations file carried it.
const PRE_L58_SOURCE_TYPES = [
  'near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern', 'athlete_voice',
  'training_hold', 'incident', 'video_scan', 'compliance_violation', 'shadow_disclosure',
];

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let applyEscalationsRunner: Apply;
let migrationSql: string;
let escalationsSql: string;

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

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  for (const athlete of [ATHLETE, OTHER_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Self Report Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, athlete, COACH],
    );
  }
  return client;
}

function checkIn(client: Client, values: { id?: string; mood?: unknown; day?: string } = {}) {
  return client.query(
    `insert into pilot.athlete_check_ins (organization_id, check_in_id, athlete_id, checked_in_on, energy, mood)
     values ($1, $2, $3, $4::date, 4, $5)`,
    [ORG, values.id ?? 'ci-1', ATHLETE, values.day ?? '2026-10-17', values.mood ?? null],
  );
}

function session(client: Client, values: { id?: string; type?: unknown } = {}) {
  return client.query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes,
       completed_flag, created_at, updated_at, session_type)
     values ($1, $2, $3, '2026-10-17', 7, 'athlete_post_session_self_report', '', true, now(), now(), $4)`,
    [ORG, values.id ?? 'sess-1', ATHLETE, values.type ?? null],
  );
}

function symptomReport(
  client: Client,
  values: { id?: string; athlete?: string; day?: string; context?: string; symptoms?: unknown } = {},
) {
  return client.query(
    `insert into pilot.sparring_symptom_reports (organization_id, report_id, athlete_id, reported_on, context, symptoms)
     values ($1, $2, $3, $4::date, $5, $6::text[])`,
    [
      ORG,
      values.id ?? 'rep-1',
      values.athlete ?? ATHLETE,
      values.day ?? '2026-10-17',
      values.context ?? 'after_sparring',
      values.symptoms ?? ['headache'],
    ],
  );
}

function escalation(client: Client, sourceType: string, id = 'esc-1') {
  return client.query(
    `insert into pilot.safety_escalations (organization_id, escalation_id, source_type, source_id, athlete_id,
       severity, reason, escalated_to_role, triggered_by)
     values ($1, $2, $3, 'rep-1', $4, 'high', 'Reported after sparring: headache.', 'coach', 'human')`,
    [ORG, id, sourceType, ATHLETE],
  );
}

async function narrowEscalationSourcesToPreL58(client: Client): Promise<void> {
  await client.query('alter table pilot.safety_escalations drop constraint safety_escalations_source_type_check');
  await client.query(
    `alter table pilot.safety_escalations add constraint safety_escalations_source_type_check
       check (source_type in (${PRE_L58_SOURCE_TYPES.map((type) => `'${type}'`).join(', ')}))`,
  );
}

async function count(client: Client, table: string): Promise<number> {
  const result = await client.query(`select count(*)::int as n from ${table}`);
  return result.rows[0].n;
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
    }, STARTUP_TIMEOUT_MS);
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  applyEscalationsRunner = (await nativeDynamicImport(pathToFileURL(ESCALATIONS_RUNNER_PATH).href))
    .applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  escalationsSql = await fs.readFile(path.join(INFRA_DIR, ESCALATIONS_FILE), 'utf8');
}, STARTUP_TIMEOUT_MS + 30_000);

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

describe('athlete self-report measures migration (L58)', () => {
  test('applies on top of the full schema, and re-applying through the runner is a no-op', async () => {
    const client = await freshDatabase('selfrep_rerun');
    try {
      await checkIn(client, { mood: 4 });
      await session(client, { type: 'sparring' });
      await symptomReport(client);
      await client.query(`insert into pilot.athlete_cycle_tracking (organization_id, athlete_id) values ($1, $2)`, [ORG, ATHLETE]);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      expect((await client.query('select mood from pilot.athlete_check_ins')).rows).toEqual([{ mood: 4 }]);
      expect((await client.query('select session_type from pilot.sessions')).rows).toEqual([{ session_type: 'sparring' }]);
      expect(await count(client, 'pilot.sparring_symptom_reports')).toBe(1);
      expect(await count(client, 'pilot.athlete_cycle_tracking')).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('rows stored before the migration keep every value; the new fields start absent', async () => {
    const client = await freshDatabase('selfrep_existing');
    try {
      // Stand the database where production is today: none of this migration's objects.
      await client.query('drop table pilot.athlete_cycle_entries, pilot.athlete_cycle_tracking, pilot.sparring_symptom_reports, pilot.organization_symptom_flag_settings');
      await client.query('alter table pilot.athlete_check_ins drop column mood');
      await client.query('alter table pilot.sessions drop column session_type');
      await client.query(
        `insert into pilot.athlete_check_ins (organization_id, check_in_id, athlete_id, checked_in_on, energy, soreness, sleep_hours, stress, note)
         values ($1, 'ci-old', $2, '2026-10-01', 3, 2, 7.5, 4, 'tired')`,
        [ORG, ATHLETE],
      );
      await client.query(
        `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag,
           created_at, updated_at, duration_minutes)
         values ($1, 'sess-old', $2, '2026-10-01', 6, 'athlete_post_session_self_report', 'pads', true, now(), now(), 60)`,
        [ORG, ATHLETE],
      );

      await applyRunner(client, migrationSql);

      const checkIns = await client.query(
        'select energy, soreness, sleep_hours::float8 as sleep_hours, stress, note, mood from pilot.athlete_check_ins',
      );
      expect(checkIns.rows).toEqual([{ energy: 3, soreness: 2, sleep_hours: 7.5, stress: 4, note: 'tired', mood: null }]);
      const sessions = await client.query(
        'select rpe::float8 as rpe, rpe_method, notes, duration_minutes, session_type from pilot.sessions',
      );
      expect(sessions.rows).toEqual([
        { rpe: 6, rpe_method: 'athlete_post_session_self_report', notes: 'pads', duration_minutes: 60, session_type: null },
      ]);
    } finally {
      await client.end();
    }
  });

  test('mood is 1-5 or absent', async () => {
    const client = await freshDatabase('selfrep_mood');
    try {
      await checkIn(client, { id: 'ci-null', day: '2026-10-10' });
      for (const [index, mood] of [1, 5].entries()) {
        await checkIn(client, { id: `ci-${mood}`, day: `2026-10-1${index + 1}`, mood });
      }
      for (const mood of [0, 6]) {
        await expect(checkIn(client, { id: `ci-bad-${mood}`, day: '2026-10-15', mood })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_athlete_check_ins_mood_check',
        });
      }
      const rows = await client.query('select mood from pilot.athlete_check_ins order by checked_in_on');
      expect(rows.rows.map((row) => row.mood)).toEqual([null, 1, 5]);
    } finally {
      await client.end();
    }
  });

  test('session type is one of the six tags or absent', async () => {
    const client = await freshDatabase('selfrep_session_type');
    try {
      const tags = ['technique', 'bag_pads', 'conditioning', 'sparring', 'mixed', 'other'];
      for (const tag of tags) await session(client, { id: `sess-${tag}`, type: tag });
      await session(client, { id: 'sess-none' });
      for (const bad of ['boxing', 'Sparring', '']) {
        await expect(session(client, { id: `sess-bad-${bad}`, type: bad })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_sessions_session_type_check',
        });
      }
      expect(await count(client, 'pilot.sessions')).toBe(tags.length + 1);
    } finally {
      await client.end();
    }
  });

  test('symptom-flag settings default to the coach and no protocol text, and stay inside their vocabulary', async () => {
    const client = await freshDatabase('selfrep_settings');
    try {
      await client.query('insert into pilot.organization_symptom_flag_settings (organization_id) values ($1)', [ORG]);
      const row = await client.query('select recipient_role, protocol_text from pilot.organization_symptom_flag_settings');
      expect(row.rows).toEqual([{ recipient_role: 'coach', protocol_text: '' }]);

      await expect(
        client.query(`insert into pilot.organization_symptom_flag_settings (organization_id, recipient_role) values ($1, 'parent')`, [OTHER_ORG]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_org_symptom_flag_settings_role_check' });
      await expect(
        client.query(`insert into pilot.organization_symptom_flag_settings (organization_id, protocol_text) values ($1, $2)`, [OTHER_ORG, 'x'.repeat(1001)]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_org_symptom_flag_settings_protocol_check' });
      await expect(
        client.query(`insert into pilot.organization_symptom_flag_settings (organization_id) values ('nobody-here')`),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_org_symptom_flag_settings_org_fk' });

      await client.query(`insert into pilot.organization_symptom_flag_settings (organization_id, recipient_role) values ($1, 'organization_admin')`, [OTHER_ORG]);
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG]);
      expect(await count(client, 'pilot.organization_symptom_flag_settings')).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a symptom report is a list of the seven items and nothing else; "None of these" is an empty list', async () => {
    const client = await freshDatabase('selfrep_symptoms');
    try {
      await symptomReport(client, { id: 'rep-none', symptoms: [] });
      await symptomReport(client, {
        id: 'rep-all',
        context: 'next_day',
        symptoms: ['headache', 'dizzy', 'nausea', 'foggy', 'vision', 'ringing', 'hard_head_shot'],
      });
      for (const [id, symptoms] of [
        ['rep-unknown', ['concussion']],
        ['rep-null', ['headache', null]],
        ['rep-score', ['3']],
      ] as const) {
        await expect(symptomReport(client, { id, day: '2026-10-18', symptoms })).rejects.toMatchObject({
          code: '23514',
          constraint: 'pilot_sparring_symptom_reports_symptoms_check',
        });
      }
      await expect(symptomReport(client, { id: 'rep-ctx', day: '2026-10-18', context: 'before_sparring' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'pilot_sparring_symptom_reports_context_check',
      });
      const columns = await client.query(
        `select column_name from information_schema.columns
          where table_schema = 'pilot' and table_name = 'sparring_symptom_reports' order by column_name`,
      );
      // No total, severity or score column exists to hold one.
      expect(columns.rows.map((row) => row.column_name)).toEqual(
        ['athlete_id', 'context', 'created_at', 'organization_id', 'report_id', 'reported_on', 'symptoms'],
      );
    } finally {
      await client.end();
    }
  });

  test('one symptom report per athlete, per day, per context', async () => {
    const client = await freshDatabase('selfrep_symptom_day');
    try {
      await symptomReport(client);
      await expect(symptomReport(client, { id: 'rep-2' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_sparring_symptom_reports_one_per_day',
      });
      await symptomReport(client, { id: 'rep-next', context: 'next_day' });
      await symptomReport(client, { id: 'rep-other', athlete: OTHER_ATHLETE });
      await symptomReport(client, { id: 'rep-tomorrow', day: '2026-10-18' });
      expect(await count(client, 'pilot.sparring_symptom_reports')).toBe(4);
    } finally {
      await client.end();
    }
  });

  test("'sparring_symptom' is an escalation source on the full schema", async () => {
    const client = await freshDatabase('selfrep_escalation');
    try {
      await escalation(client, 'sparring_symptom');
      await expect(escalation(client, 'sparring_score', 'esc-2')).rejects.toMatchObject({
        code: '23514',
        constraint: 'safety_escalations_source_type_check',
      });
    } finally {
      await client.end();
    }
  });

  test('this file widens a database whose escalation sources predate it, and keeps every older source', async () => {
    const client = await freshDatabase('selfrep_escalation_widen');
    try {
      await narrowEscalationSourcesToPreL58(client);
      await expect(escalation(client, 'sparring_symptom')).rejects.toMatchObject({ code: '23514' });

      await applyRunner(client, migrationSql);

      await escalation(client, 'sparring_symptom');
      for (const [index, type] of PRE_L58_SOURCE_TYPES.entries()) await escalation(client, type, `esc-old-${index}`);
      expect(await count(client, 'pilot.safety_escalations')).toBe(PRE_L58_SOURCE_TYPES.length + 1);
    } finally {
      await client.end();
    }
  });

  test('the escalations file, re-run, widens a stale database too and never narrows this one back', async () => {
    const client = await freshDatabase('selfrep_escalation_rerun');
    try {
      await narrowEscalationSourcesToPreL58(client);
      await applyEscalationsRunner(client, escalationsSql);
      await escalation(client, 'sparring_symptom');

      await applyRunner(client, migrationSql);
      await applyEscalationsRunner(client, escalationsSql);
      await escalation(client, 'sparring_symptom', 'esc-2');
      expect(await count(client, 'pilot.safety_escalations')).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('a cycle entry cannot exist without the athlete opting in, and turning it off deletes every entry', async () => {
    const client = await freshDatabase('selfrep_cycle_opt_in');
    try {
      const entry = (id: string, day: string, athlete = ATHLETE) => client.query(
        `insert into pilot.athlete_cycle_entries (organization_id, entry_id, athlete_id, period_started_on) values ($1, $2, $3, $4::date)`,
        [ORG, id, athlete, day],
      );
      await expect(entry('cyc-1', '2026-10-01')).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_athlete_cycle_entries_tracking_fk',
      });

      await client.query(`insert into pilot.athlete_cycle_tracking (organization_id, athlete_id) values ($1, $2), ($1, $3)`, [ORG, ATHLETE, OTHER_ATHLETE]);
      await entry('cyc-1', '2026-09-03');
      await entry('cyc-2', '2026-10-01');
      await entry('cyc-other', '2026-10-01', OTHER_ATHLETE);
      await expect(entry('cyc-3', '2026-10-01')).rejects.toMatchObject({
        code: '23505',
        constraint: 'pilot_athlete_cycle_entries_one_per_day',
      });

      await client.query('delete from pilot.athlete_cycle_tracking where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
      const left = await client.query('select entry_id from pilot.athlete_cycle_entries');
      expect(left.rows).toEqual([{ entry_id: 'cyc-other' }]);
    } finally {
      await client.end();
    }
  });

  test('deleting the athlete deletes their symptom reports, escalations, cycle opt-in and cycle entries', async () => {
    const client = await freshDatabase('selfrep_purge');
    try {
      await symptomReport(client);
      await symptomReport(client, { id: 'rep-other', athlete: OTHER_ATHLETE });
      await escalation(client, 'sparring_symptom');
      await client.query(`insert into pilot.athlete_cycle_tracking (organization_id, athlete_id) values ($1, $2), ($1, $3)`, [ORG, ATHLETE, OTHER_ATHLETE]);
      await client.query(
        `insert into pilot.athlete_cycle_entries (organization_id, entry_id, athlete_id, period_started_on)
         values ($1, 'cyc-1', $2, '2026-10-01'), ($1, 'cyc-2', $3, '2026-10-01')`,
        [ORG, ATHLETE, OTHER_ATHLETE],
      );

      // What the retention purge runs (scripts/pilot-cleanup-deleted-data.mjs).
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);

      for (const table of ['sparring_symptom_reports', 'athlete_cycle_tracking', 'athlete_cycle_entries', 'safety_escalations']) {
        const rows = await client.query(`select athlete_id from pilot.${table}`);
        expect({ table, athletes: rows.rows.map((row) => row.athlete_id) }).toEqual({
          table,
          athletes: table === 'safety_escalations' ? [] : [OTHER_ATHLETE],
        });
      }
    } finally {
      await client.end();
    }
  });

  test('the cycle tables hold dates only: no length, phase or prediction column', async () => {
    const client = await freshDatabase('selfrep_cycle_columns');
    try {
      const columns = await client.query(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'pilot' and table_name in ('athlete_cycle_tracking', 'athlete_cycle_entries')
          order by table_name, column_name`,
      );
      expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
        'athlete_cycle_entries.athlete_id',
        'athlete_cycle_entries.created_at',
        'athlete_cycle_entries.entry_id',
        'athlete_cycle_entries.organization_id',
        'athlete_cycle_entries.period_started_on',
        'athlete_cycle_tracking.athlete_id',
        'athlete_cycle_tracking.opted_in_at',
        'athlete_cycle_tracking.organization_id',
      ]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive; its one drop is the guarded escalation-constraint widening', () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function|view)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql.match(/\bdrop\s+constraint\b/g)).toHaveLength(1);
    expect(sql).toContain("execute format('alter table pilot.safety_escalations drop constraint %i', stale_constraint)");
  });

  test('the runner refuses a symptom check of that name that admits a score', async () => {
    const client = await freshDatabase('selfrep_wide_symptoms');
    try {
      await expect(applyRunner(client, `
        alter table pilot.sparring_symptom_reports drop constraint pilot_sparring_symptom_reports_symptoms_check;
        alter table pilot.sparring_symptom_reports add constraint pilot_sparring_symptom_reports_symptoms_check
          check (array_position(symptoms, null) is null)`)).rejects.toThrow('ATHLETE_SELF_REPORT_MEASURES_NOT_READY: symptom_list_check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses cycle entries that hang off the athlete instead of the opt-in', async () => {
    const client = await freshDatabase('selfrep_cycle_fk');
    try {
      await expect(applyRunner(client, `
        alter table pilot.athlete_cycle_entries drop constraint pilot_athlete_cycle_entries_tracking_fk;
        alter table pilot.athlete_cycle_entries add constraint pilot_athlete_cycle_entries_tracking_fk
          foreign key (organization_id, athlete_id) references pilot.athletes (organization_id, athlete_id) on delete cascade`))
        .rejects.toThrow('ATHLETE_SELF_REPORT_MEASURES_NOT_READY: cycle_entries_opt_in_fk_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a settings table whose default recipient is not the coach', async () => {
    const client = await freshDatabase('selfrep_default_role');
    try {
      await expect(applyRunner(
        client,
        `alter table pilot.organization_symptom_flag_settings alter column recipient_role set default 'organization_admin'`,
      )).rejects.toThrow('ATHLETE_SELF_REPORT_MEASURES_NOT_READY: settings_default_coach_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('selfrep_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('ATHLETE_SELF_REPORT_MEASURES_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
