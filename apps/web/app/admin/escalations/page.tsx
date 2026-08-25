"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';
import { useDialogFocusTrap } from '@/src/lib/useDialogFocusTrap';
// Imported (type-only, erased at build time -- safe in a 'use client' page,
// matching e.g. app/athlete/sign-in/page.tsx's `import type { PilotRole }`)
// rather than re-declared here: escalationLadder.ts is the canonical source
// of truth for which source_types exist, and SOURCE_LABEL below is keyed off
// this same type so a future new source_type fails `npx tsc --noEmit` with a
// missing-key error instead of silently rendering a blank Source cell, which
// is exactly how 'incident'/'video_scan'/'compliance_violation' went blank
// here -- this file used to keep its own separate union that drifted out of
// sync with the real one.
import type { SafetyEscalationSourceType } from '@/src/server/pilot/escalationLadder';

type EscalationSeverity = 'low' | 'moderate' | 'high' | 'critical';
type EscalationStatus = 'open' | 'acknowledged' | 'resolved';

interface SafetyEscalation {
  escalation_id: string;
  source_type: SafetyEscalationSourceType;
  athlete_id: string;
  severity: EscalationSeverity;
  reason: string;
  status: EscalationStatus;
  escalated_to_role: string;
  created_at: string;
}

const SEVERITY_BADGE: Record<EscalationSeverity, { rung: string; glyph: string }> = {
  critical: { rung: 'badge--locked', glyph: '✕' },
  high: { rung: 'badge--restricted', glyph: '▲' },
  moderate: { rung: 'badge--monitor', glyph: '◉' },
  low: { rung: 'badge--monitor', glyph: '◉' },
};

// Record<SafetyEscalationSourceType, string> (not Record<string, string>) is
// load-bearing: TypeScript rejects this object if it is missing a key for
// any value the canonical union admits, so a new source_type added to
// escalationLadder.ts without a label here is a compile error, not a blank
// cell in production.
// Exported so page.test.tsx can assert, without a full render, that every
// value SAFETY_ESCALATION_SOURCE_TYPES admits has a non-blank label here.
export const SOURCE_LABEL: Record<SafetyEscalationSourceType, string> = {
  near_miss: 'Near Miss',
  pain_report: 'Pain Report',
  safety_gate_evaluation: 'Safety Gate',
  repeated_pattern: 'Repeated Pattern',
  athlete_voice: 'Athlete Voice',
  training_hold: 'Training Hold',
  incident: 'Incident',
  video_scan: 'Video Scan',
  compliance_violation: 'Compliance Violation',
};

