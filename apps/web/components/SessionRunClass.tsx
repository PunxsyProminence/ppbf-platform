'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { ClassChoice } from '@/src/shared/sessionClassChoice';
import SessionClassPicker, { classTimes } from './SessionClassPicker';

// The class a live session is running, on the live screen (D4, OD-2026-10-21-002): tied, its
// "here" taps also go on that class's register; untied (open gym), they do not
// (OD-2026-10-13-016). The coach can tie the session to one of today's classes, which copies the
// marks already made, or untie it, which leaves the register as it is. Wording PROPOSED.

export interface RunClassView {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  no_shows: number;
}

type Copied = { athlete_id: string; effect: string };

/** The live run's class as GET /api/pilot/session-scripts/runs answers it, or null. */
export async function fetchRunClass(): Promise<RunClassView | null> {
  const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, { credentials: 'include' });
  if (!response.ok) throw new Error('run');
  return ((await response.json()) as { class?: RunClassView }).class ?? null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a tie did to the register, in counts (the names are on the who-is-here list). */
export function tieSummary(title: string, copied: readonly Copied[]): string {
  const count = (effect: string) => copied.filter((row) => row.effect === effect).length;
  const parts = [
    count('created') + count('already_present') > 0 ? `${plural(count('created') + count('already_present'), 'athlete is', 'athletes are')} Present on its register` : '',
    count('flipped') > 0 ? `${plural(count('flipped'), 'was', 'were')} Absent or Excused and ${count('flipped') === 1 ? 'is' : 'are'} now Present` : '',
    count('register_newer') > 0 ? `${plural(count('register_newer'), 'mark', 'marks')} changed on the register after your tap ${count('register_newer') === 1 ? 'stays' : 'stay'} as the register says` : '',
    count('skipped') > 0 ? `${plural(count('skipped'), 'athlete was', 'athletes were')} not added` : '',
  ].filter(Boolean);
  return `Tied to ${title}.${parts.length ? ` ${parts.join('; ')}.` : ''}`;
}

export default function SessionRunClass({
  runId,
  classId,
  onClassChange,
}: {
  readonly runId: string;
  readonly classId: string | null;
  readonly onClassChange: (classId: string | null) => void;
}) {
  const [view, setView] = useState<RunClassView | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState<ClassChoice>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // The class's name and times, read when the session is (or becomes) tied.
  useEffect(() => {
    if (!classId) return undefined;
    let live = true;
    void (async () => {
      const read = await fetchRunClass().catch(() => null);
      if (live) setView(read);
    })();
    return () => {
      live = false;
    };
  }, [classId]);

  async function tie(next: string | null) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tie_class', class_id: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        class_id?: string | null;
        copied?: Copied[];
        released?: string[];
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setMessage(payload.message ?? 'The class could not be changed. Try again.');
        return;
      }
      setChoosing(false);
      onClassChange(payload.class_id ?? null);
      if (payload.class_id) {
        const tied = await fetchRunClass().catch(() => null);
        setView(tied);
        setMessage(tieSummary(tied?.title ?? 'the class', payload.copied ?? []));
      } else {
        const kept = payload.released?.length ?? 0;
        setMessage(`No class now (open gym).${kept ? ` The ${plural(kept, 'mark', 'marks')} this session put on the class register ${kept === 1 ? 'stays' : 'stay'}.` : ''}`);
      }
    } catch {
      setMessage('Network error -- the class was not changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-[var(--s5)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
      {classId ? (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p className="t-body">
            Class: <strong>{view?.title ?? 'a scheduled class'}</strong>
            {view && classTimes(view) ? `, ${classTimes(view)}` : ''}. Marks here also go on its register.
          </p>
          <button type="button" onClick={() => void tie(null)} disabled={busy} className="btn btn--ghost disabled:opacity-60">
            {busy ? 'Saving...' : 'Untie from the class'}
          </button>
        </div>
      ) : !choosing ? (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p className="t-body">No class (open gym). Marks here do not go on a class register.</p>
          <button type="button" onClick={() => setChoosing(true)} className="btn btn--ghost">
            Tie to a class...
          </button>
        </div>
      ) : (
        <div className="space-y-[var(--s3)]">
          <SessionClassPicker value={choice} onChange={setChoice} name={`tie-${runId}`} />
          <div className="flex flex-wrap gap-[var(--s3)]">
            <button type="button" onClick={() => choice && void tie(choice)} disabled={busy || !choice} className="btn disabled:opacity-60">
              {busy ? 'Saving...' : 'Tie to this class'}
            </button>
            <button type="button" onClick={() => setChoosing(false)} disabled={busy} className="btn btn--ghost">
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="t-body mt-[var(--s2)] text-[color:var(--brass-300)]">
          {message}
        </p>
      )}
    </div>
  );
}
