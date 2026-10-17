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
// parent through it. Walks app/ and components/ source (tests excluded) for a
// literal '/guardian' or '/guardian/...' path.
test('no page or component links /guardian', () => {
  const root = path.resolve(__dirname, '../..');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
        if (/['"`]\/guardian(?:\/[^'"`]*)?['"`]/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(root, full));
        }
      }
    }
  };
  walk(path.join(root, 'app'));
  walk(path.join(root, 'components'));
  expect(hits).toEqual([]);
});
