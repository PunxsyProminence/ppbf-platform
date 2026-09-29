import { writeCsv } from './csv';
import { type IdKind, isNewId } from './ids';
import { referenceSetsFromBaseline } from './referenceSets';
import { committedPath, FILE_SPECS } from './specs';
import type { ColumnSpec, FileSpec, Finding, ParsedFile, ParsedPackage, ReferenceSets } from './types';
import { type MintedIds, parseFile, rowKey, validateParsed, type ValidationResult } from './validate';
import { normalizeCell, splitList } from './values';

// `content:prepare`: turn a validated hand-off into the committed seed files.
//
// IT MERGES, IT NEVER COPIES. A package may carry any subset of the material
// (a type or file it leaves out is untouched, never read as empty), and the
// committed CSVs are the current source for everything the package does not
// mention. Copying a subset over them would silently delete the rest -- and
// orphan the template items and transfer claims that point at it (CRITIQUE,
// missing: "content:prepare copies the files").
//
//   item files (drills, templates, ...)  a row with the same key replaces the
//                                        committed row in place; a new key is
//                                        appended; nothing is ever dropped
//   child files (scale levels, items...) a parent's rows in the package
//                                        replace ALL of that parent's committed
//                                        rows in that file; parents with no row
//                                        in the package keep theirs
//
// THE HAND-OFF FILES GET THE MINTED IDS TOO. Every new:<short-name> in the
// package is replaced by the id it minted, so the folder now names what the
// repository holds: running prepare on it again finds every item unchanged,
// instead of refusing each new: because its minted id now exists.
//
// Pure: committed files in, new file texts out. The CLI writes them.

export interface FileChange {
  /** Relative to apps/web/seed-data. */
  path: string;
  before: string | null;
  after: string;
  added: string[];
  replaced: string[];
  unchanged: string[];
  parentsReplaced: { parent: string; removed: number; added: number }[];
}

export interface PrepareResult {
  changes: FileChange[];
  /** Hand-off files with their new:<short-name> ids replaced, by package-relative path. Only files that change. */
  packageRewrites: { path: string; after: string }[];
  minted: { kind: IdKind; from: string; to: string }[];
  /** Blank child ids the tool filled in. */
  mintedChildIds: number;
  /** Blocking findings the merged files would have that the committed files do not. Must be empty to write. */
  introducedFindings: Finding[];
  notices: string[];
}

export interface PrepareInput {
  validation: ValidationResult;
  baseline: ParsedPackage;
  /** Exact committed text by path relative to seed-data, for the files that exist. */
  baselineText: ReadonlyMap<string, string>;
  claimIds: ReadonlySet<string>;
  skillCodes: ReadonlySet<string>;
}

type Cells = Record<string, string>;

function kindOfReference(spec: FileSpec, column: ColumnSpec): IdKind | undefined {
  if (column.role === 'key') return spec.mint?.idKind;
  if (column.allowNew) return column.idKind;
  return undefined;
}

function resolveNewIds(spec: FileSpec, cells: Cells, minted: MintedIds): void {
  for (const column of spec.columns) {
    const value = cells[column.name];
    if (!value || !isNewId(value)) continue;
    const kind = kindOfReference(spec, column);
    const id = kind ? minted.get(kind)?.get(value) : undefined;
    if (!id) throw new Error(`${spec.file}: ${column.name} ${value} has no minted id (validation should have refused this)`);
    cells[column.name] = id;
  }
}

/** The package row as it will be written: normalized, new ids resolved, placeholders and ids filled. */
function preparedCells(
  spec: FileSpec,
  values: Readonly<Record<string, string>>,
  minted: MintedIds,
  committedByKey: ReadonlyMap<string, Record<string, string>>,
  counter: { childIds: number },
): Cells {
  const cells: Cells = {};
  for (const column of spec.columns) {
    const value = values[column.name] ?? '';
    cells[column.name] = column.list && value ? splitList(value, column.list).join(column.list) : value;
  }
  resolveNewIds(spec, cells, minted);

  // A blank tool-decided cell takes the committed row's value when the row
  // already exists (same key) -- including a child's own id, so re-sending a
  // drill's unchanged scale rows without their ids does not re-mint them.
  const committed = committedByKey.get(rowKey(spec, cells));
  for (const column of spec.columns) {
    if (cells[column.name]) continue;
    const kept = committed ? normalizeCell(committed[column.name]) : '';
    if (column.role === 'placeholder') cells[column.name] = kept || (column.placeholder ?? '');
    else if (column.role === 'lineage') cells[column.name] = kept || cells[spec.key[0]];
    else if (column.role === 'system') cells[column.name] = kept || (column.systemDefault ?? '');
    else if (column.role === 'child_id') cells[column.name] = kept;
  }

  const mint = spec.mint;
  if (mint && !cells[mint.column]) {
    cells[mint.column] = mint.mint(cells);
    counter.childIds += 1;
  }
  return cells;
}

