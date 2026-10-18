'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * THE COACH'S TOP ROW (lane L39 PR 3). Jason 2026-10-17, "A: Coach screen only"
 * (OD-2026-10-17-008): the ATTENDANCE and NEED ATTENTION tiles from his style
 * references go on the coach's own live-session screen, never on the gym TV.
 * Counts only, no names (OD-2026-10-17-018).
 *
 * Three reads the coach's screens already make, nothing new on the server:
 *   attendance  GET  /api/pilot/coach/attendance-today -- today's reconciled
 *               marks for the gym (`covered`). A row is a mark; no row is NOT an
 *               absence, so the athletes without one are counted as "Not
 *               marked", never as absent. It is the gym day, not this session,
 *               and the tiles say "today".
 *   attention   GET  /api/pilot/escalations?status=open -- open escalations the
 *               coach may see, counted by their own severity.
 *   queue       POST /api/pilot/shadow/review-projection -- the SHADOW review
 *               queue's total, the number the coach workspace shows.
 *
 * A read that fails says so in words. It never shows 0: "nothing here" and "we
 * could not look" are different claims (the #991 class).
 */

export const COACH_TILES_REFRESH_MS = 60_000;

export interface AttendanceCounts {
  present: number;
  absent: number;
  excused: number;
  notMarked: number;
}

export interface AttentionCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

type Read<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; value: T };

/** Today's marks over the athletes the read covered; null when the payload is not one. */
export function attendanceCounts(payload: unknown): AttendanceCounts | null {
  const body = payload as { ok?: unknown; covered?: unknown; marks?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.covered) || !Array.isArray(body.marks)) return null;
  const covered = new Set(body.covered.filter((id): id is string => typeof id === 'string'));
  const status = new Map<string, string>();
  for (const mark of body.marks as Array<{ athlete_id?: unknown; status?: unknown }>) {
    if (typeof mark?.athlete_id === 'string' && covered.has(mark.athlete_id) && typeof mark.status === 'string') {
      status.set(mark.athlete_id, mark.status);
    }
  }
  const count = (wanted: string) => [...status.values()].filter((value) => value === wanted).length;
  return {
    present: count('present'),
    absent: count('absent'),
    excused: count('excused'),
    notMarked: [...covered].filter((id) => !status.has(id)).length,
  };
}

/** Open escalations by severity; null when the payload is not a list. */
export function attentionCounts(payload: unknown): AttentionCounts | null {
  const body = payload as { ok?: unknown; escalations?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.escalations)) return null;
  const counts: AttentionCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const row of body.escalations as Array<{ severity?: unknown }>) {
    const severity = row?.severity;
    if (severity === 'critical' || severity === 'high' || severity === 'moderate' || severity === 'low') {
      counts[severity] += 1;
    }
  }
  return counts;
}

/** The SHADOW review queue's total; null when the payload has none. */
export function queueTotal(payload: unknown): number | null {
  const body = payload as { ok?: unknown; total?: unknown } | null;
  if (!body || body.ok !== true || typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) return null;
  return body.total;
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function Tile({ value, label, badge }: { value: number; label: string; badge?: { tone: string; glyph: string } }) {
  return (
    <li className="ge-tile">
      <span className="ge-tile__value">{value}</span>
      {badge ? (
        <span className={`badge badge--${badge.tone}`}>
          <i aria-hidden="true">{badge.glyph}</i>
          {label}
        </span>
      ) : (
        <span className="ge-tile__label">{label}</span>
      )}
    </li>
  );
}

function Group({ title, read, children }: { title: string; read: Read<unknown>; children: () => ReactNode }) {
  return (
    <section className="coach-tiles__group" aria-label={title}>
      <h3 className="coach-tiles__cap ge-enamel ge-enamel--sign">{title}</h3>
      {read.state === 'loading' && <p className="coach-tiles__note">Reading...</p>}
      {read.state === 'failed' && <p className="coach-tiles__note">Could not read</p>}
      {read.state === 'ok' && <ul className="coach-tiles__row">{children()}</ul>}
    </section>
  );
}

export default function CoachLiveTiles() {
  const [attendance, setAttendance] = useState<Read<AttendanceCounts>>({ state: 'loading' });
  const [attention, setAttention] = useState<Read<AttentionCounts>>({ state: 'loading' });
  const [queue, setQueue] = useState<Read<number>>({ state: 'loading' });

  const load = useCallback(async () => {
    const base = apiBase();
    const [a, b, c] = await Promise.allSettled([
      readJson(`${base}/api/pilot/coach/attendance-today`),
      readJson(`${base}/api/pilot/escalations?status=open`),
      readJson(`${base}/api/pilot/shadow/review-projection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1 }),
      }),
    ]);
    const counted = a.status === 'fulfilled' ? attendanceCounts(a.value) : null;
    setAttendance(counted ? { state: 'ok', value: counted } : { state: 'failed' });
    const levels = b.status === 'fulfilled' ? attentionCounts(b.value) : null;
    setAttention(levels ? { state: 'ok', value: levels } : { state: 'failed' });
    const total = c.status === 'fulfilled' ? queueTotal(c.value) : null;
    setQueue(total === null ? { state: 'failed' } : { state: 'ok', value: total });
  }, []);

  useEffect(() => {
    // No state is set before load's first await (the convention SessionScriptLiveDelivery follows).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const id = setInterval(() => void load(), COACH_TILES_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="ge-wallboard coach-tiles" role="group" aria-label="The gym at a glance">
      <Group title="Attendance today" read={attendance}>
        {() =>
          attendance.state === 'ok' && (
            <>
              <Tile value={attendance.value.present} label="Present" />
              <Tile value={attendance.value.absent} label="Absent" />
              <Tile value={attendance.value.excused} label="Excused" />
              <Tile value={attendance.value.notMarked} label="Not marked" />
            </>
          )
        }
      </Group>
      <Group title="Need attention" read={attention}>
        {() =>
          attention.state === 'ok' && (
            <>
              <Tile value={attention.value.critical} label="Critical" badge={{ tone: 'restricted', glyph: '▲' }} />
              <Tile value={attention.value.high} label="High" badge={{ tone: 'restricted', glyph: '▲' }} />
              <Tile value={attention.value.moderate} label="Moderate" badge={{ tone: 'monitor', glyph: '◉' }} />
              <Tile value={attention.value.low} label="Low" />
            </>
          )
        }
      </Group>
      <Group title="SHADOW queue" read={queue}>
        {() => queue.state === 'ok' && <Tile value={queue.value} label="To review" />}
      </Group>
    </div>
  );
}
