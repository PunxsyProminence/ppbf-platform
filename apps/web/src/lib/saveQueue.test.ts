/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';

import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { writeGymTabletSignedOutAt } from '@/src/lib/gymTabletMark';

import {
  ANSWER_WAIT_MS,
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
 *   - a save that fails on a flaky connection stays on the page, is sent again with the same request
 *     key, and lands once; one save at a time, in order; the queue never stops while saves wait;
 *   - a refusal is not resent, and a refused RESEND is checked with the server before any failed
 *     words, or reported as not known (condition 2);
 *   - nothing survives a sign-out or an account change, and nothing of one person is shown to the
 *     next; a save is never sent under an account that did not make it;
 *   - nothing is written to device storage; a save is not kept when the page does not know who is
 *     signed in.
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

/** Who the session route says is signed in; 'unreachable' throws; 'hang' never answers until released. */
let sessionAccount: string | null | 'unreachable' | 'hang' = 'acct-a';
/** Answers used one by one before sessionAccount, when set. */
let sessionAnswers: Array<string | null> = [];
let releaseSession: ((account: string | null) => void) | null = null;
let sessionCalls = 0;

function mockSessionRoute() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/api/pilot/auth/session')) throw new Error(`unexpected fetch ${url}`);
    sessionCalls += 1;
    if (sessionAnswers.length > 0) {
      const scripted = sessionAnswers.shift() as string | null;
      return answer(200, scripted === null ? { authenticated: false } : { authenticated: true, account_id: scripted });
    }
    if (sessionAccount === 'unreachable') throw new TypeError('Failed to fetch');
    const account = sessionAccount === 'hang'
      ? await new Promise<string | null>((resolve) => { releaseSession = resolve; })
      : sessionAccount;
    return answer(200, account === null ? { authenticated: false } : { authenticated: true, account_id: account });
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
  sessionAnswers = [];
  releaseSession = null;
  sessionCalls = 0;
  mockSessionRoute();
  window.localStorage.clear();
  window.sessionStorage.clear();
  createPersistentRoleSession('coach');
  prepareSaveQueue();
});

afterEach(() => {
  resetSaveQueueForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('a save that fails on a flaky connection is kept and resent until it lands', () => {
  test('a dropped connection, then a server error: it waits with its words, is resent every 15 seconds with the same request key, and lands once', async () => {
    const { save, contexts } = scriptedSave('Ada Reyes: here', ['throw', answer(503), answer(200, { outcome: 'marked' })]);

    await expect(keepSave(save)).resolves.toBe('kept');
    await settle();
    expect(save.send).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);

    await jest.advanceTimersByTimeAsync(RESEND_MS - 1);
    expect(save.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(save.send).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.send).toHaveBeenCalledTimes(3);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual([]);

    await jest.advanceTimersByTimeAsync(RESEND_MS * 4);
    expect(save.send).toHaveBeenCalledTimes(3);
    // The same save every time: one request key, the account that made it; the count since it was made grows.
    expect(new Set(contexts.map((context) => context.requestKey)).size).toBe(1);
    expect(contexts[0].requestKey).toEqual(expect.any(String));
    expect(contexts.map((context) => context.madeByAccountId)).toEqual(['acct-a', 'acct-a', 'acct-a']);
    expect(contexts.map((context) => context.first)).toEqual([true, false, false]);
    expect(contexts[2].msSinceMade).toBeGreaterThanOrEqual(2 * RESEND_MS);
  });

  test('two saves get two request keys', async () => {
    const one = scriptedSave('One', [answer(200)]);
    const two = scriptedSave('Two', [answer(200)]);
    await keepSave(one.save);
    await keepSave(two.save);
    await settle();
    expect(one.contexts[0].requestKey).not.toBe(two.contexts[0].requestKey);
  });

  test('the browser coming back online sends at once, without waiting for the 15 seconds', async () => {
    const { save } = scriptedSave('Pause', ['throw', answer(200)]);
    await keepSave(save);
    await settle();
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
  });

  test('a send that never answers counts as unknown after the wait, and the save is resent', async () => {
    let calls = 0;
    const save: KeptSave = {
      label: 'Hangs once',
      send: jest.fn(() => {
        calls += 1;
        return calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve(answer(200));
      }),
      onSaved: jest.fn(),
    };
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(readSaveQueue().waiting).toEqual(['Hangs once']);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.send).toHaveBeenCalledTimes(2);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
  });

  test.each([400, 403, 404, 405, 409, 410, 413, 415, 422])('a %i is a refusal: not resent', async (status) => {
    const { save } = scriptedSave('Refused', [answer(status), answer(200)]);
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS * 3);
    expect(save.send).toHaveBeenCalledTimes(1);
    expect(save.onRefused).toHaveBeenCalledWith(expect.anything(), false);
  });

  test.each([408, 429, 500, 502, 503])('a %i proves nothing: kept and resent', async (status) => {
    const { save } = scriptedSave('Unknown', [answer(status), answer(200)]);
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.send).toHaveBeenCalledTimes(2);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('msSinceMade counts on the wall clock when performance.now() stops (a sleeping tablet), and is capped at a day', async () => {
    jest.spyOn(performance, 'now').mockReturnValue(1_000);
    // Never answered, so it is resent through the whole day and past it.
    const { save, contexts } = scriptedSave('Ada Reyes: here', []);
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(contexts[1].msSinceMade).toBeGreaterThanOrEqual(RESEND_MS);

    // The tablet slept for 25 hours (the wall clock moved, no timer ran); then it is online again.
    jest.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(contexts[contexts.length - 1].msSinceMade).toBe(24 * 60 * 60 * 1000);
  });
});

