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
import { jobBarFor } from './jobBars';
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

  test('an athlete on the sparring log sees no line: one page is nowhere to go', async () => {
    createPersistentRoleSession('athlete');
    mockPath = '/athlete/dashboard/sparring';
    let container: HTMLElement | undefined;
    await act(async () => {
      ({ container } = render(<ClusterNav cluster="sparring" />));
    });
    expect(container!.innerHTML).toBe('');
  });

  // Lane AS-5 (app scrub CS-02): the clinic's records of one athlete.
  test('a coach on the Clearance Board sees the Clinic line, the board marked', async () => {
    createPersistentRoleSession('coach');
    mockPath = '/coach/sports-medicine';
    await act(async () => {
      render(<ClusterNav cluster="clinic" />);
    });
    expect(screen.getByRole('navigation', { name: 'Clinic' })).toBeTruthy();
    expect(screen.getByText('Clearance Board').getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/coach/athlete-safety',
      '/coach/sparring-exposure',
    ]);
  });

  // Lane AS-5 (app scrub CS-06, Q9 = A): the athlete's own log is not on the
  // coach's line.
  test('a coach\'s Sparring line names the coach pages, not the athlete\'s Sparring Log', async () => {
    expect(COACH_CLUSTERS.sparring).not.toContain('/athlete/dashboard/sparring');
    createPersistentRoleSession('coach');
    mockPath = '/coach/sparring-caps';
    await act(async () => {
      render(<ClusterNav cluster="sparring" />);
    });
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/coach/sparring-exposure',
      '/coach/athlete-limits',
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

  /* The four clinic pages (lane U2, audit UX-A A-3) were a Clinic row on the
     Dashboard; since lane 6C7's 7a-2 they are in the home's Safety job, which
     draws the coach job bar's Safety section (stage 2 section 3.4 row 22).
     coachHomeLayout.test.tsx pins the rendered links. */
  test('links the four clinic pages by their doors, through the Safety job', () => {
    const safety = jobBarFor('coach')?.sections.find((section) => section.label === 'Safety');
    const hrefs = (safety?.items ?? []).map((item) => item.href);
    for (const href of ['/coach/sports-medicine', '/coach/athlete-safety', '/coach/athlete-limits', '/coach/sparring-caps']) {
      expect(hrefs).toContain(href);
      const door = BUILDING.find((d) => d.href === href);
      expect(door && door.roles !== OPEN && door.roles.includes('coach')).toBe(true);
    }
    expect(workspace).toMatch(/\{ section: 'Safety', title: 'Safety'/);
    expect(workspace).toContain("{activeTab === 'dashboard' && <CoachHomeJobs />}");
  });

  // "Needs you now" is the home's strip since lane 6C7's 7b (it was the floor board's card).
  test('"Needs you now" links The Morning Read, not as the full list (CS-04)', () => {
    const strip = fs.readFileSync(path.join(__dirname, 'CoachNeedsYouStrip.tsx'), 'utf8');
    expect(strip).toMatch(/<Link href="\/coach\/intelligence"[^>]*>More reads: The Morning Read<\/Link>/);
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
