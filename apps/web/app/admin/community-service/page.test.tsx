/**
 * @jest-environment jsdom
 */

// Community service page. What these pin: verified and unverified hours
// render as SEPARATE figures (never one combined number a reader could
// mistake for verified service), hours floor rather than round up, and
// the page states which figure external readers should rely on.

import { act, fireEvent, render, screen } from '@testing-library/react';

import CommunityServicePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const TOTALS = [{
  person_account_id: 'acct-jordan',
  verified_minutes: 150,   // 2h30 -> floors to 2h
  unverified_minutes: 90,  // 1h30 -> floors to 1h
  entry_count: 3,
  entries: [
    { activity_id: 'a-1', activity_type: 'food_bank', occurred_on: '2026-08-10', duration_minutes: 120, what_was_worked_on: 'sorting donations', verified: true },
    { activity_id: 'a-2', activity_type: 'gym_cleanup', occurred_on: '2026-08-12', duration_minutes: 90, what_was_worked_on: '', verified: false },
  ],
}];

function mockFetch() {
  return jest.fn(async () => ({ ok: true, json: async () => ({ items: TOTALS }) }) as Response) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('verified and unverified hours render separately, floored, with the external-use rule stated', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<CommunityServicePage />);
  });

  expect(await screen.findByText(/2h verified/)).toBeTruthy();
  expect(screen.getByText(/1h awaiting verification/)).toBeTruthy();
  // 150 + 90 = 240 minutes = 4h. No combined figure may appear anywhere.
  expect(screen.queryByText(/4h/)).toBeNull();
  expect(screen.getByText(/it is the verified figure/i)).toBeTruthy();
});

test('entries show their own verification state, unsmoothed', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<CommunityServicePage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Show entries' }));
  });

  expect(screen.getByText(/food bank · 120 min · verified/)).toBeTruthy();
  expect(screen.getByText(/gym cleanup · 90 min · awaiting verification/)).toBeTruthy();
});
