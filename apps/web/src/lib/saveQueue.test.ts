/**
 * @jest-environment jsdom
 */

import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { writeGymTabletSignedOutAt } from '@/src/lib/gymTabletMark';

import {
  RESEND_MS,
  dismissFailedSaves,
  keepSave,
  prepareSaveQueue,
  readSaveQueue,
  resetSaveQueueForTests,
  type KeptSave,
  type SendContext,
} from './saveQueue';

/*
 * The kept-save queue (W4 item 7; OW27-34 A, OW27-35 A; App Overwatch's GO and conditions on #2158,
 * answers on #2165). What this file proves:
 *   - a save that fails on a flaky connection stays on the page, is sent again, and lands once;
 *   - one save at a time, in order;
 *   - a refusal is not resent, and a refused RESEND is checked with the server before any failed
 *     words (condition 2);
 *   - nothing survives a sign-out or an account change: role session cleared, another tab's
 *     sign-out mark, a 401, the server saying another account made it, or a check before a resend
 *     answering with someone else or nobody;
 *   - nothing is written to device storage;
 *   - a save is not kept when the page does not know who is signed in.
 */

type FakeResponse = { ok: boolean; status: number; body: unknown };

function answer(status: number, body: unknown = {}): Response {
  const fake: FakeResponse = { ok: status >= 200 && status < 300, status, body };
  const response = {
    ...fake,
    json: async () => fake.body,
    clone: () => response,
  };
  return response as unknown as Response;
}

let sessionAccount: string | null | 'unreachable' = 'acct-a';
const sessionCalls: number[] = [];

function mockSessionRoute() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/api/pilot/auth/session')) throw new Error(`unexpected fetch ${url}`);
    sessionCalls.push(Date.now());
    if (sessionAccount === 'unreachable') throw new TypeError('Failed to fetch');
    return answer(200, sessionAccount === null ? { authenticated: false } : { authenticated: true, account_id: sessionAccount });
  }) as unknown as typeof fetch;
}

/** A save whose sends answer, in turn, with the given answers ('throw' for a dropped connection). */
function scriptedSave(label: string, answers: Array<Response | 'throw'>, extra: Partial<KeptSave> = {}) {
  const contexts: SendContext[] = [];
  const save: KeptSave = {
    label,
    send: jest.fn(async (context: SendContext) => {
      contexts.push(context);
      const next = answers.shift() ?? 'throw';
      if (next === 'throw') throw new TypeError('Failed to fetch');
      return next;
    }),
    onSaved: jest.fn(),
    onRefused: jest.fn(() => 'The server refused it.'),
    ...extra,
  };
  return { save, contexts };
}

/** Lets every pending promise settle, without moving the clock. */
async function settle() {
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers();
  resetSaveQueueForTests();
  sessionAccount = 'acct-a';
  sessionCalls.length = 0;
  mockSessionRoute();
  window.localStorage.clear();
  window.sessionStorage.clear();
  createPersistentRoleSession('coach');
  prepareSaveQueue();
});

afterEach(() => {
  resetSaveQueueForTests();
  jest.useRealTimers();
});

describe('a save that fails on a flaky connection is kept on the page and resent until it lands', () => {
  test('a dropped connection, then a server error: it waits with its words, is resent every 15 seconds, and lands once', async () => {
    const { save, contexts } = scriptedSave('Ada Reyes: here', ['throw', answer(503), answer(200, { outcome: 'marked' })]);

    await expect(keepSave(save)).resolves.toBe('kept');
    await settle();
    expect(save.send).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);

    await jest.advanceTimersByTimeAsync(RESEND_MS - 1);
    expect(save.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(save.send).toHaveBeenCalledTimes(2);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);

    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.send).toHaveBeenCalledTimes(3);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual([]);

    // Nothing more is sent once it landed.
    await jest.advanceTimersByTimeAsync(RESEND_MS * 4);
    expect(save.send).toHaveBeenCalledTimes(3);
    // Every send names the account that made it; the count since it was made grows.
    expect(contexts.map((context) => context.madeByAccountId)).toEqual(['acct-a', 'acct-a', 'acct-a']);
    expect(contexts.map((context) => context.first)).toEqual([true, false, false]);
    expect(contexts[2].msSinceMade).toBeGreaterThanOrEqual(2 * RESEND_MS);
  });

  test('the browser coming back online sends at once, without waiting for the 15 seconds', async () => {
    const { save } = scriptedSave('Pause', ['throw', answer(200)]);
    await keepSave(save);
    await settle();
    expect(save.send).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    await settle();
    expect(save.send).toHaveBeenCalledTimes(2);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('one at a time, in order: a newer save waits behind an older one still waiting', async () => {
    const older = scriptedSave('Ada Reyes: here', ['throw', answer(200)]);
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    const order: string[] = [];
    (older.save.onSaved as jest.Mock).mockImplementation(() => order.push('older'));
    (newer.save.onSaved as jest.Mock).mockImplementation(() => order.push('newer'));

    await keepSave(older.save);
    await settle();
    await keepSave(newer.save);
    await settle();
    expect(newer.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here', 'Ada Reyes: not here']);

    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(order).toEqual(['older', 'newer']);
    expect(readSaveQueue().waiting).toEqual([]);
  });
});

describe('refusals', () => {
  test('a refusal of the first send is not resent and shows the screen\'s words; nothing is asked of the server', async () => {
    const checkLanded = jest.fn(async () => true);
    const { save } = scriptedSave('Staff note on Ada Reyes', [answer(409, { code: 'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT' })], { checkLanded });

    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS * 3);
    expect(save.send).toHaveBeenCalledTimes(1);
    expect(checkLanded).not.toHaveBeenCalled();
    expect(save.onRefused).toHaveBeenCalledWith(expect.anything(), false);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [{ label: 'Staff note on Ada Reyes', words: 'The server refused it.' }] });

    dismissFailedSaves();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [] });
  });

  test('a refused RESEND that the server shows had landed reads as saved, never as failed (condition 2)', async () => {
    const checkLanded = jest.fn(async () => true);
    const { save } = scriptedSave('End session', ['throw', answer(409, { error: 'SESSION_RUN_NOT_LIVE' })], { checkLanded });

    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(checkLanded).toHaveBeenCalledTimes(1);
    expect(save.onSaved).toHaveBeenCalledWith(null);
    expect(save.onRefused).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [] });
  });

  test('a refused RESEND the server shows had not landed, or could not be checked, gets the screen\'s words', async () => {
    const notLanded = scriptedSave('Remove note', ['throw', answer(404)], { checkLanded: jest.fn(async () => false) });
    const unknown = scriptedSave('Remove other note', ['throw', answer(404)], { checkLanded: jest.fn(async () => null) });

    await keepSave(notLanded.save);
    await keepSave(unknown.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(notLanded.save.onRefused).toHaveBeenCalledWith(expect.anything(), false);
    expect(unknown.save.onRefused).toHaveBeenCalledWith(expect.anything(), null);
    expect(readSaveQueue().failed.map((item) => item.label)).toEqual(['Remove note', 'Remove other note']);
  });
});

