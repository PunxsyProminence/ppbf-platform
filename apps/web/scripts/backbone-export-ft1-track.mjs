#!/usr/bin/env node
// BACKBONE -> FT1 TRACK PACKAGES (lane FT1b; OD-2026-11-11-003).
//
//   node scripts/backbone-export-ft1-track.mjs <backbone-folder> [--out <seed-data folder>]
//   npm run backbone:export-ft1 -- <backbone-folder> [--out <seed-data folder>]
//
// The 8-week non-contact FT1 class track, from the frozen Backbone into three content packages:
//   drill-library     131 drills + their cues and own stop rules   (rows ADDED to the committed CSVs)
//   workout-templates  33 templates + 131 items                    (rows ADDED to the committed CSVs)
//   training-tracks     1 track, 8 blocks, 40 block sessions       (new CSVs)
// --out defaults to apps/web/seed-data. Existing rows of the two committed packages are kept
// exactly as they are; rows of the FT1 set already in a file are replaced, so a second run is
// byte-identical.
//
// THE SET. The track's blocks, the templates they list, and the drills those templates and
// the blocks' optional_drill_refs name. It must equal every record whose stage_keys is exactly
// ["FT1"]; a difference stops the export (the brief's counts: 1 / 8 / 40 / 33 / 131 / 131).
//
// FROZEN, READ-ONLY, HASHED. Every file read is hashed (sha256, first 16 hex) against
// FREEZE_MANIFEST.json `files`; a mismatch, or a file the manifest does not list, stops the
// export. backbone_version is stamped from those hashes, never from file times.
//
// COPY, NEVER REWORD. Text is the Backbone's own, NFC and trimmed; null is a blank cell; JSON
// cells are the Backbone's own JSON with keys sorted. Nothing under `record` is dropped silently:
// every key is either carried or listed in NOT_CARRIED below (and printed); an unknown key stops
// the export. Licensed excerpts (`quote`, `quotes`, `owner_passages`, at any depth) never enter
// this public repository (OD-2026-10-02-013 2A); the count dropped is printed (0 in the frozen set).
// A value the app cannot take is the app's validator's to refuse, never a quiet edit here.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ORG_PLACEHOLDER = '{{PPBF_ORG_ID}}';
export const FT1_TRACK_ID = 'trk_d104860a7eccef';
export const MANIFEST_FILE = 'FREEZE_MANIFEST.json';
export const CONTENT_DIRS = { tracks: 'data/content/tracks', blocks: 'data/content/blocks', sessions: 'data/content/sessions', drills: 'data/content/drills' };
export const EXCERPT_KEYS = ['quote', 'quotes', 'owner_passages'];
export const EXPECTED_COUNTS = { tracks: 1, blocks: 8, blockSessions: 40, templates: 33, items: 131, drills: 131, cues: 131, stopRules: 9, scaleLevels: 0 };

export class ExportError extends Error {}

