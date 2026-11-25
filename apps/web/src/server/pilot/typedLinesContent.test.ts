import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { readCsv } from './contentImport/csv';
import { MINT } from './contentImport/ids';
import { normalizeName } from './contentImport/warnings';

// Lane W4-8 (OD-2026-11-19-030, OW26-05 "B: Turn typed lines into library drills"; OD-2026-11-20-001 OW27-09,
// "B: A new drill for every line"): every typed step in the 11 mixed templates becomes a library drill, AI-draft
// labelled (OD-2026-11-15-011). Plan and GO: #2162. Checks the committed rows only (no database):
//   - every lane W4-8 drill passes adoption readiness from its own seed rows (the floor test taken as met, as
//     committedTemplateIssueSweep.test.ts does), carries the draft marker on every drafted field, and is
//     version 1 of its own lineage with the id the import mints from its discipline and name;
//   - its name is not equal to, inside, or around any other drill's name (the import's near-duplicate rule);
//   - each step its source_ref names is either still a typed step holding exactly the quoted line (a drill PR
//     lands before its step PR) or links this drill, at the drill's own contact level; and no step links a
//     lane W4-8 drill that does not name it.

const SEED = path.resolve(__dirname, '../../../seed-data');
const DRILLS = 'drill-library/seed_drill_library.csv';
const SCALES = 'drill-library/seed_drill_scale_levels.csv';
const STOPS = 'drill-library/seed_drill_stop_rules.csv';
const CUES = 'drill-library/seed_drill_cues.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';
const CLASS = 'AI DRAFT - lane W4-8';
const MARKER = /^AI draft, lane W4-8, \d{4}-\d{2}-\d{2} \(OD-2026-11-19-030; OD-2026-11-20-001 OW27-09; OD-2026-11-15-011\)$/;
const LABELLED = [
  'category', 'contact_level', 'cues', 'difficulty', 'discipline', 'equipment_needed', 'execution', 'name', 'purpose',
  'scale_levels', 'standard_setup', 'stop_rules', 'target_behavior', 'what_good_looks_like',
];
// No 's' flag: the app targets ES2017 (tsconfig), and a typed line with a line break is matched by [^]*.
const STEP_REF = /typed line of ((?:wtp_[0-9a-f]{14} step \d+)(?:, wtp_[0-9a-f]{14} step \d+)*): '([^]*)'$/;
const PROVENANCE = 'COACHING-CRAFT DRAFT \u2014 no directly relevant research retrieved; REQUIRES FLOOR VALIDATION';

/**
 * The typed lines a step PR replaced, pinned before the PR linked them: per template, sha256 of each typed step's
 * "<ordinal>\t<line>\n" in ordinal order, where the line is the step's free_text_drill, or its block title when the
 * step held its text only in details. Taken from the committed items at the commit before each step PR (TL-1b:
 * 89d1dc81). Once a step links its drill, its typed text is gone from the template, so this is what still holds the
 * drill's quoted line to the original (reviewer B on #2174). A step PR adds its templates here.
 */
const LINKED_LINES_SHA256: Record<string, string> = {
  wtp_43c793b8f90e77: '0ce93376cfc381be8be9e73068f87136e6b238d8f235f82ef21108586c6926d9', // 48-Session Manual, Weeks 1-4 (TL-1b)
  wtp_ed57bea28de0f7: '5c1fda8d7e279462011757fdb575f8ed2b837d6e6544cc45ad5e6e51f20f0bdb', // Weeks 5-8 (TL-1b)
  wtp_d861f584584788: '0db4dd011480e5ccfd5f3fc5df45984ebb9f25803a3e26c91e55fa94bb79f2b2', // Weeks 9-12 (TL-1b)
  wtp_900c0a3fd4422a: '76781c9612b5ad2c1e003308dafa24cf78438f64140c99b5ffaa2180ff21f03e', // Scripted 60-Minute Class (TL-2; at d9514532)
};

type Row = Record<string, string>;

const parseProblems: string[] = [];
function rows(name: string): Row[] {
  const table = readCsv(fs.readFileSync(path.join(SEED, name), 'utf8'));
  parseProblems.push(...table.problems.map((problem) => `${name}: ${JSON.stringify(problem)}`));
  return table.records.map((record) => Object.fromEntries(table.header.map((column, index) => [column, record.cells[index]])));
}

