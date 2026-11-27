/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-4b (GO on #2192, 7206014991): what is running on the floor now, and how many are here,
// on the board's and the staff-role and volunteer homes. QH's words, asserted as literal text. A round is
// shown as read, with the time (QF A). The board's total reads a number only from 5 up and "Suppressed"
// for 0 to 4 (flag 3). A failed, unfinished or malformed read never reads as a number, a zero or "No
// class" (FN-0 F15). No name or id reaches the page, and nothing is kept on the device (F10).

import { act, render, screen } from '@testing-library/react';

import OnTheFloorClassesLine, { BoardOnTheFloorLine, CLASSES_LINE_WORDS } from './OnTheFloorClassesLine';
import { useBoardSession } from './BoardRoleGate';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';

jest.mock('./BoardRoleGate', () => ({ __esModule: true, useBoardSession: jest.fn() }));
const mockSession = jest.mocked(useBoardSession);

const CHECKING = 'Checking who is on the floor...';
const FAILED = 'Who is on the floor could not be checked.';
const NONE = 'No class is running now.';

const READ_AT = '2026-11-25T23:12:00.000Z';
const at = (iso: string) => formatGymTimeOfDay(iso) as string;
// A November evening at the gym (America/New_York, UTC-5): 6:00 PM to 7:00 PM, read at 6:12 PM.
const CLASS = { title: 'Bag work', start_at: '2026-11-25T23:00:00.000Z', end_at: '2026-11-26T00:00:00.000Z', room: 'Ring 1' };
const ROUND = { tv_name: 'Ring TV', phase: 'work', round: 2, rounds_total: 5, is_paused: false };
const CLASS_LINE = `Running now: Bag work, ${at(CLASS.start_at)} to ${at(CLASS.end_at)}, Ring 1`;
const ROUND_LINE = `Ring TV: round 2 of 5 (at ${at(READ_AT)})`;
const BOARD = { ok: true, read_at: READ_AT, classes: [CLASS], rounds: [ROUND], total: { status: 'available', count: 7 } };
const STAFF = { ok: true, read_at: READ_AT, classes: [{ ...CLASS, count: 3 }], rounds: [ROUND] };

const originalFetch = global.fetch;
beforeEach(() => {
  mockSession.mockReturnValue({ role: 'board', seats: [] });
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch;
}

/** The reader each answer is for: an answer with a total is the board's, any other the staff home's. */
const readerOf = (body: unknown): 'board' | 'staff' => (body && typeof body === 'object' && 'total' in body ? 'board' : 'staff');

async function linesFor(body: unknown, status = 200, reader = readerOf(body)): Promise<string[]> {
  respond(status, body);
  render(<OnTheFloorClassesLine reader={reader} />);
  await screen.findAllByText((_text, node) => node?.tagName === 'P' && node.textContent !== CHECKING);
  const region = screen.getByRole('region', { name: 'What is running on the floor' });
  return Array.from(region.querySelectorAll('p'), (p) => p.textContent ?? '');
}

test('the words are QH\'s, exactly', () => {
  expect(CLASSES_LINE_WORDS).toEqual({
    checking: CHECKING,
    failed: FAILED,
    none: NONE,
    running: 'Running now: ',
    total: 'On the floor now: ',
    suppressed: 'Suppressed',
  });
  expect(at(CLASS.start_at)).toMatch(/^6:00\sPM$/);
  expect(at(READ_AT)).toMatch(/^6:12\sPM$/);
});

test('the board: each class without a count, each round as read with its time, and the floored total', async () => {
  expect(await linesFor(BOARD)).toEqual([CLASS_LINE, ROUND_LINE, 'On the floor now: 7']);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/on-the-floor/classes'),
    expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
  );
});

test.each([
  [{ status: 'available', count: 5 }, 'On the floor now: 5'],
  [{ status: 'insufficient_data', count: null }, 'On the floor now: Suppressed'],
])('the board\'s total %j reads "%s" (flag 3)', async (total, line) => {
  expect((await linesFor({ ...BOARD, total })).at(-1)).toBe(line);
});

test('staff and volunteers: each class with how many are here, the rounds, and no total', async () => {
  expect(await linesFor(STAFF)).toEqual([`${CLASS_LINE}, 3 here`, ROUND_LINE]);
  expect(await screen.findByText(`${CLASS_LINE}, 3 here`)).toBeTruthy();
});

test('a class with nobody here yet reads 0 here for staff, whose counts are exact (flag 2)', async () => {
  expect((await linesFor({ ...STAFF, classes: [{ ...CLASS, count: 0 }] }))[0]).toBe(`${CLASS_LINE}, 0 here`);
});

test('no class running reads "No class is running now."', async () => {
  expect(await linesFor({ ...STAFF, classes: [], rounds: [] })).toEqual([NONE]);
});

test('a class with no room is read without one', async () => {
  expect((await linesFor({ ...STAFF, classes: [{ ...CLASS, room: ' ', count: 1 }] }))[0])
    .toBe(`Running now: Bag work, ${at(CLASS.start_at)} to ${at(CLASS.end_at)}, 1 here`);
});

test('a round clock not started, finished or ended is left out: QH has no words for it', async () => {
  const rounds = [
    { ...ROUND, phase: 'ready', round: 0 },
    { ...ROUND, tv_name: 'Back TV', phase: 'ended', round: 0 },
    { ...ROUND, tv_name: 'Side TV', phase: 'done', round: 5 },
  ];
  expect(await linesFor({ ...STAFF, rounds })).toEqual([`${CLASS_LINE}, 3 here`]);
});

test('a round being rested, or paused, is read out as the round it is in, as read', async () => {
  const rounds = [{ ...ROUND, phase: 'rest', round: 3 }, { ...ROUND, tv_name: 'Back TV', round: 1, is_paused: true }];
  expect(await linesFor({ ...STAFF, rounds })).toEqual([
    `${CLASS_LINE}, 3 here`,
    `Ring TV: round 3 of 5 (at ${at(READ_AT)})`,
    `Back TV: round 1 of 5 (at ${at(READ_AT)})`,
  ]);
});

test('no name, id, run, script or coach field reaches the page, whatever the server sends beside it', async () => {
  respond(200, {
    ...BOARD,
    classes: [{ ...CLASS, class_id: 'class-77', coach_account_id: 'coach-acct-9' }],
    rounds: [{ ...ROUND, run_id: 'run-55', script_name: 'Plan-X' }],
  });
  const { container } = render(<OnTheFloorClassesLine reader="board" />);
  await screen.findByText(CLASS_LINE);
  expect(container.innerHTML).not.toMatch(/class-77|coach-acct-9|run-55|Plan-X/);
});

test('while the read is in progress it says it is checking, never "No class" or a number', () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  render(<OnTheFloorClassesLine reader="board" />);
  expect(screen.getByText(CHECKING).parentElement?.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText(NONE)).toBeNull();
});

