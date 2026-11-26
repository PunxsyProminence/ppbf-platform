/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentFamilyThreads, { type GuardianThreadView, useParentFamilyThreads } from './ParentFamilyThreads';

// The guardian's "Write to the coach" panel (W4 item 4, PM-3). Who may write, read and mark read
// is proved on Postgres in familyThreadsGuardian.pg.test.ts; here: what the panel shows and sends,
// the per-child count of unseen replies, and that a failure is said, never shown as "none".

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const THREAD: GuardianThreadView = {
  thread_id: 't1',
  athlete_id: 'ath_2',
  created_at: '2026-11-25T03:00:00.000Z',
  posts: [
    { post_id: 'p1', from: 'you', staff_name: null, text: 'Is practice on Saturday?', created_at: '2026-11-25T03:00:00.000Z', new_to_me: false },
    { post_id: 'p2', from: 'staff', staff_name: 'Coach Name', text: 'Yes, see you Saturday.', created_at: '2026-11-25T04:00:00.000Z', new_to_me: true },
    { post_id: 'p3', from: 'staff', staff_name: null, text: 'Bring water.', created_at: '2026-11-25T05:00:00.000Z', new_to_me: false },
  ],
};

const NAMES = new Map([['ath_1', 'First Child'], ['ath_2', 'Second Child']]);

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function install(list: Handler, post: Handler = () => jsonResponse({ ok: true }, true, 201), read: Handler = () => jsonResponse({ ok: true })) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const key = String(url);
    if (key.endsWith('/api/pilot/parent/family-thread-reads')) return read(init);
    if (key.endsWith('/api/pilot/parent/family-threads')) return init?.method === 'POST' ? post(init) : list(init);
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

