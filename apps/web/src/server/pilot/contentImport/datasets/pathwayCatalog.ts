import type { DbClient } from '../actor';
import { type CellInput, canonicalRow, isContentColumn, sha256Hex } from '../canonical';
import { appendLedgerRow, ledgerHeads, planLedgerVersions, type LedgerVersionPlan } from '../ledger';
import { datasetSpec } from '../specs';
import {
  PATHWAY_DEFAULTS_FILE,
  PATHWAY_LINKS_FILE,
  PATHWAY_STAGES_FILE,
  pathwayStageReferenceFindings,
} from '../specs/pathwayCatalog';
import { type ColumnSpec, type FileSpec, type Finding, type ParsedFile, type ParsedPackage, STAGE_KEYS, type Warning } from '../types';
import { integerText, normalizeCell, numberText, splitList } from '../values';
import { withStoredLabels } from './contentLabels';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, EngineContext, UnitPlan } from './index';

// THE PATHWAY CATALOG ENGINE (specs/pathwayCatalog.ts; pathway_catalog
// migration). Three keyed tables, each loaded in the keyed-registry pattern
// (registries.ts) with one difference: each FILE is a whole snapshot, so a row
// the table holds that the file leaves out is retired.
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
// leaves out keeps the stored value (contentLabels.ts withStoredLabels, lane
// BB-1a's rule). stage_keys is blank on catalog rows (the spec refuses it).
//
// NOTHING HERE PLACES ANYONE. The catalog describes; no reader computes or
// restricts a stage from it.

interface Table {
  spec: FileSpec;
  table: string;
  /** pilot.reference_content_revisions.dataset (a lowercase slug). */
  ledgerDataset: string;
  itemKey(row: Readonly<Record<string, CellInput>>): string;
}

const dataset = datasetSpec('pathway-catalog');
const specOf = (file: string) => dataset.files.find((spec) => spec.file === file) as FileSpec;

const TABLES: readonly Table[] = [
  { spec: specOf(PATHWAY_STAGES_FILE), table: 'pathway_stages', ledgerDataset: 'pathway_stages', itemKey: (row) => String(row.stage_key) },
  {
    spec: specOf(PATHWAY_LINKS_FILE),
    table: 'pathway_stage_links',
    ledgerDataset: 'pathway_stage_links',
    itemKey: (row) => `${String(row.from_stage_key)}>${String(row.to_stage_key)}`,
  },
  { spec: specOf(PATHWAY_DEFAULTS_FILE), table: 'pathway_stage_defaults', ledgerDataset: 'pathway_stage_defaults', itemKey: (row) => String(row.default_id) },
];

/** Columns that hold JSON in the table (jsonb): compared, and handed to withStoredLabels, as text. */
const JSON_CONTENT = new Set(['phases', 'field_labels', 'evidence']);

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
function normalized(row: Readonly<Record<string, unknown>>): Record<string, CellInput> {
  const out: Record<string, CellInput> = {};
  for (const [name, value] of Object.entries(row)) {
    out[name] = JSON_CONTENT.has(name) ? jsonText(value as CellInput) : (value as CellInput);
  }
  return out;
}

/** What one row IS, active or retired: the ledger's content_sha256. */
function rowHash(table: Table, row: Readonly<Record<string, CellInput>>, active: boolean): string {
  return sha256Hex(JSON.stringify([table.spec.file, canonicalRow(table.spec, row), active ? 'active' : 'retired']));
}

function ledgerContent(table: Table, row: Readonly<Record<string, CellInput>>, active: boolean): Record<string, string> {
  return { ...canonicalRow(table.spec, row), active_flag: String(active) };
}

/** The value written for a validated cell; blank is NULL (every optional column is nullable). */
function databaseValue(column: ColumnSpec, value: string): unknown {
  if (!value) return null;
  if (column.type === 'integer') return Number(integerText(value));
  if (column.type === 'number') return Number(numberText(value));
  if (column.list) return splitList(value, column.list);
  return value;
}

/** The columns an UPDATE or INSERT writes: content (labels included; stage_keys is not a column). */
function written(table: Table): ColumnSpec[] {
  return table.spec.columns.filter((column) => (isContentColumn(column) || column.role === 'key') && column.name !== 'stage_keys');
}

interface Item {
  table: Table;
  unit: UnitPlan;
  cells?: Record<string, CellInput>;
  active: boolean;
  databaseCells?: Record<string, CellInput>;
  ledger?: LedgerVersionPlan;
}

interface State {
  items: Item[];
}

async function tablesExist(client: DbClient): Promise<boolean> {
  const { rows } = await client.query<{ ready: boolean }>(`select to_regclass('pilot.pathway_stages') is not null as ready`);
  return rows[0]?.ready === true;
}

