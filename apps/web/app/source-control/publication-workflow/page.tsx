"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';
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

const quickLinks = [
  { label: 'Source control', href: '/source-control' },
  { label: 'Audit trace', href: '/audit' },
  { label: 'Admin compliance center', href: '/admin/compliance-center' },
  { label: 'Operations Hub', href: '/operations' },
  { label: 'Member Access', href: '/login' },
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

  const stats = [
    { label: 'Automation State', value: 'NOT YET AUTOMATED' },
    { label: 'Execution Engine', value: 'BACKEND REQUIRED' },
    { label: 'Approval Model', value: 'HUMAN REVIEW REQUIRED' },
    { label: 'Release Control', value: 'Jason Approval' },
    { label: 'Open Requirements', value: String(requirements.filter((item) => item.status === 'open').length) },
  ];

  return (
    /* Ink ground (Law 6): a staff governance table, on the same leather
       chassis as /source-control rather than the FeatureSurface scaffold. */
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
          <p className="t-eyebrow tracking-[0.35em]">Publication Workflow</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>
            Automated Publication Workflow
          </h1>
          {/* Law 7: the unbuilt state is stamped in brass, off the safety
              ladder's colours. */}
          <span className="stamp stamp--brass">{capabilityStatus}</span>
          <p className="t-body max-w-[80ch]">
            Source-control publication surface for the PPBF ecosystem. This pass is front-end visibility only.
          </p>
          <ShadowChatButton context="Publication Workflow Automated Publication Workflow" />
        </header>

        <DevelopmentPipelineBanner currentStage="publish" />

        {errorMessage ? (
          /* Law 3: the failed load carries a glyph and an uppercase label,
             not colour alone. */
          <div role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Load failed
            </span>
            <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
          </div>
        ) : null}

        <section className="grid gap-[var(--s4)] sm:grid-cols-2 xl:grid-cols-5">
          {stats.map((item) => (
            <article key={item.label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-eyebrow">{item.label}</p>
              <p className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-md)' }}>{item.value}</p>
            </article>
          ))}
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Workflow Surface Registry</h2>
          <div className="grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
            {workflowPanels.map((stage) => (
              <article key={stage} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-body font-semibold text-[color:var(--bone-100)]">{stage}</p>
                <p className="t-label mt-[var(--s2)]">{capabilityStatus}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Quick links</h2>
          <div className="flex flex-wrap gap-[var(--s4)]">
            {quickLinks.map((item) => (
              <Link key={item.href} href={item.href} className="btn btn--ghost">
                {item.label}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
