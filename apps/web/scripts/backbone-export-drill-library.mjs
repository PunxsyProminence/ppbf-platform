#!/usr/bin/env node
// BACKBONE -> DRILL LIBRARY, LANE 2 (lane L2b; OD-2026-11-15-002, OD-2026-11-10-003).
//
//   node scripts/backbone-export-drill-library.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]
//
// The rest of the drill library: every frozen Backbone drill whose stage_keys is NOT exactly ["FT1"]
// (FT1's 131 are backbone-export-ft1-track.mjs's). Rows are ADDED to the committed drill-library CSVs:
//   seed_drill_library.csv      256 drills
//   seed_drill_cues.csv         their cues
//   seed_drill_stop_rules.csv   their own stop rules
// Scale levels and secondary skills: the frozen records carry none (checked; a record that did would
// stop the export), so those two files are not written. --out defaults to apps/web/seed-data. Every
// committed row outside the lane-2 set is kept exactly as it is, in its place; lane-2 rows already in
// a file are replaced, so a second run on an unedited tree is byte-identical.
//
// OVERWRITE GUARD (as lane FT1-G, #1924). Lane-2 rows are edited after the export: the drafts Jason
// approves (OD-2026-11-15-002 ruling 2) fill blank fields and labels, and add cues, stop rules and the
// rule kinds the import needs. A rerun would put the frozen blanks back, so every committed lane-2 row
// the run would replace is compared with its new row first; a changed cell or a row that would
// disappear stops the export, naming each file, drill and field, and nothing is written.
// --allow-overwrite writes anyway and prints the same list.
//
// THE SET. 256 drills: 190 'Long Road practice'; 54 'PPBF owner-authored' (DOC-091 22, DOC-151 12,
// DOC-152 12, DOC-089 8); 12 DOC-023/DOC-022. A different count is printed by name and the run exits 2,
// as the FT1 exporter does (the L2b brief: a different count stops the lane).
//
// FROZEN, READ-ONLY, HASHED. Every drill file is hashed against FREEZE_MANIFEST.json, as the FT1
// exporter does; a mismatch stops the export.
//
// COPY, NEVER REWORD. As the FT1 exporter: text NFC and trimmed; null is a blank cell. A text field
// the record holds as a list of lines (common_errors in 49 records, execution in 1) is written one
// element per line, joined by "\n", each element as written. Nothing under `record` is dropped
// silently: every key is carried or on the not-carried list (printed with counts); an unknown key
// stops the export. Excerpt keys (`quote`, `quotes`, `owner_passages`) never enter this public
// repository (OD-2026-10-02-013 2A; the L2b brief: owner passages are read as drafting sources only).
//
// MAPPING (the L2b step-1 report, Overwatch OK):
//   - field_provenance: as written, except the 12 long DOC-023 values, which load as
//     'PPBF owner-authored' (PK-201 A); the long value is kept in
//     field_labels.field_provenance.backbone_value.
//   - status, sources, stage_links, scale_levels: not carried, as FT1.
//   - library_group, coaching_notes, prescription and the other record keys with no drill-library
//     column (NO_COLUMN below): not carried; the frozen Backbone keeps them (PK-203 A), and the
//     drafts quote them as sources where a drafted field uses them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONTENT_DIRS,
  EXCERPT_KEYS,
  ExportError,
  HEADERS,
  ORG_PLACEHOLDER,
  boolCell,
  checkUniqueIds,
  committedRows,
  compare,
  describeOverwrites,
  findOverwrites,
  isObject,
  labelCells,
  loadManifest,
  mergeCsv,
  numberCell,
  readDir,
  sha16,
  textCell,
} from './backbone-export-ft1-track.mjs';

export const LONG_ROAD = 'Long Road practice';
export const OWNER = 'PPBF owner-authored';
export const DOC023_PROVENANCE = 'PPBF owner-authored (DOC-023 first; DOC-022 for the fields DOC-023 lacks, labelled per field)';
export const EXPECTED_COUNTS = {
  drills: 256, longRoad: 190, ownerAuthored: 54, doc023: 12, doc091: 22, doc151: 12, doc152: 12, doc089: 8,
  cues: 126, stopRules: 12, scaleLevels: 0,
  none: 150, light_technical: 33, controlled_sparring: 68, open_sparring: 5,
};
export const FILES = ['drill-library/seed_drill_library.csv', 'drill-library/seed_drill_cues.csv', 'drill-library/seed_drill_stop_rules.csv'];

// Record keys with no drill-library column. The frozen Backbone keeps them; the drafts cite them.
export const NO_COLUMN = ['library_group', 'coaching_notes', 'prescription', 'progression', 'head_impact_cost', 'owner_rules', 'combination_range',
  'combination_exit', 'training_rule', 'exit_condition', 'correction_path', 'kpi', 'placement_rule', 'placement_condition', 'pass_fail', 'log',
  'source_evidence_grade', 'neurological_development', 'life_skill_transfer', 'coupling_rung', 'use_when', 'exchange_cap_rule', 'defense_return_rule',
  'feint_type', 'feint_mechanism', 'differences', 'progression_stage'];
