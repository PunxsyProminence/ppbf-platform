/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import DrillDetail from './DrillDetail';
import { fromAthleteDrillDetail, fromCoachDrillDetail } from './drillDetailView';
import type { AthleteDrillDetail, DrillFieldDrafts, DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import { AI_DRAFT_MARK, DRAFT_NOT_CHECKED } from '@/src/lib/sessionScriptWords';

// THE STAFF AI-DRAFT MARK ON THE DRILL SCREEN (lane ED-UI PR3; OW25-57,
// OD-2026-11-19-012: coaches and admins only). Plan item 4 and Q2 = A, Q4 = A:
// the 6e mark beside each drafted field where the screen shows it, each scale
// level in its own summary, the drill's own stop-rule list as one; a labelled
// version's unchecked field says so beside it; a version with no label row
// says so once, under the header. Never on an athlete view.

const NOT_CHECKED = `(${DRAFT_NOT_CHECKED})`;

const DRILL = {
  drill_id: 'd-1',
  name: 'Jab return',
  discipline: 'boxing',
  category: 'technical',
  difficulty: 'beginner',
  skill_id: null,
  contact_level: 'none',
  requires_coach_authorization: false,
  version: 3,
  lineage_id: 'lin-1',
  supersedes_drill_id: null,
  superseded_at: null,
  active: true,
  field_provenance: 'INFERRED',
  content_class: 'COACHING CRAFT',
  source_ref: 'test',
  grounding_claim_ids: [],
  scale_levels: [
    { scale_level: 'A', is_starting_point: false, demand_description: 'Slow pace.', constraint_applied: '', contact_level: 'none', coach_watch_point: '', authoring_state: 'authored' },
    { scale_level: 'B', is_starting_point: true, demand_description: 'Full pace.', constraint_applied: '', contact_level: 'none', coach_watch_point: '', authoring_state: 'authored' },
  ],
  stop_rules: [
    { ordinal: 1, condition_text: 'Stop if dizzy.', rule_kind: 'medical', origin: 'drill' },
    { ordinal: 2, condition_text: 'Re-warm after a long rest.', rule_kind: 'warmup_decay', origin: 'drill' },
  ],
  universal_stop_rules: [],
  cues: [{ cue_family: 'jab', cue_text: 'Snap back' }],
  secondary_skills: [],
  target_behavior: 'Return the hand to the chin',
  purpose: 'Keep the jab safe.',
  standard_setup: 'Pairs on the floor, one pad each.',
  equipment_needed: 'gloves',
  execution: 'Jab. Return.',
  what_good_looks_like: 'Hand back at the chin',
  what_bad_looks_like: 'Hand drops',
  common_errors: 'Pawing the jab',
  corrections: 'Touch the chin',
  transfer: 'Every straight punch',
  exit_condition: 'Ten clean returns',
  correction_path: 'Slow it down',
};

const SHOWN = [
  'name', 'difficulty', 'discipline', 'category', 'contact_level', 'requires_coach_authorization', 'stop_rules', 'purpose',
  'standard_setup', 'equipment_needed', 'execution', 'cues', 'what_good_looks_like', 'what_bad_looks_like', 'corrections',
  'common_errors', 'exit_condition', 'correction_path', 'target_behavior', 'transfer',
] as const;

function every(state: boolean | null): DrillFieldDrafts {
  return { ...Object.fromEntries(SHOWN.map((field) => [field, state])), scale_levels: { A: state, B: state }, labelled: true } as DrillFieldDrafts;
}

function renderCoach(fieldDrafts: DrillFieldDrafts | undefined) {
  const drill = { ...DRILL, field_drafts: fieldDrafts } as unknown as DrillWithDetail;
  return render(<DrillDetail view={fromCoachDrillDetail(drill)} audience="coach" />);
}

const marks = () => screen.queryAllByText(AI_DRAFT_MARK);
const hasMark = (element: Element | null) => Boolean(element?.textContent?.includes(AI_DRAFT_MARK));
const hasNotChecked = (element: Element | null) => Boolean(element?.textContent?.includes(NOT_CHECKED));
const besideHeading = (name: string) => screen.getByRole('heading', { name }).parentElement;
const summary = (text: string) => [...document.querySelectorAll('summary')].find((element) => element.textContent?.startsWith(text)) ?? null;
const line = (label: string) => screen.getByText(label).closest('p');

test('every drafted field shows the mark where the screen shows it, and only there', () => {
  renderCoach(every(true));
  // The header: name, difficulty, discipline and category.
  expect(hasMark(besideHeading('Jab return'))).toBe(true);
  expect(hasMark(screen.getByText('beginner').closest('div')?.parentElement ?? null)).toBe(true);
  // Safety: contact, coach authorization, the drill's own stop rules (Q2 = A: one list, its kinds included).
  expect(hasMark(line('Contact:'))).toBe(true);
  expect(hasMark(line('Coach authorization:'))).toBe(true);
  expect(hasMark(screen.getByText('Stop rules'))).toBe(true);
  expect(hasMark(screen.getByText('Before contact or maximal effort'))).toBe(true);
  // Each section heading.
  for (const heading of ['What it is for', 'Setup', 'Equipment', 'How it runs', 'What good looks like', 'What to avoid', 'Exit condition', 'Coaching cues']) {
    expect(hasMark(besideHeading(heading))).toBe(true);
  }
  expect(hasMark(screen.getByText(/^Common errors/))).toBe(true);
  // The expanders: corrections and correction path, each scale level, the coaching notes.
  expect(hasMark(summary('Corrections'))).toBe(true);
  expect(hasMark(screen.getByText(/^Correction path/))).toBe(true);
  expect(hasMark(summary('Easier (A)'))).toBe(true);
  expect(hasMark(summary('Standard (B)'))).toBe(true);
  expect(hasMark(line('Target behaviour:'))).toBe(true);
  expect(hasMark(screen.getByText(/^Transfer/))).toBe(true);
  // 20 fields, the drill's own stop rules marked in both of their groups, and two scale levels.
  expect(marks()).toHaveLength(23);
});

test('the headings keep their names: the mark sits beside them, not inside', () => {
  renderCoach(every(true));
  expect(screen.getByRole('heading', { level: 2, name: 'Jab return' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: 'What good looks like' })).toBeInTheDocument();
});

test('a field that is not a draft has no mark; a labelled field nobody checked says so beside it', () => {
  renderCoach({ ...every(false), purpose: true, execution: null, scale_levels: { A: false, B: null }, labelled: true });
  expect(marks()).toHaveLength(1);
  expect(hasMark(besideHeading('What it is for'))).toBe(true);
  expect(hasMark(besideHeading('What good looks like'))).toBe(false);
  expect(hasNotChecked(besideHeading('How it runs'))).toBe(true);
  expect(hasNotChecked(summary('Standard (B)'))).toBe(true);
  expect(hasNotChecked(summary('Easier (A)'))).toBe(false);
  expect(screen.getAllByText(NOT_CHECKED)).toHaveLength(2);
});

test.each([
  ['no label row', false],
  ['a read that failed', null],
])('a version with %s says so once, under the header, and marks nothing', (_case, labelled) => {
  renderCoach({ ...every(true), labelled });
  expect(marks()).toHaveLength(0);
  const lines = screen.getAllByText(NOT_CHECKED);
  expect(lines).toHaveLength(1);
  // Directly under the header, the first thing after it.
  expect(lines[0].previousElementSibling?.tagName).toBe('HEADER');
});

test('a response with no field_drafts at all reads as not checked, never as "no drafts"', () => {
  renderCoach(undefined);
  expect(marks()).toHaveLength(0);
  expect(screen.getAllByText(NOT_CHECKED)).toHaveLength(1);
});

test('never on an athlete view: no mark and no draft words, whatever the drill holds', () => {
  const drill = { ...DRILL, field_drafts: every(true) } as unknown as DrillWithDetail;
  const { unmount } = render(<DrillDetail view={fromCoachDrillDetail(drill)} audience="athlete" />);
  expect(marks()).toHaveLength(0);
  expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument();
  unmount();
  const athlete = {
    ...DRILL,
    setup: DRILL.standard_setup,
    cues: ['Snap back'],
    scale_levels: DRILL.scale_levels,
    stop_rules: DRILL.stop_rules,
  } as unknown as AthleteDrillDetail;
  render(<DrillDetail view={fromAthleteDrillDetail(athlete)} audience="athlete" />);
  expect(marks()).toHaveLength(0);
  expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument();
});

test('the view carries every shown field, each scale level and whether the version is labelled', () => {
  const drafts = { ...every(true), scale_levels: { A: false, B: true } } as DrillFieldDrafts;
  const view = fromCoachDrillDetail({ ...DRILL, field_drafts: drafts } as unknown as DrillWithDetail);
  expect(view.coach?.fieldDrafts).toMatchObject({ cues: true, good: true, bad: true, corrections: true, labelled: true });
  expect(view.coach?.fieldDrafts.fields).toMatchObject({ name: true, transfer: true, stop_rules: true });
  expect(view.coach?.fieldDrafts.scaleLevels).toEqual({ A: false, B: true });
  const none = fromCoachDrillDetail({ ...DRILL } as unknown as DrillWithDetail);
  expect(none.coach?.fieldDrafts).toEqual({ cues: null, good: null, bad: null, corrections: null, fields: {}, scaleLevels: {}, labelled: null });
});