// Backbone record keys, by kind: carried (to a column or a JSON cell) and deliberately not carried.
const LABELS = ['field_labels', 'evidence', 'stage_keys'];
export const KEYS = {
  drill: {
    carried: ['organization_id', 'drill_id', 'lineage_id', 'name', 'discipline', 'category', 'target_behavior', 'purpose', 'standard_setup', 'execution',
      'what_good_looks_like', 'what_bad_looks_like', 'common_errors', 'corrections', 'transfer', 'contact_level', 'equipment_needed',
      'requires_coach_authorization', 'content_class', 'source_ref', 'difficulty', 'grounding_claim_ids', 'field_provenance', 'active', 'cues', 'stop_rules', ...LABELS],
    notCarried: ['status', 'sources', 'stage_links', 'scale_levels'],
  },
  template: {
    carried: ['organization_id', 'template_id', 'lineage_id', 'name', 'session_type', 'difficulty', 'age_band', 'duration_minutes', 'intent', 'coach_notes',
      'requires_coach_authorization', 'active', 'items', ...LABELS],
    notCarried: ['session_kind', 'contact_structure', 'track_id', 'status', 'sources', 'stage_links'],
  },
  item: { carried: ['item_id', 'ordinal', 'block', 'contact_level', 'drill_id', 'free_text_drill', 'scale_level'], notCarried: [] },
  cue: { carried: ['cue_id', 'cue_text', 'focus_type', 'source_ref'], notCarried: [] },
  stopRule: { carried: ['stop_rule_id', 'ordinal', 'condition_text', 'scope', 'rule_kind'], notCarried: [] },
  track: {
    carried: ['organization_id', 'track_id', 'lineage_id', 'name', 'lane', 'track', 'duration_weeks', 'delivered_to_program_id', 'age_band', 'status', 'sources', 'active',
      'block_ids', 'decision_cycle', 'daily_domain_order', 'domain_roles', 'weekly_rhythm', 'friday_protocol', 'week_titles', 'punch_introduction_guideline',
      'primary_cue', 'coach_intervention_standards', 'source_references_note', ...LABELS],
    notCarried: ['stage_links'],
  },
  block: {
    carried: ['organization_id', 'track_block_id', 'lineage_id', 'track_id', 'block_order', 'title', 'weeks', 'description', 'session_refs', 'optional_drill_refs',
      'status', 'sources', ...LABELS],
    notCarried: ['active'],
  },
  sessionRef: { carried: ['week', 'day', 'template_id'], notCarried: [] },
};
const TRACK_DETAILS = ['decision_cycle', 'daily_domain_order', 'domain_roles', 'weekly_rhythm', 'friday_protocol', 'week_titles', 'punch_introduction_guideline',
  'primary_cue', 'coach_intervention_standards', 'source_references_note'];
const BLOCK_DETAILS = ['description', 'optional_drill_refs'];

const DRILL_HEADER = ['organization_id', 'drill_id', 'lineage_id', 'version', 'supersedes_drill_id', 'superseded_at', 'name', 'discipline', 'category', 'skill_id',
  'target_behavior', 'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'what_bad_looks_like', 'common_errors', 'corrections', 'transfer',
  'contact_level', 'equipment_needed', 'requires_coach_authorization', 'content_class', 'source_ref', 'active', 'created_by_account_id', 'difficulty',
  'grounding_claim_ids', 'field_provenance', ...LABELS];
const TEMPLATE_HEADER = ['organization_id', 'template_id', 'lineage_id', 'version', 'supersedes_template_id', 'superseded_at', 'name', 'session_type', 'difficulty',
  'age_band', 'duration_minutes', 'intent', 'coach_notes', 'requires_coach_authorization', 'active', 'created_by_account_id', ...LABELS];
export const HEADERS = {
  'drill-library/seed_drill_library.csv': DRILL_HEADER,
  'drill-library/seed_drill_cues.csv': ['organization_id', 'cue_id', 'drill_id', 'cue_text', 'cue_family', 'focus_type', 'evidence_note', 'source_ref'],
  'drill-library/seed_drill_stop_rules.csv': ['organization_id', 'stop_rule_id', 'drill_id', 'ordinal', 'condition_text', 'scope', 'rule_kind'],
  'workout-templates/seed_workout_templates.csv': TEMPLATE_HEADER,
  'workout-templates/seed_workout_template_items.csv': ['organization_id', 'item_id', 'template_id', 'ordinal', 'block', 'drill_id', 'free_text_drill', 'duration_minutes',
    'rep_count', 'contact_level', 'coach_note', 'scale_level'],
  'training-tracks/seed_training_tracks.csv': ['organization_id', 'track_id', 'lineage_id', 'version', 'supersedes_track_id', 'superseded_at', 'name', 'lane', 'track',
    'duration_weeks', 'delivered_to_program_id', 'age_band', 'status', 'sources', 'details', 'active', 'created_by_account_id', ...LABELS],
  'training-tracks/seed_track_blocks.csv': ['organization_id', 'track_block_id', 'block_lineage_id', 'track_id', 'block_order', 'title', 'weeks', 'status', 'sources',
    'field_labels', 'evidence', 'stage_keys', 'details'],
  'training-tracks/seed_track_block_sessions.csv': ['organization_id', 'block_session_id', 'track_id', 'block_order', 'ordinal', 'week', 'day', 'template_lineage_id'],
};

