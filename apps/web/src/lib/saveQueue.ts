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
 * today. The account is asked again before every resend, before the first send of a save that
 * waited, and in the background whenever the role session is written again; until that background
 * ask confirms the account, a new save waits for its answer and is checked again before it is sent.
 * Everything kept,
 * waiting or failed, is dropped the moment that account is gone or another is signed in: the role
 * session is cleared (every sign-out in the page does that), the device's sign-out / sign-in mark
 * changes (every sign-in writes it first; this tab or another), a 401, the server saying the save
 * was made by another account, or a check that answers with another account or nobody. The words a waiting or failed save showed go with it: the next person sees
 * nothing of the last person's saves. Only the person whose saves were dropped, once the page has
 * confirmed it is still them signed in with no sign-out or sign-in on the device since, is told how
 * many were not sent, with no names (AGENT_KERNEL floor: an unknown value never looks complete).
 * The count, too, is forgotten at a sign-out or sign-in.
 *
 * RESENT every 15 seconds and when the browser says it is online again (the tablet sign-out's
 * pattern, TabletIdleSignOut.tsx), until the server says yes, refuses it, or it is dropped. A
 * refusal of a RESEND is checked with the server before any failed words, when the screen can
 * check; when it cannot, the screen is told the outcome is not known: a save that went through
 * must never read as failed (Overwatch condition 2 on #2158). A screen callback that throws never
 * stops the queue.
 *
 * Known limit, accepted by App Overwatch (#2165, comments 7151658028 and 7152137181): order holds
 * within one page, not across two devices of the same coach. A late save from one device can undo
 * a newer change made on the other: a run action, or a here tap or take-back, which on a session
 * tied to a class also writes or removes that class's register mark. What still holds: a register
 * change made after a tap wins (condition 1), and each screen reads back what the server holds.
 *
 * Known limit, within one page: a send given up on after ANSWER_WAIT_MS is aborted, which stops it
 * on the network, but not work the server had already started on it. If the server took a request
 * and is still working on it after 30 seconds, it may write it after a newer save from this page.
 */

export const RESEND_MS = 15_000;
/** The here-tap route's limit for tapped_ms_ago. */
const MS_SINCE_MADE_MAX = 24 * 60 * 60 * 1000;
/** A save that waited this long behind others has its account checked before its first send. */
const WAITED_MS = 1_000;
/** A send or an account check with no answer by then counts as unknown, so the queue moves on. */
export const ANSWER_WAIT_MS = 30_000;

export type SaveAnswer = 'saved' | 'refused' | 'unknown';

export interface SendContext {
  /** Aborted when the queue stops waiting for this send: pass it to fetch, so a send given up on never lands later. */
  signal: AbortSignal;
  /**
   * One random id for this save, the same on every send of it: the request key a route takes
   * (request_key), so the server writes the save once however often it is sent.
   */
  requestKey: string;
  /**
   * The account that made this save. Sent as made_by_account_id in the JSON body where the route
   * takes it, never in a URL or a header: an account id can be an email address.
   */
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
  /**
   * What an answer proves. Default: 2xx saved; 408 and 429 unknown; any other 4xx refused (the
   * server answered and wrote nothing); anything else unknown. A throw counts as unknown.
   */
  answerOf?: (response: Response) => SaveAnswer | Promise<SaveAnswer>;
  /** After a refusal of a resend: did an earlier send land after all? true, false, or null (could not tell). */
  checkLanded?: () => Promise<boolean | null>;
  /** The save went through: the server's answer, or null when the check found it had landed. */
  onSaved?: (response: Response | null) => void;
  /**
   * Refused. `landed` is false when the first send was refused or the check found nothing, and null
   * when a resend was refused and it is not known whether an earlier send landed. Returns the
   * failed words, or nothing for none.
   */
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
  /** How many waiting saves were dropped unsent; shown only to the account that made them. */
  notSent: number;
}

interface Entry {
  save: KeptSave;
  requestKey: string;
  accountId: string;
  madeAtPerf: number;
  madeAtWall: number;
  sends: number;
}

const EMPTY: SaveQueueState = { waiting: [], failed: [], notSent: 0 };

let entries: Entry[] = [];
let failed: FailedSave[] = [];
/** The account this page last confirmed, since the role session last changed; null when not known. */
let accountId: string | null = null;
/** The account whose saves and words this page holds; nothing is shown unless it is confirmed now. */
let heldAccount: string | null = null;
/**
 * Whether this page holds anything for an account (since its first confirmation after the last
 * drop), and the device's sign-out / sign-in mark as it read then. Any other mark seen later means a
 * sign-out or sign-in on this device since. Compared by value; the one clock in it: the mark module
 * deletes a mark dated in the future (the device clock set back), which reads as a change, so the
 * saves are dropped, never kept.
 */
let holding = false;
let markAtHold: number | null = null;
let learning: Promise<string | null> | null = null;
/** Each ask of who is signed in gets a number; only the newest one's answer is used. */
let learnSeq = 0;
/** The role session was written again and no answer has confirmed the account since. */
let rechecking = false;
/** Saves dropped unsent: how many, whose, and the device mark when they were dropped. */
let notSent: { count: number; accountId: string; mark: number | null } | null = null;
let generation = 0;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let snapshot: SaveQueueState = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  // Shown only while the account that holds them is the one confirmed signed in now: between a
  // change of role session and the next confirmation, nothing of anyone's saves is on screen.
  const confirmed = accountId !== null && accountId === heldAccount;
  const dropped = notSent && accountId !== null && notSent.accountId === accountId ? notSent.count : 0;
  snapshot = (!confirmed || (entries.length === 0 && failed.length === 0)) && dropped === 0
    ? EMPTY
    : {
      waiting: confirmed ? entries.map((entry) => entry.save.label) : [],
      failed: confirmed ? [...failed] : [],
      notSent: dropped,
    };
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's own failure never stops the queue.
    }
  }
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

