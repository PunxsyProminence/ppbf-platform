/**
 * @jest-environment jsdom
 */

// The failure mode this file exists to pin: a ceremony that fires twice, or
// fires on every render. `completed >= 13` is true forever after the 13th
// session, so anything reading it as an event instead of a state rings the bell
// on every re-render, every tab switch and every reload — which is worse than
// the silence it replaced.
//
// The second failure mode, subtler: an athlete with a year of training opening
// their card on a new phone has crossed nothing, and must not be congratulated
// for history.

import {
  CEREMONY_STORAGE_PREFIX,
  boxingNumberNote,
  ceremonyStorageKey,
  decideCeremony,
  readSealed,
  resetCeremonyMemory,
  writeSealed,
} from './milestoneCeremony';
import { MILESTONES } from './TrainingCard';

const M = [...MILESTONES];

afterEach(() => {
  window.localStorage.clear();
  resetCeremonyMemory();
});

describe('decideCeremony — the crossing rule', () => {
  it('rings nothing the first time it sees a card, however much is on it', () => {
    // A year of training opened on a new phone. Nothing was crossed here.
    const first = decideCeremony(40, null, M);
    expect(first.celebrate).toBeNull();
    expect(first.seeded).toBe(true);
    expect(first.record).toEqual([5, 13, 34]);
  });

  it('writes down the first sighting even when nothing is earned yet', () => {
    // Otherwise every later look is another first sighting, and the fifth
    // session never rings.
    const first = decideCeremony(1, null, M);
    expect(first.record).toEqual([]);
    expect(first.changed).toBe(true);
  });

  it('rings on the crossing', () => {
    const crossing = decideCeremony(13, [5], M);
    expect(crossing.celebrate).toBe(13);
    expect(crossing.record).toEqual([5, 13]);
  });

  it('rings once, then never again for the same milestone', () => {
    const first = decideCeremony(13, [5], M);
    expect(first.celebrate).toBe(13);

    // Every subsequent render at the same count, and every count above it.
    for (const count of [13, 13, 14, 20, 33]) {
      expect(decideCeremony(count, first.record, M).celebrate).toBeNull();
    }
  });

  it('says nothing at all on a count that crosses nothing', () => {
    for (const count of [0, 1, 4, 6, 12, 14, 88]) {
      const known = M.filter((m) => m <= count);
      expect(decideCeremony(count, known, M).celebrate).toBeNull();
    }
  });

  it('rings once for the furthest milestone when a backfill crosses two', () => {
    // A coach entering ten sessions at once must not produce two bells.
    const jump = decideCeremony(14, [], M);
    expect(jump.celebrate).toBe(13);
    expect(jump.record).toEqual([5, 13]);
  });

  it('never takes a milestone back, so a corrected row cannot make it ring twice', () => {
    const crossed = decideCeremony(13, [5], M);
    expect(crossed.celebrate).toBe(13);

    // A session row is deleted; the count falls back under 13.
    const fallen = decideCeremony(12, crossed.record, M);
    expect(fallen.celebrate).toBeNull();
    expect(fallen.record).toEqual([5, 13]);

    // And back up again. Still silent.
    expect(decideCeremony(13, fallen.record, M).celebrate).toBeNull();
  });

  it('walks a whole athlete from nothing to 233 and rings exactly five times', () => {
    let known: readonly number[] | null = null;
    const rung: number[] = [];

    for (let count = 1; count <= 240; count++) {
      // Two observations per count — the card re-renders constantly.
      for (let render = 0; render < 2; render++) {
        const decision = decideCeremony(count, known, M);
        if (decision.celebrate !== null) {
          rung.push(decision.celebrate);
        }
        known = decision.record;
      }
    }

    expect(rung).toEqual([5, 13, 34, 89, 233]);
  });

  it('is only ever handed a cumulative count, so it cannot implement a streak', () => {
    // Same count, wildly different histories: three sessions this week versus
    // three sessions across three years. Identical answer, by construction.
    expect(decideCeremony(5, [], M)).toEqual(decideCeremony(5, [], M));
    // And an absence can never revoke anything — see the no-streaks argument
    // in TrainingCard.tsx, which is load-bearing.
    expect(decideCeremony(0, [5, 13], M).record).toEqual([5, 13]);
  });
});

