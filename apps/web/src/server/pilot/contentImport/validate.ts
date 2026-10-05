import { readCsv } from './csv';
import {
  idPattern,
  idShapeText,
  INLINE_CLAIM_TAG_PATTERN,
  type IdKind,
  isNewId,
  NEW_ID_PATTERN,
  SKILL_FAMILY_PREFIX,
} from './ids';
import { FILE_SPECS, fileSpecByName, UNIVERSAL_SYSTEM_COLUMNS } from './specs';
import {
  type ColumnSpec,
  type FileSpec,
  type Finding,
  type FindingCode,
  ORG_PLACEHOLDER,
  type PackageFileInput,
  type ParsedFile,
  type ParsedPackage,
  type ParsedRow,
  type ReferenceSets,
  type ReferenceTarget,
  type RowContext,
  type RowValues,
  type Warning,
} from './types';
import { integerText, isIntegerText, isNumberText, normalizeCell, parseBoolean, splitList } from './values';
import { BOUNDS, VOCABULARIES } from './vocabularies';
import { computeWarnings } from './warnings';

// STAGES 1 AND 2 OF THE CONTENT-IMPORT CORE: PARSE AND VALIDATE.
//
// PURE. No database, no environment, no disk: the caller hands in file names
// and text (the CLI reads a folder; the later upload route reads a request
// body) plus the reference sets to check against. That seam is what lets R1's
// "later" route reuse this exact code (plan, architecture section, THE SEAM).
//
// BLOCKING vs WARNING. A blocking finding is something the database would
// refuse, something that would load wrong without any error, or something
// that must never enter the public repository. Everything that is merely
// worth a second look -- boilerplate text, a name close to another -- is a
// warning and never stops a hand-off.

/** Video, stills and audio. The repository is public; teaching footage goes in through Teach Shadow upload. */
export const MEDIA_EXTENSIONS = [
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.3gp', '.mts',
  '.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.bmp', '.tif', '.tiff', '.svg',
  '.raw', '.dng', '.cr2', '.nef', '.arw',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
] as const;

/** An archive could carry media past the extension check, so a package arrives unpacked. */
export const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'] as const;

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export interface ValidateOptions {
  references: ReferenceSets;
  /**
   * The committed content this package would be merged into. Used for name
   * uniqueness across package and committed items, for minted-id collisions,
   * and to tell new and changed items from unchanged ones.
   */
  baseline?: ParsedPackage;
}

export type MintedIds = Map<IdKind, Map<string, string>>;

export interface ValidationResult {
  blocking: Finding[];
  warnings: Warning[];
  parsed: ParsedPackage;
  /** new:<short-name> -> minted id, by the kind of item. */
  minted: MintedIds;
  /**
   * The id a BLANK key takes, by package row, for files whose key is a child
   * id the tool fills (transfer claims). prepare writes exactly these.
   */
  blankKeyIds: Map<ParsedRow, string>;
}

export function rowKey(spec: FileSpec, values: RowValues): string {
  return spec.key.map((column) => values[column] ?? '').join(' / ');
}

/** The kind of item a new:<short-name> in this column names, or undefined if the column takes no new: ids. */
export function newIdKindOf(spec: FileSpec, column: ColumnSpec): IdKind | undefined {
  // lineage_id must equal the key (checkCell), so a new: lineage is the key's new: id.
  if (column.role === 'key' || column.role === 'lineage') return spec.mint?.idKind;
  if (column.allowNew) return column.idKind;
  return undefined;
}

// ---------------------------------------------------------------------------
// Parse

/**
 * Parse one file against its spec. Header problems are findings, not
 * exceptions, so one bad file does not hide the problems in the others.
 */
