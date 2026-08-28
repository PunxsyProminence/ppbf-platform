"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * The screen the SHADOW human-review queue never had.
 *
 * WHY THIS EXISTS. When a member's chat trips the safety boundary, the platform
 * writes a ticket to pilot.shadow_human_review_queue -- and when the classifier
 * reads chest_pain, fainting, loss_of_consciousness or urgent_personal_symptom,
 * it writes that ticket at severity 'critical'. Two live paths do it: the chat
 * route's pre- and post-generation boundaries, and the async job processor.
 *
 * The route to read and triage those tickets
 * (app/api/pilot/shadow/reviews, GET + PATCH) shipped with them and was
 * correct. Nothing ever called it. The SHADOW admin console fetches thirteen
 * endpoints and this was not among them -- /api/pilot/shadow/review-projection,
 * which it does fetch, is a different queue entirely (intake cases and
 * documents). /api/pilot/shadow/metrics counted these rows without showing one.
 *
 * So the escalation fired, the record was durable and correct, and no human was
 * ever shown it. This page is the missing half.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. The queue stores a category, a severity,
 * a one-line summary and a small metadata object -- classification, safety
 * reasons, whether the session was athlete-scoped. It does NOT store the
 * member's words, and this page does not go looking for them. A reviewer needs
 * to know that a child raised something the boundary refused to answer, and to
 * act on it in the room; they do not need the transcript to do that, and
 * putting a door to it here would turn a safeguarding queue into a reading
 * surface. If a conversation genuinely has to be read, that is a separate,
 * audited decision and belongs behind its own route.
 *
 * ORDERING is the server's, not this page's: listHumanReviews sorts
 * critical -> high -> moderate, then oldest first within a severity. The oldest
 * critical ticket is the first row on screen, which is the only ordering a
 * triage queue can defensibly have.
 */

type ReviewStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';
type Severity = 'critical' | 'high' | 'moderate';

