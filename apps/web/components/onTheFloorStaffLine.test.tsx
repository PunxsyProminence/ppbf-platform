/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-3, with FN-4b's classes and rounds above the names (QB; QG A:
// the count is the number of names). The coach and admin "on the floor now" line. Jason's words
// (FN0-Q2 A, OD-2026-11-25-002) and App Overwatch's loading line (QA A, #2192).
// It reads once when the page opens, keeps nothing on the device, and a failed
// or unfinished read never reads as "Nobody" (FN-0 F15). The words are asserted
// as literal text, not through the component's own constant, so a one-letter
// change to Jason's words fails here.

import { act, render, screen } from '@testing-library/react';

import OnTheFloorStaffLine, { ON_THE_FLOOR_WORDS } from './OnTheFloorStaffLine';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';

const CHECKING = 'Checking who is on the floor...';
const FAILED = 'Who is on the floor could not be checked.';
const NOBODY = 'Nobody is counted on the floor right now.';

const originalFetch = global.fetch;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  // Restore first, so a failed check below cannot leak a mock into the next test.
  global.fetch = originalFetch;
  jest.useRealTimers();
  // Nothing from the line is kept on the device, on any path (FN-0 F10).
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe('');
});

// The coach's and admin's classes read (FN-4a): classes without a count, and the rounds.
const READ_AT = '2026-11-25T23:12:00.000Z';
const CLASSES = {
  ok: true,
  read_at: READ_AT,
  classes: [{ title: 'Bag work', start_at: '2026-11-25T23:00:00.000Z', end_at: '2026-11-26T00:00:00.000Z', room: 'Ring 1' }],
  rounds: [{ tv_name: 'Ring TV', phase: 'work', round: 2, rounds_total: 5, is_paused: false }],
};
const at = (iso: string) => formatGymTimeOfDay(iso) as string;
const ABOVE_THE_NAMES = [
  `Running now: Bag work, ${at('2026-11-25T23:00:00.000Z')} to ${at('2026-11-26T00:00:00.000Z')}, Ring 1`,
  `Ring TV: round 2 of 5 (at ${at(READ_AT)})`,
];

const CLASSES_URL = '/api/pilot/on-the-floor/classes';
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

/** The names read answers `status`/`body`; the classes read answers `classes` (healthy by default). */
function respond(status: number, body: unknown, classes: [number, unknown] = [200, CLASSES]) {
  global.fetch = jest.fn(async (url: unknown) =>
    String(url).includes(CLASSES_URL) ? reply(classes[0], classes[1]) : reply(status, body)) as unknown as typeof fetch;
}

const lines = () => Array.from(screen.getByRole('region', { name: 'Who is on the floor' }).querySelectorAll('p'), (p) => p.textContent);
const reads = (route: 'names' | 'classes') => (global.fetch as jest.Mock).mock.calls
  .filter(([url]) => String(url).includes(CLASSES_URL) === (route === 'classes')).length;

const LINE = {
  ok: true,
  day: '2026-11-25',
  athletes: [
    { athlete_id: 'a-1', full_name: 'Ada Reyes' },
    { athlete_id: 'a-2', full_name: 'Ben Ortiz' },
  ],
};

test('the words are Jason\'s, exactly (OD-2026-11-25-002) and QA A\'s loading line', () => {
  expect(ON_THE_FLOOR_WORDS).toEqual({ checking: CHECKING, failed: FAILED, nobody: NOBODY, lead: 'On the floor now: ', count: ' on the floor now' });
});

