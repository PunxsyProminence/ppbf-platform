import { MINT } from '../ids';
import type { DatasetSpec } from '../types';
import { integerText, isIntegerText } from '../values';
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

// pilot.workout_templates and pilot.workout_template_items
// (workout_templates_v2 migration :43-100). Loaded by the content-import core
// (seed-reference-data, npm run seed:workout-templates). The retired
// seed-workout-templates.mjs named only the active-name index in its ON
// CONFLICT; the primary key is (organization_id, template_id) (migration :63),
// so a new name on an existing id was a key violation there, not a skip.

export const workoutTemplatesDataset: DatasetSpec = {
  name: 'workout-templates',
  title: 'Workout templates',
  folder: 'workout-templates',
  summary:
    'Reusable session plans. A template and its items are one unit: under R2 a change to either makes a new '
    + 'template version and the old one is kept. Items listed for a template replace all of its items.',
  loadedToday:
    'seed-reference-data workflow, dataset workout-templates (npm run seed:workout-templates), through the '
    + 'content-import core: a new template is inserted, a changed one becomes a new version (the old one retired from '
    + 'the coach browse, kept as history), an unchanged one is skipped. Items name a drill lineage and store the '
    + 'version current at load.',
  files: [
    {
      dataset: 'workout-templates',
      folder: 'workout-templates',
      file: 'seed_workout_templates.csv',
      rowMeaning: 'one template',
      key: ['template_id'],
      nameColumn: 'name',
      nearDuplicateNames: true,
      unique: [
        {
          columns: ['name'],
          description: 'name is unique among current templates (pilot_workout_templates_one_active_name).',
        },
      ],
      mint: { column: 'template_id', idKind: 'template', mint: (row) => MINT.template(row.name) },
      columns: [
        organizationColumn(),
        keyColumn('template_id', 'template', "Keep the template's existing id on a revision; new:<short-name> for a new one.", true),
        lineageColumn('template_id'),
        systemColumn('version', '1', 'a changed template becomes the next version at load'),
        systemColumn('supersedes_template_id', '', 'set when a new version is written'),
        systemColumn('superseded_at', '', 'set when a newer version is written'),
        text('name', 'The template name.', { required: true }),
        text('session_type', 'e.g. technical, footwork, sparring.', { required: true, label: true }),
        vocabulary('difficulty', 'difficulty', 'Who it is pitched at.', { required: true }),
        text('age_band', 'e.g. any, youth, adult, youth_and_adult.', { blankDefault: 'any', label: true }),
        integer('duration_minutes', 'Session length, 15 to 180 minutes.', { required: true, bound: 'template_duration_minutes' }),
        text('intent', 'What the session is for.', { required: true }),
        text('coach_notes', 'Coach notes.'),
        bool('requires_coach_authorization', 'A coach must authorize it.', { blankDefault: 'false' }),
        systemColumn('active', 'true', 'withdrawing a template is a separate action'),
        createdByColumn(),
      ],
    },
    {
      dataset: 'workout-templates',
      folder: 'workout-templates',
      file: 'seed_workout_template_items.csv',
      rowMeaning: 'one item, in order, of one template',
      key: ['template_id', 'ordinal'],
      parent: { column: 'template_id', target: 'template' },
      mint: {
        column: 'item_id',
        idKind: 'template_item',
        mint: (row) => MINT.templateItem(row.template_id, isIntegerText(row.ordinal) ? integerText(row.ordinal) : row.ordinal),
      },
      columns: [
        organizationColumn(),
        childIdColumn('item_id', 'template_item', 'Keep it, or leave blank and the tool mints it.'),
        parentColumn('template_id', 'template', 'template', 'The template id, or the new:<short-name> of a template in this package.'),
        integer('ordinal', 'Position in the template; unique per template.', { required: true, bound: 'positive' }),
        text('block', 'e.g. warmup, technical, cooldown.', { required: true, label: true }),
        referenceColumn('drill_id', 'drill', "A drill's lineage key or the new:<short-name> of a drill in this package.", {
          idKind: 'drill',
          allowNew: true,
        }),
        text('free_text_drill', 'A drill described in words instead of drill_id.'),
        integer('duration_minutes', '1 to 90 minutes.', { bound: 'template_item_duration_minutes' }),
        integer('rep_count', 'Reps, 1 or more.', { bound: 'positive' }),
        vocabulary('contact_level', 'contact_level', 'Contact in this item.', { blankDefault: 'none' }),
        text('coach_note', 'Coach note.'),
        vocabulary('scale_level', 'scale_level', 'A preferred scale level (a preference, never forced).'),
      ],
      rowRules: [
        {
          description: 'Exactly one of drill_id and free_text_drill.',
          mirrors: { table: 'workout_template_items', constraint: 'pilot_wti_one_source' },
          check: (row) =>
            Boolean(row.drill_id) === Boolean(row.free_text_drill)
              ? 'needs exactly one of drill_id and free_text_drill'
              : null,
        },
        {
          description: 'Contact above light_technical carries no duration or rep count.',
          mirrors: { table: 'workout_template_items', constraint: 'pilot_wti_no_contact_volume' },
          check: (row) => {
            const contact = row.contact_level || 'none';
            return !['none', 'light_technical'].includes(contact) && (row.duration_minutes || row.rep_count)
              ? `contact_level ${contact} may not carry duration_minutes or rep_count`
              : null;
          },
        },
      ],
    },
  ],
};