const TEXT_KEYS = ['name', 'discipline', 'category', 'target_behavior', 'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'what_bad_looks_like',
  'common_errors', 'corrections', 'transfer', 'contact_level', 'equipment_needed', 'content_class', 'source_ref', 'difficulty'];
const KEYS = {
  drill: {
    carried: ['organization_id', 'drill_id', 'lineage_id', ...TEXT_KEYS, 'requires_coach_authorization', 'grounding_claim_ids', 'field_provenance', 'active',
      'cues', 'stop_rules', 'field_labels', 'evidence', 'stage_keys'],
    notCarried: ['status', 'sources', 'stage_links', 'scale_levels', 'owner_passages', ...NO_COLUMN],
  },
  cue: { carried: ['cue_id', 'cue_text', 'focus_type', 'source_ref'], notCarried: [] },
  stopRule: { carried: ['stop_rule_id', 'ordinal', 'condition_text', 'scope', 'rule_kind'], notCarried: [] },
};

const isFt1 = (record) => Array.isArray(record.stage_keys) && record.stage_keys.length === 1 && record.stage_keys[0] === 'FT1';

/** The source group a lane-2 drill is reviewed in (the review sheets' grouping). */
export function sourceGroup(record) {
  if (record.field_provenance === LONG_ROAD) return 'Long Road';
  if (record.field_provenance === DOC023_PROVENANCE) return 'DOC-023/022';
  for (const doc of ['DOC-091', 'DOC-151', 'DOC-152', 'DOC-089']) if (String(record.content_class).includes(doc)) return doc;
  return 'unknown';
}

