'use client';

import { useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTime, gymDayIso } from '@/src/lib/gymTime';

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

export interface BoardReportWindow {
  from: string;
  to: string;
}

export interface BoardReport extends BoardSummary {
  window: BoardReportWindow;
  timeZone: string;
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
    frame: 'mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)]',
    tile: 'stat',
  },
  workspace: {
    frame: 'mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)]',
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

/** The 30 gym days ending today, inclusive: the report's default window. */
export function defaultReportWindow(nowMs: number): BoardReportWindow {
  const to = gymDayIso(new Date(nowMs)) ?? new Date(nowMs).toISOString().slice(0, 10);
  const [year, month, day] = to.split('-').map(Number);
  const from = new Date(Date.UTC(year!, month! - 1, day! - 29)).toISOString().slice(0, 10);
  return { from, to };
}

interface ReportFigure {
  label: string;
  metric: BoardCountMetric;
  unitLabel: string;
  detail: string | null;
}

function reportFigures(report: BoardReport): ReportFigure[] {
  return [
    { label: 'Active athletes', metric: report.activeAthletes, unitLabel: 'active athletes', detail: null },
    {
      label: 'Training sessions',
      metric: report.trainingSessions30Days,
      unitLabel: 'training sessions',
      detail: boardRateDisplay(
        report.trainingSessions30Days.completionRate,
        report.trainingSessions30Days.completedCount,
        report.trainingSessions30Days.count,
        'Completed',
      ),
    },
    {
      label: 'Coach reviews',
      metric: report.coachReviews30Days,
      unitLabel: 'coach reviews',
      detail: boardRateDisplay(
        report.coachReviews30Days.approvalRate,
        report.coachReviews30Days.approvedCount,
        report.coachReviews30Days.count,
        'Approved',
      ),
    },
    { label: 'Goals active', metric: report.goalStatusBuckets.active, unitLabel: 'active goals', detail: null },
    { label: 'Goals completed', metric: report.goalStatusBuckets.completed, unitLabel: 'completed goals', detail: null },
    { label: 'Goals in another status', metric: report.goalStatusBuckets.other, unitLabel: 'goals in another status', detail: null },
  ];
}

/*
 * THE DATED BOARD REPORT (#1542, RP-04). A window the board chooses (the last
 * 30 gym days by default), the same aggregate figures and suppression as the
 * tiles above, when it was made, and what each figure counts. Print prints the
 * report alone; the browser's "Save as PDF" makes the file. Aggregate only: no
 * athlete appears. The definitions are written from the query in
 * src/server/pilot/boardSummary.ts.
 */
function BoardReportSection() {
  const [range, setRange] = useState<BoardReportWindow>(() => defaultReportWindow(Date.now()));
  const [report, setReport] = useState<BoardReport | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function makeReport() {
    if (busyRef.current) return;
    setFailure('');
    if (!range.from || !range.to || range.from > range.to) {
      setFailure('Choose a From date on or before the To date.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      const response = await fetch(`${apiBase()}${BOARD_SUMMARY_ENDPOINT}?${params}`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; report?: BoardReport; error?: string };
      if (!response.ok || payload.success !== true || !payload.report) {
        throw new Error(payload.error || 'The report could not be made.');
      }
      setReport(payload.report);
    } catch (error) {
      setReport(null);
      setFailure(error instanceof Error && error.message ? error.message : 'The report could not be made.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-[var(--s5)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
      <h3 className="t-label">Board report</h3>
      <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
        <label className="field">
          <span className="t-label">From</span>
          <input
            type="date"
            className="input"
            value={range.from}
            onChange={(event) => { setFailure(''); setRange((held) => ({ ...held, from: event.target.value })); }}
          />
        </label>
        <label className="field">
          <span className="t-label">To</span>
          <input
            type="date"
            className="input"
            value={range.to}
            onChange={(event) => { setFailure(''); setRange((held) => ({ ...held, to: event.target.value })); }}
          />
        </label>
        <button type="button" className="btn" onClick={() => void makeReport()} disabled={busy}>
          {busy ? 'Making…' : 'Make report'}
        </button>
        {report ? (
          <button type="button" className="btn btn--ghost" onClick={() => window.print()}>Print</button>
        ) : null}
      </div>
      {failure ? (
        <div role="alert" className="alert alert--critical mt-[var(--s3)]">
          <span className="alert-icon" aria-hidden="true">✕</span>
          <div className="alert-body">
            <p className="alert-title">Report not made</p>
            <p className="alert-msg">{failure}</p>
          </div>
        </div>
      ) : null}
      {report ? (
        <>
          {/* On paper, only the report: everything else on the page is hidden
              while printing, and the report sits at the top of the sheet. */}
          <style>{'@media print { body * { visibility: hidden !important; } .board-report-print, .board-report-print * { visibility: visible !important; } .board-report-print { position: absolute; left: 0; top: 0; width: 100%; } }'}</style>
          <article aria-label="Board report" className="board-report-print mt-[var(--s4)]">
            <h4 className="t-command text-[length:var(--t-md)]">Board summary report</h4>
            <p className="t-body mt-[var(--s2)]">
              Reporting window: {report.window.from} to {report.window.to} (gym days, inclusive).
            </p>
            <p className="t-data">Made {formatGymDateTime(report.generatedAt) ?? report.generatedAt} (gym time).</p>
            <table className="mt-[var(--s3)] w-full text-left">
              <thead>
                <tr className="t-eyebrow">
                  <th scope="col" className="py-[var(--s2)]">Figure</th>
                  <th scope="col" className="py-[var(--s2)]">Value</th>
                  <th scope="col" className="py-[var(--s2)]">Note</th>
                </tr>
              </thead>
              <tbody>
                {reportFigures(report).map((figure) => {
                  const display = boardMetricDisplay(figure.metric, report.minimumCohortSize, figure.unitLabel);
                  return (
                    <tr key={figure.label} className="t-body">
                      <th scope="row" className="py-[var(--s2)] font-normal">{figure.label}</th>
                      <td className="py-[var(--s2)]">{display.value}</td>
                      <td className="py-[var(--s2)]">
                        {display.note}
                        {figure.metric.status === 'available' && figure.detail ? ` ${figure.detail}.` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h5 className="t-label mt-[var(--s4)]">Definitions</h5>
            <ul className="t-body mt-[var(--s2)] list-disc space-y-[var(--s1)] pl-[var(--s4)]">
              <li>Scope: the whole organization. No individual athlete appears in this report.</li>
              <li>Active athletes: athletes marked active and not deleted, as of when this report was made.</li>
              <li>
                Training sessions: sessions dated in the reporting window, for athletes active when the report was made.
                Completed means the session is marked completed.
              </li>
              <li>
                Coach reviews: reviews written on a gym day in the reporting window, on sessions of athletes active when
                the report was made. Approved means the review is marked approved.
              </li>
              <li>
                Goals: the current goals of active athletes, as of when this report was made, by status. Active is
                active, open or in progress; completed is completed, complete or achieved; another status is anything else.
              </li>
              <li>
                Suppressed: fewer than {report.minimumCohortSize} athletes contributed, so the figure is withheld rather
                than reduced. No records: nothing was recorded, which is not a measured zero.
              </li>
              <li>Active athletes and goals have no stored history, so they are not figures for the window.</li>
            </ul>
          </article>
        </>
      ) : null}
    </div>
  );
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

      <BoardReportSection />
    </section>
  );
}
