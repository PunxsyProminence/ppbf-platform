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
}

export function rowKey(spec: FileSpec, values: RowValues): string {
  return spec.key.map((column) => values[column] ?? '').join(' / ');
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
      existing.set(row.values[mint.column], file.spec.nameColumn ? row.values[file.spec.nameColumn] : '');
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

// ---------------------------------------------------------------------------
// References

interface Targets {
  known(target: ReferenceTarget, value: string): boolean;
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
  const minted = mintIds(parsed, options.baseline, blocking);

  const warnings = [...parseWarnings, ...computeWarnings(parsed, { references: options.references, baseline: options.baseline })];
  return { blocking, warnings, parsed, minted };
}