export function parseFile(path: string, spec: FileSpec, text: string): { file: ParsedFile; findings: Finding[] } {
  const findings: Finding[] = [];
  const table = readCsv(text);
  for (const problem of table.problems) {
    findings.push({
      code: problem.kind === 'column_count' ? 'column_count' : 'csv_unreadable',
      file: path,
      line: problem.line,
      message: problem.message,
    });
  }

  const known = new Set(spec.columns.map((column) => column.name));
  const allowedSystem = new Set<string>(UNIVERSAL_SYSTEM_COLUMNS);
  const seen = new Set<string>();
  for (const name of table.header) {
    if (seen.has(name)) {
      findings.push({ code: 'duplicate_column', file: path, line: 1, column: name, message: `column ${name} appears twice in the header` });
    }
    seen.add(name);
    if (!known.has(name) && !allowedSystem.has(name)) {
      findings.push({
        code: 'unknown_column',
        file: path,
        line: 1,
        column: name,
        message: `column ${name} is not part of ${spec.file}; its values would be dropped without a word. Allowed: ${spec.columns.map((c) => c.name).join(', ')}`,
      });
    }
  }
  if (table.header.length > 0) {
    for (const column of spec.columns) {
      if (column.required && !seen.has(column.name)) {
        findings.push({ code: 'missing_column', file: path, line: 1, column: column.name, message: `required column ${column.name} is missing from the header` });
      }
    }
  }

  const rows: ParsedRow[] = table.records.map((record) => {
    const raw: Record<string, string> = {};
    table.header.forEach((name, index) => {
      if (!(name in raw)) raw[name] = record.cells[index] ?? '';
    });
    const values: Record<string, string> = {};
    for (const column of spec.columns) values[column.name] = normalizeCell(raw[column.name]);
    for (const name of UNIVERSAL_SYSTEM_COLUMNS) {
      if (name in raw) values[name] = normalizeCell(raw[name]);
    }
    return { line: record.line, raw, values };
  });

  return { file: { path, spec, header: table.header, rows }, findings };
}

/**
 * Sort the package's files: CSVs named in the contract are parsed, media and
 * archives are refused, anything else is reported.
 */
export function parsePackage(inputs: readonly PackageFileInput[]): {
  parsed: ParsedPackage;
  findings: Finding[];
  warnings: Warning[];
} {
  const findings: Finding[] = [];
  const warnings: Warning[] = [];
  const files: ParsedFile[] = [];
  const bySpec = new Map<FileSpec, string>();

  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    const ext = extensionOf(input.path);
    if ((MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
      findings.push({
        code: 'media_file',
        file: input.path,
        message:
          'video, photos and audio never go in a content package: the repository is public. Teaching footage and stills go in through Teach Shadow upload.',
      });
      continue;
    }
    if ((ARCHIVE_EXTENSIONS as readonly string[]).includes(ext)) {
      findings.push({ code: 'archive_file', file: input.path, message: 'unpack the archive; a package is plain CSV files, and an archive could carry media past this check' });
      continue;
    }
    const spec = fileSpecByName(baseName(input.path));
    if (!spec) {
      if (ext === '.csv') {
        findings.push({
          code: 'unknown_file',
          file: input.path,
          message: `${baseName(input.path)} is not a file the contract knows, so nothing in it would load. Known files: ${FILE_SPECS.map((s) => s.file).join(', ')}`,
        });
      } else {
        warnings.push({ code: 'ignored_file', file: input.path, message: 'not a CSV the contract knows; ignored' });
      }
      continue;
    }
    const earlier = bySpec.get(spec);
    if (earlier) {
      findings.push({ code: 'duplicate_file', file: input.path, message: `${spec.file} appears twice (also ${earlier}); keep one` });
      continue;
    }
    bySpec.set(spec, input.path);
    const result = parseFile(input.path, spec, input.text);
    files.push(result.file);
    findings.push(...result.findings);
  }

  return { parsed: { files }, findings, warnings };
}

// ---------------------------------------------------------------------------
// Cells

function finding(file: ParsedFile, row: ParsedRow, column: string | undefined, code: FindingCode, message: string): Finding {
  return { code, file: file.path, line: row.line, column, key: rowKey(file.spec, row.values) || undefined, message };
}

function boundProblem(column: ColumnSpec, value: number): string | null {
  if (!column.bound) return null;
  const bound: { gt?: number; gte?: number; lte?: number } = BOUNDS[column.bound];
  if (bound.gt !== undefined && !(value > bound.gt)) return `must be above ${bound.gt}`;
  if (bound.gte !== undefined && value < bound.gte) return `must be ${bound.gte} or more`;
  if (bound.lte !== undefined && value > bound.lte) return `must be ${bound.lte} or less`;
  return null;
}

