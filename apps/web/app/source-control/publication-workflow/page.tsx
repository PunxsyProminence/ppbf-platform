"use client";

import { useEffect, useMemo, useState } from 'react';
import FeatureSurface from '@/components/FeatureSurface';
import { apiBase } from '@/lib/apiBase';

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

const publicationStages = [
  'Publication Workflow Overview',
  'Source Review',
  'Approval Queue',
  'Publication Queue',
  'Publication History',
  'Destination Registry',
  'Source Status',
  'Version Status',
  'Approved Build Input Placeholder',
  'Publish to Ecosystem Placeholder',
  'Human Approval Gate',
  'Jason Approval',
];

interface ShadowRequirementItem {
  research_requirement_id: number;
  status: 'open' | 'resolved';
}

export default function PublicationWorkflowPage() {
  const [requirements, setRequirements] = useState<ShadowRequirementItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Unable to load SHADOW research requirements.');
        }

        const payload = (await response.json()) as { items?: ShadowRequirementItem[] };
        setRequirements(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setRequirements([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW research requirements.');
      }
    })();
  }, []);

  const workflowPanels = useMemo(
    () => [
      ...publicationStages,
      `Open Research Requirements (${requirements.filter((item) => item.status === 'open').length})`,
      `Resolved Research Requirements (${requirements.filter((item) => item.status === 'resolved').length})`,
    ],
    [requirements],
  );

  return (
    <FeatureSurface
      eyebrow="Publication Workflow"
      title="Automated Publication Workflow"
      description="Source-control publication surface for the PPBF ecosystem. This pass is front-end visibility only."
      status={capabilityStatus}
      currentStage="publish"
      primaryLinks={[
        { label: 'Source control', href: '/source-control' },
        { label: 'Audit trace', href: '/audit' },
        { label: 'Admin compliance center', href: '/admin/compliance-center' },
      ]}
      stats={[
        { label: 'Automation State', value: 'NOT YET AUTOMATED' },
        { label: 'Execution Engine', value: 'BACKEND REQUIRED' },
        { label: 'Approval Model', value: 'HUMAN REVIEW REQUIRED' },
        { label: 'Release Control', value: 'Jason Approval' },
        { label: 'Open Requirements', value: String(requirements.filter((item) => item.status === 'open').length) },
      ]}
    >
      <div className="space-y-4">
        {errorMessage ? <p className="text-sm text-[var(--locked-ink)]">{errorMessage}</p> : null}
        <section className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[var(--brass-300)]">Workflow Surface Registry</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflowPanels.map((stage) => (
              <article key={stage} className="border border-[var(--hide-500)] bg-[var(--hide-950)] p-3">
                <p className="text-[14px] font-semibold text-[var(--bone-200)]">{stage}</p>
                <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[var(--brass-300)]">
                  {capabilityStatus}
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </FeatureSurface>
  );
}
