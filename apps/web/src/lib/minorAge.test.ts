// Lane AS-10, PR AS10-1: the age rule moved, unchanged, from wallDisplay.ts so
// a page can ask the same question the server asks. These hold that it is ONE
// rule in two places of import, and that the shared copy can load in a browser.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as minorAge from './minorAge';
import * as wallDisplay from '@/src/server/pilot/wallDisplay';

test('wallDisplay re-exports the very same rule, not a copy', () => {
  expect(wallDisplay.isMinor).toBe(minorAge.isMinor);
  expect(wallDisplay.ageInYears).toBe(minorAge.ageInYears);
  expect(wallDisplay.ADULT_AGE_YEARS).toBe(minorAge.ADULT_AGE_YEARS);
});

test('the rule is defined only in src/lib/minorAge.ts', () => {
  const wall = readFileSync(path.join(__dirname, '../server/pilot/wallDisplay.ts'), 'utf8');
  expect(wall).not.toMatch(/export (?:function isMinor|function ageInYears|const ADULT_AGE_YEARS)/);
});

test('the shared copy imports nothing a browser cannot load', () => {
  const source = readFileSync(path.join(__dirname, 'minorAge.ts'), 'utf8');
  const imports = Array.from(source.matchAll(/from '([^']+)'/g)).map((match) => match[1]);
  expect(imports).toEqual(['@/src/lib/gymTime']);
});

test('unknown is a minor; 18 on the gym\'s day is not', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  expect(minorAge.isMinor(null, now)).toBe(true);
  expect(minorAge.isMinor('not a date', now)).toBe(true);
  expect(minorAge.isMinor('2008-11-20', now)).toBe(false);
  expect(minorAge.isMinor('2008-11-21', now)).toBe(true);
});
