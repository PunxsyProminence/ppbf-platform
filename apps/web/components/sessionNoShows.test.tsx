/**
 * @jest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import SessionNoShows from './SessionNoShows';
import SaveQueueNotice from './SaveQueueNotice';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, prepareSaveQueue, readSaveQueue, resetSaveQueueForTests } from '@/src/lib/saveQueue';

// The End Session no-shows offer (OD-2026-10-21-004 ruling 3, "A: Offer it (Rec.)"). Which athletes
// it marks, and when the server refuses, are proven in sessionRunClass.pg.test.ts; this proves the
// screen offers it only with something to mark, sends it only on the coach's tap, and says what
// happened.

const fetchSpy = jest.fn();
const json = (body: unknown, status = 200) => {
  const response = { ok: status < 400, status, json: async () => body, clone: () => response };
  return response as unknown as Response;
};
/** The class view; its no-shows are ath-1, ath-2, … unless named. */
const tiedClass = (noShows: number | readonly string[], classId = 'class-youth') => {
  const ids = typeof noShows === 'number' ? Array.from({ length: noShows }, (_, i) => `ath-${i + 1}`) : [...noShows];
  return { class_id: classId, title: 'Youth boxing', start_at: 's', end_at: 'e', status: 'open', no_shows: ids.length, no_show_ids: ids };
};

function serve(noShows: number | 'fail', patch: () => Response = () => json({ marked: ['a', 'b'] }), classId = 'class-youth') {
  fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch();
    return noShows === 'fail' ? json({}, 500) : json({ run: {}, class: tiedClass(noShows, classId) });
  });
}

