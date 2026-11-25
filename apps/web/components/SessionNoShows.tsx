'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { keepSave, readSaveQueue, subscribeSaveQueue, type KeptSave } from '@/src/lib/saveQueue';
import { type RunClassView, fetchLiveRunClass, fetchRunClass, unknownOffPage, unknownOutcomeWords } from './SessionRunClass';

// The End Session offer on a session tied to a class (OD-2026-10-21-004 ruling 3, Jason: "A: Offer
// it (Rec.)"): one tap marks Absent everyone signed up for the class who has no mark. Never
// automatic: only the coach's tap here sends it, and ending the session does not. The count is the
// server's (`class.no_shows`), read again whenever the marks here change; it is 0, and nothing is
// offered, whenever the server would refuse (the class has not started, was cancelled, or is not
// this coach's). The server skips anyone marked in any session of the gym that day. Wording PROPOSED.
// The tap names the athletes the screen showed (`class.no_show_ids`), and only those can be marked:
// a resend never reaches anyone who became a no-show later (W4 item 7, OVERWATCH 7160191377).

const RUN_GONE = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);
// Refusals the server gives only after looking the tap's key up (sessionRunClass.ts): a send
// of this key that had landed would have been answered with its first answer instead.
const REFUSED_AFTER_KEY = new Set([
  'SESSION_RUN_NOT_LIVE',
  'SESSION_RUN_NOT_TIED',
  'SESSION_CLASS_CANCELLED',
  'SESSION_CLASS_NOT_YOURS',
  'SESSION_CLASS_NOT_STARTED',
  'SESSION_NO_SHOWS_KEY_REUSED',
]);

type Read = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; view: RunClassView | null };

