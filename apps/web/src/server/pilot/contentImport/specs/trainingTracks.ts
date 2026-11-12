import { EVIDENCE_LABELS, RECORD_STATUSES, STAGE_KEYS, type ColumnSpec, type DatasetSpec, type FileSpec, type RowRule } from '../types';
import {
  createdByColumn,
  integer,
  lineageColumn,
  organizationColumn,
  referenceColumn,
  systemColumn,
  text,
  vocabulary,
} from './common';

// TRAINING TRACKS (SCHEMA_PROPOSAL P17; training_tracks migration; lane FT1a).
// A multi-week class track, its ordered blocks, and the sessions each block
// lists by week and day. First use: the 8-week FT1 non-contact class track.
//
// ONE UNIT UNDER R2: a track with its blocks and block sessions, as a template
// with its items (datasets/trainingTracks.ts on the shared engine in
// templateScriptVersions.ts). Both child files name the TRACK as their parent;
// a block session reaches its block by (track_id, block_order).
//
// IDS ARE THE BACKBONE'S. A track keeps its trk_ id and v1 of its blocks their
// trb_ ids; none takes new:<name>. block_lineage_id carries the trb_ id into
// every later version, whose block ids are minted.
//
// JSON CELLS. details (every backbone field with no column of its own, whole),
// sources, and a block's own labels are JSON cells. sources is a JSON list,
// NOT a '|' list: a backbone source such as "Jason 2026-10-24 (RULES s9, First
// class track)" holds a comma, which a '|' list column refuses as a bad
// separator (Overwatch, FT1a step 1, addition A). A JSON cell carries it whole.

export const TRACKS_FILE = 'seed_training_tracks.csv';
export const BLOCKS_FILE = 'seed_track_blocks.csv';
export const SESSIONS_FILE = 'seed_track_block_sessions.csv';

const TRACK_ID = /^trk_[0-9a-f]{14}$/;
const BLOCK_ID = /^trb_[0-9a-f]{14}$/;
const SESSION_ID = /^tbs_[0-9a-f]{14}$/;

function parsed(value: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function idShape(column: string, pattern: RegExp, shape: string, mirrors?: RowRule['mirrors']): RowRule {
  return {
    description: `${column} is ${shape}.`,
    mirrors,
    check: (row) => (row[column] && !pattern.test(row[column]) ? `${column} '${row[column]}' is not ${shape}` : null),
  };
}

/** sources: a JSON list of non-empty text (addition A). */
const SOURCES_RULE: RowRule = {
  description: 'sources, when set, is a JSON list of non-empty text (e.g. ["DOC-123"]).',
  check: (row) => {
    if (!row.sources) return null;
    const result = parsed(row.sources);
    if (!result.ok) return `sources is not readable JSON: ${result.error}`;
    if (!Array.isArray(result.value)) return 'sources must be a JSON list of source keys, e.g. ["DOC-123"]';
    const bad = result.value.findIndex((item) => typeof item !== 'string' || item.trim() === '');
    return bad >= 0 ? `sources item ${bad + 1} is not non-empty text (${JSON.stringify(result.value[bad])})` : null;
  },
};

function detailsRule(mirrors: RowRule['mirrors']): RowRule {
  return {
    description: 'details, when set, is a JSON object: every backbone field with no column of its own, by its backbone name.',
    mirrors,
    check: (row) => {
      if (!row.details) return null;
      const result = parsed(row.details);
      if (!result.ok) return `details is not readable JSON: ${result.error}`;
      return isPlainObject(result.value) ? null : 'details must be a JSON object: backbone field name -> value';
    },
  };
}

/** Every status in a field_labels object (the rule validate.ts applies to the label column). */
function badStatuses(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => badStatuses(item, `${path}[${index}]`, out));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const at = path ? `${path}.${key}` : key;
    if (key === 'sources' && Array.isArray(value)) continue;
    if (key === 'status' && !isPlainObject(value)) {
      if (!(RECORD_STATUSES as readonly unknown[]).includes(value)) out.push(`${at} is ${JSON.stringify(value)}`);
    } else {
      badStatuses(value, at, out);
    }
  }
}

