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

// pilot.session_scripts, session_script_blocks, session_script_renderings
// (session_scripts migration :27-124). Loaded today by seed-session-scripts.mjs.

const scriptParent = () =>
  parentColumn('script_id', 'script', 'script', 'The script id, or the new:<short-name> of a script in this package.');

export const sessionScriptsDataset: DatasetSpec = {
  name: 'session-scripts',
  title: 'Session scripts',
  folder: 'session-scripts',
  summary:
    'A whole coached session, minute by minute, with the words to say. A script, its blocks and its renderings '
    + 'are one unit: under R2 a change makes a new version and the old one is kept. Blocks (or renderings) listed '
    + 'for a script replace all of its blocks (or renderings).',
  loadedToday:
    'seed-reference-data workflow, dataset session-scripts (npm run seed:session-scripts). Insert-only by id: an '
    + 'existing script, block or rendering id is skipped; a new block at an existing (script, block_order) stops the run.',
  files: [
    {
      dataset: 'session-scripts',
      folder: 'session-scripts',
      file: 'seed_session_scripts.csv',
      rowMeaning: 'one session script',
      key: ['script_id'],
      nameColumn: 'name',
      mint: { column: 'script_id', idKind: 'script', mint: (row) => MINT.script(row.discipline, row.name) },
      columns: [
        organizationColumn(),
        keyColumn('script_id', 'script', "Keep the script's existing id on a revision; new:<short-name> for a new one.", true),
        lineageColumn('script_id'),
        systemColumn('version', '1', 'a changed script becomes the next version at load'),
        text('name', 'The script name.', { required: true }),
        referenceColumn('discipline', 'discipline', 'A discipline key.', { required: true, idKind: 'slug' }),
        text('theme', 'The theme.'),
        text('phase', 'e.g. Accumulation.'),
        text('day_of_week', 'e.g. Wednesday.'),
        integer('total_minutes', '10 to 300 minutes.', { bound: 'script_total_minutes' }),
        vocabulary('contact_structure', 'script_contact_structure', 'How contact is arranged.', { blankDefault: 'non_contact' }),
        text('target_group', 'Who it is for, in the coach\'s own terms.'),
        text('prerequisite_note', 'What athletes need first.'),
        text('reset_protocol', 'What to do when the room loses it.'),
        text('coach_priorities', 'The priorities, in order.'),
        text('frequent_phrases', 'The short cues repeated all session.'),
        vocabulary('authoring_state', 'script_authoring_state', 'How far it has been reviewed.', { blankDefault: 'draft' }),
        text('source_document', 'Which PPBF document it came from.', { label: true }),
        createdByColumn(),
      ],
    },
    {
      dataset: 'session-scripts',
      folder: 'session-scripts',
      file: 'seed_session_script_blocks.csv',
      rowMeaning: 'one timed block, in order, of one script',
      key: ['script_id', 'block_order'],
      parent: { column: 'script_id', target: 'script' },
      mint: {
        column: 'block_id',
        idKind: 'block',
        mint: (row) => MINT.block(row.script_id, isIntegerText(row.block_order) ? integerText(row.block_order) : row.block_order),
      },
      columns: [
        organizationColumn(),
        childIdColumn('block_id', 'block', 'Keep it, or leave blank and the tool mints it.'),
        scriptParent(),
        integer('block_order', 'Position in the script; unique per script.', { required: true, bound: 'positive' }),
        integer('start_offset_min', 'Minutes from the start, 0 or more.', { required: true, bound: 'block_start_offset' }),
        integer('end_offset_min', 'Minutes from the start; after start_offset_min.', { required: true }),
        text('block_label', 'What the block is.', { required: true }),
        text('what_to_say', 'What to say.'),
        text('what_to_explain', 'What to explain.'),
        text('what_to_watch', 'What to watch.'),
        text('what_to_fix', 'What to fix.'),
        vocabulary('block_kind', 'block_kind', 'The kind of block.', { blankDefault: 'instruction' }),
        referenceColumn('drill_id', 'drill', "The drill this block runs: a drill's lineage key or a new:<short-name> in this package.", {
          idKind: 'drill',
          allowNew: true,
        }),
        vocabulary('scale_level', 'scale_level', 'The scale level the block runs at.'),
        vocabulary('contact_level', 'contact_level', 'Contact in this block.', { blankDefault: 'none' }),
      ],
      rowRules: [
        {
          description: 'end_offset_min is after start_offset_min.',
          mirrors: { table: 'session_script_blocks', constraint: 'pilot_ssb_window' },
          check: (row) => {
            if (!isIntegerText(row.start_offset_min) || !isIntegerText(row.end_offset_min)) return null;
            return Number(integerText(row.end_offset_min)) > Number(integerText(row.start_offset_min))
              ? null
              : `ends at ${row.end_offset_min}, not after its start at ${row.start_offset_min}`;
          },
        },
        {
          description: 'At least one of what_to_say / explain / watch / fix, unless block_kind is transition, arrival or close.',
          mirrors: { table: 'session_script_blocks', constraint: 'pilot_ssb_content' },
          check: (row) =>
            !row.what_to_say && !row.what_to_explain && !row.what_to_watch && !row.what_to_fix
            && !['transition', 'arrival', 'close'].includes(row.block_kind)
              ? 'says nothing: fill at least one of what_to_say, what_to_explain, what_to_watch, what_to_fix'
              : null,
        },
      ],
    },
    {
      dataset: 'session-scripts',
      folder: 'session-scripts',
      file: 'seed_session_script_renderings.csv',
      rowMeaning: 'one script rendered for one kind of reader',
      key: ['script_id', 'format'],
      parent: { column: 'script_id', target: 'script' },
      mint: { column: 'rendering_id', idKind: 'rendering', mint: (row) => MINT.rendering(row.script_id, row.format) },
      columns: [
        organizationColumn(),
        childIdColumn('rendering_id', 'rendering', 'Keep it, or leave blank and the tool mints it.'),
        scriptParent(),
        vocabulary('format', 'rendering_format', 'Which rendering; one of each per script.', { required: true }),
        text('audience_note', 'Who reads it and where.'),
        text('body', 'The rendered text.', { required: true }),
        bool('generated_from_blocks', 'true when derived from the blocks, false when hand-authored.', { blankDefault: 'false' }),
      ],
    },
  ],
};
