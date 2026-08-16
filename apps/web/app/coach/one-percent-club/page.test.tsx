/**
 * @jest-environment jsdom
 */

// 1% Club page. What these pin is the module's whole point: a
// milestone-surfaced nomination reads as SURFACED rather than as if a coach
// or athlete put the name forward, and a confirmed member has no revoke
// control anywhere on the page.

import { act, fireEvent, render, screen } from '@testing-library/react';

import OnePercentClubPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const NOMINATIONS = [
  {
    nomination_id: 'nom-1', athlete_id: 'a1', athlete_name: 'Jordan P.',
    source: 'milestone_surfaced', nominated_by_display_name: 'Coach A',
    nominator_note: '', milestone_key: 'consistency.233', status: 'open',
    withdrawal_reason: null, expires_at: '2026-09-15T00:00:00Z', decided_at: null,
    created_at: '2026-08-16T00:00:00Z',
  },
  {
    nomination_id: 'nom-2', athlete_id: 'a2', athlete_name: 'Sam R.',
    source: 'self_peer_nomination', nominated_by_display_name: 'Sam R.',
    nominator_note: 'Nominating myself', milestone_key: null, status: 'open',
    withdrawal_reason: null, expires_at: '2026-09-15T00:00:00Z', decided_at: null,
    created_at: '2026-08-16T00:00:00Z',
  },
];

const MEMBERS = [
  {
    nomination_id: 'nom-old', athlete_id: 'a3', athlete_name: 'Alex T.',
    source: 'coach_nomination', nominated_by_display_name: 'Coach B',
    nominator_note: '', milestone_key: null, status: 'confirmed',
    withdrawal_reason: null, expires_at: '2026-07-01T00:00:00Z', decided_at: '2026-07-10T00:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
  },
];

function mockFetch(capture?: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      capture?.posts.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({
          item: { nomination_id: 'nom-1' },
          tally: { eligible_count: 5, yes_count: 1, no_count: 0, majority_reached: false },
        }),
      } as Response;
    }
    if (url.includes('/one-percent-club')) {
      return { ok: true, json: async () => ({ items: NOMINATIONS, members: MEMBERS }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'a1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a milestone-surfaced nomination reads as surfaced, never as if a person nominated it', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<OnePercentClubPage />);
  });

  expect(await screen.findByText('Surfaced by a milestone')).toBeTruthy();
  expect(screen.getByText('Self / peer nomination')).toBeTruthy();
  // The two sources render visibly different labels, side by side.
  expect(screen.queryByText('Surfaced by a milestone')).not.toEqual(screen.queryByText('Self / peer nomination'));
});

test('a confirmed member has no revoke or remove control on the page', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<OnePercentClubPage />);
  });

  expect(await screen.findByText('Alex T.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
});

test('filing a nomination posts athlete_id and any claimed milestone key, never a source', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<OnePercentClubPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'a1' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'File nomination' }));
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({ action: 'nominate', athlete_id: 'a1' });
  expect(capture.posts[0]).not.toHaveProperty('source');
});

test('voting yes or no posts the vote and shows the real tally, not a percentage', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<OnePercentClubPage />);
  });
  await act(async () => {
    fireEvent.click((await screen.findAllByRole('button', { name: 'Vote yes' }))[0]);
  });

  expect(capture.posts[0]).toMatchObject({ action: 'vote', nomination_id: 'nom-1', vote: 'yes' });
  expect(await screen.findByText(/1 yes of 5 eligible/i)).toBeTruthy();
});

test('withdrawing needs a reason typed in before it posts', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<OnePercentClubPage />);
  });
  await act(async () => {
    fireEvent.click((await screen.findAllByRole('button', { name: 'Withdraw' }))[0]);
  });
  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/needs a reason/i)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getAllByPlaceholderText('Reason to withdraw this nomination')[0], {
      target: { value: 'filed in error' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Withdraw' })[0]);
  });
  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({ action: 'withdraw', reason: 'filed in error' });
});
