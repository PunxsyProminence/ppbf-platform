import fs from 'node:fs';
import path from 'node:path';

import {
  CONSISTENCY_THRESHOLDS,
  DEFAULT_PROGRAM,
  MILESTONES,
  PROGRAMS,
  RECOGNITION_KINDS,
  RECOGNITION_PHRASES,
  TRACKS,
  TRACK_META,
  earnedMilestoneKeys,
  isRecognitionKind,
  milestonesFor,
  pathProgress,
  sessionCountMilestoneKeys,
  tracksFor,
} from './achievementPaths';

/**
 * The catalogue is program design, so these are not unit tests of arithmetic --
 * they are the four rules in achievementPaths.ts, asserted against the data.
 *
 * Every one of them exists because the failure it catches is silent. A
 * milestone quietly worded as "three weeks running" reads fine in a diff and is
 * a streak. A track added to the competitive programme and forgotten everywhere
 * else turns a fitness member's path back into a boxing ladder with the
 * fighting greyed out. Neither breaks a build.
 */

describe('nothing in the catalogue can punish an absence', () => {
  // The vocabulary of streaks, decay and required cadence. If one of these
  // words is the right word for a new milestone, the milestone is wrong.
  const STREAK_WORDS = [
    'streak', 'in a row', 'consecutive', 'unbroken week', 'every week',
    'don\'t break', 'do not break', 'chain', 'daily', 'each week', 'per week',
    'this month', 'last month', 'within', 'since your last', 'lapsed',
    'expired', 'expires', 'missed', 'absent', 'attendance rate', 'comeback',
  ];

  test.each(MILESTONES)('$key says nothing about a gap or a cadence', (milestone) => {
    const prose = `${milestone.label} ${milestone.family}`.toLowerCase();
    for (const word of STREAK_WORDS) {
      expect(prose).not.toContain(word);
    }
  });

  test('every count-based milestone is a cumulative total, never a rate', () => {
    for (const milestone of MILESTONES) {
      if (milestone.evidence !== 'session_count') {
        expect(milestone.threshold).toBeUndefined();
        continue;
      }
      expect(typeof milestone.threshold).toBe('number');
      expect(milestone.threshold).toBeGreaterThan(0);
    }

    // A cumulative series only ever goes up, so the thresholds must be strictly
    // increasing. A series with a repeat or a dip would mean two milestones
    // landing at the same count, which is the shape a "reset" would take.
    const ascending = [...CONSISTENCY_THRESHOLDS].sort((a, b) => a - b);
    expect([...CONSISTENCY_THRESHOLDS]).toEqual(ascending);
    expect(new Set(CONSISTENCY_THRESHOLDS).size).toBe(CONSISTENCY_THRESHOLDS.length);
  });

  test('a three-month gap takes nothing away — the count is the only input', () => {
    // Somebody trains to 40 sessions, is hurt, comes back months later and logs
    // one more. The safety gate that locked them out is exactly the case the
    // no-streaks argument is about: what they hold must not have moved.
    const beforeInjury = earnedMilestoneKeys({
      completedSessions: 40,
      awardedKeys: ['conditioning.mile_unbroken', 'community.helped_someone_new'],
    });

    const afterMonthsAway = earnedMilestoneKeys({
      completedSessions: 41,
      awardedKeys: ['conditioning.mile_unbroken', 'community.helped_someone_new'],
    });

    for (const key of beforeInjury) {
      expect(afterMonthsAway).toContain(key);
    }
    expect(afterMonthsAway.length).toBeGreaterThanOrEqual(beforeInjury.length);
  });

  test('the count function takes a number and nothing else', () => {
    // Guards the property structurally rather than by inspection: a function
    // whose only parameter is a count cannot observe a date, and a function
    // that cannot observe a date cannot observe a gap.
    expect(sessionCountMilestoneKeys.length).toBe(1);
    expect(sessionCountMilestoneKeys(0)).toEqual([]);
    expect(sessionCountMilestoneKeys(1)).toEqual(['consistency.first_session']);
    expect(sessionCountMilestoneKeys(13)).toContain('consistency.13');
    expect(sessionCountMilestoneKeys(13)).not.toContain('consistency.34');
  });

  test('the consistency series never contradicts the training card', () => {
    // The card owns MILESTONES and this file owns CONSISTENCY_THRESHOLDS.
    // Drift between them would tell one athlete two different numbers on two
    // panels of the same screen. Read as source rather than imported: the card
    // is a client component whose import chain pulls in Web Audio.
    const card = fs.readFileSync(
      path.resolve(__dirname, '../../components/TrainingCard.tsx'),
      'utf8',
    );
    const declared = /export const MILESTONES = \[([^\]]+)\]/.exec(card);
    expect(declared).not.toBeNull();

    const cardSeries = declared![1]
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));

    expect(cardSeries.length).toBeGreaterThan(0);
    for (const threshold of cardSeries) {
      expect([...CONSISTENCY_THRESHOLDS]).toContain(threshold);
    }
  });
});

