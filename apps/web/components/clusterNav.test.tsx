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
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
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

// Lane AS4-4D4E (AS-4 part 4d; GO on #2128, Q3 = A, Q4 = A).
describe('the planning, film and Teach Shadow lines (app scrub CF-10, CS-13) and their tap size (CF-17, CS-11)', () => {
  test('Teach Shadow is its own line, and Film names no Teach Shadow page', () => {
    expect(COACH_CLUSTERS['teach-shadow']).toEqual([
      '/teach-shadow',
      '/teach-shadow/capture',
      '/teach-shadow/cut',
      '/teach-shadow/annotation',
      '/teach-shadow/agreement',
    ]);
    expect(COACH_CLUSTERS.film.some((href) => href.startsWith('/teach-shadow'))).toBe(false);
  });

  test('a coach on Teach Shadow sees the Teach Shadow line, not the Film Study pages', async () => {
    createPersistentRoleSession('coach');
    mockPath = '/teach-shadow/cut';
    await act(async () => {
      render(<ClusterNav cluster="teach-shadow" />);
    });
    expect(screen.getByRole('navigation', { name: 'Teach Shadow' })).toBeTruthy();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/teach-shadow', '/teach-shadow/capture', '/teach-shadow/annotation', '/teach-shadow/agreement']);
    expect(hrefs.some((href) => href!.startsWith('/coach/video'))).toBe(false);
  });

  test('a coach on Class plans sees the planning line with Library and Workout Templates', async () => {
    createPersistentRoleSession('coach');
    mockPath = '/coach/class-plans';
    await act(async () => {
      render(<ClusterNav cluster="planning" />);
    });
    expect(screen.getByText('Class plans').getAttribute('aria-current')).toBe('page');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/coach/library');
    expect(hrefs).toContain('/coach/workout-templates');
    expect(hrefs).not.toContain('/coach/class-plans');
  });

  test('every link in a line carries the tap-link class', async () => {
    createPersistentRoleSession('coach');
    mockPath = '/coach/workout-templates';
    await act(async () => {
      render(<ClusterNav cluster="planning" />);
    });
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(link.className.split(/\s+/)).toContain('tap-link');
  });

  test('globals.css lifts a tap-link to the 55px tap size on a kiosk surface only', () => {
    const css = fs.readFileSync(path.join(WEB, 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/\[data-surface="kiosk"\]\s+\.tap-link\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*var\(--tap\)/);
    // Opt-in by class: no bare link rule stretches links inside sentences.
    expect(css).not.toMatch(/\[data-surface="kiosk"\]\s+a\s*[,{]/);
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
