"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatMeasuredAt, type BoardCountMetric } from '../BoardSummaryPanel';

interface ComplianceSummary {
  audience: 'organization_admin' | 'board';
  minimumCohortSize: number;
  generatedAt: string;
  total: BoardCountMetric;
  severity: {
    critical: BoardCountMetric;
    high: BoardCountMetric;
    medium: BoardCountMetric;
    low: BoardCountMetric;
  };
  status: {
    new: BoardCountMetric;
    acknowledged: BoardCountMetric;
    escalated: BoardCountMetric;
    resolved: BoardCountMetric;
    dismissed: BoardCountMetric;
  };
}

// No detector writes to this register and no screen files into it, so every
// figure below counts filings made by a person. The distinction between "none
// filed" and "none happened" is the whole meaning of a zero here and has to
// stay on screen next to the number.
const FILED_BY_HAND_NOTE = 'Counts filings made by a person, not incidents detected by the platform.';

function violationDisplay(
  metric: BoardCountMetric | undefined,
  minimumCohortSize: number,
  isLoading: boolean,
  isFiltered: boolean,
): { value: string; note: string } {
  if (isLoading) {
    return { value: '...', note: 'Loading the register.' };
  }

  if (!metric) {
    return { value: 'Unavailable', note: 'The register could not be read.' };
  }

  if (metric.status === 'insufficient_data') {
    return {
      value: 'Suppressed',
      note: `Fewer than ${minimumCohortSize} athletes are involved, so the count is withheld.`,
    };
  }

  if (metric.status === 'unavailable' || metric.count === null) {
    return {
      value: 'None filed',
      note: isFiltered
        ? 'Nothing with this status has been filed. That is not a finding that none occurred.'
        : 'Nobody has filed one. That is not a finding that none occurred.',
    };
  }

  return { value: String(metric.count), note: FILED_BY_HAND_NOTE };
}

function filterLabel(metric: BoardCountMetric | undefined, isLoading: boolean): string {
  if (isLoading) return '...';
  if (!metric) return 'unavailable';
  if (metric.status === 'insufficient_data') return 'suppressed';
  if (metric.status === 'unavailable' || metric.count === null) return 'none filed';
  return String(metric.count);
}

