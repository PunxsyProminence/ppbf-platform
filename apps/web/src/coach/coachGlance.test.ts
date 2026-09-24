/**
 * THE GLANCE MODEL, TESTED WITHOUT A SCREEN.
 *
 * These are pure functions of already-loaded state, so they are tested directly
 * rather than through a render. That matters for a reason beyond speed: the
 * whole point of extracting them is that BOARD and ROOM cannot each compute
 * their own version of a fact. A test that went through one layout's markup
 * would be a test of that layout. This tests the fact.
 *
 * Every case below is a mistake that has actually been made in this code, or
 * one the shape of the data invites. None of them is hypothetical.
 */

import {
  coachTasksFrom,
  escalationGlance,
  formatElapsed,
  readinessGlance,
  reviewQueueBadgeFor,
} from './coachGlance';

describe('formatElapsed', () => {
  it('reads as minutes and seconds under an hour, and hours and minutes over', () => {
    expect(formatElapsed(0)).toBe('0m 00s');
    expect(formatElapsed(59)).toBe('0m 59s');
    expect(formatElapsed(750)).toBe('12m 30s');
    expect(formatElapsed(3840)).toBe('1h 04m');
  });

  it('floors a clock that runs backwards to zero rather than rendering a minus', () => {
    /* The server owns elapsed time. A clock-skew correction between two reads
       can hand back a smaller number than the last one, and a coach glancing up
       mid-round should see 0m 00s rather than -3m 41s, which reads as a broken
       session rather than as arithmetic. */
    expect(formatElapsed(-221)).toBe('0m 00s');
    expect(formatElapsed(Number.NaN)).toBe('0m 00s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0m 00s');
  });

  it('pads, so the numbers do not jump around as they change width', () => {
    expect(formatElapsed(61)).toBe('1m 01s');
    expect(formatElapsed(3601)).toBe('1h 00m');
  });
});

describe('readinessGlance', () => {
  const band = (readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN') => ({ readiness });
  const contextual = (athleteId: string) => ({ athleteId });

  it('counts each band, and unknown is counted rather than ignored', () => {
    const glance = readinessGlance(
      [band('RED'), band('YELLOW'), band('YELLOW'), band('UNKNOWN'), band('GREEN')],
      [],
    );
    expect([glance.red, glance.yellow, glance.unknown]).toEqual([1, 2, 1]);
    expect(glance.banded).toBe(4);
  });

  it('says the feed answered when the ONLY readings are staff judgements', () => {
    /* THE ONE THAT BROKE EVERY ORGANIZATION. trackingAvailable was once
       `athletes.some(a => a.readiness !== 'UNKNOWN')` -- the same question,
       while every reading still became a band. Once unvalidated readings
       stopped being promoted, an org whose scores are all staff judgements --
       which is every org today -- had nobody with a band, so the tile fell to
       "No signal". It called a working feed a dead one, and took the provenance
       caveat down with it, because the caveat renders inside that branch. */
    const glance = readinessGlance(
      [band('UNKNOWN'), band('UNKNOWN'), band('UNKNOWN')],
      [contextual('ath_1'), contextual('ath_2')],
    );
    expect(glance.trackingAvailable).toBe(true);
    expect(glance.banded).toBe(0);
    expect(glance.unvalidated).toBe(2);
  });

  it('says the feed said nothing only when it genuinely said nothing', () => {
    // "No signal" has to keep meaning no signal, or it is worth nothing.
    const glance = readinessGlance([band('UNKNOWN'), band('UNKNOWN')], []);
    expect(glance.trackingAvailable).toBe(false);
    expect(glance.tracked).toBe(0);
  });

  it('counts unvalidated readings from the contextual list, never from the roster', () => {
    /* THE SECOND TRAP, AND IT IS SILENT. An earlier draft derived "unvalidated"
       from the roster. But an unvalidated reading leaves its athlete UNKNOWN by
       design, so the roster holds no trace of it: the derivation returned 0 for
       exactly the rows it existed to count, and the caveat stopped rendering at
       the moment the provenance gate began working. The opposite of the intent,
       and invisible without this.

       Here the roster is entirely banded and the contextual list is not empty.
       A roster-derived count would report 0. */
    const glance = readinessGlance(
      [band('GREEN'), band('RED')],
      [contextual('ath_9'), contextual('ath_10'), contextual('ath_11')],
    );
    expect(glance.unvalidated).toBe(3);
  });

  it('adds the two sources rather than choosing between them', () => {
    const glance = readinessGlance([band('RED'), band('UNKNOWN')], [contextual('ath_3')]);
    expect(glance.tracked).toBe(glance.banded + glance.unvalidated);
    expect(glance.tracked).toBe(2);
  });

  it('holds together on an empty roster instead of dividing by nobody', () => {
    const glance = readinessGlance([], []);
    expect(glance).toEqual({
      red: 0, yellow: 0, unknown: 0, banded: 0, unvalidated: 0, tracked: 0,
      trackingAvailable: false,
    });
  });
});

describe('coachTasksFrom', () => {
  const item = (id: string, status: 'pending_review' | 'approved' | 'rejected' | 'promoted') => ({
    intake_case_id: id,
    status,
    summary: `case ${id}`,
    updated_at: '2026-07-30T11:02:00.000Z',
  });

  it('derives tasks only from work that is actually pending', () => {
    const tasks = coachTasksFrom([
      item('a', 'pending_review'),
      item('b', 'approved'),
      item('c', 'rejected'),
      item('d', 'pending_review'),
      item('e', 'promoted'),
    ]);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'd']);
  });

  it('words the timing as a sentence, because a derived task has no due date', () => {
    /* The fabricated five-item list this replaced showed every coach the same
       stale to-dos with due dates that had already passed. A derived task knows
       when it ARRIVED, not when it is due, and it says so. */
    const [task] = coachTasksFrom([item('a', 'pending_review')]);
    expect(task.when).toBe('In review queue since 2026-07-30');
    expect(task.when).not.toMatch(/due/i);
  });

  it('returns nothing for an empty queue rather than inventing a starter list', () => {
    expect(coachTasksFrom([])).toEqual([]);
  });
});

