// Real PostgreSQL-backed test for the cue source_ref census.
//
// The census exists to answer one runtime question -- how many pilot.drill_cues
// rows carry a given source_ref -- for an environment nobody can inspect from the
// repository. Three things make it worth a real database rather than a mock:
//
//   1. It must not fail on a database where pilot.drill_cues does not exist,
//      because that is a legitimate state (an environment that never took the
//      drill-library migration) and a SELECT from a missing table is an error.
//   2. NULL and '' are different answers about provenance, and only a real
//      GROUP BY proves they stay apart.
//   3. source_ref is free text, so a stored value can contain a newline, a
//      carriage return, or something shaped like a GitHub workflow command. A
//      diagnostic that echoed one raw could be made to emit fake evidence lines
//      into a CI log. The only convincing proof is a hostile value that actually
//      came out of Postgres, run through the real formatter.
//
// Spins up the same disposable, local-only embedded Postgres the other migration
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cue-source-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CENSUS_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-cue-source-provenance.mjs');

const SCHEMA = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
];

const ORG = 'org-cue-source-census';
const DRILL = 'drl-cue-source-census';
const OTHER_SOURCE_REF = 'Punxsy_Drill_Library_Source_v3.docx';

/**
 * Everything a stored source_ref could carry that a naive logger would hand
 * straight to the CI log: a pipe, a real carriage return and newline, a quote, a
 * backslash, and a string shaped like a GitHub workflow command. Built with
 * `join('\r\n')` so the CR and LF are genuine control characters rather than the
 * two-character sequences "\" and "n".
 */
const HOSTILE_SOURCE_REF = ['odd|source', '::warning::"x"\\path'].join('\r\n');

/** The same hostile content, past the display bound, to exercise truncation. */
const OVERLONG_SOURCE_REF = `${HOSTILE_SOURCE_REF}${'y'.repeat(300)}`;

/**
 * Written as escape sequences rather than typed literally. These are the two
 * characters JSON leaves raw, and a raw one sitting in a .ts file is invisible to
 * a reviewer and treated as a line terminator by some parsers -- so the escape is
 * the safe way to write them. `'\u2028'` in a string literal IS the character at
 * runtime, which is what the assertions need.
 */
const LINE_SEPARATOR = '\u2028';
const PARAGRAPH_SEPARATOR = '\u2029';

/**
 * Everything the generic encoder has to survive, in one value: a real LF and CR, a
 * real U+2028 and U+2029, a quote, a backslash, a pipe, and a GitHub
 * workflow-command prefix. This is the value the DATABASE_JSON/ROLE_JSON path
 * would have to handle if a PostgreSQL identifier were quoted into containing it.
 */
const HOSTILE_LOG_VALUE = [
  'odd|source',
  '::warning::"x"\\path',
].join('\r\n') + LINE_SEPARATOR + 'after-ls' + PARAGRAPH_SEPARATOR + 'after-ps';

const TARGET_ROWS = 238;
const OTHER_ROWS = 20;
const NULL_ROWS = 1;
const EMPTY_ROWS = 1;
const HOSTILE_ROWS = 1;
const OVERLONG_ROWS = 1;
/** Stated as the sum of the fixtures, so adding one cannot silently pass. */
const EXPECTED_TOTAL = TARGET_ROWS + OTHER_ROWS + NULL_ROWS + EMPTY_ROWS + HOSTILE_ROWS + OVERLONG_ROWS;

/**
 * The third database's only content: rows under a source_ref that is not the
 * target, so the table exists and the target count is genuinely zero. This is
 * what separates "no table, nothing was asked" from "table there, target absent".
 */
const ZERO_TARGET_OTHER_ROWS = 3;

