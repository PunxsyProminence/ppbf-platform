import type { DbClient } from '../actor';
import { canonicalRow, type CellInput } from '../canonical';
import type { ColumnSpec, FileSpec, Finding, ParsedFile, ParsedRow } from '../types';
import { integerText, numberText, parseBoolean, splitList } from '../values';

// WHAT THE TWO DATASETS THAT HOLD THEIR OWN VERSIONS SHARE: the drill library
// (drills.ts) and the universal stop rules (universalStopRules.ts). Both keep
// every version as its own row -- lineage_id, version, supersedes_*,
// superseded_at (drill_library_v3 migration :83-89; content-import migration
// :164-178) -- so, unlike the registries (registries.ts), nothing is updated
// in place and nothing goes to the history ledger: the old row IS the history.
//
// THE WRITE ORDER IS FIXED BY THE SCHEMA. One head per lineage is an index,
// partial on superseded_at is null (content-import migration :155-157,
// :217-219), so a version write sets superseded_at on the old head FIRST and
// inserts the new head SECOND; the other order is refused. The engines do all
// the supersedes of an import before any insert, so two items that trade
// names (drills) or positions (universal rules) in one hand-off do not trip
// the name or ordinal index on the first insert while the other item still
// holds the value.

/** Identifiers come from specs and constants, never input; this keeps it that way. */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`content-import: '${name}' is not a plain SQL identifier`);
  return name;
}

export interface TableColumn {
  nullable: boolean;
  /** text[] in the database, '|' list text in a package. */
  array: boolean;
}

/** The live table's columns, read from the database rather than restated, so they cannot drift from the migrations. */
export async function tableColumns(client: DbClient, table: string): Promise<Map<string, TableColumn>> {
  const { rows } = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
    `select column_name, is_nullable, data_type
       from information_schema.columns
      where table_schema = 'pilot' and table_name = $1`,
    [table],
  );
  return new Map(rows.map((row) => [row.column_name, { nullable: row.is_nullable === 'YES', array: row.data_type === 'ARRAY' }]));
}

/**
 * Every column the engine writes must exist. A spec column the table lacks
 * would otherwise fail half-way through a load, or be dropped without a word
 * by a writer that builds its column list from the table.
 */
export function assertColumns(table: string, columns: ReadonlyMap<string, TableColumn>, names: readonly string[]): void {
  const missing = names.filter((name) => !columns.has(name));
  if (missing.length > 0) throw new Error(`content-import: pilot.${table} has no column(s) ${missing.join(', ')}`);
}

/**
 * The database value for one canonical cell (canonical.ts: blank already reads
 * as the column's blankDefault). A '|' list becomes a real text[] -- the old
 * drill loader split on ';' and ',' only and so stored 'A1-001|A2-002' as ONE
 * element (the retired seed-drill-library.mjs); every row written here is split.
 * A blank is NULL where the column allows it, '' for a NOT NULL text column
 * (what_bad_looks_like has no default, drill_library_v3 migration :101-102),
 * and an empty array for a NOT NULL array.
 */
export function typedValue(column: ColumnSpec, text: string, info: TableColumn): unknown {
  const value = text || column.blankDefault || '';
  if (info.array) {
    if (value) return splitList(value, column.list ?? '|');
    return info.nullable ? null : [];
  }
  if (!value) return info.nullable || column.type !== 'text' ? null : '';
  switch (column.type) {
    case 'boolean':
      return parseBoolean(value);
    case 'integer':
      return Number(integerText(value));
    case 'number':
      return Number(numberText(value));
    default:
      return column.list ? splitList(value, column.list).join(column.list) : value;
  }
}

/** The content columns of a row as canonical text, minus the ones the database does not store. */
export function storedContent(
  spec: FileSpec,
  row: Readonly<Record<string, CellInput>>,
  notStored: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const content = canonicalRow(spec, row);
  for (const name of notStored) delete content[name];
  return content;
}

/**
 * Multi-row INSERT, a few hundred rows per statement: a first load of the
 * drill library is about 1,400 rows across five tables, and one round trip per
 * row is what made the old loaders slow against Azure. No ON CONFLICT: every
 * row here was planned under lock as new, so a conflict is a defect and must
 * fail the whole import rather than be skipped.
 */
export async function insertRows(
  client: DbClient,
  table: string,
  columns: readonly { name: string; array: boolean }[],
  rows: readonly unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(20_000 / columns.length));
  const names = columns.map((column) => ident(column.name)).join(', ');
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      if (row.length !== columns.length) throw new Error(`content-import: a pilot.${table} row has ${row.length} values for ${columns.length} columns`);
      const cells = row.map((value, index) => {
        params.push(value);
        return columns[index].array ? `$${params.length}::text[]` : `$${params.length}`;
      });
      return `(${cells.join(', ')})`;
    });
    const outcome = await client.query(`insert into pilot.${ident(table)} (${names}) values ${tuples.join(', ')}`, params);
    if (outcome.rowCount !== chunk.length) {
      throw new Error(`content-import: expected to insert ${chunk.length} row(s) into pilot.${table}, inserted ${outcome.rowCount}`);
    }
  }
}

/**
 * The validator's blocking findings on these files, by the item each one
 * belongs to. A finding on a row goes to that row's item; a header problem,
 * an unreadable file, or a line that is not the start of a row makes every
 * item the file touches suspect, not only the row it names.
 */
export function reasonsByItem(
  files: readonly ParsedFile[],
  blocking: readonly Finding[],
  itemOf: (file: ParsedFile, row: ParsedRow) => string,
): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const add = (key: string, message: string) => {
    const list = reasons.get(key) ?? [];
    if (!list.includes(message)) list.push(message);
    reasons.set(key, list);
  };
  for (const file of files) {
    const findings = blocking.filter((finding) => finding.file === file.path);
    if (findings.length === 0) continue;
    const rowAt = new Map(file.rows.map((row) => [row.line, row]));
    const touched = [...new Set(file.rows.map((row) => itemOf(file, row)))];
    for (const finding of findings) {
      const row = finding.line !== undefined && finding.line > 1 ? rowAt.get(finding.line) : undefined;
      for (const key of row ? [itemOf(file, row)] : touched) add(key, finding.message);
    }
  }
  return reasons;
}