function checkKeys(kind, record, where, tally) {
  if (!isObject(record)) throw new ExportError(`${where} is not an object`);
  if (record.organization_id !== undefined && record.organization_id !== ORG_PLACEHOLDER) {
    throw new ExportError(`${where}: organization_id ${JSON.stringify(record.organization_id)} is not ${ORG_PLACEHOLDER}`);
  }
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

/** A text field; a list of text is written one element per line, each element as written. */
function textOrLines(value, where) {
  if (Array.isArray(value)) {
    if (!value.every((line) => typeof line === 'string')) throw new ExportError(`${where} is a list with a non-text element`);
    return value.map((line) => line.normalize('NFC').trim()).filter((line) => line !== '').join('\n');
  }
  return textCell(value, where);
}

/** The lane-2 drills, hashed against the manifest. */
export function readLane2(backboneDir) {
  const manifest = loadManifest(backboneDir);
  const hashes = [];
  const all = readDir(backboneDir, manifest, CONTENT_DIRS.drills, hashes).map((entry) => entry.record);
  const drills = all.filter((record) => !isFt1(record)).sort((a, b) => compare(a.drill_id, b.drill_id));
  return { drills, hashes, total: all.length };
}

function drillRows(drills, dropped, tally) {
  const library = [];
  const cues = [];
  const stopRules = [];
  const counts = { scaleLevels: 0, groups: {}, contact: {} };
  for (const drill of drills) {
    const where = `drill ${drill.drill_id}`;
    checkKeys('drill', drill, where, tally);
    if (textCell(drill.lineage_id, `${where} lineage_id`) !== drill.drill_id) throw new ExportError(`${where}: lineage_id differs from drill_id`);
    if ((drill.scale_levels ?? []).length) counts.scaleLevels += drill.scale_levels.length;
    if (!Array.isArray(drill.grounding_claim_ids)) throw new ExportError(`${where}: grounding_claim_ids must be a list`);
    const group = sourceGroup(drill);
    counts.groups[group] = (counts.groups[group] ?? 0) + 1;
    counts.contact[drill.contact_level] = (counts.contact[drill.contact_level] ?? 0) + 1;

    let record = drill;
    if (drill.field_provenance === DOC023_PROVENANCE) {
      // PK-201 A: loads as 'PPBF owner-authored'; the long value stays in field_labels.
      const labels = isObject(drill.field_labels) ? drill.field_labels : {};
      const current = isObject(labels.field_provenance) ? labels.field_provenance : {};
      record = { ...drill, field_provenance: OWNER, field_labels: { ...labels, field_provenance: { ...current, backbone_value: DOC023_PROVENANCE } } };
    }
    const cells = {
      organization_id: ORG_PLACEHOLDER, drill_id: drill.drill_id, lineage_id: drill.lineage_id, version: '1', supersedes_drill_id: '', superseded_at: '',
      skill_id: '', created_by_account_id: '',
      grounding_claim_ids: drill.grounding_claim_ids.map((id) => textCell(id, `${where} grounding_claim_ids`)).join('|'),
      requires_coach_authorization: boolCell(drill.requires_coach_authorization, `${where} requires_coach_authorization`),
      active: boolCell(drill.active, `${where} active`),
      field_provenance: textCell(record.field_provenance, `${where} field_provenance`),
      ...labelCells(record, where, dropped),
    };
    for (const key of TEXT_KEYS) cells[key] = textOrLines(drill[key], `${where} ${key}`);
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

/**
 * The drill-library files for one Backbone folder: { files, counts, differences, notices, overwrites, backboneVersion }.
 * `existing(name)` returns a committed file's text, or undefined. Throws, before any file is produced,
 * when a committed lane-2 row would be changed or removed, unless `allowOverwrite`.
 */
export function exportDrillLibrary(backboneDir, existing = () => undefined, { allowOverwrite = false } = {}) {
  const set = readLane2(backboneDir);
  const backboneVersion = `drill-library lane 2 ${sha16(Buffer.from([...set.hashes].sort(compare).join('\n')))} (${set.hashes.length} files)`;
  const dropped = { keys: 0 };
  const tally = {};
  const rows = drillRows(set.drills, dropped, tally);
  const g = rows.counts.groups;
  const counts = {
    drills: rows.library.length, longRoad: g['Long Road'] ?? 0, ownerAuthored: (g['DOC-091'] ?? 0) + (g['DOC-151'] ?? 0) + (g['DOC-152'] ?? 0) + (g['DOC-089'] ?? 0),
    doc023: g['DOC-023/022'] ?? 0, doc091: g['DOC-091'] ?? 0, doc151: g['DOC-151'] ?? 0, doc152: g['DOC-152'] ?? 0, doc089: g['DOC-089'] ?? 0,
    cues: rows.cues.length, stopRules: rows.stopRules.length, scaleLevels: rows.counts.scaleLevels,
    none: rows.counts.contact.none ?? 0, light_technical: rows.counts.contact.light_technical ?? 0,
    controlled_sparring: rows.counts.contact.controlled_sparring ?? 0, open_sparring: rows.counts.contact.open_sparring ?? 0,
  };
  if (g.unknown) throw new ExportError(`${g.unknown} drill(s) belong to no source group`);
  const differences = Object.entries(EXPECTED_COUNTS).filter(([key, expected]) => counts[key] !== expected).map(([key, expected]) => `${key}: brief ${expected}, observed ${counts[key]}`);

  const lane2 = new Set(rows.library.map((row) => row.drill_id));
  const ofLane2 = (row) => lane2.has(row.drill_id);
  const ordinal = (a, b) => compare(a.drill_id, b.drill_id) || Number(a.ordinal) - Number(b.ordinal);
  const files = {};
  const overwrites = [];
  const put = (name, newRows) => {
    const committed = committedRows(existing(name), HEADERS[name]);
    const replaced = committed.filter(ofLane2);
    const kept = committed.filter((row) => !ofLane2(row));
    // A committed row outside lane 2 with a lane-2 drill's name stops the export (one active name per discipline).
    if (name === FILES[0]) {
      const names = new Map(kept.map((row) => [`${row.discipline}\u0000${row.name}`, row.drill_id]));
      for (const row of newRows) {
        const other = names.get(`${row.discipline}\u0000${row.name}`);
        if (other) throw new ExportError(`${name}: drill ${row.drill_id} "${row.name}" has the name of committed drill ${other}; nothing written`);
      }
    }
    checkUniqueIds(name, kept, newRows);
    overwrites.push(...findOverwrites(name, replaced, newRows));
    files[name] = mergeCsv(kept, HEADERS[name], newRows);
  };
  put(FILES[0], rows.library);
  put(FILES[1], rows.cues.sort(ordinal));
  put(FILES[2], rows.stopRules.sort(ordinal));
  const overwriteLines = describeOverwrites(overwrites);
  if (overwrites.length && !allowOverwrite) {
    throw new ExportError([
      `refused: this run would change or remove ${overwrites.length} committed lane-2 row(s): edits made in the repo since the export`
        + ' (the drafted drill fields, cues, stop rules and labels, OD-2026-11-15-002 ruling 2). Nothing was written.',
      ...overwriteLines,
      'To write the frozen Backbone\'s rows over them on purpose, run again with --allow-overwrite.',
    ].join('\n'));
  }
  const notCarried = Object.entries(tally).sort(([a], [b]) => compare(a, b)).map(([key, n]) => `${key} x${n}`);
  return {
    backboneVersion,
    counts,
    differences,
    files,
    overwrites,
    notices: [
      `drill files read: ${set.total} (lane 2: ${set.drills.length})`,
      `excerpt keys (${EXCERPT_KEYS.join(', ')}) dropped inside carried cells: ${dropped.keys}`,
      `record keys not carried (kind.key xcount): ${notCarried.join(', ')}`,
      ...(overwrites.length ? [`--allow-overwrite: changed or removed ${overwrites.length} committed row(s):`, ...overwriteLines] : []),
      ...(differences.length ? [`COUNTS DIFFER FROM THE BRIEF: ${differences.join('; ')}`] : []),
    ],
  };
}

const USAGE = 'usage: node scripts/backbone-export-drill-library.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]';

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
    const result = exportDrillLibrary(path.resolve(typedIn, args.backboneDir), existing, { allowOverwrite: args.allowOverwrite });
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
      console.error(`backbone-export-drill-library: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
