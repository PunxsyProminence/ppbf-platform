/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-3: the coach and admin "on the floor now" line. Jason's words
// (FN0-Q2 A, OD-2026-11-25-002) and App Overwatch's loading line (QA A, #2192).
// It reads once when the page opens, keeps nothing on the device, and a failed
// or unfinished read never reads as "Nobody" (FN-0 F15). The words are asserted
// as literal text, not through the component's own constant, so a one-letter
// change to Jason's words fails here.

import { act, render, screen } from '@testing-library/react';

import OnTheFloorStaffLine, { ON_THE_FLOOR_WORDS } from './OnTheFloorStaffLine';

const CHECKING = 'Checking who is on the floor...';
const FAILED = 'Who is on the floor could not be checked.';
const NOBODY = 'Nobody is counted on the floor right now.';

const originalFetch = global.fetch;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  // Nothing from the line is kept on the device, on any path (FN-0 F10).
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  global.fetch = originalFetch;
  jest.useRealTimers();
});

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch;
}

const LINE = {
  ok: true,
  day: '2026-11-25',
  athletes: [
    { athlete_id: 'a-1', full_name: 'Ada Reyes' },
    { athlete_id: 'a-2', full_name: 'Ben Ortiz' },
  ],
};

test('the words are Jason\'s, exactly (OD-2026-11-25-002) and QA A\'s loading line', () => {
  expect(ON_THE_FLOOR_WORDS).toEqual({ checking: CHECKING, failed: FAILED, nobody: NOBODY, lead: 'On the floor now: ' });
});

test('names everyone counted, in the order the server gives, and nothing else about them', async () => {
  respond(200, LINE);
  const { container } = render(<OnTheFloorStaffLine />);
  expect(await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz')).toBeTruthy();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/on-the-floor'),
    expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
  );
  // No athlete id reaches the page: not in the text, a key, a title or a data attribute.
  expect(container.innerHTML).not.toContain('a-1');
  expect(container.innerHTML).not.toContain('a-2');
  expect(screen.getByText('On the floor now: Ada Reyes, Ben Ortiz').getAttribute('aria-busy')).toBe('false');
});

test('with nobody counted it says so, in Jason\'s words', async () => {
  respond(200, { ...LINE, athletes: [] });
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(NOBODY)).toBeTruthy();
});

test('while the read is in progress it says it is checking, never "Nobody"', () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  render(<OnTheFloorStaffLine />);
  expect(screen.getByText(CHECKING).getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText(NOBODY)).toBeNull();
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
});

test('leaving the page while the read is in progress cancels it', async () => {
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const { unmount } = render(<OnTheFloorStaffLine />);
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
});

test('it reads once when the page opens: no timer, focus, visibility or network change reads it again', async () => {
  jest.useFakeTimers();
  respond(200, LINE);
  render(<OnTheFloorStaffLine />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(60 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('one neutral line at the floor size: no warning, hold or medical colour (FN-0 F12)', async () => {
  respond(200, LINE);
  const { container } = render(<OnTheFloorStaffLine />);
  const line = await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz');
  expect((line as HTMLElement).style.fontSize).toBe('var(--t-md)');
  expect((line as HTMLElement).style.color).toBe('');
  expect(container.innerHTML).not.toMatch(/restricted|locked|warn|danger|alert|monitor/i);
  expect(screen.getByRole('region', { name: 'Who is on the floor' })).toBeTruthy();
});
