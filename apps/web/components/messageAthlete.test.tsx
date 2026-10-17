/**
 * @jest-environment jsdom
 */

// "Message the athlete" on /coach/decision-loop (#1542, FC-06): a coach note
// with note_type 'athlete_message' through the existing coach-note write;
// confirmed only when the answer names this note and athlete; one send per
// press; a refused send keeps the words and says why. Under it, "Sent to this
// athlete": what staff wrote to this athlete, read on open and after a send.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import MessageAthlete from './MessageAthlete';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

const SENT = { note_id: 'n0', note_text: 'Welcome to the gym.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat Smith' };

function routedFetch(options: {
  send?: () => Response | Promise<Response>;
  sentList?: () => Response | Promise<Response>;
} = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/pilot/coach/athlete-messages')) {
      return options.sentList ? options.sentList() : jsonResponse({ items: [] });
    }
    if (init?.method === 'POST') {
      return options.send ? options.send() : jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-1' });
    }
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posts(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

function sentListReads(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/api/pilot/coach/athlete-messages'));
}

async function renderForm(athleteId = 'ath-1') {
  await act(async () => {
    render(<MessageAthlete athleteId={athleteId} />);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('sends the words to that athlete as an athlete message, clears the box, and re-reads what was sent', async () => {
  let reads = 0;
  const fetchMock = routedFetch({
    sentList: () => jsonResponse({ items: (reads += 1) === 1 ? [] : [{ ...SENT, note_text: 'Great work on the jab.' }] }),
  });
  await renderForm();

  const send = screen.getByRole('button', { name: 'Send to athlete' });
  expect(send).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: '  Great work on the jab.  ' } });
  await act(async () => {
    fireEvent.click(send);
  });

  expect(posts(fetchMock)).toEqual([{
    entity_type: 'coach_note',
    athlete_id: 'ath-1',
    payload: { note_type: 'athlete_message', note_text: 'Great work on the jab.' },
  }]);
  expect(String(fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST')![0])).toContain('/api/pilot/intake/domain-upsert');
  expect(screen.getByLabelText('Message to the athlete')).toHaveValue('');
  expect(screen.getByRole('status').textContent).toContain("on the athlete's Dashboard");
  // FC-06 Q-2, ruled B: the family of an athlete under 18 reads a copy.
  expect(screen.getByText(/For an athlete under 18, or with no date of birth on file, their family can read it too\./)).toBeInTheDocument();
  expect(sentListReads(fetchMock)).toHaveLength(2);
  expect(within(screen.getByRole('list', { name: 'Sent to this athlete' })).getByText('Great work on the jab.')).toBeInTheDocument();
});

test('what was already sent to this athlete shows when the form opens, with who and when', async () => {
  const fetchMock = routedFetch({ sentList: () => jsonResponse({ items: [SENT] }) });
  await renderForm();

  expect(sentListReads(fetchMock)[0]).toContain('athlete_id=ath-1');
  const item = within(screen.getByRole('list', { name: 'Sent to this athlete' })).getByRole('listitem');
  expect(item.textContent).toContain('Welcome to the gym.');
  // 22:00 UTC on Oct 13 is 6:00 PM in the gym.
  expect(item.textContent).toMatch(/Coach Pat Smith · .*6:00/);
});

test('a failed read of what was sent says so, never that nothing was sent', async () => {
  routedFetch({ sentList: () => jsonResponse({ error: 'boom' }, false) });
  await renderForm();

  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText('Nothing has been sent to this athlete yet.')).toBeNull();
});

test('a failed read of what was sent has Check again, which reads it again and shows the list', async () => {
  let answer: () => Response | Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'));
  const fetchMock = routedFetch({ sentList: () => answer() });
  await renderForm();
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');

  answer = () => jsonResponse({ items: [SENT] });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  });
  expect(sentListReads(fetchMock)).toHaveLength(2);
  expect(sentListReads(fetchMock)[1]).toContain('athlete_id=ath-1');
  expect(posts(fetchMock)).toEqual([]);
  expect(within(screen.getByRole('list', { name: 'Sent to this athlete' })).getByText('Welcome to the gym.')).toBeInTheDocument();
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
});

test('two presses in one tick send one message', async () => {
  let finish: ((value: Response) => void) | null = null;
  const fetchMock = routedFetch({ send: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  await renderForm();

  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: 'Once.' } });
  const form = screen.getByRole('button', { name: 'Send to athlete' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });

  expect(posts(fetchMock)).toHaveLength(1);
  await act(async () => {
    finish?.(jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-1' }));
  });
});

test.each([
  ['a refusal', () => jsonResponse({ ok: false, error: 'Forbidden: athlete does not belong to organization' }, false), 'Forbidden: athlete does not belong to organization'],
  ['an answer about another athlete', () => jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-2' }), 'The message did not send'],
])('%s keeps the words and says why', async (_label, answer, reason) => {
  routedFetch({ send: answer });
  await renderForm();

  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: 'Keep me.' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to athlete' }));
  });

  expect(screen.getByRole('alert').textContent).toContain(reason);
  expect(screen.getByLabelText('Message to the athlete')).toHaveValue('Keep me.');
});

test('the box holds the same 4000-character limit the server enforces on an athlete message', async () => {
  routedFetch();
  await renderForm();

  expect(screen.getByLabelText('Message to the athlete')).toHaveAttribute('maxLength', '4000');
});
