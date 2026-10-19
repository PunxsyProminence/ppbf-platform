/**
 * @jest-environment jsdom
 */

// Parent walk 2026-10-19 item 9: the records list read "NEEKO NEALE -> ZZ-AUDIT
// TEST CLASS" and "Status: registered", and coaching requests "Status:
// pending" -- the data's words, not a sentence. Wording PROPOSED (lane step,
// Overwatch GO 2026-10-19: "PR C1 (schedule wording)").
//
// Pinned on the rendered DOM (jsdom). How it reads on a tablet has not been
// checked (NOT VERIFIED).

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

const NOON = Date.parse('2026-10-14T16:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const at = (offsetMs: number) => new Date(NOON + offsetMs).toISOString();

const CLASS = {
  class_id: 'class-1',
  title: 'Tuesday Youth Boxing',
  start_at: at(-7 * DAY),
  end_at: at(-7 * DAY + 3600 * 1000),
  location: 'Main floor',
  capacity: 12,
  status: 'open',
};

function registration(id: string, status: 'registered' | 'waitlisted' | 'cancelled', parentReviewed: boolean) {
  return {
    registration_id: id,
    class_id: 'class-1',
    athlete_id: 'athlete-1',
    requested_by_role: 'parent',
    parent_reviewed: parentReviewed,
    status,
    created_at: at(-8 * DAY),
  };
}

function coaching(id: string, status: 'pending' | 'approved' | 'declined', goals: string) {
  return {
    request_id: id,
    athlete_id: 'athlete-1',
    preferred_at: at(2 * DAY),
    goals,
    status,
    assigned_coach_account_id: null,
    created_at: at(-DAY),
  };
}

function install(payload: Record<string, unknown>) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'parent', athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'Jordan Price' }] });
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role: 'parent', classes: [CLASS], registrations: [], coaching_requests: [], attendance: [], ...payload });
    }
    if (url.includes('/api/pilot/')) return json({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function renderPage() {
  await act(async () => {
    render(<SchedulerPage />);
  });
  await screen.findByText('Parent Review and Records');
}

function recordsText(): string {
  return screen.getByText('Parent Review and Records').closest('article')?.textContent ?? '';
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOON);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('a registration reads as a sentence, with no arrow and no raw status', async () => {
  install({
    registrations: [registration('r1', 'registered', false), registration('r2', 'waitlisted', true), registration('r3', 'cancelled', true)],
  });
  await renderPage();

  const text = recordsText();
  expect(text).toContain('Jordan Price is registered for Tuesday Youth Boxing');
  expect(text).toContain('Jordan Price is on the waitlist for Tuesday Youth Boxing');
  expect(text).toContain('Registration cancelled: Jordan Price, Tuesday Youth Boxing');
  expect(text).toContain('Parent reviewed: No');
  expect(text).toContain('Parent reviewed: Yes');
  expect(text).not.toContain('->');
  expect(text).not.toMatch(/Status: (registered|waitlisted|cancelled)/);
});

test('an attendance record names the class without an arrow', async () => {
  install({
    attendance: [{
      attendance_id: 'a1', class_id: 'class-1', athlete_id: 'athlete-1', status: 'present', method: 'coach_override', note: '', checked_in_at: at(-7 * DAY),
    }],
  });
  await renderPage();

  const text = recordsText();
  expect(text).toContain('Jordan Price at Tuesday Youth Boxing');
  expect(text).not.toContain('->');
});

test('a coaching request status is said in words', async () => {
  install({
    coaching_requests: [
      coaching('c1', 'pending', 'Southpaw sparring prep'),
      coaching('c2', 'approved', 'Footwork'),
      coaching('c3', 'declined', 'Extra conditioning'),
    ],
  });
  await renderPage();

  const line = (goals: string) => screen.getByText(goals).closest('.input')?.textContent ?? '';
  expect(line('Southpaw sparring prep')).toContain('Status: Waiting for an answer');
  expect(line('Footwork')).toContain('Status: Approved');
  expect(line('Extra conditioning')).toContain('Status: Declined');
  expect(line('Southpaw sparring prep')).not.toContain('Status: pending');
});
