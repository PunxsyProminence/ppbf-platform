import { hex14 } from '../ids';
import type { ColumnSpec, DatasetSpec, FileSpec, Finding, ParsedFile, ParsedPackage, RowRule, RowValues } from '../types';
import { splitList } from '../values';
import { ASSESSMENT_PROTOCOLS_FILE, assessmentProtocolsFile } from './assessmentProtocols';
import { integer, number, organizationColumn, systemColumn, text, vocabulary } from './common';
import { PATHWAY_STAGES_FILE, STAGE_KEY_PATTERN } from './pathwayCatalog';

// THE ASSESSMENT CATALOG (SCHEMA_PROPOSAL P5, P6; assessment_catalog
// migration; lane CAT; OD-2026-11-15-006 ruling 1, OD-2026-11-16-001,
// OD-2026-11-16-003). The backbone's gates and their criteria, the scorecard
// items, the anchor-clip specs, the scales and the non-contact cap, the
// assessment protocols, and the two behavioural KPI lists, per organization.
// It describes and informs: a gate is shown as met, not met or not scored and
// never moves anyone; the cap is data for the later rating path.
//
// EACH CATALOG FILE IS A WHOLE SNAPSHOT of its table, as the pathway catalog's
// (a row the table holds that the file leaves out is retired, never deleted).
// The protocols file is NOT: a protocol it leaves out is left alone, and a
// changed one becomes the next protocol_version (specs/assessmentProtocols.ts).
//
// Ids are the backbone's own, checked against its identity rule (DATA_MODEL
// s3.2) and never re-minted: pgt_ = hex14(stage_key:gate_kind), pgc_ =
// hex14(gate_id:ordinal), sci_ = hex14(protocol_id:NN), acs_ =
// hex14(scorecard_item_id:level:context_class). A KPI's kpi_ id is
// hex14(list_key:name) (lane CAT). None takes new:<name>.

export const GATES_FILE = 'seed_pathway_gates.csv';
export const CRITERIA_FILE = 'seed_pathway_gate_criteria.csv';
export const SCALES_FILE = 'seed_scorecard_scales.csv';
export const CAPS_FILE = 'seed_scorecard_score_caps.csv';
export const ITEMS_FILE = 'seed_scorecard_items.csv';
export const ANCHOR_SPECS_FILE = 'seed_scorecard_anchor_clip_specs.csv';
export const KPI_LISTS_FILE = 'seed_behavior_kpi_lists.csv';
export const KPIS_FILE = 'seed_behavior_kpis.csv';

const FOLDER = 'assessment-catalog';

const backboneVersion = () =>
  text('backbone_version', 'The snapshot the row comes from. A new value is a new version of the row.', { label: true });
const activeFlag = () =>
  systemColumn('active_flag', 'true', 'a row the file carries is active; one a later snapshot leaves out is retired (false), never deleted');
const status = (required = true) => vocabulary('status', 'record_status', 'The record status (backbone RULES section 10).', { required });
const sources = (): ColumnSpec => ({ name: 'sources', role: 'content', type: 'text', list: '|', label: true, description: 'Source keys, separated by |.' });
const decision = () => text('decision', 'The decision record the row rests on (e.g. D-OQ183).', { label: true });
const key = (name: string, description: string): ColumnSpec => ({ name, role: 'key', type: 'text', required: true, description });
const listOf = (name: string, description: string, extra: Partial<ColumnSpec> = {}): ColumnSpec =>
  ({ name, role: 'content', type: 'text', list: '|', description, ...extra });

/** The label column a catalog row does not use: each row names its stage itself, where it has one. */
const NO_STAGE_KEYS: RowRule = {
  description: 'stage_keys stays blank: a catalog row names any stage in its own columns.',
  check: (row) => (row.stage_keys ? `stage_keys is for content items; leave it blank on an assessment catalog row ('${row.stage_keys}')` : null),
};

