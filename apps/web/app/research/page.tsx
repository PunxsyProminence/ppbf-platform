'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import FeatureSurface from '@/components/FeatureSurface';
import { apiBase } from '@/lib/apiBase';

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

export default function ResearchIntakePage() {
  const [items, setItems] = useState<ShadowResearchItem[]>([]);
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
        setRequirements(payload.items ?? []);
      } catch {
        setRequirements([]);
      }
    })();
  }, []);

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

  return (
    <FeatureSurface
      eyebrow="Research Intake"
      title="Research Inbox and intake lane"
      description="SHADOW research projection showing requirements, gaps, evidence labels, and review state."
      status="ready"
      currentStage="research"
      primaryLinks={[
        { label: 'Q&A Research Chat', href: '/research/chat' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Pipeline publish stage', href: '/source-control#publish' },
      ]}
      stats={[
        { label: 'Mode', value: 'Research Projection' },
        { label: 'Current Stage', value: 'Research Intake' },
        { label: 'Items', value: String(items.length) },
        { label: 'Pending Review', value: String(counts.pending) },
      ]}
    >
      <div className="space-y-4">
        {errorMessage ? (
          <section className="border-2 border-[#8b4444] bg-[#151515] p-4 text-sm text-[#f0c4c4]">{errorMessage}</section>
        ) : null}

        {!errorMessage && items.length === 0 ? (
          <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Empty State</p>
            <p className="mt-2 text-[14px] text-[#cfbfae]">No SHADOW research projection items exist for this organization yet.</p>
          </section>
        ) : null}

        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Review State Summary</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Pending', value: counts.pending },
              { label: 'Approved', value: counts.approved },
              { label: 'Rejected', value: counts.rejected },
              { label: 'Promoted', value: counts.promoted },
            ].map((entry) => (
              <article key={entry.label} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
                <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#b0a095]">{entry.label}</p>
                <p className="mt-2 text-2xl font-black text-[#e8d7c6]">{entry.value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-3 border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Research Intake Cards</p>
          {items.map((item) => (
            <article key={item.event_id} className="border border-[#8b4444] bg-[#1a1a1a]/70 p-4">
              <div className="grid gap-2 md:grid-cols-2">
                <p className="text-[16px] font-bold text-[#e8d7c6]">{item.source_event_name}</p>
                <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-[#d4a574]">Status: {item.review_state}</p>
                <p className="text-[14px] text-[#cfbfae]">Requirement: {item.requirement || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Knowledge Gap: {item.knowledge_gap || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Evidence Label: {item.evidence_label || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Source Status: {item.source_status}</p>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#5a4a3a] pt-3">
                <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#d4a574]">Next: Evidence Review</p>
                <Link
                  href="/evidence"
                  className="inline-flex min-h-[44px] items-center border border-[#8b4444] bg-[#2a1414] px-3 text-[12px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
                >
                  Move to Evidence -&gt;
                </Link>
              </div>
            </article>
          ))}
        </section>

        <section className="space-y-3 border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Operational Research Requirements</p>
          <form onSubmit={handleCreateRequirement} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={requirementDraft.sourceEventName}
                onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEventName: event.target.value }))}
                className="border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8d7c6] outline-none"
                placeholder="Source event name"
              />
              <input
                value={requirementDraft.sourceEntityType}
                onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEntityType: event.target.value }))}
                className="border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8d7c6] outline-none"
                placeholder="Source entity type"
              />
            </div>
            <input
              value={requirementDraft.sourceEntityId}
              onChange={(event) => setRequirementDraft((current) => ({ ...current, sourceEntityId: event.target.value }))}
              className="w-full border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8d7c6] outline-none"
              placeholder="Source entity id"
            />
            <textarea
              value={requirementDraft.researchRequirement}
              onChange={(event) => setRequirementDraft((current) => ({ ...current, researchRequirement: event.target.value }))}
              className="h-24 w-full border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8d7c6] outline-none"
              placeholder="Research requirement"
            />
            <textarea
              value={requirementDraft.knowledgeGap}
              onChange={(event) => setRequirementDraft((current) => ({ ...current, knowledgeGap: event.target.value }))}
              className="h-20 w-full border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8d7c6] outline-none"
              placeholder="Knowledge gap"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="inline-flex min-h-[44px] items-center border border-[#8b4444] bg-[#2a1414] px-4 text-[12px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
              >
                Save Requirement
              </button>
              <p className="text-[12px] text-[#cfbfae]">{submitMessage || 'Persist a requirement from evidence or a manual note.'}</p>
            </div>
          </form>
          <div className="space-y-2">
            {requirements.map((requirement) => (
              <article key={requirement.research_requirement_id} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[14px] font-bold text-[#e8d7c6]">{requirement.source_event_name}</p>
                  <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#d4a574]">{requirement.status}</p>
                </div>
                <p className="mt-2 text-[13px] text-[#cfbfae]">{requirement.research_requirement}</p>
                <p className="mt-1 text-[12px] text-[#b0a095]">Gap: {requirement.knowledge_gap}</p>
                <p className="mt-1 text-[12px] text-[#b0a095]">
                  Source: {requirement.source_status} | Confidence: {requirement.source_confidence_tier} | Verification: {requirement.source_verification_state}
                </p>
                {requirement.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => void handleResolveRequirement(requirement.research_requirement_id)}
                    disabled={resolvingId === requirement.research_requirement_id}
                    className="mt-3 inline-flex min-h-[44px] items-center border border-[#3f8b5b] bg-[#122319] px-3 text-[12px] font-bold text-[#c9f0d7] transition hover:border-[#c9f0d7] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {resolvingId === requirement.research_requirement_id ? 'Resolving...' : 'Mark Resolved'}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </div>
    </FeatureSurface>
  );
}