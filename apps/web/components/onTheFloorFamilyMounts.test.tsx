/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-2: where the family line sits, and that it is read once per page open.
//   Parent Hub: directly under the hub's heading block, one line per own child who counts,
//   by the hub's own name for them (Jason Q3.2 A).
//   Athlete home: directly after the I'm here card, on Today; not mounted without the
//   athlete's own record (Q3.4 A; FN-0 check 8).

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteWorkspace from './AthleteWorkspace';
import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const floorReads = () => (global.fetch as jest.Mock).mock.calls.filter(([input]) => String(input).includes('/api/pilot/on-the-floor')).length;

jest.setTimeout(20000);

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('Parent Hub: a line for each own child who counts, directly under the heading block, read once', async () => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/on-the-floor')) return jsonResponse({ ok: true, on_the_floor: ['ath_2'] });
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }, { athlete_id: 'ath_2', full_name: 'Second Kid' }] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ParentHub />);
  });

  const line = await screen.findByText('Second is on the floor now.');
  expect(screen.queryByText(/First is on the floor/)).toBeNull();
  const heading = screen.getByRole('heading', { level: 1, name: 'Parent Hub' });
  expect(line.closest('section')?.previousElementSibling?.contains(heading)).toBe(true);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Attendance' }));
  });
  expect(floorReads()).toBe(1);
});

function athleteFetch(athleteId: string | null) {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, athlete_id: athleteId });
    if (url.includes('/api/pilot/on-the-floor')) return jsonResponse({ ok: true, on_the_floor: true });
    return jsonResponse({ ok: true, items: [] });
  }) as unknown as typeof fetch;
}

test('athlete home: the line sits directly after I\'m here on Today, is drawn only there, and a tab change does not read it again', async () => {
  athleteFetch('ath_test');
  await act(async () => {
    render(<AthleteWorkspace />);
  });

  const line = await screen.findByText("You're on the floor now.");
  const imHere = screen.getByRole('heading', { name: "Today's class" }).closest('section');
  expect(imHere).not.toBeNull();
  expect(line.closest('section')?.previousElementSibling).toBe(imHere);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
  });
  expect(screen.queryByText("You're on the floor now.")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  });
  expect(await screen.findByText("You're on the floor now.")).toBeTruthy();
  expect(floorReads()).toBe(1);
});

test('athlete home: an account with no athlete record gets no line, and nothing is read', async () => {
  athleteFetch(null);
  await act(async () => {
    render(<AthleteWorkspace />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole('region', { name: 'On the floor' })).toBeNull();
  expect(floorReads()).toBe(0);
});