// Jest's CJS transform rewrites a bare `import()` into `require()`, which cannot
// load an ESM .mjs. Building the import through `new Function` keeps a real
// dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as disciplineValueCensus.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type SourceRefRow = { source_ref: string | null; row_count: number };
type CensusReport = {
  database: string;
  role: string;
  tablePresent: boolean;
  total: number | null;
  targetCount: number | null;
  sourceRefs: SourceRefRow[];
  truncated: boolean;
};

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let census: (client: Client) => Promise<CensusReport>;
let formatSourceRefRecord: (row: SourceRefRow) => string;
let encodeSingleLineJson: (value: unknown) => string;
let runCensus: () => Promise<CensusReport>;
let targetSourceRef: string;
let displayLimit: number;
const sql: Record<string, string> = {};

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The real schema plus the organization and drill every cue row hangs off. */
async function databaseWithParents(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  for (const file of SCHEMA) {
    await client.query(sql[file]);
  }

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG],
  );
  await client.query(
    `insert into pilot.drill_library (
       organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
       standard_setup, execution, what_good_looks_like, what_bad_looks_like
     )
     values ($1, $2, $2, 'census drill', 'defense', 'b', 'p', 's', 'e', 'g', 'bad')`,
    [ORG, DRILL],
  );

  return client;
}

/**
 * One statement per distinct source_ref, each generating its own block of cue_ids,
 * so the row counts in the assertions are the row counts inserted.
 */
async function insertCueBlock(client: Client, prefix: string, count: number, sourceRef: string | null) {
  await client.query(
    `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text, source_ref)
     select $1, $2 || '-' || g, $3, 'cue ' || g, $4
     from generate_series(1, $5::int) g`,
    [ORG, prefix, DRILL, sourceRef, count],
  );
}

/** The main fixture: every source_ref shape, including TARGET_ROWS of the target. */
async function populatedDatabase(name: string): Promise<Client> {
  const client = await databaseWithParents(name);

  const blocks: Array<{ prefix: string; count: number; sourceRef: string | null }> = [
    { prefix: 'target', count: TARGET_ROWS, sourceRef: targetSourceRef },
    { prefix: 'other', count: OTHER_ROWS, sourceRef: OTHER_SOURCE_REF },
    { prefix: 'nullref', count: NULL_ROWS, sourceRef: null },
    { prefix: 'emptyref', count: EMPTY_ROWS, sourceRef: '' },
    { prefix: 'hostile', count: HOSTILE_ROWS, sourceRef: HOSTILE_SOURCE_REF },
    { prefix: 'overlong', count: OVERLONG_ROWS, sourceRef: OVERLONG_SOURCE_REF },
  ];
  for (const { prefix, count, sourceRef } of blocks) {
    await insertCueBlock(client, prefix, count, sourceRef);
  }

  return client;
}

/**
 * The third database, and the whole reason it is separate: pilot.drill_cues EXISTS
 * and holds rows, and none of them carries the target. Merging this into the
 * 238-target fixture would make the two states indistinguishable, which is exactly
 * the confusion this fixture exists to rule out.
 */
async function zeroTargetDatabase(name: string): Promise<Client> {
  const client = await databaseWithParents(name);
  await insertCueBlock(client, 'other', ZERO_TARGET_OTHER_ROWS, OTHER_SOURCE_REF);
  return client;
}

/** Every cue row's identity and provenance, for the before/after comparison. */
async function snapshot(client: Client) {
  const result = await client.query(
    `select cue_id, source_ref, cue_text, cue_family, focus_type, evidence_note
     from pilot.drill_cues order by cue_id`,
  );
  return result.rows;
}

function parseRecord(line: string) {
  expect(line.startsWith('SOURCE_REF_COUNT_JSON=')).toBe(true);
  return JSON.parse(line.slice('SOURCE_REF_COUNT_JSON='.length)) as {
    source_ref: string | null;
    source_ref_length: number | null;
    display_truncated: boolean;
    row_count: number;
  };
}

/**
 * Runs the REAL run() against one disposable database with console.log captured,
 * and restores the environment and the spy whatever happens. Shared because four
 * tests now exercise the printed output and the save/restore dance is the part
 * that goes wrong when it is copied.
 */
