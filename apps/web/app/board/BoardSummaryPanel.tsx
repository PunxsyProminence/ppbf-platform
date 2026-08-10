'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

// The board aggregate contract, mirrored on the client so this component never
// pulls a server module (and its database driver) across the client boundary.
// The server is the source of truth: see src/server/pilot/boardSummary.ts.
export type BoardAggregateStatus = 'available' | 'unavailable' | 'insufficient_data';

export interface BoardCountMetric {
  status: BoardAggregateStatus;
  count: number | null;
}

export interface BoardRateMetric extends BoardCountMetric {
  completedCount: number | null;
  completionRate: number | null;
}

export interface BoardReviewRateMetric extends BoardCountMetric {
  approvedCount: number | null;
  approvalRate: number | null;
}

export interface BoardSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  activeAthletes: BoardCountMetric;
  trainingSessions30Days: BoardRateMetric;
  goalStatusBuckets: {
    active: BoardCountMetric;
    completed: BoardCountMetric;
    other: BoardCountMetric;
  };
  coachReviews30Days: BoardReviewRateMetric;
}

export const BOARD_SUMMARY_ENDPOINT = '/api/pilot/board/summary';

export type BoardSummaryVariant = 'hub' | 'workspace';

interface BoardSummaryPalette {
  frame: string;
  tile: string;
}

// Both call sites — the hub and the seat workspace — now stand on the ink
// ground of the board room, so the two variants resolve to the same leather
// materials. The variant prop survives for call-site compatibility and as the
// seam where a future ground split would land.
const palettes: Record<BoardSummaryVariant, BoardSummaryPalette> = {
  hub: {
    frame: 'mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)]',
    tile: 'stat',
  },
  workspace: {
    frame: 'mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)]',
    tile: 'stat',
  },
};

export interface BoardMetricDisplay {
  value: string;
  note: string;
}

/**
 * The three aggregate states are three different facts and must never collapse
 * into one another on screen. A suppressed figure is a figure that exists and
 * is being withheld, so it can never be drawn as a blank or as a zero -- a
 * board reading "0" would take it for a measurement.
 */
export function boardMetricDisplay(
  metric: BoardCountMetric,
  minimumCohortSize: number,
  unitLabel: string,
): BoardMetricDisplay {
  if (metric.status === 'insufficient_data') {
    return {
      value: 'Suppressed',
      note: `Fewer than ${minimumCohortSize} athletes contributed, so the figure is withheld.`,
    };
  }

  if (metric.status === 'unavailable' || metric.count === null) {
    return {
      value: 'No records',
      note: `No ${unitLabel} recorded in this period.`,
    };
  }

  return {
    value: String(metric.count),
    note: `Measured; at least ${minimumCohortSize} athletes contributed.`,
  };
}

export function boardRateDisplay(
  rate: number | null,
  numerator: number | null,
  denominator: number | null,
  label: string,
): string | null {
  if (rate === null || numerator === null || denominator === null) {
    return null;
  }
  return `${label} ${Math.round(rate * 100)}% (${numerator} of ${denominator})`;
}

/**
 * Renders the moment the figures were measured. A safeguarding number carries
 * its own timestamp or it is not a safeguarding number: a board must be able to
 * tell a reading taken minutes ago from one taken last quarter.
 */
