// Which internal links a family is shown (#1593, PH-11 Q-A A): only a page the
// building map lists for parents, read as a browser will read the path.
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

import { parentMayOpenPath } from './parentResources';

describe('parentMayOpenPath', () => {
  test.each([
    '/help',
    '/parent/safety',
    '/parent/safety?tab=holds',
    '/parent/video#latest',
    '/parent/dashboard',
  ])('%s is a page a parent can open', (path) => {
    expect(parentMayOpenPath(path)).toBe(true);
  });

  test.each([
    '/admin',
    '/coach/drills',
    '/helpdesk',
    '/no-such-page',
    // A browser rewrites these to /admin before it asks for them.
    '/dashboard/../admin',
    '/dashboard/%2e%2e/admin',
    '/parent/./../admin',
    // These land on a parent page, but not on the one written: left out all
    // the same, so the written door is the one judged.
    '/admin/../parent/safety',
    '/admin/%2E%2E/help',
    // Another host, on a parent path: never the path written.
    '//elsewhere.example/parent/safety',
    'https://elsewhere.example/help',
  ])('%s is left out', (path) => {
    expect(parentMayOpenPath(path)).toBe(false);
  });
});
