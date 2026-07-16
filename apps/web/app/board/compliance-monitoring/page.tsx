"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import ShadowChatButton from '@/components/ShadowChatButton';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';

const boardRoles = roleRoutes
  .map((route) => route.role)
  .filter((role): role is ClubRole => role.startsWith('board-'));

interface ComplianceViolation {
  violation_id: string;
  rule_id: string;
  athlete_id: string;
  severity: string;
  status: string;
  escalation_status: string;
  created_at: string;
}

interface ShadowRequirementItem {
  research_requirement_id: number;
  status: 'open' | 'resolved';
}

export default function BoardComplianceMonitoringPage() {
  const [violations, setViolations] = useState<ComplianceViolation[]>([]);
  const [requirements, setRequirements] = useState<ShadowRequirementItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');

  useEffect(() => {
    void (async () => {
      try {
        // Fetch violations
        const violRes = await fetch(`${apiBase()}/api/pilot/compliance/violations?status=${selectedStatus || ''}`);
        if (!violRes.ok) {
          throw new Error('Unable to load compliance violations.');
        }
        const violData = (await violRes.json()) as { items?: ComplianceViolation[] };
        setViolations(violData.items ?? []);

        // Fetch SHADOW requirements
        const reqRes = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`);
        if (reqRes.ok) {
          const payload = (await reqRes.json()) as { items?: ShadowRequirementItem[] };
          setRequirements(payload.items ?? []);
        }

        setErrorMessage('');
      } catch (error) {
        setViolations([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load compliance data.');
      }
    })();
  }, [selectedStatus]);

  const severityCounts = useMemo(
    () => ({
      critical: violations.filter((v) => v.severity === 'critical').length,
      high: violations.filter((v) => v.severity === 'high').length,
      medium: violations.filter((v) => v.severity === 'medium').length,
      low: violations.filter((v) => v.severity === 'low').length,
    }),
    [violations],
  );

  const statusCounts = useMemo(
    () => ({
      new: violations.filter((v) => v.status === 'new').length,
      acknowledged: violations.filter((v) => v.status === 'acknowledged').length,
      escalated: violations.filter((v) => v.status === 'escalated').length,
      resolved: violations.filter((v) => v.status === 'resolved').length,
    }),
    [violations],
  );

  return (
    <RoleSessionGate allowedRoles={boardRoles}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">Board Workspace</p>
            <h1 className="font-display text-4xl font-black">Automated Compliance Monitoring</h1>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Real-time compliance violation tracking and escalation management.
            </p>
            {errorMessage ? <p className="text-sm text-[var(--red-primary)]">{errorMessage}</p> : null}
            <ShadowChatButton context="Board Compliance Monitoring" />
          </header>

          {/* Metrics Dashboard */}
          <section className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <article className="border-2 border-[var(--black)] bg-[#fce8e6] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">Critical</h2>
              <p className="mt-4 text-4xl font-black">{severityCounts.critical}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[#fff3cd] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-[#ff9800]">High</h2>
              <p className="mt-4 text-4xl font-black">{severityCounts.high}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em]">Medium</h2>
              <p className="mt-4 text-4xl font-black">{severityCounts.medium}</p>
            </article>
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em]">Low</h2>
              <p className="mt-4 text-4xl font-black">{severityCounts.low}</p>
            </article>
          </section>

          {/* Status Filters */}
          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-bold uppercase">Filter by Status</h2>
            <div className="flex flex-wrap gap-2">
              {['', 'new', 'acknowledged', 'escalated', 'resolved'].map((status) => (
                <button
                  key={status || 'all'}
                  onClick={() => setSelectedStatus(status)}
                  className={`border-2 px-3 py-1 text-sm font-bold uppercase ${
                    selectedStatus === status
                      ? 'border-[var(--black)] bg-[var(--black)] text-[var(--canvas-tan)]'
                      : 'border-[var(--black)] bg-[var(--canvas-tan-light)]'
                  }`}
                >
                  {status || 'All'} ({status === '' ? violations.length : violations.filter((v) => v.status === status).length})
                </button>
              ))}
            </div>
          </section>

          {/* Violations List */}
          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-bold uppercase">Violations</h2>
            {violations.length === 0 ? (
              <p className="text-sm text-[var(--gray-dark)]">No violations found.</p>
            ) : (
              <div className="space-y-3">
                {violations.map((violation) => (
                  <article key={violation.violation_id} className="border-2 border-[var(--black)] bg-white p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex gap-2">
                          <span className={`text-xs font-bold uppercase px-2 py-1 border border-[var(--black)] ${
                            violation.severity === 'critical' ? 'bg-[#fce8e6]' :
                            violation.severity === 'high' ? 'bg-[#fff3cd]' :
                            'bg-[var(--canvas-tan-light)]'
                          }`}>
                            {violation.severity}
                          </span>
                          <span className="text-xs font-bold uppercase px-2 py-1 border border-[var(--black)] bg-[var(--canvas-tan-light)]">
                            {violation.status}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-mono">Athlete: {violation.athlete_id}</p>
                        <p className="text-xs text-[var(--gray-dark)]">
                          {new Date(violation.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <button className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-xs font-bold uppercase">
                        Review
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/board" className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]">
              Back to Board Hub
            </Link>
            <Link href="/admin/compliance-center" className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]">
              Admin Compliance Center
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
