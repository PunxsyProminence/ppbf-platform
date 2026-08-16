'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

// Read-only rollup over data the gym already records: session logs and RPE
// (pilot.sessions), readiness check-ins (pilot.readiness), go-forward
// training-day evidence (pilot.activity_log), and the progression loop.
// Numbers are labeled by their actual source -- "training days" is the
// activity log's evidence stream, deliberately NOT an attendance percentage,
// because attendance-source adjudication is a separately owned decision (see
// performanceAnalytics.ts).
interface PerformanceItem {
  athlete_id: string;
  full_name: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  training_days: number;
  readiness_count: number;
  avg_readiness: number | null;
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  open_gaps: number;
  active_assignments: number;
  avg_assignment_completion: number | null;
}

const WINDOW_CHOICES = [7, 28, 90] as const;

function formatNumber(value: number | null, digits = 1): string {
  if (value == null) return '—';
  return value.toFixed(digits);
}

// Direction is shown only when both halves of the window have check-ins and
// the means differ by a margin worth a coach's glance. This is a glanceable
// cue, not a statistical claim -- the SHADOW lane owns real inference.
function ReadinessTrend({ early, late }: { early: number | null; late: number | null }) {
  if (early == null || late == null) return null;
  const delta = late - early;
  if (Math.abs(delta) < 0.5) {
    return <span className="badge badge--monitor"><i>◉</i>steady</span>;
  }
  return delta > 0 ? (
    <span className="badge badge--cleared"><i>▲</i>rising</span>
  ) : (
    <span className="badge badge--restricted"><i>▼</i>falling</span>
  );
}

export default function PerformanceAnalyticsPage() {
  const [windowDays, setWindowDays] = useState<number>(28);
  const [items, setItems] = useState<PerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setErrorMessage(null);
        const response = await fetch(
          `${apiBase()}/api/pilot/analytics/performance?window_days=${windowDays}`,
          { method: 'GET', credentials: 'include' },
        );
        if (!response.ok) throw new Error(`Failed to load performance analytics: ${response.status}`);
        const payload = (await response.json()) as { items?: PerformanceItem[] };
        setItems(payload.items ?? []);
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load performance analytics.');
      } finally {
        setLoading(false);
      }
    })();
  }, [windowDays]);

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/performance-analytics" allowedRoles={['coach', 'admin']} room="floor" showShellHeader={false}>
      <div className="room--floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-6xl">
          <div className="mb-[var(--s5)]">
            <p className="t-eyebrow">Performance Analytics</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Roster Rollup</h1>
            <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
              Session logs, readiness check-ins, training days, and progression work over the selected window.
              Read-only; every number comes from records the gym already keeps.
            </p>
          </div>

          <nav aria-label="Window" className="mb-[var(--s5)] flex gap-[var(--s3)]">
            {WINDOW_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={choice === windowDays ? 'btn' : 'btn btn--ghost'}
                aria-pressed={choice === windowDays}
                onClick={() => setWindowDays(choice)}
              >
                {choice} days
              </button>
            ))}
          </nav>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading performance rollup...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">🥊</div>
                <div className="empty-title">No athletes on your roster</div>
                <p className="empty-msg mx-auto">Athletes you coach (or cover) will appear here with their rollup.</p>
              </div>
            </div>
          ) : (
            <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]" style={{ overflowX: 'auto' }}>
              <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="text-left">
                    <th className="t-label p-[var(--s3)]">Athlete</th>
                    <th className="t-label p-[var(--s3)]">Sessions</th>
                    <th className="t-label p-[var(--s3)]">Avg RPE</th>
                    <th className="t-label p-[var(--s3)]">Training days</th>
                    <th className="t-label p-[var(--s3)]">Readiness</th>
                    <th className="t-label p-[var(--s3)]">Trend</th>
                    <th className="t-label p-[var(--s3)]">Open gaps</th>
                    <th className="t-label p-[var(--s3)]">Drill completion</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.athlete_id} className="border-t border-[color:rgba(212,175,74,.18)]">
                      <td className="p-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{item.full_name}</td>
                      <td className="t-data p-[var(--s3)]">{item.sessions_completed}/{item.sessions_total}</td>
                      <td className="t-data p-[var(--s3)]">{formatNumber(item.avg_rpe)}</td>
                      <td className="t-data p-[var(--s3)]">{item.training_days}</td>
                      <td className="t-data p-[var(--s3)]">
                        {formatNumber(item.avg_readiness)}
                        {item.readiness_count > 0 ? (
                          <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">({item.readiness_count} check-ins)</span>
                        ) : null}
                      </td>
                      <td className="p-[var(--s3)]">
                        <ReadinessTrend early={item.readiness_early_avg} late={item.readiness_late_avg} />
                      </td>
                      <td className="t-data p-[var(--s3)]">{item.open_gaps}</td>
                      <td className="t-data p-[var(--s3)]">
                        {item.avg_assignment_completion == null ? '—' : `${Math.round(item.avg_assignment_completion)}%`}
                        {item.active_assignments > 0 ? (
                          <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">({item.active_assignments} active)</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/progression-intelligence" className="btn btn--ghost">
              Progression Intelligence
            </Link>
            <Link href="/coach/operations" className="btn btn--ghost">
              Coach Operations
            </Link>
          </div>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
