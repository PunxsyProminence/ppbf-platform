'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { type RunClassView, fetchRunClass } from './SessionRunClass';

// The End Session offer on a session tied to a class (OD-2026-10-21-004 ruling 3, Jason: "A: Offer
// it (Rec.)"): one tap marks Absent everyone signed up for the class who has no mark. Never
// automatic: only the coach's tap here sends it, and ending the session does not. The count is the
// server's (`class.no_shows`); it is 0, and nothing is offered, whenever the server would refuse
// (the class has not started, was cancelled, or is not this coach's). Wording PROPOSED.

const RUN_GONE = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);

export default function SessionNoShows({ runId, onRunNotLive }: { readonly runId: string; readonly onRunNotLive: () => void }) {
  const [tied, setTied] = useState<RunClassView | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const read = await fetchRunClass().catch(() => null);
      if (live) setTied(read);
    })();
    return () => {
      live = false;
    };
  }, [runId]);

  async function markNoShows() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
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
      setDone(payload.marked?.length ?? 0);
    } catch {
      setMessage('Network error -- it is not known whether anyone was marked Absent. Check the class register.');
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <p role="status" className="t-body text-[color:var(--brass-300)]">
        {done === 0
          ? 'Nobody needed marking: everyone signed up already has a mark.'
          : `${done} signed-up ${done === 1 ? 'athlete was' : 'athletes were'} marked Absent on the class register.`}
      </p>
    );
  }
  if (!tied || tied.no_shows === 0) return null;
  return (
    <div className="space-y-[var(--s2)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] p-[var(--s3)]">
      <p className="t-body">
        {tied.no_shows} signed up for {tied.title} {tied.no_shows === 1 ? 'has' : 'have'} no mark here or on its register.
      </p>
      <button type="button" onClick={() => void markNoShows()} disabled={busy} className="btn btn--ghost disabled:opacity-60">
        {busy ? 'Marking...' : `Mark ${tied.no_shows === 1 ? 'them' : `all ${tied.no_shows}`} Absent`}
      </button>
      {message && <p role="alert" className="t-body font-semibold">{message}</p>}
    </div>
  );
}