export default function SessionNoShows({
  runId,
  classId,
  presentCount,
  onRunNotLive,
  isFinishWaiting,
}: {
  readonly runId: string;
  readonly classId: string;
  /** The marks here, as last read: a change reads the count again. */
  readonly presentCount: number | null;
  readonly onRunNotLive: () => void;
  /** Whether a finish is kept and waiting now: once it lands this screen goes, so a refusal is said in the page's list. */
  readonly isFinishWaiting?: () => boolean;
}) {
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [result, setResult] = useState('');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const view = await fetchRunClass().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
      if (!live) return;
      setRead(view.ok ? { state: 'loaded', view: view.value } : { state: 'failed' });
    })();
    return () => {
      live = false;
    };
  }, [runId, classId, presentCount, attempt]);

  // done: how many this tap marked; null when the server shows it landed without saying how many.
  const showMarked = useCallback((done: number | null) => {
    setResult(done === null
      ? 'The class register now shows no no-shows.'
      : done === 0
        ? 'Nobody needed marking: everyone signed up already has a mark.'
        : `${done} signed-up ${done === 1 ? 'athlete was' : 'athletes were'} marked Absent on the class register.`);
    setAttempt((count) => count + 1);
  }, []);
  // A kept tap not yet saved: the button waits too, so the same tap is not kept twice. A sign-out
  // drops it without a word here, so with nothing waiting on the page, nothing waits here either.
  const [waiting, setWaiting] = useState(false);
  useEffect(
    () =>
      subscribeSaveQueue(() => {
        const state = readSaveQueue();
        if (state.waiting.length === 0 && state.checking === 0) setWaiting(false);
      }),
    [],
  );
  // While this offer is on the page, and no kept finish will take it away; otherwise a refusal gives
  // its words to the page's list.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  // Kept on the open page and resent until it goes through (W4 item 7, OQ-3). Every send carries the
  // names shown at the tap and the tap's one key: the server marks only those, and answers a resend of
  // a key that landed with the first answer, writing nothing (OVERWATCH 7160191377). A refused RESEND
  // is checked before any failed words (Overwatch condition 2).
  const keptNoShows = useCallback((resolved: { done: boolean }, named: readonly string[]): KeptSave => {
    let refusal: { error?: string; message?: string } = {};
    const label = 'Mark the no-shows Absent';
    return {
      label,
      send: ({ signal, requestKey }) =>
        fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'mark_no_shows', athlete_ids: named, request_key: requestKey }),
          signal,
        }),
      answerOf: async (response) => {
        if (response.ok) return 'saved';
        refusal = (await response.clone().json().catch(() => ({}))) as typeof refusal;
        return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'refused' : 'unknown';
      },
      // Not landed when the server refused after looking the key up. Otherwise landed only if the
      // coach's live run is this run and none of the names sent is still a no-show of its class.
      checkLanded: async (signal) => {
        if (refusal.error && REFUSED_AFTER_KEY.has(refusal.error)) return false;
        const now = await fetchLiveRunClass(signal).catch(() => null);
        if (now === null) return null;
        return now.runId === runId && now.view?.class_id === classId && !now.view.no_show_ids.some((id) => named.includes(id));
      },
      onSaved: (response) => {
        resolved.done = true;
        setWaiting(false);
        void (async () => {
          if (!response) {
            showMarked(null);
            return;
          }
          // A resend of a send that landed is answered with that send's answer.
          const payload = (await response.json().catch(() => ({}))) as { marked?: string[] };
          showMarked(payload.marked?.length ?? 0);
        })();
      },
      // Refused: said here, where the coach tapped.
      onRefused: (_response, landed) => {
        resolved.done = true;
        setWaiting(false);
        if (refusal.error && RUN_GONE.has(refusal.error)) {
          onRunNotLive();
          return undefined;
        }
        const reason = refusal.message ?? 'Nobody was marked Absent.';
        // Off the page, the page's list says it, after the save's own name.
        if (!onPage.current || isFinishWaiting?.()) {
          return landed === null ? unknownOffPage('Check the class register before marking them again.') : reason;
        }
        setMessage(landed === null ? unknownOutcomeWords(label) : reason);
        return undefined;
      },
    };
  }, [classId, isFinishWaiting, onRunNotLive, runId, showMarked]);

  // named: the no-shows this screen shows now, which the coach is tapping on.
  const markNoShows = useCallback(async (named: readonly string[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      // Waiting once kept (the account check settles first, under this tap's busy lock), unless it
      // was answered already.
      const resolved = { done: false };
      if ((await keepSave(keptNoShows(resolved, named))) === 'kept') {
        if (!resolved.done) setWaiting(true);
        return;
      }
      // Not kept (the page does not know who is signed in): sent once, as before, naming the same athletes.
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_no_shows', athlete_ids: named }),
      });
      const payload = (await response.json().catch(() => ({}))) as { marked?: string[]; error?: string; message?: string };
      if (!response.ok) {
        if (payload.error && RUN_GONE.has(payload.error)) {
          onRunNotLive();
          return;
        }
        setMessage(payload.message ?? 'Nobody was marked Absent. Try again.');
        return;
      }
      showMarked(payload.marked?.length ?? 0);
    } catch {
      setMessage('Network error -- it is not known whether anyone was marked Absent. Check the class register.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [keptNoShows, onRunNotLive, runId, showMarked]);

  // Only this class's count: never one read before a retie.
  const view = read.state === 'loaded' && read.view?.class_id === classId ? read.view : null;

  return (
    <div className="space-y-[var(--s2)]">
      {/* A kept tap not yet saved says so on the same status line, mounted always. */}
      <p role="status" className="t-body text-[color:var(--brass-300)]">
        {waiting ? 'Marking the no-shows Absent is not saved yet. This page keeps sending it while it stays open.' : result}
      </p>
      {read.state === 'failed' && (
        <p className="t-body">
          Could not check the class register for no-shows.{' '}
          <button type="button" className="btn btn--ghost" onClick={() => { setRead({ state: 'loading' }); setAttempt((count) => count + 1); }}>
            Check again
          </button>
        </p>
      )}
      {view && view.no_shows > 0 && (
        <div className="space-y-[var(--s2)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] p-[var(--s3)]">
          <p className="t-body">
            {view.no_shows} signed up for {view.title} {view.no_shows === 1 ? 'has' : 'have'} no mark on its register or in any session today.
          </p>
          <button type="button" onClick={() => void markNoShows(view.no_show_ids)} disabled={busy || waiting} className="btn btn--ghost disabled:opacity-60">
            {busy ? 'Marking…' : `Mark ${view.no_shows === 1 ? 'them' : `all ${view.no_shows}`} Absent`}
          </button>
        </div>
      )}
      {message && <p role="alert" className="t-body font-semibold">{message}</p>}
    </div>
  );
}
