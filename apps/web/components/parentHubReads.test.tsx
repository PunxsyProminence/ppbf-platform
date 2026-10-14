/**
 * @jest-environment jsdom
 */

/* #1542, FC-05: a coach's message counts as opened when at least half of it is
   on screen on the Messages tab -- not when the hub fetches the inbox. Each is
   recorded once per visit; a failed write is retried the next time it comes
   on screen, and is never shown to the guardian. Also the two parent-facing
   copy changes folded in: observations "where the coaches can read it", and
   the Family Goals tab pointing to the child's goals under Progress. */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  show(noteId: string, ratio: number) {
    const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readNote === noteId);
    if (!target) return;
    this.callback(
      [{ target, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function showMessage(noteId: string, ratio = 1) {
  for (const observer of FakeObserver.instances) observer.show(noteId, ratio);
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

function installFetch(options: { repliesGet?: Handler; repliesPost?: Handler; readsPost?: Handler } = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
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
    .filter((c) => String(c[0]).includes('/api/pilot/parent/message-reads'))
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

  test('a failed write is not shown, and is tried again the next time the message is on screen', async () => {
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

  test("the Family Goals tab points to the child's goals under Progress and is no longer stamped not implemented", async () => {
    installFetch();
    await renderHub();
    await openTab('Family Goals');
    expect(screen.getByText(/Your child's own goals, as their coach set them, are on the Progress tab\./)).toBeInTheDocument();
    expect(screen.queryByText(/NOT YET IMPLEMENTED -- there is no backend feed for family goals/)).toBeNull();
  });
});