/** A block's own labels, checked as the root label columns are (validate.ts checkAnnotation). */
const BLOCK_LABEL_RULES: RowRule[] = [
  {
    description: `field_labels, when set, is a JSON object of per-field {"status", "sources"}; every status is one of ${RECORD_STATUSES.join(', ')}.`,
    mirrors: { table: 'track_blocks', constraint: 'pilot_track_blocks_field_labels_check' },
    check: (row) => {
      if (!row.field_labels) return null;
      const result = parsed(row.field_labels);
      if (!result.ok) return `field_labels is not readable JSON: ${result.error}`;
      if (!isPlainObject(result.value)) return 'field_labels must be a JSON object: field name -> {"status": ..., "sources": [...]}';
      const bad: string[] = [];
      badStatuses(result.value, '', bad);
      return bad.length > 0 ? `field_labels status ${bad.join('; ')}. Allowed: ${RECORD_STATUSES.join(' | ')}` : null;
    },
  },
  {
    description: `evidence, when set, is a JSON object or a JSON list of them; an evidence_label is one of ${EVIDENCE_LABELS.join(', ')}.`,
    mirrors: { table: 'track_blocks', constraint: 'pilot_track_blocks_evidence_check' },
    check: (row) => {
      if (!row.evidence) return null;
      const result = parsed(row.evidence);
      if (!result.ok) return `evidence is not readable JSON: ${result.error}`;
      const entries = Array.isArray(result.value) ? result.value : [result.value];
      if (!entries.every(isPlainObject)) return 'evidence must be a JSON object or a JSON list of objects';
      const bad = entries.findIndex((entry) => 'evidence_label' in entry && !(EVIDENCE_LABELS as readonly unknown[]).includes(entry.evidence_label));
      return bad >= 0
        ? `evidence entry ${bad + 1}: evidence_label ${JSON.stringify(entries[bad].evidence_label)} is not allowed. Allowed: ${EVIDENCE_LABELS.join(' | ')}`
        : null;
    },
  },
  {
    description: `stage_keys, when set, is a JSON list of pathway stages (${STAGE_KEYS.join(', ')}).`,
    check: (row) => {
      if (!row.stage_keys) return null;
      const result = parsed(row.stage_keys);
      if (!result.ok) return `stage_keys is not readable JSON: ${result.error}`;
      if (!Array.isArray(result.value)) return 'stage_keys must be a JSON list of stage keys, e.g. ["FT1"]';
      const bad = result.value.filter((key) => !(STAGE_KEYS as readonly unknown[]).includes(key));
      return bad.length > 0 ? `stage_keys ${bad.map((key) => JSON.stringify(key)).join(', ')} not a pathway stage. Allowed: ${STAGE_KEYS.join(' | ')}` : null;
    },
  },
];

const statusColumn = () => vocabulary('status', 'record_status', 'The record status (backbone RULES section 10).', { required: true });

const sourcesColumn = (): ColumnSpec => ({
  name: 'sources',
  role: 'content',
  type: 'text',
  blankDefault: '[]',
  description: 'The record\'s sources: a JSON list of source keys, e.g. ["DOC-123"]. A JSON list, not a | list, so a source may hold any character.',
});

const detailsColumn = (what: string): ColumnSpec => ({
  name: 'details',
  role: 'content',
  type: 'text',
  blankDefault: '{}',
  description: `JSON object: every backbone field of the ${what} with no column of its own, whole, by its backbone name.`,
});

/** The parent column of a child file: the track's lineage key (a package names lineages). */
const trackParentColumn = (): ColumnSpec => ({
  name: 'track_id',
  role: 'parent',
  type: 'text',
  required: true,
  description: "The track's id (trk_), in seed_training_tracks.csv of this package or already loaded.",
});

const tracksFile: FileSpec = {
  dataset: 'training-tracks',
  folder: 'training-tracks',
  file: TRACKS_FILE,
  rowMeaning: 'one training track',
  key: ['track_id'],
  nameColumn: 'name',
  columns: [
    organizationColumn(),
    { name: 'track_id', role: 'key', type: 'text', required: true, description: "The backbone's track id: 'trk_' and 14 lowercase hex. Kept on a revision." },
    lineageColumn('track_id'),
    systemColumn('version', '1', 'a changed track becomes the next version at load'),
    systemColumn('supersedes_track_id', '', 'set when a new version is written'),
    systemColumn('superseded_at', '', 'set when a newer version is written'),
    text('name', 'The track name.', { required: true }),
    vocabulary('lane', 'track_lane', 'The lane the track belongs to.', { required: true }),
    vocabulary('track', 'track_kind', 'The recreation track (contact or fitness), when it has one.'),
    integer('duration_weeks', 'How many weeks the track runs.', { bound: 'positive' }),
    text('delivered_to_program_id', 'The enrollment group it is delivered to, when the backbone names one.'),
    text('age_band', 'Who it is for, as the backbone writes it (e.g. all ages).', { blankDefault: 'any', label: true }),
    statusColumn(),
    sourcesColumn(),
    detailsColumn('track'),
    systemColumn('active', 'true', 'a revision keeps the current version\'s active flag; a superseded version is inactive'),
    createdByColumn(),
  ],
  rowRules: [
    idShape('track_id', TRACK_ID, "'trk_' and 14 lowercase hex", { table: 'training_tracks', constraint: 'pilot_training_tracks_id_check' }),
    SOURCES_RULE,
    detailsRule({ table: 'training_tracks', constraint: 'pilot_training_tracks_details_check' }),
  ],
};