test('the classes and rounds, then how many (the number of names, QG A), then everyone counted, in the server\'s order', async () => {
  respond(200, LINE);
  const { container } = render(<OnTheFloorStaffLine />);
  expect(await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz')).toBeTruthy();
  expect(lines()).toEqual([...ABOVE_THE_NAMES, '2 on the floor now', 'On the floor now: Ada Reyes, Ben Ortiz']);
  expect(reads('names')).toBe(1);
  expect(reads('classes')).toBe(1);
  for (const route of ['/api/pilot/on-the-floor', CLASSES_URL]) {
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${route}$`)),
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  }
  // No athlete id reaches the page: not in the text, a key, a title or a data attribute.
  expect(container.innerHTML).not.toContain('a-1');
  expect(container.innerHTML).not.toContain('a-2');
  expect(screen.getByText('On the floor now: Ada Reyes, Ben Ortiz').parentElement?.getAttribute('aria-busy')).toBe('false');
});

test('with nobody counted it says so, in Jason\'s words, under the classes, and shows no count', async () => {
  respond(200, { ...LINE, athletes: [] });
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(NOBODY)).toBeTruthy();
  expect(lines()).toEqual([...ABOVE_THE_NAMES, NOBODY]);
});

test('with no class running and no round, the names still read under "No class is running now."', async () => {
  respond(200, LINE, [200, { ...CLASSES, classes: [], rounds: [] }]);
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz')).toBeTruthy();
  expect(lines()).toEqual(['No class is running now.', '2 on the floor now', 'On the floor now: Ada Reyes, Ben Ortiz']);
});

test('while the read is in progress it says it is checking, never "Nobody"', () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  render(<OnTheFloorStaffLine />);
  expect(screen.getByText(CHECKING).parentElement?.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText(NOBODY)).toBeNull();
});

test.each([
  ['the names are in but the classes are not', 'classes'],
  ['the classes are in but the names are not', 'names'],
])('while %s, the whole line is still checking: no half-read line', async (_label, pending) => {
  global.fetch = jest.fn(async (url: unknown) => {
    const isClasses = String(url).includes(CLASSES_URL);
    if ((pending === 'classes') === isClasses) return new Promise(() => {});
    return isClasses ? reply(200, CLASSES) : reply(200, LINE);
  }) as unknown as typeof fetch;
  render(<OnTheFloorStaffLine />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(lines()).toEqual([CHECKING]);
});

test.each([
  ['a server error', [500, { error: 'Internal server error' }]],
  ['a refusal', [403, { error: 'Forbidden' }]],
  ['an answer with no class list', [200, { ...CLASSES, classes: undefined }]],
  ['a malformed round', [200, { ...CLASSES, rounds: [{ tv_name: '', round: 1, rounds_total: 3 }] }]],
] as [string, [number, unknown]][])('a classes read that fails (%s) fails the whole line: no names, no count', async (_label, classes) => {
  respond(200, LINE, classes);
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(FAILED)).toBeTruthy();
  expect(lines()).toEqual([FAILED]);
});

test.each([
  ['a server error', () => respond(500, { error: 'Internal server error' })],
  ['a refusal', () => respond(403, { error: 'Forbidden' })],
  ['no session', () => respond(401, { error: 'Unauthorized' })],
  ['an error status whose body still says ok with an empty list', () => respond(500, { ok: true, day: '2026-11-25', athletes: [] })],
  ['an error status whose body still carries names', () => respond(503, LINE)],
  ['a network failure', () => { global.fetch = jest.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch; }],
  ['a body that is not JSON', () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response) as unknown as typeof fetch;
  }],
  ['an empty body', () => respond(200, null)],
  ['an answer with no list', () => respond(200, { ok: true, day: '2026-11-25' })],
  ['a list that is not a list', () => respond(200, { ...LINE, athletes: { athlete_id: 'a-1', full_name: 'Ada Reyes' } })],
  ['an answer not marked ok', () => respond(200, { ...LINE, ok: false })],
  ['an entry with no name', () => respond(200, { ...LINE, athletes: [{ athlete_id: 'a-1' }] })],
  ['an entry whose name is not text', () => respond(200, { ...LINE, athletes: [{ athlete_id: 'a-1', full_name: 42 }] })],
  ['an entry with a blank name', () => respond(200, { ...LINE, athletes: [{ athlete_id: 'a-1', full_name: '  ' }] })],
  ['an entry with no id', () => respond(200, { ...LINE, athletes: [{ full_name: 'Ada Reyes' }] })],
])('%s says the line could not be checked, never "Nobody" and never a name', async (_label, arrange) => {
  arrange();
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(FAILED)).toBeTruthy();
  expect(screen.queryByText(NOBODY)).toBeNull();
  expect(screen.queryByText(/Ada Reyes|Ben Ortiz/)).toBeNull();
  expect(lines()).toEqual([FAILED]);
});

test('leaving the page while the reads are in progress cancels both', async () => {
  const signals: AbortSignal[] = [];
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const { unmount } = render(<OnTheFloorStaffLine />);
  expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
  unmount();
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
});

test('it reads once when the page opens: no timer, focus, visibility, page-show or network change reads it again', async () => {
  jest.useFakeTimers();
  respond(200, LINE);
  render(<OnTheFloorStaffLine />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(25 * 60 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    // Bubbles from the document to the window, as a browser's does.
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  expect(reads('names')).toBe(1);
  expect(reads('classes')).toBe(1);
});

test('one neutral line at the floor size: no warning, hold or medical colour (FN-0 F12)', async () => {
  respond(200, LINE);
  const { container } = render(<OnTheFloorStaffLine />);
  const line = await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz');
  expect((line as HTMLElement).style.fontSize).toBe('var(--t-md)');
  expect((line as HTMLElement).style.color).toBe('');
  // Exactly the page's neutral classes: any colour class, by whatever name, fails here.
  expect(line.className).toBe('t-body');
  const region = screen.getByRole('region', { name: 'Who is on the floor' });
  expect(region.className).toBe('mat-leather rounded-[var(--r-lg)] p-[var(--s4)]');
  expect(container.innerHTML).not.toMatch(/restricted|locked|warn|danger|alert|monitor|red-highlight|rust|blood/i);
});