describe('reviewQueueBadgeFor', () => {
  it('says it is checking while the read is in flight, and never zero', () => {
    // An in-flight read reported as "0 pending" is the board telling a coach
    // there is no work when it has not looked yet.
    expect(reviewQueueBadgeFor('loading', 0)).toEqual({ tone: 'monitor', label: 'checking' });
    expect(reviewQueueBadgeFor('loading', 7).label).toBe('checking');
  });

  it('says zero out loud when the queue was read and is genuinely empty', () => {
    // This is the good news a coach came for, and it used to be silence.
    expect(reviewQueueBadgeFor('loaded', 0)).toEqual({ tone: 'monitor', label: '0 pending' });
  });

  it('counts real pending work', () => {
    expect(reviewQueueBadgeFor('loaded', 3).label).toBe('3 pending');
  });

  it('says unavailable when the read failed, and never renders it as a count', () => {
    const badge = reviewQueueBadgeFor('unavailable', 0);
    expect(badge.label).toBe('unavailable');
    expect(badge.label).not.toMatch(/\d/);
  });

  it('never reaches for the reserved medical rung to report a network failure', () => {
    /* A read that did not come back is not a safeguarding state. Borrowing
       --locked for an unreachable endpoint would teach a coach that the
       reserved red can mean "try again later", which is the whole value of
       reserving it gone. */
    const tones = (['loading', 'loaded', 'unavailable'] as const)
      .map((state) => reviewQueueBadgeFor(state, 2).tone);
    expect(tones).toEqual(['monitor', 'monitor', 'restricted']);
    expect(tones).not.toContain('locked');
  });
});

describe('escalationGlance', () => {
  const row = (
    severity: 'low' | 'moderate' | 'high' | 'critical',
    status: 'open' | 'acknowledged' | 'resolved' = 'open',
  ) => ({ severity, status });

  it('stops counting a row the coach has acknowledged', () => {
    /* THE ONE THAT SHIPPED. The board printed the ARRAY LENGTH as "N open".
       Acknowledging does not remove the row -- the handler replaces it in place
       on purpose, so the coach can still see what they just did and read that
       closing it out is an admin decision. Keeping the row is right; counting
       it as open was not. The board said "2 open" directly above a row whose
       own body said "Acknowledged", and nothing failed, because no test had
       ever read that number. */
    const glance = escalationGlance([
      row('critical'),
      row('high', 'acknowledged'),
    ]);
    expect(glance.open).toBe(1);
  });

  it('keeps the acknowledged row as its own fact rather than throwing it away', () => {
    // A renderer wanting "1 acknowledged, waiting on admin" reads this, instead
    // of subtracting two other numbers and hoping the difference means that.
    const glance = escalationGlance([
      row('critical'),
      row('high', 'acknowledged'),
      row('low', 'acknowledged'),
    ]);
    expect(glance.acknowledgedStillShown).toBe(2);
  });

  it('composes severity over the OPEN rows only', () => {
    // An acknowledged critical is not waiting on anybody. Counting it in the
    // composition would put a critical on the glance that nobody needs to act
    // on, which is the same false-alarm problem in the other direction.
    const glance = escalationGlance([
      row('critical'),
      row('high'),
      row('high'),
      row('moderate'),
      row('critical', 'acknowledged'),
      row('low', 'resolved'),
    ]);
    expect([glance.critical, glance.high, glance.moderate, glance.low]).toEqual([1, 2, 1, 0]);
    expect(glance.open).toBe(4);
  });

  it('adds up: the composition accounts for every open row and no others', () => {
    const rows = [row('critical'), row('high'), row('moderate'), row('low'), row('high', 'acknowledged')];
    const glance = escalationGlance(rows);
    expect(glance.critical + glance.high + glance.moderate + glance.low).toBe(glance.open);
  });

  it('reports nothing waiting when nothing is, without inventing a state', () => {
    expect(escalationGlance([])).toEqual({
      open: 0, critical: 0, high: 0, moderate: 0, low: 0, acknowledgedStillShown: 0,
    });
  });

  it('does not treat a resolved row as acknowledged, or as open', () => {
    const glance = escalationGlance([row('critical', 'resolved')]);
    expect([glance.open, glance.acknowledgedStillShown]).toEqual([0, 0]);
  });
});
