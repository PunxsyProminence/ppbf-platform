import { type CellInput, isContentColumn, unitContentHash } from '../canonical';
import { hex14, isNewId } from '../ids';
import { drillLineageHeads } from '../lineage';
import { rootFileSpec } from '../specs';
import type { ColumnSpec, DatasetSpec, FileSpec, Finding, ParsedFile, ParsedRow, RowValues } from '../types';
import { newIdKindOf, type MintedIds, type ValidationResult } from '../validate';
import { integerText, normalizeCell, numberText, parseBoolean, splitList } from '../values';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, EngineContext, UnitPlan } from './index';

// THE VERSIONED UNITS OF IMP-08: a workout template with its items, and a
// session script with its blocks and renderings (R2 for tables that DO hold
// versions: workout_templates_v2 migration :45-49, session_scripts migration
// :30-31, :59).
//
//   unchanged -> nothing is written. A re-import of the committed files must
//                leave every row exactly as it was (the old loaders' ON
//                CONFLICT DO NOTHING got this right: seed-workout-templates.mjs
//                :201, seed-session-scripts.mjs:183).
//   changed   -> a NEW VERSION: v(n+1) under a new id, with every child row
//                re-minted under that id, and the old version kept as it is
//                -- its rows, its children, whatever points at it. Before this
//                engine a revision was skipped without a word (the same DO
//                NOTHING lines).
//   new       -> inserted as v1 under its key.
//   absent    -> a lineage the database holds and the root file does not name
//                is left alone and listed.
//
// ONE UNIT = the root row plus its child rows. A child file replaces a
// parent's rows only when it has at least one row for that parent; a parent
// with no rows in a child file keeps what its current version has (the
// contract's child-replacement rule, canonical.ts datasetUnits). So a package
// holding only seed_workout_template_items.csv still revises the templates it
// names.
//
// A PACKAGE NAMES LINEAGES, NEVER VERSIONS (contract "Identity"). The key of a
// template or script is its lineage key, and so is every drill_id an item or a
// block carries. Consequences:
//   - the content hash compares a stored child's drill by its LINEAGE (a join
//     to drill_library), so a template whose drill merely got a newer version
//     is UNCHANGED -- it keeps the drill version it was built with (the
//     owner-flagged default; the readers report uses_older_drill_version);
//   - a written child row stores the drill lineage's CURRENT head drill_id,
//     resolved at APPLY, after the drill library of the same import has been
//     written (datasets apply in dependency order, datasets/index.ts);
//   - a key that is some later VERSION's id is refused, rather than inserted
//     as a new lineage that collides with the primary key.
//
// NEW VERSION IDS are minted, not random: '<prefix>_' + the first 14 hex of
// sha256(lineage_id + '#v' + n), the formula the plan fixes for drill versions
// (intake plan, architecture section, "IDENTIFIERS"). The same plan re-made
// under lock therefore writes the same ids it showed, and v1 keeps its
// lineage key as its id. Child ids of a version are the ids.ts formulas fed
// the VERSION's id, so a new version's children can never collide with, or
// attach to, an older version's.

// ---------------------------------------------------------------------------
// Configuration: what differs between templates and scripts.

export interface ChildTable {
  spec: FileSpec;
  table: string;
  /** The child's own id column (item_id, block_id, rendering_id). */
  idColumn: string;
  /** The id a child row gets under the version id `parentId` (the ids.ts formula). */
  mintId(parentId: string, row: RowValues): string;
}

/** The current version of a lineage, as stored. */
export interface VersionHead {
  id: string;
  lineageId: string;
  version: number;
  row: Readonly<Record<string, CellInput>>;
}

export interface RootWrite {
  outcome: 'new' | 'new_version';
  /** The version being replaced, for a new_version. */
  head?: VersionHead;
  actorRole: string;
}

