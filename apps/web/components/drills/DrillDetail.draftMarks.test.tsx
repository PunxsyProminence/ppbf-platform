/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import DrillDetail from './DrillDetail';
import { fromAthleteDrillDetail, fromCoachDrillDetail } from './drillDetailView';
import type { AthleteDrillDetail, DrillFieldDrafts, DrillMarkedField, DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
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
  return { ...Object.fromEntries(SHOWN.map((field) => [field, state])), scale_levels: { A: state, B: state }, labelled: true } as unknown as DrillFieldDrafts;
}

function renderCoach(fieldDrafts: DrillFieldDrafts | undefined, overrides: Record<string, unknown> = {}) {
  const drill = { ...DRILL, ...overrides, field_drafts: fieldDrafts } as unknown as DrillWithDetail;
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
  // The readiness group: the drill's own rule carries the mark, not the group's heading.
  expect(hasMark(screen.getByText('Re-warm after a long rest.').closest('li'))).toBe(true);
  expect(hasMark(screen.getByText('Before contact or maximal effort'))).toBe(false);
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

// One field drafted, every other field not: its mark is the only one, at its own place.
const PLACE: Record<(typeof SHOWN)[number], (mark: Element) => boolean> = {
  name: (mark) => Boolean(besideHeading('Jab return')?.contains(mark)),
  difficulty: (mark) => Boolean(screen.getByText('beginner').closest('.plaque')?.parentElement?.contains(mark)),
  discipline: (mark) => mark.previousSibling?.textContent === 'boxing',
  category: (mark) => mark.previousSibling?.textContent === 'technical',
  contact_level: (mark) => Boolean(line('Contact:')?.contains(mark)),
  requires_coach_authorization: (mark) => Boolean(line('Coach authorization:')?.contains(mark)),
  stop_rules: (mark) => screen.getByText('Stop rules').contains(mark) || Boolean(screen.getByText('Re-warm after a long rest.').closest('li')?.contains(mark)),
  purpose: (mark) => Boolean(besideHeading('What it is for')?.contains(mark)),
  standard_setup: (mark) => Boolean(besideHeading('Setup')?.contains(mark)),
  equipment_needed: (mark) => Boolean(besideHeading('Equipment')?.contains(mark)),
  execution: (mark) => Boolean(besideHeading('How it runs')?.contains(mark)),
  cues: (mark) => Boolean(besideHeading('Coaching cues')?.contains(mark)),
  what_good_looks_like: (mark) => Boolean(besideHeading('What good looks like')?.contains(mark)),
  what_bad_looks_like: (mark) => Boolean(besideHeading('What to avoid')?.contains(mark)),
  corrections: (mark) => Boolean(summary('Corrections')?.contains(mark)),
  common_errors: (mark) => screen.getByText(/^Common errors/).contains(mark),
  exit_condition: (mark) => Boolean(besideHeading('Exit condition')?.contains(mark)),
  correction_path: (mark) => screen.getByText(/^Correction path/).contains(mark),
  target_behavior: (mark) => Boolean(line('Target behaviour:')?.contains(mark)),
  transfer: (mark) => screen.getByText(/^Transfer/).contains(mark),
};

test.each(SHOWN)('only %s drafted: its mark alone, at its own place', (key) => {
  renderCoach({ ...every(false), [key]: true });
  const found = screen.getAllByText(AI_DRAFT_MARK);
  // The drill's own stop rules show in two groups here (Stop rules, and its readiness rule).
  expect(found).toHaveLength(key === 'stop_rules' ? 2 : 1);
  for (const mark of found) expect(PLACE[key](mark)).toBe(true);
});

test.each(['A', 'B'])('only scale level %s drafted: its mark alone, in its own summary', (level) => {
  renderCoach({ ...every(false), scale_levels: { A: false, B: false, [level]: true } });
  expect(marks()).toHaveLength(1);
  expect(hasMark(summary(level === 'A' ? 'Easier (A)' : 'Standard (B)'))).toBe(true);
});

test('a readiness list holding a gym rule: only the drill\'s own rule carries the mark', () => {
  renderCoach({ ...every(false), stop_rules: true }, {
    universal_stop_rules: [{ ordinal: 1, condition_text: 'Re-warm after twenty idle minutes.', rule_kind: 'warmup_decay', origin: 'universal' }],
  });
  expect(hasMark(screen.getByText('Re-warm after a long rest.').closest('li'))).toBe(true);
  expect(hasMark(screen.getByText('Re-warm after twenty idle minutes.').closest('li'))).toBe(false);
  expect(marks()).toHaveLength(2);
});

test.each([
  // [what the drill holds, the field whose words Equipment shows]
  ['equipment written, setup shown', { equipment_needed: 'gloves' }, 'equipment_needed'],
  ['equipment blank, setup "none" (shown as equipment)', { equipment_needed: '', standard_setup: 'none' }, 'standard_setup'],
  ['equipment blank, setup written (shown as Setup)', { equipment_needed: '' }, 'equipment_needed'],
  ['both blank', { equipment_needed: '', standard_setup: '' }, 'equipment_needed'],
] as const)('Equipment carries the mark of the column it shows: %s', (_case, overrides, shown) => {
  const other: DrillMarkedField = shown === 'equipment_needed' ? 'standard_setup' : 'equipment_needed';
  const { unmount } = renderCoach({ ...every(false), [shown]: true }, overrides);
  expect(hasMark(besideHeading('Equipment'))).toBe(true);
  unmount();
  renderCoach({ ...every(false), [other]: true }, overrides);
  expect(hasMark(besideHeading('Equipment'))).toBe(false);
});

test('"not checked" in the header keeps a light ink; elsewhere it takes the card\'s', () => {
  renderCoach({ ...every(false), name: null, purpose: null });
  const inHeader = besideHeading('Jab return')?.querySelector('span');
  expect(inHeader).toHaveTextContent(NOT_CHECKED);
  expect(inHeader).toHaveStyle({ color: 'var(--bone-200)' });
  const inBody = besideHeading('What it is for')?.querySelector('span');
  expect(inBody).toHaveTextContent(NOT_CHECKED);
  expect(inBody?.getAttribute('style')).toBeNull();
  expect(inBody?.className).toContain('in-[.ge-drillcase]:text-[color:#3A2E1D]');
  // Off the parchment (the console's lit card), the lift.
  expect(inBody?.className).toContain('text-[color:var(--bone-200)]');
});

// The live console's "View instructions" (a kiosk surface): beside a heading the words take the body's size, not
// the article's; in a label line, the body face, not the label's.
test('"not checked" has the body text\'s size, kiosk rise and face wherever it sits', () => {
  renderCoach({ ...every(false), name: null, purpose: null, transfer: null });
  for (const span of screen.getAllByText(NOT_CHECKED)) {
    expect(span.className).toContain('text-[length:var(--t-sm)]');
    expect(span.className).toContain('in-data-[surface=kiosk]:text-[length:var(--t-md)]');
    expect(span.className).toContain('font-[family-name:var(--font-body)]');
  }
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

// "LOOKS RIGHT" (OD-2026-11-19-007, OW25-55; lane ED-UI PR4, Q2 = A, Q3 = A, Q7 = A): beside each drafted
// field the edit form can change, when the page offers it; one press per scale level, one for the
// drill's own stop rules; inside an expander, never in its summary.
describe('"Looks right" beside a drafted field', () => {
  const press = (name: string) => screen.queryByRole('button', { name: `Looks right: ${name}` });
  const presses = () => screen.queryAllByRole('button', { name: /^Looks right: / });
  function renderWith(fieldDrafts: DrillFieldDrafts, onPress = jest.fn(), overrides: Record<string, unknown> = {}, disabled = false) {
    const drill = { ...DRILL, ...overrides, field_drafts: fieldDrafts } as unknown as DrillWithDetail;
    render(<DrillDetail view={fromCoachDrillDetail(drill)} audience="coach" looksRight={{ onPress, disabled }} />);
    return onPress;
  }

  test('every drafted field the form can change has one press, named for the field; discipline has none (Q3 = A)', () => {
    renderWith(every(true));
    for (const name of [
      'Name', 'Difficulty', 'Category', 'Contact', 'Coach authorization', 'Stop rules', 'What it is for', 'Setup', 'Equipment',
      'How it runs', 'Coaching cues', 'What good looks like', 'What to avoid', 'Corrections', 'Common errors', 'Exit condition',
      'Correction path', 'Target behaviour', 'Transfer', 'Easier (A)', 'Standard (B)',
    ]) expect(press(name)).toHaveTextContent(/^Looks right$/);
    expect(press('Discipline')).toBeNull();
    // 19 fields (all 20 shown but discipline) and two scale levels; the stop rules once, not per group.
    expect(presses()).toHaveLength(21);
  });

  test('each press names its field, and a scale level by its key', () => {
    const onPress = renderWith(every(true));
    fireEvent.click(press('What it is for')!);
    fireEvent.click(press('Standard (B)')!);
    fireEvent.click(press('Stop rules')!);
    fireEvent.click(press('Equipment')!);
    expect(onPress.mock.calls.map(([target]) => target)).toEqual(['purpose', 'scale_levels.B', 'stop_rules', 'equipment_needed']);
  });

  test('no press beside a field that is not a draft, or not checked, or on a version with no label row', () => {
    renderWith({ ...every(false), purpose: null, execution: true, scale_levels: { A: false, B: null }, labelled: true });
    expect(presses().map((button) => button.getAttribute('aria-label'))).toEqual(['Looks right: How it runs']);
    cleanup();
    renderWith({ ...every(true), labelled: false });
    expect(presses()).toHaveLength(0);
  });

  test('never in an expander\'s summary: the press for Corrections and for a level sits inside', () => {
    renderWith(every(true));
    for (const name of ['Corrections', 'Easier (A)', 'Standard (B)']) {
      expect(press(name)!.closest('summary')).toBeNull();
      expect(press(name)!.closest('details')).not.toBeNull();
    }
  });

  test('with no "Stop rules" group, the list\'s one press sits with its first readiness rule', () => {
    renderWith(every(true), jest.fn(), {
      stop_rules: [{ ordinal: 1, condition_text: 'Re-warm after a long rest.', rule_kind: 'warmup_decay', origin: 'drill' }],
    });
    expect(press('Stop rules')!.closest('li')).toHaveTextContent('Re-warm after a long rest.');
    expect(presses().filter((button) => button.getAttribute('aria-label') === 'Looks right: Stop rules')).toHaveLength(1);
  });

  test('a page that does not offer it (the live console) shows the marks and no press; nor does an athlete view', () => {
    render(<DrillDetail view={fromCoachDrillDetail({ ...DRILL, field_drafts: every(true) } as unknown as DrillWithDetail)} audience="coach" />);
    expect(marks().length).toBeGreaterThan(0);
    expect(presses()).toHaveLength(0);
    cleanup();
    render(<DrillDetail view={fromCoachDrillDetail({ ...DRILL, field_drafts: every(true) } as unknown as DrillWithDetail)} audience="athlete" looksRight={{ onPress: jest.fn() }} />);
    expect(presses()).toHaveLength(0);
  });

  test('discipline and category each keep their own mark and press together, so a wrapped press stays with its field', () => {
    renderWith(every(true));
    const categoryGroup = press('Category')!.parentElement!;
    expect(categoryGroup.textContent?.startsWith('technical')).toBe(true);
    expect(categoryGroup.textContent).not.toContain('boxing');
    expect(screen.getByText('boxing').closest('span')).not.toContainElement(press('Category'));
  });

  test('a busy page disables every press', () => {
    renderWith(every(true), jest.fn(), {}, true);
    for (const button of presses()) expect(button).toBeDisabled();
  });
});
