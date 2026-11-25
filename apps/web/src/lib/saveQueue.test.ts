/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';

import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { writeGymTabletSignedOutAt } from '@/src/lib/gymTabletMark';

import {
  ANSWER_WAIT_MS,
  KEEP_WAIT_MS,
  RESEND_MS,
  dismissFailedSaves,
  keepSave,
  prepareSaveQueue,
  readSaveQueue,
  resetSaveQueueForTests,
  saveQueueAccountConfirmed,
  type KeptSave,
  type SaveAnswer,
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
/** The abort signal each ask of the session route was given. */
let sessionSignals: Array<AbortSignal | null | undefined> = [];

function mockSessionRoute() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/api/pilot/auth/session')) throw new Error(`unexpected fetch ${url}`);
    sessionCalls += 1;
    sessionSignals.push(init?.signal);
    if (sessionAnswers.length > 0) {
      const scripted = sessionAnswers.shift() as string | null;
      return answer(200, scripted === null ? { authenticated: false } : { authenticated: true, account_id: scripted });
    }
    if (sessionAccount === 'unreachable') throw new TypeError('Failed to fetch');
    // A hanging ask ends when its signal is aborted, as fetch does.
    const account = sessionAccount === 'hang'
      ? await new Promise<string | null>((resolve, reject) => {
        releaseSession = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
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
  sessionSignals = [];
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

  test('a send that never answers is aborted after the wait, counts as unknown, and the save is resent', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const save: KeptSave = {
      label: 'Hangs once',
      send: jest.fn((context: SendContext) => {
        calls += 1;
        signals.push(context.signal);
        // The first send hangs until aborted, as fetch does with the signal.
        return calls === 1
          ? new Promise<Response>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
          : Promise.resolve(answer(200));
      }),
      onSaved: jest.fn(),
    };
    await keepSave(save);
    await settle();
    expect(signals[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    // Given up on, and aborted: it cannot reach the server after a newer save.
    expect(signals[0].aborted).toBe(true);
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
  test('a send that ignores the signal holds the queue until it settles: a newer save never overtakes it', async () => {
    let release: (value: Response) => void = () => {};
    const sent: string[] = [];
    let olderCalls = 0;
    const older: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(() => {
        olderCalls += 1;
        sent.push(`here ${olderCalls}`);
        return olderCalls === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : Promise.resolve(answer(200));
      }),
      onSaved: jest.fn(),
    };
    const newer: KeptSave = {
      label: 'Ada Reyes: not here',
      send: jest.fn(async () => {
        sent.push('not here');
        return answer(200);
      }),
      onSaved: jest.fn(),
    };
    await keepSave(older);
    await settle();
    await keepSave(newer);
    await settle();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS + RESEND_MS * 4);
    expect(sent).toEqual(['here 1']);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here', 'Ada Reyes: not here']);
    // It settles late: counted as unknown and resent (the same save), and only then the newer one.
    release(answer(200));
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(sent).toEqual(['here 1', 'here 2', 'not here']);
    expect(newer.onSaved).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['before', 0],
    ['after', ANSWER_WAIT_MS],
  ])('a send that ignores the signal and never settles does not hold the next person\'s saves after a sign-out %s the wait', async (_when, elapsed) => {
    const signals: AbortSignal[] = [];
    const stuck: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn((context: SendContext) => {
        signals.push(context.signal);
        return new Promise<Response>(() => {});
      }),
      onSaved: jest.fn(),
    };
    await keepSave(stuck);
    await settle();
    await jest.advanceTimersByTimeAsync(elapsed);
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.save.onSaved).toHaveBeenCalledTimes(1);
    expect(stuck.send).toHaveBeenCalledTimes(1);
    // A drop before the give-up leaves the request to finish (it went under the last person's own
    // session); after the give-up it was already aborted.
    expect(signals[0].aborted).toBe(elapsed === ANSWER_WAIT_MS);
  });

  test('the same coach confirmed again after a drop (the role cache ran out): their next save waits for their own earlier request still on its way', async () => {
    const order: string[] = [];
    let release: (value: Response) => void = () => {};
    const older: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(() => new Promise<Response>((resolve) => {
        release = (value) => {
          order.push('here (old)');
          resolve(value);
        };
      })),
      onSaved: jest.fn(),
    };
    await keepSave(older);
    await settle();
    // No mark: the role cache ran out and the page restores the same coach.
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    (newer.save.send as jest.Mock).mockImplementationOnce(async () => {
      order.push('not here');
      return answer(200);
    });
    await keepSave(newer.save);
    await settle();
    expect(order).toEqual([]);
    release(answer(200));
    await settle();
    expect(order).toEqual(['here (old)', 'not here']);
    expect(newer.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('that wait ends at the earlier request\'s own give-up, which aborts it; another person\'s saves never wait for it', async () => {
    const signals: AbortSignal[] = [];
    const older: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn((context: SendContext) => {
        signals.push(context.signal);
        return new Promise<Response>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
      onSaved: jest.fn(),
    };
    await keepSave(older);
    await settle();
    await jest.advanceTimersByTimeAsync(10_000);
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    await keepSave(newer.save);
    await settle();
    expect(newer.save.send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 10_000);
    expect(signals[0].aborted).toBe(true);
    expect(newer.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a sign-out while the same coach\'s save waits for their earlier request: the next person\'s save goes at once, and the waiting save is never sent', async () => {
    const older: KeptSave = { label: 'Ada Reyes: here', send: jest.fn(() => new Promise<Response>(() => {})), onSaved: jest.fn() };
    await keepSave(older);
    await settle();
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    await keepSave(newer.save);
    await settle();
    expect(newer.save.send).not.toHaveBeenCalled();
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.save.onSaved).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(newer.save.send).not.toHaveBeenCalled();
  });

  test('after waiting for an earlier request, the account is checked again before the send', async () => {
    let release: (value: Response) => void = () => {};
    const older: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
      onSaved: jest.fn(),
    };
    await keepSave(older);
    await settle();
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    await keepSave(newer.save);
    await settle();
    // Meanwhile, someone else signed in (no mark): the check after the wait finds them.
    sessionAccount = 'acct-b';
    release(answer(200));
    await settle();
    expect(newer.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual([]);
  });

  test('the wait for an earlier request is not stretched when the device clock is set back', async () => {
    const older: KeptSave = { label: 'Ada Reyes: here', send: jest.fn(() => new Promise<Response>(() => {})), onSaved: jest.fn() };
    await keepSave(older);
    await settle();
    // Set back while the request is on its way, before the drop measures the time it has left.
    jest.setSystemTime(Date.now() - 60 * 60 * 1000);
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const newer = scriptedSave('Ada Reyes: not here', [answer(200)]);
    await keepSave(newer.save);
    await settle();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(newer.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a send that throws at once counts as unknown and is resent, leaving no stray timer', async () => {
    let calls = 0;
    const save: KeptSave = {
      label: 'Throws at once',
      send: jest.fn(() => {
        calls += 1;
        if (calls === 1) throw new TypeError('bad request object');
        return Promise.resolve(answer(200));
      }),
      onSaved: jest.fn(),
    };
    await keepSave(save);
    await settle();
    expect(readSaveQueue().waiting).toEqual(['Throws at once']);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an answer whose body stalls is aborted with its send after the wait, and the save is resent', async () => {
    let calls = 0;
    const save: KeptSave = {
      label: 'Body stalls',
      send: jest.fn(async (context: SendContext) => {
        calls += 1;
        if (calls > 1) return answer(200);
        const stalled = {
          ok: false,
          status: 409,
          json: () => new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
          clone: () => stalled,
        };
        return stalled as unknown as Response;
      }),
      onSaved: jest.fn(),
      onRefused: jest.fn(() => 'The server refused it.'),
    };
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(save.onRefused).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual(['Body stalls']);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a drop while a landed check hangs: the check is released and aborted, and the next person\'s save goes at once', async () => {
    const checkSignals: AbortSignal[] = [];
    const kept = scriptedSave('End session', ['throw', answer(409)], {
      checkLanded: (signal: AbortSignal) => {
        checkSignals.push(signal);
        return new Promise<boolean>(() => {});
      },
    });
    await keepSave(kept.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(checkSignals).toHaveLength(1);
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    expect(checkSignals[0].aborted).toBe(true);
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.save.onSaved).toHaveBeenCalledTimes(1);
    expect(kept.save.onRefused).not.toHaveBeenCalled();
  });

  test('a landed check that never answers reads as not known after the wait, and the next save goes', async () => {
    const kept = scriptedSave('End session', ['throw', answer(409)], { checkLanded: () => new Promise<boolean>(() => {}) });
    const next = scriptedSave('Next', [answer(200)]);
    await keepSave(kept.save);
    await settle();
    await keepSave(next.save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onRefused).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(kept.save.onRefused).toHaveBeenCalledWith(expect.anything(), null);
    expect(next.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('an answerOf or onSaved that never returns holds the queue at most the wait', async () => {
    let calls = 0;
    const slow: KeptSave = {
      label: 'Slow answerOf',
      send: jest.fn(async () => answer(200)),
      answerOf: jest.fn(() => {
        calls += 1;
        return calls === 1 ? new Promise<SaveAnswer>(() => {}) : 'saved';
      }),
      onSaved: jest.fn(() => new Promise<void>(() => {})) as unknown as KeptSave['onSaved'],
    };
    const next = scriptedSave('Next', [answer(200)]);
    await keepSave(slow);
    await settle();
    await keepSave(next.save);
    await settle();
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(readSaveQueue().waiting).toEqual(['Slow answerOf', 'Next']);
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(slow.send).toHaveBeenCalledTimes(2);
    expect(slow.onSaved).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(next.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('an answer whose body a screen already read: no code to read, and a 2xx still lands once', async () => {
    const used = {
      ok: true,
      status: 200,
      json: async () => { throw new TypeError('Body has already been used'); },
      clone: () => { throw new TypeError('Body has already been used'); },
    } as unknown as Response;
    const kept = scriptedSave('Ada Reyes: here', [used]);
    await keepSave(kept.save);
    await settle();
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(kept.save.send).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().waiting).toEqual([]);
  });

  test('an account check that never answers is given up after the wait, aborted, and asked again later', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(200)]);
    await keepSave(kept.save);
    await settle();
    sessionAccount = 'hang';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(sessionSignals.at(-1)?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(sessionSignals.at(-1)?.aborted).toBe(true);
    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a sign-out while a screen\'s answerOf is still working: the next person\'s save is not taken for it', async () => {
    let decide: (value: SaveAnswer) => void = () => {};
    const save: KeptSave = {
      label: 'Ada Reyes: here',
      send: jest.fn(async () => answer(200)),
      answerOf: () => new Promise<SaveAnswer>((resolve) => { decide = resolve; }),
      onSaved: jest.fn(),
    };
    await keepSave(save);
    await settle();
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    // The next person's save goes at once: the dropped save's answer left no resend timer behind.
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.save.onSaved).toHaveBeenCalledTimes(1);
    decide('saved');
    await settle();
    expect(save.onSaved).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual([]);
  });

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

// #2182 round 12: a save that went through may still leave the coach something to check, when the
// screen that made it has gone; its words are listed as saved, never as not saved (reviewer B, round 13).
describe('words from a save that went through', () => {
  test('words onSaved returns are listed as saved, apart from refusals', async () => {
    const { save } = scriptedSave('Mark an athlete here', [answer(200)], { onSaved: jest.fn(() => 'saved, but check the register.') });
    await keepSave(save);
    await settle();
    expect(readSaveQueue()).toEqual({
      waiting: [],
      failed: [{ label: 'Mark an athlete here', words: 'saved, but check the register.', known: true, saved: true }],
      notSent: 0,
      checking: 0,
    });
  });

  test('words from a save the landed check found are listed as saved too', async () => {
    const onSaved = jest.fn(() => 'saved, but check the register.');
    const { save } = scriptedSave('Mark an athlete here', ['throw', answer(409)], { onSaved, checkLanded: jest.fn(async () => true) });
    await keepSave(save);
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(onSaved).toHaveBeenCalledWith(null);
    expect(readSaveQueue().failed).toEqual([{ label: 'Mark an athlete here', words: 'saved, but check the register.', known: true, saved: true }]);
  });

  test('a drop while onSaved is working: its words are not listed for the next person', async () => {
    let finish: (words: string) => void = () => undefined;
    const onSaved = jest.fn(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));
    const { save } = scriptedSave('Mark an athlete here', [answer(200)], { onSaved });
    await keepSave(save);
    await settle();
    clearRoleSession();
    await settle();
    finish('saved, but check the register.');
    await settle();
    // Not even counted: nothing of the last person's save is held for whoever is next.
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });
});

describe('the page id', () => {
  test('one id for every save of one account on this page, the same after a drop when that account comes back', async () => {
    const first = scriptedSave('One', [answer(200)]);
    const second = scriptedSave('Two', [answer(200)]);
    await keepSave(first.save);
    await keepSave(second.save);
    await settle();
    clearRoleSession();
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const third = scriptedSave('Three', [answer(200)]);
    await keepSave(third.save);
    await settle();
    const ids = [first, second, third].map((one) => one.contexts[0]?.pageId);
    expect(ids[0]).toEqual(expect.any(String));
    expect(new Set(ids).size).toBe(1);
  });

  test('another account on the same page gets another id: two people\'s saves are never tied together', async () => {
    const mine = scriptedSave('One', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    prepareSaveQueue();
    await settle();
    const theirs = scriptedSave('Two', [answer(200)]);
    await keepSave(theirs.save);
    await settle();
    expect(theirs.contexts[0]?.pageId).toEqual(expect.any(String));
    expect(theirs.contexts[0]?.pageId).not.toBe(mine.contexts[0]?.pageId);
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [{ label: 'Staff note on Ada Reyes', words: 'The server refused it.', known: true }], notSent: 0, checking: 0 });

    dismissFailedSaves();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await expectNothingSent(kept, 1);
  });

  test('another person signed in without passing through "nobody" (the sign-in writes the device mark first): the last person\'s words leave the screen at once, and their saves are dropped', async () => {
    await failedSave('Staff note on Ada Reyes');
    const kept = await waitingSave('Ada Reyes: here');

    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await expectNothingSent(kept, 1);

    // The next person's save is tied to them.
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('a role session written again with no mark, answered by another account: dropped once the check answers', async () => {
    await failedSave('Staff note on Ada Reyes');
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'acct-b';
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await expectNothingSent(kept, 1);
  });

  test('a role session written again by the same person on flaky wifi (the check cannot answer): a count, no names, until the account is confirmed; nothing is dropped and new saves are kept', async () => {
    await failedSave('Staff note on Ada Reyes');
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    // At once: it may be another person at the screen (a sign-in that wrote no device mark).
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 2 });
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 2 });
    const next = scriptedSave('Ada Reyes: not here', [answer(200)]);
    await expect(keepSave(next.save)).resolves.toBe('kept');
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 3 });
    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
    expect(next.save.onSaved).toHaveBeenCalledTimes(1);
    expect(readSaveQueue().failed.map((item) => item.label)).toEqual(['Staff note on Ada Reyes']);
    expect(readSaveQueue().checking).toBe(0);
  });

  test('with only failed words held, the check is asked again every 15 seconds until it answers: another account drops them, unseen', async () => {
    await failedSave('Staff note on Ada Reyes');
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    const asked = sessionCalls;
    await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    expect(sessionCalls).toBe(asked + 2);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    sessionAccount = 'acct-b';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    // The next person's own save is tied to them, and nothing of the last person's comes back.
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
    expect(readSaveQueue().failed).toEqual([]);
  });

  test('the not-sent count is not shown while the account is being checked again', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw']);
    await keepSave(kept.save);
    await settle();
    clearRoleSession();
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue().notSent).toBe(1);
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    sessionAccount = 'acct-a';
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(readSaveQueue().notSent).toBe(1);
  });

  test('an older answer to "who is signed in" arriving after a newer one is never used', async () => {
    // The first background ask hangs; a second one answers another account; then the first answers late.
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    const firstRelease = releaseSession;
    sessionAnswers = ['acct-b'];
    createPersistentRoleSession('coach');
    await settle();
    firstRelease?.('acct-a');
    await settle();
    sessionAccount = 'acct-b';
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('an older answer naming another account, arriving after a newer one confirmed the same person, is never used', async () => {
    // The newer answer drops nothing here, so only the ask's number can tell the old answer apart.
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    const firstRelease = releaseSession;
    sessionAnswers = ['acct-a'];
    createPersistentRoleSession('coach');
    await settle();
    firstRelease?.('acct-b');
    await settle();
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);
    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a tab coming back into view asks again who is signed in: another account signed in elsewhere (no mark) is found before this tab sends anything', async () => {
    await failedSave('Staff note on Ada Reyes');
    sessionAccount = 'acct-b';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // At once: a count, no names.
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });

  test('a save made while an ask cannot answer, then another account confirmed: that person is told the count, with no names', async () => {
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    const unsure = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(unsure.save);
    await settle();
    sessionAccount = 'acct-b';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(unsure.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 1, checking: 0 });
  });

  test('a save made while checking that the same person then confirms is theirs: a later sign-out does not tell the next person about it', async () => {
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    const kept = scriptedSave('Ada Reyes: here', []);
    await keepSave(kept.save);
    await settle();
    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);
    clearRoleSession();
    sessionAccount = 'acct-b';
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });

  test('a check before a send that confirms the account shows the names again at once, before the background ask answers', async () => {
    await failedSave('Staff note on Ada Reyes');
    await waitingSave('Ada Reyes: here');
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue().checking).toBe(2);
    sessionAnswers = ['acct-a'];
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(readSaveQueue()).toEqual({
      waiting: [],
      failed: [{ label: 'Staff note on Ada Reyes', words: 'The server refused it.', known: true }],
      notSent: 0,
      checking: 0,
    });
  });

  test('a resend\'s check asked before a re-check began never ends it: names stay hidden until a newer answer, and the save is sent once confirmed', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    // The resend's own check is out, and slow.
    sessionAccount = 'hang';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    const resendCheck = releaseSession;
    // Someone signs in elsewhere (no mark) and comes to this tab: a re-check, its ask out too.
    createPersistentRoleSession('coach');
    await settle();
    const recheckAsk = releaseSession;
    expect(saveQueueAccountConfirmed()).toBe(false);
    // The older answer names the last coach: it confirms nothing.
    resendCheck?.('acct-a');
    await settle();
    expect(saveQueueAccountConfirmed()).toBe(false);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    expect(kept.save.send).toHaveBeenCalledTimes(1);
    // The re-check's own answer decides.
    recheckAsk?.('acct-a');
    await settle();
    expect(saveQueueAccountConfirmed()).toBe(true);
    expect(readSaveQueue().waiting).toEqual(['Ada Reyes: here']);
    // The resend asked again after the re-check began; its answer sends the save.
    releaseSession?.('acct-a');
    await settle();
    expect(kept.save.send).toHaveBeenCalledTimes(2);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('coming back to the tab while a re-check\'s ask is still out asks again: the older ask\'s answer never confirms the last coach', async () => {
    await failedSave('Staff note on Ada Reyes');
    // The coach glances away and back; that re-check's ask hangs on the floor network.
    sessionAccount = 'hang';
    window.dispatchEvent(new Event('focus'));
    await settle();
    const olderAsk = releaseSession;
    // Someone else signs in in another tab (no mark) and comes back to this one.
    window.dispatchEvent(new Event('focus'));
    await settle();
    const newerAsk = releaseSession;
    expect(newerAsk).not.toBe(olderAsk);
    // The older ask answers with the last coach: not used.
    olderAsk?.('acct-a');
    await settle();
    expect(saveQueueAccountConfirmed()).toBe(false);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    // The newer ask decides: another account, so the last coach's words go unseen.
    newerAsk?.('acct-b');
    await settle();
    expect(saveQueueAccountConfirmed()).toBe(true);
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });

  test('a drop during the account check before a resend: the next person\'s first save goes at once, not 15 seconds later', async () => {
    await waitingSave('Ada Reyes: here');
    sessionAccount = 'hang';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    clearRoleSession();
    sessionAccount = 'acct-b';
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    await keepSave(mine.save);
    await settle();
    expect(mine.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('the check before a send finding another account confirms it: a count of saves made while checking reaches that person at once', async () => {
    // The background ask hangs, so the pump's own check is the one that finds the other account.
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    sessionAnswers = ['acct-b'];
    const unsure = scriptedSave('Ben Ortiz: here', [answer(200)]);
    const result = keepSave(unsure.save);
    await jest.advanceTimersByTimeAsync(KEEP_WAIT_MS);
    await expect(result).resolves.toBe('kept');
    await settle();
    expect(sessionAnswers).toEqual([]);
    expect(unsure.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 1, checking: 0 });
  });

  test('a save handed over while a check hangs is shown as a count at once, and kept after a few seconds for the account last confirmed', async () => {
    sessionAccount = 'hang';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    window.dispatchEvent(new Event('focus'));
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    const result = keepSave(kept.save);
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    await jest.advanceTimersByTimeAsync(KEEP_WAIT_MS);
    await expect(result).resolves.toBe('kept');
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 1 });
    expect(kept.save.send).not.toHaveBeenCalled();
    // The check answers the same person: the line shows, and the save goes.
    releaseSession?.('acct-a');
    sessionAccount = 'acct-a';
    await settle();
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.onSaved).toHaveBeenCalledTimes(1);
  });

  test('a save handed over before any account was confirmed, with the check hanging: no count (it may not be kept), then not kept after a few seconds', async () => {
    resetSaveQueueForTests();
    sessionAccount = 'hang';
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    const result = keepSave(kept.save);
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await jest.advanceTimersByTimeAsync(KEEP_WAIT_MS);
    await expect(result).resolves.toBe('not_kept');
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    expect(kept.save.send).not.toHaveBeenCalled();
  });

  test('a mark written in this tab while re-checking, then a save while the ask hangs: everything of the last account goes first, and the save is not counted for it', async () => {
    await failedSave('Staff note on Ada Reyes');
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue().checking).toBe(1);
    jest.advanceTimersByTime(5);
    writeGymTabletSignedOutAt(Date.now());
    sessionAccount = 'hang';
    const kept = scriptedSave('Ben Ortiz: here', [answer(200)]);
    const result = keepSave(kept.save);
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    releaseSession?.('acct-b');
    await expect(result).resolves.toBe('kept');
    await settle();
    expect(kept.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('two drops on the same device mark add up: the count shown is both', async () => {
    const first = scriptedSave('One', ['throw']);
    await keepSave(first.save);
    await settle();
    clearRoleSession();
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue().notSent).toBe(1);
    const second = scriptedSave('Two', ['throw']);
    await keepSave(second.save);
    await settle();
    clearRoleSession();
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue().notSent).toBe(2);
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
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

  test('the page asking again after its role session is written, and finding nobody, drops everything, the count too', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = null;
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    // The same person signs in again: the session that made the save ended, so it stays dropped,
    // and nothing of it survived that sign-out, not even the count.
    sessionAccount = 'acct-a';
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
    await expectNothingSent(kept, 1);
  });

  test('a sign-out from inside a refusal callback: its words are not kept for the next person', async () => {
    const kept = scriptedSave('Staff note on Ada Reyes', [answer(422)], {
      onRefused: jest.fn(() => {
        clearRoleSession();
        return 'The server refused it.';
      }),
    });
    await keepSave(kept.save);
    await settle();
    sessionAccount = 'acct-b';
    createPersistentRoleSession('coach');
    await settle();
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });

  test('a sign-in on the device while the page asks who is signed in: that answer is not used', async () => {
    resetSaveQueueForTests();
    sessionAccount = 'hang';
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    const result = keepSave(kept.save);
    await settle();
    writeGymTabletSignedOutAt(Date.now());
    releaseSession?.('acct-a');
    await expect(result).resolves.toBe('not_kept');
    await expectNothingSent(kept, 0);
  });

  test('a save made while the page asks again who is signed in waits for that answer, and is tied to whoever it names', async () => {
    sessionAccount = 'hang';
    createPersistentRoleSession('coach');
    await settle();
    const mine = scriptedSave('Ben Ortiz: here', [answer(200)]);
    const result = keepSave(mine.save);
    await settle();
    expect(mine.save.send).not.toHaveBeenCalled();
    releaseSession?.('acct-b');
    await expect(result).resolves.toBe('kept');
    await settle();
    expect(mine.contexts.map((context) => context.madeByAccountId)).toEqual(['acct-b']);
  });

  test('a save made while that ask cannot answer is tied to the account last confirmed, and is never sent before a check confirms it', async () => {
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    const kept = scriptedSave('Ada Reyes: here', [answer(200)]);
    await expect(keepSave(kept.save)).resolves.toBe('kept');
    await settle();
    expect(kept.save.send).not.toHaveBeenCalled();
    sessionAccount = 'acct-b';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(kept.save.send).not.toHaveBeenCalled();
    expect(readSaveQueue().waiting).toEqual([]);
  });

  test('once a check before a send confirms the account again, a save made at once is sent without asking', async () => {
    sessionAccount = 'unreachable';
    createPersistentRoleSession('coach');
    await settle();
    const one = scriptedSave('One', [answer(200)]);
    await keepSave(one.save);
    await settle();
    sessionAccount = 'acct-a';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    expect(one.save.onSaved).toHaveBeenCalledTimes(1);
    const asked = sessionCalls;
    const two = scriptedSave('Two', [answer(200)]);
    await keepSave(two.save);
    await settle();
    expect(two.save.onSaved).toHaveBeenCalledTimes(1);
    expect(sessionCalls).toBe(asked);
  });

  test('a sign-in mark written in this tab while the check before a send is out: nothing is sent', async () => {
    const kept = await waitingSave('Ada Reyes: here');
    sessionAccount = 'hang';
    await jest.advanceTimersByTimeAsync(RESEND_MS);
    writeGymTabletSignedOutAt(Date.now());
    releaseSession?.('acct-a');
    await settle();
    expect(readSaveQueue().waiting).toEqual([]);
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });
});

describe('saves dropped while the same person is still signed in', () => {
  test('the count is forgotten at a sign-out or sign-in on the device, even when the same person comes back', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw']);
    await keepSave(kept.save);
    await settle();
    clearRoleSession();
    jest.advanceTimersByTime(5);
    writeGymTabletSignedOutAt(Date.now());
    createPersistentRoleSession('coach');
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
  });

  test('the count, with no names, is shown once the page confirms it is still them; another person never sees it', async () => {
    const kept = scriptedSave('Ada Reyes: here', ['throw', answer(200)]);
    await keepSave(kept.save);
    await settle();
    // The role cache runs out (8 hours) while the coach is still signed in: the queue drops what it keeps.
    clearRoleSession();
    expect(readSaveQueue().notSent).toBe(0);
    prepareSaveQueue();
    await settle();
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 1, checking: 0 });
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
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
    expect(readSaveQueue()).toEqual({ waiting: [], failed: [], notSent: 0, checking: 0 });
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
