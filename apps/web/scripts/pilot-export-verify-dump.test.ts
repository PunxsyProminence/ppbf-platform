// Contract tests for the backup verifier.
//
// The verifier's whole value is that it REFUSES. A suite that only proved a
// good dump passes would pass equally against a verifier that always returns
// ok -- which is the state the platform was in before this existed, where a
// backup step could report success on a zero-byte file. So most of what is
// asserted here is refusal: the truncated dump, the schema-only dump, the empty
// file, and the populated table that dumped nothing.
//
// The module under test is real ESM (.mjs), and the default jest runner has no
// ESM loader (`npm test` does not pass --experimental-vm-modules). As with
// postgresWriteTarget.test.ts, every case is evaluated in one real `node` child
// process, so these tests exercise the module exactly as the workflow consumes
// it rather than a transpiled copy.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, 'pilot-export-verify-dump.mjs'),
).href;

// Two invented names, present only so the negative control below can prove the
// summary carries no row content out of the parser.
const ATHLETE_NAME_A = 'Marisol Quinteros';
const ATHLETE_NAME_B = 'Devon Achterberg';

const HEADER = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  'CREATE SCHEMA pilot;',
  '',
  'CREATE TABLE pilot.organizations (',
  '    organization_id text NOT NULL',
  ');',
  '',
  'CREATE TABLE pilot.accounts (',
  '    account_id text NOT NULL',
  ');',
  '',
  'CREATE TABLE pilot.athletes (',
  '    athlete_id text NOT NULL,',
  '    full_name text NOT NULL',
  ');',
  '',
  'CREATE TABLE pilot.audit_events (',
  '    audit_id bigint NOT NULL',
  ');',
  '',
].join('\n');

const DATA = [
  'COPY pilot.organizations (organization_id) FROM stdin;',
  'org-ppbf',
  '\\.',
  '',
  'COPY pilot.athletes (athlete_id, full_name) FROM stdin;',
  `ath-001\t${ATHLETE_NAME_A}`,
  `ath-002\t${ATHLETE_NAME_B}`,
  '\\.',
  '',
  'COPY pilot.accounts (account_id) FROM stdin;',
  'ath-001',
  '\\.',
  '',
  'COPY pilot.audit_events (audit_id) FROM stdin;',
  '1',
  '2',
  '3',
  '\\.',
  '',
].join('\n');

// The real floor is 4096 uncompressed bytes, so the good fixture is padded past
// it deliberately: the passing case must clear the same threshold production
// dumps are held to, not a threshold relaxed for the test.
const PADDING = `${'-- pilot schema dump padding\n'.repeat(200)}`;

const FOOTER = ['--', '-- PostgreSQL database dump complete', '--', ''].join('\n');

const FIXTURES = {
  good: `${HEADER}${DATA}${PADDING}${FOOTER}`,
  // Everything but the rows: this is what a dump against an empty database, or
  // one produced with the wrong flags, looks like.
  schemaOnly: `${HEADER}${PADDING}${FOOTER}`,
  // Killed mid-COPY: the gzip member can still decompress cleanly up to the
  // cut, which is why size alone never detects this.
  truncated: `${HEADER}${PADDING}COPY pilot.athletes (athlete_id, full_name) FROM stdin;\nath-001\t${ATHLETE_NAME_A}\n`,
  liveGood: { organizations: 1, athletes: 2, accounts: 1, audit_events: 3 },
  // The dump is right and the counts moved under it -- a row written between
  // the snapshot and the count.
  liveDrift: { organizations: 1, athletes: 3, accounts: 1, audit_events: 3 },
  // A gym that has captured no medical intake. Zero on both sides is not a
  // failure; it is the truth.
  liveEmptyTable: { organizations: 1, athletes: 2, accounts: 1, audit_events: 3, medical_intake: 0 },
  // A populated table the dump missed entirely.
  liveMissedTable: { organizations: 1, athletes: 2, accounts: 1, audit_events: 3, waivers: 12 },
};

interface Summary {
  uncompressedBytes: number;
  completed: boolean;
  unterminatedCopyTable: string | null;
  createdTables: string[];
  copiedRows: Record<string, number>;
  totalDataRows: number;
}

interface Verdict {
  ok: boolean;
  failures: string[];
  notes: string[];
}

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };

const CASES: Record<string, string> = {
  summary_good: 'summarize(F.good)',
  summary_schema_only: 'summarize(F.schemaOnly)',
  summary_truncated: 'summarize(F.truncated)',
  summary_empty: 'summarize("")',
  summary_from_gzip_file: 'summarizeGzipFile(F.good)',

  verdict_good: 'm.evaluateBackup(await summarize(F.good), F.liveGood)',
  verdict_schema_only: 'm.evaluateBackup(await summarize(F.schemaOnly), F.liveGood)',
  verdict_truncated: 'm.evaluateBackup(await summarize(F.truncated), F.liveGood)',
  verdict_empty_file: 'm.evaluateBackup(await summarize(""), {})',
  verdict_drift: 'm.evaluateBackup(await summarize(F.good), F.liveDrift)',
  verdict_empty_table: 'm.evaluateBackup(await summarize(F.good), F.liveEmptyTable)',
  verdict_missed_table: 'm.evaluateBackup(await summarize(F.good), F.liveMissedTable)',
};