describe('the queue never stops while saves wait', () => {
  test('a screen\'s answerOf that throws counts as unknown: the save is resent and the queue goes on', async () => {
    let calls = 0;
    const { save } = scriptedSave('Ada Reyes: here', [answer(502), answer(200)], {
      answerOf: (response) => {
        calls += 1;
        if (calls === 1) throw new SyntaxError('Unexpected token < in JSON');
        return response.ok ? 'saved' : 'unknown';
      },
    });
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.send).toHaveBeenCalledTimes(2);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('an onSaved that throws: the landed save leaves the waiting line and the next save is still sent', async () => {
    const first = scriptedSave('One', [answer(200)], { onSaved: jest.fn(() => { throw new Error('screen bug'); }) });
    const second = scriptedSave('Two', [answer(200)]);
    await keepSave(first.save);
    await keepSave(second.save);
    await settle();
    expect(second.save.onSaved).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual([]);
  });

  test('a checkLanded that throws reads as not known, and the queue goes on', async () => {
    const refused = scriptedSave('Remove note', ['throw', answer(404)], {
      checkLanded: jest.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    const after = scriptedSave('Next', [answer(200)]);
    await keepSave(refused.save);
    await settle();
    await keepSave(after.save);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(refused.save.onRefused).toHaveBeenCalledWith(expect.anything(), null);
    expect(after.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a drop while a send is on its way does not stall the next person\'s save', async () => {
    let release: (value: Response) => void = () => {};
    const aSave: KeptSave = {
      label: 'A: Ada Reyes here',
      send: jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
      onSaved: jest.fn(),
    };
    await keepSave(aSave);
    await settle();
    clearRoleSession();
    sessionAccount = 'acct-b';
    createPersistentRoleSession('coach');
    const bSave = scriptedSave('B: Ben Ortiz here', [answer(200)]);
    await expect(keepSave(bSave.save)).resolves.toBe('kept');
    release(answer(200));
    await settle();
    expect(aSave.onSaved).not.toHaveBeenCalled();
    expect(bSave.save.send).toHaveBeenCalledTimes(1);
    expect(bSave.contexts[0].madeByAccountId).toBe('acct-b');
    expect(bSave.save.onSaved).toHaveBeenCalledTimes(1);
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [{ label: 'Staff note on Ada Reyes', words: 'The server refused it.' }], notSent: 0 });

    dismissFailedSaves();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
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
    expect(readSaveQueue().failed).toEqual([]);
  });

  test('a refused RESEND: shown not landed -> false; could not be checked, or no check -> not known (null)', async () => {
    const notLanded = scriptedSave('A', ['throw', answer(404)], { checkLanded: jest.fn(async () => false) });
    const unknown = scriptedSave('B', ['throw', answer(404)], { checkLanded: jest.fn(async () => null) });
    const noCheck = scriptedSave('C', ['throw', answer(404)]);
    for (const kept of [notLanded, unknown, noCheck]) await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS * 3);
    expect(notLanded.save.onRefused).toHaveBeenCalledWith(expect.anything(), false);
    expect(unknown.save.onRefused).toHaveBeenCalledWith(expect.anything(), null);
    expect(noCheck.save.onRefused).toHaveBeenCalledWith(expect.anything(), null);
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

  async function failedSave(label: string) {
    const kept = scriptedSave(label, [answer(422)]);
    await keepSave(kept.save);
    await settle();
    expect(readSaveQueue().failed.map((item) => item.label)).toContain(label);
    return kept;
  }

  async function expectNothingSent(kept: ReturnType<typeof scriptedSave>, sendsBefore: number) {
    await jest.advanceTimersByTimeAsync(RESEND_MS * 4);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(kept.save.send).toHaveBeenCalledTimes(sendsBefore);
    expect(kept.save.onSaved).not.toHaveBeenCalled();
  }

  test('signing out in this page drops waiting and failed saves at once, words and all', async () => {
    await failedSave('Refused one');
    const kept = await waitingSave('Ada Reyes: here');

    clearRoleSession();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
    await expectNothingSent(kept, 1);
  });

  test('another person signed in without passing through "nobody": the last person\'s words leave the screen at once, and their saves are dropped', async () => {
    await failedSave('Staff note on Ada Reyes');
    const kept = await waitingSave('Ada Reyes: here');

    sessionAccount = 'acct-b';
    createPersistentRoleSession('coach');
    // Nothing of the last person is on screen while the page asks who is signed in.
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
    await expectNothingSent(kept, 1);

    // The next person's save is tied to them.
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('a sign-out or sign-in mark from another tab drops failed words too, not only waiting saves', async () => {
    await failedSave('Staff note on Ada Reyes');
    writeGymTabletSignedOutAt(Date.now());
    window.dispatchEvent(new StorageEvent('storage', { key: 'ppbf.device.gymTabletSignedOutAt' }));
    expect(readSaveQueue().failed).toEqual([]);
  });

  test('a mark written in this tab (no storage event) is seen before the next send and before the next save is tied', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    writeGymTabletSignedOutAt(Date.now());
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(readSaveQueue().waiting).toEqual([]);
    await expectNothingSent(kept, 1);

    await failedSave('Refused');
    jest.advanceTimersByTime(5);
    writeGymTabletSignedOutAt(Date.now());
    sessionAccount = 'acct-b';
    const next = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(next.save);
    await settle();
    expect(readSaveQueue().failed).toEqual([]);
    expect(next.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('a 401 drops everything: no refusal, no words', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(401)]);
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onRefused).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
    await expectNothingSent(kept, 2);
  });

  test('the server saying another account made the save drops everything, and shows no words', async () => {
    const kept = scriptedSave('Staff note on Ada Reyes', ['throw', answer(409, { code: 'SAVE_MADE_BY_ANOTHER_ACCOUNT' })]);
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onRefused).not.toHaveBeenCalled();
    expect(readSaveQueue().failed).toEqual([]);
    await expectNothingSent(kept, 2);
  });

  test.each([
    ['another account', 'acct-b'],
    ['nobody', null],
  ] as const)('the check before a resend finding %s signed in drops everything, and nothing is resent', async (_label, now) => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = now;
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(readSaveQueue().waiting).toEqual([]);
    await expectNothingSent(kept, 1);
  });

  test('a save that waited behind another has the account checked before its first send', async () => {
    const first = scriptedSave('One', ['throw', answer(200)]);
    await keepSave(first.save);
    await settle();
    const second = scriptedSave('Two', [answer(200)]);
    await keepSave(second.save);
    await settle();
    // The first save's resend is checked and lands; by the time the second goes, someone else is signed in.
    sessionAnswers = ['acct-a', 'acct-b'];
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(first.save.onSaved).toHaveBeenCalledTimes(1);
    expect(second.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual([]);
  });

  test('the page asking again after its role session is written, and finding nobody, drops everything', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = null;
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
    await expectNothingSent(kept, 1);
  });

  test('a drop during the account check before a send: nothing is sent', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'hang';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    clearRoleSession();
    releaseSession?.('acct-a');
    await settle();
    await expectNothingSent(kept, 1);
  });

  test('a drop during the landed check: no saved callback, no failed words', async () => {
    let releaseCheck: (value: boolean) => void = () => {};
    const kept = scriptedSave('End session', ['throw', answer(409)], {
      checkLanded: () => new Promise<boolean>((resolve) => { releaseCheck = resolve; }),
    });
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    clearRoleSession();
    releaseCheck(true);
    await settle();
    expect(kept.save.onSaved).not.toHaveBeenCalled();
    expect(kept.save.onRefused).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
  });

  test('a save handed over while the page is asking who is signed in, then a sign-out: not kept, nothing sent', async () => {
    resetSaveQueueForTests();
    sessionAccount = 'hang';
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    const result = keepSave(kept.save);
    await settle();
    clearRoleSession();
    releaseSession?.('acct-a');
    await expect(result).resolves.toBe('not_kept');
    await expectNothingSent(kept, 0);
  });

  test('an answer that arrives after the drop changes nothing', async () => {
    let release: (value: Response) => void = () => {};
    const answerOf = jest.fn(() => 'saved' as const);
    const save: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
      answerOf,
      onSaved: jest.fn(),
    };
    await keepSave(save);
    await settle();
    clearRoleSession();
    release(answer(200));
    await settle();
    expect(answerOf).not.toHaveBeenCalled();
    expect(save.onSaved).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
  });
});

