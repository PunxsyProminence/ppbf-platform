import { MINT } from '../ids';
import type { DatasetSpec, FileSpec, RowValues } from '../types';
import { integerText, isIntegerText, parseBoolean } from '../values';
import {
  bool,
  childIdColumn,
  createdByColumn,
  integer,
  keyColumn,
  lineageColumn,
  organizationColumn,
  parentColumn,
  referenceColumn,
  systemColumn,
  text,
  vocabulary,
} from './common';

// pilot.drill_library and its four child tables (drill_library_v3 migration
// :83-202, widened by drill_vocabulary_widening; drill_secondary_skills
// migration). Loaded by the content-import core (seed-reference-data, npm run
// seed:drill-library).

const drillParent = () =>
  parentColumn('drill_id', 'drill', 'drill', "The drill's lineage key (its first version's id), or the new:<short-name> of a drill in this package.");

const drillLibrary: FileSpec = {
  dataset: 'drill-library',
  folder: 'drill-library',
  file: 'seed_drill_library.csv',
  rowMeaning: 'one drill',
  key: ['drill_id'],
  nameColumn: 'name',
  nearDuplicateNames: true,
  unique: [
    {
      columns: ['discipline', 'name'],
      description:
        'name is unique within its discipline among current drills (pilot_drill_library_one_active_name refuses a second one).',
    },
  ],
  mint: { column: 'drill_id', idKind: 'drill', mint: (row) => MINT.drill(row.discipline, row.name) },
  columns: [
    organizationColumn(),
    keyColumn('drill_id', 'drill', "Keep the drill's existing id on a revision; new:<short-name> for a new drill.", true),
    lineageColumn('drill_id'),
    systemColumn('version', '1', 'a changed drill becomes the next version at load'),
    systemColumn('supersedes_drill_id', '', 'set when a new version is written'),
    systemColumn('superseded_at', '', 'set when a newer version is written'),
    text('name', 'The drill name.', { required: true }),
    referenceColumn('discipline', 'discipline', 'A discipline key.', { required: true, idKind: 'slug' }),
    text('category', 'e.g. technical, footwork, conditioning.', { required: true, label: true }),
    referenceColumn('skill_id', 'skill', 'The ONE primary skill code (SK-...), never a family id SKILL-01..12.', { idKind: 'skill' }),
    text('target_behavior', 'The lesson every scale level must still produce.', { required: true }),
    text('purpose', 'What the drill is for.', { required: true }),
    text('standard_setup', 'How to set it up.', { required: true }),
    text('execution', 'How it runs.', { required: true }),
    text('what_good_looks_like', 'What good execution looks like. A drill without it cannot be adopted.'),
    text('what_bad_looks_like', 'What poor execution looks like.'),
    text('common_errors', 'Common errors.'),
    text('corrections', 'Corrections.'),
    text('transfer', 'How it transfers to the sport.'),
    vocabulary('contact_level', 'contact_level', 'The most contact the drill involves.', { required: true }),
    text('equipment_needed', 'Equipment.'),
    bool('requires_coach_authorization', 'A coach must authorize it before an athlete runs it.', { required: true }),
    text('content_class', 'How the content was produced, e.g. COACHING CRAFT - PPBF source manual v3.', { required: true, label: true }),
    text('source_ref', 'Where it came from.', { label: true }),
    systemColumn('active', 'true', 'withdrawing a drill is a separate action'),
    createdByColumn(),
    vocabulary('difficulty', 'difficulty', 'What the drill REQUIRES to be attempted at all (not the scale level).', { required: true }),
    referenceColumn(
      'grounding_claim_ids',
      'claim',
      'Research claims behind the drill, from the LOADED research package, separated by |.',
      { idKind: 'claim', list: '|' },
    ),
    vocabulary('field_provenance', 'field_provenance', 'How the fields were authored.', { required: true }),
  ],
};

function isStart(row: RowValues): boolean {
  return parseBoolean(row.is_starting_point) === true;
}

const scaleLevels: FileSpec = {
  dataset: 'drill-library',
  folder: 'drill-library',
  file: 'seed_drill_scale_levels.csv',
  rowMeaning: 'one demand level (A, B or C) of one drill',
  key: ['drill_id', 'scale_level'],
  parent: { column: 'drill_id', target: 'drill' },
  mint: { column: 'scale_id', idKind: 'scale', mint: (row) => MINT.scale(row.drill_id, row.scale_level) },
  columns: [
    organizationColumn(),
    childIdColumn('scale_id', 'scale', 'Keep it, or leave blank and the tool mints it.'),
    drillParent(),
    vocabulary('scale_level', 'scale_level', 'A = simplified, B = the drill as designed, C = harder, same lesson.', { required: true }),
    bool('is_starting_point', 'true on exactly one row per drill, and that row is B.', { required: true }),
    text('demand_description', 'What changes at this level.', { required: true }),
    text('constraint_applied', 'The constraint that changes the demand.'),
    vocabulary('contact_level', 'contact_level', 'Contact at this level.', { blankDefault: 'none' }),
    text('coach_watch_point', 'What the coach watches for.'),
    vocabulary('authoring_state', 'scale_authoring_state', 'How far the row has been reviewed.', { blankDefault: 'authored' }),
  ],
  groupRules: [
    {
      description: 'Each drill has exactly one starting level, and it is B.',
      code: 'scale_rule',
      // The "it is B" half. The column CHECK names two columns, so Postgres
      // names it after the table alone; "exactly one" is the partial unique
      // index pilot_drill_scale_one_start, not a constraint.
      mirrors: { table: 'drill_scale_levels', constraint: 'drill_scale_levels_check' },
      check: (rows) => {
        const starts = rows.filter(isStart);
        if (starts.length !== 1) {
          return `has ${starts.length} starting levels; exactly one is required, and it is B`;
        }
        return starts[0].scale_level === 'B' ? null : `starts at ${starts[0].scale_level}; the starting level is B`;
      },
    },
  ],
};

