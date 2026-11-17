import type { DbClient } from '../actor';
import type { CellInput } from '../canonical';
import { datasetSpec } from '../specs';
import { ANCHOR_SPECS_FILE, CRITERIA_FILE, GATES_FILE } from '../specs/assessmentCatalog';
import {
  PATHWAY_DEFAULTS_FILE,
  PATHWAY_LINKS_FILE,
  PATHWAY_STAGES_FILE,
  pathwayStageReferenceFindings,
} from '../specs/pathwayCatalog';
import { type FileSpec, type Finding, type ParsedFile, type ParsedPackage, STAGE_KEYS, type Warning } from '../types';
import { splitList } from '../values';
import {
  applySnapshotTables,
  finishSnapshotUnits,
  lockSnapshotTables,
  planSnapshotTables,
  readSnapshotTables,
  type SnapshotItem,
  type SnapshotTable,
} from './catalogSnapshot';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult } from './index';

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
// The snapshot mechanics live in catalogSnapshot.ts (shared with the
// assessment catalog, lane CAT-b); what is pathway-specific stays here.
//
// NOTHING HERE PLACES ANYONE. The catalog describes; no reader computes or
// restricts a stage from it.

const dataset = datasetSpec('pathway-catalog');
const specOf = (file: string) => dataset.files.find((spec) => spec.file === file) as FileSpec;

/** Columns that hold JSON in the tables (jsonb): compared, and handed to withStoredLabels, as text. */
const JSON_CONTENT = new Set(['phases', 'field_labels', 'evidence']);

const TABLES: readonly SnapshotTable[] = [
  { spec: specOf(PATHWAY_STAGES_FILE), table: 'pathway_stages', ledgerDataset: 'pathway_stages', itemKey: (row) => String(row.stage_key), jsonColumns: JSON_CONTENT },
  {
    spec: specOf(PATHWAY_LINKS_FILE),
    table: 'pathway_stage_links',
    ledgerDataset: 'pathway_stage_links',
    itemKey: (row) => `${String(row.from_stage_key)}>${String(row.to_stage_key)}`,
    jsonColumns: JSON_CONTENT,
  },
  {
    spec: specOf(PATHWAY_DEFAULTS_FILE),
    table: 'pathway_stage_defaults',
    ledgerDataset: 'pathway_stage_defaults',
    itemKey: (row) => String(row.default_id),
    jsonColumns: JSON_CONTENT,
  },
];

interface State {
  items: SnapshotItem[];
}

async function tablesExist(client: DbClient): Promise<boolean> {
  const { rows } = await client.query<{ ready: boolean }>(`select to_regclass('pilot.pathway_stages') is not null as ready`);
  return rows[0]?.ready === true;
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
    await lockSnapshotTables(ctx, TABLES);
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
    const present = (table: SnapshotTable) => input.files.find((file) => file.spec === table.spec);
    const database = await readSnapshotTables(ctx, TABLES);

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
      // The assessment catalog's loaded rows that name a stage (lane CAT-b): a
      // stage file may not retire a stage one of them still names, unless the
      // package carries that catalog file too (its own engine checks it).
      const named: [string, string, string, string][] = [
        ['pathway_gates', 'gate_id', 'stage_key', GATES_FILE],
        ['pathway_gate_criteria', 'criterion_id', 'ref_stage_key', CRITERIA_FILE],
        ['scorecard_anchor_clip_specs', 'anchor_spec_id', 'used_by_stage_keys', ANCHOR_SPECS_FILE],
      ];
      for (const [catalogTable, keyColumn, stageColumn, file] of named) {
        if (input.all?.some((candidate) => candidate.spec.file === file)) continue;
        const ready = await ctx.client.query<{ ready: boolean }>(`select to_regclass('pilot.${catalogTable}') is not null as ready`);
        if (ready.rows[0]?.ready !== true) continue;
        const { rows } = await ctx.client.query<{ key: string; named: string | string[] | null }>(
          `select ${keyColumn} as key, ${stageColumn} as named from pilot.${catalogTable} where organization_id = $1 and active_flag`,
          [ctx.organizationId],
        );
        for (const row of rows) {
          for (const end of Array.isArray(row.named) ? row.named : [row.named]) {
            if (end && !kept.has(end)) {
              findings.push({
                code: 'orphan_reference',
                file: present(stagesTable)?.path ?? PATHWAY_STAGES_FILE,
                key: row.key,
                message: `this file would retire stage '${end}', but the loaded ${catalogTable} row ${row.key} still names it; carry ${file} too, or keep the stage`,
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

    const items = await planSnapshotTables(ctx, input, TABLES, database, findings);

    // INFORMATION, never a refusal (Overwatch, PR #1894): how many rows this
    // load carries with no labels at all, so the approver sees what the
    // snapshot is missing. A link's provenance is its backbone_version.
    const warnings: Warning[] = [];
    const unlabelled: [SnapshotTable, string, (cells: Record<string, CellInput>) => boolean][] = [
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

    finishSnapshotUnits(items);
    return { dataset: dataset.name, units: items.map((item) => item.unit), findings, warnings, state: { items } satisfies State };
  },

  async apply(ctx, plan, write): Promise<DatasetWriteResult> {
    const { items } = plan.state as State;
    const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
    // TABLES order: stages before the links and defaults that name them.
    await applySnapshotTables(ctx, TABLES, items, write, result, 'pathway catalog');
    return result;
  },
};