function headerFor(spec: FileSpec, committed: ParsedFile | undefined, packageRows: readonly Cells[]): string[] {
  if (!committed) return spec.columns.map((column) => column.name);
  const header = [...committed.header];
  for (const column of spec.columns) {
    if (header.includes(column.name)) continue;
    // Added only when the package actually says something in it: a blank
    // column would change every committed row's bytes for nothing.
    if (packageRows.some((row) => row[column.name])) header.push(column.name);
  }
  return header;
}

function sameRow(header: readonly string[], raw: Readonly<Record<string, string>>, cells: Cells): boolean {
  return header.every((name) => normalizeCell(raw[name]) === (cells[name] ?? ''));
}

function mergeFile(
  spec: FileSpec,
  committed: ParsedFile | undefined,
  before: string | null,
  packageFile: ParsedFile,
  minted: MintedIds,
  counter: { childIds: number },
): FileChange {
  const committedByKey = new Map((committed?.rows ?? []).map((row) => [rowKey(spec, row.values), row.raw]));
  const prepared = packageFile.rows.map((row) => preparedCells(spec, row.values, minted, committedByKey, counter));
  const header = headerFor(spec, committed, prepared);

  // Each output row is either a committed row kept byte for byte, or prepared cells.
  type Out = { raw: Readonly<Record<string, string>> } | { cells: Cells };
  const out: Out[] = (committed?.rows ?? []).map((row) => ({ raw: row.raw }));
  const change: FileChange = {
    path: committedPath(spec),
    before,
    after: '',
    added: [],
    replaced: [],
    unchanged: [],
    parentsReplaced: [],
  };

  if (spec.parent) {
    const parentColumn = spec.parent.column;
    const byParent = new Map<string, Cells[]>();
    for (const cells of prepared) {
      const list = byParent.get(cells[parentColumn]) ?? [];
      list.push(cells);
      byParent.set(cells[parentColumn], list);
    }
    for (const [parent, rows] of byParent) {
      const positions = out
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => ('raw' in entry ? normalizeCell(entry.raw[parentColumn]) : entry.cells[parentColumn]) === parent);
      const old = positions.map(({ entry }) => entry);
      const unchanged = old.length === rows.length
        && old.every((entry, index) => 'raw' in entry && sameRow(header, entry.raw, rows[index]));
      if (unchanged) {
        change.unchanged.push(parent);
        continue;
      }
      const at = positions.length > 0 ? positions[0].index : out.length;
      for (const { index } of [...positions].reverse()) out.splice(index, 1);
      out.splice(Math.min(at, out.length), 0, ...rows.map((cells) => ({ cells })));
      change.parentsReplaced.push({ parent, removed: old.length, added: rows.length });
    }
  } else {
    const indexByKey = new Map(out.map((entry, index) => ['raw' in entry ? rowKey(spec, mapNormalized(entry.raw)) : '', index]));
    for (const cells of prepared) {
      const key = rowKey(spec, cells);
      const index = indexByKey.get(key);
      if (index === undefined) {
        indexByKey.set(key, out.length);
        out.push({ cells });
        change.added.push(key);
        continue;
      }
      const existing = out[index];
      if ('raw' in existing && sameRow(header, existing.raw, cells)) {
        change.unchanged.push(key);
        continue;
      }
      out[index] = { cells };
      change.replaced.push(key);
    }
  }

  change.after = writeCsv(
    header,
    out.map((entry) => header.map((name) => ('raw' in entry ? entry.raw[name] ?? '' : entry.cells[name] ?? ''))),
  );
  return change;
}

function mapNormalized(raw: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) out[name] = normalizeCell(value);
  return out;
}

/** The package file as given, with each new:<short-name> id replaced by its minted id. */
function rewrittenPackageFile(file: ParsedFile, minted: MintedIds): { path: string; after: string } | null {
  let changed = false;
  const columns = new Map(file.spec.columns.map((column) => [column.name, column]));
  const rows = file.rows.map((row) =>
    file.header.map((name) => {
      const raw = row.raw[name] ?? '';
      const column = columns.get(name);
      const value = normalizeCell(raw);
      if (!column || !isNewId(value)) return raw;
      const kind = kindOfReference(file.spec, column);
      const id = kind ? minted.get(kind)?.get(value) : undefined;
      if (!id) return raw;
      changed = true;
      return id;
    }),
  );
  return changed ? { path: file.path, after: writeCsv(file.header, rows) } : null;
}

