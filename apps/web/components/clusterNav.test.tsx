/**
 * @jest-environment jsdom
 */

// Lane U2 (audit UX-A A-3, A-11, A-16; Jason 2026-10-17 "A: Cross-link now
// (Recommended)"): each group of coach pages shares one sub-nav line, the
// coach home links the clinic and The Morning Read, and nothing links a role
// to a page that refuses it.

import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import ClusterNav, { COACH_CLUSTERS, type CoachCluster } from './ClusterNav';
import { BUILDING, OPEN } from './buildingMap';
import { clearRoleSession, createPersistentRoleSession } from './roleSession';

let mockPath = '/coach/intelligence';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

afterEach(() => clearRoleSession());

const WEB = path.resolve(__dirname, '..');
const pageSource = (href: string) => fs.readFileSync(path.join(WEB, 'app', ...href.split('/').filter(Boolean), 'page.tsx'), 'utf8');
const gateOf = (source: string) => {
  const match = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
};
const ALL = Object.entries(COACH_CLUSTERS).flatMap(([cluster, hrefs]) => hrefs.map((href) => [cluster, href] as const));

// Every page of every group carries its line (the Decision Loop's waited
// for #1678, per Overwatch 2026-10-17, and is in now).
const PLACEMENT_PENDING = new Set<string>();

describe('the cluster lines', () => {
  test.each(ALL)('%s: %s has a door whose roles are exactly the page\'s gate', (_cluster, href) => {
    const door = BUILDING.find((d) => d.href === href);
    expect(door).toBeDefined();
    expect(door!.roles).not.toBe(OPEN);
    expect([...(door!.roles as readonly string[])].sort()).toEqual(gateOf(pageSource(href)));
  });

  test.each(ALL.filter(([, href]) => !PLACEMENT_PENDING.has(href)))('%s: %s carries its line', (cluster, href) => {
    const source = pageSource(href);
    expect(source).toContain(`<ClusterNav cluster="${cluster}" />`);
    expect(source).toContain("import ClusterNav from '@/components/ClusterNav';");
  });

  test('a coach on The Morning Read sees the whole group, the current page marked', async () => {
    createPersistentRoleSession('coach');
    mockPath = '/coach/intelligence';
    await act(async () => {
      render(<ClusterNav cluster="who-needs-me" />);
    });
    const nav = screen.getByRole('navigation', { name: 'Who needs you' });
    expect(nav).toBeTruthy();
    expect(screen.getByText('The Morning Read').getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/coach/performance-analytics',
      '/coach/passbook-gaps',
      '/coach/athlete-intelligence',
      '/coach/decision-loop',
    ]);
  });

  test('an admin is not shown a coach-only page', async () => {
    createPersistentRoleSession('admin');
    mockPath = '/coach/workout-templates';
    await act(async () => {
      render(<ClusterNav cluster="planning" />);
    });
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/coach/cards');
    expect(hrefs).toContain('/coach/session-scripts');
  });

  test.each(Object.keys(COACH_CLUSTERS) as CoachCluster[])('the %s line renders nothing with no session', async (cluster) => {
    let container: HTMLElement | undefined;
    await act(async () => {
      ({ container } = render(<ClusterNav cluster={cluster} />));
    });
    expect(container!.innerHTML).toBe('');
  });
});

describe('the coach home', () => {
  const workspace = fs.readFileSync(path.join(__dirname, 'CoachWorkspace.tsx'), 'utf8');
  const floor = fs.readFileSync(path.join(__dirname, 'CoachFloorFocus.tsx'), 'utf8');

  test('links the four clinic pages by their doors', () => {
    const clinic = workspace.match(/const CLINIC_DOORS = \[([^\]]*)\]/);
    expect(clinic).not.toBeNull();
    const hrefs = [...clinic![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/coach/sports-medicine', '/coach/injuries', '/coach/athlete-limits', '/coach/sparring-caps']);
    for (const href of hrefs) {
      const door = BUILDING.find((d) => d.href === href);
      expect(door && door.roles !== OPEN && door.roles.includes('coach')).toBe(true);
    }
    expect(workspace).toContain('{CLINIC_DOORS.map((door) => (');
  });

  test('"Needs you now" links The Morning Read as the full list', () => {
    expect(floor).toMatch(/<Link href="\/coach\/intelligence"[^>]*>Full list: The Morning Read<\/Link>/);
  });

  test('renders one h1: the tab masthead is an h2 under "Coach Workspace"', () => {
    expect(workspace).not.toMatch(/<h1[\s>]/);
    expect(pageSource('/coach/environment/intake-router')).toContain('roleLabel="Coach Workspace"');
  });

  test('the Morning Read door counts the reads the page makes', () => {
    const door = BUILDING.find((d) => d.href === '/coach/intelligence');
    expect(door?.hint).toMatch(/^Seven /);
    expect(pageSource('/coach/intelligence')).toContain('Seven reads');
  });
});
