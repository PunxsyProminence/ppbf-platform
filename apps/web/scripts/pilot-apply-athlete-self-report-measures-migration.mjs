import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete self-report measures migration (lane L58: mood, session type, sparring
// symptom flag, cycle tracking) inside one transaction. The operator names the host and database
// they believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch
// refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// A check by name ON its own table, compared to the exact text PostgreSQL prints for this
// migration's own check (runs of whitespace collapsed). A same-named check that admits more fails.
function checkIs(table, name, definition) {
  return `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}')
         and c.contype = 'c' and c.convalidated
         and c.conname = '${name}'
         and regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]]+', ' ', 'g')
           = '${definition.replace(/'/g, "''")}'
    )`;
}

// A key by name ON its own table over exactly these columns (order-free). For a foreign key: to
// this table, with ON DELETE CASCADE.
function keyIs(table, name, type, columns, references) {
  const fk = references
    ? `and c.confrelid = to_regclass('${references}') and c.confdeltype = 'c'`
    : '';
  return `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}')
         and c.conname = '${name}' and c.contype = '${type}' ${fk}
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array[${[...columns].sort().map((column) => `'${column}'`).join(', ')}]::text[]
    )`;
}

function columnIs(table, column, type) {
  return `exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = '${table}'
         and column_name = '${column}' and data_type = '${type}' and is_nullable = 'YES'
    )`;
}

const SYMPTOMS = ['headache', 'dizzy', 'nausea', 'foggy', 'vision', 'ringing', 'hard_head_shot'];
const SESSION_TYPES = ['technique', 'bag_pads', 'conditioning', 'sparring', 'mixed', 'other'];
const anyText = (values) => `ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}]`;

// Readiness asserts the result, not the attempt.
const READINESS_QUERY = `
  select
    ${columnIs('athlete_check_ins', 'mood', 'integer')} as mood_column_ready,
    ${checkIs('pilot.athlete_check_ins', 'pilot_athlete_check_ins_mood_check',
      'CHECK (((mood IS NULL) OR ((mood >= 1) AND (mood <= 5))))')} as mood_check_ready,
    ${columnIs('sessions', 'session_type', 'text')} as session_type_column_ready,
    ${checkIs('pilot.sessions', 'pilot_sessions_session_type_check',
      `CHECK (((session_type IS NULL) OR (session_type = ANY (${anyText(SESSION_TYPES)}))))`)} as session_type_check_ready,
    ${keyIs('pilot.organization_symptom_flag_settings', 'pilot_org_symptom_flag_settings_pkey', 'p', ['organization_id'])} as settings_pkey_ready,
    ${keyIs('pilot.organization_symptom_flag_settings', 'pilot_org_symptom_flag_settings_org_fk', 'f', ['organization_id'], 'pilot.organizations')} as settings_org_fk_ready,
    ${checkIs('pilot.organization_symptom_flag_settings', 'pilot_org_symptom_flag_settings_role_check',
      `CHECK ((recipient_role = ANY (${anyText(['coach', 'organization_admin', 'admin'])})))`)} as settings_role_check_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'organization_symptom_flag_settings'
         and column_name = 'recipient_role' and column_default = '''coach''::text'
    ) as settings_default_coach_ready,
    ${keyIs('pilot.sparring_symptom_reports', 'pilot_sparring_symptom_reports_pkey', 'p', ['organization_id', 'report_id'])} as symptom_pkey_ready,
    ${keyIs('pilot.sparring_symptom_reports', 'pilot_sparring_symptom_reports_athlete_fk', 'f', ['organization_id', 'athlete_id'], 'pilot.athletes')} as symptom_athlete_fk_ready,
    ${keyIs('pilot.sparring_symptom_reports', 'pilot_sparring_symptom_reports_one_per_day', 'u', ['organization_id', 'athlete_id', 'reported_on', 'context'])} as symptom_one_per_day_ready,
    ${checkIs('pilot.sparring_symptom_reports', 'pilot_sparring_symptom_reports_context_check',
      `CHECK ((context = ANY (${anyText(['after_sparring', 'next_day'])})))`)} as symptom_context_check_ready,
    ${checkIs('pilot.sparring_symptom_reports', 'pilot_sparring_symptom_reports_symptoms_check',
      `CHECK (((array_position(symptoms, NULL::text) IS NULL) AND (symptoms <@ ${anyText(SYMPTOMS)})))`)} as symptom_list_check_ready,
    exists (
      select 1 from pg_constraint
       where conrelid = to_regclass('pilot.safety_escalations')
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%source_type%'
         and pg_get_constraintdef(oid) like '%''sparring_symptom''%'
    ) as escalation_source_ready,
    ${keyIs('pilot.athlete_cycle_tracking', 'pilot_athlete_cycle_tracking_pkey', 'p', ['organization_id', 'athlete_id'])} as cycle_tracking_pkey_ready,
    ${keyIs('pilot.athlete_cycle_tracking', 'pilot_athlete_cycle_tracking_athlete_fk', 'f', ['organization_id', 'athlete_id'], 'pilot.athletes')} as cycle_tracking_athlete_fk_ready,
    ${keyIs('pilot.athlete_cycle_entries', 'pilot_athlete_cycle_entries_pkey', 'p', ['organization_id', 'entry_id'])} as cycle_entries_pkey_ready,
    ${keyIs('pilot.athlete_cycle_entries', 'pilot_athlete_cycle_entries_tracking_fk', 'f', ['organization_id', 'athlete_id'], 'pilot.athlete_cycle_tracking')} as cycle_entries_opt_in_fk_ready,
    ${keyIs('pilot.athlete_cycle_entries', 'pilot_athlete_cycle_entries_one_per_day', 'u', ['organization_id', 'athlete_id', 'period_started_on'])} as cycle_entries_one_per_day_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ATHLETE_SELF_REPORT_MEASURES_NOT_READY: ${missing.join(', ')}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_athlete_self_report_measures_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied athlete self-report measures migration: ${migrationPath}`);
  console.log('PILOT ATHLETE SELF-REPORT MEASURES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE SELF-REPORT MEASURES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
