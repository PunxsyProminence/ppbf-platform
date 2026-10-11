import {
  IssuedWorkoutsUnreadableError,
  orderAssignedWork,
  readIssuedWorkouts,
  type IssuedWorkoutStepView,
  type IssuedWorkoutView,
} from './issuedWorkouts';

// The reader and the ordering every assigned-work screen shares (lane P7c).
// The screens' own suites prove what is DRAWN from these; this file is the
// rules themselves, on inputs a screen fixture would have to contort to reach.

const step = (ordinal: number, assignmentId: string, overrides: Partial<IssuedWorkoutStepView> = {}): IssuedWorkoutStepView => ({
  ordinal,
  block: 'main_work',
  scale_level: null,
  contact_level: 'none',
  coach_note: null,
  assignment_id: assignmentId,
  ...overrides,
});

const workout = (issueId: string, steps: IssuedWorkoutStepView[], name = `Workout ${issueId}`): IssuedWorkoutView => ({
  issue_id: issueId,
  template_name: name,
  steps,
});

const work = (...ids: string[]) => ids.map((id) => ({ assignment_id: id }));

/** A row as one short string: "W:name(n)", "B:block" or "A:id" / "S<ordinal>:id" for a step. */
const drawn = (assignments: Array<{ assignment_id: string }>, workouts: IssuedWorkoutView[]) =>
  orderAssignedWork(assignments, workouts).map((row) => {
    if (row.kind === 'workout') return `W:${row.workout.template_name}(${row.stepCount})`;
    if (row.kind === 'block') return `B:${row.block}`;
    return row.step ? `S${row.step.ordinal}:${row.assignment.assignment_id}` : `A:${row.assignment.assignment_id}`;
  });

describe('readIssuedWorkouts', () => {
  const READABLE = workout('issue-1', [step(1, 'a')]);

  test('an absent key is no workouts; a well-formed list is returned as it is', () => {
    expect(readIssuedWorkouts(undefined)).toEqual([]);
    expect(readIssuedWorkouts([])).toEqual([]);
    expect(readIssuedWorkouts([READABLE])).toEqual([READABLE]);
  });

  test('a level left open and a missing note are readable: null is an answer', () => {
    const open = workout('issue-1', [step(1, 'a', { scale_level: null, coach_note: null })]);
    expect(readIssuedWorkouts([open])).toEqual([open]);
  });

  test('what no screen is required to draw is not looked at: a date, a name or a version of any kind', () => {
    for (const extra of [{ issued_at: null }, { issued_at: 0 }, { issued_by_name: 5 }, { template_version: 'two' }, { something_new: true }]) {
      expect(readIssuedWorkouts([{ ...READABLE, ...extra }])).toHaveLength(1);
    }
  });

  const UNREADABLE: Array<[string, unknown]> = [
    ['null', null],
    ['an object', { issue_id: 'issue-1' }],
    ['a list holding null', [null]],
    ['a list holding text', ['issue-1']],
    ['a workout with no id', [{ ...READABLE, issue_id: 7 }]],
    ['a workout with no name', [{ ...READABLE, template_name: null }]],
    ['a workout whose steps are not a list', [{ ...READABLE, steps: 'one' }]],
    ['a step that is null', [{ ...READABLE, steps: [null] }]],
    ['a step that is text', [{ ...READABLE, steps: ['a'] }]],
    ['a step whose order is text', [{ ...READABLE, steps: [{ ...step(1, 'a'), ordinal: '1' }] }]],
    ['a step whose order is not whole', [{ ...READABLE, steps: [{ ...step(1, 'a'), ordinal: 1.5 }] }]],
    ['a step with no block', [{ ...READABLE, steps: [{ ...step(1, 'a'), block: undefined }] }]],
    ['a step whose scale level is a number', [{ ...READABLE, steps: [{ ...step(1, 'a'), scale_level: 2 }] }]],
    ['a step with no contact level', [{ ...READABLE, steps: [{ ...step(1, 'a'), contact_level: null }] }]],
    ['a step whose note is a number', [{ ...READABLE, steps: [{ ...step(1, 'a'), coach_note: 5 }] }]],
    ['a step with no assignment', [{ ...READABLE, steps: [{ ...step(1, 'a'), assignment_id: undefined }] }]],
    ['one bad workout among good ones', [READABLE, { ...READABLE, issue_id: null }]],
  ];

  test.each(UNREADABLE)('%s is refused, never read as "no workouts"', (_label, raw) => {
    expect(() => readIssuedWorkouts(raw)).toThrow(IssuedWorkoutsUnreadableError);
  });
});

