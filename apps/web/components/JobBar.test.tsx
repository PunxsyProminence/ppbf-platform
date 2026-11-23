/**
 * @jest-environment jsdom
 */

// THE JOB BAR (AS-4, U2-4b). It draws jobBarFor (jobBars.ts, 4a): each role's
// sections from the App Scrub stage 2 file (S2-2 A, OD-2026-11-19-008), as
// leather tags on a tablet or desk and a plain bar on a phone (scrub Q13 A,
// OD-2026-11-19-009). The one property that is not a look: the bar never shows
// a page the person cannot open, and a board seat it cannot confirm is never
// drawn (it fails closed).

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import JobBar, { PARENT_HUB_OPENS_TAB, PARENT_HUB_TAB_LABEL } from './JobBar';
import * as buildingMap from './buildingMap';
import { JOB_BARS } from './jobBars';
import { getRoleSessionSnapshot } from './roleSession';
import type { ClubRole } from './roleRoutes';

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(() => '/dashboard'),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

jest.mock('./roleSession', () => ({
  getRoleSessionSnapshot: jest.fn(),
  subscribeRoleSession: () => () => {},
}));

const mockPathname = usePathname as jest.MockedFunction<typeof usePathname>;
const mockSnapshot = getRoleSessionSnapshot as jest.MockedFunction<typeof getRoleSessionSnapshot>;

const ROLES_WITH_BARS = Object.keys(JOB_BARS) as ClubRole[];

function signIn(role: ClubRole | null, extra: Record<string, unknown> = {}) {
  mockSnapshot.mockReturnValue(role === null ? null : ({ role, expiresAt: Date.now() + 60_000, ...extra } as never));
}

/** Opens every section's sheet in turn and returns every link the bar offers, sheets included. */
function everyHref(container: HTMLElement): string[] {
  const hrefs = new Set<string>();
  const collect = () => container.querySelectorAll('a[href]').forEach((a) => hrefs.add(a.getAttribute('href') ?? ''));
  collect();
  const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'));
  for (const toggle of toggles) {
    fireEvent.click(toggle);
    collect();
    fireEvent.click(toggle);
  }
  return [...hrefs];
}

const pathOf = (href: string) => href.split('?')[0];

beforeEach(() => {
  mockPathname.mockReturnValue('/dashboard');
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockSnapshot.mockReset();
});

