import { createHash } from 'node:crypto';

import type { ColumnSpec, DatasetSpec, FileSpec, ParsedPackage, RowValues } from './types';
import { integerText, isIntegerText, isNumberText, normalizeCell, numberText, parseBoolean, splitList } from './values';

// WHAT COUNTS AS "CHANGED" (R2: changed -> new version, unchanged -> skipped).
//
// A canonical sha256 over CONTENT only. Ids, lineage, versions, timestamps,
// organization and seeder placeholders, child surrogate ids and the parent
// column are excluded: none of them is the material, and counting them would
// make every re-import look like a revision.
//
// ONE CANONICALISER FOR FILE ROWS AND DATABASE ROWS. The plan stage (IMP-06)
// will hash database rows with this same function, so it accepts what a
// database hands back as well as CSV text: text[] arrays, booleans, numbers,
// null. For a list column every element is RE-SPLIT on the list separator
// before joining -- the old drill loader stored 'A1-001|A2-002' as ONE array
// element (seed-drill-library.mjs:210-219 splits on ; and , only; 82 of the
// 119 committed drills carry a '|'), and without the re-split every one of
// those drills would read as changed the first time it is compared.
//
// A BLANK CELL AND ITS COLUMN'S blankDefault ARE THE SAME CONTENT, for the
// same reason: the loader stores the default for a blank, so the database row
// says 'authored' where the file said nothing.

export type CellInput = string | readonly string[] | boolean | number | null | undefined;

const EXCLUDED_ROLES = new Set(['key', 'parent', 'child_id', 'lineage', 'placeholder', 'system']);

export function isContentColumn(column: ColumnSpec): boolean {
  return !EXCLUDED_ROLES.has(column.role);
}

export function canonicalCell(column: ColumnSpec, value: CellInput): string {
  if (column.list) {
    if (value === null || value === undefined) return '';
    const elements = Array.isArray(value) ? value : [String(value)];
    return elements.flatMap((element) => splitList(normalizeCell(String(element)), column.list as string)).join(column.list);
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  // A blank IS its column's default: the loader writes the default for a blank
  // (blankDefault in the spec) and a database row holds it, so 'none' and ''
  // in a scale row's contact_level are the same content, not a revision.
  const written = value === null || value === undefined ? '' : normalizeCell(Array.isArray(value) ? value.join(',') : String(value));
  const text = written || column.blankDefault || '';
  if (!text) return '';
  if (column.type === 'boolean') {
    const parsed = parseBoolean(text);
    return parsed === null ? text : String(parsed);
  }
  if (column.type === 'integer' && isIntegerText(text)) return integerText(text);
  if (column.type === 'number' && isNumberText(text)) return numberText(text);
  return text;
}

/** Content columns only, canonical, in spec order. */
export function canonicalRow(spec: FileSpec, row: Readonly<Record<string, CellInput>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of spec.columns) {
    if (!isContentColumn(column)) continue;
    out[column.name] = canonicalCell(column, row[column.name]);
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface UnitContent {
  root: Readonly<Record<string, CellInput>> | null;
  /** Child rows by child file name. */
  children: Readonly<Record<string, readonly Readonly<Record<string, CellInput>>[]>>;
}

/**
 * One hash for an item and all of its child rows. Child rows are sorted by
 * their canonical text, because row order within a child file is not content
 * (scale levels and stop rules carry their own order columns).
 */
export function unitContentHash(dataset: DatasetSpec, unit: UnitContent): string {
  const rootSpec = dataset.files.find((file) => !file.parent);
  const payload: unknown[] = [dataset.name];
  payload.push(rootSpec && unit.root ? canonicalRow(rootSpec, unit.root) : null);
  for (const spec of dataset.files) {
    if (!spec.parent) continue;
    const rows = (unit.children[spec.file] ?? []).map((row) => JSON.stringify(canonicalRow(spec, row))).sort();
    payload.push([spec.file, rows]);
  }
  return sha256Hex(JSON.stringify(payload));
}

/**
 * The unit of every item in a dataset: its root row plus child rows grouped
 * by parent. `overlay`, when given, wins per parent and per child file -- the
 * package rows of a parent replace that parent's baseline rows only in the
 * child files where the package has at least one row for it (the contract's
 * child-replacement rule).
 */
export function datasetUnits(
  dataset: DatasetSpec,
  base: ParsedPackage | undefined,
  overlay?: ParsedPackage,
): Map<string, UnitContent> {
  const rootSpec = dataset.files.find((file) => !file.parent);
  if (!rootSpec) return new Map();
  const keyColumn = rootSpec.key[0];

  const rowsOf = (pkg: ParsedPackage | undefined, spec: FileSpec): RowValues[] =>
    pkg?.files.find((file) => file.spec === spec)?.rows.map((row) => row.values) ?? [];

  const units = new Map<string, { root: RowValues | null; children: Record<string, RowValues[]> }>();
  const unitFor = (id: string) => {
    let unit = units.get(id);
    if (!unit) {
      unit = { root: null, children: {} };
      units.set(id, unit);
    }
    return unit;
  };

  for (const row of rowsOf(base, rootSpec)) unitFor(row[keyColumn]).root = row;
  for (const row of rowsOf(overlay, rootSpec)) unitFor(row[keyColumn]).root = row;

  for (const spec of dataset.files) {
    if (!spec.parent) continue;
    const parentColumn = spec.parent.column;
    const overlayRows = rowsOf(overlay, spec);
    const overlaid = new Set(overlayRows.map((row) => row[parentColumn]));
    for (const row of rowsOf(base, spec)) {
      if (overlaid.has(row[parentColumn])) continue;
      (unitFor(row[parentColumn]).children[spec.file] ??= []).push(row);
    }
    for (const row of overlayRows) {
      (unitFor(row[parentColumn]).children[spec.file] ??= []).push(row);
    }
  }

  return units as Map<string, UnitContent>;
}
