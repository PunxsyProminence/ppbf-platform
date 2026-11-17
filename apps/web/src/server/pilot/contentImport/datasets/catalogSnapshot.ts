import { type CellInput, canonicalRow, isContentColumn, sha256Hex } from '../canonical';
import { appendLedgerRow, ledgerHeads, planLedgerVersions, type LedgerVersionPlan } from '../ledger';
import type { ColumnSpec, FileSpec, Finding, ParsedFile } from '../types';
import type { ValidationResult } from '../validate';
import { integerText, normalizeCell, numberText, splitList } from '../values';
import { withStoredLabels } from './contentLabels';
import type { DatasetWriteResult, EngineContext, UnitPlan } from './index';

// THE CATALOG SNAPSHOT PATTERN, shared by the pathway catalog
// (datasets/pathwayCatalog.ts, lane BB-1b) and the assessment catalog
// (datasets/assessmentCatalog.ts, lane CAT-b). Lifted out of the pathway
// catalog engine unchanged in behaviour: the same hashes, the same outcomes,
// the same writes (the pathway-catalog pg suite pins a plan hash, and lane
// CAT-b's suite re-plans the committed pathway seed against it).
//
// Each FILE is a whole snapshot of one keyed table, loaded in the keyed-
// registry pattern (registries.ts) with one difference: a row the table holds
// that the file leaves out is retired.
//
//   new          inserted, active; recorded in the history ledger as v1
//   unchanged    nothing written
//   new_version  updated in place, the ledger recording before (when it has
//                not seen that content) and after. Retiring a row (the file
//                leaves it out) and bringing a retired row back are new
//                versions too: active_flag is part of what the ledger records.
//   absent       a retired row the file still leaves out; not touched
//
// LABELS ARE NATIVE (SP-1): field_labels and evidence are columns of each
// table, written from the package's label columns; a label column the file
// leaves out keeps the stored value (contentLabels.ts withStoredLabels).
// stage_keys is never a column of a catalog table.

export interface SnapshotTable {
  spec: FileSpec;
  table: string;
  /** pilot.reference_content_revisions.dataset (a lowercase slug). */
  ledgerDataset: string;
  itemKey(row: Readonly<Record<string, CellInput>>): string;
  /** Columns that hold JSON in the table (jsonb): compared, and handed to withStoredLabels, as text. */
  jsonColumns: ReadonlySet<string>;
}

export interface SnapshotItem {
  table: SnapshotTable;
  unit: UnitPlan;
  cells?: Record<string, CellInput>;
  active: boolean;
  databaseCells?: Record<string, CellInput>;
  ledger?: LedgerVersionPlan;
}

export type DatabaseRows = Map<SnapshotTable, Map<string, Record<string, CellInput>>>;

/** JSON with keys sorted at every depth, so CSV text and jsonb compare equal. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function jsonText(value: CellInput | object): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') return sortedJson(value);
  try {
    return sortedJson(JSON.parse(String(value)));
  } catch {
    return String(value);
  }
}

/** A row's cells with its JSON content columns in one canonical form, whichever side it came from. */
export function normalizedRow(table: SnapshotTable, row: Readonly<Record<string, unknown>>): Record<string, CellInput> {
  const out: Record<string, CellInput> = {};
  for (const [name, value] of Object.entries(row)) {
    out[name] = table.jsonColumns.has(name) ? jsonText(value as CellInput) : (value as CellInput);
  }
  return out;
}

/** What one row IS, active or retired: the ledger's content_sha256. */
export function snapshotRowHash(table: SnapshotTable, row: Readonly<Record<string, CellInput>>, active: boolean): string {
  return sha256Hex(JSON.stringify([table.spec.file, canonicalRow(table.spec, row), active ? 'active' : 'retired']));
}

function ledgerContent(table: SnapshotTable, row: Readonly<Record<string, CellInput>>, active: boolean): Record<string, string> {
  return { ...canonicalRow(table.spec, row), active_flag: String(active) };
}

/**
 * The value written for a validated cell. A blank is the value it stands for
 * (blankDefault: what the hash already reads it as), else NULL (every optional
 * catalog column is nullable). The pathway catalog's columns carry no
 * blankDefault, so its writes are as they were.
 */