async function databaseRows(ctx: EngineContext, table: Table): Promise<Map<string, Record<string, CellInput>>> {
  const { rows } = await ctx.client.query<Record<string, unknown>>(`select * from pilot.${table.table} where organization_id = $1`, [ctx.organizationId]);
  return new Map(rows.map((row) => {
    const cells = normalized(row);
    return [table.itemKey(cells), cells];
  }));
}

/** Every stage key the organization's catalog holds, retired ones included (a link to one is still a valid foreign key). */
async function keptStageKeys(client: DbClient, organizationId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ stage_key: string }>('select stage_key from pilot.pathway_stages where organization_id = $1', [organizationId]);
  return new Set(rows.map((row) => row.stage_key));
}

/**
 * THE PLAN-STAGE STAGE-KEY CHECK (plan.ts). Every stage a content item names
 * in stage_keys must be in the catalog it will be linked to: this
 * organization's loaded stages (a retired stage is kept and still counts, so
 * an item already linked to one is not refused on re-import) plus the
 * package's own seed_pathway_stages.csv. Refused by name before any write --
 * exactly what content_stage_links' foreign key would refuse at apply. A key
 * outside the 18 already has its offline finding (validate.ts) and is not
 * repeated.
 */
export async function stageKeyFindings(client: DbClient, organizationId: string, parsed: ParsedPackage): Promise<Finding[]> {
  const files = parsed.files.filter((file) => file.spec.dataset !== 'pathway-catalog' && file.spec.columns.some((c) => c.annotation === 'stage_keys'));
  const named = files.some((file) => file.rows.some((row) => row.values.stage_keys));
  if (!named) return [];
  const ready = await tablesExist(client);
  const stagesFile = parsed.files.find((file) => file.spec.file === PATHWAY_STAGES_FILE);
  const known = new Set([...(stagesFile?.rows.map((row) => row.values.stage_key) ?? []), ...(ready ? await keptStageKeys(client, organizationId) : [])]);
  const source = ready
    ? `this organization's pathway catalog (pilot.pathway_stages)${stagesFile ? ` or ${PATHWAY_STAGES_FILE} of this package` : ''}`
    : 'any pathway catalog: pilot.pathway_stages does not exist in this database; apply the pathway-catalog migration first';
  const out: Finding[] = [];
  for (const file of files) {
    for (const row of file.rows) {
      for (const key of splitList(row.values.stage_keys ?? '', '|')) {
        if (known.has(key) || !(STAGE_KEYS as readonly string[]).includes(key)) continue;
        out.push({ code: 'unknown_stage_key', file: file.path, line: row.line, column: 'stage_keys', message: `'${key}' is not a stage in ${source}` });
      }
    }
  }
  return out;
}

