/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import BehaviourSampleWindow from './BehaviourSampleWindow';

// The coach's sampled-window screen for gym tablets (PATTERN-1f). The routes decide who may do
// what (behaviour-windows route suites and behaviourSampleWindows.pg.test.ts); this suite asserts
// what the screen sends and shows: one athlete, one window, the coach's own taps only, and nothing
// it does not know.

const KEYS = '/api/pilot/coach/behaviour-keys';
const WINDOWS = '/api/pilot/coach/behaviour-windows';
const WINDOW = `${WINDOWS}/win-1`;
const NAMES = [
  { behaviour_key: 'k_drop', label: 'Drops the lead hand after the jab', status: 'active' },
  { behaviour_key: 'k_old', label: 'An old name', status: 'retired' },
];
const OPEN_ROW = {
  window_id: 'win-1', athlete_id: 'ath-1', behaviour_key: 'k_drop', run_id: 'run 1', context_kind: 'context',
  context_id: 'session', task_constraint: 'controlled', chances: 10, closed_at: null,
};
const SHOWN = /^Shown for Ada Reyes, chance/;
const NOT_SHOWN = /^Not shown for Ada Reyes, chance/;

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[];

/** Answers by method and path; a handler returning undefined is a route this test does not expect. */
function serve(handler: (call: Call) => Response | Promise<Response> | undefined) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const answer = await handler(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${call.url}`);
    return answer;
  }) as unknown as typeof fetch;
}

const lists = (open: unknown[] = []) => (call: Call) => {
  if (call.method === 'GET' && call.url === KEYS) return respond({ ok: true, keys: NAMES, skillCodes: [] });
  if (call.method === 'GET' && call.url === `${WINDOWS}?sessionRunId=run%201`) return respond({ ok: true, windows: open });
  return undefined;
};

/** A window read: the row, where the count stands, and this coach's own taps. */
const windowRead = (currentChance: number, myTaps: unknown[] = [], row: Record<string, unknown> = OPEN_ROW) =>
  respond({ ok: true, window: row, currentChance, myTaps });

/** Taps and changes echo what was sent; a close answers the closed row. */
const patchEcho = (call: Call) => (call.body?.action === 'close'
  ? respond({ ok: true, window: { ...OPEN_ROW, closed_at: '2026-11-22T20:00:00Z' } })
  : respond({ ok: true, tap: { chance: call.body?.chance ?? 1, polarity: call.body?.polarity } }));

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function showOpened() {
  await act(async () => {
    render(<BehaviourSampleWindow runId="run 1" athleteId="ath-1" athleteName="Ada Reyes" />);
  });
  await press(/Watch a behaviour/);
}

const reopen = async () => {
  await press(/^Hide/);
  await press(/Watch a behaviour/);
  await press(/Join:/);
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads nothing until the coach opens it, then offers the active names, the contexts and the task, ten chances unless set', async () => {
  serve(lists());
  await act(async () => {
    render(<BehaviourSampleWindow runId="run 1" athleteId="ath-1" athleteName="Ada Reyes" />);
  });
  expect(calls).toEqual([]);
  expect(screen.getByRole('button', { name: 'Watch a behaviour for Ada Reyes' })).toHaveAttribute('aria-expanded', 'false');
  await press(/Watch a behaviour/);
  const name = screen.getByLabelText('Behaviour') as HTMLSelectElement;
  expect(Array.from(name.options).map((option) => option.textContent)).toEqual(['Drops the lead hand after the jab']);
  expect((screen.getByLabelText('What they are doing') as HTMLSelectElement).value).toBe('session');
  expect((screen.getByLabelText('Task') as HTMLSelectElement).value).toBe('controlled');
  expect((screen.getByLabelText('Chances') as HTMLInputElement).value).toBe('10');
});

test('opens a window for this athlete in this run, as asked, then shows chance 1 of its chances and no change to make', async () => {
  serve((call) => lists()(call) ?? (call.method === 'POST' && call.url === WINDOWS
    ? respond({ ok: true, window: { ...OPEN_ROW, task_constraint: 'live', chances: 6 } }, 201) : undefined));
  await showOpened();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'live' } });
    fireEvent.change(screen.getByLabelText('What they are doing'), { target: { value: 'technical_sparring' } });
    fireEvent.change(screen.getByLabelText('Chances'), { target: { value: '6' } });
  });
  await press('Open the window');
  expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
    athleteId: 'ath-1', behaviourKey: 'k_drop', sessionRunId: 'run 1', attemptContext: 'technical_sparring',
    taskConstraint: 'live', chances: 6,
  });
  expect(screen.getByText('Chance 1 of 6')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: SHOWN })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: NOT_SHOWN })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
});

test('a refused open gives the server\'s reason and reads nothing; an open with no answer is not known and the list is read again', async () => {
  let posts = 0;
  serve((call) => {
    if (call.method === 'POST') {
      posts += 1;
      return posts === 1 ? respond({ ok: false, error: 'That athlete is not marked present in that session run.' }, 400) : respond({}, 500);
    }
    return lists()(call);
  });
  await showOpened();
  const listReads = () => calls.filter((call) => call.url === KEYS).length;
  await press('Open the window');
  expect(screen.getByRole('status')).toHaveTextContent('Not opened: That athlete is not marked present in that session run.');
  expect(listReads()).toBe(1);
  await press('Open the window');
  expect(screen.getByRole('status')).toHaveTextContent('It is not known whether the window was opened (500); reading the list again.');
  expect(listReads()).toBe(2);
});

test('a tap goes to the chance on screen, the count moves on, and change last tap flips the coach\'s own last tap', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(1) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join: Drops the lead hand after the jab \(Controlled, Session, 10 chances\)/);
  expect(screen.getByText('Chance 1 of 10')).toBeInTheDocument();
  await press(SHOWN);
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 1, polarity: 'occurrence' });
  expect(screen.getByRole('status')).toHaveTextContent('Saved: chance 1, Shown.');
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: 1 shown of 1 tapped')).toBeInTheDocument();
  await press(/Change last tap to Not shown/);
  expect(calls.at(-1)?.body).toEqual({ action: 'change_last', polarity: 'counterexample' });
  expect(screen.getByText('You: 0 shown of 1 tapped')).toBeInTheDocument();
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
});

test('while a tap is saving, both tap buttons are held and say so', async () => {
  let release: (response: Response) => void = () => undefined;
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') return new Promise<Response>((resolve) => { release = resolve; });
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: SHOWN }));
  });
  expect(screen.getByRole('button', { name: SHOWN })).toBeDisabled();
  expect(screen.getByRole('button', { name: NOT_SHOWN })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Saving…');
  await act(async () => {
    release(respond({ ok: true, tap: { chance: 1, polarity: 'occurrence' } }));
  });
  expect(screen.getByRole('button', { name: SHOWN })).toBeEnabled();
});

test('a coach joining or coming back starts at the chance the count stands at, not after their own last (7084899452 point 2)', async () => {
  let mine: unknown[] = [];
  let current = 4;
  serve((call) => {
    if (call.url === WINDOW) return call.method === 'GET' ? windowRead(current, mine) : patchEcho(call);
    return lists([OPEN_ROW, { ...OPEN_ROW, window_id: 'win-9', athlete_id: 'ath-2' }])(call);
  });
  await showOpened();
  // Only this athlete's open window is offered.
  expect(screen.getAllByRole('button', { name: /^Join:/ })).toHaveLength(1);
  await press(/Join:/);
  expect(screen.getByText('Chance 4 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: no taps yet')).toBeInTheDocument();

  // Back after tapping 1 and 2 while another coach went on to 7: the count, not their own next.
  mine = [{ chance: 1, polarity: 'occurrence' }, { chance: 2, polarity: 'counterexample' }];
  current = 8;
  await reopen();
  expect(screen.getByText('Chance 8 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: 1 shown of 2 tapped')).toBeInTheDocument();
  await press(SHOWN);
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 8, polarity: 'occurrence' });

  // Back when the count is past the last chance: the window is full, whatever this coach tapped.
  current = 11;
  await reopen();
  expect(screen.getByText('No chances left: all 10 are tapped or skipped, so the window is full.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: SHOWN })).toBeNull();
});

test('the last chance takes a tap, and then the window is full', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(10) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  expect(screen.getByText('Chance 10 of 10')).toBeInTheDocument();
  await press(NOT_SHOWN);
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 10, polarity: 'counterexample' });
  expect(screen.getByText('No chances left: all 10 are tapped or skipped, so the window is full.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: NOT_SHOWN })).toBeNull();
  expect(screen.getByRole('button', { name: 'Close the window' })).toBeInTheDocument();
});

test('closing asks first, says it is for every coach, then sends close; a closed window takes no tap and no change', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(3) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  await press('Close the window');
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 3, polarity: 'occurrence' });
  expect(screen.getByText('Closing ends this window for every coach, and it cannot be opened again.')).toBeInTheDocument();
  await press('Keep it open');
  expect(screen.getByRole('button', { name: SHOWN })).toBeInTheDocument();
  await press('Close the window');
  await press('Yes, close it');
  expect(calls.at(-1)?.body).toEqual({ action: 'close' });
  expect(screen.getByText('This window is closed.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: SHOWN })).toBeNull();
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close the window' })).toBeNull();
});

test('a refused tap says the server\'s reason and reads the window again; a lost answer says it is not known and forgets the last tap', async () => {
  let patches = 0;
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') {
      patches += 1;
      if (patches === 1) return patchEcho(call);
      if (patches === 2) return respond({ ok: false, error: 'That window is closed.' }, 400);
      throw new Error('network');
    }
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  const reads = () => calls.filter((call) => call.method === 'GET' && call.url === WINDOW).length;
  await press(SHOWN);
  expect(screen.getByRole('button', { name: /Change last tap/ })).toBeInTheDocument();
  await press(NOT_SHOWN);
  expect(screen.getByRole('status')).toHaveTextContent('Not saved: That window is closed.');
  expect(reads()).toBe(2);
  // Refused: nothing was saved, so the coach's last tap is still the one shown.
  expect(screen.getByRole('button', { name: /Change last tap/ })).toBeInTheDocument();
  await press(SHOWN);
  expect(screen.getByRole('status')).toHaveTextContent('It is not known whether the tap was saved; reading the window again.');
  expect(reads()).toBe(3);
  // Not known: which tap is the coach's last is not known either, so there is nothing to change.
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
});

test('a coming-back coach does not keep another window\'s last tap', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(1) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  expect(screen.getByRole('button', { name: /Change last tap/ })).toBeInTheDocument();
  await reopen();
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
});

test('an answer that lands after the coach hid the screen does not open it again', async () => {
  let release: (response: Response) => void = () => undefined;
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') return new Promise<Response>((resolve) => { release = resolve; });
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: SHOWN }));
  });
  await press(/^Hide/);
  await act(async () => {
    release(respond({}, 500));
  });
  expect(screen.getByRole('button', { name: 'Watch a behaviour for Ada Reyes' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(/Chance/)).toBeNull();
});

test('a list or a window it could not read says so, never "none", and Read again reads that same thing', async () => {
  serve((call) => (call.url === KEYS ? respond({ ok: false }, 500) : lists()(call)));
  await showOpened();
  expect(screen.getByText('The behaviour names or this run\'s windows could not be read just now.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Behaviour')).toBeNull();
  serve((call) => (call.url === KEYS ? respond({ ok: true, keys: [NAMES[1]] }) : lists([OPEN_ROW])(call)));
  await press('Read again');
  expect(screen.getByText('This gym has no active behaviour name yet, so a window cannot be opened.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open the window' })).toBeNull();

  // A window answer without the count is not a window it can show.
  serve((call) => (call.url === WINDOW ? respond({ ok: true, window: OPEN_ROW, myTaps: [] }) : lists([OPEN_ROW])(call)));
  await press(/Join:/);
  expect(screen.getByText('This window could not be read just now.')).toBeInTheDocument();
  serve((call) => (call.url === WINDOW ? windowRead(2) : undefined));
  await press('Read again');
  expect(calls.map((call) => call.url)).toEqual([WINDOW]);
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
});

test('the screen shows only the coach\'s own count: no tier, label, bar or other coach\'s taps (Q2 A, Q6, LL-Q2)', async () => {
  serve((call) => (call.url === WINDOW ? windowRead(6, [{ chance: 5, polarity: 'occurrence' }]) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('meter')).toBeNull();
  expect(document.body.textContent).not.toMatch(/tier|emerging|established|pattern|bar\b/i);
  expect(screen.getByText('You: 1 shown of 1 tapped')).toBeInTheDocument();
});

test('the gym-floor sizes that apply: every button takes the sheet\'s tap floor, the fields the kiosk input, the two tap buttons twice --tap and 160px wide inline', async () => {
  serve((call) => (call.url === WINDOW ? windowRead(1) : lists([OPEN_ROW])(call)));
  await showOpened();
  for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('btn', 'btn--tap');
  for (const field of [...screen.getAllByRole('combobox'), screen.getByRole('spinbutton')]) expect(field).toHaveClass('input--kiosk');
  await press(/Join:/);
  expect(screen.getByRole('button', { name: /^Skip this chance/ })).toHaveClass('btn', 'btn--tap');
  for (const name of [SHOWN, NOT_SHOWN]) {
    const button = screen.getByRole('button', { name });
    // Inline, because a utility class cannot beat .btn's own min-height.
    expect(button.style.minHeight).toBe('calc(var(--tap) * 2)');
    expect(button.style.minWidth).toBe('160px');
  }
});

test('mid-window, a re-read after an error keeps the coach\'s place, moved past a tap of theirs it finds saved; it does not jump to the count', async () => {
  let patches = 0;
  let mine: unknown[] = [];
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(patches === 0 ? 1 : 7, mine);
    if (call.method === 'PATCH') {
      patches += 1;
      if (patches === 1) {
        mine = [{ chance: 1, polarity: 'occurrence' }];
        return patchEcho(call);
      }
      if (patches === 2) return respond({ ok: false, error: 'That window is closed.' }, 409);
      // Saved, but the answer is lost: the re-read finds chance 2 among this coach's taps.
      mine = [{ chance: 1, polarity: 'occurrence' }, { chance: 2, polarity: 'counterexample' }];
      throw new Error('network');
    }
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
  // Refused, and the count has moved on to 7: this coach stays at their own place.
  await press(NOT_SHOWN);
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
  // Lost: the read shows chance 2 saved, so the coach moves on to 3 rather than tapping 2 again.
  await press(NOT_SHOWN);
  expect(screen.getByText('Chance 3 of 10')).toBeInTheDocument();
});

test('a tap answered with a server error forgets the last tap, as a lost one does', async () => {
  let patches = 0;
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') {
      patches += 1;
      return patches === 1 ? patchEcho(call) : respond({}, 500);
    }
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  expect(screen.getByRole('button', { name: /Change last tap/ })).toBeInTheDocument();
  await press(SHOWN);
  expect(screen.getByRole('status')).toHaveTextContent('It is not known whether the tap was saved (500); reading the window again.');
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
});

test('opening a new window forgets the last tap made in another', async () => {
  serve((call) => {
    if (call.url === WINDOW) return call.method === 'GET' ? windowRead(1) : patchEcho(call);
    if (call.method === 'POST') return respond({ ok: true, window: { ...OPEN_ROW, window_id: 'win-2' } }, 201);
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  expect(screen.getByRole('button', { name: /Change last tap/ })).toBeInTheDocument();
  await press(/^Hide/);
  await press(/Watch a behaviour/);
  await press('Open the window');
  expect(screen.getByText('Chance 1 of 10')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
});

test('a list read that lands after the coach hid the screen does not open it again', async () => {
  let release: (response: Response) => void = () => undefined;
  serve((call) => {
    if (call.url === KEYS) return new Promise<Response>((resolve) => { release = resolve; });
    return lists()(call);
  });
  await act(async () => {
    render(<BehaviourSampleWindow runId="run 1" athleteId="ath-1" athleteName="Ada Reyes" />);
  });
  await press(/Watch a behaviour/);
  await press(/^Hide/);
  await act(async () => {
    release(respond({ ok: true, keys: NAMES }));
  });
  expect(screen.getByRole('button', { name: 'Watch a behaviour for Ada Reyes' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('Behaviour')).toBeNull();
});

// PATTERN-2b: "Skip this chance" (Jason 2026-11-22, "yes add it"; Overwatch 7088785576 on #2082).
const SKIP = /^Skip this chance/;

test('skip this chance moves the coach\'s own count on one and saves nothing; the next tap goes to the chance after', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(3) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  expect(screen.getByRole('button', { name: SKIP })).toHaveAccessibleName('Skip this chance (chance 3, nothing saved)');
  const before = calls.length;
  await press(SKIP);
  expect(calls.length).toBe(before);
  expect(screen.getByRole('status')).toHaveTextContent('Skipped chance 3: nothing saved for it.');
  expect(screen.getByText('Chance 4 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: no taps yet')).toBeInTheDocument();
  await press(SHOWN);
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 4, polarity: 'occurrence' });
  expect(screen.getByText('Chance 5 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: 1 shown of 1 tapped')).toBeInTheDocument();
});

test('change last tap after a skip still flips the coach\'s last tap, not the skipped chance', async () => {
  serve((call) => (call.url === WINDOW ? (call.method === 'GET' ? windowRead(1) : patchEcho(call)) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  await press(SHOWN);
  await press(SKIP);
  expect(screen.getByText('Chance 3 of 10')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Change last tap to Not shown/ })).toHaveAccessibleName('Change last tap to Not shown (chance 1)');
  await press(/Change last tap to Not shown/);
  expect(calls.at(-1)?.body).toEqual({ action: 'change_last', polarity: 'counterexample' });
  expect(screen.getByText('Chance 3 of 10')).toBeInTheDocument();
});

test('skipping the last chance leaves the window full, with no tap and no skip to make', async () => {
  serve((call) => (call.url === WINDOW ? windowRead(10) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  await press(SKIP);
  expect(screen.getByText('No chances left: all 10 are tapped or skipped, so the window is full.')).toBeInTheDocument();
  for (const name of [SHOWN, NOT_SHOWN, SKIP]) expect(screen.queryByRole('button', { name })).toBeNull();
});

test('while a tap is saving, skip is held too, so the count cannot move under the tap', async () => {
  let release: (response: Response) => void = () => undefined;
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') return new Promise<Response>((resolve) => { release = resolve; });
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: SHOWN }));
  });
  expect(screen.getByRole('button', { name: SKIP })).toBeDisabled();
  await act(async () => {
    release(respond({ ok: true, tap: { chance: 1, polarity: 'occurrence' } }));
  });
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: SKIP })).toBeEnabled();
});

test('a re-read after a refused tap keeps the place a skip moved to', async () => {
  serve((call) => {
    if (call.url === WINDOW && call.method === 'GET') return windowRead(1);
    if (call.method === 'PATCH') return respond({ ok: false, error: 'That window is closed.' }, 400);
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  await press(SKIP);
  await press(SKIP);
  await press(SHOWN);
  expect(calls.at(-1)?.url).toBe(WINDOW);
  expect(calls.at(-2)?.body).toEqual({ action: 'tap', chance: 3, polarity: 'occurrence' });
  expect(screen.getByText('Chance 3 of 10')).toBeInTheDocument();
});
