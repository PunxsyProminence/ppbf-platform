import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { readCsv } from './contentImport/csv';

// Lane HW (OD-2026-11-19-005, OW25-49 (c); Backbone ACTIONS A-112): the six PPBF home sessions on
// the Personal and Home Training track, in place of the six held sessions, which are never loaded.
// Checks the committed rows only (no database): the six templates and their items carry the AI-draft
// marker on every drafted field (OD-2026-11-15-011), the track names exactly these six in days 1-6
// and every template id it names is a committed template, and the 17 linked drills whose stage
// tags omit youth stages keep their tags (report only; no tag is changed by this lane).

const SEED = path.resolve(__dirname, '../../../seed-data');
const TEMPLATES = 'workout-templates/seed_workout_templates.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const DRILLS = 'drill-library/seed_drill_library.csv';
const SCALES = 'drill-library/seed_drill_scale_levels.csv';
const STOPS = 'drill-library/seed_drill_stop_rules.csv';
const CUES = 'drill-library/seed_drill_cues.csv';
// The six drills lane HW wrote for the typed steps (Overwatch GO, Q4 A), by the draft's item title.
const HW_DRILLS: Record<string, string> = {
  'Floor Y and T raises (on the towel)': 'drl_7bcdd061b3f789', 'Forearm plank': 'drl_563b857233c3ee', 'Reverse lunge': 'drl_aeb2cbd5cc593d',
  'Glute bridge': 'drl_cbc25e710fb3e3', 'Towel squeeze and wring': 'drl_564171b28b3667', 'Wall calf raise': 'drl_35aac3b481205b',
};
const SHADOW = 'drl_e7587c167c1ebd';
const TRACK_ID = 'trk_55480ac4429113';
const MARKER = 'AI draft, lane HW, 2026-11-19 (OD-2026-11-19-005; OD-2026-11-15-011)';
const BANDS = ['U12', '12–17', 'Adult'];
const DRAFTED = ['coach_notes', 'name', 'session_type', 'difficulty', 'age_band', 'duration_minutes', 'intent', 'details', 'items'];

type Row = Record<string, string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rows(name: string): Row[] {
  const table = readCsv(fs.readFileSync(path.join(SEED, name), 'utf8'));
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((column, index) => [column, record.cells[index]])));
}
const json = (cell: string) => JSON.parse(cell) as Json;

const templates = rows(TEMPLATES);
const home = templates.filter((row) => row.name.startsWith('PPBF Home Day ')).sort((a, b) => json(a.details).home_week_day - json(b.details).home_week_day);
const homeIds = home.map((row) => row.template_id);
const items = rows(ITEMS).filter((row) => homeIds.includes(row.template_id));
const drills = new Map(rows(DRILLS).map((row) => [row.drill_id, row]));
const track = rows(TRACKS).find((row) => row.track_id === TRACK_ID) as Row;

