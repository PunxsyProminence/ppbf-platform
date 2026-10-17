/**
 * @jest-environment jsdom
 */

/* #1542, FC-05: a coach's message counts as opened when at least half of it is
   on screen on the Messages tab -- not when the hub fetches the inbox. Each is
   recorded once per visit; a failed write is retried when the tab is next
   opened, and is never shown to the guardian. Also the parent-facing copy
   change folded in: observations "where the coaches can read it". */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

/* A stand-in for the browser's IntersectionObserver: the test says which
   message is on screen, and how much of it. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.instances.push(this);
  }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  show(noteId: string, ratio: number, visibleHeight = 0, screenHeight = 800) {
    const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readNote === noteId);
    if (!target) return;
    this.callback(
      [{
        target,
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
        intersectionRect: { height: visibleHeight },
        rootBounds: { height: screenHeight },
      } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function showMessage(noteId: string, ratio = 1, visibleHeight = 0) {
  for (const observer of FakeObserver.instances) observer.show(noteId, ratio, visibleHeight);
}

const MESSAGES = [
  {
    note_id: '11111111-1111-4111-8111-111111111111',
    athlete_id: 'ath_1',
    athlete_name: 'First Child',
    sender_role: 'coach',
    note_text: 'Bring gloves Thursday.',
    created_at: '2026-10-01T12:00:00.000Z',
    task: null,
  },
  {
    note_id: '22222222-2222-4222-8222-222222222222',
    athlete_id: 'ath_2',
    athlete_name: 'Second Child',
    sender_role: 'admin',
    note_text: 'Medical form is due.',
    created_at: '2026-10-02T12:00:00.000Z',
    task: null,
  },
];

type Handler = (init?: RequestInit) => Promise<Response>;

function installFetch(
  options: { repliesGet?: Handler; repliesPost?: Handler; readsGet?: Handler; readsPost?: Handler } = {},
): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // FC-06: the Messages tab's "Sent to your athlete" copy; none here.
    if (url.includes('/api/pilot/parent/athlete-messages')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1', role: 'parent' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/parent/safety')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/parent/message-reads')) {
      if (init?.method !== 'POST') {
        return options.readsGet ? options.readsGet(init) : jsonResponse({ ok: true, items: [] });
      }
      if (options.readsPost) return options.readsPost(init);
      const sent = JSON.parse(String(init?.body)) as { note_id: string };
      return jsonResponse({ ok: true, read: { note_id: sent.note_id, first_read_at: '2026-10-13T23:30:00.000Z' } });
    }
    if (url.includes('/api/pilot/parent/message-replies')) {
      if (init?.method === 'POST') {
        if (options.repliesPost) return options.repliesPost(init);
        const sent = JSON.parse(String(init.body)) as { note_id: string; reply_text: string };
        return jsonResponse({
          ok: true,
          item: { reply_id: 'r-new', note_id: sent.note_id, reply_text: sent.reply_text, created_at: '2026-10-13T23:30:00.000Z' },
        });
      }
      return options.repliesGet ? options.repliesGet(init) : jsonResponse({ ok: true, items: [] });
    }
    if (url.includes('/api/pilot/parent/messages')) return jsonResponse({ ok: true, items: MESSAGES });
    if (url.includes('/api/pilot/scheduler')) {
      return jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function readPosts(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/pilot/parent/message-reads') && (c[1] as RequestInit).method === 'POST')
    .map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { note_id: string }).note_id);
}

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
}

async function openTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  FakeObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a message counts as opened when it is on screen on the Messages tab (FC-05)', () => {
  test('loading the hub, and opening the tab, record nothing until a message is on screen', async () => {
    const fetchMock = installFetch();
    await renderHub();
    expect(readPosts(fetchMock)).toEqual([]);

    await openTab('Messages');
    await screen.findByText('Bring gloves Thursday.');
    expect(readPosts(fetchMock)).toEqual([]);
  });

  test('a message at least half on screen is recorded once; one barely on screen is not', async () => {
    const fetchMock = installFetch();
    await renderHub();
    await openTab('Messages');
    await screen.findByText('Bring gloves Thursday.');

    await act(async () => {
      showMessage(MESSAGES[1]!.note_id, 0.2);
      showMessage(MESSAGES[0]!.note_id, 0.6);
      showMessage(MESSAGES[0]!.note_id, 1);
    });

    expect(readPosts(fetchMock)).toEqual([MESSAGES[0]!.note_id]);
  });

  test('a message taller than the screen counts once it fills half the screen', async () => {
    const fetchMock = installFetch();
    await renderHub();
    await openTab('Messages');
    await screen.findByText('Bring gloves Thursday.');

    await act(async () => {
      // 30% of a long message on screen, filling 300px of an 800px screen: not yet.
      showMessage(MESSAGES[0]!.note_id, 0.3, 300);
    });
    expect(readPosts(fetchMock)).toEqual([]);
    await act(async () => {
      // 40% of it, filling 600px of 800: opened.
      showMessage(MESSAGES[0]!.note_id, 0.4, 600);
    });
    expect(readPosts(fetchMock)).toEqual([MESSAGES[0]!.note_id]);
  });

  test('the watch fires at every 1%, so a message many screens tall is seen as it scrolls', () => {
    installFetch();
    const seen: Array<number[] | number | undefined> = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class extends FakeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback);
        seen.push(options?.threshold);
      }
    };
    return (async () => {
      await renderHub();
      await openTab('Messages');
      await screen.findByText('Bring gloves Thursday.');
      const thresholds = seen.at(-1) as number[];
      expect(thresholds).toHaveLength(101);
      expect(thresholds).toContain(0.05);
      expect(thresholds).toContain(0.5);
    })();
  });

  test('what is watched is the message itself, not the replies and reply box under it', async () => {
    installFetch();
    await renderHub();
    await openTab('Messages');
    await screen.findByText('Bring gloves Thursday.');

    const watched = document.querySelector<HTMLElement>(`[data-read-note="${MESSAGES[0]!.note_id}"]`)!;
    expect(watched.textContent).toContain('Bring gloves Thursday.');
    expect(watched.querySelector('textarea')).toBeNull();
    expect(watched.textContent).not.toContain('Send reply');
  });

  test('a failed write is not shown, and is tried again when the tab is next opened', async () => {
    let calls = 0;
    const fetchMock = installFetch({
      readsPost: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ ok: false, error: 'boom' }, false) : jsonResponse({ ok: true, read: {} });
      },
    });
    await renderHub();
    await openTab('Messages');
    await screen.findByText('Bring gloves Thursday.');

    await act(async () => {
      showMessage(MESSAGES[0]!.note_id, 1);
    });
    expect(screen.queryByRole('alert')).toBeNull();

    // Away and back: the message comes on screen again and is retried.
    await openTab('Overview');
    await openTab('Messages');
    await act(async () => {
      showMessage(MESSAGES[0]!.note_id, 1);
    });
    expect(readPosts(fetchMock)).toEqual([MESSAGES[0]!.note_id, MESSAGES[0]!.note_id]);
  });
});

describe('parent-facing copy folded into FC-05', () => {
  test('the observations card says the coaches can read what is saved', async () => {
    installFetch();
    await renderHub();
    await openTab('Observations');
    // The sentence is the help panel's description, shown when the help is opened.
    fireEvent.click(screen.getByRole('button', { name: /HELP: Parent Observations/ }));
    expect(screen.getByText(/saved to your child's record at the gym, where the coaches can read it\./)).toBeInTheDocument();
  });
});

/* #1542, FC-08: a message is "New" until this guardian has opened it, read
   back from their own opens; the summary tile counts the new ones. */