const stopRules: FileSpec = {
  dataset: 'drill-library',
  folder: 'drill-library',
  file: 'seed_drill_stop_rules.csv',
  rowMeaning: "one of the drill's OWN stop conditions",
  key: ['drill_id', 'ordinal'],
  parent: { column: 'drill_id', target: 'drill' },
  mint: {
    column: 'stop_rule_id',
    idKind: 'stop_rule',
    mint: (row) => MINT.stopRule(row.drill_id, isIntegerText(row.ordinal) ? integerText(row.ordinal) : row.ordinal),
  },
  columns: [
    organizationColumn(),
    childIdColumn('stop_rule_id', 'stop_rule', 'Keep it, or leave blank and the tool mints it.'),
    drillParent(),
    integer('ordinal', 'Order within the drill; unique per drill.', { required: true, bound: 'positive' }),
    text('condition_text', 'Stop when ...', { required: true }),
    // Kept only so today's rows stay valid. R3: every drill's rules are its
    // own; the gym-wide set lives in seed_universal_stop_rules.csv. A
    // 'universal' here is reported, and treated as this drill's own rule.
    vocabulary(
      'scope',
      'stop_rule_scope',
      "Optional. Legacy rows say universal; each is treated as this drill's own rule (R3).",
      { blankDefault: 'drill_specific' },
    ),
    vocabulary('rule_kind', 'stop_rule_kind', 'What kind of stop.', { required: true }),
  ],
};

const cues: FileSpec = {
  dataset: 'drill-library',
  folder: 'drill-library',
  file: 'seed_drill_cues.csv',
  rowMeaning: 'one coaching cue for one drill',
  key: ['drill_id', 'cue_text'],
  parent: { column: 'drill_id', target: 'drill' },
  mint: { column: 'cue_id', idKind: 'cue', mint: (row) => MINT.cue(row.drill_id, row.cue_text) },
  columns: [
    organizationColumn(),
    childIdColumn('cue_id', 'cue', 'Keep it, or leave blank and the tool mints it.'),
    drillParent(),
    text('cue_text', 'The words the coach says.', { required: true }),
    text('cue_family', 'The cue family all three scale levels share.', { label: true }),
    vocabulary('focus_type', 'cue_focus_type', 'Where the cue directs attention.', { blankDefault: 'unspecified' }),
    text('evidence_note', 'Evidence note (evidence attaches to the cue class, not the words).'),
    text('source_ref', 'Where it came from.', { label: true }),
  ],
};

const secondarySkills: FileSpec = {
  dataset: 'drill-library',
  folder: 'drill-library',
  file: 'seed_drill_secondary_skills.csv',
  rowMeaning: 'one additional skill a drill materially trains',
  key: ['drill_id', 'skill_id'],
  parent: { column: 'drill_id', target: 'drill' },
  columns: [
    organizationColumn(),
    drillParent(),
    referenceColumn('skill_id', 'skill', "An SK code that is NOT the drill's primary skill.", { required: true, idKind: 'skill' }),
    {
      name: 'expected_primary_skill_id',
      role: 'content',
      type: 'text',
      idKind: 'skill',
      description: "Optional. The primary skill you expect the drill to have; refused if the drill's primary differs.",
    },
  ],
  // The retired loader's own refusals (seed-drill-secondary-skills.mjs),
  // checked here against the package or the committed library instead of the
  // database, so they surface before a load rather than during one.
  rowRules: [
    {
      description: 'The drill has a primary skill_id, and the secondary skill is not that same code.',
      check: (row, context) => {
        const primary = context.drillPrimarySkill(row.drill_id);
        if (primary === undefined) return null; // an unknown drill is reported as an orphan instead
        if (!primary) return `drill ${row.drill_id} has no primary skill_id, so it cannot have a secondary one`;
        return primary === row.skill_id ? `${row.skill_id} is already the primary skill of ${row.drill_id}` : null;
      },
    },
    {
      description: "expected_primary_skill_id, when given, equals the drill's primary skill_id.",
      check: (row, context) => {
        if (!row.expected_primary_skill_id) return null;
        const primary = context.drillPrimarySkill(row.drill_id);
        if (primary === undefined) return null;
        return primary === row.expected_primary_skill_id
          ? null
          : `expected primary ${row.expected_primary_skill_id} but drill ${row.drill_id} has ${primary || 'none'}`;
      },
    },
  ],
};

export const drillLibraryDataset: DatasetSpec = {
  name: 'drill-library',
  title: 'Drills',
  folder: 'drill-library',
  summary:
    'A drill and its rows in the four child files are ONE unit: under R2 a change anywhere makes a new drill '
    + 'version and the old version is kept (and stays live for gyms that adopted it). A child file replaces the full '
    + 'set of rows only for drills that have at least one row in it; a drill with no rows there keeps what it has.',
  loadedToday:
    'seed-reference-data workflow, dataset drill-library (npm run seed:drill-library; npm run '
    + 'seed:drill-secondary-skills loads the same dataset, because secondary skills are part of a drill\'s version), '
    + 'through the content-import core: a new drill is inserted, a changed one becomes a new version with every child '
    + 'row re-minted and the old version kept live for gyms that adopted it, an unchanged one is skipped. Rows the '
    + "retired loader wrote before #1020 may hold a '|' grounding list as ONE array element (it split on ';' and ',' "
    + 'only); the content hash re-splits it, so that stored form never reads as a revision. New secondary-skill links '
    + 'are held by the row rules below, not by a pinned file.',
  files: [drillLibrary, scaleLevels, stopRules, cues, secondarySkills],
};
