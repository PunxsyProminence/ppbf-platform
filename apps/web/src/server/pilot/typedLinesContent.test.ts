import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { readCsv } from './contentImport/csv';
import { MINT } from './contentImport/ids';
import { VOCABULARIES } from './contentImport/vocabularies';
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
/** Least to most contact (contentImport/vocabularies.ts). */
const CONTACT: readonly string[] = VOCABULARIES.contact_level.values;
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
  wtp_1ad3c846b03ecc: '8bfaffbfcb34d4f272ca36e03e104c4cd51954e5e1b65be5f83638c29105298d', // Friday Sparring Coach Sheet (TL-3a; at 746bc1a5)
  wtp_3557c34e022c31: 'af348054e5f79b77fdf2e644f384beb693da08be5209fbbaaa5ab961d0908fa6', // Wednesday Coach Sheet Defense Day (TL-3a; at 746bc1a5)
  wtp_9fbf7f8edf5016: '444687bba7a13750b9447cf569728336345eac5c5dbb1cedeaedc048b190eee8', // Wednesday Gold Standard Coach Script (TL-3b; at 746bc1a5)
  wtp_456e418b1741b8: '5a716e9cdff90a63a310d72e96184e1ef94c207277dbc8289291d03dbfe010b5', // Iso + Plyo 60-Minute Boxing Session (TL-4; at 746bc1a5)
  wtp_01de3f48606d4c: 'a1cc0a3d368b2e25614bd8a9e4849aee8e443c540f32c292c186f2a855c8993f', // Conditioning session A — SIT (TL-5a; at 746bc1a5)
  wtp_c2c4bec001a56b: 'eca11c360662cbeaad4cef0bc817c25497403baf86a45c8d5f9b7d461010499f', // Phase 1 boxing skill session (TL-5a; at 746bc1a5)
};

