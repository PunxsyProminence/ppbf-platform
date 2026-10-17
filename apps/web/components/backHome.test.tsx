/**
 * @jest-environment jsdom
 */

// Lane U2 (audit UX-A A-5/A-7): the one back link goes to the reader's own
// home, so it can never open a page that refuses them.

import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import BackHome, { backHomeTarget } from './BackHome';
import { clearRoleSession, createPersistentRoleSession, getPilotRoleDestination } from './roleSession';
import type { ClubRole } from './roleRoutes';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

afterEach(() => {
  clearRoleSession();
});

const APP_DIR = path.resolve(__dirname, '../app');

/** The allowedRoles literal a page passes to its gate, or null when it has none. */
function pageAllowedRoles(route: string): string[] | null {
  const file = path.join(APP_DIR, ...route.split('/').filter(Boolean), 'page.tsx');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;
}

const CASES: ReadonlyArray<readonly [ClubRole, string, string]> = [
  ['coach', '/coach/environment/intake-router', 'Back to Coach Workspace'],
  ['admin', '/admin/people', 'Back to Gym Office'],
  ['platform_owner', '/admin/platform', 'Back to Omega'],
  ['athlete', '/athlete/dashboard', 'Back to Athlete Workspace'],
  ['parent', '/parent/dashboard', 'Back to Parent Hub'],
  ['board', '/board', 'Back to Board Hub'],
  ['staff', '/workspace', 'Back to Staff Workspace'],
  ['volunteer', '/workspace', 'Back to Volunteer Workspace'],
];

describe('BackHome', () => {
  test.each(CASES)('a %s goes back to %s', async (role, href, label) => {
    createPersistentRoleSession(role);
    await act(async () => {
      render(<BackHome />);
    });
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(href);
    // The same answer sign-in gives, never a second table.
    expect(href).toBe(getPilotRoleDestination(role));
  });

  // "Never bounces": the home page's own gate names this role. Omega and the
  // board hub gate elsewhere (a role check in the page, a layout gate), so
  // they are listed rather than silently skipped.
  const GATED_ELSEWHERE = new Set(['/admin/platform', '/board']);
  test.each(CASES)('a %s is admitted by its home, %s', (role, href) => {
    const roles = pageAllowedRoles(href);
    if (GATED_ELSEWHERE.has(href)) {
      expect(roles).toBeNull();
    } else {
      expect(roles).toContain(role);
    }
  });

  // Jason 2026-10-17, glossary A: each label equals its page title.
  test.each(CASES)('a %s reads the title of the home it opens, %s', (_role, href, label) => {
    const title = label.replace(/^Back to /, '');
    const file = path.join(APP_DIR, ...href.split('/').filter(Boolean), 'page.tsx');
    const source = fs.readFileSync(file, 'utf8');
    const staffTitle = /\$\{roleLabel\} Workspace/.test(source) && / Workspace$/.test(title);
    expect(source.includes(`>${title}<`) || source.includes(`roleLabel="${title}"`) || staffTitle).toBe(true);
  });

  test('a board member with a seat goes back to their seat', async () => {
    createPersistentRoleSession('board', 'president');
    await act(async () => {
      render(<BackHome />);
    });
    // The seat page's own title (BoardMemberDashboard.tsx: "<seatLabel> Workspace").
    expect(screen.getByRole('link', { name: 'Back to President Workspace' }).getAttribute('href')).toBe('/board/president');
    expect(backHomeTarget({ role: 'board', expiresAt: Date.now() + 1000 }).href).toBe('/board');
  });

  test('with no session it points at /dashboard, which resolves the role on the server', async () => {
    await act(async () => {
      render(<BackHome />);
    });
    expect(screen.getByRole('link', { name: 'Back to your home page' }).getAttribute('href')).toBe('/dashboard');
  });

  test('keeps the class the page passes', async () => {
    createPersistentRoleSession('coach');
    await act(async () => {
      render(<BackHome className="btn btn--ghost mt-[var(--s4)]" />);
    });
    expect(screen.getByRole('link').className).toBe('btn btn--ghost mt-[var(--s4)]');
  });
});
