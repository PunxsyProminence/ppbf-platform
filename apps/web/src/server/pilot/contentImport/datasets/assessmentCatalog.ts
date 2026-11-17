import type { DbClient } from '../actor';
import { type CellInput, canonicalRow, sha256Hex } from '../canonical';
import { datasetSpec } from '../specs';
import {
  ANCHOR_SPECS_FILE,
  assessmentCatalogReferenceFindings,
  CAPS_FILE,
  CATALOG_REFERENCES,
  CRITERIA_FILE,
  GATES_FILE,
  ITEMS_FILE,
  KPI_LISTS_FILE,
  KPIS_FILE,
  SCALES_FILE,
} from '../specs/assessmentCatalog';
import { ASSESSMENT_PROTOCOLS_FILE } from '../specs/assessmentProtocols';
import type { ColumnSpec, FileSpec, Finding, ParsedFile, RowValues, Warning } from '../types';
import { normalizeCell, splitList } from '../values';
import {
  applySnapshotTables,
  cellText,
  databaseValue,
  finishSnapshotUnits,
  lockSnapshotTables,
  normalizedRow,
  planSnapshotTables,
  readSnapshotTables,
  type SnapshotItem,
  type SnapshotTable,
  writtenColumns,
} from './catalogSnapshot';
import { withStoredLabels } from './contentLabels';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, EngineContext, UnitPlan } from './index';

// THE ASSESSMENT CATALOG ENGINE (specs/assessmentCatalog.ts; assessment_catalog
// migration; lane CAT-b).
//
// EIGHT CATALOG TABLES, each file a whole snapshot (catalogSnapshot.ts, the
// pathway catalog's pattern): new, unchanged, revised in place with the history
// ledger, retired when a file leaves a row out, never deleted.
//
// THE PROTOCOLS ARE VERSIONED ROWS, NOT A SNAPSHOT (R2; the table's key is
// organization_id, protocol_id, protocol_version). A protocol the file carries
// is new (version 1), unchanged, or a new version (the next protocol_version
// inserted, the earlier one kept and set inactive, so a recorded result keeps
// pointing at the version it was taken with). A protocol the organization
// holds that the file leaves out is LEFT ALONE, and the plan says which
// (protocols_left_alone). A protocol whose name another active protocol
// already holds is refused by name. Every one of these shows in the dry-run
// plan before anything is written (Overwatch's CAT-b guard). The table keeps
// its own versions, so protocols write no history-ledger rows; the plan's
// "history" numbers for a protocol are its protocol_version.
//
// NOTHING HERE PLACES ANYONE. Gates inform; the cap is data.

const dataset = datasetSpec('assessment-catalog');
const specOf = (file: string) => dataset.files.find((spec) => spec.file === file) as FileSpec;

const JSON_CONTENT = new Set(['field_labels', 'evidence', 'level_anchors']);

const table = (file: string, name: string, keyColumn: string): SnapshotTable => ({
  spec: specOf(file),
  table: name,
  ledgerDataset: name,
  itemKey: (row) => String(row[keyColumn]),
  jsonColumns: JSON_CONTENT,
});

/** Apply order: a table before the tables that name it. */
const TABLES: readonly SnapshotTable[] = [
  table(SCALES_FILE, 'scorecard_scales', 'scale_key'),
  table(CAPS_FILE, 'scorecard_score_caps', 'cap_key'),
  table(ITEMS_FILE, 'scorecard_items', 'scorecard_item_id'),
  table(GATES_FILE, 'pathway_gates', 'gate_id'),
  table(CRITERIA_FILE, 'pathway_gate_criteria', 'criterion_id'),
  table(ANCHOR_SPECS_FILE, 'scorecard_anchor_clip_specs', 'anchor_spec_id'),
  table(KPI_LISTS_FILE, 'behavior_kpi_lists', 'list_key'),
  table(KPIS_FILE, 'behavior_kpis', 'kpi_id'),
];
const byFile = new Map(TABLES.map((entry) => [entry.spec.file, entry]));

const PROTOCOLS = specOf(ASSESSMENT_PROTOCOLS_FILE);
const PROTOCOL_JSON = new Set(['field_labels', 'evidence']);
/** NOT NULL text columns of pilot.assessment_protocols: a blank cell is written as its default, or '' (CAT ruling Q1). */
const PROTOCOL_NOT_NULL_TEXT = new Set([
  'name', 'quality_measured', 'protocol_summary', 'equipment_needed', 'retest_interval_basis',
  'reliability_status', 'validity_status', 'evidence_class', 'boxing_specific',
]);

interface ProtocolItem {
  unit: UnitPlan;
  cells?: Record<string, CellInput>;
  /** The version written: 1 for a new protocol, the next for a revision. */
  version?: number;
  /** The version a revision sets inactive. */
  supersedes?: number;
}

interface State {
  items: SnapshotItem[];
  protocols: ProtocolItem[];
}

