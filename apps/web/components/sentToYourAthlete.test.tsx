/**
 * @jest-environment jsdom
 */

// "Sent to your athlete" on the parent hub's Messages tab (#1542, FC-06 Q-2 B):
// a read-only copy of what staff wrote to the guardian's children, each with
// the child's name, who wrote it and when (gym time); an empty state; a failed
// read says so and is never "nothing sent".

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import SentToYourAthlete from './SentToYourAthlete';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("each copy names the child it was sent to, who wrote it and when", async () => {
  const fetchMock = jest.fn(async () => jsonResponse({
    ok: true,
    items: [
      // 22:00 UTC on Oct 13 is 6:00 PM in the gym.
      { note_id: 'n2', athlete_id: 'ath-2', note_text: 'Great work on the jab.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat Smith' },
      { note_id: 'n1', athlete_id: 'ath-unknown', note_text: 'Welcome.', created_at: '2026-10-01T14:00:00.000Z', from_name: 'Your gym' },
    ],
  }));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<SentToYourAthlete childNames={{ 'ath-1': 'First Child', 'ath-2': 'Second Child' }} />);
  });

  const items = within(screen.getByRole('region', { name: 'Sent to your athlete' })).getAllByRole('listitem');
  expect(items[0]!.textContent).toContain('To Second Child');
  expect(items[0]!.textContent).toMatch(/Coach Pat Smith · .*6:00/);
  expect(items[1]!.textContent).toContain('To your child');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/pilot/parent/athlete-messages'), expect.anything());
});

test('nothing sent yet says so', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ ok: true, items: [], in_scope: 1 })) as unknown as typeof fetch;

  await act(async () => {
    render(<SentToYourAthlete childNames={{}} />);
  });

  expect(screen.getByText('Nothing has been sent to your athlete yet.')).toBeInTheDocument();
});

test('a guardian with no child in scope (in_scope 0) sees no section, never "nothing sent"', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ ok: true, items: [], in_scope: 0 })) as unknown as typeof fetch;

  await act(async () => {
    render(<SentToYourAthlete childNames={{}} />);
  });

  expect(screen.queryByRole('region', { name: 'Sent to your athlete' })).toBeNull();
  expect(screen.queryByText('Nothing has been sent to your athlete yet.')).toBeNull();
});

test('a failed read says so, and never that nothing was sent', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<SentToYourAthlete childNames={{}} />);
  });

  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText('Nothing has been sent to your athlete yet.')).toBeNull();
});
