import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/src/lib/apiBase';
import { readGymTabletSignedOutAt } from '@/src/lib/gymTabletMark';

/*
 * THE KEPT-SAVE QUEUE (W4 item 7; OD-2026-11-21-006: OW27-34 A, "In the open page; dropped at
 * sign-out", "Retried until it goes through or the page closes; tied to the account that made it";
 * OW27-35 A, the live floor saves). App Overwatch on #2158: one shared module that lives as long as
 * the tab, not a screen's state, and no "Leave this page?" prompt.
 *
 * IN MEMORY ONLY. Nothing here is written to localStorage, sessionStorage, IndexedDB or a cookie:
 * offline storage on the device stays parked (OD-2026-09-28-008). A save not sent when the tab
 * closes is lost, which is the ruling's stated cost.
 *
 * ONE AT A TIME, IN ORDER. Every save a screen hands here waits behind the ones before it, so an
 * older save never lands after a newer one from this page (a quick correction stays a correction).
 * The server makes each resend safe: a request key, or a save that sets a state (#2165).
 *
 * TIED TO THE ACCOUNT THAT MADE IT. A save is kept only once this page knows who is signed in
 * (POST /api/pilot/auth/session); before that it is not kept, and the screen says what it says
 * today. Everything kept is dropped, unsent and unshown, the moment that account is gone or
 * another is signed in: the role session is cleared (every sign-out in the page does that), a
 * sign-out or sign-in on this device in another tab (the gym tablet's boundary mark), a 401, the
 * server saying the save was made by another account, or a check before a resend that answers
 * with another account or nobody. The words a waiting or failed save shows go with it, so the next
 * person sees nothing of the last person's saves.
 *
 * RESENT every 15 seconds and when the browser says it is online again (the tablet sign-out's
 * pattern, TabletIdleSignOut.tsx), until the server says yes, refuses it, or it is dropped. A
 * refusal of a RESEND is checked with the server before any failed words, when the screen can
 * check: a save that went through must never read as failed (Overwatch condition 2 on #2158).
 *
 * Known limit, accepted by App Overwatch (#2165): order holds within one page. A coach using two
 * devices on one live run can have a late save from one undo a newer change made on the other.
 */

export const RESEND_MS = 15_000;
/** The here-tap route's limit for tapped_ms_ago. */
const MS_SINCE_MADE_MAX = 24 * 60 * 60 * 1000;
/** A save that waited this long behind others has its account checked before its first send. */
const WAITED_MS = 1_000;
/** The server's own refusals: it answered and wrote nothing. Everything else proves nothing. */
const REFUSAL_STATUSES = new Set([400, 403, 404, 409, 422]);

export type SaveAnswer = 'saved' | 'refused' | 'unknown';

export interface SendContext {
  /** The account that made this save: sent as made_by_account_id where the route takes it. */
  madeByAccountId: string;
  /** Whole milliseconds since the save was made, for tapped_ms_ago. */
  msSinceMade: number;
  /** True for the first send, false for a resend. */
  first: boolean;
}

export interface KeptSave {
  /** What the waiting and failed words call this save. In memory only, dropped with the save. */
  label: string;
  /** Sends the save once. Every call sends the same save: the same request key or target state. */
  send: (context: SendContext) => Promise<Response>;
  /** What an answer proves. Default: 2xx saved; 400, 403, 404, 409, 422 refused; anything else unknown. */
  answerOf?: (response: Response) => SaveAnswer | Promise<SaveAnswer>;
  /** After a refusal of a resend: did an earlier send land after all? true, false, or null (could not tell). */
  checkLanded?: () => Promise<boolean | null>;
  /** The save went through: the server's answer, or null when the check found it had landed. */
  onSaved?: (response: Response | null) => void;
  /** Refused and not landed (false) or not known (null). Returns the failed words, or nothing for none. */
  onRefused?: (response: Response, landed: false | null) => string | void;
}

export interface FailedSave {
  label: string;
  words: string;
}

export interface SaveQueueState {
  /** Labels of the saves still waiting, oldest first. */
  waiting: readonly string[];
  failed: readonly FailedSave[];
}

interface Entry {
  save: KeptSave;
  accountId: string;
  madeAtPerf: number;
  madeAtWall: number;
  sends: number;
}

const EMPTY: SaveQueueState = { waiting: [], failed: [] };

let entries: Entry[] = [];
let failed: FailedSave[] = [];
let accountId: string | null = null;
let learning: Promise<string | null> | null = null;
let generation = 0;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let snapshot: SaveQueueState = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = entries.length === 0 && failed.length === 0
    ? EMPTY
    : { waiting: entries.map((entry) => entry.save.label), failed: [...failed] };
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function later(): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = undefined;
    void pump();
  }, RESEND_MS);
}

/** Everything kept, waiting or failed, goes: the account it was tied to is gone. */
function dropAll(): void {
  generation += 1;
  entries = [];
  failed = [];
  accountId = null;
  learning = null;
  clearTimer();
  notify();
}

/** Who is signed in now: an account id, null for nobody, or 'unreachable'. */
async function signedInAccount(): Promise<string | null | 'unreachable'> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return 'unreachable';
    const body = (await response.json().catch(() => null)) as { authenticated?: unknown; account_id?: unknown } | null;
    if (body?.authenticated === false) return null;
    return typeof body?.account_id === 'string' && body.account_id !== '' ? body.account_id : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

