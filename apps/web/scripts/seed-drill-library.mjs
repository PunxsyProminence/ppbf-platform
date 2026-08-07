import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the literature-grounded drill library (README_DRILL_LIBRARY_V3.md)
 * into pilot.drill_library / drill_scale_levels / drill_stop_rules /
 * drill_cues, in that FK order.
 *
 * Every generated field in this content is DRAFT -- field_provenance and
 * content_class say so on every row -- and requires floor validation
 * before it reaches athletes. Seeding it does not make it trusted; it
 * makes it present, versioned, and traceable back to grounding_claim_ids.
 *
 * IDEMPOTENT on (organization_id, discipline, name): re-running never
 * duplicates or overwrites a drill that already exists (whether this
 * loader put it there or a coach did). Uses the database's own partial
 * unique index (pilot_drill_library_one_active_name) via ON CONFLICT ...
 * DO NOTHING, the same "let the constraint decide, not a racy
 * check-then-insert" doctrine drills.ts and drillVersioning.ts already
 * follow -- so this is also safe if it were ever run twice concurrently.
 *
 * --dry-run runs every insert for real, inside a transaction, and always
 * rolls back at the end -- so what it reports is exactly what the real
 * constraint would decide, not a separately-coded prediction of it that
 * could drift from the real one.
 *
 * ONLY seed_drill_library.csv WAS ACTUALLY SUPPLIED. The scale-level,
 * stop-rule and cue seed files this loader also knows how to read do not
 * exist yet in apps/web/seed-data/drill-library/ -- their absence is
 * reported, not treated as an error, so this script is ready the day
 * those files are added without needing a code change.
 *
 * Placeholders: every row in the CSVs carries the literal strings
 * {{PPBF_ORG_ID}} and {{SEED_ACCOUNT_ID}}, substituted here at load time --
 * never commit a real organization or account id into a seed CSV.
 */

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

function assertExpectedTarget(target, expectedHostname, expectedDatabase) {
  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * RFC 4180 by hand -- same algorithm as
 * apps/web/src/server/pilot/rosterImport.ts#parseCsv, duplicated rather
 * than imported because scripts/*.mjs in this repo are plain ESM with no
 * dependency on the TypeScript app source (matching every pilot-apply-*
 * runner's own self-contained convention). Handles CRLF and LF, doubled
 * quotes inside quoted fields, embedded newlines and commas, and a leading
 * UTF-8 BOM -- all present in the supplied CSV's long free-text fields.
 */
function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      endRow();
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    endRow();
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

function substitutePlaceholders(text, { organizationId, seedAccountId }) {
  return text
    .replaceAll('{{PPBF_ORG_ID}}', organizationId)
    .replaceAll('{{SEED_ACCOUNT_ID}}', seedAccountId);
}

async function loadCsvRecords(filePath, placeholders) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const substituted = substitutePlaceholders(raw, placeholders);
  const table = parseCsv(substituted);
  if (table.length === 0) return [];
  const [header, ...rows] = table;
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}

function toBool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

function toIntOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTextOrNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

