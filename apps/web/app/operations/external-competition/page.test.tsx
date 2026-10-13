/**
 * @jest-environment jsdom
 */

// The external-competition skeleton page (owner decision 2026-08-15:
// deliberately skeletal). What these pin: the page states its own limits
// instead of pretending; competitions render from the API; creating one
// posts the form; opening a competition loads its entries; adding an entry
// posts the LINK (an athlete_id, nothing else); and a duplicate entry
// surfaces the server's message instead of a silent success.

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ExternalCompetitionPlatformPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const COMPETITION = {
  competition_id: 'comp-1',
  competition_name: 'Regional Open 2026',
  competition_date: '2026-12-05',
  location: 'Pittsburgh',
  sanctioning_body: 'USA Boxing',
  status: 'planned',
  notes: '',
};

const ENTRY = {
  entry_id: 'entry-1',
  athlete_id: 'ath-1',
  athlete_name: 'Jordan Little',
  status: 'entered',
  result: null,
  lesson_note: '',
};

function mockFetch(options: {
  capture?: { posts: Array<{ url: string; body: unknown }> };
  entryPostStatus?: number;
  entryPostError?: string;
  failCompetitions?: boolean;
  failEntries?: boolean;
  entries?: Array<Record<string, unknown>>;
  /** What the entry list reads once an entry POST has been answered, kept or refused. */
  entriesAfterPost?: Array<Record<string, unknown>>;
  /** Holds every entry POST until it resolves. */
  postGate?: Promise<void>;
}) {
  let posted = false;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      options.capture?.posts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (init?.method === 'POST') {
      options.capture?.posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes('/entries') && options.postGate) await options.postGate;
      if (url.includes('/entries')) posted = true;
      if (url.includes('/entries') && options.entryPostStatus) {
        return {
          ok: false,
          status: options.entryPostStatus,
          json: async () => ({ error: options.entryPostError }),
        } as Response;
      }
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/external-competition/competitions')) {
      if (options.failCompetitions) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ items: [COMPETITION] }) } as Response;
    }
    if (url.includes('/external-competition/entries')) {
      if (options.failEntries) return { ok: false, status: 500, json: async () => ({}) } as Response;
      const items = posted && options.entriesAfterPost ? options.entriesAfterPost : options.entries ?? [ENTRY];
      return { ok: true, json: async () => ({ items }) } as Response;
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
    render(<ExternalCompetitionPlatformPage />);
  });

  expect(screen.getByText(/Minimal skeleton by owner decision/)).toBeTruthy();
  expect(screen.getByText(/stay unbuilt until real competitions define/)).toBeTruthy();
});

test('competitions render from the API read', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });

  expect(await screen.findByText('Regional Open 2026')).toBeTruthy();
});

test('a failed competitions read never says there are none on record', async () => {
  global.fetch = mockFetch({ failCompetitions: true });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });

  expect(await screen.findByText('Could not load competitions')).toBeTruthy();
  expect(screen.queryByText('No competitions on record')).toBeNull();
});

test('a failed entry-list read never says no athletes are entered', async () => {
  global.fetch = mockFetch({ failEntries: true });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open entries' }));
  });

  expect(await screen.findByText(/entry list could not be loaded/)).toBeTruthy();
  expect(screen.queryByText('No athletes entered.')).toBeNull();
});

test('creating a competition posts the form', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add competition' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Competition name'), { target: { value: 'State Finals' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-02-20' } });
    fireEvent.change(screen.getByLabelText('Sanctioning body (optional)'), { target: { value: 'USA Boxing' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save competition' }));
  });

  const post = capture.posts.find((entry) => entry.url.includes('/competitions'));
  expect(post).toBeTruthy();
  expect(post?.body).toEqual({
    competition_name: 'State Finals',
    competition_date: '2027-02-20',
    location: '',
    sanctioning_body: 'USA Boxing',
  });
});

test('opening a competition shows its entries; adding one posts the link only', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open entries' }));
  });

  expect(await screen.findByText(/Jordan Little/)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Enter athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
  });

  const post = capture.posts.find((entry) => entry.url.includes('/entries'));
  expect(post).toBeTruthy();
  // The link and nothing else: no name, no dob, no athlete attribute travels.
  expect(post?.body).toEqual({ competition_id: 'comp-1', athlete_id: 'ath-2' });
});

test('a duplicate entry surfaces the server message', async () => {
  global.fetch = mockFetch({
    capture: { posts: [] },
    entryPostStatus: 409,
    entryPostError: 'This athlete is already entered in this competition.',
  });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open entries' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Enter athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
  });

  expect(await screen.findByText('This athlete is already entered in this competition.')).toBeTruthy();
});

