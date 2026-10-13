/**
 * @jest-environment jsdom
 */

/* #1542, FC-03: a guardian answers a coach's message, under that message.
   Their own earlier replies show there (the server returns only theirs); a
   failed earlier-replies read says so; a reply is sent once per press, and a
   refused send keeps the text and says why. */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
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

function installFetch(options: { repliesGet?: Handler; repliesPost?: Handler } = {}): jest.Mock {
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

async function openMessages() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  });
  await screen.findByText('Bring gloves Thursday.');
}

function card(text: string): HTMLElement {
  return screen.getByText(text).closest('.mat-paper') as HTMLElement;
}

function replyPosts(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/pilot/parent/message-replies') && (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('replying to a coach message (FC-03)', () => {
  test('earlier replies show under the message they answer, with the time in gym time', async () => {
    installFetch({
      repliesGet: async () => jsonResponse({
        ok: true,
        items: [
          { reply_id: 'r1', note_id: MESSAGES[0]!.note_id, reply_text: 'Packed already.', created_at: '2026-10-01T23:30:00.000Z' },
        ],
      }),
    });
    await openMessages();

    const gloves = card('Bring gloves Thursday.');
    expect(within(gloves).getByText('Packed already.')).toBeInTheDocument();
    expect(within(gloves).getByText(/You replied · .*7:30/)).toBeInTheDocument();
    expect(within(card('Medical form is due.')).queryByText('Packed already.')).toBeNull();
  });

  test('a reply is sent for that message, appears under it, and the box clears', async () => {
    const fetchMock = installFetch();
    await openMessages();

    const gloves = card('Bring gloves Thursday.');
    const send = within(gloves).getByRole('button', { name: 'Send reply' });
    expect(send).toBeDisabled();
    fireEvent.change(within(gloves).getByLabelText('Your reply'), { target: { value: '  See you Thursday.  ' } });
    await act(async () => {
      fireEvent.click(send);
    });

    expect(replyPosts(fetchMock)).toEqual([{ note_id: MESSAGES[0]!.note_id, reply_text: 'See you Thursday.' }]);
    expect(within(gloves).getByText('See you Thursday.')).toBeInTheDocument();
    expect(within(gloves).getByLabelText('Your reply')).toHaveValue('');
    expect(within(card('Medical form is due.')).queryByText('See you Thursday.')).toBeNull();
  });

  test('two presses in one tick send one reply', async () => {
    let finish: ((value: Response) => void) | null = null;
    const fetchMock = installFetch({
      repliesPost: () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    await openMessages();

    const gloves = card('Bring gloves Thursday.');
    fireEvent.change(within(gloves).getByLabelText('Your reply'), { target: { value: 'Once.' } });
    const send = within(gloves).getByRole('button', { name: 'Send reply' });
    act(() => {
      fireEvent.click(send);
      fireEvent.click(send);
    });

    expect(replyPosts(fetchMock)).toHaveLength(1);
    await act(async () => {
      finish?.(jsonResponse({ ok: true, item: { reply_id: 'r-1', note_id: MESSAGES[0]!.note_id, reply_text: 'Once.', created_at: '2026-10-13T23:30:00.000Z' } }));
    });
  });

  test('a refused send keeps the text, says why under that message, and adds nothing', async () => {
    installFetch({
      repliesPost: async () => jsonResponse({ ok: false, error: 'Not found: that message is not on your page.' }, false),
    });
    await openMessages();

    const gloves = card('Bring gloves Thursday.');
    fireEvent.change(within(gloves).getByLabelText('Your reply'), { target: { value: 'Keep me.' } });
    await act(async () => {
      fireEvent.click(within(gloves).getByRole('button', { name: 'Send reply' }));
    });

    expect(within(gloves).getByRole('alert').textContent).toContain('Not found: that message is not on your page.');
    expect(within(gloves).getByLabelText('Your reply')).toHaveValue('Keep me.');
    expect(within(gloves).queryByText(/You replied/)).toBeNull();
    expect(within(card('Medical form is due.')).queryByRole('alert')).toBeNull();
  });

  test('a failed earlier-replies read says so, and replying still works', async () => {
    const fetchMock = installFetch({ repliesGet: async () => jsonResponse({ error: 'boom' }, false) });
    await openMessages();

    expect(screen.getByText(/Your earlier replies have not loaded\. This is not a statement that you have not replied\./)).toBeInTheDocument();
    const gloves = card('Bring gloves Thursday.');
    fireEvent.change(within(gloves).getByLabelText('Your reply'), { target: { value: 'Still works.' } });
    await act(async () => {
      fireEvent.click(within(gloves).getByRole('button', { name: 'Send reply' }));
    });
    expect(replyPosts(fetchMock)).toHaveLength(1);
    expect(within(gloves).getByText('Still works.')).toBeInTheDocument();
  });
});
