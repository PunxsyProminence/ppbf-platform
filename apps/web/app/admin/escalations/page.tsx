"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

type EscalationSeverity = 'low' | 'moderate' | 'high' | 'critical';
type EscalationStatus = 'open' | 'acknowledged' | 'resolved';
type EscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern';

interface SafetyEscalation {
  escalation_id: string;
  source_type: EscalationSourceType;
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

const SOURCE_LABEL: Record<EscalationSourceType, string> = {
  near_miss: 'Near Miss',
  pain_report: 'Pain Report',
  safety_gate_evaluation: 'Safety Gate',
  repeated_pattern: 'Repeated Pattern',
};

const STATUS_TABS: Array<{ value: EscalationStatus | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return value;
  }
}

export default function EscalationsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [roleFetchFailed, setRoleFetchFailed] = useState(false);
  const [items, setItems] = useState<SafetyEscalation[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<EscalationStatus | 'all'>('open');
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [isScanning, setIsScanning] = useState(false);

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

  async function handleResolve(escalationId: string) {
    const note = window.prompt(
      'Resolution note (required -- this is the durable record of why the red flag was closed):',
      '',
    );
    if (note === null) return;
    // A safety escalation about a minor does not close without a stated
    // reason. An empty OK is treated as "not done deciding", not as consent.
    if (note.trim() === '') {
      setActionMessage('Resolution needs a note -- the escalation was not resolved.');
      return;
    }
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
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Escalations</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.safety_escalations</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              This platform sends no email or push notification -- a near miss, pain report, or safety-gate flag
              severe enough to escalate lands here, and only here. Nothing auto-resolves; a human closes every row.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {roleFetchFailed ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">
                  Your role could not be verified, so resolve and pattern-scan controls are hidden. Reload to retry.
                </span>
              </p>
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
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)]">
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
                                <button type="button" onClick={() => void handleResolve(item.escalation_id)} className="btn--lever min-h-[44px]">
                                  Resolve
                                </button>
                              ) : null}
                            </div>
                          ) : item.status === 'acknowledged' && isAdmin ? (
                            <button type="button" onClick={() => void handleResolve(item.escalation_id)} className="btn--lever min-h-[44px]">
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
