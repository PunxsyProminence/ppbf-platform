import { __testables } from './sessionScriptRuns';

const { computeElapsedSeconds } = __testables;

// The clock is the whole reason a live run is a row rather than React state, so it is tested on its
// own rather than only through a route. Every case here is a thing that actually happens on a gym
// floor: a phone that slept, a coach who paused to deal with an injury, a tab reopened an hour
// later.
//
// These are pure-function tests with an injected `now`, so they do not need Postgres and run in the
// fast suite. The pg suite covers what the DATABASE computes when a pause is closed out; this
// covers what a reader computes while it is open.

function row(overrides: Record<string, unknown> = {}) {
  return {
    started_at: '2026-08-09T10:00:00.000Z',
    paused_at: null,
    paused_seconds: 0,
    ...overrides,
  } as Parameters<typeof computeElapsedSeconds>[0];
}

describe('computeElapsedSeconds', () => {
  it('counts wall time since start when the run has never paused', () => {
    const now = new Date('2026-08-09T10:25:00.000Z');
    expect(computeElapsedSeconds(row(), now)).toBe(25 * 60);
  });

  it('subtracts banked pause time', () => {
    const now = new Date('2026-08-09T10:25:00.000Z');
    // 25 minutes on the clock, 5 of them paused, so 20 minutes of session.
    expect(computeElapsedSeconds(row({ paused_seconds: 300 }), now)).toBe(20 * 60);
  });

  // The case that matters most: a paused run must not keep counting. A coach who pauses to deal
  // with an injury and comes back twenty minutes later should not find twenty minutes of session
  // time they did not teach.
  it('freezes at the moment the pause began, however long ago that was', () => {
    const frozen = computeElapsedSeconds(
      row({ paused_at: '2026-08-09T10:10:00.000Z' }),
      new Date('2026-08-09T10:30:00.000Z'),
    );
    expect(frozen).toBe(10 * 60);

    // Same row read much later reads the same. If this ever changes, the timer is running while
    // paused and the reading is a lie.
    const readMuchLater = computeElapsedSeconds(
      row({ paused_at: '2026-08-09T10:10:00.000Z' }),
      new Date('2026-08-09T18:00:00.000Z'),
    );
    expect(readMuchLater).toBe(frozen);
  });

  it('freezes net of pause time already banked from earlier pauses', () => {
    // Started 10:00, banked 4 minutes across earlier pauses, paused again at 10:20.
    // Gross to the pause is 20 minutes; net is 16.
    const elapsed = computeElapsedSeconds(
      row({ paused_at: '2026-08-09T10:20:00.000Z', paused_seconds: 240 }),
      new Date('2026-08-09T11:00:00.000Z'),
    );
    expect(elapsed).toBe(16 * 60);
  });

  // A tab asleep for twenty minutes and one watched the whole time must resume to the same
  // reading. This is the property that makes the run row worth persisting at all.
  it('reads identically regardless of when the reader last looked', () => {
    const stored = row();
    const now = new Date('2026-08-09T10:42:00.000Z');
    const watchedTheWholeTime = computeElapsedSeconds(stored, now);
    const justWokeUp = computeElapsedSeconds({ ...stored }, now);
    expect(justWokeUp).toBe(watchedTheWholeTime);
    expect(watchedTheWholeTime).toBe(42 * 60);
  });

  it('treats a null paused_seconds as nothing banked rather than as an error', () => {
    const now = new Date('2026-08-09T10:15:00.000Z');
    expect(computeElapsedSeconds(row({ paused_seconds: null }), now)).toBe(15 * 60);
  });

  // A row that predates live-run tracking has no started_at. It is not a live run and has no
  // elapsed time; reporting anything other than 0 would invent a duration for a session nobody
  // timed.
  it('reports zero for a row with no start time', () => {
    const now = new Date('2026-08-09T10:15:00.000Z');
    expect(computeElapsedSeconds(row({ started_at: null }), now)).toBe(0);
  });

  // Clock skew between the database and the reader could otherwise produce a negative reading,
  // which would render as something like "-3 min" on a coach's screen.
  it('never returns a negative reading when now precedes started_at', () => {
    const now = new Date('2026-08-09T09:59:00.000Z');
    expect(computeElapsedSeconds(row(), now)).toBe(0);
  });

  it('never returns a negative reading when banked pause exceeds wall time', () => {
    const now = new Date('2026-08-09T10:01:00.000Z');
    expect(computeElapsedSeconds(row({ paused_seconds: 9999 }), now)).toBe(0);
  });

  it('floors partial seconds rather than rounding up', () => {
    const now = new Date('2026-08-09T10:00:00.900Z');
    expect(computeElapsedSeconds(row(), now)).toBe(0);
  });
});