export function databaseValue(column: ColumnSpec, value: string): unknown {
  if (!value && column.blankDefault !== undefined) return column.type === 'boolean' ? column.blankDefault === 'true' : column.blankDefault;
  if (!value) return null;
  if (column.type === 'integer') return Number(integerText(value));
  if (column.type === 'number') return Number(numberText(value));
  if (column.list) return splitList(value, column.list);
  return value;
}

/** A cell as written text, whichever side it came from (a list cell may arrive as an array). */
export function cellText(column: ColumnSpec, cell: CellInput): string {
  if (Array.isArray(cell)) return normalizeCell(cell.join(column.list ?? '|'));
  return normalizeCell(cell === null || cell === undefined ? '' : String(cell));
}

/** The columns an UPDATE or INSERT writes: content (labels included; stage_keys is not a column). */
export function writtenColumns(spec: FileSpec): ColumnSpec[] {
  return spec.columns.filter((column) => (isContentColumn(column) || column.role === 'key') && column.name !== 'stage_keys');
}

export async function readSnapshotTables(ctx: EngineContext, tables: readonly SnapshotTable[]): Promise<DatabaseRows> {
  const database: DatabaseRows = new Map();
  for (const table of tables) {
    const { rows } = await ctx.client.query<Record<string, unknown>>(`select * from pilot.${table.table} where organization_id = $1`, [ctx.organizationId]);
    database.set(table, new Map(rows.map((row) => {
      const cells = normalizedRow(table, row);
      return [table.itemKey(cells), cells];
    })));
  }
  return database;
}

/** Every row of each table: a snapshot may retire rows it does not name. */
export async function lockSnapshotTables(ctx: EngineContext, tables: readonly SnapshotTable[]): Promise<void> {
  for (const table of tables) {
    await ctx.client.query(`select 1 from pilot.${table.table} where organization_id = $1 order by 1 for update`, [ctx.organizationId]);
  }
}

/** Each present file's rows against its table: new, unchanged, new_version, reject; and the rows it leaves out, retired or absent. */
export async function planSnapshotTables(
  ctx: EngineContext,
  input: { files: readonly ParsedFile[]; validation: ValidationResult },
  tables: readonly SnapshotTable[],
  database: DatabaseRows,
  findings: readonly Finding[],
): Promise<SnapshotItem[]> {
  const items: SnapshotItem[] = [];
  for (const table of tables) {
    const file = input.files.find((candidate) => candidate.spec === table.spec);
    if (!file) continue;
    const rows = database.get(table) ?? new Map();
    const keys = file.rows.map((row) => table.itemKey(row.values));
    const heads = await ledgerHeads(ctx.client, ctx.organizationId, table.ledgerDataset, [...new Set([...keys, ...rows.keys()])]);
    const fileFindings = [...input.validation.blocking, ...findings].filter((finding) => finding.file === file.path);
    const wholeFile = fileFindings.filter((finding) => finding.line === undefined || finding.line <= 1).map((finding) => finding.message);
    const seen = new Set<string>();
    const datasetName = table.spec.dataset;

    file.rows.forEach((row, index) => {
      const key = keys[index];
      seen.add(key);
      const existing = rows.get(key);
      const cells = normalizedRow(table, withStoredLabels(file.header, row.values, existing));
      const unit: UnitPlan = { dataset: datasetName, key, outcome: 'reject', fileSha256: snapshotRowHash(table, cells, true) };
      const existingActive = existing ? existing.active_flag !== false : false;
      if (existing) unit.databaseSha256 = snapshotRowHash(table, existing, existingActive);
      const reasons = [...wholeFile, ...fileFindings.filter((finding) => finding.line === row.line).map((finding) => finding.message)];
      let ledger: LedgerVersionPlan | undefined;
      if (reasons.length > 0) {
        unit.reasons = reasons;
      } else if (!existing) {
        unit.outcome = 'new';
        ledger = planLedgerVersions(heads.get(key), undefined);
      } else if (unit.fileSha256 === unit.databaseSha256) {
        unit.outcome = 'unchanged';
      } else {
        unit.outcome = 'new_version';
        ledger = planLedgerVersions(heads.get(key), unit.databaseSha256);
      }
      items.push({ table, unit, cells, active: true, databaseCells: existing, ledger });
    });

    // The snapshot leaves these out: an active row is retired, a retired one left alone.
    for (const [key, row] of rows) {
      if (seen.has(key)) continue;
      if (row.active_flag === false) {
        items.push({ table, unit: { dataset: datasetName, key, outcome: 'absent' }, active: false });
        continue;
      }
      const unit: UnitPlan = {
        dataset: datasetName,
        key,
        outcome: 'new_version',
        retires: true,
        fileSha256: snapshotRowHash(table, row, false),
        databaseSha256: snapshotRowHash(table, row, true),
      };
      const ledger = planLedgerVersions(heads.get(key), unit.databaseSha256);
      items.push({ table, unit, cells: row, active: false, databaseCells: row, ledger });
    }
  }
  return items;
}

