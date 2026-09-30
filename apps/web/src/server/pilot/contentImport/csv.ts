import { CsvError, parse } from 'csv-parse/sync';

// READING AND WRITING THE PACKAGE CSVs.
//
// csv-parse rather than another hand-written RFC 4180 loop (seed-drill-library
// .mjs:103-170 and its copies in the other loaders). It is already a
// dependency and already reads the research package (import-shadow-research
// .mjs:6).
//
// COLUMN COUNT IS CHECKED HERE, ROW BY ROW. The old loaders pad a short row
// with '' (the retired seed-drill-library.mjs, `row[i] ?? ''`), so a row that lost a
// comma loads with every later field shifted one column left and nothing says
// so. relax_column_count is on only so that EVERY bad row is reported with its
// line, instead of the parse stopping at the first.

export interface CsvTable {
  header: string[];
  /** Data rows, cells exactly as written. */
  records: { line: number; cells: string[] }[];
  /** Problems that make rows unreadable; the caller turns them into blocking findings. */
  problems: { kind: 'unreadable' | 'column_count'; line?: number; message: string }[];
}

interface CsvParseRecord {
  record: string[];
  info: { lines: number };
  raw?: string;
}

/** Line where a record starts: csv-parse reports the line where it ENDS. */
function startLine(endLine: number, raw: string | undefined): number {
  if (!raw) return endLine;
  const body = raw.replace(/^(?:\r?\n)+/, '').replace(/\r?\n$/, '');
  const inner = body.match(/\n/g)?.length ?? 0;
  return endLine - inner;
}

export function readCsv(text: string): CsvTable {
  let parsed: CsvParseRecord[];
  try {
    // With info and raw on, csv-parse returns { record, info, raw } per row;
    // its sync typings only describe the plain string[][] shape.
    parsed = parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
      raw: true,
    }) as unknown as CsvParseRecord[];
  } catch (error) {
    if (error instanceof CsvError) {
      const line = (error as CsvError & { lines?: number }).lines;
      return { header: [], records: [], problems: [{ kind: 'unreadable', line, message: error.message }] };
    }
    throw error;
  }

  if (parsed.length === 0) {
    return { header: [], records: [], problems: [{ kind: 'unreadable', message: 'the file is empty (no header row)' }] };
  }

  const [headerRecord, ...rest] = parsed;
  const header = headerRecord.record.map((cell) => cell.trim());
  const problems: CsvTable['problems'] = [];
  const records: CsvTable['records'] = [];

  for (const entry of rest) {
    const line = startLine(entry.info.lines, entry.raw);
    // A row of empty cells is not a row -- the old loaders drop it too
    // (the retired seed-*.mjs loaders did), and spreadsheet exports leave them.
    if (entry.record.every((cell) => cell.trim() === '')) continue;
    if (entry.record.length !== header.length) {
      problems.push({
        kind: 'column_count',
        line,
        message: `this row has ${entry.record.length} cells but the header has ${header.length}; a missing or extra comma shifts every later value into the wrong column`,
      });
      continue;
    }
    records.push({ line, cells: entry.record });
  }

  return { header, records, problems };
}

/**
 * Minimal quoting (only cells holding a comma, a quote or a line break), LF
 * line endings, no BOM, a final newline: the exact form of every committed
 * seed CSV. contentPackageContract.test.ts proves each committed file
 * round-trips through readCsv + writeCsv byte for byte, which is what lets
 * `content:prepare` rewrite a file without touching the rows it did not change.
 */
export function writeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(quoteCell).join(','));
  return `${lines.join('\n')}\n`;
}

function quoteCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
