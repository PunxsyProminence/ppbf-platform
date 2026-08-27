import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads the 173 classified transfer claims (neuro_mechanism / life_skill_transfer /
 * cognitive_demand) into pilot.transfer_claims. Every claim in this seed attaches to a
 * drill_id -- seed-drill-library.mjs must run first, or the FK will reject every row.
 *
 * IDEMPOTENT on the table's own primary key (organization_id, transfer_id).
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

function toBool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

function toTextOrNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

async function seedTransferClaims(client, records, { dryRun }) {
  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const result = await client.query(
      `insert into pilot.transfer_claims (
         organization_id, transfer_id, drill_id, block_id, script_id, claim_kind, statement,
         named_structure, evidence_class, registry_claim_id, source_document, athlete_facing,
         public_facing
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (organization_id, transfer_id) do nothing
       returning transfer_id`,
      [
        record.organization_id,
        record.transfer_id,
        toTextOrNull(record.drill_id),
        toTextOrNull(record.block_id),
        toTextOrNull(record.script_id),
        record.claim_kind,
        record.statement,
        record.named_structure || '',
        record.evidence_class || 'MECHANISM-THEORISED',
        record.registry_claim_id || '',
        record.source_document || '',
        record.athlete_facing === '' ? true : toBool(record.athlete_facing),
        toBool(record.public_facing),
      ],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}transfer_claims: ${inserted} would-insert/inserted, ${skipped} already present (skipped)`);
  return { inserted, skipped };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  await client.query('BEGIN');
  try {
    const records = await loadCsvRecords(path.join(seedDir, 'seed_transfer_claims.csv'), placeholders);
    await seedTransferClaims(client, records, { dryRun });
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

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedDir = path.resolve(__dirname, '../seed-data/transfer-claims');

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
  console.log(dryRun ? 'PILOT TRANSFER CLAIMS SEED DRY-RUN PASS' : 'PILOT TRANSFER CLAIMS SEED PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT TRANSFER CLAIMS SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
