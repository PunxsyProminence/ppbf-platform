import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only census of the values `pilot.waivers.status` actually holds.
 *
 * THE QUESTION THIS ANSWERS, AND WHY IT IS NOT ANSWERABLE FROM THE REPOSITORY.
 * The column is `status text not null` with no CHECK constraint anywhere in
 * infra/azure (checked: no CHECK on this column exists in any .sql file in
 * that directory). Two of its four writers store a literal --
 * grantMediaConsent writes 'signed', withdrawMediaConsent writes 'withdrawn'.
 * The other two do not: POST /api/pilot/intake/domain-upsert stores
 * `asString(body.payload.status, 'signed')`, any string a caller sends, and
 * POST /api/pilot/intake/review-action stores whatever the promoted intake
 * case payload carried. So the set of values in production is a fact about
 * production, and nothing in this repository records it.
 *
 * THE DECISION IT FEEDS. Owner decision, 2026-08-29 (D-7): MEASURE PRODUCTION
 * FIRST, before any CHECK constraint is proposed for this column. This script
 * is that measurement and nothing more. It does not add a constraint, does not
 * suggest a vocabulary, does not map or rewrite a single row, and has no write
 * path at all -- every statement is a SELECT inside an explicit READ ONLY
 * transaction, so it is safe to run directly against production.
 *
 * WHAT A READER ALREADY DOES WITH AN ODD VALUE, so the numbers below are read
 * correctly rather than as a list of outages. Every reader of this column
 * already fails CLOSED on a value it does not understand:
 *
 *   waiverCompliance.normalizeWaiverStatus  trims and lowercases, then keeps
 *                                           the value only if it is in
 *                                           WAIVER_STATUSES; anything else
 *                                           becomes 'missing'.
 *   guardianConsent                         trims and lowercases, then tests
 *                                           `=== 'signed'`; anything else is
 *                                           not consent.
 *   GET /api/pilot/video/[videoId]          refuses outright (409) when a
 *                                           guardian-scoped row carries a
 *                                           status outside {signed,withdrawn}.
 *
 * So an unrecognised value today is not a leak. It is a family whose signed
 * paperwork may be reported as missing, which is a different harm and the one
 * this census is for. THE COUNTS BELOW ARE NOT AN INCIDENT REPORT AND MUST NOT
 * BE READ AS ONE.
 *
 * WHAT THE CLASSIFICATION MEANS, precisely, because the distinction is the
 * whole point of measuring before constraining:
 *
 *   EXACT         Byte-identical to a value the readers' vocabulary contains.
 *                 A CHECK written over that vocabulary would accept it.
 *   NORMALISES    Lands in the vocabulary only after trim and lowercase --
 *                 ' Signed ', 'SIGNED'. EVERY READER ACCEPTS THESE ROWS. A
 *                 byte-exact CHECK would REFUSE them, which is exactly the
 *                 kind of row an unmeasured constraint takes a deploy down
 *                 over.
 *   UNRECOGNISED  Not in the vocabulary even after normalising. Already
 *                 failing closed everywhere today.
 *
 * 'missing' IS COUNTED SEPARATELY AND DELIBERATELY. It is in WAIVER_STATUSES,
 * but as the value a READER SYNTHESISES for "no waiver row exists". A stored
 * row that says 'missing' is a different claim from an absent row, and whether
 * a CHECK should admit it is an owner decision this script does not take.
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
 * The reader vocabulary, copied from waiverCompliance.ts's WAIVER_STATUSES
 * rather than imported: this is a .mjs script and that is a TypeScript module
 * in the Next.js build graph. A test pins the two lists equal, so the copy
 * cannot drift silently -- see waiverStatusCensus.pg.test.ts.
 */
export const WAIVER_STATUSES = ['signed', 'declined', 'withdrawn', 'missing'];

/**
 * The value readers synthesise for "no row exists", held separately from the
 * list above so a stored row carrying it is reported as its own finding rather
 * than folded into the clean count.
 */
export const SYNTHETIC_STATUS = 'missing';