describe('nothing survives a sign-out or an account change', () => {
  async function waitingSave(label: string) {
    const kept = scriptedSave(label, ['throw', answer(200), answer(200)]);
    await keepSave(kept.save);
    await settle();
    expect(readSaveQueue().waiting).toEqual([label]);
    return kept;
  }

  async function expectDropped(kept: ReturnType<typeof scriptedSave>, sendsBefore: number) {
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [] });
    await jest.advanceTimersByTimeAsync(RESEND_MS * 4);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(kept.save.send).toHaveBeenCalledTimes(sendsBefore);
    expect(kept.save.onSaved).not.toHaveBeenCalled();
  }

  test('signing out in this page (the role session cleared) drops waiting and failed saves at once, words and all', async () => {
    const failedSave = scriptedSave('Refused one', [answer(422)]);
    await keepSave(failedSave.save);
    await settle();
    const kept = await waitingSave('Ada Reyes: here');
    expect(readSaveQueue().failed).toHaveLength(1);

    clearRoleSession();
    await expectDropped(kept, 1);
  });

  test('a sign-out or sign-in on this device in another tab (the boundary mark) drops what this page keeps', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    writeGymTabletSignedOutAt(Date.now());
    window.dispatchEvent(new StorageEvent('storage', { key: 'ppbf.device.gymTabletSignedOutAt' }));
    await expectDropped(kept, 1);
  });

  test('a 401 on a resend drops everything', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(401)]);
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    await expectDropped(kept, 2);
  });

  test('the server saying another account made the save drops everything, and shows no words', async () => {
    const kept = scriptedSave('Staff note on Ada Reyes', ['throw', answer(409, { code: 'SAVE_MADE_BY_ANOTHER_ACCOUNT' })]);
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onRefused).not.toHaveBeenCalled();
    await expectDropped(kept, 2);
  });

  test.each([
    ['another account', 'acct-b'],
    ['nobody', null],
  ] as const)('the check before a resend finding %s signed in drops everything, and nothing is resent', async (_label, now) => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = now;
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    await expectDropped(kept, 1);
  });

  test('when the check before a resend cannot reach the server, nothing is sent and the save keeps waiting', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'unreachable';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.send).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);

    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.send).toHaveBeenCalledTimes(2);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('an answer that arrives after the drop changes nothing', async () => {
    let release: (value: Response) => void = () => {};
    const save: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
      onSaved: jest.fn(),
      onRefused: jest.fn(() => 'refused'),
    };
    await keepSave(save);
    await settle();
    clearRoleSession();
    release(answer(200));
    await settle();
    expect(save.onSaved).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [] });
  });
});

describe('what the page holds', () => {
  test('nothing is written to localStorage, sessionStorage, IndexedDB or a cookie', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const cookieBefore = document.cookie;
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(503), answer(422)]);

    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(readSaveQueue().failed).toHaveLength(1);

    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookieBefore);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect((window as unknown as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    setItem.mockRestore();
  });

  test('a save is not kept, and nothing is sent, when the page does not know who is signed in', async () => {
    resetSaveQueueForTests();
    sessionAccount = 'unreachable';
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);

    await expect(keepSave(kept.save)).resolves.toBe('not_kept');
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(kept.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [] });
  });

  test('the account is learned once and reused for a first send made at once; a save that waited is checked again', async () => {
    const first = scriptedSave('One', [answer(200)]);
    await keepSave(first.save);
    await settle();
    const callsAfterFirst = sessionCalls.length;

    const second = scriptedSave('Two', [answer(200)]);
    await keepSave(second.save);
    await settle();
    expect(sessionCalls.length).toBe(callsAfterFirst);

    const slow = scriptedSave('Three', ['throw', answer(200)]);
    await keepSave(slow.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(sessionCalls.length).toBe(callsAfterFirst + 1);
  });
});
