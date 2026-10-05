import { datasetSpec } from './specs';
import type { ColumnSpec, FileSpec } from './types';
import { BOUNDS, VOCABULARIES } from './vocabularies';

// The workout intake prompt: text an organization admin pastes into ANY AI
// assistant together with a workout written in their own words, to get back
// the two CSV files the upload screen (/admin/content-import) loads.
//
// GENERATED FROM THE SPECS, like the contract doc (describe.ts). The header
// lines, the allowed values, the number ranges and the row rules below are
// read from the same objects validate.ts checks an upload against, so the
// prompt cannot ask for something the upload then refuses. aiPrompt.test.ts
// pins that: a package written to this prompt validates with nothing blocking.
//
// THE GYM'S DRILLS ARE THE ONE THING OF A GYM IN IT (OD-2026-10-02-012, Jason
// "A"): "The prompt carries the gym's drill list. Steps link to a drill when it
// clearly matches, use words otherwise, and the AI asks when unsure. Your drill
// names go to the AI you use. No athlete data." The list is handed in by the
// caller, and only through promptDrills(): per drill its lineage key (what an
// item's drill_id names, specs/templates.ts), its name, its primary skill
// code and its own contact_level (a step may not link it at more contact:
// step_contact_above_drill, validate.ts). Nothing else of the library row -- no organization, no account, no
// version id, no coaching text -- can reach the text, because PromptDrill has
// no field for it. Everything else here is still code constants alone: nothing
// read from a session or the environment, no organization, account, template
// id or athlete.
//
// WITH NO DRILLS the prompt is the words-only prompt of item 1 (#1103): every
// drill described in free_text_drill, drill_id left blank.

/** Columns the tool or the session decides. Left out of the prompt's files; a missing one is not a finding. */
const TOOL_DECIDED: readonly ColumnSpec['role'][] = ['system', 'placeholder', 'lineage', 'child_id'];

export const WORKOUT_PROMPT_DATASET = 'workout-templates';

/** One drill as the prompt shows it. These four fields are all of a drill that leaves the app. */
export interface PromptDrill {
  /** The drill's lineage key: the value an item's drill_id names, and the upload checks against the gym's current heads. */
  readonly id: string;
  readonly name: string;
  /** The primary skill code (drill_library.skill_id), or null when the drill has none. */
  readonly skillCode: string | null;
  /** The drill's own contact_level: the most contact a step linking it may carry (step_contact_above_drill). */
  readonly contactLevel: string;
}

/** One line, no separator: a drill's own text can add no line or column to the prompt. \s misses NEL (U+0085). */
function oneLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').replace(/\|/g, '/').trim();
}

/**
 * The ONLY way a library row becomes prompt text: lineage key, name, primary
 * skill code and contact_level are picked by name, so a wider row (listDrillLibrary returns every
 * column of drill_library) carries nothing more into the prompt.
 */
export function promptDrills(
  rows: readonly { lineage_id: string; name: string; skill_id: string | null; contact_level: string }[],
): PromptDrill[] {
  return rows.map((row) => ({
    id: oneLine(row.lineage_id),
    name: oneLine(row.name),
    skillCode: row.skill_id ? oneLine(row.skill_id) : null,
    contactLevel: oneLine(row.contact_level),
  }));
}

/** The columns the assistant is asked to write, in file order. */
export function promptColumns(spec: FileSpec): ColumnSpec[] {
  return spec.columns.filter((column) => !TOOL_DECIDED.includes(column.role));
}

function boundText(column: ColumnSpec): string {
  if (!column.bound) return '';
  const bound: { gt?: number; gte?: number; lte?: number } = BOUNDS[column.bound];
  const low = bound.gte ?? (bound.gt !== undefined ? bound.gt + 1 : undefined);
  if (low !== undefined && bound.lte !== undefined) return `, ${low} to ${bound.lte}`;
  if (low !== undefined) return `, ${low} or more`;
  if (bound.lte !== undefined) return `, ${bound.lte} or less`;
  return '';
}

function allowedText(column: ColumnSpec, linking: boolean): string {
  if (column.role === 'key') {
    return 'new:<short-name> for a new workout (lowercase letters, digits and hyphens, e.g. new:beginner-footwork); '
      + 'the existing id, exactly as given, when I say I am changing a workout that is already loaded';
  }
  if (column.role === 'parent') return `the same ${column.name} as the workout this row belongs to`;
  if (column.references === 'drill') {
    return linking
      ? "the id of one of THE GYM'S DRILLS below, exactly as listed, when the step clearly is that drill; otherwise leave blank"
      : 'leave blank';
  }
  if (column.vocabulary) return `one of: ${VOCABULARIES[column.vocabulary].values.join(', ')}`;
  if (column.type === 'boolean') return 'true or false';
  if (column.type === 'integer') return `a whole number${boundText(column)}`;
  if (column.type === 'number') return `a number${boundText(column)}`;
  return 'text';
}

