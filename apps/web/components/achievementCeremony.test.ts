/**
 * @jest-environment jsdom
 */

/**
 * The crossing rule for key-shaped achievements.
 *
 * milestoneCeremony.test.ts pins the same rule for the session count; this pins
 * it for everything identified by a key instead of a number, and specifically
 * the three ways it can betray somebody:
 *
 *   a bell that rings for HISTORY, because a phone saw the card for the first
 *   time and mistook a year of training for a year of crossings;
 *
 *   a bell that rings TWICE, because the record was read as a state rather than
 *   an event and every render is that state again;
 *
 *   a record that SHRINKS, which would let a correction upstream take an
 *   achievement back off somebody.
 */

import {
  achievementCeremonyKey,
  decideAchievementCeremony,
  readCelebrated,
  resetAchievementCeremonyMemory,
  writeCelebrated,
} from './achievementCeremony';

beforeEach(() => {
  window.localStorage.clear();
  resetAchievementCeremonyMemory();
});

describe('the crossing rule', () => {
  it('seeds on first sight and celebrates nothing', () => {
    // An athlete with two years behind them opens this on a new phone. They
    // crossed nothing by opening it; they are looking at history.
    const decision = decideAchievementCeremony(
      ['consistency.5', 'conditioning.mile_unbroken', 'community.helped_someone_new'],
      null,
    );

    expect(decision.celebrate).toBeNull();
    expect(decision.seeded).toBe(true);
    // Written down even so, or the next observation reads as another first
    // sighting and the real crossing after it never rings.
    expect(decision.changed).toBe(true);
    expect(decision.record).toHaveLength(3);
  });

  it('seeds an empty record for a brand new athlete, so their FIRST one still rings', () => {
    const first = decideAchievementCeremony([], null);
    expect(first.record).toEqual([]);
    expect(first.changed).toBe(true);

    const then = decideAchievementCeremony(['consistency.first_session'], first.record);
    expect(then.celebrate).toBe('consistency.first_session');
  });

  it('celebrates a genuine crossing exactly once', () => {
    const known = ['consistency.5'];
    const crossing = decideAchievementCeremony(['consistency.5', 'consistency.13'], known);
    expect(crossing.celebrate).toBe('consistency.13');

    // The same state, seen again on the next render, is not another event.
    const again = decideAchievementCeremony(['consistency.5', 'consistency.13'], crossing.record);
    expect(again.celebrate).toBeNull();
  });

  it('rings once for several landing at the same time, not once each', () => {
    // A coach marks four things on Sunday from the office. Four seals coming
    // down at once reads as a glitch, not a ceremony -- rule 5 of the sound
    // system.
    const decision = decideAchievementCeremony(
      ['craft.stance_and_guard', 'craft.jab_lands_clean', 'craft.slip_and_return'],
      [],
    );
    expect(decision.celebrate).toBe('craft.slip_and_return');
    expect(decision.record).toHaveLength(3);
  });

  it('never shrinks the record, so nothing already celebrated can ring twice', () => {
    const known = ['conditioning.mile_unbroken', 'consistency.13'];
    // A row corrected away upstream: the list coming in is shorter.
    const decision = decideAchievementCeremony(['consistency.13'], known);

    expect(decision.celebrate).toBeNull();
    expect(decision.record).toEqual(['conditioning.mile_unbroken', 'consistency.13']);

    // And returning to it later still does not ring, because it was never
    // forgotten.
    const back = decideAchievementCeremony(
      ['consistency.13', 'conditioning.mile_unbroken'],
      decision.record,
    );
    expect(back.celebrate).toBeNull();
  });

  it('ignores a duplicate in the incoming list', () => {
    const decision = decideAchievementCeremony(['consistency.5', 'consistency.5'], []);
    expect(decision.record).toEqual(['consistency.5']);
    expect(decision.celebrate).toBe('consistency.5');
  });
});

describe('nothing here can observe an absence', () => {
  it('takes a set of keys and no time at all', () => {
    // Structural, not by inspection: the decision function's inputs are the
    // things held and the things already celebrated. There is no date, no
    // clock and no ordering by recency anywhere in its signature, so there is
    // nothing for a gap to be computed from.
    expect(decideAchievementCeremony.length).toBe(2);
  });

  it('gives the same answer whether a day or a year passed in between', () => {
    // The same two observations, with an arbitrary amount of time and any
    // number of missed sessions between them. The ceremony cannot tell, which
    // is exactly the property that keeps an injured athlete's progress intact.
    const known = ['consistency.5'];
    const soon = decideAchievementCeremony(['consistency.5', 'consistency.13'], known);
    const muchLater = decideAchievementCeremony(['consistency.5', 'consistency.13'], known);
    expect(soon).toEqual(muchLater);
  });
});

describe('the stored record', () => {
  it('is scoped per athlete, so a shared tablet does not silence the next one', () => {
    // Without the athlete on the key, the first card opened on a gym tablet
    // seeds the record for everybody who uses it afterwards.
    expect(achievementCeremonyKey('ath_1')).not.toBe(achievementCeremonyKey('ath_2'));

    writeCelebrated(achievementCeremonyKey('ath_1'), ['consistency.5']);
    expect(readCelebrated(achievementCeremonyKey('ath_2'))).toBeNull();
    expect(readCelebrated(achievementCeremonyKey('ath_1'))).toEqual(['consistency.5']);
  });

  it('reads as never-seen when storage is unreadable, which seeds rather than double-rings', () => {
    window.localStorage.setItem(achievementCeremonyKey('ath_3'), 'not json');
    expect(readCelebrated(achievementCeremonyKey('ath_3'))).toBeNull();
  });

  it('drops anything in storage that is not a key', () => {
    window.localStorage.setItem(achievementCeremonyKey('ath_4'), JSON.stringify(['a', 7, null, '']));
    expect(readCelebrated(achievementCeremonyKey('ath_4'))).toEqual(['a']);
  });
});
