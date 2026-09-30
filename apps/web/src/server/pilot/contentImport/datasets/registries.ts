import { type CellInput, canonicalRow, isContentColumn, unitContentHash } from '../canonical';
import { isNewId } from '../ids';
import { appendLedgerRow, ledgerHeads, planLedgerVersions, type LedgerVersionPlan } from '../ledger';
import { datasetSpec, rootFileSpec } from '../specs';
import type { ColumnSpec, DatasetSpec, FileSpec, Finding, ParsedFile, ParsedRow, RowValues } from '../types';
import type { ValidationResult } from '../validate';
import { integerText, normalizeCell, numberText, parseBoolean, splitList } from '../values';
import type { DatasetEngine, DatasetPlan, DatasetWriteResult, EngineContext, UnitPlan } from './index';

// THE THREE KEYED REGISTRIES: disciplines, competence levels, cohort
// definitions (R2 for tables that cannot hold versions).
//
//   unchanged -> nothing is written, not even an UPDATE with equal values: a
//                re-import of the committed files must leave every row
//                exactly as it was (the old loaders' ON CONFLICT DO NOTHING
//                got this right, and must not be lost).
//   changed   -> the LIVE row is updated in place (its key is a foreign-key
//                target: five tables point at a discipline, athlete_competence
//                at a level_key, and cohort_definitions has no version
//                columns), and the history ledger records before (if the
//                ledger has not seen that content) and after, with versions
//                (ledger.ts). Before this engine the change was skipped
//                without a word (the retired seed-disciplines.mjs and
//                seed-competence-cohorts.mjs: on conflict do nothing).
//   new       -> inserted, and recorded in the ledger as v1.
//   absent    -> a row in the database the package does not mention is left
//                alone and listed.
//
// A COMPETENCE LEVEL MAY NOT CHANGE ORDINAL IN PLACE. Cohorts qualify athletes
// by level ORDINAL, not by level_key (competence_cohorts migration :113-114,
// min/max_level_ordinal; competenceCohorts.ts:266-270), so moving a level
// silently changes which athletes every cohort admits -- and swapping two
// levels fails on the non-deferrable unique (organization_id, ordinal)
// (competence_cohorts migration :36). That is a blocking finding here, not a
// database error half-way through a load.

// ---------------------------------------------------------------------------
// Database <-> cell text

interface ColumnInfo {
  nullable: boolean;
}

/** Identifiers come from specs and constants, never input; this keeps it that way. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`content-import: '${name}' is not a plain SQL identifier`);
  return name;
}

/** A database value as the cell text a CSV would carry, for the validator's baseline. */
function cellText(value: unknown, column: ColumnSpec): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeCell(String(item))).join(column.list ?? '|');
  return normalizeCell(String(value));
}

/**
 * The value written for a validated cell. A blank means the column's
 * blankDefault (what the old loaders wrote for a blank, and what the canonical
 * hash reads a blank as), and otherwise NULL -- or '' for a NOT NULL text
 * column such as disciplines.evidence_note, whose old loader wrote ''
 * (the retired seed-disciplines.mjs). Nullability is read from the live table, not
 * restated here, so it cannot drift from the migrations.
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

// ---------------------------------------------------------------------------

interface RegistryConfig {
  dataset: DatasetSpec;
  table: string;
  /** pilot.reference_content_revisions.dataset: a lowercase slug (its CHECK refuses '-'). */
  ledgerDataset: string;
  /** A blocking rule on a revision of an existing row; returns why, or null. */
  revisionRule?: {
    code: Finding['code'];
    column: string;
    check(key: string, before: Record<string, string>, after: Record<string, string>): string | null;
  };
}

interface RegistryItem {
  unit: UnitPlan;
  values?: RowValues;
  fileContent?: Record<string, string>;
  databaseContent?: Record<string, string>;
  ledger?: LedgerVersionPlan;
}

interface RegistryState {
  items: RegistryItem[];
  columns: Map<string, ColumnInfo>;
}