/** The lane-linked steps that carry their own stated time as their duration (#2177); a step PR adds its templates here. */
const TIMED_STEPS: Record<string, number[]> = {
  wtp_900c0a3fd4422a: [1, 2, 8, 9, 10, 11, 12, 13, 14, 15], // Scripted 60-Minute Class (TL-2)
  wtp_1ad3c846b03ecc: [1], // Friday Sparring Coach Sheet (TL-3a; step 9's own block time is open sparring, so it stays blank)
  wtp_3557c34e022c31: [1, 6, 7, 8, 9, 10], // Wednesday Coach Sheet Defense Day (TL-3a; the minutes in each step's own title)
  wtp_9fbf7f8edf5016: [1, 2, 3, 4], // Wednesday Gold Standard Coach Script (TL-3b; steps 6 and 7 are controlled sparring)
  wtp_456e418b1741b8: [21], // Iso + Plyo 60-Minute Boxing Session (TL-4; its other linked steps share their block times)
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

/**
 * The minutes a step's block time spans, read the two ways the committed sheets write it: a clock time of day
 * ('4:35–4:40', '3:30 to 3:40': hours:minutes) or a minute:second time into the session ('58:00–60:00'). The
 * clock reading is taken when it gives 1 to 90 minutes (the import's bound for an item's duration); otherwise the
 * minute:second reading when it gives whole minutes in that bound; otherwise null (e.g. '0–8 min', '15 min').
 */
function blockMinutes(blockTime: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(?:–|-|to)\s*(\d{1,2}):(\d{2})$/.exec(typeof blockTime === 'string' ? blockTime : '');
  if (!match) return null;
  const [a, b, c, d] = match.slice(1).map(Number);
  const inBound = (minutes: number) => Number.isInteger(minutes) && minutes >= 1 && minutes <= 90;
  if (a <= 23 && c <= 23 && b < 60 && d < 60 && inBound(c * 60 + d - (a * 60 + b))) return c * 60 + d - (a * 60 + b);
  if (b < 60 && d < 60 && inBound((c * 60 + d - (a * 60 + b)) / 60)) return (c * 60 + d - (a * 60 + b)) / 60;
  return null;
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
      // No scale level runs above the drill's own contact (a step's limit, GO condition 5); level B, the drill as
      // designed, runs at it. An easier level may sit lower (the open sparring drill's level A is controlled sparring).
      // A blank level contact is 'none' (the import's blankDefault); a value outside the vocabulary ranks -1 and fails.
      const rank = (value: string) => CONTACT.indexOf(value || 'none');
      for (const level of scales.get(drill.drill_id) ?? []) {
        const at = { drill: drill.drill_id, level: level.scale_level };
        expect({ ...at, known: rank(level.contact_level) >= 0, above: rank(level.contact_level) > rank(drill.contact_level) })
          .toEqual({ ...at, known: true, above: false });
        if (level.scale_level === 'B') expect({ ...at, b: rank(level.contact_level) }).toEqual({ ...at, b: rank(drill.contact_level) });
      }
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

  it('give each linked step its own stated time as its duration, and label it (Codex P1 and App Overwatch on #2177)', () => {
    // Issuing, timers and presets read duration_minutes, never details (workoutTemplates.ts, WorkoutTemplateItemRow
    // .details). A linked step whose details state a time of its own runs for that many minutes: its block_time range,
    // or, where it has none of its own, the minutes its block_title states ("(5 MIN)"), either held by no other step of
    // its template (the title's minutes are matched as written, "(N MIN)"). A time several steps share is the block's,
    // not a step's; and only a step at contact none or light_technical may hold a duration (the import's rule,
    // specs/templates.ts). Durations a step states some other way (details.time, or minutes inside its typed line) are
    // not read here.
    const laneIds = new Set(laneDrills.map((drill) => drill.drill_id));
    const detail = (item: Row, key: string) => (item.details ? JSON.parse(item.details)[key] : undefined);
    const holders = new Map<string, number>();
    for (const item of items) {
      for (const key of ['block_time', 'block_title']) {
        const at = `${item.template_id} ${key} ${detail(item, key)}`;
        holders.set(at, (holders.get(at) ?? 0) + 1);
      }
    }
    const own = (item: Row, key: string) => holders.get(`${item.template_id} ${key} ${detail(item, key)}`) === 1;
    const statedTime = (item: Row): { text: string; minutes: number } | null => {
      const range = own(item, 'block_time') ? blockMinutes(detail(item, 'block_time')) : null;
      if (range !== null) return { text: detail(item, 'block_time'), minutes: range };
      const title = own(item, 'block_title') ? String(detail(item, 'block_title') ?? '') : '';
      const found = [...title.matchAll(/\((\d{1,2}) MIN\)/g)];
      const minutes = found.length === 1 ? Number(found[0][1]) : 0;
      return minutes >= 1 && minutes <= 90 ? { text: found[0][0], minutes } : null;
    };
    const timed = items.filter((item) => laneIds.has(item.drill_id) && statedTime(item) !== null
      && ['none', 'light_technical'].includes(item.contact_level));
    const byTemplate: Record<string, number[]> = {};
    for (const item of timed) (byTemplate[item.template_id] ??= []).push(Number(item.ordinal));
    expect(byTemplate).toEqual(TIMED_STEPS);
    const templateRows = rows('workout-templates/seed_workout_templates.csv');
    for (const item of timed) {
      const step = `${item.template_id} ${item.ordinal}`;
      const { text, minutes } = statedTime(item) as { text: string; minutes: number };
      expect({ step, duration: item.duration_minutes }).toEqual({ step, duration: String(minutes) });
      const label = JSON.parse(templateRows.find((row) => row.template_id === item.template_id)?.field_labels ?? '{}').items?.duration_minutes;
      const basis = String(label?.basis ?? '');
      expect({ step, status: label?.status, lane: basis.startsWith('lane W4-8'), named: basis.includes(`${item.ordinal} ('${text}' → ${minutes})`) })
        .toEqual({ step, status: 'INFERRED', lane: true, named: true });
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