/** An id of the backbone's shape, and the id its identity string gives (never re-minted). */
function backboneId(column: string, prefix: string, identity: (row: RowValues) => string | null, mirrors: RowRule['mirrors'], whose = "the backbone's id"): RowRule[] {
  const shape = new RegExp(`^${prefix}_[0-9a-f]{14}$`);
  return [
    {
      description: `${column} is '${prefix}_' and 14 lowercase hex.`,
      mirrors,
      check: (row) => (row[column] && !shape.test(row[column]) ? `${column} '${row[column]}' is not '${prefix}_' and 14 lowercase hex` : null),
    },
    {
      description: `${column} is ${whose} for the row's identity: '${prefix}_' + first 14 hex of sha256(identity).`,
      check: (row) => {
        const ident = identity(row);
        if (!shape.test(row[column] ?? '') || ident === null) return null;
        const expected = `${prefix}_${hex14(ident)}`;
        return row[column] === expected ? null : `${column} '${row[column]}' is not the id of '${ident}' (${expected})`;
      },
    },
  ];
}

function stageShape(column: string): RowRule {
  return {
    description: `each stage in ${column} is a stage key in its human form (Y3, AM1).`,
    check: (row) => {
      const bad = splitList(row[column] ?? '', '|').filter((value) => !STAGE_KEY_PATTERN.test(value));
      return bad.length ? `${column} names '${bad.join("', '")}', not a stage key (capital letters then digits)` : null;
    },
  };
}

function jsonObject(column: string, mirrors?: RowRule['mirrors']): RowRule {
  return {
    description: `${column}, when set, is a JSON object.`,
    mirrors,
    check: (row) => {
      if (!row[column]) return null;
      try {
        const value = JSON.parse(row[column]);
        return value && typeof value === 'object' && !Array.isArray(value) ? null : `${column} must be a JSON object`;
      } catch {
        return `${column} is not readable JSON`;
      }
    },
  };
}

const gatesFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: GATES_FILE,
  rowMeaning: 'one pathway gate',
  key: ['gate_id'],
  columns: [
    organizationColumn(),
    key('gate_id', "The backbone's id: 'pgt_' + hex14(stage_key + ':' + gate_kind). Kept as given, never re-minted."),
    text('stage_key', 'The stage the gate belongs to: a stage of the pathway catalog.', { required: true, label: true }),
    vocabulary('gate_kind', 'pathway_gate_kind', 'Which gate of the stage this is. One gate per stage and kind.', { required: true }),
    { name: 'informs_only', role: 'content', type: 'boolean', blankDefault: 'true', description: 'Always true: a gate informs and never moves anyone (RULES section 1).' },
    text('override_process', 'How a coach may place a member against the gate result (the override workflow is a later lane).', { label: true }),
    text('override_presets_status', 'The state of the override reason pick-list.', { label: true }),
    status(),
    sources(),
    decision(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    ...backboneId('gate_id', 'pgt', (row) => (row.stage_key && row.gate_kind ? `${row.stage_key}:${row.gate_kind}` : null),
      { table: 'pathway_gates', constraint: 'pilot_pathway_gates_id_check' }),
    stageShape('stage_key'),
    {
      description: 'informs_only is true: a gate informs and never moves anyone.',
      mirrors: { table: 'pathway_gates', constraint: 'pilot_pathway_gates_informs_only_check' },
      check: (row) => (row.informs_only && !['true', 'yes', '1'].includes(row.informs_only.toLowerCase()) ? 'informs_only must be true: a gate never moves anyone' : null),
    },
    NO_STAGE_KEYS,
  ],
};

const criteriaFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: CRITERIA_FILE,
  rowMeaning: 'one gate criterion',
  key: ['criterion_id'],
  unique: [{ columns: ['gate_id', 'ordinal'], description: 'one criterion per place in a gate (pilot_pathway_gate_criteria_one_active_ordinal).' }],
  columns: [
    organizationColumn(),
    key('criterion_id', "The backbone's id: 'pgc_' + hex14(gate_id + ':' + ordinal). Kept as given, never re-minted."),
    text('gate_id', 'The gate the criterion belongs to: a gate in seed_pathway_gates.csv (or, without that file, the loaded catalog).', { required: true, label: true }),
    integer('ordinal', 'The criterion\'s place in its gate (1 = first).', { required: true, bound: 'positive' }),
    vocabulary('kind', 'gate_criterion_kind', 'What the criterion checks: text a coach confirms, a scorecard minimum, a stage or gate completed, or a bout count.', { required: true }),
    text('criterion_text', 'The criterion as a coach reads it (kind text). The backbone key is `text`.'),
    vocabulary('polarity', 'gate_criterion_polarity', 'For a checkpoint list: something the member should have, or should not have.'),
    listOf('scorecard_item_ids', 'The scorecard items a scorecard minimum reads, separated by |: items in seed_scorecard_items.csv (or the loaded catalog).'),
    listOf('item_numbers', 'Those items\' numbers on their scorecard, separated by |, as the backbone states them.'),
    text('protocol_id', 'The protocol the items belong to, when the backbone names it.', { label: true }),
    number('min_score', 'The lowest score that meets the criterion (halves allowed, e.g. 4.5).', { bound: 'positive' }),
    listOf('contexts', 'The contexts the scores must come from, separated by |.', { vocabulary: 'scorable_context', label: true }),
    vocabulary('combine', 'gate_criterion_combine', 'all: every item at the minimum; any: at least one.'),
    text('ref_stage_key', 'The stage a stage_completed or gate_met criterion names. The backbone key is `stage_key`.', { label: true }),
    vocabulary('ref_gate_kind', 'pathway_gate_kind', 'The kind of the gate a gate_met criterion names. The backbone key is `gate_kind`.'),
    text('ref_gate_id', 'The gate a gate_met criterion names; its stage and kind must be that gate\'s. The backbone key is `gate_id`.', { label: true }),
    integer('bout_min', 'Fewest bouts (bout_count). The backbone key is `min`.'),
    integer('bout_max', 'Most bouts (bout_count). The backbone key is `max`.'),
    text('bout_scope', 'What the bouts are counted over. The backbone key is `scope`.', { label: true }),
    text('note', 'A note on the criterion, as written.'),
    text('conflict_resolved', 'How a conflict between sources was decided, as written.'),
    text('source_cell', 'The source table cell the criterion was read from, as written.'),
    status(false),
    sources(),
    decision(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    ...backboneId('criterion_id', 'pgc', (row) => (row.gate_id && row.ordinal ? `${row.gate_id}:${Number(row.ordinal)}` : null),
      { table: 'pathway_gate_criteria', constraint: 'pilot_pathway_gate_criteria_id_check' }),
    {
      description: 'Each kind carries what it needs: text its words; scorecard_min its items, minimum and contexts; stage_completed its stage; gate_met its gate\'s stage, kind and id; bout_count a bound.',
      mirrors: { table: 'pathway_gate_criteria', constraint: 'pilot_pathway_gate_criteria_kind_shape_check' },
      check: (row) => {
        const need: Record<string, string[]> = {
          text: ['criterion_text'],
          scorecard_min: ['scorecard_item_ids', 'min_score', 'contexts'],
          stage_completed: ['ref_stage_key'],
          gate_met: ['ref_stage_key', 'ref_gate_kind', 'ref_gate_id'],
        };
        const missing = (need[row.kind] ?? []).filter((column) => !row[column]);
        if (missing.length) return `a ${row.kind} criterion needs ${missing.join(', ')}`;
        if (row.kind === 'bout_count' && !row.bout_min && !row.bout_max) return 'a bout_count criterion needs bout_min or bout_max';
        return null;
      },
    },
    {
      description: 'Bout counts are 0 or more, and bout_min is not above bout_max.',
      mirrors: { table: 'pathway_gate_criteria', constraint: 'pilot_pathway_gate_criteria_bout_range_check' },
      check: (row) => {
        if ((row.bout_min && Number(row.bout_min) < 0) || (row.bout_max && Number(row.bout_max) < 0)) return 'a bout count cannot be negative';
        return row.bout_min && row.bout_max && Number(row.bout_min) > Number(row.bout_max) ? `bout_min ${row.bout_min} is above bout_max ${row.bout_max}` : null;
      },
    },
    {
      description: 'item_numbers are whole numbers, as many as scorecard_item_ids when both are set.',
      check: (row) => {
        const numbers = splitList(row.item_numbers ?? '', '|');
        if (numbers.some((value) => !/^[1-9][0-9]*$/.test(value))) return `item_numbers '${row.item_numbers}' must be whole numbers separated by |`;
        const ids = splitList(row.scorecard_item_ids ?? '', '|');
        return numbers.length && ids.length && numbers.length !== ids.length ? `item_numbers names ${numbers.length} items and scorecard_item_ids ${ids.length}` : null;
      },
    },
    stageShape('ref_stage_key'),
    NO_STAGE_KEYS,
  ],
};

const scalesFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: SCALES_FILE,
  rowMeaning: 'one scorecard scale',
  key: ['scale_key'],
  columns: [
    organizationColumn(),
    key('scale_key', 'The scale\'s name as the backbone gives it (e.g. live_long_road).'),
    integer('min_level', 'The lowest score on the scale.', { required: true }),
    integer('max_level', 'The highest score on the scale.', { required: true }),
    text('level_anchors', 'JSON object: what each score means, by score ("1" ... "5"), as written.', { required: true }),
    status(),
    text('note', 'A note on the scale, as written.'),
    sources(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    {
      description: 'scale_key is lowercase letters, digits and underscores.',
      mirrors: { table: 'scorecard_scales', constraint: 'pilot_scorecard_scales_key_check' },
      check: (row) => (row.scale_key && !/^[a-z][a-z0-9_]*$/.test(row.scale_key) ? `scale_key '${row.scale_key}' is not lowercase letters, digits and underscores` : null),
    },
    {
      description: 'min_level is 0 or more and below max_level.',
      mirrors: { table: 'scorecard_scales', constraint: 'pilot_scorecard_scales_levels_check' },
      check: (row) => (row.min_level && row.max_level && !(Number(row.min_level) >= 0 && Number(row.min_level) < Number(row.max_level))
        ? `min_level ${row.min_level} must be 0 or more and below max_level ${row.max_level}` : null),
    },
    jsonObject('level_anchors', { table: 'scorecard_scales', constraint: 'pilot_scorecard_scales_anchors_check' }),
    NO_STAGE_KEYS,
  ],
};

const capsFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: CAPS_FILE,
  rowMeaning: 'one score cap',
  key: ['cap_key'],
  columns: [
    organizationColumn(),
    key('cap_key', 'The cap\'s name as the backbone gives it (e.g. non_contact_rule).'),
    text('scale_key', 'The scale the cap applies to: a scale in seed_scorecard_scales.csv (or the loaded catalog).', { required: true, label: true }),
    number('max_score', 'The highest score allowed where the cap applies.', { required: true, bound: 'positive' }),
    text('applies_to', 'Where the cap applies, as the backbone words it.', { required: true }),
    text('applies_to_protocol_id', 'The protocol the cap applies to, read from applies_to.', { label: true }),
    listOf('applies_to_contexts', 'The contexts the cap applies to, read from applies_to, separated by |.', { vocabulary: 'scorable_context', label: true }),
    text('wording', 'Which scale wording the capped scores use, as written.'),
    decision(),
    text('note', 'A note on the cap, as written.'),
    status(),
    sources(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    {
      description: 'cap_key is lowercase letters, digits and underscores.',
      mirrors: { table: 'scorecard_score_caps', constraint: 'pilot_scorecard_score_caps_key_check' },
      check: (row) => (row.cap_key && !/^[a-z][a-z0-9_]*$/.test(row.cap_key) ? `cap_key '${row.cap_key}' is not lowercase letters, digits and underscores` : null),
    },
    NO_STAGE_KEYS,
  ],
};

const itemsFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: ITEMS_FILE,
  rowMeaning: 'one scorecard item',
  key: ['scorecard_item_id'],
  nameColumn: 'name',
  unique: [{ columns: ['protocol_id', 'item_number'], description: 'one item per number on a protocol (pilot_scorecard_items_one_active_number).' }],
  columns: [
    organizationColumn(),
    key('scorecard_item_id', "The backbone's id: 'sci_' + hex14(protocol_id + ':' + two-digit item number), checked; an item with no protocol is checked by shape only (its id comes from its source key and name, D-PK128). Kept as given, never re-minted."),
    text('protocol_id', 'The protocol the item belongs to: a protocol in seed_assessment_protocols.csv (or the loaded catalog).', { label: true }),
    integer('item_number', 'The item\'s number on its protocol.', { bound: 'positive' }),
    text('item_group', 'The scorecard section (e.g. foundations). The backbone key is `group`.', { label: true }),
    text('name', 'The item\'s name.', { required: true }),
    text('definition', 'What the item rates, as written.', { required: true }),
    text('scale', 'The scale as the backbone states it.', { required: true, label: true }),
    text('scale_key', 'The scale the item is scored on: a scale in seed_scorecard_scales.csv (or the loaded catalog). Blank when the source gives none.', { label: true }),
    listOf('scorable_contexts', 'The contexts the item may be scored in, separated by |.', { vocabulary: 'scorable_context', label: true }),
    listOf('gaps', 'What the source leaves open, separated by |, each as written (commas and semicolons kept).', { proseItems: true }),
    status(),
    sources(),
    decision(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    ...backboneId('scorecard_item_id', 'sci',
      (row) => (row.protocol_id && row.item_number ? `${row.protocol_id}:${String(Number(row.item_number)).padStart(2, '0')}` : null),
      { table: 'scorecard_items', constraint: 'pilot_scorecard_items_id_check' }),
    NO_STAGE_KEYS,
  ],
};

const anchorSpecsFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: ANCHOR_SPECS_FILE,
  rowMeaning: 'one anchor-clip spec',
  key: ['anchor_spec_id'],
  unique: [{
    columns: ['scorecard_item_id', 'level', 'context_class'],
    description: 'one spec per item, level and context (pilot_scorecard_anchor_clip_specs_one_active_slot).',
  }],
  columns: [
    organizationColumn(),
    key('anchor_spec_id', "The backbone's id: 'acs_' + hex14(scorecard_item_id + ':' + level + ':' + context_class). Kept as given, never re-minted."),
    text('scorecard_item_id', 'The item the anchor footage is for: an item in seed_scorecard_items.csv (or the loaded catalog).', { required: true, label: true }),
    integer('item_number', 'The item\'s number, as the backbone repeats it; must equal the item\'s own.'),
    integer('level', 'The score the footage should show; within the item\'s scale.', { required: true, bound: 'anchor_level' }),
    vocabulary('context_class', 'anchor_context_class', 'Live footage or non-contact footage.', { required: true }),
    listOf('used_by_stage_keys', 'The stages whose gates use the anchor, separated by |. The backbone key is `used_by_gates`.', { label: true }),
    integer('priority', 'Which anchors to film first (1 = first).', { bound: 'positive' }),
    status(),
    sources(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    ...backboneId('anchor_spec_id', 'acs',
      (row) => (row.scorecard_item_id && row.level && row.context_class ? `${row.scorecard_item_id}:${Number(row.level)}:${row.context_class}` : null),
      { table: 'scorecard_anchor_clip_specs', constraint: 'pilot_scorecard_anchor_clip_specs_id_check' }),
    stageShape('used_by_stage_keys'),
    NO_STAGE_KEYS,
  ],
};

const kpiListsFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: KPI_LISTS_FILE,
  rowMeaning: 'one behavioural KPI list',
  key: ['list_key'],
  nameColumn: 'title',
  columns: [
    organizationColumn(),
    { name: 'list_key', role: 'key', type: 'text', required: true, vocabulary: 'kpi_list_key', description: 'drill: DOC-041\'s drill KPIs; room: DOC-027\'s core behavioural KPIs (OD-2026-11-16-003).' },
    text('title', 'The list\'s title as its source gives it.', { required: true }),
    text('source_doc', 'The owner document the list comes from (DOC-041, DOC-027).', { required: true, label: true }),
    text('scope_text', 'What the list is for.'),
    text('scoring_rule_text', 'How the list is scored, quoted from its source.'),
    status(),
    sources(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [NO_STAGE_KEYS],
};

const kpisFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: FOLDER,
  file: KPIS_FILE,
  rowMeaning: 'one behavioural KPI',
  key: ['kpi_id'],
  nameColumn: 'name',
  unique: [{ columns: ['list_key', 'ordinal'], description: 'one KPI per place in a list (pilot_behavior_kpis_one_active_ordinal).' }],
  columns: [
    organizationColumn(),
    key('kpi_id', "Lane CAT's id rule (not in the backbone's DATA_MODEL): 'kpi_' + hex14(list_key + ':' + name). Kept as given, never re-minted."),
    vocabulary('list_key', 'kpi_list_key', 'The list the KPI belongs to.', { required: true }),
    integer('ordinal', 'The KPI\'s place in its list, in its source\'s order (1 = first).', { required: true, bound: 'positive' }),
    text('name', 'The KPI, quoted from its source.', { required: true }),
    vocabulary('scoring_kind', 'kpi_scoring_kind', 'How the KPI is scored (DOC-041: counts, yes-no marks or three-level ratings). Blank for a room KPI.'),
    text('level_anchors', 'JSON object, three-level KPIs only: what each level means ("1" ... "3").'),
    status(),
    sources(),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    ...backboneId('kpi_id', 'kpi', (row) => (row.list_key && row.name ? `${row.list_key}:${row.name}` : null),
      { table: 'behavior_kpis', constraint: 'pilot_behavior_kpis_id_check' }, "lane CAT's id"),
    jsonObject('level_anchors'),
    {
      description: 'level_anchors only on a three-level KPI.',
      mirrors: { table: 'behavior_kpis', constraint: 'pilot_behavior_kpis_anchors_check' },
      check: (row) => (row.level_anchors && row.scoring_kind !== 'three_level' ? 'level_anchors is for a three_level KPI only' : null),
    },
    NO_STAGE_KEYS,
  ],
};

export const assessmentCatalogDataset: DatasetSpec = {
  name: 'assessment-catalog',
  title: 'Assessment catalog',
  folder: FOLDER,
  summary:
    'The backbone\'s pathway gates and their criteria, the scorecard items, the anchor-clip specs, the scorecard scales and '
    + 'the non-contact cap, the assessment protocols, and the two behavioural KPI lists (SCHEMA_PROPOSAL P5, P6; '
    + 'OD-2026-11-16-001, OD-2026-11-16-003). It describes and informs: a gate is shown as met, not met or not scored and '
    + 'never moves anyone, and the cap is data for the later rating path. Each catalog file is a whole snapshot of its '
    + 'table, as the pathway catalog\'s: a changed row is revised in place with the old content kept in the history ledger, '
    + 'and a row the file leaves out is retired (kept, marked inactive), never deleted. The protocols file is not a '
    + 'snapshot: a protocol it leaves out is left alone, and a changed one becomes the next protocol_version, the earlier '
    + 'version kept inactive; a protocol\'s name may not be held by another active protocol when the load starts (so '
    + 'swapping two names takes two loads), and a reference to a protocol the file leaves out is checked against the '
    + 'loaded ones. Blank loads blank for this dataset: a protocol\'s quality_measured is not required, and a '
    + 'blank boxing_specific or evidence_class is stored blank rather than as the table\'s default (Overwatch\'s CAT '
    + 'ruling Q1). Every id is checked against its identity rule (a scorecard item with no protocol by its shape only). '
    + 'Gates, criteria and anchor specs name '
    + 'stages of the pathway catalog, which must be loaded first.',
  loadedToday:
    'Nothing yet: the tables exist (assessment-catalog migration), and the Backbone seed files follow in lane CAT-c '
    + '(the KPI lists in CAT-d).',
  files: [assessmentProtocolsFile, scalesFile, capsFile, itemsFile, gatesFile, criteriaFile, anchorSpecsFile, kpiListsFile, kpisFile],
};

