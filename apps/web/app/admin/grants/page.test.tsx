/**
 * @jest-environment jsdom
 */

// The obligations ledger is a deadlines board. What these pin: the empty
// state is withheld while loading; an overdue open row is flagged and a
// settled row never is; and advancing a row PATCHes the ledger rather than
// mutating anything client-side.

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import GrantObligationsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const OVERDUE_ROW = {
  obligation_id: 'ob-1',
  grant_name: 'Community Youth Grant',
  funder_name: 'Foundation X',
  obligation_type: 'report',
  description: 'Quarterly outcomes report.',
  due_date: '2020-01-01',
  status: 'open',
  completed_at: null,
  notes: '',
};

const SETTLED_OLD_ROW = {
  ...OVERDUE_ROW,
  obligation_id: 'ob-2',
  grant_name: 'Equipment Grant',
  status: 'complete',
};

function mockFetch(rows: unknown[], capture?: { patches: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      capture?.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    return { ok: true, json: async () => ({ items: rows }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while loading', async () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

  render(<GrantObligationsPage />);

  await screen.findByText(/Loading obligations/);
  expect(screen.queryByText('No obligations on record')).toBeNull();
});

test('an overdue open row is flagged; a settled row with the same old date is not', async () => {
  global.fetch = mockFetch([OVERDUE_ROW, SETTLED_OLD_ROW]);

  render(<GrantObligationsPage />);

  await screen.findByText('Community Youth Grant');
  expect(screen.getAllByText('overdue')).toHaveLength(1);
  expect(screen.getByText('Equipment Grant')).toBeTruthy();
});

test('advancing a row PATCHes the ledger with the target status', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = mockFetch([OVERDUE_ROW], capture);

  render(<GrantObligationsPage />);

  await screen.findByText('Community Youth Grant');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark submitted' }));
  });

  expect(capture.patches).toEqual([{ obligation_id: 'ob-1', status: 'submitted' }]);
});
