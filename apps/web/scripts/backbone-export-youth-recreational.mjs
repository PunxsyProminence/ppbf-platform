#!/usr/bin/env node
// BACKBONE -> YOUTH + RECREATIONAL STAGE CONTENT (lane YR; OD-2026-11-15-006 ruling 2).
//
//   node scripts/backbone-export-youth-recreational.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]
//
// The first stage lane: every frozen track, block and session whose stage_keys include a youth
// stage (Y1-Y5) or RC1, and are not exactly ["FT1"] (OD-2026-11-10-003 point 4: a record that
// spans groups goes in the first lane that uses it). Written as NEW rows of committed packages:
//   workout-templates   27 templates + 240 items (6 DOC-136 templates, 42 items, HELD: see HELD_TEMPLATES)
//   training-tracks     53 tracks (52 library tracks, 1 class track) + 3 blocks + 48 block sessions
//   session-scripts     the 13 blocks of scr_e2ed38b1a19670, whose script and renderings are
//                       already committed; its root row gains the record's labels
// --out defaults to apps/web/seed-data. Every committed row outside the set is kept byte for byte,
// and a second run is byte-identical.
//
// FROZEN, READ-ONLY, HASHED. Every file read is hashed (sha256, first 16 hex) against
// FREEZE_MANIFEST.json; a mismatch, or a file the manifest does not list, stops the export.
// A count different from the brief's is printed and exits 2 (the lane stops on it).
//
// COPY, NEVER REWORD. Text cells are the Backbone's own, NFC and trimmed; null is a blank cell; a
// JSON cell is the Backbone's own JSON, key-sorted, whole (strings inside it are not trimmed).
// Every record key is carried to a column, carried into `details` by its Backbone name, or listed
// in NOT_CARRIED (printed with counts); an unknown key stops the export.
//
// EXCERPTS. Research `quote` keys (469, all in evidence entries) never enter this public repository
// (OD-2026-10-02-013 2A); the citation stays. An evidence entry's sp10 note sentence that shares an
// 8-word run with its own quote repeats the paper's text and is dropped too (1 in the set; the
// lane's fidelity review). Owner passages (DOC-027, DOC-072) are Jason's own material and are
// carried whole (Q-208, RH-Q02 A; Overwatch, lane YR step 1).
//
// BESIDE-LINES (OD-2026-11-16-004 ruling 1; Overwatch, lane YR Q5 A, Q6 A). Beside each frozen
// DOC-154 Thursday "REST / WEIGH-IN" line the app shows the USA Boxing day-of weigh-in line, in the
// Backbone's own wording already in the repo, with its key and the excerpt-only caveat. They are
// held on the DOC-154 track as `details.beside_lines` (an app key, not a Backbone field, labelled
// in field_labels). Nothing on the sheet is edited: the export stops unless each sheet line is
// found at its place, word for word, and the line text is found word for word in the frozen spine
// and the caveat in OWNER_DECISIONS.md.
//
// OVERWRITE GUARD (as FT1-G). Before anything is written, every committed row of the set is
// compared with its new row: a committed non-blank cell that would change, or a committed row that
// would disappear, stops the export and names each; --allow-overwrite writes anyway.
//
// TWO STOPS NO FLAG PASSES (lane GD; lib/backbone-export-guards.mjs). A row this run would write
// that names a held DOC-136 record (a frozen track's session_refs and groups do), or a committed
// template step that links a drill written back as a typed line, stops the export and nothing is
// written, with or without --allow-overwrite.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONTENT_DIRS,
  ExportError,
  GUARD_KEYS as FT1_GUARD_KEYS,
  HEADERS as FT1_HEADERS,
  ORG_PLACEHOLDER,
  boolCell,
  committedRows,
  compare,
  isObject,
  loadManifest,
  numberCell,
  readCsv,
  readDir,
  sha16,
  sortedJson,
  textCell,
  writeCsv,
} from './backbone-export-ft1-track.mjs';
import { heldTextFindings, stopMessage, typedLineFindings } from './lib/backbone-export-guards.mjs';

export const STAGES = ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'];
export const SCRIPT_ID = 'scr_e2ed38b1a19670';
export const DOC154_TRACK_ID = 'trk_98f1b755dce913';
export const SPINE_FILE = 'data/spine/spine.json';
export const EXCERPT_KEYS = ['quote', 'quotes'];
export const EXPECTED_COUNTS = {
  tracks: 53, blocks: 3, blockSessions: 48, templates: 27, items: 240, heldTemplates: 6, heldItems: 42, scripts: 1, scriptBlocks: 13, quoteKeys: 469,
  ownerPassages: 354, besideLines: 2, sp10Sentences: 1,
};

// HELD (OD-2026-10-02-013 answers 2A and 4A; Overwatch, lane YR, DOC-136 option B). The six DOC-136
// home-program days are printed from USA Boxing High-Performance Coach Education: outside
// copyrighted material, neither PPBF-owned nor open-licence, and there is no private load path for
// templates. They stay out of this public repository: not exported, listed here by id, counted.
// A reference to one elsewhere (a track's session_refs) is not written either: a row that names a
// held record stops the export (lane GD, Overwatch C1 on #2042; lane HW took that text out of the
// committed track row). Jason may reverse this.
export const HELD_TEMPLATES = {
  wtp_40b6956ea37245: 'DOC-136 home day 1 (USA Boxing High-Performance Coach Education)',
  wtp_0f42c41a78dea4: 'DOC-136 home day 2 (USA Boxing High-Performance Coach Education)',
  wtp_fb399b5d31e70d: 'DOC-136 home day 3 (USA Boxing High-Performance Coach Education)',
  wtp_35c593e3b96cdf: 'DOC-136 home day 4 (USA Boxing High-Performance Coach Education)',
  wtp_b965c8174bd41a: 'DOC-136 home day 5 (USA Boxing High-Performance Coach Education)',
  wtp_f20745471ef7c4: 'DOC-136 home day 6 (USA Boxing High-Performance Coach Education)',
};