function registryEngine(config: RegistryConfig): DatasetEngine {
  const spec: FileSpec = rootFileSpec(config.dataset);
  if (config.dataset.files.length !== 1) {
    throw new Error(`content-import: ${config.dataset.name} has ${config.dataset.files.length} files; a registry has exactly one`);
  }
  const unsupported = spec.columns.filter((column) => ['lineage', 'child_id', 'parent'].includes(column.role));
  if (unsupported.length > 0) {
    throw new Error(`content-import: ${config.dataset.name} has versioned or child columns (${unsupported.map((c) => c.name).join(', ')}); it is not a registry`);
  }
  const table = `pilot.${ident(config.table)}`;
  const keyColumn = ident(spec.key[0]);
  const stored = spec.columns.filter((column) => column.role !== 'placeholder');

  async function columnInfo(ctx: EngineContext): Promise<Map<string, ColumnInfo>> {
    const { rows } = await ctx.client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'pilot' and table_name = $1`,
      [config.table],
    );
    const info = new Map(rows.map((row) => [row.column_name, { nullable: row.is_nullable === 'YES' }]));
    // The spec and the table must agree on every column the engine writes. A
    // spec column the table lacks would otherwise fail mid-load, or -- worse --
    // be silently dropped by a loader that builds its column list from the
    // table.
    const missing = stored.filter((column) => !info.has(column.name)).map((column) => column.name);
    if (missing.length > 0) {
      throw new Error(`content-import: ${table} has no column(s) ${missing.join(', ')} that ${spec.file} writes`);
    }
    return info;
  }

  async function databaseRows(ctx: EngineContext): Promise<Map<string, Record<string, CellInput>>> {
    const { rows } = await ctx.client.query<Record<string, CellInput>>(
      `select * from ${table} where organization_id = $1 order by ${keyColumn}`,
      [ctx.organizationId],
    );
    return new Map(rows.map((row) => [String(row[keyColumn]), row]));
  }

  function unitHash(row: Readonly<Record<string, CellInput>>): string {
    return unitContentHash(config.dataset, { root: row, children: {} });
  }

  return {
    spec: config.dataset,

    async readBaseline(ctx): Promise<ParsedFile[]> {
      const rows = await databaseRows(ctx);
      const parsedRows: ParsedRow[] = [...rows.values()].map((row) => {
        const values: Record<string, string> = {};
        for (const column of spec.columns) values[column.name] = column.role === 'placeholder' ? '' : cellText(row[column.name], column);
        return { line: 0, raw: { ...values }, values };
      });
      return [{ path: `database:${table}`, spec, header: spec.columns.map((column) => column.name), rows: parsedRows }];
    },

    async lockKeys(ctx, keys): Promise<void> {
      const existing = keys.filter((key) => key && !isNewId(key));
      if (existing.length === 0) return;
      await ctx.client.query(
        `select 1 from ${table}
          where organization_id = $1 and ${keyColumn} = any($2::text[])
          order by ${keyColumn}
          for update`,
        [ctx.organizationId, [...existing].sort()],
      );
    },

    async plan(ctx, input: { files: readonly ParsedFile[]; validation: ValidationResult }): Promise<DatasetPlan> {
      const file = input.files.find((candidate) => candidate.spec === spec);
      const columns = await columnInfo(ctx);
      if (!file) return { dataset: config.dataset.name, units: [], findings: [], state: { items: [], columns } satisfies RegistryState };

      const database = await databaseRows(ctx);
      const fileFindings = input.validation.blocking.filter((finding) => finding.file === file.path);
      // A header problem (unknown or missing column) or an unreadable file
      // makes every row of the file suspect, not only the row it names.
      const wholeFile = fileFindings.filter((finding) => finding.line === undefined || finding.line <= 1).map((finding) => finding.message);
      const byLine = new Map<number, string[]>();
      for (const finding of fileFindings) {
        if (finding.line === undefined || finding.line <= 1) continue;
        byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding.message]);
      }

      const mintKind = spec.mint?.idKind;
      const resolve = (raw: string) => (isNewId(raw) && mintKind ? input.validation.minted.get(mintKind)?.get(raw) ?? raw : raw);
      const keys = file.rows.map((row) => resolve(row.values[keyColumn]));
      const heads = await ledgerHeads(ctx.client, ctx.organizationId, config.ledgerDataset, [...new Set(keys)]);

      const findings: Finding[] = [];
      const items: RegistryItem[] = [];
      const seen = new Set<string>();

      file.rows.forEach((row, index) => {
        const key = keys[index];
        seen.add(key);
        const raw = row.values[keyColumn];
        const unit: UnitPlan = { dataset: config.dataset.name, key, outcome: 'reject' };
        if (raw !== key) unit.packageKey = raw;
        const fileContent = canonicalRow(spec, row.values);
        unit.fileSha256 = unitHash(row.values);
        const existing = database.get(key);
        const databaseContent = existing ? canonicalRow(spec, existing) : undefined;
        if (existing) unit.databaseSha256 = unitHash(existing);

        const reasons = [...wholeFile, ...(byLine.get(row.line) ?? [])];
        if (reasons.length === 0 && existing && databaseContent && config.revisionRule && unit.fileSha256 !== unit.databaseSha256) {
          const problem = config.revisionRule.check(key, databaseContent, fileContent);
          if (problem) {
            reasons.push(problem);
            findings.push({ code: config.revisionRule.code, file: file.path, line: row.line, column: config.revisionRule.column, key, message: problem });
          }
        }

        let ledger: LedgerVersionPlan | undefined;
        if (reasons.length > 0) {
          unit.outcome = 'reject';
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
        if (ledger) {
          if (ledger.fromVersion !== undefined) unit.fromVersion = ledger.fromVersion;
          unit.toVersion = ledger.toVersion;
          if (ledger.recordBefore) unit.recordsBefore = true;
        }
        items.push({ unit, values: row.values, fileContent, databaseContent, ledger });
      });

      for (const key of database.keys()) {
        if (seen.has(key)) continue;
        items.push({ unit: { dataset: config.dataset.name, key, outcome: 'absent' } });
      }

      const state: RegistryState = { items, columns };
      return { dataset: config.dataset.name, units: items.map((item) => item.unit), findings, state };
    },

    async apply(ctx, plan, write): Promise<DatasetWriteResult> {
      const state = plan.state as RegistryState;
      const result: DatasetWriteResult = { inserted: [], updated: [], ledgerRows: 0 };
      const info = (column: ColumnSpec) => state.columns.get(column.name) as ColumnInfo;

      const record = async (key: string, version: number, content: Record<string, string>, sha: string) => {
        await appendLedgerRow(ctx.client, {
          organizationId: ctx.organizationId,
          dataset: config.ledgerDataset,
          itemKey: key,
          version,
          content,
          contentSha256: sha,
          importId: write.importId,
          actor: ctx.actor,
        });
        result.ledgerRows += 1;
      };

      for (const item of state.items) {
        const { unit, values, ledger } = item;
        if (unit.outcome !== 'new' && unit.outcome !== 'new_version') continue;
        if (!values || !ledger || !item.fileContent || !unit.fileSha256) {
          throw new Error(`content-import: ${config.dataset.name} ${unit.key} was planned without its content`);
        }

        if (unit.outcome === 'new') {
          const names = ['organization_id'];
          const params: unknown[] = [ctx.organizationId];
          for (const column of stored) {
            names.push(ident(column.name));
            if (column.role === 'key') {
              params.push(unit.key);
            } else if (column.role === 'system') {
              // Only blank or the system default passed validation; the tool
              // decides, so a new row gets the default (cohort active_flag
              // true -- retiring is a separate action).
              params.push(column.systemDefault === undefined ? null : databaseValue(column, column.systemDefault, info(column)));
            } else {
              params.push(databaseValue(column, values[column.name] ?? '', info(column)));
            }
          }
          await ctx.client.query(
            `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
            params,
          );
          result.inserted.push(unit.key);
          await record(unit.key, ledger.toVersion, item.fileContent, unit.fileSha256);
          continue;
        }

        if (ledger.recordBefore) {
          if (!item.databaseContent || !unit.databaseSha256 || ledger.fromVersion === undefined) {
            throw new Error(`content-import: ${config.dataset.name} ${unit.key} was planned as a revision without its database content`);
          }
          await record(unit.key, ledger.fromVersion, item.databaseContent, unit.databaseSha256);
        }
        // Content columns only: the key is the identity and never changes
        // here, and a system column (cohort active_flag) belongs to its own
        // action, not to a content revision.
        const updated = stored.filter(isContentColumn);
        const params: unknown[] = [ctx.organizationId, unit.key];
        const sets = updated.map((column) => {
          params.push(databaseValue(column, values[column.name] ?? '', info(column)));
          return `${ident(column.name)} = $${params.length}`;
        });
        const outcome = await ctx.client.query(
          `update ${table} set ${sets.join(', ')} where organization_id = $1 and ${keyColumn} = $2`,
          params,
        );
        // The row was locked FOR UPDATE and re-read before this plan; anything
        // but exactly one row means the plan no longer describes the table.
        if (outcome.rowCount !== 1) {
          throw new Error(`content-import: expected to update 1 row of ${table} for ${unit.key}, updated ${outcome.rowCount}`);
        }
        result.updated.push(unit.key);
        await record(unit.key, ledger.toVersion, item.fileContent, unit.fileSha256);
      }
      return result;
    },
  };
}

export const REGISTRY_ENGINES: readonly DatasetEngine[] = [
  registryEngine({ dataset: datasetSpec('disciplines'), table: 'disciplines', ledgerDataset: 'disciplines' }),
  registryEngine({
    dataset: datasetSpec('competence-levels'),
    table: 'competence_levels',
    ledgerDataset: 'competence_levels',
    revisionRule: {
      code: 'ordinal_change',
      column: 'ordinal',
      check: (key, before, after) =>
        before.ordinal !== after.ordinal
          ? `competence level ${key} would move from ordinal ${before.ordinal} to ${after.ordinal}. Cohorts admit athletes by ordinal, `
            + 'so moving a level in place silently changes who every cohort admits. Keep the ordinal (other fields may change); '
            + 'a re-ordered ladder needs its own reviewed change.'
          : null,
    },
  }),
  registryEngine({ dataset: datasetSpec('cohort-definitions'), table: 'cohort_definitions', ledgerDataset: 'cohort_definitions' }),
];
