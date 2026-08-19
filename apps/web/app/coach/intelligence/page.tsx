'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Coach Intelligence v1 (register module 111): the owner-approved morning
// read. Seven deterministic, read-only observations about the coach's own
// athletes -- every item is a stored fact plus a named threshold, organized
// by urgency. No ML, no scores, no predictions; the coach decides what any
// of it means, and acting on an item happens on the surface that owns it.
//
// The two safety registers render FIRST and are counted in `total`. Before
// they existed this page could total zero items -- and print "Nothing needs
// your eyes" -- for an athlete carrying an open safety escalation or an open
// compliance violation, because the digest never read either register. The
// empty state is the whole reason the omission mattered, so the fix has to
// reach the page and not stop at the API.

interface Digest {
  open_safety_escalations: Array<{
    athlete_id: string; athlete_name: string; escalation_id: string;
    source_type: string; severity: string; reason: string; created_at: string;
  }>;
  open_compliance_violations: Array<{
    athlete_id: string; athlete_name: string; violation_id: string;
    rule_id: string; rule_name: string; severity: string; status: string; days_open: number;
  }>;
  stalled_gaps: Array<{ athlete_id: string; athlete_name: string; gap_type: string; gap_description: string; days_open: number }>;
  readiness_concerns: Array<{ athlete_id: string; athlete_name: string; red_days: number }>;
  fading_attendance: Array<{ athlete_id: string; athlete_name: string; training_days_early: number; training_days_late: number }>;
  unreviewed_sessions: Array<{ athlete_id: string; athlete_name: string; session_id: string; session_date: string; days_waiting: number }>;
  expiring_holds: Array<{ athlete_id: string; athlete_name: string; hold_id: string; expires_at: string }>;
}

const EMPTY: Digest = {
  open_safety_escalations: [], open_compliance_violations: [],
  stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
};

// Severity rung -> the design system's status badge, the same mapping
// /admin/escalations already uses, so one severity does not read as two
// different colours on two staff surfaces. Law 2: saturated colour is
// safety/status only, which is exactly what these are. The two registers
// carry different vocabularies ('moderate' on escalations, 'medium' on
// compliance violations) and both are listed rather than normalized --
// renaming another capability's stored value on the way to the screen is how
// a surface starts lying about the record. Anything unrecognized falls to
// 'monitor' rather than disappearing: an unbadged safety row is still a
// safety row a coach must see.
const SEVERITY_BADGE: Record<string, string> = {
  critical: 'badge--locked',
  high: 'badge--restricted',
  moderate: 'badge--monitor',
  medium: 'badge--monitor',
  low: 'badge--monitor',
};

function severityBadgeClass(severity: string): string {
  return SEVERITY_BADGE[severity] ?? 'badge--monitor';
}

// The stored source_type/status values read as database enums, so they are
// spaced for a human without being renamed.
function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

export default function CoachIntelligencePage() {
  const [digest, setDigest] = useState<Digest>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/intelligence`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load the digest.');
        const payload = (await response.json()) as Digest;
        if (controller.signal.aborted) return;
        setDigest({ ...EMPTY, ...payload });
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the digest.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const total =
    digest.open_safety_escalations.length + digest.open_compliance_violations.length
    + digest.stalled_gaps.length + digest.readiness_concerns.length + digest.fading_attendance.length
    + digest.unreviewed_sessions.length + digest.expiring_holds.length;

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>The Morning Read</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Seven deterministic reads of your own athletes&rsquo; records, organized by urgency.
              Every item is a stored fact plus a stated threshold — no scores, no predictions.
              You decide what any of it means. Open safety escalations and open compliance
              violations lead the list; they are shown here, but they are acted on where they live.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage} Items may exist that are not shown here.</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Reading the ledger...</span>
            </div>
          ) : !errorMessage && total === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">Nothing needs your eyes</div>
                <p className="empty-msg mx-auto">No item crossed a threshold. This is a read of the ledger, not a guarantee the floor is fine.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s4)]">
              {digest.open_safety_escalations.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Open safety escalations</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.open_safety_escalations.map((item) => (
                      <li key={item.escalation_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className={`badge ${severityBadgeClass(item.severity)}`}>{item.severity}</span>
                        {' '}<span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— {humanize(item.source_type)}: {item.reason}
                        {' '}(filed {item.created_at.slice(0, 10)}). <Link className="underline" href="/admin/escalations">Escalation queue</Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.open_compliance_violations.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Open compliance violations</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.open_compliance_violations.map((item) => (
                      <li key={item.violation_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className={`badge ${severityBadgeClass(item.severity)}`}>{item.severity}</span>
                        {' '}<span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— {item.rule_name} ({humanize(item.status)}, open {item.days_open} days).
                        {' '}Closing one out is an organization admin action.
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.expiring_holds.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Holds expiring within 14 days</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.expiring_holds.map((item) => (
                      <li key={item.hold_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— hold expires {item.expires_at.slice(0, 10)}. <Link className="underline" href="/coach/sports-medicine">Clearance board</Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.readiness_concerns.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>3+ RED readiness days this week</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.readiness_concerns.map((item) => (
                      <li key={item.athlete_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— {item.red_days} RED check-in days in the last 7. Talk before training.
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.fading_attendance.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Attendance fading</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.fading_attendance.map((item) => (
                      <li key={item.athlete_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— {item.training_days_late} training days this fortnight, down from {item.training_days_early}.
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.stalled_gaps.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Gaps waiting 14+ days for a drill</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.stalled_gaps.map((item) => (
                      <li key={`${item.athlete_id}:${item.gap_type}:${item.days_open}`} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— {item.gap_type}: {item.gap_description} ({item.days_open} days). <Link className="underline" href="/coach/progression-intelligence">Assign a drill</Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {digest.unreviewed_sessions.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Sessions unreviewed for 7+ days</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {digest.unreviewed_sessions.map((item) => (
                      <li key={item.session_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        <span className="font-semibold text-[color:var(--bone-100)]">{item.athlete_name}</span>
                        {' '}— session on {item.session_date}, waiting {item.days_waiting} days.
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
