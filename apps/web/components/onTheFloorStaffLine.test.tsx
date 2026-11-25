/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-3: the coach and admin "on the floor now" line. Jason's words
// (FN0-Q2 A) and App Overwatch's loading line (QA A, #2192). It reads once when
// the page opens, keeps nothing on the device, and a failed or unfinished read
// never reads as "Nobody" (FN-0 F15).

import { act, render, screen } from '@testing-library/react';

import OnTheFloorStaffLine, { ON_THE_FLOOR_WORDS } from './OnTheFloorStaffLine';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response) as unknown as typeof fetch;
}

const LINE = {
  ok: true,
  day: '2026-11-25',
  athletes: [
    { athlete_id: 'a-1', full_name: 'Ada Reyes' },
    { athlete_id: 'a-2', full_name: 'Ben Ortiz' },
  ],
};

test('names everyone counted, in the order the server gives, in Jason\'s words', async () => {
  respond(200, LINE);
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText('On the floor now: Ada Reyes, Ben Ortiz')).toBeTruthy();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/on-the-floor'),
    expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
  );
});

test('with nobody counted it says so, in Jason\'s words', async () => {
  respond(200, { ...LINE, athletes: [] });
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(ON_THE_FLOOR_WORDS.nobody)).toBeTruthy();
});

test('while the read is in progress it says it is checking, never "Nobody"', () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  render(<OnTheFloorStaffLine />);
  expect(screen.getByText(ON_THE_FLOOR_WORDS.checking)).toBeTruthy();
  expect(screen.queryByText(ON_THE_FLOOR_WORDS.nobody)).toBeNull();
});

test.each([
  ['a server error', () => respond(500, { error: 'Internal server error' })],
  ['a refusal', () => respond(403, { error: 'Forbidden' })],
  ['a network failure', () => { global.fetch = jest.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch; }],
  ['an answer with no list', () => respond(200, { ok: true, day: '2026-11-25' })],
  ['an answer not marked ok', () => respond(200, { ...LINE, ok: false })],
  ['a list with a malformed entry', () => respond(200, { ...LINE, athletes: [{ athlete_id: 'a-1' }] })],
])('%s says the line could not be checked, never "Nobody"', async (_label, arrange) => {
  arrange();
  render(<OnTheFloorStaffLine />);
  expect(await screen.findByText(ON_THE_FLOOR_WORDS.failed)).toBeTruthy();
  expect(screen.queryByText(ON_THE_FLOOR_WORDS.nobody)).toBeNull();
});

test('it reads once when the page opens: nothing polls, and nothing is kept on the device', async () => {
  jest.useFakeTimers();
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  respond(200, LINE);
  render(<OnTheFloorStaffLine />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(60 * 60 * 1000);
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(setItem).not.toHaveBeenCalled();
  setItem.mockRestore();
});
