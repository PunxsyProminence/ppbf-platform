/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import FamilyThreadsForStaff, { FamilyThreadsUnread, type StaffThreadView } from './FamilyThreadsForStaff';

// The staff panel for messages a guardian started (W4 item 4, PM-2). Who may read, answer and
// mark read is proved on Postgres in familyThreadsStaff.pg.test.ts; here: what the panel shows,
// what it sends, and that a failure is said, never shown as "no messages".

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const THREAD: StaffThreadView = {
  thread_id: 't1',
  athlete_id: 'ath-1',
  created_at: '2026-11-25T03:00:00.000Z',
  guardian_name: 'First Guardian',
  posts: [
    { post_id: 'p1', from: 'guardian', staff_name: null, text: 'Is practice on Saturday?', created_at: '2026-11-25T03:00:00.000Z', new_to_me: true },
    { post_id: 'p2', from: 'staff', staff_name: 'Coach Name', text: 'Yes, see you Saturday.', created_at: '2026-11-25T04:00:00.000Z', new_to_me: false },
    { post_id: 'p3', from: 'guardian', staff_name: null, text: 'Thank you!', created_at: '2026-11-25T05:00:00.000Z', new_to_me: false },
  ],
};

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function install(list: Handler, post: Handler = () => jsonResponse({ ok: true }, true, 201), read: Handler = () => jsonResponse({ ok: true })) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const key = String(url);
    if (key.includes('/api/pilot/coach/family-thread-reads')) return read(init);
    if (key.includes('/api/pilot/coach/family-threads?athlete_id=ath-1') && init?.method !== 'POST') return list(init);
    if (key.endsWith('/api/pilot/coach/family-threads') && init?.method === 'POST') return post(init);
    throw new Error(`Unexpected fetch: ${key}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function bodies(fetchMock: jest.Mock, path: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith(path) && (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('FamilyThreadsForStaff', () => {
  test("shows each message with the guardian's name, the replies, and New on what this staff member has not seen", async () => {
    install(() => jsonResponse({ ok: true, items: [THREAD] }));
    render(<FamilyThreadsForStaff athleteId="ath-1" />);

    const thread = await screen.findByRole('list', { name: 'Message from First Guardian' });
    const posts = within(thread).getAllByRole('listitem');
    expect(posts.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^First Guardian.*New.*Is practice on Saturday\?$/),
      expect.stringMatching(/^Coach Name.*Yes, see you Saturday\.$/),
      expect.stringMatching(/^First Guardian.*Thank you!$/),
    ]);
    expect(within(posts[2]).queryByText('New')).toBeNull();
    expect(screen.getByLabelText('Reply to First Guardian')).toBeInTheDocument();
    expect(screen.getByText(/Only the guardian who wrote one sees it/)).toBeInTheDocument();
  });

  test('none yet says so; a failed read says so and Check again reads again', async () => {
    let fail = true;
    const fetchMock = install(() => (fail ? jsonResponse({ error: 'down' }, false, 500) : jsonResponse({ ok: true, items: [] })));
    render(<FamilyThreadsForStaff athleteId="ath-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This is not a statement that there are none.');
    expect(screen.queryByText('No messages from the family yet.')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('No messages from the family yet.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a reply is sent for its thread, the box empties, the list is read again, and New stays for the visit', async () => {
    let reads = 0;
    const fetchMock = install(() => {
      reads += 1;
      // On the second read p1 has been seen: New stays all the same.
      const posts = THREAD.posts.map((post) => ({ ...post, new_to_me: reads === 1 && post.new_to_me }));
      return jsonResponse({ ok: true, items: [{ ...THREAD, posts }] });
    });
    render(<FamilyThreadsForStaff athleteId="ath-1" />);
    const box = await screen.findByLabelText('Reply to First Guardian');

    fireEvent.change(box, { target: { value: '  See you then.  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    });

    expect(bodies(fetchMock, '/api/pilot/coach/family-threads')).toEqual([{ thread_id: 't1', text: 'See you then.' }]);
    await waitFor(() => expect(reads).toBe(2));
    expect(box).toHaveValue('');
    expect(within(screen.getByText('Is practice on Saturday?').closest('li') as HTMLElement).getByText('New')).toBeInTheDocument();
  });

  test('a blank reply is not sent; a refused one keeps the words and says why; a server fault does not repeat its text', async () => {
    let status = 400;
    const fetchMock = install(
      () => jsonResponse({ ok: true, items: [THREAD] }),
      () => jsonResponse({ error: status === 400 ? 'A message is at most 2000 characters.' : 'internal detail' }, false, status),
    );
    render(<FamilyThreadsForStaff athleteId="ath-1" />);
    const box = await screen.findByLabelText('Reply to First Guardian');

    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText('Write a reply before sending.')).toBeInTheDocument();
    expect(bodies(fetchMock, '/api/pilot/coach/family-threads')).toEqual([]);

    fireEvent.change(box, { target: { value: 'Long words' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    });
    expect(await screen.findByText(/not sent; it is still in the box\. A message is at most 2000 characters\./)).toBeInTheDocument();
    expect(box).toHaveValue('Long words');

    status = 500;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    });
    await waitFor(() => expect(screen.queryByText(/2000 characters/)).toBeNull());
    expect(screen.getByText('Your reply was not sent; it is still in the box.')).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).toBeNull();
  });

  describe('seeing a guardian post (half on screen, FC-05 Q-1 A)', () => {
    class FakeObserver {
      static instances: FakeObserver[] = [];
      observed = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {
        FakeObserver.instances.push(this);
      }
      observe(element: Element) { this.observed.add(element); }
      unobserve(element: Element) { this.observed.delete(element); }
      disconnect() { this.observed.clear(); }
      show(postId: string, ratio: number) {
        const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readPost === postId);
        if (!target) return;
        this.callback([{
          target, isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: 0 }, rootBounds: { height: 800 },
        } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    const show = (postId: string, ratio: number) => FakeObserver.instances.forEach((observer) => observer.show(postId, ratio));
    const watched = () => FakeObserver.instances.flatMap((observer) => [...observer.observed])
      .map((element) => (element as HTMLElement).dataset.readPost);

    beforeEach(() => {
      FakeObserver.instances = [];
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
    });
    afterEach(() => {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    });

    test('only a new guardian post is watched; under half is not a read; half is, once; a failed write is tried again', async () => {
      let readOk = false;
      const fetchMock = install(
        () => jsonResponse({ ok: true, items: [THREAD] }),
        undefined,
        () => jsonResponse({ ok: readOk }, readOk, readOk ? 200 : 500),
      );
      render(<FamilyThreadsForStaff athleteId="ath-1" />);
      await screen.findByText('Is practice on Saturday?');
      await waitFor(() => expect(watched()).toEqual(['p1']));

      await act(async () => show('p1', 0.4));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([]);

      await act(async () => show('p1', 0.5));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([{ post_id: 'p1' }]);
      // The write failed: watched again, and sent again when next on screen.
      await waitFor(() => expect(watched()).toEqual(['p1']));
      readOk = true;
      await act(async () => show('p1', 0.9));
      await act(async () => show('p1', 0.9));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([{ post_id: 'p1' }, { post_id: 'p1' }]);
    });
  });
});

describe('FamilyThreadsUnread', () => {
  const ROSTER = [
    { athlete_id: 'ath-1', full_name: 'Athlete One' },
    { athlete_id: 'ath-2', full_name: '  ' },
  ];

  function installUnread(answer: () => Response) {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/pilot/coach/family-threads/unread')) return answer();
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('names each athlete on the roster with new messages and how many; a tap chooses that athlete', async () => {
    installUnread(() => jsonResponse({ ok: true, items: [
      { athlete_id: 'ath-1', unseen: 2 }, { athlete_id: 'ath-2', unseen: 1 }, { athlete_id: 'ath-not-listed', unseen: 4 },
    ] }));
    const onChoose = jest.fn();
    render(<FamilyThreadsUnread athletes={ROSTER} refreshKey="" onChoose={onChoose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Athlete One (2 new)' }));
    expect(onChoose).toHaveBeenCalledWith('ath-1');
    expect(screen.getByRole('button', { name: 'Unnamed athlete (1 new)' })).toBeInTheDocument();
    expect(screen.queryByText(/4 new/)).toBeNull();
  });

  test('nothing new shows nothing; a failed read says so and reads again on request', async () => {
    let fail = true;
    const fetchMock = installUnread(() => (fail ? jsonResponse({ error: 'down' }, false, 500) : jsonResponse({ ok: true, items: [] })));
    const { container } = render(<FamilyThreadsUnread athletes={ROSTER} refreshKey="" onChoose={jest.fn()} />);

    expect(await screen.findByText('New messages from families could not be checked.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check for new messages again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('reads again when the chosen athlete changes', async () => {
    const fetchMock = installUnread(() => jsonResponse({ ok: true, items: [] }));
    const { rerender } = render(<FamilyThreadsUnread athletes={ROSTER} refreshKey="" onChoose={jest.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<FamilyThreadsUnread athletes={ROSTER} refreshKey="ath-1" onChoose={jest.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
