import type { DbClient } from '../actor';
import { type CellInput, isContentColumn } from '../canonical';
import type { ColumnSpec, DatasetName } from '../types';
import { normalizeCell, splitList } from '../values';
import type { DatasetWriteResult, EngineContext } from './index';

// THE BACKBONE LABELS OF AN ITEM (SCHEMA_PROPOSAL P19, P9; content_labels
// migration). The three label columns of a root file (specs/common.ts
// labelColumns) are stored BESIDE the item, never in its own table:
//   field_labels, evidence -> pilot.content_record_labels, one row per item
//                             VERSION, written with the version it labels
//   stage_keys             -> pilot.content_stage_links, by LINEAGE, so a new
//                             version keeps its links; a dropped link is ended,
//                             never deleted
// Every engine does the same three things with them:
//   1. reads the stored labels of each item's CURRENT version into its
//      database row before hashing it (overlayStoredLabels), so a package that
//      repeats them plans `unchanged`;
//   2. leaves them out of the columns it writes to its own table
//      (isTableContent);
//   3. after writing a version, writes that version's labels and brings the
//      item's current links to the set the package names (writeItemLabels).
// LEFT OUT IS NOT BLANK. A label column missing from the root file's header
// is not stated: the item's stored value stands in for it (withStoredLabels),
// so an older package that repeats a labelled item plans `unchanged`, and one
// that revises it writes the new version WITH its stored labels and leaves its
// links alone. A column present and blank means none. Without this, any
// package written before P19 would strip the labels of every item it revised.
// An item without labels does none of this: canonical.ts leaves blank label
// cells out of the hash, so it plans exactly as it did before P19.

const KIND: Record<DatasetName, string> = {
  // Never written here: the catalog keeps its labels natively (datasets/pathwayCatalog.ts).
  'pathway-catalog': 'pathway_catalog',
  disciplines: 'discipline',
  'competence-levels': 'competence_level',
  'cohort-definitions': 'cohort_definition',
  'drill-library': 'drill',
  'universal-stop-rules': 'universal_stop_rule',
  'workout-templates': 'workout_template',
  'session-scripts': 'session_script',
  'training-tracks': 'training_track',
  'transfer-claims': 'transfer_claim',
  'assessment-protocols': 'assessment_protocol',
};

/** target_kind in both label tables: the item kind a dataset holds. */
export function labelTargetKind(dataset: DatasetName): string {
  return KIND[dataset];
}

/** A content column the item's OWN table holds: the label columns live beside it. */
export function isTableContent(column: ColumnSpec): boolean {
  return isContentColumn(column) && column.role !== 'annotation';
}

async function labelTablesExist(client: DbClient): Promise<boolean> {
  const { rows } = await client.query<{ ready: boolean }>(
    `select to_regclass('pilot.content_record_labels') is not null
        and to_regclass('pilot.content_stage_links') is not null as ready`,
  );
  return rows[0]?.ready === true;
}

const LABEL_COLUMNS = ['field_labels', 'evidence', 'stage_keys'] as const;

/**
 * A package root row with every label column its FILE does not carry (not in
 * `header`) taken from the item's stored labels (`stored`: its database row
 * after overlayStoredLabels; undefined for a new item, which has none).
 */
export function withStoredLabels(
  header: readonly string[],
  values: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, CellInput>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...values };
  for (const name of LABEL_COLUMNS) {
    if (!header.includes(name)) out[name] = text(stored?.[name]);
  }
  return out;
}

export interface LabelHead {
  lineage: string;
  /** The version whose labels are current; undefined when the item has no recorded version. */
  version: number | undefined;
  /** The database row, given the three label cells as the text a package would carry. */
  row: Record<string, CellInput>;
}

/**
 * Puts each item's stored labels into its database row: field_labels and
 * evidence of the CURRENT version as JSON text, and its current stage links
 * as a | list. Without this, an item loaded with labels would read as revised
 * on every later plan. Before the content_labels migration nothing can be
 * stored, so there is nothing to read.
 */
export async function overlayStoredLabels(ctx: EngineContext, dataset: DatasetName, heads: readonly LabelHead[]): Promise<void> {
  if (heads.length === 0 || !(await labelTablesExist(ctx.client))) return;
  const kind = labelTargetKind(dataset);
  const lineages = [...new Set(heads.map((head) => head.lineage))];
  const labels = await ctx.client.query<{ target_lineage_id: string; target_version: number; field_labels: unknown; evidence: unknown }>(
    `select target_lineage_id, target_version, field_labels, evidence from pilot.content_record_labels
      where organization_id = $1 and target_kind = $2 and target_lineage_id = any($3::text[])`,
    [ctx.organizationId, kind, lineages],
  );
  const links = await ctx.client.query<{ target_lineage_id: string; stage_key: string }>(
    `select target_lineage_id, stage_key from pilot.content_stage_links
      where organization_id = $1 and target_kind = $2 and target_lineage_id = any($3::text[]) and superseded_at is null`,
    [ctx.organizationId, kind, lineages],
  );
  const json = (value: unknown) => (value === null || value === undefined ? '' : JSON.stringify(value));
  for (const head of heads) {
    const stored = labels.rows.find((row) => row.target_lineage_id === head.lineage && Number(row.target_version) === head.version);
    if (stored) {
      head.row.field_labels = json(stored.field_labels);
      head.row.evidence = json(stored.evidence);
    }
    const keys = links.rows.filter((row) => row.target_lineage_id === head.lineage).map((row) => row.stage_key).sort();
    if (keys.length > 0) head.row.stage_keys = keys.join('|');
  }
}

