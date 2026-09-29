import { type CellInput, isContentColumn, sha256Hex, unitContentHash } from '../canonical';
import { isNewId, MINT } from '../ids';
import { datasetSpec, rootFileSpec } from '../specs';
import type { FileSpec, Finding, ParsedFile, ParsedRow } from '../types';
import type { ValidationResult } from '../validate';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, EngineContext, UnitPlan } from './index';
import {
  assertColumns,
  insertRows,
  reasonsByItem,
  storedContent,
  type TableColumn,
  tableColumns,
  typedValue,
} from './versioned';

// THE DRILL LIBRARY (R2 for drills; IMP-07 of the intake plan).
//
// THE UNIT. A drill is its pilot.drill_library row PLUS its scale levels, its
// OWN stop rules, its cues, its secondary skills and the transfer claims
// attached to it (decision 9: one rule, history automatic). A change anywhere
// in the unit is a new version of the drill.
//
//   unchanged -> nothing is written. The content hash is canonical.ts's, on
//                both sides, and it RE-SPLITS database list elements on '|':
//                the old loader stored 'A1-001|A2-002' as one element
//                (seed-drill-library.mjs:210-219), and without the re-split
//                every such drill would read as revised the first time.
//   changed   -> v(n+1): the current head gets superseded_at and STAYS
//                active (gyms that adopted it keep it: pilot.drills pins the
//                exact reference version, drill_reference_provenance
//                migration :79-84, and the athlete reads need that row
//                active, drillLibraryV3.ts:726,746,818); the new row gets
//                drill_id MINT.drillVersion(lineage, n+1), the same
//                lineage_id, supersedes_drill_id = the old head, and a
//                re-minted copy of every child row. The old version keeps its
//                own children: nothing new ever attaches to history. A rename
//                is just another change -- the old loader stopped on the
//                primary key instead (its ON CONFLICT arbiter is the name
//                index, seed-drill-library.mjs:245, so a new name with the
//                old id is a 23505).
//   new       -> v1, drill_id = the lineage key (the committed id, or the
//                drl_ formula for a new:<short-name>), children keep the ids
//                the files give them.
//   absent    -> a current drill the package does not name is left alone.
//
// A PACKAGE NAMES A DRILL BY ITS LINEAGE KEY -- the id of its first version --
// in every file (contract "Identity"), so every key here is resolved to the
// lineage's current head (superseded_at is null; exactly one per lineage,
// content-import migration :155-157). A child file replaces a drill's rows in
// that file only when it has at least one row for the drill; otherwise the
// drill keeps what it has (canonical.ts datasetUnits, the same rule).
//
// pilot.drills IS NEVER TOUCHED (OD-2026-09-16-001 clause 5): a gym's adopted
// drill keeps pointing at the version it adopted; moving it to a newer version
// is a coach action (IMP-15), not an import.
//
// TRANSFER CLAIMS are their own dataset (specs/transferClaims.ts) and no
// engine loads that file yet (plan.ts refuses it as dataset_not_loadable), so
// a package cannot change them; a drill's claims are carried to its new
// version with the rest of the unit, and are part of the unit hash.

const DATASET = datasetSpec('drill-library');
const ROOT = rootFileSpec(DATASET);
const TRANSFER = rootFileSpec(datasetSpec('transfer-claims'));

function childSpec(file: string): FileSpec {
  const spec = DATASET.files.find((candidate) => candidate.file === file);
  if (!spec?.parent) throw new Error(`content-import: ${file} is not a child file of the drill library`);
  return spec;
}

interface ChildTable {
  spec: FileSpec;
  table: string;
  /** The row's own id column; secondary skills have none (the relationship is its key). */
  idColumn?: string;
}