/** Everything kept, waiting or failed, goes: the account it was tied to is gone or has changed. */
function dropAll(): void {
  if (entries.length > 0) {
    notSent = { count: entries.length, accountId: entries[0].accountId, mark: readGymTabletSignedOutAt() };
  } else if (notSent && notSent.mark !== readGymTabletSignedOutAt()) {
    notSent = null;
  }
  generation += 1;
  entries = [];
  failed = [];
  accountId = null;
  heldAccount = null;
  holding = false;
  markAtHold = null;
  learning = null;
  rechecking = false;
  clearTimer();
  notify();
}

/**
 * A request, given up on after ANSWER_WAIT_MS: no request may hold the queue forever. It is ABORTED
 * then, not left open, so a send given up on cannot reach the server after a newer one.
 */
function withinWait<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let wait: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    wait = setTimeout(() => {
      controller.abort();
      reject(new Error('no answer'));
    }, ANSWER_WAIT_MS);
  });
  return Promise.race([start(controller.signal), timeout]).finally(() => clearTimeout(wait));
}

/** Who is signed in now: an account id, null for nobody, or 'unreachable'. */
async function signedInAccount(): Promise<string | null | 'unreachable'> {
  try {
    const response = await withinWait((signal) => fetch(`${apiBase()}/api/pilot/auth/session`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal,
    }));
    if (!response.ok) return 'unreachable';
    const body = (await response.json().catch(() => null)) as { authenticated?: unknown; account_id?: unknown } | null;
    if (body?.authenticated === false) return null;
    return typeof body?.account_id === 'string' && body.account_id !== '' ? body.account_id : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** A sign-out or sign-in mark on this device written since this page began to hold (any tab). */
function boundaryNewer(): boolean {
  return holding && readGymTabletSignedOutAt() !== markAtHold;
}

/** The account signed in now. Saves and words held for another account go first. */
function confirmAccount(answer: string): void {
  if (heldAccount !== null && heldAccount !== answer) dropAll();
  accountId = answer;
  heldAccount = answer;
  rechecking = false;
  if (!holding) {
    holding = true;
    markAtHold = readGymTabletSignedOutAt();
  }
  // Told only to the same account, and only with no sign-out or sign-in on the device since.
  if (notSent && (notSent.accountId !== answer || notSent.mark !== readGymTabletSignedOutAt())) notSent = null;
  notify();
}

/**
 * Who is signed in: the account confirmed already, or ask (always, when `again`). While the role
 * session's background ask is out, its answer; if it cannot answer, the account last confirmed
 * (a save made then is checked again before it is sent).
 */
function learnAccount(again = false): Promise<string | null> {
  if (boundaryNewer()) dropAll();
  if (accountId && !again && !rechecking) return Promise.resolve(accountId);
  if (!learning || again) {
    const seen = generation;
    const seq = ++learnSeq;
    const markAtAsk = readGymTabletSignedOutAt();
    learning = signedInAccount().then((answer) => {
      // Only the newest ask counts: an older answer arriving late is never used.
      if (seen !== generation || seq !== learnSeq) return seq === learnSeq ? null : accountId;
      learning = null;
      // A sign-out or sign-in on the device while asking: the answer may be about the last person.
      if (readGymTabletSignedOutAt() !== markAtAsk) {
        if (holding) dropAll();
        return null;
      }
      if (answer === null) {
        dropAll();
        notSent = null;
        notify();
        return null;
      }
      if (answer === 'unreachable') return accountId;
      confirmAccount(answer);
      return answer;
    });
  }
  return learning;
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  subscribeRoleSession(() => {
    // Signed out, or a sign-in on this device since this page began to hold (every sign-in writes
    // the device mark before it writes the role session): everything goes, at once.
    if (!getRoleSessionSnapshot() || boundaryNewer()) {
      dropAll();
      return;
    }
    // The same device with no sign-in since: a page read its session again. Ask in the background;
    // another account or nobody drops everything, and an unanswered ask leaves the saves as they are.
    rechecking = true;
    void learnAccount(true);
  });
  window.addEventListener('storage', () => {
    if (boundaryNewer()) dropAll();
  });
  window.addEventListener('online', () => {
    clearTimer();
    void pump();
  });
}

/** Called by a screen that keeps saves, when it opens: learns who is signed in. */
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
  try {
    // clone() throws on a body a screen's send already read: then there is no code to read.
    const body = (await response.clone().json()) as { code?: unknown; error?: unknown } | null;
    return body?.code ?? body?.error;
  } catch {
    return undefined;
  }
}

