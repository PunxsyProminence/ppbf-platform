"use client";

import { useEffect, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatMeasuredAt, type BoardCountMetric } from '../BoardSummaryPanel';

// The board's only window into the escalation ladder. The API
// (GET /api/pilot/board/escalation-summary) is count-only and
// k-anonymity-gated -- the board learns how many are open per severity,
// never who. The board is deliberately 403'd from the escalation rows
// themselves; this page is why that refusal is not "the board learns
// nothing".
interface EscalationSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  openBySeverity: {
    critical: BoardCountMetric;
    high: BoardCountMetric;
    moderate: BoardCountMetric;
    low: BoardCountMetric;
  };
}

function escalationDisplay(
  metric: BoardCountMetric | undefined,
  minimumCohortSize: number,
  isLoading: boolean,
): { value: string; note: string } {
  if (isLoading) {
    return { value: '...', note: 'Loading the ladder.' };
  }

  if (!metric) {
    return { value: 'Unavailable', note: 'The ladder could not be read.' };
  }

  if (metric.status === 'insufficient_data') {
    return {
      value: 'Suppressed',
      note: `Fewer than ${minimumCohortSize} athletes are involved, so the count is withheld.`,
    };
  }

  if (metric.status === 'unavailable' || metric.count === null) {
    return {
      value: 'None open',
      note: 'No escalation at this severity is currently open. Resolved ladders are not counted here.',
    };
  }

  return { value: String(metric.count), note: 'Open escalations staff have raised on the ladder.' };
}

export default function BoardEscalationMonitoringPage() {
  const [summary, setSummary] = useState<EscalationSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`${apiBase()}/api/pilot/board/escalation-summary`, { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Unable to load the escalation summary.');
        }
        const payload = (await response.json()) as { ok?: boolean; summary?: EscalationSummary };
        if (payload.ok !== true || !payload.summary) {
          throw new Error('Escalation summary unavailable.');
        }
        setSummary(payload.summary);
        setErrorMessage('');
      } catch (error) {
        setSummary(null);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the escalation summary.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const minimumCohortSize = summary?.minimumCohortSize ?? 5;
  const measuredAt = summary ? formatMeasuredAt(summary.generatedAt) : null;
  const buckets = summary?.openBySeverity ?? null;
  const nothingOpen = Boolean(
    summary
    && (['critical', 'high', 'moderate', 'low'] as const).every(
      (key) => summary.openBySeverity[key].status === 'unavailable',
    ),
  );

  // Same idiom as the compliance register: severity wears the saturated band
  // only when a measured count is actually open; an empty or suppressed
  // bucket stays neutral leather.
  const severityTiles = [
    { label: 'Critical', metric: buckets?.critical, glyph: '✕', tone: 'flex flex-col gap-[var(--s2)] rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[color-mix(in_srgb,var(--locked)_16%,transparent)] p-[var(--s4)] px-[var(--s5)]' },
    { label: 'High', metric: buckets?.high, glyph: '▲', tone: 'flex flex-col gap-[var(--s2)] rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_16%,transparent)] p-[var(--s4)] px-[var(--s5)]' },
    { label: 'Moderate', metric: buckets?.moderate, glyph: null, tone: null },
    { label: 'Low', metric: buckets?.low, glyph: null, tone: null },
  ];

  // .stat / .stat-val / .stat-label are the sheet's count tile, and
  // BoardSummaryPanel already renders the hub's figures with them. These two
  // constants were a second implementation of the same object, so the hub's
  // tiles and this register's tiles were visibly different things standing in
  // one room. The saturated severity band stays a local class because it is a
  // status treatment, not a tile.
  const NEUTRAL_TILE = 'stat';
  const VALUE = 'stat-val';

  return (
    // platform_owner is admitted to match BoardRoleGate in app/board/layout.tsx
    // and the sibling compliance register page.
    <RoleSessionGate allowedRoles={['board', 'platform_owner']}>
      <main className="room room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-7xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow tracking-[0.22em]">Board Workspace</p>
            <h1 className="font-display text-[length:var(--t-2xl)] font-black text-[color:var(--bone-100)]">Escalation Ladder</h1>
            <p className="t-body max-w-[80ch]">
              How many safety escalations are open right now, by severity, across the whole organization. The board
              sees counts only: fewer than {minimumCohortSize} athletes in a bucket and the number is withheld, and
              no name, case, or detail ever reaches this page. Working the ladder itself is the organization
              admin&rsquo;s job.
            </p>
            <p className="t-data">
              {isLoading
                ? 'Loading the ladder...'
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
          </header>

          {nothingOpen ? (
            <section className="mat-paper mt-[var(--s5)] rounded-[var(--r-md)] p-[var(--s5)]">
              <h2 className="font-display text-[length:var(--t-sm)] font-black uppercase tracking-[0.08em] text-[color:var(--brass-800)]">Read this zero correctly</h2>
              <p className="mt-[var(--s2)] max-w-[80ch] text-[length:var(--t-sm)] leading-6">
                No escalation is currently open on the ladder. Escalations are raised by staff, so an empty ladder
                means nothing is open right now &mdash; it is not a measurement of underlying conditions, and it says
                nothing about escalations already resolved.
              </p>
            </section>
          ) : null}

          <section className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-2 lg:grid-cols-4">
            {severityTiles.map((tile) => {
              const display = escalationDisplay(tile.metric, minimumCohortSize, isLoading);
              const suppressed = !isLoading && tile.metric?.status === 'insufficient_data';
              const flagged = Boolean(
                tile.tone
                && !isLoading
                && tile.metric?.status === 'available'
                && (tile.metric.count ?? 0) > 0,
              );
              return (
                <article key={tile.label} className={flagged && tile.tone ? tile.tone : NEUTRAL_TILE}>
                  <h2 className="stat-label flex items-center gap-[var(--s2)]">
                    {flagged ? <span aria-hidden="true">{tile.glyph}</span> : null}
                    <span>{tile.label}</span>
                  </h2>
                  {suppressed ? (
                    <p>
                      <span className="stamp stamp--flat">{display.value}</span>
                    </p>
                  ) : (
                    <p className={VALUE}>{display.value}</p>
                  )}
                  <p className="stat-note">{display.note}</p>
                </article>
              );
            })}
          </section>
        </div>
      </main>
    </RoleSessionGate>
  );
}
