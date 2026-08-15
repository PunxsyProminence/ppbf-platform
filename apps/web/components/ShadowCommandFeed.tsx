'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

// The operational record, read-only, for the operations hub's command node.
//
// This panel used to be a stamped placeholder whose copy existed to stop an
// empty panel from being mistaken for a quiet floor. The feed keeps that
// doctrine while replacing the stamp with the real record: it reads the SAME
// org-scoped, role-projected rows the SHADOW consoles read (shadow/events and
// shadow/telemetry routes, both restricted server-side), combines them newest
// first, and claims nothing beyond what is recorded. No alerting rules, no
// thresholds, no severity ranking -- deciding what deserves an alarm is a
// human decision that has not been made, and inventing one here would put
// fabricated urgency on a safety-adjacent surface.
interface ShadowEventItem {
  shadow_event_id: number;
  event_name: string;
  entity_type: string;
  created_at: string;
}

interface ShadowTelemetryItem {
  shadow_telemetry_event_id: number;
  metric_name: string;
  created_at: string;
}

interface FeedRow {
  key: string;
  kind: 'event' | 'telemetry';
  label: string;
  detail: string | null;
  created_at: string;
}

const FEED_LIMIT = 12;

export default function ShadowCommandFeed() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [eventsResponse, telemetryResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/shadow/events`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: FEED_LIMIT }),
          }),
          fetch(`${apiBase()}/api/pilot/shadow/telemetry`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: FEED_LIMIT }),
          }),
        ]);

        if (!eventsResponse.ok || !telemetryResponse.ok) {
          throw new Error('Unable to read the operational record.');
        }

        const eventsPayload = (await eventsResponse.json()) as { events?: ShadowEventItem[] };
        const telemetryPayload = (await telemetryResponse.json()) as { telemetry?: ShadowTelemetryItem[] };

        const combined: FeedRow[] = [
          ...(eventsPayload.events ?? []).map((event) => ({
            key: `event-${event.shadow_event_id}`,
            kind: 'event' as const,
            label: event.event_name,
            detail: event.entity_type || null,
            created_at: event.created_at,
          })),
          ...(telemetryPayload.telemetry ?? []).map((metric) => ({
            key: `telemetry-${metric.shadow_telemetry_event_id}`,
            kind: 'telemetry' as const,
            label: metric.metric_name,
            detail: null,
            created_at: metric.created_at,
          })),
        ]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, FEED_LIMIT);

        setRows(combined);
        setErrorMessage(null);
      } catch (error) {
        setRows([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to read the operational record.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <p className="t-body"><span className="working">Reading the operational record...</span></p>;
  }

  if (errorMessage) {
    return (
      <div className="alert alert--critical alert--tight" role="alert">
        <div className="alert-body">
          <p className="alert-msg">
            {errorMessage} A failed read means this panel is blind right now, not that the floor is clear.
          </p>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="t-body">
        Nothing is recorded in the operational feed. An empty feed means nothing has been recorded,
        not that the floor is clear.
      </p>
    );
  }

  return (
    <ul className="space-y-[var(--s2)]">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-baseline gap-x-[var(--s3)] gap-y-[var(--s1)]">
          <span className={row.kind === 'event' ? 'badge badge--monitor' : 'badge badge--cleared'}>
            <i>{row.kind === 'event' ? '◉' : '▣'}</i>
            {row.kind}
          </span>
          <span className="t-data" style={{ fontSize: 'var(--t-sm)' }}>{row.label}</span>
          {row.detail ? (
            <span className="t-label" style={{ fontSize: 'var(--t-xs)' }}>{row.detail}</span>
          ) : null}
          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{formatGymStamp(row.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