function checkItem(file: ParsedFile, row: ParsedRow, column: ColumnSpec, item: string, out: Finding[]): void {
  if (column.vocabulary) {
    const allowed: readonly string[] = VOCABULARIES[column.vocabulary].values;
    if (!allowed.includes(item)) {
      out.push(finding(file, row, column.name, 'unknown_value', `'${item}' is not allowed. Allowed: ${allowed.join(' | ')}`));
    }
  }
  if (column.idKind) {
    if (column.allowNew && isNewId(item)) {
      if (!NEW_ID_PATTERN.test(item)) {
        out.push(finding(file, row, column.name, 'bad_id', `'${item}' is not a valid new id: new: then lowercase letters, digits and hyphens`));
      }
    } else if (column.idKind === 'skill' && SKILL_FAMILY_PREFIX.test(item)) {
      out.push(
        finding(
          file,
          row,
          column.name,
          'skill_family_in_skill_column',
          `${item} is a skill FAMILY id; a skill column holds an SK- code. Families are derived in skillFamilies.ts (owner decision D2-B).`,
        ),
      );
    } else if (!idPattern(column.idKind).test(item)) {
      out.push(finding(file, row, column.name, 'bad_id', `'${item}' has the wrong shape; expected ${idShapeText(column.idKind)}`));
    }
  }
}

function checkCell(file: ParsedFile, row: ParsedRow, column: ColumnSpec, out: Finding[]): void {
  const value = row.values[column.name] ?? '';

  if (column.role === 'placeholder') {
    if (!value || value === column.placeholder) return;
    if (value.includes('{{')) {
      out.push(finding(file, row, column.name, 'stray_placeholder', `only ${column.placeholder} (or blank) is allowed here`));
    } else if (column.placeholder === ORG_PLACEHOLDER) {
      out.push(finding(file, row, column.name, 'literal_organization', `a real organization id ('${value}') is refused; write ${ORG_PLACEHOLDER} or leave it blank`));
    } else {
      out.push(finding(file, row, column.name, 'literal_account', `a real account id ('${value}') is refused; write ${column.placeholder} or leave it blank`));
    }
    return;
  }

  if (value.includes('{{')) {
    out.push(finding(file, row, column.name, 'stray_placeholder', "'{{' is only allowed as {{PPBF_ORG_ID}} in organization_id or {{SEED_ACCOUNT_ID}} in created_by_account_id"));
    return;
  }

  if (column.role === 'system') {
    if (!value) return;
    const fallback = column.systemDefault;
    const matches = fallback !== undefined
      && (column.type === 'boolean'
        ? value.toLowerCase() === fallback
        : value === fallback || (isIntegerText(value) && integerText(value) === fallback));
    if (!matches) {
      out.push(
        finding(
          file,
          row,
          column.name,
          'system_column_set',
          fallback ? `${column.name} is decided by the tool; leave it blank or ${fallback}, not '${value}'` : `${column.name} is decided by the tool; leave it blank`,
        ),
      );
    }
    return;
  }

  if (column.role === 'lineage') {
    const key = row.values[file.spec.key[0]] ?? '';
    if (value && value !== key) {
      out.push(finding(file, row, column.name, 'system_column_set', `lineage_id must be blank or equal ${file.spec.key[0]} ('${key}'), not '${value}'`));
    }
    return;
  }

  if (!value) {
    if (column.required) out.push(finding(file, row, column.name, 'missing_required', `${column.name} is required`));
    return;
  }

  if (column.type === 'boolean' && parseBoolean(value) === null) {
    out.push(finding(file, row, column.name, 'bad_type', `'${value}' is not true or false`));
    return;
  }
  if (column.type === 'integer' || column.type === 'number') {
    const ok = column.type === 'integer' ? isIntegerText(value) : isNumberText(value);
    if (!ok) {
      out.push(finding(file, row, column.name, 'bad_type', `'${value}' is not a ${column.type === 'integer' ? 'whole number' : 'number'}`));
      return;
    }
    const problem = boundProblem(column, Number(value));
    if (problem) out.push(finding(file, row, column.name, 'out_of_range', `${value} ${problem}`));
    return;
  }

  if (column.list) {
    const wrong = column.list === '|' ? /[;,]/ : /[|;]/;
    if (wrong.test(value)) {
      out.push(
        finding(
          file,
          row,
          column.name,
          'bad_separator',
          column.list === '|'
            ? `separate items with | only ('${value}')`
            : `this column keeps its stored ',' separator; use ',' only ('${value}')`,
        ),
      );
      return;
    }
    for (const item of splitList(value, column.list)) checkItem(file, row, column, item, out);
    return;
  }

  checkItem(file, row, column, value, out);
}