export const PATHWAY_CATALOG_ENGINE: DatasetEngine = {
  spec: dataset,

  // Nothing in the catalog is minted or unique beyond its key, so the
  // validator needs no baseline.
  async readBaseline(): Promise<ParsedFile[]> {
    return [];
  },

  // Every row of the three tables: a snapshot may retire rows it does not name.
  async lockKeys(ctx): Promise<void> {
    if (!(await tablesExist(ctx.client))) return;
    for (const table of TABLES) {
      await ctx.client.query(`select 1 from pilot.${table.table} where organization_id = $1 order by 1 for update`, [ctx.organizationId]);
    }
  },

  async plan(ctx, input): Promise<DatasetPlan> {
    if (!(await tablesExist(ctx.client))) {
      return {
        dataset: dataset.name,
        units: [],
        state: { items: [] } satisfies State,
        findings: input.files.map((file) => ({
          code: 'dataset_not_loadable',
          file: file.path,
          message: 'pilot.pathway_stages does not exist in this database; apply the pathway-catalog migration first.',
        })),
      };
    }

    const findings: Finding[] = [];
    const present = (table: Table) => input.files.find((file) => file.spec === table.spec);
    const database = new Map<Table, Map<string, Record<string, CellInput>>>();
    for (const table of TABLES) database.set(table, await databaseRows(ctx, table));

    // Link ends and default scopes against the stages this load leaves
    // active. With the package's stage file, the validator has checked the
    // package's rows; what is left is a LOADED link or default that a file
    // the package leaves out still names, and the package's stage file would
    // retire its stage. Without one, the package's rows against the loaded
    // active stages.
    const stagesTable = TABLES[0];
    if (present(stagesTable)) {
      const kept = new Set(present(stagesTable)?.rows.map((row) => row.values.stage_key));
      for (const table of TABLES.slice(1)) {
        if (present(table)) continue;
        for (const [key, row] of database.get(table) ?? []) {
          if (row.active_flag === false) continue;
          const ends = table === TABLES[1] ? [row.from_stage_key, row.to_stage_key] : [row.stage_key];
          for (const end of ends) {
            if (end && !kept.has(String(end))) {
              findings.push({
                code: 'orphan_reference',
                file: present(stagesTable)?.path ?? PATHWAY_STAGES_FILE,
                key,
                message: `this file would retire stage '${String(end)}', but the loaded ${table.table === 'pathway_stage_links' ? 'link' : 'default'} ${key} still names it; carry ${table.spec.file} too, or keep the stage`,
              });
            }
          }
        }
      }
    } else {
      const loaded = new Set(
        [...(database.get(stagesTable)?.values() ?? [])].filter((row) => row.active_flag !== false).map((row) => String(row.stage_key)),
      );
      findings.push(...pathwayStageReferenceFindings({ files: [...input.files] }, (key) => loaded.has(key), "this organization's active pathway stages (pilot.pathway_stages)"));
    }

    const items: Item[] = [];
    for (const table of TABLES) {
      const file = present(table);
      if (!file) continue;
      const rows = database.get(table) ?? new Map();
      const keys = file.rows.map((row) => table.itemKey(row.values));
      const heads = await ledgerHeads(ctx.client, ctx.organizationId, table.ledgerDataset, [...new Set([...keys, ...rows.keys()])]);
      const fileFindings = [...input.validation.blocking, ...findings].filter((finding) => finding.file === file.path);
      const wholeFile = fileFindings.filter((finding) => finding.line === undefined || finding.line <= 1).map((finding) => finding.message);
      const seen = new Set<string>();

      file.rows.forEach((row, index) => {
        const key = keys[index];
        seen.add(key);
        const existing = rows.get(key);
        const cells = normalized(withStoredLabels(file.header, row.values, existing));
        const unit: UnitPlan = { dataset: dataset.name, key, outcome: 'reject', fileSha256: rowHash(table, cells, true) };
        const existingActive = existing ? existing.active_flag !== false : false;
        if (existing) unit.databaseSha256 = rowHash(table, existing, existingActive);
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
          items.push({ table, unit: { dataset: dataset.name, key, outcome: 'absent' }, active: false });
          continue;
        }
        const unit: UnitPlan = {
          dataset: dataset.name,
          key,
          outcome: 'new_version',
          retires: true,
          fileSha256: rowHash(table, row, false),
          databaseSha256: rowHash(table, row, true),
        };
        const ledger = planLedgerVersions(heads.get(key), unit.databaseSha256);
        items.push({ table, unit, cells: row, active: false, databaseCells: row, ledger });
      }
    }

    // INFORMATION, never a refusal (Overwatch, PR #1894): how many rows this
    // load carries with no labels at all, so the approver sees what the
    // snapshot is missing. A link's provenance is its backbone_version.
    const warnings: Warning[] = [];
    const unlabelled: [Table, string, (cells: Record<string, CellInput>) => boolean][] = [
      [TABLES[0], 'stages carry no field_labels', (cells) => !cells.field_labels],
      [TABLES[2], 'defaults carry no sources', (cells) => !cells.sources || (Array.isArray(cells.sources) && cells.sources.length === 0)],
    ];
    for (const [table, what, bare] of unlabelled) {
      const carried = items.filter((item) => item.table === table && item.active && item.cells && item.unit.outcome !== 'reject');
      const count = carried.filter((item) => bare(item.cells as Record<string, CellInput>)).length;
      if (count > 0) {
        warnings.push({
          code: 'unlabelled_catalog_rows',
          file: present(table)?.path,
          count,
          message: `${count} of ${carried.length} ${what}; they load without them (information only).`,
        });
      }
    }

    for (const item of items) {
      if (item.ledger) {
        if (item.ledger.fromVersion !== undefined) item.unit.fromVersion = item.ledger.fromVersion;
        item.unit.toVersion = item.ledger.toVersion;
        if (item.ledger.recordBefore) item.unit.recordsBefore = true;
      }
    }
    return { dataset: dataset.name, units: items.map((item) => item.unit), findings, warnings, state: { items } satisfies State };
  },

  async apply(ctx, plan, write): Promise<DatasetWriteResult> {
    const { items } = plan.state as State;
    const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
    const record = async (table: Table, key: string, version: number, content: Record<string, string>, sha: string) => {
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

    // TABLES order: stages before the links and defaults that name them.
    for (const table of TABLES) {
      const columns = written(table);
      const keyColumns = table.spec.key;
      for (const item of items) {
        const { unit, cells, ledger } = item;
        if (item.table !== table || (unit.outcome !== 'new' && unit.outcome !== 'new_version')) continue;
        if (!cells || !ledger || !unit.fileSha256) throw new Error(`content-import: pathway catalog ${unit.key} was planned without its content`);
        const value = (column: ColumnSpec) =>
          databaseValue(column, normalizeCell(Array.isArray(cells[column.name]) ? (cells[column.name] as string[]).join(column.list ?? '|') : cells[column.name] === null || cells[column.name] === undefined ? '' : String(cells[column.name])));

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
            throw new Error(`content-import: pathway catalog ${unit.key} was planned as a revision without its database content`);
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
    return result;
  },
};