let outcomes: Record<string, Outcome>;

beforeAll(() => {
  const body = Object.entries(CASES)
    .map(
      ([name, expr]) =>
        `try { out[${JSON.stringify(name)}] = {ok: true, value: await (${expr})}; }`
        + ` catch (e) { out[${JSON.stringify(name)}] = {ok: false, message: e.message}; }`,
    )
    .join('\n');

  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import zlib from 'node:zlib';
    import { Readable } from 'node:stream';

    const F = ${JSON.stringify(FIXTURES)};
    const out = {};

    // Chunked deliberately: the parser has to hold a partial line across chunk
    // boundaries, and a whole-buffer read would never exercise that.
    const summarize = (text) => {
      const buffer = Buffer.from(text, 'utf8');
      const chunks = [];
      for (let offset = 0; offset < buffer.length; offset += 97) {
        chunks.push(buffer.subarray(offset, offset + 97));
      }
      return m.summarizeDumpStream(Readable.from(chunks));
    };

    const summarizeGzipFile = async (text) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-backup-')), 'dump.sql.gz');
      fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text, 'utf8')));
      try {
        return await m.summarizeDumpFile(file);
      } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
    };

    ${body}
    process.stdout.write(JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  outcomes = JSON.parse(stdout);
});

function resolved<T>(name: string): T {
  const outcome = outcomes[name];
  if (outcome.ok !== true) {
    throw new Error(`${name} threw unexpectedly: ${(outcome as { message: string }).message}`);
  }
  return outcome.value as T;
}

describe('summarizeDumpStream', () => {
  test('counts the rows in every COPY block and the tables the dump creates', () => {
    const summary = resolved<Summary>('summary_good');
    expect(summary.completed).toBe(true);
    expect(summary.unterminatedCopyTable).toBeNull();
    expect(summary.createdTables).toEqual(['accounts', 'athletes', 'audit_events', 'organizations']);
    expect(summary.copiedRows).toEqual({ accounts: 1, athletes: 2, audit_events: 3, organizations: 1 });
    expect(summary.totalDataRows).toBe(7);
    expect(summary.uncompressedBytes).toBeGreaterThan(4096);
  });

  test('carries no row content out of the parser', () => {
    // The negative control. This module reads a complete copy of every child's
    // record and its output goes into a workflow log, so the summary must be
    // counts and table names and nothing else.
    const serialized = JSON.stringify(resolved<Summary>('summary_good'));
    expect(serialized).not.toContain(ATHLETE_NAME_A);
    expect(serialized).not.toContain(ATHLETE_NAME_B);
    expect(serialized).not.toContain('ath-001');
    expect(serialized).not.toContain('org-ppbf');
  });

  test('reads the same summary back through gzip as from the plain stream', () => {
    expect(resolved<Summary>('summary_from_gzip_file')).toEqual(resolved<Summary>('summary_good'));
  });

  test('reports a dump cut off mid-table as unterminated and incomplete', () => {
    const summary = resolved<Summary>('summary_truncated');
    expect(summary.completed).toBe(false);
    expect(summary.unterminatedCopyTable).toBe('athletes');
  });

  test('reports an empty file as empty rather than erroring', () => {
    const summary = resolved<Summary>('summary_empty');
    expect(summary.uncompressedBytes).toBe(0);
    expect(summary.totalDataRows).toBe(0);
    expect(summary.completed).toBe(false);
  });
});

describe('evaluateBackup', () => {
  test('accepts a complete dump that carries the rows the database holds', () => {
    const verdict = resolved<Verdict>('verdict_good');
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test('refuses a schema-only dump of a gym that has records', () => {
    const verdict = resolved<Verdict>('verdict_schema_only');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain('dump_carries_no_rows: the dump has schema and no data');
    expect(verdict.failures.some((failure) => failure.startsWith('table_dumped_empty: pilot.athletes'))).toBe(true);
  });

  test('refuses a dump cut off mid-table', () => {
    const verdict = resolved<Verdict>('verdict_truncated');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain('dump_truncated_in_table: pilot.athletes');
    expect(verdict.failures.some((failure) => failure.startsWith('dump_incomplete:'))).toBe(true);
  });

  test('refuses an empty file even when nothing is known about the database', () => {
    const verdict = resolved<Verdict>('verdict_empty_file');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((failure) => failure.startsWith('dump_too_small:'))).toBe(true);
    expect(verdict.failures).toContain('table_missing_from_dump: pilot.athletes');
  });

  test('refuses a dump that missed a populated table entirely', () => {
    const verdict = resolved<Verdict>('verdict_missed_table');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain('table_dumped_empty: pilot.waivers holds 12 rows and the dump carries none');
  });

  test('treats a count that moved under the snapshot as a note, not a failure', () => {
    const verdict = resolved<Verdict>('verdict_drift');
    expect(verdict.ok).toBe(true);
    expect(verdict.notes).toContain('row_count_drift: pilot.athletes dumped=2 live=3');
  });

  test('does not fault a table that is genuinely empty on both sides', () => {
    const verdict = resolved<Verdict>('verdict_empty_table');
    expect(verdict.ok).toBe(true);
    expect(verdict.notes).toEqual([]);
  });
});
