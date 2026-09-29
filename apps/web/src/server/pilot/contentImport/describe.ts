import { ID_PREFIX, idShapeText, MINT_FORMULA_TEXT } from './ids';
import { DATASETS, UNIVERSAL_SYSTEM_COLUMNS } from './specs';
import { ACCOUNT_PLACEHOLDER, type ColumnSpec, type DatasetSpec, type FileSpec, ORG_PLACEHOLDER } from './types';
import { ARCHIVE_EXTENSIONS, MEDIA_EXTENSIONS } from './validate';
import { BOUNDS, VOCABULARIES } from './vocabularies';

// docs/CONTENT_PACKAGE_CONTRACT.md, generated. The specs are the one source:
// the doc Jason's other account follows and the validator that checks the
// hand-off are written from the same objects, so they cannot say different
// things. contentPackageContract.test.ts fails when the committed doc is not
// exactly this output; regenerate with `npm run content:describe -- --write`.

function cellText(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function boundText(column: ColumnSpec): string {
  if (!column.bound) return '';
  const bound: { gt?: number; gte?: number; lte?: number } = BOUNDS[column.bound];
  const parts: string[] = [];
  if (bound.gt !== undefined) parts.push(column.type === 'integer' ? `${bound.gt + 1} or more` : `above ${bound.gt}`);
  if (bound.gte !== undefined) parts.push(`${bound.gte} or more`);
  if (bound.lte !== undefined) parts.push(`${bound.lte} or less`);
  return parts.join(', ');
}

function allowedText(spec: FileSpec, column: ColumnSpec): string {
  const parts: string[] = [];
  if (column.role === 'placeholder') return `\`${column.placeholder}\` or blank`;
  if (column.role === 'system') return column.systemDefault ? `blank or \`${column.systemDefault}\`` : 'blank';
  if (column.role === 'lineage') return `blank or the same as ${spec.key[0]}`;
  if (column.vocabulary) {
    parts.push(VOCABULARIES[column.vocabulary].values.map((value) => `\`${value}\``).join(', '));
  } else if (column.idKind) {
    parts.push(idShapeText(column.idKind));
    if (column.allowNew) parts.push('or new:<short-name>');
  } else if (column.type === 'boolean') {
    parts.push('true or false');
  } else if (column.type === 'integer') {
    parts.push('whole number');
  } else if (column.type === 'number') {
    parts.push('number');
  } else {
    parts.push('text');
  }
  const bound = boundText(column);
  if (bound) parts.push(bound);
  if (column.list) parts.unshift(`a list separated by \`${column.list}\`; each item:`);
  if (column.references) parts.push(`; ${REFERENCE_TEXT[column.references]}`);
  return parts.join(' ').replace(/ ;/g, ';');
}

const REFERENCE_TEXT: Record<NonNullable<ColumnSpec['references']>, string> = {
  discipline: 'must be a discipline in the package or the committed disciplines',
  level_ordinal: 'must be the ordinal of a competence level in the package or the committed levels',
  drill: 'must be a drill in the package or the committed library',
  template: 'must be a template in the package or the committed templates',
  script: 'must be a script in the package or the committed scripts',
  block: 'must be a block in the package or the committed scripts',
  claim: 'must be a claim in the LOADED research package',
  skill: 'should be listed in skillFamilies.ts (a warning otherwise)',
};

function columnRow(spec: FileSpec, column: ColumnSpec): string {
  const required = column.required ? 'yes' : '';
  const blankText = column.blankDefault ?? column.blankMeans;
  const blank = blankText ? ` Blank means ${blankText}.` : '';
  return `| ${column.name} | ${required} | ${cellText(allowedText(spec, column))} | ${cellText(column.description + blank)} |`;
}

function fileSection(spec: FileSpec): string[] {
  const lines = [
    `#### ${spec.folder}/${spec.file}`,
    '',
    `One row = ${spec.rowMeaning}. Identity: ${spec.key.join(' + ')}.`
      + (spec.parent ? ` Rows belong to their ${spec.parent.target} (${spec.parent.column}).` : ''),
    '',
    '| column | required | allowed | meaning |',
    '| --- | --- | --- | --- |',
    ...spec.columns.map((column) => columnRow(spec, column)),
    '',
  ];
  const rules = [
    ...(spec.unique ?? []).map((rule) => rule.description),
    ...(spec.groupRules ?? []).map((rule) => rule.description),
    ...(spec.rowRules ?? []).map((rule) => rule.description),
  ];
  if (spec.mint) {
    const column = spec.columns.find((c) => c.name === spec.mint?.column);
    const formula = MINT_FORMULA_TEXT[spec.mint.idKind];
    if (column?.role === 'key') {
      rules.push(`A new:<short-name> ${spec.mint.column} becomes ${formula}.`);
    } else if (spec.key.includes(spec.mint.column)) {
      // The id is the whole identity (transfer claims): see blankKeyIds in validate.ts.
      rules.push(
        `A blank ${spec.mint.column} takes the id of the committed row whose content gives the same ${formula}, `
        + 'else it is filled with that formula. Two rows that come to the same id are refused as a duplicate.',
      );
    } else {
      rules.push(`A blank ${spec.mint.column} is filled with ${formula} (an existing row keeps its id).`);
    }
  }
  if (rules.length > 0) {
    lines.push('Rules:', '', ...rules.map((rule) => `- ${rule}`), '');
  }
  return lines;
}

function datasetSection(dataset: DatasetSpec, index: number): string[] {
  return [
    `### ${index + 1}. ${dataset.title}`,
    '',
    dataset.summary,
    '',
    `Loaded today: ${dataset.loadedToday}`,
    '',
    ...dataset.files.flatMap(fileSection),
  ];
}

export function describeContract(): string {
  const idKinds = Object.keys(ID_PREFIX) as (keyof typeof ID_PREFIX)[];
  const lines: string[] = [
    '# Content package contract',
    '',
    '<!-- GENERATED by `npm run content:describe -- --write` from apps/web/src/server/pilot/contentImport/specs/.',
    '     Do not edit by hand: contentPackageContract.test.ts fails when this file and the specs disagree. -->',
    '',
    'How to hand coaching and reference material to the app: drills, workout templates, session scripts,',
    'disciplines, competence levels, cohorts, transfer claims, universal stop rules and assessment protocols.',
    'Research releases have their own contract (not in this file yet).',
    '',
    '## How a hand-off works',
    '',
    '1. Put the CSV files in one folder. Use the folder names below or put every file in the one folder; files are',
    '   recognised by their file name. Any subset is fine: a type or file you leave out is left untouched, never read',
    '   as empty.',
    '2. Claude runs `npm run content:validate -- --dir <folder>` (no database, no secrets). It lists BLOCKING problems,',
    '   which must be fixed, and WARNINGS, which are worth a look and never stop the hand-off.',
    '3. Claude runs `npm run content:prepare -- --dir <folder> --write`. It mints ids for new items, writes them back',
    '   into your rows, and MERGES the rows into `apps/web/seed-data/` (see "Merging" below).',
    '4. A pull request carries the files; the fast guard validates every committed file again.',
    '5. After merge, the seed-reference-data workflow loads them (dry run first; production needs Jason\'s approval).',
    '',
    '## Rules for every file',
    '',
    '- CSV, UTF-8, a header row, comma between cells, standard double-quote quoting (spreadsheet "CSV UTF-8" export).',
    '  Every row has exactly as many cells as the header.',
    `- \`organization_id\`: \`${ORG_PLACEHOLDER}\` or blank. \`created_by_account_id\`: \`${ACCOUNT_PLACEHOLDER}\` or blank.`,
    '  A real organization or account id is refused: the seed workflow or the signed-in session decides them (gym',
    '  content belongs to punxsy_prominence and is seeded by an organization admin, never the platform owner).',
    '- No other `{{` text anywhere.',
    `- NO video, photos or audio, ever (${MEDIA_EXTENSIONS.join(' ')}), and no archives`,
    `  (${ARCHIVE_EXTENSIONS.join(' ')}). The repository is public. Teaching footage and stills go in through Teach`,
    '  Shadow upload.',
    `- Columns the tool decides (version, supersedes_*, superseded_at, active / active_flag, ${UNIVERSAL_SYSTEM_COLUMNS.join(', ')})`,
    '  may be left out, left blank, or hold today\'s default shown in the tables. Anything else is refused.',
    '- Lists inside one cell use `|` between items; spaces around items are trimmed. Two stored exceptions keep `,`:',
    '  cohort `required_domains` and `tenure_bands`. Any other separator in a list cell is refused.',
    '- true / false in any letter case. Whole numbers may be written `2` or `2.0`. A blank cell means the default the',
    '  table shows ("Blank means ..."), and is the same content as writing that default; with no default shown it means',
    '  "no value".',
    '- A column the file does not define is refused (its values would otherwise be dropped silently).',
    '',
    '## Identity',
    '',
    '- A REVISED item keeps its existing id from the committed CSV (drl_..., wtp_..., scr_..., coh_...). Without its',
    '  id a renamed item loads as a brand-new item; the warning report flags names close to an existing one.',
    '- A NEW item\'s id is `new:<short-name>`: lowercase letters, digits and hyphens, unique within the package. Other',
    '  files in the same package refer to it by the same `new:` value. `content:prepare` mints the real id and',
    '  writes it into every file.',
    '- In every package file, drill_id means the drill\'s LINEAGE key (the id of its first version), never a later',
    '  version\'s id. template_id and script_id work the same way.',
    '- Child ids (scale_id, stop_rule_id, cue_id, item_id, block_id, rendering_id, transfer_id) may be blank; the tool',
    '  keeps the committed id of an existing row and mints one for a new row. An existing row is found by the rest of',
    '  its identity (a drill + scale_level, a template + ordinal, ...). transfer_id IS a claim\'s whole identity, so a',
    '  blank one is matched to the committed claim with the same target, claim_kind and statement: KEEP transfer_id',
    '  when a revision changes any of those three, or the revision is added as a new claim beside the old one.',
    '- Id formats:',
    ...idKinds.map((kind) => `  - ${kind.replace(/_/g, ' ')}: ${idShapeText(kind)}; minted as ${MINT_FORMULA_TEXT[kind]}`),
    `  - research claim: ${idShapeText('claim')}. It must be a claim in the LOADED research package`,
    '    (shadow-research/2026-08-07), so a drill cannot cite a claim that is not loaded yet.',
    `  - skill: ${idShapeText('skill')}. A family id SKILL-01..12 is never allowed in a skill column. A code not`,
    '    listed in skillFamilies.ts is a warning naming the edit it needs.',
    `  - assessment protocol: ${idShapeText('assessment_protocol')}.`,
    `  - discipline, competence level: ${idShapeText('slug')}.`,
    '',
    '## What happens on load (R2)',
    '',
    '- Changed means any content cell or child row differs after trimming and normalising; ids, versions, placeholders',
    '  and timestamps never count.',
    '- A CHANGED item gets a new version and the old one is kept as history. A NEW item is inserted. An UNCHANGED item',
    '  is skipped. An item the hand-off leaves out is left alone and listed.',
    '- TODAY the seed loaders are insert-only (see "Loaded today" under each type): new items load, revisions reach',
    '  the committed files but not the database until the versioning loader lands.',
    '',
    '## Merging into the committed files (`content:prepare`)',
    '',
    '- Item files: a row whose identity matches a committed row replaces it in place; a new identity is added at the',
    '  end. A committed row the package leaves out is NEVER removed.',
    '- Child files (a drill\'s scale levels, stop rules, cues and secondary skills; a template\'s items; a script\'s',
    '  blocks and renderings): the package\'s rows for a parent replace ALL of that parent\'s committed rows in that',
    '  file. A parent with no row in the package keeps what it has.',
    '- prepare refuses to write if the merged files would carry a blocking problem the committed files do not.',
    '- A row whose content is the same as the committed row (true/TRUE, 2/2.0, a blank for the default shown) is',
    '  unchanged: the committed row is kept byte for byte.',
    '',
    '## Blocking problems',
    '',
    '- a duplicate identity, or a duplicate name / ordinal where the database allows only one',
    '- a reference to something that is in neither the package nor the committed files (orphan), including inline',
    '  claim tags like [A2-070] in text',
    '- a wrong list separator; a missing required value or column; a value outside the allowed list; a wrong id shape',
    '- a real organization or account id; stray `{{` text; media files or archives; a tool-decided column set',
    '- scale levels: each drill has exactly one starting level, and it is B',
    '- a stop-rule ordinal used twice for one drill; the row rules listed under each file',
    '- a new item whose minted id is already a committed item (revise it by its id instead)',
    '',
    '## Warnings (never block)',
    '',
    '- the same text of 25+ characters in 5+ rows of one column',
    '- a name equal to, or contained in, another item\'s name: "is this a revision of drl_...?"',
    '- a content column with one value in every row (5+ rows)',
    '- a new or changed drill that would load but could not be adopted by a gym: it needs what_good_looks_like,',
    '  A/B/C scale levels with one starting point, and at least one stop rule of its own',
    '- a skill code not listed in skillFamilies.ts, with the edit it needs',
    '- legacy stop-rule rows with scope=universal: each is treated as that drill\'s own rule (R3)',
    '',
    '## The material types',
    '',
    ...DATASETS.flatMap(datasetSection),
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
