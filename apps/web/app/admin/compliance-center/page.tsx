'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ShadowDataDeletionQueue from '@/components/ShadowDataDeletionQueue';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';
import { useDialogFocusTrap } from '@/src/lib/useDialogFocusTrap';
import BackHome from '@/components/BackHome';

interface ComplianceViolation {
  violation_id: string;
  rule_id: string;
  athlete_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'new' | 'acknowledged' | 'escalated' | 'resolved' | 'dismissed';
  created_at: string;
  description?: string;
  // Filled by the list read; null when the athlete or rule row is not on file,
  // and then the id is what there is to show.
  athlete_name?: string | null;
  rule_name?: string | null;
}

// The status tabs. 'all' is the register as loaded; every other tab asks the
// server for that status alone, so a dismissed record older than the newest
// rows of the whole register is still reachable from its own tab.
const STATUS_TABS = ['all', 'new', 'acknowledged', 'escalated', 'resolved', 'dismissed'] as const;

function violationsUrl(status: string): string {
  const base = `${apiBase()}/api/pilot/compliance/violations`;
  return status === 'all' ? base : `${base}?status=${encodeURIComponent(status)}`;
}

const athleteLabel = (v: ComplianceViolation) => v.athlete_name || v.athlete_id;
const ruleLabel = (v: ComplianceViolation) => v.rule_name || v.rule_id;

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
  // Counted from the rows on screen, never held beside them: a tile that is
  // its own state falls behind the list the moment a re-read sets one and
  // not the other.
  const metrics = useMemo(
    () => ({
      total: violations.length,
      critical: violations.filter((v) => v.severity === 'critical').length,
      high: violations.filter((v) => v.severity === 'high').length,
      medium: violations.filter((v) => v.severity === 'medium').length,
      low: violations.filter((v) => v.severity === 'low').length,
    }),
    [violations],
  );
  // The tab the admin is looking at right now, readable from a request that
  // was sent before they changed it: a re-read after an escalate or a
  // transition reads the tab showing when it is SENT, not the one that was
  // showing when the button was pressed.
  const showingTabRef = useRef(statusFilter);
  // Every read of the register takes the next number when it is sent, and
  // only the latest one sent may put rows on the screen. Comparing the tab
  // NAME was not enough: tab A, then B, then back to A made an old answer
  // for A acceptable again, and it could land after the newer read of A and
  // put older rows and counts on screen.
  const latestReadRef = useRef(0);
  // True from the moment a tab's own load is sent until some read answers
  // it. A re-read that overtakes that load has to finish its job (clear
  // "Loading", or say the list is unavailable), because the load it
  // overtook will be dropped when it answers.
  const loadOwedRef = useRef(false);

  // `reconcile` is the quiet re-read after an escalate or a transition: it
  // shows no "Loading", and when it fails over rows already on screen it
  // changes nothing, so the action's own outcome message stands.
  const readTab = useCallback(async (tab: string, reconcile: boolean) => {
    latestReadRef.current += 1;
    const generation = latestReadRef.current;
    if (!reconcile) {
      loadOwedRef.current = true;
      setIsLoading(true);
    }
    try {
      const res = await fetch(violationsUrl(tab), { credentials: 'include' });
      if (!res.ok) {
        throw new Error('Unable to load compliance violations');
      }

      const data = (await res.json()) as { items?: ComplianceViolation[]; limit?: number };
      if (generation !== latestReadRef.current) return;
      setViolations(data.items ?? []);
      setReadLimit(typeof data.limit === 'number' ? data.limit : null);
      setDataAuthoritative(true);
      if (!reconcile) setErrorMessage('');
    } catch (error) {
      if (generation !== latestReadRef.current) return;
      if (reconcile && !loadOwedRef.current) return;
      const message = error instanceof Error ? error.message : 'Unable to load violations';
      setDataAuthoritative(false);
      setViolations([]);
      setReadLimit(null);
      // A re-read standing in for a load keeps the action's message if there is one.
      setErrorMessage((current) => (reconcile && current ? current : message));
    }
    loadOwedRef.current = false;
    setIsLoading(false);
  }, []);

  // Load violations: on entry, and again each time the status tab changes.
  useEffect(() => {
    void (async () => {
      await readTab(statusFilter, false);
    })();
  }, [statusFilter, readTab]);

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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to escalate violation');
      return;
    }
    // Re-read the tab that is showing now.
    await readTab(showingTabRef.current, true);
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
    }
    // Reconcile with server truth on every terminal outcome: after a 409 the
    // rendered state is stale by definition. The action's own outcome
    // message stands; a failed re-read does not overwrite it.
    await readTab(showingTabRef.current, true);
  };

  const filteredViolations = getFilteredViolations();

  const metricValue = (value: number) => {
    if (isLoading) return '...';
    if (!dataAuthoritative) return '--';
    return String(value);
  };
  // The same rule for the two "X of Y loaded" counts: a read in flight or a
  // read that failed has no count to state.
  const countShown = metricValue;

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
          {/* Never nearer the edge than 73px: the shade is 89px and its pool of
              light 233px, centred, so 8% alone put the light past a phone's
              screen and widened the page (#1482 item 5). Unchanged above ~900px. */}
          <i aria-hidden="true" className="lamp lamp--green right-[max(8%,73px)]" />
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
        {!isLoading && dataAuthoritative && readLimit !== null && violations.length > 0 ? (
          <p className="t-muted">
            These figures cover the {readLimit} most recently filed{statusFilter === 'all' ? '' : ` ${statusFilter}`} violations,
            newest first — not this gym&rsquo;s whole compliance record. A violation filed before that window is
            not counted here.
          </p>
        ) : null}

        <section className="mat-leather flex flex-wrap items-center gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]">
          <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Filter violations by status">
            {STATUS_TABS.map((status) => (
              <button
                key={status}
                onClick={() => {
                  showingTabRef.current = status;
                  setStatusFilter(status);
                }}
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
            Showing {countShown(filteredViolations.length)} of {countShown(violations.length)} loaded
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
            Violations ({countShown(filteredViolations.length)} of {countShown(violations.length)} loaded)
          </h2>
          <div className="space-y-[var(--s4)]">
            {/* A register that failed to load is not a register the filters
                emptied. Pointing the admin at the Status and Severity
                selects for a read that never happened sends them to widen
                filters that were never the reason they see nothing -- and
                leaves them believing the gym has no matching violations. */}
            {isLoading ? (
              <div className="empty mat-leather rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)]">
                <p className="empty-msg mx-auto">Loading…</p>
              </div>
            ) : !dataAuthoritative ? (
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
                      <p className="t-body font-semibold text-[color:var(--bone-100)]">Athlete: {athleteLabel(v)}</p>
                      <p className="t-data">Rule: {ruleLabel(v)}</p>
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
                  Athlete: <span className="font-semibold text-[color:var(--bone-100)]">{athleteLabel(selectedViolation)}</span>
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
                {closing.violation.severity} &middot; {ruleLabel(closing.violation)} &middot; {athleteLabel(closing.violation)}
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
          <Link href="/admin/waiver-status?view=all" className="btn btn--ghost">
            Cleared tonight
          </Link>
          <BackHome />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
