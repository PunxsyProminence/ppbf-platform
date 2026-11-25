/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { useLayoutEffect } from 'react';

import { formatGymDateTimeShort } from '@/src/lib/gymTime';

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
    // The time in gym time, not the stored instant (Q4.4 A).
    const gymTime = formatGymDateTimeShort(THREAD.posts[0].created_at);
    expect(gymTime).toBeTruthy();
    expect(posts[0]).toHaveTextContent(`First Guardian · ${gymTime}`);
    expect(posts[0].textContent).not.toContain(THREAD.posts[0].created_at);
    expect(screen.getByLabelText('Reply to First Guardian')).toBeInTheDocument();
    expect(screen.getByText(/The gym's staff can read them; of the family, only the guardian\s+who wrote one sees it/)).toBeInTheDocument();
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
    let releaseSecond: () => void = () => {};
    const fetchMock = install(() => {
      reads += 1;
      // On the second read p1 has been seen: New stays all the same.
      const posts = THREAD.posts.map((post) => ({ ...post, new_to_me: reads === 1 && post.new_to_me }));
      const response = jsonResponse({ ok: true, items: [{ ...THREAD, posts }] });
      return reads === 1 ? response : new Promise<Response>((resolve) => { releaseSecond = () => resolve(response); });
    });
    render(<FamilyThreadsForStaff athleteId="ath-1" />);
    const box = await screen.findByLabelText('Reply to First Guardian');

    fireEvent.change(box, { target: { value: '  See you then.  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    });

    expect(bodies(fetchMock, '/api/pilot/coach/family-threads')).toEqual([{ thread_id: 't1', text: 'See you then.' }]);
    // While it is read again, the list stays on screen.
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByText('Is practice on Saturday?')).toBeInTheDocument();
    expect(screen.queryByText('Loading messages from the family…')).toBeNull();
    await act(async () => releaseSecond());
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

    fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    expect(await screen.findByText('Write a reply before sending.')).toBeInTheDocument();
    expect(bodies(fetchMock, '/api/pilot/coach/family-threads')).toEqual([]);

    fireEvent.change(box, { target: { value: 'Long words' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    });
    expect(await screen.findByText(/not sent; it is still in the box\. A message is at most 2000 characters\./)).toBeInTheDocument();
    expect(box).toHaveValue('Long words');

    status = 500;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    });
    await waitFor(() => expect(screen.queryByText(/2000 characters/)).toBeNull());
    expect(screen.getByText('Your reply was not sent; it is still in the box.')).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).toBeNull();
  });

  test('while a reply is sent, only its thread is held: its button is disabled and says so, its box is read-only, a second tap sends nothing', async () => {
    const second: StaffThreadView = {
      ...THREAD, thread_id: 't2', guardian_name: 'Second Guardian',
      posts: [{ post_id: 'q1', from: 'guardian', staff_name: null, text: 'Can she move up a class?', created_at: '2026-11-25T06:00:00.000Z', new_to_me: false }],
    };
    let release: (response: Response) => void = () => {};
    const fetchMock = install(
      () => jsonResponse({ ok: true, items: [THREAD, second] }),
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    render(<FamilyThreadsForStaff athleteId="ath-1" />);
    const box = await screen.findByLabelText('Reply to First Guardian');
    fireEvent.change(box, { target: { value: 'See you then.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    });

    const held = screen.getByRole('button', { name: 'Sending reply to First Guardian' });
    expect(held).toBeDisabled();
    expect(held).toHaveTextContent('Sending…');
    expect(box).toHaveAttribute('readonly');
    fireEvent.click(held);
    expect(bodies(fetchMock, '/api/pilot/coach/family-threads')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send reply to Second Guardian' })).toBeEnabled();
    expect(screen.getByLabelText('Reply to Second Guardian')).not.toHaveAttribute('readonly');

    await act(async () => release(jsonResponse({ ok: true }, true, 201)));
    expect(await screen.findByRole('button', { name: 'Send reply to First Guardian' })).toBeEnabled();
  });

  test('a reply that fails after the coach has moved to another athlete is told on the athlete now on screen', async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const key = String(url);
      if (key.endsWith('/api/pilot/coach/family-threads') && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      if (key.includes('athlete_id=ath-1')) return Promise.resolve(jsonResponse({ ok: true, items: [THREAD] }));
      if (key.includes('athlete_id=ath-2')) return Promise.resolve(jsonResponse({ ok: true, items: [] }));
      throw new Error(`Unexpected fetch: ${key}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { rerender } = render(<FamilyThreadsForStaff athleteId="ath-1" />);
    fireEvent.change(await screen.findByLabelText('Reply to First Guardian'), { target: { value: 'See you then.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
    });

    rerender(<FamilyThreadsForStaff athleteId="ath-2" />);
    expect(await screen.findByText('No messages from the family yet.')).toBeInTheDocument();
    await act(async () => release(jsonResponse({ error: 'down' }, false, 500)));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your reply to First Guardian, for the athlete you were on before, was not sent. Go back to them; it is still in its box.',
    );

    // Back on that athlete, the words are in the box and the failure is under its thread.
    rerender(<FamilyThreadsForStaff athleteId="ath-1" />);
    expect(await screen.findByLabelText('Reply to First Guardian')).toHaveValue('See you then.');
    expect(screen.getByText('Your reply was not sent; it is still in the box.')).toBeInTheDocument();
    expect(screen.queryByText(/for the athlete you were on before/)).toBeNull();
  });

  test("after a switch, the last child's messages are not shown while the next child's are read; an unsent reply is kept", async () => {
    let releaseB: (response: Response) => void = () => {};
    const fetchMock = jest.fn((url: string) => {
      const key = String(url);
      if (key.includes('athlete_id=ath-1')) return Promise.resolve(jsonResponse({ ok: true, items: [THREAD] }));
      if (key.includes('athlete_id=ath-2')) return new Promise<Response>((resolve) => { releaseB = resolve; });
      throw new Error(`Unexpected fetch: ${key}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    // Looks at the page as the render for the next child reaches it, before the panel's own
    // effects run: the last child's words must not be there even for that one paint.
    const underNext: string[] = [];
    function Probe({ athleteId }: Readonly<{ athleteId: string }>) {
      useLayoutEffect(() => {
        if (athleteId === 'ath-2' && document.body.textContent?.includes('Is practice on Saturday?')) underNext.push(athleteId);
      });
      return null;
    }
    const both = (athleteId: string) => (
      <>
        <FamilyThreadsForStaff athleteId={athleteId} />
        <Probe athleteId={athleteId} />
      </>
    );
    const { rerender } = render(both('ath-1'));
    fireEvent.change(await screen.findByLabelText('Reply to First Guardian'), { target: { value: 'Half written' } });

    rerender(both('ath-2'));
    expect(underNext).toEqual([]);
    expect(screen.queryByText('Is practice on Saturday?')).toBeNull();
    expect(screen.queryByLabelText('Reply to First Guardian')).toBeNull();
    expect(screen.getByText('Loading messages from the family…')).toBeInTheDocument();
    await act(async () => releaseB(jsonResponse({ ok: true, items: [] })));
    expect(await screen.findByText('No messages from the family yet.')).toBeInTheDocument();

    rerender(both('ath-1'));
    expect(await screen.findByLabelText('Reply to First Guardian')).toHaveValue('Half written');
  });

  test("a late answer for the last child, arriving after the next child's, does not replace it", async () => {
    let releaseA: (response: Response) => void = () => {};
    let readsOfA = 0;
    global.fetch = jest.fn((url: string) => {
      const key = String(url);
      if (key.includes('athlete_id=ath-1')) {
        readsOfA += 1;
        return new Promise<Response>((resolve) => { releaseA = resolve; });
      }
      if (key.includes('athlete_id=ath-2')) return Promise.resolve(jsonResponse({ ok: true, items: [] }));
      throw new Error(`Unexpected fetch: ${key}`);
    }) as unknown as typeof fetch;
    const { rerender } = render(<FamilyThreadsForStaff athleteId="ath-1" />);
    await waitFor(() => expect(readsOfA).toBe(1));
    rerender(<FamilyThreadsForStaff athleteId="ath-2" />);
    expect(await screen.findByText('No messages from the family yet.')).toBeInTheDocument();

    await act(async () => releaseA(jsonResponse({ ok: true, items: [THREAD] })));
    expect(screen.getByText('No messages from the family yet.')).toBeInTheDocument();
    expect(screen.queryByText('Is practice on Saturday?')).toBeNull();
  });

  test('coming back to a child is a new visit: a post read on the last visit is not New again', async () => {
    let readsOfA = 0;
    global.fetch = jest.fn((url: string) => {
      const key = String(url);
      if (key.includes('athlete_id=ath-1')) {
        readsOfA += 1;
        const posts = THREAD.posts.map((post) => ({ ...post, new_to_me: readsOfA === 1 && post.new_to_me }));
        return Promise.resolve(jsonResponse({ ok: true, items: [{ ...THREAD, posts }] }));
      }
      if (key.includes('athlete_id=ath-2')) return Promise.resolve(jsonResponse({ ok: true, items: [] }));
      throw new Error(`Unexpected fetch: ${key}`);
    }) as unknown as typeof fetch;
    const { rerender } = render(<FamilyThreadsForStaff athleteId="ath-1" />);
    const first = await screen.findByText('Is practice on Saturday?');
    expect(within(first.closest('li') as HTMLElement).getByText('New')).toBeInTheDocument();

    rerender(<FamilyThreadsForStaff athleteId="ath-2" />);
    await screen.findByText('No messages from the family yet.');
    rerender(<FamilyThreadsForStaff athleteId="ath-1" />);
    await waitFor(() => expect(readsOfA).toBe(2));
    const again = await screen.findByText('Is practice on Saturday?');
    expect(within(again.closest('li') as HTMLElement).queryByText('New')).toBeNull();
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
      show(postId: string, ratio: number, visibleHeight: number, times: number) {
        const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readPost === postId);
        if (!target) return;
        const entry = {
          target, isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: visibleHeight }, rootBounds: { height: 800 },
        } as unknown as IntersectionObserverEntry;
        this.callback(Array.from({ length: times }, () => entry), this as unknown as IntersectionObserver);
      }
    }
    const show = (postId: string, ratio: number, visibleHeight = 0, times = 1) =>
      FakeObserver.instances.forEach((observer) => observer.show(postId, ratio, visibleHeight, times));
    const watched = () => FakeObserver.instances.flatMap((observer) => [...observer.observed])
      .map((element) => (element as HTMLElement).dataset.readPost);

    beforeEach(() => {
      FakeObserver.instances = [];
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
    });
    afterEach(() => {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    });

    test('only a new guardian post is watched; under half is not a read; half is, once, and tells the page', async () => {
      const fetchMock = install(() => jsonResponse({ ok: true, items: [THREAD] }));
      const onSeen = jest.fn();
      render(<FamilyThreadsForStaff athleteId="ath-1" onSeen={onSeen} />);
      await screen.findByText('Is practice on Saturday?');
      await waitFor(() => expect(watched()).toEqual(['p1']));

      await act(async () => show('p1', 0.4));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([]);

      // One batch naming the post twice still sends it once; once sent it is no longer watched.
      await act(async () => show('p1', 0.5, 0, 2));
      expect(watched()).toEqual([]);
      await act(async () => show('p1', 0.9));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([{ post_id: 'p1' }]);
      await waitFor(() => expect(onSeen).toHaveBeenCalledTimes(1));
    });

    test('a post taller than the screen counts once it fills half the screen', async () => {
      const fetchMock = install(() => jsonResponse({ ok: true, items: [THREAD] }));
      render(<FamilyThreadsForStaff athleteId="ath-1" />);
      await waitFor(() => expect(watched()).toEqual(['p1']));
      await act(async () => show('p1', 0.2, 399));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([]);
      await act(async () => show('p1', 0.2, 400));
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toEqual([{ post_id: 'p1' }]);
    });

    test('a failed write is not sent again at once (no loop on a refusal); the next read of the list watches it again', async () => {
      const fetchMock = install(
        () => jsonResponse({ ok: true, items: [THREAD] }),
        undefined,
        () => jsonResponse({ error: 'Forbidden: no active staff seat in this gym.' }, false, 403),
      );
      const onSeen = jest.fn();
      render(<FamilyThreadsForStaff athleteId="ath-1" onSeen={onSeen} />);
      await screen.findByText('Is practice on Saturday?');
      await waitFor(() => expect(watched()).toEqual(['p1']));

      await act(async () => show('p1', 0.9));
      await waitFor(() => expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toHaveLength(1));
      await act(async () => show('p1', 0.9));
      expect(watched()).toEqual([]);
      expect(bodies(fetchMock, '/api/pilot/coach/family-thread-reads')).toHaveLength(1);
      expect(onSeen).not.toHaveBeenCalled();

      // A reply re-reads the list: the post is watched again.
      fireEvent.change(screen.getByLabelText('Reply to First Guardian'), { target: { value: 'Yes.' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send reply to First Guardian' }));
      });
      await waitFor(() => expect(watched()).toEqual(['p1']));
    });
  });
});

describe('FamilyThreadsUnread', () => {
  const ROSTER = [
    { athlete_id: 'ath-1', full_name: 'Athlete One' },
    { athlete_id: 'ath-2', full_name: '  ' },
    { athlete_id: 'ath-3', full_name: 'Athlete Three' },
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
      { athlete_id: 'ath-3', unseen: 0 },
    ] }));
    const onChoose = jest.fn();
    render(<FamilyThreadsUnread athletes={ROSTER} refreshKey="" onChoose={onChoose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Athlete One (2 new)' }));
    expect(onChoose).toHaveBeenCalledWith('ath-1');
    expect(screen.getByRole('button', { name: 'Unnamed athlete (1 new)' })).toBeInTheDocument();
    expect(screen.queryByText(/4 new/)).toBeNull();
    expect(screen.queryByText(/Athlete Three/)).toBeNull();
    expect(screen.getByRole('group', { name: 'New messages from families' })).toBeInTheDocument();
  });

  test('until the first answer it says it is checking, never "nothing new"', async () => {
    let release: (response: Response) => void = () => {};
    installUnread(() => new Promise<Response>((resolve) => { release = resolve; }) as unknown as Response);
    render(<FamilyThreadsUnread athletes={ROSTER} refreshKey="" onChoose={jest.fn()} />);
    expect(screen.getByText('Checking for new messages from families…')).toBeInTheDocument();
    await act(async () => release(jsonResponse({ ok: true, items: [{ athlete_id: 'ath-1', unseen: 1 }] })));
    expect(await screen.findByRole('button', { name: 'Athlete One (1 new)' })).toBeInTheDocument();
    expect(screen.queryByText('Checking for new messages from families…')).toBeNull();
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