// OD-2026-11-16-004 ruling 1 (OW25-23 A), as Overwatch ruled its wording (lane YR Q6 A): the
// Backbone's own sentence (frozen spine; committed pathway stage defaults), the key, and the
// caveat as the OWNER_DECISIONS entry words it.
export const BESIDE_LINE = {
  line_key: 'USAB-R11',
  line_text: "'Day-before' conflicts with USA Boxing 2026 Rule 11.1(2) (weigh in on the day they box) on the USA Boxing route; 11.2 events use the same 'Daily weigh-in' (INFERRED same day).",
  sources: ['EXT-USAB-RB2026'],
  caveat: 'The card for OW25-23 says the research session read the USA Boxing rule only in search-result excerpts, not the full 2026 rule book.',
  ruling: 'OD-2026-11-16-004',
};
export const BESIDE_PLACES = [
  { group_section: 'DOC-154 sheet 1', block_index: 5, sheet_text: 'THURSDAY – REST / WEIGH-IN (Walk, Stretch, Rehydrate, Early sleep)' },
  { group_section: 'DOC-154 sheet 2', block_index: 10, sheet_text: 'REST / WEIGH-IN: Walk + stretch | Rehydrate smart | Early sleep' },
];
const BESIDE_LABEL = {
  status: 'OBSERVED',
  sources: ['Jason 2026-11-16 (OD-2026-11-16-004)', 'data/spine/spine.json USAB-R11 (EXT-USAB-RB2026)'],
  note: 'app key, not a Backbone field: the lines the app shows beside the sheet lines; nothing on the sheet is edited',
};

const LABELS = ['field_labels', 'evidence', 'stage_keys'];
// Record keys by kind: to a column, into details (by Backbone name), checked and not carried, not carried.
export const KEYS = {
  track: {
    columns: ['organization_id', 'track_id', 'lineage_id', 'name', 'lane', 'track', 'duration_weeks', 'delivered_to_program_id', 'age_band', 'status', 'sources', 'active', ...LABELS],
    details: ['part_heading', 'chapter_heading', 'subtitle', 'publisher_line', 'groups', 'session_refs', 'differences', 'field_provenance', 'owner_passages', 'library_text',
      'source_header', 'sessions_per_week', 'session_minutes', 'phase_focus', 'session_blocks', 'coaching_standards', 'age_adaptation'],
    checked: ['block_ids'],
    notCarried: ['stage_links'],
  },
  block: {
    columns: ['organization_id', 'track_block_id', 'lineage_id', 'track_id', 'block_order', 'title', 'weeks', 'status', 'sources', 'session_refs', ...LABELS],
    details: ['description', 'optional_drill_refs', 'week_1_check'],
    checked: ['active'],
    notCarried: [],
  },
  sessionRef: { columns: ['week', 'day', 'template_id'], details: [], checked: [], notCarried: [] },
  template: {
    columns: ['organization_id', 'template_id', 'lineage_id', 'name', 'session_type', 'difficulty', 'age_band', 'duration_minutes', 'intent', 'coach_notes',
      'requires_coach_authorization', 'active', 'items', ...LABELS],
    details: ['contact_structure', 'owner_passages', 'source_sections', 'field_provenance', 'block_notes', 'conditioning_categories', 'use_rule', 'differences',
      'extension_rule', 'placement_rule', 'placement_condition', 'print_ready_layout', 'structure'],
    checked: [],
    notCarried: ['session_kind', 'track_id', 'status', 'sources', 'stage_links'],
  },
  item: {
    columns: ['item_id', 'ordinal', 'block', 'drill_id', 'free_text_drill', 'duration_minutes', 'contact_level', 'coach_note', 'scale_level'],
    details: ['phase', 'time', 'block_time', 'block_title', 'plan_items', 'parts', 'changed_by', 'timing', 'within_item_id', 'owner_source', 'rung', 'time_lines', 'round_focus_rule'],
    checked: [],
    notCarried: [],
  },
  script: {
    columns: ['organization_id', 'script_id', 'lineage_id', 'name', 'discipline', 'theme', 'phase', 'day_of_week', 'total_minutes', 'contact_structure',
      'target_group', 'prerequisite_note', 'reset_protocol', 'coach_priorities', 'frequent_phrases', 'authoring_state', 'source_document', 'blocks', 'renderings', ...LABELS],
    details: [],
    checked: [],
    notCarried: ['session_kind', 'active', 'status', 'sources', 'stage_links'],
  },
  scriptBlock: {
    columns: ['block_id', 'block_order', 'start_offset_min', 'end_offset_min', 'block_label', 'what_to_say', 'what_to_explain', 'what_to_watch', 'what_to_fix', 'block_kind',
      'drill_id', 'scale_level', 'contact_level'],
    details: [],
    checked: [],
    notCarried: [],
  },
  rendering: { columns: ['rendering_id', 'format', 'audience_note', 'body', 'generated_from_blocks'], details: [], checked: [], notCarried: [] },
};

