import fs from 'node:fs';
import path from 'node:path';

import { permanentRedirect } from 'next/navigation';

import GuardianPage from './page';
import GuardianDashboardPage from './dashboard/page';

jest.mock('next/navigation', () => ({
  permanentRedirect: jest.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

beforeEach(() => jest.mocked(permanentRedirect).mockClear());

test('/guardian forwards permanently to the Parent Hub', () => {
  expect(() => GuardianPage()).toThrow('NEXT_REDIRECT');
  expect(permanentRedirect).toHaveBeenCalledWith('/parent/dashboard');
});

test('/guardian/dashboard forwards permanently to the Parent Hub', () => {
  expect(() => GuardianDashboardPage()).toThrow('NEXT_REDIRECT');
  expect(permanentRedirect).toHaveBeenCalledWith('/parent/dashboard');
});

// A redirect is not a destination: nothing in the app should still send a
// parent through it. Walks app/, components/, src/ and lib/ source (tests
// excluded) for a literal '/guardian' path, bare or followed by '/', '?' or '#'.
const GUARDIAN_LITERAL = /['"`]\/guardian(?:[/?#][^'"`]*)?['"`]/;

test('the literal-path check catches every form of the address', () => {
  for (const hit of ["'/guardian'", '"/guardian/dashboard"', '`/guardian?from=hub`', "'/guardian#consent'"]) {
    expect(hit).toMatch(GUARDIAN_LITERAL);
  }
  for (const miss of ["'/guardians'", "'/guardian-consent'", "'/api/pilot/guardian'", "'/parent/dashboard'"]) {
    expect(miss).not.toMatch(GUARDIAN_LITERAL);
  }
});

test('no page or component links /guardian', () => {
  const root = path.resolve(__dirname, '../..');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Lane U2 removes the /operations 'The Stands' link to /guardian.
      if (path.relative(root, full).split(path.sep).join('/') === 'app/operations/page.tsx') continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
        if (GUARDIAN_LITERAL.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(root, full));
        }
      }
    }
  };
  walk(path.join(root, 'app'));
  walk(path.join(root, 'components'));
  walk(path.join(root, 'src'));
  walk(path.join(root, 'lib'));
  expect(hits).toEqual([]);
});