const STATUS_TABS: Array<{ value: EscalationStatus | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

function formatDate(value: string): string {
  return formatGymDateTimeShort(value) ?? value;
}

export default function EscalationsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [roleFetchFailed, setRoleFetchFailed] = useState(false);
  const [items, setItems] = useState<SafetyEscalation[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<EscalationStatus | 'all'>('open');
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  // The resolution note used to be collected in window.prompt(): a decision
  // about a minor, taken in unstyled browser chrome with no room, no material,
  // no glyph and no kiosk sizing, on the one screen in the building where the
  // record being written is why a red flag was closed. It is a dialog now --
  // the same role="dialog" aria-modal shape and the same focus trap
  // /admin/compliance-center already uses for Escalate, which is the LOWER
  // stakes flow of the two.
  const [resolving, setResolving] = useState<SafetyEscalation | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [noteRefusal, setNoteRefusal] = useState('');
  const closeResolve = useCallback(() => {
    setResolving(null);
    setResolutionNote('');
    setNoteRefusal('');
  }, []);
  const resolveDialogRef = useDialogFocusTrap<HTMLDivElement>({
    open: resolving !== null,
    onClose: closeResolve,
  });

  const isAdmin = role === 'admin' || role === 'organization_admin';

  const load = useCallback(async (status: EscalationStatus | 'all') => {
    try {
      const qs = status === 'all' ? '' : `?status=${status}`;
      const response = await fetch(`${apiBase()}/api/pilot/escalations${qs}`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { escalations?: SafetyEscalation[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load escalations.');
      }
      setItems(payload.escalations ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load escalations.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // POST, matching app/schedule/page.tsx -- the session route exports
        // POST only, so a GET here 405s and would silently hide every admin
        // control on this page forever.
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json().catch(() => ({}))) as { role?: string };
        if (!response.ok || !payload.role) {
          setRole(null);
          setRoleFetchFailed(true);
          return;
        }
        setRole(payload.role);
        setRoleFetchFailed(false);
      } catch {
        setRole(null);
        setRoleFetchFailed(true);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      await load(statusFilter);
    })();
  }, [load, statusFilter]);

  const counts = useMemo(() => {
    const source = items ?? [];
    return {
      critical: source.filter((item) => item.severity === 'critical').length,
      high: source.filter((item) => item.severity === 'high').length,
      total: source.length,
    };
  }, [items]);

  async function handleAcknowledge(escalationId: string) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', escalation_id: escalationId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to acknowledge.');
      }
      setActionMessage('Escalation acknowledged.');
      await load(statusFilter);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to acknowledge.');
    }
  }

  async function handleResolve(escalationId: string, note: string) {
    // A safety escalation about a minor does not close without a stated
    // reason. An empty confirm is treated as "not done deciding", not as
    // consent -- and, unlike a dismissed prompt, the dialog stays open with
    // the refusal beside the field it belongs to.
    if (note.trim() === '') {
      setNoteRefusal('A resolution needs a stated reason — the escalation was not resolved.');
      return;
    }
    closeResolve();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', escalation_id: escalationId, resolution_note: note }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to resolve.');
      }
      setActionMessage('Escalation resolved.');
      await load(statusFilter);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to resolve.');
    }
  }

  async function handleScanPatterns() {
    setIsScanning(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan_patterns' }),
      });
      const payload = (await response.json().catch(() => ({}))) as { filed_count?: number; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to scan for patterns.');
      }
      setActionMessage(
        payload.filed_count && payload.filed_count > 0
          ? `Scan complete: ${payload.filed_count} new repeated-pattern escalation(s) filed.`
          : 'Scan complete: no new patterns crossed the threshold.',
      );
      await load(statusFilter);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to scan for patterns.');
    } finally {
      setIsScanning(false);
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
      <main className="room room--clinic min-h-screen">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          {/* Room DNA (clinic): the room's own cabinetry under the masthead, its
              green banker's shade, and the blackletter reserved for the clinic
              masthead at display size only. The eyebrow states --brass-200
              because --brass-400 is 3.34:1 on .mat-wood's lit edge; the full
              note, and where that restatement really belongs, is on
              /coach/sports-medicine. */}
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Admin Workspace</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Escalations
            </h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.safety_escalations</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              This platform sends no email or push notification -- a near miss, pain report, or safety-gate flag
              severe enough to escalate lands here, and only here. Nothing auto-resolves; a human closes every row.
            </p>
            {/* Room DNA (clinic): both of these were --locked red, the colour
                this room reserves for a medical or safeguarding fact. One is a
                failed read of the queue; the other is a failed read of the
                caller's own role. --restricted carries them, each keeping the
                glyph and gaining the uppercase label Law 3 asks for -- colour
                was doing that work alone. */}
            {errorMessage ? (
              <div role="alert" className="alert alert--warning mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{errorMessage}</p>
                </div>
              </div>
            ) : null}
            {roleFetchFailed ? (
              <div role="alert" className="alert alert--warning mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">
                    Your role could not be verified, so resolve and pattern-scan controls are hidden. Reload to retry.
                  </p>
                </div>
              </div>
            ) : null}
            {actionMessage ? <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p> : null}
          </header>

          <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-3">
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">Critical (this view)</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{isLoading ? '—' : counts.critical}</p>
            </article>
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">High (this view)</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{isLoading ? '—' : counts.high}</p>
            </article>
            <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-[var(--s4)] py-[var(--s4)]">
              <p className="t-eyebrow">Total (this view)</p>
              <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{isLoading ? '—' : counts.total}</p>
            </article>
          </section>

          <div className="mt-[var(--s5)] flex flex-wrap items-center gap-[var(--s3)]">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setStatusFilter(tab.value)}
                className={`btn ${statusFilter === tab.value ? '' : 'btn--ghost'}`}
              >
                {tab.label}
              </button>
            ))}
            {isAdmin ? (
              <button type="button" disabled={isScanning} onClick={() => void handleScanPatterns()} className="btn btn--ghost ml-auto disabled:opacity-50">
                {isScanning ? 'Scanning…' : 'Scan for repeated patterns'}
              </button>
            ) : null}
          </div>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading escalations…</div>
            </div>
          ) : errorMessage ? (
            // A failed load must not wear the empty state's clothes: "Nothing
            // in this view" is a claim about the data, and after an error we
            // hold no data to make claims about.
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">Escalations could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing in this view</div>
              <div className="empty-msg">No {statusFilter === 'all' ? '' : statusFilter} escalations right now.</div>
            </div>
          ) : (
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)]">
              <table className="w-full text-left">
                <thead>
                  <tr className="t-eyebrow border-b border-[color:var(--hide-700)]">
                    <th className="px-[var(--s4)] py-[var(--s3)]">Severity</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Source</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Athlete</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Reason</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Filed</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const badge = SEVERITY_BADGE[item.severity];
                    return (
                      <tr key={item.escalation_id} className="border-b border-[color:var(--hide-800)] last:border-b-0 align-top">
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          <span className={`badge ${badge.rung}`}><i>{badge.glyph}</i>{item.severity}</span>
                        </td>
                        <td className="t-body px-[var(--s4)] py-[var(--s3)]">{SOURCE_LABEL[item.source_type]}</td>
                        <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.athlete_id}</td>
                        <td className="t-body px-[var(--s4)] py-[var(--s3)] max-w-[40ch]">{item.reason}</td>
                        <td className="t-body px-[var(--s4)] py-[var(--s3)]">{formatDate(item.created_at)}</td>
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          {item.status === 'open' ? (
                            <div className="flex flex-col gap-[var(--s2)]">
                              <button type="button" onClick={() => void handleAcknowledge(item.escalation_id)} className="btn--lever min-h-[44px]">
                                Acknowledge
                              </button>
                              {isAdmin ? (
                                <button type="button" onClick={() => setResolving(item)} className="btn--lever min-h-[44px]">
                                  Resolve
                                </button>
                              ) : null}
                            </div>
                          ) : item.status === 'acknowledged' && isAdmin ? (
                            <button type="button" onClick={() => setResolving(item)} className="btn--lever min-h-[44px]">
                              Resolve
                            </button>
                          ) : (
                            <span className="badge badge--cleared"><i>✓</i>{item.status}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* The durable record of why a red flag about a child was closed.
              Deliberately unriveted: ppbf.css allows "one ceremonial rivet per
              screen at most", and a riveted card is Front Office DNA, not this
              room's. Cabinetry, a green-shaded reading light, kiosk-sized
              field and buttons instead. */}
          {resolving ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-[var(--s4)]">
              <div
                ref={resolveDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="resolve-escalation-heading"
                className="mat-wood w-full max-w-lg rounded-[var(--r-lg)] border border-[color:var(--brass-700)] p-[var(--s5)]"
              >
                <p className="t-eyebrow text-[color:var(--brass-200)]">
                  {SOURCE_LABEL[resolving.source_type]} &middot; {resolving.severity}
                </p>
                <h2
                  id="resolve-escalation-heading"
                  className="t-command mt-[var(--s3)]"
                  style={{ fontSize: 'var(--t-lg)' }}
                >
                  Close this escalation
                </h2>
                <p className="t-body mt-[var(--s3)]">
                  This is the durable record of why the flag was closed, and it stays on the child&rsquo;s
                  history. Closing the escalation closes the workflow only — it clears nothing and lifts no
                  training hold.
                </p>
                <div className="field mt-[var(--s4)]">
                  <label className="t-label" htmlFor="resolution-note">Resolution note (required)</label>
                  <textarea
                    id="resolution-note"
                    className="textarea input--kiosk"
                    rows={3}
                    value={resolutionNote}
                    onChange={(event) => {
                      setResolutionNote(event.target.value);
                      setNoteRefusal('');
                    }}
                  />
                </div>
                {noteRefusal ? (
                  <div role="alert" className="alert alert--warning alert--tight">
                    <span className="alert-icon" aria-hidden="true">▲</span>
                    <div className="alert-body">
                      <p className="alert-title">Attention</p>
                      <p className="alert-msg">{noteRefusal}</p>
                    </div>
                  </div>
                ) : null}
                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  {/* Cancel first in the DOM: the way out is the first thing a
                      keyboard user reaches and the first thing a screen reader
                      announces after the warning. */}
                  <button type="button" onClick={closeResolve} className="btn btn--ghost btn--kiosk flex-1">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResolve(resolving.escalation_id, resolutionNote)}
                    className="btn btn--kiosk flex-1"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
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
