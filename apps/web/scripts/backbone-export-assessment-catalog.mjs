#!/usr/bin/env node
// BACKBONE -> ASSESSMENT CATALOG PACKAGE (lane CAT-c; OD-2026-11-15-006 ruling 1,
// OD-2026-11-16-001; content-package intake route A, OD-2026-10-28-002).
//
//   node scripts/backbone-export-assessment-catalog.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]
//   npm run backbone:export:assessment-catalog -- <backbone-folder>
//
// Reads ONE file of the frozen Backbone, read-only, hashed against
// FREEZE_MANIFEST.json (a mismatch stops the export):
//   working/design-2026-10-25/design_catalogs.json
// and writes seven files of the `assessment-catalog` content package
// (contentImport/specs/assessmentCatalog.ts) under <out>/assessment-catalog/:
//   seed_assessment_protocols.csv       46 protocols
//   seed_scorecard_scales.csv            2 scales (live_long_road, cue_response_draft)
//   seed_scorecard_score_caps.csv        1 cap (non_contact_rule, D-Q11)
//   seed_scorecard_items.csv            29 scorecard items
//   seed_pathway_gates.csv              38 gates
//   seed_pathway_gate_criteria.csv      94 criteria
//   seed_scorecard_anchor_clip_specs.csv 105 anchor-clip specs
// and, from the frozen DOC-027 track data/content/tracks/trk_21ba0c958c98e1.json
// (lane CAT-d; OD-2026-11-16-003 ruling 1; owner rule D-PK77-1), the ROOM rows of
//   seed_behavior_kpi_lists.csv         the room list and its scoring line
//   seed_behavior_kpis.csv              DOC-027's 6 core behavioural KPIs
// Those two files also hold the DRILL list, DOC-041's 7 drill KPIs: DOC-041 is
// not in the frozen Backbone, so its rows (and the drafted scoring kinds and
// three-level anchors on them) are committed by hand and kept exactly as they
// are, in their place; only the room rows are written here.
// --out defaults to apps/web/seed-data.
// A count that differs from the brief is printed by name and the run exits 2.
//
// COPY, NEVER REWORD. Every text cell is the backbone's own value, Unicode NFC
// and trimmed; JSON cells are the backbone's own JSON with keys sorted; lists
// are '|'-joined. Every record key is carried to a column or a label, or is on
// the NOT_CARRIED list (printed with counts); an unknown key stops the export.
// The mapping is lane CAT's step-1 report, section 1 (Overwatch OK):
//   - criteria: text -> criterion_text; stage_key, gate_kind, gate_id (the gate
//     a gate_met criterion names) -> ref_stage_key, ref_gate_kind, ref_gate_id;
//     min, max, scope -> bout_min, bout_max, bout_scope; a field label keyed by
//     a renamed key follows it (text -> criterion_text);
//   - items: group -> item_group; contexts_status -> field_labels.scorable_contexts;
//     id_note -> field_labels.scorecard_item_id.note; scale_key read from the
//     scale text by SCALE_KEYS (labelled INFERRED);
//   - anchor specs: used_by_gates (stage keys) -> used_by_stage_keys;
//   - gates: schema_note -> field_labels.gate_kind.note;
//   - protocols: protocol_text, or description where there is none, ->
//     protocol_summary; quality_measured, boxing_specific and evidence_class
//     are not stated and load blank (Overwatch's CAT ruling Q1);
//     human_authority_required loads true, labelled INFERRED (Overwatch:
//     backbone RULES section 1, AI informs and humans decide);
//   - scales: each anchor set with its status (scale_definitions.status), the
//     cue_response_note on cue_response_draft;
//   - the cap: non_contact_rule as written, with its scale, protocol and
//     contexts read from its wording by CAP_SCOPE (labelled INFERRED); a
//     different wording stops the export rather than being re-read.
// NOT CARRIED: protocols' minted_from (the hand-off placeholder the PP id
// replaced); design_catalogs' meta and status_line (provenance in
// docs/backbone/ASSESSMENT_CATALOG_PROVENANCE.md, OD-2026-11-16-001); its
// default_rules (loaded as pathway stage defaults, lane BB-1c).
//
// LICENSED EXCERPTS STAY OUT OF THIS PUBLIC REPOSITORY: every `quotes` key is
// dropped at any depth and counted (OD-2026-10-02-013 answer 2A). The citation
// itself (statement_id, source key, location, labels) stays.
//
// THE OUTPUT IS A WHOLE SNAPSHOT: the same frozen file gives byte-identical
// CSVs (rows sorted by id, LF, UTF-8 without BOM). backbone_version is the
// file's hash, never a time, so a copy or re-sync changes nothing.
//
// OVERWRITE GUARD. A committed file that differs from what this run would write
// is not overwritten: each changed or removed row is printed by id and column,
// and nothing is written. --allow-overwrite writes anyway and prints the same list.
//
// It describes and informs. Nothing reads the catalog to move, place or restrict anyone.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CATALOGS_FILE = 'working/design-2026-10-25/design_catalogs.json';
export const ROOM_TRACK_FILE = 'data/content/tracks/trk_21ba0c958c98e1.json';
/** The owner rule that holds DOC-027's core behavioural KPIs, by its own source line. */
export const ROOM_SOURCE = 'DOC-027 (Punxsy Master Source Manual v1, Performance Tracking Source Manual v3, Core Behavioral KPIs)';
export const MANIFEST_FILE = 'FREEZE_MANIFEST.json';
export const FOLDER = 'assessment-catalog';
export const ORG_PLACEHOLDER = '{{PPBF_ORG_ID}}';
export const EXCERPT_KEYS = ['quotes'];
export const RECORD_STATUSES = ['OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED'];

