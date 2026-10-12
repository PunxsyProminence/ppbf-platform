/**
 * @jest-environment jsdom
 */

/**
 * WO-PH-04: the parent hub's Observations tab -- the form and this
 * guardian's history for the selected child.
 *
 *   the form posts the selected child, the category, the rating or null, and
 *   the notes; a saved entry appears from the server's answer;
 *
 *   a refused write keeps what was typed and says so;
 *
 *   the history is the selected child's, and a sibling's answer -- late or
 *   not -- never shows under this child's name;
 *
 *   a read that did not answer is not an empty history; no rating is shown
 *   as a bar or a percentage.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const HISTORY: Record<string, unknown[]> = {
  ath_1: [
    { note_id: 'o2', category: 'sleep_recovery', rating: null, notes: 'Slept badly before the test.', created_at: '2026-10-10T20:00:00.000Z' },
    { note_id: 'o1', category: 'energy', rating: 7, notes: 'Bouncing off the walls.', created_at: '2026-10-08T20:00:00.000Z' },
  ],
  ath_2: [
    { note_id: 'o9', category: 'motivation', rating: 4, notes: 'Sibling: quiet week.', created_at: '2026-10-09T20:00:00.000Z' },
  ],
};

type GetHandler = (athleteId: string, init?: RequestInit) => Promise<Response>;
type PostHandler = (body: Record<string, unknown>) => Promise<Response>;

function installFetch(options: { get?: GetHandler; post?: PostHandler } = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/parent/observations')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (options.post) return options.post(body);
        return jsonResponse({
          ok: true,
          item: { note_id: 'o_new', category: body.category, rating: body.rating, notes: body.notes, created_at: '2026-10-12T15:00:00.000Z' },
        }, true, 201);
      }
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      if (options.get) return options.get(athleteId, init);
      return jsonResponse({ ok: true, items: HISTORY[athleteId] ?? [] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderObservations() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Observations' }));
  });
}

function history(): HTMLElement {
  return screen.getByRole('region', { name: 'What you have written' });
}

function posts(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('/api/pilot/parent/observations') && (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

async function fillAndSend(fields: { category?: string; rating?: string; notes: string }) {
  if (fields.category) {
    fireEvent.change(screen.getByLabelText('What it is about'), { target: { value: fields.category } });
  }
  if (fields.rating !== undefined) {
    fireEvent.change(screen.getByLabelText(/^Rating/), { target: { value: fields.rating } });
  }
  fireEvent.change(screen.getByLabelText('What you noticed'), { target: { value: fields.notes } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the history', () => {
  test('shows this child’s entries, newest first, with the category, the rating in words when given, and the date', async () => {
    installFetch();
    await renderObservations();
    await waitFor(() => expect(within(history()).getAllByRole('listitem')).toHaveLength(2));
    const [first, second] = within(history()).getAllByRole('listitem');
    expect(first).toHaveTextContent('Sleep & recovery');
    expect(first).not.toHaveTextContent('out of 10');
    expect(first).toHaveTextContent('Slept badly before the test.');
    expect(second).toHaveTextContent('Energy · 7 out of 10');
    expect(second).toHaveTextContent('Bouncing off the walls.');
    expect(history().textContent ?? '').not.toMatch(/\d+\s*%/);
    expect(history().textContent).not.toContain('Sibling: quiet week.');
  });

  test('a failed read is Unavailable, not an empty history', async () => {
    installFetch({ get: async () => jsonResponse({ error: 'down' }, false) });
    await renderObservations();
    await within(history()).findByText('Unavailable - your observations could not be read. This is not an empty list.');
    expect(within(history()).queryByText('Nothing written about this child yet.')).toBeNull();
  });

  test('an empty history says so', async () => {
    installFetch({ get: async () => jsonResponse({ ok: true, items: [] }) });
    await renderObservations();
    await within(history()).findByText('Nothing written about this child yet.');
  });

  test('switching child moves the history, and the child left behind’s late answer is ignored', async () => {
    let releaseFirst: (() => void) | null = null;
    let firstCalls = 0;
    installFetch({
      get: (athleteId) => {
        if (athleteId === 'ath_1') {
          firstCalls += 1;
          if (firstCalls === 1) return Promise.resolve(jsonResponse({ ok: true, items: HISTORY.ath_1 }));
          // A second read for the first child answers only when released.
          return new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(jsonResponse({ ok: true, items: HISTORY.ath_1 }));
          });
        }
        return Promise.resolve(jsonResponse({ ok: true, items: HISTORY.ath_2 }));
      },
    });
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await within(history()).findByText('Sibling: quiet week.');
    expect(within(history()).queryByText('Bouncing off the walls.')).toBeNull();

    // Back to the first child (its read hangs), then to the second again;
    // the first child's answer lands late.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'First Child' }));
    });
    expect(within(history()).queryByText('Sibling: quiet week.')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await within(history()).findByText('Sibling: quiet week.');
    await act(async () => {
      (releaseFirst as (() => void) | null)?.();
    });
    expect(within(history()).queryByText('Bouncing off the walls.')).toBeNull();
    expect(within(history()).getByText('Sibling: quiet week.')).toBeInTheDocument();
  });
});

describe('the form', () => {
  test('posts the selected child, the category, the rating and the notes; the saved entry comes from the answer', async () => {
    const fetchMock = installFetch();
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');

    await fillAndSend({ category: 'motivation', rating: '8', notes: '  Asked to go early every day.  ' });

    expect(posts(fetchMock)).toEqual([{ athlete_id: 'ath_1', category: 'motivation', rating: 8, notes: 'Asked to go early every day.' }]);
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST' && String(c[0]).includes('/observations'));
    expect((call?.[1] as RequestInit).credentials).toBe('include');
    await within(history()).findByText('Asked to go early every day.');
    expect(within(history()).getAllByRole('listitem')[0]).toHaveTextContent('Motivation · 8 out of 10');
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByLabelText('What you noticed')).toHaveValue('');
  });

  test('no rating is the default and posts null', async () => {
    const fetchMock = installFetch();
    await renderObservations();
    await fillAndSend({ notes: 'Fine week.' });
    expect(posts(fetchMock)).toEqual([{ athlete_id: 'ath_1', category: 'energy', rating: null, notes: 'Fine week.' }]);
  });

  test('empty notes send nothing', async () => {
    const fetchMock = installFetch();
    await renderObservations();
    fireEvent.change(screen.getByLabelText('What you noticed'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);
    });
    expect(posts(fetchMock)).toEqual([]);
  });

  test('a refused write keeps what was typed and says so; nothing is added to the history', async () => {
    installFetch({ post: async () => jsonResponse({ ok: false, error: 'Forbidden: parent not linked to athlete' }, false, 403) });
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');
    await fillAndSend({ notes: 'Keep me.' });

    // In words a family can act on, not the server's.
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not save -- this child is not on your account. What you wrote is still in the box.');
    expect(screen.getByRole('alert').textContent).not.toContain('Forbidden');
    expect(screen.getByLabelText('What you noticed')).toHaveValue('Keep me.');
    expect(within(history()).getAllByRole('listitem')).toHaveLength(2);
  });

  test('an entry saved for one child is not added under the sibling switched to while it was being sent', async () => {
    let release: (() => void) | null = null;
    installFetch({
      post: (body) => new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({
          ok: true,
          item: { note_id: 'o_new', category: body.category, rating: null, notes: body.notes, created_at: '2026-10-12T15:00:00.000Z' },
        }, true, 201));
      }),
    });
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');
    await fillAndSend({ notes: 'For the first child.' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await within(history()).findByText('Sibling: quiet week.');
    await act(async () => {
      (release as (() => void) | null)?.();
    });
    expect(within(history()).queryByText('For the first child.')).toBeNull();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  test('a refused-as-invalid write says what to fix, in plain words', async () => {
    installFetch({ post: async () => jsonResponse({ ok: false, error: 'Observation is invalid: athlete_id, a category (energy, motivation, sleep_recovery, general_development)…' }, false, 400) });
    await renderObservations();
    await fillAndSend({ notes: 'x' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('pick what it is about and write what you noticed (up to 4000 characters)');
    expect(alert.textContent).not.toContain('sleep_recovery');
  });

  test('a draft typed about one child is not left in the box for the sibling', async () => {
    const fetchMock = installFetch();
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');
    fireEvent.change(screen.getByLabelText('What you noticed'), { target: { value: 'About the first child.' } });
    fireEvent.change(screen.getByLabelText(/^Rating/), { target: { value: '9' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    expect(screen.getByLabelText('What you noticed')).toHaveValue('');
    expect(screen.getByLabelText(/^Rating/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(posts(fetchMock)).toEqual([]);
  });

  test('a save whose row could not be read back is still Saved, and the history is read again', async () => {
    let gets = 0;
    installFetch({
      get: async () => {
        gets += 1;
        return jsonResponse({ ok: true, items: gets === 1 ? HISTORY.ath_1 : [
          { note_id: 'o_new', category: 'energy', rating: null, notes: 'Read again.', created_at: '2026-10-12T15:00:00.000Z' },
          ...HISTORY.ath_1,
        ] });
      },
      post: async () => jsonResponse({ ok: true, item: null }, true, 201),
    });
    await renderObservations();
    await within(history()).findByText('Bouncing off the walls.');
    await fillAndSend({ notes: 'Read again.' });
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    await within(history()).findByText('Read again.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('says it is saved, never that a coach has it', async () => {
    installFetch();
    await renderObservations();
    await fillAndSend({ notes: 'x' });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Write down what you notice');
    expect(text).not.toMatch(/Send to Coach|Sent to the coach|Tell the coach what you notice/);
  });

  test('a category the screen does not know makes the history unreadable rather than crashing', async () => {
    installFetch({ get: async () => jsonResponse({ ok: true, items: [{ note_id: 'x', category: 'toString', rating: null, notes: 'n', created_at: '2026-10-12T15:00:00.000Z' }] }) });
    await renderObservations();
    await within(history()).findByText('Unavailable - your observations could not be read. This is not an empty list.');
  });

  test('the placeholder and its percentage bar are gone', async () => {
    installFetch();
    await renderObservations();
    expect(document.body.textContent).not.toContain('there is no backend feed or entry form for parent observations');
  });
});
