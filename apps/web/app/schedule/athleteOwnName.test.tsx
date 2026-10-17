/**
 * @jest-environment jsdom
 */

// F-117: an athlete's own registration, attendance and coaching-request rows
// read their roster code (first-name-001), because the athlete reads no
// roster. They now read the athlete's own name, from their own record; no
// roster is read and no other athlete's id gains a name. The line after a
// coaching request's status is its goals, now labelled as such.
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

const GYM_NOON = Date.parse('2026-10-14T16:00:00.000Z');
const OWN_ID = 'jordan-001';
const OTHER_ID = 'casey-002';

const scheduler = {
  ok: true,
  role: 'athlete',
  classes: [{
    class_id: 'class-1',
    title: 'Youth Boxing',
    start_at: '2026-10-20T21:00:00.000Z',
    end_at: '2026-10-20T22:00:00.000Z',
    capacity: 12,
    status: 'scheduled',
  }],
  registrations: [
    { registration_id: 'reg-1', class_id: 'class-1', athlete_id: OWN_ID, status: 'registered', parent_reviewed: false },
    // Not a row an athlete is served today; here to pin that only the
    // athlete's own id gains a name.
    { registration_id: 'reg-2', class_id: 'class-1', athlete_id: OTHER_ID, status: 'registered', parent_reviewed: false },
  ],
  coaching_requests: [{
    request_id: 'req-1',
    athlete_id: OWN_ID,
    preferred_at: '2026-10-21T21:00:00.000Z',
    goals: 'Yes',
    status: 'pending',
    assigned_coach_account_id: null,
    created_at: '2026-10-13T16:00:00.000Z',
  }],
  attendance: [{
    attendance_id: 'att-1',
    class_id: 'class-1',
    athlete_id: OWN_ID,
    status: 'present',
    method: 'self',
    note: '',
    checked_in_at: '2026-10-13T21:05:00.000Z',
  }],
};

type OwnRead = 'ok' | 'not-found' | 'fails';

function install(ownRead: OwnRead) {
  const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (payload: unknown, ok = true) =>
      Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'athlete', athlete_id: OWN_ID });
    if (url.endsWith('/api/pilot/scheduler')) return json(scheduler);
    if (url.endsWith('/api/pilot/athletes/get')) {
      if (ownRead === 'fails') return json({ error: 'nope' }, false);
      if (ownRead === 'not-found') return json({ found: false });
      // A full_name for a DIFFERENT id coming back must still only name the
      // caller's own rows: the page keys on its own id.
      return json({ found: true, athlete: { athlete_id: OTHER_ID, full_name: 'Jordan Price' } });
    }
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: OTHER_ID, full_name: 'Casey Lee' }] });
    if (url.includes('/api/pilot/')) return json({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
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

function textOf(pattern: RegExp): string {
  return screen.getAllByText(pattern).map((node) => node.textContent ?? '').join('\n');
}

test("an athlete's own rows read their name, not their roster code", async () => {
  const fetchMock = install('ok');
  await renderPage();

  const registrations = textOf(/^Registration:/);
  expect(registrations).toContain('Registration: Jordan Price');
  expect(registrations).not.toContain(`Registration: ${OWN_ID}`);
  expect(textOf(/^Attendance:/)).toContain('Attendance: Jordan Price');
  expect(textOf(/^Attendance:/)).not.toContain(OWN_ID);

  const requestRow = screen.getByText('Yes').closest('.input');
  expect(requestRow?.textContent).toContain('Jordan Price');
  expect(requestRow?.textContent).not.toContain(OWN_ID);

  // Their own record, asked for by their own id.
  const ownCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/pilot/athletes/get'));
  expect(ownCalls).toHaveLength(1);
  expect(JSON.parse(String((ownCalls[0][1] as RequestInit).body))).toEqual({ athlete_id: OWN_ID });
});

test('an athlete reads no roster, and no other id gains a name', async () => {
  const fetchMock = install('ok');
  await renderPage();

  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/pilot/athletes/list'))).toBe(false);
  expect(textOf(/^Registration:/)).toContain(`Registration: ${OTHER_ID}`);
  expect(screen.queryByText(/Casey Lee/)).not.toBeInTheDocument();
});

test.each<OwnRead>(['fails', 'not-found'])('an own record that cannot be read (%s) leaves the roster code and the page', async (ownRead) => {
  install(ownRead);
  await renderPage();

  expect(textOf(/^Registration:/)).toContain(`Registration: ${OWN_ID}`);
  expect(screen.queryByText(/Jordan Price/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();
});

test("the line after a coaching request's status is labelled as its goals", async () => {
  install('ok');
  await renderPage();

  const goalsLine = screen.getByText('Yes').closest('p');
  expect(goalsLine?.textContent).toBe('Goals: Yes');
});
