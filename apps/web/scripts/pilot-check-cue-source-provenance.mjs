import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only census of the `source_ref` values pilot.drill_cues actually holds.
 *
 * WHAT IT ANSWERS, AND ONLY THIS: does this database contain rows whose
 * source_ref equals the named target, and how many? Plus, for context, the count
 * behind every other distinct source_ref in the table.
 *
 * WHY THE TARGET IS NAMED HERE AND NOTHING ELSE IS. A provenance review outside
 * this repository asked whether the seed catalogue's most-cited source_ref
 * corresponds to a document anyone can produce. That question is answered
 * elsewhere, it is revisable, and its answer is not this script's business --
 * a diagnostic that printed a conclusion about a source file would keep printing
 * it long after the evidence moved, from a place nobody thinks to update. So the
 * filename is here as a comparison value and NOTHING MORE: this script never
 * says whether the source exists, never calls a row wrong, and never names a
 * defect. It reports counts. What the counts mean is read from the provenance
 * record, which can change without this file changing.
 *
 * IT IS A REPORT, NOT A GATE. Rows carrying the target are data, not a failure
 * condition -- a check that exited non-zero on finding them would turn `all` red
 * against both environments for a standing condition, and a red run that always
 * means the same thing stops being read. It reports success whenever it managed
 * to run, and the answer is the printed count. Read the number, not the exit
 * status -- the same contract seed-identity and runtime-claims carry.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never selects or prints cue_text: a cue is
 * coaching instruction written for a child on a gym floor, and a diagnostic has
 * no business copying that into a CI log when "how many rows" is the whole
 * question. It takes no SQL and no source_ref from its caller, so it cannot be
 * turned into a query console. And it changes nothing -- every statement runs
 * inside an explicit READ ONLY transaction, so Postgres itself refuses a write
 * rather than a reviewer having to notice one is absent.
 *
 * ONE MORE THING THE DATABASE IS NOT TRUSTED WITH: its own strings. source_ref is
 * free text, so a value could contain a newline, a carriage return, or something
 * shaped like `::warning::` -- and a diagnostic that echoed it raw could be made
 * to emit extra log lines, fake evidence records, or a GitHub workflow command.
 * Every database-derived value therefore leaves here JSON-encoded on a single
 * line with a fixed prefix, so no stored value can start a line or forge a field.
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
 * The one source_ref this check counts. A constant, not an input: an argument
 * here would make this a general-purpose row-counter pointed at any predicate an
 * operator typed, which is a query console with extra steps.
 */
export const TARGET_SOURCE_REF = 'coach_cue_and_feedback_library.csv';

/**
 * Bound on the number of distinct source_ref values printed. Exceeding it is
 * REPORTED rather than silently trimmed -- the multiorg orphan check records what
 * a quiet `limit 10` cost there. TOTAL_DRILL_CUES and TARGET_SOURCE_REF_COUNT are
 * computed by their own aggregate and are never affected by this cap.
 */
export const DISTINCT_LIMIT = 200;

/**
 * Bound on the DISPLAYED length of one source_ref. Only the rendering is
 * shortened: grouping, counting and the target comparison all happen in SQL over
 * the whole value, and a shortened display is marked as such and carries the
 * value's true length, so the evidence is bounded without being falsified.
 */
export const SOURCE_REF_DISPLAY_LIMIT = 200;

const LINE_SEPARATORS = /[\u2028\u2029]/g;

const escapeLineSeparator = (character) => (character === '\u2028' ? '\\u2028' : '\\u2029');

/**
 * Any value as reversible JSON that cannot occupy more than one physical log line.
 * The single place this script is allowed to turn database-derived data into log
 * text, so there is one rule to audit instead of one per field.
 *
 * JSON.stringify escapes quotes, backslashes and every C0 control character
 * including newline and carriage return. U+2028 and U+2029 are escaped on top of
 * that, because JSON leaves them raw and some log viewers still break a line on
 * them. The consequence is the property everything else rests on: a stored value
 * cannot begin a line, so it can neither forge an evidence record nor be read as
 * a `::workflow command::`. A pipe is just a character, because nothing here is
 * pipe-delimited.
 *
 * IT DELIBERATELY DOES NOT TRUNCATE. This is a serialization primitive, not a
 * display-bound one -- `JSON.parse` of its output reproduces the input exactly.
 * A bound that lived here would silently make an identifier irreversible, so any
 * shortening is the caller's decision and the caller has to say it shortened.
 */
export function encodeSingleLineJson(value) {
  return JSON.stringify(value).replace(LINE_SEPARATORS, escapeLineSeparator);
}

