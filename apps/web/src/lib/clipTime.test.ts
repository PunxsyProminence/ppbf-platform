// The player's arithmetic, tested away from the player.
//
// Two of the three things this file pins are load-bearing for the study
// itself: the CLAMP is what keeps an annotator inside the sampled span, and
// the seconds/milliseconds conversion is what keeps a stored offset a whole
// integer the calibration modules will accept. The formatter is pinned because
// the display is the only evidence an annotator has of the number they are
// about to store.

import {
  MS_PER_SECOND,
  STEP_MS,
  clampMsToClip,
  formatDurationMs,
  formatMediaOffset,
  isSpanWithinClip,
  mediaSecondsFromMs,
  msFromMediaSeconds,
} from './clipTime';

describe('formatMediaOffset', () => {
  test('renders milliseconds in full rather than rounding them away', () => {
    expect(formatMediaOffset(0)).toBe('0:00.000');
    expect(formatMediaOffset(1_234)).toBe('0:01.234');
    expect(formatMediaOffset(1_274)).toBe('0:01.274');
    // Two marks 40ms apart must not print as the same number.
    expect(formatMediaOffset(1_234)).not.toBe(formatMediaOffset(1_274));
  });

  test('rolls over minutes and hours', () => {
    expect(formatMediaOffset(61_500)).toBe('1:01.500');
    expect(formatMediaOffset(3_600_000)).toBe('1:00:00.000');
    expect(formatMediaOffset(3_723_045)).toBe('1:02:03.045');
  });

  test('shows a negative offset rather than silently flooring it to zero', () => {
    expect(formatMediaOffset(-250)).toBe('-0:00.250');
  });

  test('reads as no-position rather than as a rendering bug when the media has none', () => {
    expect(formatMediaOffset(Number.NaN)).toBe('--:--.---');
    expect(formatMediaOffset(Number.POSITIVE_INFINITY)).toBe('--:--.---');
  });
});

describe('formatDurationMs', () => {
  test('reads as a duration, not a playhead', () => {
    expect(formatDurationMs(6_500)).toBe('6.5s');
    expect(formatDurationMs(0)).toBe('0.0s');
    expect(formatDurationMs(Number.NaN)).toBe('--');
  });
});

describe('clampMsToClip', () => {
  test('holds the playhead inside the clip in both directions', () => {
    expect(clampMsToClip(500, 1_000, 7_000)).toBe(1_000);
    expect(clampMsToClip(9_999, 1_000, 7_000)).toBe(7_000);
  });

  test('leaves a position inside the clip alone', () => {
    expect(clampMsToClip(4_200, 1_000, 7_000)).toBe(4_200);
  });

  test('is inclusive on both ends, matching the database containment CHECK', () => {
    expect(clampMsToClip(1_000, 1_000, 7_000)).toBe(1_000);
    expect(clampMsToClip(7_000, 1_000, 7_000)).toBe(7_000);
  });

  test('rounds to a whole millisecond so the result is storable', () => {
    expect(clampMsToClip(4_200.4, 1_000, 7_000)).toBe(4_200);
    expect(Number.isInteger(clampMsToClip(4_200.6, 1_000, 7_000))).toBe(true);
  });

  test('a non-finite playhead lands at the clip start, never in a form field as NaN', () => {
    expect(clampMsToClip(Number.NaN, 1_000, 7_000)).toBe(1_000);
  });
});

describe('isSpanWithinClip', () => {
  test('accepts a span inside the clip, including one that touches both ends', () => {
    expect(isSpanWithinClip(1_000, 7_000, 1_000, 7_000)).toBe(true);
    expect(isSpanWithinClip(2_000, 3_000, 1_000, 7_000)).toBe(true);
  });

  test('refuses a span that leaves the clip at either end', () => {
    expect(isSpanWithinClip(900, 3_000, 1_000, 7_000)).toBe(false);
    expect(isSpanWithinClip(6_000, 7_001, 1_000, 7_000)).toBe(false);
  });

  test('refuses a span that does not move forward', () => {
    expect(isSpanWithinClip(3_000, 3_000, 1_000, 7_000)).toBe(false);
    expect(isSpanWithinClip(3_500, 3_000, 1_000, 7_000)).toBe(false);
  });

  test('refuses a non-finite bound rather than treating it as zero', () => {
    expect(isSpanWithinClip(Number.NaN, 3_000, 1_000, 7_000)).toBe(false);
  });
});

describe('the DOM seconds boundary', () => {
  test('a float currentTime becomes a whole millisecond the modules accept', () => {
    const ms = msFromMediaSeconds(1.2340000000000002);
    expect(ms).toBe(1_234);
    expect(Number.isInteger(ms)).toBe(true);
  });

  test('a media element with no position yields zero rather than NaN', () => {
    expect(msFromMediaSeconds(Number.NaN)).toBe(0);
  });

  test('round-trips back to the seconds the element wants', () => {
    expect(mediaSecondsFromMs(1_234)).toBeCloseTo(1.234, 6);
    expect(MS_PER_SECOND).toBe(1_000);
  });
});

describe('the step ladder', () => {
  // The steps are milliseconds and are never described as frames anywhere --
  // the platform stores no frame rate, so a frame-labelled step would be a
  // precision claim nothing backs. This pins the values so a later "one frame"
  // rename has to argue with a test.
  test('every step is a whole number of milliseconds', () => {
    for (const step of Object.values(STEP_MS)) {
      expect(Number.isInteger(step)).toBe(true);
      expect(step).toBeGreaterThan(0);
    }
  });

  test('the ladder goes fine, small, large', () => {
    expect(STEP_MS.fine).toBeLessThan(STEP_MS.small);
    expect(STEP_MS.small).toBeLessThan(STEP_MS.large);
  });
});