export interface LabelledWrite {
  lineage: string;
  /** The version this import wrote. */
  version: number;
  /** The item's root cells as written: package text, or the stored labels carried over. */
  cells: Readonly<Record<string, CellInput>>;
}

function text(value: CellInput): string {
  return normalizeCell(Array.isArray(value) ? value.join('|') : value === null || value === undefined ? '' : String(value));
}

/**
 * Writes the labels of every version this import wrote, and brings each
 * item's current stage links to the set its package row names (blank = none).
 * The rows are listed in `result` (inserted / revised), so a dry run and the
 * audit row show them.
 */
export async function writeItemLabels(
  ctx: EngineContext,
  dataset: DatasetName,
  importId: string,
  writes: readonly LabelledWrite[],
  result: DatasetWriteResult,
): Promise<void> {
  if (writes.length === 0) return;
  const kind = labelTargetKind(dataset);
  const wanted = new Map(writes.map((write) => [write.lineage, new Set(splitList(text(write.cells.stage_keys), '|'))]));
  const labelled = writes.filter((write) => text(write.cells.field_labels) || text(write.cells.evidence));

  if (!(await labelTablesExist(ctx.client))) {
    if (labelled.length === 0 && [...wanted.values()].every((keys) => keys.size === 0)) return;
    throw new Error('content-import: this package carries field_labels, evidence or stage_keys, but pilot.content_record_labels does not exist; apply the content-labels migration first');
  }

  for (const write of labelled) {
    await ctx.client.query(
      `insert into pilot.content_record_labels
         (organization_id, target_kind, target_lineage_id, target_version, field_labels, evidence,
          import_id, recorded_by_account_id, recorded_by_role)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        ctx.organizationId, kind, write.lineage, write.version,
        text(write.cells.field_labels) || null, text(write.cells.evidence) || null,
        importId, ctx.actor.accountId, ctx.actor.role,
      ],
    );
    result.inserted.push(`labels ${write.lineage} v${write.version}`);
  }

  const { rows } = await ctx.client.query<{ target_lineage_id: string; stage_key: string }>(
    `select target_lineage_id, stage_key from pilot.content_stage_links
      where organization_id = $1 and target_kind = $2 and target_lineage_id = any($3::text[]) and superseded_at is null
      order by target_lineage_id, stage_key`,
    [ctx.organizationId, kind, [...wanted.keys()]],
  );
  for (const row of rows) {
    if (wanted.get(row.target_lineage_id)?.has(row.stage_key)) continue;
    const ended = await ctx.client.query(
      `update pilot.content_stage_links set superseded_at = now(), superseded_by_import_id = $5
        where organization_id = $1 and target_kind = $2 and target_lineage_id = $3 and stage_key = $4 and superseded_at is null`,
      [ctx.organizationId, kind, row.target_lineage_id, row.stage_key, importId],
    );
    if (ended.rowCount !== 1) throw new Error(`content-import: expected to end 1 stage link ${row.target_lineage_id} ${row.stage_key}, ended ${ended.rowCount}`);
    result.updated.push(`stage link ${row.target_lineage_id} ${row.stage_key} ended`);
  }
  const current = new Set(rows.map((row) => `${row.target_lineage_id}\u0000${row.stage_key}`));
  for (const [lineage, keys] of wanted) {
    for (const key of [...keys].sort()) {
      if (current.has(`${lineage}\u0000${key}`)) continue;
      // role and lane: a package names stage keys only, so neither is stated.
      await ctx.client.query(
        `insert into pilot.content_stage_links
           (organization_id, target_kind, target_lineage_id, stage_key, import_id, recorded_by_account_id, recorded_by_role)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.organizationId, kind, lineage, key, importId, ctx.actor.accountId, ctx.actor.role],
      );
      result.inserted.push(`stage link ${lineage} ${key}`);
    }
  }
}

/**
 * An in-app edit that writes a new version of a labelled item (an edited script
 * that has a run) carries the CURRENT version's field_labels and evidence to the
 * new version, in the caller's transaction; stage links are by lineage and stay.
 * Only when a label row exists for the old version: nothing is invented.
 */
export async function carryLabelsToNewVersion(
  client: DbClient,
  organizationId: string,
  dataset: DatasetName,
  lineageId: string,
  fromVersion: number,
  toVersion: number,
): Promise<boolean> {
  if (!(await labelTablesExist(client))) return false;
  const carried = await client.query(
    `insert into pilot.content_record_labels
       (organization_id, target_kind, target_lineage_id, target_version, field_labels, evidence, backbone_version,
        import_id, recorded_by_account_id, recorded_by_role)
     select organization_id, target_kind, target_lineage_id, $5, field_labels, evidence, backbone_version,
            import_id, recorded_by_account_id, recorded_by_role
       from pilot.content_record_labels
      where organization_id = $1 and target_kind = $2 and target_lineage_id = $3 and target_version = $4`,
    [organizationId, labelTargetKind(dataset), lineageId, fromVersion, toVersion],
  );
  return (carried.rowCount ?? 0) > 0;
}
