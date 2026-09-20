import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only census of the `source_ref` values pilot.drill_cues actually holds,
 * and the question it answers is the one no amount of repository reading can:
 * do the rows citing a source nobody can produce exist in THIS database?
 *
 * WHY THIS EXISTS. 238 of the 258 rows in seed_drill_cues.csv cite
 * `coach_cue_and_feedback_library.csv` as their source_ref. That file is not in
 * the repository, not in any reachable Git tree, and not a member of any of the
 * three ppbf_proposed_migrations archives -- v1, v2 and v3 were each fetched,
 * size-verified and fully enumerated, and none contains it. The provenance
 * question is therefore settled as far as sources go: the reference exists in
 * the seed lineage and the cited file does not exist in any identified
 * authoritative source. What that costs depends entirely on whether those rows
 * are only in a hand-run CSV or are sitting in a live catalogue, and nothing in
 * the repository can answer that. Seed files are not runtime, a run log is not
 * the database, and `seed:drill-library` is dispatched by hand -- so the only
 * honest way to know is to ask the database.
 *
 * IT IS A REPORT, NOT A GATE, and that is deliberate. The 238 rows are an
 * already-adjudicated condition awaiting an owner decision, not a regression: a
 * check that exited non-zero on finding them would turn `all` permanently red
 * against both environments for something nobody has been asked to fix yet, and
 * a red run that always means the same known thing stops being read. So this
 * exits zero whenever it managed to run, and the answer is the printed count.
 * Read the number, not the exit code -- the same contract seed-identity and
 * runtime-claims carry.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never prints cue_text, and it never
 * selects it: a cue is coaching instruction written for a child on a gym floor,
 * and a diagnostic has no business copying that into a CI log where the answer
 * to "how many rows" is all anyone needs. It takes no SQL and no source_ref from
 * its caller, so it cannot be turned into a query console. And it changes
 * nothing -- every statement runs inside an explicit READ ONLY transaction, so
 * Postgres itself refuses a write rather than a reviewer having to notice one is
 * absent.
 */

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
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
 * The one source_ref this check is about. A constant, not an input: an argument
 * here would make this a general-purpose row-counter pointed at any predicate an
 * operator typed, which is a query console with extra steps.
 */
const TARGET_SOURCE_REF = 'coach_cue_and_feedback_library.csv';

/**
 * Bound on the distinct source_ref values printed. The drill-library catalogue
 * ships two distinct values, so any realistic answer is far under this; the cap
 * exists so a pathological database cannot make a diagnostic print unboundedly.
 * Exceeding it is REPORTED rather than silently trimmed -- the multiorg orphan
 * check records what a quiet `limit 10` cost there.
 */
const DISTINCT_LIMIT = 200;

/** Which database this actually is, answered by the session rather than assumed. */
async function readSessionIdentity(client) {
  const result = await client.query(
    'select current_database() as database, current_user as role',
  );
  return result.rows[0];
}

/**
 * Whether pilot.drill_cues exists, asked of the catalog rather than by selecting
 * from it -- a missing table is a legitimate answer here (an environment that
 * never took the drill-library migration), and it should be reported, not raised
 * as an error.
 */
async function readTablePresence(client) {
  const result = await client.query(
    "select to_regclass('pilot.drill_cues') is not null as present",
  );
  return result.rows[0].present === true;
}

/** Total rows, and the count carrying the unsupported reference. */
async function readCounts(client) {
  const result = await client.query(
    `select count(*)::int as total,
            count(*) filter (where source_ref = $1)::int as target
     from pilot.drill_cues`,
    [TARGET_SOURCE_REF],
  );
  return result.rows[0];
}

/**
 * Rows per distinct source_ref. NULL and the empty string are kept apart: the
 * column is nullable and also defaults are not in play here, so "no source was
 * recorded" and "a source was recorded as nothing" are different findings and
 * collapsing them would hide one of them.
 */
async function readSourceRefCounts(client) {
  const result = await client.query(
    `select source_ref, count(*)::int as row_count
     from pilot.drill_cues
     group by source_ref
     order by row_count desc, source_ref
     limit ${DISTINCT_LIMIT + 1}`,
  );
  return result.rows;
}