const CHILD_TABLES: readonly ChildTable[] = [
  { spec: childSpec('seed_drill_scale_levels.csv'), table: 'drill_scale_levels', idColumn: 'scale_id' },
  { spec: childSpec('seed_drill_stop_rules.csv'), table: 'drill_stop_rules', idColumn: 'stop_rule_id' },
  { spec: childSpec('seed_drill_cues.csv'), table: 'drill_cues', idColumn: 'cue_id' },
  { spec: childSpec('seed_drill_secondary_skills.csv'), table: 'drill_secondary_skills' },
];

// A check, not content: expected_primary_skill_id asserts what the drill's
// primary is (seed-drill-secondary-skills.mjs:186-198 kept it in code for that
// reason) and pilot.drill_secondary_skills has no column for it. Hashing it
// would make every package that carries it read as a revision forever.
const NOT_STORED: ReadonlyMap<FileSpec, ReadonlySet<string>> = new Map([
  [childSpec('seed_drill_secondary_skills.csv'), new Set(['expected_primary_skill_id'])],
]);

// The claim's target is the unit itself, so it is not part of the claim's content.
const TRANSFER_TARGETS = new Set(['drill_id', 'block_id', 'script_id']);

function notStored(spec: FileSpec): ReadonlySet<string> {
  return NOT_STORED.get(spec) ?? new Set();
}

/** The columns a row's content is written to: canonical.ts's content columns, minus the ones not stored. */
function contentColumns(spec: FileSpec, skip: ReadonlySet<string>) {
  return spec.columns.filter((column) => isContentColumn(column) && !skip.has(column.name));
}

// ---------------------------------------------------------------------------

type DbRow = Record<string, CellInput> & Record<string, unknown>;

interface Head {
  drillId: string;
  lineageId: string;
  version: number;
  active: boolean;
  row: DbRow;
}

interface ChildRow {
  /** The row's own id as the package or the database gives it; '' when blank. */
  id: string;
  content: Record<string, string>;
}

interface UnitContentRows {
  root: Record<string, string> | null;
  children: Map<FileSpec, ChildRow[]>;
  transfers: Record<string, string>[];
}

interface DrillItem {
  unit: UnitPlan;
  head?: Head;
  /** What the new row and its children will say (the package over the database, per child file). */
  effective?: UnitContentRows;
  /** The drill_id this plan writes: the lineage key for v1, MINT.drillVersion for a later version. */
  drillId?: string;
  /** Planned child ids, by table. */
  childIds?: Map<string, string[]>;
  transferIds?: string[];
}

interface DrillState {
  items: DrillItem[];
  columns: Map<string, Map<string, TableColumn>>;
}

function unitHash(content: UnitContentRows): string {
  const children: Record<string, Record<string, string>[]> = {};
  for (const [spec, rows] of content.children) children[spec.file] = rows.map((row) => row.content);
  const base = unitContentHash(DATASET, { root: content.root, children });
  if (content.transfers.length === 0) return base;
  // Claims joined in only when there are any, so a drill without claims hashes
  // exactly as canonical.ts hashes the package (UnitPlan.fileSha256).
  return sha256Hex(JSON.stringify([base, content.transfers.map((row) => JSON.stringify(row)).sort()]));
}

function transferContent(row: DbRow): Record<string, string> {
  return storedContent(TRANSFER, row, TRANSFER_TARGETS);
}

async function readHeads(ctx: EngineContext): Promise<Map<string, Head>> {
  const { rows } = await ctx.client.query<DbRow>(
    `select * from pilot.drill_library
      where organization_id = $1 and superseded_at is null
      order by lineage_id`,
    [ctx.organizationId],
  );
  return new Map(
    rows.map((row) => [
      String(row.lineage_id),
      { drillId: String(row.drill_id), lineageId: String(row.lineage_id), version: Number(row.version), active: row.active === true, row },
    ]),
  );
}

