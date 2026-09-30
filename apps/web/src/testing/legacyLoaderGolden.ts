/*
 * THE ROWS THE RETIRED SEED LOADERS WROTE, FROZEN, WITH THE EXACT FILES THEY
 * READ (legacyLoaderGoldenData/rows.json and legacyLoaderGoldenData/inputs/).
 *
 * WHY THIS EXISTS. Production's reference rows were written by the
 * apps/web/scripts/seed-*.mjs loaders IMP-10 retired, and an item nobody
 * revises keeps that stored form for good: the content-import engine skips an
 * unchanged item, it never rewrites it. So every load from now on compares its
 * files with rows in the OLD loaders' form, and if the engine read any of those
 * forms as different content, a load would plan a new version of every item it
 * was meant to leave alone. Until IMP-10 the contentImport* suites proved the
 * engine reads them as unchanged by running the loaders. With the loaders
 * deleted, this is their output, captured from them before they went
 * (legacyLoaderGoldenData/generate.mjs). An engine first load is no stand-in:
 * it proves the engine reads ITS OWN stored forms, which is not the question.
 *
 * WHY THE LOADERS OF 943930d4. They are the ones the seed workflow ran before
 * this wave, and that drill loader still split grounding_claim_ids on ';' and
 * ',' only -- #1020 added '|' -- which is the form production's 2026-08-24
 * drill rows hold: a '|' list as ONE array element. The loaders at dbc3d927
 * (after #1020) wrote identical rows in every table but that column (OBSERVED
 * when this was generated, 2026-09-29).
 *
 * FROZEN INPUTS, NOT THE COMMITTED FILES. The rows are paired with the files the
 * loaders read, so a content hand-off that edits seed-data leaves this guard as
 * it was. Registries, templates and scripts are the whole files, byte-identical
 * to seed-data at 943930d4; the drills are 13 of the 119, chosen so that every
 * value shape the five drill files hold appears (generate.mjs says how).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DbClient } from '../server/pilot/contentImport/actor';
import { readDatasetFiles } from '../server/pilot/contentImport/cli';
import type { DatasetName } from '../server/pilot/contentImport/types';

const DATA_DIR = path.join(__dirname, 'legacyLoaderGoldenData');

/** The files the old loaders read, laid out as seed-data is. */
export const LEGACY_GOLDEN_INPUTS = path.join(DATA_DIR, 'inputs');

interface GoldenTable {
  columns: string[];
  rows: (string | null)[][];
}

interface Golden {
  organizationIds: string[];
  accountId: string;
  tables: Record<string, GoldenTable>;
}

const GOLDEN = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rows.json'), 'utf8')) as Golden;

/** The tables each dataset's old loader wrote, in foreign-key order. */
export const LEGACY_GOLDEN_TABLES = {
  registries: ['pilot.disciplines', 'pilot.competence_levels', 'pilot.cohort_definitions'],
  drills: ['pilot.drill_library', 'pilot.drill_scale_levels', 'pilot.drill_stop_rules', 'pilot.drill_cues', 'pilot.drill_secondary_skills'],
  templates: ['pilot.workout_templates', 'pilot.workout_template_items'],
  scripts: ['pilot.session_scripts', 'pilot.session_script_blocks', 'pilot.session_script_renderings'],
} as const;

/** The files the old loaders read for these datasets, keyed as readDatasetFiles keys the committed ones. */
export function legacyGoldenFiles(datasets: readonly DatasetName[]): Record<string, string> {
  return readDatasetFiles(LEGACY_GOLDEN_INPUTS, datasets);
}

function goldenTable(table: string): GoldenTable {
  const golden = GOLDEN.tables[table];
  if (!golden) throw new Error(`legacyLoaderGolden: no rows for ${table}`);
  return golden;
}

/** Table and column names come from the committed fixture; this keeps them plain identifiers. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(name)) throw new Error(`legacyLoaderGolden: '${name}' is not a plain SQL identifier`);
  return name;
}

/** One table's rows as the old loaders wrote them: column -> Postgres's text form (null for NULL). */
export function legacyGoldenRows(table: string): Record<string, string | null>[] {
  const { columns, rows } = goldenTable(table);
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

/**
 * Writes the old loaders' rows of these tables, in the order given, into
 * `organizationId`, with the golden gym and seed account replaced by the
 * caller's. Every value goes in as Postgres's own text form and is parsed by
 * the column's type, so '8.0' stays '8.0' and a '|' list stays one array
 * element; created_at and updated_at take their defaults.
 */
export async function insertLegacyGoldenRows(
  client: DbClient,
  tables: readonly string[],
  target: { organizationId: string; accountId: string },
): Promise<void> {
  for (const table of tables) {
    const { columns, rows } = goldenTable(table);
    const names = columns.map((column) => `"${ident(column)}"`).join(', ');
    const params = columns.map((_, index) => `$${index + 1}`).join(', ');
    for (const row of rows) {
      const values = row.map((value) => {
        if (value !== null && GOLDEN.organizationIds.includes(value)) return target.organizationId;
        return value === GOLDEN.accountId ? target.accountId : value;
      });
      await client.query(`insert into ${ident(table)} (${names}) values (${params})`, values);
    }
  }
}
