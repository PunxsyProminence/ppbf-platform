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
  attendanceGlance,
  attendanceMarkLabel,
  attendanceMarkTitle,
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

describe('attendanceGlance', () => {
  const at = (attendance:
    'Present' | 'Absent' | 'Excused' | 'Unknown' | 'Unavailable' | 'NotCovered') => ({ attendance });

  it('tallies the four marks a coach reads across the room', () => {
    const glance = attendanceGlance([
      at('Present'), at('Present'), at('Absent'), at('Excused'), at('Unknown'),
    ]);
    expect([glance.present, glance.absent, glance.excused, glance.unmarked]).toEqual([2, 1, 1, 1]);
    expect(glance.covered).toBe(5);
    expect(glance.readable).toBe(true);
  });

  it('REFUSES to tally when the register could not be read', () => {
    /* THE FALSE ZERO, AND WHY IT IS DANGEROUS ON A PEG BOARD.

       A failed read moves EVERY athlete to 'Unavailable'. A tally over that
       renders 0 present, 0 absent, 0 excused -- the board telling a coach that
       nobody came, in the same typography it uses to tell them who did. On a
       peg board it is four empty columns, which reads as an empty gym rather
       than as a broken read.

       So the flag, not the numbers, is what the renderer must ask first. */
    const glance = attendanceGlance([at('Unavailable'), at('Unavailable'), at('Unavailable')]);
    expect(glance.readable).toBe(false);
    expect([glance.present, glance.absent, glance.excused, glance.unmarked]).toEqual([0, 0, 0, 0]);
    expect(glance.covered).toBe(0);
  });

  it('refuses even when only some athletes are unavailable', () => {
    // A partial read is still not a register. Showing "1 present" beside two
    // athletes nobody could look up is a count with a hole in it, presented as
    // though it were whole.
    const glance = attendanceGlance([at('Present'), at('Unavailable')]);
    expect(glance.readable).toBe(false);
  });

  it('keeps "nobody asked" apart from "no mark yet"', () => {
    /* Three kinds of not-knowing, and they are not interchangeable. NotCovered
       athletes were never part of the question -- they cannot be missing from a
       register they were never on -- so they do not land in unmarked and they
       do not swell the denominator. */
    const glance = attendanceGlance([
      at('Present'), at('Unknown'), at('NotCovered'), at('NotCovered'),
    ]);
    expect(glance.unmarked).toBe(1);
    expect(glance.notCovered).toBe(2);
    expect(glance.covered).toBe(2);
  });

  it('still reports who was never asked about when the read failed', () => {
    // NotCovered is knowable without the register: it comes from the access
    // contract, not from today's marks. Losing it would be losing a fact the
    // failure did not actually take away.
    const glance = attendanceGlance([at('Unavailable'), at('NotCovered')]);
    expect(glance.readable).toBe(false);
    expect(glance.notCovered).toBe(1);
  });

  it('treats a register nobody has marked yet as readable, not as broken', () => {
    // Before the register is taken, everyone is Unknown. That is the ordinary
    // start of a session and it is not a failure -- four columns with everyone
    // in the unmarked one is the truth.
    const glance = attendanceGlance([at('Unknown'), at('Unknown'), at('Unknown')]);
    expect(glance.readable).toBe(true);
    expect(glance.unmarked).toBe(3);
    expect(glance.covered).toBe(3);
  });

  it('adds up: the four marks account for the covered register exactly', () => {
    const glance = attendanceGlance([
      at('Present'), at('Absent'), at('Excused'), at('Unknown'), at('NotCovered'),
    ]);
    expect(glance.present + glance.absent + glance.excused + glance.unmarked)
      .toBe(glance.covered);
  });

  it('holds together on an empty roster', () => {
    const glance = attendanceGlance([]);
    expect(glance.readable).toBe(true);
    expect(glance.covered).toBe(0);
  });
});

describe('what a mark is called', () => {
  /* Not styling, and not a calculation. It is the sentence a coach reads, and
     it is the single most likely thing to drift between two surfaces showing
     the same register -- the board saying "No mark yet" while the register
     behind it says "Unmarked", leaving a coach to work out whether those are
     the same state. One function, both surfaces. */

  it('gives each kind of not-knowing its own words', () => {
    expect(attendanceMarkLabel('Unknown')).toBe('No mark yet');
    expect(attendanceMarkLabel('Unavailable')).toBe('Register unavailable');
    expect(attendanceMarkLabel('NotCovered')).toBe('Not your athlete');
  });

  it('never lets one kind of not-knowing wear another\'s words', () => {
    /* Three states, three sentences, no overlap. "Nobody could look" read as
       "nobody has ticked them off" sends a coach to mark a register that is not
       there; "nobody asked" read as "unmarked" sends them to mark a child they
       are not cleared for. */
    const labels = (['Unknown', 'Unavailable', 'NotCovered'] as const).map(attendanceMarkLabel);
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) {
      expect(label).not.toMatch(/^(Present|Absent|Excused)$/);
    }
  });

  it('passes a real mark through as itself', () => {
    expect(attendanceMarkLabel('Present')).toBe('Present');
    expect(attendanceMarkLabel('Absent')).toBe('Absent');
    expect(attendanceMarkLabel('Excused')).toBe('Excused');
  });

  it('says what each kind of not-knowing is NOT', () => {
    // Every one of these has been read as its neighbour at some point.
    expect(attendanceMarkTitle('Unavailable')).toMatch(/not a statement that they were absent/i);
    expect(attendanceMarkTitle('NotCovered')).toMatch(/not a statement about whether they trained/i);
    expect(attendanceMarkTitle('Unknown')).toMatch(/no attendance mark recorded/i);
  });

  it('describes a real mark as a mark', () => {
    expect(attendanceMarkTitle('Present')).toBe('Marked present today');
    expect(attendanceMarkTitle('Excused')).toBe('Marked excused today');
  });
});
