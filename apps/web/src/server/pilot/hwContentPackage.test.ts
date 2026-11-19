import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
const TRACK_ID = 'trk_55480ac4429113';
const MARKER = 'AI draft, lane HW, 2026-11-19 (OD-2026-11-19-005; OD-2026-11-15-011)';
const BANDS = ['U12', '12–17', 'Adult'];
const DRAFTED = ['name', 'session_type', 'difficulty', 'age_band', 'duration_minutes', 'intent', 'details', 'items'];

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

  it('carry the same stop rule and the under-12 adult-in-the-room line in all six', () => {
    const stopRules = new Set(home.map((row) => json(row.details).stop_rule));
    expect(stopRules.size).toBe(1);
    expect([...stopRules][0]).toContain('call 911');
    for (const row of home) {
      expect((json(row.details).before_every_session as string[]).some((line) => line.startsWith('Under 12: an adult is at home and in the room for the whole session'))).toBe(true);
    }
  });

  it('have 55 non-contact items, each marked as an AI draft, each main item with all three bands, a rest, a cue and a safety line', () => {
    expect(items).toHaveLength(55);
    for (const item of items) {
      const details = json(item.details);
      expect([item.contact_level, details.draft]).toEqual(['none', MARKER]);
      if (item.block !== 'warmup' && item.block !== 'cooldown') {
        expect(Object.keys(details.amounts).sort()).toEqual([...BANDS].sort());
        for (const key of ['rest', 'cue', 'safety']) expect(typeof details[key] === 'string' && details[key].length > 0).toBe(true);
      }
    }
    expect(items.filter((item) => item.drill_id === '').map((item) => item.free_text_drill).filter((text) => !text.startsWith('Session primer')))
      .toEqual(['Forearm plank', 'Reverse lunge', 'Glute bridge', 'Wall calf raise']);
  });

  it('name only drills the committed library holds', () => {
    const named = items.flatMap((item) => {
      const details = json(item.details);
      return [item.drill_id, ...(details.also_drills ?? []), details.alternate_drill?.drill_id].filter(Boolean) as string[];
    });
    expect(named.filter((id) => !drills.has(id))).toEqual([]);
    expect(new Set(named).size).toBe(37);
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
      return [item.drill_id, ...(details.also_drills ?? []), details.alternate_drill?.drill_id].filter(Boolean) as string[];
    }));
    const omitting = [...named].filter((id) => {
      const keys = drills.get(id)?.stage_keys.split('|').filter(Boolean) ?? [];
      return keys.length > 0 && ['Y1', 'Y2', 'Y3', 'Y4', 'Y5'].some((stage) => !keys.includes(stage));
    }).sort();
    expect(omitting).toEqual(Object.keys(expected).sort());
    for (const id of omitting) expect({ id, stage_keys: drills.get(id)?.stage_keys }).toEqual({ id, stage_keys: expected[id] });
  });
});
