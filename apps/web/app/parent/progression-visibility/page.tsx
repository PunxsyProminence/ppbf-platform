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
      {/* Family-facing surface — warm canvas ground (Law 6), paper panels on it. */}
      <div className="on-canvas min-h-full rounded-[var(--r-lg)] p-[var(--s5)] md:p-[var(--s6)]">
        <div className="mx-auto w-full max-w-[1080px] space-y-[var(--s6)]">
          <header className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow">Closed-Loop Progression Intelligence</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              Parent Progression Visibility
            </h1>
            <p className="t-body mt-[var(--s3)]">
              Family-facing progression surface for support visibility only.
            </p>
            <p className="t-label mt-[var(--s3)]">
              {capabilityStatus}
            </p>
            {errorMessage ? (
              <div className="alert alert--critical alert--tight" role="alert">
                <div className="alert-body">
                  <span className="badge badge--locked"><i>✕</i>Failed</span>
                  <p className="alert-msg mt-[var(--s3)]">{errorMessage}</p>
                </div>
              </div>
            ) : null}
          </header>

          <section className="grid gap-[var(--s4)] md:grid-cols-2">
            {familyPanels.map((panel) => (
              <article key={panel} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-body font-semibold">{panel}</p>
                <p className="t-label mt-[var(--s2)]">
                  {capabilityStatus}
                </p>
              </article>
            ))}
          </section>

          <div className="flex flex-wrap gap-[var(--s3)]">
            <Link href="/parent/dashboard" className="btn btn--ghost">
              Back to Parent Hub
            </Link>
          </div>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
