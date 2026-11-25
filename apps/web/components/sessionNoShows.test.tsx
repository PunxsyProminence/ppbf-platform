/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import SessionNoShows from './SessionNoShows';
import { createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, prepareSaveQueue, resetSaveQueueForTests } from '@/src/lib/saveQueue';

// The End Session no-shows offer (OD-2026-10-21-004 ruling 3, "A: Offer it (Rec.)"). Which athletes
// it marks, and when the server refuses, are proven in sessionRunClass.pg.test.ts; this proves the
// screen offers it only with something to mark, sends it only on the coach's tap, and says what
// happened.

const fetchSpy = jest.fn();
const json = (body: unknown, status = 200) => {
  const response = { ok: status < 400, status, json: async () => body, clone: () => response };
  return response as unknown as Response;
};
const tiedClass = (noShows: number, classId = 'class-youth') =>
  ({ class_id: classId, title: 'Youth boxing', start_at: 's', end_at: 'e', status: 'open', no_shows: noShows });

function serve(noShows: number | 'fail', patch: () => Response = () => json({ marked: ['a', 'b'] }), classId = 'class-youth') {
  fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch();
    return noShows === 'fail' ? json({}, 500) : json({ run: {}, class: tiedClass(noShows, classId) });
  });
}

const patches = () => fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

async function show(props: Partial<{ presentCount: number | null; onRunNotLive: () => void }> = {}) {
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    ({ rerender } = render(<SessionNoShows runId="run-1" classId="class-youth" presentCount={props.presentCount ?? 0} onRunNotLive={props.onRunNotLive ?? jest.fn()} />));
  });
  return rerender;
}

beforeEach(() => {
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

test('offers the tap with the count, sends nothing until it is tapped, then says how many were marked', async () => {
  serve(2);
  await show();
  expect(screen.getByText('2 signed up for Youth boxing have no mark on its register or in any session today.')).toBeTruthy();
  expect(patches()).toHaveLength(0);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 Absent' }));
  });
  expect(String(patches()[0][0])).toContain('/api/pilot/session-scripts/runs/run-1');
  expect(JSON.parse(String((patches()[0][1] as RequestInit).body))).toEqual({ action: 'mark_no_shows' });
  expect(screen.getByRole('status').textContent).toBe('2 signed-up athletes were marked Absent on the class register.');
});

test('offers nothing when nobody is missing (or the server would refuse), or for another class', async () => {
  serve(0);
  await show();
  expect(screen.queryByRole('button')).toBeNull();
  fetchSpy.mockReset();
  serve(3, undefined, 'class-other');
  await show();
  expect(screen.queryByRole('button', { name: /Absent/ })).toBeNull();
});

test('reads the count again when the marks here change', async () => {
  serve(2);
  const rerender = await show({ presentCount: 1 });
  expect(screen.getByRole('button', { name: 'Mark all 2 Absent' })).toBeTruthy();
  serve(1);
  await act(async () => {
    rerender(<SessionNoShows runId="run-1" classId="class-youth" presentCount={2} onRunNotLive={jest.fn()} />);
  });
  expect(screen.getByRole('button', { name: 'Mark them Absent' })).toBeTruthy();
});

test('a failed read says so and can check again; it never reads as nobody to mark', async () => {
  serve('fail');
  await show();
  expect(screen.getByText(/Could not check the class register for no-shows\./)).toBeTruthy();
  serve(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  });
  expect(screen.getByRole('button', { name: 'Mark them Absent' })).toBeTruthy();
});

test('a refusal is said in the server\'s words; a run ended elsewhere is handed back', async () => {
  serve(1, () => json({ error: 'SESSION_CLASS_NOT_STARTED', message: 'This class has not started yet, so nobody is a no-show.' }, 409));
  await show();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark them Absent' }));
  });
  expect(screen.getByRole('alert').textContent).toBe('This class has not started yet, so nobody is a no-show.');
});

test('a run ended elsewhere is handed back to the live screen', async () => {
  serve(1, () => json({ error: 'SESSION_RUN_NOT_LIVE' }, 409));
  const onRunNotLive = jest.fn();
  await show({ onRunNotLive });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark them Absent' }));
  });
  expect(onRunNotLive).toHaveBeenCalledTimes(1);
});

describe('kept on a flaky connection (W4 item 7, OQ-3)', () => {
  beforeEach(() => {
    resetSaveQueueForTests();
    createPersistentRoleSession('coach');
  });
  afterEach(() => {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  });

  function serveKept(patch: (send: number) => 'throw' | Response, noShowsAfter: (sends: number) => number, liveRunId = 'run-1') {
    let sends = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/pilot/auth/session')) return json({ authenticated: true, account_id: 'acct-a' });
      if (init?.method === 'PATCH') {
        sends += 1;
        const next = patch(sends);
        if (next === 'throw') throw new TypeError('Failed to fetch');
        return next;
      }
      return json({ run: { run_id: liveRunId }, class: tiedClass(noShowsAfter(sends)) });
    });
  }

  async function tapMark(onRunNotLive = jest.fn()) {
    prepareSaveQueue();
    await show({ onRunNotLive });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 Absent' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    return onRunNotLive;
  }

  test('a no-shows tap whose send is lost is kept: the button waits and says so; it is resent with its signal and says how many were marked', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ marked: ['a', 'b'] })), (sends) => (sends > 1 ? 0 : 2));
    await tapMark();
    expect(patches()).toHaveLength(1);
    expect(screen.getByText('Marking the no-shows Absent is not saved yet. This page keeps sending it while it stays open.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark all 2 Absent' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(patches()).toHaveLength(2);
    for (const [, init] of patches()) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('2 signed-up athletes were marked Absent on the class register.')).toBeTruthy();
  });

  test('a resend answered with nobody marked (an earlier send marked them) does not say nobody needed marking', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ marked: [] })), (sends) => (sends > 0 ? 0 : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.queryByText(/Nobody needed marking/)).toBeNull();
    expect(screen.getByText('The class register now shows no no-shows.')).toBeTruthy();
  });

  test('a refused resend the server shows as landed (this run, no no-shows left) reads as done (condition 2)', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? 0 : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('The class register now shows no no-shows.')).toBeTruthy();
  });

  test('a refused resend when the coach\'s live run is another run is not read as landed: its words are said here', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? 0 : 2), 'run-2');
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByRole('alert').textContent).toBe('Not yet.');
  });

  test('a tap refused because the session is no longer live hands that to the console, as today', async () => {
    jest.useFakeTimers();
    serveKept(() => json({ error: 'SESSION_RUN_NOT_LIVE' }, 409), () => 2);
    const onRunNotLive = await tapMark();
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
  });
});
