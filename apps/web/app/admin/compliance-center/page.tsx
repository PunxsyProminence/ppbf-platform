'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

interface ComplianceViolation {
  violation_id: string;
  rule_id: string;
  athlete_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'new' | 'acknowledged' | 'escalated' | 'resolved' | 'dismissed';
  created_at: string;
  description?: string;
}

export default function AdminComplianceCenterPage() {
  const [violations, setViolations] = useState<ComplianceViolation[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [dataAuthoritative, setDataAuthoritative] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [selectedViolation, setSelectedViolation] = useState<ComplianceViolation | null>(null);
  const [escalateToRole, setEscalateToRole] = useState('organization_admin');
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

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-[var(--locked-ink)]';
      case 'high':
        return 'bg-[var(--restricted-ink)]';
      case 'medium':
        return 'bg-[var(--monitor-ink)]';
      default:
        return 'bg-[var(--cleared-ink)]';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new':
        return 'text-[var(--locked)]';
      case 'escalated':
        return 'text-[var(--restricted)]';
      case 'resolved':
        return 'text-[var(--cleared)]';
      default:
        return 'text-[var(--monitor)]';
    }
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
    >
      <div className="space-y-6">
        <header className="border-2 border-[var(--patina-700)] bg-[var(--hide-950)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">Compliance Management</p>
          <h1 className="mt-2 text-3xl font-black text-[var(--bone-100)]">Compliance Center</h1>
          <p className="mt-2 text-sm text-[var(--bone-300)]">Review, manage, and escalate athlete compliance violations.</p>
          {errorMessage ? <p className="mt-2 text-xs text-[var(--locked-ink)]">{errorMessage}</p> : null}
          {!errorMessage && !isLoading && !dataAuthoritative ? (
            <p className="mt-2 text-xs text-[var(--locked-ink)]">Compliance metrics are unavailable and intentionally not shown as zero.</p>
          ) : null}
        </header>

        {/* Metrics Dashboard */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)] p-3 text-center">
            <p className="text-xs text-[var(--bone-300)]">Total</p>
            <p className="text-2xl font-bold text-[var(--bone-100)]">{metricValue(metrics.total)}</p>
          </div>
          <div className="border-2 border-[var(--locked-ink)] bg-[var(--hide-900)] p-3 text-center">
            <p className="text-xs text-[var(--locked)]">Critical</p>
            <p className="text-2xl font-bold text-[var(--bone-100)]">{metricValue(metrics.critical)}</p>
          </div>
          <div className="border-2 border-[var(--restricted-ink)] bg-[var(--hide-900)] p-3 text-center">
            <p className="text-xs text-[var(--restricted)]">High</p>
            <p className="text-2xl font-bold text-[var(--bone-100)]">{metricValue(metrics.high)}</p>
          </div>
          <div className="border-2 border-[var(--monitor-ink)] bg-[var(--hide-900)] p-3 text-center">
            <p className="text-xs text-[var(--monitor)]">Medium</p>
            <p className="text-2xl font-bold text-[var(--bone-100)]">{metricValue(metrics.medium)}</p>
          </div>
          <div className="border-2 border-[var(--cleared-ink)] bg-[var(--hide-900)] p-3 text-center">
            <p className="text-xs text-[var(--cleared)]">Low</p>
            <p className="text-2xl font-bold text-[var(--bone-100)]">{metricValue(metrics.low)}</p>
          </div>
        </section>

        <section className="flex flex-wrap items-center gap-3 border border-[var(--hide-500)] bg-[var(--hide-950)] p-3">
          <div className="flex flex-wrap gap-2">
            {['all', 'new', 'acknowledged', 'escalated', 'resolved'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`border-2 px-3 py-1 text-xs font-bold uppercase ${
                  statusFilter === status
                    ? 'border-[var(--brass-500)] bg-[var(--rust-900)] text-[var(--brass-300)]'
                    : 'border-[var(--hide-500)] bg-[var(--hide-950)] text-[var(--bone-400)]'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="severity-filter" className="text-xs font-bold text-[var(--brass-300)]">Severity:</label>
            <select id="severity-filter"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="border border-[var(--hide-500)] bg-[var(--hide-950)] px-3 py-1 text-xs text-[var(--bone-200)]"
            >
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="ml-auto text-xs text-[var(--bone-400)]">
            Showing {dataAuthoritative ? filteredViolations.length : '--'} of {dataAuthoritative ? violations.length : '--'}
          </div>
        </section>

        {/* Violations List */}
        <section>
          <h2 className="mb-4 text-lg font-bold text-[var(--bone-100)]">
            Violations ({filteredViolations.length} of {violations.length})
          </h2>
          <div className="space-y-3">
            {filteredViolations.length === 0 ? (
              <div className="border border-[var(--hide-500)] bg-[var(--hide-950)] px-4 py-5 text-sm text-[var(--bone-400)]">
                No violations match the current filters. Try setting Status to &quot;all&quot; and Severity to &quot;all&quot;.
              </div>
            ) : (
              filteredViolations.map((v) => (
                <div
                  key={v.violation_id}
                  className={`border-2 border-[var(--patina-700)] p-4 ${getSeverityColor(v.severity)}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="mb-2 flex gap-2">
                        <span className="font-mono text-xs font-bold uppercase text-[var(--hide-950)]">
                          {v.severity}
                        </span>
                        <span className={`font-mono text-xs font-bold uppercase ${getStatusColor(v.status)}`}>
                          {v.status}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-[var(--hide-950)]">Athlete: {v.athlete_id}</p>
                      <p className="text-xs text-[var(--hide-700)]">Rule: {v.rule_id}</p>
                      <p className="mt-1 text-xs text-[var(--hide-600)]">
                        {new Date(v.created_at).toLocaleString()}
                      </p>
                      {v.description && <p className="mt-2 text-sm text-[var(--hide-800)]">{v.description}</p>}
                    </div>
                    {v.status === 'new' || v.status === 'acknowledged' ? (
                      <button
                        onClick={() => setSelectedViolation(v)}
                        className="border-2 border-[var(--hide-950)] bg-[var(--locked-ink)] px-3 py-2 text-xs font-bold text-[var(--hide-950)]"
                      >
                        Escalate
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Escalation Modal */}
        {selectedViolation && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4">
            <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-950)] p-6 max-w-sm">
              <h3 className="mb-4 text-lg font-bold text-[var(--bone-100)]">Escalate Violation</h3>
              <p className="mb-4 text-sm text-[var(--bone-300)]">
                Athlete: <span className="font-semibold text-[var(--bone-200)]">{selectedViolation.athlete_id}</span>
              </p>
              <div className="mb-4">
                <label htmlFor="escalate-to-select" className="block text-xs font-bold uppercase text-[var(--brass-300)]">Escalate To</label>
                <select id="escalate-to-select"
                  value={escalateToRole}
                  onChange={(e) => setEscalateToRole(e.target.value)}
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                >
                  <option value="organization_admin">Organization Admin</option>
                  <option value="admin">Platform Admin</option>
                </select>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleEscalate}
                  className="flex-1 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] py-2 text-xs font-bold text-[var(--brass-300)]"
                >
                  Escalate
                </button>
                <button
                  onClick={() => setSelectedViolation(null)}
                  className="flex-1 border-2 border-[var(--hide-500)] bg-[var(--hide-950)] py-2 text-xs font-bold text-[var(--bone-400)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Link href="/admin" className="border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-4 py-2 text-xs font-mono text-[var(--brass-300)]">
            Back to Admin
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