export interface VersionedDatasetConfig {
  dataset: DatasetSpec;
  table: string;
  idColumn: string;
  idPrefix: string;
  /**
   * What "current" means (lineage.ts): templates carry superseded_at and one
   * head per lineage by index; a script's current version is its highest.
   */
  head: 'not_superseded' | 'highest_version';
  children: readonly ChildTable[];
  /** Root columns that are lifecycle, not content: excluded from the content hash. */
  lifecycleColumns?: readonly string[];
  /** Only rows for which this holds occupy their name (a partial unique index); undefined = every row. */
  holdsName?(row: Readonly<Record<string, CellInput>>): boolean;
  /**
   * Values for tool-decided root columns, and any column whose written value
   * is not simply the file's. Applied over the content values.
   */
  rootOverrides(write: RootWrite): Record<string, unknown>;
  /**
   * Take the old head out of "current" BEFORE its successor is inserted.
   * Templates need it (the one-head-per-lineage and one-active-name indexes
   * refuse the other order); scripts supersede by existing, so they omit it.
   */
  supersede?(ctx: EngineContext, head: VersionHead): Promise<void>;
}

/** A dataset's child file by name; a renamed file fails at import time, not mid-load. */
export function childFile(dataset: DatasetSpec, file: string): FileSpec {
  const found = dataset.files.find((spec) => spec.file === file && spec.parent);
  if (!found) throw new Error(`content-import: ${dataset.name} has no child file ${file}`);
  return found;
}

export function versionId(prefix: string, lineageId: string, version: number): string {
  return `${prefix}_${hex14(`${lineageId}#v${version}`)}`;
}

// ---------------------------------------------------------------------------
// Database <-> cell text (the conventions registries.ts uses, for the same
// reasons: one canonical text for file rows and database rows).

interface ColumnInfo {
  nullable: boolean;
}

/** Identifiers come from specs and constants, never input; this keeps it that way. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`content-import: '${name}' is not a plain SQL identifier`);
  return name;
}

function cellText(value: CellInput | Date, column: ColumnSpec | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeCell(String(item))).join(column?.list ?? '|');
  return normalizeCell(String(value));
}

/**
 * The value written for a cell. A blank means the column's blankDefault, and
 * otherwise NULL -- or '' for a NOT NULL text column such as
 * session_scripts.theme, whose old loader wrote '' (seed-session-scripts.mjs
 * `record.theme || ''`). Nullability is read from the live table.
 */
function databaseValue(column: ColumnSpec, value: string, info: ColumnInfo): unknown {
  const text = value || column.blankDefault || '';
  if (!text) return info.nullable || column.type !== 'text' ? null : '';
  switch (column.type) {
    case 'boolean':
      return parseBoolean(text);
    case 'integer':
      return Number(integerText(text));
    case 'number':
      return Number(numberText(text));
    default:
      return column.list ? splitList(text, column.list).join(column.list) : text;
  }
}

/** A package row with every new:<short-name> it carries replaced by the id minted for it. */
function resolvedCells(spec: FileSpec, values: RowValues, minted: MintedIds): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const column of spec.columns) {
    const value = values[column.name] ?? '';
    const kind = value && isNewId(value) ? newIdKindOf(spec, column) : undefined;
    cells[column.name] = (kind && minted.get(kind)?.get(value)) || value;
  }
  return cells;
}

function withoutColumns(dataset: DatasetSpec, names: readonly string[]): DatasetSpec {
  if (names.length === 0) return dataset;
  return {
    ...dataset,
    files: dataset.files.map((file) => (file.parent ? file : { ...file, columns: file.columns.filter((column) => !names.includes(column.name)) })),
  };
}

// ---------------------------------------------------------------------------

type Cells = Record<string, string>;

interface VersionedItem {
  unit: UnitPlan;
  /** The unit as it would be written: root cells and child cells per child file. */
  root?: Cells;
  children?: Map<FileSpec, Cells[]>;
  head?: VersionHead;
}

interface VersionedState {
  items: VersionedItem[];
  columns: Map<string, Map<string, ColumnInfo>>;
}

