import type { DbClient } from '../actor';
import { type CellInput, isContentColumn, unitContentHash } from '../canonical';
import { isNewId, MINT } from '../ids';
import { datasetSpec, rootFileSpec } from '../specs';
import type { Finding, ParsedFile, ParsedRow } from '../types';
import type { ValidationResult } from '../validate';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, UnitPlan } from './index';
import {
  assertColumns,
  insertRows,
  reasonsByItem,
  storedContent,
  type TableColumn,
  tableColumns,
  typedValue,
} from './versioned';

// THE UNIVERSAL STOP RULES (R3: "obviously injury of some sort would require
// stoppage universally"), stored ONCE per gym in pilot.universal_stop_rules
// (content-import migration :164-222) and applying to every drill -- or, with
// applies_to_contact_levels, to the drills at those contact levels.
//
// R2 exactly as drills.ts applies it, on the table's own version columns:
//   unchanged -> nothing is written
//   changed   -> the current head gets superseded_at (it stays active; a
//                withdrawn rule is active = false, a separate action), then
//                v(n+1) is inserted as MINT.universalRuleVersion(lineage, n+1)
//                with supersedes_rule_id = the old head. One head per lineage
//                and one current rule per ordinal are indexes
//                (content-import migration :213-219), so every supersede of
//                an import runs before any insert: two rules may trade places.
//   new       -> v1, universal_rule_id = the lineage key (the ust_ formula for
//                a new:<short-name>)
//   absent    -> left alone and listed
// A package names a rule by its LINEAGE key, like a drill.

const DATASET = datasetSpec('universal-stop-rules');
const SPEC = rootFileSpec(DATASET);
const TABLE = 'universal_stop_rules';
const CONTENT = SPEC.columns.filter(isContentColumn);

type DbRow = Record<string, CellInput> & Record<string, unknown>;

interface Head {
  ruleId: string;
  lineageId: string;
  version: number;
  active: boolean;
  row: DbRow;
}

interface RuleItem {
  unit: UnitPlan;
  head?: Head;
  content?: Record<string, string>;
  ruleId?: string;
}

interface RuleState {
  items: RuleItem[];
  columns: Map<string, TableColumn>;
}

function hashOf(content: Readonly<Record<string, CellInput>>): string {
  return unitContentHash(DATASET, { root: content, children: {} });
}

async function readHeads(client: DbClient, organizationId: string): Promise<Map<string, Head>> {
  const { rows } = await client.query<DbRow>(
    `select * from pilot.universal_stop_rules
      where organization_id = $1 and superseded_at is null
      order by lineage_id`,
    [organizationId],
  );
  return new Map(
    rows.map((row) => [
      String(row.lineage_id),
      { ruleId: String(row.universal_rule_id), lineageId: String(row.lineage_id), version: Number(row.version), active: row.active === true, row },
    ]),
  );
}