describe('saves dropped while the same person is still signed in', () => {
  test('the count, with no names, is shown once the page confirms it is still them; another person never sees it', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(200)]);
    await keepSave(kept.save);
    await settle();
    // The role cache runs out (8 hours) while the coach is still signed in: the queue drops what it keeps.
    clearRoleSession();
    expect(readSaveQueue().notSent).toBe(0);
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 1 });
    dismissFailedSaves();
    expect(readSaveQueue().notSent).toBe(0);

    // Dropped again, and this time someone else is signed in when the page asks.
    const again = scriptedSave('Ada Reyes: here', ['throw']);
    await keepSave(again.save);
    await settle();
    clearRoleSession();
    sessionAccount = 'acct-b';
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
  });
});

describe('what the page holds', () => {
  test('nothing is written to localStorage, sessionStorage or a cookie while saves wait and fail', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem');
    const cookieBefore = document.cookie;
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(503), answer(422)]);

    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(readSaveQueue().failed).toHaveLength(1);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookieBefore);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test('the module names no device store at all (jsdom has no IndexedDB, so this is read from the source)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'saveQueue.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches', 'setItem']) {
      expect(source).not.toContain(store);
    }
  });

  test('a save is not kept, and nothing is sent, when the page does not know who is signed in', async () => {
    resetSaveQueueForTests();
    sessionAccount = 'unreachable';
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    await expect(keepSave(kept.save)).resolves.toBe('not_kept');
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(kept.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0 });
  });

  test('the account is learned once and reused for a first send made at once; a resend asks again', async () => {
    const first = scriptedSave('One', [answer(200)]);
    await keepSave(first.save);
    await settle();
    const callsAfterFirst = sessionCalls;

    const second = scriptedSave('Two', [answer(200)]);
    await keepSave(second.save);
    await settle();
    expect(sessionCalls).toBe(callsAfterFirst);

    const slow = scriptedSave('Three', ['throw', answer(200)]);
    await keepSave(slow.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(sessionCalls).toBe(callsAfterFirst + 1);
  });
});