// Contact above light_technical carries no minutes in the column (pilot_wti_no_contact_volume);
// such an item's frozen minutes go into its details, labelled by name (Overwatch Q2 A, pending Jason).
const VOLUME_FREE_CONTACT = ['none', 'light_technical'];

const SCRIPT_ROOT_COLUMNS = ['organization_id', 'script_id', 'lineage_id', 'version', 'name', 'discipline', 'theme', 'phase', 'day_of_week', 'total_minutes',
  'contact_structure', 'target_group', 'prerequisite_note', 'reset_protocol', 'coach_priorities', 'frequent_phrases', 'authoring_state', 'source_document',
  'created_by_account_id'];
export const FILES = {
  templates: 'workout-templates/seed_workout_templates.csv',
  items: 'workout-templates/seed_workout_template_items.csv',
  tracks: 'training-tracks/seed_training_tracks.csv',
  blocks: 'training-tracks/seed_track_blocks.csv',
  sessions: 'training-tracks/seed_track_block_sessions.csv',
  scripts: 'session-scripts/seed_session_scripts.csv',
  scriptBlocks: 'session-scripts/seed_session_script_blocks.csv',
  renderings: 'session-scripts/seed_session_script_renderings.csv',
  drills: 'drill-library/seed_drill_library.csv',
};
export const HEADERS = {
  [FILES.templates]: FT1_HEADERS[FILES.templates],
  [FILES.items]: FT1_HEADERS[FILES.items],
  [FILES.tracks]: FT1_HEADERS[FILES.tracks],
  [FILES.blocks]: FT1_HEADERS[FILES.blocks],
  [FILES.sessions]: FT1_HEADERS[FILES.sessions],
  [FILES.scripts]: [...SCRIPT_ROOT_COLUMNS, ...LABELS],
  [FILES.scriptBlocks]: ['organization_id', 'block_id', 'script_id', 'block_order', 'start_offset_min', 'end_offset_min', 'block_label', 'what_to_say', 'what_to_explain',
    'what_to_watch', 'what_to_fix', 'block_kind', 'drill_id', 'scale_level', 'contact_level'],
};
export const GUARD_KEYS = {
  [FILES.templates]: FT1_GUARD_KEYS[FILES.templates],
  [FILES.items]: FT1_GUARD_KEYS[FILES.items],
  [FILES.tracks]: FT1_GUARD_KEYS[FILES.tracks],
  [FILES.blocks]: FT1_GUARD_KEYS[FILES.blocks],
  [FILES.sessions]: FT1_GUARD_KEYS[FILES.sessions],
  [FILES.scripts]: { owner: 'script_id', row: ['script_id'] },
  [FILES.scriptBlocks]: { owner: 'script_id', row: ['script_id', 'block_order'] },
};

// ---- cells ----

/** Lower-case words of letters only: numbers and symbols never make a shared run. */
const alphaWords = (text) => (String(text ?? '').toLowerCase().match(/[a-z]+/g) ?? []);
const SHARED_RUN = 8;

/**
 * An evidence entry's sp10 notes, less any sentence that shares a run of SHARED_RUN words with the
 * entry's own quote: such a sentence repeats the cited paper's text, which never enters this public
 * repository (OD-2026-10-02-013 2A; Overwatch, lane YR: "keep the citation by key and drop the
 * run"). The rest of the note and the citation stay. `count.sp10Sentences` counts the drops.
 */
function stripSp10Runs(entry, count) {
  if (!isObject(entry) || typeof entry.quote !== 'string' || !isObject(entry.sp10)) return entry;
  const quote = alphaWords(entry.quote).join(' ');
  const sp10 = {};
  for (const [key, value] of Object.entries(entry.sp10)) {
    if (typeof value !== 'string') { sp10[key] = value; continue; }
    // Sentences with the space after each kept as written: [s0, sep0, s1, sep1, ...].
    const parts = value.split(/((?<=[.;])\s+)/);
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const words = alphaWords(parts[i]);
      const shared = words.length >= SHARED_RUN
        && words.some((_, at) => at + SHARED_RUN <= words.length && quote.includes(words.slice(at, at + SHARED_RUN).join(' ')));
      if (shared) dropped += 1;
      else kept.push(parts[i], parts[i + 1] ?? '');
    }
    count.sp10Sentences = (count.sp10Sentences ?? 0) + dropped;
    // A note with nothing dropped stays exactly as written.
    sp10[key] = dropped ? kept.join('').trim() : value;
  }
  return { ...entry, sp10 };
}

/** The value with every research excerpt key removed at any depth; counts them. Owner passages stay. */
export function stripExcerpts(value, count) {
  if (Array.isArray(value)) return value.map((item) => stripExcerpts(item, count));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (EXCERPT_KEYS.includes(key)) count[key] = (count[key] ?? 0) + 1;
    else out[key] = stripExcerpts(inner, count);
  }
  return out;
}

export function labelCells(record, where, dropped, { stageKeysAsJson = false, extraLabels = {} } = {}) {
  const cells = {};
  if (record.field_labels === undefined || record.field_labels === null) cells.field_labels = Object.keys(extraLabels).length ? sortedJson(extraLabels) : '';
  else if (!isObject(record.field_labels)) throw new ExportError(`${where}: field_labels is not an object`);
  else {
    const clash = Object.keys(extraLabels).filter((key) => key in record.field_labels);
    if (clash.length) throw new ExportError(`${where}: field_labels already has ${clash.join(', ')}, an app key this export adds`);
    cells.field_labels = sortedJson({ ...stripExcerpts(record.field_labels, dropped), ...extraLabels });
  }
  if (record.evidence === undefined || record.evidence === null) cells.evidence = '';
  else if (!Array.isArray(record.evidence) || !record.evidence.every(isObject)) throw new ExportError(`${where}: evidence must be a list of entries`);
  else cells.evidence = record.evidence.length ? sortedJson(stripExcerpts(record.evidence.map((entry) => stripSp10Runs(entry, dropped)), dropped)) : '';
  const stages = record.stage_keys ?? [];
  if (!Array.isArray(stages) || !stages.every((key) => typeof key === 'string')) throw new ExportError(`${where}: stage_keys must be a list of text`);
  cells.stage_keys = stageKeysAsJson ? (stages.length ? sortedJson(stages) : '') : stages.join('|');
  return cells;
}

