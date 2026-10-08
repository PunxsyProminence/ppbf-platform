"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * The screen the SHADOW human-review queue never had.
 *
 * WHY THIS EXISTS. The platform writes a ticket to
 * pilot.shadow_human_review_queue for three classes of event, and a ticket is
 * not always a refusal:
 *
 *   - REQUEST-RISK. The classifier marked a member's message high-risk. One
 *     ticket, however the request then went: withheld, answered with a fixed
 *     line, answered by the model, queued for the background worker, or
 *     turned away by a limit or an unavailable mode. Written by the chat
 *     route.
 *   - GENERATED-RESPONSE SAFETY. An answer the model generated was withheld
 *     or replaced by the safety boundary, or asked for a human look, whatever
 *     the question was. Written by the chat route and by the async job
 *     processor.
 *   - OPERATIONAL / FILTER ROWS that already existed, such as the notice
 *     shown when the Library holds no evidence. Not a safety event.
 *
 * When the classifier reads chest_pain, fainting, loss_of_consciousness or
 * urgent_personal_symptom, the chat route writes its tickets at severity
 * 'critical'; the async job processor always writes at 'high'.
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
 * WHAT IT SHOWS OF THE MEMBER'S WORDS: THE ONE EXCHANGE, ON REQUEST, AUDITED.
 * The queue row itself stores a category, a severity, a one-line summary and a
 * small metadata object -- classification, safety reasons, whether the session
 * was athlete-scoped -- and not the member's words. Behind a ticket the
 * reviewer may open exactly the flagged question and its answer
 * (OD-2026-10-07-009 question card 2 item 4, Jason: "That one exchange"),
 * labelled with the asker's role and age band, and nothing else from the chat.
 * The server bounds that read to the one ticket (GET ?reviewId=) and records
 * who read whose exchange in pilot.audit_events before returning it; this page
 * never fetches a conversation, never links to one, and says on the control
 * that the read is recorded. A ticket that cannot name its exchange (written
 * when the request was throttled or queued, or before the async processor
 * recorded its message, or after the chat was purged) says "exchange not
 * recorded".
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

interface ExchangeMessage {
  messageId: string;
  content: string;
  createdAt: string;
}

/** Mirrors ShadowReviewExchange in shadowConversations.ts. */
type ReviewExchange =
  | {
      recorded: true;
      subject: { accountId: string; role: string | null; ageBand: 'under_18' | 'adult' | 'age_not_on_record' };
      userMessage: ExchangeMessage | null;
      assistantMessage: ExchangeMessage & { responseState: 'ok' | 'filtered' | null };
    }
  | { recorded: false; reason: string };

type ExchangeState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; exchange: ReviewExchange };

const AGE_BAND_LABEL: Record<'under_18' | 'adult' | 'age_not_on_record', string> = {
  under_18: 'under 18',
  adult: '18 or over',
  age_not_on_record: 'age not on record — treated as under 18',
};

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
 *
 * The rung and glyph are the design system's badge ladder, the same one
 * /admin/compliance-center uses for violation severity: critical -> locked,
 * high -> restricted, moderate -> monitor. This page first named its own
 * classes (severity-critical, ticket, tabs ...) that no stylesheet ever
 * defined, so it rendered unstyled until it moved onto the shared ones.
 */
