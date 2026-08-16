/**
 * @jest-environment jsdom
 */

// The external-competition skeleton page (owner decision 2026-08-15:
// deliberately skeletal). What these pin: the page states its own limits
// instead of pretending; competitions render from the API; creating one
// posts the form; opening a competition loads its entries; adding an entry
// posts the LINK (an athlete_id, nothing else); and a duplicate entry
// surfaces the server's message instead of a silent success.

import { act, fireEvent, render, screen } from '@testing-library/react';

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
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      options.capture?.posts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (init?.method === 'POST') {
      options.capture?.posts.push({ url, body: JSON.parse(String(init.body)) });
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
      return { ok: true, json: async () => ({ items: [COMPETITION] }) } as Response;
    }
    if (url.includes('/external-competition/entries')) {
      return { ok: true, json: async () => ({ items: [ENTRY] }) } as Response;
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
