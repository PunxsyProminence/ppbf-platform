'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';
import { apiBase } from '@/lib/apiBase';
import { RESEARCH_DOMAIN_LABELS, RESEARCH_DOMAINS, type ResearchDomain } from '@/src/server/pilot/shadowResearchSubmissions';

// ── types ──────────────────────────────────────────────────────────────────

type AnswerState =
  | 'needs_evidence'
  | 'sources_submitted'
  | 'evidence_under_review'
  | 'partially_answered'
  | 'resolved';

interface ShadowResearchRequirement {
  research_requirement_id: number;
  source_event_name: string;
  source_entity_type: string;
  source_entity_id: string;
  research_requirement: string;
  knowledge_gap: string;
  evidence_label: string | null;
  source_status: string;
  source_confidence_tier: string;
  source_verification_state: string;
  status: 'open' | 'resolved';
  created_at: string;
  // computed by the UI after loading submissions
  answer_state?: AnswerState;
}

interface ResearchSubmission {
  submission_id: string;
  research_requirement_id: number;
  source_id: string;
  review_verdict: string | null;
  doi: string | null;
  provider_provenance: string | null;
  why_this_source: string | null;
  created_at: string;
}

interface LibrarySource {
  source_id: string;
  title: string;
  publisher: string | null;
  source_type: string;
}

type WorkspaceTab = 'needs_evidence' | 'answer_a_gap' | 'general_research';

// ── constants ──────────────────────────────────────────────────────────────

/* Law 3: every status rung gets a glyph + uppercase label, never bare colour. */
const ANSWER_STATE_BADGES: Record<AnswerState, { className: string; glyph: string; label: string }> = {
  needs_evidence: { className: 'badge badge--monitor', glyph: '◉', label: 'Needs Evidence' },
  sources_submitted: { className: 'badge badge--filed', glyph: '◌', label: 'Sources Submitted' },
  evidence_under_review: { className: 'badge badge--filed', glyph: '◌', label: 'Evidence Under Review' },
  partially_answered: { className: 'badge badge--cleared', glyph: '✓', label: 'Partially Answered' },
  resolved: { className: 'badge badge--cleared', glyph: '✓', label: 'Resolved' },
};

/* A paper-ground caption label. */
const PAPER_LABEL = 'font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]';

// ── answer state computation ──────────────────────────────────────────────
// Must match the server-side computeAnswerState in shadowResearchSubmissions.ts.
// The resolved rung is only reachable from the requirement's own status field;
// submission alone structurally cannot reach it.

function computeAnswerState(
  requirement: Pick<ShadowResearchRequirement, 'status'>,
  submissions: ResearchSubmission[],
): AnswerState {
  if (requirement.status === 'resolved') return 'resolved';
  if (submissions.length === 0) return 'needs_evidence';
  const hasPositive = submissions.some(
    (s) => s.review_verdict === 'relevant' || s.review_verdict === 'partial',
  );
  if (hasPositive) return 'partially_answered';
  const allPending = submissions.every((s) => s.review_verdict === null);
  if (allPending) return 'sources_submitted';
  return 'evidence_under_review';
}

// ── component ─────────────────────────────────────────────────────────────