test.each([
  ['a server error', 500, { error: 'Internal server error' }],
  ['a refusal', 403, { error: 'Forbidden' }],
  ['an error status whose body still reads well', 503, BOARD],
  ['an empty body', 200, null],
  ['an answer not marked ok', 200, { ...BOARD, ok: false }],
  ['no read time', 200, { ...BOARD, read_at: undefined }],
  ['a read time that is not a time', 200, { ...BOARD, read_at: 'soon' }],
  ['no class list', 200, { ...BOARD, classes: undefined }],
  ['no round list', 200, { ...BOARD, rounds: { tv_name: 'Ring TV' } }],
  ['a class with no title', 200, { ...BOARD, classes: [{ ...CLASS, title: ' ' }] }],
  ['a class with no start', 200, { ...BOARD, classes: [{ ...CLASS, start_at: null }] }],
  ['a class whose room is not text', 200, { ...BOARD, classes: [{ ...CLASS, room: 4 }] }],
  ['a count that is not a whole number', 200, { ...STAFF, classes: [{ ...CLASS, count: '3' }] }],
  ['a negative count', 200, { ...STAFF, classes: [{ ...CLASS, count: -1 }] }],
  ['a round with no TV name', 200, { ...BOARD, rounds: [{ ...ROUND, tv_name: '' }] }],
  ['a round that is not a whole number', 200, { ...BOARD, rounds: [{ ...ROUND, round: 1.5 }] }],
  ['a round past its total', 200, { ...BOARD, rounds: [{ ...ROUND, round: 6 }] }],
  ['a round total that is not a whole number', 200, { ...BOARD, rounds: [{ ...ROUND, rounds_total: '5' }] }],
  ['a round total of 0', 200, { ...BOARD, rounds: [{ ...ROUND, round: 0, rounds_total: 0 }] }],
  ['a round in an unknown phase', 200, { ...BOARD, rounds: [{ ...ROUND, phase: 'warmup' }] }],
  ['a class with no end', 200, { ...BOARD, classes: [{ ...CLASS, end_at: 'later' }] }],
  ['a read time that is only a year', 200, { ...BOARD, read_at: '2026' }],
  ['a staff answer whose class has no count', 200, { ...STAFF, classes: [CLASS] }],
  ['a staff answer that carries a total', 200, { ...STAFF, total: { status: 'available', count: 7 } }, 'staff'],
  ['a board total under the floor marked available', 200, { ...BOARD, total: { status: 'available', count: 4 } }],
  ['a board total of 0 marked available', 200, { ...BOARD, total: { status: 'available', count: 0 } }],
  ['a suppressed total that carries a number', 200, { ...BOARD, total: { status: 'insufficient_data', count: 3 } }],
  ['a total with an unknown status', 200, { ...BOARD, total: { status: 'unavailable', count: 9 } }],
  ['a total that is not an object', 200, { ...BOARD, total: 9 }],
] as [string, number, unknown, ('board' | 'staff')?][])('%s says the line could not be checked, never a number or "No class"', async (_label, status, body, ...reader) => {
  // The reader is a rest argument: a fourth named parameter would read to jest as a `done` callback.
  expect(await linesFor(body, status, reader[0] ?? readerOf(body))).toEqual([FAILED]);
});