export const UNIVERSAL_STOP_RULES_ENGINE: DatasetEngine = {
  spec: DATASET,

  // The org's current ACTIVE rules, keyed by lineage, so the validator's
  // "ordinal is unique across the set" is judged against what the gym holds
  // (pilot_universal_stop_rules_one_current_per_ordinal: superseded_at is
  // null and active).
  async readBaseline(ctx): Promise<ParsedFile[]> {
    const heads = [...(await readHeads(ctx.client, ctx.organizationId)).values()].filter((head) => head.active);
    const rows: ParsedRow[] = heads.map((head) => {
      const content = storedContent(SPEC, head.row);
      const values: Record<string, string> = {};
      for (const column of SPEC.columns) values[column.name] = column.role === 'key' ? head.lineageId : content[column.name] ?? '';
      return { line: 0, raw: { ...values }, values };
    });
    return [{ path: `database:pilot.${TABLE}`, spec: SPEC, header: SPEC.columns.map((column) => column.name), rows }];
  },

  async lockKeys(ctx, keys): Promise<void> {
    const lineages = [...new Set(keys.filter((key) => key && !isNewId(key)))].sort();
    if (lineages.length === 0) return;
    await ctx.client.query(
      `select 1 from pilot.universal_stop_rules
        where organization_id = $1 and lineage_id = any($2::text[]) and superseded_at is null
        order by universal_rule_id
        for update`,
      [ctx.organizationId, lineages],
    );
  },

  async plan(ctx, input: { files: readonly ParsedFile[]; validation: ValidationResult }): Promise<DatasetPlan> {
    const columns = await tableColumns(ctx.client, TABLE);
    assertColumns(TABLE, columns, [
      'organization_id', 'universal_rule_id', 'lineage_id', 'version', 'supersedes_rule_id', 'superseded_at', 'active',
      'created_by_account_id', 'created_by_role', ...CONTENT.map((column) => column.name),
    ]);
    const file = input.files.find((candidate) => candidate.spec === SPEC);
    if (!file) return { dataset: DATASET.name, units: [], findings: [], state: { items: [], columns } satisfies RuleState };

    const keyColumn = SPEC.key[0];
    const resolve = (raw: string) => (isNewId(raw) ? input.validation.minted.get('universal_rule')?.get(raw) ?? raw : raw);
    const keyOf = (_file: ParsedFile, row: ParsedRow) => resolve(row.values[keyColumn] ?? '');
    const reasons = reasonsByItem([file], input.validation.blocking, keyOf);
    const heads = await readHeads(ctx.client, ctx.organizationId);
    const everyVersion = await ctx.client.query<{ universal_rule_id: string; lineage_id: string; version: number }>(
      'select universal_rule_id, lineage_id, version from pilot.universal_stop_rules where organization_id = $1',
      [ctx.organizationId],
    );
    const existingIds = new Map(everyVersion.rows.map((row) => [row.universal_rule_id, row]));

    const findings: Finding[] = [];
    const items: RuleItem[] = [];
    const seen = new Set<string>();
    for (const row of file.rows) {
      const raw = row.values[keyColumn] ?? '';
      const key = resolve(raw);
      seen.add(key);
      const unit: UnitPlan = { dataset: DATASET.name, key, outcome: 'reject' };
      if (raw !== key) unit.packageKey = raw;
      const head = heads.get(key);
      const content = storedContent(SPEC, row.values);
      unit.fileSha256 = hashOf(content);
      if (head) unit.databaseSha256 = hashOf(storedContent(SPEC, head.row));
      const item: RuleItem = { unit, head, content };
      items.push(item);

      const why = [...(reasons.get(key) ?? [])];
      if (why.length === 0) {
        if (!head) {
          const taken = existingIds.get(key);
          if (taken) {
            why.push(
              taken.lineage_id === key
                ? `universal rule ${key} exists in this organization but has no current version; it cannot be loaded again as a first version`
                : `${key} is version ${taken.version} of universal rule ${taken.lineage_id}. A package names a rule by its lineage key: write ${taken.lineage_id}`,
            );
          } else {
            unit.outcome = 'new';
            unit.toVersion = 1;
            item.ruleId = key;
          }
        } else if (unit.fileSha256 === unit.databaseSha256) {
          unit.outcome = 'unchanged';
        } else {
          const ruleId = MINT.universalRuleVersion(head.lineageId, head.version + 1);
          const taken = existingIds.get(ruleId);
          if (taken) {
            why.push(`version ${head.version + 1} of universal rule ${key} mints ${ruleId}, which already exists (version ${taken.version} of ${taken.lineage_id})`);
          } else {
            unit.outcome = 'new_version';
            unit.fromVersion = head.version;
            unit.toVersion = head.version + 1;
            item.ruleId = ruleId;
          }
        }
        if (why.length > 0) {
          findings.push({ code: 'minted_id_exists', file: file.path, line: row.line, column: keyColumn, key, message: why[0] });
        }
      }
      if (why.length > 0) {
        unit.outcome = 'reject';
        unit.reasons = why;
        delete unit.fromVersion;
        delete unit.toVersion;
      }
    }

    for (const head of heads.values()) {
      if (seen.has(head.lineageId)) continue;
      items.push({ unit: { dataset: DATASET.name, key: head.lineageId, outcome: 'absent' } });
    }
    const state: RuleState = { items, columns };
    return { dataset: DATASET.name, units: items.map((item) => item.unit), findings, state };
  },

  // No history-ledger rows: the versions live in the table itself.
  async apply(ctx, plan): Promise<DatasetWriteResult> {
    const state = plan.state as RuleState;
    const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
    const writes = state.items.filter((item) => item.unit.outcome === 'new' || item.unit.outcome === 'new_version');
    if (writes.length === 0) return result;
    const info = (name: string) => state.columns.get(name) as TableColumn;

    for (const item of writes) {
      if (item.unit.outcome !== 'new_version') continue;
      const head = item.head as Head;
      const outcome = await ctx.client.query(
        `update pilot.universal_stop_rules set superseded_at = now()
          where organization_id = $1 and universal_rule_id = $2 and superseded_at is null`,
        [ctx.organizationId, head.ruleId],
      );
      if (outcome.rowCount !== 1) {
        throw new Error(`content-import: expected to supersede 1 head of universal rule ${item.unit.key} (${head.ruleId}), updated ${outcome.rowCount}`);
      }
      result.updated.push(head.ruleId);
    }

    const names = [
      'organization_id', 'universal_rule_id', 'lineage_id', 'version', 'supersedes_rule_id',
      ...CONTENT.map((column) => column.name),
      'active', 'created_by_account_id', 'created_by_role',
    ];
    await insertRows(
      ctx.client,
      TABLE,
      names.map((name) => ({ name, array: info(name).array })),
      writes.map((item) => {
        const content = item.content as Record<string, string>;
        return [
          ctx.organizationId,
          item.ruleId,
          item.unit.key,
          item.unit.toVersion,
          item.unit.outcome === 'new_version' ? (item.head as Head).ruleId : null,
          ...CONTENT.map((column) => typedValue(column, content[column.name] ?? '', info(column.name))),
          item.unit.outcome === 'new_version' ? (item.head as Head).active : true,
          ctx.actor.accountId,
          ctx.actor.role,
        ];
      }),
    );
    result.inserted.push(...writes.map((item) => item.ruleId as string));
    return result;
  },
};
