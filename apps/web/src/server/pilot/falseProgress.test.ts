// False-progress classification (module 053). What these pin: the default
// is INSUFFICIENT EVIDENCE -- a thin record never flags in either
// direction; the false-progress flag fires only when practice is strong
// AND live is weak with real attempt counts on both sides; zero live
// attempts is its own honest state (untested, not failing); and the
// boundary arithmetic is exact so the thresholds cannot drift silently.

import {
  CONTROLLED_CONTEXTS,
  LIVE_CONTEXTS,
  MIN_ATTEMPTS_PER_SIDE,
  classifyTransfer,
} from './falseProgress';

test('unknown is not clear: thin records classify as insufficient evidence, never as a flag', () => {
  // No attempts at all.
  expect(classifyTransfer({ controlledMakes: 0, controlledMisses: 0, liveMakes: 0, liveMisses: 0 }))
    .toBe('insufficient_evidence');
  // Below the per-side minimum in practice, however perfect.
  expect(classifyTransfer({ controlledMakes: 2, controlledMisses: 0, liveMakes: 0, liveMisses: 5 }))
    .toBe('insufficient_evidence');
  // Practice weak -- there is no gain to test, so no transfer claim either way.
  expect(classifyTransfer({ controlledMakes: 3, controlledMisses: 7, liveMakes: 0, liveMisses: 5 }))
    .toBe('insufficient_evidence');
  // Live side exists but is too thin to compare (1-2 attempts).
  expect(classifyTransfer({ controlledMakes: 8, controlledMisses: 1, liveMakes: 0, liveMisses: 2 }))
    .toBe('insufficient_evidence');
});

test('the false-progress flag: strong in practice, weak live, with real counts both sides', () => {
  expect(classifyTransfer({ controlledMakes: 8, controlledMisses: 1, liveMakes: 1, liveMisses: 5 }))
    .toBe('not_transferring');
  // Exactly at the live-weak boundary (1/3 > 0.3 -> NOT flagged; 0.3 exactly is flagged).
  expect(classifyTransfer({ controlledMakes: 7, controlledMisses: 3, liveMakes: 3, liveMisses: 7 }))
    .toBe('not_transferring'); // 0.30 exactly
  expect(classifyTransfer({ controlledMakes: 7, controlledMisses: 3, liveMakes: 1, liveMisses: 2 }))
    .toBe('transferring'); // 1/3 = 0.333 clears the weak line
});

test('zero live attempts is untested, an honest state distinct from failing', () => {
  expect(classifyTransfer({ controlledMakes: 5, controlledMisses: 1, liveMakes: 0, liveMisses: 0 }))
    .toBe('untested_live');
});

test('holding up live classifies as transferring', () => {
  expect(classifyTransfer({ controlledMakes: 9, controlledMisses: 2, liveMakes: 4, liveMisses: 2 }))
    .toBe('transferring');
  // Exactly at the practice-strong boundary: 7/10 = 0.70 counts as strong.
  expect(classifyTransfer({ controlledMakes: 7, controlledMisses: 3, liveMakes: 4, liveMisses: 1 }))
    .toBe('transferring');
});

test('context classes are disjoint and deliberately exclude open_floor and film_study', () => {
  const controlled = new Set<string>(CONTROLLED_CONTEXTS);
  for (const live of LIVE_CONTEXTS) expect(controlled.has(live)).toBe(false);
  const all = new Set<string>([...CONTROLLED_CONTEXTS, ...LIVE_CONTEXTS]);
  expect(all.has('open_floor')).toBe(false);
  expect(all.has('film_study')).toBe(false);
  expect(MIN_ATTEMPTS_PER_SIDE).toBeGreaterThanOrEqual(3);
});