// The hub's use: the hook once, the count beside the panel.
function Hub({ activeChildId, onTab = true }: Readonly<{ activeChildId: string | null; onTab?: boolean }>) {
  const threads = useParentFamilyThreads();
  const counts = threads.unseenByChild;
  return (
    <>
      <p data-testid="unseen">{counts ? [...counts].map(([id, n]) => `${id}:${n}`).join(' ') || 'none' : 'unavailable'}</p>
      {onTab ? <ParentFamilyThreads threads={threads} childNames={NAMES} activeChildId={activeChildId} /> : null}
    </>
  );
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('a guardian writes to the coach about the chosen child; the box empties and their messages are read again', async () => {
  let reads = 0;
  const fetchMock = install(() => {
    reads += 1;
    return jsonResponse({ ok: true, items: reads === 1 ? [] : [THREAD] });
  });
  render(<Hub activeChildId="ath_1" />);
  expect(await screen.findByText('You have not written to the coach yet.')).toBeInTheDocument();
  expect(screen.getByText('Only you and the gym\'s staff see what you write here, and the replies.')).toBeInTheDocument();

  const box = screen.getByLabelText('Your message about First Child');
  fireEvent.change(box, { target: { value: '  Is practice on Saturday?  ' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to the coach' }));
  });

  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toEqual([{ athlete_id: 'ath_1', text: 'Is practice on Saturday?' }]);
  expect(box).toHaveValue('');
  expect(screen.getByText('Sent. The coach’s reply will show under it.')).toBeInTheDocument();
  await waitFor(() => expect(reads).toBe(2));
});

test('two submits of one box in the same tick send it once, for a new message and for writing again (Codex 4704019860)', async () => {
  let releases: Array<(response: Response) => void> = [];
  const fetchMock = install(
    () => jsonResponse({ ok: true, items: [THREAD] }),
    () => new Promise<Response>((resolve) => { releases.push(resolve); }),
  );
  render(<Hub activeChildId="ath_1" />);
  const againBox = await screen.findByLabelText(/Write again about Second Child/);
  const newBox = screen.getByLabelText('Your message about First Child');
  fireEvent.change(newBox, { target: { value: 'Is practice on Saturday?' } });
  fireEvent.change(againBox, { target: { value: 'Thank you!' } });

  // A double press: both submits land before React re-renders the disabled button.
  act(() => {
    fireEvent.submit(newBox.closest('form') as HTMLFormElement);
    fireEvent.submit(newBox.closest('form') as HTMLFormElement);
    fireEvent.submit(againBox.closest('form') as HTMLFormElement);
    fireEvent.submit(againBox.closest('form') as HTMLFormElement);
  });
  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toEqual([
    { athlete_id: 'ath_1', text: 'Is practice on Saturday?' },
    { thread_id: 't1', text: 'Thank you!' },
  ]);

  // Once a send has answered, the box sends again.
  await act(async () => {
    for (const release of releases) release(jsonResponse({ error: 'down' }, false, 500));
    releases = [];
  });
  await act(async () => {
    fireEvent.submit(newBox.closest('form') as HTMLFormElement);
  });
  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toHaveLength(3);
});

test('with no child chosen there is no box, only how to choose one', async () => {
  install(() => jsonResponse({ ok: true, items: [] }));
  render(<Hub activeChildId={null} />);
  expect(await screen.findByText('Choose your child above to write to the coach.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send to the coach' })).toBeNull();
});

test("shows each message with the child's name, the gym's replies, New on one not yet seen, and counts it for that child", async () => {
  install(() => jsonResponse({ ok: true, items: [THREAD] }));
  render(<Hub activeChildId="ath_1" />);

  const thread = await screen.findByRole('list', { name: 'Your message about Second Child' });
  const posts = within(thread).getAllByRole('listitem');
  expect(posts.map((item) => item.textContent)).toEqual([
    expect.stringMatching(/^You.*Is practice on Saturday\?$/),
    expect.stringMatching(/^Coach Name.*New.*Yes, see you Saturday\.$/),
    expect.stringMatching(/^The gym.*Bring water\.$/),
  ]);
  expect(screen.getByTestId('unseen')).toHaveTextContent('ath_2:1');
});

test('writes again under a message they started; a refusal keeps the words and says why; a server fault does not repeat its text', async () => {
  let status = 404;
  const fetchMock = install(
    () => jsonResponse({ ok: true, items: [THREAD] }),
    () => jsonResponse({ error: status === 404 ? 'Not found: that message is not on your page.' : 'internal detail' }, false, status),
  );
  render(<Hub activeChildId="ath_1" />);
  const box = await screen.findByLabelText(/Write again about Second Child/);
  const send = screen.getByRole('button', { name: /^Send again about Second Child/ });

  fireEvent.click(send);
  expect(await screen.findByText('Write a message before sending.')).toBeInTheDocument();

  fireEvent.change(box, { target: { value: 'Thank you!' } });
  await act(async () => {
    fireEvent.click(send);
  });
  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toEqual([{ thread_id: 't1', text: 'Thank you!' }]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Not sent; your words are still in the box. Not found: that message is not on your page.');
  expect(box).toHaveValue('Thank you!');

  status = 500;
  await act(async () => {
    fireEvent.click(send);
  });
  expect(await screen.findByText('Not sent; your words are still in the box.')).toBeInTheDocument();
  expect(screen.queryByText(/internal detail/)).toBeNull();
});

test('a failed read says so, never "none", and the count is unavailable; checking again reads again', async () => {
  let fail = true;
  // A refusal that still carries a list is a failed read all the same.
  const fetchMock = install(() => (fail ? jsonResponse({ ok: false, items: [] }, false, 500) : jsonResponse({ ok: true, items: [] })));
  render(<Hub activeChildId="ath_1" />);

  expect(await screen.findByRole('alert')).toHaveTextContent('This is not a statement that you have written none.');
  expect(screen.queryByText('You have not written to the coach yet.')).toBeNull();
  expect(screen.getByTestId('unseen')).toHaveTextContent('unavailable');

  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Check for your messages again' }));
  expect(await screen.findByText('You have not written to the coach yet.')).toBeInTheDocument();
  expect(screen.getByTestId('unseen')).toHaveTextContent('none');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('a re-read that fails after a send says so over the last list; it never claims none was written', async () => {
  let reads = 0;
  install(() => {
    reads += 1;
    return reads === 1 ? jsonResponse({ ok: true, items: [] }) : jsonResponse({ error: 'down' }, false, 500);
  });
  render(<Hub activeChildId="ath_1" />);
  fireEvent.change(await screen.findByLabelText('Your message about First Child'), { target: { value: 'Hello' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to the coach' }));
  });
  await waitFor(() => expect(reads).toBe(2));
  expect(await screen.findByText(/could not be read again\. What shows below is from the last read\./)).toBeInTheDocument();
  expect(screen.queryByText('You have not written to the coach yet.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Check for your messages again' })).toBeInTheDocument();
});

test('words written about one child stay with that child: after the picker changes they are not sent about the other', async () => {
  const fetchMock = install(() => jsonResponse({ ok: true, items: [] }));
  const { rerender } = render(<Hub activeChildId="ath_1" />);
  fireEvent.change(await screen.findByLabelText('Your message about First Child'), { target: { value: 'About the first child' } });

  rerender(<Hub activeChildId="ath_2" />);
  const second = screen.getByLabelText('Your message about Second Child');
  expect(second).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Send to the coach' }));
  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toEqual([]);

  rerender(<Hub activeChildId="ath_1" />);
  expect(screen.getByLabelText('Your message about First Child')).toHaveValue('About the first child');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to the coach' }));
  });
  expect(bodies(fetchMock, '/api/pilot/parent/family-threads')).toEqual([{ athlete_id: 'ath_1', text: 'About the first child' }]);
});

test('words typed while a message is being sent are kept', async () => {
  let release: () => void = () => {};
  install(
    () => jsonResponse({ ok: true, items: [] }),
    () => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse({ ok: true }, true, 201)); }),
  );
  render(<Hub activeChildId="ath_1" />);
  const box = await screen.findByLabelText('Your message about First Child');
  fireEvent.change(box, { target: { value: 'First message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to the coach' }));
  fireEvent.change(box, { target: { value: 'A second, different message' } });
  await act(async () => release());
  expect(box).toHaveValue('A second, different message');
});