export const EXPECTED_COUNTS = {
  protocols: 46, scales: 2, caps: 1, items: 29, gates: 38, criteria: 94, anchorSpecs: 105, excerptKeys: 4, excerptPassages: 10, roomKpis: 6,
};

const LABELS = ['field_labels', 'evidence', 'stage_keys'];
export const HEADERS = {
  'seed_assessment_protocols.csv': [
    'organization_id', 'protocol_id', 'protocol_version', 'name', 'measure_kind', 'source_ref', 'quality_measured', 'protocol_summary',
    'equipment_needed', 'time_to_administer_min', 'retest_interval_days', 'retest_after_training_hours', 'retest_interval_basis',
    'reliability_status', 'validity_status', 'evidence_class', 'boxing_specific', 'minimal_detectable_change', 'human_authority_required',
    'protocol_group', 'status', 'sources', 'decision', 'backbone_version', 'active', ...LABELS,
  ],
  'seed_scorecard_scales.csv': ['organization_id', 'scale_key', 'min_level', 'max_level', 'level_anchors', 'status', 'note', 'sources', 'backbone_version', 'active_flag', ...LABELS],
  'seed_scorecard_score_caps.csv': [
    'organization_id', 'cap_key', 'scale_key', 'max_score', 'applies_to', 'applies_to_protocol_id', 'applies_to_contexts', 'wording', 'decision',
    'note', 'status', 'sources', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_scorecard_items.csv': [
    'organization_id', 'scorecard_item_id', 'protocol_id', 'item_number', 'item_group', 'name', 'definition', 'scale', 'scale_key',
    'scorable_contexts', 'gaps', 'status', 'sources', 'decision', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_pathway_gates.csv': [
    'organization_id', 'gate_id', 'stage_key', 'gate_kind', 'informs_only', 'override_process', 'override_presets_status', 'status', 'sources',
    'decision', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_pathway_gate_criteria.csv': [
    'organization_id', 'criterion_id', 'gate_id', 'ordinal', 'kind', 'criterion_text', 'polarity', 'scorecard_item_ids', 'item_numbers', 'protocol_id',
    'min_score', 'contexts', 'combine', 'ref_stage_key', 'ref_gate_kind', 'ref_gate_id', 'bout_min', 'bout_max', 'bout_scope', 'note',
    'conflict_resolved', 'source_cell', 'status', 'sources', 'decision', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_scorecard_anchor_clip_specs.csv': [
    'organization_id', 'anchor_spec_id', 'scorecard_item_id', 'item_number', 'level', 'context_class', 'used_by_stage_keys', 'priority', 'status',
    'sources', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_behavior_kpi_lists.csv': [
    'organization_id', 'list_key', 'title', 'source_doc', 'scope_text', 'scoring_rule_text', 'status', 'sources', 'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_behavior_kpis.csv': [
    'organization_id', 'kpi_id', 'list_key', 'ordinal', 'name', 'scoring_kind', 'level_anchors', 'status', 'sources', 'backbone_version', 'active_flag', ...LABELS,
  ],
};
/** The KPI files: the room rows come from the Backbone, every other row is kept as committed. */
export const KPI_FILES = ['seed_behavior_kpi_lists.csv', 'seed_behavior_kpis.csv'];
/** Each file's id column, for sorting and the overwrite guard. */
export const KEY_OF = {
  'seed_assessment_protocols.csv': 'protocol_id',
  'seed_scorecard_scales.csv': 'scale_key',
  'seed_scorecard_score_caps.csv': 'cap_key',
  'seed_scorecard_items.csv': 'scorecard_item_id',
  'seed_pathway_gates.csv': 'gate_id',
  'seed_pathway_gate_criteria.csv': 'criterion_id',
  'seed_scorecard_anchor_clip_specs.csv': 'anchor_spec_id',
  'seed_behavior_kpi_lists.csv': 'list_key',
  'seed_behavior_kpis.csv': 'kpi_id',
};

/** Every key each record kind may carry; anything else stops the export. */
export const KEYS = {
  protocol: {
    carried: ['protocol_id', 'name', 'measure_kind', 'description', 'protocol_text', 'reliability_status', 'validity_status', 'protocol_group',
      'status', 'sources', 'evidence', 'decision'],
    notCarried: ['minted_from'],
  },
  item: {
    carried: ['scorecard_item_id', 'protocol_id', 'item_number', 'group', 'name', 'definition', 'scale', 'scorable_contexts', 'contexts_status',
      'gaps', 'id_note', 'status', 'sources', 'evidence', 'decision', 'organization_id'],
    notCarried: [],
  },
  gate: {
    carried: ['gate_id', 'stage_key', 'gate_kind', 'criteria', 'informs_only', 'override_process', 'override_presets_status', 'status', 'sources',
      'evidence', 'schema_note', 'decision'],
    notCarried: [],
  },
  criterion: {
    carried: ['criterion_id', 'ordinal', 'kind', 'text', 'polarity', 'scorecard_item_ids', 'item_numbers', 'protocol_id', 'min_score', 'contexts',
      'combine', 'stage_key', 'gate_kind', 'gate_id', 'min', 'max', 'scope', 'note', 'conflict_resolved', 'source_cell', 'status', 'sources',
      'decision', 'field_labels', 'evidence'],
    notCarried: [],
  },
  anchorSpec: {
    carried: ['anchor_spec_id', 'scorecard_item_id', 'item_number', 'level', 'context_class', 'used_by_gates', 'priority', 'status', 'sources'],
    notCarried: [],
  },
  catalogs: {
    carried: ['assessment_protocols', 'scorecard_items', 'gates', 'anchor_clip_specs', 'scale_definitions'],
    notCarried: ['meta', 'status_line', 'default_rules'],
  },
  scaleDefinitions: {
    carried: ['live_long_road', 'cue_response_draft', 'status', 'non_contact_rule', 'cue_response_note'],
    notCarried: [],
  },
  cap: { carried: ['wording', 'max_score', 'applies_to', 'decision', 'note'], notCarried: [] },
};

/** The scale an item's scale text names (INFERRED); a text not listed stops the export. Blank: the source gives none. */
export const SCALE_KEYS = {
  '1-5 (Long Road Part 2 section 3.1)': 'live_long_road',
  '1-5 (draft anchors, INFERRED; DOC-027 states no numeric scale)': 'cue_response_draft',
  'not in source (gap)': '',
};

/** The cap's scope, read from its frozen wording (INFERRED). A different wording stops the export. */
export const CAP_SCOPE = {
  applies_to: 'PP-T01 Long Road items scored in drill, shadow or partner contexts',
  wording: 'live_long_road (verbatim; the draft non-contact wording is withdrawn)',
  scale_key: 'live_long_road',
  applies_to_protocol_id: 'PP-T01',
  applies_to_contexts: ['drill', 'shadow', 'partner'],
};

const HUMAN_AUTHORITY_LABEL = {
  status: 'INFERRED',
  sources: ['RULES'],
  basis: 'Backbone RULES section 1 (AI informs and humans decide); the backbone does not state it per protocol (Overwatch, lane CAT-b)',
};

export class ExportError extends Error {}

/** JSON with keys sorted at every depth; every string NFC, as the text cells are. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key.normalize('NFC'))}:${sortedJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  return JSON.stringify(value) ?? 'null';
}

/** contentImport/csv.ts writeCsv: minimal quoting, LF, final newline, no BOM. */
export function writeCsv(header, rows) {
  const quote = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return `${[header, ...rows].map((cells) => cells.map(quote).join(',')).join('\n')}\n`;
}

/** contentImport/csv.ts readCsv, enough for the overwrite guard: RFC 4180 with LF. */
export function readCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function text(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ExportError(`${where} is ${JSON.stringify(value)}, not text`);
  return value.normalize('NFC').trim();
}
function number(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ExportError(`${where} is ${JSON.stringify(value)}, not a number`);
  return String(value);
}
function list(value, where, each = text) {
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) throw new ExportError(`${where} is not a list`);
  return value.map((item, index) => each(item, `${where}[${index}]`)).join('|');
}
function status(value, where) {
  if (value === undefined || value === null) return '';
  if (!RECORD_STATUSES.includes(value)) throw new ExportError(`${where}: status ${JSON.stringify(value)} is not one of ${RECORD_STATUSES.join(', ')}`);
  return value;
}

