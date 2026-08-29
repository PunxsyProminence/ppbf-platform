'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ShadowDataDeletionQueue from '@/components/ShadowDataDeletionQueue';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';
import { useDialogFocusTrap } from '@/src/lib/useDialogFocusTrap';

interface ComplianceViolation {
  violation_id: string;
  rule_id: string;
  athlete_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'new' | 'acknowledged' | 'escalated' | 'resolved' | 'dismissed';
  created_at: string;
  description?: string;
}

// Law 3: severity and workflow state each carry a glyph and an uppercase
// label on the badge ladder, never colour alone. Severity climbs the four
// rungs; workflow state maps to what the queue still owes: new/escalated
// await action, acknowledged/dismissed are tracked, resolved is settled.
const SEVERITY_BADGE: Record<ComplianceViolation['severity'], { rung: string; glyph: string }> = {
  critical: { rung: 'badge--locked', glyph: '✕' },
  high: { rung: 'badge--restricted', glyph: '▲' },
  medium: { rung: 'badge--monitor', glyph: '◉' },
  low: { rung: 'badge--cleared', glyph: '✓' },
};

// Room DNA (clinic): --locked, the red rung, is what this room says when a
// clinician or a safeguarding decision has stopped something. `escalated` is
// neither -- it is a workflow state meaning a human handed the row up the
// ladder, and it wore the same red as `critical` severity two badges to its
// left. It drops to --restricted, which is where the comment above already
// files it ("new/escalated await action"), and takes the ◈ RefusalStamp gives
// GET_PERMISSION -- "a request handed to someone else, not yet resolved" is
// exactly what escalated means, and the distinct glyph is what keeps it apart
// from `new` now that they share a rung. Law 3 was never colour's job alone.
const STATUS_BADGE: Record<ComplianceViolation['status'], { rung: string; glyph: string }> = {
  new: { rung: 'badge--restricted', glyph: '▲' },
  acknowledged: { rung: 'badge--monitor', glyph: '◉' },
  escalated: { rung: 'badge--restricted', glyph: '◈' },
  resolved: { rung: 'badge--cleared', glyph: '✓' },
  dismissed: { rung: 'badge--monitor', glyph: '◉' },
};

