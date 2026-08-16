/**
 * @jest-environment jsdom
 */

// The attempt log. What these pin: recording posts the raw facts (target,
// achieved) and NEVER a client-computed verdict; a missed attempt renders
// with its miss badge, not hidden; an empty target posts null (a
// measurement); and the page frames misses as the point.

import { act, fireEvent, render, screen } from '@testing-library/react';

import AttemptLogPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const MISSED_ATTEMPT = {
  attempt_id: 'att-1',
  athlete_name: 'Jordan P.',
  metric_kind: 'time_seconds',
  direction: 'at_most',
  target_value: '90',
  achieved_value: '92',
  made: false,
  note: 'gassed at 300m',
  attempted_at: '2026-08-15T22:00:00.000Z',
};

function mockFetch(capture: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/training-attempts') && init?.method === 'POST') {
      capture.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/training-attempts')) {
      return { ok: true, json: async () => ({ items: [MISSED_ATTEMPT] }) } as Response;
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

test('a missed attempt renders with its miss badge and note -- failures are shown, not smoothed', async () => {
  global.fetch = mockFetch({ posts: [] });

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  expect(await screen.findByText('missed')).toBeTruthy();
  expect(screen.getByText(/92s \/ target 90s/)).toBeTruthy();
  expect(screen.getByText('gassed at 300m')).toBeTruthy();
  expect(screen.getByText(/the misses are the point/i)).toBeTruthy();
});

test('recording posts raw facts only; an empty target posts null (a measurement)', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Achieved/), { target: { value: '12' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record attempt' }));
  });

  expect(capture.posts).toHaveLength(1);
  const posted = capture.posts[0] as Record<string, unknown>;
  expect(posted).toMatchObject({ athlete_id: 'ath-1', metric_kind: 'reps', target_value: null, achieved_value: 12 });
  // The verdict is the server's to compute.
  expect(posted).not.toHaveProperty('made');
});

test('a non-numeric achieved never leaves the page', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record attempt' }));
  });

  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/Achieved must be a non-negative number/)).toBeTruthy();
});