export default function BoardComplianceMonitoringPage() {
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  // The status breakdown and the filter labels must always describe the WHOLE
  // register. Reading them from a filtered response makes every other bucket
  // report nothing filed, which on a safeguarding page reads as an assurance.
  const [baseline, setBaseline] = useState<ComplianceSummary | null>(null);
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
        if (!selectedStatus) {
          setBaseline(violData.summary);
        }

        setErrorMessage('');
      } catch (error) {
        setSummary(null);
        setBaseline(null);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load compliance data.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [selectedStatus]);

  const severityCounts = useMemo(() => summary?.severity ?? null, [summary]);
  // Always the unfiltered register: these are the per-status totals, so a
  // filtered copy of them would be the same numbers filtered by themselves.
  const statusCounts = useMemo(() => baseline?.status ?? null, [baseline]);

  const minimumCohortSize = summary?.minimumCohortSize ?? 5;
  const measuredAt = summary ? formatMeasuredAt(summary.generatedAt) : null;
  const isFiltered = selectedStatus !== '';
  const nothingToShow = summary?.total.status === 'unavailable';

  const severityTiles = [
    { label: 'Critical', metric: severityCounts?.critical, tone: 'border-2 border-[var(--black)] bg-[var(--locked-ink)] p-4', headingTone: 'text-[var(--red-primary)]' },
    { label: 'High', metric: severityCounts?.high, tone: 'border-2 border-[var(--black)] bg-[var(--restricted-ink)] p-4', headingTone: 'text-[var(--restricted)]' },
    { label: 'Medium', metric: severityCounts?.medium, tone: 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4', headingTone: '' },
    { label: 'Low', metric: severityCounts?.low, tone: 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4', headingTone: '' },
  ];

  const statusTiles = [
    { label: 'New', metric: statusCounts?.new },
    { label: 'Acknowledged', metric: statusCounts?.acknowledged },
    { label: 'Escalated', metric: statusCounts?.escalated },
    { label: 'Resolved', metric: statusCounts?.resolved },
    { label: 'Dismissed', metric: statusCounts?.dismissed },
  ];

  return (
    <RoleSessionGate allowedRoles={['board']}>
      <main className="room--clinic min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">Board Workspace</p>
            <h1 className="font-display text-4xl font-black">Hand-Filed Compliance Register</h1>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Aggregate counts of compliance violations that staff have filed by hand, with escalation status. The
              platform runs no violation detector and no screen files into this register, so these figures track
              reporting, not gym conditions.
            </p>
            <p className="text-[13px] font-mono text-[var(--gray-dark)]">
              {isLoading
                ? 'Loading the register...'
                : measuredAt
                  ? `Read ${measuredAt}`
                  : 'Read time unknown'}
            </p>
            {errorMessage ? <p className="text-sm text-[var(--red-primary)]">{errorMessage}</p> : null}
            {!errorMessage && !isLoading && !summary ? (
              <p className="text-sm text-[var(--red-primary)]">The register could not be read, so no counts are shown. This is a failed read, not an empty register.</p>
            ) : null}
          </header>

          {nothingToShow ? (
            <section className="mt-6 border-2 border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.08em] text-[var(--red-primary)]">Read this zero correctly</h2>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
                {isFiltered
                  ? 'No violation with the selected status has been filed, so every count in this view reads as none filed.'
                  : 'No compliance violation has ever been filed for this organization, so every count on this page reads as none filed.'}
                {' '}
                That is a statement about reporting, not about safety: nothing detects a violation for you, so an empty
                register means no one has filed one, not that nothing has happened.
              </p>
            </section>
          ) : null}

          {/* Severity counts */}
          <section className="mt-8 space-y-3">
            <p className="text-sm text-[var(--gray-dark)]">
              {isFiltered
                ? `Severity across violations with the status "${selectedStatus}" only.`
                : 'Severity across every violation on the register.'}
            </p>
          </section>
          <section className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {severityTiles.map((tile) => {
              const display = violationDisplay(tile.metric, minimumCohortSize, isLoading, isFiltered);
              return (
                <article key={tile.label} className={tile.tone}>
                  <h2 className={`text-xs font-bold uppercase tracking-[0.08em] ${tile.headingTone}`}>{tile.label}</h2>
                  <p className="mt-4 text-4xl font-black">{display.value}</p>
                  <p className="mt-2 text-[13px] leading-5 text-[var(--gray-dark)]">{display.note}</p>
                </article>
              );
            })}
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
                  {status || 'All'} ({status === ''
                    ? filterLabel(baseline?.total, isLoading)
                    : filterLabel(statusCounts?.[status as keyof NonNullable<typeof statusCounts>], isLoading)})
                </button>
              ))}
            </div>
          </section>

          {/* Aggregate View */}
          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-bold uppercase">Status Summary</h2>
            <p className="text-sm text-[var(--gray-dark)]">
              The whole register, regardless of the filter above.
            </p>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
              {statusTiles.map((tile) => {
                const display = violationDisplay(tile.metric, minimumCohortSize, isLoading, false);
                return (
                  <article key={tile.label} className="border-2 border-[var(--black)] bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.08em]">{tile.label}</p>
                    <p className="mt-2 text-3xl font-black">{display.value}</p>
                    <p className="mt-2 text-[13px] leading-5 text-[var(--gray-dark)]">{display.note}</p>
                  </article>
                );
              })}
            </div>

            <p className="text-sm text-[var(--gray-dark)]">
              This board view exposes aggregate-only compliance telemetry and excludes athlete-level identifiers. A
              count drawn from fewer than {minimumCohortSize} athletes is suppressed rather than shown, because a small
              count plus a date identifies the athlete behind it. {FILED_BY_HAND_NOTE}
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