export function versionedDatasetEngine(config: VersionedDatasetConfig): DatasetEngine {
  const rootSpec = rootFileSpec(config.dataset);
  const table = `pilot.${ident(config.table)}`;
  const idColumn = ident(config.idColumn);
  const hashDataset = withoutColumns(config.dataset, config.lifecycleColumns ?? []);
  const childByFile = new Map(config.children.map((child) => [child.spec, child]));
  for (const file of config.dataset.files) {
    if (file.parent && !childByFile.has(file)) throw new Error(`content-import: ${file.file} has no child table configured`);
  }
  const drillColumnOf = (spec: FileSpec) => spec.columns.find((column) => column.references === 'drill' && column.role === 'reference');
  const headFilter = config.head === 'not_superseded' ? 'and superseded_at is null' : '';

  async function columnInfo(ctx: EngineContext): Promise<Map<string, Map<string, ColumnInfo>>> {
    const tables = [config.table, ...config.children.map((child) => child.table)];
    const { rows } = await ctx.client.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable
         from information_schema.columns
        where table_schema = 'pilot' and table_name = any($1::text[])`,
      [tables],
    );
    const info = new Map<string, Map<string, ColumnInfo>>(tables.map((name) => [name, new Map()]));
    for (const row of rows) info.get(row.table_name)?.set(row.column_name, { nullable: row.is_nullable === 'YES' });
    // The spec and the tables must agree on every column written; a column
    // the table lacks would otherwise fail mid-load.
    const check = (name: string, columns: readonly string[]) => {
      const missing = columns.filter((column) => !info.get(name)?.has(column));
      if (missing.length > 0) throw new Error(`content-import: pilot.${name} has no column(s) ${missing.join(', ')} that the ${config.dataset.name} engine writes`);
    };
    check(config.table, [idColumn, 'lineage_id', 'version', 'created_by_account_id', ...rootSpec.columns.filter(isContentColumn).map((c) => c.name)]);
    for (const child of config.children) {
      check(child.table, [child.idColumn, child.spec.parent?.column ?? '', ...child.spec.columns.filter(isContentColumn).map((c) => c.name)]);
    }
    return info;
  }

  async function readHeads(ctx: EngineContext): Promise<Map<string, VersionHead>> {
    const sql = config.head === 'not_superseded'
      ? `select * from ${table} where organization_id = $1 and superseded_at is null`
      : `select distinct on (lineage_id) * from ${table} where organization_id = $1 order by lineage_id, version desc`;
    const { rows } = await ctx.client.query<Record<string, CellInput>>(sql, [ctx.organizationId]);
    return new Map(
      rows.map((row) => [
        String(row.lineage_id),
        { id: String(row[idColumn]), lineageId: String(row.lineage_id), version: Number(row.version), row },
      ]),
    );
  }

  /** Keys that are a stored VERSION's id but not a lineage key: a package must name the lineage. */
  async function versionsNamed(ctx: EngineContext, keys: readonly string[]): Promise<Map<string, { lineageId: string; version: number }>> {
    const candidates = keys.filter((key) => key && !isNewId(key));
    if (candidates.length === 0) return new Map();
    const { rows } = await ctx.client.query<{ id: string; lineage_id: string; version: number }>(
      `select ${idColumn} as id, lineage_id, version from ${table}
        where organization_id = $1 and ${idColumn} = any($2::text[]) and ${idColumn} <> lineage_id`,
      [ctx.organizationId, candidates],
    );
    return new Map(rows.map((row) => [row.id, { lineageId: row.lineage_id, version: Number(row.version) }]));
  }

  async function maxVersions(ctx: EngineContext, lineages: readonly string[]): Promise<Map<string, number>> {
    if (lineages.length === 0) return new Map();
    const { rows } = await ctx.client.query<{ lineage_id: string; max_version: number }>(
      `select lineage_id, max(version)::int as max_version from ${table}
        where organization_id = $1 and lineage_id = any($2::text[])
        group by lineage_id`,
      [ctx.organizationId, [...lineages]],
    );
    return new Map(rows.map((row) => [row.lineage_id, Number(row.max_version)]));
  }

  /** Child rows of the given version ids, as cells, with a stored drill_id replaced by its drill's LINEAGE key. */
  async function readChildren(ctx: EngineContext, versionIds: readonly string[]): Promise<Map<FileSpec, Map<string, Cells[]>>> {
    const out = new Map<FileSpec, Map<string, Cells[]>>();
    for (const child of config.children) {
      const byParent = new Map<string, Cells[]>();
      out.set(child.spec, byParent);
      if (versionIds.length === 0) continue;
      const parentColumn = ident(child.spec.parent?.column ?? '');
      const drill = drillColumnOf(child.spec);
      const drillColumn = drill ? ident(drill.name) : undefined;
      const { rows } = await ctx.client.query<Record<string, CellInput>>(
        drillColumn
          ? `select c.*, d.lineage_id as content_import_drill_lineage
               from pilot.${ident(child.table)} c
               left join pilot.drill_library d on d.organization_id = c.organization_id and d.drill_id = c.${drillColumn}
              where c.organization_id = $1 and c.${parentColumn} = any($2::text[])`
          : `select c.* from pilot.${ident(child.table)} c where c.organization_id = $1 and c.${parentColumn} = any($2::text[])`,
        [ctx.organizationId, [...versionIds]],
      );
      for (const row of rows) {
        const cells: Cells = {};
        for (const column of child.spec.columns) cells[column.name] = column.role === 'placeholder' ? '' : cellText(row[column.name], column);
        if (drillColumn && row.content_import_drill_lineage) cells[drillColumn] = String(row.content_import_drill_lineage);
        const parent = String(row[parentColumn]);
        byParent.set(parent, [...(byParent.get(parent) ?? []), cells]);
      }
    }
    return out;
  }

  function rootCells(row: Readonly<Record<string, CellInput>>): Cells {
    const cells: Cells = {};
    for (const column of rootSpec.columns) cells[column.name] = column.role === 'placeholder' ? '' : cellText(row[column.name], column);
    return cells;
  }

  function unitHash(root: Cells, children: Map<FileSpec, Cells[]>): string {
    return unitContentHash(hashDataset, {
      root,
      children: Object.fromEntries(config.children.map((child) => [child.spec.file, children.get(child.spec) ?? []])),
    });
  }

  return {
    spec: config.dataset,

    async readBaseline(ctx): Promise<ParsedFile[]> {
      // The CURRENT version of every lineage, under its LINEAGE key: that is
      // what a package names, so it is what uniqueness and minted-id
      // collisions are judged against.
      const heads = await readHeads(ctx);
      const rows: ParsedRow[] = [...heads.values()].map((head) => {
        const values = rootCells(head.row);
        values[rootSpec.key[0]] = head.lineageId;
        // A row that does not hold its name under the partial unique index
        // (a withdrawn template: pilot_workout_templates_one_active_name is
        // `where active`) must not make a new template's name look taken.
        if (config.holdsName && rootSpec.nameColumn && !config.holdsName(head.row)) values[rootSpec.nameColumn] = '';
        return { line: 0, raw: { ...values }, values };
      });
      return [{ path: `database:${table}`, spec: rootSpec, header: rootSpec.columns.map((column) => column.name), rows }];
    },

    async lockKeys(ctx, keys): Promise<void> {
      const existing = keys.filter((key) => key && !isNewId(key));
      if (existing.length === 0) return;
      await ctx.client.query(
        `select 1 from ${table}
          where organization_id = $1 and lineage_id = any($2::text[]) ${headFilter}
          order by ${idColumn}
          for update`,
        [ctx.organizationId, [...existing].sort()],
      );
    },

    async plan(ctx, input: { files: readonly ParsedFile[]; validation: ValidationResult }): Promise<DatasetPlan> {
      const { minted } = input.validation;
      const columns = await columnInfo(ctx);
      const rootFile = input.files.find((file) => file.spec === rootSpec);
      const childFiles = config.children
        .map((child) => input.files.find((file) => file.spec === child.spec))
        .filter((file): file is ParsedFile => file !== undefined);
      if (!rootFile && childFiles.length === 0) {
        return { dataset: config.dataset.name, units: [], findings: [], state: { items: [], columns } satisfies VersionedState };
      }

      // Blocking findings, located. A header problem or an unreadable file
      // makes every row of that file suspect, so it rejects every unit.
      const present = new Set([rootFile, ...childFiles].filter(Boolean).map((file) => (file as ParsedFile).path));
      const fileFindings = input.validation.blocking.filter((finding) => present.has(finding.file));
      const wholeFile = fileFindings.filter((finding) => finding.line === undefined || finding.line <= 1).map((finding) => finding.message);
      const byLine = new Map<string, string[]>();
      for (const finding of fileFindings) {
        if (finding.line === undefined || finding.line <= 1) continue;
        const at = `${finding.file}\u0000${finding.line}`;
        byLine.set(at, [...(byLine.get(at) ?? []), finding.message]);
      }
      const rowReasons = (file: ParsedFile, row: ParsedRow) => byLine.get(`${file.path}\u0000${row.line}`) ?? [];

      // The package, resolved: keys in file order, then parents named only by child rows.
      const keys: string[] = [];
      const packageKeys = new Map<string, { raw: string; file: string }>();
      const packageRoots = new Map<string, { cells: Cells; reasons: string[] }>();
      const addKey = (key: string, raw: string, file: string) => {
        if (!packageKeys.has(key)) {
          keys.push(key);
          packageKeys.set(key, { raw, file });
        }
      };
      for (const row of rootFile?.rows ?? []) {
        const cells = resolvedCells(rootSpec, row.values, minted);
        const key = cells[rootSpec.key[0]];
        addKey(key, row.values[rootSpec.key[0]], (rootFile as ParsedFile).path);
        packageRoots.set(key, { cells, reasons: rowReasons(rootFile as ParsedFile, row) });
      }
      const packageChildren = new Map<FileSpec, Map<string, Cells[]>>();
      const childReasons = new Map<string, string[]>();
      for (const file of childFiles) {
        const byParent = new Map<string, Cells[]>();
        packageChildren.set(file.spec, byParent);
        const parentColumn = file.spec.parent?.column ?? '';
        for (const row of file.rows) {
          const cells = resolvedCells(file.spec, row.values, minted);
          const parent = cells[parentColumn];
          addKey(parent, row.values[parentColumn], file.path);
          byParent.set(parent, [...(byParent.get(parent) ?? []), cells]);
          childReasons.set(parent, [...(childReasons.get(parent) ?? []), ...rowReasons(file, row)]);
        }
      }

      const heads = await readHeads(ctx);
      const named = await versionsNamed(ctx, keys.filter((key) => !heads.has(key)));
      const versions = await maxVersions(ctx, keys.filter((key) => heads.has(key)));
      const storedChildren = await readChildren(
        ctx,
        keys.map((key) => heads.get(key)?.id).filter((id): id is string => id !== undefined),
      );

      const findings: Finding[] = [];
      const items: VersionedItem[] = [];
      for (const key of keys) {
        const from = packageKeys.get(key) as { raw: string; file: string };
        const unit: UnitPlan = { dataset: config.dataset.name, key, outcome: 'reject' };
        if (from.raw !== key) unit.packageKey = from.raw;
        const head = heads.get(key);
        const packageRoot = packageRoots.get(key);
        const reasons = [...wholeFile, ...(packageRoot?.reasons ?? []), ...(childReasons.get(key) ?? [])];

        const version = named.get(key);
        if (version) {
          const message = `${key} is version ${version.version} of ${version.lineageId}. A package names the lineage: write ${version.lineageId}, and the tool decides the version.`;
          reasons.push(message);
          findings.push({ code: 'bad_id', file: from.file, column: rootSpec.key[0], key, message });
        }

        const root = packageRoot?.cells ?? (head ? rootCells(head.row) : undefined);
        if (!root && reasons.length === 0) {
          // The validator reports a child row whose parent is nowhere as an
          // orphan; this is the backstop if it ever does not.
          reasons.push(`${key} has child rows but is neither in this package nor in the database`);
        }
        const children = new Map<FileSpec, Cells[]>();
        for (const child of config.children) {
          const fromPackage = packageChildren.get(child.spec)?.get(key);
          children.set(child.spec, fromPackage ?? (head ? storedChildren.get(child.spec)?.get(head.id) ?? [] : []));
        }

        if (root) unit.fileSha256 = unitHash(root, children);
        if (head) {
          const storedRoot = rootCells(head.row);
          const stored = new Map(config.children.map((child) => [child.spec, storedChildren.get(child.spec)?.get(head.id) ?? []]));
          unit.databaseSha256 = unitHash(storedRoot, stored);
        }

        if (reasons.length > 0) {
          unit.reasons = reasons;
        } else if (!head) {
          unit.outcome = 'new';
          unit.toVersion = 1;
        } else if (unit.fileSha256 === unit.databaseSha256) {
          unit.outcome = 'unchanged';
        } else {
          unit.outcome = 'new_version';
          unit.fromVersion = head.version;
          unit.toVersion = (versions.get(key) ?? head.version) + 1;
        }
        items.push({ unit, root, children, head });
      }

      // A lineage the database holds that the ROOT file does not name. A
      // package of child rows only is not a statement about which templates
      // exist, so it lists nothing as absent.
      if (rootFile) {
        for (const lineage of heads.keys()) {
          if (packageKeys.has(lineage)) continue;
          items.push({ unit: { dataset: config.dataset.name, key: lineage, outcome: 'absent' } });
        }
      }

      const state: VersionedState = { items, columns };
      return { dataset: config.dataset.name, units: items.map((item) => item.unit), findings, state };
    },

    async apply(ctx, plan): Promise<DatasetWriteResult> {
      const state = plan.state as VersionedState;
      const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
      const writes = state.items.filter((item) => item.unit.outcome === 'new' || item.unit.outcome === 'new_version');
      if (writes.length === 0) return result;
      const info = (tableName: string, column: ColumnSpec) => state.columns.get(tableName)?.get(column.name) as ColumnInfo;

      // Resolved NOW, not at plan: a drill revised or added earlier in this
      // same import is already written, and its new head is what a template
      // or script version written today should run.
      const drillHeads = await drillLineageHeads(ctx.client, ctx.organizationId);
      const headDrill = (lineage: string, where: string) => {
        const head = drillHeads.get(lineage);
        if (!head) throw new Error(`content-import: ${where} names drill ${lineage}, which has no current version in ${ctx.organizationId}`);
        return head.drillId;
      };

      // 1. Every old head out of "current" FIRST, then every insert. The
      //    indexes refuse the other order (one head per lineage; one active
      //    name), and doing all of them first also lets two templates in one
      //    package swap names.
      if (config.supersede) {
        for (const item of writes) {
          if (item.unit.outcome === 'new_version') {
            if (!item.head) throw new Error(`content-import: ${config.dataset.name} ${item.unit.key} was planned as a revision without its current version`);
            await config.supersede(ctx, item.head);
          }
        }
      }

      // 2. Insert v1 of each new lineage and v(n+1) of each revised one, with their children.
      for (const item of writes) {
        const { unit, root, children, head } = item;
        if (!root || !children || unit.toVersion === undefined) {
          throw new Error(`content-import: ${config.dataset.name} ${unit.key} was planned without its content`);
        }
        const isNew = unit.outcome === 'new';
        const id = isNew ? unit.key : versionId(config.idPrefix, unit.key, unit.toVersion);

        const values = new Map<string, unknown>([
          ['organization_id', ctx.organizationId],
          [idColumn, id],
          ['lineage_id', unit.key],
          ['version', unit.toVersion],
          ['created_by_account_id', ctx.actor.accountId],
        ]);
        for (const column of rootSpec.columns.filter(isContentColumn)) {
          values.set(ident(column.name), databaseValue(column, root[column.name] ?? '', info(config.table, column)));
        }
        const overrides = config.rootOverrides({ outcome: isNew ? 'new' : 'new_version', head, actorRole: ctx.actor.role });
        for (const [name, value] of Object.entries(overrides)) values.set(ident(name), value);
        const names = [...values.keys()];
        await ctx.client.query(
          `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          [...values.values()],
        );

        for (const child of config.children) {
          const parentColumn = ident(child.spec.parent?.column ?? '');
          const drill = drillColumnOf(child.spec);
          for (const cells of children.get(child.spec) ?? []) {
            // A new lineage keeps a child id its file gave (the committed
            // files carry them); a new version always re-mints, because an
            // id in the file names a row of an OLDER version.
            const childId = isNew && cells[child.idColumn] ? cells[child.idColumn] : child.mintId(id, cells);
            const row = new Map<string, unknown>([
              ['organization_id', ctx.organizationId],
              [ident(child.idColumn), childId],
              [parentColumn, id],
            ]);
            for (const column of child.spec.columns.filter(isContentColumn)) {
              const cell = cells[column.name] ?? '';
              const value = column === drill && cell ? headDrill(cell, `${config.dataset.name} ${unit.key}`) : cell;
              row.set(ident(column.name), databaseValue(column, value, info(child.table, column)));
            }
            const childNames = [...row.keys()];
            await ctx.client.query(
              `insert into pilot.${ident(child.table)} (${childNames.join(', ')}) values (${childNames.map((_, i) => `$${i + 1}`).join(', ')})`,
              [...row.values()],
            );
          }
        }

        if (isNew) result.inserted.push(unit.key);
        else result.updated.push(`${id} (v${unit.toVersion} of ${unit.key})`);
      }
      return result;
    },
  };
}