/** JSON with object keys sorted at every depth (contentImport/canonical.ts sortedJson). */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** contentImport/csv.ts writeCsv: minimal quoting, LF, final newline, no BOM. */
export function writeCsv(header, rows) {
  const quote = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return `${[header, ...rows].map((cells) => cells.map(quote).join(',')).join('\n')}\n`;
}

/** contentImport/csv.ts readCsv, for the committed files (quoted cells, doubled quotes, LF or CRLF, optional BOM). */
export function readCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function textCell(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ExportError(`${where} is ${JSON.stringify(value)}, not text`);
  return value.normalize('NFC').trim();
}
function numberCell(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ExportError(`${where} is ${JSON.stringify(value)}, not a number`);
  return String(value);
}
function boolCell(value, where) {
  if (typeof value !== 'boolean') throw new ExportError(`${where} is ${JSON.stringify(value)}, not true or false`);
  return String(value);
}

/** The value with every excerpt key removed at any depth; `count.keys` counts them. */
function stripExcerpts(value, count) {
  if (Array.isArray(value)) return value.map((item) => stripExcerpts(item, count));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (EXCERPT_KEYS.includes(key)) count.keys += 1;
    else out[key] = stripExcerpts(inner, count);
  }
  return out;
}

/** Throws unless every key of `record` is carried or deliberately not carried (nothing lost silently). */
function checkKeys(kind, record, where, tally) {
  if (!isObject(record)) throw new ExportError(`${where} is not an object`);
  const { carried, notCarried } = KEYS[kind];
  if (record.organization_id !== undefined && record.organization_id !== ORG_PLACEHOLDER) {
    throw new ExportError(`${where}: organization_id ${JSON.stringify(record.organization_id)} is not ${ORG_PLACEHOLDER}; the export always writes the placeholder`);
  }
  for (const key of Object.keys(record)) {
    if (carried.includes(key)) continue;
    if (notCarried.includes(key)) {
      tally[`${kind}.${key}`] = (tally[`${kind}.${key}`] ?? 0) + 1;
      continue;
    }
    throw new ExportError(`${where}: key ${JSON.stringify(key)} has no column and is not on the not-carried list; report it, do not drop it`);
  }
}

/** The three label cells: field_labels (object), evidence (list), stage_keys ('|' list). */
function labelCells(record, where, dropped, { stageKeysAsJson = false } = {}) {
  const cells = {};
  if (record.field_labels === undefined || record.field_labels === null) cells.field_labels = '';
  else if (!isObject(record.field_labels)) throw new ExportError(`${where}: field_labels is not an object`);
  else cells.field_labels = sortedJson(stripExcerpts(record.field_labels, dropped));
  if (record.evidence === undefined || record.evidence === null) cells.evidence = '';
  else if (!Array.isArray(record.evidence) || !record.evidence.every(isObject)) throw new ExportError(`${where}: evidence must be a list of entries`);
  else cells.evidence = record.evidence.length ? sortedJson(stripExcerpts(record.evidence, dropped)) : '';
  const stages = record.stage_keys ?? [];
  if (!Array.isArray(stages) || !stages.every((key) => typeof key === 'string')) throw new ExportError(`${where}: stage_keys must be a list of text`);
  cells.stage_keys = stageKeysAsJson ? (stages.length ? sortedJson(stages) : '') : stages.join('|');
  return cells;
}

/** The JSON list cell for `sources` (a source may hold a comma, so never a '|' list). */
function sourcesCell(sources, where) {
  if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string')) throw new ExportError(`${where}: sources must be a list of source keys`);
  return sortedJson(sources.map((source) => source.normalize('NFC').trim()));
}