test.each([
  ['a network failure', () => { global.fetch = jest.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch; }],
  ['a body that is not JSON', () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('<'); } }) as unknown as Response) as unknown as typeof fetch;
  }],
])('%s says the line could not be checked', async (_label, arrange) => {
  arrange();
  render(<OnTheFloorClassesLine reader="board" />);
  expect(await screen.findByText(FAILED)).toBeTruthy();
});

test('it reads once when the page opens, and leaving the page cancels the read', async () => {
  jest.useFakeTimers();
  respond(200, BOARD);
  render(<OnTheFloorClassesLine reader="board" />);
  await act(async () => {
    jest.advanceTimersByTime(25 * 60 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);

  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const { unmount } = render(<OnTheFloorClassesLine reader="board" />);
  unmount();
  expect(signal?.aborted).toBe(true);
});

test('a neutral line at the floor size: no warning or hold colour', async () => {
  respond(200, BOARD);
  const { container } = render(<OnTheFloorClassesLine reader="board" />);
  const line = await screen.findByText(CLASS_LINE);
  expect(line.className).toBe('t-body');
  expect((line as HTMLElement).style.fontSize).toBe('var(--t-md)');
  expect(container.innerHTML).not.toMatch(/restricted|locked|warn|danger|alert|rust|blood/i);
});

describe('the board\'s mount renders for a board reader only (GO 7206014991)', () => {
  test('a board reader gets the line', async () => {
    respond(200, BOARD);
    render(<BoardOnTheFloorLine />);
    expect(await screen.findByText('On the floor now: 7')).toBeTruthy();
  });

  // The board's shape is checked on the page too, not only on the server (flags 3 and 4).
  test.each([
    ['a class carrying a count', { ...BOARD, classes: [{ ...CLASS, count: 1 }] }],
    ['no total', Object.fromEntries(Object.entries(BOARD).filter(([key]) => key !== 'total'))],
  ])('a board answer with %s says the line could not be checked, never a count per class', async (_label, body) => {
    respond(200, body);
    render(<BoardOnTheFloorLine />);
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(/here/)).toBeNull();
  });

  test.each([
    ['the platform owner', { role: 'platform_owner' as const, seats: [] }],
    ['no board session', null],
  ])('%s gets nothing, and nothing is read', (_label, session) => {
    mockSession.mockReturnValue(session);
    respond(200, BOARD);
    const { container } = render(<BoardOnTheFloorLine />);
    expect(container.innerHTML).toBe('');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
