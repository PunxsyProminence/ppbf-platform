/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import SessionNoShows from './SessionNoShows';

// The End Session no-shows offer (OD-2026-10-21-004 ruling 3, "A: Offer it (Rec.)"). Which athletes
// it marks, and when the server refuses, are proven in sessionRunClass.pg.test.ts; this proves the
// screen offers it only with something to mark, sends it only on the coach's tap, and says what
// happened.

const fetchSpy = jest.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const tiedClass = (noShows: number) => ({ class_id: 'class-youth', title: 'Youth boxing', start_at: 's', end_at: 'e', status: 'open', no_shows: noShows });

function serve(noShows: number, patch: () => Response = () => json({ marked: ['a', 'b'] })) {
  fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
    (init?.method === 'PATCH' ? patch() : json({ run: {}, class: tiedClass(noShows) })));
}

const patches = () => fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

async function show(onRunNotLive = jest.fn()) {
  await act(async () => {
    render(<SessionNoShows runId="run-1" onRunNotLive={onRunNotLive} />);
  });
  return onRunNotLive;
}

beforeEach(() => {
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

test('offers the tap with the count, sends nothing until it is tapped, then says how many were marked', async () => {
  serve(2);
  await show();
  expect(screen.getByText('2 signed up for Youth boxing have no mark here or on its register.')).toBeTruthy();
  expect(patches()).toHaveLength(0);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 Absent' }));
  });
  expect(String(patches()[0][0])).toContain('/api/pilot/session-scripts/runs/run-1');
  expect(JSON.parse(String((patches()[0][1] as RequestInit).body))).toEqual({ action: 'mark_no_shows' });
  expect(screen.getByRole('status').textContent).toBe('2 signed-up athletes were marked Absent on the class register.');
});

test('offers nothing when nobody is missing (or the server would refuse)', async () => {
  serve(0);
  await show();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a refusal is said in the server\'s words; a run ended elsewhere is handed back', async () => {
  serve(1, () => json({ error: 'SESSION_CLASS_NOT_STARTED', message: 'This class has not started yet, so nobody is a no-show.' }, 409));
  await show();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark them Absent' }));
  });
  expect(screen.getByRole('alert').textContent).toBe('This class has not started yet, so nobody is a no-show.');

  fetchSpy.mockReset();
  serve(1, () => json({ error: 'SESSION_RUN_NOT_LIVE' }, 409));
  const onRunNotLive = jest.fn();
  await act(async () => {
    render(<SessionNoShows runId="run-2" onRunNotLive={onRunNotLive} />);
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark them Absent' })[1]);
  });
  expect(onRunNotLive).toHaveBeenCalledTimes(1);
});
