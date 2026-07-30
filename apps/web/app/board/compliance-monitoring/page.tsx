"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface ComplianceSummary {
  total: number;
  severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  status: {
    new: number;
    acknowledged: number;
    escalated: number;
    resolved: number;
    dismissed: number;
  };
}

// ShadowRequirementItem interface available for future use in research requirement tracking
// interface ShadowRequirementItem {
//   research_requirement_id: number;
//   status: 'open' | 'resolved';
// }

export default function BoardComplianceMonitoringPage() {
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [errorMessage, setErrorMessage] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        const violRes = await fetch(`${apiBase()}/api/pilot/board/compliance-summary?status=${selectedStatus || ''}`, { credentials: 'include' });
        if (!violRes.ok) {
          throw new Error('Unable to load compliance violations.');
        }
        const violData = (await violRes.json()) as { ok?: boolean; summary?: ComplianceSummary };
        if (violData.ok !== true || !violData.summary) {
          throw new Error('Compliance summary unavailable.');
        }
        setSummary(violData.summary);

        setErrorMessage('');
      } catch (error) {
        setSummary(null);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load compliance data.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [selectedStatus]);

  const severityCounts = useMemo(() => summary?.severity ?? null, [summary]);
  const statusCounts = useMemo(() => summary?.status ?? null, [summary]);

  const totalViolations = summary?.total ?? null;

  const metricValue = (value: number | null | undefined) => {
    if (isLoading) return '...';
    if (value === null || value === undefined) return '--';
    return String(value);
  };

  return (
    <RoleSessionGate allowedRoles={['board']}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">Board Workspace</p>
            <h1 className="font-display text-4xl font-black">Automated Compliance Monitoring</h1>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Real-time compliance violation tracking and escalation management.
            </p>
            {errorMessage ? <p className="text-sm text-[var(--red-primary)]">{errorMessage}</p> : null}
            {!errorMessage && !isLoading && !summary ? (
              <p className="text-sm text-[var(--red-primary)]">Compliance telemetry is unavailable. Counts are intentionally suppressed.</p>
            ) : null}
          </header>

          {/* Metrics Dashboard */}
          <section className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <article className="border-2 border-[var(--black)] bg-[#fce8e6] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">Critical</h2>
              <p className="mt-4 text-4xl font-black">{metricValue(severityCounts?.critical)}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[#fff3cd] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-[#ff9800]">High</h2>
              <p className="mt-4 text-4xl font-black">{metricValue(severityCounts?.high)}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em]">Medium</h2>
              <p className="mt-4 text-4xl font-black">{metricValue(severityCounts?.medium)}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em]">Low</h2>
              <p className="mt-4 text-4xl font-black">{metricValue(severityCounts?.low)}</p>
            </article>
          </section>

          {/* Status Filters */}
          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-bold uppercase">Filter by Status</h2>
            <div className="flex flex-wrap gap-2">
              {['', 'new', 'acknowledged', 'escalated', 'resolved', 'dismissed'].map((status) => (
                <button
                  key={status || 'all'}
                  onClick={() => setSelectedStatus(status)}
                  className={`border-2 px-3 py-1 text-sm font-bold uppercase ${
                    selectedStatus === status
                      ? 'border-[var(--black)] bg-[var(--black)] text-[var(--canvas-tan)]'
                      : 'border-[var(--black)] bg-[var(--canvas-tan-light)]'
                  }`}
                >
                  {status || 'All'} ({status === '' ? metricValue(totalViolations) : metricValue(statusCounts?.[status as keyof NonNullable<typeof statusCounts>])})
                </button>
              ))}
            </div>
          </section>

          {/* Aggregate View */}
          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-bold uppercase">Status Summary</h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
              <article className="border-2 border-[var(--black)] bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.08em]">New</p>
                <p className="mt-2 text-3xl font-black">{metricValue(statusCounts?.new)}</p>
              </article>
              <article className="border-2 border-[var(--black)] bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.08em]">Acknowledged</p>
                <p className="mt-2 text-3xl font-black">{metricValue(statusCounts?.acknowledged)}</p>
              </article>
              <article className="border-2 border-[var(--black)] bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.08em]">Escalated</p>
                <p className="mt-2 text-3xl font-black">{metricValue(statusCounts?.escalated)}</p>
              </article>
              <article className="border-2 border-[var(--black)] bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.08em]">Resolved</p>
                <p className="mt-2 text-3xl font-black">{metricValue(statusCounts?.resolved)}</p>
              </article>
              <article className="border-2 border-[var(--black)] bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.08em]">Dismissed</p>
                <p className="mt-2 text-3xl font-black">{metricValue(statusCounts?.dismissed)}</p>
              </article>
            </div>

            <p className="text-sm text-[var(--gray-dark)]">
              This board view intentionally exposes aggregate-only compliance telemetry and excludes athlete-level identifiers.
            </p>
          </section>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/board" className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]">
              Back to Board Hub
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
