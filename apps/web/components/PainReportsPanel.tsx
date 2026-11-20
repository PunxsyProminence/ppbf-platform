'use client';

import Link from 'next/link';

import type { PainReportsRead, CoachPainReport } from '@/components/usePainReports';
import { formatGymStamp } from '@/src/lib/gymTime';
import { painScoreLabel } from '@/src/shared/painScoreLabel';

/**
 * ATHLETE PAIN REPORTS (lane U2-6b-2): the coach home's pain list, moved out of CoachWorkspace
 * with its markup and words unchanged, so the class screen can show it too. Its read now asks for
 * up to 50 reports (QF = A), and a body that cannot state its window, completeness or list shows
 * the failed-read words, never the "No athlete on your roster has reported pain" line.
 * It draws one shared read (usePainReports): the coach home's, or on the class screen the same
 * read the pain tile counts, so the two show the same answer (Overwatch's 6b ruling).
 *
 * Drawn --restricted, not --locked: "A pain report is not a medical stop at any severity"
 * (OD-2026-10-03-017), and --locked is the medical stop (UXB-10).
 */

/** What a missing detail is called, which depends on who was asked. */
export function painDetailAbsent(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Not stated by the athlete' : 'Not stated';
}

/** The label over the time the report refers to. */
export function painObservedLabel(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Athlete reported it happened' : 'Reported as happening';
}

/* The provenance sentence under each card. Only an athlete's own report is
   described as self-reported; a staff-entered one says so and says it is not a
   medical assessment; an unestablished reporter says that rather than
   defaulting to the athlete. */
export const PAIN_PROVENANCE: Record<CoachPainReport['reporter'], string> = {
  athlete:
    'Self-reported by the athlete. This is not a coach assessment and not a medical assessment.',
  coach:
    'Entered by a coach, not self-reported by the athlete. This is an observation, not a medical assessment.',
  staff_admin:
    'Entered by staff, not self-reported by the athlete. This is an observation, not a medical assessment.',
  unknown:
    'The reporter is not recorded. Do not read this as self-reported by the athlete. This is an observation, not a medical assessment.',
};

// --locked means a medical stop (OD-2026-09-29-001). A pain report is not one,
// whatever its severity (Jason, 2026-10-03), so critical, high and moderate share
// the restricted rung; the badge label still names the severity.
export function painSeverityTone(severity: CoachPainReport['severity']): 'restricted' | 'monitor' {
  if (severity === 'critical' || severity === 'high' || severity === 'moderate') return 'restricted';
  return 'monitor';
}

// A stored timestamp the browser cannot parse is shown verbatim rather than as
// "Invalid Date": the raw value is at least something a coach can report.
export function painReportTime(value: string | null): string {
  if (!value) {
    return 'Not recorded';
  }
  const parsed = new Date(value);
  return formatGymStamp(parsed) ?? value;
}

/** The coach home's StatusBadge markup for the two rungs a pain report wears. */
function PainBadge({ tone, label }: { readonly tone: 'restricted' | 'monitor'; readonly label: string }) {
  return (
    <span className={`badge badge--${tone}`}>
      <i>{tone === 'restricted' ? '▲' : '◉'}</i>
      {label}
    </span>
  );
}

export default function PainReportsPanel({
  read,
  boardShown,
}: {
  readonly read: PainReportsRead;
  /** The coach home's floor board is on screen: "Record what you did" is there, not a link here. */
  readonly boardShown: boolean;
}) {
  return (
    <section id="coach-dashboard-details" aria-live="polite" className="mat-leather rounded-[var(--r-lg)] border-2 border-[color:var(--restricted)] p-[var(--s4)] space-y-[var(--s3)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h2 className="font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.12em] text-[var(--restricted-ink)]">
          Athlete Pain Reports
        </h2>
        <button
          type="button"
          onClick={read.reload}
          className="btn btn--ghost"
          aria-label="Refresh athlete pain reports"
        >
          Refresh
        </button>
      </div>

      {read.loading && (
        <p className="text-xs text-[color:var(--bone-300)]">Checking for athlete pain reports...</p>
      )}

      {!read.loading && read.error && (
        <div className="border-2 border-[var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_22%,var(--hide-950))]/20 p-3">
          <p className="text-sm font-semibold text-[color:var(--restricted-ink)]">{read.error}</p>
          <p className="mt-1 text-xs text-[color:var(--restricted-ink)]">
            Pain reports may exist that are not shown here. Do not read this as &quot;no athlete
            reported pain&quot; -- ask the floor.
          </p>
        </div>
      )}

      {!read.loading && !read.error && read.reports.length === 0 && (
        <p className="text-xs text-[color:var(--bone-400)]">
          No athlete on your roster has reported pain
          {read.windowDays === null ? '' : ` in the last ${read.windowDays} days`}. A report
          appears here as soon as an athlete submits one.
        </p>
      )}

      {!read.loading && !read.error && read.reports.length > 0 && (
        <div className="space-y-3">
          {read.truncated && (
            <p className="text-xs text-[var(--restricted-ink)]">
              More reports matched than are listed here. The highest-severity ones are shown first;
              the rest are in each athlete&apos;s near-miss history on the decision loop.
            </p>
          )}

          {read.reports.map((report) => (
            <article key={report.nearMissId} className="mat-leather--raised rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] p-[var(--s3)] space-y-[var(--s3)]">
              <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                <div>
                  <p className="text-[length:var(--t-md)] font-black text-[color:var(--bone-100)]">
                    {report.athleteName ?? 'Athlete name unavailable'}
                  </p>
                  <p className="t-data text-[color:var(--bone-400)]">Athlete ID {report.athleteId}</p>
                </div>
                <PainBadge
                  tone={painSeverityTone(report.severity)}
                  label={painScoreLabel(report.painScore)}
                />
              </div>

              <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Body location</dt>
                  <dd className={report.location ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                    {report.location ?? painDetailAbsent(report.reporter)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Pain type</dt>
                  <dd className={report.painType ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                    {report.painType ?? painDetailAbsent(report.reporter)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">{painObservedLabel(report.reporter)}</dt>
                  <dd className={report.observedAt ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                    {painReportTime(report.observedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Recorded</dt>
                  <dd className={report.recordedAt ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                    {painReportTime(report.recordedAt)}
                  </dd>
                </div>
              </dl>

              <p className="text-xs text-[color:var(--bone-300)]">
                {PAIN_PROVENANCE[report.reporter]}
              </p>
            </article>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            {boardShown ? (
              <p className="t-data text-[color:var(--bone-300)]">
                Record what you did from Needs You Now on the floor board above.
              </p>
            ) : (
              <Link
                href="/coach/decision-loop"
                className="btn"
              >
                Record What You Did
              </Link>
            )}
            <p className="t-muted">
              There is no clear button: a report stays here until it ages out of the window, and the
              permanent record is the athlete&apos;s near-miss history, which nothing on this screen
              can remove.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