export default function ResearchWorkspacePage() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('needs_evidence');
  const [requirements, setRequirements] = useState<ShadowResearchRequirement[]>([]);
  const [submissions, setSubmissions] = useState<ResearchSubmission[]>([]);
  const [librarySources, setLibrarySources] = useState<LibrarySource[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  // Answer a Gap form
  const [gapForm, setGapForm] = useState({
    research_requirement_id: '',
    source_id: '',
    doi: '',
    pmid: '',
    provider_provenance: '',
    why_this_source: '',
  });
  const [gapMessage, setGapMessage] = useState('');
  const [gapSubmitting, setGapSubmitting] = useState(false);

  // General Research form
  const [generalForm, setGeneralForm] = useState({
    title: '',
    publisher: '',
    source_type: 'peer_reviewed',
    authority_tier: '3',
    publication_date: '',
    url: '',
    domain_classification: '' as ResearchDomain | '',
  });
  const [generalMessage, setGeneralMessage] = useState('');
  const [generalSubmitting, setGeneralSubmitting] = useState(false);

  // Mark Resolved
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [resolveMessage, setResolveMessage] = useState('');

  // Load requirements and submissions on mount
  useEffect(() => {
    void (async () => {
      try {
        const [reqRes, subRes, srcRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/shadow/research-submissions`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/shadow/library/sources?limit=200`, { credentials: 'include' }),
        ]);

        if (!reqRes.ok) throw new Error('Unable to load research requirements.');

        const reqPayload = (await reqRes.json()) as { items?: ShadowResearchRequirement[] };
        setRequirements(reqPayload.items ?? []);

        if (subRes.ok) {
          const subPayload = (await subRes.json()) as { items?: ResearchSubmission[] };
          setSubmissions(subPayload.items ?? []);
        }

        if (srcRes.ok) {
          const srcPayload = (await srcRes.json()) as { items?: LibrarySource[] };
          setLibrarySources(srcPayload.items ?? []);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load research workspace.');
      }
    })();
  }, []);

  // Attach computed answer states to requirements
  const requirementsWithState = useMemo<ShadowResearchRequirement[]>(() => {
    return requirements.map((req) => {
      const reqSubmissions = submissions.filter(
        (s) => s.research_requirement_id === req.research_requirement_id,
      );
      return { ...req, answer_state: computeAnswerState(req, reqSubmissions) };
    });
  }, [requirements, submissions]);

  const openRequirements = useMemo(
    () => requirementsWithState.filter((r) => r.status === 'open'),
    [requirementsWithState],
  );

  async function handleAnswerGap(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gapForm.research_requirement_id || !gapForm.source_id) {
      setGapMessage('Select a requirement and a source.');
      return;
    }
    setGapSubmitting(true);
    setGapMessage('');
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/research-submissions`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          research_requirement_id: Number(gapForm.research_requirement_id),
          source_id: gapForm.source_id,
          doi: gapForm.doi.trim() || null,
          pmid: gapForm.pmid.trim() || null,
          provider_provenance: gapForm.provider_provenance.trim() || null,
          why_this_source: gapForm.why_this_source.trim() || null,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? 'Unable to file submission.');
      }
      const payload = (await res.json()) as { submission: ResearchSubmission };
      setSubmissions((current) => [payload.submission, ...current]);
      setGapForm({ research_requirement_id: '', source_id: '', doi: '', pmid: '', provider_provenance: '', why_this_source: '' });
      setGapMessage(
        'Source filed. The source answers nothing until evidence review approves it.',
      );
    } catch (error) {
      setGapMessage(error instanceof Error ? error.message : 'Unable to file submission.');
    } finally {
      setGapSubmitting(false);
    }
  }

  async function handleGeneralResearch(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!generalForm.title.trim()) {
      setGeneralMessage('Title is required.');
      return;
    }
    setGeneralSubmitting(true);
    setGeneralMessage('');
    try {
      const metadata: Record<string, unknown> = {};
      if (generalForm.domain_classification) {
        metadata['domain_classification'] = generalForm.domain_classification;
      }
      const res = await fetch(`${apiBase()}/api/pilot/shadow/library/sources`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: generalForm.title.trim(),
          publisher: generalForm.publisher.trim() || null,
          source_type: generalForm.source_type,
          authority_tier: Number(generalForm.authority_tier),
          url: generalForm.url.trim() || null,
          publication_date: generalForm.publication_date.trim() || null,
          metadata,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? 'Unable to register source.');
      }
      const payload = (await res.json()) as { source: LibrarySource };
      setLibrarySources((current) => [payload.source, ...current]);
      setGeneralForm({
        title: '',
        publisher: '',
        source_type: 'peer_reviewed',
        authority_tier: '3',
        publication_date: '',
        url: '',
        domain_classification: '',
      });
      setGeneralMessage(
        'Research registered. It is not citable until a reviewer approves and indexes it. It can be linked to a requirement gap later.',
      );
    } catch (error) {
      setGeneralMessage(error instanceof Error ? error.message : 'Unable to register source.');
    } finally {
      setGeneralSubmitting(false);
    }
  }

  async function handleResolve(researchRequirementId: number) {
    setResolvingId(researchRequirementId);
    setResolveMessage('');
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          research_requirement_id: researchRequirementId,
          metadata: { resolved_from: 'research_workspace' },
        }),
      });
      if (!res.ok) throw new Error('Unable to resolve requirement.');
      setRequirements((current) =>
        current.map((r) =>
          r.research_requirement_id === researchRequirementId ? { ...r, status: 'resolved' } : r,
        ),
      );
      setResolveMessage('Requirement resolved.');
    } catch (error) {
      setResolveMessage(error instanceof Error ? error.message : 'Unable to resolve requirement.');
    } finally {
      setResolvingId(null);
    }
  }

  const tabs: { key: WorkspaceTab; label: string; count?: number }[] = [
    { key: 'needs_evidence', label: 'Needs Evidence', count: openRequirements.length },
    { key: 'answer_a_gap', label: 'Answer a Gap' },
    { key: 'general_research', label: 'General Research' },
  ];

  return (
    /* Room--file: the research wall. */
    <main className="room--file min-h-screen bg-[var(--hide-950)]">
      <header className="mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">SHADOW</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Research Workspace
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              See open knowledge gaps, submit evidence against them, and register general research for later review.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Research Workspace" />
            <Link href="/research/chat" className="btn btn--ghost">
              Q&amp;A Chat
            </Link>
            <Link href="/evidence" className="btn btn--ghost">
              Evidence Review
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="research" />

        {errorMessage ? (
          <section role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked"><i>✕</i>Workspace Unavailable</span>
            <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
          </section>
        ) : null}

        {/* Tab bar */}
        <nav aria-label="Research workspace tabs" className="flex gap-[var(--s2)] border-b border-[color:rgba(212,175,74,.22)]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={[
                'btn btn--ghost px-[var(--s4)] pb-[var(--s3)]',
                activeTab === tab.key ? 'border-b-2 border-[color:var(--brass-400)]' : '',
              ].join(' ')}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="ml-[var(--s2)] badge badge--monitor">{tab.count}</span>
              ) : null}
            </button>
          ))}
        </nav>

        {/* ── Tab 1: Needs Evidence ── */}
        {activeTab === 'needs_evidence' ? (
          <section className="space-y-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Open Research Requirements
            </h2>
            {resolveMessage ? (
              <p className="t-muted" role="status">{resolveMessage}</p>
            ) : null}
            {requirementsWithState.length === 0 ? (
              <div className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
                <p className={PAPER_LABEL}>Empty State</p>
                <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">
                  No research requirements yet. SHADOW will add them when it encounters knowledge gaps.
                </p>
              </div>
            ) : openRequirements.length === 0 ? (
              <div className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
                <p className={PAPER_LABEL}>All Resolved</p>
                <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">
                  All research requirements are resolved.
                </p>
              </div>
            ) : null}
            <div className="grid gap-[var(--s4)] lg:grid-cols-2">
              {openRequirements.map((req) => {
                const state = req.answer_state ?? 'needs_evidence';
                const badge = ANSWER_STATE_BADGES[state];
                const reqSubmissions = submissions.filter(
                  (s) => s.research_requirement_id === req.research_requirement_id,
                );
                return (
                  <article key={req.research_requirement_id} className="relative mat-paper rounded-[var(--r-sm)] p-[var(--s5)]">
                    <span className="pin pin--brass" aria-hidden="true" />
                    <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                      <p className="t-typed text-[length:var(--t-md)] font-bold">{req.source_event_name}</p>
                      <span className={badge.className}>
                        <i>{badge.glyph}</i>
                        {badge.label}
                      </span>
                    </div>
                    <dl className="mt-[var(--s4)] grid gap-x-[var(--s4)] gap-y-[var(--s3)] sm:grid-cols-2">
                      <div>
                        <dt className={PAPER_LABEL}>Requirement</dt>
                        <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">
                          {req.research_requirement || 'Not provided'}
                        </dd>
                      </div>
                      <div>
                        <dt className={PAPER_LABEL}>Knowledge Gap</dt>
                        <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">
                          {req.knowledge_gap || 'Not provided'}
                        </dd>
                      </div>
                      {req.evidence_label ? (
                        <div>
                          <dt className={PAPER_LABEL}>Evidence Label</dt>
                          <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{req.evidence_label}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className={PAPER_LABEL}>Sources Filed</dt>
                        <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{reqSubmissions.length}</dd>
                      </div>
                    </dl>
                    <div className="mt-[var(--s4)] flex flex-wrap items-center justify-between gap-[var(--s3)] border-t border-[color:rgba(51,41,27,.26)] pt-[var(--s4)]">
                      {req.status === 'open' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setGapForm((f) => ({
                                ...f,
                                research_requirement_id: String(req.research_requirement_id),
                              }));
                              setActiveTab('answer_a_gap');
                            }}
                            className="btn"
                          >
                            Answer This Gap
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleResolve(req.research_requirement_id)}
                            disabled={resolvingId === req.research_requirement_id}
                            className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {resolvingId === req.research_requirement_id ? 'Resolving…' : 'Mark Resolved'}
                          </button>
                        </>
                      ) : (
                        <p className={PAPER_LABEL}>Resolved</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* ── Tab 2: Answer a Gap ── */}
        {activeTab === 'answer_a_gap' ? (
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Answer a Gap
            </h2>
            <p className="t-body max-w-[64ch]">
              Pick an open requirement, select a registered library source, and attach provenance.
              The source answers nothing until evidence review approves it.
            </p>
            <form onSubmit={handleAnswerGap} className="space-y-[var(--s4)]">
              <label className="field">
                <span className="t-label">Open requirement</span>
                <select
                  value={gapForm.research_requirement_id}
                  onChange={(e) => setGapForm((f) => ({ ...f, research_requirement_id: e.target.value }))}
                  className="input"
                  required
                >
                  <option value="">— select a requirement —</option>
                  {openRequirements.map((req) => (
                    <option key={req.research_requirement_id} value={String(req.research_requirement_id)}>
                      #{req.research_requirement_id} — {req.research_requirement.slice(0, 80)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="t-label">Library source</span>
                <select
                  value={gapForm.source_id}
                  onChange={(e) => setGapForm((f) => ({ ...f, source_id: e.target.value }))}
                  className="input"
                  required
                >
                  <option value="">— select a source —</option>
                  {librarySources.map((src) => (
                    <option key={src.source_id} value={src.source_id}>
                      {src.title} {src.publisher ? `(${src.publisher})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                <label className="field">
                  <span className="t-label">DOI <span className="t-muted">(optional)</span></span>
                  <input
                    value={gapForm.doi}
                    onChange={(e) => setGapForm((f) => ({ ...f, doi: e.target.value }))}
                    className="input"
                    placeholder="10.xxxx/xxxxx"
                  />
                </label>
                <label className="field">
                  <span className="t-label">PMID <span className="t-muted">(optional)</span></span>
                  <input
                    value={gapForm.pmid}
                    onChange={(e) => setGapForm((f) => ({ ...f, pmid: e.target.value }))}
                    className="input"
                    placeholder="PubMed ID"
                  />
                </label>
              </div>
              <label className="field">
                <span className="t-label">Source / provider provenance <span className="t-muted">(optional)</span></span>
                <input
                  value={gapForm.provider_provenance}
                  onChange={(e) => setGapForm((f) => ({ ...f, provider_provenance: e.target.value }))}
                  className="input"
                  placeholder="e.g. Penn State Library"
                />
              </label>
              <label className="field">
                <span className="t-label">Why this source? <span className="t-muted">(optional)</span></span>
                <textarea
                  value={gapForm.why_this_source}
                  onChange={(e) => setGapForm((f) => ({ ...f, why_this_source: e.target.value }))}
                  className="textarea h-[89px]"
                  placeholder="How does this source address the knowledge gap?"
                />
              </label>
              <div className="flex flex-wrap items-center gap-[var(--s4)]">
                <button type="submit" disabled={gapSubmitting} className="btn disabled:cursor-not-allowed disabled:opacity-60">
                  {gapSubmitting ? 'Filing…' : 'File Submission'}
                </button>
                {gapMessage ? (
                  <p className="t-muted" role="status">{gapMessage}</p>
                ) : null}
              </div>
            </form>
          </section>
        ) : null}

        {/* ── Tab 3: General Research ── */}
        {activeTab === 'general_research' ? (
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              General Research
            </h2>
            <p className="t-body max-w-[64ch]">
              Register useful research not yet requested by an open gap. Provenance and domain
              classification are preserved. The source is not citable until reviewed and approved.
              It can be linked to a requirement gap after registration.
            </p>
            <form onSubmit={handleGeneralResearch} className="space-y-[var(--s4)]">
              <label className="field">
                <span className="t-label">Title <span className="t-muted">(required)</span></span>
                <input
                  value={generalForm.title}
                  onChange={(e) => setGeneralForm((f) => ({ ...f, title: e.target.value }))}
                  className="input"
                  placeholder="Source title"
                  required
                />
              </label>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                <label className="field">
                  <span className="t-label">Publisher / journal</span>
                  <input
                    value={generalForm.publisher}
                    onChange={(e) => setGeneralForm((f) => ({ ...f, publisher: e.target.value }))}
                    className="input"
                    placeholder="Publisher or journal name"
                  />
                </label>
                <label className="field">
                  <span className="t-label">Publication date</span>
                  <input
                    type="date"
                    value={generalForm.publication_date}
                    onChange={(e) => setGeneralForm((f) => ({ ...f, publication_date: e.target.value }))}
                    className="input"
                  />
                </label>
              </div>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                <label className="field">
                  <span className="t-label">Source type</span>
                  <select
                    value={generalForm.source_type}
                    onChange={(e) => setGeneralForm((f) => ({ ...f, source_type: e.target.value }))}
                    className="input"
                  >
                    <option value="peer_reviewed">Peer Reviewed</option>
                    <option value="clinical_guideline">Clinical Guideline</option>
                    <option value="governing_body">Governing Body</option>
                    <option value="textbook">Textbook</option>
                    <option value="internal_policy">Internal Policy</option>
                    <option value="coach_observation">Coach Observation</option>
                    <option value="athlete_self_report">Athlete Self Report</option>
                    <option value="sensor_data">Sensor Data</option>
                    <option value="media">Media</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="field">
                  <span className="t-label">Authority tier (1–5)</span>
                  <select
                    value={generalForm.authority_tier}
                    onChange={(e) => setGeneralForm((f) => ({ ...f, authority_tier: e.target.value }))}
                    className="input"
                  >
                    <option value="1">1 — Highest</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5 — Lowest</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span className="t-label">Domain classification <span className="t-muted">(human-picked, correctable)</span></span>
                <select
                  value={generalForm.domain_classification}
                  onChange={(e) => setGeneralForm((f) => ({ ...f, domain_classification: e.target.value as ResearchDomain | '' }))}
                  className="input"
                >
                  <option value="">— select a domain —</option>
                  {RESEARCH_DOMAINS.map((domain) => (
                    <option key={domain} value={domain}>
                      {RESEARCH_DOMAIN_LABELS[domain]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="t-label">URL <span className="t-muted">(optional)</span></span>
                <input
                  value={generalForm.url}
                  onChange={(e) => setGeneralForm((f) => ({ ...f, url: e.target.value }))}
                  className="input"
                  placeholder="https://…"
                />
              </label>
              <div className="flex flex-wrap items-center gap-[var(--s4)]">
                <button type="submit" disabled={generalSubmitting} className="btn disabled:cursor-not-allowed disabled:opacity-60">
                  {generalSubmitting ? 'Registering…' : 'Register Source'}
                </button>
                {generalMessage ? (
                  <p className="t-muted" role="status">{generalMessage}</p>
                ) : null}
              </div>
            </form>
          </section>
        ) : null}
      </div>
    </main>
  );
}