/** Copies each item's ledger versions onto its unit, as the plan prints them. */
export function finishSnapshotUnits(items: readonly SnapshotItem[]): void {
  for (const item of items) {
    if (item.ledger) {
      if (item.ledger.fromVersion !== undefined) item.unit.fromVersion = item.ledger.fromVersion;
      item.unit.toVersion = item.ledger.toVersion;
      if (item.ledger.recordBefore) item.unit.recordsBefore = true;
    }
  }
}

/** Writes exactly what planSnapshotTables decided, table by table in `tables` order (a table before the tables that name it). */
export async function applySnapshotTables(
  ctx: EngineContext,
  tables: readonly SnapshotTable[],
  items: readonly SnapshotItem[],
  write: { importId: string },
  result: DatasetWriteResult,
  what: string,
): Promise<void> {
  const record = async (table: SnapshotTable, key: string, version: number, content: Record<string, string>, sha: string) => {
    await appendLedgerRow(ctx.client, {
      organizationId: ctx.organizationId,
      dataset: table.ledgerDataset,
      itemKey: key,
      version,
      content,
      contentSha256: sha,
      importId: write.importId,
      actor: ctx.actor,
    });
    result.ledgerRows += 1;
  };

  for (const table of tables) {
    const columns = writtenColumns(table.spec);
    const keyColumns = table.spec.key;
    for (const item of items) {
      const { unit, cells, ledger } = item;
      if (item.table !== table || (unit.outcome !== 'new' && unit.outcome !== 'new_version')) continue;
      if (!cells || !ledger || !unit.fileSha256) throw new Error(`content-import: ${what} ${unit.key} was planned without its content`);
      const value = (column: ColumnSpec) => databaseValue(column, cellText(column, cells[column.name]));

      if (unit.outcome === 'new') {
        const names = ['organization_id', ...columns.map((column) => column.name), 'active_flag'];
        const params = [ctx.organizationId, ...columns.map(value), true];
        await ctx.client.query(
          `insert into pilot.${table.table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          params,
        );
        result.inserted.push(unit.key);
        await record(table, unit.key, ledger.toVersion, ledgerContent(table, cells, true), unit.fileSha256);
        continue;
      }

      if (ledger.recordBefore) {
        if (!item.databaseCells || !unit.databaseSha256 || ledger.fromVersion === undefined) {
          throw new Error(`content-import: ${what} ${unit.key} was planned as a revision without its database content`);
        }
        const wasActive = item.databaseCells.active_flag !== false;
        await record(table, unit.key, ledger.fromVersion, ledgerContent(table, item.databaseCells, wasActive), unit.databaseSha256);
      }
      const params: unknown[] = [ctx.organizationId, ...keyColumns.map((name) => String(cells[name]))];
      const where = keyColumns.map((name, index) => `${name} = $${index + 2}`).join(' and ');
      const sets = ['active_flag', 'updated_at'].map((name) => `${name} = ${name === 'updated_at' ? 'now()' : `$${params.push(item.active)}`}`);
      if (item.active) {
        for (const column of columns) {
          if (keyColumns.includes(column.name)) continue;
          sets.push(`${column.name} = $${params.push(value(column))}`);
        }
      }
      const outcome = await ctx.client.query(`update pilot.${table.table} set ${sets.join(', ')} where organization_id = $1 and ${where}`, params);
      if (outcome.rowCount !== 1) {
        throw new Error(`content-import: expected to update 1 row of pilot.${table.table} for ${unit.key}, updated ${outcome.rowCount}`);
      }
      result.updated.push(item.active ? unit.key : `${unit.key} retired`);
      await record(table, unit.key, ledger.toVersion, ledgerContent(table, cells, item.active), unit.fileSha256);
    }
  }
}