describe('orderAssignedWork', () => {
  test('with no workouts the assignments come back in the order given', () => {
    expect(drawn(work('a', 'b', 'c'), [])).toEqual(['A:a', 'A:b', 'A:c']);
    expect(drawn([], [workout('issue-1', [step(1, 'a')])])).toEqual([]);
  });

  test('a workout is drawn whole at the place of the FIRST of its drills, its steps in ordinal order whatever order they came in', () => {
    const tuesday = workout('issue-1', [step(7, 'c'), step(2, 'a'), step(5, 'b')], 'Tuesday');
    // 'x' stands before the workout's first drill, 'y' between two of them, 'z' after the last.
    expect(drawn(work('x', 'c', 'y', 'a', 'b', 'z'), [tuesday])).toEqual([
      'A:x',
      'W:Tuesday(3)',
      'B:main_work',
      'S2:a',
      'S5:b',
      'S7:c',
      'A:y',
      'A:z',
    ]);
  });

  test('a block is headed every time it changes, so one the coach returns to is headed again', () => {
    const tuesday = workout('issue-1', [
      step(1, 'a', { block: 'warmup' }),
      step(2, 'b', { block: 'main_work' }),
      step(3, 'c', { block: 'main_work' }),
      step(4, 'd', { block: 'warmup' }),
    ], 'Tuesday');
    expect(drawn(work('a', 'b', 'c', 'd'), [tuesday])).toEqual([
      'W:Tuesday(4)', 'B:warmup', 'S1:a', 'B:main_work', 'S2:b', 'S3:c', 'B:warmup', 'S4:d',
    ]);
  });

  test('a step whose assignment is not in the list is left out and not counted; a workout with none left is not drawn', () => {
    const tuesday = workout('issue-1', [step(1, 'a'), step(2, 'gone'), step(3, 'c')], 'Tuesday');
    const friday = workout('issue-2', [step(1, 'also-gone')], 'Friday');
    expect(drawn(work('a', 'c', 'x'), [tuesday, friday])).toEqual(['W:Tuesday(2)', 'B:main_work', 'S1:a', 'S3:c', 'A:x']);
    // The workout still says how many steps it has in all.
    const [heading] = orderAssignedWork(work('a', 'c'), [tuesday]);
    expect(heading.kind === 'workout' && heading.workout.steps.length).toBe(3);
  });

  test('two workouts each stand where the first of their own drills does, whatever order the workouts came in', () => {
    const tuesday = workout('issue-1', [step(1, 'a'), step(2, 'b')], 'Tuesday');
    const friday = workout('issue-2', [step(1, 'p'), step(2, 'q')], 'Friday');
    const expected = ['W:Friday(2)', 'B:main_work', 'S1:p', 'S2:q', 'W:Tuesday(2)', 'B:main_work', 'S1:a', 'S2:b'];
    expect(drawn(work('q', 'a', 'p', 'b'), [tuesday, friday])).toEqual(expected);
    expect(drawn(work('q', 'a', 'p', 'b'), [friday, tuesday])).toEqual(expected);
  });

  test('nothing is drawn twice: an assignment two workouts name, a step listed twice, an issue id sent twice', () => {
    const tuesday = workout('issue-1', [step(1, 'a'), step(2, 'b'), step(2, 'b')], 'Tuesday');
    const claimsB = workout('issue-2', [step(1, 'b'), step(2, 'c')], 'Friday');
    const sameIdAgain = workout('issue-1', [step(1, 'd')], 'A repeat');
    const rows = drawn(work('a', 'b', 'c', 'd'), [tuesday, claimsB, sameIdAgain]);

    expect(rows).toEqual(['W:Tuesday(2)', 'B:main_work', 'S1:a', 'S2:b', 'W:Friday(1)', 'B:main_work', 'S2:c', 'A:d']);
    // Every assignment exactly once.
    const ids = orderAssignedWork(work('a', 'b', 'c', 'd'), [tuesday, claimsB, sameIdAgain])
      .flatMap((row) => (row.kind === 'assignment' ? [row.assignment.assignment_id] : []));
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('row keys never repeat, even when two blocks of one workout share a name', () => {
    const tuesday = workout('issue-1', [
      step(1, 'a', { block: 'warmup' }),
      step(2, 'b', { block: 'main_work' }),
      step(3, 'c', { block: 'warmup' }),
    ]);
    const keys = orderAssignedWork(work('a', 'b', 'c', 'x'), [tuesday]).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the caller\'s assignment objects are passed through untouched, with every field they had', () => {
    const items = [{ assignment_id: 'a', status: 'assigned', extra: 1 }, { assignment_id: 'b', status: 'in_progress', extra: 2 }];
    const rows = orderAssignedWork(items, [workout('issue-1', [step(1, 'b')])]);
    const out = rows.flatMap((row) => (row.kind === 'assignment' ? [row.assignment] : []));
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
  });
});