const blocksFile: FileSpec = {
  dataset: 'training-tracks',
  folder: 'training-tracks',
  file: BLOCKS_FILE,
  rowMeaning: 'one block, in order, of one track',
  key: ['track_id', 'block_order'],
  parent: { column: 'track_id', target: 'track' },
  unique: [
    {
      columns: ['track_id', 'block_lineage_id'],
      description: 'block_lineage_id is unique within its track (pilot_track_blocks_lineage_uq).',
    },
  ],
  columns: [
    organizationColumn(),
    {
      name: 'track_block_id',
      role: 'child_id',
      type: 'text',
      description: "The backbone's block id (trb_), kept on a track's first load; a later version's block ids are minted. Blank: minted.",
    },
    text('block_lineage_id', "The backbone's block id (trb_), the same in every version of the track.", { required: true }),
    trackParentColumn(),
    integer('block_order', 'Position in the track; unique per track.', { required: true, bound: 'positive' }),
    text('title', 'The block title.'),
    integer('weeks', 'How many weeks the block runs.', { bound: 'positive' }),
    statusColumn(),
    sourcesColumn(),
    { name: 'field_labels', role: 'content', type: 'text', description: 'The block\'s own field labels: JSON object, per field {"status", "sources"}.' },
    { name: 'evidence', role: 'content', type: 'text', description: 'The block\'s own evidence: a JSON object, or a JSON list of them.' },
    {
      name: 'stage_keys',
      role: 'content',
      type: 'text',
      blankDefault: '[]',
      description: 'The block\'s own stage keys: a JSON list, e.g. ["FT1"]. Kept on the block; the track\'s stage_keys make its stage links.',
    },
    detailsColumn('block'),
  ],
  rowRules: [
    idShape('track_block_id', BLOCK_ID, "'trb_' and 14 lowercase hex", { table: 'track_blocks', constraint: 'pilot_track_blocks_id_check' }),
    idShape('block_lineage_id', BLOCK_ID, "'trb_' and 14 lowercase hex", { table: 'track_blocks', constraint: 'pilot_track_blocks_lineage_check' }),
    {
      description: 'A track_block_id the file gives equals block_lineage_id: both are the backbone\'s block id.',
      check: (row) =>
        row.track_block_id && row.block_lineage_id && row.track_block_id !== row.block_lineage_id
          ? `track_block_id '${row.track_block_id}' and block_lineage_id '${row.block_lineage_id}' differ; both are the backbone's block id`
          : null,
    },
    SOURCES_RULE,
    ...BLOCK_LABEL_RULES,
    detailsRule({ table: 'track_blocks', constraint: 'pilot_track_blocks_details_check' }),
  ],
};

const sessionsFile: FileSpec = {
  dataset: 'training-tracks',
  folder: 'training-tracks',
  file: SESSIONS_FILE,
  rowMeaning: 'one session a block lists, in order',
  key: ['track_id', 'block_order', 'ordinal'],
  parent: { column: 'track_id', target: 'track' },
  columns: [
    organizationColumn(),
    { name: 'block_session_id', role: 'child_id', type: 'text', description: 'Leave blank; the tool mints it (tbs_).' },
    trackParentColumn(),
    integer('block_order', "The block it belongs to: a block_order of the same track's blocks.", { required: true, bound: 'positive' }),
    integer('ordinal', 'Position in the block\'s list; unique per block.', { required: true, bound: 'positive' }),
    integer('week', 'The week of the track (not of the block), as the backbone writes it.', { required: true, bound: 'positive' }),
    vocabulary('day', 'weekday', 'The day, as written.', { required: true }),
    referenceColumn(
      'template_lineage_id',
      'template',
      "The workout template's lineage key (wtp_), or the new:<short-name> of a template in this package. At plan it must have a current, active version in the organization.",
      { required: true, idKind: 'template', allowNew: true },
    ),
  ],
  rowRules: [
    idShape('block_session_id', SESSION_ID, "'tbs_' and 14 lowercase hex", { table: 'track_block_sessions', constraint: 'pilot_track_block_sessions_id_check' }),
  ],
};

export const trainingTracksDataset: DatasetSpec = {
  name: 'training-tracks',
  title: 'Training tracks',
  folder: 'training-tracks',
  summary:
    'Multi-week class tracks (SCHEMA_PROPOSAL P17): a track, its ordered blocks, and the workout templates each block lists by '
    + 'week and day. A track with its blocks and block sessions is one unit: under R2 a change to any of them makes a new track '
    + 'version, every block and block session re-minted under it, and the old version kept as it was; a block a later file '
    + 'leaves out is absent from the new version and kept on the old one. Rows listed for a track in a child file replace all of '
    + 'that track\'s rows in that file. A block session names a template LINEAGE, so a day opens its current version; the plan '
    + 'refuses, by name, a template with no current active version. Ids are the backbone\'s (trk_, trb_). details, sources and a '
    + 'block\'s labels are JSON cells; sources is a JSON list, not a | list, so a source holding a comma is carried whole.',
  loadedToday:
    'No committed package yet: lane FT1b exports the FT1 track from the Backbone. Loads through the content-import core '
    + '(seed-reference-data workflow, dataset training-tracks, or the admin content-import screen); no screen shows a track yet.',
  files: [tracksFile, blocksFile, sessionsFile],
};