export function sourcesCell(sources, where) {
  if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string')) throw new ExportError(`${where}: sources must be a list of source keys`);
  return sortedJson(sources.map((source) => source.normalize('NFC').trim()));
}

/** details: the listed Backbone keys the record has (null kept as null), whole, key-sorted; blank when none. */
export function detailsCell(record, keys, dropped, extra = {}) {
  const details = Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
  const clash = Object.keys(extra).filter((key) => key in details);
  if (clash.length) throw new ExportError(`details already has ${clash.join(', ')}, an app key this export adds`);
  const merged = { ...stripExcerpts(details, dropped), ...extra };
  return Object.keys(merged).length ? sortedJson(merged) : '';
}

/** Throws unless every key of `record` is known for its kind; tallies the not-carried ones. */
function checkKeys(kind, record, where, tally) {
  if (!isObject(record)) throw new ExportError(`${where} is not an object`);
  if (record.organization_id !== undefined && record.organization_id !== ORG_PLACEHOLDER) {
    throw new ExportError(`${where}: organization_id ${JSON.stringify(record.organization_id)} is not ${ORG_PLACEHOLDER}; the export always writes the placeholder`);
  }
  const { columns, details, checked, notCarried } = KEYS[kind];
  for (const key of Object.keys(record)) {
    if (columns.includes(key) || details.includes(key) || checked.includes(key)) continue;
    if (notCarried.includes(key)) {
      tally[`${kind}.${key}`] = (tally[`${kind}.${key}`] ?? 0) + 1;
      continue;
    }
    throw new ExportError(`${where}: key ${JSON.stringify(key)} has no column, no place in details and is not on the not-carried list; report it, do not drop it`);
  }
}

export const sameId = (record, idKey, where) => {
  if (record.lineage_id !== record[idKey]) throw new ExportError(`${where}: lineage_id differs from ${idKey}`);
};

// ---- reading the frozen Backbone ----

const inLane = (record) => {
  const keys = Array.isArray(record.stage_keys) ? record.stage_keys : [];
  if (keys.length === 1 && keys[0] === 'FT1') return false;
  return keys.some((key) => STAGES.includes(key));
};

function readSpineText(backboneDir, manifest, hashes) {
  const file = path.join(backboneDir, SPINE_FILE);
  if (!fs.existsSync(file)) throw new ExportError(`not found: ${file}`);
  const bytes = fs.readFileSync(file);
  const hash = sha16(bytes);
  if (!manifest.has(SPINE_FILE)) throw new ExportError(`${SPINE_FILE} is not in the manifest`);
  if (manifest.get(SPINE_FILE) !== hash) throw new ExportError(`${SPINE_FILE}: hash ${hash} differs from the manifest (${manifest.get(SPINE_FILE)}); the frozen Backbone has changed`);
  hashes.push(`${SPINE_FILE}:${hash}`);
  return bytes.toString('utf8');
}

/** Every string anywhere in a JSON value. */
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (isObject(value)) for (const item of Object.values(value)) yield* strings(item);
}

export function readSet(backboneDir) {
  const manifest = loadManifest(backboneDir);
  const hashes = [];
  const tracks = readDir(backboneDir, manifest, CONTENT_DIRS.tracks, hashes).map((entry) => entry.record).filter(inLane);
  const blocks = readDir(backboneDir, manifest, CONTENT_DIRS.blocks, hashes).map((entry) => entry.record).filter(inLane);
  const sessions = readDir(backboneDir, manifest, CONTENT_DIRS.sessions, hashes).map((entry) => entry.record).filter(inLane);
  const spine = JSON.parse(readSpineText(backboneDir, manifest, hashes));
  const held = sessions.filter((record) => record.session_kind === 'template' && Object.hasOwn(HELD_TEMPLATES, record.template_id));
  const templates = sessions.filter((record) => record.session_kind === 'template' && !Object.hasOwn(HELD_TEMPLATES, record.template_id));
  const scripts = sessions.filter((record) => record.session_kind === 'script');
  const other = sessions.filter((record) => !['template', 'script'].includes(record.session_kind));
  if (other.length) throw new ExportError(`session ${other[0].template_id ?? other[0].script_id}: session_kind ${JSON.stringify(other[0].session_kind)} is neither template nor script`);
  const missingHeld = Object.keys(HELD_TEMPLATES).filter((id) => !held.some((record) => record.template_id === id));
  if (missingHeld.length) throw new ExportError(`held template(s) ${missingHeld.join(', ')} not in the set; the HELD list is out of date`);
  return { tracks, blocks, templates, held, scripts, spine, hashes };
}

// ---- building the rows ----

