import fs from 'node:fs';
import path from 'node:path';

import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { readCsv } from './contentImport/csv';

// The lane-2 drill drafts (lane L2b; OD-2026-11-15-002, as changed by Jason's cards OW25-15,
// OW25-16 A and OW25-17 A: he skips the review of AI drafts; they load once the lane's two
// adversarial reviewers pass each review sheet).
//
// The lane-2 drills are the 256 frozen Backbone drills whose stage_keys is not exactly ["FT1"]
// (backbone-export-drill-library.mjs). Their blank purpose, target behaviour, difficulty, the one
// category, setup, steps, what good looks like, A/B/C scaling, own stop rules, the rule kinds of the
// 12 DOC-023/022 stop rules, and a cue for every non-conditioning drill without one were drafted by AI
// from the Backbone sources. Pinned here, from the committed CSVs alone:
//
//   1. Every lane-2 drill passes the adoption-readiness check with the floor test taken as met --
//      the inputs issuing uses. Withdrawn/superseded are database states, so the committed row is
//      read as a current version.
//   2. Every drafted field says so in field_labels: the L2b `draft` marker, status INFERRED (with
//      the source keys it was built from) or UNVERIFIED (no source), never OBSERVED or REPORTED.
//      Scale levels, stop rules, rule kinds and cues carry a label per level, rule or cue, and each
//      drafted stop rule its evidence tier (Backbone RULES sections 1 and 10). No approval source
//      is added (OW25-16 A): a "Jason <date> (OD-...)" source on a drafted label is refused.
//   3. Contact levels and requires_coach_authorization are as frozen (OD-2026-11-15-002 ruling 3;
//      OW25-01 A: false on all 73 sparring drills).