describe('the record it keeps', () => {
  it('files each athlete separately, because the gym tablet is shared', () => {
    expect(ceremonyStorageKey('ath_1')).not.toBe(ceremonyStorageKey('ath_2'));
    expect(ceremonyStorageKey('ath_1')).toBe(`${CEREMONY_STORAGE_PREFIX}.ath_1`);
    expect(ceremonyStorageKey(undefined)).toBe(`${CEREMONY_STORAGE_PREFIX}.unknown`);
    expect(ceremonyStorageKey('   ')).toBe(`${CEREMONY_STORAGE_PREFIX}.unknown`);
  });

  it('tells "never seen" apart from "seen, nothing earned"', () => {
    const key = ceremonyStorageKey('ath_1');
    expect(readSealed(key)).toBeNull();
    writeSealed(key, []);
    expect(readSealed(key)).toEqual([]);
  });

  it('survives a reload', () => {
    const key = ceremonyStorageKey('ath_1');
    writeSealed(key, [5, 13]);
    resetCeremonyMemory();               // a new page, same browser
    expect(readSealed(key)).toEqual([5, 13]);
  });

  it('treats a corrupted record as never seen, so it seeds rather than repeats', () => {
    const key = ceremonyStorageKey('ath_1');
    window.localStorage.setItem(key, 'not json at all');
    expect(readSealed(key)).toBeNull();
    expect(decideCeremony(89, readSealed(key), M).celebrate).toBeNull();
  });

  it('keeps working for the visit when storage is blocked entirely', () => {
    // Private mode, and some embedded kiosk webviews. The crossing that
    // happens while the athlete is standing at the tablet must still work.
    const key = ceremonyStorageKey('ath_1');
    const blocked = () => { throw new Error('storage disabled'); };
    const store = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked },
    });

    try {
      expect(readSealed(key)).toBeNull();
      writeSealed(key, [5]);
      expect(readSealed(key)).toEqual([5]);
      expect(decideCeremony(5, readSealed(key), M).celebrate).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
    }
  });

  it('never throws, whatever is in storage', () => {
    const key = ceremonyStorageKey('ath_1');
    for (const junk of ['', '{}', 'null', '[1,"two",null]', '[]']) {
      window.localStorage.setItem(key, junk);
      resetCeremonyMemory();
      expect(() => readSealed(key)).not.toThrow();
    }
    // Non-numbers are dropped rather than poisoning the comparison.
    window.localStorage.setItem(key, '[5,"13",null,34]');
    resetCeremonyMemory();
    expect(readSealed(key)).toEqual([5, 34]);
  });
});

/**
 * THE BOXING NUMBERS — a remark on a count, and nothing that could become a
 * second milestone system.
 *
 * The risk of adding anything to this file is that it acquires the ability to
 * observe an absence. These tests are the proof it did not: the new function
 * takes a cumulative count and returns a line, it keeps no record, and it can
 * never fire on the same count as a ceremony.
 */
describe('boxingNumberNote', () => {
  it('remarks on 3 — the rounds in an amateur bout', () => {
    const note = boxingNumberNote(3);
    expect(note?.count).toBe(3);
    expect(note?.line).toContain('amateur bout');
  });

  it('remarks on 12 — championship distance', () => {
    const note = boxingNumberNote(12);
    expect(note?.count).toBe(12);
    expect(note?.line.toLowerCase()).toContain('championship');
  });

  it('says nothing about any other number, which is almost all of them', () => {
    for (let count = 0; count <= 250; count += 1) {
      if (count === 3 || count === 12) continue;
      expect(boxingNumberNote(count)).toBeNull();
    }
  });

  it('is only true on the day — at 4 you did not just do it, you did it last time', () => {
    expect(boxingNumberNote(3)).not.toBeNull();
    expect(boxingNumberNote(4)).toBeNull();
    expect(boxingNumberNote(13)).toBeNull();
  });

  it('can never collide with a milestone, so two things never fire at once', () => {
    for (const milestone of M) {
      expect(boxingNumberNote(milestone)).toBeNull();
    }
    for (const remarked of [3, 12]) {
      expect(M).not.toContain(remarked);
      // The ceremony may well have something to say at 12 -- the athlete
      // crossed 5 on the way -- but it can never press a seal FOR 3 or 12,
      // because neither is on the ladder. That is the collision that matters:
      // a seal coming down and a remark landing on the same number would read
      // as one event stuttering.
      expect(decideCeremony(remarked, [], M).celebrate).not.toBe(remarked);
    }
  });

  /* ---------------------------------------------------------------------
     THE NO-STREAKS INVARIANT, STILL TRUE AFTER THE ADDITION
  --------------------------------------------------------------------- */

  it('takes a cumulative count and nothing else', () => {
    // One argument. There is no date to hand it, no history, no last-seen, so
    // there is nothing in it that could observe a gap, a cadence or an expiry.
    expect(boxingNumberNote.length).toBe(1);
  });

  it('gives the identical answer to wildly different histories', () => {
    // Three sessions this week and three sessions across three years. The
    // function cannot tell them apart, by construction.
    expect(boxingNumberNote(3)).toEqual(boxingNumberNote(3));
  });

  it('keeps no record, so it can never say a second thing on a second look', () => {
    // Unlike the ceremony, it is pure: looking at it a hundred times leaves
    // storage exactly as it found it, and nothing accumulates that a later
    // read could compare against.
    const before = window.localStorage.length;
    for (let i = 0; i < 100; i += 1) {
      boxingNumberNote(3);
      boxingNumberNote(12);
    }
    expect(window.localStorage.length).toBe(before);
  });

  it('punishes nothing: a count that falls back still gets the same treatment', () => {
    // A corrected-away session row moves the count down. That must produce a
    // remark or silence -- never a rebuke.
    expect(boxingNumberNote(12)).not.toBeNull();
    expect(boxingNumberNote(11)).toBeNull();
    expect(boxingNumberNote(3)).not.toBeNull();
  });

  it('uses none of the vocabulary a streak needs', () => {
    for (const count of [3, 12]) {
      const line = boxingNumberNote(count)?.line.toLowerCase() ?? '';
      expect(line).not.toMatch(/streak|consecutive|in a row|don't break|keep it up|missed|lapsed|expired/);
    }
  });
});
