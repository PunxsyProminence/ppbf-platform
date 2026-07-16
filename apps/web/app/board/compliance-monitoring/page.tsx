"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import ShadowChatButton from '@/components/ShadowChatButton';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';

const boardRoles = roleRoutes
  .map((route) => route.role)
  .filter((role): role is ClubRole => role.startsWith('board-'));

const complianceCards = [
  'Compliance Dashboard',
  'Compliance Watchlist',
  'Policy Review Queue',
  'Required Review Dates',
  'Board Compliance Alerts',
  'Safety Governance Monitoring',
  'Public Charity Compliance Placeholder',
  'Annual Filing Placeholder',
  'Conflict of Interest Review Placeholder',
  'Youth Safety Review Placeholder',
  'Audit Monitoring Placeholder',
];

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

interface ShadowRequirementItem {
  research_requirement_id: number;
  status: 'open' | 'resolved';
}

export default function BoardComplianceMonitoringPage() {
  const [requirements, setRequirements] = useState<ShadowRequirementItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`);
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

  const cards = useMemo(
    () => [
      ...complianceCards,
      `Open SHADOW Requirements (${requirements.filter((item) => item.status === 'open').length})`,
      `Resolved SHADOW Requirements (${requirements.filter((item) => item.status === 'resolved').length})`,
    ],
    [requirements],
  );

  return (
    <RoleSessionGate allowedRoles={boardRoles}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">Board Workspace</p>
            <h1 className="font-display text-4xl font-black">Automated Compliance Monitoring</h1>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">{capabilityStatus}</p>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Board compliance watch and governance monitoring surface. This route is static/front-end only and does not run compliance automation.
            </p>
            {errorMessage ? <p className="text-sm text-[var(--red-primary)]">{errorMessage}</p> : null}
            <ShadowChatButton context="Board Compliance Monitoring" />
          </header>

          <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <article key={card} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{card}</h2>
                <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">
                  {capabilityStatus}
                </p>
              </article>
            ))}
          </section>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/board" className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]">
              Back to Board Hub
            </Link>
            <Link href="/admin/compliance-center" className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]">
              Admin Compliance Center
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
