/**
 * @jest-environment jsdom
 */

import {
  isGymTabletMarked,
  markSessionBoundary,
  readGymTabletLastUse,
  readGymTabletSignedOutAt,
  setGymTabletMark,
  subscribeGymTabletMark,
  writeGymTabletLastUse,
  writeGymTabletSignedOutAt,
} from './gymTabletMark';
import { clearRoleSession } from '@/components/roleSession';
import { endThisSession } from './signOut';
import { DEFAULT_TABLET_IDLE_MINUTES, TABLET_IDLE_MINUTES, tabletIdleLabel } from '@/src/shared/tabletIdle';

beforeEach(() => window.localStorage.clear());

test('a fresh device is not marked; marking and unmarking are kept and announced', () => {
  const listener = jest.fn();
  const stop = subscribeGymTabletMark(listener);
  expect(isGymTabletMarked()).toBe(false);
  expect(setGymTabletMark(true)).toBe(true);
  expect(isGymTabletMarked()).toBe(true);
  expect(setGymTabletMark(false)).toBe(true);
  expect(isGymTabletMarked()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});

/* AS2-b review A: clearRoleSession runs on a mere cache clear too, which can
   happen while the session is alive, so it must not reset the idle clock. */
test('a role-cache clear keeps both the mark and the idle clock', () => {
  setGymTabletMark(true);
  writeGymTabletLastUse(1_700_000_000_000);
  clearRoleSession();
  expect(isGymTabletMarked()).toBe(true);
  expect(readGymTabletLastUse()).toBe(1_700_000_000_000);
});

test('marking or unmarking starts the idle clock again', () => {
  writeGymTabletLastUse(1_700_000_000_000);
  setGymTabletMark(true);
  expect(readGymTabletLastUse()).toBeNull();
  writeGymTabletLastUse(1_700_000_000_000);
  setGymTabletMark(false);
  expect(readGymTabletLastUse()).toBeNull();
});

test('a missing or broken clock reads as none', () => {
  expect(readGymTabletLastUse()).toBeNull();
  window.localStorage.setItem('ppbf.device.gymTabletLastUse', 'soon');
  expect(readGymTabletLastUse()).toBeNull();
});

test('a browser that refuses storage reads as not marked, and marking says it was not kept', () => {
  const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  expect(setGymTabletMark(true)).toBe(false);
  expect(isGymTabletMarked()).toBe(false);
  spy.mockRestore();
});

test.each([
  [{ ok: true, status: 200 }, true],
  [{ ok: false, status: 401 }, true],
  [{ ok: false, status: 500 }, false],
])('ending the session reads %p as done = %p', async (response, done) => {
  const fetcher = jest.fn(async () => response as Response);
  await expect(endThisSession(fetcher as unknown as typeof fetch)).resolves.toBe(done);
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/pilot/auth/logout'), expect.objectContaining({ method: 'POST', credentials: 'include' }));
});

test('a request that never lands is not done', async () => {
  const fetcher = jest.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  await expect(endThisSession(fetcher as unknown as typeof fetch)).resolves.toBe(false);
});

test('the shared list, default and words', () => {
  expect(TABLET_IDLE_MINUTES).toEqual([15, 30, 60, 120, 240]);
  expect(DEFAULT_TABLET_IDLE_MINUTES).toBe(60);
  expect(TABLET_IDLE_MINUTES.map(tabletIdleLabel)).toEqual(['15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours']);
});

/* AS2-b review A, round 4. */
test('a session boundary starts a fresh clock and marks every older page stale; the device mark stays', () => {
  setGymTabletMark(true);
  writeGymTabletLastUse(Date.now() - 1_000);
  const before = Date.now();
  markSessionBoundary();
  expect(readGymTabletLastUse()).toBeNull();
  expect(readGymTabletSignedOutAt()).toBeGreaterThanOrEqual(before);
  expect(isGymTabletMarked()).toBe(true);
});

test('a signed-out mark in the future (a clock set back) is dropped, not capped, so no page reloads forever', () => {
  writeGymTabletSignedOutAt(Date.now() + 60 * 60_000);
  expect(readGymTabletSignedOutAt()).toBeNull();
  expect(window.localStorage.getItem('ppbf.device.gymTabletSignedOutAt')).toBeNull();
});
