/**
 * @jest-environment jsdom
 */

/*
 * AS-9 step AS9-4 (app scrub FAM-23; Q7 = A): the hub's Attendance tab sends a
 * parent to /schedule to "mark your child here", the parent's own words for
 * the check-in there, not "check an athlete in".
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('the Attendance tab says "mark your child here", never "check an athlete in"', async () => {
  await act(async () => {
    render(<ParentHub />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Attendance' }));
  });

  const link = screen.getByRole('link', { name: 'Open the full scheduler' });
  expect(link).toHaveAttribute('href', '/schedule');
  expect(link.parentElement?.textContent?.replace(/\s+/g, ' ')).toBe(
    'Open the full scheduler to register, review a registration, or mark your child here.',
  );
  expect(document.body.textContent).not.toContain('check an athlete in');
});
