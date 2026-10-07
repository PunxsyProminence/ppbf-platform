import { adoptionReadiness } from '../../../lib/drillAdoptionReadiness';
import { datasetUnits, unitContentHash, type UnitContent } from './canonical';
import { SKILL_CODE_PATTERN } from './ids';
import { DATASETS } from './specs';
import type { FileSpec, ParsedFile, ParsedPackage, ReferenceSets, RowValues, Warning } from './types';
import { parseBoolean } from './values';

// THE WARNING REPORT. Nothing here ever blocks a hand-off; each warning is
// something a person should look at before the PR merges.
//
// Kept because each one points at a real failure or a real cost, measured on
// the committed files:
//   repeated text      the scale-B demand_description and coach_watch_point
//                      are the same sentence on all 119 drills
//   constant column    cue focus_type is 'external' on 258/258 rows;
//                      scale constraint_applied is blank on 357/357
//   near-duplicate     a renamed drill without its id loads as a NEW drill
//   names              (R2 would then keep both)
//   adoption gaps      a drill that loads cleanly is then refused at Promote
//                      (promote/route.ts:102 runs adoptionReadiness)
//   unmapped SK code   skillFamilies.test.ts:115-133 fails until the code is
//                      listed, so the report names the edit
//   legacy universal   R3: the five boilerplate lines are not universal
// Token-overlap near-duplicate TEXT was in the plan and is not here: it caught
// nothing (CRITIQUE, over_built).

export interface WarningContext {
  references: ReferenceSets;
  baseline?: ParsedPackage;
}

const REPEAT_MIN_LENGTH = 25;
const REPEAT_MIN_ROWS = 5;
const CONSTANT_MIN_ROWS = 5;

function keyOf(spec: FileSpec, values: RowValues): string {
  return spec.key.map((column) => values[column] ?? '').join(' / ');
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
}

function isFreeText(spec: FileSpec, name: string): boolean {
  const column = spec.columns.find((c) => c.name === name);
  return !!column && column.role === 'content' && column.type === 'text' && !column.vocabulary && !column.idKind && !column.list && !column.label;
}

function repeatedText(file: ParsedFile, out: Warning[]): void {
  for (const column of file.spec.columns) {
    if (!isFreeText(file.spec, column.name) || !file.header.includes(column.name)) continue;
    const groups = new Map<string, string[]>();
    for (const row of file.rows) {
      const value = row.values[column.name];
      if (value.length < REPEAT_MIN_LENGTH) continue;
      const list = groups.get(value) ?? [];
      list.push(keyOf(file.spec, row.values));
      groups.set(value, list);
    }
    for (const [value, keys] of groups) {
      if (keys.length < REPEAT_MIN_ROWS) continue;
      out.push({
        code: 'repeated_text',
        file: file.path,
        column: column.name,
        count: keys.length,
        samples: keys.slice(0, 3),
        message: `the same text is in ${keys.length} rows: "${excerpt(value)}"`,
      });
    }
  }
}

function constantColumns(file: ParsedFile, out: Warning[]): void {
  if (file.rows.length < CONSTANT_MIN_ROWS) return;
  for (const column of file.spec.columns) {
    // Structural columns (ids, references, placeholders, system) are
    // constant by design and say nothing about the material.
    if (column.role !== 'content' || !file.header.includes(column.name)) continue;
    const first = file.rows[0].values[column.name];
    if (file.rows.every((row) => row.values[column.name] === first)) {
      out.push({
        code: 'constant_column',
        file: file.path,
        column: column.name,
        count: file.rows.length,
        message: first
          ? `every one of ${file.rows.length} rows says "${excerpt(first)}"`
          : `blank in all ${file.rows.length} rows`,
      });
    }
  }
}

