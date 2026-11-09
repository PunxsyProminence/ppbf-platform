#!/usr/bin/env node
// BACKBONE -> PATHWAY CATALOG PACKAGE (lane BB-1c; OD-2026-11-08-001).
//
//   node scripts/backbone-export-pathway-catalog.mjs <backbone-folder> [--out <folder>]
//
// Reads ONLY two files of the Backbone folder, read-only:
//   data/spine/spine.json                              stages[]
//   working/design-2026-10-25/design_catalogs.json     default_rules[]
// and writes the three CSVs of the `pathway-catalog` content package
// (specs/pathwayCatalog.ts): seed_pathway_stages.csv, seed_pathway_stage_links.csv,
// seed_pathway_stage_defaults.csv. --out defaults to apps/web/seed-data/pathway-catalog.
//
// COPY, NEVER REWORD. Every text cell is the backbone's own value, Unicode NFC
// and trimmed (the content contract's normalisation); JSON cells are the
// backbone's own JSON with keys sorted. Labels are the backbone's own: a
// stage's field_labels come from each spine field's status and sources; a
// default's status, sources and whole evidence[] list are the row's. Nothing
// is mapped: a status outside the four or an evidence_label outside the eight
// stops the export, by name.
//
// THE OUTPUT IS A WHOLE SNAPSHOT: the same two input files give byte-identical
// CSVs (rows in a fixed order, LF, UTF-8 without BOM, writeCsv's quoting).
// This is what regenerates the catalog at the final Backbone hand-off.
//
// It describes the pathway. Nothing reads the catalog to compute, change or
// restrict where a coach places anyone.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SPINE_FILE = 'data/spine/spine.json';
export const CATALOGS_FILE = 'working/design-2026-10-25/design_catalogs.json';
export const ORG_PLACEHOLDER = '{{PPBF_ORG_ID}}';

// The backbone's vocabularies (contentImport/types.ts RECORD_STATUSES, EVIDENCE_LABELS).
export const RECORD_STATUSES = ['OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED'];
export const EVIDENCE_LABELS = ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED', 'RULE', 'CONVENTION', 'FRAMEWORK', 'UNTIERED'];

// Headers in the spec's column order, label columns last (specs/index.ts appends
// labelColumns()). backboneExportPathwayCatalog.test.ts pins each to the spec.
const LABELS = ['field_labels', 'evidence', 'stage_keys'];
export const HEADERS = {
  'seed_pathway_stages.csv': [
    'organization_id', 'stage_key', 'segment', 'ordinal', 'name', 'who_text', 'develops_text', 'typical_duration_text',
    'contact_default', 'competition_text', 'age_band_guide_text', 'ppbf_name', 'ppbf_name_meaning', 'ppbf_name_language',
    'backbone_version', 'active_flag', ...LABELS,
  ],
  'seed_pathway_stage_links.csv': ['organization_id', 'from_stage_key', 'to_stage_key', 'link_kind', 'backbone_version', 'active_flag', ...LABELS],
  'seed_pathway_stage_defaults.csv': [
    'organization_id', 'default_id', 'scope', 'default_key', 'kind', 'value_text', 'value_vocabulary', 'value_min', 'value_max',
    'unit', 'window_days', 'sparring_type', 'composite_parent', 'phases', 'display_text', 'status', 'sources',
    'backbone_version', 'active_flag', ...LABELS,
  ],
};

// Stage column <- spine field (value, and the field's own status and sources as its label).
const STAGE_TEXT_FIELDS = [
  ['who_text', 'who'],
  ['develops_text', 'develops'],
  ['typical_duration_text', 'typical_duration'],
  ['contact_default', 'contact_default'],
  ['competition_text', 'competition'],
  ['ppbf_name', 'ppbf_name'],
];
// Parts of ppbf_name with columns of their own, labelled by ppbf_name's status and sources.
const PPBF_NAME_PARTS = [
  ['ppbf_name_meaning', 'meaning'],
  ['ppbf_name_language', 'language'],
];
// default_rules[] keys copied one to one into the column of the same name.
const DEFAULT_TEXT_KEYS = ['default_id', 'scope', 'default_key', 'kind', 'value_text', 'value_vocabulary', 'unit', 'sparring_type', 'composite_parent', 'display_text', 'status'];
const DEFAULT_NUMBER_KEYS = ['value_min', 'value_max', 'window_days'];

export class ExportError extends Error {}

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

const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A text cell: the backbone's string, NFC and trimmed. Anything else but a string is refused. */
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

function checkStatus(status, where) {
  if (!RECORD_STATUSES.includes(status)) {
    throw new ExportError(`${where}: status ${JSON.stringify(status)} is not one of ${RECORD_STATUSES.join(', ')} (refused, not mapped)`);
  }
}

function checkSources(sources, where) {
  if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string')) {
    throw new ExportError(`${where}: sources must be a list of source keys`);
  }
  for (const source of sources) {
    if (source.includes('|')) throw new ExportError(`${where}: source key ${JSON.stringify(source)} holds '|', the list separator`);
  }
}

