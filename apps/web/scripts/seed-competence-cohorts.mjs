import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the 6 competence levels (exploring..teaching) and 6 cohort definitions
 * (Open Floor, Working Group, Pressure Group, Competition Squad, Adaptive Track,
 * Parent and Child) into pilot.competence_levels / pilot.cohort_definitions.
 *
 * IDEMPOTENT on each table's own primary key: re-running never duplicates a row
 * already present.
 *
 * --dry-run runs every insert for real, inside a transaction, and always
 * rolls back at the end.
 *
 * Placeholders: every row carries the literal string {{PPBF_ORG_ID}},
 * substituted here at load time -- never commit a real organization id into
 * a seed CSV.
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

function substitutePlaceholders(text, { organizationId }) {
  return text.replaceAll('{{PPBF_ORG_ID}}', organizationId);
}

async function loadCsvRecords(filePath, placeholders) {
  const raw = await fs.readFile(filePath, 'utf8');
  const substituted = substitutePlaceholders(raw, placeholders);
  const table = parseCsv(substituted);
  if (table.length === 0) return [];
  const [header, ...rows] = table;
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
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

function toBool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

async function seedCompetenceLevels(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.competence_levels (
         organization_id, level_key, ordinal, display_name, observable_test, typical_scale
       )
       values ($1,$2,$3,$4,$5,$6)
       on conflict (organization_id, level_key) do nothing
       returning level_key`,
      [
        record.organization_id,
        record.level_key,
        toIntOrNull(record.ordinal),
        record.display_name,
        record.observable_test,
        toTextOrNull(record.typical_scale),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}competence_levels: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

async function seedCohortDefinitions(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.cohort_definitions (
         organization_id, cohort_id, cohort_name, discipline, min_level_ordinal, max_level_ordinal,
         required_domains, tenure_bands, min_age_regulatory, max_age_regulatory, regulatory_basis,
         contact_permitted, requires_coach_approval, notes, active_flag
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (organization_id, cohort_id) do nothing
       returning cohort_id`,
      [
        record.organization_id,
        record.cohort_id,
        record.cohort_name,
        record.discipline || 'boxing',
        toIntOrNull(record.min_level_ordinal),
        toIntOrNull(record.max_level_ordinal),
        record.required_domains || '',
        record.tenure_bands || '',
        toIntOrNull(record.min_age_regulatory),
        toIntOrNull(record.max_age_regulatory),
        record.regulatory_basis || '',
        record.contact_permitted || 'none',
        record.requires_coach_approval === '' ? true : toBool(record.requires_coach_approval),
        record.notes || '',
        record.active_flag === '' ? true : toBool(record.active_flag),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}cohort_definitions: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  await client.query('BEGIN');
  try {
    const levelRecords = await loadCsvRecords(path.join(seedDir, 'seed_competence_levels.csv'), placeholders);
    await seedCompetenceLevels(client, levelRecords, { dryRun });

    const cohortRecords = await loadCsvRecords(path.join(seedDir, 'seed_cohort_definitions.csv'), placeholders);
    await seedCohortDefinitions(client, cohortRecords, { dryRun });
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

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedDir = path.resolve(__dirname, '../seed-data/competence-cohorts');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await seedAll(client, seedDir, { organizationId }, { dryRun });
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`organization_id: ${organizationId}`);
  console.log(dryRun ? 'PILOT COMPETENCE COHORTS SEED DRY-RUN PASS' : 'PILOT COMPETENCE COHORTS SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT COMPETENCE COHORTS SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