/** Case, punctuation and whitespace do not make a different name. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function namesClose(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Whole-word containment: 'jab' is inside 'jab entry', not inside 'jabber'.
  return ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

function nearDuplicateNames(file: ParsedFile, baseline: ParsedPackage | undefined, out: Warning[]): void {
  const spec = file.spec;
  const nameColumn = spec.nameColumn;
  if (!spec.nearDuplicateNames || !nameColumn) return;

  const effective = new Map<string, { name: string; normalized: string; inPackage: boolean }>();
  for (const row of baseline?.files.find((f) => f.spec === spec)?.rows ?? []) {
    effective.set(keyOf(spec, row.values), { name: row.values[nameColumn], normalized: normalizeName(row.values[nameColumn]), inPackage: false });
  }
  for (const row of file.rows) {
    effective.set(keyOf(spec, row.values), { name: row.values[nameColumn], normalized: normalizeName(row.values[nameColumn]), inPackage: true });
  }

  const entries = [...effective.entries()];
  const reported = new Set<string>();
  for (const [key, entry] of entries) {
    if (!entry.inPackage) continue;
    const matches = entries.filter(
      ([otherKey, other]) => otherKey !== key && namesClose(entry.normalized, other.normalized) && !reported.has(`${otherKey}\u0000${key}`),
    );
    if (matches.length === 0) continue;
    for (const [otherKey] of matches) reported.add(`${key}\u0000${otherKey}`);
    out.push({
      code: 'near_duplicate_name',
      file: file.path,
      column: nameColumn,
      samples: [key, ...matches.map(([otherKey]) => otherKey)].slice(0, 4),
      message: `'${entry.name}' (${key}) is close to ${matches
        .slice(0, 3)
        .map(([otherKey, other]) => `'${other.name}' (${otherKey})`)
        .join(', ')}: is this a revision of ${matches[0][0]}? If so, use that id so it loads as a new version, not a new item.`,
    });
  }
}

function readinessInput(unit: UnitContent) {
  const root = (unit.root ?? {}) as Record<string, string>;
  const scale = (unit.children['seed_drill_scale_levels.csv'] ?? []) as Record<string, string>[];
  const stops = unit.children['seed_drill_stop_rules.csv'] ?? [];
  const cues = (unit.children['seed_drill_cues.csv'] ?? []) as Record<string, string>[];
  return {
    active: true,
    superseded_at: null,
    name: root.name ?? '',
    purpose: root.purpose ?? '',
    discipline: root.discipline ?? '',
    category: root.category ?? '',
    difficulty: root.difficulty ?? '',
    standard_setup: root.standard_setup ?? '',
    execution: root.execution ?? '',
    what_good_looks_like: root.what_good_looks_like ?? '',
    scale_levels: scale.map((row) => ({ scale_level: row.scale_level, is_starting_point: parseBoolean(row.is_starting_point ?? '') === true })),
    // Every row in the drill's own stop-rule file counts, legacy 'universal'
    // ones included (R3: treated as the drill's own). Gym-wide rules from the
    // universal file do NOT make a drill ready on their own.
    stop_rules: [...stops],
    // The cue rule (OD-2026-10-06-026): a technique drill needs one, a
    // conditioning drill (by discipline) does not.
    cues: cues.map((row) => ({ cue_text: row.cue_text ?? '' })),
    // A package is judged before any gym has marked anything: a draft in it
    // will need a coach's floor test before that gym can adopt it.
    field_provenance: root.field_provenance ?? '',
    floor_tested_by_this_gym: false,
  };
}

function adoptionGaps(parsed: ParsedPackage, baseline: ParsedPackage | undefined, out: Warning[]): void {
  const dataset = DATASETS.find((d) => d.name === 'drill-library');
  if (!dataset) return;
  const touched = new Set<string>();
  for (const file of parsed.files) {
    if (file.spec.dataset !== dataset.name) continue;
    const column = file.spec.parent?.column ?? file.spec.key[0];
    for (const row of file.rows) if (row.values[column]) touched.add(row.values[column]);
  }
  if (touched.size === 0) return;

  const before = datasetUnits(dataset, baseline);
  const after = datasetUnits(dataset, baseline, parsed);
  const drillFile = parsed.files.find((file) => file.spec.file === 'seed_drill_library.csv')?.path ?? 'drill-library';

  for (const id of touched) {
    const unit = after.get(id);
    if (!unit?.root) continue; // an orphan child row is already a blocking finding
    const previous = before.get(id);
    const status = !previous?.root ? 'new' : unitContentHash(dataset, previous) !== unitContentHash(dataset, unit) ? 'changed' : null;
    if (!status) continue;
    const readiness = adoptionReadiness(readinessInput(unit));
    if (readiness.ready) continue;
    out.push({
      code: 'adoption_readiness',
      file: drillFile,
      samples: [id],
      message: `${status} drill '${unit.root.name ?? id}' (${id}) would load but could not be adopted by a gym: ${readiness.missing.join(' ')}`,
    });
  }
}

function unmappedSkillCodes(parsed: ParsedPackage, references: ReferenceSets, out: Warning[]): void {
  const codes = new Map<string, { file: string; keys: string[] }>();
  for (const file of parsed.files) {
    for (const column of file.spec.columns) {
      if (column.idKind !== 'skill') continue;
      for (const row of file.rows) {
        const code = row.values[column.name];
        if (!code || !SKILL_CODE_PATTERN.test(code) || references.skillCodes.has(code)) continue;
        const entry = codes.get(code) ?? { file: file.path, keys: [] };
        entry.keys.push(keyOf(file.spec, row.values));
        codes.set(code, entry);
      }
    }
  }
  for (const [code, entry] of codes) {
    out.push({
      code: 'unmapped_skill_code',
      file: entry.file,
      count: entry.keys.length,
      samples: entry.keys.slice(0, 3),
      message:
        `${code} is not in apps/web/src/server/pilot/skillFamilies.ts. Add it to UNMAPPED_SKILL_CODES (or to a family in `
        + 'FAMILY_MEMBER_CODES) in the same PR; skillFamilies.test.ts fails until every seeded code is listed.',
    });
  }
}

function legacyUniversalStopRules(file: ParsedFile, out: Warning[]): void {
  if (file.spec.file !== 'seed_drill_stop_rules.csv') return;
  const universal = file.rows.filter((row) => row.values.scope === 'universal');
  if (universal.length === 0) return;
  out.push({
    code: 'legacy_universal_stop_rule',
    file: file.path,
    column: 'scope',
    count: universal.length,
    samples: universal.slice(0, 3).map((row) => keyOf(file.spec, row.values)),
    message:
      `${universal.length} rows say scope=universal. Each is treated as that drill's own rule (R3); the gym-wide set `
      + 'belongs in seed_universal_stop_rules.csv.',
  });
}

export function computeWarnings(parsed: ParsedPackage, context: WarningContext): Warning[] {
  const out: Warning[] = [];
  for (const file of parsed.files) {
    repeatedText(file, out);
    constantColumns(file, out);
    nearDuplicateNames(file, context.baseline, out);
    legacyUniversalStopRules(file, out);
  }
  adoptionGaps(parsed, context.baseline, out);
  unmappedSkillCodes(parsed, context.references, out);
  return out;
}
