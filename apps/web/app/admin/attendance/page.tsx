"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateShort, formatGymDayShort } from '@/src/lib/gymTime';

interface AttendanceAthleteSummary {
  athlete_id: string;
  full_name: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
  last_marked_at: string | null;
  attendance_rate: number | null;
}

interface WeeklyAttendanceTrendRow {
  week_start: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
  attendance_rate: number | null;
}

const TREND_WEEKS = 8;

interface FilledTrendWeek extends WeeklyAttendanceTrendRow {
  omitted?: boolean;
}

/**
 * getWeeklyAttendanceTrend OMITS a week with zero marks rather than
 * zero-filling it (see its own doc comment) -- attendance_rate: null would
 * be indistinguishable from a real 0% week. That's the right call server
 * side, but it pushes the promised "fills gaps on render" onto this page.
 * Round 9 review caught that nothing here actually did that: trend.map(...)
 * rendered whatever weeks came back as adjacent bars with no gap marker, so
 * a closed-gym week read as identical to "there were only N weeks of data."
 * This reindexes the response onto every Monday between its first and last
 * returned week, inserting an explicit omitted placeholder for any week the
 * server dropped.
 */
function fillWeeklyTrendGaps(trend: WeeklyAttendanceTrendRow[]): FilledTrendWeek[] {
  if (trend.length === 0) return [];
  const byWeekStart = new Map(trend.map((week) => [week.week_start, week]));
  const filled: FilledTrendWeek[] = [];
  const cursor = new Date(`${trend[0].week_start}T00:00:00Z`);
  const end = new Date(`${trend[trend.length - 1].week_start}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    const existing = byWeekStart.get(key);
    filled.push(
      existing ?? {
        week_start: key,
        present_count: 0,
        absent_count: 0,
        excused_count: 0,
        total_marked: 0,
        attendance_rate: null,
        omitted: true,
      },
    );
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return filled;
}

function formatWeekLabel(weekStart: string): string {
  return formatGymDayShort(weekStart) ?? weekStart;
}

function formatRate(rate: number | null): string {
  if (rate === null) return 'Unavailable';
  return `${Math.round(rate * 100)}%`;
}

function formatLastMarked(value: string | null): string {
  if (!value) return 'Never';
  return formatGymDateShort(value) ?? value;
}

// Sorts athletes with a real rate first (worst attendance first, so a coach
// or admin sees who needs attention without hunting for them), and pushes
// never-marked athletes to the bottom under their own heading rather than
// interleaving "0%" (a real, bad number) with "no data yet" (not a number at
// all) -- collapsing those two would be exactly the fabrication this
// dashboard exists to avoid.
function sortSummary(items: AttendanceAthleteSummary[]): AttendanceAthleteSummary[] {
  const withRate = items.filter((item) => item.attendance_rate !== null).sort((a, b) => (a.attendance_rate ?? 0) - (b.attendance_rate ?? 0));
  const withoutRate = items.filter((item) => item.attendance_rate === null).sort((a, b) => a.full_name.localeCompare(b.full_name));
  return [...withRate, ...withoutRate];
}

export default function AttendanceDashboardPage() {
  const [items, setItems] = useState<AttendanceAthleteSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  // Best-effort and independent of the summary above: a trend that fails to
  // load must not take the athlete-level table down with it.
  const [trend, setTrend] = useState<WeeklyAttendanceTrendRow[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/scheduler/attendance-summary?trend=1&weeks=${TREND_WEEKS}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => ({}))) as { trend?: WeeklyAttendanceTrendRow[] };
        setTrend(payload.trend ?? []);
      } catch {
        if (controller.signal.aborted) return;
        // No trend strip is a smaller loss than a broken dashboard.
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/scheduler/attendance-summary`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as {
          athletes?: AttendanceAthleteSummary[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load attendance summary.');
        }
        setItems(payload.athletes ?? []);
        setErrorMessage('');
      } catch (error) {
        if (controller.signal.aborted) return;
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load attendance summary.');
      }
    })();
    return () => controller.abort();
  }, []);

  const sorted = useMemo(() => sortSummary(items ?? []), [items]);

  const kpis = useMemo(() => {
    const source = items ?? [];
    const withRate = source.filter((item) => item.attendance_rate !== null);
    const averageRate = withRate.length === 0
      ? null
      : withRate.reduce((sum, item) => sum + (item.attendance_rate ?? 0), 0) / withRate.length;
    return {
      totalAthletes: source.length,
      neverMarked: source.filter((item) => item.total_marked === 0).length,
      averageRate,
    };
  }, [items]);

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Attendance</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | ROLLS UP pilot.scheduler_attendance</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every mark comes from a real check-in recorded on the <Link href="/schedule" className="underline">Schedule</Link> page.
              An athlete with no rows here has never been checked in for a class, not a 0% attendance rate --
              those two facts are shown separately below.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
          </header>

          <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-3">
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">Athletes tracked</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">
                {isLoading ? '—' : kpis.totalAthletes}
              </p>
            </article>
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">Never checked in</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">
                {isLoading ? '—' : kpis.neverMarked}
              </p>
            </article>
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">Average rate (marked athletes)</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">
                {isLoading ? '—' : formatRate(kpis.averageRate)}
              </p>
            </article>
          </section>

          {trend && trend.length > 0 ? (
            <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]">
              <p className="t-eyebrow">Weekly trend (last {TREND_WEEKS} weeks)</p>
              <div className="mt-[var(--s3)] flex items-end gap-[var(--s2)]" style={{ height: '72px' }}>
                {fillWeeklyTrendGaps(trend).map((week) => {
                  const heightPercent = week.attendance_rate === null ? 4 : Math.max(4, Math.round(week.attendance_rate * 100));
                  const label = week.omitted
                    ? `Week of ${formatWeekLabel(week.week_start)}: no attendance data`
                    : `Week of ${formatWeekLabel(week.week_start)}: ${formatRate(week.attendance_rate)}`;
                  return (
                    <div key={week.week_start} className="flex flex-1 flex-col items-center justify-end gap-[var(--s1)]" style={{ height: '100%' }}>
                      <div
                        role="img"
                        aria-label={label}
                        title={label}
                        className={
                          week.omitted
                            ? 'w-full rounded-t-[var(--r-sm)] border border-dashed border-[color:var(--bone-500)] bg-transparent opacity-40'
                            : 'w-full rounded-t-[var(--r-sm)] bg-[var(--brass-500)]'
                        }
                        style={{ height: `${heightPercent}%`, minHeight: '4px' }}
                      />
                      <p className="t-data text-[length:var(--t-xs)] text-[color:var(--bone-400)]">{formatWeekLabel(week.week_start)}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading attendance…</div>
            </div>
          ) : errorMessage ? (
            // Same rule as the escalations page: a failed load is not an
            // empty roster, and must not read as one.
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">Attendance could not be loaded</div>
              <div className="empty-msg">The summary is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">No active athletes in scope yet</div>
              <div className="empty-msg">
                Coaches see athletes registered for their own classes; organization_admin/admin see the whole roster.
              </div>
            </div>
          ) : (
            /* A ruled sheet on the desk. .ledger is the office's own record
                furniture -- rules, head rule, and the mono voice Law 4 gives
                anything auditable -- so every hand-rolled px/py/border on the
                rows below is gone with it. */
            <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
              <table className="ledger">
                <caption className="text-left">Attendance</caption>
                <thead>
                  <tr>
                    <th scope="col">Athlete</th>
                    <th scope="col">Present</th>
                    <th scope="col">Absent</th>
                    <th scope="col">Excused</th>
                    <th scope="col">Rate</th>
                    <th scope="col">Last marked</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((item) => (
                    <tr key={item.athlete_id}>
                      <td>{item.full_name}</td>
                      <td>{item.present_count}</td>
                      <td>{item.absent_count}</td>
                      <td>{item.excused_count}</td>
                      <td>
                        {item.attendance_rate === null ? (
                          <span className="badge badge--monitor"><i>◉</i>Unavailable</span>
                        ) : (
                          formatRate(item.attendance_rate)
                        )}
                      </td>
                      <td>{formatLastMarked(item.last_marked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/schedule" className="btn btn--ghost">
              Go to Schedule (mark attendance)
            </Link>
            <Link href="/admin/athletes" className="btn btn--ghost">
              Athlete Records
            </Link>
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