async function captureRunOutput(database: string): Promise<{ lines: string[]; report: CensusReport }> {
  const previousConnection = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  const previousSsl = process.env.PPBF_POSTGRES_DISABLE_SSL;
  const lines: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(database);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  try {
    const report = await runCensus();
    return { lines, report };
  } finally {
    log.mockRestore();
    if (previousConnection === undefined) delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    else process.env.AZURE_POSTGRES_CONNECTION_STRING = previousConnection;
    if (previousSsl === undefined) delete process.env.PPBF_POSTGRES_DISABLE_SSL;
    else process.env.PPBF_POSTGRES_DISABLE_SSL = previousSsl;
  }
}

/**
 * The invariant that makes every other output claim trustworthy, asserted on each
 * captured console.log call INDIVIDUALLY rather than on a joined blob. Joining and
 * re-splitting would still notice an embedded newline, but it could not say which
 * call produced it -- and it would let a line that only LOOKS safe after the join
 * pass. Deliberately broader than the fields under review: any future field that
 * prints a database value raw fails here, without anyone remembering to extend it.
 */
function expectEveryLineIsOneSafeLine(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).not.toContain(LINE_SEPARATOR);
    expect(line).not.toContain(PARAGRAPH_SEPARATOR);
    expect(line.startsWith('::')).toBe(false);
  }
}

