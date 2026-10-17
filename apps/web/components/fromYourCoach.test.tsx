/**
 * @jest-environment jsdom
 */

// "From your coach" on the athlete's Dashboard (#1542, FC-06): each message
// with who and when in gym time, newest first as given; an empty inbox says
// so; a failed read says so and is never shown as "no messages".

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import FromYourCoach from './FromYourCoach';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('each message reads with its words, who it is from and when, in gym time', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({
    ok: true,
    items: [
      // 22:00 UTC on Oct 13 is 6:00 PM in the gym.
      { note_id: 'n2', note_text: 'Great work on the jab.\nKeep the chin down.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat' },
      { note_id: 'n1', note_text: 'Welcome to the gym.', created_at: '2026-10-01T14:00:00.000Z', from_name: 'Your gym' },
    ],
  }));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<FromYourCoach />);
  });

  const items = within(screen.getByRole('region', { name: 'From your coach' })).getAllByRole('listitem');
  expect(items[0]!.textContent).toContain('Keep the chin down.');
  expect(items[0]!.textContent).toMatch(/Coach Pat · .*6:00/);
  expect(items[1]!.textContent).toContain('Your gym');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/pilot/athlete/coach-messages'), expect.anything());
});

test('the newest ten show first; Show more reveals older ones and says how many are left', async () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    note_id: `n-${index}`,
    note_text: `Note ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 30 - index, 15)).toISOString(),
    from_name: 'Coach Pat',
  }));
  global.fetch = jest.fn(async () => jsonResponse({ ok: true, items: many })) as unknown as typeof fetch;

  await act(async () => {
    render(<FromYourCoach />);
  });

  const items = () => within(screen.getByRole('region', { name: 'From your coach' })).getAllByRole('listitem');
  expect(items()).toHaveLength(10);
  await act(async () => {
    screen.getByRole('button', { name: 'Show 3 more (3 older)' }).click();
  });
  expect(items()).toHaveLength(13);
  expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
});

test('an empty inbox says no messages yet', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  await act(async () => {
    render(<FromYourCoach />);
  });

  expect(screen.getByText('No messages from your coach yet.')).toBeInTheDocument();
});

test('a failed read says so, and never that there are no messages', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<FromYourCoach />);
  });

  expect(screen.getByRole('alert').textContent).toContain("couldn't load your coach's messages");
  expect(screen.queryByText('No messages from your coach yet.')).toBeNull();
});
