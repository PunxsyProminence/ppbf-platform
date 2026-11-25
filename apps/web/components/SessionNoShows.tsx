'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { keepSave, type KeptSave } from '@/src/lib/saveQueue';
import { type RunClassView, fetchRunClass } from './SessionRunClass';

// The End Session offer on a session tied to a class (OD-2026-10-21-004 ruling 3, Jason: "A: Offer
// it (Rec.)"): one tap marks Absent everyone signed up for the class who has no mark. Never
// automatic: only the coach's tap here sends it, and ending the session does not. The count is the
// server's (`class.no_shows`), read again whenever the marks here change; it is 0, and nothing is
// offered, whenever the server would refuse (the class has not started, was cancelled, or is not
// this coach's). The server skips anyone marked in any session of the gym that day. Wording PROPOSED.

const RUN_GONE = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);

type Read = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; view: RunClassView | null };

export default function SessionNoShows({
  runId,
  classId,
  presentCount,
  onRunNotLive,
}: {
  readonly runId: string;
  readonly classId: string;
  /** The marks here, as last read: a change reads the count again. */
  readonly presentCount: number | null;
  readonly onRunNotLive: () => void;
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

  const showMarked = useCallback((done: number | null) => {
    setResult(done === null
      ? 'The server shows the no-shows were marked Absent on the class register.'
      : done === 0
        ? 'Nobody needed marking: everyone signed up already has a mark.'
        : `${done} signed-up ${done === 1 ? 'athlete was' : 'athletes were'} marked Absent on the class register.`);
    setAttempt((count) => count + 1);
  }, []);

  // Kept on the open page and resent until it goes through (W4 item 7, OQ-3). Marking the no-shows
  // again marks nobody new (OQ-1's repeat proofs). A refused RESEND is checked against the count the
  // server holds before any failed words (Overwatch condition 2).
  const keptNoShows = useCallback((): KeptSave => {
    let refusal: { error?: string; message?: string } = {};
    return {
      label: 'Mark the no-shows Absent',
      send: ({ signal }) =>
        fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'mark_no_shows' }),
          signal,
        }),
      answerOf: async (response) => {
        if (response.ok) return 'saved';
        refusal = (await response.clone().json().catch(() => ({}))) as typeof refusal;
        return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'refused' : 'unknown';
      },
      checkLanded: async (signal) => {
        const now = await fetchRunClass(signal).then((view) => ({ view }), () => null);
        if (now === null) return null;
        return now.view?.class_id === classId && now.view.no_shows === 0;
      },
      onSaved: (response) => {
        void (async () => {
          if (!response) {
            showMarked(null);
            return;
          }
          const payload = (await response.json().catch(() => ({}))) as { marked?: string[] };
          showMarked(payload.marked?.length ?? 0);
        })();
      },
      onRefused: (_response, landed) => {
        if (refusal.error && RUN_GONE.has(refusal.error)) {
          onRunNotLive();
          return undefined;
        }
        if (landed === null) return 'It is not known whether anyone was marked Absent. Check the class register.';
        return refusal.message ?? 'Nobody was marked Absent.';
      },
    };
  }, [classId, onRunNotLive, runId, showMarked]);

  const markNoShows = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      if ((await keepSave(keptNoShows())) === 'kept') return;
      // Not kept (the page does not know who is signed in): sent once, as before.
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_no_shows' }),
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
      <p role="status" className="t-body text-[color:var(--brass-300)]">{result}</p>
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
          <button type="button" onClick={() => void markNoShows()} disabled={busy} className="btn btn--ghost disabled:opacity-60">
            {busy ? 'Marking…' : `Mark ${view.no_shows === 1 ? 'them' : `all ${view.no_shows}`} Absent`}
          </button>
        </div>
      )}
      {message && <p role="alert" className="t-body font-semibold">{message}</p>}
    </div>
  );
}