/** The value with every excerpt key removed at any depth; counts keys and the passages they held. */
function stripExcerpts(value, count) {
  if (Array.isArray(value)) return value.map((item) => stripExcerpts(item, count));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (EXCERPT_KEYS.includes(key)) {
      count.keys += 1;
      count.passages += Array.isArray(inner) ? inner.length : 1;
    } else out[key] = stripExcerpts(inner, count);
  }
  return out;
}

function evidence(value, where, dropped) {
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value) || !value.every(isObject)) throw new ExportError(`${where}: evidence must be a list of entries`);
  return value.length ? sortedJson(stripExcerpts(value, dropped)) : '';
}

function checkKeys(kind, record, where, tally) {
  if (!isObject(record)) throw new ExportError(`${where} is not an object`);
  const { carried, notCarried } = KEYS[kind];
  for (const key of Object.keys(record)) {
    if (carried.includes(key)) continue;
    if (notCarried.includes(key)) {
      tally[`${kind}.${key}`] = (tally[`${kind}.${key}`] ?? 0) + 1;
      continue;
    }
    throw new ExportError(`${where}: key ${JSON.stringify(key)} has no column and is not on the not-carried list; report it, do not drop it`);
  }
}

const labelsCell = (labels) => (Object.keys(labels).length ? sortedJson(labels) : '');

