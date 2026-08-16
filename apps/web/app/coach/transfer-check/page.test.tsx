/**
 * @jest-environment jsdom
 */

// Transfer check page. What these pin: a not-transferring flag renders
// with its RAW COUNTS (the coach sees the same facts the rule saw);
// untested-live renders as an honest unknown, not a failure; and nothing
// on the page renders a score or percentage.

import { act, fireEvent, render, screen } from '@testing-library/react';

import TransferCheckPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const READOUT = [
  {
    metric_kind: 'reps',
    controlled_makes: 8, controlled_misses: 1,
    live_makes: 1, live_misses: 5,
    state: 'not_transferring',
  },
  {
    metric_kind: 'time_seconds',
    controlled_makes: 5, controlled_misses: 1,
    live_makes: 0, live_misses: 0,
    state: 'untested_live',
  },
];

function mockFetch() {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/transfer-check')) {
      return { ok: true, json: async () => ({ items: READOUT }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('flags render with raw counts, and untested-live reads as unknown rather than failure', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<TransferCheckPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  expect(await screen.findByText('not transferring')).toBeTruthy();
  expect(screen.getByText(/practice: 8 of 9 made · live: 1 of 6 made/)).toBeTruthy();
  expect(screen.getByText(/the gain has not transferred yet/i)).toBeTruthy();

  expect(screen.getByText('untested live')).toBeTruthy();
  expect(screen.getByText(/untested, not failing/i)).toBeTruthy();

  // No score, no percentage, anywhere.
  expect(screen.queryByText(/%/)).toBeNull();
  expect(screen.getByText(/never a verdict/)).toBeTruthy();
});
