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
  label: string;
  value: string;
  note: string;
  accent: string;
}

const palettes: Record<BoardSummaryVariant, BoardSummaryPalette> = {
  hub: {
    frame: 'border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)]/80',
    tile: 'border border-[#654535] bg-[var(--hide-900)]',
    label: 'text-[#8f7f72]',
    value: 'text-[color:var(--bone-200)]',
    note: 'text-[#cbb8a8]',
    accent: 'text-[color:var(--brass-300)]',
  },
  workspace: {
    frame: 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)]',
    tile: 'border-2 border-[var(--black)] bg-[var(--canvas-tan)]',
    label: 'text-[var(--gray-dark)]',
    value: 'text-[var(--black)]',
    note: 'text-[var(--gray-dark)]',
    accent: 'text-[var(--red-primary)]',
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
    <section className={`${palette.frame} p-5`}>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className={`text-xs font-mono uppercase tracking-[0.22em] ${palette.accent}`}>{heading}</p>
          <h2 className={`mt-2 text-lg font-black ${palette.value}`}>Organization-level figures</h2>
        </div>
        <p className={`text-[12px] font-mono ${palette.note}`}>
          {isLoading
            ? 'Loading figures...'
            : measuredAt
              ? `Measured ${measuredAt}`
              : 'Measurement time unknown'}
        </p>
      </div>

      {errorMessage ? <p className={`mt-3 text-sm ${palette.accent}`}>{errorMessage}</p> : null}

      {summary ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tiles.map((tile) => {
              const display = boardMetricDisplay(tile.metric, summary.minimumCohortSize, tile.unitLabel);
              return (
                <article key={tile.label} className={`${palette.tile} p-3`}>
                  <p className={`text-[12px] font-mono uppercase tracking-[0.14em] ${palette.label}`}>{tile.label}</p>
                  <p className={`mt-2 text-[22px] font-black ${palette.value}`}>{display.value}</p>
                  <p className={`mt-1 text-[13px] leading-5 ${palette.note}`}>{display.note}</p>
                  {tile.metric.status === 'available' && tile.detail ? (
                    <p className={`mt-1 text-[13px] leading-5 ${palette.note}`}>{tile.detail}</p>
                  ) : null}
                </article>
              );
            })}
          </div>

          <p className={`mt-4 text-[13px] leading-5 ${palette.note}`}>
            Figures cover the whole organization. Any figure drawn from fewer than {summary.minimumCohortSize} athletes
            is suppressed rather than reduced, and &quot;No records&quot; means nothing was recorded in the period, not that
            the count is zero.
          </p>
        </>
      ) : null}
    </section>
  );
}