function learnAccount(): Promise<string | null> {
  if (accountId) return Promise.resolve(accountId);
  if (!learning) {
    const seen = generation;
    learning = signedInAccount().then((answer) => {
      learning = null;
      if (seen !== generation || answer === null || answer === 'unreachable') return null;
      accountId = answer;
      return answer;
    });
  }
  return learning;
}

/** A sign-out or sign-in on this device after a kept save was made (another tab, or this one). */
function boundaryAfterOldest(): boolean {
  const mark = readGymTabletSignedOutAt();
  return mark !== null && entries.some((entry) => mark >= entry.madeAtWall);
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  subscribeRoleSession(() => {
    if (!getRoleSessionSnapshot()) dropAll();
  });
  window.addEventListener('storage', () => {
    if (boundaryAfterOldest()) dropAll();
  });
  window.addEventListener('online', () => {
    clearTimer();
    void pump();
  });
}

/** Called by a screen that keeps saves, when it opens: learns who is signed in, once. */
export function prepareSaveQueue(): void {
  install();
  void learnAccount();
}

function msSinceMade(entry: Entry): number {
  // The larger of two counts: performance.now() may stop while a tablet sleeps, and Date.now() can
  // be set back. Too large only makes a late tap lose to a register change more often.
  const elapsed = Math.max(performance.now() - entry.madeAtPerf, Date.now() - entry.madeAtWall);
  return Math.min(MS_SINCE_MADE_MAX, Math.max(0, Math.round(elapsed)));
}

async function codeOf(response: Response): Promise<unknown> {
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
  return body?.code ?? body?.error;
}

function defaultAnswer(response: Response): SaveAnswer {
  if (response.ok) return 'saved';
  return REFUSAL_STATUSES.has(response.status) ? 'refused' : 'unknown';
}

async function pump(): Promise<void> {
  const head = entries[0];
  if (busy || !head) return;
  busy = true;
  clearTimer();
  const seen = generation;
  let next = false;
  try {
    if (boundaryAfterOldest()) {
      dropAll();
      return;
    }
    if (head.sends > 0 || performance.now() - head.madeAtPerf > WAITED_MS) {
      const now = await signedInAccount();
      if (seen !== generation) return;
      if (now === 'unreachable') {
        later();
        return;
      }
      if (now !== head.accountId) {
        dropAll();
        return;
      }
    }
    let response: Response | null = null;
    try {
      response = await head.save.send({ madeByAccountId: head.accountId, msSinceMade: msSinceMade(head), first: head.sends === 0 });
    } catch {
      response = null;
    }
    head.sends += 1;
    // Read the answer, then ask once whether the queue was dropped while it was on its way (a
    // sign-out, another account): a dropped save's answer is never used.
    const accountGone = response !== null
      && (response.status === 401 || (await codeOf(response)) === 'SAVE_MADE_BY_ANOTHER_ACCOUNT');
    const answer = response === null || accountGone ? 'unknown' : await (head.save.answerOf ?? defaultAnswer)(response);
    if (seen !== generation) return;
    if (accountGone) {
      dropAll();
      return;
    }
    if (response === null) {
      later();
      return;
    }
    if (answer === 'unknown') {
      later();
      return;
    }
    if (answer === 'saved') {
      entries.shift();
      head.save.onSaved?.(response);
    } else {
      // A refused RESEND may be refusing a save an earlier send already made (a finish, a removal).
      const landed = head.sends > 1 && head.save.checkLanded ? await head.save.checkLanded() : false;
      if (seen !== generation) return;
      entries.shift();
      if (landed === true) {
        head.save.onSaved?.(null);
      } else {
        const words = head.save.onRefused?.(response, landed);
        if (typeof words === 'string' && words !== '') failed.push({ label: head.save.label, words });
      }
    }
    notify();
    next = true;
  } finally {
    busy = false;
    if (next && entries.length > 0) void pump();
  }
}

/**
 * Hands a save to the queue. 'kept': it is sent now, or after the saves before it, and resent until
 * it goes through. 'not_kept': this page does not know who is signed in, so the save cannot be tied
 * to an account; nothing was sent, and the screen says what it said before this queue.
 */
export async function keepSave(save: KeptSave): Promise<'kept' | 'not_kept'> {
  install();
  const madeAtPerf = performance.now();
  const madeAtWall = Date.now();
  const seen = generation;
  const account = await learnAccount();
  if (!account || seen !== generation) return 'not_kept';
  entries.push({ save, accountId: account, madeAtPerf, madeAtWall, sends: 0 });
  notify();
  // While a save waits for its resend, a new one waits behind it: the queue tries again on its
  // 15 seconds or when the browser says it is online, not on every new tap.
  if (timer === undefined) void pump();
  return 'kept';
}

/** Clears the failed words once the person has read them. */
export function dismissFailedSaves(): void {
  if (failed.length === 0) return;
  failed = [];
  notify();
}

export function subscribeSaveQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readSaveQueue(): SaveQueueState {
  return snapshot;
}

export function emptySaveQueueState(): SaveQueueState {
  return EMPTY;
}

/** Tests only: a fresh page. */
export function resetSaveQueueForTests(): void {
  dropAll();
  busy = false;
  listeners.clear();
}