// ---- reading the frozen Backbone, hashed ----

function loadManifest(backboneDir) {
  const file = path.join(backboneDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new ExportError(`not found: ${file}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(manifest.files)) throw new ExportError(`${MANIFEST_FILE}: files[] is missing`);
  return new Map(manifest.files.map((entry) => [entry.path, entry.sha256_16]));
}

/** Reads every JSON file of a content folder, each checked against the manifest. Returns [{ file, hash, wrapper }]. */
function readDir(backboneDir, manifest, dir, hashes) {
  const full = path.join(backboneDir, dir);
  if (!fs.existsSync(full)) throw new ExportError(`not found: ${full}`);
  return fs.readdirSync(full).filter((name) => name.endsWith('.json')).sort(compare).map((name) => {
    const rel = `${dir}/${name}`;
    const bytes = fs.readFileSync(path.join(full, name));
    const hash = sha16(bytes);
    if (!manifest.has(rel)) throw new ExportError(`${rel} is not in ${MANIFEST_FILE}`);
    if (manifest.get(rel) !== hash) throw new ExportError(`${rel}: hash ${hash} differs from ${MANIFEST_FILE} (${manifest.get(rel)}); the frozen Backbone has changed`);
    hashes.push(`${rel}:${hash}`);
    const wrapper = JSON.parse(bytes.toString('utf8'));
    if (!isObject(wrapper.record)) throw new ExportError(`${rel}: record is missing`);
    return { file: rel, wrapper, record: wrapper.record };
  });
}

const isFt1 = (record) => Array.isArray(record.stage_keys) && record.stage_keys.length === 1 && record.stage_keys[0] === 'FT1';
const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));

/** The FT1 set, found by reachability from the track, and checked equal to the stage_keys ["FT1"] set. */
export function readFt1(backboneDir) {
  const manifest = loadManifest(backboneDir);
  const hashes = [];
  const tracks = readDir(backboneDir, manifest, CONTENT_DIRS.tracks, hashes).map((entry) => entry.record);
  const blocksAll = readDir(backboneDir, manifest, CONTENT_DIRS.blocks, hashes).map((entry) => entry.record);
  const sessionsAll = readDir(backboneDir, manifest, CONTENT_DIRS.sessions, hashes).map((entry) => entry.record);
  const drillsAll = readDir(backboneDir, manifest, CONTENT_DIRS.drills, hashes).map((entry) => entry.record);

  const track = tracks.find((candidate) => candidate.track_id === FT1_TRACK_ID);
  if (!track) throw new ExportError(`track ${FT1_TRACK_ID} not found`);
  const blocks = blocksAll.filter((block) => block.track_id === FT1_TRACK_ID).sort((a, b) => a.block_order - b.block_order);
  const templateById = new Map(sessionsAll.map((template) => [template.template_id, template]));
  const drillById = new Map(drillsAll.map((drill) => [drill.drill_id, drill]));

  const templateIds = new Set();
  const drillIds = new Set();
  for (const block of blocks) {
    for (const ref of block.session_refs ?? []) templateIds.add(ref.template_id);
    for (const ref of block.optional_drill_refs ?? []) drillIds.add(typeof ref === 'string' ? ref : ref?.drill_id);
  }
  const templates = [...templateIds].sort(compare).map((id) => {
    const template = templateById.get(id);
    if (!template) throw new ExportError(`block session names template ${id}, which is not in the Backbone`);
    for (const item of template.items ?? []) if (item.drill_id) drillIds.add(item.drill_id);
    return template;
  });
  const drills = [...drillIds].sort(compare).map((id) => {
    const drill = drillById.get(id);
    if (!drill) throw new ExportError(`drill ${id} is named but not in the Backbone`);
    return drill;
  });

  const ft1Templates = new Set(sessionsAll.filter(isFt1).map((r) => r.template_id));
  const ft1Drills = new Set(drillsAll.filter(isFt1).map((r) => r.drill_id));
  const ft1Blocks = new Set(blocksAll.filter(isFt1).map((r) => r.track_block_id));
  if (!sameSet(ft1Templates, templateIds)) throw new ExportError(`templates reachable from the track (${templateIds.size}) differ from those with stage_keys ["FT1"] (${ft1Templates.size})`);
  if (!sameSet(ft1Drills, drillIds)) throw new ExportError(`drills reachable from the track (${drillIds.size}) differ from those with stage_keys ["FT1"] (${ft1Drills.size})`);
  if (!sameSet(ft1Blocks, new Set(blocks.map((block) => block.track_block_id)))) throw new ExportError('the track\'s blocks differ from the blocks with stage_keys ["FT1"]');
  return { track, blocks, templates, drills, hashes };
}

// ---- building the rows ----

function drillRows(drills, version, dropped, tally) {
  const library = [];
  const cues = [];
  const stopRules = [];
  const counts = { scaleLevels: 0 };
  for (const drill of drills) {
    const where = `drill ${drill.drill_id}`;
    checkKeys('drill', drill, where, tally);
    if (textCell(drill.lineage_id, `${where} lineage_id`) !== drill.drill_id) throw new ExportError(`${where}: lineage_id differs from drill_id`);
    if ((drill.scale_levels ?? []).length) counts.scaleLevels += drill.scale_levels.length;
    if (!Array.isArray(drill.grounding_claim_ids)) throw new ExportError(`${where}: grounding_claim_ids must be a list`);
    const cells = {
      organization_id: ORG_PLACEHOLDER, drill_id: drill.drill_id, lineage_id: drill.lineage_id, version: '1', supersedes_drill_id: '', superseded_at: '',
      skill_id: '', created_by_account_id: '',
      grounding_claim_ids: drill.grounding_claim_ids.map((id) => textCell(id, `${where} grounding_claim_ids`)).join('|'),
      requires_coach_authorization: boolCell(drill.requires_coach_authorization, `${where} requires_coach_authorization`),
      active: boolCell(drill.active, `${where} active`),
      ...labelCells(drill, where, dropped),
    };
    for (const key of ['name', 'discipline', 'category', 'target_behavior', 'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'what_bad_looks_like',
      'common_errors', 'corrections', 'transfer', 'contact_level', 'equipment_needed', 'content_class', 'source_ref', 'difficulty', 'field_provenance']) {
      cells[key] = textCell(drill[key], `${where} ${key}`);
    }
    library.push(cells);
    for (const cue of drill.cues ?? []) {
      checkKeys('cue', cue, `${where} cue`, tally);
      cues.push({ organization_id: ORG_PLACEHOLDER, cue_id: textCell(cue.cue_id, `${where} cue_id`), drill_id: drill.drill_id, cue_text: textCell(cue.cue_text, `${where} cue_text`),
        cue_family: '', focus_type: textCell(cue.focus_type, `${where} focus_type`), evidence_note: '', source_ref: textCell(cue.source_ref, `${where} cue source_ref`) });
    }
    for (const rule of drill.stop_rules ?? []) {
      checkKeys('stopRule', rule, `${where} stop rule`, tally);
      stopRules.push({ organization_id: ORG_PLACEHOLDER, stop_rule_id: textCell(rule.stop_rule_id, `${where} stop_rule_id`), drill_id: drill.drill_id,
        ordinal: numberCell(rule.ordinal, `${where} stop rule ordinal`), condition_text: textCell(rule.condition_text, `${where} condition_text`),
        scope: textCell(rule.scope, `${where} scope`), rule_kind: textCell(rule.rule_kind, `${where} rule_kind`) });
    }
  }
  return { library, cues, stopRules, counts };
}

function templateRows(templates, version, dropped, tally) {
  const rows = [];
  const items = [];
  for (const template of templates) {
    const where = `template ${template.template_id}`;
    checkKeys('template', template, where, tally);
    if (template.lineage_id !== template.template_id) throw new ExportError(`${where}: lineage_id differs from template_id`);
    rows.push({
      organization_id: ORG_PLACEHOLDER, template_id: template.template_id, lineage_id: template.lineage_id, version: '1', supersedes_template_id: '', superseded_at: '',
      name: textCell(template.name, `${where} name`), session_type: textCell(template.session_type, `${where} session_type`), difficulty: textCell(template.difficulty, `${where} difficulty`),
      age_band: textCell(template.age_band, `${where} age_band`), duration_minutes: numberCell(template.duration_minutes, `${where} duration_minutes`),
      intent: textCell(template.intent, `${where} intent`), coach_notes: textCell(template.coach_notes, `${where} coach_notes`),
      requires_coach_authorization: boolCell(template.requires_coach_authorization, `${where} requires_coach_authorization`),
      active: boolCell(template.active, `${where} active`), created_by_account_id: '',
      ...labelCells(template, where, dropped),
    });
    for (const item of template.items ?? []) {
      checkKeys('item', item, `${where} item`, tally);
      items.push({
        organization_id: ORG_PLACEHOLDER, item_id: textCell(item.item_id, `${where} item_id`), template_id: template.template_id, ordinal: numberCell(item.ordinal, `${where} item ordinal`),
        block: textCell(item.block, `${where} item block`), drill_id: textCell(item.drill_id, `${where} item drill_id`),
        free_text_drill: textCell(item.free_text_drill, `${where} item free_text_drill`), duration_minutes: '', rep_count: '',
        contact_level: textCell(item.contact_level, `${where} item contact_level`), coach_note: '', scale_level: textCell(item.scale_level, `${where} item scale_level`),
      });
    }
  }
  return { rows, items };
}

function trackRows({ track, blocks }, version, dropped, tally) {
  const where = `track ${track.track_id}`;
  checkKeys('track', track, where, tally);
  if (track.lineage_id !== track.track_id) throw new ExportError(`${where}: lineage_id differs from track_id`);
  const blockIds = blocks.map((block) => block.track_block_id);
  if (!Array.isArray(track.block_ids) || track.block_ids.length !== blockIds.length || track.block_ids.some((id, index) => id !== blockIds[index])) {
    throw new ExportError(`${where}: block_ids ${JSON.stringify(track.block_ids)} differ from the blocks file's ids in block_order ${JSON.stringify(blockIds)}`);
  }
  const details = Object.fromEntries(TRACK_DETAILS.filter((key) => track[key] !== undefined).map((key) => [key, track[key]]));
  const trackCells = {
    organization_id: ORG_PLACEHOLDER, track_id: track.track_id, lineage_id: track.lineage_id, version: '1', supersedes_track_id: '', superseded_at: '',
    name: textCell(track.name, `${where} name`), lane: textCell(track.lane, `${where} lane`), track: textCell(track.track, `${where} track`),
    duration_weeks: numberCell(track.duration_weeks, `${where} duration_weeks`), delivered_to_program_id: textCell(track.delivered_to_program_id, `${where} delivered_to_program_id`),
    age_band: textCell(track.age_band, `${where} age_band`), status: textCell(track.status, `${where} status`), sources: sourcesCell(track.sources, where),
    details: sortedJson(stripExcerpts(details, dropped)), active: boolCell(track.active, `${where} active`), created_by_account_id: '',
    ...labelCells(track, where, dropped),
  };
  const blockCells = [];
  const sessionCells = [];
  blocks.forEach((block, index) => {
    const at = `block ${block.track_block_id}`;
    checkKeys('block', block, at, tally);
    if (block.active !== true) throw new ExportError(`${at}: active is ${JSON.stringify(block.active)}; a block has no active column, so only an active block can be exported`);
    if (block.lineage_id !== block.track_block_id) throw new ExportError(`${at}: lineage_id differs from track_block_id`);
    if (block.block_order !== index + 1) throw new ExportError(`${at}: block_order ${block.block_order} is not ${index + 1} (blocks must run 1..n without gaps)`);
    const labels = labelCells(block, at, dropped, { stageKeysAsJson: true });
    blockCells.push({
      organization_id: ORG_PLACEHOLDER, track_block_id: block.track_block_id, block_lineage_id: block.lineage_id, track_id: track.track_id,
      block_order: numberCell(block.block_order, `${at} block_order`), title: textCell(block.title, `${at} title`), weeks: numberCell(block.weeks, `${at} weeks`),
      status: textCell(block.status, `${at} status`), sources: sourcesCell(block.sources, at), ...labels,
      details: sortedJson(stripExcerpts(Object.fromEntries(BLOCK_DETAILS.filter((key) => block[key] !== undefined).map((key) => [key, block[key]])), dropped)),
    });
    (block.session_refs ?? []).forEach((ref, position) => {
      checkKeys('sessionRef', ref, `${at} session_ref ${position + 1}`, tally);
      sessionCells.push({
        organization_id: ORG_PLACEHOLDER, block_session_id: '', track_id: track.track_id, block_order: String(block.block_order), ordinal: String(position + 1),
        week: numberCell(ref.week, `${at} session_ref week`), day: textCell(ref.day, `${at} session_ref day`), template_lineage_id: textCell(ref.template_id, `${at} session_ref template_id`),
      });
    });
  });
  return { trackCells, blockCells, sessionCells };
}

// ---- merging into the committed files ----

/** The committed file's rows, minus any row whose key cell is in `replace`, then the new rows; ordered new rows by `sortKey`. */
function mergeCsv(existingText, header, newRows, keyColumns, replaceKeys) {
  const keyOf = (obj) => keyColumns.map((column) => obj[column] ?? '').join('\u0000');
  let kept = [];
  if (existingText) {
    const table = readCsv(existingText);
    const index = new Map(table.header.map((name, position) => [name, position]));
    for (const name of table.header) if (!header.includes(name)) throw new ExportError(`committed file has column ${name}, which the exporter does not know`);
    for (const cells of table.rows) {
      const obj = Object.fromEntries(header.map((name) => [name, index.has(name) ? (cells[index.get(name)] ?? '') : '']));
      if (!replaceKeys.has(keyOf(obj))) kept.push(obj);
    }
  }
  const all = [...kept, ...newRows];
  return writeCsv(header, all.map((obj) => header.map((column) => obj[column] ?? '')));
}

/**
 * The packages for one Backbone folder: { files: { 'folder/file.csv': text }, counts, notices, backboneVersion }.
 * `existing(name)` returns a committed file's text, or undefined.
 */
export function exportFt1Track(backboneDir, existing = () => undefined) {
  const set = readFt1(backboneDir);
  const backboneVersion = `ft1 ${sha16(Buffer.from([...set.hashes].sort(compare).join('\n')))} (${set.hashes.length} files)`;
  const dropped = { keys: 0 };
  const tally = {};
  const drillSet = drillRows(set.drills, backboneVersion, dropped, tally);
  const templateSet = templateRows(set.templates, backboneVersion, dropped, tally);
  const trackSet = trackRows(set, backboneVersion, dropped, tally);

  const counts = {
    tracks: 1, blocks: trackSet.blockCells.length, blockSessions: trackSet.sessionCells.length, templates: templateSet.rows.length, items: templateSet.items.length,
    drills: drillSet.library.length, cues: drillSet.cues.length, stopRules: drillSet.stopRules.length, scaleLevels: drillSet.counts.scaleLevels,
  };
  const differences = Object.entries(EXPECTED_COUNTS).filter(([key, expected]) => counts[key] !== expected).map(([key, expected]) => `${key}: brief ${expected}, observed ${counts[key]}`);

  const byId = (column) => (a, b) => compare(a[column], b[column]);
  const ordinal = (column) => (a, b) => compare(a[column], b[column]) || Number(a.ordinal) - Number(b.ordinal);
  const lib = drillSet.library.sort(byId('drill_id'));
  const drillIdSet = new Set(lib.map((row) => row.drill_id));
  const templateIdSet = new Set(templateSet.rows.map((row) => row.template_id));
  const files = {};
  const put = (name, keyColumns, replaceKeys, rows) => {
    files[name] = mergeCsv(existing(name), HEADERS[name], rows, keyColumns, replaceKeys);
  };
  put('drill-library/seed_drill_library.csv', ['drill_id'], drillIdSet, lib);
  // Rows a drill (or template) lists replace ALL of its rows in a child file, as the importer does.
  put('drill-library/seed_drill_cues.csv', ['drill_id'], drillIdSet, drillSet.cues.sort(ordinal('drill_id')));
  put('drill-library/seed_drill_stop_rules.csv', ['drill_id'], drillIdSet, drillSet.stopRules.sort(ordinal('drill_id')));
  put('workout-templates/seed_workout_templates.csv', ['template_id'], templateIdSet, templateSet.rows.sort(byId('template_id')));
  put('workout-templates/seed_workout_template_items.csv', ['template_id'], templateIdSet, templateSet.items.sort(ordinal('template_id')));
  const table = (name, rows) => writeCsv(HEADERS[name], rows.map((row) => HEADERS[name].map((column) => row[column] ?? '')));
  files['training-tracks/seed_training_tracks.csv'] = table('training-tracks/seed_training_tracks.csv', [trackSet.trackCells]);
  files['training-tracks/seed_track_blocks.csv'] = table('training-tracks/seed_track_blocks.csv', trackSet.blockCells);
  files['training-tracks/seed_track_block_sessions.csv'] = table('training-tracks/seed_track_block_sessions.csv', trackSet.sessionCells);

  const sessionTypes = {};
  for (const row of templateSet.rows) sessionTypes[row.session_type] = (sessionTypes[row.session_type] ?? 0) + 1;
  const notCarried = Object.entries(tally).sort(([a], [b]) => compare(a, b)).map(([key, n]) => `${key} x${n}`);
  return {
    backboneVersion,
    counts,
    differences,
    sessionTypes,
    files,
    notices: [
      `session_type values: ${Object.entries(sessionTypes).map(([value, n]) => `${value} ${n}`).join(', ')}`,
      `licensed excerpt keys (${EXCERPT_KEYS.join(', ')}) dropped: ${dropped.keys}`,
      `record keys not carried (kind.key xcount): ${notCarried.join(', ')}`,
      ...(differences.length ? [`COUNTS DIFFER FROM THE BRIEF: ${differences.join('; ')}`] : []),
    ],
  };
}

const USAGE = 'usage: node scripts/backbone-export-ft1-track.mjs <backbone-folder> [--out <seed-data folder>]';

export function parseArgs(argv) {
  const positional = [];
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      if (!out) throw new ExportError(`--out needs a folder\n${USAGE}`);
      i += 1;
    } else if (argv[i].startsWith('--')) throw new ExportError(`unknown option ${argv[i]}\n${USAGE}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new ExportError(`give exactly one Backbone folder\n${USAGE}`);
  return { backboneDir: positional[0], out };
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
    const result = exportFt1Track(path.resolve(typedIn, args.backboneDir), existing);
    for (const [name, text] of Object.entries(result.files)) {
      fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
      fs.writeFileSync(path.join(out, name), text, 'utf8');
    }
    console.log(`backbone_version: ${result.backboneVersion}`);
    console.log(`counts: ${JSON.stringify(result.counts)} -> ${out}`);
    for (const notice of result.notices) console.log(notice);
    if (result.differences.length) process.exit(2);
  } catch (error) {
    if (error instanceof ExportError) {
      console.error(`backbone-export-ft1-track: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
