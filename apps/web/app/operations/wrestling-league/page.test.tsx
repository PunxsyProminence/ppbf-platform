/**
 * @jest-environment jsdom
 */

// The wrestling-league skeleton page (owner decision 2026-08-15: deliberately
// skeletal). What these pin: the page states its own limits instead of
// pretending; seasons render from the API; creating a season posts the form;
// opening a season loads its events and roster; adding a roster athlete posts
// the LINK (an athlete_id, nothing else); and a duplicate roster add surfaces
// the server's message instead of a silent success.

import { act, fireEvent, render, screen } from '@testing-library/react';

import WrestlingLeagueManagementPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const SEASON = {
  season_id: 'season-1',
  season_name: 'Winter League 2026',
  starts_on: '2026-11-01',
  ends_on: null,
  status: 'planned',
  notes: '',
};

const EVENT = {
  event_id: 'event-1',
  event_name: 'Opening Duals',
  event_date: '2026-11-08',
  location: 'Main Gym',
  status: 'planned',
};

const ROSTER_ENTRY = {
  entry_id: 'entry-1',
  athlete_id: 'ath-1',
  athlete_name: 'Jordan Little',
  status: 'active',
};

function mockFetch(options: {
  capture?: { posts: Array<{ url: string; body: unknown }> };
  rosterPostStatus?: number;
  rosterPostError?: string;
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      options.capture?.posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes('/roster') && options.rosterPostStatus) {
        return {
          ok: false,
          status: options.rosterPostStatus,
          json: async () => ({ error: options.rosterPostError }),
        } as Response;
      }
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/wrestling-league/seasons')) {
      return { ok: true, json: async () => ({ items: [SEASON] }) } as Response;
    }
    if (url.includes('/wrestling-league/events')) {
      return { ok: true, json: async () => ({ items: [EVENT] }) } as Response;
    }
    if (url.includes('/wrestling-league/roster')) {
      return { ok: true, json: async () => ({ items: [ROSTER_ENTRY] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the page states the skeleton boundary instead of pretending', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });

  expect(screen.getByText(/Minimal skeleton by owner decision/)).toBeTruthy();
  expect(screen.getByText(/stay unbuilt until a real\s+league defines/)).toBeTruthy();
});

test('seasons render from the API read', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });

  expect(await screen.findByText('Winter League 2026')).toBeTruthy();
});

test('creating a season posts the form', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add season' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Season name'), { target: { value: 'Spring League' } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2027-03-01' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save season' }));
  });

  const post = capture.posts.find((entry) => entry.url.includes('/seasons'));
  expect(post).toBeTruthy();
  expect(post?.body).toEqual({ season_name: 'Spring League', starts_on: '2027-03-01', ends_on: null });
});

test('opening a season shows its events and roster; adding an athlete posts the link only', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail' }));
  });

  expect(await screen.findByText(/Opening Duals/)).toBeTruthy();
  expect(screen.getByText(/Jordan Little/)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Add athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }));
  });

  const post = capture.posts.find((entry) => entry.url.includes('/roster'));
  expect(post).toBeTruthy();
  // The link and nothing else: no name, no dob, no athlete attribute travels.
  expect(post?.body).toEqual({ season_id: 'season-1', athlete_id: 'ath-2' });
});

test('a duplicate roster add surfaces the server message', async () => {
  global.fetch = mockFetch({
    capture: { posts: [] },
    rosterPostStatus: 409,
    rosterPostError: 'This athlete is already on the season roster.',
  });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Add athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }));
  });

  expect(await screen.findByText('This athlete is already on the season roster.')).toBeTruthy();
});
