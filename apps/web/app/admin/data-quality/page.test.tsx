/**
 * @jest-environment jsdom
 */

// The data-quality page: findings (children hidden from their guardian) are
// separated from informational splits, there is NO merge control anywhere,
// and a failed check admits duplicates may exist rather than rendering as a
// clean bill of health.

import { act, render, screen } from '@testing-library/react';

import DataQualityPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const FINDING = {
  email: 'g*******@example.org',
  record_count: 2,
  claimed_count: 1,
  unclaimed_count: 1,
  account_ids: ['acct-1'],
  parent_ids: ['par-a', 'par-b'],
  hidden_athlete_ids: ['ath-2'],
};

const INFORMATIONAL = {
  email: 'm***@example.org',
  record_count: 2,
  claimed_count: 2,
  unclaimed_count: 0,
  account_ids: ['acct-2', 'acct-3'],
  parent_ids: ['par-c', 'par-d'],
  hidden_athlete_ids: [],
};

function mockFetch(response: { ok?: boolean; items?: unknown[] }) {
  return jest.fn(async () => ({
    ok: response.ok ?? true,
    status: response.ok === false ? 500 : 200,
    json: async () => ({ items: response.items ?? [] }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('findings and informational splits are separated, with ids as the remediation keys and no merge control', async () => {
  global.fetch = mockFetch({ items: [FINDING, INFORMATIONAL] });

  await act(async () => {
    render(<DataQualityPage />);
  });

  expect(screen.getByText('Children hidden from their guardian')).toBeTruthy();
  expect(screen.getByText('1 hidden')).toBeTruthy();
  expect(screen.getByText(/Hidden athlete ids: ath-2/)).toBeTruthy();
  expect(screen.getByText(/par-a, par-b/)).toBeTruthy();
  expect(screen.getByText('Split but currently harmless')).toBeTruthy();
  // Report-only: no merge, fix, or delete control exists on this page.
  expect(screen.queryByRole('button', { name: /merge|fix|delete/i })).toBeNull();
});

test('a clean check says every email maps to one record', async () => {
  global.fetch = mockFetch({ items: [] });

  await act(async () => {
    render(<DataQualityPage />);
  });

  expect(screen.getByText('No split guardian records')).toBeTruthy();
});

test('a failed check admits duplicates may exist, never rendering as clean', async () => {
  global.fetch = mockFetch({ ok: false });

  await act(async () => {
    render(<DataQualityPage />);
  });

  expect(screen.getByText(/Duplicates may exist that are not shown here/)).toBeTruthy();
  expect(screen.queryByText('No split guardian records')).toBeNull();
});
