/**
 * @jest-environment jsdom
 */

// The wrestling-league skeleton page (owner decision 2026-08-15: deliberately
// skeletal). What these pin: the page states its own limits instead of
// pretending; seasons render from the API; creating a season posts the form;
// opening a season loads its events and roster; adding a roster athlete posts
// the LINK (an athlete_id, nothing else); a duplicate roster add surfaces
// the server's message instead of a silent success; and a season's lists are
// shown only from a good read of that same season -- never after a failed
// read, and never from a late reply for a season no longer open.

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

test('a failed seasons read shows the failure, not an empty league', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/wrestling-league/seasons')) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });

  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load league seasons\./);
  expect(screen.queryByText('No seasons on record')).toBeNull();
  expect(screen.queryByText(/When a league season is planned/)).toBeNull();
});

test('a failed season-detail read shows neither an empty season nor the last season opened', async () => {
  // Season one opens cleanly; season two's detail read fails. The page used to
  // print season one's event and roster under season two -- or, with nothing
  // opened before, "No events filed" / "No athletes" -- beneath the failure.
  const SECOND = { ...SEASON, season_id: 'season-2', season_name: 'Spring League 2027' };
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/wrestling-league/seasons')) {
      return { ok: true, json: async () => ({ items: [SEASON, SECOND] }) } as Response;
    }
    if (url.includes('season_id=season-2')) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    if (url.includes('/wrestling-league/events')) {
      return { ok: true, json: async () => ({ items: [EVENT] }) } as Response;
    }
    if (url.includes('/wrestling-league/roster')) {
      return { ok: true, json: async () => ({ items: [ROSTER_ENTRY] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });

  const [openFirst] = await screen.findAllByRole('button', { name: 'Open detail' });
  await act(async () => {
    fireEvent.click(openFirst);
  });
  expect(await screen.findByText(/Opening Duals/)).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
  });
  const [, openSecond] = screen.getAllByRole('button', { name: 'Open detail' });
  await act(async () => {
    fireEvent.click(openSecond);
  });

  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);
  expect(screen.queryByText(/Opening Duals/)).toBeNull();
  expect(screen.queryByText(/Jordan Little/)).toBeNull();
  expect(screen.queryByText(/No events filed for this season/)).toBeNull();
  expect(screen.queryByText(/No athletes on this season roster/)).toBeNull();
});

test('a failed first season-detail read does not say the season has no events or athletes', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/wrestling-league/seasons')) {
      return { ok: true, json: async () => ({ items: [SEASON] }) } as Response;
    }
    if (url.includes('/wrestling-league/roster')) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    if (url.includes('/wrestling-league/events')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail' }));
  });

  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);
  expect(screen.queryByText(/No events filed for this season/)).toBeNull();
  expect(screen.queryByText(/No athletes on this season roster/)).toBeNull();
});

const SECOND_SEASON = { ...SEASON, season_id: 'season-2', season_name: 'Spring League 2027' };
const SECOND_EVENT = { ...EVENT, event_id: 'event-2', event_name: 'Spring Opener' };
const SECOND_ENTRY = { ...ROSTER_ENTRY, entry_id: 'entry-2', athlete_id: 'ath-3', athlete_name: 'Riley Moss' };

const failed = () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
const items = (rows: unknown[]) => ({ ok: true, json: async () => ({ items: rows }) }) as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// Two seasons. Season one reads EVENT / ROSTER_ENTRY; season two either fails
// or reads SECOND_EVENT / SECOND_ENTRY. With holdFirst.on, season one's detail
// reads wait for holdFirst.release (true = succeed, false = fail).
function twoSeasonFetch(options: {
  secondDetail: 'fails' | 'succeeds';
  holdFirst?: { on: boolean; release: Promise<boolean> };
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') return { ok: true, json: async () => ({ item: {} }) } as Response;
    if (url.includes('/wrestling-league/seasons')) return items([SEASON, SECOND_SEASON]);
    if (url.includes('season_id=season-2')) {
      if (options.secondDetail === 'fails') return failed();
      return items(url.includes('/events') ? [SECOND_EVENT] : [SECOND_ENTRY]);
    }
    if (url.includes('season_id=season-1')) {
      if (options.holdFirst?.on && !(await options.holdFirst.release)) return failed();
      return items(url.includes('/events') ? [EVENT] : [ROSTER_ENTRY]);
    }
    return items([]);
  }) as unknown as typeof fetch;
}