describe('nothing in the catalogue ranks one athlete against another', () => {
  test('no milestone carries a score, a weight, a tier or an ordinal', () => {
    // Ranking needs a comparable per-athlete number. The catalogue's job is to
    // never hand one out, so the assertion is over the SHAPE: these are the
    // only keys a milestone has.
    const allowed = new Set(['key', 'track', 'label', 'family', 'evidence', 'threshold']);
    for (const milestone of MILESTONES) {
      for (const field of Object.keys(milestone)) {
        expect(allowed.has(field)).toBe(true);
      }
    }
  });

  test('the only comparison any milestone makes is against the athlete themselves', () => {
    // Deliberately not the bare word "beat": beating your own earlier time is
    // the one comparison this catalogue permits, and it is a comparison of one
    // person to one person. What is banned is beating SOMEBODY ELSE.
    const COMPARATIVE = [
      'best in', 'fastest in', 'top ', 'rank', 'leader', 'beat everyone',
      'beat the others', 'beat the rest', 'first in the gym', 'ahead of',
      'better than',
    ];
    for (const milestone of MILESTONES) {
      const prose = `${milestone.label} ${milestone.family}`.toLowerCase();
      for (const phrase of COMPARATIVE) {
        expect(prose).not.toContain(phrase);
      }
    }

    // The one comparative milestone in the catalogue compares somebody to their
    // own earlier self, which is one person and one person.
    const ownBest = MILESTONES.find((m) => m.key === 'conditioning.mile_faster_than_before');
    expect(ownBest?.label.toLowerCase()).toContain('your own');
  });

  test('the four programmes are alternatives, not a ladder', () => {
    // A defaulted programme must not be the fight path: a system that assumes
    // everyone is competing is the system this catalogue replaces.
    expect(PROGRAMS).toHaveLength(4);
    expect(DEFAULT_PROGRAM).not.toBe('competitive');

    // No programme is a superset of every other, which is what a ladder would
    // look like expressed as sets. Competitive has one extra track; the other
    // three are identical, so none of them is "below" another.
    expect(new Set(tracksFor('fitness'))).toEqual(new Set(tracksFor('recreational')));
    expect(new Set(tracksFor('fitness'))).toEqual(new Set(tracksFor('youth')));
  });
});

describe('a fitness-only member has a complete path, not a boxing ladder with rungs greyed out', () => {
  const fitness = milestonesFor('fitness');

  test('their path is substantial in its own right', () => {
    // Not a token track. If this number ever collapses, somebody has quietly
    // moved the real progression back behind the competition track.
    expect(fitness.length).toBeGreaterThanOrEqual(30);
  });

  test('they get four full tracks, each with several milestones', () => {
    const tracks = tracksFor('fitness');
    expect([...tracks]).toEqual(['consistency', 'conditioning', 'craft', 'community']);

    for (const track of tracks) {
      expect(fitness.filter((m) => m.track === track).length).toBeGreaterThanOrEqual(5);
    }
  });

  test('the competition track is ABSENT for them, never present-and-locked', () => {
    // The distinction this asserts is the whole point. A rung that is rendered
    // and unreachable tells somebody they are the incomplete version of
    // somebody else; a rung that was never handed to the renderer cannot.
    expect(fitness.some((m) => m.track === 'competition')).toBe(false);

    const drawn = pathProgress('fitness', { completedSessions: 3, awardedKeys: [] });
    expect(drawn.map((t) => t.track)).not.toContain('competition');

    // And there is no shape in which a caller could draw one: every track
    // returned carries only earned/ahead, with no "available: false" variant.
    for (const track of drawn) {
      expect(Object.keys(track).sort()).toEqual(['ahead', 'earned', 'meta', 'track']);
    }
  });

  test('a competitive athlete gets the same four plus one, not a different system', () => {
    const competitive = milestonesFor('competitive');
    for (const milestone of fitness) {
      expect(competitive).toContainEqual(milestone);
    }
    expect(competitive.length).toBeGreaterThan(fitness.length);
  });
});

