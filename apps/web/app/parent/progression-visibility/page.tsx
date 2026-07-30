'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

interface ShadowRequirementItem {
  research_requirement_id: number;
  source_event_name: string;
  research_requirement: string;
  knowledge_gap: string;
  source_status: string;
  source_verification_state: string;
  status: 'open' | 'resolved';
  created_at: string;
}

export default function ParentProgressionVisibilityPage() {
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [requirements, setRequirements] = useState<ShadowRequirementItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [observationResponse, requirementResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 8 }) }),
          fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, { credentials: 'include' }),
        ]);

        if (!observationResponse.ok || !requirementResponse.ok) {
          throw new Error('Unable to load family progression signals.');
        }

        const observationPayload = (await observationResponse.json()) as { items?: ShadowObservationItem[] };
        const requirementPayload = (await requirementResponse.json()) as { items?: ShadowRequirementItem[] };

        setObservations(observationPayload.items ?? []);
        setRequirements(requirementPayload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setObservations([]);
        setRequirements([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load family progression signals.');
      }
    })();
  }, []);

  const familyPanels = useMemo(
    () => [
      `Parent-Support Visibility ${observations.length > 0 ? 'Live' : 'Placeholder'}`,
      `Athlete Development Timeline (${observations.length} signals)`,
      `${requirements.filter((item) => item.status === 'open').length} Coach Review Required Notices`,
      `${requirements.filter((item) => item.status === 'resolved').length} Human Review Resolved Notices`,
    ],
    [observations.length, requirements],
  );

  return (
    <RoleStandaloneView roleLabel="Parent Hub" routeLabel="/parent/progression-visibility" allowedRoles={['parent']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Parent Progression Visibility</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Family-facing progression surface for support visibility only.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            {capabilityStatus}
          </p>
          {errorMessage ? <p className="mt-2 text-xs text-[#f0c4c4]">{errorMessage}</p> : null}
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          {familyPanels.map((panel) => (
            <article key={panel} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel}</p>
              <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                {capabilityStatus}
              </p>
            </article>
          ))}
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/parent/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Parent Hub
          </Link>
          <Link href="/athlete/progression-intelligence" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Athlete Progression Surface
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
