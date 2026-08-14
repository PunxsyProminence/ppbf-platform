'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

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

const STATUS_BADGE: Record<ComplianceViolation['status'], { rung: string; glyph: string }> = {
  new: { rung: 'badge--restricted', glyph: '▲' },
  acknowledged: { rung: 'badge--monitor', glyph: '◉' },
  escalated: { rung: 'badge--locked', glyph: '✕' },
  resolved: { rung: 'badge--cleared', glyph: '✓' },
  dismissed: { rung: 'badge--monitor', glyph: '◉' },
};

export default function AdminComplianceCenterPage() {
  const [violations, setViolations] = useState<ComplianceViolation[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [dataAuthoritative, setDataAuthoritative] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [selectedViolation, setSelectedViolation] = useState<ComplianceViolation | null>(null);
  const [escalateToRole, setEscalateToRole] = useState('organization_admin');
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

        const data = (await res.json()) as { items?: ComplianceViolation[] };
        const allViolations = data.items ?? [];
        setViolations(allViolations);

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
  const transitionViolation = async (violation: ComplianceViolation, action: 'acknowledge' | 'resolve' | 'dismiss') => {
    let note = '';
    if (action !== 'acknowledge') {
      const entered = window.prompt(
        action === 'resolve'
          ? 'How was this violation resolved (required)? This closes the workflow only -- it does not clear the athlete or lift any restriction.'
          : 'Why is this violation being dismissed (required)? The record is kept, never deleted.',
        '',
      );
      if (entered === null) return;
      note = entered.trim();
      if (!note) {
        setErrorMessage(`A ${action === 'resolve' ? 'resolution' : 'dismissal'} needs a stated reason -- nothing was recorded.`);
        return;
      }
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
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Compliance Management</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Compliance Center</h1>
          <p className="t-body mt-[var(--s3)]">Review, manage, and escalate athlete compliance violations.</p>
          {errorMessage ? (
            <p role="alert" className="alert alert--critical">
              <span className="alert-icon">✕</span>
              <span className="alert-msg">{errorMessage}</span>
            </p>
          ) : null}
          {!errorMessage && !isLoading && !dataAuthoritative ? (
            <p role="alert" className="alert alert--warning">
              <span className="alert-icon">▲</span>
              <span className="alert-msg">Compliance metrics are unavailable and intentionally not shown as zero.</span>
            </p>
          ) : null}
        </header>

        {/* Metrics Dashboard */}
        <section className="grid grid-cols-2 gap-[var(--s4)] sm:grid-cols-5">
          {([
            ['Total', metrics.total, null],
            ['Critical', metrics.critical, '✕'],
            ['High', metrics.high, '▲'],
            ['Medium', metrics.medium, '◉'],
            ['Low', metrics.low, '✓'],
          ] as [string, number, string | null][]).map(([label, value, glyph]) => (
            <article key={label} className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)] text-center">
              <p className="t-eyebrow">{glyph ? `${glyph} ` : ''}{label}</p>
              <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{metricValue(value)}</p>
            </article>
          ))}
        </section>

        <section className="mat-leather flex flex-wrap items-center gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
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
          <div className="t-muted ml-auto">
            Showing {dataAuthoritative ? filteredViolations.length : '--'} of {dataAuthoritative ? violations.length : '--'}
          </div>
        </section>

        {/* Violations List */}
        <section>
          <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>
            Violations ({filteredViolations.length} of {violations.length})
          </h2>
          <div className="space-y-[var(--s4)]">
            {filteredViolations.length === 0 ? (
              <div className="empty mat-leather rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.14)]">
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
                          onClick={() => void transitionViolation(v, 'resolve')}
                          disabled={transitioningIds.has(v.violation_id)}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      ) : null}
                      {v.status === 'new' || v.status === 'acknowledged' ? (
                        <button
                          onClick={() => void transitionViolation(v, 'dismiss')}
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

        {/* Escalation Modal */}
        {selectedViolation && (
          <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-[var(--s4)]">
            <div className="frame max-w-sm">
              <i className="rivet rivet--tl" /><i className="rivet rivet--tr" /><i className="rivet rivet--bl" /><i className="rivet rivet--br" />
              <div className="frame-in mat-leather p-[var(--s5)]">
                <h3 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Escalate Violation</h3>
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
                  <button
                    onClick={handleEscalate}
                    className="btn flex-1"
                  >
                    Escalate
                  </button>
                  <button
                    onClick={() => setSelectedViolation(null)}
                    className="btn btn--ghost flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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