test('a loss cannot leave the page without its lesson; with one it posts the result', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open entries' }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Record result' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'lost' } });
  });
  // The lesson label announces the rule before it fires.
  expect(screen.getByText(/required — a loss without a lesson is refused/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  });
  expect(capture.posts.filter((entry) => entry.url.includes('/entries'))).toHaveLength(0);
  expect(screen.getByText(/A loss cannot be recorded without its lesson/)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Lesson/), { target: { value: 'kept dropping the right hand' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  });
  const patch = capture.posts.find((entry) => entry.url.includes('/entries'));
  expect(patch?.body).toMatchObject({ entry_id: 'entry-1', result: 'lost', lesson_note: 'kept dropping the right hand' });
});

// WO-N8-03: a withdrawn athlete is not shown as a competitor. They leave the Entries list and keep
// their history under Withdrawn; Re-enter goes back through the same entry POST, so every existing
// check runs again.
const WITHDRAWN = {
  entry_id: 'entry-2',
  athlete_id: 'ath-3',
  athlete_name: 'Riley Shaw',
  status: 'withdrawn',
  result: 'lost',
  lesson_note: 'Keep the hands up late.',
};

async function openEntries() {
  await act(async () => {
    render(<ExternalCompetitionPlatformPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open entries' }));
  });
}

test('a withdrawn entry is listed under Withdrawn with its history, not among the entered', async () => {
  global.fetch = mockFetch({ entries: [ENTRY, WITHDRAWN] });
  await openEntries();

  const entered = await screen.findByRole('list', { name: 'Entries' });
  expect(within(entered).getByText(/Jordan Little/)).toBeTruthy();
  expect(within(entered).queryByText(/Riley Shaw/)).toBeNull();

  const withdrawn = screen.getByRole('list', { name: 'Withdrawn' });
  expect(within(withdrawn).getByText(/Riley Shaw · withdrawn/)).toBeTruthy();
  expect(within(withdrawn).getByText('lost')).toBeTruthy();
  expect(within(withdrawn).getByText('Lesson: Keep the hands up late.')).toBeTruthy();
  // Not a competitor: no result or withdraw actions on the withdrawn row.
  expect(within(withdrawn).queryByRole('button', { name: /record result|correct result|withdraw/i })).toBeNull();
});

test('with every entry withdrawn, the page says no athletes are entered and keeps the history', async () => {
  global.fetch = mockFetch({ entries: [WITHDRAWN] });
  await openEntries();

  expect(await screen.findByText('No athletes entered.')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Withdrawn' })).toBeTruthy();
});

test('Re-enter posts the same entry link as adding an athlete', async () => {
  const capture = { posts: [] as Array<{ url: string; body: unknown }> };
  global.fetch = mockFetch({ capture, entries: [WITHDRAWN] });
  await openEntries();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter' }));
  });

  expect(capture.posts).toEqual([
    {
      url: expect.stringContaining('/api/pilot/operations/external-competition/entries'),
      body: { competition_id: 'comp-1', athlete_id: 'ath-3' },
    },
  ]);
});

test('a refused re-entry shows the server message and the row stays withdrawn', async () => {
  global.fetch = mockFetch({ entries: [WITHDRAWN], entryPostStatus: 403, entryPostError: 'Medical clearance is not current.' });
  await openEntries();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter' }));
  });

  expect(await screen.findByText('Medical clearance is not current.')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Withdrawn' })).getByText(/Riley Shaw · withdrawn/)).toBeTruthy();
});

test('a kept re-entry moves the athlete back to Entries', async () => {
  global.fetch = mockFetch({ entries: [WITHDRAWN], entriesAfterPost: [{ ...WITHDRAWN, status: 'entered', result: null, lesson_note: '' }] });
  await openEntries();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter' }));
  });

  expect(within(await screen.findByRole('list', { name: 'Entries' })).getByText(/Riley Shaw/)).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Withdrawn' })).toBeNull();
});

test('a refused re-entry re-reads the list, so a row another screen re-entered leaves Withdrawn', async () => {
  global.fetch = mockFetch({
    entries: [WITHDRAWN],
    entriesAfterPost: [{ ...WITHDRAWN, status: 'entered' }],
    entryPostStatus: 409,
    entryPostError: 'This athlete is already entered in this competition.',
  });
  await openEntries();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter' }));
  });

  expect(await screen.findByText('This athlete is already entered in this competition.')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Entries' })).getByText(/Riley Shaw/)).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Withdrawn' })).toBeNull();
});

test('Re-enter cannot be pressed twice while the first press is in flight', async () => {
  let open: () => void = () => {};
  const postGate = new Promise<void>((resolve) => { open = resolve; });
  global.fetch = mockFetch({ entries: [WITHDRAWN], postGate });
  await openEntries();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter' }));
  });
  expect((screen.getByRole('button', { name: 'Re-enter' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    open();
  });
});