const DRAFT_MARK = 'AI draft, lane L2b, 2026-11-16 (OD-2026-11-15-002 ruling 2)';
const APPROVAL = /^Jason \d{4}-\d{2}-\d{2} \(OD-/;
const LIBRARY_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');
const PER_PART = new Set(['scale_levels', 'stop_rules', 'stop_rules.rule_kind', 'cues']);

type Row = Record<string, string>;
type Label = { status?: unknown; sources?: unknown; draft?: unknown; evidence_label?: unknown; [key: string]: unknown };

function rows(file: string): Row[] {
  const table = readCsv(fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf8'));
  expect(table.problems).toEqual([]);
  return table.records.map(({ cells }) => Object.fromEntries(table.header.map((name, i) => [name, cells[i] ?? ''])));
}

const library = rows('seed_drill_library.csv');
const scales = rows('seed_drill_scale_levels.csv');
const stops = rows('seed_drill_stop_rules.csv');
const cues = rows('seed_drill_cues.csv');

const lane2 = library.filter((row) => row.stage_keys !== '' && row.stage_keys !== 'FT1');
const childrenOf = (table: Row[], drillId: string) => table.filter((row) => row.drill_id === drillId);
const labelsOf = (row: Row) => JSON.parse(row.field_labels) as Record<string, Label>;

function checkLabel(where: string, label: Label | undefined, problems: string[]): void {
  if (!label || typeof label !== 'object') {
    problems.push(`${where}: no label`);
    return;
  }
  const sources = Array.isArray(label.sources) ? (label.sources as unknown[]) : null;
  if (!sources) {
    problems.push(`${where}: sources is not a list`);
    return;
  }
  if (sources.some((source) => typeof source !== 'string' || APPROVAL.test(source))) problems.push(`${where}: an approval source or a non-text source`);
  if (label.status === 'INFERRED') {
    if (sources.length === 0) problems.push(`${where}: INFERRED with no source`);
  } else if (label.status === 'UNVERIFIED') {
    if (sources.length > 0) problems.push(`${where}: UNVERIFIED with a source`);
  } else {
    problems.push(`${where}: a drafted field is ${JSON.stringify(label.status)} (INFERRED or UNVERIFIED only)`);
  }
}

describe('lane-2 drill drafts (lane L2b)', () => {
  it('finds the 256 lane-2 drills with their contact levels as frozen, and no coach-authorization flag', () => {
    expect(lane2).toHaveLength(256);
    const contact: Record<string, number> = {};
    for (const row of lane2) contact[row.contact_level] = (contact[row.contact_level] ?? 0) + 1;
    expect(contact).toEqual({ none: 150, light_technical: 33, controlled_sparring: 68, open_sparring: 5 });
    expect(lane2.filter((row) => row.requires_coach_authorization !== 'false')).toEqual([]);
    expect(new Set(lane2.map((row) => row.field_provenance))).toEqual(new Set(['Long Road practice', 'PPBF owner-authored']));
  });

  it('every lane-2 drill passes adoption readiness with the floor test taken as met', () => {
    const notReady = lane2
      .map((row) => {
        const readiness = adoptionReadiness({
          active: row.active === 'true',
          superseded_at: row.superseded_at || null,
          name: row.name,
          purpose: row.purpose,
          discipline: row.discipline,
          category: row.category,
          difficulty: row.difficulty,
          standard_setup: row.standard_setup,
          execution: row.execution,
          what_good_looks_like: row.what_good_looks_like,
          scale_levels: childrenOf(scales, row.drill_id).map((level) => ({
            scale_level: level.scale_level,
            is_starting_point: level.is_starting_point.toLowerCase() === 'true',
          })),
          stop_rules: childrenOf(stops, row.drill_id),
          cues: childrenOf(cues, row.drill_id).map((cue) => ({ cue_text: cue.cue_text })),
          field_provenance: row.field_provenance,
          floor_tested_by_this_gym: true,
        });
        return readiness.ready ? null : `${row.drill_id} ${row.name}: ${readiness.missing.join(' ')}`;
      })
      .filter((line): line is string => line !== null);
    expect(notReady).toEqual([]);
  });

  it("each lane-2 drill has A, B and C, starting at B, with the drill's own contact level", () => {
    const problems: string[] = [];
    for (const row of lane2) {
      const levels = childrenOf(scales, row.drill_id);
      const names = levels.map((level) => level.scale_level).sort().join('');
      if (names !== 'ABC') problems.push(`${row.drill_id}: levels ${names}`);
      const starts = levels.filter((level) => level.is_starting_point.toLowerCase() === 'true').map((level) => level.scale_level);
      if (starts.join('') !== 'B') problems.push(`${row.drill_id}: starts at ${starts.join(',') || 'none'}`);
      for (const level of levels) {
        if (level.contact_level !== row.contact_level) problems.push(`${row.drill_id} ${level.scale_level}: contact ${level.contact_level} vs drill ${row.contact_level}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every drafted field has a field_labels entry marking it an AI draft, INFERRED with sources or UNVERIFIED without, and no approval source', () => {
    const problems: string[] = [];
    const drafted: Record<string, number> = {};
    for (const row of lane2) {
      const labels = labelsOf(row);
      for (const [field, label] of Object.entries(labels)) {
        if (!label || typeof label !== 'object' || label.draft === undefined) continue;
        if (label.draft !== DRAFT_MARK) problems.push(`${row.drill_id} ${field}: draft marker ${JSON.stringify(label.draft)}`);
        drafted[field] = (drafted[field] ?? 0) + 1;
        checkLabel(`${row.drill_id} ${field}`, label, problems);
        if (field === 'scale_levels') {
          for (const level of ['A', 'B', 'C']) checkLabel(`${row.drill_id} scale ${level}`, label[level] as Label | undefined, problems);
        }
        if (field === 'stop_rules') {
          const own = childrenOf(stops, row.drill_id);
          if (own.length === 0) problems.push(`${row.drill_id}: stop rules labelled as drafted but none committed`);
          for (const rule of own) {
            const ruleLabel = label[rule.ordinal] as Label | undefined;
            checkLabel(`${row.drill_id} stop ${rule.ordinal}`, ruleLabel, problems);
            if (!['CONVENTION', 'UNTIERED'].includes(String(ruleLabel?.evidence_label))) problems.push(`${row.drill_id} stop ${rule.ordinal}: evidence tier ${JSON.stringify(ruleLabel?.evidence_label)}`);
            if (rule.scope !== 'drill_specific') problems.push(`${row.drill_id} stop ${rule.ordinal}: scope ${rule.scope}`);
          }
        }
        if (field === 'stop_rules.rule_kind') {
          for (const rule of childrenOf(stops, row.drill_id)) {
            const kindLabel = label[rule.ordinal] as Label | undefined;
            checkLabel(`${row.drill_id} rule kind ${rule.ordinal}`, kindLabel, problems);
            if (kindLabel?.rule_kind !== rule.rule_kind) problems.push(`${row.drill_id} rule kind ${rule.ordinal}: label ${JSON.stringify(kindLabel?.rule_kind)} vs row ${rule.rule_kind}`);
          }
        }
        if (field === 'cues') {
          for (const cue of childrenOf(cues, row.drill_id)) checkLabel(`${row.drill_id} cue ${cue.cue_id}`, label[cue.cue_id] as Label | undefined, problems);
        }
        if (!PER_PART.has(field) && !String(row[field] ?? '').trim()) problems.push(`${row.drill_id} ${field}: labelled as drafted but blank`);
      }
      if (labels.scale_levels?.draft === undefined) problems.push(`${row.drill_id}: scale_levels not labelled as a draft`);
      if (row.discipline !== 'conditioning' && childrenOf(cues, row.drill_id).length === 0) problems.push(`${row.drill_id}: a non-conditioning drill with no cue`);
    }
    expect(problems).toEqual([]);
    // The brief's blank counts (OBSERVED in the frozen files), plus F1 A's 12 rule kinds.
    expect(drafted).toEqual({
      purpose: 173, target_behavior: 167, difficulty: 222, category: 1, standard_setup: 125, execution: 158, what_good_looks_like: 231,
      scale_levels: 256, stop_rules: 244, 'stop_rules.rule_kind': 12, cues: 152,
    });
  });
});
