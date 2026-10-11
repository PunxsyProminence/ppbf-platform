/**
 * @jest-environment jsdom
 */

// This page replaced a front-end placeholder that showed org-wide SHADOW
// projections to guardians. What it must do instead: read the linked-child
// list from the route that runs the guardian visibility gate, then read that
// child's real progression records. What it must never do: claim "no gaps"
// while requests are still in flight, or offer a guardian a way to log a
// completion (that is the athlete's or a coach's act).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { formatGymDateNumeric } from '@/src/lib/gymTime';
import ParentProgressionVisibilityPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const CHILD = { athlete_id: 'athlete-001', full_name: 'Jordan Doe' };
const SECOND_CHILD = { athlete_id: 'athlete-002', full_name: 'Riley Doe' };

const GAP = {
  gap_id: 'gap-1',
  athlete_id: 'athlete-001',
  gap_type: 'technique',
  gap_description: 'Rear foot stays flat through the cross.',
  severity: 'high',
  status: 'identified',
  created_at: '2026-07-30T12:00:00.000Z',
};

const ASSIGNMENT = {
  assignment_id: 'assign-1',
  gap_id: 'gap-1',
  drill_name: 'pivot-drill',
  drill_description: 'Pivot on the ball of the rear foot.',
  drill_display_name: 'Rear-Foot Pivot Drill',
  drill_display_description: 'Pivot on the ball of the rear foot through every cross.',
  drill_difficulty: 'beginner',
  frequency_per_week: 3,
  completion_percentage: 40,
  status: 'in_progress',
  created_at: '2026-07-31T12:00:00.000Z',
  // What the server sends a guardian (OD-2026-10-06-025 ruling 2): a name,
  // and no assigned_by_account_id.
  assigned_by_name: 'Coach J Rivera',
};

const COMPLETION = {
  completion_id: 'comp-1',
  assignment_id: 'assign-1',
  reps_completed: 20,
  notes: '',
  verification_status: 'verified',
  completed_at: '2026-08-01T12:00:00.000Z',
  verified_at: '2026-08-02T12:00:00.000Z',
};

type JsonBody = Record<string, unknown>;

function jsonOk(body: JsonBody) {
  return { ok: true, json: async () => body } as Response;
}

function mockFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, responder] of Object.entries(overrides)) {
      if (url.includes(fragment)) return responder();
    }
    if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD] });
    if (url.includes('/progression/gaps')) return jsonOk({ items: [GAP] });
    if (url.includes('/progression/assignments')) return jsonOk({ items: [ASSIGNMENT] });
    if (url.includes('/progression/completions')) return jsonOk({ items: [COMPLETION] });
    return jsonOk({ items: [] });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the linked-child list is still loading', async () => {
  global.fetch = mockFetch({
    '/athletes/list': () => new Promise<Response>(() => {}),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText(/Loading progression data/);
  expect(screen.queryByText('No progression gaps on record')).toBeNull();
  expect(screen.queryByText('No linked athletes')).toBeNull();
});

