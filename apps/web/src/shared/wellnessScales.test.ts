import { WELLNESS_COLUMNS } from '@/src/server/pilot/athleteCheckIns';

import {
  SLEEP_HOURS_MAX,
  SLEEP_HOURS_MIN,
  SLEEP_HOURS_TYPICAL_MAX,
  SLEEP_HOURS_TYPICAL_MIN,
  WELLNESS_SCALES,
  WELLNESS_SCALE_KEYS,
  WELLNESS_SCALE_MAX,
  WELLNESS_SCALE_MIN,
  wellnessAnchor,
} from './wellnessScales';

// The owner's requirement was not "collect more numbers", it was that the
// numbers say what they mean: "they need a description on what each number
// represents". These cases are about the ways a described scale stops being
// one -- an anchor missing, a scale and its column disagreeing, or a direction
// assumed rather than recorded.

describe('every scale describes all five of its numbers', () => {
  it.each(WELLNESS_SCALES.map((scale) => [scale.key, scale] as const))(
    '%s names 1 through 5',
    (_key, scale) => {
      expect(scale.anchors).toHaveLength(WELLNESS_SCALE_MAX - WELLNESS_SCALE_MIN + 1);
      for (const anchor of scale.anchors) {
        expect(anchor.trim()).not.toBe('');
      }
      // Two numbers sharing a description is a scale with four usable points
      // wearing a five-point label -- the athlete cannot tell them apart, so
      // neither can the stored value.
      expect(new Set(scale.anchors).size).toBe(scale.anchors.length);
      expect(scale.question.trim()).not.toBe('');
    },
  );

  it('records a direction for every scale rather than leaving it to be inferred', () => {
    // soreness and stress run the other way: 5 is a bad day. Nothing averages
    // these yet, and this is the assertion that makes the first thing that
    // does have to look.
    for (const scale of WELLNESS_SCALES) {
      expect(['higher_is_better', 'higher_is_worse']).toContain(scale.direction);
    }
    const reversed = WELLNESS_SCALES.filter((scale) => scale.direction === 'higher_is_worse')
      .map((scale) => scale.key)
      .sort();
    expect(reversed).toEqual(['soreness', 'stress']);
  });

  it('names each scale once', () => {
    expect(new Set(WELLNESS_SCALE_KEYS).size).toBe(WELLNESS_SCALE_KEYS.length);
  });
});

describe('the scales and the columns they label are the same set', () => {
  it('every stored wellness column has a described scale, and every scale has a column', () => {
    // THE DRIFT TRIPWIRE, and the reason this module is in src/shared rather
    // than beside either consumer.
    //
    // The server validates against these bounds and the athlete's screen
    // labels from these anchors. A measure added to the database and not here
    // would be collected as a bare number nobody described; a scale added here
    // and not to the database would be offered to a child and then discarded
    // on write. Both are silent, and both are the failure this pairing exists
    // to make loud.
    expect([...WELLNESS_SCALE_KEYS].sort()).toEqual([...WELLNESS_COLUMNS].sort());
  });
});

describe('wellnessAnchor', () => {
  it('returns the description for each stored value', () => {
    expect(wellnessAnchor('energy', 1)).toBe('Running on empty');
    expect(wellnessAnchor('energy', 5)).toBe('Full tank');
    expect(wellnessAnchor('stress', 5)).toBe('Very stressed');
  });

  it('renders absence as absence, never as a middle', () => {
    // The contract: stored null is "not reported", never 0 and never 3.
    expect(wellnessAnchor('energy', null)).toBeNull();
    expect(wellnessAnchor('energy', undefined)).toBeNull();
  });

  it('refuses values outside the scale rather than clamping them into it', () => {
    // Clamping would let an out-of-range number acquire a description and read
    // as a real answer on the athlete's own history.
    expect(wellnessAnchor('energy', 0)).toBeNull();
    expect(wellnessAnchor('energy', 6)).toBeNull();
    expect(wellnessAnchor('energy', 3.5)).toBeNull();
  });
});

describe('sleep is a quantity, not a rating', () => {
  it('has bounds but no anchors, and its control span sits inside its storage bounds', () => {
    // Sleep is deliberately absent from WELLNESS_SCALES: hours are measured,
    // ratings are judged, and giving hours anchor text would turn one into the
    // other.
    expect(WELLNESS_SCALE_KEYS).not.toContain('sleep_hours' as never);
    expect(SLEEP_HOURS_MIN).toBeLessThan(SLEEP_HOURS_TYPICAL_MIN);
    expect(SLEEP_HOURS_TYPICAL_MAX).toBeLessThan(SLEEP_HOURS_MAX);
    // A slider offering hours the column would refuse is a control that can
    // only produce a 400.
    expect(SLEEP_HOURS_TYPICAL_MIN).toBeGreaterThanOrEqual(SLEEP_HOURS_MIN);
    expect(SLEEP_HOURS_TYPICAL_MAX).toBeLessThanOrEqual(SLEEP_HOURS_MAX);
  });
});