/**
 * The two values GET /api/pilot/video/[videoId] understands. A
 * guardian-scoped waiver row outside this set makes that route refuse with
 * 409 GUARDIAN_CONSENT_UNREADABLE, so it is the one population where an odd
 * value is already blocking a real request today.
 */
export const CONSENT_STATUSES_THE_VIDEO_GATE_UNDERSTANDS = ['signed', 'withdrawn'];

// High enough to be the complete set for any realistic accumulation, low
// enough that a pathological database cannot make this diagnostic print
// unboundedly. Exceeding it is REPORTED, never silent -- the multiorg orphan
// check records what a quiet `limit 10` cost: ten ids named, covering 23 of 43
// rows, and a cleanup built from that list would have missed twenty.
const DISTINCT_LIMIT = 500;

/** Waiver types listed per value before the list is elided. */
const WAIVER_TYPE_SAMPLE = 12;

function normalizeStatusText(raw) {
  return (raw ?? '').trim().toLowerCase();
}

/** EXACT / NORMALISES / UNRECOGNISED, as defined in the header. */
function classify(rawStatus) {
  if (WAIVER_STATUSES.includes(rawStatus)) return 'EXACT';
  if (WAIVER_STATUSES.includes(normalizeStatusText(rawStatus))) return 'NORMALISES';
  return 'UNRECOGNISED';
}

/** Refuses to describe a database that does not have the table. */
async function assertWaiversTable(client) {
  const result = await client.query(
    `select to_regclass('pilot.waivers') is not null as present`,
  );
  if (result.rows[0]?.present !== true) {
    // Reporting "0 rows, clean" for a database with no waivers table would be
    // a false all-clear, which is the one output a census must never produce.
    throw new Error('WAIVER_TABLE_ABSENT');
  }
}

/**
 * Whether the guardian-media-consent migration has reached this database.
 * parent_id arrives with it, and the guardian-scoped section below is
 * meaningless without that column -- reported as NOT APPLICABLE rather than
 * silently counted as zero.
 */