interface HumanReview {
  review_id: string;
  conversation_id: string | null;
  account_id: string;
  category: string;
  severity: Severity;
  summary: string;
  status: ReviewStatus;
  metadata: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const STATUS_TABS: { value: ReviewStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'in_review', label: 'In review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

/**
 * Severity is the whole point of the ordering, so it is rendered as a word and
 * a colour rather than a colour alone -- a reviewer scanning on a phone in a
 * gym should not have to distinguish two similar reds.
 */
const SEVERITY_STYLE: Record<Severity, { label: string; className: string }> = {
  critical: { label: 'CRITICAL', className: 'severity-critical' },
  high: { label: 'HIGH', className: 'severity-high' },
  moderate: { label: 'MODERATE', className: 'severity-moderate' },
};

function formatWhen(value: string | null): string {
  if (!value) return '--';
  return formatGymDateTimeShort(value) ?? value;
}

function ShadowReviewsConsole() {
  const [status, setStatus] = useState<ReviewStatus>('open');
  const [reviews, setReviews] = useState<HumanReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  /**
   * Which fetch the page is currently willing to believe. Tabs make the reads
   * racy: click Open then Resolved quickly and the slower Open response can
   * land second, painting open tickets under the Resolved tab. On a
   * safeguarding queue that is not a cosmetic glitch -- it is a reviewer
   * reading unactioned criticals as already dealt with. Each load claims a
   * number and only the newest claim is allowed to write.
   */
  const requestRef = useRef(0);

  /**
   * Nothing here sets state before the first await, deliberately: this runs
   * from an effect, and a synchronous setState in an effect cascades renders.
   * Entering the loading state is the caller's job -- the initial state covers
   * the first paint, and the tab handler covers every switch after it.
   */
  const load = useCallback(async (which: ReviewStatus) => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/shadow/reviews?status=${encodeURIComponent(which)}`,
        { credentials: 'include' },
      );
      const payload = await response.json() as { reviews?: HumanReview[]; error?: string };
      if (ticket !== requestRef.current) return;
      if (!response.ok) {
        setError(payload.error ?? 'Could not load the review queue.');
        setReviews([]);
        return;
      }
      setReviews(payload.reviews ?? []);
      setError(null);
    } catch {
      if (ticket !== requestRef.current) return;
      setError('Could not reach the review queue.');
      setReviews([]);
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, []);

  // Awaited inside the effect rather than called bare, which is the shape the
  // set-state-in-effect rule reads as safe. It is not a formality here: `load`
  // really does reach its first await before it touches state, so no render
  // cascades off this effect.
  useEffect(() => {
    void (async () => {
      await load(status);
    })();
  }, [load, status]);

  function selectStatus(next: ReviewStatus) {
    if (next === status) return;
    setLoading(true);
    setError(null);
    setStatus(next);
  }

  /**
   * The three transitions the route accepts. 'open' is not among them: a ticket
   * becomes open by being written, and nothing re-opens one from here, so a
   * reviewer cannot quietly undo someone else's resolution.
   */
  const decide = useCallback(
    async (reviewId: string, next: 'in_review' | 'resolved' | 'dismissed') => {
      setPending(reviewId);
      setError(null);
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/reviews`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewId, status: next }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string };
          setError(payload.error ?? 'That change was refused.');
          return;
        }
        await load(status);
      } catch {
        setError('Could not reach the review queue.');
      } finally {
        setPending(null);
      }
    },
    [load, status],
  );

  const criticalCount = reviews.filter((r) => r.severity === 'critical').length;

  return (
    <main className="shadow-reviews">
      <header>
        <h1>SHADOW human review</h1>
        <p className="lede">
          Chats the safety boundary refused to answer. A ticket here means a person
          raised something the assistant would not handle on its own — not that the
          assistant failed.
        </p>
      </header>

      {status === 'open' && criticalCount > 0 && (
        <p className="critical-banner" role="status">
          {criticalCount} critical {criticalCount === 1 ? 'ticket' : 'tickets'} waiting.
          Critical means the classifier read chest pain, fainting, loss of
          consciousness, or an urgent personal symptom.
        </p>
      )}

      <nav className="tabs" aria-label="Review status">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={tab.value === status ? 'tab tab-active' : 'tab'}
            aria-current={tab.value === status ? 'page' : undefined}
            onClick={() => selectStatus(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error && <p className="error" role="alert">{error}</p>}

      {loading && <p className="muted">Loading…</p>}

      {!loading && reviews.length === 0 && !error && (
        <p className="muted">
          {status === 'open'
            ? 'Nothing waiting. Tickets appear here the moment the boundary withholds an answer.'
            : `No ${status.replace('_', ' ')} tickets.`}
        </p>
      )}

      <ul className="queue">
        {reviews.map((review) => {
          const severity = SEVERITY_STYLE[review.severity] ?? SEVERITY_STYLE.moderate;
          const busy = pending === review.review_id;
          return (
            <li key={review.review_id} className={`ticket ${severity.className}`}>
              <div className="ticket-head">
                <span className="severity-badge">{severity.label}</span>
                <span className="category">{review.category.replace(/_/g, ' ')}</span>
                <span className="when">{formatWhen(review.created_at)}</span>
              </div>

              <p className="summary">{review.summary}</p>

              <dl className="facts">
                <div>
                  <dt>Account</dt>
                  <dd><code>{review.account_id}</code></dd>
                </div>
                {review.reviewed_by && (
                  <div>
                    <dt>Last touched by</dt>
                    <dd>
                      <code>{review.reviewed_by}</code> · {formatWhen(review.reviewed_at)}
                    </dd>
                  </div>
                )}
              </dl>

              {/*
                The metadata is rendered as-is and is small by construction --
                classification, safety reasons, session type, athlete-scoped
                flag. It carries no message text. Rendering it verbatim keeps
                this page honest about exactly what the platform recorded,
                rather than paraphrasing it into something that reads as more
                or less than it is.
              */}
              {review.metadata && Object.keys(review.metadata).length > 0 && (
                <details className="meta">
                  <summary>What the boundary recorded</summary>
                  <pre>{JSON.stringify(review.metadata, null, 2)}</pre>
                </details>
              )}

              {(review.status === 'open' || review.status === 'in_review') && (
                <div className="actions">
                  {review.status === 'open' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(review.review_id, 'in_review')}
                    >
                      I am looking at this
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(review.review_id, 'resolved')}
                  >
                    Resolved — acted on in the gym
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void decide(review.review_id, 'dismissed')}
                  >
                    Dismiss — nothing to act on
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}

export default function ShadowReviewsPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <ShadowReviewsConsole />
    </RoleSessionGate>
  );
}
