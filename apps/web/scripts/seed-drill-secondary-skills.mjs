import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Loads secondary skill relationships into pilot.drill_secondary_skills.
 *
 * WHY THIS IS ITS OWN LOADER AND NOT PART OF seed-drill-library.mjs.
 *
 * That loader writes 119 drills plus their scale levels, stop rules and cues
 * in ONE transaction. Adding one relationship row to it would mean re-running
 * the whole library to change a relationship, and a failure anywhere in that
 * chain would roll back the relationship too. The relationship table is also a
 * different KIND of data: drill_library rows are content, these are assertions
 * ABOUT content, and they are expected to change independently and often as
 * taxonomy reconciliation proceeds family by family.
 *
 * WHAT IT REFUSES TO DO, WHICH IS THE POINT.
 *
 * A row here says "this drill also trains that skill". Getting it wrong is not
 * a crash -- it silently widens what a coach's related-skill search returns.
 * So every row is validated AGAINST THE DATABASE before insert, not merely
 * parsed:
 *
 *   - the drill must exist in the SAME organization being seeded;
 *   - that drill must already have a primary skill owner (a drill with no
 *     primary cannot coherently have a secondary);
 *   - the value must look like an operational SK-* code;
 *   - the value must NOT be a SKILL-* family id -- family ids are derived
 *     through skillFamilies.ts and must never reach a skill column;
 *   - the value must differ from the drill's own primary, because a secondary
 *     restating the primary is the redundancy the owner model forbids;
 *   - and where the CSV pins an expected primary, the database's actual
 *     primary must match it.
 *
 * A row failing any of these is REJECTED and the run fails. It is never
 * skipped quietly and never "repaired" -- if the database disagrees with the
 * CSV about a drill's primary owner, that disagreement is the finding.
 *
 * IDEMPOTENT on the table's own primary key
 * (organization_id, drill_id, skill_id). There is no surrogate id and no
 * provenance column, so there is nothing to update on conflict -- a re-run
 * inserts nothing and reports it as already present.
 *
 * NO SEEDER ACCOUNT. Unlike drill-library and session-scripts, this table has
 * no created_by column, so PPBF_SEED_ACCOUNT_ID is deliberately not read.
 *
 * --dry-run runs every insert and every validation for real, inside a
 * transaction, and always rolls back.
 *
 * Placeholders: the CSV carries the literal {{PPBF_ORG_ID}}, substituted here
 * at load time -- never commit a real organization id into a seed CSV.
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

// Same hand-rolled RFC 4180 parser as the sibling loaders, duplicated rather
// than imported -- scripts/*.mjs in this repo are self-contained.
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

/**
 * The primary owner this loader requires a named drill to already have.
 *
 * Kept in source rather than as a CSV column on purpose: it is an ASSERTION
 * about the destination database, not seed content, and putting it in the CSV
 * would let a future edit weaken the check and the data in one stroke. If the
 * database's primary for one of these drills is anything else, the taxonomy
 * decision behind the relationship no longer holds and the run must stop for a
 * human rather than write the row anyway.
 */
const EXPECTED_PRIMARY = {
  drl_3df01682e604dd: 'SK-CROSS-01',
};