async function tablesReady(client: DbClient): Promise<boolean> {
  const { rows } = await client.query<{ ready: boolean }>(
    `select to_regclass('pilot.pathway_gates') is not null
        and exists (select 1 from information_schema.columns
                     where table_schema = 'pilot' and table_name = 'assessment_protocols' and column_name = 'field_labels') as ready`,
  );
  return rows[0]?.ready === true;
}

function protocolHash(row: Readonly<Record<string, CellInput>>): string {
  return sha256Hex(JSON.stringify([ASSESSMENT_PROTOCOLS_FILE, canonicalRow(PROTOCOLS, row)]));
}

const PROTOCOL_TABLE: SnapshotTable = { spec: PROTOCOLS, table: 'assessment_protocols', ledgerDataset: '', itemKey: (row) => String(row.protocol_id), jsonColumns: PROTOCOL_JSON };

/** A protocol row, either side, with its JSON columns in one canonical form. */
function protocolRow(row: Readonly<Record<string, unknown>>): Record<string, CellInput> {
  return normalizedRow(PROTOCOL_TABLE, row);
}

/** Database rows as validated text, for the reference checks. */
function asValues(row: Readonly<Record<string, CellInput>>): RowValues {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(row)) {
    out[name] = Array.isArray(value) ? value.join('|') : value === null || value === undefined ? '' : String(value);
  }
  return out;
}

async function protocolRows(ctx: EngineContext): Promise<Record<string, CellInput>[]> {
  const { rows } = await ctx.client.query<Record<string, unknown>>(
    'select * from pilot.assessment_protocols where organization_id = $1 order by protocol_id, protocol_version',
    [ctx.organizationId],
  );
  return rows.map(protocolRow);
}

async function keptStageKeys(ctx: EngineContext): Promise<Set<string>> {
  const { rows } = await ctx.client.query<{ stage_key: string }>('select stage_key from pilot.pathway_stages where organization_id = $1', [ctx.organizationId]);
  return new Set(rows.map((row) => row.stage_key));
}

function protocolValue(column: ColumnSpec, cells: Readonly<Record<string, CellInput>>): unknown {
  const text = cellText(column, cells[column.name]);
  if (!text && column.blankDefault === undefined && PROTOCOL_NOT_NULL_TEXT.has(column.name)) return '';
  return databaseValue(column, text);
}

const findingKey = (finding: Finding) => JSON.stringify([finding.code, finding.file, finding.line ?? null, finding.column ?? null, finding.message]);

