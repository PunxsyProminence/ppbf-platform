import {
  calculateReadinessL14,
  calculateDeltaRPE,
  isDeltaRPELocked,
} from './readinessMath';

describe('readinessMath', () => {
  describe('calculateReadinessL14', () => {
    test('clamps extreme high inputs to 10.0', () => {
      expect(calculateReadinessL14(20, 0, 10)).toBe(10.0);
    });

    test('clamps extreme low inputs to 1.0', () => {
      expect(calculateReadinessL14(0, 10, 0)).toBe(1.0);
    });

    test('rounds to one decimal place after clamp', () => {
      // 8*1.25 - 3*0.45 + 5*0.3 = 10 - 1.35 + 1.5 = 10.15 -> clamped 10 -> 10.0
      expect(calculateReadinessL14(8, 3, 5)).toBe(10.0);

      // 6*1.25 - 6*0.45 + 4*0.3 = 7.5 - 2.7 + 1.2 = 6.0
      expect(calculateReadinessL14(6, 6, 4)).toBe(6.0);

      // 5*1.25 - 6*0.45 + 2*0.3 = 6.25 - 2.7 + 0.6 = 4.15 -> 4.2
      expect(calculateReadinessL14(5, 6, 2)).toBe(4.2);
    });

    test('handles low soreness as readiness lift while still clamped', () => {
      expect(calculateReadinessL14(7, 0, 6)).toBe(10.0);
    });
  });

  describe('calculateDeltaRPE', () => {
    test('returns observed minus intended', () => {
      expect(calculateDeltaRPE(8, 6)).toBe(2);
      expect(calculateDeltaRPE(5, 6)).toBe(-1);
    });
  });

  describe('isDeltaRPELocked', () => {
    test('locks when deltaRpe >= 2 and rationale is null/empty/whitespace', () => {
      expect(isDeltaRPELocked(2, null)).toBe(true);
      expect(isDeltaRPELocked(3, '')).toBe(true);
      expect(isDeltaRPELocked(2.5, '   ')).toBe(true);
    });

    test('does not lock when rationale exists', () => {
      expect(isDeltaRPELocked(2, 'Athlete reported poor sleep')).toBe(false);
      expect(isDeltaRPELocked(4, 'Technique focus day')).toBe(false);
    });

    test('does not lock when deltaRpe < 2', () => {
      expect(isDeltaRPELocked(1.9, null)).toBe(false);
      expect(isDeltaRPELocked(-1, '')).toBe(false);
    });
  });
});