function defaultAnswer(response: Response): SaveAnswer {
  if (response.ok) return 'saved';
  if (response.status === 408 || response.status === 429) return 'unknown';
  return response.status >= 400 && response.status < 500 ? 'refused' : 'unknown';
}

/** A screen's callback, never allowed to stop the queue: a throw gives the fallback. */
async function safely<T>(callback: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await callback();
  } catch {
    return fallback;
  }
}

async function pump(): Promise<void> {
  const head = entries[0];
  if (busy || !head) return;
  busy = true;
  clearTimer();
  const seen = generation;
  let next = false;
  try {
    if (boundaryNewer()) {
      dropAll();
      return;
    }
    if (head.sends > 0 || rechecking || head.accountId !== accountId || msSinceMade(head) > WAITED_MS) {
      const now = await signedInAccount();
      if (seen !== generation) return;
      if (boundaryNewer()) {
        dropAll();
        return;
      }
      if (now === 'unreachable') {
        later();
        return;
      }
      if (now !== head.accountId) {
        dropAll();
        return;
      }
      confirmAccount(now);
    }
    let response: Response | null = null;
    try {
      response = await withinWait((signal) => head.save.send({
        signal,
        requestKey: head.requestKey,
        madeByAccountId: head.accountId,
        msSinceMade: msSinceMade(head),
        first: head.sends === 0,
      }));
    } catch {
      response = null;
    }
    head.sends += 1;
    const accountGone = response !== null
      && (response.status === 401 || (await codeOf(response)) === 'SAVE_MADE_BY_ANOTHER_ACCOUNT');
    // A dropped save's answer is never used (a sign-out, another account, while it was on its way).
    if (seen !== generation) return;
    if (accountGone) {
      dropAll();
      return;
    }
    const answered = response;
    const answer: SaveAnswer = answered === null
      ? 'unknown'
      : await safely(() => (head.save.answerOf ?? defaultAnswer)(answered), 'unknown' as SaveAnswer);
    if (seen !== generation) return;
    if (answered === null || answer === 'unknown') {
      later();
      return;
    }
    if (answer === 'saved') {
      entries.shift();
      notify();
      await safely(() => head.save.onSaved?.(answered), undefined);
    } else {
      // A refused RESEND may be refusing a save an earlier send already made (a finish, a removal).
      // Without a check, whether it landed is not known.
      const landed: boolean | null = head.sends === 1
        ? false
        : head.save.checkLanded ? await safely(() => head.save.checkLanded!(), null) : null;
      if (seen !== generation) return;
      entries.shift();
      if (landed === true) {
        notify();
        await safely(() => head.save.onSaved?.(null), undefined);
      } else {
        const words = await safely(() => head.save.onRefused?.(answered, landed), undefined);
        if (seen !== generation) return;
        if (typeof words === 'string' && words !== '') failed.push({ label: head.save.label, words });
        notify();
      }
    }
    next = true;
  } finally {
    busy = false;
    // Never left without a way forward: the next save now, or a resend in 15 seconds. A save handed
    // over while this one was on its way, or kept after a drop, is sent at once.
    if (entries.length > 0 && timer === undefined) {
      if (next || seen !== generation) void pump();
      else later();
    }
  }
}

/** A random request key, or null where the browser cannot make one (then the save is not kept). */
function newRequestKey(): string | null {
  const cryptoApi = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
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
  const requestKey = newRequestKey();
  if (!requestKey) return 'not_kept';
  const account = await learnAccount();
  if (!account || account !== accountId) return 'not_kept';
  entries.push({ save, requestKey, accountId: account, madeAtPerf, madeAtWall, sends: 0 });
  notify();
  // While a save waits for its resend, a new one waits behind it: the queue tries again on its
  // 15 seconds or when the browser says it is online, not on every new tap.
  if (timer === undefined) void pump();
  return 'kept';
}

/** Clears the failed words and the not-sent count once the person has read them. */
export function dismissFailedSaves(): void {
  if (failed.length === 0 && notSent === null) return;
  failed = [];
  notSent = null;
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
  notSent = null;
  busy = false;
  listeners.clear();
  notify();
}