/** `DATABASE=` must be gone without `DATABASE_JSON=` counting as a match. */
function expectNoRawField(lines: string[], field: string) {
  const rawField = new RegExp(`^${field}=`);
  expect(lines.filter((line) => rawField.test(line))).toEqual([]);
}

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);

    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  for (const file of SCHEMA) {
    sql[file] = await fs.readFile(path.join(INFRA_DIR, file), 'utf8');
  }

  // The real script, not a copy of its query or its formatter.
  const censusModule = await nativeDynamicImport(pathToFileURL(CENSUS_PATH).href);
  census = censusModule.checkCueSourceProvenance as typeof census;
  formatSourceRefRecord = censusModule.formatSourceRefRecord as typeof formatSourceRefRecord;
  encodeSingleLineJson = censusModule.encodeSingleLineJson as typeof encodeSingleLineJson;
  runCensus = censusModule.run as typeof runCensus;
  targetSourceRef = censusModule.TARGET_SOURCE_REF as string;
  displayLimit = censusModule.SOURCE_REF_DISPLAY_LIMIT as number;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });

  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('cue source_ref census against a real database', () => {
  test('a database with no pilot.drill_cues is reported, not raised as an error', async () => {
    // The state an environment that never took the drill-library migration is
    // in. A SELECT from a missing table errors, so the catalog probe is what
    // makes this answerable at all.
    const client = await freshDatabase('cue_census_absent');
    try {
      const report = await census(client);
      expect(report.tablePresent).toBe(false);
      expect(report.total).toBeNull();
      expect(report.targetCount).toBeNull();
      expect(report.sourceRefs).toEqual([]);
      expect(report.truncated).toBe(false);
      // Session-derived, not assumed from a connection string.
      expect(report.database).toBe('cue_census_absent');
      expect(report.role).toBe(PG_USER);
    } finally {
      await client.end();
    }
  });

  test('the absent-table run prints n/a for every count, never NO', async () => {
    // The distinction this exists to protect: nothing was counted and nothing was
    // looked for, because there was no table to ask. A NO here would claim the
    // target was searched for and not found.
    const client = await freshDatabase('cue_census_absent_output');
    await client.end();

    const { lines } = await captureRunOutput('cue_census_absent_output');

    expectEveryLineIsOneSafeLine(lines);
    expect(lines).toContain('DRILL_CUES_TABLE_PRESENT=NO');
    expect(lines).toContain('TOTAL_DRILL_CUES=n/a');
    expect(lines).toContain('TARGET_SOURCE_REF_COUNT=n/a');
    expect(lines).toContain('TARGET_SOURCE_REF_PRESENT=n/a');
    expect(lines).toContain('CUE_SOURCE_PROVENANCE_CHECK_PASS');

    // The state carrier, and the one that must not be n/a.
    expect(lines).not.toContain('DRILL_CUES_TABLE_PRESENT=YES');
    expect(lines).not.toContain('TARGET_SOURCE_REF_PRESENT=NO');
    expect(lines).toContain(`DATABASE_JSON=${JSON.stringify('cue_census_absent_output')}`);
    expectNoRawField(lines, 'DATABASE');
    expectNoRawField(lines, 'ROLE');
  });

  test('a present table with zero target rows prints NO, not n/a', async () => {
    // The other side of the same distinction, and the reason this needs its own
    // database: the 238-target fixture cannot produce a zero target count.
    const client = await zeroTargetDatabase('cue_census_zero_target');
    try {
      const { lines, report } = await captureRunOutput('cue_census_zero_target');

      expect(report.tablePresent).toBe(true);
      expect(report.targetCount).toBe(0);

      expectEveryLineIsOneSafeLine(lines);
      expect(lines).toContain('DRILL_CUES_TABLE_PRESENT=YES');
      expect(lines).toContain(`TOTAL_DRILL_CUES=${ZERO_TARGET_OTHER_ROWS}`);
      expect(lines).toContain('TARGET_SOURCE_REF_COUNT=0');
      expect(lines).toContain('TARGET_SOURCE_REF_PRESENT=NO');
      expect(lines).toContain('CUE_SOURCE_PROVENANCE_CHECK_PASS');

      // Zero matches is a real answer, so nothing here may read as n/a.
      expect(lines).not.toContain('TARGET_SOURCE_REF_COUNT=n/a');
      expect(lines).not.toContain('TARGET_SOURCE_REF_PRESENT=n/a');
      expect(lines).not.toContain('TOTAL_DRILL_CUES=n/a');
    } finally {
      await client.end().catch(() => {});
    }
  });

  describe('the shared single-line JSON encoder', () => {
    test('a value carrying every dangerous character survives as one line', () => {
      // Sanity first: the fixture really holds the characters, so the assertions
      // below are not passing on a tame string.
      expect(HOSTILE_LOG_VALUE).toContain('\n');
      expect(HOSTILE_LOG_VALUE).toContain('\r');
      expect(HOSTILE_LOG_VALUE).toContain(LINE_SEPARATOR);
      expect(HOSTILE_LOG_VALUE).toContain(PARAGRAPH_SEPARATOR);
      expect(HOSTILE_LOG_VALUE).toContain('"');
      expect(HOSTILE_LOG_VALUE).toContain('\\');
      expect(HOSTILE_LOG_VALUE).toContain('|');
      expect(HOSTILE_LOG_VALUE).toContain('::warning::');

      const encoded = encodeSingleLineJson(HOSTILE_LOG_VALUE);

      expect(encoded).not.toContain('\n');
      expect(encoded).not.toContain('\r');
      expect(encoded).not.toContain(LINE_SEPARATOR);
      expect(encoded).not.toContain(PARAGRAPH_SEPARATOR);

      // Reversible: escaped, never sanitized or shortened.
      expect(JSON.parse(encoded)).toBe(HOSTILE_LOG_VALUE);
      expect(encoded.split('\n')).toHaveLength(1);
    });

    test('the workflow-command text stays data and cannot begin a line', () => {
      const encoded = encodeSingleLineJson(HOSTILE_LOG_VALUE);

      // It is still in there -- not stripped -- but it can only ever appear after
      // the opening quote, never at the start of a physical line.
      expect(JSON.parse(encoded)).toContain('::warning::');
      for (const line of `FIELD_JSON=${encoded}`.split('\n')) {
        expect(line.startsWith('::')).toBe(false);
      }
    });

    test('it never truncates, so an identifier of any length round-trips', () => {
      // The reason the display bound lives in formatSourceRefRecord and not here:
      // a bound in the encoder would quietly make a long value irreversible.
      const long = 'n'.repeat(displayLimit * 3);
      expect(JSON.parse(encodeSingleLineJson(long))).toBe(long);
      expect(encodeSingleLineJson(long)).toHaveLength(long.length + 2);
    });
  });

  describe('with the real schema and the fixture rows', () => {
    let client: Client;

    beforeAll(async () => {
      client = await populatedDatabase('cue_census_populated');
    });

    afterAll(async () => {
      await client.end().catch(() => {});
    });

    test('counts the target exactly, and the total matches the fixtures', async () => {
      const report = await census(client);
      expect(report.tablePresent).toBe(true);
      expect(report.total).toBe(EXPECTED_TOTAL);
      expect(report.targetCount).toBe(TARGET_ROWS);
      // Six distinct values, well under the cap, so nothing is elided.
      expect(report.truncated).toBe(false);
      expect(report.sourceRefs).toHaveLength(6);
    });

    test('NULL and the empty string stay separate grouped values', async () => {
      const report = await census(client);
      const byValue = new Map(report.sourceRefs.map((row) => [row.source_ref, row.row_count]));

      // Present as distinct keys, not collapsed into one another.
      expect(byValue.has(null)).toBe(true);
      expect(byValue.has('')).toBe(true);
      expect(byValue.get(null)).toBe(NULL_ROWS);
      expect(byValue.get('')).toBe(EMPTY_ROWS);
      expect(byValue.get(targetSourceRef)).toBe(TARGET_ROWS);
      expect(byValue.get(OTHER_SOURCE_REF)).toBe(OTHER_ROWS);
    });

    test('reading the census changes no row', async () => {
      const before = await snapshot(client);
      await census(client);
      const after = await snapshot(client);
      expect(after).toEqual(before);
      expect(after).toHaveLength(EXPECTED_TOTAL);
    });

    test('Postgres refuses a write in the transaction mode the census opens', async () => {
      // Not a claim about the script's text -- a claim about what the server does
      // inside `BEGIN TRANSACTION READ ONLY`, which is the guarantee that makes
      // this safe to dispatch at production.
      await client.query('BEGIN TRANSACTION READ ONLY');
      let code: string | undefined;
      try {
        await client.query(
          `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text)
           values ($1, 'must-not-exist', $2, 'x')`,
          [ORG, DRILL],
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      await client.query('ROLLBACK');
      expect(code).toBe('25006');
    });

    test('a hostile source_ref cannot break out of one log line', async () => {
      const report = await census(client);
      const hostile = report.sourceRefs.find((row) => row.source_ref === HOSTILE_SOURCE_REF);
      expect(hostile).toBeDefined();

      // Sanity: the value really did come back from Postgres carrying the
      // dangerous characters, so what follows is not testing a tame string.
      expect(hostile!.source_ref).toContain('\n');
      expect(hostile!.source_ref).toContain('\r');
      expect(hostile!.source_ref).toContain('|');
      expect(hostile!.source_ref).toContain('"');
      expect(hostile!.source_ref).toContain('\\');
      expect(hostile!.source_ref).toContain('::warning::');

      const line = formatSourceRefRecord(hostile!);

      // ONE physical line. This is the property everything else rests on: the
      // `::warning::` cannot begin a line, so it can never be read as a workflow
      // command, and no second evidence record can be forged.
      expect(line.split('\n')).toHaveLength(1);
      expect(line).not.toContain('\r');
      expect(line.startsWith('SOURCE_REF_COUNT_JSON=')).toBe(true);

      const parsed = parseRecord(line);
      // Escaped, not dropped: the value round-trips exactly.
      expect(parsed.source_ref).toBe(HOSTILE_SOURCE_REF);
      expect(parsed.display_truncated).toBe(false);
      expect(parsed.source_ref_length).toBe(HOSTILE_SOURCE_REF.length);
      expect(parsed.row_count).toBe(HOSTILE_ROWS);
    });

    test('an overlong source_ref is shortened for display only, and says so', async () => {
      const report = await census(client);
      const overlong = report.sourceRefs.find((row) => row.source_ref === OVERLONG_SOURCE_REF);
      expect(overlong).toBeDefined();
      expect(overlong!.source_ref!.length).toBeGreaterThan(displayLimit);

      const parsed = parseRecord(formatSourceRefRecord(overlong!));
      expect(parsed.display_truncated).toBe(true);
      expect(parsed.source_ref).toHaveLength(displayLimit);
      expect(parsed.source_ref).toBe(OVERLONG_SOURCE_REF.slice(0, displayLimit));
      // The true length survives, so a shortened display never understates the
      // evidence, and the count is untouched by the display bound.
      expect(parsed.source_ref_length).toBe(OVERLONG_SOURCE_REF.length);
      expect(parsed.row_count).toBe(OVERLONG_ROWS);
    });

    test('NULL and the empty string serialize distinguishably', async () => {
      const nullRecord = parseRecord(formatSourceRefRecord({ source_ref: null, row_count: NULL_ROWS }));
      const emptyRecord = parseRecord(formatSourceRefRecord({ source_ref: '', row_count: EMPTY_ROWS }));

      expect(nullRecord.source_ref).toBeNull();
      expect(nullRecord.source_ref_length).toBeNull();
      expect(emptyRecord.source_ref).toBe('');
      expect(emptyRecord.source_ref_length).toBe(0);
      expect(nullRecord.source_ref).not.toBe(emptyRecord.source_ref);
    });

    test('the whole printed output is one safe line per call, and reports rather than fails', async () => {
      // The end-to-end path, not just the formatter: run() connects, prints, and
      // returns. 238 target rows are data, so this must complete normally and
      // leave the process exit code alone.
      const previousExitCode = process.exitCode;
      const { lines, report } = await captureRunOutput('cue_census_populated');
      expect(report.targetCount).toBe(TARGET_ROWS);

      // Every captured call, not a joined blob. This is the guard that makes the
      // rest of the assertions mean anything.
      expectEveryLineIsOneSafeLine(lines);
      expect(lines.filter((line) => line.startsWith('SOURCE_REF_COUNT_JSON='))).toHaveLength(6);

      // Database-derived identity goes out encoded, and the old raw fields are gone.
      expect(lines).toContain(`DATABASE_JSON=${JSON.stringify('cue_census_populated')}`);
      expect(lines).toContain(`ROLE_JSON=${JSON.stringify(PG_USER)}`);
      expectNoRawField(lines, 'DATABASE');
      expectNoRawField(lines, 'ROLE');

      expect(lines).toContain(`TARGET_SOURCE_REF=${targetSourceRef}`);
      expect(lines).toContain(`TOTAL_DRILL_CUES=${EXPECTED_TOTAL}`);
      expect(lines).toContain(`TARGET_SOURCE_REF_COUNT=${TARGET_ROWS}`);
      expect(lines).toContain('TARGET_SOURCE_REF_PRESENT=YES');
      expect(lines).toContain('DRILL_CUES_TABLE_PRESENT=YES');
      expect(lines).toContain('CUE_SOURCE_PROVENANCE_CHECK_PASS');

      // A report, not a gate: finding the rows is not a failure.
      expect(process.exitCode).toBe(previousExitCode);
    });

    test('the printed output states no conclusion about whether the source exists', async () => {
      // The provenance verdict lives outside this script and is revisable; if it
      // ever leaks back into runtime output, this fails rather than shipping a
      // stale conclusion to every future run.
      const { lines } = await captureRunOutput('cue_census_populated');
      const printed = lines.join('\n');
      for (const verdict of [
        'UNSUPPORTED',
        'unsupported',
        'does not exist in any',
        'every reachable Git tree',
        'archives',
        'defect',
        'confined to the seed source',
      ]) {
        expect(printed).not.toContain(verdict);
      }
    });
  });
});
