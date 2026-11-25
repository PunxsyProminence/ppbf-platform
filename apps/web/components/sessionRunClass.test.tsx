/**
 * @jest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SessionClassPicker from './SessionClassPicker';
import SessionRunClass, { tieSummary } from './SessionRunClass';
import SaveQueueNotice from './SaveQueueNotice';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, prepareSaveQueue, resetSaveQueueForTests } from '@/src/lib/saveQueue';

// D4 (OD-2026-10-21-002): the class picker and the live screen's class line. The rules are the
// server's (sessionRunClass.pg.test.ts); this proves what the screen sends and says.

const fetchSpy = jest.fn();
const now = Date.now();
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const YOUTH = { class_id: 'class-youth', title: 'Youth boxing', start_at: iso(-10), end_at: iso(50), held_by_other_session: false };
const ADULT = { class_id: 'class-adult', title: 'Adult boxing', start_at: iso(120), end_at: iso(180), held_by_other_session: false };
const HELD = { class_id: 'class-held', title: 'Sparring', start_at: iso(-5), end_at: iso(55), held_by_other_session: true };

function json(body: unknown, status = 200) {
  const response = { ok: status < 400, status, json: async () => body, clone: () => response };
  return response as unknown as Response;
}

beforeEach(() => {
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe('SessionClassPicker', () => {
  test('opens on the one class under way, shows a held class it cannot pick, and offers No class', async () => {
    fetchSpy.mockResolvedValue(json({ classes: [YOUTH, ADULT, HELD] }));
    const onChange = jest.fn();
    render(<SessionClassPicker value={undefined} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('class-youth', expect.objectContaining({ picked: false })));
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/pilot/session-scripts/runs?classes=today');
    expect((screen.getByRole('radio', { name: /Sparring/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'No class (open gym)' }));
    expect(onChange).toHaveBeenLastCalledWith(null, expect.objectContaining({ picked: true }));
  });

  test('with two classes under way it leaves the choice to the coach and says so', async () => {
    fetchSpy.mockResolvedValue(json({ classes: [YOUTH, { ...ADULT, start_at: iso(-20) }] }));
    const onChange = jest.fn();
    render(<SessionClassPicker value={undefined} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined, expect.objectContaining({ picked: false })));
    expect(screen.getByText('Choose the class, or No class, to start.')).toBeTruthy();
  });

  test('when the classes cannot be read, it says the session starts without a class', async () => {
    fetchSpy.mockResolvedValue(json({}, 500));
    const onChange = jest.fn();
    render(<SessionClassPicker value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, { picked: false, classes: [] }));
    expect(screen.getByRole('status').textContent).toContain('starts without a class');
  });
});

describe('SessionRunClass', () => {
  test('an untied session ties to the chosen class and says what the register now shows', async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        return json({ class_id: 'class-youth', copied: [{ athlete_id: 'a', effect: 'created' }, { athlete_id: 'b', effect: 'flipped', previous_status: 'absent' }], released: [] });
      }
      if (url.includes('classes=today')) return json({ classes: [YOUTH] });
      return json({ run: {}, class: { ...YOUTH, status: 'open', no_shows: 0 } });
    });
    const onClassChange = jest.fn();
    render(<SessionRunClass runId="run-1" classId={null} onClassChange={onClassChange} onRunNotLive={jest.fn()} />);
    expect(screen.getByText(/No class \(open gym\)\. Marks here do not go on a class register\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tie to a class...' }));
    await waitFor(() => expect((screen.getByRole('radio', { name: /Youth boxing/ }) as HTMLInputElement).checked).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tie to this class' }));
    });
    const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(String(patch?.[0])).toContain('/api/pilot/session-scripts/runs/run-1');
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ action: 'tie_class', class_id: 'class-youth' });
    expect(onClassChange).toHaveBeenCalledWith('class-youth');
    expect(screen.getByRole('status').textContent).toBe(
      'Tied to Youth boxing. 1 athlete is Present on its register; 1 was marked Absent and is now Present.',
    );
  });

  test('a tied session names its class and unties, saying the register marks stay', async () => {
    fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return json({ class_id: null, copied: [], released: ['a', 'b'] });
      return json({ run: {}, class: { ...YOUTH, status: 'open', no_shows: 0 } });
    });
    const onClassChange = jest.fn();
    render(<SessionRunClass runId="run-1" classId="class-youth" onClassChange={onClassChange} onRunNotLive={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Youth boxing')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Untie from the class' }));
    });
    expect(JSON.parse(String((fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')?.[1] as RequestInit).body)))
      .toEqual({ action: 'tie_class', class_id: null });
    expect(onClassChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('status').textContent).toBe('No class now (open gym). The 2 marks this session put on the class register stay.');
  });

  test('a refusal shows the server\'s words and changes nothing', async () => {
    fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return json({ error: 'SESSION_CLASS_ALREADY_LIVE', message: 'Another live session is already running this class.' }, 409);
      return json({ run: {}, class: { ...YOUTH, status: 'open', no_shows: 0 } });
    });
    const onClassChange = jest.fn();
    render(<SessionRunClass runId="run-1" classId="class-youth" onClassChange={onClassChange} onRunNotLive={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Untie from the class' }));
    });
    expect(onClassChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Another live session is already running this class.');
  });
});

test('a session that ended elsewhere is handed back to the live screen, not retried', async () => {
  fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return json({ error: 'SESSION_RUN_NOT_LIVE' }, 409);
    return json({ run: null });
  });
  const onRunNotLive = jest.fn();
  render(<SessionRunClass runId="run-1" classId="class-youth" onClassChange={jest.fn()} onRunNotLive={onRunNotLive} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Untie from the class' }));
  });
  expect(onRunNotLive).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toBe('');
});

test('a class cancelled since the tie says marks stay on the session only', async () => {
  fetchSpy.mockResolvedValue(json({ run: {}, class: { ...YOUTH, status: 'cancelled', no_shows: 0 } }));
  render(<SessionRunClass runId="run-1" classId="class-youth" onClassChange={jest.fn()} onRunNotLive={jest.fn()} />);
  expect(await screen.findByText(/This class was cancelled: marks here stay on the session only\./)).toBeTruthy();
});

test('tieSummary counts what the register shows without naming anyone', () => {
  expect(tieSummary('Youth', [])).toBe('Tied to Youth.');
  expect(tieSummary('Youth', [{ athlete_id: 'a', effect: 'register_newer' }, { athlete_id: 'b', effect: 'skipped' }, { athlete_id: 'c', effect: 'skipped' }]))
    .toBe('Tied to Youth. 1 mark changed on the register after your tap stays as the register says; 2 athletes were not added.');
  expect(tieSummary('Youth', [
    { athlete_id: 'a', effect: 'flipped', previous_status: 'absent' },
    { athlete_id: 'b', effect: 'flipped', previous_status: 'excused' },
    { athlete_id: 'c', effect: 'flipped', previous_status: 'excused' },
  ])).toBe('Tied to Youth. 1 was marked Absent and is now Present; 2 were marked Excused and are now Present.');
});

describe('SessionRunClass: a tie kept on a flaky connection (W4 item 7, OQ-3)', () => {
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

  // The server: the coach's live run (by id) and its class, and the PATCH answers in turn.
  function serveTie(liveRunId: string, patches: Array<'throw' | Response>, tiedTo: () => string | null) {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, account_id: 'acct-a' });
      if (init?.method === 'PATCH') {
        const next = patches.shift() ?? 'throw';
        if (next === 'throw') throw new TypeError('Failed to fetch');
        return next;
      }
      if (url.includes('classes=today')) return json({ classes: [YOUTH] });
      const tied = tiedTo();
      return json({ run: { run_id: liveRunId }, class: tied ? { ...YOUTH, status: 'open', no_shows: 0 } : null });
    });
  }

  async function tieToYouth() {
    prepareSaveQueue();
    const onClassChange = jest.fn();
    await act(async () => {
      render(<SessionRunClass runId="run-1" classId={null} onClassChange={onClassChange} onRunNotLive={jest.fn()} />);
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tie to a class...' }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tie to this class' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    return onClassChange;
  }

  test('a tie whose answer is lost is kept, named with its class while it waits, and resent with its signal; a refused resend the server shows as landed reads as done', async () => {
    jest.useFakeTimers();
    let tied: string | null = null;
    // The first send reached the server and tied it; its answer was lost.
    const firstSend = () => {
      tied = 'class-youth';
      return 'throw' as const;
    };
    const patches: Array<'throw' | Response> = [];
    serveTie('run-1', patches, () => tied);
    fetchSpy.mockImplementationOnce(fetchSpy.getMockImplementation() as never);
    const base = fetchSpy.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let sends = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sends += 1;
        if (sends === 1) {
          firstSend();
          throw new TypeError('Failed to fetch');
        }
        return json({ error: 'CLASS_NOT_TIEABLE', message: 'That class cannot be tied now.' }, 409);
      }
      return base(input, init);
    });
    const onClassChange = await tieToYouth();
    expect(screen.getByRole('status').textContent).toBe('Tie the session to Youth boxing: not saved yet. This page keeps sending it while it stays open.');
    expect(onClassChange).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    const patchesSent = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patchesSent).toHaveLength(2);
    for (const [, init] of patchesSent) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const checks = fetchSpy.mock.calls.filter(([input, init]) => String(input).endsWith('/api/pilot/session-scripts/runs') && (init as RequestInit | undefined)?.signal);
    expect(checks.length).toBeGreaterThan(0);
    expect(onClassChange).toHaveBeenCalledWith('class-youth');
    expect(screen.getByRole('status').textContent).toContain('Tied to Youth boxing.');
  });

  test('a refused resend when the coach\'s live run is another run is not read as landed: its words are said here', async () => {
    jest.useFakeTimers();
    let sends = 0;
    serveTie('run-2', [], () => 'class-youth');
    const base = fetchSpy.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return json({ error: 'CLASS_NOT_TIEABLE', message: 'That class cannot be tied now.' }, 409);
      }
      return base(input, init);
    });
    const onClassChange = await tieToYouth();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(onClassChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('That class cannot be tied now.');
  });

  test('signing out drops a kept tie: its waiting words go', async () => {
    jest.useFakeTimers();
    serveTie('run-1', [], () => null);
    await tieToYouth();
    expect(screen.getByRole('status').textContent).toContain('not saved yet');
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('a refusal after the class line has gone from the page is said in the page\'s list, after the save\'s name', async () => {
    jest.useFakeTimers();
    let sends = 0;
    serveTie('run-2', [], () => 'class-youth');
    const base = fetchSpy.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return json({ error: 'CLASS_NOT_TIEABLE', message: 'That class cannot be tied now.' }, 409);
      }
      return base(input, init);
    });
    await tieToYouth();
    cleanup();
    await act(async () => {
      render(<SaveQueueNotice />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText('Tie the session to Youth boxing: That class cannot be tied now.')).toBeTruthy();
  });
});
