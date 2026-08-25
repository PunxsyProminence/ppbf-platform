'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ShadowChatButton from '@/components/ShadowChatButton';
import { apiBase } from '@/lib/apiBase';
import {
  RESEARCH_CLASSIFICATION_DOMAINS,
  researchClassificationLabel,
} from '@/src/shared/researchClassification';

interface ShadowResearchItem {
  event_id: number;
  requirement: string | null;
  knowledge_gap: string | null;
  evidence_label: string | null;
  source_status: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  source_event_name: string;
  created_at: string;
}

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
}

/* Law 3: a review state is a queue outcome -- glyph + uppercase label on the
   status ladder, never a bare lowercase word or colour alone. */
const REVIEW_STATE_BADGES: Record<ShadowResearchItem['review_state'], { className: string; glyph: string; label: string }> = {
  pending_review: { className: 'badge badge--monitor', glyph: '◉', label: 'Pending Review' },
  approved: { className: 'badge badge--cleared', glyph: '✓', label: 'Approved' },
  rejected: { className: 'badge badge--locked', glyph: '✕', label: 'Rejected' },
  promoted: { className: 'badge badge--cleared', glyph: '✓', label: 'Promoted' },
  /* The sheet's own administrative rung (badge--filed) replaced the
     hand-rolled chip this entry used to carry -- same ◌, same job. */
  unknown: { className: 'badge badge--filed', glyph: '◌', label: 'Unknown' },
};

/* A paper-ground caption label. The sheet's .t-label is tuned for leather
   (bone ink); on paper the same caption needs dark ink. */
const PAPER_LABEL = 'font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]';

/* Issue #345's answer-state ladder, computed server-side from the submission
   links. Deliberately incapable of 'resolved' on its own: that rung reads
   the requirement's own status, which only the human Mark Resolved changes. */
type AnswerState = 'needs_evidence' | 'sources_submitted' | 'evidence_under_review' | 'partially_answered' | 'resolved';

const ANSWER_STATE_BADGES: Record<AnswerState, { className: string; glyph: string; label: string }> = {
  needs_evidence: { className: 'badge badge--restricted', glyph: '▲', label: 'Needs Evidence' },
  sources_submitted: { className: 'badge badge--monitor', glyph: '◉', label: 'Sources Submitted' },
  evidence_under_review: { className: 'badge badge--monitor', glyph: '◉', label: 'Evidence Under Review' },
  partially_answered: { className: 'badge badge--restricted', glyph: '▲', label: 'Partially Answered' },
  resolved: { className: 'badge badge--cleared', glyph: '✓', label: 'Resolved' },
};

interface LibrarySourceOption {
  source_id: string;
  title: string;
  source_type: string;
  metadata?: { general_research?: boolean; classification_domain?: string };
}

const GENERAL_SOURCE_TYPES = [
  'peer_reviewed', 'clinical_guideline', 'governing_body', 'textbook', 'media', 'other',
] as const;