export function formatMeasuredAt(generatedAt: string): string | null {
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

interface BoardSummaryPanelProps {
  readonly variant?: BoardSummaryVariant;
  readonly heading?: string;
}

export default function BoardSummaryPanel({
  variant = 'workspace',
  heading = 'Organization aggregate',
}: BoardSummaryPanelProps) {
  const palette = palettes[variant];
  const [summary, setSummary] = useState<BoardSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}${BOARD_SUMMARY_ENDPOINT}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('Unable to load the organization aggregate.');
        }
        const payload = (await response.json()) as { success?: boolean; summary?: BoardSummary };
        if (payload.success !== true || !payload.summary) {
          throw new Error('Organization aggregate unavailable.');
        }
        setSummary(payload.summary);
        setErrorMessage('');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setSummary(null);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the organization aggregate.');
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  const measuredAt = summary ? formatMeasuredAt(summary.generatedAt) : null;

  const tiles = summary
    ? [
      {
        label: 'Active Athletes',
        metric: summary.activeAthletes,
        unitLabel: 'active athletes',
        detail: null as string | null,
      },
      {
        label: 'Training Sessions (30 Days)',
        metric: summary.trainingSessions30Days,
        unitLabel: 'training sessions',
        detail: boardRateDisplay(
          summary.trainingSessions30Days.completionRate,
          summary.trainingSessions30Days.completedCount,
          summary.trainingSessions30Days.count,
          'Completed',
        ),
      },
      {
        label: 'Coach Reviews (30 Days)',
        metric: summary.coachReviews30Days,
        unitLabel: 'coach reviews',
        detail: boardRateDisplay(
          summary.coachReviews30Days.approvalRate,
          summary.coachReviews30Days.approvedCount,
          summary.coachReviews30Days.count,
          'Approved',
        ),
      },
      {
        label: 'Goals Active',
        metric: summary.goalStatusBuckets.active,
        unitLabel: 'active goals',
        detail: null,
      },
      {
        label: 'Goals Completed',
        metric: summary.goalStatusBuckets.completed,
        unitLabel: 'completed goals',
        detail: null,
      },
      {
        label: 'Goals Other Status',
        metric: summary.goalStatusBuckets.other,
        unitLabel: 'goals in another status',
        detail: null,
      },
    ]
    : [];

  return (
    <section className={`${palette.frame} p-[var(--s5)]`}>
      <div className="flex flex-col gap-[var(--s2)] md:flex-row md:items-end md:justify-between">
        <div>
          <p className="t-eyebrow tracking-[0.22em]">{heading}</p>
          <h2 className="t-command mt-[var(--s2)] text-[length:var(--t-md)]">Organization-level figures</h2>
        </div>
        {/* The read time is part of the record (a safeguarding figure carries
            its own timestamp), so it speaks in the data voice. */}
        <p className="t-data">
          {isLoading
            ? 'Loading figures...'
            : measuredAt
              ? `Measured ${measuredAt}`
              : 'Measurement time unknown'}
        </p>
      </div>

      {errorMessage ? (
        <p className="t-body mt-[var(--s3)] flex items-center gap-[var(--s2)]">
          <span aria-hidden="true" className="text-[color:var(--brass-400)]">▲</span>
          <span>{errorMessage}</span>
        </p>
      ) : null}

      {summary ? (
        <>
          <div className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2 xl:grid-cols-3">
            {tiles.map((tile) => {
              const display = boardMetricDisplay(tile.metric, summary.minimumCohortSize, tile.unitLabel);
              const suppressed = tile.metric.status === 'insufficient_data';
              return (
                <article key={tile.label} className={palette.tile}>
                  <p className="stat-label">{tile.label}</p>
                  {suppressed ? (
                    // k-anonymity withholding is a static ink stamp (Law 7),
                    // never a blank and never a zero.
                    <p>
                      <span className="stamp stamp--flat">{display.value}</span>
                    </p>
                  ) : (
                    <p className="stat-val">{display.value}</p>
                  )}
                  <p className="stat-note">{display.note}</p>
                  {tile.metric.status === 'available' && tile.detail ? (
                    <p className="stat-note">{tile.detail}</p>
                  ) : null}
                </article>
              );
            })}
          </div>

          <p className="t-muted mt-[var(--s4)]">
            Figures cover the whole organization. Any figure drawn from fewer than {summary.minimumCohortSize} athletes
            is suppressed rather than reduced, and &quot;No records&quot; means nothing was recorded in the period, not that
            the count is zero.
          </p>
        </>
      ) : null}
    </section>
  );
}