function protocolRow(record, version, dropped, tally) {
  const where = `protocol ${record.protocol_id ?? '(no protocol_id)'}`;
  checkKeys('protocol', record, where, tally);
  const summary = record.protocol_text ?? record.description;
  if (record.protocol_text !== undefined && record.description !== undefined) throw new ExportError(`${where}: both protocol_text and description; which one is the summary is not decided`);
  return {
    organization_id: ORG_PLACEHOLDER,
    protocol_id: text(record.protocol_id, `${where} protocol_id`),
    name: text(record.name, `${where} name`),
    measure_kind: text(record.measure_kind, `${where} measure_kind`),
    protocol_summary: text(summary, `${where} protocol_text`),
    reliability_status: text(record.reliability_status, `${where} reliability_status`),
    validity_status: text(record.validity_status, `${where} validity_status`),
    human_authority_required: 'true',
    protocol_group: text(record.protocol_group, `${where} protocol_group`),
    status: status(record.status, where),
    sources: list(record.sources, `${where} sources`),
    decision: text(record.decision, `${where} decision`),
    backbone_version: version,
    active: 'true',
    field_labels: labelsCell({ human_authority_required: HUMAN_AUTHORITY_LABEL }),
    evidence: evidence(record.evidence, where, dropped),
  };
}

function itemRow(record, version, dropped, tally) {
  const where = `scorecard item ${record.scorecard_item_id ?? '(no id)'}`;
  checkKeys('item', record, where, tally);
  if (record.organization_id !== undefined && record.organization_id !== ORG_PLACEHOLDER) {
    throw new ExportError(`${where}: organization_id ${JSON.stringify(record.organization_id)} is not ${ORG_PLACEHOLDER}`);
  }
  const scale = text(record.scale, `${where} scale`);
  if (!(scale in SCALE_KEYS)) throw new ExportError(`${where}: scale ${JSON.stringify(scale)} names no known scale; add it to SCALE_KEYS by decision, do not guess`);
  const labels = {};
  if (record.contexts_status !== undefined) labels.scorable_contexts = { status: status(record.contexts_status, `${where} contexts_status`) };
  if (record.id_note !== undefined) labels.scorecard_item_id = { note: text(record.id_note, `${where} id_note`) };
  if (SCALE_KEYS[scale]) labels.scale_key = { status: 'INFERRED', basis: 'read from the scale text (lane CAT mapping)' };
  return {
    organization_id: ORG_PLACEHOLDER,
    scorecard_item_id: text(record.scorecard_item_id, `${where} id`),
    protocol_id: text(record.protocol_id, `${where} protocol_id`),
    item_number: number(record.item_number, `${where} item_number`),
    item_group: text(record.group, `${where} group`),
    name: text(record.name, `${where} name`),
    definition: text(record.definition, `${where} definition`),
    scale,
    scale_key: SCALE_KEYS[scale],
    scorable_contexts: list(record.scorable_contexts, `${where} scorable_contexts`),
    gaps: list(record.gaps, `${where} gaps`),
    status: status(record.status, where),
    sources: list(record.sources, `${where} sources`),
    decision: text(record.decision, `${where} decision`),
    backbone_version: version,
    active_flag: 'true',
    field_labels: labelsCell(labels),
    evidence: evidence(record.evidence, where, dropped),
  };
}

function gateRow(record, version, dropped, tally) {
  const where = `gate ${record.gate_id ?? '(no id)'}`;
  checkKeys('gate', record, where, tally);
  if (record.informs_only !== true) throw new ExportError(`${where}: informs_only is ${JSON.stringify(record.informs_only)}; a gate only informs (RULES section 1)`);
  const labels = {};
  if (record.schema_note !== undefined) labels.gate_kind = { note: text(record.schema_note, `${where} schema_note`) };
  return {
    organization_id: ORG_PLACEHOLDER,
    gate_id: text(record.gate_id, `${where} id`),
    stage_key: text(record.stage_key, `${where} stage_key`),
    gate_kind: text(record.gate_kind, `${where} gate_kind`),
    informs_only: 'true',
    override_process: text(record.override_process, `${where} override_process`),
    override_presets_status: text(record.override_presets_status, `${where} override_presets_status`),
    status: status(record.status, where),
    sources: list(record.sources, `${where} sources`),
    decision: text(record.decision, `${where} decision`),
    backbone_version: version,
    active_flag: 'true',
    field_labels: labelsCell(labels),
    evidence: evidence(record.evidence, where, dropped),
  };
}

