/**
 * @jest-environment jsdom
 */

import {
  isGymTabletMarked,
  readGymTabletLastUse,
  setGymTabletMark,
  subscribeGymTabletMark,
  writeGymTabletLastUse,
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

test("signing out keeps the mark (the device's) and clears the idle clock (the person's)", () => {
  setGymTabletMark(true);
  writeGymTabletLastUse(1_700_000_000_000);
  clearRoleSession();
  expect(isGymTabletMarked()).toBe(true);
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