/** A spine field's own label: {status, sources} as the field gives them; null when it gives neither. */
function fieldLabel(field, where) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
  const label = {};
  if (field.status !== undefined) {
    checkStatus(field.status, where);
    label.status = field.status;
  }
  if (field.sources !== undefined) {
    checkSources(field.sources, where);
    label.sources = field.sources;
  }
  return Object.keys(label).length ? label : null;
}

/** A spine field's value: the object's `value`, or the field itself when it is plain text. */
function fieldValue(field, where) {
  if (field && typeof field === 'object' && !Array.isArray(field)) return textCell(field.value, `${where}.value`);
  return textCell(field, where);
}

function checkEvidence(evidence, where) {
  if (!Array.isArray(evidence) || !evidence.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    throw new ExportError(`${where}: evidence must be a list of entries`);
  }
  evidence.forEach((entry, index) => {
    if ('evidence_label' in entry && !EVIDENCE_LABELS.includes(entry.evidence_label)) {
      throw new ExportError(
        `${where}: evidence entry ${index + 1} evidence_label ${JSON.stringify(entry.evidence_label)} is not one of ${EVIDENCE_LABELS.join(', ')} (refused, not mapped)`,
      );
    }
  });
}

function stageRow(stage, version) {
  const where = `stage ${stage.stage_id}`;
  const cells = {
    organization_id: ORG_PLACEHOLDER,
    stage_key: textCell(stage.stage_id, `${where} stage_id`),
    segment: textCell(stage.segment, `${where} segment`),
    ordinal: numberCell(stage.order, `${where} order`),
    name: textCell(stage.name, `${where} name`),
    backbone_version: version,
    active_flag: 'true',
  };
  const labels = {};
  for (const [column, key] of STAGE_TEXT_FIELDS) {
    cells[column] = fieldValue(stage[key], `${where} ${key}`);
    const label = fieldLabel(stage[key], `${where} ${key}`);
    if (label) labels[column] = label;
  }
  const ppbfName = stage.ppbf_name && typeof stage.ppbf_name === 'object' ? stage.ppbf_name : {};
  for (const [column, part] of PPBF_NAME_PARTS) {
    cells[column] = textCell(ppbfName[part], `${where} ppbf_name.${part}`);
    if (cells[column] && labels.ppbf_name) labels[column] = labels.ppbf_name;
  }
  cells.field_labels = Object.keys(labels).length ? sortedJson(labels) : '';
  return cells;
}

/**
 * What kind of move a next-stage link is (lane BB-1c brief, item 1):
 *   exit        the target is EX1
 *   lateral     both stages share a segment at the same order, or the target is
 *               RC1 or FT1 from a stage outside the recreational segment
 *   branch      the stage has more than one link that is neither exit nor lateral
 *   progression otherwise
 */
export function linkKinds(stages) {
  const byKey = new Map(stages.map((stage) => [stage.stage_id, stage]));
  const out = [];
  for (const stage of stages) {
    const first = stage.next_stages.map((to) => {
      const target = byKey.get(to);
      if (to === 'EX1') return { to, kind: 'exit' };
      const sameSlot = target && target.segment === stage.segment && target.order === stage.order;
      const intoLifelong = (to === 'RC1' || to === 'FT1') && stage.segment !== 'recreational';
      return { to, kind: sameSlot || intoLifelong ? 'lateral' : null };
    });
    const open = first.filter((link) => link.kind === null).length;
    for (const link of first) out.push({ from: stage.stage_id, to: link.to, kind: link.kind ?? (open > 1 ? 'branch' : 'progression') });
  }
  return out;
}

function defaultRow(rule, version) {
  const where = `default ${rule.default_id ?? '(no default_id)'}`;
  const cells = { organization_id: ORG_PLACEHOLDER, backbone_version: version, active_flag: 'true', stage_keys: '' };
  for (const key of DEFAULT_TEXT_KEYS) cells[key] = textCell(rule[key], `${where} ${key}`);
  for (const key of DEFAULT_NUMBER_KEYS) cells[key] = numberCell(rule[key], `${where} ${key}`);
  checkStatus(rule.status, where);
  checkSources(rule.sources ?? [], where);
  cells.sources = (rule.sources ?? []).map((source) => source.normalize('NFC').trim()).join('|');
  if (rule.phases !== undefined) {
    if (!Array.isArray(rule.phases)) throw new ExportError(`${where}: phases must be a list`);
    cells.phases = sortedJson(rule.phases);
  } else {
    cells.phases = '';
  }
  checkEvidence(rule.evidence, where);
  cells.evidence = rule.evidence.length ? sortedJson(rule.evidence) : '';
  cells.field_labels = defaultFieldLabels(rule, where);
  return cells;
}

/**
 * A default's field_labels: blank unless the row carries per-field labels
 * (Overwatch, PR #1894). Each entry must be {status, sources?} with a status
 * of the four; any other shape is refused by name, never reshaped.
 */