test('leaving the tab and coming back keeps unsent words', async () => {
  install(() => jsonResponse({ ok: true, items: [THREAD] }));
  const { rerender } = render(<Hub activeChildId="ath_1" />);
  fireEvent.change(await screen.findByLabelText('Your message about First Child'), { target: { value: 'Half written' } });
  fireEvent.change(screen.getByLabelText(/Write again about Second Child/), { target: { value: 'Also half written' } });
  rerender(<Hub activeChildId="ath_1" onTab={false} />);
  rerender(<Hub activeChildId="ath_1" />);
  expect(screen.getByLabelText('Your message about First Child')).toHaveValue('Half written');
  expect(screen.getByLabelText(/Write again about Second Child/)).toHaveValue('Also half written');
});

describe("seeing the gym's reply (half on screen, FC-05 Q-1 A)", () => {
  class FakeObserver {
    static instances: FakeObserver[] = [];
    observed = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {
      FakeObserver.instances.push(this);
    }
    observe(element: Element) { this.observed.add(element); }
    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
    show(postId: string, ratio: number, visibleHeight: number) {
      const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readPost === postId);
      if (!target) return;
      this.callback([{
        target, isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: visibleHeight }, rootBounds: { height: 800 },
      } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }
  const show = (postId: string, ratio: number, visibleHeight = 0) =>
    FakeObserver.instances.forEach((observer) => observer.show(postId, ratio, visibleHeight));
  const watched = () => FakeObserver.instances.flatMap((observer) => [...observer.observed])
    .map((element) => (element as HTMLElement).dataset.readPost);

  beforeEach(() => {
    FakeObserver.instances = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  });
  afterEach(() => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  test('only an unseen reply is watched; under half is not a read; half is, once; the count drops and New stays', async () => {
    const fetchMock = install(() => jsonResponse({ ok: true, items: [THREAD] }));
    render(<Hub activeChildId="ath_1" />);
    await screen.findByText('Yes, see you Saturday.');
    await waitFor(() => expect(watched()).toEqual(['p2']));

    await act(async () => show('p2', 0.4));
    expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toEqual([]);
    // Taller than the screen: half the screen filled with it is a read.
    await act(async () => show('p2', 0.2, 399));
    expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toEqual([]);
    await act(async () => show('p2', 0.2, 400));
    expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toEqual([{ post_id: 'p2' }]);
    await act(async () => show('p2', 0.9));
    expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toEqual([{ post_id: 'p2' }]);
    await waitFor(() => expect(screen.getByTestId('unseen')).toHaveTextContent('none'));
    expect(within(screen.getByText('Yes, see you Saturday.').closest('li') as HTMLElement).getByText('New')).toBeInTheDocument();
  });

  test('New stays on a reply for the visit after a re-read in which it comes back seen', async () => {
    let reads = 0;
    install(() => {
      reads += 1;
      const posts = THREAD.posts.map((post) => ({ ...post, new_to_me: reads === 1 && post.new_to_me }));
      return jsonResponse({ ok: true, items: [{ ...THREAD, posts }] });
    });
    render(<Hub activeChildId="ath_1" />);
    await waitFor(() => expect(watched()).toEqual(['p2']));
    await act(async () => show('p2', 0.9));
    await waitFor(() => expect(screen.getByTestId('unseen')).toHaveTextContent('none'));

    // Writing again reads the list again; the server now says p2 has been seen.
    fireEvent.change(screen.getByLabelText(/Write again about Second Child/), { target: { value: 'Thanks' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send again about Second Child/ }));
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(within(screen.getByText('Yes, see you Saturday.').closest('li') as HTMLElement).getByText('New')).toBeInTheDocument();
  });

  test('a reply recorded as seen is not sent again when the tab is left and opened again', async () => {
    const fetchMock = install(() => jsonResponse({ ok: true, items: [THREAD] }));
    const { rerender } = render(<Hub activeChildId="ath_1" />);
    await waitFor(() => expect(watched()).toEqual(['p2']));
    await act(async () => show('p2', 0.9));
    await waitFor(() => expect(screen.getByTestId('unseen')).toHaveTextContent('none'));

    rerender(<Hub activeChildId="ath_1" onTab={false} />);
    rerender(<Hub activeChildId="ath_1" />);
    await screen.findByText('Yes, see you Saturday.');
    expect(watched()).toEqual([]);
    expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toEqual([{ post_id: 'p2' }]);
  });

  test('a failed write is not sent again at once; the count stays; the next read watches it again', async () => {
    const fetchMock = install(
      () => jsonResponse({ ok: true, items: [THREAD] }),
      () => jsonResponse({ ok: true }, true, 201),
      () => jsonResponse({ error: 'Not found' }, false, 404),
    );
    render(<Hub activeChildId="ath_1" />);
    await waitFor(() => expect(watched()).toEqual(['p2']));

    await act(async () => show('p2', 0.9));
    await waitFor(() => expect(bodies(fetchMock, '/api/pilot/parent/family-thread-reads')).toHaveLength(1));
    expect(watched()).toEqual([]);
    expect(screen.getByTestId('unseen')).toHaveTextContent('ath_2:1');

    // Writing again reads the list again: the reply is watched afresh.
    fireEvent.change(screen.getByLabelText(/Write again about Second Child/), { target: { value: 'Thanks' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send again about Second Child/ }));
    });
    await waitFor(() => expect(watched()).toEqual(['p2']));
  });
});
