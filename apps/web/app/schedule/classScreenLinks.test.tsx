/**
 * @jest-environment jsdom
 */

// Lane 6C7, U2-6c (app scrub CF-07, CF-09, CF-26; Overwatch's answers on #2043: Q1 = A, Q2 = A).
//
//   CF-07  today's class rows on /schedule open the class screen (/coach/class?class=<id>), for
//          staff only: the class screen admits coaches and admins, and a family is never offered a
//          link it would be turned away from.
//   CF-09  one register word for coaches, "Who is here" (the class screen's word), with a link from
//          this register to that one. A family's "Attendance Check-In" and "I'm here" are unchanged.
//   CF-26  the records block is titled by what it lists for staff; the family title is unchanged.
//
// Pinned on the rendered DOM (jsdom), with the gym's day taken from the test's own clock. How it
// looks on a gym tablet has not been checked; that needs a signed-in view on staging.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, className }: { readonly href: string; readonly children: ReactNode; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A fixed instant in the middle of the gym's day (13:00 in New York), so "today" never straddles
// the gym's midnight whatever hour the suite runs at. The page reads the clock through Date.now().
const NOW = Date.parse('2026-11-20T18:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function classRow(id: string, title: string, startOffsetMs: number, over: Record<string, unknown> = {}) {
  return {
    class_id: id,
    title,
    start_at: at(startOffsetMs),
    end_at: at(startOffsetMs + HOUR),
    location: 'Main Floor',
    capacity: 16,
    status: 'open',
    registered_count: 1,
    ...over,
  };
}

const CLASSES = [
  classRow('class today/1', 'Tonight Fundamentals', -10 * 60 * 1000),
  classRow('class-called-off', 'Called Off Tonight', -5 * 60 * 1000, { status: 'cancelled' }),
  classRow('class-next-week', 'Next Week Sparring', 7 * DAY),
];

const ATHLETES = [{ athlete_id: 'athlete-1', full_name: 'Jordan Price' }];

function install(role: 'coach' | 'admin' | 'organization_admin' | 'parent' | 'athlete') {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    if (init?.method === 'POST' && !url.endsWith('/api/pilot/auth/session')) throw new Error(`this suite presses nothing: ${url}`);
    if (url.endsWith('/api/pilot/auth/session')) {
      return json({ authenticated: true, role, athlete_id: role === 'athlete' ? 'athlete-1' : null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: ATHLETES });
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({
        ok: true,
        role,
        athlete_id: role === 'athlete' ? 'athlete-1' : null,
        classes: CLASSES,
        registrations: [{
          registration_id: 'reg-1',
          class_id: 'class today/1',
          athlete_id: 'athlete-1',
          requested_by_role: 'parent',
          parent_reviewed: true,
          status: 'registered',
          created_at: at(-DAY),
        }],
        coaching_requests: [],
        attendance: [],
      });
    }
    if (url.includes('/api/pilot/')) return json({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

async function renderPage() {
  await act(async () => {
    render(<SchedulerPage />);
  });
  await screen.findByText('Class Schedule');
  await screen.findByText('Tonight Fundamentals');
}

const classScreenLinks = () => screen.queryAllByRole('link', { name: /^Open class screen/ });

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(['coach', 'admin', 'organization_admin'] as const)('a %s on /schedule', (role) => {
  test("each of today's classes that is not cancelled opens the class screen on that class", async () => {
    install(role);
    await renderPage();

    // The class row's link, and the same class beside the register's picker (it opens on today's class).
    const links = classScreenLinks();
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/coach/class?class=class%20today%2F1',
      '/coach/class?class=class%20today%2F1',
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      'Open class screen: Tonight Fundamentals',
      'Open class screen: Tonight Fundamentals',
    ]);
    // A plate, so it takes the kiosk tap floor as the row's buttons do; not a bare text link.
    for (const link of links) expect(link.className).toMatch(/\bbtn\b/);
  });

  test("a cancelled class and another day's class are not offered", async () => {
    install(role);
    await renderPage();
    for (const title of ['Called Off Tonight', 'Next Week Sparring']) {
      const row = screen.getAllByText(title).map((node) => node.closest('div.mat-leather--raised')).find(Boolean) as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).queryByRole('link', { name: /^Open class screen/ })).toBeNull();
    }
  });

  test('the register is "Who is here" with Save, and the records block is titled by what it lists', async () => {
    install(role);
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Who is here' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Attendance Check-In' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update Attendance' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Registrations and attendance' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Parent Review and Records' })).toBeNull();
  });
});

describe.each(['parent', 'athlete'] as const)('a %s on /schedule', (role) => {
  test('is never offered the class screen, and keeps the family words', async () => {
    install(role);
    await renderPage();
    expect(classScreenLinks()).toEqual([]);
    expect(document.querySelector('a[href^="/coach/class"]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Attendance Check-In' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Who is here' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Parent Review and Records' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Registrations and attendance' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
