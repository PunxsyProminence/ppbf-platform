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

  // Severity is a safety signal only when a measured count is actually on the
  // register (Law 2). An empty or suppressed bucket stays neutral leather; a
  // live critical or high count wears the saturated band with its glyph
  // (Law 3), the same idiom the coach panel uses for injury flags.
  const severityTiles = [
    { label: 'Critical', metric: severityCounts?.critical, glyph: '✕', tone: 'rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[color-mix(in_srgb,var(--locked)_16%,transparent)] p-[var(--s4)]' },
    { label: 'High', metric: severityCounts?.high, glyph: '▲', tone: 'rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_16%,transparent)] p-[var(--s4)]' },
    { label: 'Medium', metric: severityCounts?.medium, glyph: null, tone: null },
    { label: 'Low', metric: severityCounts?.low, glyph: null, tone: null },
  ];

  const statusTiles = [
    { label: 'New', metric: statusCounts?.new },
    { label: 'Acknowledged', metric: statusCounts?.acknowledged },
    { label: 'Escalated', metric: statusCounts?.escalated },
    { label: 'Resolved', metric: statusCounts?.resolved },
    { label: 'Dismissed', metric: statusCounts?.dismissed },
  ];

  const NEUTRAL_TILE = 'mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]';
  const VALUE = 'mt-[var(--s3)] font-mono text-[length:var(--t-xl)] font-bold text-[color:var(--bone-100)]';

  return (
    // platform_owner is admitted to match BoardRoleGate in app/board/layout.tsx
    // and /api/pilot/board/compliance-rules, which already serves this role.
    // Listing 'board' alone refused the owner from a register its own API
    // returns to them.
    <RoleSessionGate allowedRoles={['board', 'platform_owner']}>
      {/* The clinic room: this is the safeguarding register, so it stands in
          the room the sheet gives to clearance and safety, on the ink ground
          the pattern requires (a room never sits on canvas). */}
      <main className="room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-7xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow tracking-[0.22em]">Board Workspace</p>
            <h1 className="font-display text-[length:var(--t-2xl)] font-black text-[color:var(--bone-100)]">Hand-Filed Compliance Register</h1>
            <p className="t-body max-w-[80ch]">
              Aggregate counts of compliance violations that staff have filed by hand, with escalation status. The
              platform runs no violation detector and no screen files into this register, so these figures track
              reporting, not gym conditions.
            </p>
            <p className="t-data">
              {isLoading
                ? 'Loading the register...'
                : measuredAt
                  ? `Read ${measuredAt}`
                  : 'Read time unknown'}
            </p>
            {errorMessage ? (
              <p className="t-body flex items-center gap-[var(--s2)]">
                <span aria-hidden="true" className="text-[color:var(--brass-400)]">▲</span>
                <span>{errorMessage}</span>
              </p>
            ) : null}
            {!errorMessage && !isLoading && !summary ? (
              <p className="t-body flex items-center gap-[var(--s2)]">
                <span aria-hidden="true" className="text-[color:var(--brass-400)]">▲</span>
                <span>The register could not be read, so no counts are shown. This is a failed read, not an empty register.</span>
              </p>
            ) : null}
          </header>

          {nothingToShow ? (
            // Paper, because this is a note pinned over the register rather
            // than a metric: it keeps its own light ground and dark ink in
            // any room.
            <section className="mat-paper mt-[var(--s5)] rounded-[var(--r-md)] p-[var(--s5)]">
              <h2 className="font-display text-[length:var(--t-sm)] font-black uppercase tracking-[0.08em] text-[color:var(--brass-800)]">Read this zero correctly</h2>
              <p className="mt-[var(--s2)] max-w-[80ch] text-[length:var(--t-sm)] leading-6">
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
          <section className="mt-[var(--s6)] space-y-[var(--s3)]">
            <p className="t-body">
              {isFiltered
                ? `Severity across violations with the status "${selectedStatus}" only.`
                : 'Severity across every violation on the register.'}
            </p>
          </section>
          <section className="mt-[var(--s3)] grid gap-[var(--s4)] md:grid-cols-2 lg:grid-cols-4">
            {severityTiles.map((tile) => {
              const display = violationDisplay(tile.metric, minimumCohortSize, isLoading, isFiltered);
              const suppressed = !isLoading && tile.metric?.status === 'insufficient_data';
              const flagged = Boolean(
                tile.tone
                && !isLoading
                && tile.metric?.status === 'available'
                && (tile.metric.count ?? 0) > 0,
              );
              return (
                <article key={tile.label} className={flagged && tile.tone ? tile.tone : NEUTRAL_TILE}>
                  <h2 className="t-label flex items-center gap-[var(--s2)]">
                    {flagged ? <span aria-hidden="true">{tile.glyph}</span> : null}
                    <span>{tile.label}</span>
                  </h2>
                  {suppressed ? (
                    // k-anonymity withholding is a static ink stamp (Law 7),
                    // never an empty cell and never a zero.
                    <p className="mt-[var(--s3)]">
                      <span className="stamp stamp--flat">{display.value}</span>
                    </p>
                  ) : (
                    <p className={VALUE}>{display.value}</p>
                  )}
                  <p className="t-muted mt-[var(--s2)]">{display.note}</p>
                </article>
              );
            })}
          </section>

          {/* Status Filters */}
          <section className="mt-[var(--s6)] space-y-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-md)]">Filter by Status</h2>
            <div className="flex flex-wrap gap-[var(--s2)]">
              {['', 'new', 'acknowledged', 'escalated', 'resolved', 'dismissed'].map((status) => (
                <button
                  key={status || 'all'}
                  onClick={() => setSelectedStatus(status)}
                  className={`min-h-[44px] rounded-[var(--r-sm)] border px-[var(--s4)] text-[length:var(--t-sm)] font-bold uppercase transition ${
                    selectedStatus === status
                      ? 'mat-brass--patina border-[color:var(--brass-600)] text-[color:var(--hide-950)]'
                      : 'border-[color:rgba(212,175,74,.32)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-200)] hover:border-[color:var(--brass-400)]'
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
          <section className="mt-[var(--s6)] space-y-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-md)]">Status Summary</h2>
            <p className="t-body">
              The whole register, regardless of the filter above.
            </p>
            <div className="grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-5">
              {statusTiles.map((tile) => {
                const display = violationDisplay(tile.metric, minimumCohortSize, isLoading, false);
                const suppressed = !isLoading && tile.metric?.status === 'insufficient_data';
                return (
                  <article key={tile.label} className={NEUTRAL_TILE}>
                    <p className="t-label">{tile.label}</p>
                    {suppressed ? (
                      <p className="mt-[var(--s3)]">
                        <span className="stamp stamp--flat">{display.value}</span>
                      </p>
                    ) : (
                      <p className={VALUE}>{display.value}</p>
                    )}
                    <p className="t-muted mt-[var(--s2)]">{display.note}</p>
                  </article>
                );
              })}
            </div>

            <p className="t-body">
              This board view exposes aggregate-only compliance telemetry and excludes athlete-level identifiers. A
              count drawn from fewer than {minimumCohortSize} athletes is suppressed rather than shown, because a small
              count plus a date identifies the athlete behind it. {FILED_BY_HAND_NOTE}
            </p>
          </section>

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/board" className="btn btn--ghost">
              Back to Board Hub
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