test('a guardian with no linked athlete is told so, not shown an empty progression', async () => {
  global.fetch = mockFetch({
    '/athletes/list': async () => jsonOk({ items: [] }),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('No linked athletes');
  expect(screen.queryByText('No progression gaps on record')).toBeNull();
});

test('the child with no gaps reads as coached-not-yet, only after loading settles', async () => {
  global.fetch = mockFetch({
    '/progression/gaps': async () => jsonOk({ items: [] }),
    '/progression/assignments': async () => jsonOk({ items: [] }),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('No progression gaps on record');
  await waitFor(() => expect(screen.queryByText(/Loading progression data/)).toBeNull());
});

test('a failed linked-athlete read never tells a guardian their account is not linked', async () => {
  global.fetch = mockFetch({
    '/athletes/list': async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Could not load your linked athletes');
  expect(screen.queryByText('No linked athletes')).toBeNull();
});

test('a failed progression read never says there are no gaps on record', async () => {
  global.fetch = mockFetch({
    '/progression/gaps': async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Could not load progression');
  expect(screen.queryByText('No progression gaps on record')).toBeNull();
});

test("the child's real gap, drill, and verified work render read-only", async () => {
  global.fetch = mockFetch() as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Rear foot stays flat through the cross.');
  expect(screen.getByText("Jordan Doe's Progression")).toBeTruthy();
  expect(screen.getByText('Rear-Foot Pivot Drill')).toBeTruthy();
  expect(screen.getByText('40%')).toBeTruthy();
  expect(screen.getByText('20 reps')).toBeTruthy();
  expect(screen.getByText('verified')).toBeTruthy();
  // Who assigned it, as a name (OD-2026-10-06-025 ruling 2).
  expect(screen.getByText('Assigned by')).toBeTruthy();
  expect(screen.getByText('Coach J Rivera')).toBeTruthy();

  // Read-only: no completion-logging affordance exists for a guardian.
  expect(screen.queryByRole('button', { name: /log/i })).toBeNull();
});

test('a drill with no name from the server shows no "Assigned by" line, not a blank one', async () => {
  const unnamed: Partial<typeof ASSIGNMENT> = { ...ASSIGNMENT };
  delete unnamed.assigned_by_name;
  global.fetch = mockFetch({
    '/progression/assignments': async () => jsonOk({ items: [unnamed] }),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Rear-Foot Pivot Drill');
  expect(screen.queryByText('Assigned by')).toBeNull();
});

// REQUEST ORDERING. Two children, one tap between them, and two fetch chains
// in flight at once. The header prints the name of the child currently
// SELECTED; the gaps, drills and logged work come from whichever chain wrote
// state last. Before the abort guard those could disagree, and a guardian
// would read one child's development record under their sibling's name.
describe('request ordering when the guardian switches child', () => {
  const SECOND_GAP = {
    gap_id: 'gap-2',
    athlete_id: 'athlete-002',
    gap_type: 'tactical',
    gap_description: 'Guard drops after the third round.',
    severity: 'medium',
    status: 'identified',
    created_at: '2026-08-02T12:00:00.000Z',
  };

  test("a slow answer for the child left behind never lands on the selected child's record", async () => {
    // The first child's gaps read is held open until the assertion below has
    // already seen the second child's record on screen -- that is precisely
    // the out-of-order arrival this guard exists for.
    let releaseFirstChild: () => void = () => {};
    const firstChildAnswered = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD, SECOND_CHILD] });
      if (url.includes('/progression/gaps')) {
        if (url.includes('athlete_id=athlete-001')) {
          await firstChildAnswered;
          return jsonOk({ items: [GAP] });
        }
        return jsonOk({ items: [SECOND_GAP] });
      }
      return jsonOk({ items: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ParentProgressionVisibilityPage />);

    // Wait until the first child's read is genuinely in flight before switching.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('athlete_id=athlete-001')),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));
    await screen.findByText('Guard drops after the third round.');

    // Now the first child's answer arrives -- last, and for the wrong child.
    await act(async () => {
      releaseFirstChild();
    });

    expect(screen.queryByText('Rear foot stays flat through the cross.')).toBeNull();
    expect(screen.getByText('Guard drops after the third round.')).toBeTruthy();
    expect(screen.getByText("Riley Doe's Progression")).toBeTruthy();
  });

  test('the superseded chain does not settle the page while the selected child is still loading', async () => {
    // Both chains in flight, and the FIRST one answers first. Its finally
    // block clearing progressionLoading is its own kind of wrong answer: this
    // page renders content -- or "No progression gaps on record" -- the moment
    // loading goes false, so a superseded chain settling the page presents the
    // child left behind, or a claim that the selected child has nothing, as a
    // finished read.
    let releaseFirstChild: () => void = () => {};
    let releaseSecondChild: () => void = () => {};
    const firstChildAnswered = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    const secondChildAnswered = new Promise<void>((resolve) => {
      releaseSecondChild = resolve;
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD, SECOND_CHILD] });
      if (url.includes('/progression/gaps')) {
        if (url.includes('athlete_id=athlete-002')) {
          await secondChildAnswered;
          return jsonOk({ items: [SECOND_GAP] });
        }
        await firstChildAnswered;
        return jsonOk({ items: [GAP] });
      }
      return jsonOk({ items: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ParentProgressionVisibilityPage />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('athlete_id=athlete-001')),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('athlete_id=athlete-002')),
      ).toBe(true),
    );

    await act(async () => {
      releaseFirstChild();
    });

    expect(screen.queryByText('Rear foot stays flat through the cross.')).toBeNull();
    expect(screen.queryByText('No progression gaps on record')).toBeNull();
    expect(screen.getByText(/Loading progression data/)).toBeTruthy();

    await act(async () => {
      releaseSecondChild();
    });

    await screen.findByText('Guard drops after the third round.');
  });
});

test('switching children refetches progression for the selected athlete only', async () => {
  const fetchMock = mockFetch({
    '/athletes/list': async () => jsonOk({ items: [CHILD, SECOND_CHILD] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Rear foot stays flat through the cross.');

  fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));

  await waitFor(() => {
    const gapCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/progression/gaps'));
    expect(gapCalls[gapCalls.length - 1]).toContain('athlete_id=athlete-002');
  });
});

// AN ISSUED WORKOUT KEEPS ITS SHAPE FOR THE GUARDIAN TOO (lane P7c). The
// guardian reads what their child reads: the workout as one panel, its steps
// in the coach's order, each with its block, its scale level when the coach
// set one, its contact level as written and the note. Read-only, and nothing
// is said about a contact level beyond the level itself.
describe("an issued workout keeps its shape on the guardian's page", () => {
  const drill = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
    ...ASSIGNMENT,
    assignment_id: id,
    drill_name: name.toLowerCase(),
    drill_display_name: name,
    drill_display_description: `How ${name} is done.`,
    completion_percentage: 0,
    status: 'assigned',
    ...overrides,
  });

  // The server's order, which is not the workout's: a drill in no workout
  // first, and another BETWEEN two of the workout's steps.
  const WORK = [
    drill('as-loose', 'Shadowbox'),
    drill('as-w3', 'Body Sparring'),
    drill('as-w1', 'Skip Rope', { status: 'completed', completion_percentage: 100 }),
    drill('as-late', 'Heavy Bag'),
    drill('as-w2', 'Jab Ladder', { status: 'in_progress', completion_percentage: 50 }),
  ];

  // The ordinals are the coach's and have gaps; the steps arrive out of order.
  const WORKOUT = {
    issue_id: 'issue-1',
    athlete_id: 'athlete-001',
    template_name: 'Technical Tuesday',
    template_version: 2,
    issued_at: '2026-10-11T15:00:00.000Z',
    issued_by_name: 'Coach J Rivera',
    steps: [
      { ordinal: 7, block: 'main_work', scale_level: 'C', contact_level: 'controlled_sparring', coach_note: 'Two rounds.\nCoach watching.', assignment_id: 'as-w3' },
      { ordinal: 2, block: 'warmup', scale_level: 'A', contact_level: 'none', coach_note: 'Easy pace.', assignment_id: 'as-w1' },
      { ordinal: 5, block: 'main_work', scale_level: null, contact_level: 'light_technical', coach_note: null, assignment_id: 'as-w2' },
    ],
  };

  function open(work: unknown[], workouts: unknown, completions: Array<{ assignment_id: string }> = []) {
    const answer: JsonBody = workouts === undefined ? { items: work } : { items: work, workouts };
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD] });
      if (url.includes('/progression/gaps')) return jsonOk({ items: [GAP] });
      if (url.includes('/progression/assignments')) return jsonOk(answer);
      // As the route answers: only the completions of the assignment asked about.
      const asked = new URL(url, 'http://localhost').searchParams.get('assignment_id');
      return jsonOk({ items: completions.filter((completion) => completion.assignment_id === asked) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ParentProgressionVisibilityPage />);
    return fetchMock;
  }

  /** The "Drill Assignments" section, once the record is on screen. */
  async function drillSection(): Promise<HTMLElement> {
    const heading = await screen.findByRole('heading', { name: 'Drill Assignments' });
    return heading.closest('section') as HTMLElement;
  }

  /** Every heading under "Drill Assignments", in document order, as "level: text". */
  const headings = (within_: HTMLElement) =>
    within(within_).getAllByRole('heading').map((heading) => `${heading.tagName.toLowerCase()}: ${heading.textContent}`);

  /** One step of the workout, found from its drill's heading. */
  const stepOf = (panel: HTMLElement, title: string) =>
    within(panel).getByRole('heading', { name: title }).closest('[data-testid="issued-workout-step"]') as HTMLElement;

  test('the workout is one panel where the first of its drills stood: steps in the coach order, a block name wherever the block changes, other drills outside it', async () => {
    open(WORK, [WORKOUT]);
    const section = await drillSection();
    const panel = within(section).getByTestId('issued-workout');

    expect(headings(section)).toEqual([
      'h2: Drill Assignments',
      // The server listed this drill first; it stays first.
      'h3: Shadowbox',
      'h3: Technical Tuesday',
      'h4: warmup',
      'h5: Skip Rope',
      'h4: main work',
      'h5: Jab Ladder',
      'h5: Body Sparring',
      // The drill the server listed between two steps is not pulled into the workout: it follows it.
      'h3: Heavy Bag',
    ]);
    // Inside the panel: its name, both block names and the three steps -- only those.
    expect(headings(panel)).toEqual(['h3: Technical Tuesday', 'h4: warmup', 'h5: Skip Rope', 'h4: main work', 'h5: Jab Ladder', 'h5: Body Sparring']);
    expect(within(panel).getAllByTestId('issued-workout-step')).toHaveLength(3);
    // Five drills, five records: none drawn twice, none dropped.
    expect(within(section).getAllByText('Completion')).toHaveLength(5);
    expect(within(section).getAllByTestId('issued-workout')).toHaveLength(1);
  });

  test('the panel says who issued it, when, and how many steps, in the page own date form', async () => {
    open(WORK, [WORKOUT]);
    const panel = within(await drillSection()).getByTestId('issued-workout');

    expect(within(panel).getByText('Workout')).toBeTruthy();
    expect(within(panel).getByText(`From: Coach J Rivera · ${formatGymDateNumeric(WORKOUT.issued_at)} · 3 steps, in this order`)).toBeTruthy();
  });

  test('a workout with no coach name says no "From"; one step reads "1 step"', async () => {
    const nameless: Partial<typeof WORKOUT> = { ...WORKOUT, steps: [WORKOUT.steps[1]] };
    delete nameless.issued_by_name;
    open(WORK, [nameless]);
    const panel = within(await drillSection()).getByTestId('issued-workout');

    expect(within(panel).getByText(`${formatGymDateNumeric(WORKOUT.issued_at)} · 1 step, in this order`)).toBeTruthy();
    expect(panel.textContent).not.toContain('From:');
  });

  test('each step says its number, then exactly: the scale level when the coach set one, the contact level as written, and the note', async () => {
    open(WORK, [WORKOUT]);
    const section = await drillSection();
    const panel = within(section).getByTestId('issued-workout');
    const lines = (title: string) => within(stepOf(panel, title)).getByTestId('step-notes').textContent;

    expect(within(stepOf(panel, 'Skip Rope')).getByText('Step 2')).toBeTruthy();
    expect(lines('Skip Rope')).toBe('Scale: Easier (A)Contact: No contactNote: Easy pace.');
    // A level the coach left open is not shown and nothing stands in for it.
    expect(within(stepOf(panel, 'Jab Ladder')).getByText('Step 5')).toBeTruthy();
    expect(lines('Jab Ladder')).toBe('Contact: Light technical contact');
    expect(within(stepOf(panel, 'Body Sparring')).getByText('Step 7')).toBeTruthy();
    expect(lines('Body Sparring')).toBe('Scale: Harder (C)Contact: Controlled sparringNote: Two rounds.\nCoach watching.');
    // A drill that is a step of no workout carries no step lines at all.
    expect(within(section).getAllByTestId('step-notes')).toHaveLength(3);
    const loose = within(section).getByRole('heading', { name: 'Shadowbox' }).closest('article') as HTMLElement;
    expect(loose.textContent).not.toMatch(/Step \d/);
    expect(within(loose).queryByTestId('step-notes')).toBeNull();
  });

  test('the contact level is shown and nothing is said about it: a sparring step is drawn as a no-contact step is', async () => {
    open(WORK, [WORKOUT]);
    const section = await drillSection();
    const panel = within(section).getByTestId('issued-workout');
    const sparring = stepOf(panel, 'Body Sparring');

    expect(within(section).queryByRole('alert')).toBeNull();
    expect(sparring.querySelector('.alert, [title]')).toBeNull();
    // Its whole text: its step, its name and description, its status, the three lines, its record.
    expect(sparring.textContent).toBe(
      'Step 7Body SparringHow Body Sparring is done.◉assignedScale: Harder (C)Contact: Controlled sparringNote: Two rounds.\nCoach watching.Completion0%Per week3xAssigned byCoach J Rivera',
    );
    // The same classes, element for element, as a step with no contact (only the status badge may differ).
    const shape = (step: HTMLElement) =>
      Array.from(step.querySelectorAll('*'))
        .filter((element) => !element.closest('.badge'))
        .map((element) => `${element.tagName}.${element.className}`);
    const noContact = stepOf(panel, 'Skip Rope');
    expect(shape(sparring)).toEqual(shape(noContact));
  });

  test('a step is still the record it always was: its status, its completion and its logged work; and the page stays read-only', async () => {
    open(WORK, [WORKOUT], [{ ...COMPLETION, assignment_id: 'as-w2', completion_id: 'comp-w2', reps_completed: 12 }]);
    const section = await drillSection();
    const panel = within(section).getByTestId('issued-workout');
    const ladder = stepOf(panel, 'Jab Ladder');

    await within(ladder).findByText('12 reps');
    expect(within(ladder).getByText('50%')).toBeTruthy();
    expect(within(ladder).getByText('in progress')).toBeTruthy();
    expect(within(stepOf(panel, 'Skip Rope')).getByText('100%')).toBeTruthy();
    // The logged work is under its own step and nowhere else.
    expect(within(section).getAllByText('12 reps')).toHaveLength(1);
    expect(within(section).queryByRole('button')).toBeNull();
    expect(within(section).queryByRole('link')).toBeNull();
  });

  const NO_WORKOUTS: Array<[string, unknown]> = [
    ['an empty workouts list', []],
    ['no workouts key at all (an older server)', undefined],
  ];

  test.each(NO_WORKOUTS)('with %s the drills are drawn as they always were, in the order the API returned', async (_label, workouts) => {
    open(WORK, workouts);
    const section = await drillSection();

    expect(headings(section)).toEqual(['h2: Drill Assignments', 'h3: Shadowbox', 'h3: Body Sparring', 'h3: Skip Rope', 'h3: Heavy Bag', 'h3: Jab Ladder']);
    expect(screen.queryByTestId('issued-workout')).toBeNull();
    expect(screen.queryByTestId('step-notes')).toBeNull();
    expect(screen.queryByText('Could not load progression')).toBeNull();
  });

  const UNREADABLE: Array<[string, unknown]> = [
    ['not a list', { issue_id: 'issue-1' }],
    ['a workout with no name', [{ ...WORKOUT, template_name: null }]],
    ['a step with no block', [{ ...WORKOUT, steps: [{ ...WORKOUT.steps[0], block: undefined }] }]],
    ['a step whose contact level is missing', [{ ...WORKOUT, steps: [{ ...WORKOUT.steps[0], contact_level: null }] }]],
    ['a workout with no date', [{ ...WORKOUT, issued_at: null }]],
    ['a workout whose date is not a date', [{ ...WORKOUT, issued_at: 'last Tuesday-ish' }]],
    ['a workout whose date is a number', [{ ...WORKOUT, issued_at: 5 }]],
    ['a coach name that is not text', [{ ...WORKOUT, issued_by_name: 5 }]],
  ];

  test.each(UNREADABLE)('workouts the page cannot read (%s) are a failed read of the record, never the steps drawn loose or "nothing on record"', async (_label, workouts) => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    open(WORK, workouts);

    await screen.findByText('Could not load progression');
    // Said in this page's own words; what the reader refused goes to the log.
    expect(screen.getByRole('alert').textContent).toContain('Failed to load progression data.');
    expect(document.body.textContent).not.toContain('beside the assignments');
    expect(logged.mock.calls).toEqual([[{ event: 'parent-progression-workouts-unreadable', error: expect.objectContaining({ name: 'IssuedWorkoutsUnreadableError' }) }]]);
    expect(screen.queryByText('Skip Rope')).toBeNull();
    expect(screen.queryByText('Shadowbox')).toBeNull();
    expect(screen.queryByText('Rear foot stays flat through the cross.')).toBeNull();
    expect(screen.queryByText('No progression gaps on record')).toBeNull();
    expect(screen.queryByText('No drills assigned yet')).toBeNull();
  });

  test("one child's workout is never drawn under the other child: switching redraws from the selected child's own answer", async () => {
    const siblingDrill = drill('as-sib', 'Footwork Ladder');
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD, SECOND_CHILD] });
      if (url.includes('/progression/gaps')) return jsonOk({ items: [GAP] });
      if (url.includes('/progression/assignments')) {
        return url.includes('athlete_id=athlete-001')
          ? jsonOk({ items: WORK, workouts: [WORKOUT] })
          : jsonOk({ items: [siblingDrill], workouts: [] });
      }
      return jsonOk({ items: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ParentProgressionVisibilityPage />);
    await screen.findByTestId('issued-workout');

    fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));

    await screen.findByRole('heading', { name: 'Footwork Ladder' });
    expect(screen.getByText("Riley Doe's Progression")).toBeTruthy();
    expect(screen.queryByTestId('issued-workout')).toBeNull();
    expect(screen.queryByText('Technical Tuesday')).toBeNull();
    expect(screen.queryByTestId('step-notes')).toBeNull();
  });
});