async function validateRow(client, record) {
  const organizationId = String(record.organization_id ?? '').trim();
  const drillId = String(record.drill_id ?? '').trim();
  const skillId = String(record.skill_id ?? '').trim();

  if (!organizationId || !drillId || !skillId) {
    throw new Error(`SECONDARY_SKILL_ROW_INCOMPLETE: ${drillId || '(no drill_id)'}`);
  }

  // Checked before the SK- shape test, because "SKILL-01" also starts with
  // "SK" -- a prefix check alone would admit exactly the value this rule
  // exists to keep out of the column.
  if (skillId.toUpperCase().startsWith('SKILL-')) {
    throw new Error(
      `SECONDARY_SKILL_IS_FAMILY_ID: ${drillId} -> ${skillId}. `
      + 'Family ids are derived through skillFamilies.ts and are never stored in a skill column.',
    );
  }

  if (!skillId.startsWith('SK-')) {
    throw new Error(`SECONDARY_SKILL_NOT_A_CODE: ${drillId} -> ${skillId}`);
  }

  const { rows } = await client.query(
    `select skill_id from pilot.drill_library
     where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );

  if (rows.length === 0) {
    // Organization-scoped on purpose: a drill existing in ANOTHER organization
    // is not a match, and the composite foreign key would refuse the insert
    // anyway. Failing here names the reason instead of surfacing a constraint.
    throw new Error(`SECONDARY_SKILL_DRILL_NOT_FOUND_IN_ORG: ${drillId}`);
  }

  const primary = rows[0].skill_id;

  if (primary === null || String(primary).trim() === '') {
    throw new Error(`SECONDARY_SKILL_DRILL_HAS_NO_PRIMARY: ${drillId}`);
  }

  if (primary === skillId) {
    throw new Error(`SECONDARY_SKILL_EQUALS_PRIMARY: ${drillId} -> ${skillId}`);
  }

  const expected = EXPECTED_PRIMARY[drillId];
  if (expected !== undefined && primary !== expected) {
    throw new Error(
      `SECONDARY_SKILL_PRIMARY_MISMATCH: ${drillId} has primary ${primary}, expected ${expected}. `
      + 'Refusing to write a relationship whose approval assumed a different primary owner.',
    );
  }

  return { organizationId, drillId, skillId };
}

async function seedSecondarySkills(client, records, { dryRun }) {
  let inserted = 0;
  let alreadyPresent = 0;
  let rejected = 0;

  for (const record of records) {
    let row;
    try {
      row = await validateRow(client, record);
    } catch (error) {
      rejected += 1;
      // Counted and re-thrown: the transaction must not commit a partial set,
      // and a rejected row is a decision for a human, not a warning to skip.
      console.error(`${dryRun ? '[dry-run] ' : ''}rejected: ${String(error.message ?? error)}`);
      throw error;
    }

    const result = await client.query(
      `insert into pilot.drill_secondary_skills (organization_id, drill_id, skill_id)
       values ($1,$2,$3)
       on conflict (organization_id, drill_id, skill_id) do nothing
       returning drill_id`,
      [row.organizationId, row.drillId, row.skillId],
    );

    if (result.rows.length > 0) {
      inserted += 1;
    } else {
      alreadyPresent += 1;
    }
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}drill secondary skills: `
    + `inserted=${inserted} already_present=${alreadyPresent} rejected=${rejected}`,
  );
  return { inserted, alreadyPresent, rejected };
}

export async function seedAll(client, seedDir, placeholders, { dryRun = false } = {}) {
  await client.query('BEGIN');
  let summary;
  try {
    const records = await loadCsvRecords(
      path.join(seedDir, 'seed_drill_secondary_skills.csv'),
      placeholders,
    );
    summary = await seedSecondarySkills(client, records, { dryRun });
  } finally {
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('[dry-run] Rolled back. Nothing was written.');
    } else {
      // A rejected row throws out of the try, so this COMMIT is only reached
      // when every row validated. The rollback on failure is PostgreSQL's:
      // the aborted transaction cannot commit.
      await client.query('COMMIT');
    }
  }
  return summary;
}

export async function run() {
  const dryRun = process.argv.includes('--dry-run');

  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');
  // No default -- a loader that guesses its owning organization writes real
  // rows under the wrong one, silently. seedWorkflowContract.test.ts asserts
  // no seed loader falls back here.
  const organizationId = required('PPBF_SEED_ORG_ID');

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
    await seedAll(client, seedDir, { organizationId }, { dryRun });
  } finally {
    await client.end();
  }

  // Target host and database are printed; the organization id is NOT. The app
  // treats it as a secret and the workflow masks it, so echoing it here would
  // put it in a run log anyone with repo read access can see. The sibling
  // loaders print it; this one deliberately does not.
  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(
    dryRun
      ? 'PILOT DRILL SECONDARY SKILLS SEED DRY-RUN PASS'
      : 'PILOT DRILL SECONDARY SKILLS SEED PASS',
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL SECONDARY SKILLS SEED FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
