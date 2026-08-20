"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

type EscalationSeverity = 'low' | 'moderate' | 'high' | 'critical';

interface HoldItem {
  hold_id: string;
  athlete_id: string;
  athlete_name: string | null;
  scope: 'all_training' | 'contact_only' | 'conditioning_only';
  reason_category: string;
  placed_by_role: string;
  placed_at: string;
}

interface GateFailureItem {
  athlete_id: string;
  athlete_name: string | null;
  gate_name: string;
  outcome: 'blocked' | 'flagged';
  evaluated_at: string;
}

interface EscalationItem {
  escalation_id: string;
  athlete_id: string;
  athlete_name: string | null;
  source_type: string;
  severity: EscalationSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: string;
}

interface ViolationItem {
  violation_id: string;
  athlete_id: string;
  athlete_name: string | null;
  severity: string;
  status: string;
  created_at: string;
}

interface SafetyReview {
  openHolds: HoldItem[];
  failingGates: GateFailureItem[];
  openEscalations: EscalationItem[];
  openViolations: ViolationItem[];
}

// Law 3: a severity badge carries a glyph and an uppercase label, never colour
// alone. This one shipped as a bare rung while both of its siblings --
// /admin/escalations over the same four-value union, and
// /admin/compliance-center -- supply the glyphs. Same glyphs as escalations,
// because it is the same ladder read from a different page.
const SEVERITY_BADGE: Record<EscalationSeverity, { rung: string; glyph: string }> = {
  critical: { rung: 'badge--locked', glyph: '✕' },
  high: { rung: 'badge--restricted', glyph: '▲' },
  moderate: { rung: 'badge--monitor', glyph: '◉' },
  low: { rung: 'badge--monitor', glyph: '◉' },
};

function displayName(athleteId: string, athleteName: string | null): string {
  return athleteName ?? athleteId;
}

export default function SafetyReviewPage() {
  const [review, setReview] = useState<SafetyReview | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/safety-review`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as Partial<SafetyReview> & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load the safety review.');
      }
      setReview({
        openHolds: payload.openHolds ?? [],
        failingGates: payload.failingGates ?? [],
        openEscalations: payload.openEscalations ?? [],
        openViolations: payload.openViolations ?? [],
      });
      setErrorMessage('');
    } catch (error) {
      setReview(null);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the safety review.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const isLoading = review === null && !errorMessage;
  const totalOpen = review
    ? review.openHolds.length + review.failingGates.length + review.openEscalations.length + review.openViolations.length
    : 0;

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--clinic min-h-screen">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          {/* Room DNA (clinic): cabinetry, the green banker's shade, and the
              blackletter reserved for the clinic masthead at display size only.
              The eyebrow states --brass-200 because --brass-400 is 3.34:1 on
              .mat-wood's lit edge; full note on /coach/sports-medicine. */}
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Admin Workspace</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Safety Review
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Everything open, right now, across the four safety systems: training holds, safety-gate checks, the
              red-flag escalation ladder, and compliance violations. Each item links to the page that can act on
              it -- this view only rolls them up.
            </p>
            {/* A failed read is a network fact. --locked red is what this room
                says when a clinician or a safeguarding decision has stopped
                something, so it does not carry this. --restricted does, keeping
                the glyph and gaining the uppercase label Law 3 asks for. */}
            {errorMessage ? (
              <div role="alert" className="alert alert--warning mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{errorMessage}</p>
                </div>
              </div>
            ) : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The review could not be loaded</div>
              <div className="empty-msg">Reload to retry.</div>
            </div>
          ) : totalOpen === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✓</div>
              <div className="empty-title">Nothing open right now</div>
              <div className="empty-msg">No active holds, failing gate checks, open escalations, or open compliance violations.</div>
            </div>
          ) : (
            <div className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              {review!.openHolds.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
                  <h2 className="t-command text-[length:var(--t-lg)]">Active Training Holds ({review!.openHolds.length})</h2>
                  <ul className="mt-[var(--s3)] divide-y divide-[color:var(--hide-800)]">
                    {review!.openHolds.map((hold) => (
                      <li key={hold.hold_id} className="flex flex-wrap items-center justify-between gap-[var(--s3)] py-[var(--s2)]">
                        <span className="t-body">{displayName(hold.athlete_id, hold.athlete_name)}</span>
                        <span className="t-data text-[color:var(--bone-400)]">{hold.scope} &middot; {hold.reason_category}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {review!.failingGates.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
                  <h2 className="t-command text-[length:var(--t-lg)]">Failing Safety Gates ({review!.failingGates.length})</h2>
                  <ul className="mt-[var(--s3)] divide-y divide-[color:var(--hide-800)]">
                    {review!.failingGates.map((gate) => (
                      <li key={`${gate.athlete_id}-${gate.gate_name}`} className="flex flex-wrap items-center justify-between gap-[var(--s3)] py-[var(--s2)]">
                        <span className="t-body">{displayName(gate.athlete_id, gate.athlete_name)}</span>
                        <span className="t-data text-[color:var(--bone-400)]">{gate.gate_name} &middot; {gate.outcome}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {review!.openEscalations.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
                  <h2 className="t-command text-[length:var(--t-lg)]">Open Escalations ({review!.openEscalations.length})</h2>
                  <ul className="mt-[var(--s3)] divide-y divide-[color:var(--hide-800)]">
                    {review!.openEscalations.map((escalation) => (
                      <li key={escalation.escalation_id} className="flex flex-wrap items-center justify-between gap-[var(--s3)] py-[var(--s2)]">
                        <span className="t-body">{displayName(escalation.athlete_id, escalation.athlete_name)}</span>
                        <span className={`badge ${SEVERITY_BADGE[escalation.severity].rung}`}>
                          <i aria-hidden="true">{SEVERITY_BADGE[escalation.severity].glyph}</i>
                          {escalation.severity}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Link href="/admin/escalations" className="t-body mt-[var(--s3)] inline-block underline">
                    Open the full escalation queue
                  </Link>
                </section>
              )}

              {review!.openViolations.length > 0 && (
                <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
                  <h2 className="t-command text-[length:var(--t-lg)]">Open Compliance Violations ({review!.openViolations.length})</h2>
                  <ul className="mt-[var(--s3)] divide-y divide-[color:var(--hide-800)]">
                    {review!.openViolations.map((violation) => (
                      <li key={violation.violation_id} className="flex flex-wrap items-center justify-between gap-[var(--s3)] py-[var(--s2)]">
                        <span className="t-body">{displayName(violation.athlete_id, violation.athlete_name)}</span>
                        <span className="t-data text-[color:var(--bone-400)]">{violation.severity} &middot; {violation.status}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href="/admin/compliance-center" className="t-body mt-[var(--s3)] inline-block underline">
                    Open the compliance center
                  </Link>
                </section>
              )}
            </div>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/admin/escalations" className="btn btn--ghost">
              Escalations
            </Link>
            <Link href="/admin/compliance-center" className="btn btn--ghost">
              Compliance Center
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
