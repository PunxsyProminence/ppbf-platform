import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';

/**
 * ONE ADMIN HOME, ONE NAME PER HUB (lane U2, audit UX-A A-1, A-6, A-13).
 *
 * Jason 2026-10-17, glossary "A: Use these words (Recommended)": the gym
 * admin's home is the Gym Office (/admin/people), and each menu label equals
 * its page title. Before this, /admin answered to five names and /operations
 * to four, and admin pages sent people "back" to three different places.
 * "Capabilities" and "Operations" are PROPOSED names under that principle.
 */

const WEB = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'api' && entry.name !== 'node_modules') sourceFiles(full, found);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const SOURCES = [...sourceFiles(path.join(WEB, 'app')), ...sourceFiles(path.join(WEB, 'components'))].map(
  (file) => [path.relative(WEB, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const,
);

const door = (href: string) => BUILDING.find((d) => d.href === href);

describe('one admin home, one name per hub', () => {
  test.each([
    ['/admin/people', 'app/admin/people/page.tsx', 'Gym Office'],
    ['/admin', 'app/admin/page.tsx', 'Capabilities'],
    ['/operations', 'app/operations/page.tsx', 'Operations'],
  ])('%s: the door label is the page title, %s', (href, file, title) => {
    expect(door(href)?.label).toBe(title);
    expect(read(file)).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
  });

  test('no screen shows a retired hub name', () => {
    // Case-insensitive and across line breaks: a button label written in
    // capitals on its own line is still the name on the screen.
    const RETIRED = />\s*(?:Back to )?(?:Mission Control|The Ring|The Capability Room|Capability Room|Capability Console|Admin Hub|Admin Home|Admin Dashboard|Go To Admin Dashboard|the Front Office|the office)\s*</i;
    const offenders = SOURCES.filter(([, s]) => RETIRED.test(s)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test('no page hard-codes where an admin goes back to', () => {
    const HARD_BACK = /<(?:Link|OperationsLink)[^>]*>\s*Back to (?:Admin|admin|Mission Control|Operations|the Front Office|the office)\b/;
    const offenders = SOURCES.filter(([, s]) => HARD_BACK.test(s)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test('/launch, a second door onto /operations, is gone', () => {
    expect(fs.existsSync(path.join(WEB, 'app/launch'))).toBe(false);
  });
});

describe('the platform owner is not walked into "set per gym" notices (A-6)', () => {
  test.each(['/admin/people', '/admin/pin', '/admin/activation-codes', '/admin/video-review'])(
    'the %s door is not offered to the platform owner',
    (href) => {
      expect(door(href)?.roles).toEqual(['admin']);
    },
  );

  test('the gym wizard finishes on the way home, not on two per-gym consoles', () => {
    const wizard = read('app/admin/organizations/page.tsx');
    expect(wizard).not.toContain('Manage People');
    expect(wizard).not.toMatch(/<Link href="\/admin"/);
    expect(wizard).toMatch(/<BackHome className="btn flex-1" \/>/);
  });
});
