'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

/**
 * PAST HOLDS -- one athlete's lifted and expired training holds, read back on
 * the Sports Medicine board (audit finding F-071: a lifted hold could not be
 * read anywhere afterwards).
 *
 * THE BOARD'S RULE HOLDS HERE TOO (owner decision 2026-08-15, kept by
 * OD-2026-10-04-001): the board shows holds "with athlete-safe explanations
 * ONLY". So a past hold shows exactly what the athlete was told -- what
 * stopped, their sentence, what would lift it -- and when it began and ended.
 * The staff reason, its category, the lift note and who lifted it are in the
 * row the route sends and are never rendered here.
 *
 * Read on demand: one closed button per row costs the board no request. The
 * route's staff read with no status filter answers every hold the athlete has
 * had; the active one is already on the board, so only lifted and expired
 * rows are listed. A failed read says so and offers Check again; it is never
 * shown as "no past holds".
 */

export interface PastHold {
  hold_id: string;
  athlete_id: string;
  scope: string;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  status: 'lifted' | 'expired';
}

type Reading =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; holds: PastHold[] };

const STATUSES: ReadonlySet<string> = new Set(['active', 'lifted', 'expired']);

/** Every entry must be a hold of THIS athlete with a known status, or the answer is not this answer. */
function isHoldOf(entry: unknown, athleteId: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const row = entry as Record<string, unknown>;
  return (
    row.athlete_id === athleteId
    && typeof row.hold_id === 'string'
    && typeof row.status === 'string' && STATUSES.has(row.status)
    && typeof row.scope === 'string'
    && typeof row.placed_at === 'string'
  );
}

/* The route sends times as Postgres text ('2026-09-01 16:00:00+00'), which not
   every browser's Date will read; ISO 8601 all of them do (the board's own
   isoInstant does the same). */
export function isoInstant(value: string): string {
  return value.trim().replace(' ', 'T').replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, '$1:00');
}

/** Only the athlete-safe fields leave this function; the rest of the staff row is dropped. */
function toPastHold(row: Record<string, unknown>): PastHold {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const instant = (value: unknown) => (typeof value === 'string' && value.trim() ? isoInstant(value) : null);
  return {
    hold_id: row.hold_id as string,
    athlete_id: row.athlete_id as string,
    scope: row.scope as string,
    athlete_explanation: text(row.athlete_explanation),
    lift_condition_text: text(row.lift_condition_text),
    placed_at: isoInstant(row.placed_at as string),
    expires_at: instant(row.expires_at),
    lifted_at: instant(row.lifted_at),
    status: row.status as 'lifted' | 'expired',
  };
}

function ended(hold: PastHold): string {
  if (hold.status === 'lifted') {
    const on = formatGymDateNumeric(hold.lifted_at);
    return on ? `Lifted ${on}` : 'Lifted';
  }
  const on = formatGymDateNumeric(hold.expires_at);
  return on ? `Expired ${on}` : 'Expired';
}

export default function PastTrainingHolds({
  athleteId,
  athleteName,
  reloadKey,
}: {
  athleteId: string;
  athleteName: string;
  /** Changes when the board's hold for this athlete changes (a lift), so an open list reads again. */
  reloadKey?: string;
}) {
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const readSeq = useRef(0);

  // `quiet`: a re-read after a lift keeps the list on screen until the new
  // answer lands, rather than blanking it to "Reading".
  const read = useCallback(async (quiet = false) => {
    const seq = ++readSeq.current;
    if (!quiet) setReading({ state: 'loading' });
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('unreadable');
      const payload = (await response.json()) as { ok?: unknown; holds?: unknown } | null;
      if (
        !payload
        || payload.ok !== true
        || !Array.isArray(payload.holds)
        || !payload.holds.every((entry) => isHoldOf(entry, athleteId))
      ) {
        throw new Error('unreadable');
      }
      const holds = (payload.holds as Array<Record<string, unknown>>)
        .filter((row) => row.status !== 'active')
        .map(toPastHold);
      if (readSeq.current === seq) setReading({ state: 'loaded', holds });
    } catch {
      if (readSeq.current === seq) setReading({ state: 'failed' });
    }
  }, [athleteId]);

  // An open list reads again when the board's hold changes under it.
  const open = reading.state !== 'closed';
  const lastKey = useRef(reloadKey);
  useEffect(() => {
    if (lastKey.current === reloadKey) return;
    lastKey.current = reloadKey;
    // A fetch, whose answer is set after it lands (same as FinishedSessions).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void read(true);
  }, [reloadKey, open, read]);

  if (reading.state === 'closed') {
    return (
      <button type="button" className="btn btn--ghost mt-[var(--s3)]" onClick={() => void read()}>
        Past holds
      </button>
    );
  }

  const headingId = `past-holds-${athleteId}`;
  return (
    <section className="mt-[var(--s3)]" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-[var(--s3)]">
        <h3 id={headingId} className="t-label">Past holds</h3>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => { readSeq.current += 1; setReading({ state: 'closed' }); }}
        >
          Hide
        </button>
      </div>

      {reading.state === 'loading' ? (
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" role="status">Reading past holds…</p>
      ) : null}

      {reading.state === 'failed' ? (
        <div role="alert" className="mt-[var(--s2)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
          <p className="t-body font-semibold">
            Past holds could not be read just now. This is not a statement that there were none.
          </p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
            Check again
          </button>
        </div>
      ) : null}

      {reading.state === 'loaded' && reading.holds.length === 0 ? (
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
          {athleteName} has no lifted or expired holds.
        </p>
      ) : null}

      {reading.state === 'loaded' && reading.holds.length > 0 ? (
        <ul className="mt-[var(--s2)] space-y-[var(--s2)]" aria-label={`Past holds for ${athleteName}, newest first`}>
          {reading.holds.map((hold) => (
            <li
              key={hold.hold_id}
              className="mat-paper rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s3)]"
            >
              <p className="t-eyebrow">
                {hold.scope.replaceAll('_', ' ')} · placed {formatGymDateNumeric(hold.placed_at) ?? 'date not known'} · {ended(hold)}
              </p>
              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                {hold.athlete_explanation || 'No sentence was written for the athlete.'}
              </p>
              <p className="t-label mt-[var(--s2)]">
                Its path back was: {hold.lift_condition_text || 'Not written down.'}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