function checkCells(file: ParsedFile, out: Finding[]): void {
  for (const row of file.rows) {
    for (const column of file.spec.columns) checkCell(file, row, column, out);
    for (const name of UNIVERSAL_SYSTEM_COLUMNS) {
      if (row.values[name]) {
        out.push(finding(file, row, name, 'system_column_set', `${name} is written by the loader; leave it blank`));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Keys, names and minted ids

function checkKeys(file: ParsedFile, out: Finding[]): void {
  const firstLine = new Map<string, number>();
  for (const row of file.rows) {
    if (file.spec.key.some((column) => !row.values[column])) continue;
    const key = rowKey(file.spec, row.values);
    const earlier = firstLine.get(key);
    if (earlier !== undefined) {
      out.push(finding(file, row, file.spec.key.join(', '), 'duplicate_key', `(${file.spec.key.join(', ')}) = (${key}) already appears on line ${earlier}`));
    } else {
      firstLine.set(key, row.line);
    }
  }

  // A child id that is not part of the key (scale_id, cue_id, ...) must also
  // be unique: it is the table's primary key.
  const mintColumn = file.spec.mint?.column;
  if (mintColumn && !file.spec.key.includes(mintColumn)) {
    const seen = new Map<string, number>();
    for (const row of file.rows) {
      const id = row.values[mintColumn];
      if (!id) continue;
      const earlier = seen.get(id);
      if (earlier !== undefined) {
        out.push(finding(file, row, mintColumn, 'duplicate_id', `${id} already appears on line ${earlier}`));
      } else {
        seen.set(id, row.line);
      }
    }
  }
}

function baselineFile(baseline: ParsedPackage | undefined, spec: FileSpec): ParsedFile | undefined {
  return baseline?.files.find((file) => file.spec === spec);
}

function checkUnique(file: ParsedFile, baseline: ParsedPackage | undefined, out: Finding[]): void {
  for (const rule of file.spec.unique ?? []) {
    const effective = new Map<string, { values: RowValues; row?: ParsedRow }>();
    for (const row of baselineFile(baseline, file.spec)?.rows ?? []) {
      effective.set(rowKey(file.spec, row.values), { values: row.values });
    }
    for (const row of file.rows) effective.set(rowKey(file.spec, row.values), { values: row.values, row });

    const groups = new Map<string, { key: string; row?: ParsedRow }[]>();
    for (const [key, entry] of effective) {
      const parts = rule.columns.map((column) => entry.values[column] ?? '');
      if (parts.some((part) => !part)) continue;
      const group = parts.join('\u0000');
      const list = groups.get(group) ?? [];
      list.push({ key, row: entry.row });
      groups.set(group, list);
    }

    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const member of members) {
        if (!member.row) continue;
        const others = members.filter((other) => other !== member).map((other) => other.key);
        out.push(
          finding(
            file,
            member.row,
            rule.columns.join(', '),
            'duplicate_value',
            `${rule.columns.map((column) => `${column} '${member.row?.values[column]}'`).join(', ')} is also used by ${others.join(', ')}. ${rule.description}`,
          ),
        );
      }
    }
  }
}

function mintIds(parsed: ParsedPackage, baseline: ParsedPackage | undefined, out: Finding[]): MintedIds {
  const minted: MintedIds = new Map();
  for (const file of parsed.files) {
    const mint = file.spec.mint;
    if (!mint || !file.spec.key.includes(mint.column)) continue;
    const keyColumn = file.spec.columns.find((column) => column.name === mint.column);
    if (!keyColumn?.allowNew) continue;

    const existing = new Map<string, string>();
    for (const row of baselineFile(baseline, file.spec)?.rows ?? []) {
      // A database baseline blanks the name of a row that does not hold it (a
      // withdrawn template, datasets/templateScriptVersions.ts readBaseline)
      // and keeps it in raw, so the message can still name the item.
      const name = file.spec.nameColumn ? row.values[file.spec.nameColumn] || row.raw[file.spec.nameColumn] || '' : '';
      existing.set(row.values[mint.column], name);
    }

    const byKind = minted.get(mint.idKind) ?? new Map<string, string>();
    minted.set(mint.idKind, byKind);
    const mintedBy = new Map<string, string>();

    for (const row of file.rows) {
      const newId = row.values[mint.column];
      if (!isNewId(newId) || !NEW_ID_PATTERN.test(newId)) continue;
      const id = mint.mint(row.values);
      byKind.set(newId, id);
      if (existing.has(id)) {
        const name = existing.get(id);
        out.push(
          finding(
            file,
            row,
            mint.column,
            'minted_id_exists',
            `${newId} mints ${id}, which is already the committed item${name ? ` '${name}'` : ''}. To revise that item keep its id instead of new:; to add a different item give it a different name.`,
          ),
        );
      }
      const other = mintedBy.get(id);
      if (other) {
        out.push(finding(file, row, mint.column, 'minted_id_exists', `${newId} mints ${id}, the same id as ${other}; the two rows describe the same item`));
      } else {
        mintedBy.set(id, newId);
      }
    }
  }
  return minted;
}

/** The row with each new:<short-name> reference replaced by its minted id; unresolved ones are left (they are orphans). */
function withNewIdsResolved(spec: FileSpec, values: RowValues, minted: MintedIds): Record<string, string> {
  const cells: Record<string, string> = { ...values };
  for (const column of spec.columns) {
    const value = cells[column.name];
    if (!value || !isNewId(value)) continue;
    const kind = newIdKindOf(spec, column);
    const id = kind ? minted.get(kind)?.get(value) : undefined;
    if (id) cells[column.name] = id;
  }
  return cells;
}

/**
 * A BLANK KEY THAT IS A CHILD ID -- transfer_id, the only one today. Every
 * other child file finds an existing row by the rest of its key (drill +
 * scale_level) and keeps its id; here the id IS the key, so a blank one has no
 * key to compare. Without this, two blank rows describing the same claim minted
 * the same id and prepare kept only the second, and a blank-id re-send of a
 * committed claim was added beside it (review S1).
 *
 * The rest of the identity is what the formula reads (target, claim_kind,
 * statement): a blank row takes the id of the committed row whose content mints
 * the same id -- the same claim -- and otherwise the minted id. Refused: the
 * minted id already names a committed claim whose words have since changed
 * (that is a different claim now), and two rows that come to the same id.
 */
function resolveBlankKeys(parsed: ParsedPackage, baseline: ParsedPackage | undefined, minted: MintedIds, out: Finding[]): Map<ParsedRow, string> {
  const resolved = new Map<ParsedRow, string>();
  for (const file of parsed.files) {
    const mint = file.spec.mint;
    const keyColumn = file.spec.columns.find((column) => column.name === file.spec.key[0]);
    if (!mint || file.spec.key.length !== 1 || keyColumn?.name !== mint.column || keyColumn.role !== 'child_id') continue;

    const committedIds = new Set<string>();
    const byContent = new Map<string, string[]>();
    for (const row of baselineFile(baseline, file.spec)?.rows ?? []) {
      const id = row.values[mint.column];
      if (!id) continue;
      committedIds.add(id);
      const contentId = mint.mint(row.values);
      byContent.set(contentId, [...(byContent.get(contentId) ?? []), id]);
    }

    const lineOf = new Map<string, number>();
    for (const row of file.rows) {
      const id = row.values[mint.column];
      if (id && !lineOf.has(id)) lineOf.set(id, row.line);
    }

    for (const row of file.rows) {
      if (row.values[mint.column]) continue;
      const contentId = mint.mint(withNewIdsResolved(file.spec, row.values, minted));
      const matches = byContent.get(contentId) ?? [];
      if (matches.length > 1) {
        out.push(finding(file, row, mint.column, 'duplicate_key', `has the same content as committed ${matches.join(', ')}; write the ${mint.column} you mean`));
        continue;
      }
      const id = matches[0] ?? contentId;
      if (matches.length === 0 && committedIds.has(id)) {
        out.push(
          finding(
            file,
            row,
            mint.column,
            'minted_id_exists',
            `a blank ${mint.column} mints ${id}, which is already a committed row whose content has since changed. To revise that row write its ${mint.column}; to add a new one, change what the id is made from.`,
          ),
        );
        continue;
      }
      const earlier = lineOf.get(id);
      if (earlier !== undefined) {
        out.push(finding(file, row, mint.column, 'duplicate_key', `a blank ${mint.column} comes to ${id}, the same row as line ${earlier}`));
        continue;
      }
      lineOf.set(id, row.line);
      resolved.set(row, id);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// References

/** The contact ladder, lowest to highest (the vocabulary's order; athleteContactCaps.ts ranks by it too). */
const CONTACT_LADDER: readonly string[] = VOCABULARIES.contact_level.values;

interface Targets {
  known(target: ReferenceTarget, value: string): boolean;
  /** A committed drill (not one in this package) whose current version is withdrawn. */
  withdrawnDrill(lineage: string): boolean;
  /**
   * The linked drill's own contact_level: the package's drill row when the
   * package carries the drill, otherwise the committed one. undefined when
   * unknown or not on the ladder (that has its own finding).
   */
  drillContactLevel(lineage: string): string | undefined;
  describe(target: ReferenceTarget): string;
}

function buildTargets(parsed: ParsedPackage, references: ReferenceSets): Targets {
  const packageKeys = (file: string, column: string) =>
    new Set(parsed.files.find((f) => f.spec.file === file)?.rows.map((row) => row.values[column]).filter(Boolean) ?? []);

  const disciplines = packageKeys('seed_disciplines.csv', 'discipline');
  const ordinals = new Set(
    [...packageKeys('seed_competence_levels.csv', 'ordinal')].filter(isIntegerText).map((value) => Number(integerText(value))),
  );
  const drills = packageKeys('seed_drill_library.csv', 'drill_id');
  const packageDrillContact = new Map<string, string>();
  for (const row of parsed.files.find((f) => f.spec.file === 'seed_drill_library.csv')?.rows ?? []) {
    const id = row.values.drill_id;
    // A repeated drill_id is duplicate_id; the first row stands here.
    if (id && !packageDrillContact.has(id)) packageDrillContact.set(id, row.values.contact_level ?? '');
  }
  const templates = packageKeys('seed_workout_templates.csv', 'template_id');
  const scripts = packageKeys('seed_session_scripts.csv', 'script_id');
  const blocks = packageKeys('seed_session_script_blocks.csv', 'block_id');

  return {
    known(target, value) {
      switch (target) {
        case 'discipline':
          return disciplines.has(value) || references.disciplines.has(value);
        case 'level_ordinal':
          return isIntegerText(value)
            && (ordinals.has(Number(integerText(value))) || references.levelOrdinals.has(Number(integerText(value))));
        case 'drill':
          return drills.has(value) || (!isNewId(value) && references.drills.has(value));
        case 'template':
          return templates.has(value) || (!isNewId(value) && references.templates.has(value));
        case 'script':
          return scripts.has(value) || (!isNewId(value) && references.scripts.has(value));
        case 'block':
          return blocks.has(value) || references.blocks.has(value);
        case 'claim':
          return references.claimIds.has(value);
        case 'skill':
          return true; // an SK code outside skillFamilies.ts is a warning (warnings.ts), not an orphan
        default:
          return false;
      }
    },
    withdrawnDrill(lineage) {
      // A drill in the package is judged by the package (its own active
      // column); only a committed drill the package does not carry is read
      // from the reference set.
      if (drills.has(lineage) || isNewId(lineage)) return false;
      return references.drills.get(lineage)?.active === false;
    },
    drillContactLevel(lineage) {
      const level = packageDrillContact.has(lineage)
        ? packageDrillContact.get(lineage)
        : isNewId(lineage) ? undefined : references.drills.get(lineage)?.contactLevel;
      // Blank is never a valid drill contact_level offline (it is required on
      // a drill row, missing_required); a committed one is never blank.
      return level && CONTACT_LADDER.includes(level) ? level : undefined;
    },
    describe(target) {
      switch (target) {
        case 'claim':
          return 'the loaded research package (shadow-research/2026-08-07)';
        case 'level_ordinal':
          return 'the competence levels in this package or the committed ones';
        default:
          return `this package or the committed ${target === 'discipline' ? 'disciplines' : `${target}s`}`;
      }
    },
  };
}

function checkReferences(file: ParsedFile, targets: Targets, out: Finding[]): void {
  for (const row of file.rows) {
    for (const column of file.spec.columns) {
      const value = row.values[column.name];
      if (!value) continue;

      if (column.references) {
        const items = column.list ? splitList(value, column.list) : [value];
        for (const item of items) {
          // A malformed value already has its own finding; do not stack an orphan on it.
          if (column.idKind && !(column.allowNew && isNewId(item)) && !idPattern(column.idKind).test(item)) continue;
          if (column.type === 'integer' && !isIntegerText(item)) continue;
          if (!targets.known(column.references, item)) {
            out.push(finding(file, row, column.name, 'orphan_reference', `${column.references} '${item}' is in neither ${targets.describe(column.references)}`));
            continue;
          }
          // A step that LINKS a drill (templates, scripts: role 'reference')
          // may not name a withdrawn one. The AI workout prompt lists only the
          // gym's active current drills (OD-2026-10-03-002 section 7), so the
          // upload refuses what the prompt would never offer. A withdrawn
          // head is still the head of its lineage (lineage.ts), so a drill
          // package revising it names it in a 'parent' column, which this does
          // not touch.
          if (column.references === 'drill' && column.role === 'reference' && targets.withdrawnDrill(item)) {
            out.push(finding(
              file,
              row,
              column.name,
              'withdrawn_drill',
              `drill '${item}' is withdrawn (its current version is inactive), so a step cannot link it. `
              + 'Write the step in words (free_text_drill), or restore the drill first.',
            ));
          }
          // A step may not run a linked drill at more contact than the drill
          // itself involves (its contact_level: "the most contact the drill
          // involves", specs/drills.ts). The step's blank is 'none', its
          // column default. An unknown value on either side already has its
          // own finding and is not compared. PR #1208's design; Build List
          // row from PR #1114's reviewer.
          // Only the files whose step carries contact (template items, script
          // blocks); a transfer claim's drill_id has no contact of its own.
          if (column.references === 'drill' && column.role === 'reference' && file.spec.columns.some((c) => c.name === 'contact_level')) {
            const step = row.values.contact_level || 'none';
            const drill = targets.drillContactLevel(item);
            if (drill !== undefined && CONTACT_LADDER.includes(step) && CONTACT_LADDER.indexOf(step) > CONTACT_LADDER.indexOf(drill)) {
              out.push(finding(
                file,
                row,
                'contact_level',
                'step_contact_above_drill',
                `contact_level ${step} is above the linked drill's own contact_level (drill '${item}' is ${drill}), so the step cannot link it at that contact. `
                + `Lower the step to ${drill} or less, link a drill at that contact, or write the step in words (free_text_drill).`,
              ));
            }
          }
        }
      }

      // Inline claim tags in prose ("... [A2-070]") are citations too, and
      // must name a claim that is actually loaded.
      if (column.role === 'content' && column.type === 'text' && !column.vocabulary && !column.idKind) {
        for (const match of value.matchAll(INLINE_CLAIM_TAG_PATTERN)) {
          if (!targets.known('claim', match[1])) {
            out.push(finding(file, row, column.name, 'orphan_reference', `inline tag [${match[1]}] is not a claim in ${targets.describe('claim')}`));
          }
        }
      }
    }
  }
}

// The same rule as step_contact_above_drill, from the drill's side: a drill
// revision may not lower contact_level beneath a committed step that links
// its lineage, or that step ends up above its drill. A step whose template or
// script the package also carries is the package's (checkReferences judges
// it), so only the others are compared. At plan only (committedSteps).
function checkDrillsAgainstCommittedSteps(parsed: ParsedPackage, references: ReferenceSets, out: Finding[]): void {
  if (!references.committedSteps) return;
  const parents = new Set<string>();
  for (const [file, column] of [
    ['seed_workout_templates.csv', 'template_id'],
    ['seed_workout_template_items.csv', 'template_id'],
    ['seed_session_scripts.csv', 'script_id'],
    ['seed_session_script_blocks.csv', 'script_id'],
  ] as const) {
    for (const row of parsed.files.find((f) => f.spec.file === file)?.rows ?? []) if (row.values[column]) parents.add(row.values[column]);
  }
  const drillFile = parsed.files.find((f) => f.spec.file === 'seed_drill_library.csv');
  for (const row of drillFile?.rows ?? []) {
    const lineage = row.values.drill_id;
    const level = row.values.contact_level;
    if (!lineage || isNewId(lineage) || !CONTACT_LADDER.includes(level)) continue;
    const above = (references.committedSteps.get(lineage) ?? []).filter(
      (step) => !parents.has(step.parent) && CONTACT_LADDER.indexOf(step.contactLevel) > CONTACT_LADDER.indexOf(level),
    );
    if (above.length === 0) continue;
    const named = above.slice(0, 5).map((step) => `${step.parent} / ${step.position} (${step.contactLevel})`).join(', ');
    out.push(finding(
      drillFile!,
      row,
      'contact_level',
      'drill_contact_below_steps',
      `contact_level ${level} is below ${above.length} committed step${above.length === 1 ? '' : 's'} linking drill '${lineage}': `
      + `${named}${above.length > 5 ? ', ...' : ''}. Keep the drill's contact_level, or bring those steps in this package at ${level} or less.`,
    ));
  }
}

// ---------------------------------------------------------------------------
// Row and group rules

function rowContext(parsed: ParsedPackage, references: ReferenceSets): RowContext {
  const drills = new Map(
    parsed.files.find((file) => file.spec.file === 'seed_drill_library.csv')?.rows.map((row) => [row.values.drill_id, row.values.skill_id]) ?? [],
  );
  return {
    drillPrimarySkill(drillId) {
      if (drills.has(drillId)) return drills.get(drillId) ?? '';
      return references.drills.get(drillId)?.skillId;
    },
  };
}

function checkRules(file: ParsedFile, context: RowContext, out: Finding[]): void {
  for (const rule of file.spec.rowRules ?? []) {
    for (const row of file.rows) {
      const problem = rule.check(row.values, context);
      if (problem) out.push(finding(file, row, undefined, 'row_rule', problem));
    }
  }

  const parent = file.spec.parent;
  if (!parent || !file.spec.groupRules?.length) return;
  const groups = new Map<string, ParsedRow[]>();
  for (const row of file.rows) {
    const id = row.values[parent.column];
    if (!id) continue;
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  for (const rule of file.spec.groupRules) {
    for (const [id, rows] of groups) {
      const problem = rule.check(rows.map((row) => row.values));
      if (problem) {
        out.push({ code: rule.code ?? 'row_rule', file: file.path, line: rows[0].line, column: parent.column, key: id, message: `${parent.target} ${id} ${problem}` });
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function validatePackage(inputs: readonly PackageFileInput[], options: ValidateOptions): ValidationResult {
  const { parsed, findings, warnings } = parsePackage(inputs);
  return validateParsed(parsed, options, findings, warnings);
}

/** Validate an already-parsed package (prepare re-validates its merged result this way). */
export function validateParsed(
  parsed: ParsedPackage,
  options: ValidateOptions,
  parseFindings: Finding[] = [],
  parseWarnings: Warning[] = [],
): ValidationResult {
  const blocking = [...parseFindings];
  const targets = buildTargets(parsed, options.references);
  const context = rowContext(parsed, options.references);

  for (const file of parsed.files) {
    checkCells(file, blocking);
    checkKeys(file, blocking);
    checkUnique(file, options.baseline, blocking);
    checkReferences(file, targets, blocking);
    checkRules(file, context, blocking);
  }
  checkDrillsAgainstCommittedSteps(parsed, options.references, blocking);
  const minted = mintIds(parsed, options.baseline, blocking);
  const blankKeyIds = resolveBlankKeys(parsed, options.baseline, minted, blocking);

  const warnings = [...parseWarnings, ...computeWarnings(parsed, { references: options.references, baseline: options.baseline })];
  return { blocking, warnings, parsed, minted, blankKeyIds };
}