export default function AdminComplianceCenterPage() {
  const [violations, setViolations] = useState<ComplianceViolation[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [dataAuthoritative, setDataAuthoritative] = useState(false);
  // The cap the server applied to this read. The violations route is
  // `order by created_at desc limit N` (default 50, max 100) and this page
  // sends no limit, so every figure below covers that newest slice and not
  // the register. Held in state so the window line quotes the real number
  // rather than a copy of the default that could drift from it.
  const [readLimit, setReadLimit] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [selectedViolation, setSelectedViolation] = useState<ComplianceViolation | null>(null);
  const escalateModalRef = useDialogFocusTrap<HTMLDivElement>({
    open: selectedViolation !== null,
    onClose: () => setSelectedViolation(null),
  });
  const [escalateToRole, setEscalateToRole] = useState('organization_admin');
  // Resolving or dismissing a violation on a child's record is a durable
  // decision with a required reason. It was collected in window.prompt():
  // browser chrome, no room, no material, no glyph, no kiosk sizing. It now
  // uses the same dialog shape this page already had -- for Escalate, the
  // lower-stakes flow of the three.
  const [closing, setClosing] = useState<{ violation: ComplianceViolation; action: 'resolve' | 'dismiss' } | null>(null);
  const [closingNote, setClosingNote] = useState('');
  const [noteRefusal, setNoteRefusal] = useState('');
  const closeClosingDialog = useCallback(() => {
    setClosing(null);
    setClosingNote('');
    setNoteRefusal('');
  }, []);
  const closeDialogRef = useDialogFocusTrap<HTMLDivElement>({
    open: closing !== null,
    onClose: closeClosingDialog,
  });
  // Per-row, not a single scalar: a transition in flight on one violation
  // must never disable another row's buttons.
  const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
  const [metrics, setMetrics] = useState({
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    new: 0,
    acknowledged: 0,
    escalated: 0,
    resolved: 0,
  });

  // Load violations
  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`${apiBase()}/api/pilot/compliance/violations`, { credentials: 'include' });
        if (!res.ok) {
          throw new Error('Unable to load compliance violations');
        }

        const data = (await res.json()) as { items?: ComplianceViolation[]; limit?: number };
        const allViolations = data.items ?? [];
        setViolations(allViolations);
        setReadLimit(typeof data.limit === 'number' ? data.limit : null);

        // Calculate metrics
        const calc = {
          total: allViolations.length,
          critical: allViolations.filter((v) => v.severity === 'critical').length,
          high: allViolations.filter((v) => v.severity === 'high').length,
          medium: allViolations.filter((v) => v.severity === 'medium').length,
          low: allViolations.filter((v) => v.severity === 'low').length,
          new: allViolations.filter((v) => v.status === 'new').length,
          acknowledged: allViolations.filter((v) => v.status === 'acknowledged').length,
          escalated: allViolations.filter((v) => v.status === 'escalated').length,
          resolved: allViolations.filter((v) => v.status === 'resolved').length,
        };
        setMetrics(calc);
        setDataAuthoritative(true);
        setErrorMessage('');
      } catch (error) {
        setDataAuthoritative(false);
        setViolations([]);
        setReadLimit(null);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load violations');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const getFilteredViolations = () => {
    return violations.filter((v) => {
      const statusMatch = statusFilter === 'all' || v.status === statusFilter;
      const severityMatch = severityFilter === 'all' || v.severity === severityFilter;
      return statusMatch && severityMatch;
    });
  };

  const handleEscalate = async () => {
    if (!selectedViolation) return;

    try {
      const res = await fetch(`${apiBase()}/api/pilot/compliance/escalate`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          violation_id: selectedViolation.violation_id,
          escalated_to_role: escalateToRole,
        }),
      });

      if (!res.ok) throw new Error('Failed to escalate violation');

      setSelectedViolation(null);
      setEscalateToRole('organization_admin');

      // Reload violations
      const reloadRes = await fetch(`${apiBase()}/api/pilot/compliance/violations`, { credentials: 'include' });
      if (reloadRes.ok) {
        const data = (await reloadRes.json()) as { items?: ComplianceViolation[] };
        const allViolations = data.items ?? [];
        setViolations(allViolations);

        const calc = {
          total: allViolations.length,
          critical: allViolations.filter((v) => v.severity === 'critical').length,
          high: allViolations.filter((v) => v.severity === 'high').length,
          medium: allViolations.filter((v) => v.severity === 'medium').length,
          low: allViolations.filter((v) => v.severity === 'low').length,
          new: allViolations.filter((v) => v.status === 'new').length,
          acknowledged: allViolations.filter((v) => v.status === 'acknowledged').length,
          escalated: allViolations.filter((v) => v.status === 'escalated').length,
          resolved: allViolations.filter((v) => v.status === 'resolved').length,
        };
        setMetrics(calc);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to escalate violation');
    }
  };

  // The lifecycle levers the register was missing: acknowledge is receipt;
  // resolve and dismiss close the workflow (never the underlying concern)
  // and require a stated reason, same as every sibling console's closing
  // verdicts. The server's CAS is the authority -- a stale click gets the
  // server's refusal, named, not a silent overwrite.
  const transitionViolation = async (
    violation: ComplianceViolation,
    action: 'acknowledge' | 'resolve' | 'dismiss',
    reason = '',
  ) => {
    let note = '';
    if (action !== 'acknowledge') {
      note = reason.trim();
      if (!note) {
        // The dialog stays open with the refusal beside the field, rather than
        // closing and leaving a message somewhere else on the page.
        setNoteRefusal(`A ${action === 'resolve' ? 'resolution' : 'dismissal'} needs a stated reason — nothing was recorded.`);
        return;
      }
      closeClosingDialog();
    }

    setTransitioningIds((prev) => new Set(prev).add(violation.violation_id));
    try {
      const res = await fetch(`${apiBase()}/api/pilot/compliance/violations`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ violation_id: violation.violation_id, action, note: note || undefined }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to update the violation.');
      }
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the violation.');
    } finally {
      setTransitioningIds((prev) => {
        const next = new Set(prev);
        next.delete(violation.violation_id);
        return next;
      });
      // Reconcile with server truth on every terminal outcome: after a 409
      // the rendered state is stale by definition.
      try {
        const reloadRes = await fetch(`${apiBase()}/api/pilot/compliance/violations`, { credentials: 'include' });
        if (reloadRes.ok) {
          const data = (await reloadRes.json()) as { items?: ComplianceViolation[] };
          setViolations(data.items ?? []);
        }
      } catch {
        // The action's own outcome message stands; a failed reload must not
        // overwrite it.
      }
    }
  };

  const filteredViolations = getFilteredViolations();

  const metricValue = (value: number) => {
    if (isLoading) return '...';
    if (!dataAuthoritative) return '--';
    return String(value);
  };

  return (
    <RoleStandaloneView
      roleLabel="Admin Workspace"
      routeLabel="/admin/compliance-center"
      allowedRoles={['admin']}
      showShellHeader={false}
      room="clinic"
    >
      <div className="space-y-[var(--s5)]">
        {/* Room DNA (clinic): cabinetry, the green banker's shade, and the
            blackletter reserved for the clinic masthead at display size only.
            The eyebrow states --brass-200 because --brass-400 is 3.34:1 on
            .mat-wood's lit edge; the full note is on /coach/sports-medicine. */}
        <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <p className="t-eyebrow text-[color:var(--brass-200)]">Compliance Management</p>
          <h1
            className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
            style={{ fontSize: 'var(--t-2xl)' }}
          >
            Compliance Center
          </h1>
          <p className="t-body mt-[var(--s3)]">Review, manage, and escalate athlete compliance violations.</p>
          {/* --locked is a medical or safeguarding fact in this room. A register
              that would not load, and a transition the server bounced, are
              neither -- and the correct answer was already twelve lines below,
              in the .alert--warning the unavailable-metrics notice uses for
              exactly this. Same rung now, glyph and uppercase label intact. */}
          {errorMessage ? (
            <div role="alert" className="alert alert--warning">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          ) : null}
          {!errorMessage && !isLoading && !dataAuthoritative ? (
            <div role="alert" className="alert alert--warning">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">Compliance metrics are unavailable and intentionally not shown as zero.</p>
              </div>
            </div>
          ) : null}
        </header>

        {/* Metrics Dashboard.

            Every tile here is an aggregate over the rows this page loaded,
            and that set is capped and ordered newest-first. A bare "Total"
            was a claim about the register; worse, a bare "Critical" reads as
            "this gym has no critical violations" when a critical row filed
            before the window simply was not read. The labels are scoped the
            way /admin/escalations already scopes its own -- "(this view)" --
            and the window itself is stated underneath. */}
        <section className="grid grid-cols-2 gap-[var(--s4)] sm:grid-cols-5">
          {([
            ['Total (this view)', metrics.total, null],
            ['Critical (this view)', metrics.critical, '✕'],
            ['High (this view)', metrics.high, '▲'],
            ['Medium (this view)', metrics.medium, '◉'],
            ['Low (this view)', metrics.low, '✓'],
          ] as [string, number, string | null][]).map(([label, value, glyph]) => (
            <article key={label} className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)] text-center">
              <p className="t-eyebrow">{glyph ? `${glyph} ` : ''}{label}</p>
              <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{metricValue(value)}</p>
            </article>
          ))}
        </section>

        {/* The window the figures above were computed over. Stated only when
            there are rows and a server-reported cap to state -- a caveat over
            an unread or empty register would be furniture explaining nothing. */}
        {dataAuthoritative && readLimit !== null && violations.length > 0 ? (
          <p className="t-muted">
            These figures cover the {readLimit} most recently filed violations, newest first — not this
            gym&rsquo;s whole compliance record. A violation filed before that window is not counted here.
          </p>
        ) : null}

        <section className="mat-leather flex flex-wrap items-center gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]">
          <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Filter violations by status">
            {['all', 'new', 'acknowledged', 'escalated', 'resolved'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                aria-pressed={statusFilter === status}
                className={`inline-flex min-h-[44px] items-center rounded-[var(--r-sm)] border px-[var(--s4)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] transition ${
                  statusFilter === status
                    ? 'border-[color:var(--brass-300)] bg-[var(--hide-800)] text-[color:var(--brass-300)]'
                    : 'border-[color:var(--hide-600)] bg-[var(--hide-950)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-[var(--s4)]">
            <label htmlFor="severity-filter" className="t-label">Severity:</label>
            <select id="severity-filter"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="select w-auto"
            >
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          {/* "of N" is the count of rows LOADED, which is not the count of
              rows on file -- the read is capped. Said as "loaded" so the
              denominator stops reading as the register's size. */}
          <div className="t-muted ml-auto">
            Showing {dataAuthoritative ? filteredViolations.length : '--'} of {dataAuthoritative ? violations.length : '--'} loaded
          </div>
        </section>

        {/* The data-subject request queue.
            POST /api/pilot/shadow/data has filed deletion requests since the
            SHADOW runtime slice and nothing anywhere read them, so its
            promised "manual review" had nowhere to happen. It happens here:
            this room is already where the platform puts rows a human owes an
            answer to, and a deletion request parked on a SHADOW admin page
            would be reachable and still never looked at. */}
        <ShadowDataDeletionQueue />

        {/* Violations List */}
        <section>
          <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>
            Violations ({filteredViolations.length} of {violations.length} loaded)
          </h2>
          <div className="space-y-[var(--s4)]">
            {/* A register that failed to load is not a register the filters
                emptied. Pointing the admin at the Status and Severity
                selects for a read that never happened sends them to widen
                filters that were never the reason they see nothing -- and
                leaves them believing the gym has no matching violations. */}
            {!isLoading && !dataAuthoritative ? (
              <div className="empty mat-leather rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)]">
                <p className="empty-msg mx-auto">
                  The violations register could not be loaded. This list is unavailable, not empty — violations
                  may be on file that are not shown here. Reload to retry.
                </p>
              </div>
            ) : filteredViolations.length === 0 ? (
              <div className="empty mat-leather rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)]">
                <p className="empty-msg mx-auto">
                  No violations match the current filters. Try setting Status to &quot;all&quot; and Severity to &quot;all&quot;.
                </p>
              </div>
            ) : (
              filteredViolations.map((v) => (
                <div
                  key={v.violation_id}
                  className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]"
                >
                  <div className="flex items-start justify-between gap-[var(--s4)]">
                    <div className="flex-1">
                      <div className="mb-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                        <span className={`badge ${SEVERITY_BADGE[v.severity].rung}`}>
                          <i>{SEVERITY_BADGE[v.severity].glyph}</i>{v.severity}
                        </span>
                        <span className={`badge ${STATUS_BADGE[v.status].rung}`}>
                          <i>{STATUS_BADGE[v.status].glyph}</i>{v.status}
                        </span>
                      </div>
                      <p className="t-body font-semibold text-[color:var(--bone-100)]">Athlete: {v.athlete_id}</p>
                      <p className="t-data">Rule: {v.rule_id}</p>
                      <p className="t-muted mt-[var(--s2)]">
                        {formatGymStamp(v.created_at)}
                      </p>
                      {v.description && <p className="t-body mt-[var(--s3)]">{v.description}</p>}
                    </div>
                    {/* Only the actions the server will accept from this
                        row's current state. resolved and dismissed are
                        terminal: no buttons. An escalated violation comes
                        back down by being resolved, never dismissed. */}
                    <div className="flex flex-col items-end gap-[var(--s2)]">
                      {v.status === 'new' ? (
                        <button
                          onClick={() => void transitionViolation(v, 'acknowledge')}
                          disabled={transitioningIds.has(v.violation_id)}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Acknowledge
                        </button>
                      ) : null}
                      {v.status === 'new' || v.status === 'acknowledged' ? (
                        <button
                          onClick={() => setSelectedViolation(v)}
                          disabled={transitioningIds.has(v.violation_id)}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Escalate
                        </button>
                      ) : null}
                      {v.status === 'acknowledged' || v.status === 'escalated' ? (
                        <button
                          onClick={() => setClosing({ violation: v, action: 'resolve' })}
                          disabled={transitioningIds.has(v.violation_id)}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      ) : null}
                      {v.status === 'new' || v.status === 'acknowledged' ? (
                        <button
                          onClick={() => setClosing({ violation: v, action: 'dismiss' })}
                          disabled={transitioningIds.has(v.violation_id)}
                          className="btn btn--ghost disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Escalation Modal.
            De-riveted: ppbf.css allows "one ceremonial rivet per screen at
            most" and this dialog wore four, which is Front Office DNA -- a
            riveted card belongs on the records desk, not in the clinic. The
            room's own cabinetry carries it instead, and the dialog now matches
            the closing dialog below it rather than out-dressing it. */}
        {selectedViolation && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-[var(--s4)]">
            <div
              ref={escalateModalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="escalate-violation-heading"
              className="mat-wood w-full max-w-sm rounded-[var(--r-lg)] border border-[color:var(--brass-700)]"
            >
              <div className="p-[var(--s5)]">
                <h3 id="escalate-violation-heading" className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Escalate Violation</h3>
                <p className="t-body mb-[var(--s4)]">
                  Athlete: <span className="font-semibold text-[color:var(--bone-100)]">{selectedViolation.athlete_id}</span>
                </p>
                <div className="field mb-[var(--s4)]">
                  <label htmlFor="escalate-to-select" className="t-label">Escalate To</label>
                  <select id="escalate-to-select"
                    value={escalateToRole}
                    onChange={(e) => setEscalateToRole(e.target.value)}
                    className="select mt-[var(--s2)]"
                  >
                    <option value="organization_admin">Organization Admin</option>
                    <option value="admin">Platform Admin</option>
                  </select>
                </div>
                <div className="flex gap-[var(--s4)]">
                  {/* Cancel first in the DOM: the way out is the first thing a
                      keyboard user reaches and a screen reader announces. */}
                  <button
                    onClick={() => setSelectedViolation(null)}
                    className="btn btn--ghost btn--kiosk flex-1"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleEscalate}
                    className="btn btn--kiosk flex-1"
                  >
                    Escalate
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Resolving or dismissing a violation on a child's record: the durable
            reason, collected in the room instead of in browser chrome. */}
        {closing ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-[var(--s4)]">
            <div
              ref={closeDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="close-violation-heading"
              className="mat-wood w-full max-w-lg rounded-[var(--r-lg)] border border-[color:var(--brass-700)] p-[var(--s5)]"
            >
              <p className="t-eyebrow text-[color:var(--brass-200)]">
                {closing.violation.severity} &middot; {closing.violation.rule_id}
              </p>
              <h3
                id="close-violation-heading"
                className="t-command mt-[var(--s3)]"
                style={{ fontSize: 'var(--t-lg)' }}
              >
                {closing.action === 'resolve' ? 'Resolve this violation' : 'Dismiss this violation'}
              </h3>
              <p className="t-body mt-[var(--s3)]">
                {closing.action === 'resolve'
                  ? 'This closes the workflow only — it does not clear the athlete and it lifts no restriction. What you write here stays on the record.'
                  : 'The record is kept, never deleted. What you write here is why nobody acted on it.'}
              </p>
              <div className="field mt-[var(--s4)]">
                <label className="t-label" htmlFor="closing-note">
                  {closing.action === 'resolve' ? 'How was this resolved (required)' : 'Why is this being dismissed (required)'}
                </label>
                <textarea
                  id="closing-note"
                  className="textarea input--kiosk"
                  rows={3}
                  value={closingNote}
                  onChange={(event) => {
                    setClosingNote(event.target.value);
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
                <button type="button" onClick={closeClosingDialog} className="btn btn--ghost btn--kiosk flex-1">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void transitionViolation(closing.violation, closing.action, closingNote)}
                  className="btn btn--kiosk flex-1"
                >
                  {closing.action === 'resolve' ? 'Resolve' : 'Dismiss'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-[var(--s4)]">
          <Link href="/admin/escalations" className="btn btn--ghost">
            Escalations
          </Link>
          <Link href="/admin" className="btn btn--ghost">
            Back to Admin
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
