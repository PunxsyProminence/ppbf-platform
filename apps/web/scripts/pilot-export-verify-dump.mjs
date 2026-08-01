/**
 * Reads a pg_dump of the `pilot` schema back and decides whether it is a
 * backup or only a file.
 *
 * An empty, truncated or schema-only dump is indistinguishable from a good one
 * by exit code and nearly indistinguishable by size, and a backup path that
 * reports success on one is worse than no backup path at all -- it is the thing
 * everybody stops checking. So this parses the dump that was just produced and
 * compares what it actually carries against what the database actually holds.
 *
 * NOTHING HERE PRINTS A ROW. The dump is a complete copy of every child's
 * record in the gym; the only values this script emits are table names, row
 * counts and byte totals. Lines are classified and discarded, never retained
 * and never echoed, and the connection string is never printed in any branch.
 *
 * Two subcommands:
 *   probe   prints the server's major version, so the workflow can install the
 *           matching pg_dump. A pg_dump older than its server refuses to run.
 *   verify  parses --dump <file.sql.gz> and asserts it against live counts.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Tables whose absence from the dump means the dump is not of this schema at
// all. Every environment has these -- they are in the base schema, not in any
// increment -- so a missing one is never "that migration has not run here".
const REQUIRED_TABLES = ['organizations', 'accounts', 'athletes', 'audit_events'];

// Tables counted on both sides. The roster and the records a family would ask
// for come first; the rest are here because a dump that silently lost one of
// them is the failure this whole file exists to catch.
const COUNTED_TABLES = [
  'organizations',
  'accounts',
  'athletes',
  'parents',
  'guardian_links',
  'emergency_contacts',
  'medical_intake',
  'waivers',
  'attendance',
  'sessions',
  'coach_reviews',
  'audit_events',
];

// A schema-only dump of this schema is already far larger than this. The floor
// exists to catch nothing-at-all -- a dump killed at connect time, an empty
// file left behind by a failed pipe -- rather than to judge a real dump.
const MIN_UNCOMPRESSED_BYTES = 4096;

// pg_dump writes this as its last line and has done so for every version this
// platform could be pointed at. Its absence means the file was cut short, which
// no byte count or gzip integrity check can tell you on its own: a truncated
// gzip stream written by a killed pipeline can still decompress cleanly up to
// the point it stops.
const COMPLETION_MARKER = '-- PostgreSQL database dump complete';

const CREATE_TABLE_PATTERN = /^CREATE TABLE (?:IF NOT EXISTS )?pilot\.([A-Za-z0-9_]+)/;
const COPY_PATTERN = /^COPY pilot\.([A-Za-z0-9_]+)\s/;

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Same rule as db.ts's resolveSslConfig and every pilot-apply-* runner:
// production and staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * Classifies a plain-format pg_dump one line at a time.
 *
 * The COPY body is counted, not read: once a `COPY pilot.<table> ... FROM
 * stdin;` header is seen, every following line is one data row until the `\.`
 * terminator. pg_dump escapes data such that a bare `\.` cannot occur inside a
 * row, so the terminator is unambiguous.
 *
 * @param {AsyncIterable<Buffer|string>} readable plain (already decompressed) SQL
 */
export async function summarizeDumpStream(readable) {
  const decoder = new StringDecoder('utf8');
  const createdTables = new Set();
  const copiedRows = new Map();

  let uncompressedBytes = 0;
  let currentCopyTable = null;
  let completed = false;
  let pending = '';

  const consumeLine = (line) => {
    if (currentCopyTable !== null) {
      if (line === '\\.') {
        currentCopyTable = null;
        return;
      }
      copiedRows.set(currentCopyTable, (copiedRows.get(currentCopyTable) ?? 0) + 1);
      return;
    }

    if (line.startsWith(COMPLETION_MARKER)) {
      completed = true;
      return;
    }

    const created = CREATE_TABLE_PATTERN.exec(line);
    if (created) {
      createdTables.add(created[1]);
      return;
    }

    const copy = COPY_PATTERN.exec(line);
    if (copy) {
      currentCopyTable = copy[1];
      if (!copiedRows.has(currentCopyTable)) {
        copiedRows.set(currentCopyTable, 0);
      }
    }
  };

  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    uncompressedBytes += buffer.length;
    // Decoded through StringDecoder so a multi-byte character split across two
    // chunks is not turned into replacement characters mid-parse.
    pending += decoder.write(buffer);

    let breakIndex = pending.indexOf('\n');
    while (breakIndex !== -1) {
      consumeLine(pending.slice(0, breakIndex).replace(/\r$/, ''));
      pending = pending.slice(breakIndex + 1);
      breakIndex = pending.indexOf('\n');
    }
  }

  pending += decoder.end();
  if (pending.length > 0) {
    consumeLine(pending.replace(/\r$/, ''));
  }

  const copiedRowsObject = Object.fromEntries([...copiedRows.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    uncompressedBytes,
    completed,
    unterminatedCopyTable: currentCopyTable,
    createdTables: [...createdTables].sort(),
    copiedRows: copiedRowsObject,
    totalDataRows: Object.values(copiedRowsObject).reduce((total, count) => total + count, 0),
  };
}

/**
 * Decompresses and summarizes a gzipped dump on disk.
 *
 * zlib raises on a corrupt member, so a dump that cannot be read at all fails
 * here rather than being summarized as empty.
 */
export async function summarizeDumpFile(dumpPath) {
  const stream = fs.createReadStream(dumpPath).pipe(zlib.createGunzip());
  return summarizeDumpStream(stream);
}