function templateRows(templates, drillIds, dropped, tally, notes) {
  const rows = [];
  const items = [];
  for (const template of [...templates].sort((a, b) => compare(a.template_id, b.template_id))) {
    const where = `template ${template.template_id}`;
    checkKeys('template', template, where, tally);
    sameId(template, 'template_id', where);
    rows.push({
      organization_id: ORG_PLACEHOLDER, template_id: template.template_id, lineage_id: template.lineage_id, version: '1', supersedes_template_id: '', superseded_at: '',
      name: textCell(template.name, `${where} name`), session_type: textCell(template.session_type, `${where} session_type`),
      difficulty: textCell(template.difficulty, `${where} difficulty`), age_band: textCell(template.age_band, `${where} age_band`),
      duration_minutes: numberCell(template.duration_minutes, `${where} duration_minutes`), intent: textCell(template.intent, `${where} intent`),
      coach_notes: textCell(template.coach_notes, `${where} coach_notes`),
      requires_coach_authorization: boolCell(template.requires_coach_authorization, `${where} requires_coach_authorization`),
      active: boolCell(template.active, `${where} active`), created_by_account_id: '',
      details: detailsCell(template, KEYS.template.details, dropped),
      ...labelCells(template, where, dropped),
    });
    const ordinals = (template.items ?? []).map((item) => item.ordinal);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new ExportError(`${where}: item ordinals ${JSON.stringify(ordinals)} do not run 1..n`);
    for (const item of template.items ?? []) {
      const at = `${where} item ${item.ordinal}`;
      checkKeys('item', item, at, tally);
      if (item.drill_id && !drillIds.has(item.drill_id)) throw new ExportError(`${at}: drill ${item.drill_id} is not in ${FILES.drills}`);
      const contact = textCell(item.contact_level, `${at} contact_level`);
      let duration = numberCell(item.duration_minutes, `${at} duration_minutes`);
      const extra = {};
      if (duration !== '' && !VOLUME_FREE_CONTACT.includes(contact || 'none')) {
        extra.duration_minutes = item.duration_minutes;
        duration = '';
        notes.push(`${at}: ${contact} with ${item.duration_minutes} min -> details.duration_minutes (the column takes no minutes above light_technical)`);
      }
      items.push({
        organization_id: ORG_PLACEHOLDER, item_id: textCell(item.item_id, `${at} item_id`), template_id: template.template_id, ordinal: numberCell(item.ordinal, `${at} ordinal`),
        block: textCell(item.block, `${at} block`), drill_id: textCell(item.drill_id, `${at} drill_id`), free_text_drill: textCell(item.free_text_drill, `${at} free_text_drill`),
        duration_minutes: duration, rep_count: '', contact_level: contact, coach_note: textCell(item.coach_note, `${at} coach_note`),
        scale_level: textCell(item.scale_level, `${at} scale_level`), details: detailsCell(item, KEYS.item.details, dropped, extra),
      });
    }
  }
  return { rows, items };
}

function besideLines(track, spine, ownerDecisions) {
  const where = `track ${track.track_id}`;
  if (!Array.isArray(track.groups)) throw new ExportError(`${where}: groups is not a list`);
  if (![...strings(spine)].some((text) => text.includes(BESIDE_LINE.line_text))) {
    throw new ExportError(`the beside-line text is not word for word in ${SPINE_FILE}: ${BESIDE_LINE.line_text}`);
  }
  if (!ownerDecisions.includes(BESIDE_LINE.caveat)) throw new ExportError(`the beside-line caveat is not word for word in OWNER_DECISIONS.md: ${BESIDE_LINE.caveat}`);
  return BESIDE_PLACES.map((place) => {
    const group = track.groups.find((candidate) => candidate.section === place.group_section);
    const block = group?.blocks?.[place.block_index];
    if (!block || block.text !== place.sheet_text) {
      throw new ExportError(`${where}: ${place.group_section} block ${place.block_index} is ${JSON.stringify(block?.text)}, not the sheet line ${JSON.stringify(place.sheet_text)}`);
    }
    return { ...place, ...BESIDE_LINE };
  });
}