describe('lane HW: the six PPBF home sessions', () => {
  it('are six templates, days 1 to 6, each id minted from its name, off the stage map, for all ages, unloaded', () => {
    expect(home.map((row) => json(row.details).home_week_day)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const row of home) {
      const day = json(row.details).home_week_day;
      expect(row.name.startsWith(`PPBF Home Day ${day} — `)).toBe(true);
      expect(row.template_id).toBe(`wtp_${createHash('sha256').update(row.name).digest('hex').slice(0, 14)}`);
      expect([row.stage_keys, row.difficulty, row.age_band, row.requires_coach_authorization]).toEqual(['', 'beginner', 'all ages', 'false']);
      // The duration column is the Adult total (Overwatch Q3); every band's total is in details.
      expect(row.duration_minutes).toBe(String(json(row.details).duration_minutes_by_band.Adult));
      expect(Object.keys(json(row.details).duration_minutes_by_band).sort()).toEqual([...BANDS].sort());
    }
  });

  it('label every drafted field INFERRED with the AI-draft marker, and say so in details', () => {
    for (const row of home) {
      const labels = json(row.field_labels);
      for (const field of DRAFTED) {
        expect({ id: row.template_id, field, status: labels[field]?.status, draft: labels[field]?.draft, basis: Boolean(labels[field]?.basis) })
          .toEqual({ id: row.template_id, field, status: 'INFERRED', draft: MARKER, basis: true });
      }
      expect([json(row.details).field_provenance, json(row.details).draft]).toEqual(['AI draft — coach to edit', MARKER]);
    }
  });

  it('carry the same stop rule and the under-12 adult-in-the-room line in all six, in details and in the coach notes the coach screen shows', () => {
    const stopRules = new Set(home.map((row) => json(row.details).stop_rule));
    expect(stopRules.size).toBe(1);
    expect([...stopRules][0]).toContain('call 911');
    for (const row of home) {
      expect((json(row.details).before_every_session as string[]).some((line) => line.startsWith('Under 12: an adult is at home and in the room for the whole session'))).toBe(true);
      // The coach screen shows coach_notes, not template details (reviewer 2, finding 1).
      for (const line of json(row.details).before_every_session as string[]) expect(row.coach_notes).toContain(line);
      expect(row.coach_notes).toContain('call 911');
      // Overwatch Q5: the primer, folded into the warm-up, is in the warm-up line the coach notes carry.
      expect(row.coach_notes).toContain(`Warm-up: ${json(row.details).warm_up}`);
    }
  });

  it('have 50 non-contact items, each marked as an AI draft, each main item with all three bands, a rest, a cue and a safety line', () => {
    expect(items).toHaveLength(50);
    for (const item of items) {
      const details = json(item.details);
      expect([item.contact_level, details.draft]).toEqual(['none', MARKER]);
      if (item.block !== 'warmup' && item.block !== 'cooldown') {
        expect(Object.keys(details.amounts).sort()).toEqual([...BANDS].sort());
        for (const key of ['rest', 'cue', 'safety']) expect(typeof details[key] === 'string' && details[key].length > 0).toBe(true);
      }
    }
    // Every step names a drill: a typed step is refused at issue (OD-2026-09-18-001).
    expect(items.filter((item) => item.drill_id === '')).toEqual([]);
    // Overwatch Q5: the five primers that name no drill are folded into the warm-up; Day 4's, which names one, stays a step.
    expect(items.filter((item) => item.free_text_drill.startsWith('Session primer')).map((item) => item.drill_id)).toEqual(['drl_25e4934a3ab2ab']);
    expect(items.filter((item) => json(item.details).primer).length).toBe(5);
    // The typed steps link the lane HW drills; the two partial matches still name their related library drill (bands or weights), unlinked.
    for (const [title, drillId] of Object.entries(HW_DRILLS)) expect(items.filter((item) => item.free_text_drill === title).map((item) => item.drill_id)).toEqual([drillId]);
    expect(items.filter((item) => json(item.details).related_drill).map((item) => [item.drill_id, json(item.details).related_drill]))
      .toEqual([[HW_DRILLS['Floor Y and T raises (on the towel)'], 'drl_d0d14430bb0ddb'], [HW_DRILLS['Towel squeeze and wring'], 'drl_179419bceeab59']]);
  });

  it('name only drills the committed library holds', () => {
    const named = items.flatMap((item) => {
      const details = json(item.details);
      return [item.drill_id, ...(details.also_drills ?? []), details.alternate_drill?.drill_id, details.related_drill].filter(Boolean) as string[];
    });
    expect(named.filter((id) => !drills.has(id))).toEqual([]);
    expect(new Set(named).size).toBe(43);
  });

  it('are what the track lists for days 1 to 6, and every template the track names is a committed template', () => {
    const details = json(track.details);
    expect(details.groups.slice(1, 7).map((group: Json) => [group.order, group.session_refs.map((ref: Json) => ref.template_id)]))
      .toEqual(homeIds.map((id, index) => [index + 2, [id]]));
    expect(details.session_refs.slice(1, 7).map((ref: Json) => ref.template_id)).toEqual(homeIds);
    const committed = new Set(templates.map((row) => row.template_id));
    const named = [...new Set(Object.values(track).join(' ').match(/\bwtp_[0-9a-f]{14}\b/g) ?? [])];
    expect(named.filter((id) => !committed.has(id))).toEqual([]);
    expect(track.stage_keys).toBe('Y1|Y2|Y3|Y4|Y5|T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1|EX1');
    for (const field of ['groups', 'session_refs']) expect(json(track.field_labels)[field].draft).toBe(`entries 2-7: ${MARKER}`);
  });

  // A-112: report the 17 linked drills whose stage tags omit youth stages, and change no tags.
  it('leave the stage tags of the 17 linked drills that omit youth stages exactly as they were', () => {
    const FT1 = 'T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1';
    const NO_FT1 = 'T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1';
    const expected: Record<string, string> = {
      drl_0f284bce7c9171: NO_FT1, drl_2d3741d101a571: NO_FT1, drl_39ec154e04cb95: FT1, drl_5ff7db8ae359c1: NO_FT1,
      drl_6bd0ad1ffb7a50: NO_FT1, drl_7288d58dc1ed47: NO_FT1, drl_83057d7afff22a: FT1, drl_85a93f6757497a: FT1,
      drl_8ca8814b596907: FT1, drl_bbf178262859b4: 'Y1|Y2', drl_bf062f758ca6d2: NO_FT1, drl_c933404c933b35: NO_FT1,
      drl_d0d14430bb0ddb: NO_FT1, drl_d75b4c493c3c82: FT1, drl_eaf0e3cba383bf: NO_FT1, drl_f0156a0b5388f7: NO_FT1,
      drl_f5d68d0b9b4be7: NO_FT1,
    };
    const named = new Set(items.flatMap((item) => {
      const details = json(item.details);
      return [item.drill_id, ...(details.also_drills ?? []), details.alternate_drill?.drill_id, details.related_drill].filter(Boolean) as string[];
    }));
    const omitting = [...named].filter((id) => {
      const keys = drills.get(id)?.stage_keys.split('|').filter(Boolean) ?? [];
      return keys.length > 0 && ['Y1', 'Y2', 'Y3', 'Y4', 'Y5'].some((stage) => !keys.includes(stage));
    }).sort();
    expect(omitting).toEqual(Object.keys(expected).sort());
    for (const id of omitting) expect({ id, stage_keys: drills.get(id)?.stage_keys }).toEqual({ id, stage_keys: expected[id] });
  });

  // Overwatch GO (Q4 A, Q6): all six issue. Issuing runs adoptionReadiness on every step's drill with the
  // floor test taken as met (workoutTemplates.ts planTemplateIssue), so every linked drill must pass it.
  it('link only drills that pass adoption readiness from the seed files, so all six can be issued', () => {
    const library = rows(DRILLS);
    const scales = rows(SCALES);
    const stops = rows(STOPS);
    const cues = rows(CUES);
    const truthy = (value: string) => value.trim().toLowerCase() === 'true';
    const verdicts = [...new Set(items.map((item) => item.drill_id))].map((id) => {
      const drill = library.find((row) => (row.lineage_id || row.drill_id) === id && row.superseded_at === '') as Row;
      const readiness = adoptionReadiness({
        active: truthy(drill.active || 'true'), superseded_at: drill.superseded_at || null, name: drill.name, purpose: drill.purpose,
        discipline: drill.discipline, category: drill.category, difficulty: drill.difficulty, standard_setup: drill.standard_setup,
        execution: drill.execution, what_good_looks_like: drill.what_good_looks_like,
        scale_levels: scales.filter((row) => row.drill_id === id).map((row) => ({ scale_level: row.scale_level, is_starting_point: truthy(row.is_starting_point) })),
        stop_rules: stops.filter((row) => row.drill_id === id),
        cues: cues.filter((row) => row.drill_id === id).map((row) => ({ cue_text: row.cue_text })),
        field_provenance: drill.field_provenance,
        floor_tested_by_this_gym: true,
      });
      return { id, missing: readiness.missing };
    });
    expect(verdicts.length).toBe(39);
    expect(verdicts.filter((verdict) => verdict.missing.length > 0)).toEqual([]);
  });

  it('write the six drills as non-contact AI drafts: every field labelled, the scale rows marked for coach review', () => {
    const scales = rows(SCALES);
    const stops = rows(STOPS);
    const stopRule = json(home[0].details).stop_rule as string;
    for (const drillId of Object.values(HW_DRILLS)) {
      const drill = drills.get(drillId) as Row;
      expect([drill.contact_level, drill.requires_coach_authorization, drill.discipline, drill.difficulty, drill.stage_keys]).toEqual(['none', 'false', 'conditioning', 'beginner', '']);
      const labels = json(drill.field_labels);
      for (const field of ['name', 'category', 'target_behavior', 'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'cues', 'stop_rules', 'scale_levels']) {
        expect({ drillId, field, status: labels[field]?.status, draft: labels[field]?.draft }).toEqual({ drillId, field, status: 'INFERRED', draft: MARKER });
      }
      for (const level of ['A', 'B', 'C']) expect(labels.scale_levels[level]?.draft).toBe(MARKER);
      expect(scales.filter((row) => row.drill_id === drillId).map((row) => [row.scale_level, row.authoring_state])).toEqual([
        ['A', 'scaffold_needs_coach_review'], ['B', 'scaffold_needs_coach_review'], ['C', 'scaffold_needs_coach_review'],
      ]);
      // Every one carries the draft's home stop rule word for word.
      expect(stops.some((row) => row.drill_id === drillId && row.condition_text === stopRule[0].toUpperCase() + stopRule.slice(1))).toBe(true);
    }
  });

  it("give Shadow With an Imagined Opponent the draft's Day 1 cue, labelled as an AI draft, and nothing else", () => {
    expect(rows(CUES).filter((row) => row.drill_id === SHADOW).map((row) => row.cue_text)).toEqual(['Picture an opponent walking at you: punch, then step off the line.']);
    const labels = json((drills.get(SHADOW) as Row).field_labels);
    expect(Object.keys(labels)).toEqual(['cues']);
    expect(labels.cues.draft).toBe(MARKER);
  });

  // An issued card carries each item's coach_note, scale level and contact level, not its details nor the
  // template's coach_notes (workoutTemplates.ts issue path; IssuedWorkoutStepNotes). Reviewer 2, round 2.
  it("put the draft's words for each step in its coach note, the one line an issued card shows, within the 1000-character edit limit", () => {
    const stopRule = json(home[0].details).stop_rule as string;
    for (const item of items) {
      const details = json(item.details);
      expect(item.coach_note.length).toBeGreaterThan(0);
      expect(item.coach_note.length).toBeLessThanOrEqual(1000);
      if (details.amounts) {
        for (const band of BANDS) expect(item.coach_note).toContain(`${band}: ${details.amounts[band]}`);
        // "no rest needed" stands alone; any other rest reads "rest <amount>".
        const rest = details.rest.startsWith('no rest') ? `· ${details.rest}` : `· rest ${details.rest}`;
        for (const line of [rest, `Cue: ${details.cue}`, `Safety: ${details.safety}`]) expect(item.coach_note).toContain(line);
        expect(item.coach_note).not.toContain('rest no rest');
      }
    }
    for (const row of home) {
      const first = items.find((item) => item.template_id === row.template_id && item.ordinal === '1') as Row;
      expect(first.coach_note).toContain(stopRule.slice(1));
      expect(first.coach_note).toContain('Under 12: an adult is at home and in the room for the whole session');
      expect(first.coach_note).toContain('12–17: tell a parent before you start');
    }
    // Day 5's one-two-then-pivot prefers the linked drill's shadow-only level A (its B and C use a bag or pads).
    expect(items.filter((item) => item.scale_level !== '').map((item) => [item.template_id, item.ordinal, item.scale_level, item.drill_id]))
      .toEqual([[homeIds[4], '5', 'A', 'drl_5ff7db8ae359c1']]);
  });
});