const patches = () => fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
/** Reads of the live run and its class. */
const classReads = () => fetchSpy.mock.calls.filter(([input, init]) => !(init as RequestInit | undefined)?.method && String(input).endsWith('/session-scripts/runs'));

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
  // Today's path: the names on screen and their class, sent once, with no key.
  expect(JSON.parse(String((patches()[0][1] as RequestInit).body))).toEqual({ action: 'mark_no_shows', athlete_ids: ['ath-1', 'ath-2'], class_id: 'class-youth' });
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
    // Signed in first, then the queue reset: the sign-in's ask must not outlive the reset.
    createPersistentRoleSession('coach');
    resetSaveQueueForTests();
  });
  afterEach(() => {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  });

  function serveKept(
    patch: (send: number) => 'throw' | Response,
    noShowsAfter: (sends: number) => number | readonly string[],
    liveRunId = 'run-1',
    liveClassAfter: (sends: number) => string = () => 'class-youth',
  ) {
    let sends = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/pilot/auth/session')) return json({ authenticated: true, account_id: 'acct-a' });
      if (init?.method === 'PATCH') {
        sends += 1;
        const next = patch(sends);
        if (next === 'throw') throw new TypeError('Failed to fetch');
        return next;
      }
      return json({ run: { run_id: liveRunId }, class: tiedClass(noShowsAfter(sends), liveClassAfter(sends)) });
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

  // OVERWATCH 7160191377: the resend names what the first send named, with the same key, even after the
  // screen has read a different set of no-shows; the server answers a landed key with its first answer.
  test('every send names the athletes shown at the tap, with one key, even after the screen reads others', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ marked: ['ath-1', 'ath-2'] })), (sends) => (sends > 0 ? ['ath-3'] : 2));
    const rerender = await (async () => {
      prepareSaveQueue();
      const later = await show();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 Absent' }));
        await jest.advanceTimersByTimeAsync(0);
      });
      return later;
    })();
    // The marks here change while it waits: the screen reads the class again, and shows only Ath 3 now.
    await act(async () => {
      rerender(<SessionNoShows runId="run-1" classId="class-youth" presentCount={1} onRunNotLive={jest.fn()} />);
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button', { name: 'Mark them Absent' })).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    const bodies = patches().map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    // The names and class shown at the tap, and one key: the server marks only those, once.
    expect(bodies[0]).toEqual({ action: 'mark_no_shows', athlete_ids: ['ath-1', 'ath-2'], class_id: 'class-youth', request_key: expect.any(String) });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(String(bodies[0].request_key).length).toBeGreaterThan(0);
    // The answer the server replays is the first send's: it says how many that send marked.
    expect(screen.getByText('2 signed-up athletes were marked Absent on the class register.')).toBeTruthy();
  });

  test('a resend answered with nobody marked says nobody it named needed marking: the server would have replayed a send that landed', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ marked: [] })), (sends) => (sends > 0 ? 0 : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText('Nobody this tap named needed marking.')).toBeTruthy();
  });

  test('a refused resend the server shows as landed (this run, none of the names sent still a no-show) reads as done (condition 2)', async () => {
    jest.useFakeTimers();
    // Ath 9 became a no-show since; the tap never named them, so they do not count.
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? ['ath-9'] : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('None of the athletes this tap named is still listed as a no-show.')).toBeTruthy();
  });

  test('a refused resend while a name it sent is still a no-show is not read as landed: its words are said here', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? ['ath-2'] : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByRole('alert').textContent).toBe('Not yet.');
  });

  test.each(['SESSION_CLASS_CANCELLED', 'SESSION_CLASS_NOT_STARTED', 'SESSION_CLASS_NOT_YOURS', 'SESSION_RUN_NOT_TIED', 'SESSION_NO_SHOWS_CLASS_CHANGED'])(
    'a resend refused with %s, given only after the server looked the key up, is known not landed, though the class shows no no-shows',
    async (error) => {
      jest.useFakeTimers();
      serveKept((send) => (send === 1 ? 'throw' : json({ error, message: 'Refused.' }, 409)), (sends) => (sends > 0 ? 0 : 2));
      await tapMark();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(RESEND_MS);
      });
      expect(screen.getByRole('alert').textContent).toBe('Refused.');
      expect(screen.queryByText('None of the athletes this tap named is still listed as a no-show.')).toBeNull();
      // Read nothing to decide: only the class read before the tap.
      expect(classReads()).toHaveLength(1);
    },
  );

  test('a resend refused as the key reused with other names is not known, never read as not landed: a send of that key did land', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'SESSION_NO_SHOWS_KEY_REUSED', message: 'Refused.' }, 409)), (sends) => (sends > 0 ? 0 : 2));
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/not known/i);
    expect(screen.queryByText('Refused.')).toBeNull();
    expect(classReads()).toHaveLength(1);
  });

  test('a resend refused as not found (refused before the key is looked up) is checked against the class, and reads as landed when none it named is still a no-show', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'SESSION_RUN_NOT_FOUND' }, 404)), (sends) => (sends > 0 ? 0 : 2));
    const onRunNotLive = await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    // The landed check's read is the one sent with the queue's signal.
    expect(classReads().filter(([, init]) => (init as RequestInit).signal)).toHaveLength(1);
    expect(onRunNotLive).not.toHaveBeenCalled();
    expect(screen.getByText('None of the athletes this tap named is still listed as a no-show.')).toBeTruthy();
  });

  test('a resend refused as no longer live, given after the key was looked up, hands that to the console without reading the class', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'SESSION_RUN_NOT_LIVE' }, 409)), (sends) => (sends > 0 ? 0 : 2));
    const onRunNotLive = await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('None of the athletes this tap named is still listed as a no-show.')).toBeNull();
    expect(classReads()).toHaveLength(1);
    // Named in the page's list as not saved too (round 13, reviewer A): the console only says the
    // session ended, and nothing at all once it settled on this page.
    expect(readSaveQueue().failed).toEqual([
      { label: 'Mark the no-shows Absent', words: 'Nobody was marked Absent: the session had already ended when it reached the server.', known: true },
    ]);
  });

  test('a resend refused as not found whose check cannot be read is named as not known in the page\'s list', async () => {
    jest.useFakeTimers();
    let reads = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/pilot/auth/session')) return json({ authenticated: true, account_id: 'acct-a' });
      if (init?.method === 'PATCH') {
        if (patches().length === 1) throw new TypeError('Failed to fetch');
        return json({ error: 'SESSION_RUN_NOT_FOUND' }, 404);
      }
      reads += 1;
      return reads === 1 ? json({ run: { run_id: 'run-1' }, class: tiedClass(2) }) : json({}, 500);
    });
    const onRunNotLive = await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().failed).toEqual([{ label: 'Mark the no-shows Absent', words: expect.stringMatching(/could not be checked/), known: false }]);
  });

  // Round 14, reviewer B: another class's no-shows say nothing about this class's; never "not saved".
  test('a refused resend when the coach\'s live run is tied to another class now is not known: its not-known words are said here', async () => {
    jest.useFakeTimers();
    serveKept(
      (send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)),
      (sends) => (sends > 0 ? 0 : 2),
      'run-1',
      (sends) => (sends > 0 ? 'class-other' : 'class-youth'),
    );
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/^Mark the no-shows Absent: .*not known whether it was saved/);
    expect(screen.queryByText('None of the athletes this tap named is still listed as a no-show.')).toBeNull();
  });

  test('a yes whose answer cannot be read is not taken as nobody marked: it is sent again, and the replayed answer says how many', async () => {
    jest.useFakeTimers();
    const unreadable = { ok: true, status: 200, json: async () => { throw new SyntaxError('cut off'); } } as Record<string, unknown>;
    unreadable.clone = () => unreadable;
    serveKept((send) => (send === 1 ? (unreadable as unknown as Response) : json({ marked: ['ath-1', 'ath-2'] })), (sends) => (sends > 1 ? 0 : 2));
    await tapMark();
    expect(screen.queryByText('Nobody this tap named needed marking.')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(patches()).toHaveLength(2);
    expect(screen.getByText('2 signed-up athletes were marked Absent on the class register.')).toBeTruthy();
  });

  // Round 14, reviewers A and B: once this run has ended, the live read cannot show what it holds.
  test('a refused resend when the coach\'s live run is another run is not known: its not-known words are said here', async () => {
    jest.useFakeTimers();
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? 0 : 2), 'run-2');
    await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/^Mark the no-shows Absent: .*not known whether it was saved/);
    expect(screen.queryByText('Not yet.')).toBeNull();
  });

  test('a resend refused as not found once no run is live is named as not known in the page\'s list, never as not saved', async () => {
    jest.useFakeTimers();
    let sends = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/pilot/auth/session')) return json({ authenticated: true, account_id: 'acct-a' });
      if (init?.method === 'PATCH') {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return json({ error: 'SESSION_RUN_NOT_FOUND' }, 404);
      }
      return sends === 0 ? json({ run: { run_id: 'run-1' }, class: tiedClass(2) }) : json({ run: null });
    });
    const onRunNotLive = await tapMark();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().failed).toEqual([{ label: 'Mark the no-shows Absent', words: expect.stringMatching(/could not be checked/), known: false }]);
  });

  test('a tap refused because the session is no longer live hands that to the console, as today', async () => {
    jest.useFakeTimers();
    serveKept(() => json({ error: 'SESSION_RUN_NOT_LIVE' }, 409), () => 2);
    const onRunNotLive = await tapMark();
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().failed).toEqual([
      { label: 'Mark the no-shows Absent', words: 'Nobody was marked Absent: the session had already ended when it reached the server.', known: true },
    ]);
  });

  test('a tap made before the page has confirmed who is signed in still waits, and says so, once kept', async () => {
    jest.useFakeTimers();
    serveKept(() => 'throw', () => 2);
    const base = fetchSpy.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const answers: Array<() => void> = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/pilot/auth/session')) {
        return new Promise<Response>((resolve) => {
          answers.push(() => resolve(json({ authenticated: true, account_id: 'acct-a' })));
        });
      }
      return base(input, init);
    });
    await tapMark();
    expect(answers.length).toBeGreaterThan(0);
    await act(async () => {
      for (const answer of answers.splice(0)) answer();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(patches()).toHaveLength(1);
    expect(screen.getByText('Marking the no-shows Absent is not saved yet. This page keeps sending it while it stays open.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark all 2 Absent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('signing out drops a kept tap: the button is free again and its waiting words go', async () => {
    jest.useFakeTimers();
    serveKept(() => 'throw', () => 2);
    await tapMark();
    expect((screen.getByRole('button', { name: 'Mark all 2 Absent' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      clearRoleSession();
    });
    expect((screen.getByRole('button', { name: 'Mark all 2 Absent' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/not saved yet/)).toBeNull();
  });

  test('a refusal after the offer has gone from the page is said in the page\'s list, after the save\'s name', async () => {
    jest.useFakeTimers();
    // This run, with a name the tap sent still a no-show: not landed, so the server's words are said.
    serveKept((send) => (send === 1 ? 'throw' : json({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, 409)), (sends) => (sends > 0 ? ['ath-2'] : 2));
    await tapMark();
    cleanup();
    await act(async () => {
      render(<SaveQueueNotice />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText('Mark the no-shows Absent: Not yet.')).toBeTruthy();
  });
});