export async function checkCueSourceProvenance(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const identity = await readSessionIdentity(client);
    const tablePresent = await readTablePresence(client);

    if (!tablePresent) {
      await client.query('COMMIT');
      return {
        database: identity.database,
        role: identity.role,
        tablePresent: false,
        total: null,
        targetCount: null,
        sourceRefs: [],
        truncated: false,
      };
    }

    const counts = await readCounts(client);
    const rows = await readSourceRefCounts(client);
    const truncated = rows.length > DISTINCT_LIMIT;

    await client.query('COMMIT');

    return {
      database: identity.database,
      role: identity.role,
      tablePresent: true,
      total: counts.total,
      targetCount: counts.target,
      sourceRefs: truncated ? rows.slice(0, DISTINCT_LIMIT) : rows,
      truncated,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** NULL and '' rendered so neither can be mistaken for the other, or for a name. */
function renderSourceRef(value) {
  if (value === null) return '(null)';
  if (value === '') return '(empty string)';
  return value;
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await checkCueSourceProvenance(client);
  } finally {
    await client.end();
  }

  console.log('Cue source_ref provenance census');
  console.log('================================');
  console.log(`DATABASE=${report.database}`);
  console.log(`ROLE=${report.role}`);
  console.log(`DRILL_CUES_TABLE_PRESENT=${report.tablePresent ? 'YES' : 'NO'}`);

  if (!report.tablePresent) {
    console.log('================================');
    console.log('PILOT CUE SOURCE PROVENANCE CENSUS: TABLE ABSENT');
    console.log(
      'pilot.drill_cues does not exist in this database, so it holds no cue rows at all '
      + 'and carries none of the unsupported reference. This is an answer, not a failure: '
      + 'an environment that never took the drill-library v3 migration looks exactly like this.',
    );
    console.log('CUE_SOURCE_PROVENANCE_CHECK_PASS');
    return report;
  }

  console.log(`TOTAL_DRILL_CUES=${report.total}`);
  for (const { source_ref: sourceRef, row_count: rowCount } of report.sourceRefs) {
    console.log(`SOURCE_REF_COUNT|${renderSourceRef(sourceRef)}|${rowCount}`);
  }
  if (report.truncated) {
    console.log(
      `!! more than ${DISTINCT_LIMIT} distinct source_ref values -- the list above is `
      + 'TRUNCATED and incomplete, and TOTAL_DRILL_CUES is the only complete figure here.',
    );
  }
  console.log(`TARGET_SOURCE_REF_COUNT=${report.targetCount}`);
  console.log('================================');

  if (report.targetCount === 0) {
    console.log('PILOT CUE SOURCE PROVENANCE CENSUS: UNSUPPORTED REFERENCE NOT PRESENT');
    console.log(
      `No row in this database cites ${TARGET_SOURCE_REF}. The unsupported provenance is `
      + 'confined to the seed source here.',
    );
  } else {
    console.log(
      `PILOT CUE SOURCE PROVENANCE CENSUS: UNSUPPORTED REFERENCE LIVE (${report.targetCount} row(s))`,
    );
    console.log(
      `${report.targetCount} row(s) in this database cite ${TARGET_SOURCE_REF}, a file absent `
      + 'from the repository, from every reachable Git tree, and from all three proposed-migration '
      + 'archives. What should happen to them is an owner decision -- this script does not '
      + 'rewrite a source_ref, delete a row, or propose a replacement source, and cannot: it has '
      + 'no write path.',
    );
  }

  console.log('CUE_SOURCE_PROVENANCE_CHECK_PASS');
  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
    // Exits zero whenever it ran. This is a REPORT, not a gate: the 238 rows are
    // a known, owner-parked condition, so failing on them would make `all` red
    // for something nobody has been asked to fix. The count is the answer.
    process.exit(0);
  } catch (error) {
    console.error('PILOT CUE SOURCE PROVENANCE CENSUS FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