function toTextArray(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return [];
  // grounding_claim_ids is a semicolon-or-comma-separated list inside one
  // CSV cell; the cell itself was already correctly unquoted by parseCsv.
  return trimmed
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function seedDrillLibrary(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.drill_library (
         organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at,
         name, discipline, category, difficulty, skill_id, target_behavior,
         purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
         common_errors, corrections, transfer,
         contact_level, equipment_needed, requires_coach_authorization, content_class, source_ref,
         grounding_claim_ids, field_provenance,
         active, created_by_account_id, created_by_role
       )
       values (
         $1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,
         $18,$19,$20,
         $21,$22,$23,$24,$25,
         $26::text[],$27,
         $28,$29,$30
       )
       on conflict (organization_id, discipline, name) where active do nothing
       returning drill_id`,
      [
        record.organization_id,
        record.drill_id,
        record.lineage_id || record.drill_id,
        toIntOrNull(record.version) ?? 1,
        toTextOrNull(record.supersedes_drill_id),
        toTextOrNull(record.superseded_at),
        record.name,
        record.discipline || 'boxing',
        record.category,
        record.difficulty || 'intermediate',
        toTextOrNull(record.skill_id),
        record.target_behavior,
        record.purpose,
        record.standard_setup,
        record.execution,
        record.what_good_looks_like,
        record.what_bad_looks_like,
        record.common_errors || '',
        record.corrections || '',
        record.transfer || '',
        record.contact_level || 'none',
        record.equipment_needed || '',
        toBool(record.requires_coach_authorization),
        record.content_class || 'COACHING CRAFT - informed by evidence, not individually validated',
        toTextOrNull(record.source_ref),
        toTextArray(record.grounding_claim_ids),
        record.field_provenance || 'PPBF source manual v3',
        record.active === '' ? true : toBool(record.active),
        toTextOrNull(record.created_by_account_id),
        toTextOrNull(record.created_by_role),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}drill_library: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedDrillScaleLevels(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.drill_scale_levels (
         organization_id, scale_id, drill_id, scale_level, is_starting_point,
         demand_description, constraint_applied, contact_level, coach_watch_point, authoring_state
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (organization_id, drill_id, scale_level) do nothing
       returning scale_id`,
      [
        record.organization_id,
        record.scale_id,
        record.drill_id,
        record.scale_level,
        toBool(record.is_starting_point),
        record.demand_description,
        record.constraint_applied || '',
        record.contact_level || 'none',
        record.coach_watch_point || '',
        record.authoring_state || 'authored',
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}drill_scale_levels: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedDrillStopRules(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.drill_stop_rules (
         organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind
       )
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (organization_id, drill_id, ordinal) do nothing
       returning stop_rule_id`,
      [
        record.organization_id,
        record.stop_rule_id,
        record.drill_id,
        toIntOrNull(record.ordinal),
        record.condition_text,
        record.scope || 'drill_specific',
        record.rule_kind,
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}drill_stop_rules: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedDrillCues(client, records, { dryRun }) {
  let inserted = 0;

  for (const record of records) {
    await client.query(
      `insert into pilot.drill_cues (
         organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (organization_id, cue_id) do nothing`,
      [
        record.organization_id,
        record.cue_id,
        record.drill_id,
        record.cue_text,
        record.cue_family || '',
        record.focus_type || 'unspecified',
        record.evidence_note || '',
        toTextOrNull(record.source_ref),
      ],
    );
    inserted += 1;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}drill_cues: ${inserted} rows processed`);
  return { inserted, skipped: 0 };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  const files = {
    drills: 'seed_drill_library.csv',
    scaleLevels: 'seed_drill_scale_levels.csv',
    stopRules: 'seed_drill_stop_rules.csv',
    cues: 'seed_drill_cues.csv',
  };

  await client.query('BEGIN');
  try {
    const drillRecords = await loadCsvRecords(path.join(seedDir, files.drills), placeholders);
    if (drillRecords === null) {
      console.log(`${files.drills} not found in ${seedDir} -- nothing to seed for drill_library.`);
    } else {
      await seedDrillLibrary(client, drillRecords, { dryRun });
    }

    const scaleRecords = await loadCsvRecords(path.join(seedDir, files.scaleLevels), placeholders);
    if (scaleRecords === null) {
      console.log(`${files.scaleLevels} not found in ${seedDir} -- skipping drill_scale_levels (not an error; this file was never supplied).`);
    } else {
      await seedDrillScaleLevels(client, scaleRecords, { dryRun });
    }

    const stopRuleRecords = await loadCsvRecords(path.join(seedDir, files.stopRules), placeholders);
    if (stopRuleRecords === null) {
      console.log(`${files.stopRules} not found in ${seedDir} -- skipping drill_stop_rules (not an error; this file was never supplied).`);
    } else {
      await seedDrillStopRules(client, stopRuleRecords, { dryRun });
    }

    const cueRecords = await loadCsvRecords(path.join(seedDir, files.cues), placeholders);
    if (cueRecords === null) {
      console.log(`${files.cues} not found in ${seedDir} -- skipping drill_cues (not an error; this file was never supplied).`);
    } else {
      await seedDrillCues(client, cueRecords, { dryRun });
    }
  } finally {
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('[dry-run] Rolled back. Nothing was written.');
    } else {
      await client.query('COMMIT');
    }
  }
}

export async function run() {
  const dryRun = process.argv.includes('--dry-run');

  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');
  const organizationId = process.env.PPBF_SEED_ORG_ID?.trim() || 'ppbf-default-org';
  const seedAccountId = required('PPBF_SEED_ACCOUNT_ID');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedDir = path.resolve(__dirname, '../seed-data/drill-library');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await seedAll(client, seedDir, { organizationId, seedAccountId }, { dryRun });
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`organization_id: ${organizationId}`);
  console.log(dryRun ? 'PILOT DRILL LIBRARY SEED DRY-RUN PASS' : 'PILOT DRILL LIBRARY SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL LIBRARY SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
