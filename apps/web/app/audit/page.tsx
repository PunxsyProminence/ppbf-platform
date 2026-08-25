'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
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

  const stats = [
    { label: 'Current Stage', value: 'Audit Trace' },
    { label: 'Next Stage', value: 'Source Control' },
    { label: 'Source', value: 'pilot.audit_events' },
    { label: 'Events Shown', value: loadState === 'loaded' ? String(events.length) : '--' },
  ];

  return (
    <main className="room room--file min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <header className="mat-leather--raised border-b border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Audit &amp; Change Trace</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              The Ledger
            </h1>
            {/* The ledger has no 'why' field. pilot.audit_events records the
                event type, the actor, the entity and a details blob -- what
                happened and who did it. Its own building-map hint says exactly
                that; this line used to promise a reason nothing stores. */}
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              The continuity ledger: what happened and who did it. No reason is recorded against an event, because
              nothing asks for one.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Audit Trace" />
            <Link href="/source-control" className="btn btn--ghost">
              Source Control
            </Link>
            <Link href="/simulator" className="btn btn--ghost">
              Simulator
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="audit" />

        <section aria-label="Audit trace status" className="flex flex-wrap gap-[var(--s3)]">
          {stats.map((item) => (
            <span key={item.label} className="plaque">
              {item.label.toUpperCase()}: {item.value.toUpperCase()}
            </span>
          ))}
        </section>

        {/* .t-body pins a bone ink tuned for leather, and this line stands
            directly on the room's cork wall with no panel under it. The ink
            goes on a child span for the same cascade reason /evidence
            documents: ppbf.css is unlayered, so a utility on the .t-body
            element itself loses and never lands. */}
        {loadState === 'loading' && (
          <p className="t-body" aria-busy="true">
            <span className="text-[color:var(--hide-900)]">Loading the audit trail...</span>
          </p>
        )}

        {/* A failed read and an empty trail must never look the same: one means
            nothing has happened, the other means we do not know what has. */}
        {loadState === 'failed' && (
          <div className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s5)]" role="alert">
            <span className="badge badge--locked">
              <i>✕</i>Trail Not Read
            </span>
            <p className="t-body mt-[var(--s3)]">
              The audit trail could not be loaded, so this is not a record of nothing happening -- it is a record of
              nothing being read.
            </p>
            <button type="button" onClick={retry} className="btn btn--ghost mt-[var(--s4)]">
              Retry loading the audit trail
            </button>
          </div>
        )}

        {loadState === 'loaded' && events.length === 0 && (
          <div className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            <p className="t-typed text-[length:var(--t-sm)]">
              No audit events have been recorded for your organization yet.
            </p>
          </div>
        )}

        {/* Law 4: every row is auditable, so the whole record speaks in the
            mono voice -- a ruled paper ledger, append-only, no row actions. */}
        {loadState === 'loaded' && events.length > 0 && (
          <section className="mat-paper aged rounded-[var(--r-md)] p-[var(--s5)]">
            <div className="overflow-x-auto">
              <table className="ledger">
                <caption className="text-left">Organization Audit Trail</caption>
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Role</th>
                    <th scope="col">Event</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={String(event.audit_id)}>
                      <td className="whitespace-nowrap">{event.created_at}</td>
                      <td>{event.actor_account_id ?? 'Not recorded'}</td>
                      <td>{event.actor_role ?? 'Not recorded'}</td>
                      <td>
                        <span className="ledger-val">{event.event_type}</span>
                      </td>
                      <td>
                        {event.entity_type}
                        <span className="ledger-id block">{event.entity_id}</span>
                      </td>
                      <td className="max-w-[34ch] break-words">{formatDetails(event.details)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Flow Direction</p>
          <p className="t-body mt-[var(--s3)]">
            Audited items move into Source Control promotion states for controlled publication.
          </p>
        </div>
      </div>
    </main>
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
