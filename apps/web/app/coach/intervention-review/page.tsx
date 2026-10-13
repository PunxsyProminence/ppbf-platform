'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDate } from '@/src/lib/gymTime';

// Intervention review (module 026 slice 3): the whole loop on one page --
// DECISION -> PLANNED -> ACTUAL -> WHAT HAPPENED -> WHAT WE LEARNED.
// Every verdict here is a recorded human judgment with three SEPARATE
// answers (performance, hypothesis, learning); the page offers no way to
// collapse them into a score. A miss reviewed honestly is a finding, not
// a failure to hide.

interface ExecutionSummary {
  execution_id: string;
  athlete_name: string | null;
  athlete_id: string;
  protocol_title: string | null;
  protocol_id: string;
  protocol_version: number;
  status: string;
  planned_exposure: Record<string, number>;
  actual_exposure: Record<string, number>;
  adherence: string;
  deviations: string;
  stop_change_reason: string;
  created_at: string;
}

interface EvidenceLink {
  link_id: string;
  evidence_role: string;
  source_kind: string;
  source_id: string;
  note: string;
  status: string;
  removed_reason: string;
  // Computed by the API at read time: false when a film-study source's
  // proposal is not (or no longer) accepted. The row still renders -- links
  // are stamped, never hidden -- it just may not pass for evidence.
  source_admissible: boolean;
}

interface OutcomeReview {
  review_id: string;
  performance_result: string;
  performance_notes: string;
  hypothesis_result: string;
  learning_signal: string;
  learning_notes: string;
}

/* An earlier verdict, kept as history (issue #1481): replaced by a later
   review, or retired when the record was reopened. */
interface RetiredReview extends OutcomeReview {
  retired_on_reopen: boolean;
  retired_at: string;
  reviewed_at: string;
}

interface ChainItem {
  execution: ExecutionSummary;
  decision_text: string | null;
  evidence: EvidenceLink[];
  review: OutcomeReview | null;
  review_history?: RetiredReview[];
}

/* The history line's opening words. Wording PROPOSED for Jason. */
function retiredLabel(entry: RetiredReview): string {
  const when = formatGymDate(entry.retired_at) ?? entry.retired_at;
  return entry.retired_on_reopen
    ? `Retired when the record was reopened, ${when}`
    : `Replaced by a later review, ${when}`;
}

const EVIDENCE_ROLES = [
  'baseline', 'during_intervention', 'immediate_post', 'retention',
  'transfer', 'counterevidence', 'adverse_response', 'context',
];

const SOURCE_KINDS = ['training_attempt', 'readiness', 'assessment', 'film_study', 'activity_log'];

const PERFORMANCE_RESULTS = ['improved', 'unchanged', 'declined', 'mixed', 'unknown'];

const HYPOTHESIS_RESULTS = [
  'supported', 'partially_supported', 'contradicted', 'unresolved', 'confounded', 'insufficient_evidence',
];

const LEARNING_SIGNALS = [
  'prior_belief_strengthened', 'prior_belief_weakened', 'boundary_condition_discovered',
  'intervention_non_response', 'transfer_failure', 'retention_failure',
  'implementation_failure', 'attribution_changed', 'redundant_evidence', 'unresolved',
];

const words = (value: string) => value.replaceAll('_', ' ');

// Shown when a write went through and only the reload after it failed: the
// work is saved, and saying "Failed" would invite doing it twice.
const NOT_REFRESHED = 'The list could not be refreshed. Reload the page to see the latest.';

function exposureText(exposure: Record<string, number>): string {
  const entries = Object.entries(exposure);
  if (entries.length === 0) return 'none recorded';
  return entries.map(([dimension, amount]) => `${words(dimension)}: ${amount}`).join(' · ');
}