// ---------------------------------------------------------------------------
// CROSS-FILE REFERENCES. Each names its target by key; a target the package
// carries is checked against the package's file (that file is the whole
// table after this load), otherwise against `lookup` -- at plan, the
// organization's active rows (datasets/assessmentCatalog.ts). Offline with no
// target file and no lookup, the plan stage decides.

export interface CatalogReference {
  from: string;
  column: string;
  list?: boolean;
  to: string;
  what: string;
}

export const CATALOG_REFERENCES: readonly CatalogReference[] = [
  { from: CRITERIA_FILE, column: 'gate_id', to: GATES_FILE, what: 'gate' },
  { from: CRITERIA_FILE, column: 'ref_gate_id', to: GATES_FILE, what: 'gate' },
  { from: CRITERIA_FILE, column: 'scorecard_item_ids', list: true, to: ITEMS_FILE, what: 'scorecard item' },
  { from: CRITERIA_FILE, column: 'protocol_id', to: ASSESSMENT_PROTOCOLS_FILE, what: 'protocol' },
  { from: ITEMS_FILE, column: 'protocol_id', to: ASSESSMENT_PROTOCOLS_FILE, what: 'protocol' },
  { from: ITEMS_FILE, column: 'scale_key', to: SCALES_FILE, what: 'scale' },
  { from: CAPS_FILE, column: 'scale_key', to: SCALES_FILE, what: 'scale' },
  { from: CAPS_FILE, column: 'applies_to_protocol_id', to: ASSESSMENT_PROTOCOLS_FILE, what: 'protocol' },
  { from: ANCHOR_SPECS_FILE, column: 'scorecard_item_id', to: ITEMS_FILE, what: 'scorecard item' },
  { from: KPIS_FILE, column: 'list_key', to: KPI_LISTS_FILE, what: 'KPI list' },
];

/** The stage columns, checked against the pathway catalog's stages. */
export const STAGE_REFERENCES: readonly { from: string; column: string; list?: boolean }[] = [
  { from: GATES_FILE, column: 'stage_key' },
  { from: CRITERIA_FILE, column: 'ref_stage_key' },
  { from: ANCHOR_SPECS_FILE, column: 'used_by_stage_keys', list: true },
];

/** A target row by key, or undefined. */
export type CatalogLookup = (file: string, key: string) => RowValues | undefined;

const KEY_OF: Record<string, string> = {
  [GATES_FILE]: 'gate_id',
  [ITEMS_FILE]: 'scorecard_item_id',
  [ASSESSMENT_PROTOCOLS_FILE]: 'protocol_id',
  [SCALES_FILE]: 'scale_key',
  [KPI_LISTS_FILE]: 'list_key',
};

function fileOf(parsed: ParsedPackage, name: string): ParsedFile | undefined {
  return parsed.files.find((file) => file.spec.file === name);
}

/**
 * Every reference above, every stage named, and the three agreements a
 * reference carries: a gate_met criterion's stage and kind are its gate's; an
 * anchor spec's item_number is its item's; its level lies on its item's scale.
 * Refused by name. `lookup` and `stageKnown` are the plan stage's database
 * fallbacks; offline only package files are known (and the backbone's 18
 * stage keys, already checked by shape).
 */
