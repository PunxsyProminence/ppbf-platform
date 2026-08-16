'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

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
}

interface OutcomeReview {
  review_id: string;
  performance_result: string;
  performance_notes: string;
  hypothesis_result: string;
  learning_signal: string;
  learning_notes: string;
}

interface ChainItem {
  execution: ExecutionSummary;
  decision_text: string | null;
  evidence: EvidenceLink[];
  review: OutcomeReview | null;
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
  const [reviewForm, setReviewForm] = useState({
    performance_result: 'unknown', performance_notes: '',
    hypothesis_result: 'unresolved', learning_signal: 'unresolved', learning_notes: '',
  });

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

  const post = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return false;
    } finally {
      setBusy(false);
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
      ...reviewForm,
    }, 'Unable to record the review.');
    if (ok) {
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
      <main className="room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
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
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
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
                {items.map(({ execution, decision_text, evidence, review }) => (
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
                                  {link.note ? ` — ${link.note}` : ''}
                                  {link.status === 'removed' ? ` (removed: ${link.removed_reason})` : ''}
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
                          ) : 'Not yet reviewed by a human.'}
                        </dd>
                      </div>
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
                          onClick={() => { setReviewingFor(execution.execution_id); setLinkingFor(null); }}>
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
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