function trackRows({ tracks, blocks, templates, spine }, ownerDecisions, dropped, tally, counts) {
  const templateIds = new Set(templates.map((template) => template.template_id));
  const trackCells = [];
  const blockCells = [];
  const sessionCells = [];
  for (const track of [...tracks].sort((a, b) => compare(a.track_id, b.track_id))) {
    const where = `track ${track.track_id}`;
    checkKeys('track', track, where, tally);
    sameId(track, 'track_id', where);
    const own = blocks.filter((block) => block.track_id === track.track_id).sort((a, b) => a.block_order - b.block_order);
    const ids = own.map((block) => block.track_block_id);
    const listed = track.block_ids ?? [];
    if (!Array.isArray(listed) || listed.length !== ids.length || listed.some((id, index) => id !== ids[index])) {
      throw new ExportError(`${where}: block_ids ${JSON.stringify(listed)} differ from the blocks in block_order ${JSON.stringify(ids)}`);
    }
    let extraDetails = {};
    let extraLabels = {};
    if (track.track_id === DOC154_TRACK_ID) {
      extraDetails = { beside_lines: besideLines(track, spine, ownerDecisions) };
      extraLabels = { beside_lines: BESIDE_LABEL };
      counts.besideLines += extraDetails.beside_lines.length;
    }
    trackCells.push({
      organization_id: ORG_PLACEHOLDER, track_id: track.track_id, lineage_id: track.lineage_id, version: '1', supersedes_track_id: '', superseded_at: '',
      name: textCell(track.name, `${where} name`), lane: textCell(track.lane, `${where} lane`), track: textCell(track.track, `${where} track`),
      duration_weeks: numberCell(track.duration_weeks, `${where} duration_weeks`), delivered_to_program_id: textCell(track.delivered_to_program_id, `${where} delivered_to_program_id`),
      age_band: textCell(track.age_band, `${where} age_band`), status: textCell(track.status, `${where} status`), sources: sourcesCell(track.sources, where),
      details: detailsCell(track, KEYS.track.details, dropped, extraDetails), active: boolCell(track.active, `${where} active`), created_by_account_id: '',
      ...labelCells(track, where, dropped, { extraLabels }),
    });
    own.forEach((block, index) => {
      const at = `block ${block.track_block_id}`;
      checkKeys('block', block, at, tally);
      sameId(block, 'track_block_id', at);
      if (block.active !== true) throw new ExportError(`${at}: active is ${JSON.stringify(block.active)}; a block has no active column, so only an active block can be exported`);
      if (block.block_order !== index + 1) throw new ExportError(`${at}: block_order ${block.block_order} is not ${index + 1} (blocks must run 1..n without gaps)`);
      blockCells.push({
        organization_id: ORG_PLACEHOLDER, track_block_id: block.track_block_id, block_lineage_id: block.lineage_id, track_id: track.track_id,
        block_order: numberCell(block.block_order, `${at} block_order`), title: textCell(block.title, `${at} title`), weeks: numberCell(block.weeks, `${at} weeks`),
        status: textCell(block.status, `${at} status`), sources: sourcesCell(block.sources, at), ...labelCells(block, at, dropped, { stageKeysAsJson: true }),
        details: detailsCell(block, KEYS.block.details, dropped),
      });
      (block.session_refs ?? []).forEach((ref, position) => {
        checkKeys('sessionRef', ref, `${at} session_ref ${position + 1}`, tally);
        if (!templateIds.has(ref.template_id)) throw new ExportError(`${at} session_ref ${position + 1}: template ${ref.template_id} is not in this set`);
        sessionCells.push({
          organization_id: ORG_PLACEHOLDER, block_session_id: '', track_id: track.track_id, block_order: String(block.block_order), ordinal: String(position + 1),
          week: numberCell(ref.week, `${at} session_ref week`), day: textCell(ref.day, `${at} session_ref day`), template_lineage_id: textCell(ref.template_id, `${at} session_ref template_id`),
        });
      });
    });
  }
  const orphan = blocks.find((block) => !tracks.some((track) => track.track_id === block.track_id));
  if (orphan) throw new ExportError(`block ${orphan.track_block_id}: its track ${orphan.track_id} is not in this set`);
  return { trackCells, blockCells, sessionCells };
}

/** The script: its committed root row must hold the frozen values; the blocks are new; the renderings must already be committed as frozen. */
function scriptRows(scripts, existing, dropped, tally) {
  if (scripts.length !== 1 || scripts[0].script_id !== SCRIPT_ID) {
    throw new ExportError(`the set's script sessions are ${JSON.stringify(scripts.map((script) => script.script_id))}, not [${JSON.stringify(SCRIPT_ID)}]`);
  }
  const script = scripts[0];
  const where = `script ${SCRIPT_ID}`;
  checkKeys('script', script, where, tally);
  sameId(script, 'script_id', where);
  const committed = committedRows(existing(FILES.scripts), HEADERS[FILES.scripts]).find((row) => row.script_id === SCRIPT_ID);
  if (!committed) throw new ExportError(`${where} is not committed in ${FILES.scripts}; this export adds its blocks to the committed script`);
  for (const column of SCRIPT_ROOT_COLUMNS.filter((name) => !['organization_id', 'version', 'created_by_account_id'].includes(name))) {
    const frozen = column === 'total_minutes' ? numberCell(script[column], `${where} ${column}`) : textCell(script[column], `${where} ${column}`);
    if (frozen !== committed[column]) throw new ExportError(`${where}: ${column} is ${JSON.stringify(frozen)} in the Backbone and ${JSON.stringify(committed[column])} in ${FILES.scripts}`);
  }
  const root = { ...committed, ...labelCells(script, where, dropped) };
  const renderings = committedRows(existing(FILES.renderings), ['organization_id', 'rendering_id', 'script_id', 'format', 'audience_note', 'body', 'generated_from_blocks'])
    .filter((row) => row.script_id === SCRIPT_ID);
  for (const rendering of script.renderings ?? []) {
    const at = `${where} rendering ${rendering.format}`;
    checkKeys('rendering', rendering, at, tally);
    const row = renderings.find((candidate) => candidate.format === rendering.format);
    // The committed renderings are the frozen text with CRLF read as LF (the only CR in the set).
    const body = textCell(String(rendering.body ?? '').replace(/\r\n/g, '\n'), `${at} body`);
    if (!row || row.rendering_id !== rendering.rendering_id || row.body !== body || row.audience_note !== textCell(rendering.audience_note, `${at} audience_note`)
      || row.generated_from_blocks !== boolCell(rendering.generated_from_blocks, `${at} generated_from_blocks`)) {
      throw new ExportError(`${at} is not committed as frozen in ${FILES.renderings}; this export keeps the committed renderings and writes none`);
    }
  }
  if (renderings.length !== (script.renderings ?? []).length) throw new ExportError(`${where}: ${renderings.length} committed renderings, ${(script.renderings ?? []).length} frozen`);
  const blocks = [...(script.blocks ?? [])].sort((a, b) => a.block_order - b.block_order).map((block, index) => {
    const at = `${where} block ${block.block_order}`;
    checkKeys('scriptBlock', block, at, tally);
    if (block.block_order !== index + 1) throw new ExportError(`${at}: block_order is not ${index + 1}`);
    const cells = { organization_id: ORG_PLACEHOLDER, script_id: SCRIPT_ID, block_id: textCell(block.block_id, `${at} block_id`) };
    for (const column of KEYS.scriptBlock.columns.filter((name) => name !== 'block_id')) {
      cells[column] = ['block_order', 'start_offset_min', 'end_offset_min'].includes(column) ? numberCell(block[column], `${at} ${column}`) : textCell(block[column], `${at} ${column}`);
    }
    return cells;
  });
  return { root, blocks };
}

