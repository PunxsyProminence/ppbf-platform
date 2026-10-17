/**
 * @jest-environment jsdom
 */

// F-043: a coaching request nobody answered before its preferred time read
// "pending" for months. It now says the time has passed; one still ahead, and
// an answered one, read as before. Staff can still resolve the old one.
//
// Pinned on the rendered DOM (jsdom). How it reads on a tablet or a phone has
// not been checked (NOT VERIFIED).

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const DAY = 24 * 3600 * 1000;
const GYM_NOON = Date.parse('2026-10-14T16:00:00.000Z');
const at = (offsetMs: number) => new Date(GYM_NOON + offsetMs).toISOString();

function request(id: string, preferredOffsetMs: number, status: 'pending' | 'approved' | 'declined', goals: string) {
  return {
    request_id: id,
    athlete_id: 'athlete-1',
    preferred_at: at(preferredOffsetMs),
    goals,
    status,
    assigned_coach_account_id: null,
    created_at: at(preferredOffsetMs - DAY),
  };
}

function install(role: 'parent' | 'organization_admin', coachingRequests: ReturnType<typeof request>[]) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role, athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'Jordan Price' }] });
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role, classes: [], registrations: [], coaching_requests: coachingRequests, attendance: [] });
    }
    if (url.includes('/api/pilot/')) return json({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function renderPage() {
  await act(async () => {
    render(<SchedulerPage />);
  });
  await screen.findByText('Coaching Requests');
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(GYM_NOON);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function statusLineFor(goals: string): string {
  const row = screen.getByText(goals).closest('.input');
  if (!row) throw new Error(`no request row for ${goals}`);
  return row.textContent ?? '';
}

test('a pending request whose preferred time has passed says so, and no longer reads just "pending"', async () => {
  install('parent', [
    request('old', -60 * DAY, 'pending', 'Footwork before the August show'),
    request('soon', 2 * DAY, 'pending', 'Southpaw sparring prep'),
    request('done', -30 * DAY, 'declined', 'Extra conditioning'),
  ]);
  await renderPage();

  const old = statusLineFor('Footwork before the August show');
  expect(old).toContain('Status: not answered, and the preferred time has passed');
  expect(old).not.toContain('Status: pending');

  expect(statusLineFor('Southpaw sparring prep')).toContain('Status: pending');
  expect(statusLineFor('Extra conditioning')).toContain('Status: declined');
  expect(statusLineFor('Extra conditioning')).not.toContain('preferred time has passed');
});

test('a request whose preferred time passes while the page is open flips to the new line', async () => {
  // Only the interval and the clock are faked; fetch and findBy keep real
  // timers (as cancelClass.test.tsx does for the same 15-second clock).
  jest.restoreAllMocks();
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
      'hrtime', 'performance',
    ],
  });
  jest.setSystemTime(GYM_NOON);
  try {
    install('parent', [request('soon', 10_000, 'pending', 'Southpaw sparring prep')]);
    await renderPage();
    expect(statusLineFor('Southpaw sparring prep')).toContain('Status: pending');

    act(() => {
      jest.advanceTimersByTime(15_000);
    });

    expect(statusLineFor('Southpaw sparring prep')).toContain('Status: not answered, and the preferred time has passed');
  } finally {
    jest.useRealTimers();
  }
});

test('the office can still resolve a pending request whose preferred time has passed', async () => {
  install('organization_admin', [request('old', -60 * DAY, 'pending', 'Footwork before the August show')]);
  await renderPage();

  expect(statusLineFor('Footwork before the August show')).toContain('preferred time has passed');
  expect(screen.getByLabelText(/Coach to assign/)).toBeInTheDocument();
});