describe('New until this guardian opens it (FC-08)', () => {
  const [OPENED, UNOPENED] = [MESSAGES[0]!, MESSAGES[1]!];

  function card(noteId: string): HTMLElement {
    return document.querySelector<HTMLElement>(`[data-read-note="${noteId}"]`)!;
  }

  function newTileValue(): string {
    const label = screen.getAllByText('New messages').find((element) => element.tagName === 'P');
    return label?.parentElement?.textContent?.replace('New messages', '').trim() ?? '';
  }

  function readsAnswer(noteIds: string[]): Handler {
    return async () => jsonResponse({
      ok: true,
      items: noteIds.map((noteId) => ({ note_id: noteId, first_read_at: '2026-10-12T12:00:00.000Z' })),
    });
  }

  test('an unopened message says New, an opened one does not, and the tile counts the new ones', async () => {
    installFetch({ readsGet: readsAnswer([OPENED.note_id]) });
    await renderHub();

    expect(newTileValue()).toBe('1');
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(within(card(OPENED.note_id)).queryByText('New')).toBeNull();
  });

  test('a failed reads answer: the tile is Unavailable and no card says New', async () => {
    installFetch({ readsGet: async () => jsonResponse({ ok: false, error: 'boom' }, false) });
    await renderHub();

    expect(newTileValue()).toBe('Unavailable');
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);
    expect(screen.queryByText('New')).toBeNull();
  });

  test('once the open is recorded the tile drops at once, and New stays on that card for this visit', async () => {
    installFetch();
    await renderHub();
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);
    expect(within(card(OPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(newTileValue()).toBe('2');

    await act(async () => {
      showMessage(OPENED.note_id, 1);
    });

    await waitFor(() => expect(newTileValue()).toBe('1'));
    expect(within(card(OPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
  });

  test('a failed open keeps New on', async () => {
    installFetch({ readsPost: async () => jsonResponse({ ok: false, error: 'boom' }, false) });
    await renderHub();
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);

    await act(async () => {
      showMessage(OPENED.note_id, 1);
    });

    expect(within(card(OPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(newTileValue()).toBe('2');
  });

  test('an open recorded before the reads answer keeps its New when the answer already includes it', async () => {
    let answerReads: (response: Response) => void = () => undefined;
    installFetch({ readsGet: () => new Promise<Response>((resolve) => { answerReads = resolve; }) });
    await renderHub();
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);

    // UNOPENED is opened this visit, and its POST commits before the reads
    // query takes its snapshot, so the answer names it as already opened.
    await act(async () => {
      showMessage(UNOPENED.note_id, 1);
    });
    await act(async () => {
      answerReads(jsonResponse({
        ok: true,
        items: [
          { note_id: OPENED.note_id, first_read_at: '2026-10-12T12:00:00.000Z' },
          { note_id: UNOPENED.note_id, first_read_at: '2026-10-17T12:00:00.000Z' },
        ],
      }));
    });

    expect(within(card(OPENED.note_id)).queryByText('New')).toBeNull();
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(newTileValue()).toBe('0');
  });

  test('an open recorded before the reads answer stays opened when the answer lands without it', async () => {
    let answerReads: (response: Response) => void = () => undefined;
    installFetch({ readsGet: () => new Promise<Response>((resolve) => { answerReads = resolve; }) });
    await renderHub();
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);

    await act(async () => {
      showMessage(UNOPENED.note_id, 1);
    });
    await act(async () => {
      answerReads(jsonResponse({ ok: true, items: [{ note_id: OPENED.note_id, first_read_at: '2026-10-12T12:00:00.000Z' }] }));
    });

    // OPENED was opened before this visit: no New. UNOPENED was new when the hub
    // loaded and was opened during this visit: New stays on it; the tile counts 0.
    expect(within(card(OPENED.note_id)).queryByText('New')).toBeNull();
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(newTileValue()).toBe('0');
  });

  test("switching child moves no New between messages, and a late reads answer marks only the notes it names", async () => {
    let answerReads: (response: Response) => void = () => undefined;
    installFetch({ readsGet: () => new Promise<Response>((resolve) => { answerReads = resolve; }) });
    await renderHub();
    await openTab('Messages');
    await screen.findByText(OPENED.note_text);
    expect(screen.queryByText('New')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await act(async () => {
      answerReads(jsonResponse({ ok: true, items: [{ note_id: OPENED.note_id, first_read_at: '2026-10-12T12:00:00.000Z' }] }));
    });

    expect(within(card(OPENED.note_id)).queryByText('New')).toBeNull();
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'First Child' }));
    });
    expect(within(card(OPENED.note_id)).queryByText('New')).toBeNull();
    expect(within(card(UNOPENED.note_id)).getByText('New')).toBeInTheDocument();
    expect(newTileValue()).toBe('1');
  });
});