/** The heads' own rows in every child table, and their transfer claims, by head drill_id. */
async function readHeadChildren(ctx: EngineContext, headIds: readonly string[]) {
  const children = new Map<FileSpec, Map<string, DbRow[]>>();
  for (const child of CHILD_TABLES) {
    const byDrill = new Map<string, DbRow[]>();
    if (headIds.length > 0) {
      const { rows } = await ctx.client.query<DbRow>(
        `select * from pilot.${child.table} where organization_id = $1 and drill_id = any($2::text[])`,
        [ctx.organizationId, headIds],
      );
      for (const row of rows) byDrill.set(String(row.drill_id), [...(byDrill.get(String(row.drill_id)) ?? []), row]);
    }
    children.set(child.spec, byDrill);
  }
  const transfers = new Map<string, DbRow[]>();
  if (headIds.length > 0) {
    const { rows } = await ctx.client.query<DbRow>(
      `select * from pilot.transfer_claims where organization_id = $1 and drill_id = any($2::text[])`,
      [ctx.organizationId, headIds],
    );
    for (const row of rows) transfers.set(String(row.drill_id), [...(transfers.get(String(row.drill_id)) ?? []), row]);
  }
  return { children, transfers };
}

function databaseUnit(head: Head, children: Map<FileSpec, Map<string, DbRow[]>>, transfers: Map<string, DbRow[]>): UnitContentRows {
  const rows = new Map<FileSpec, ChildRow[]>();
  for (const child of CHILD_TABLES) {
    rows.set(
      child.spec,
      (children.get(child.spec)?.get(head.drillId) ?? []).map((row) => ({
        id: child.idColumn ? String(row[child.idColumn] ?? '') : '',
        content: storedContent(child.spec, row, notStored(child.spec)),
      })),
    );
  }
  return {
    root: storedContent(ROOT, head.row),
    children: rows,
    transfers: (transfers.get(head.drillId) ?? []).map(transferContent),
  };
}

async function columnsByTable(ctx: EngineContext): Promise<Map<string, Map<string, TableColumn>>> {
  const out = new Map<string, Map<string, TableColumn>>();
  const drillColumns = await tableColumns(ctx.client, 'drill_library');
  assertColumns('drill_library', drillColumns, [
    'organization_id', 'drill_id', 'lineage_id', 'version', 'supersedes_drill_id', 'superseded_at', 'active',
    'created_by_account_id', 'created_by_role', 'updated_at',
    ...contentColumns(ROOT, new Set()).map((column) => column.name),
  ]);
  out.set('drill_library', drillColumns);
  for (const child of CHILD_TABLES) {
    const columns = await tableColumns(ctx.client, child.table);
    assertColumns(child.table, columns, [
      'organization_id', 'drill_id', ...(child.idColumn ? [child.idColumn] : []),
      ...contentColumns(child.spec, notStored(child.spec)).map((column) => column.name),
    ]);
    out.set(child.table, columns);
  }
  const transferColumns = await tableColumns(ctx.client, 'transfer_claims');
  assertColumns('transfer_claims', transferColumns, [
    'organization_id', 'transfer_id', ...contentColumns(TRANSFER, new Set()).map((column) => column.name),
  ]);
  out.set('transfer_claims', transferColumns);
  return out;
}

function finding(code: Finding['code'], file: string, key: string, message: string): Finding {
  return { code, file, column: 'drill_id', key, message };
}

