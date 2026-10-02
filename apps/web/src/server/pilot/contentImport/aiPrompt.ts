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
// WHAT IS NOT IN IT, on purpose: nothing read from a database, a session or
// the environment. No organization, no account, no drill or template id of
// this gym, no athlete. It is the same text for every gym, built from code
// constants alone, because it is handed to a third party.
//
// DRILLS ARE WORDS. An item may name a drill of the gym's library by id, but
// the prompt carries no drill list, so it tells the assistant to describe each
// drill in free_text_drill and leave drill_id blank -- which the item file's
// own row rule already allows. Linking items to library drills is a later,
// separate decision of the owner's.

/** Columns the tool or the session decides. Left out of the prompt's files; a missing one is not a finding. */
const TOOL_DECIDED: readonly ColumnSpec['role'][] = ['system', 'placeholder', 'lineage', 'child_id'];

export const WORKOUT_PROMPT_DATASET = 'workout-templates';

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

function allowedText(column: ColumnSpec): string {
  if (column.role === 'key') {
    return 'new:<short-name> for a new workout (lowercase letters, digits and hyphens, e.g. new:beginner-footwork); '
      + 'the existing id, exactly as given, when I say I am changing a workout that is already loaded';
  }
  if (column.role === 'parent') return `the same ${column.name} as the workout this row belongs to`;
  if (column.references === 'drill') return 'leave blank';
  if (column.vocabulary) return `one of: ${VOCABULARIES[column.vocabulary].values.join(', ')}`;
  if (column.type === 'boolean') return 'true or false';
  if (column.type === 'integer') return `a whole number${boundText(column)}`;
  if (column.type === 'number') return `a number${boundText(column)}`;
  return 'text';
}

function columnLine(column: ColumnSpec): string {
  const head = `- ${column.name} (${column.required ? 'required' : 'optional'}): ${allowedText(column)}.`;
  // The spec's description of drill_id says what MAY go there; the prompt says to leave it blank, and nothing else.
  if (column.references === 'drill') return head;
  const blank = column.blankDefault ?? column.blankMeans;
  return `${head} ${column.description}` + (blank ? ` Blank means ${blank}.` : '');
}

function fileSection(spec: FileSpec, number: number): string[] {
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
    ...columns.map(columnLine),
    ...(rules.length > 0 ? ['Rules:', ...rules.map((rule) => `- ${rule}`)] : []),
    '',
  ];
}

export function workoutIntakePrompt(): string {
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
    '- Describe every drill in words in free_text_drill and leave drill_id blank.',
    '- A step with contact above light_technical has no duration_minutes and no rep_count: write its rounds or',
    '  time, as the document gives them, in coach_note.',
    '',
    ...dataset.files.flatMap((file, index) => fileSection(file, index + 1)),
    'THE WORKOUT DOCUMENT:',
  ];
  return `${lines.join('\n')}\n`;
}
