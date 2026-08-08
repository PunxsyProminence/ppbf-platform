import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the 5 discipline rows (boxing, wrestling, bjj, combatives,
 * conditioning) into pilot.disciplines. Boxing and conditioning seed
 * `active=true`; wrestling, bjj and combatives seed `active=false` --
 * present in the registry so grappling_exposure/athlete_discipline_participation
 * can FK against them, but not yet a lane with curriculum content.
 *
 * IDEMPOTENT on the table's own primary key (organization_id, discipline).
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

// Same hand-rolled RFC 4180 parser as seed-drill-library.mjs/seed-workout-templates.mjs,
// duplicated rather than imported -- scripts/*.mjs in this repo are self-contained.
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

function toBool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

function toTextOrNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

async function seedDisciplines(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.disciplines (
         organization_id, discipline, display_name, lane, exposure_model, governing_body,
         age_policy_source, youth_permitted, adult_permitted, mixed_age_permitted,
         evidence_note, active
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (organization_id, discipline) do nothing
       returning discipline`,
      [
        record.organization_id,
        record.discipline,
        record.display_name,
        record.lane,
        record.exposure_model,
        toTextOrNull(record.governing_body),
        toTextOrNull(record.age_policy_source),
        toBool(record.youth_permitted),
        toBool(record.adult_permitted),
        toBool(record.mixed_age_permitted),
        record.evidence_note || '',
        record.active === '' ? true : toBool(record.active),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}disciplines: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  await client.query('BEGIN');
  try {
    const records = await loadCsvRecords(path.join(seedDir, 'seed_disciplines.csv'), placeholders);
    await seedDisciplines(client, records, { dryRun });
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
  // No default -- see the note in seed-drill-library.mjs. A loader that guesses
  // its owning organization writes real rows under the wrong one, silently.
  const organizationId = required('PPBF_SEED_ORG_ID');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedDir = path.resolve(__dirname, '../seed-data/multidiscipline');

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
  console.log(dryRun ? 'PILOT DISCIPLINES SEED DRY-RUN PASS' : 'PILOT DISCIPLINES SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DISCIPLINES SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