async function parentColumnPresent(client) {
  const result = await client.query(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'waivers' and column_name = 'parent_id'
     ) as present`,
  );
  return result.rows[0]?.present === true;
}

/** Any CHECK constraint already covering the status column. */
async function statusCheckConstraints(client) {
  const result = await client.query(
    `select c.conname, pg_get_constraintdef(c.oid) as definition
     from pg_constraint c
     where c.conrelid = to_regclass('pilot.waivers')
       and c.contype = 'c'
       and (select a.attnum from pg_attribute a
             where a.attrelid = to_regclass('pilot.waivers')
               and a.attname = 'status') = any(c.conkey)
     order by c.conname`,
  );
  return result.rows;
}

/** Every distinct raw status value, with its count and the types it appears on. */
async function distinctStatusValues(client) {
  const result = await client.query(
    `select w.status,
            count(*)::int as row_count,
            count(distinct w.waiver_type)::int as waiver_type_count,
            (array_agg(distinct w.waiver_type))[1:${WAIVER_TYPE_SAMPLE}] as waiver_types
     from pilot.waivers w
     group by w.status
     order by count(*) desc, w.status
     limit ${DISTINCT_LIMIT + 1}`,
  );
  return result.rows;
}

/**
 * Which organizations hold the values a byte-exact CHECK would refuse. The
 * headline rollup above is deliberately ungrouped -- a vocabulary is a
 * platform-wide question -- but acting on a finding means knowing whose rows
 * they are, so only the actionable population is broken out by organization.
 */
async function nonExactValuesByOrganization(client) {
  const result = await client.query(
    `select w.organization_id, w.status, w.waiver_type, count(*)::int as row_count
     from pilot.waivers w
     where w.status <> all($1::text[])
     group by w.organization_id, w.status, w.waiver_type
     order by count(*) desc, w.organization_id, w.status, w.waiver_type
     limit ${DISTINCT_LIMIT + 1}`,
    [WAIVER_STATUSES],
  );
  return result.rows;
}

/** Guardian-scoped rows the video gate already refuses to read. */
async function unreadableGuardianRows(client) {
  const result = await client.query(
    `select w.organization_id, w.status, count(*)::int as row_count
     from pilot.waivers w
     where w.parent_id is not null
       and btrim(lower(w.status)) <> all($1::text[])
     group by w.organization_id, w.status
     order by count(*) desc, w.organization_id, w.status
     limit ${DISTINCT_LIMIT + 1}`,
    [CONSENT_STATUSES_THE_VIDEO_GATE_UNDERSTANDS],
  );
  return result.rows;
}

function truncate(rows) {
  const truncated = rows.length > DISTINCT_LIMIT;
  return { rows: truncated ? rows.slice(0, DISTINCT_LIMIT) : rows, truncated };
}

function sumRows(rows) {
  return rows.reduce((sum, row) => sum + row.row_count, 0);
}

export async function censusWaiverStatuses(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await assertWaiversTable(client);

    const checkConstraints = await statusCheckConstraints(client);
    const parentColumn = await parentColumnPresent(client);

    const { rows: valueRows, truncated: valuesTruncated } = truncate(
      await distinctStatusValues(client),
    );
    const values = valueRows.map((row) => ({
      status: row.status,
      rowCount: row.row_count,
      waiverTypeCount: row.waiver_type_count,
      waiverTypes: row.waiver_types ?? [],
      classification: classify(row.status),
      isSynthetic: row.status === SYNTHETIC_STATUS,
    }));

    const { rows: byOrgRows, truncated: byOrgTruncated } = truncate(
      await nonExactValuesByOrganization(client),
    );

    let guardianGate = null;
    if (parentColumn) {
      const { rows: unreadableRows, truncated: unreadableTruncated } = truncate(
        await unreadableGuardianRows(client),
      );
      guardianGate = {
        applicable: true,
        unreadable: unreadableRows,
        unreadableRowCount: sumRows(unreadableRows),
        truncated: unreadableTruncated,
      };
    }

    await client.query('COMMIT');

    const totalRowCount = values.reduce((sum, value) => sum + value.rowCount, 0);

    return {
      checkConstraints,
      parentColumnPresent: parentColumn,
      totalRowCount,
      values,
      valuesTruncated,
      byOrganization: byOrgRows,
      byOrganizationTruncated: byOrgTruncated,
      guardianGate,
      // Rows a CHECK written byte-exactly over WAIVER_STATUSES would refuse.
      // This is THE number the pending decision needs.
      nonExactRowCount: values
        .filter((value) => value.classification !== 'EXACT')
        .reduce((sum, value) => sum + value.rowCount, 0),
      // The subset of those that no amount of normalising would rescue.
      unrecognisedRowCount: values
        .filter((value) => value.classification === 'UNRECOGNISED')
        .reduce((sum, value) => sum + value.rowCount, 0),
      // Rows literally storing the reader-synthesised absence value.
      syntheticRowCount: values
        .filter((value) => value.isSynthetic)
        .reduce((sum, value) => sum + value.rowCount, 0),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function describeTypes(value) {
  const listed = value.waiverTypes.map((type) => JSON.stringify(type)).join(', ');
  const hidden = value.waiverTypeCount - value.waiverTypes.length;
  return hidden > 0 ? `${listed}, +${hidden} more` : listed;
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await censusWaiverStatuses(client);
  } finally {
    await client.end();
  }

  console.log('pilot.waivers.status census');
  console.log('===========================');

  if (report.checkConstraints.length === 0) {
    console.log('CHECK constraint on status: NONE -- the column accepts any text.');
  } else {
    for (const { conname, definition } of report.checkConstraints) {
      console.log(`CHECK constraint on status: ${conname} ${definition}`);
    }
  }
  console.log(`Total pilot.waivers rows: ${report.totalRowCount}`);
  console.log('');

  console.log(`Distinct status values: ${report.values.length}`);
  for (const value of report.values) {
    // JSON.stringify, not the bare value: whitespace and case ARE the finding
    // here, and an unquoted ' Signed ' prints indistinguishably from 'Signed'.
    console.log(
      `    ${JSON.stringify(value.status)} -> ${value.rowCount} row(s)`
      + `  [${value.classification}${value.isSynthetic ? ', SYNTHETIC-ABSENCE VALUE' : ''}]`,
    );
    console.log(`        waiver_type: ${describeTypes(value)}`);
  }
  if (report.valuesTruncated) {
    console.log(
      `    !! more than ${DISTINCT_LIMIT} distinct values -- list above is TRUNCATED and incomplete`,
    );
  }
  console.log('');

  console.log(
    `Rows a byte-exact CHECK over [${WAIVER_STATUSES.join(', ')}] would REFUSE: ${report.nonExactRowCount}`,
  );
  for (const row of report.byOrganization) {
    console.log(
      `    organization_id=${JSON.stringify(row.organization_id)}`
      + ` status=${JSON.stringify(row.status)}`
      + ` waiver_type=${JSON.stringify(row.waiver_type)} -> ${row.row_count} row(s)`,
    );
  }
  if (report.byOrganizationTruncated) {
    console.log(
      `    !! more than ${DISTINCT_LIMIT} distinct triples -- list above is TRUNCATED and incomplete`,
    );
  }
  console.log(
    `    of which UNRECOGNISED even after trim/lowercase: ${report.unrecognisedRowCount}`,
  );
  console.log(
    `Rows storing ${JSON.stringify(SYNTHETIC_STATUS)}, the value readers synthesise for `
    + `"no waiver row exists": ${report.syntheticRowCount}`,
  );
  console.log('');

  if (!report.parentColumnPresent) {
    console.log(
      'Guardian media-consent gate: NOT APPLICABLE -- pilot.waivers has no parent_id column, '
      + 'so the guardian-media-consent migration has not reached this database.',
    );
  } else {
    console.log(
      `Guardian-scoped rows GET /api/pilot/video/[videoId] already refuses to read `
      + `(status outside [${CONSENT_STATUSES_THE_VIDEO_GATE_UNDERSTANDS.join(', ')}]): `
      + `${report.guardianGate.unreadableRowCount}`,
    );
    for (const row of report.guardianGate.unreadable) {
      console.log(
        `    organization_id=${JSON.stringify(row.organization_id)}`
        + ` status=${JSON.stringify(row.status)} -> ${row.row_count} row(s)`,
      );
    }
    if (report.guardianGate.truncated) {
      console.log(
        `    !! more than ${DISTINCT_LIMIT} distinct pairs -- list above is TRUNCATED and incomplete`,
      );
    }
  }
  console.log('===========================');

  if (report.nonExactRowCount === 0) {
    console.log('PILOT WAIVER STATUS CENSUS: EVERY VALUE IS BYTE-EXACT');
    console.log(
      'A CHECK constraint written over the reader vocabulary would apply to this database '
      + 'without refusing a row. That is a measurement of this database at this moment, not a '
      + 'recommendation to add one, and not a claim about any other environment.',
    );
  } else {
    console.log(`PILOT WAIVER STATUS CENSUS: NON-EXACT VALUES (${report.nonExactRowCount} row(s))`);
    console.log(
      'A CHECK constraint written byte-exactly over the reader vocabulary WOULD REFUSE TO APPLY '
      + 'to this database, and every row it would refuse is listed above. What should happen to '
      + 'them -- normalise them, widen the vocabulary, admit case and padding in the constraint '
      + 'itself, or leave the column unconstrained -- is an owner decision. This script does not '
      + 'take it, does not recommend one, and cannot rewrite a row.',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { nonExactRowCount } = await run();
    // Non-zero on values found, not on a script error. Same convention as
    // pilot-check-discipline-values.mjs: this is a gate result, and a caller
    // should see a stop sign rather than a passing diagnostic that happened to
    // print a warning. IT IS NOT AN ASSERTION THAT ANYTHING IS BROKEN -- see
    // the header on how every reader already handles these rows.
    process.exit(nonExactRowCount === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT WAIVER STATUS CENSUS FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