export function assessmentCatalogReferenceFindings(
  parsed: ParsedPackage,
  fallback?: { lookup: CatalogLookup; stageKnown: (stageKey: string) => boolean; where: string },
): Finding[] {
  const packageIndex = new Map<string, Map<string, RowValues>>();
  for (const name of Object.keys(KEY_OF)) {
    const file = fileOf(parsed, name);
    if (file) packageIndex.set(name, new Map(file.rows.map((row) => [row.values[KEY_OF[name]], row.values])));
  }
  const known = (name: string): boolean => packageIndex.has(name) || fallback !== undefined;
  const find = (name: string, value: string): RowValues | undefined => {
    const inPackage = packageIndex.get(name)?.get(value);
    if (inPackage) return inPackage;
    // A snapshot file is the whole table after this load; the protocols file is not.
    return packageIndex.has(name) && name !== ASSESSMENT_PROTOCOLS_FILE ? undefined : fallback?.lookup(name, value);
  };
  const source = (name: string) => (packageIndex.has(name) ? `${name} of this package` : fallback?.where ?? name);

  const out: Finding[] = [];
  for (const reference of CATALOG_REFERENCES) {
    const file = fileOf(parsed, reference.from);
    if (!file || !known(reference.to)) continue;
    for (const row of file.rows) {
      const values = reference.list ? splitList(row.values[reference.column] ?? '', '|') : [row.values[reference.column]].filter(Boolean);
      for (const value of values) {
        if (find(reference.to, value)) continue;
        // The protocols file is not a snapshot: a protocol it leaves out stays
        // loaded, so offline (no lookup) only the plan stage can decide.
        if (reference.to === ASSESSMENT_PROTOCOLS_FILE && packageIndex.has(reference.to) && !fallback) continue;
        out.push({
          code: 'orphan_reference',
          file: file.path,
          line: row.line,
          column: reference.column,
          message: `${reference.column} names ${reference.what} '${value}', which is not in ${source(reference.to)}`,
        });
      }
    }
  }

  const criteria = fileOf(parsed, CRITERIA_FILE);
  if (criteria && known(GATES_FILE)) {
    for (const row of criteria.rows) {
      const gate = row.values.ref_gate_id ? find(GATES_FILE, row.values.ref_gate_id) : undefined;
      if (gate && (gate.stage_key !== row.values.ref_stage_key || gate.gate_kind !== row.values.ref_gate_kind)) {
        out.push({
          code: 'orphan_reference',
          file: criteria.path,
          line: row.line,
          column: 'ref_gate_id',
          message: `gate ${row.values.ref_gate_id} is ${gate.stage_key} ${gate.gate_kind}, not ${row.values.ref_stage_key} ${row.values.ref_gate_kind}`,
        });
      }
    }
  }

  const specs = fileOf(parsed, ANCHOR_SPECS_FILE);
  if (specs && known(ITEMS_FILE)) {
    for (const row of specs.rows) {
      const item = find(ITEMS_FILE, row.values.scorecard_item_id);
      if (!item) continue;
      if (row.values.item_number && item.item_number && Number(row.values.item_number) !== Number(item.item_number)) {
        out.push({
          code: 'row_rule',
          file: specs.path,
          line: row.line,
          column: 'item_number',
          message: `item_number ${row.values.item_number} is not the number of item ${row.values.scorecard_item_id} (${item.item_number})`,
        });
      }
      const scale = item.scale_key && known(SCALES_FILE) ? find(SCALES_FILE, item.scale_key) : undefined;
      const level = Number(row.values.level);
      if (scale && row.values.level && (level < Number(scale.min_level) || level > Number(scale.max_level))) {
        out.push({
          code: 'out_of_range',
          file: specs.path,
          line: row.line,
          column: 'level',
          message: `level ${row.values.level} is not on scale ${item.scale_key} (${scale.min_level}-${scale.max_level})`,
        });
      }
    }
  }

  const stages = fileOf(parsed, PATHWAY_STAGES_FILE);
  if (stages || fallback) {
    const inFile = new Set(stages?.rows.map((row) => row.values.stage_key).filter(Boolean));
    const stageKnown = (value: string) => (stages ? inFile.has(value) : fallback?.stageKnown(value) === true);
    const where = stages ? `${PATHWAY_STAGES_FILE} of this package` : fallback?.where ?? '';
    for (const reference of STAGE_REFERENCES) {
      const file = fileOf(parsed, reference.from);
      for (const row of file?.rows ?? []) {
        const values = reference.list ? splitList(row.values[reference.column] ?? '', '|') : [row.values[reference.column]].filter(Boolean);
        for (const value of values) {
          if (!STAGE_KEY_PATTERN.test(value) || stageKnown(value)) continue;
          out.push({
            code: 'orphan_reference',
            file: (file as ParsedFile).path,
            line: row.line,
            column: reference.column,
            message: `${reference.column} names stage '${value}', which is not in ${where}`,
          });
        }
      }
    }
  }
  return out;
}