describe('nothing encodes health, injury, clearance or discipline', () => {
  test('no milestone states a permission or a medical fact', () => {
    const FORBIDDEN = [
      'cleared', 'clearance', 'medical', 'injur', 'concussion', 'doctor',
      'physio', 'restricted', 'suspended', 'banned', 'discipline', 'punish',
      'warning', 'weight class', 'body fat', 'bmi',
    ];
    for (const milestone of MILESTONES) {
      const prose = `${milestone.key} ${milestone.label} ${milestone.family}`.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(prose).not.toContain(word);
      }
    }
  });

  test('an unearned milestone carries no reason it is unearned', () => {
    // If an unearned entry could say WHY, its absence would be readable
    // backwards -- "not cleared", "not allowed", "not good enough". The shape
    // makes that impossible: `ahead` holds the same Milestone objects as
    // `earned`, with no extra field to hold a reason.
    const drawn = pathProgress('competitive', { completedSessions: 0, awardedKeys: [] });
    for (const track of drawn) {
      for (const milestone of track.ahead) {
        expect(MILESTONES).toContainEqual(milestone);
      }
    }
  });
});

describe('recognition is a closed positive vocabulary', () => {
  test('there is no negative value to send', () => {
    const NEGATIVE = [
      'concern', 'incident', 'warning', 'violation', 'discipline', 'late',
      'missed', 'poor', 'bad', 'refused', 'disrespect', 'attitude',
    ];
    for (const kind of RECOGNITION_KINDS) {
      for (const word of NEGATIVE) {
        expect(kind.toLowerCase()).not.toContain(word);
      }
    }

    // And nothing outside the closed set is accepted at all, so a caller cannot
    // invent one.
    expect(isRecognitionKind('concern')).toBe(false);
    expect(isRecognitionKind('needs_improvement')).toBe(false);
    expect(isRecognitionKind('helped_someone')).toBe(true);
  });

  test('every kind has a sentence a person would actually say, in both voices', () => {
    expect(RECOGNITION_PHRASES).toHaveLength(RECOGNITION_KINDS.length);
    for (const phrase of RECOGNITION_PHRASES) {
      expect(RECOGNITION_KINDS).toContain(phrase.kind);
      // A whole sentence, not a tag: what lands on an athlete's screen has to
      // read as something somebody said.
      expect(phrase.said.length).toBeGreaterThan(15);
      expect(phrase.said.trim().endsWith('.')).toBe(true);
      expect(phrase.family.length).toBeGreaterThan(10);
      // Short enough to read at a glance with taped hands.
      expect(phrase.button.length).toBeLessThanOrEqual(24);
    }
  });

  test('no recognition phrase carries a number', () => {
    // A count inside the phrase ("your 5th this month") would be a per-athlete
    // quantity on the face of the thing, which is where a ranking starts.
    for (const phrase of RECOGNITION_PHRASES) {
      expect(`${phrase.said} ${phrase.family} ${phrase.button}`).not.toMatch(/\d/);
    }
  });
});

describe('the family framing translates rather than truncates', () => {
  test('every milestone and every track has both voices, and they differ', () => {
    for (const milestone of MILESTONES) {
      expect(milestone.label.trim().length).toBeGreaterThan(0);
      expect(milestone.family.trim().length).toBeGreaterThan(0);
      // Same fact, different reader. Identical strings would mean somebody
      // skipped the translation rather than deciding it needed none.
      expect(milestone.family).not.toBe(milestone.label);
    }

    for (const track of TRACKS) {
      expect(TRACK_META[track].family.trim().length).toBeGreaterThan(0);
      expect(TRACK_META[track].label.trim().length).toBeGreaterThan(0);
    }
  });

  test('the family voice carries no gym jargon and no scores', () => {
    const JARGON = ['rpe', 'rir', 'tempo', 'periodization', 'volume load', '%', 'score'];
    for (const milestone of MILESTONES) {
      const family = milestone.family.toLowerCase();
      for (const word of JARGON) {
        expect(family).not.toContain(word);
      }
    }
  });

  test('every catalogue key is unique', () => {
    const keys = MILESTONES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