export const ASSESSMENT_CATALOG_ENGINE: DatasetEngine = {
  spec: dataset,

  async readBaseline(): Promise<ParsedFile[]> {
    return [];
  },

  async lockKeys(ctx): Promise<void> {
    if (!(await tablesReady(ctx.client))) return;
    await ctx.client.query('select 1 from pilot.assessment_protocols where organization_id = $1 order by 1 for update', [ctx.organizationId]);
    await lockSnapshotTables(ctx, TABLES);
  },

  async plan(ctx, input): Promise<DatasetPlan> {
    if (!(await tablesReady(ctx.client))) {
      return {
        dataset: dataset.name,
        units: [],
        state: { items: [], protocols: [] } satisfies State,
        findings: input.files.map((file) => ({
          code: 'dataset_not_loadable',
          file: file.path,
          message: 'the assessment catalog tables do not exist in this database; apply the assessment-catalog migration first.',
        })),
      };
    }

    const present = (name: string) => input.files.find((file) => file.spec.file === name);
    const database = await readSnapshotTables(ctx, TABLES);
    const protocols = await protocolRows(ctx);
    const latest = new Map<string, Record<string, CellInput>>();
    for (const row of protocols) latest.set(String(row.protocol_id), row);
    const stages = await keptStageKeys(ctx);

    // References whose target the package leaves out, against what the
    // organization holds (active rows; a protocol's latest version). Those the
    // package carries were checked offline (validate.ts) and are not repeated.
    const lookup = (file: string, key: string): RowValues | undefined => {
      if (file === ASSESSMENT_PROTOCOLS_FILE) {
        const row = latest.get(key);
        return row && row.active !== false ? asValues(row) : undefined;
      }
      const target = byFile.get(file);
      const row = target ? database.get(target)?.get(key) : undefined;
      return row && row.active_flag !== false ? asValues(row) : undefined;
    };
    const offline = new Set(input.validation.blocking.map(findingKey));
    const findings: Finding[] = assessmentCatalogReferenceFindings({ files: [...input.files] }, {
      lookup,
      stageKnown: (key) => stages.has(key),
      where: "this organization's assessment catalog and pathway stages",
    }).filter((finding) => !offline.has(findingKey(finding)));

    // A file that retires a row a LOADED row of a file the package leaves out
    // still names: refused, as the pathway catalog refuses a stage file that
    // would orphan a loaded link.
    for (const reference of CATALOG_REFERENCES) {
      const target = present(reference.to);
      if (!target || present(reference.from) || reference.to === ASSESSMENT_PROTOCOLS_FILE) continue;
      const kept = new Set(target.rows.map((row) => byFile.get(reference.to)?.itemKey(row.values)));
      const from = byFile.get(reference.from);
      for (const [key, row] of (from ? database.get(from) : undefined) ?? []) {
        if (row.active_flag === false) continue;
        const named = reference.list ? splitList(asValues(row)[reference.column] ?? '', '|') : [asValues(row)[reference.column]].filter(Boolean);
        for (const value of named) {
          if (kept.has(value)) continue;
          findings.push({
            code: 'orphan_reference',
            file: target.path,
            key,
            message: `this file would retire ${reference.what} '${value}', but the loaded ${from?.table} row ${key} still names it; carry ${reference.from} too, or keep the ${reference.what}`,
          });
        }
      }
    }

    const items = await planSnapshotTables(ctx, input, TABLES, database, findings);
    finishSnapshotUnits(items);

    // The protocols: versioned rows, never retired.
    const protocolItems: ProtocolItem[] = [];
    const warnings: Warning[] = [];
    const file = present(ASSESSMENT_PROTOCOLS_FILE);
    if (file) {
      // A name another active protocol holds: refused by name (pilot_assessment_protocols_one_active_name).
      for (const row of file.rows) {
        const holder = protocols.find((other) => other.active !== false && other.protocol_id !== row.values.protocol_id
          && normalizeCell(String(other.name)) === row.values.name);
        if (holder) {
          findings.push({
            code: 'duplicate_value',
            file: file.path,
            line: row.line,
            column: 'name',
            message: `another active protocol, ${String(holder.protocol_id)} v${String(holder.protocol_version)}, already has the name '${row.values.name}'`,
          });
        }
      }
      const fileFindings = [...input.validation.blocking, ...findings].filter((finding) => finding.file === file.path);
      const wholeFile = fileFindings.filter((finding) => finding.line === undefined || finding.line <= 1).map((finding) => finding.message);
      const carried = new Set<string>();
      for (const row of file.rows) {
        const key = row.values.protocol_id;
        carried.add(key);
        const existing = latest.get(key);
        const cells = protocolRow(withStoredLabels(file.header, row.values, existing));
        const unit: UnitPlan = { dataset: dataset.name, key, outcome: 'reject', fileSha256: protocolHash(cells) };
        if (existing) unit.databaseSha256 = protocolHash(existing);
        const reasons = [...wholeFile, ...fileFindings.filter((finding) => finding.line === row.line).map((finding) => finding.message)];
        const item: ProtocolItem = { unit, cells };
        if (reasons.length > 0) {
          unit.reasons = reasons;
        } else if (!existing) {
          unit.outcome = 'new';
          unit.toVersion = 1;
          item.version = 1;
        } else if (unit.fileSha256 === unit.databaseSha256 && existing.active !== false) {
          unit.outcome = 'unchanged';
        } else {
          unit.outcome = 'new_version';
          unit.fromVersion = Number(existing.protocol_version);
          unit.toVersion = Number(existing.protocol_version) + 1;
          item.version = unit.toVersion;
          item.supersedes = unit.fromVersion;
        }
        protocolItems.push(item);
      }
      const left = [...latest.keys()].filter((key) => !carried.has(key) && latest.get(key)?.active !== false);
      if (left.length > 0) {
        warnings.push({
          code: 'protocols_left_alone',
          file: file.path,
          count: left.length,
          samples: left.slice(0, 10),
          message: `${left.length} protocol(s) this organization holds are not in this file and are left as they are: ${left.join(', ')} (information only).`,
        });
      }
    }

    return {
      dataset: dataset.name,
      units: [...protocolItems.map((item) => item.unit), ...items.map((item) => item.unit)],
      findings,
      warnings,
      state: { items, protocols: protocolItems } satisfies State,
    };
  },

  async apply(ctx, plan, write): Promise<DatasetWriteResult> {
    const { items, protocols } = plan.state as State;
    const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
    const columns = writtenColumns(PROTOCOLS);

    for (const item of protocols) {
      const { unit, cells, version } = item;
      if (unit.outcome !== 'new' && unit.outcome !== 'new_version') continue;
      if (!cells || version === undefined) throw new Error(`content-import: protocol ${unit.key} was planned without its content`);
      if (item.supersedes !== undefined) {
        const retired = await ctx.client.query(
          `update pilot.assessment_protocols set active = false, updated_at = now()
            where organization_id = $1 and protocol_id = $2 and protocol_version = $3`,
          [ctx.organizationId, unit.key, item.supersedes],
        );
        if (retired.rowCount !== 1) throw new Error(`content-import: expected to set protocol ${unit.key} v${item.supersedes} inactive, updated ${retired.rowCount}`);
      }
      const names = ['organization_id', ...columns.map((column) => column.name), 'protocol_version', 'active'];
      const params = [ctx.organizationId, ...columns.map((column) => protocolValue(column, cells)), version, true];
      await ctx.client.query(
        `insert into pilot.assessment_protocols (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        params,
      );
      (unit.outcome === 'new' ? result.inserted : result.updated).push(`${unit.key} v${version}`);
    }

    await applySnapshotTables(ctx, TABLES, items, write, result, 'assessment catalog');
    return result;
  },
};