async function openSeason(index: number) {
  const buttons = await screen.findAllByRole('button', { name: 'Open detail' });
  await act(async () => {
    fireEvent.click(buttons[index]);
  });
}

test('a later good read of a season shows its lists again after an earlier failed one', async () => {
  global.fetch = twoSeasonFetch({ secondDetail: 'fails' });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await openSeason(1);
  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
  });
  await openSeason(0);

  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/Opening Duals/)).toBeTruthy();
  expect(screen.getByText(/Jordan Little/)).toBeTruthy();
  expect(screen.queryByText('Unable to load the season detail.')).toBeNull();
});

test('after a failed season-detail read, the lists still say so once another action clears the alert', async () => {
  // Starting the season succeeds and clears the shared alert; the detail read
  // is still the failed one, so blank lists would read as "none".
  global.fetch = twoSeasonFetch({ secondDetail: 'fails' });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await openSeason(1);
  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);

  const [, startSecond] = screen.getAllByRole('button', { name: 'Start season' });
  await act(async () => {
    fireEvent.click(startSecond);
  });

  expect(screen.queryByRole('alert')).toBeNull();
  // One line under Events, one under Roster.
  expect(screen.getAllByText('Unable to load the season detail.')).toHaveLength(2);
  expect(screen.queryByText(/No events filed for this season/)).toBeNull();
  expect(screen.queryByText(/No athletes on this season roster/)).toBeNull();
});

test("a season's reload that lands after another season was opened is dropped (the other season failed)", async () => {
  const hold = deferred<boolean>();
  const holdFirst = { on: false, release: hold.promise };
  const fetchMock = twoSeasonFetch({ secondDetail: 'fails', holdFirst });
  global.fetch = fetchMock;

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await openSeason(0);
  expect(screen.getByText(/Opening Duals/)).toBeTruthy();

  // Adding an event reloads season one; that reload is held open.
  holdFirst.on = true;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
  });
  await openSeason(1);
  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);
  expect(screen.queryByText(/Opening Duals/)).toBeNull();

  // Season one's late reload now succeeds.
  await act(async () => {
    hold.resolve(true);
  });

  const calls = (fetchMock as unknown as jest.Mock).mock.calls.map(([input]) => String(input));
  expect(calls.filter((url) => url.includes('season_id=season-1'))).toHaveLength(4);
  expect(screen.getByRole('button', { name: 'Close detail' })).toBeTruthy();
  expect(screen.queryByText(/Opening Duals/)).toBeNull();
  expect(screen.queryByText(/Jordan Little/)).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the season detail\./);
  expect(screen.queryByText(/No events filed for this season/)).toBeNull();
  expect(screen.queryByText(/No athletes on this season roster/)).toBeNull();
});

test.each([
  ['fails', false],
  ['succeeds', true],
])("a season's reload that lands after another season was opened is dropped (the late reload %s)", async (_label, lateOutcome) => {
  const hold = deferred<boolean>();
  const holdFirst = { on: false, release: hold.promise };
  global.fetch = twoSeasonFetch({ secondDetail: 'succeeds', holdFirst });

  await act(async () => {
    render(<WrestlingLeagueManagementPage />);
  });
  await openSeason(0);
  expect(screen.getByText(/Opening Duals/)).toBeTruthy();

  holdFirst.on = true;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
  });
  await openSeason(1);
  expect(screen.getByText(/Spring Opener/)).toBeTruthy();

  await act(async () => {
    hold.resolve(lateOutcome);
  });

  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/Spring Opener/)).toBeTruthy();
  expect(screen.getByText(/Riley Moss/)).toBeTruthy();
  expect(screen.queryByText(/Opening Duals/)).toBeNull();
  expect(screen.queryByText(/Jordan Little/)).toBeNull();
  expect(screen.queryByText('Unable to load the season detail.')).toBeNull();
});