/**
 * One grouped row as one line of log. The display bound lives here rather than in
 * the encoder, and when it applies the record carries the value's true length and
 * says it was shortened -- so the evidence is bounded without being falsified.
 *
 * Exported so the hostile-value behaviour can be tested directly against this
 * exact function rather than against a copy of its logic.
 */
export function formatSourceRefRecord(row) {
  const value = row.source_ref;
  const isText = typeof value === 'string';
  const truncated = isText && value.length > SOURCE_REF_DISPLAY_LIMIT;

  return `SOURCE_REF_COUNT_JSON=${encodeSingleLineJson({
    source_ref: truncated ? value.slice(0, SOURCE_REF_DISPLAY_LIMIT) : value,
    source_ref_length: isText ? value.length : null,
    display_truncated: truncated,
    row_count: row.row_count,
  })}`;
}

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

/** Total rows, and the count carrying the target reference. */
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
 * column is nullable, so "no source was recorded" and "a source was recorded as
 * nothing" are different findings and collapsing them would hide one of them.
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
  // REPEATABLE READ, not merely READ ONLY, and the difference matters: this census
  // is several SELECTs, and under PostgreSQL's default READ COMMITTED each one takes
  // its OWN snapshot. A seed transaction committing between the count and the
  // grouped read would produce a report whose total disagreed with its own
  // per-source records -- internally contradictory while every statement was still
  // read-only. REPEATABLE READ gives the whole census one snapshot, so the numbers
  // describe a single state of the database or the report does not exist.
  // READ ONLY stays, and stays first: Postgres still refuses any write, and the
  // literal `BEGIN TRANSACTION READ ONLY` that checkDispatchCoverage.test.ts asserts
  // on every check script is preserved verbatim. Not SERIALIZABLE -- nothing here
  // writes, so predicate locking and serialization failures would buy nothing and
  // could make a read-only diagnostic fail against a busy database.
  await client.query('BEGIN TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ');
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

  console.log('Cue source_ref census');
  console.log('=====================');
  // current_database() and current_user come out of the same database the grouped
  // values do, so they go through the same encoder. A quoted identifier can hold
  // a line break, and a raw one here would have been the one field able to forge
  // a log line.
  console.log(`DATABASE_JSON=${encodeSingleLineJson(report.database)}`);
  console.log(`ROLE_JSON=${encodeSingleLineJson(report.role)}`);
  console.log(`DRILL_CUES_TABLE_PRESENT=${report.tablePresent ? 'YES' : 'NO'}`);
  console.log(`TARGET_SOURCE_REF=${TARGET_SOURCE_REF}`);

  if (!report.tablePresent) {
    // `n/a` throughout, never 0 and never NO: no count and no target comparison
    // happened, because there was no table to ask. A zero would assert an empty
    // table, and a NO would assert that the target was looked for and not found.
    // DRILL_CUES_TABLE_PRESENT carries the actual state.
    console.log('TOTAL_DRILL_CUES=n/a');
    console.log('TARGET_SOURCE_REF_COUNT=n/a');
    console.log('TARGET_SOURCE_REF_PRESENT=n/a');
    console.log('=====================');
    console.log('pilot.drill_cues does not exist in this database, so there is no row to count.');
    console.log('CUE_SOURCE_PROVENANCE_CHECK_PASS');
    return report;
  }

  console.log(`TOTAL_DRILL_CUES=${report.total}`);
  for (const row of report.sourceRefs) {
    console.log(formatSourceRefRecord(row));
  }
  if (report.truncated) {
    console.log(
      `SOURCE_REF_LIST_TRUNCATED=YES more than ${DISTINCT_LIMIT} distinct source_ref values; `
      + 'the per-value list above is incomplete. TOTAL_DRILL_CUES and '
      + 'TARGET_SOURCE_REF_COUNT are computed separately and remain complete.',
    );
  }
  console.log(`TARGET_SOURCE_REF_COUNT=${report.targetCount}`);
  console.log(`TARGET_SOURCE_REF_PRESENT=${report.targetCount > 0 ? 'YES' : 'NO'}`);
  console.log('=====================');
  console.log(
    `${report.targetCount} of ${report.total} row(s) in pilot.drill_cues carry that source_ref. `
    + 'This check reports the count only; what it means is recorded outside this script.',
  );
  console.log('CUE_SOURCE_PROVENANCE_CHECK_PASS');
  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    // No process.exit on success. The client is closed in run()'s finally, so
    // Node has nothing left to keep the loop alive and exits 0 on its own --
    // and a forced exit here could cut stdout off mid-flush, losing the very
    // counts this check exists to report.
    await run();
  } catch (error) {
    console.error('PILOT CUE SOURCE PROVENANCE CENSUS FAILED TO RUN');
    console.error(String(error));
    process.exitCode = 1;
  }
}
