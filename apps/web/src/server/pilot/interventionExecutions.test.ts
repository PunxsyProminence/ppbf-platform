// Adherence and context vocabularies (module 026 slice 2). What these pin:
// adherence is a closed set of explicit states -- a percentage or invented
// grade is refused, not stored -- and trained context is a small factual
// vocabulary with no difficulty score. Absence is legal in both cases: the
// stored default 'unknown' is the honest state, never a guess.

import {
  ADHERENCE_STATES,
  TRAINED_CONTEXTS,
  adherenceError,
  trainedContextError,
} from './interventionExecutions';

test('absence is legal -- unknown stays unknown rather than being guessed', () => {
  expect(adherenceError(undefined)).toBeNull();
  expect(adherenceError(null)).toBeNull();
  expect(trainedContextError(undefined)).toBeNull();
  expect(trainedContextError(null)).toBeNull();
});

test('every explicit adherence state is accepted; fake percentages and grades are refused', () => {
  for (const state of ADHERENCE_STATES) {
    expect(adherenceError(state)).toBeNull();
  }
  expect(adherenceError('82%')).toMatch(/adherence must be one of/);
  expect(adherenceError('mostly')).toMatch(/adherence must be one of/);
  expect(adherenceError(0.82)).toMatch(/adherence must be one of/);
});

test('trained context is facts, not scores', () => {
  for (const context of TRAINED_CONTEXTS) {
    expect(trainedContextError(context)).toBeNull();
  }
  expect(trainedContextError('difficulty-8.2')).toMatch(/trained_context must be one of/);
  expect(trainedContextError(8.2)).toMatch(/trained_context must be one of/);
});