export default function InterventionReviewPage() {
  const [items, setItems] = useState<ChainItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkingFor, setLinkingFor] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState({ evidence_role: 'baseline', source_kind: 'training_attempt', source_id: '', note: '' });
  const [reviewingFor, setReviewingFor] = useState<string | null>(null);
  // The verdict this screen was showing when the review form opened (null:
  // none). It goes back with the review, so a verdict someone else recorded
  // since is not replaced unseen.
  const [reviewingOver, setReviewingOver] = useState<string | null>(null);
  const [reviewForm, setReviewForm] = useState({
    performance_result: 'unknown', performance_notes: '',
    hypothesis_result: 'unresolved', learning_signal: 'unresolved', learning_notes: '',
  });
  const [removingLink, setRemovingLink] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-review`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load the review chain.');
    const payload = (await response.json()) as { items?: ChainItem[] };
    setItems(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        if (controller.signal.aborted) return;
        setLoaded(true);
      } catch {
        if (controller.signal.aborted) return;
        setErrorMessage('Unable to load the review chain.');
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  /** Resolves null when the write failed; otherwise what the server answered,
   * and whether the list was read again after it. */
  const send = async (
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    failure: string,
  ): Promise<{ item?: unknown; refreshed: boolean } | null> => {
    setBusy(true);
    let answered: { item?: unknown } = {};
    let refreshed = false;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-review`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      answered = (await response.json().catch(() => ({}))) as { item?: unknown };
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      setBusy(false);
      return null;
    }
    // The write is done from here on. A reload that fails is reported as
    // that, and the caller still closes its form: leaving it open would
    // invite sending the same write again.
    try {
      await reload();
      refreshed = true;
      setErrorMessage(null);
    } catch {
      setErrorMessage(NOT_REFRESHED);
    } finally {
      setBusy(false);
    }
    return { ...answered, refreshed };
  };

  const post = (body: Record<string, unknown>, failure: string) => send('POST', body, failure);

  // Unlinking strikes the association only. The link stays on the record,
  // stamped with the reason; the attempt, assessment or film note it pointed
  // at is not touched by this or by anything the server does with it.
  const handleRemove = async (linkId: string) => {
    const reason = removeReason.trim();
    if (!reason) {
      setErrorMessage('Say why this link no longer counts before removing it.');
      return;
    }
    const ok = await send('PATCH', {
      action: 'remove_evidence',
      link_id: linkId,
      removed_reason: reason,
    }, 'Unable to remove the link.');
    if (ok) {
      // Stamped here as the server stamped it, so the link reads removed even
      // when the reload did not come back. After a good reload it already
      // does, and this changes nothing.
      setItems((current) => current.map((entry) => ({
        ...entry,
        evidence: entry.evidence.map((link) => (link.link_id === linkId && link.status === 'active'
          ? { ...link, status: 'removed', removed_reason: reason }
          : link)),
      })));
      setRemovingLink(null);
      setRemoveReason('');
    }
  };

  const handleLink = async (executionId: string) => {
    if (!linkForm.source_id.trim()) {
      setErrorMessage('Name the source record (its id) to link it.');
      return;
    }
    const ok = await post({
      action: 'link_evidence',
      execution_id: executionId,
      ...linkForm,
    }, 'Unable to link evidence.');
    if (ok) {
      setLinkingFor(null);
      setLinkForm({ evidence_role: 'baseline', source_kind: 'training_attempt', source_id: '', note: '' });
    }
  };

  const handleReview = async (executionId: string) => {
    const ok = await post({
      action: 'review_outcome',
      execution_id: executionId,
      expected_review_id: reviewingOver,
      ...reviewForm,
    }, 'Unable to record the review.');
    if (ok) {
      // When the reload did not come back, the verdict is shown as the server
      // recorded it, so it stands on screen and the next review from this
      // screen names it. When the reload did come back the list is the truth
      // and is left alone: it may already hold a verdict someone else recorded
      // after this one, and this answer is the older of the two.
      const recorded = ok.item as OutcomeReview | undefined;
      if (!ok.refreshed && recorded?.review_id) {
        setItems((current) => current.map((entry) => (entry.execution.execution_id === executionId
          ? { ...entry, review: recorded }
          : entry)));
      }
      setReviewingFor(null);
      setReviewForm({
        performance_result: 'unknown', performance_notes: '',
        hypothesis_result: 'unresolved', learning_signal: 'unresolved', learning_notes: '',
      });
    }
  };

  const select = (
    id: string,
    label: string,
    value: string,
    options: string[],
    onChange: (value: string) => void,
  ) => (
    <div className="field">
      <label className="t-label" htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{words(option)}</option>
        ))}
      </select>
    </div>
  );

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>What We Learned</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The whole loop, one athlete at a time: what was decided, what we planned, what we
              actually did, what the evidence says happened, and what it taught us. Three separate
              answers, never one score — and a miss reviewed honestly is a finding.
            </p>
          </header>

          {errorMessage && (
            <div className={`alert ${errorMessage === NOT_REFRESHED ? 'alert--warning' : 'alert--critical'}`} role="alert">
              <span className="alert-icon" aria-hidden="true">{errorMessage === NOT_REFRESHED ? '▲' : '✕'}</span>
              <div className="alert-body">
                <p className="alert-title">{errorMessage === NOT_REFRESHED ? 'Saved' : 'Failed'}</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loaded && (
            items.length === 0 && !errorMessage ? (
              <div className="mat-leather rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">Nothing to review yet</div>
                  <p className="empty-msg mx-auto">Executions land here once the work is recorded.</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-[var(--s3)]">
                {items.map(({ execution, decision_text, evidence, review, review_history: reviewHistory }) => (
                  <li key={execution.execution_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">
                        {execution.protocol_title ?? execution.protocol_id} (v{execution.protocol_version})
                      </span>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {execution.athlete_name ?? execution.athlete_id} · {execution.status.replaceAll('_', ' ')} · {execution.created_at.slice(0, 10)}
                      </span>
                    </div>

                    <dl className="mt-[var(--s3)] space-y-[var(--s2)]">
                      <div>
                        <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Decision</dt>
                        <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                          {decision_text ?? 'No linked decision — execution recorded directly against the protocol.'}
                        </dd>
                      </div>
                      <div>
                        <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Planned</dt>
                        <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>{exposureText(execution.planned_exposure)}</dd>
                      </div>
                      <div>
                        <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Actually did</dt>
                        <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                          {exposureText(execution.actual_exposure)} — adherence {words(execution.adherence)}
                          {execution.deviations ? ` — ${execution.deviations}` : ''}
                          {execution.stop_change_reason ? ` — stopped: ${execution.stop_change_reason}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>What happened (evidence)</dt>
                        <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                          {evidence.length === 0 ? 'No evidence linked yet.' : (
                            <ul className="space-y-[var(--s1)]">
                              {evidence.map((link) => (
                                <li key={link.link_id}>
                                  <span className={`badge ${link.status === 'removed' ? 'badge--locked' : link.evidence_role === 'counterevidence' || link.evidence_role === 'adverse_response' ? 'badge--locked' : 'badge--monitor'}`}>
                                    <i aria-hidden="true">▪</i>{words(link.evidence_role)}
                                  </span>{' '}
                                  {words(link.source_kind)} {link.source_id}
                                  {link.source_admissible === false && (
                                    <>
                                      {' '}
                                      <span className="badge badge--locked">
                                        <i aria-hidden="true">▪</i>inadmissible — no accepted proposal
                                      </span>
                                    </>
                                  )}
                                  {link.note ? ` — ${link.note}` : ''}
                                  {link.status === 'removed' ? ` (removed: ${link.removed_reason})` : ''}
                                  {link.status === 'active' && removingLink !== link.link_id && (
                                    <>
                                      {' '}
                                      <button type="button" className="btn btn--ghost" disabled={busy}
                                        onClick={() => { setRemovingLink(link.link_id); setRemoveReason(''); }}>
                                        Remove link
                                      </button>
                                    </>
                                  )}
                                  {link.status === 'active' && removingLink === link.link_id && (
                                    <div className="mt-[var(--s2)] flex flex-wrap items-end gap-[var(--s2)]">
                                      <div className="field">
                                        <label className="t-label" htmlFor={`remove-reason-${link.link_id}`}>Why does this no longer count? (required)</label>
                                        <input id={`remove-reason-${link.link_id}`} className="input" value={removeReason}
                                          onChange={(e) => setRemoveReason(e.target.value)} />
                                      </div>
                                      <button type="button" className="btn" disabled={busy}
                                        onClick={() => void handleRemove(link.link_id)}>
                                        {busy ? 'Removing…' : 'Remove it'}
                                      </button>
                                      <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setRemovingLink(null)}>Cancel</button>
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Learned</dt>
                        <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                          {review ? (
                            <>
                              <span className="font-semibold">{words(review.performance_result)}</span>
                              {' — '}{review.performance_notes}
                              <br />
                              Hypothesis: <span className="font-semibold">{words(review.hypothesis_result)}</span>
                              {' · '}Learning: <span className="font-semibold">{words(review.learning_signal)}</span>
                              {review.learning_notes ? ` — ${review.learning_notes}` : ''}
                            </>
                          ) : reviewHistory && reviewHistory.length > 0
                            ? 'No standing verdict since the record was reopened.'
                            : 'Not yet reviewed by a human.'}
                        </dd>
                      </div>
                      {reviewHistory && reviewHistory.length > 0 && (
                        <div>
                          <dt className="t-label" style={{ fontSize: 'var(--t-xs)' }}>Earlier verdicts</dt>
                          <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                            <ul className="space-y-[var(--s1)]">
                              {reviewHistory.map((entry) => (
                                <li key={entry.review_id}>
                                  {retiredLabel(entry)}: {words(entry.performance_result)}
                                  {' — '}{entry.performance_notes}
                                  {' · '}Hypothesis: {words(entry.hypothesis_result)}
                                  {' · '}reviewed {formatGymDate(entry.reviewed_at) ?? entry.reviewed_at}.
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      )}
                    </dl>

                    <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                      {linkingFor !== execution.execution_id && (
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => { setLinkingFor(execution.execution_id); setReviewingFor(null); }}>
                          Link evidence
                        </button>
                      )}
                      {(execution.status === 'completed' || execution.status === 'stopped') && reviewingFor !== execution.execution_id && (
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => {
                            setReviewingFor(execution.execution_id);
                            setReviewingOver(review?.review_id ?? null);
                            setLinkingFor(null);
                          }}>
                          {review ? 'Re-review (supersedes)' : 'Review outcome'}
                        </button>
                      )}
                    </div>

                    {linkingFor === execution.execution_id && (
                      <div className="mt-[var(--s3)] border-t border-[color:var(--hide-800)] pt-[var(--s3)]">
                        <div className="grid gap-[var(--s2)] md:grid-cols-2">
                          {select(`link-role-${execution.execution_id}`, 'Evidence role', linkForm.evidence_role, EVIDENCE_ROLES,
                            (value) => setLinkForm((f) => ({ ...f, evidence_role: value })))}
                          {select(`link-kind-${execution.execution_id}`, 'Source kind', linkForm.source_kind, SOURCE_KINDS,
                            (value) => setLinkForm((f) => ({ ...f, source_kind: value })))}
                          <div className="field">
                            <label className="t-label" htmlFor={`link-source-${execution.execution_id}`}>Source record id</label>
                            <input id={`link-source-${execution.execution_id}`} className="input" value={linkForm.source_id}
                              onChange={(e) => setLinkForm((f) => ({ ...f, source_id: e.target.value }))} />
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`link-note-${execution.execution_id}`}>Note</label>
                            <input id={`link-note-${execution.execution_id}`} className="input" value={linkForm.note}
                              onChange={(e) => setLinkForm((f) => ({ ...f, note: e.target.value }))} />
                          </div>
                        </div>
                        <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                          <button type="button" className="btn" disabled={busy}
                            onClick={() => void handleLink(execution.execution_id)}>
                            {busy ? 'Linking…' : 'Link it'}
                          </button>
                          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setLinkingFor(null)}>Cancel</button>
                        </div>
                      </div>
                    )}

                    {reviewingFor === execution.execution_id && (
                      <div className="mt-[var(--s3)] border-t border-[color:var(--hide-800)] pt-[var(--s3)]">
                        <div className="grid gap-[var(--s2)] md:grid-cols-3">
                          {select(`review-perf-${execution.execution_id}`, 'What happened', reviewForm.performance_result, PERFORMANCE_RESULTS,
                            (value) => setReviewForm((f) => ({ ...f, performance_result: value })))}
                          {select(`review-hyp-${execution.execution_id}`, 'The belief we tested', reviewForm.hypothesis_result, HYPOTHESIS_RESULTS,
                            (value) => setReviewForm((f) => ({ ...f, hypothesis_result: value })))}
                          {select(`review-learn-${execution.execution_id}`, 'What it revealed', reviewForm.learning_signal, LEARNING_SIGNALS,
                            (value) => setReviewForm((f) => ({ ...f, learning_signal: value })))}
                          <div className="field md:col-span-3">
                            <label className="t-label" htmlFor={`review-notes-${execution.execution_id}`}>What happened, in your words (required)</label>
                            <textarea id={`review-notes-${execution.execution_id}`} className="input" rows={2} value={reviewForm.performance_notes}
                              onChange={(e) => setReviewForm((f) => ({ ...f, performance_notes: e.target.value }))} />
                          </div>
                          <div className="field md:col-span-3">
                            <label className="t-label" htmlFor={`review-learning-${execution.execution_id}`}>Learning notes</label>
                            <input id={`review-learning-${execution.execution_id}`} className="input" value={reviewForm.learning_notes}
                              onChange={(e) => setReviewForm((f) => ({ ...f, learning_notes: e.target.value }))} />
                          </div>
                        </div>
                        <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                          <button type="button" className="btn" disabled={busy}
                            onClick={() => void handleReview(execution.execution_id)}>
                            {busy ? 'Recording…' : 'Record review'}
                          </button>
                          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setReviewingFor(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/intervention-executions" className="btn btn--ghost">The Work</Link>{' '}
            <Link href="/coach/intervention-protocols" className="btn btn--ghost">Protocols</Link>{' '}
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