describe.each(['rail', 'phone'] as const)('the %s bar', (variant) => {
  it.each(ROLES_WITH_BARS)('offers a %s only pages visibleDoors gives them', (role) => {
    signIn(role);
    const { container } = render(<JobBar variant={variant} />);
    const open = new Set(buildingMap.visibleDoors(role, { boardSeats: [] }).map((door) => door.href));
    const hrefs = everyHref(container);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(open.has(pathOf(href))).toBe(true);
  });

  it('never draws a page visibleDoors hides, even one the role\'s bar data names', () => {
    // Today's data names no page a role cannot open, so a bar drawn from JOB_BARS
    // directly would pass the test above. Hide two of the coach's pages and check
    // the bar follows the door list, not the data.
    const real = buildingMap.visibleDoors;
    jest
      .spyOn(buildingMap, 'visibleDoors')
      .mockImplementation((role, viewer) =>
        real(role, viewer).filter((door) => door.href !== '/coach/class' && door.href !== '/coach/passbook'),
      );
    signIn('coach');
    const { container } = render(<JobBar variant={variant} />);
    const hrefs = everyHref(container).map(pathOf);
    expect(hrefs).not.toContain('/coach/class');
    expect(hrefs).not.toContain('/coach/passbook');
    expect(hrefs).toContain('/schedule');
  });

  it('drops a section every page of which is hidden', () => {
    const real = buildingMap.visibleDoors;
    jest
      .spyOn(buildingMap, 'visibleDoors')
      .mockImplementation((role, viewer) => real(role, viewer).filter((door) => door.href !== '/admin/platform/overview'));
    signIn('platform_owner');
    render(<JobBar variant={variant} />);
    const nav = screen.getByRole('navigation', { name: 'Your jobs' });
    expect(within(nav).queryByText('Gyms')).toBeNull();
    expect(within(nav).getByText('Onboard')).toBeTruthy();
  });

  describe('a board member: the seat fails closed', () => {
    it('shows no seat workspace from the cached landing seat alone, and draws Board Hub once', () => {
      // The role session carries the landing seat; the held seats live only in
      // the board gate's context, which sits below this bar. Unconfirmed, the
      // landing seat is not drawn: Home is Board Hub.
      signIn('board', { boardSeat: 'treasurer' });
      const { container } = render(<JobBar variant={variant} />);
      const hrefs = everyHref(container).map(pathOf);
      expect(hrefs.some((href) => /^\/board\/(president|chair|vice-chair|treasurer|secretary|safety-director|community-director|at-large)$/.test(href))).toBe(false);
      expect(hrefs.filter((href) => href === '/board')).toHaveLength(1);
      expect(container.querySelectorAll('a[href="/board"]')).toHaveLength(1);
    });

    it('under the board gate, draws the landing seat only when the held seats list it, and no other seat', () => {
      // Not reachable today (the gate's provider sits inside the board pages,
      // below this bar), but if the bar is ever mounted under it, the held seats
      // are the truth (review round 1, NIT 1).
      const gate = jest.requireActual('./BoardRoleGate') as typeof import('./BoardRoleGate');
      const seats = jest.spyOn(gate, 'useBoardSession');
      seats.mockReturnValue({ seats: ['chair', 'treasurer'] } as never);
      signIn('board', { boardSeat: 'chair' });
      const held = render(<JobBar variant={variant} />);
      let hrefs = everyHref(held.container).map(pathOf);
      expect(hrefs).toContain('/board/chair');
      expect(hrefs).not.toContain('/board/treasurer');
      cleanup();

      seats.mockReturnValue({ seats: ['treasurer'] } as never);
      signIn('board', { boardSeat: 'chair' });
      const stale = render(<JobBar variant={variant} />);
      hrefs = everyHref(stale.container).map(pathOf);
      expect(hrefs).not.toContain('/board/chair');
      expect(hrefs).not.toContain('/board/treasurer');
      expect(hrefs).toContain('/board');
    });

    it('lists Aggregates, Escalations and Compliance', () => {
      signIn('board');
      const { container } = render(<JobBar variant={variant} />);
      const hrefs = everyHref(container);
      expect(hrefs).toEqual(
        expect.arrayContaining(['/board/aggregates', '/board/escalation-monitoring', '/board/compliance-monitoring']),
      );
    });
  });

  it.each([
    ['nobody is signed in', null, '/dashboard'],
    ['an athlete (no bar: Q14 A)', 'athlete', '/athlete/dashboard'],
    ['a coach on /login', 'coach', '/login'],
    ['a coach on the wall display', 'coach', '/wall'],
  ] as const)('draws nothing for %s', (_label, role, path) => {
    signIn(role);
    mockPathname.mockReturnValue(path);
    const { container } = render(<JobBar variant={variant} />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('draws nothing on a screen refusing this session in place', () => {
    const refused = buildingMap.BUILDING.find(
      (door) => door.refusesInPlace && door.roles !== buildingMap.OPEN && !door.roles.includes('board'),
    );
    expect(refused).toBeTruthy();
    signIn('board');
    mockPathname.mockReturnValue(refused!.href);
    const { container } = render(<JobBar variant={variant} />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('names each page by its door label', () => {
    signIn('parent');
    render(<JobBar variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: /^Safety/ }));
    expect(screen.getByRole('link', { name: 'Safety Status' }).getAttribute('href')).toBe('/parent/safety');
  });

  it('draws the Parent Hub tab items, each opening its tab, since Parent Hub reads the address (4e)', () => {
    // Lane AS4-4D4E: ParentHub keeps its tab in ?tab= (useTabParam), so a tab
    // item opens that tab. Messages, a section of tabs only, is drawn again.
    expect(PARENT_HUB_OPENS_TAB).toBe(true);
    signIn('parent');
    const { container } = render(<JobBar variant={variant} />);
    const nav = screen.getByRole('navigation', { name: 'Your jobs' });
    expect(within(nav).getByText('Messages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Progress/ }));
    expect(screen.getByRole('link', { name: 'Progress Visibility' })).toBeTruthy();
    expect(screen.getAllByText(/Parent Hub tab/).length).toBeGreaterThan(0);
    const hrefs = everyHref(container);
    for (const tab of ['progress', 'home-assignments', 'family-goals', 'observations']) {
      expect(hrefs).toContain(`/parent/dashboard?tab=${tab}`);
    }
    // Every tab a link names is one Parent Hub's rail draws.
    for (const href of hrefs.filter((h) => h.includes('?tab='))) {
      expect(Object.keys(PARENT_HUB_TAB_LABEL)).toContain(new URL(href, 'http://x').searchParams.get('tab'));
    }
  });

  it('makes a one-page section a plain link and a longer one a sheet', () => {
    signIn('coach');
    render(<JobBar variant={variant} />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/coach/environment/intake-router');
    const plan = screen.getByRole('button', { name: /^Plan/ });
    expect(plan.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(plan);
    expect(plan.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Drill Library' })).toBeTruthy();
  });

  it('draws one More for the coach and parent (kept apart in the data) and for staff and volunteer (a section), none for others', () => {
    for (const role of ROLES_WITH_BARS) {
      signIn(role);
      render(<JobBar variant={variant} />);
      const more = screen.queryAllByRole('button', { name: /^More/ });
      const bar = JOB_BARS[role]!;
      const wantsMore = bar.more.length > 0 || bar.sections.some((section) => section.label === 'More');
      expect(more).toHaveLength(wantsMore ? 1 : 0);
      cleanup();
    }
    // The coach's More holds the pages stage 2 put there, after the five sections.
    signIn('coach');
    render(<JobBar variant={variant} />);
    const labels = screen.getAllByRole('listitem').map((li) => li.firstElementChild?.firstChild?.textContent);
    expect(labels).toEqual(['Home', 'Class', 'Athletes', 'Plan', 'Safety', 'More']);
  });

  it('keeps one sheet open at a time, and Escape shuts it and returns focus', () => {
    signIn('coach');
    render(<JobBar variant={variant} />);
    const plan = screen.getByRole('button', { name: /^Plan/ });
    const safety = screen.getByRole('button', { name: /^Safety/ });
    fireEvent.click(plan);
    fireEvent.click(safety);
    expect(plan.getAttribute('aria-expanded')).toBe('false');
    expect(safety.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(safety.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(safety);
  });

  it('marks where the person is: the section holding this page, and the page itself', () => {
    signIn('coach');
    mockPathname.mockReturnValue('/coach/drills');
    render(<JobBar variant={variant} />);
    const plan = screen.getByRole('button', { name: /^Plan/ });
    expect(plan.className).toMatch(/is-active/);
    expect(plan.textContent).toMatch(/you are here/i);
    // Only that section: the others carry neither the mark nor the words.
    const marked = Array.from(document.querySelectorAll('nav[aria-label="Your jobs"] .is-active'));
    expect(marked).toEqual([plan]);
    expect(screen.getByRole('button', { name: /^Safety/ }).textContent).not.toMatch(/you are here/i);
    fireEvent.click(plan);
    expect(screen.getByRole('link', { name: 'Drill Library' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('Parent Hub tab names', () => {
  it('match the headings ParentHub.tsx draws on its tab rail', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(join(__dirname, 'ParentHub.tsx'), 'utf8');
    for (const [id, label] of Object.entries(PARENT_HUB_TAB_LABEL)) {
      expect(source).toContain(`{ id: '${id}', label: '${label}' }`);
    }
    // Every tab a bar names has a heading here.
    for (const bar of Object.values(JOB_BARS)) {
      for (const item of [...(bar?.sections.flatMap((s) => s.items) ?? []), ...(bar?.more ?? [])]) {
        if (item.tab) expect(PARENT_HUB_TAB_LABEL[item.tab]).toBeTruthy();
      }
    }
  });
});

describe('the phone bar keeps the page clear of itself', () => {
  it('leaves an in-flow spacer as tall as the bar, so the last line of a page is not under it', () => {
    signIn('coach');
    const { container } = render(<JobBar variant="phone" />);
    expect(container.querySelector('.job-bar-spacer')).toBeTruthy();
    expect(container.querySelector('nav.job-bar--phone')).toBeTruthy();
  });
});

// Review on #2130 (BLOCKER): on Parent Hub, a tab item opens the tab in place
// (Next would keep the page and change only the address); elsewhere it is an
// ordinary link.
describe('a Parent Hub tab item', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('on Parent Hub, writes the tab to the address in place and closes the sheet', () => {
    signIn('parent');
    mockPathname.mockReturnValue('/parent/dashboard');
    window.history.replaceState(null, '', '/parent/dashboard');
    render(<JobBar variant="rail" />);
    const section = screen.getByRole('button', { name: /^Messages/ });
    fireEvent.click(section);

    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/parent/dashboard?tab=messages')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('messages');
    expect(section.getAttribute('aria-expanded')).toBe('false');
  });

  it('on another page, is left to navigate as a link', () => {
    signIn('parent');
    mockPathname.mockReturnValue('/schedule');
    window.history.replaceState(null, '', '/schedule');
    render(<JobBar variant="rail" />);
    fireEvent.click(screen.getByRole('button', { name: /^Messages/ }));

    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/parent/dashboard?tab=messages')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.addEventListener('click', (e) => e.preventDefault()); // keep jsdom from navigating
    act(() => {
      link.dispatchEvent(event);
    });

    expect(window.location.pathname).toBe('/schedule');
    expect(window.location.search).toBe('');
  });
});

// Round 2 reviews on #2130: a modified click is left to the browser, and the
// bar's Home, while on Parent Hub with a tab open, returns to the first tab.
describe('a same-page job-bar link', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('leaves a Ctrl or Cmd click on a tab item to the browser', () => {
    signIn('parent');
    mockPathname.mockReturnValue('/parent/dashboard');
    window.history.replaceState(null, '', '/parent/dashboard');
    render(<JobBar variant="rail" />);
    fireEvent.click(screen.getByRole('button', { name: /^Messages/ }));
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/parent/dashboard?tab=messages')!;

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifier });
      link.addEventListener('click', (e) => e.preventDefault(), { once: true }); // keep jsdom from navigating
      act(() => {
        link.dispatchEvent(event);
      });
      expect(window.location.search).toBe('');
    }
  });

  it('Home on Parent Hub with a tab open returns to the first tab, in place', () => {
    signIn('parent');
    mockPathname.mockReturnValue('/parent/dashboard');
    window.history.replaceState(null, '', '/parent/dashboard?tab=attendance');
    render(<JobBar variant="rail" />);
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home.getAttribute('href')).toBe('/parent/dashboard');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      home.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(window.location.search).toBe('');
  });

  it('leaves a same-page link alone when the address names no tab', () => {
    signIn('coach');
    mockPathname.mockReturnValue('/coach/environment/intake-router');
    window.history.replaceState(null, '', '/coach/environment/intake-router');
    render(<JobBar variant="rail" />);
    const home = screen.getByRole('link', { name: 'Home' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    let preventedBeforeLink = true;
    home.addEventListener('click', (e) => {
      preventedBeforeLink = e.defaultPrevented;
      e.preventDefault();
    });
    act(() => {
      home.dispatchEvent(event);
    });
    expect(preventedBeforeLink).toBe(false);
  });
});