export default function ResearchIntakePage() {
  const [items, setItems] = useState<ShadowResearchItem[]>([]);
  const [projectionLoading, setProjectionLoading] = useState(true);
  const [requirements, setRequirements] = useState<ShadowResearchRequirement[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [requirementDraft, setRequirementDraft] = useState({
    sourceEventName: 'MANUAL_RESEARCH_NOTE',
    sourceEntityType: 'manual_note',
    sourceEntityId: '',
    researchRequirement: '',
    knowledgeGap: '',
  });
  const [submitMessage, setSubmitMessage] = useState('');
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  // Issue #345 slice 2: the computed ladder per requirement, the curator's
  // source list (null until the sources read succeeds -- a 403 simply leaves
  // the Answer-a-Gap panel unrendered, matching the POST's own gate), and
  // the per-requirement answer draft.
  const [answerStates, setAnswerStates] = useState<Record<string, AnswerState>>({});
  const [curatorSources, setCuratorSources] = useState<LibrarySourceOption[] | null>(null);
  const [answeringId, setAnsweringId] = useState<number | null>(null);
  const [answerDraft, setAnswerDraft] = useState({ sourceId: '', doi: '', provider: '', note: '' });
  const [answerBusy, setAnswerBusy] = useState(false);
  // Scoped to one requirement so a message from card A never renders under
  // card B when several gaps are open at once.
  const [answerMessage, setAnswerMessage] = useState<{ forId: number; text: string } | null>(null);
  // Issue #345 workflow 3: general research intake. Classification is a
  // human-picked filing label in source metadata -- no gate, tier, or review
  // state is touched by anything in this section.
  const [generalDraft, setGeneralDraft] = useState({
    title: '', sourceType: 'peer_reviewed', url: '', classification: '', doi: '', provider: '', filename: '',
  });
  const [generalBusy, setGeneralBusy] = useState(false);
  const [generalMessage, setGeneralMessage] = useState('');
  const [reclassifyingId, setReclassifyingId] = useState<string | null>(null);
  // The correction list reads a SERVER-FILTERED general-research page, not a
  // client-side sift of the newest-200 overall list -- in a corpus of
  // thousands, a general source would otherwise fall out of the window and
  // become uncorrectable from the workspace. The 200 cap now bounds general
  // registrations only, which are curator-entered and few.
  const [generalSources, setGeneralSources] = useState<LibrarySourceOption[]>([]);

  const refreshAnswerStates = async (requirementIds: number[]) => {
    if (requirementIds.length === 0) {
      setAnswerStates({});
      return;
    }
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/shadow/research-submissions?research_requirement_ids=${requirementIds.join(',')}`,
        { credentials: 'include' },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { answer_states?: Record<string, AnswerState> };
      setAnswerStates(payload.answer_states ?? {});
    } catch {
      // The ladder is enrichment; the inbox stays useful without it.
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/research-projection`, {
        credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 120 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW research projection.');
        }

        const payload = (await response.json()) as { items?: ShadowResearchItem[] };
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW research projection.');
      } finally {
        setProjectionLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, { credentials: 'include' });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW research requirements.');
        }

        const payload = (await response.json()) as { items?: ShadowResearchRequirement[] };
        const loaded = payload.items ?? [];
        setRequirements(loaded);
        await refreshAnswerStates(loaded.map((item) => item.research_requirement_id));
      } catch {
        setRequirements([]);
      }
    })();
  }, []);

  // One probe decides whether this viewer curates: the sources list is gated
  // by the same roles as the submission POST, so a 403 here means the panel
  // would be refused anyway and is not rendered at all.
  const fetchSources = async (signal?: AbortSignal, generalOnly = false) => {
    const filter = generalOnly ? '&general_research=true' : '';
    const response = await fetch(`${apiBase()}/api/pilot/shadow/library/sources?limit=200${filter}`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { sources?: LibrarySourceOption[]; items?: LibrarySourceOption[] };
    return payload.sources ?? payload.items ?? [];
  };

  const refreshGeneralSources = async () => {
    const general = await fetchSources(undefined, true);
    if (general !== null) setGeneralSources(general);
  };

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const sources = await fetchSources(controller.signal);
        if (sources !== null && !controller.signal.aborted) {
          setCuratorSources(sources);
          const general = await fetchSources(controller.signal, true);
          if (general !== null && !controller.signal.aborted) setGeneralSources(general);
        }
      } catch {
        // Not a curator (or offline, or unmounted): the read-only workspace stands.
      }
    })();
    return () => controller.abort();
  }, []);

  async function handleRegisterGeneral() {
    if (!generalDraft.title.trim() || !generalDraft.classification) {
      setGeneralMessage('A title and a classification domain are required.');
      return;
    }
    setGeneralBusy(true);
    try {
      const provenance: Record<string, string> = {};
      if (generalDraft.doi.trim()) provenance.doi_or_pmid = generalDraft.doi.trim();
      if (generalDraft.provider.trim()) provenance.provider = generalDraft.provider.trim();
      if (generalDraft.filename.trim()) provenance.original_filename = generalDraft.filename.trim();

      const response = await fetch(`${apiBase()}/api/pilot/shadow/library/sources`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: generalDraft.title.trim(),
          source_type: generalDraft.sourceType,
          url: generalDraft.url.trim() || null,
          metadata: {
            general_research: true,
            classification_domain: generalDraft.classification,
            provenance,
          },
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Registration failed (${response.status})`);
      }
      setGeneralDraft({ title: '', sourceType: 'peer_reviewed', url: '', classification: '', doi: '', provider: '', filename: '' });
      setGeneralMessage('Source registered and classified. Evidence review still decides what becomes citable.');
      const sources = await fetchSources();
      if (sources !== null) setCuratorSources(sources);
      await refreshGeneralSources();
    } catch (error) {
      setGeneralMessage(error instanceof Error ? error.message : 'Unable to register the source.');
    } finally {
      setGeneralBusy(false);
    }
  }

  async function handleReclassify(sourceId: string, classificationDomain: string) {
    setReclassifyingId(sourceId);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/library/sources`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, classification_domain: classificationDomain }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Reclassification failed (${response.status})`);
      }
      await refreshGeneralSources();
      setGeneralMessage('Classification corrected.');
    } catch (error) {
      setGeneralMessage(error instanceof Error ? error.message : 'Unable to correct the classification.');
    } finally {
      setReclassifyingId(null);
    }
  }

  async function handleAnswerGap(requirementId: number) {
    if (!answerDraft.sourceId) {
      setAnswerMessage({ forId: requirementId, text: 'Pick the library source that answers this requirement.' });
      return;
    }
    setAnswerBusy(true);
    try {
      const provenance: Record<string, string> = {};
      if (answerDraft.doi.trim()) provenance.doi_or_pmid = answerDraft.doi.trim();
      if (answerDraft.provider.trim()) provenance.provider = answerDraft.provider.trim();

      const response = await fetch(`${apiBase()}/api/pilot/shadow/research-submissions`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          research_requirement_id: requirementId,
          source_id: answerDraft.sourceId,
          provenance,
          submission_note: answerDraft.note.trim(),
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Submission failed (${response.status})`);
      }
      setAnsweringId(null);
      setAnswerDraft({ sourceId: '', doi: '', provider: '', note: '' });
      setAnswerMessage({ forId: requirementId, text: 'Source submitted. It answers nothing until evidence review says so.' });
      await refreshAnswerStates(requirements.map((item) => item.research_requirement_id));
    } catch (error) {
      setAnswerMessage({ forId: requirementId, text: error instanceof Error ? error.message : 'Unable to submit the source.' });
    } finally {
      setAnswerBusy(false);
    }
  }

  const counts = useMemo(() => {
    return {
      pending: items.filter((item) => item.review_state === 'pending_review').length,
      approved: items.filter((item) => item.review_state === 'approved').length,
      rejected: items.filter((item) => item.review_state === 'rejected').length,
      promoted: items.filter((item) => item.review_state === 'promoted').length,
    };
  }, [items]);

  async function handleCreateRequirement(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();

    const sourceEntityId = requirementDraft.sourceEntityId.trim() || `manual-${Date.now()}`;

    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_event_name: requirementDraft.sourceEventName,
          source_entity_type: requirementDraft.sourceEntityType,
          source_entity_id: sourceEntityId,
          research_requirement: requirementDraft.researchRequirement,
          knowledge_gap: requirementDraft.knowledgeGap,
          source_status: 'observed',
          source_confidence_tier: 'SUFFICIENT_FOR_REVIEW',
          source_verification_state: 'unverified',
          metadata: { created_from: 'research_page' },
        }),
      });

      if (!response.ok) {
        throw new Error('Unable to create SHADOW research requirement.');
      }

      const payload = (await response.json()) as { research_requirement_id?: number };
      setRequirements((current) => [
        {
          research_requirement_id: payload.research_requirement_id ?? Date.now(),
          source_event_name: requirementDraft.sourceEventName,
          source_entity_type: requirementDraft.sourceEntityType,
          source_entity_id: sourceEntityId,
          research_requirement: requirementDraft.researchRequirement,
          knowledge_gap: requirementDraft.knowledgeGap,
          evidence_label: null,
          source_status: 'observed',
          source_confidence_tier: 'SUFFICIENT_FOR_REVIEW',
          source_verification_state: 'unverified',
          status: 'open',
          created_at: new Date().toISOString(),
        },
        ...current,
      ]);
      setRequirementDraft({
        sourceEventName: 'MANUAL_RESEARCH_NOTE',
        sourceEntityType: 'manual_note',
        sourceEntityId: '',
        researchRequirement: '',
        knowledgeGap: '',
      });
      setSubmitMessage('Research requirement saved.');
    } catch (error) {
      setSubmitMessage(error instanceof Error ? error.message : 'Unable to create SHADOW research requirement.');
    }
  }

  async function handleResolveRequirement(researchRequirementId: number) {
    setResolvingId(researchRequirementId);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          research_requirement_id: researchRequirementId,
          metadata: { resolved_from: 'research_page' },
        }),
      });

      if (!response.ok) {
        throw new Error('Unable to resolve SHADOW research requirement.');
      }

      setRequirements((current) =>
        current.map((requirement) =>
          requirement.research_requirement_id === researchRequirementId
            ? { ...requirement, status: 'resolved' }
            : requirement,
        ),
      );
      setSubmitMessage('Research requirement resolved.');
    } catch (error) {
      setSubmitMessage(error instanceof Error ? error.message : 'Unable to resolve SHADOW research requirement.');
    } finally {
      setResolvingId(null);
    }
  }

  const stats = [
    { label: 'Mode', value: 'Research Projection' },
    { label: 'Current Stage', value: 'Research Intake' },
    { label: 'Items', value: String(items.length) },
    { label: 'Pending Review', value: String(counts.pending) },
  ];

  return (
    /* Room--file: the research wall. Intake cards are paper records pinned to
       the cork; the requirement form is the leather-bound clipboard hung
       beside them. The room is declared ONCE, by the shell's own <main>, and
       this subtree must not restate .room--file: two rooms on one page is a
       real defect, not a duplicate class.

       allowedRoles is the client-side spelling of SHADOW_PROJECTION_READ_ROLES
       -- the set every read this page performs already authorizes
       (research-projection, research-requirements, research-submissions), and
       the set the requirement POST allows through ORGANIZATION_MEMBER_ROLES.
       It is deliberately not narrowed to the curator roles: the curator panels
       here already hide themselves when the sources probe is refused, so a
       coach or volunteer still has a working inbox. 'admin' covers
       organization_admin (mapPilotRoleToClubRole); 'board' is absent because
       ORGANIZATION_MEMBER_ROLES does not carry it and the APIs would refuse. */
    <RoleStandaloneView
      roleLabel="Research Inbox"
      routeLabel="/research"
      allowedRoles={['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer']}
      room="file"
      showShellHeader={false}
    >
      {/* ge-file: Golden Era Visual 010 scope. This wrapper class is the ONLY
          change on this route -- the cabinet head, the japanned drawer banks,
          the bronze corner plates and label rails, the engraved index tabs, the
          sunk dossier wells and the riveted pull plates all live in scoped CSS
          under .ge-file in design-system/current/ppbf-golden-era.css. Every
          control, heading, badge, form field, projection state and refusal on
          this page is untouched, and the room's own cork wall is left to its
          committed plate.

          It rides a wrapper rather than the page's own <main> because this
          route has no <main> of its own: RoleStandaloneView owns it and
          declares the file room on it (room="file" above), and the shell wraps
          68 pages, so reaching into it would leave the scope on every one of
          them. Same seam .ge-floorboard and .ge-locker use. The children below
          are deliberately NOT re-indented: a 400-line whitespace diff would
          bury the fact that nothing else here moved.

          FUNCTIONAL_CHANGES: NONE. */}
      <div className="ge-file">
      <header className="mat-leather--raised border-b border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Research Intake</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Research Inbox
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              SHADOW research projection showing requirements, gaps, evidence labels, and review state.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Research Intake" />
            <Link href="/research/chat" className="btn btn--ghost">
              Q&amp;A Research Chat
            </Link>
            <Link href="/evidence" className="btn btn--ghost">
              Evidence Review
            </Link>
            <Link href="/source-control#publish" className="btn btn--ghost">
              Publish Stage
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="research" />

        <section aria-label="Research intake status" className="flex flex-wrap gap-[var(--s3)]">
          {stats.map((item) => (
            <span key={item.label} className="plaque">
              {item.label.toUpperCase()}: {item.value.toUpperCase()}
            </span>
          ))}
        </section>

        {errorMessage ? (
          <section role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Projection Unavailable
            </span>
            <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
          </section>
        ) : null}

        {!errorMessage && projectionLoading ? (
          <section aria-busy="true" className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            {/* .working pins --brass-300 (tuned for leather, ~1.2:1 on paper).
                --brass-800 is the rung .mat-paper already restates .t-eyebrow
                to for the same reason; the ◴ glyph is a ::before on this
                element, so the ink is set here rather than on a child. */}
            <span className="working" style={{ color: 'var(--brass-800)' }}>Loading research projection...</span>
          </section>
        ) : null}

        {!errorMessage && !projectionLoading && items.length === 0 ? (
          <section className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            <p className={PAPER_LABEL}>Empty State</p>
            <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">
              No SHADOW research projection items exist for this organization yet.
            </p>
          </section>
        ) : null}

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            Review State Summary
          </h2>
          <div className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Pending', value: counts.pending },
              { label: 'Approved', value: counts.approved },
              { label: 'Rejected', value: counts.rejected },
              { label: 'Promoted', value: counts.promoted },
            ].map((entry) => (
              <article key={entry.label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label">{entry.label}</p>
                <p className="t-data mt-[var(--s2)] text-[length:var(--t-lg)] font-bold text-[color:var(--bone-100)]">{entry.value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-[var(--s4)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            <span className="text-[color:var(--hide-900)]">Research Intake Cards</span>
          </h2>
          <div className="grid gap-[var(--s4)] lg:grid-cols-2">
            {items.map((item) => {
              const badge = REVIEW_STATE_BADGES[item.review_state];
              return (
                <article key={item.event_id} className="relative mat-paper rounded-[var(--r-sm)] p-[var(--s5)]">
                  <span className="pin pin--brass" aria-hidden="true" />
                  <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                    <p className="t-typed text-[length:var(--t-md)] font-bold">{item.source_event_name}</p>
                    <span className={badge.className}>
                      <i>{badge.glyph}</i>
                      {badge.label}
                    </span>
                  </div>
                  <dl className="mt-[var(--s4)] grid gap-x-[var(--s4)] gap-y-[var(--s3)] sm:grid-cols-2">
                    <div>
                      <dt className={PAPER_LABEL}>Requirement</dt>
                      <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{item.requirement || 'Not provided'}</dd>
                    </div>
                    <div>
                      <dt className={PAPER_LABEL}>Knowledge Gap</dt>
                      <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{item.knowledge_gap || 'Not provided'}</dd>
                    </div>
                    <div>
                      <dt className={PAPER_LABEL}>Evidence Label</dt>
                      <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{item.evidence_label || 'Not provided'}</dd>
                    </div>
                    <div>
                      <dt className={PAPER_LABEL}>Source Status</dt>
                      <dd className="t-typed mt-[var(--s1)] text-[length:var(--t-sm)]">{item.source_status}</dd>
                    </div>
                  </dl>
                  <div className="mt-[var(--s4)] flex flex-wrap items-center justify-between gap-[var(--s3)] border-t border-[color:rgba(51,41,27,.26)] pt-[var(--s4)]">
                    <p className={PAPER_LABEL}>Next: Evidence Review</p>
                    <Link href="/evidence" className="btn">
                      Move to Evidence
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            Operational Research Requirements
          </h2>
          <form onSubmit={handleCreateRequirement} className="space-y-[var(--s4)]">
            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <label className="field">
                <span className="t-label">Source event name</span>
                <input
                  value={requirementDraft.sourceEventName}
                  onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEventName: event.target.value }))}
                  className="input"
                  placeholder="Source event name"
                />
              </label>
              <label className="field">
                <span className="t-label">Source entity type</span>
                <input
                  value={requirementDraft.sourceEntityType}
                  onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEntityType: event.target.value }))}
                  className="input"
                  placeholder="Source entity type"
                />
              </label>
            </div>
            <label className="field">
              <span className="t-label">Source entity id</span>
              <input
                value={requirementDraft.sourceEntityId}
                onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEntityId: event.target.value }))}
                className="input"
                placeholder="Source entity id"
              />
            </label>
            <label className="field">
              <span className="t-label">Research requirement</span>
              <textarea
                value={requirementDraft.researchRequirement}
                onChange={(event) => setRequirementDraft((current) => ({ ...current, researchRequirement: event.target.value }))}
                className="textarea h-[89px]"
                placeholder="Research requirement"
              />
            </label>
            <label className="field">
              <span className="t-label">Knowledge gap</span>
              <textarea
                value={requirementDraft.knowledgeGap}
                onChange={(event) => setRequirementDraft((current) => ({ ...current, knowledgeGap: event.target.value }))}
                className="textarea h-[55px]"
                placeholder="Knowledge gap"
              />
            </label>
            <div className="flex flex-wrap items-center gap-[var(--s4)]">
              <button type="submit" className="btn">
                Save Requirement
              </button>
              <p className="t-muted" role="status">
                {submitMessage || 'Persist a requirement from evidence or a manual note.'}
              </p>
            </div>
          </form>
          <div className="space-y-[var(--s3)]">
            {requirements.map((requirement) => (
              <article key={requirement.research_requirement_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                  <p className="t-body font-bold text-[color:var(--bone-100)]">{requirement.source_event_name}</p>
                  {requirement.status === 'open' ? (
                    <span className="badge badge--monitor">
                      <i>◉</i>Open
                    </span>
                  ) : (
                    <span className="badge badge--cleared">
                      <i>✓</i>Resolved
                    </span>
                  )}
                </div>
                <p className="t-body mt-[var(--s3)]">{requirement.research_requirement}</p>
                <p className="t-muted mt-[var(--s2)]">Gap: {requirement.knowledge_gap}</p>
                {/* Law 4: sourcing facts a reviewer checks against are records -- mono voice. */}
                <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                  Source: {requirement.source_status} | Confidence: {requirement.source_confidence_tier} | Verification: {requirement.source_verification_state}
                </p>
                {requirement.status === 'open' && answerStates[String(requirement.research_requirement_id)] ? (
                  (() => {
                    const ladder = ANSWER_STATE_BADGES[answerStates[String(requirement.research_requirement_id)]];
                    return (
                      <p className="mt-[var(--s3)]">
                        <span className={ladder.className}><i aria-hidden="true">{ladder.glyph}</i>{ladder.label}</span>
                      </p>
                    );
                  })()
                ) : null}
                {requirement.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => void handleResolveRequirement(requirement.research_requirement_id)}
                    disabled={resolvingId === requirement.research_requirement_id}
                    className="btn btn--ghost mt-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {resolvingId === requirement.research_requirement_id ? 'Resolving...' : 'Mark Resolved'}
                  </button>
                ) : null}
                {requirement.status === 'open' && curatorSources && curatorSources.length > 0 ? (
                  <div className="mt-[var(--s3)]">
                    {answeringId === requirement.research_requirement_id ? (
                      <div className="mat-paper rounded-[var(--r-sm)] p-[var(--s4)] space-y-[var(--s3)]">
                        <p className={PAPER_LABEL}>Answer this gap — submission is not an answer until review says so</p>
                        <label className="field">
                          <span className={PAPER_LABEL}>Library source</span>
                          <select
                            className="select"
                            value={answerDraft.sourceId}
                            onChange={(event) => setAnswerDraft((current) => ({ ...current, sourceId: event.target.value }))}
                          >
                            <option value="">Choose a registered source…</option>
                            {curatorSources.map((source) => (
                              <option key={source.source_id} value={source.source_id}>
                                {source.title} ({source.source_type})
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="grid gap-[var(--s3)] md:grid-cols-2">
                          <label className="field">
                            <span className={PAPER_LABEL}>DOI / PMID</span>
                            <input className="input" value={answerDraft.doi}
                              onChange={(event) => setAnswerDraft((current) => ({ ...current, doi: event.target.value }))} />
                          </label>
                          <label className="field">
                            <span className={PAPER_LABEL}>Provider (e.g. Penn State Library)</span>
                            <input className="input" value={answerDraft.provider}
                              onChange={(event) => setAnswerDraft((current) => ({ ...current, provider: event.target.value }))} />
                          </label>
                        </div>
                        <label className="field">
                          <span className={PAPER_LABEL}>Why this source answers it</span>
                          <textarea className="textarea h-[55px]" value={answerDraft.note}
                            onChange={(event) => setAnswerDraft((current) => ({ ...current, note: event.target.value }))} />
                        </label>
                        <div className="flex flex-wrap items-center gap-[var(--s3)]">
                          <button type="button" className="btn" disabled={answerBusy}
                            onClick={() => void handleAnswerGap(requirement.research_requirement_id)}>
                            {answerBusy ? 'Submitting…' : 'Submit source'}
                          </button>
                          <button type="button" className="btn btn--ghost"
                            onClick={() => { setAnsweringId(null); setAnswerMessage(null); }}>
                            Cancel
                          </button>
                          {answerMessage && answerMessage.forId === requirement.research_requirement_id
                            ? <p className="t-typed text-[length:var(--t-xs)]" role="status">{answerMessage.text}</p> : null}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <button type="button" className="btn btn--ghost"
                          onClick={() => {
                            setAnsweringId(requirement.research_requirement_id);
                            setAnswerDraft({ sourceId: '', doi: '', provider: '', note: '' });
                            setAnswerMessage(null);
                          }}>
                          Answer this gap
                        </button>
                        {answerMessage && answerMessage.forId === requirement.research_requirement_id
                          ? <p className="t-muted" role="status">{answerMessage.text}</p> : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        {curatorSources !== null ? (
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              General Research Intake
            </h2>
            <p className="t-body text-[color:var(--bone-300)]">
              Register useful research nobody asked for yet. Classification is a filing label you pick and can
              correct — it changes no gate, no tier, no review state. A general source becomes linkable to a
              requirement later through Answer a Gap, and citable only through evidence review.
            </p>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <label className="field md:col-span-2">
                <span className="t-label">Title</span>
                <input className="input" value={generalDraft.title}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label className="field">
                <span className="t-label">Source type</span>
                <select className="select" value={generalDraft.sourceType}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, sourceType: event.target.value }))}>
                  {GENERAL_SOURCE_TYPES.map((type) => (
                    <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="t-label">Classification domain</span>
                <select aria-label="Classification domain" className="select" value={generalDraft.classification}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, classification: event.target.value }))}>
                  <option value="">Choose a domain…</option>
                  {RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => (
                    <option key={domain.key} value={domain.key}>{domain.label}</option>
                  ))}
                </select>
              </label>
              <label className="field md:col-span-2">
                <span className="t-label">URL (optional)</span>
                <input className="input" value={generalDraft.url}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, url: event.target.value }))} />
              </label>
              <label className="field">
                <span className="t-label">DOI / PMID</span>
                <input className="input" value={generalDraft.doi}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, doi: event.target.value }))} />
              </label>
              <label className="field">
                <span className="t-label">Provider</span>
                <input className="input" value={generalDraft.provider}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, provider: event.target.value }))} />
              </label>
              <label className="field md:col-span-2">
                <span className="t-label">Original filename</span>
                <input className="input" value={generalDraft.filename}
                  onChange={(event) => setGeneralDraft((current) => ({ ...current, filename: event.target.value }))} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-[var(--s4)]">
              <button type="button" className="btn" disabled={generalBusy} onClick={() => void handleRegisterGeneral()}>
                {generalBusy ? 'Registering…' : 'Register general research'}
              </button>
              {generalMessage ? <p className="t-muted" role="status">{generalMessage}</p> : null}
            </div>

            {generalSources.length > 0 ? (
              <div className="space-y-[var(--s3)]">
                <h3 className="t-label">Registered general research</h3>
                {generalSources.map((source) => (
                  <article key={source.source_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                      <p className="t-body font-bold text-[color:var(--bone-100)]">{source.title}</p>
                      <span className="badge badge--filed"><i aria-hidden="true">◌</i>
                        {researchClassificationLabel(source.metadata?.classification_domain ?? '')}
                      </span>
                    </div>
                    <label className="field mt-[var(--s3)]">
                      <span className="t-label">Correct classification</span>
                      <select
                        aria-label={`Correct classification for ${source.title}`}
                        className="select"
                        value={source.metadata?.classification_domain ?? ''}
                        disabled={reclassifyingId === source.source_id}
                        onChange={(event) => {
                          if (event.target.value) void handleReclassify(source.source_id, event.target.value);
                        }}
                      >
                        <option value="">Choose a domain…</option>
                        {RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => (
                          <option key={domain.key} value={domain.key}>{domain.label}</option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      </div>
    </RoleStandaloneView>
  );
}