function defaultFieldLabels(rule, where) {
  if (rule.field_labels === undefined) return '';
  const labels = rule.field_labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new ExportError(`${where}: field_labels must be an object`);
  for (const [field, label] of Object.entries(labels)) {
    if (!label || typeof label !== 'object' || Array.isArray(label)) {
      throw new ExportError(`${where}: field_labels.${field} is ${JSON.stringify(label)}, not {status, sources} (refused, not mapped)`);
    }
    checkStatus(label.status, `${where} field_labels.${field}`);
    if (label.sources !== undefined) checkSources(label.sources, `${where} field_labels.${field}`);
  }
  return Object.keys(labels).length ? sortedJson(labels) : '';
}

function readJson(file) {
  const bytes = fs.readFileSync(file);
  return { bytes, data: JSON.parse(bytes.toString('utf8')), modified: fs.statSync(file).mtime };
}

/**
 * The package for one Backbone folder: { files: { name: text }, counts, backboneVersion }.
 * Throws ExportError on anything it would have to guess or map.
 */
export function exportPathwayCatalog(backboneDir) {
  const spineFile = path.join(backboneDir, SPINE_FILE);
  const catalogsFile = path.join(backboneDir, CATALOGS_FILE);
  for (const file of [spineFile, catalogsFile]) {
    if (!fs.existsSync(file)) throw new ExportError(`not found: ${file}`);
  }
  const spine = readJson(spineFile);
  const catalogs = readJson(catalogsFile);
  const backboneVersion = `spine ${sha16(spine.bytes)} / catalogs ${sha16(catalogs.bytes)} / ${isoSeconds(spine.modified)}, ${isoSeconds(catalogs.modified)}`;

  const stages = spine.data.stages;
  const rules = catalogs.data.default_rules;
  if (!Array.isArray(stages)) throw new ExportError(`${SPINE_FILE}: stages[] is missing`);
  if (!Array.isArray(rules)) throw new ExportError(`${CATALOGS_FILE}: default_rules[] is missing`);

  const stageRows = stages.map((stage) => stageRow(stage, backboneVersion))
    .sort((a, b) => Number(a.ordinal) - Number(b.ordinal) || compare(a.stage_key, b.stage_key));
  for (const stage of stages) {
    if (!Array.isArray(stage.next_stages)) throw new ExportError(`stage ${stage.stage_id}: next_stages must be a list`);
  }
  const linkRows = linkKinds(stages)
    .map((link) => ({
      organization_id: ORG_PLACEHOLDER,
      from_stage_key: textCell(link.from, `link from ${link.from}`),
      to_stage_key: textCell(link.to, `link ${link.from} to`),
      link_kind: link.kind,
      backbone_version: backboneVersion,
      active_flag: 'true',
    }))
    .sort((a, b) => compare(a.from_stage_key, b.from_stage_key) || compare(a.to_stage_key, b.to_stage_key));
  const defaultRows = rules.map((rule) => defaultRow(rule, backboneVersion)).sort((a, b) => compare(a.default_id, b.default_id));

  const table = (name, rows) => writeCsv(HEADERS[name], rows.map((row) => HEADERS[name].map((column) => row[column] ?? '')));
  return {
    backboneVersion,
    counts: { stages: stageRows.length, links: linkRows.length, defaults: defaultRows.length },
    files: {
      'seed_pathway_stages.csv': table('seed_pathway_stages.csv', stageRows),
      'seed_pathway_stage_links.csv': table('seed_pathway_stage_links.csv', linkRows),
      'seed_pathway_stage_defaults.csv': table('seed_pathway_stage_defaults.csv', defaultRows),
    },
  };
}

/** Code-unit order: the same on every machine and locale. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const USAGE = 'usage: node scripts/backbone-export-pathway-catalog.mjs <backbone-folder> [--out <folder>]';

export function parseArgs(argv) {
  const positional = [];
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      if (!out) throw new ExportError(`--out needs a folder\n${USAGE}`);
      i += 1;
    } else if (argv[i].startsWith('--')) {
      throw new ExportError(`unknown option ${argv[i]}\n${USAGE}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) throw new ExportError(`give exactly one Backbone folder\n${USAGE}`);
  return { backboneDir: positional[0], out };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const result = exportPathwayCatalog(path.resolve(args.backboneDir));
    const out = path.resolve(args.out ?? path.join(here, '..', 'seed-data', 'pathway-catalog'));
    fs.mkdirSync(out, { recursive: true });
    for (const [name, text] of Object.entries(result.files)) fs.writeFileSync(path.join(out, name), text, 'utf8');
    console.log(`backbone_version: ${result.backboneVersion}`);
    console.log(`stages ${result.counts.stages}, links ${result.counts.links}, defaults ${result.counts.defaults} -> ${out}`);
  } catch (error) {
    if (error instanceof ExportError) {
      console.error(`backbone-export-pathway-catalog: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