function signature(finding: Finding): string {
  // No line number: merging moves rows, and a finding that only moved is not new.
  return [finding.code, finding.file, finding.key ?? '', finding.column ?? ''].join('\u0000');
}

function mergedPackage(baseline: ParsedPackage, changes: readonly FileChange[]): ParsedPackage {
  const files: ParsedFile[] = [];
  for (const spec of FILE_SPECS) {
    const change = changes.find((c) => c.path === committedPath(spec));
    if (change) {
      files.push(parseFile(change.path, spec, change.after).file);
      continue;
    }
    const kept = baseline.files.find((file) => file.spec === spec);
    if (kept) files.push(kept);
  }
  return { files };
}

function validateAll(pkg: ParsedPackage, claimIds: ReadonlySet<string>, skillCodes: ReadonlySet<string>): Finding[] {
  const references: ReferenceSets = referenceSetsFromBaseline(pkg, { claimIds, skillCodes });
  return validateParsed(pkg, { references, baseline: pkg }).blocking;
}

export function preparePackage(input: PrepareInput): PrepareResult {
  const { validation, baseline, baselineText } = input;
  if (validation.blocking.length > 0) {
    throw new Error(`refusing to prepare a package with ${validation.blocking.length} blocking findings`);
  }

  const counter = { childIds: 0 };
  const changes: FileChange[] = [];
  for (const packageFile of validation.parsed.files) {
    const spec = packageFile.spec;
    const committed = baseline.files.find((file) => file.spec === spec);
    const before = baselineText.get(committedPath(spec)) ?? null;
    changes.push(mergeFile(spec, committed, before, packageFile, validation.minted, counter));
  }

  // The merged files must not carry a blocking finding the committed ones do
  // not: that is exactly what contentPackageContract.test.ts would fail on in
  // the PR, so it is refused here, before anything is written.
  const beforeFindings = new Set(validateAll(baseline, input.claimIds, input.skillCodes).map(signature));
  const merged = mergedPackage(baseline, changes);
  const introducedFindings = validateAll(merged, input.claimIds, input.skillCodes).filter(
    (finding) => !beforeFindings.has(signature(finding)),
  );

  const packageRewrites = validation.parsed.files
    .map((file) => rewrittenPackageFile(file, validation.minted))
    .filter((rewrite): rewrite is { path: string; after: string } => rewrite !== null);

  const minted: PrepareResult['minted'] = [];
  for (const [kind, map] of validation.minted) {
    for (const [from, to] of map) minted.push({ kind, from, to });
  }

  const notices: string[] = [];
  const revised = changes.reduce((sum, change) => sum + change.replaced.length + change.parentsReplaced.filter((p) => p.removed > 0).length, 0);
  if (revised > 0) {
    notices.push(
      `${revised} committed item(s) or child sets are REVISED. The seed loaders that run today are insert-only: they skip `
      + 'an id (or drill/template name) that already exists, so a revision reaches the files now and the database only '
      + 'once the versioning loader lands (plan IMP-06/07/10). See "Loaded today" in docs/CONTENT_PACKAGE_CONTRACT.md.',
    );
  }
  if (changes.some((change) => change.path.endsWith('seed_drill_secondary_skills.csv') && (change.added.length || change.parentsReplaced.length))) {
    notices.push(
      'seed_drill_secondary_skills.csv changed. seedWorkflowContract.test.ts pins that file to its one approved row '
      + "('seeds exactly the one approved relationship and no other'), so the PR must change that test too, on Jason's "
      + 'say-so (decision 8 in the intake plan).',
    );
  }
  const drillFile = merged.files.find((file) => file.spec.file === 'seed_drill_library.csv');
  if (drillFile) {
    const used = new Set(drillFile.rows.map((row) => row.values.skill_id).filter(Boolean));
    const stale = [...input.skillCodes].filter((code) => !used.has(code)).sort();
    if (stale.length > 0) {
      notices.push(
        `skillFamilies.ts lists ${stale.join(', ')}, which no drill in the merged library uses. Remove them from `
        + 'UNMAPPED_SKILL_CODES / FAMILY_MEMBER_CODES; skillFamilies.test.ts fails on a stale entry.',
      );
    }
  }

  return { changes, packageRewrites, minted, mintedChildIds: counter.childIds, introducedFindings, notices };
}
