import type { IdKind } from './ids';
import type { BoundName, ConstraintRef, VocabularyName } from './vocabularies';

// The shapes every part of the content-import core shares. No logic here.

export type DatasetName =
  | 'disciplines'
  | 'competence-levels'
  | 'cohort-definitions'
  | 'drill-library'
  | 'universal-stop-rules'
  | 'workout-templates'
  | 'session-scripts'
  | 'transfer-claims'
  | 'assessment-protocols';

/**
 * What a column is FOR, which decides how every stage treats it:
 *   key         the item's identity (keep it on a revision; new:<name> for a new item)
 *   parent      in a child file, the id of the item the row belongs to
 *   reference   points at another item (a drill, a discipline, a research claim)
 *   child_id    a child row's own id; may be blank, prepare mints it
 *   lineage     must be blank or equal to the key (the key IS the lineage key)
 *   placeholder only its {{...}} placeholder or blank; the real value is decided at load
 *   system      decided by the tool; blank or today's default only
 *   content     everything else -- the material itself
 */
export type ColumnRole =
  | 'key'
  | 'parent'
  | 'reference'
  | 'child_id'
  | 'lineage'
  | 'placeholder'
  | 'system'
  | 'content';

export type ReferenceTarget =
  | 'discipline'
  | 'level_ordinal'
  | 'drill'
  | 'template'
  | 'script'
  | 'block'
  | 'claim'
  | 'skill';

export const ORG_PLACEHOLDER = '{{PPBF_ORG_ID}}';
export const ACCOUNT_PLACEHOLDER = '{{SEED_ACCOUNT_ID}}';
export type Placeholder = typeof ORG_PLACEHOLDER | typeof ACCOUNT_PLACEHOLDER;

export interface ColumnSpec {
  name: string;
  role: ColumnRole;
  type: 'text' | 'integer' | 'number' | 'boolean';
  required?: boolean;
  /** Plain English, printed in the contract doc. */
  description: string;
  vocabulary?: VocabularyName;
  /** The cell holds a list; each item is checked against vocabulary / idKind / references. */
  list?: '|' | ',';
  idKind?: IdKind;
  /** new:<short-name> is accepted (a key, or a reference to an item in the same package). */
  allowNew?: boolean;
  references?: ReferenceTarget;
  bound?: BoundName;
  placeholder?: Placeholder;
  /** system columns: the one non-blank value allowed ("today's default"). */
  systemDefault?: string;
  /** What a blank cell means, for the doc. */
  blankMeans?: string;
  /**
   * A short classifier or source name that is SUPPOSED to repeat (a category,
   * a source document). Not reported as repeated text.
   */
  label?: boolean;
}

/** A value read from one row: normalized text by column name. */
export type RowValues = Readonly<Record<string, string>>;

export interface RowContext {
  /** The primary skill of a drill in the package or the committed library; undefined if the drill is unknown. */
  drillPrimarySkill(drillId: string): string | undefined;
}

export interface RowRule {
  /** Plain English, printed in the contract doc. */
  description: string;
  /** The database constraint this mirrors, when there is one. */
  mirrors?: ConstraintRef;
  /** A message when the row breaks the rule, otherwise null. */
  check(row: RowValues, context: RowContext): string | null;
}

export interface GroupRule {
  description: string;
  /** Finding code when the rule fails; row_rule unless the rule has a name of its own. */
  code?: FindingCode;
  mirrors?: ConstraintRef;
  /** Called once per parent id with that parent's rows in this file. */
  check(rows: readonly RowValues[]): string | null;
}

export interface UniqueRule {
  columns: readonly string[];
  description: string;
}

export interface MintRule {
  /** The column the minted id is written into. */
  column: string;
  idKind: IdKind;
  mint(row: RowValues): string;
}

export interface FileSpec {
  dataset: DatasetName;
  folder: string;
  file: string;
  /** One line: what one row is. */
  rowMeaning: string;
  columns: readonly ColumnSpec[];
  /** Identity of a row within the file. Rows with a blank key part are not compared. */
  key: readonly string[];
  /** Set on child files: the rows of one parent are replaced together. */
  parent?: { column: string; target: 'drill' | 'template' | 'script' };
  unique?: readonly UniqueRule[];
  rowRules?: readonly RowRule[];
  groupRules?: readonly GroupRule[];
  /** Mints the key (for new:<name>) or a blank child id. */
  mint?: MintRule;
  /** The column that names the item, used in warnings and name checks. */
  nameColumn?: string;
  /** Report near-duplicate names ("is this a revision of ...?"). */
  nearDuplicateNames?: boolean;
}

export interface DatasetSpec {
  name: DatasetName;
  title: string;
  folder: string;
  /** Plain English, for the doc: what the material is and how it is versioned. */
  summary: string;
  /** What loads the committed files into the database TODAY, stated as it is, not as planned. */
  loadedToday: string;
  files: readonly FileSpec[];
}

export interface ParsedRow {
  /** Line in the file where the row starts (1 = header). */
  line: number;
  /** Cell text exactly as written, by column. */
  raw: Record<string, string>;
  /** Normalized cell text, by column. */
  values: RowValues;
}

export interface ParsedFile {
  /** Path as the package gave it, '/'-separated. */
  path: string;
  spec: FileSpec;
  header: string[];
  rows: ParsedRow[];
}

export interface ParsedPackage {
  files: ParsedFile[];
}

export interface PackageFileInput {
  /** Relative to the package root, '/'-separated. */
  path: string;
  /** File text. Ignored for media and archives, which are refused by name. */
  text: string;
}

export type FindingCode =
  | 'csv_unreadable'
  | 'column_count'
  | 'duplicate_column'
  | 'unknown_column'
  | 'missing_column'
  | 'unknown_file'
  | 'duplicate_file'
  | 'media_file'
  | 'archive_file'
  | 'missing_required'
  | 'bad_type'
  | 'out_of_range'
  | 'unknown_value'
  | 'bad_id'
  | 'bad_separator'
  | 'duplicate_key'
  | 'duplicate_id'
  | 'duplicate_value'
  | 'orphan_reference'
  | 'minted_id_exists'
  | 'literal_organization'
  | 'literal_account'
  | 'stray_placeholder'
  | 'system_column_set'
  | 'skill_family_in_skill_column'
  | 'scale_rule'
  | 'row_rule';

export interface Finding {
  code: FindingCode;
  file: string;
  line?: number;
  column?: string;
  /** The row's identity, e.g. 'drl_7f812fecacfee4 / 3'. */
  key?: string;
  message: string;
}

export type WarningCode =
  | 'repeated_text'
  | 'near_duplicate_name'
  | 'constant_column'
  | 'adoption_readiness'
  | 'unmapped_skill_code'
  | 'legacy_universal_stop_rule'
  | 'ignored_file';

export interface Warning {
  code: WarningCode;
  file?: string;
  column?: string;
  count?: number;
  samples?: string[];
  message: string;
}

export interface ReferenceSets {
  /** registry claim ids of the LOADED research package. */
  claimIds: ReadonlySet<string>;
  /** SK codes skillFamilies.ts accounts for (mapped or explicitly unmapped). */
  skillCodes: ReadonlySet<string>;
  disciplines: ReadonlySet<string>;
  levelOrdinals: ReadonlySet<number>;
  drills: ReadonlyMap<string, { discipline: string; name: string; skillId: string }>;
  templates: ReadonlySet<string>;
  scripts: ReadonlySet<string>;
  blocks: ReadonlySet<string>;
}