const library = rows(DRILLS);
const laneDrills = library.filter((row) => row.content_class.startsWith(CLASS));
const childRows = (name: string) => {
  const out = new Map<string, Row[]>();
  for (const row of rows(name)) out.set(row.drill_id, [...(out.get(row.drill_id) ?? []), row]);
  return out;
};
const scales = childRows(SCALES);
const stops = childRows(STOPS);
const cues = childRows(CUES);
const items = rows(ITEMS);
const itemAt = new Map(items.map((item) => [`${item.template_id} ${item.ordinal}`, item]));

/** The typed text of a step: its free_text_drill, or, for a scripted class step holding none, its block title. */
function typedText(item: Row): string {
  if (item.free_text_drill) return item.free_text_drill;
  return item.details ? (JSON.parse(item.details).block_title ?? '') : '';
}

function namedSteps(drill: Row): { steps: string[]; line: string } {
  const match = STEP_REF.exec(drill.source_ref);
  if (!match) throw new Error(`${drill.drill_id}: source_ref names no typed line: ${drill.source_ref}`);
  return { steps: match[1].split(', ').map((ref) => ref.replace(' step ', ' ')), line: match[2] };
}

function closeNames(a: string, b: string): boolean {
  return a === b || ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

describe('lane W4-8 drills for the typed steps of the mixed templates (committed rows)', () => {
  it('are present, in seed files that parse', () => {
    expect(parseProblems).toEqual([]);
    expect(laneDrills.length).toBeGreaterThan(0);
  });

  it('each pass adoption readiness from their own seed rows, the floor test taken as met', () => {
    for (const drill of laneDrills) {
      const readiness = adoptionReadiness({
        active: drill.active === 'true',
        superseded_at: drill.superseded_at || null,
        name: drill.name,
        purpose: drill.purpose,
        discipline: drill.discipline,
        category: drill.category,
        difficulty: drill.difficulty,
        standard_setup: drill.standard_setup,
        execution: drill.execution,
        what_good_looks_like: drill.what_good_looks_like,
        scale_levels: (scales.get(drill.drill_id) ?? []).map((level) => ({ scale_level: level.scale_level, is_starting_point: level.is_starting_point === 'true' })),
        stop_rules: stops.get(drill.drill_id) ?? [],
        cues: (cues.get(drill.drill_id) ?? []).map((cue) => ({ cue_text: cue.cue_text })),
        field_provenance: drill.field_provenance,
        floor_tested_by_this_gym: true,
      });
      expect({ drill: drill.drill_id, missing: readiness.missing }).toEqual({ drill: drill.drill_id, missing: [] });
    }
  });

  it('are version 1 of their own lineage, with the minted id, blank stage keys and no coach-authorization flag', () => {
    for (const drill of laneDrills) {
      expect([drill.drill_id, drill.lineage_id, drill.version, drill.supersedes_drill_id, drill.superseded_at, drill.stage_keys, drill.requires_coach_authorization])
        .toEqual([MINT.drill(drill.discipline, drill.name), drill.drill_id, '1', '', '', '', 'false']);
    }
  });

  it('carry the lane W4-8 draft marker on every drafted field, and unchecked, untiered evidence', () => {
    for (const drill of laneDrills) {
      const labels = JSON.parse(drill.field_labels);
      expect({ drill: drill.drill_id, fields: Object.keys(labels).sort() }).toEqual({ drill: drill.drill_id, fields: LABELLED });
      for (const field of LABELLED) {
        expect(labels[field].status).toBe('INFERRED');
        expect(labels[field].draft).toMatch(MARKER);
        expect(labels[field].basis).not.toBe('');
        expect(labels[field].sources[0]).toBe(drill.source_ref);
      }
      const evidence = JSON.parse(drill.evidence);
      expect(evidence.map((entry: Row) => [entry.evidence_label, entry.check_state, entry.source])).toEqual([['UNTIERED', 'unchecked', drill.source_ref]]);
      // A draft provenance, so a gym's coach must still floor-test it before adoption (OD-2026-10-06-026 ruling 3).
      expect({ drill: drill.drill_id, provenance: drill.field_provenance }).toEqual({ drill: drill.drill_id, provenance: PROVENANCE });
    }
  });

  it('have names that are not equal to, inside, or around any other drill\'s name', () => {
    const normalized = library.map((row) => ({ id: row.drill_id, name: normalizeName(row.name) }));
    for (const drill of laneDrills) {
      const own = normalizeName(drill.name);
      const close = normalized.filter((other) => other.id !== drill.drill_id && closeNames(own, other.name)).map((other) => other.id);
      expect({ drill: drill.drill_id, close }).toEqual({ drill: drill.drill_id, close: [] });
    }
    expect(new Set(library.map((row) => row.drill_id)).size).toBe(library.length);
  });

  it('name only real steps, each still typed with exactly the quoted line or linking this drill, at its contact level', () => {
    for (const drill of laneDrills) {
      const { steps, line } = namedSteps(drill);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        const item = itemAt.get(step);
        if (!item) throw new Error(`${drill.drill_id}: no committed step ${step}`);
        if (item.drill_id === '') expect({ step, text: typedText(item) }).toEqual({ step, text: line });
        else expect({ step, drill: item.drill_id }).toEqual({ step, drill: drill.drill_id });
        expect({ step, contact: item.contact_level || 'none' }).toEqual({ step, contact: drill.contact_level });
      }
      for (const level of scales.get(drill.drill_id) ?? []) expect(level.contact_level).toBe(drill.contact_level);
    }
  });

  it('cover every typed or lane-linked step of each template they name, each step named by exactly one drill', () => {
    const namers = new Map<string, string[]>();
    for (const drill of laneDrills) {
      for (const step of namedSteps(drill).steps) namers.set(step, [...(namers.get(step) ?? []), drill.drill_id]);
    }
    const laneIds = new Set(laneDrills.map((drill) => drill.drill_id));
    const templates = new Set([...namers.keys()].map((step) => step.split(' ')[0]));
    const steps = items.filter((item) => templates.has(item.template_id) && (item.drill_id === '' || laneIds.has(item.drill_id)));
    expect(steps.length).toBeGreaterThan(0);
    for (const item of steps) {
      const step = `${item.template_id} ${item.ordinal}`;
      expect({ step, namedBy: (namers.get(step) ?? []).length }).toEqual({ step, namedBy: 1 });
    }
  });

  it('quote, for every template whose steps they link, exactly the typed lines it held before, and label that template', () => {
    const laneById = new Map(laneDrills.map((drill) => [drill.drill_id, drill]));
    const linkedTemplates = new Set(items.filter((item) => laneById.has(item.drill_id)).map((item) => item.template_id));
    expect([...linkedTemplates].sort()).toEqual(Object.keys(LINKED_LINES_SHA256).sort());
    const templateRows = rows('workout-templates/seed_workout_templates.csv');
    for (const [templateId, expected] of Object.entries(LINKED_LINES_SHA256)) {
      const linked = items.filter((item) => item.template_id === templateId && laneById.has(item.drill_id))
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      const text = linked.map((item) => `${item.ordinal}\t${namedSteps(laneById.get(item.drill_id) as Row).line}\n`).join('');
      expect({ templateId, sha256: createHash('sha256').update(text, 'utf8').digest('hex') }).toEqual({ templateId, sha256: expected });
      // The lane's label is a part of the template's own 'items' label, so the template screen marks the steps as drafts.
      const label = JSON.parse(templateRows.find((row) => row.template_id === templateId)?.field_labels ?? '{}').items?.drill_id;
      expect({ templateId, status: label?.status, draft: MARKER.test(label?.draft ?? '') }).toEqual({ templateId, status: 'INFERRED', draft: true });
    }
  });

  it('are linked only from the steps they name', () => {
    const named = new Map(laneDrills.map((drill) => [drill.drill_id, new Set(namedSteps(drill).steps)]));
    for (const item of items.filter((candidate) => named.has(candidate.drill_id))) {
      expect({ drill: item.drill_id, step: `${item.template_id} ${item.ordinal}`, named: named.get(item.drill_id)?.has(`${item.template_id} ${item.ordinal}`) })
        .toEqual({ drill: item.drill_id, step: `${item.template_id} ${item.ordinal}`, named: true });
    }
  });
});
