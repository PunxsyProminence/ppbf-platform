import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the 12 workout templates / 82 items (README_DRILL_LIBRARY_V3.md's
 * sibling package) into pilot.workout_templates / workout_template_items,
 * in FK order. Every drill_id referenced already exists in the 119-drill
 * seed loaded by seed-drill-library.mjs -- that loader must run first.
 *
 * IDEMPOTENT on (organization_id, name): re-running never duplicates or
 * overwrites a template that already exists, matching
 * seed-drill-library.mjs's own ON CONFLICT ... DO NOTHING doctrine (the
 * database's own partial unique index, pilot_workout_templates_one_active_name,
 * decides -- not a racy check-then-insert).
 *
 * --dry-run runs every insert for real, inside a transaction, and always
 * rolls back at the end.
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

// Same hand-rolled RFC 4180 parser as seed-drill-library.mjs, duplicated
// rather than imported -- scripts/*.mjs in this repo are self-contained.
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

async function seedWorkoutTemplates(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.workout_templates (
         organization_id, template_id, lineage_id, version, supersedes_template_id, superseded_at,
         name, session_type, difficulty, age_band, duration_minutes, intent, coach_notes,
         requires_coach_authorization, active, created_by_account_id, created_by_role
       )
       values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       )
       on conflict (organization_id, name) where active do nothing
       returning template_id`,
      [
        record.organization_id,
        record.template_id,
        record.lineage_id || record.template_id,
        toIntOrNull(record.version) ?? 1,
        toTextOrNull(record.supersedes_template_id),
        toTextOrNull(record.superseded_at),
        record.name,
        record.session_type,
        record.difficulty || 'intermediate',
        record.age_band || 'any',
        toIntOrNull(record.duration_minutes),
        record.intent,
        toTextOrNull(record.coach_notes),
        toBool(record.requires_coach_authorization),
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

  console.log(`${dryRun ? '[dry-run] ' : ''}workout_templates: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedWorkoutTemplateItems(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.workout_template_items (
         organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill,
         scale_level, duration_minutes, rep_count, contact_level, coach_note
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (organization_id, template_id, ordinal) do nothing
       returning item_id`,
      [
        record.organization_id,
        record.item_id,
        record.template_id,
        toIntOrNull(record.ordinal),
        record.block,
        toTextOrNull(record.drill_id),
        toTextOrNull(record.free_text_drill),
        toTextOrNull(record.scale_level),
        toIntOrNull(record.duration_minutes),
        toIntOrNull(record.rep_count),
        record.contact_level || 'none',
        toTextOrNull(record.coach_note),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}workout_template_items: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  const files = {
    templates: 'seed_workout_templates.csv',
    items: 'seed_workout_template_items.csv',
  };

  await client.query('BEGIN');
  try {
    const templateRecords = await loadCsvRecords(path.join(seedDir, files.templates), placeholders);
    if (templateRecords === null) {
      console.log(`${files.templates} not found in ${seedDir} -- nothing to seed for workout_templates.`);
    } else {
      await seedWorkoutTemplates(client, templateRecords, { dryRun });
    }

    const itemRecords = await loadCsvRecords(path.join(seedDir, files.items), placeholders);
    if (itemRecords === null) {
      console.log(`${files.items} not found in ${seedDir} -- nothing to seed for workout_template_items.`);
    } else {
      await seedWorkoutTemplateItems(client, itemRecords, { dryRun });
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
  const seedDir = path.resolve(__dirname, '../seed-data/workout-templates');

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
  console.log(dryRun ? 'PILOT WORKOUT TEMPLATES SEED DRY-RUN PASS' : 'PILOT WORKOUT TEMPLATES SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WORKOUT TEMPLATES SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