/** Field labels of a criterion, a label keyed by a renamed key following its column. */
const CRITERION_RENAMES = { text: 'criterion_text', stage_key: 'ref_stage_key', gate_kind: 'ref_gate_kind', gate_id: 'ref_gate_id', min: 'bout_min', max: 'bout_max', scope: 'bout_scope' };

function criterionRow(record, gateId, version, dropped, tally) {
  const where = `criterion ${record.criterion_id ?? '(no id)'} of gate ${gateId}`;
  checkKeys('criterion', record, where, tally);
  let labels = '';
  if (record.field_labels !== undefined) {
    if (!isObject(record.field_labels)) throw new ExportError(`${where}: field_labels is not an object`);
    labels = labelsCell(Object.fromEntries(Object.entries(stripExcerpts(record.field_labels, dropped)).map(([key, value]) => [CRITERION_RENAMES[key] ?? key, value])));
  }
  return {
    organization_id: ORG_PLACEHOLDER,
    criterion_id: text(record.criterion_id, `${where} id`),
    gate_id: gateId,
    ordinal: number(record.ordinal, `${where} ordinal`),
    kind: text(record.kind, `${where} kind`),
    criterion_text: text(record.text, `${where} text`),
    polarity: text(record.polarity, `${where} polarity`),
    scorecard_item_ids: list(record.scorecard_item_ids, `${where} scorecard_item_ids`),
    item_numbers: list(record.item_numbers, `${where} item_numbers`, number),
    protocol_id: text(record.protocol_id, `${where} protocol_id`),
    min_score: number(record.min_score, `${where} min_score`),
    contexts: list(record.contexts, `${where} contexts`),
    combine: text(record.combine, `${where} combine`),
    ref_stage_key: text(record.stage_key, `${where} stage_key`),
    ref_gate_kind: text(record.gate_kind, `${where} gate_kind`),
    ref_gate_id: text(record.gate_id, `${where} gate_id`),
    bout_min: number(record.min, `${where} min`),
    bout_max: number(record.max, `${where} max`),
    bout_scope: text(record.scope, `${where} scope`),
    note: text(record.note, `${where} note`),
    conflict_resolved: text(record.conflict_resolved, `${where} conflict_resolved`),
    source_cell: text(record.source_cell, `${where} source_cell`),
    status: status(record.status, where),
    sources: list(record.sources, `${where} sources`),
    decision: text(record.decision, `${where} decision`),
    backbone_version: version,
    active_flag: 'true',
    field_labels: labels,
    evidence: evidence(record.evidence, where, dropped),
  };
}

function anchorSpecRow(record, version, tally) {
  const where = `anchor spec ${record.anchor_spec_id ?? '(no id)'}`;
  checkKeys('anchorSpec', record, where, tally);
  return {
    organization_id: ORG_PLACEHOLDER,
    anchor_spec_id: text(record.anchor_spec_id, `${where} id`),
    scorecard_item_id: text(record.scorecard_item_id, `${where} scorecard_item_id`),
    item_number: number(record.item_number, `${where} item_number`),
    level: number(record.level, `${where} level`),
    context_class: text(record.context_class, `${where} context_class`),
    used_by_stage_keys: list(record.used_by_gates, `${where} used_by_gates`),
    priority: number(record.priority, `${where} priority`),
    status: status(record.status, where),
    sources: list(record.sources, `${where} sources`),
    backbone_version: version,
    active_flag: 'true',
  };
}

function scaleRows(definitions, version, tally) {
  checkKeys('scaleDefinitions', definitions, 'scale_definitions', tally);
  const statuses = definitions.status;
  if (!isObject(statuses)) throw new ExportError('scale_definitions.status is not an object');
  return ['live_long_road', 'cue_response_draft'].map((key) => {
    const anchors = definitions[key];
    if (!isObject(anchors)) throw new ExportError(`scale_definitions.${key} is not an object`);
    const levels = Object.keys(anchors).map((level) => {
      if (!/^[0-9]+$/.test(level)) throw new ExportError(`scale_definitions.${key}: level ${JSON.stringify(level)} is not a whole number`);
      text(anchors[level], `scale_definitions.${key}.${level}`);
      return Number(level);
    });
    return {
      organization_id: ORG_PLACEHOLDER,
      scale_key: key,
      min_level: String(Math.min(...levels)),
      max_level: String(Math.max(...levels)),
      level_anchors: sortedJson(Object.fromEntries(Object.entries(anchors).map(([level, value]) => [level, value.normalize('NFC').trim()]))),
      status: status(statuses[key], `scale_definitions.status.${key}`),
      note: key === 'cue_response_draft' ? text(definitions.cue_response_note, 'scale_definitions.cue_response_note') : '',
      backbone_version: version,
      active_flag: 'true',
    };
  });
}

