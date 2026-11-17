import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report: how many USA Boxing medical restriction records hold BOTH
 * of the values the staff form used to pre-pick.
 *
 * WHY THIS EXISTS (OD-2026-11-17-009; Jason's card OW25-36 A, and the
 * 2026-11-17 14:02 Backbone note asking for "a count only; no member names or
 * record details in any report, PR or chat"). Until lane DFX-a, "Record a
 * medical restriction" on /coach/medical-restrictions opened with Source
 * "Ringside Restriction Affidavit" (`ringside_affidavit`) and Loss of
 * consciousness "None" (`none`) already chosen (EMPTY_RECORD in
 * MedicalRestrictionsPanel.tsx), so a coach who skipped either field saved
 * an answer nobody gave. The columns themselves have no database default
 * (infra/azure/pilot_slice_postgres_medical_restrictions_migration.sql), so
 * those values can only have come from the form or from a person choosing
 * them.
 *
 * WHAT IT CANNOT TELL YOU. A stored row does not say whether its values were
 * chosen or left at the pre-pick, so this reports "records holding both
 * pre-set values", never "records saved without an answer".
 *
 * WHAT IT PRINTS. Three counts and nothing else: no ids, no names, no dates,
 * no organization, no row data of any kind. Counts are over the whole table
 * (every organization), because a per-organization line would print an
 * organization id. A database where the migration was never applied (the
 * table is missing, SQLSTATE 42P01) prints "table not present", never 0.
 *
 * SELECT only, inside an explicit READ ONLY transaction, so Postgres itself
 * refuses any write. Unlike the older check scripts, this one does NOT read
 * apps/web/.env.local: that file points at production on the build machine,
 * and a medical-records count should only ever run where the connection
 * string was handed to it on purpose (run-checks.yml, or an exported
 * AZURE_POSTGRES_CONNECTION_STRING).
 *
 * A REPORT, not a gate: it exits 0 whenever it ran, whatever the counts are.
 * Read the counts in the log, not the run's colour.
 */

export const PRESET_SOURCE = 'ringside_affidavit';
export const PRESET_LOSS_OF_CONSCIOUSNESS = 'none';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Export it before running this script; it does not read apps/web/.env.local.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * @returns {Promise<{ tablePresent: false } | { tablePresent: true, totalRecords: number,
 *   bothPresetValues: number, bothPresetValuesNotVoided: number }>}
 */
export async function checkMedicalRestrictionPresets(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    let rows;
    try {
      ({ rows } = await client.query(
        `select count(*)::int as total_records,
                count(*) filter (where source = $1 and loss_of_consciousness = $2)::int as both_preset_values,
                count(*) filter (where source = $1 and loss_of_consciousness = $2
                                   and voided_at is null)::int as both_preset_values_not_voided
           from pilot.medical_restrictions`,
        [PRESET_SOURCE, PRESET_LOSS_OF_CONSCIOUSNESS],
      ));
    } catch (error) {
      if (error && typeof error === 'object' && error.code === '42P01') return { tablePresent: false };
      throw error;
    }
    const [row] = rows;
    return {
      tablePresent: true,
      totalRecords: row.total_records,
      bothPresetValues: row.both_preset_values,
      bothPresetValuesNotVoided: row.both_preset_values_not_voided,
    };
  } finally {
    // Read-only: nothing to commit, and rolling back is the honest end for a report.
    await client.query('ROLLBACK').catch(() => {});
  }
}

/** The lines the report prints. Counts and fixed words only. */
export function reportLines(result) {
  const lines = ['USA Boxing medical restriction pre-set values check', '=================================================='];
  if (!result.tablePresent) {
    lines.push('pilot.medical_restrictions: table not present (the medical-restrictions migration is not applied here).');
    return lines;
  }
  lines.push(
    `total_records: ${result.totalRecords}`,
    `both_preset_values: ${result.bothPresetValues}`,
    `both_preset_values_not_voided: ${result.bothPresetValuesNotVoided}`,
    '',
    `"Records holding both pre-set values" means source = '${PRESET_SOURCE}' and loss_of_consciousness = '${PRESET_LOSS_OF_CONSCIOUSNESS}'.`,
    'A count cannot tell a skipped field from a chosen one.',
  );
  return lines;
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let result;
  try {
    result = await checkMedicalRestrictionPresets(client);
  } finally {
    await client.end();
  }
  for (const line of reportLines(result)) console.log(line);
  return result;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
    process.exit(0);
  } catch (error) {
    // The error's class and SQLSTATE only: a driver message can carry a
    // connection detail, and this log is read in a public repository's Actions.
    console.error('MEDICAL RESTRICTION PRE-SET VALUES CHECK FAILED TO RUN');
    console.error(`${error?.name ?? 'Error'}${error?.code ? ` (${error.code})` : ''}`);
    process.exit(1);
  }
}
