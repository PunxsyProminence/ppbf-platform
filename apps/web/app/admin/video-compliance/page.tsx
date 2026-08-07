"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

interface PendingPublication {
  publication_id: string;
  title: string;
  description: string;
  athlete_id: string;
  athlete_name: string | null;
  uploader_account_id: string;
  uploader_name: string | null;
  created_at: string;
  compliance_check_status: string;
  previous_review_note: string | null;
  stream_url: string | null;
}

type Decision = 'approve' | 'reject' | 'request_changes';

const DECISION_LABEL: Record<Decision, string> = {
  approve: 'Approve',
  reject: 'Reject',
  request_changes: 'Request Changes',
};

const DECISION_PROMPT: Record<'reject' | 'request_changes', string> = {
  reject: 'Reason for rejecting this video (required -- the uploader needs to know why):',
  request_changes: 'What needs to change before this can be approved (required)?',
};

function formatDate(value: string): string {
  return formatGymDateTimeShort(value) ?? value;
}

export default function VideoCompliancePage() {
  const [items, setItems] = useState<PendingPublication[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  // Per-row, not a single scalar -- deciding on one video must never disable
  // or re-enable a different row's still-in-flight buttons.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // Two decisions on two different rows can each trigger their own reload;
  // nothing guarantees the HTTP responses land in the order they were sent.
  // A generation counter lets a fresher request always win, even if its
  // response arrives before an older, now-stale one's.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/video-compliance`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: PendingPublication[]; error?: string };
      if (seq !== loadSeq.current) return;
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load the compliance review queue.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the compliance review queue.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function decide(publicationId: string, decision: Decision) {
    let note = '';
    if (decision !== 'approve') {
      const entered = window.prompt(DECISION_PROMPT[decision], '');
      if (entered === null) return;
      note = entered.trim();
      if (!note) {
        setActionMessage(`${DECISION_LABEL[decision]} needs a stated reason -- nothing was recorded.`);
        return;
      }
    }

    setPendingIds((prev) => new Set(prev).add(publicationId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/video-compliance`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publication_id: publicationId, decision, note: note || undefined }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to record the decision.');
      }
      setActionMessage(
        decision === 'approve'
          ? 'Video approved for publication.'
          : decision === 'reject'
            ? 'Video rejected.'
            : 'Changes requested.',
      );
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to record the decision.');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(publicationId);
        return next;
      });
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Video Compliance Review</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.video_publications</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every submission waits here before it can be published. Check for appropriate content, that every
              visible athlete is covered by consent, and for privacy-violating audio -- then approve, reject, or
              request changes. Every decision is logged with who, when, and why.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {actionMessage ? <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p> : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading the review queue…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The queue could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing pending</div>
              <div className="empty-msg">No videos are waiting for compliance review right now.</div>
            </div>
          ) : (
            <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              {items.map((item) => (
                <article
                  key={item.publication_id}
                  className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]"
                >
                  <div className="grid gap-[var(--s5)] md:grid-cols-2">
                    <div>
                      {item.stream_url ? (
                        <video controls src={item.stream_url} className="w-full rounded-[var(--r-md)] bg-black" />
                      ) : (
                        <div className="empty">
                          <div className="empty-glyph" aria-hidden="true">▶</div>
                          <div className="empty-title">Video not playable</div>
                          <div className="empty-msg">The underlying footage isn&rsquo;t in a released state yet.</div>
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="t-eyebrow">{item.title || 'Untitled Video'}</p>
                      {item.compliance_check_status === 'manual_review' ? (
                        <p role="status" className="badge badge--monitor mt-[var(--s2)]">
                          <i>◉</i>Changes were previously requested on this video
                        </p>
                      ) : null}
                      {item.previous_review_note ? (
                        <p className="t-body mt-[var(--s2)] border-l-2 border-[color:var(--brass-300)] pl-[var(--s3)] italic">
                          Previous reviewer note: {item.previous_review_note}
                        </p>
                      ) : null}
                      <p className="t-body mt-[var(--s2)]">{item.description}</p>
                      <dl className="t-body mt-[var(--s3)] grid grid-cols-[auto_1fr] gap-x-[var(--s3)] gap-y-[var(--s1)]">
                        <dt className="text-[color:var(--brass-300)]">Athlete</dt>
                        <dd>{item.athlete_name ?? item.athlete_id}</dd>
                        <dt className="text-[color:var(--brass-300)]">Uploaded by</dt>
                        <dd>{item.uploader_name ?? item.uploader_account_id}</dd>
                        <dt className="text-[color:var(--brass-300)]">Submitted</dt>
                        <dd>{formatDate(item.created_at)}</dd>
                      </dl>
                      <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s2)]">
                        <button
                          type="button"
                          disabled={pendingIds.has(item.publication_id)}
                          onClick={() => void decide(item.publication_id, 'approve')}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={pendingIds.has(item.publication_id)}
                          onClick={() => void decide(item.publication_id, 'request_changes')}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Request Changes
                        </button>
                        <button
                          type="button"
                          disabled={pendingIds.has(item.publication_id)}
                          onClick={() => void decide(item.publication_id, 'reject')}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