/**
 * Turns a summary plus live row counts into a verdict.
 *
 * The one asymmetry worth stating: a table that holds rows and dumped none is a
 * FAILURE, while a count that merely disagrees is a NOTE. The dump is a
 * snapshot taken before the counts are read, so a row written in between makes
 * the two differ legitimately -- failing on that would train an operator to
 * ignore a red backup. Dumping nothing at all from a populated table cannot be
 * explained that way.
 */
export function evaluateBackup(summary, liveCounts, options = {}) {
  const minUncompressedBytes = options.minUncompressedBytes ?? MIN_UNCOMPRESSED_BYTES;
  const requiredTables = options.requiredTables ?? REQUIRED_TABLES;

  const failures = [];
  const notes = [];

  if (!summary.completed) {
    failures.push(`dump_incomplete: "${COMPLETION_MARKER}" is absent, so the dump was cut short`);
  }

  if (summary.unterminatedCopyTable) {
    failures.push(`dump_truncated_in_table: pilot.${summary.unterminatedCopyTable}`);
  }

  if (summary.uncompressedBytes < minUncompressedBytes) {
    failures.push(
      `dump_too_small: ${summary.uncompressedBytes} bytes uncompressed, floor is ${minUncompressedBytes}`,
    );
  }

  for (const table of requiredTables) {
    if (!summary.createdTables.includes(table)) {
      failures.push(`table_missing_from_dump: pilot.${table}`);
    }
  }

  if (summary.totalDataRows <= 0) {
    failures.push('dump_carries_no_rows: the dump has schema and no data');
  }

  for (const [table, liveCount] of Object.entries(liveCounts)) {
    const dumped = summary.copiedRows[table] ?? 0;
    if (liveCount > 0 && dumped === 0) {
      failures.push(`table_dumped_empty: pilot.${table} holds ${liveCount} rows and the dump carries none`);
      continue;
    }
    if (dumped !== liveCount) {
      notes.push(`row_count_drift: pilot.${table} dumped=${dumped} live=${liveCount}`);
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

// Only tables that both appear in COUNTED_TABLES and exist in the database are
// counted, so an environment behind on a migration reports a smaller set rather
// than failing the whole verification with a relation-does-not-exist error.
// Names are intersected against a constant list before they reach any SQL text.
export async function readLiveCounts(client, tables = COUNTED_TABLES) {
  const present = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'pilot'
        and table_name = any($1::text[])`,
    [tables],
  );

  const names = present.rows
    .map((row) => row.table_name)
    .filter((name) => tables.includes(name))
    .sort();

  if (names.length === 0) {
    return {};
  }

  const unioned = names
    .map((name) => `select '${name}' as table_name, count(*)::bigint as row_count from pilot.${name}`)
    .join(' union all ');

  const counted = await client.query(unioned);
  return Object.fromEntries(counted.rows.map((row) => [row.table_name, Number(row.row_count)]));
}

async function connect() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  // The same declared-target guard the migration runners use. This command only
  // reads, but reading the wrong database and filing it as production's backup
  // is its own kind of data loss -- the restore that follows would put another
  // environment's rows into this one.
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const { Client } = await import('pg');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  return { client, target };
}

async function runProbe() {
  const { client, target } = await connect();
  try {
    const result = await client.query('show server_version_num');
    const versionNum = Number(result.rows[0]?.server_version_num);
    if (!Number.isFinite(versionNum) || versionNum <= 0) {
      throw new Error('POSTGRES_SERVER_VERSION_UNREADABLE');
    }
    console.log(`target_hostname: ${target.hostname}`);
    console.log(`target_database: ${target.database}`);
    console.log(`server_major: ${Math.floor(versionNum / 10000)}`);
  } finally {
    await client.end();
  }
}

async function runVerify(dumpPath) {
  if (!dumpPath) {
    throw new Error('Missing required argument: --dump <path to .sql.gz>');
  }

  const summary = await summarizeDumpFile(dumpPath);
  const { client, target } = await connect();

  let liveCounts;
  try {
    liveCounts = await readLiveCounts(client);
  } finally {
    await client.end();
  }

  const verdict = evaluateBackup(summary, liveCounts);

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`uncompressed_bytes: ${summary.uncompressedBytes}`);
  console.log(`tables_in_dump: ${summary.createdTables.length}`);
  console.log(`rows_in_dump: ${summary.totalDataRows}`);
  for (const [table, count] of Object.entries(liveCounts)) {
    console.log(`table ${table}: dumped=${summary.copiedRows[table] ?? 0} live=${count}`);
  }
  for (const note of verdict.notes) {
    console.log(`note: ${note}`);
  }

  if (!verdict.ok) {
    for (const failure of verdict.failures) {
      console.error(`failure: ${failure}`);
    }
    throw new Error('PILOT BACKUP VERIFY FAILED');
  }

  console.log('PILOT BACKUP VERIFY PASS');
}

export async function run(argv = process.argv.slice(2)) {
  const subcommand = argv[0] ?? '';
  const dumpFlagIndex = argv.indexOf('--dump');
  const dumpPath = dumpFlagIndex === -1 ? '' : argv[dumpFlagIndex + 1];

  if (subcommand === 'probe') {
    await runProbe();
    return;
  }

  if (subcommand === 'verify') {
    await runVerify(dumpPath);
    return;
  }

  throw new Error('Unsupported subcommand. Use "probe" or "verify --dump <path>".');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT BACKUP VERIFY FAIL');
    // Message only. An error from pg can carry the connection parameters on
    // its own properties, and this output goes into a workflow log.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