const SEVERITY_STYLE: Record<Severity, { label: string; rung: string; glyph: string }> = {
  critical: { label: 'CRITICAL', rung: 'badge--locked', glyph: '✕' },
  high: { label: 'HIGH', rung: 'badge--restricted', glyph: '▲' },
  moderate: { label: 'MODERATE', rung: 'badge--monitor', glyph: '◉' },
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
   * The one exchange behind a ticket, keyed by ticket, loaded only when the
   * reviewer asks for it. Never pre-fetched: each open is an audited read of
   * a member's words, so it happens on a deliberate click and not on render.
   * Cleared when the tab changes, so a re-read is a second audited click.
   */
  const [exchanges, setExchanges] = useState<Record<string, ExchangeState>>({});

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
    setExchanges({});
    setStatus(next);
  }

  /**
   * One ticket, one request, by ticket id only. The route takes nothing else:
   * no message id, no conversation id. A failure is shown on the ticket and
   * the words are not; a second click is a second audited read.
   */
  const openExchange = useCallback(async (reviewId: string) => {
    setExchanges((current) => ({ ...current, [reviewId]: { kind: 'loading' } }));
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/shadow/reviews?reviewId=${encodeURIComponent(reviewId)}`,
        { credentials: 'include' },
      );
      const payload = await response.json().catch(() => ({})) as { exchange?: ReviewExchange; error?: string };
      if (!response.ok || !payload.exchange) {
        setExchanges((current) => ({
          ...current,
          [reviewId]: { kind: 'error', message: payload.error ?? 'Could not read this exchange.' },
        }));
        return;
      }
      setExchanges((current) => ({ ...current, [reviewId]: { kind: 'loaded', exchange: payload.exchange as ReviewExchange } }));
    } catch {
      setExchanges((current) => ({
        ...current,
        [reviewId]: { kind: 'error', message: 'Could not reach the review queue.' },
      }));
    }
  }, []);

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
    <div className="space-y-[var(--s5)]">
      <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
        <h1
          className="t-gothic text-[color:var(--bone-100)]"
          style={{ fontSize: 'var(--t-2xl)' }}
        >
          SHADOW human review
        </h1>
        <p className="t-body mt-[var(--s3)] max-w-4xl">
          {'SHADOW chats sent for a human look. A ticket can come from a high-risk request, a generated answer that was withheld or replaced, or another route condition that needs review — not necessarily because SHADOW failed.'}
        </p>
      </header>

      {status === 'open' && criticalCount > 0 && (
        <p role="status" className="alert alert--critical">
          <span className="alert-icon" aria-hidden="true">✕</span>
          <span className="alert-msg">
            {criticalCount} critical {criticalCount === 1 ? 'ticket' : 'tickets'} waiting.
            Critical means the classifier read chest pain, fainting, loss of
            consciousness, or an urgent personal symptom.
          </span>
        </p>
      )}

      <nav
        className="flex flex-wrap gap-[var(--s3)]"
        aria-label="Review status"
      >
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={tab.value === status ? 'btn' : 'btn btn--ghost'}
            aria-current={tab.value === status ? 'page' : undefined}
            onClick={() => selectStatus(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error && (
        <p role="alert" className="alert alert--critical">
          <span className="alert-icon" aria-hidden="true">✕</span>
          <span className="alert-msg">{error}</span>
        </p>
      )}

      {loading && <p className="t-muted">Loading…</p>}

      {!loading && reviews.length === 0 && !error && (
        <p className="t-muted">
          {status === 'open'
            ? 'Nothing waiting. Tickets appear when SHADOW sends a chat or generated result for human review.'
            : `No ${status.replace('_', ' ')} tickets.`}
        </p>
      )}

      <ul className="space-y-[var(--s4)]">
        {reviews.map((review) => {
          const severity = SEVERITY_STYLE[review.severity] ?? SEVERITY_STYLE.moderate;
          const busy = pending === review.review_id;
          const exchange = exchanges[review.review_id];
          return (
            <li
              key={review.review_id}
              className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]"
            >
              <div className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className={`badge ${severity.rung}`}>
                  <i aria-hidden="true">{severity.glyph}</i>{severity.label}
                </span>
                <span className="t-eyebrow">{review.category.replace(/_/g, ' ')}</span>
                <span className="t-data">{formatWhen(review.created_at)}</span>
              </div>

              <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--bone-100)]">{review.summary}</p>

              <dl className="mt-[var(--s3)] space-y-[var(--s2)]">
                <div>
                  <dt className="t-eyebrow">Account</dt>
                  <dd className="t-data"><code>{review.account_id}</code></dd>
                </div>
                {review.reviewed_by && (
                  <div>
                    <dt className="t-eyebrow">Last touched by</dt>
                    <dd className="t-data">
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
                <details className="mt-[var(--s3)]">
                  <summary className="t-eyebrow cursor-pointer">What the boundary recorded</summary>
                  <pre className="t-data mt-[var(--s2)] overflow-x-auto">{JSON.stringify(review.metadata, null, 2)}</pre>
                </details>
              )}

              {/*
                The one exchange. Opened by a click, never on render; the
                server records the read against the signed-in admin before it
                returns a word. What is rendered is exactly the two messages
                the route returned and the asker's role and age band -- no
                conversation link, no neighbours, no transcript.
              */}
              <section className="mt-[var(--s3)]" aria-label="Flagged exchange">
                {!exchange && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void openExchange(review.review_id)}
                  >
                    Read the flagged exchange — this read is recorded against your account
                  </button>
                )}
                {exchange?.kind === 'loading' && <p className="t-muted">Reading the flagged exchange…</p>}
                {exchange?.kind === 'error' && (
                  <p role="alert" className="alert alert--critical">
                    <span className="alert-icon" aria-hidden="true">✕</span>
                    <span className="alert-msg">{exchange.message}</span>
                  </p>
                )}
                {exchange?.kind === 'loaded' && !exchange.exchange.recorded && (
                  <p className="t-muted">Exchange not recorded — this ticket does not name a stored message.</p>
                )}
                {exchange?.kind === 'loaded' && exchange.exchange.recorded && (
                  <div className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-eyebrow">
                      Asked by: {(exchange.exchange.subject.role ?? 'unknown role').replace(/_/g, ' ')} · {AGE_BAND_LABEL[exchange.exchange.subject.ageBand]}
                    </p>
                    <dl className="mt-[var(--s3)] space-y-[var(--s3)]">
                      <div>
                        <dt className="t-eyebrow">The question</dt>
                        <dd className="t-body whitespace-pre-wrap">
                          {exchange.exchange.userMessage
                            ? exchange.exchange.userMessage.content
                            : 'The question is not stored.'}
                        </dd>
                      </div>
                      <div>
                        <dt className="t-eyebrow">
                          {exchange.exchange.assistantMessage.responseState === 'filtered'
                            ? 'What SHADOW sent instead (the answer was withheld)'
                            : 'What SHADOW answered'}
                        </dt>
                        <dd className="t-body whitespace-pre-wrap">{exchange.exchange.assistantMessage.content}</dd>
                      </div>
                    </dl>
                    <p className="t-muted mt-[var(--s3)]">
                      {formatWhen(exchange.exchange.assistantMessage.createdAt)} · Only this exchange is shown. This read has been recorded.
                    </p>
                  </div>
                )}
              </section>

              {(review.status === 'open' || review.status === 'in_review') && (
                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  {review.status === 'open' && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={busy}
                      onClick={() => void decide(review.review_id, 'in_review')}
                    >
                      I am looking at this
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void decide(review.review_id, 'resolved')}
                  >
                    Resolved — acted on in the gym
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
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
    </div>
  );
}

export default function ShadowReviewsPage() {
  return (
    <RoleStandaloneView
      roleLabel="Admin Workspace"
      routeLabel="/admin/shadow-reviews"
      allowedRoles={['admin']}
      showShellHeader={false}
      room="clinic"
    >
      <ShadowReviewsConsole />
    </RoleStandaloneView>
  );
}