export const DRILL_LIBRARY_ENGINE: DatasetEngine = {
  spec: DATASET,

  // The org's CURRENT drills, keyed by lineage the way a package names them,
  // so the validator judges name uniqueness (pilot_drill_library_one_active_name:
  // one active current drill per name per discipline) and minted-id collisions
  // against what this gym holds. Active heads only, as the index does; a
  // withdrawn drill does not hold its name.
  async readBaseline(ctx): Promise<ParsedFile[]> {
    const heads = [...(await readHeads(ctx)).values()].filter((head) => head.active);
    const { children } = await readHeadChildren(ctx, heads.map((head) => head.drillId));
    const lineageOf = new Map(heads.map((head) => [head.drillId, head.lineageId]));

    const asParsed = (spec: FileSpec, row: DbRow, lineage: string, id: string): ParsedRow => {
      const content = storedContent(spec, row, notStored(spec));
      const values: Record<string, string> = {};
      for (const column of spec.columns) {
        if (column.role === 'key' || column.role === 'lineage' || column.role === 'parent') values[column.name] = lineage;
        else if (column.role === 'child_id') values[column.name] = id;
        else values[column.name] = content[column.name] ?? '';
      }
      return { line: 0, raw: { ...values }, values };
    };

    const files: ParsedFile[] = [
      {
        path: 'database:pilot.drill_library',
        spec: ROOT,
        header: ROOT.columns.map((column) => column.name),
        rows: heads.map((head) => asParsed(ROOT, head.row, head.lineageId, '')),
      },
    ];
    for (const child of CHILD_TABLES) {
      const rows: ParsedRow[] = [];
      for (const [drillId, list] of children.get(child.spec) ?? new Map<string, DbRow[]>()) {
        const lineage = lineageOf.get(drillId);
        if (!lineage) continue;
        for (const row of list) rows.push(asParsed(child.spec, row, lineage, child.idColumn ? String(row[child.idColumn] ?? '') : ''));
      }
      files.push({ path: `database:pilot.${child.table}`, spec: child.spec, header: child.spec.columns.map((column) => column.name), rows });
    }
    return files;
  },

  // The head of every lineage the package names, so nothing supersedes it
  // between the re-plan and the write (apply.ts step 3). Its children are
  // never updated -- a new version gets new rows -- so the head row is enough.
  async lockKeys(ctx, keys): Promise<void> {
    const lineages = [...new Set(keys.filter((key) => key && !isNewId(key)))].sort();
    if (lineages.length === 0) return;
    await ctx.client.query(
      `select 1 from pilot.drill_library
        where organization_id = $1 and lineage_id = any($2::text[]) and superseded_at is null
        order by drill_id
        for update`,
      [ctx.organizationId, lineages],
    );
  },

  async plan(ctx, input: { files: readonly ParsedFile[]; validation: ValidationResult }): Promise<DatasetPlan> {
    const columns = await columnsByTable(ctx);
    const { files, validation } = input;
    const resolve = (raw: string) => (isNewId(raw) ? validation.minted.get('drill')?.get(raw) ?? raw : raw);
    const keyOf = (file: ParsedFile, row: ParsedRow) => resolve(row.values[file.spec.parent?.column ?? ROOT.key[0]] ?? '');

    const heads = await readHeads(ctx);
    const { children, transfers } = await readHeadChildren(ctx, [...heads.values()].map((head) => head.drillId));
    const everyVersion = await ctx.client.query<{ drill_id: string; lineage_id: string; version: number }>(
      'select drill_id, lineage_id, version from pilot.drill_library where organization_id = $1',
      [ctx.organizationId],
    );
    const existingIds = new Map(everyVersion.rows.map((row) => [row.drill_id, row]));

    const rootFile = files.find((file) => file.spec === ROOT);
    const packageRoots = new Map<string, ParsedRow>();
    for (const row of rootFile?.rows ?? []) packageRoots.set(keyOf(rootFile as ParsedFile, row), row);
    const packageChildren = new Map<FileSpec, Map<string, ParsedRow[]>>();
    const packageKeys = new Map<string, string>();
    for (const file of files) {
      for (const row of file.rows) {
        const key = keyOf(file, row);
        const raw = row.values[file.spec.parent?.column ?? ROOT.key[0]] ?? '';
        if (!packageKeys.has(key) || raw !== key) packageKeys.set(key, raw);
        if (!file.spec.parent) continue;
        const byDrill = packageChildren.get(file.spec) ?? new Map<string, ParsedRow[]>();
        byDrill.set(key, [...(byDrill.get(key) ?? []), row]);
        packageChildren.set(file.spec, byDrill);
      }
    }

    const reasons = reasonsByItem(files, validation.blocking, keyOf);
    const findings: Finding[] = [];
    const reject = (key: string, code: Finding['code'], message: string) => {
      reasons.set(key, [...(reasons.get(key) ?? []), message]);
      findings.push(finding(code, rootFile?.path ?? files[0]?.path ?? DATASET.folder, key, message));
    };

    const items: DrillItem[] = [];
    for (const key of [...packageKeys.keys()].sort()) {
      const raw = packageKeys.get(key) ?? key;
      const unit: UnitPlan = { dataset: DATASET.name, key, outcome: 'reject' };
      if (raw !== key) unit.packageKey = raw;
      const head = heads.get(key);
      const database = head ? databaseUnit(head, children, transfers) : undefined;

      const packageRoot = packageRoots.get(key);
      const effective: UnitContentRows = {
        root: packageRoot ? storedContent(ROOT, packageRoot.values) : database?.root ?? null,
        children: new Map(),
        transfers: database?.transfers ?? [],
      };
      for (const child of CHILD_TABLES) {
        const rows = packageChildren.get(child.spec)?.get(key);
        effective.children.set(
          child.spec,
          rows && rows.length > 0
            ? rows.map((row) => ({
              id: child.idColumn ? row.values[child.idColumn] ?? '' : '',
              content: storedContent(child.spec, row.values, notStored(child.spec)),
            }))
            : database?.children.get(child.spec) ?? [],
        );
      }
      if (database) unit.databaseSha256 = unitHash(database);
      if (effective.root) unit.fileSha256 = unitHash(effective);
      const item: DrillItem = { unit, head, effective };
      items.push(item);

      if ((reasons.get(key) ?? []).length === 0) {
        if (!effective.root) {
          reject(key, 'orphan_reference', `drill ${raw} has rows in a child file but is neither in seed_drill_library.csv nor a current drill of this organization`);
        } else {
          // The loader's own refusals (seed-drill-secondary-skills.mjs:238-243),
          // on the drill as it WILL be: the validator checks the package's
          // secondary rows, this also catches carried rows against a changed
          // primary.
          const secondary = (effective.children.get(childSpec('seed_drill_secondary_skills.csv')) ?? []).map((row) => row.content.skill_id);
          const primary = effective.root.skill_id ?? '';
          if (secondary.length > 0 && !primary) {
            reject(key, 'row_rule', `drill ${raw} would have secondary skills (${secondary.join(', ')}) but no primary skill_id`);
          } else if (primary && secondary.includes(primary)) {
            reject(key, 'row_rule', `drill ${raw} would have ${primary} as both its primary and a secondary skill`);
          }
        }
      }

      if ((reasons.get(key) ?? []).length > 0) continue;
      if (!head) {
        const taken = existingIds.get(key);
        if (taken) {
          reject(
            key,
            'minted_id_exists',
            taken.lineage_id === key
              ? `drill ${key} exists in this organization but has no current version (every version is superseded); it cannot be loaded again as a first version`
              : `${key} is version ${taken.version} of drill ${taken.lineage_id}. A package names a drill by its lineage key (the id of its first version): write ${taken.lineage_id}`,
          );
          continue;
        }
        unit.outcome = 'new';
        unit.toVersion = 1;
        item.drillId = key;
      } else if (unit.fileSha256 === unit.databaseSha256) {
        unit.outcome = 'unchanged';
      } else {
        unit.outcome = 'new_version';
        unit.fromVersion = head.version;
        unit.toVersion = head.version + 1;
        item.drillId = MINT.drillVersion(head.lineageId, head.version + 1);
        const taken = existingIds.get(item.drillId);
        if (taken) {
          reject(key, 'minted_id_exists', `version ${unit.toVersion} of drill ${key} mints ${item.drillId}, which already exists (version ${taken.version} of ${taken.lineage_id})`);
          unit.outcome = 'reject';
        }
      }
    }

    // Child ids. A first version keeps the ids its files give (the committed
    // ids production already holds; blank ones are minted as prepare mints
    // them). A later version RE-MINTS every child from its own drill_id: the
    // package's ids belong to the version before, which keeps its rows.
    const planned = new Map<string, Map<string, string>>(); // table -> id -> drill key
    const plannedTransfers = new Map<string, string>();
    for (const item of items) {
      if (item.unit.outcome !== 'new' && item.unit.outcome !== 'new_version') continue;
      const drillId = item.drillId as string;
      const reMint = item.unit.outcome === 'new_version';
      item.childIds = new Map();
      for (const child of CHILD_TABLES) {
        if (!child.idColumn || !child.spec.mint) continue;
        const mint = child.spec.mint.mint;
        const ids = (item.effective?.children.get(child.spec) ?? []).map((row) =>
          (!reMint && row.id ? row.id : mint({ ...row.content, drill_id: drillId })));
        item.childIds.set(child.table, ids);
        const seen = planned.get(child.table) ?? new Map<string, string>();
        for (const id of ids) {
          const other = seen.get(id);
          if (other !== undefined) {
            reject(item.unit.key, 'duplicate_id', `${child.idColumn} ${id} would be written twice (drills ${other} and ${item.unit.key})`);
          }
          seen.set(id, item.unit.key);
        }
        planned.set(child.table, seen);
      }
      item.transferIds = (item.effective?.transfers ?? []).map((content) =>
        (TRANSFER.mint as NonNullable<FileSpec['mint']>).mint({ ...content, drill_id: drillId }));
      for (const id of item.transferIds) {
        const other = plannedTransfers.get(id);
        if (other !== undefined) {
          reject(item.unit.key, 'duplicate_id', `transfer_id ${id} would be written twice (drills ${other} and ${item.unit.key}): two of its claims say the same thing`);
        }
        plannedTransfers.set(id, item.unit.key);
      }
    }
    const idTables: { table: string; idColumn: string; ids: Map<string, string> }[] = [
      ...CHILD_TABLES.filter((child) => child.idColumn).map((child) => ({
        table: child.table,
        idColumn: child.idColumn as string,
        ids: planned.get(child.table) ?? new Map<string, string>(),
      })),
      { table: 'transfer_claims', idColumn: 'transfer_id', ids: plannedTransfers },
    ];
    for (const { table, idColumn, ids } of idTables) {
      if (ids.size === 0) continue;
      const { rows } = await ctx.client.query<{ id: string }>(
        `select ${idColumn} as id from pilot.${table} where organization_id = $1 and ${idColumn} = any($2::text[])`,
        [ctx.organizationId, [...ids.keys()]],
      );
      for (const row of rows) {
        const key = ids.get(row.id) as string;
        reject(key, 'minted_id_exists', `${idColumn} ${row.id} of drill ${key} already exists in pilot.${table}; keep the committed ids or leave them blank`);
      }
    }

    for (const item of items) {
      const why = reasons.get(item.unit.key) ?? [];
      if (why.length > 0) {
        item.unit.outcome = 'reject';
        item.unit.reasons = why;
        delete item.unit.fromVersion;
        delete item.unit.toVersion;
      }
    }

    for (const head of heads.values()) {
      if (packageKeys.has(head.lineageId)) continue;
      items.push({ unit: { dataset: DATASET.name, key: head.lineageId, outcome: 'absent' } });
    }

    const state: DrillState = { items, columns };
    return { dataset: DATASET.name, units: items.map((item) => item.unit), findings, state };
  },

  // No history-ledger rows: the versions live in the table itself.
  async apply(ctx, plan): Promise<DatasetWriteResult> {
    const state = plan.state as DrillState;
    const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
    const writes = state.items.filter((item) => item.unit.outcome === 'new' || item.unit.outcome === 'new_version');
    if (writes.length === 0) return result;
    const info = (table: string, column: string) => state.columns.get(table)?.get(column) as TableColumn;

    // 1. Supersede every head this import revises, before any insert.
    for (const item of writes) {
      if (item.unit.outcome !== 'new_version') continue;
      const head = item.head as Head;
      const outcome = await ctx.client.query(
        `update pilot.drill_library set superseded_at = now(), updated_at = now()
          where organization_id = $1 and drill_id = $2 and superseded_at is null`,
        [ctx.organizationId, head.drillId],
      );
      // The head was locked FOR UPDATE and re-read for this plan; anything but
      // one row means the plan no longer describes the table.
      if (outcome.rowCount !== 1) {
        throw new Error(`content-import: expected to supersede 1 head of drill ${item.unit.key} (${head.drillId}), updated ${outcome.rowCount}`);
      }
      result.updated.push(head.drillId);
    }

    // 2. The new rows, the drill before its children (their foreign keys).
    const rootContent = contentColumns(ROOT, new Set());
    const rootColumns = [
      'organization_id', 'drill_id', 'lineage_id', 'version', 'supersedes_drill_id',
      ...rootContent.map((column) => column.name),
      'active', 'created_by_account_id', 'created_by_role',
    ].map((name) => ({ name, array: info('drill_library', name).array }));
    const rootRows = writes.map((item) => {
      const head = item.head;
      const content = item.effective?.root as Record<string, string>;
      return [
        ctx.organizationId,
        item.drillId,
        item.unit.key,
        item.unit.toVersion,
        item.unit.outcome === 'new_version' ? (head as Head).drillId : null,
        ...rootContent.map((column) => typedValue(column, content[column.name] ?? '', info('drill_library', column.name))),
        // A revision does not withdraw or restore a drill: the new version
        // takes the head's active flag (a new drill is active). Withdrawing is
        // its own action (specs/drills.ts, the active column).
        item.unit.outcome === 'new_version' ? (head as Head).active : true,
        ctx.actor.accountId,
        ctx.actor.role,
      ];
    });
    await insertRows(ctx.client, 'drill_library', rootColumns, rootRows);
    result.inserted.push(...writes.map((item) => item.drillId as string));

    for (const child of CHILD_TABLES) {
      const content = contentColumns(child.spec, notStored(child.spec));
      const columns = ['organization_id', ...(child.idColumn ? [child.idColumn] : []), 'drill_id', ...content.map((column) => column.name)]
        .map((name) => ({ name, array: info(child.table, name).array }));
      const rows: unknown[][] = [];
      for (const item of writes) {
        const ids = item.childIds?.get(child.table) ?? [];
        (item.effective?.children.get(child.spec) ?? []).forEach((row, index) => {
          rows.push([
            ctx.organizationId,
            ...(child.idColumn ? [ids[index]] : []),
            item.drillId,
            ...content.map((column) => typedValue(column, row.content[column.name] ?? '', info(child.table, column.name))),
          ]);
        });
      }
      await insertRows(ctx.client, child.table, columns, rows);
    }

    const transferContentColumns = contentColumns(TRANSFER, TRANSFER_TARGETS);
    const transferColumns = ['organization_id', 'transfer_id', 'drill_id', ...transferContentColumns.map((column) => column.name)]
      .map((name) => ({ name, array: info('transfer_claims', name).array }));
    const transferRows: unknown[][] = [];
    for (const item of writes) {
      (item.effective?.transfers ?? []).forEach((content, index) => {
        transferRows.push([
          ctx.organizationId,
          item.transferIds?.[index],
          item.drillId,
          ...transferContentColumns.map((column) => typedValue(column, content[column.name] ?? '', info('transfer_claims', column.name))),
        ]);
      });
    }
    await insertRows(ctx.client, 'transfer_claims', transferColumns, transferRows);
    return result;
  },
};