// ---- merging into the committed files ----

export function guardId(name, obj) {
  const { row } = GUARD_KEYS[name];
  return row.every((column) => (obj[column] ?? '') !== '') ? row.map((column) => obj[column]).join('/') : `\u0000${HEADERS[name].map((column) => obj[column] ?? '').join('\u0000')}`;
}

/**
 * What writing `newRows` in place of `replaced` would destroy: a committed row that disappears, or a
 * committed NON-BLANK cell that changes. Filling a committed blank cell (the script's labels) is not one.
 */
export function findOverwrites(name, replaced, newRows) {
  const { owner, row } = GUARD_KEYS[name];
  const fresh = new Map(newRows.map((obj) => [guardId(name, obj), obj]));
  const found = [];
  for (const old of replaced) {
    const id = guardId(name, old);
    const label = id.startsWith('\u0000') ? `a row with no ${row.join('/')}` : id;
    const next = fresh.get(id);
    if (!next) {
      found.push({ file: name, owner: old[owner] ?? '', id: label, removed: true, columns: [] });
      continue;
    }
    const columns = HEADERS[name].filter((column) => (old[column] ?? '') !== '' && (old[column] ?? '') !== (next[column] ?? ''));
    if (columns.length) found.push({ file: name, owner: old[owner] ?? '', id: label, removed: false, columns });
  }
  return found;
}

export function describeOverwrites(found) {
  return found.map((item) => `  ${item.file} ${GUARD_KEYS[item.file].owner} ${item.owner}: ${item.removed ? `removes ${item.id}` : `changes ${item.columns.join(', ')} of ${item.id}`}`);
}

export function checkUniqueIds(name, kept, newRows) {
  const { owner, row } = GUARD_KEYS[name];
  const fresh = new Map();
  for (const obj of newRows) {
    const id = guardId(name, obj);
    if (id.startsWith('\u0000')) continue;
    if (fresh.has(id)) throw new ExportError(`${name}: the export has two rows with ${row.join('/')} ${id}`);
    fresh.set(id, obj);
  }
  for (const obj of kept) {
    const id = guardId(name, obj);
    if (fresh.has(id)) throw new ExportError(`${name}: ${row.join('/')} ${id} is a committed row of ${owner} ${obj[owner]}, outside this export, and also a row of this export. Nothing was written.`);
  }
}

/**
 * The packages for one Backbone folder: { files, counts, differences, notices, overwrites, backboneVersion }.
 * `existing(name)` returns a committed file's text, or undefined; `ownerDecisions` is OWNER_DECISIONS.md's text.
 */