function capRow(definitions, version, tally) {
  const rule = definitions.non_contact_rule;
  checkKeys('cap', rule, 'scale_definitions.non_contact_rule', tally);
  const appliesTo = text(rule.applies_to, 'non_contact_rule.applies_to');
  const wording = text(rule.wording, 'non_contact_rule.wording');
  if (appliesTo !== CAP_SCOPE.applies_to || wording !== CAP_SCOPE.wording) {
    throw new ExportError(`non_contact_rule: its wording differs from what CAP_SCOPE reads (${JSON.stringify(appliesTo)}); re-read it by decision, do not guess`);
  }
  const inferred = { status: 'INFERRED', basis: 'read from applies_to and wording (lane CAT mapping)' };
  return {
    organization_id: ORG_PLACEHOLDER,
    cap_key: 'non_contact_rule',
    scale_key: CAP_SCOPE.scale_key,
    max_score: number(rule.max_score, 'non_contact_rule.max_score'),
    applies_to: appliesTo,
    applies_to_protocol_id: CAP_SCOPE.applies_to_protocol_id,
    applies_to_contexts: CAP_SCOPE.applies_to_contexts.join('|'),
    wording,
    decision: text(rule.decision, 'non_contact_rule.decision'),
    note: text(rule.note, 'non_contact_rule.note'),
    status: status(definitions.status?.non_contact_rule, 'scale_definitions.status.non_contact_rule'),
    backbone_version: version,
    active_flag: 'true',
    field_labels: labelsCell({ scale_key: inferred, applies_to_protocol_id: inferred, applies_to_contexts: inferred }),
  };
}

/** 'prefix_' + first 14 hex of sha256(NFC-trimmed identity) (contentImport/ids.ts hex14). */
function hex14(identity) {
  return createHash('sha256').update(identity.normalize('NFC').trim(), 'utf8').digest('hex').slice(0, 14);
}

/** DOC-027's room list and its 6 KPIs, from the frozen track's owner rule, as written. */
function roomRows(track, version) {
  const record = track.record;
  if (!isObject(record) || !Array.isArray(record.groups)) throw new ExportError(`${ROOM_TRACK_FILE}: record.groups is missing`);
  const rules = record.groups.flatMap((group) => (Array.isArray(group.owner_rules) ? group.owner_rules : [])).filter((rule) => rule.owner_source === ROOM_SOURCE);
  if (rules.length !== 1) throw new ExportError(`${ROOM_TRACK_FILE}: expected one owner rule from ${ROOM_SOURCE}, found ${rules.length}`);
  const lines = rules[0].owner_text;
  if (!Array.isArray(lines) || lines.length !== 7 || !String(lines[6]).startsWith('Use simple counts')) {
    throw new ExportError(`${ROOM_TRACK_FILE}: the owner rule's owner_text is not 6 KPIs and a scoring line; re-read it by decision, do not guess`);
  }
  // The source line holds commas, which a '|' source list refuses: the key is DOC-027, and the line itself,
  // as written, rides in each row's field labels.
  const owner = text(ROOM_SOURCE, 'room source');
  const ownerLabel = { status: 'REPORTED', sources: ['DOC-027'], owner_source: owner, changed_by: text(rules[0].changed_by, 'room changed_by') };
  const recordStatus = status(record.status, `${ROOM_TRACK_FILE} status`);
  const list = {
    organization_id: ORG_PLACEHOLDER,
    list_key: 'room',
    title: 'Core Behavioral KPIs',
    source_doc: 'DOC-027',
    scope_text: 'Room and session monitoring (owner rule D-PK77-1; OD-2026-11-16-003 ruling 1)',
    scoring_rule_text: text(lines[6], 'room scoring line'),
    status: recordStatus,
    sources: 'DOC-027',
    backbone_version: version,
    active_flag: 'true',
    field_labels: labelsCell({
      title: { ...ownerLabel, basis: 'the section name in the owner rule\'s source line' },
      scoring_rule_text: ownerLabel,
      scope_text: { status: 'REPORTED', sources: ['OD-2026-11-16-003', 'D-PK77-1'] },
    }),
  };
  const kpis = lines.slice(0, 6).map((line, index) => {
    const name = text(line, `room KPI ${index + 1}`);
    return {
      organization_id: ORG_PLACEHOLDER,
      kpi_id: `kpi_${hex14(`room:${name}`)}`,
      list_key: 'room',
      ordinal: String(index + 1),
      name,
      status: recordStatus,
      sources: 'DOC-027',
      backbone_version: version,
      active_flag: 'true',
      field_labels: labelsCell({ name: ownerLabel }),
    };
  });
  return { list, kpis };
}

/** A KPI file: the committed rows that are not room rows, kept as written, then the room rows; sorted by list and place. */
function kpiFile(name, committedText, roomRowsForFile) {
  const kept = [];
  if (committedText !== undefined) {
    const header = committedText.slice(0, committedText.indexOf('\n')).split(',');
    if (header.join(',') !== HEADERS[name].join(',')) throw new ExportError(`${FOLDER}/${name}: committed header differs from the exporter's; nothing was written`);
    for (const row of readCsv(committedText)) if (row.list_key !== 'room') kept.push(row);
  }
  const order = (row) => `${row.list_key}\u0000${String(row.ordinal ?? '').padStart(4, '0')}`;
  return [...kept, ...roomRowsForFile].sort((a, b) => compare(order(a), order(b)));
}

