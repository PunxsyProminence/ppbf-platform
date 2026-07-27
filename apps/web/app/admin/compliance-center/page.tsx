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
  violation_timestamp: string;
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
        const res = await fetch(`${apiBase()}/api/pilot/compliance/violations`);
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
        return 'bg-[#fce8e6]';
      case 'high':
        return 'bg-[#fff3cd]';
      case 'medium':
        return 'bg-[#e3f2fd]';
      default:
        return 'bg-[#f1f8e9]';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new':
        return 'text-[#d32f2f]';
      case 'escalated':
        return 'text-[#f57c00]';
      case 'resolved':
        return 'text-[#388e3c]';
      default:
        return 'text-[#1976d2]';
    }
  };

  const handleEscalate = async () => {
    if (!selectedViolation) return;

    try {
      const res = await fetch(`${apiBase()}/api/pilot/compliance/escalate`, {
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
      const reloadRes = await fetch(`${apiBase()}/api/pilot/compliance/violations`);
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
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Compliance Management</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Compliance Center</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">Review, manage, and escalate athlete compliance violations.</p>
          {errorMessage ? <p className="mt-2 text-xs text-[#f0c4c4]">{errorMessage}</p> : null}
          {!errorMessage && !isLoading && !dataAuthoritative ? (
            <p className="mt-2 text-xs text-[#f0c4c4]">Compliance metrics are unavailable and intentionally not shown as zero.</p>
          ) : null}
        </header>

        {/* Metrics Dashboard */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-3 text-center">
            <p className="text-xs text-[#cfbfae]">Total</p>
            <p className="text-2xl font-bold text-[#f2e7da]">{metricValue(metrics.total)}</p>
          </div>
          <div className="border-2 border-[#fce8e6] bg-[#1a1a1a] p-3 text-center">
            <p className="text-xs text-[#d32f2f]">Critical</p>
            <p className="text-2xl font-bold text-[#f2e7da]">{metricValue(metrics.critical)}</p>
          </div>
          <div className="border-2 border-[#fff3cd] bg-[#1a1a1a] p-3 text-center">
            <p className="text-xs text-[#f57c00]">High</p>
            <p className="text-2xl font-bold text-[#f2e7da]">{metricValue(metrics.high)}</p>
          </div>
          <div className="border-2 border-[#e3f2fd] bg-[#1a1a1a] p-3 text-center">
            <p className="text-xs text-[#1976d2]">Medium</p>
            <p className="text-2xl font-bold text-[#f2e7da]">{metricValue(metrics.medium)}</p>
          </div>
          <div className="border-2 border-[#f1f8e9] bg-[#1a1a1a] p-3 text-center">
            <p className="text-xs text-[#388e3c]">Low</p>
            <p className="text-2xl font-bold text-[#f2e7da]">{metricValue(metrics.low)}</p>
          </div>
        </section>

        <section className="flex flex-wrap items-center gap-3 border border-[#5a4a3a] bg-[#121212] p-3">
          <div className="flex flex-wrap gap-2">
            {['all', 'new', 'acknowledged', 'escalated', 'resolved'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`border-2 px-3 py-1 text-xs font-bold uppercase ${
                  statusFilter === status
                    ? 'border-[#d4a574] bg-[#2a1a1a] text-[#d4a574]'
                    : 'border-[#5a4a3a] bg-[#101010] text-[#8b7355]'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="severity-filter" className="text-xs font-bold text-[#d4a574]">Severity:</label>
            <select id="severity-filter"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="border border-[#5a4a3a] bg-[#101010] px-3 py-1 text-xs text-[#e8d7c6]"
            >
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="ml-auto text-xs text-[#9a8a7a]">
            Showing {dataAuthoritative ? filteredViolations.length : '--'} of {dataAuthoritative ? violations.length : '--'}
          </div>
        </section>

        {/* Violations List */}
        <section>
          <h2 className="mb-4 text-lg font-bold text-[#f2e7da]">
            Violations ({filteredViolations.length} of {violations.length})
          </h2>
          <div className="space-y-3">
            {filteredViolations.length === 0 ? (
              <div className="border border-[#5a4a3a] bg-[#111111] px-4 py-5 text-sm text-[#9a8a7a]">
                No violations match the current filters. Try setting Status to &quot;all&quot; and Severity to &quot;all&quot;.
              </div>
            ) : (
              filteredViolations.map((v) => (
                <div
                  key={v.violation_id}
                  className={`border-2 border-[#8b4444] p-4 ${getSeverityColor(v.severity)}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="mb-2 flex gap-2">
                        <span className="font-mono text-xs font-bold uppercase text-[#111111]">
                          {v.severity}
                        </span>
                        <span className={`font-mono text-xs font-bold uppercase ${getStatusColor(v.status)}`}>
                          {v.status}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-[#111111]">Athlete: {v.athlete_id}</p>
                      <p className="text-xs text-[#333333]">Rule: {v.rule_id}</p>
                      <p className="mt-1 text-xs text-[#444444]">
                        {new Date(v.violation_timestamp).toLocaleString()}
                      </p>
                      {v.description && <p className="mt-2 text-sm text-[#222222]">{v.description}</p>}
                    </div>
                    {v.status === 'new' || v.status === 'acknowledged' ? (
                      <button
                        onClick={() => setSelectedViolation(v)}
                        className="border-2 border-[#111111] bg-[#fce8e6] px-3 py-2 text-xs font-bold text-[#111111]"
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
            <div className="border-2 border-[#8b4444] bg-[#111111] p-6 max-w-sm">
              <h3 className="mb-4 text-lg font-bold text-[#f2e7da]">Escalate Violation</h3>
              <p className="mb-4 text-sm text-[#cfbfae]">
                Athlete: <span className="font-semibold text-[#e8d7c6]">{selectedViolation.athlete_id}</span>
              </p>
              <div className="mb-4">
                <label htmlFor="escalate-to-select" className="block text-xs font-bold uppercase text-[#d4a574]">Escalate To</label>
                <select id="escalate-to-select"
                  value={escalateToRole}
                  onChange={(e) => setEscalateToRole(e.target.value)}
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                >
                  <option value="organization_admin">Organization Admin</option>
                  <option value="admin">Platform Admin</option>
                </select>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleEscalate}
                  className="flex-1 border-2 border-[#8b4444] bg-[#2a1a1a] py-2 text-xs font-bold text-[#d4a574]"
                >
                  Escalate
                </button>
                <button
                  onClick={() => setSelectedViolation(null)}
                  className="flex-1 border-2 border-[#5a4a3a] bg-[#101010] py-2 text-xs font-bold text-[#8b7355]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Link href="/admin" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Admin
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
