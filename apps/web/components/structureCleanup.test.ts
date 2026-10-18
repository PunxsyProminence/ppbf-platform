import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';
import * as roleRoutesModule from './roleRoutes';

/**
 * Lane U2 cleanup (audit UX-A A-13, A-14, A-16, 2026-10-16): the leftovers the
 * structure audit found after the larger fixes.
 */

const WEB = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('one table of homes (A-14)', () => {
  test('roleRoutes no longer answers where a role lands', () => {
    expect('getRoleRoute' in roleRoutesModule).toBe(false);
    for (const route of roleRoutesModule.roleRoutes) {
      expect(route).not.toHaveProperty('href');
    }
    // It still names every role, which /notices and the banner print.
    expect(roleRoutesModule.roleRoutes.find((r) => r.role === 'board-treasurer')?.label).toBeTruthy();
  });
});

describe('dead ends and duplicates (A-13)', () => {
  test('no screen links /public, a permanent redirect to /', () => {
    const offenders = [...sources(path.join(WEB, 'app')), ...sources(path.join(WEB, 'components'))]
      .filter((file) => /href=["'{`]+\/public["'`}]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  test('the disabled test wizard page is gone', () => {
    expect(fs.existsSync(path.join(WEB, 'app/admin/organizations/test'))).toBe(false);
  });
});

describe('doors and links that were missing (A-16)', () => {
  test('/admin/system is offered to the organization admin its page admits', () => {
    expect(read('app/admin/system/page.tsx')).toMatch(/requirePageRole\(\['platform_owner', 'organization_admin'\]\)/);
    expect(BUILDING.find((door) => door.href === '/admin/system')?.roles).toEqual(['admin', 'platform_owner']);
  });

  test('a board seat links the board\'s two reads', () => {
    const seat = read('app/board/BoardSeatWorkspace.tsx');
    expect(seat).toContain("{ label: 'Program Aggregates', href: '/board/aggregates' }");
    expect(seat).toContain("{ label: 'Escalation Ladder', href: '/board/escalation-monitoring' }");
  });
});