export function loadManifest(backboneDir) {
  const file = path.join(backboneDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new ExportError(`not found: ${file}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(manifest.files)) throw new ExportError(`${MANIFEST_FILE}: files[] is missing`);
  return new Map(manifest.files.map((entry) => [entry.path, entry.sha256_16]));
}

/** The changed and removed committed rows, by id and column, for one file. */
function overwritesOf(name, committedText, newRows, owned = () => true) {
  if (committedText === undefined) return [];
  const key = KEY_OF[name];
  const fresh = new Map(newRows.map((row) => [row[key], row]));
  const found = [];
  for (const old of readCsv(committedText).filter(owned)) {
    const next = fresh.get(old[key]);
    if (!next) {
      found.push(`  ${FOLDER}/${name} ${old[key]}: removed`);
      continue;
    }
    const columns = HEADERS[name].filter((column) => (old[column] ?? '') !== (next[column] ?? ''));
    if (columns.length) found.push(`  ${FOLDER}/${name} ${old[key]}: changes ${columns.join(', ')}`);
  }
  return found;
}

/**
 * The package for one Backbone folder: { files: { 'assessment-catalog/<file>': text }, counts, differences, notices,
 * overwrites, backboneVersion }. `existing(path)` returns a committed file's text, or undefined.
 */
export function exportAssessmentCatalog(backboneDir, existing = () => undefined, { allowOverwrite = false } = {}) {
  const manifest = loadManifest(backboneDir);
  const file = path.join(backboneDir, CATALOGS_FILE);
  if (!fs.existsSync(file)) throw new ExportError(`not found: ${file}`);
  const bytes = fs.readFileSync(file);
  const hash = sha16(bytes);
  if (!manifest.has(CATALOGS_FILE)) throw new ExportError(`${CATALOGS_FILE} is not in ${MANIFEST_FILE}`);
  if (manifest.get(CATALOGS_FILE) !== hash) {
    throw new ExportError(`${CATALOGS_FILE}: hash ${hash} differs from ${MANIFEST_FILE} (${manifest.get(CATALOGS_FILE)}); the frozen Backbone has changed`);
  }
  const catalogs = JSON.parse(bytes.toString('utf8'));
  const version = `catalogs ${hash}`;
  const tally = {};
  const dropped = { keys: 0, passages: 0 };
  checkKeys('catalogs', catalogs, CATALOGS_FILE, tally);
  for (const section of ['assessment_protocols', 'scorecard_items', 'gates', 'anchor_clip_specs']) {
    if (!Array.isArray(catalogs[section])) throw new ExportError(`${CATALOGS_FILE}: ${section}[] is missing`);
  }
  if (!isObject(catalogs.scale_definitions)) throw new ExportError(`${CATALOGS_FILE}: scale_definitions is missing`);

  const byId = (key) => (a, b) => compare(a[key], b[key]);
  const rows = {
    'seed_assessment_protocols.csv': catalogs.assessment_protocols.map((record) => protocolRow(record, version, dropped, tally)).sort(byId('protocol_id')),
    'seed_scorecard_scales.csv': scaleRows(catalogs.scale_definitions, version, tally),
    'seed_scorecard_score_caps.csv': [capRow(catalogs.scale_definitions, version, tally)],
    'seed_scorecard_items.csv': catalogs.scorecard_items.map((record) => itemRow(record, version, dropped, tally)).sort(byId('scorecard_item_id')),
    'seed_pathway_gates.csv': catalogs.gates.map((record) => gateRow(record, version, dropped, tally)).sort(byId('gate_id')),
    'seed_pathway_gate_criteria.csv': catalogs.gates.flatMap((gate) => {
      if (!Array.isArray(gate.criteria)) throw new ExportError(`gate ${gate.gate_id}: criteria must be a list`);
      return gate.criteria.map((criterion) => criterionRow(criterion, text(gate.gate_id, 'gate id'), version, dropped, tally));
    }).sort(byId('criterion_id')),
    'seed_scorecard_anchor_clip_specs.csv': catalogs.anchor_clip_specs.map((record) => anchorSpecRow(record, version, tally)).sort(byId('anchor_spec_id')),
  };
  for (const [name, list_] of Object.entries(rows)) {
    const ids = new Set();
    for (const row of list_) {
      if (ids.has(row[KEY_OF[name]])) throw new ExportError(`${name}: two rows with ${KEY_OF[name]} ${row[KEY_OF[name]]}`);
      ids.add(row[KEY_OF[name]]);
    }
  }

  const counts = {
    protocols: rows['seed_assessment_protocols.csv'].length,
    scales: rows['seed_scorecard_scales.csv'].length,
    caps: rows['seed_scorecard_score_caps.csv'].length,
    items: rows['seed_scorecard_items.csv'].length,
    gates: rows['seed_pathway_gates.csv'].length,
    criteria: rows['seed_pathway_gate_criteria.csv'].length,
    anchorSpecs: rows['seed_scorecard_anchor_clip_specs.csv'].length,
    excerptKeys: dropped.keys,
    excerptPassages: dropped.passages,
  };
  // The room rows, from the frozen DOC-027 track (hashed like the catalog).
  const trackFile = path.join(backboneDir, ROOM_TRACK_FILE);
  if (!fs.existsSync(trackFile)) throw new ExportError(`not found: ${trackFile}`);
  const trackBytes = fs.readFileSync(trackFile);
  const trackHash = sha16(trackBytes);
  if (manifest.get(ROOM_TRACK_FILE) !== trackHash) {
    throw new ExportError(`${ROOM_TRACK_FILE}: hash ${trackHash} differs from ${MANIFEST_FILE} (${manifest.get(ROOM_TRACK_FILE) ?? 'not listed'}); the frozen Backbone has changed`);
  }
  const room = roomRows(JSON.parse(trackBytes.toString('utf8')), `track trk_21ba0c958c98e1 ${trackHash}`);
  rows['seed_behavior_kpi_lists.csv'] = kpiFile('seed_behavior_kpi_lists.csv', existing(`${FOLDER}/seed_behavior_kpi_lists.csv`), [room.list]);
  rows['seed_behavior_kpis.csv'] = kpiFile('seed_behavior_kpis.csv', existing(`${FOLDER}/seed_behavior_kpis.csv`), room.kpis);
  counts.roomKpis = room.kpis.length;
  for (const name of KPI_FILES) {
    const ids = new Set();
    for (const row of rows[name]) {
      if (ids.has(row[KEY_OF[name]])) throw new ExportError(`${name}: two rows with ${KEY_OF[name]} ${row[KEY_OF[name]]}`);
      ids.add(row[KEY_OF[name]]);
    }
  }

  const differences = Object.entries(EXPECTED_COUNTS)
    .filter(([key, expected]) => counts[key] !== expected)
    .map(([key, expected]) => `${key}: brief ${expected}, observed ${counts[key]}`);

  const files = {};
  const overwrites = [];
  for (const [name, list_] of Object.entries(rows)) {
    const rel = `${FOLDER}/${name}`;
    files[rel] = writeCsv(HEADERS[name], list_.map((row) => HEADERS[name].map((column) => row[column] ?? '')));
    const committed = existing(rel);
    if (committed !== undefined && committed !== files[rel]) {
      const room = KPI_FILES.includes(name);
      overwrites.push(...overwritesOf(name, committed, list_, room ? (row) => row.list_key === 'room' : () => true));
    }
  }
  if (overwrites.length && !allowOverwrite) {
    throw new ExportError(['committed rows differ from the frozen Backbone; nothing was written (--allow-overwrite writes anyway):', ...overwrites].join('\n'));
  }

  return {
    backboneVersion: version,
    files,
    counts,
    differences,
    overwrites,
    notices: [
      `not carried: ${Object.entries(tally).sort(([a], [b]) => compare(a, b)).map(([key, count]) => `${key} (${count})`).join(', ') || 'nothing'}`,
      `evidence 'quotes' (licensed excerpts, OD-2026-10-02-013 2A) not carried: ${dropped.keys} keys, ${dropped.passages} passages`,
    ],
  };
}

const USAGE = 'usage: node scripts/backbone-export-assessment-catalog.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]';

export function parseArgs(argv) {
  const positional = [];
  let out;
  let allowOverwrite = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      if (!out || out.startsWith('--')) throw new ExportError(`--out needs a folder\n${USAGE}`);
      i += 1;
    } else if (argv[i] === '--allow-overwrite') allowOverwrite = true;
    else if (argv[i].startsWith('--')) throw new ExportError(`unknown option ${argv[i]}\n${USAGE}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new ExportError(USAGE);
  const resolvedOut = path.resolve(out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../seed-data'));
  const relative = path.relative(path.resolve(positional[0]), resolvedOut);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new ExportError(`--out ${resolvedOut} is inside the Backbone folder, which is read-only; write elsewhere`);
  }
  return { backboneDir: positional[0], out: resolvedOut, allowOverwrite };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const existing = (rel) => {
      const full = path.join(args.out, rel);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
    };
    const result = exportAssessmentCatalog(args.backboneDir, existing, { allowOverwrite: args.allowOverwrite });
    fs.mkdirSync(path.join(args.out, FOLDER), { recursive: true });
    for (const [rel, body] of Object.entries(result.files)) fs.writeFileSync(path.join(args.out, rel), body, 'utf8');
    console.log(`backbone_version: ${result.backboneVersion}`);
    console.log(`counts: ${Object.entries(result.counts).map(([key, value]) => `${key} ${value}`).join(', ')}`);
    for (const line of result.notices) console.log(line);
    if (result.overwrites.length) console.log(['OVERWROTE (--allow-overwrite):', ...result.overwrites].join('\n'));
    if (result.differences.length) {
      console.log(['COUNTS DIFFER FROM THE BRIEF:', ...result.differences.map((line) => `  ${line}`)].join('\n'));
      process.exit(2);
    }
  } catch (error) {
    if (error instanceof ExportError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
