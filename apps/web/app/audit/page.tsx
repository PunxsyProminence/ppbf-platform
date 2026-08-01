'use client';

import { useCallback, useEffect, useState } from 'react';
import FeatureSurface from '@/components/FeatureSurface';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface AuditEvent {
  audit_id: string | number;
  event_type: string;
  actor_account_id: string | null;
  actor_role: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

type LoadState = 'loading' | 'loaded' | 'failed';

function formatDetails(details: Record<string, unknown> | null): string {
  if (!details || Object.keys(details).length === 0) {
    return 'None recorded';
  }

  try {
    return JSON.stringify(details);
  } catch {
    return 'Not displayable';
  }
}

function AuditTrace() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadNonce, setReloadNonce] = useState(0);

  const retry = useCallback(() => setReloadNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      setLoadState('loading');

      try {
        const response = await fetch(`${apiBase()}/api/pilot/audit/get`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 50 }),
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          setEvents([]);
          setLoadState('failed');
          return;
        }

        const payload = (await response.json()) as { ok?: boolean; events?: AuditEvent[] };
        if (payload.ok !== true) {
          setEvents([]);
          setLoadState('failed');
          return;
        }

        setEvents(payload.events ?? []);
        setLoadState('loaded');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setEvents([]);
        setLoadState('failed');
      }
    })();

    return () => controller.abort();
  }, [reloadNonce]);

  return (
    <FeatureSurface
      eyebrow="Audit & Change Trace"
      title="Timeline visibility for governance and traceability"
      description="Track who changed what and why, then hand approved trace flows to Source Control for promotion."
      status="Live | Organization audit log"
      currentStage="audit"
      primaryLinks={[
        { label: 'Source control', href: '/source-control' },
        { label: 'Simulator', href: '/simulator' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Audit Trace' },
        { label: 'Next Stage', value: 'Source Control' },
        { label: 'Source', value: 'pilot.audit_events' },
        { label: 'Events Shown', value: loadState === 'loaded' ? String(events.length) : '--' },
      ]}
    >
      <div className="space-y-3">
        {loadState === 'loading' && (
          <p className="text-[16px] leading-7 text-[var(--bone-200)]">Loading the audit trail...</p>
        )}

        {/* A failed read and an empty trail must never look the same: one means
            nothing has happened, the other means we do not know what has. */}
        {loadState === 'failed' && (
          <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4" role="alert">
            <p className="text-[16px] leading-7 text-[var(--bone-200)]">
              The audit trail could not be loaded, so this is not a record of nothing happening -- it is a record of
              nothing being read.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 min-h-[44px] border-2 border-[var(--brass-500)] bg-[var(--hide-900)] px-4 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[var(--brass-300)]"
            >
              Retry loading the audit trail
            </button>
          </div>
        )}

        {loadState === 'loaded' && events.length === 0 && (
          <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4">
            <p className="text-[16px] leading-7 text-[var(--bone-200)]">
              No audit events have been recorded for your organization yet.
            </p>
          </div>
        )}

        {loadState === 'loaded' && events.map((event) => (
          <article key={String(event.audit_id)} className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4">
            <div className="grid gap-2 text-[14px] text-[var(--bone-300)] md:grid-cols-2">
              <p><span className="font-semibold text-[var(--brass-300)]">Timestamp:</span> {event.created_at}</p>
              <p><span className="font-semibold text-[var(--brass-300)]">Actor:</span> {event.actor_account_id ?? 'Not recorded'}</p>
              <p><span className="font-semibold text-[var(--brass-300)]">Actor Role:</span> {event.actor_role ?? 'Not recorded'}</p>
              <p><span className="font-semibold text-[var(--brass-300)]">Event:</span> {event.event_type}</p>
              <p><span className="font-semibold text-[var(--brass-300)]">Entity:</span> {event.entity_type}</p>
              <p><span className="font-semibold text-[var(--brass-300)]">Entity ID:</span> {event.entity_id}</p>
              <p className="md:col-span-2"><span className="font-semibold text-[var(--brass-300)]">Details:</span> {formatDetails(event.details)}</p>
            </div>
          </article>
        ))}

        <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-950)] p-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-[var(--brass-300)]">Flow Direction</p>
          <p className="mt-2 text-[16px] leading-7 text-[var(--bone-200)]">Audited items move into Source Control promotion states for controlled publication.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}

export default function AuditTracePage() {
  // Matches the gate on POST /api/pilot/audit/get, which admits the
  // organization admin and coach roles only. A wider gate here would render a
  // page whose only content is a 403.
  return (
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
      <AuditTrace />
    </RoleSessionGate>
  );
}
