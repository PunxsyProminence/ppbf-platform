import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the session-scripts package (3 scripts, 65 timed blocks, 4 renderings)
 * into pilot.session_scripts / session_script_blocks / session_script_renderings,
 * in FK order.
 *
 * IDEMPOTENT on each table's own primary key: re-running never duplicates a row
 * already present.
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

// Same hand-rolled RFC 4180 parser used throughout scripts/*.mjs in this repo,
// duplicated rather than imported -- these scripts are self-contained.
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
  const raw = await fs.readFile(filePath, 'utf8');
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

async function seedScripts(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.session_scripts (
         organization_id, script_id, lineage_id, version, name, discipline, theme, phase,
         day_of_week, total_minutes, contact_structure, target_group, prerequisite_note,
         reset_protocol, coach_priorities, frequent_phrases, authoring_state, source_document,
         created_by_account_id
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (organization_id, script_id) do nothing
       returning script_id`,
      [
        record.organization_id,
        record.script_id,
        record.lineage_id || record.script_id,
        toIntOrNull(record.version) ?? 1,
        record.name,
        record.discipline || 'boxing',
        record.theme || '',
        toTextOrNull(record.phase),
        toTextOrNull(record.day_of_week),
        toIntOrNull(record.total_minutes),
        record.contact_structure || 'non_contact',
        record.target_group || '',
        record.prerequisite_note || '',
        record.reset_protocol || '',
        record.coach_priorities || '',
        record.frequent_phrases || '',
        record.authoring_state || 'draft',
        record.source_document || '',
        record.created_by_account_id,
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}session_scripts: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedBlocks(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.session_script_blocks (
         organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
         block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind,
         drill_id, scale_level, contact_level
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (organization_id, block_id) do nothing
       returning block_id`,
      [
        record.organization_id,
        record.block_id,
        record.script_id,
        toIntOrNull(record.block_order),
        toIntOrNull(record.start_offset_min),
        toIntOrNull(record.end_offset_min),
        record.block_label,
        toTextOrNull(record.what_to_say),
        toTextOrNull(record.what_to_explain),
        toTextOrNull(record.what_to_watch),
        toTextOrNull(record.what_to_fix),
        record.block_kind || 'instruction',
        toTextOrNull(record.drill_id),
        toTextOrNull(record.scale_level),
        record.contact_level || 'none',
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}session_script_blocks: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedRenderings(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.session_script_renderings (
         organization_id, rendering_id, script_id, format, audience_note, body,
         generated_from_blocks
       )
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (organization_id, rendering_id) do nothing
       returning rendering_id`,
      [
        record.organization_id,
        record.rendering_id,
        record.script_id,
        record.format,
        record.audience_note || '',
        record.body,
        toBool(record.generated_from_blocks),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}session_script_renderings: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  await client.query('BEGIN');
  try {
    const scriptRecords = await loadCsvRecords(path.join(seedDir, 'seed_session_scripts.csv'), placeholders);
    await seedScripts(client, scriptRecords, { dryRun });

    const blockRecords = await loadCsvRecords(path.join(seedDir, 'seed_session_script_blocks.csv'), placeholders);
    await seedBlocks(client, blockRecords, { dryRun });

    const renderingRecords = await loadCsvRecords(path.join(seedDir, 'seed_session_script_renderings.csv'), placeholders);
    await seedRenderings(client, renderingRecords, { dryRun });
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
  // No fallback. A loader that guesses its owning organization writes real
  // rows under the wrong one, silently -- the operator's typed value
  // discarded and the run still reporting success. The three loaders the
  // workflow shipped with already refuse this way; this one did not, and
  // seedWorkflowContract.test.ts's guard did not cover it.
  const organizationId = required('PPBF_SEED_ORG_ID');
  const seedAccountId = required('PPBF_SEED_ACCOUNT_ID');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedDir = path.resolve(__dirname, '../seed-data/session-scripts');

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
  console.log(dryRun ? 'PILOT SESSION SCRIPTS SEED DRY-RUN PASS' : 'PILOT SESSION SCRIPTS SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION SCRIPTS SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
