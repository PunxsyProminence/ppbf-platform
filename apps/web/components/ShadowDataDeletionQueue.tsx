'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

/**
 * The review that POST /api/pilot/shadow/data has been promising.
 *
 * That route answers `fulfillment: 'manual_review_required'` and files a row
 * in pilot.shadow_data_deletion_requests. Until this queue existed, the only
 * read of that table anywhere was the writer's own idempotency check -- so the
 * review was a promise nothing could keep.
 *
 * WHY IT LIVES ON THE COMPLIANCE CENTER. This is a data-subject request queue,
 * and the compliance center is where this platform already puts rows a human
 * owes an answer to. A deletion request buried on a SHADOW admin page would be
 * reachable and still not looked at.
 */

export type ShadowDeletionRequestStatus = 'pending' | 'approved' | 'completed' | 'denied';

export interface ShadowDeletionRequestRow {
  requestId: string;
  accountId: string;
  status: ShadowDeletionRequestStatus;
  requestedAt: string;
  completedAt: string | null;
  processedBy: string | null;
  conversationsPending: number;
}

/* Law 3: state carries a glyph and an uppercase word, never colour alone --
   the same ladder the rest of this room uses.

   `pending` is --restricted and NOT --locked. The safeguarding red is reserved
   for the top of the safety ladder, a person who may not participate; a data
   request waiting on an admin is work owed, not a child in danger. */
const STATUS_BADGE: Record<ShadowDeletionRequestStatus, { rung: string; glyph: string; label: string }> = {
  pending: { rung: 'badge--restricted', glyph: '▲', label: 'AWAITING REVIEW' },
  approved: { rung: 'badge--restricted', glyph: '◈', label: 'APPROVED' },
  completed: { rung: 'badge--cleared', glyph: '✓', label: 'CLEARED' },
  denied: { rung: 'badge--monitor', glyph: '◉', label: 'DENIED' },
};

export default function ShadowDataDeletionQueue() {
  const [rows, setRows] = useState<ShadowDeletionRequestRow[]>([]);
  /* Four states, not two. "Nobody has asked" and "nobody could tell whether
     anybody asked" are opposite facts about a queue of children's data
     requests, and rendering the second as the first is how an unread queue
     looks handled. */
  const [state, setState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [armedId, setArmedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/shadow-data-requests`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        setState('unavailable');
        return;
      }
      const payload = (await response.json()) as { ok?: boolean; items?: ShadowDeletionRequestRow[] };
      if (payload.ok !== true || !Array.isArray(payload.items)) {
        setState('unavailable');
        return;
      }
      setRows(payload.items);
      setState('loaded');
    } catch {
      setState('unavailable');
    }
  }, []);

  /* The IIFE is not decoration: react-hooks/set-state-in-effect reads through
     a useCallback declared in the same component and flags `void load()` as a
     synchronous setState in an effect body. Wrapping the await keeps the rule
     satisfied and matches how every other admin surface here loads (see
     compliance-center/page.tsx). */
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function act(row: ShadowDeletionRequestRow, action: 'complete' | 'deny') {
    if (busyId) return;
    setBusyId(row.requestId);
    setRowErrors((prev) => ({ ...prev, [row.requestId]: '' }));
    setNotice('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/shadow-data-requests`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: row.requestId, action }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        conversationsCleared?: number;
      };
      if (!response.ok || payload.ok !== true) {
        setRowErrors((prev) => ({
          ...prev,
          [row.requestId]: payload.error || 'The request was not updated.',
        }));
        return;
      }
      /* The count comes from the SERVER's answer, not from the
         conversationsPending this row was rendered with. That number was
         counted when the queue loaded and the person can have deleted
         conversations themselves since -- reporting it would tell an admin
         eleven were cleared when three were. */
      const cleared = payload.conversationsCleared;
      setNotice(
        action === 'deny'
          ? 'Request denied. Nothing was deleted, and the denial is on the record with your name against it.'
          : typeof cleared === 'number'
            ? `Cleared ${cleared} ${cleared === 1 ? 'conversation' : 'conversations'}. `
              + 'SHADOW chat history only — memory corrections are kept.'
            : 'Request completed. SHADOW chat history only — memory corrections are kept.',
      );
      setArmedId(null);
      await load();
    } catch {
      setRowErrors((prev) => ({
        ...prev,
        [row.requestId]: 'Network error -- nothing was changed. Please try again.',
      }));
    } finally {
      setBusyId(null);
    }
  }

  const open = rows.filter((row) => row.status === 'pending' || row.status === 'approved');

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
      <h3 className="t-eyebrow">SHADOW history deletion requests</h3>
      <p className="t-muted mt-[var(--s2)]">
        A member asked for their SHADOW conversation history to be cleared. Completing a request
        clears it now — chat history only; memory corrections are kept, and nothing here touches
        their account, sessions or records.
      </p>

      {state === 'loading' && <p className="t-muted mt-[var(--s3)]">Loading requests...</p>}

      {state === 'unavailable' && (
        /* Never "no requests". An unreadable queue and an empty one are
           opposite answers to "does anybody here owe a child a decision". */
        <p className="t-body mt-[var(--s3)] text-[color:var(--restricted-ink)]">
          The request queue could not be read. This is not the same as there being none —
          reload before concluding the queue is clear.
        </p>
      )}

      {state === 'loaded' && open.length === 0 && (
        <p className="t-muted mt-[var(--s3)]">No requests are waiting on a decision.</p>
      )}

      {notice && <p role="status" className="t-body mt-[var(--s3)]">{notice}</p>}

      {state === 'loaded' && rows.length > 0 && (
        <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
          {rows.map((row) => {
            const badge = STATUS_BADGE[row.status];
            const armed = armedId === row.requestId;
            const busy = busyId === row.requestId;
            const actionable = row.status === 'pending' || row.status === 'approved';
            return (
              <li
                key={row.requestId}
                className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                  <span className="t-body font-semibold">{row.accountId}</span>
                  <span className={`badge ${badge.rung}`}>{badge.glyph} {badge.label}</span>
                </div>
                <p className="t-muted mt-[var(--s2)]">
                  Asked {formatGymStamp(row.requestedAt) ?? row.requestedAt}
                  {row.completedAt
                    ? ` · handled ${formatGymStamp(row.completedAt) ?? row.completedAt}`
                    : ''}
                </p>
                {actionable && (
                  <p className="t-muted">
                    {row.conversationsPending}{' '}
                    {row.conversationsPending === 1 ? 'conversation' : 'conversations'} would be
                    cleared.
                  </p>
                )}

                {actionable && (armed ? (
                  <>
                    <p className="t-body mt-[var(--s2)]">
                      This clears their SHADOW conversation history now. It cannot be undone from
                      here.
                    </p>
                    <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(row, 'complete')}
                        className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? 'Clearing…' : 'Clear the history'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setArmedId(null)}
                        className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Review the deletion request from ${row.accountId}`}
                      onClick={() => setArmedId(row.requestId)}
                      className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Deny the deletion request from ${row.accountId}`}
                      onClick={() => void act(row, 'deny')}
                      className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Deny
                    </button>
                  </div>
                ))}

                {rowErrors[row.requestId] && (
                  <p className="mt-[var(--s2)] text-[color:var(--restricted-ink)]">
                    {rowErrors[row.requestId]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