export function exportYouthRecreational(backboneDir, existing = () => undefined, { allowOverwrite = false, ownerDecisions = '' } = {}) {
  const set = readSet(backboneDir);
  const backboneVersion = `yr ${sha16(Buffer.from([...set.hashes].sort(compare).join('\n')))} (${set.hashes.length} files)`;
  const dropped = {};
  const tally = {};
  const notes = [];
  const counts = { besideLines: 0 };
  const drillText = existing(FILES.drills);
  if (drillText === undefined) throw new ExportError(`${FILES.drills} is not in the output folder; item drill references are checked against it`);
  const drillIds = new Set(committedRows(drillText, readCsv(drillText).header).map((row) => row.drill_id));

  const templateSet = templateRows(set.templates, drillIds, dropped, tally, notes);
  const trackSet = trackRows(set, ownerDecisions, dropped, tally, counts);
  const scriptSet = scriptRows(set.scripts, existing, dropped, tally);
  const ownerPassages = [...set.tracks, ...set.templates].reduce((sum, record) => sum + (Array.isArray(record.owner_passages) ? record.owner_passages.length : 0), 0);

  Object.assign(counts, {
    tracks: trackSet.trackCells.length, blocks: trackSet.blockCells.length, blockSessions: trackSet.sessionCells.length, templates: templateSet.rows.length,
    items: templateSet.items.length, heldTemplates: set.held.length, heldItems: set.held.reduce((sum, record) => sum + (record.items ?? []).length, 0), scripts: set.scripts.length, scriptBlocks: scriptSet.blocks.length, quoteKeys: dropped.quote ?? 0, ownerPassages,
    sp10Sentences: dropped.sp10Sentences ?? 0,
  });
  if (dropped.quotes) counts.quotesKeys = dropped.quotes;
  const differences = Object.entries(EXPECTED_COUNTS).filter(([key, expected]) => counts[key] !== expected).map(([key, expected]) => `${key}: brief ${expected}, observed ${counts[key]}`);

  const templateIds = new Set(templateSet.rows.map((row) => row.template_id));
  const trackIds = new Set(trackSet.trackCells.map((row) => row.track_id));
  const ordinal = (column, order = 'ordinal') => (a, b) => compare(a[column], b[column]) || Number(a[order]) - Number(b[order]);
  const files = {};
  const overwrites = [];
  const stops = [];
  const put = (name, rows, replaces) => {
    const committed = committedRows(existing(name), HEADERS[name]);
    const replaced = committed.filter(replaces);
    const kept = committed.filter((row) => !replaces(row));
    checkUniqueIds(name, kept, rows);
    overwrites.push(...findOverwrites(name, replaced, rows));
    stops.push(...heldTextFindings(name, HEADERS[name], rows));
    if (name === FILES.items) stops.push(...typedLineFindings(name, replaced, rows));
    // A replaced row keeps its place; new rows follow the kept ones.
    const byId = new Map(rows.map((row) => [guardId(name, row), row]));
    const inPlace = committed.map((row) => (replaces(row) ? byId.get(guardId(name, row)) : row)).filter(Boolean);
    const placed = new Set(committed.filter(replaces).map((row) => guardId(name, row)));
    const added = rows.filter((row) => !placed.has(guardId(name, row)));
    files[name] = writeCsv(HEADERS[name], [...inPlace, ...added].map((obj) => HEADERS[name].map((column) => obj[column] ?? '')));
  };
  // A held template's committed rows are this lane's too: the export removes them (the guard names it).
  const ofTemplate = (row) => templateIds.has(row.template_id) || Object.hasOwn(HELD_TEMPLATES, row.template_id);
  const ofTrack = (row) => trackIds.has(row.track_id);
  const ofScript = (row) => row.script_id === SCRIPT_ID;
  put(FILES.templates, templateSet.rows, ofTemplate);
  put(FILES.items, templateSet.items.sort(ordinal('template_id')), ofTemplate);
  put(FILES.tracks, trackSet.trackCells, ofTrack);
  put(FILES.blocks, trackSet.blockCells.sort(ordinal('track_id', 'block_order')), ofTrack);
  put(FILES.sessions, trackSet.sessionCells, ofTrack);
  put(FILES.scripts, [scriptSet.root], ofScript);
  put(FILES.scriptBlocks, scriptSet.blocks, ofScript);
  const overwriteLines = describeOverwrites(overwrites);
  const stopText = stopMessage(stops);
  if (overwrites.length && !allowOverwrite) {
    throw new ExportError([
      `refused: this run would change or remove ${overwrites.length} committed row(s): edits made in the repo since the export. Nothing was written.`,
      ...overwriteLines,
      ...(stopText
        ? ['--allow-overwrite would not write this run either.', stopText]
        : ['To write the frozen Backbone\'s rows over them on purpose, run again with --allow-overwrite.']),
    ].join('\n'));
  }
  if (stopText) throw new ExportError(stopText);

  const notCarried = Object.entries(tally).sort(([a], [b]) => compare(a, b)).map(([key, n]) => `${key} x${n}`);
  return {
    backboneVersion,
    counts,
    differences,
    files,
    overwrites,
    notices: [
      `research excerpt keys dropped: quote ${dropped.quote ?? 0}, quotes ${dropped.quotes ?? 0}; sp10 sentences repeating their quote dropped: ${dropped.sp10Sentences ?? 0}; owner passages carried: ${ownerPassages}`,
      `record keys not carried (kind.key xcount): ${notCarried.join(', ')}`,
      `beside-lines placed (${BESIDE_LINE.ruling}): ${counts.besideLines}`,
      `HELD, not exported (OD-2026-10-02-013 2A): ${set.held.map((record) => `${record.template_id} (${(record.items ?? []).length} items)`).join(', ')}`,
      ...notes,
      ...(overwrites.length ? [`--allow-overwrite: changed or removed ${overwrites.length} committed row(s):`, ...overwriteLines] : []),
      ...(differences.length ? [`COUNTS DIFFER FROM THE BRIEF: ${differences.join('; ')}`] : []),
    ],
  };
}

const USAGE = 'usage: node scripts/backbone-export-youth-recreational.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]';

export function parseArgs(argv) {
  const positional = [];
  let out;
  let allowOverwrite = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      if (!out) throw new ExportError(`--out needs a folder\n${USAGE}`);
      i += 1;
    } else if (argv[i] === '--allow-overwrite') allowOverwrite = true;
    else if (argv[i].startsWith('--')) throw new ExportError(`unknown option ${argv[i]}\n${USAGE}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new ExportError(`give exactly one Backbone folder\n${USAGE}`);
  return { backboneDir: positional[0], out, allowOverwrite };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const args = parseArgs(process.argv.slice(2));
    const typedIn = process.env.INIT_CWD ?? process.cwd();
    const out = args.out ? path.resolve(typedIn, args.out) : path.join(here, '..', 'seed-data');
    const existing = (name) => {
      const file = path.join(out, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    };
    const ownerDecisions = fs.readFileSync(path.join(here, '..', '..', '..', 'docs', 'current', 'OWNER_DECISIONS.md'), 'utf8');
    const result = exportYouthRecreational(path.resolve(typedIn, args.backboneDir), existing, { allowOverwrite: args.allowOverwrite, ownerDecisions });
    for (const [name, text] of Object.entries(result.files)) {
      fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
      fs.writeFileSync(path.join(out, name), text, 'utf8');
    }
    console.log(`backbone_version: ${result.backboneVersion}`);
    console.log(`counts: ${Object.entries(result.counts).map(([key, n]) => `${key} ${n}`).join(', ')} -> ${out}`);
    for (const notice of result.notices) console.log(notice);
    if (result.differences.length) process.exit(2);
  } catch (error) {
    if (error instanceof ExportError) {
      console.error(`backbone-export-youth-recreational: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
