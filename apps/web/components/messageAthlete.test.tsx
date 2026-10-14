/**
 * @jest-environment jsdom
 */

// "Message the athlete" on /coach/decision-loop (#1542, FC-06): a coach note
// with note_type 'athlete_message' through the existing coach-note write;
// confirmed only when the answer names this note and athlete; one send per
// press; a refused send keeps the words and says why.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import MessageAthlete from './MessageAthlete';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function sentBodies(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('sends the words to that athlete as an athlete message and clears the box when confirmed', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-1' }));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<MessageAthlete athleteId="ath-1" />);

  const send = screen.getByRole('button', { name: 'Send to athlete' });
  expect(send).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: '  Great work on the jab.  ' } });
  await act(async () => {
    fireEvent.click(send);
  });

  expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/pilot/intake/domain-upsert');
  expect(sentBodies(fetchMock)).toEqual([{
    entity_type: 'coach_note',
    athlete_id: 'ath-1',
    payload: { note_type: 'athlete_message', note_text: 'Great work on the jab.' },
  }]);
  expect(screen.getByLabelText('Message to the athlete')).toHaveValue('');
  expect(screen.getByRole('status').textContent).toContain("on the athlete's Dashboard");
});

test('two presses in one tick send one message', async () => {
  let finish: ((value: Response) => void) | null = null;
  const fetchMock = jest.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<MessageAthlete athleteId="ath-1" />);

  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: 'Once.' } });
  const form = screen.getByRole('button', { name: 'Send to athlete' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish?.(jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-1' }));
  });
});

test.each([
  ['a refusal', () => jsonResponse({ ok: false, error: 'Forbidden: athlete does not belong to organization' }, false), 'Forbidden: athlete does not belong to organization'],
  ['an answer about another athlete', () => jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'n1', athlete_id: 'ath-2' }), 'The message did not send'],
])('%s keeps the words and says why', async (_label, answer, reason) => {
  global.fetch = jest.fn(async () => answer()) as unknown as typeof fetch;
  render(<MessageAthlete athleteId="ath-1" />);

  fireEvent.change(screen.getByLabelText('Message to the athlete'), { target: { value: 'Keep me.' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to athlete' }));
  });

  expect(screen.getByRole('alert').textContent).toContain(reason);
  expect(screen.getByLabelText('Message to the athlete')).toHaveValue('Keep me.');
});
