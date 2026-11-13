import fs from 'node:fs';
import path from 'node:path';

import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { readCsv } from './contentImport/csv';

// The FT1 drill drafts (lane FT1d-1; OD-2026-11-12-005 ruling 3, OD-2026-11-12-007).
//
// The 131 FT1 drills are the DOC-123 rows of the committed drill library
// (field_provenance "PPBF owner-authored", source_ref naming DOC-123). Their
// missing setup, steps, what-good-looks-like, A/B/C scaling and own stop rules
// were drafted by AI from the Backbone sources and approved by Jason before
// merge. Two things are pinned here, from the committed CSVs alone:
//
//   1. Every FT1 drill now passes the adoption-readiness check with the floor
//      test taken as met -- the same inputs issuing uses (workoutTemplates.ts,
//      planTemplateIssue). Withdrawn/superseded are database states, so the
//      committed row is read as a current version.
//   2. Every drafted field says so in field_labels: a `draft` marker, status
//      INFERRED (with the source keys it was built from) or UNVERIFIED (no
//      source), never OBSERVED or REPORTED. Scale levels and stop rules also
//      carry a label per level and per rule, and each stop rule its evidence
//      tier (Backbone RULES sections 1 and 10).

const LIBRARY_DIR = path.resolve(__dirname, '../../../seed-data/drill-library');
const DRAFTED_FIELDS = ['standard_setup', 'execution', 'what_good_looks_like', 'scale_levels', 'stop_rules'] as const;

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

const ft1 = library.filter((row) => row.field_provenance === 'PPBF owner-authored' && row.source_ref.startsWith('DOC-123'));

function childrenOf(table: Row[], drillId: string): Row[] {
  return table.filter((row) => row.drill_id === drillId);
}

function labelsOf(row: Row): Record<string, Label> {
  return JSON.parse(row.field_labels) as Record<string, Label>;
}

function checkLabel(where: string, label: Label | undefined, problems: string[]): void {
  if (!label || typeof label !== 'object') {
    problems.push(`${where}: no label`);
    return;
  }
  const sources = Array.isArray(label.sources) ? (label.sources as unknown[]) : null;
  if (!sources) problems.push(`${where}: sources is not a list`);
  if (label.status === 'INFERRED') {
    if (sources && sources.length === 0) problems.push(`${where}: INFERRED with no sources`);
  } else if (label.status === 'UNVERIFIED') {
    if (sources && sources.length > 0) problems.push(`${where}: UNVERIFIED with sources`);
  } else {
    problems.push(`${where}: a drafted field is ${JSON.stringify(label.status)} (INFERRED or UNVERIFIED only)`);
  }
}

describe('FT1 drill drafts (lane FT1d-1)', () => {
  it('finds all 131 FT1 drills', () => {
    expect(ft1).toHaveLength(131);
  });

  it('every FT1 drill passes adoption readiness with the floor test taken as met', () => {
    const notReady = ft1
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

  it('each FT1 drill has A, B and C, starting at B, with the drill\'s own contact level', () => {
    const problems: string[] = [];
    for (const row of ft1) {
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

  it('every drafted field has a field_labels entry marking it a draft, INFERRED with sources or UNVERIFIED without', () => {
    const problems: string[] = [];
    let drafted = 0;
    for (const row of ft1) {
      const labels = labelsOf(row);
      if (row.field_provenance !== 'PPBF owner-authored') problems.push(`${row.drill_id}: field_provenance changed`);
      for (const field of DRAFTED_FIELDS) {
        const label = labels[field];
        if (!label || label.draft === undefined) continue;
        drafted += 1;
        checkLabel(`${row.drill_id} ${field}`, label, problems);
        if (field === 'scale_levels') {
          for (const level of ['A', 'B', 'C']) checkLabel(`${row.drill_id} scale ${level}`, label[level] as Label | undefined, problems);
        }
        if (field === 'stop_rules') {
          childrenOf(stops, row.drill_id).forEach((rule) => {
            const ruleLabel = label[rule.ordinal] as Label | undefined;
            checkLabel(`${row.drill_id} stop ${rule.ordinal}`, ruleLabel, problems);
            if (!['CONVENTION', 'UNTIERED'].includes(String(ruleLabel?.evidence_label))) {
              problems.push(`${row.drill_id} stop ${rule.ordinal}: evidence tier ${JSON.stringify(ruleLabel?.evidence_label)}`);
            }
            if (rule.scope !== 'drill_specific') problems.push(`${row.drill_id} stop ${rule.ordinal}: scope ${rule.scope}`);
          });
        }
      }
      // A field that was blank before the drafts had to be drafted, so it must
      // carry the marker: setup and steps of every drill but the three optional
      // punch introductions, and every drill's scale levels.
      if (!labels.scale_levels || labels.scale_levels.draft === undefined) problems.push(`${row.drill_id}: scale_levels not labelled as a draft`);
      for (const field of ['standard_setup', 'execution', 'what_good_looks_like'] as const) {
        const label = labels[field];
        if (!row[field].trim()) problems.push(`${row.drill_id} ${field}: still blank`);
        if (label?.status === 'UNVERIFIED' && label.draft === undefined) problems.push(`${row.drill_id} ${field}: UNVERIFIED but not marked a draft`);
      }
    }
    expect(problems).toEqual([]);
    // 128 setup + 128 steps + 57 what-good + 131 scale sets + 128 stop-rule sets.
    expect(drafted).toBe(572);
  });
});
