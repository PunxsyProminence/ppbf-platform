// The structured-exposure contract (module 026): exposure is a map of
// KNOWN dimension -> positive amount. What these pin: the dimension
// vocabulary is closed (an invented dimension like 'difficulty' is refused,
// not stored), amounts must be positive finite numbers, and absence is
// legal -- a protocol without exposure numbers is still a protocol.

import { EXPOSURE_DIMENSIONS, exposureShapeError } from './interventionProtocols';

test('absent exposure is legal -- a protocol is not required to quantify itself', () => {
  expect(exposureShapeError(undefined)).toBeNull();
  expect(exposureShapeError(null)).toBeNull();
  expect(exposureShapeError({})).toBeNull();
});

test('every dimension in the fixed vocabulary is accepted with a positive amount', () => {
  const exposure = Object.fromEntries(EXPOSURE_DIMENSIONS.map((d) => [d, 3]));
  expect(exposureShapeError(exposure)).toBeNull();
  expect(exposureShapeError({ rounds: 6, minutes: 0.5 })).toBeNull();
});

test('an invented dimension is refused by name -- no scalar dose sneaks in', () => {
  expect(exposureShapeError({ difficulty: 8.2 })).toMatch(/Unknown exposure dimension 'difficulty'/);
  expect(exposureShapeError({ dose: 1 })).toMatch(/Unknown exposure dimension 'dose'/);
});

test('non-positive, non-finite, and non-numeric amounts are refused', () => {
  expect(exposureShapeError({ rounds: 0 })).toMatch(/positive number/);
  expect(exposureShapeError({ rounds: -2 })).toMatch(/positive number/);
  expect(exposureShapeError({ rounds: Number.NaN })).toMatch(/positive number/);
  expect(exposureShapeError({ rounds: Number.POSITIVE_INFINITY })).toMatch(/positive number/);
  expect(exposureShapeError({ rounds: 'six' })).toMatch(/positive number/);
});

test('a non-object shape is refused outright', () => {
  expect(exposureShapeError([1, 2])).toMatch(/must be an object/);
  expect(exposureShapeError('rounds:6')).toMatch(/must be an object/);
  expect(exposureShapeError(7)).toMatch(/must be an object/);
});