function columnLine(column: ColumnSpec, linking: boolean): string {
  const head = `- ${column.name} (${column.required ? 'required' : 'optional'}): ${allowedText(column, linking)}.`;
  // The spec's description of drill_id says what MAY go there (a new:<short-name> drill too); the prompt says only what it allows.
  if (column.references === 'drill') return head;
  const blank = column.blankDefault ?? column.blankMeans;
  return `${head} ${column.description}` + (blank ? ` Blank means ${blank}.` : '');
}

function fileSection(spec: FileSpec, number: number, linking: boolean): string[] {
  const columns = promptColumns(spec);
  const rules = [
    ...(spec.unique ?? []).map((rule) => rule.description),
    ...(spec.groupRules ?? []).map((rule) => rule.description),
    ...(spec.rowRules ?? []).map((rule) => rule.description),
  ];
  return [
    `FILE ${number}: ${spec.file}`,
    `One row = ${spec.rowMeaning}.`,
    'Header row, exactly:',
    columns.map((column) => column.name).join(','),
    'Columns:',
    ...columns.map((column) => columnLine(column, linking)),
    ...(rules.length > 0 ? ['Rules:', ...rules.map((rule) => `- ${rule}`)] : []),
    '',
  ];
}

function drillRules(linking: boolean): string[] {
  if (!linking) return ['- Describe every drill in words in free_text_drill and leave drill_id blank.'];
  return [
    "- A step that clearly is one of THE GYM'S DRILLS (listed at the end): put that drill's id in drill_id, exactly",
    '  as listed, and leave free_text_drill blank. Clearly means the document names that drill, or describes it so',
    '  that no other drill on the list could be meant. A shared word alone is not a match. Anything more the',
    '  document says about that step goes in coach_note.',
    '- Any other step: describe it in words in free_text_drill and leave drill_id blank.',
    "- If you are not sure whether a step is one of the gym's drills, or which one, stop and ask me. Do not guess.",
    '  Never write an id that is not on the list.',
    "- A linked step's contact_level is at most its drill's most contact, as listed. From least to most:",
    `  ${VOCABULARIES.contact_level.values.join(', ')}. If the document runs a step at more contact than its`,
    '  drill, do not link it: describe the step in words in free_text_drill and leave drill_id blank.',
  ];
}

function drillList(drills: readonly PromptDrill[]): string[] {
  if (drills.length === 0) return [];
  return [
    "THE GYM'S DRILLS",
    'One line per drill: id | name | main skill code | most contact.',
    ...drills.map((drill) => `- ${drill.id} | ${drill.name} | ${drill.skillCode ?? 'none'} | ${drill.contactLevel}`),
    '',
  ];
}

/**
 * The prompt. `drills` is the gym's list, already narrowed by promptDrills();
 * none (the default) gives the words-only prompt.
 */
export function workoutIntakePrompt(drills: readonly PromptDrill[] = []): string {
  const linking = drills.length > 0;
  const dataset = datasetSpec(WORKOUT_PROMPT_DATASET);
  const fileNames = dataset.files.map((file) => file.file);
  const lines = [
    'You are turning a boxing gym\'s written workout into two CSV files that the gym\'s app loads.',
    'The workout document follows this prompt. It may hold one workout or several.',
    '',
    'WHAT TO DO',
    `1. Read the document. Each workout becomes one row in ${fileNames[0]} and one row per step in ${fileNames[1]}.`,
    '2. Use only what the document says. Do not add drills, numbers or notes of your own.',
    '3. If a REQUIRED value is not in the document, or you cannot tell which allowed value fits, stop and ask me.',
    '   Do not guess. An optional value the document does not give is left blank.',
    '4. Leave out the names of athletes and any personal details. A workout here is a reusable plan, not a record',
    '   of a person.',
    '5. When nothing is missing, answer with the two files and nothing else: each in its own code block, with its',
    '   file name on the line above.',
    '',
    'RULES FOR BOTH FILES',
    '- CSV, UTF-8, comma between cells, the header row exactly as written below, one row per line.',
    '- Put double quotes around any cell that holds a comma, a double quote or a line break; write a double quote',
    '  inside a quoted cell as two double quotes.',
    '- Every row has exactly as many cells as the header. A blank cell is two commas with nothing between them.',
    '- No other columns. No text containing {{ anywhere.',
    ...drillRules(linking),
    '- A step with contact above light_technical has no duration_minutes and no rep_count: write its rounds or',
    '  time, as the document gives them, in coach_note.',
    '',
    ...dataset.files.flatMap((file, index) => fileSection(file, index + 1, linking)),
    ...drillList(drills),
    'THE WORKOUT DOCUMENT:',
  ];
  return `${lines.join('\n')}\n`;
}
