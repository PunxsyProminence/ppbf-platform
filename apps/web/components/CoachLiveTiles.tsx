'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { isPainReportEscalation } from '@/src/shared/painScoreLabel';

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
 *   attention   GET  /api/pilot/escalations?status=open -- open escalations on
 *               the coach's OWN athletes (the route scopes a coach to them), by
 *               their own severity. A pain report is counted on its own, as a
 *               number with no severity word (OD-2026-10-12-005, "Show the
 *               number only"), as the header badge does.
 *   queue       POST /api/pilot/shadow/review-projection -- how many SHADOW
 *               cases are in the queue, every status (the number the coach
 *               workspace calls "in the queue"), not only those awaiting review.
 *
 * Read every two minutes, the header badge's pace: the escalations read also
 * closes hold notices whose hold has ended, so a faster poll is only load.
 *
 * A read that fails says so in words. It never shows 0: "nothing here" and "we
 * could not look" are different claims (the #991 class).
 */

export const COACH_TILES_REFRESH_MS = 120_000;

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
  /** Pain reports, counted apart: a number, never a severity word (OD-2026-10-12-005). */
  painReports: number;
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
  const counts: AttentionCounts = { critical: 0, high: 0, moderate: 0, low: 0, painReports: 0 };
  for (const row of body.escalations as Array<{ severity?: unknown; metadata?: unknown }>) {
    if (isPainReportEscalation(row?.metadata)) {
      counts.painReports += 1;
      continue;
    }
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

  // A read slower than the next one must not overwrite it, and nothing is set after unmount.
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++sequence.current;
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
    if (!mounted.current || mine !== sequence.current) return;
    const counted = a.status === 'fulfilled' ? attendanceCounts(a.value) : null;
    setAttendance(counted ? { state: 'ok', value: counted } : { state: 'failed' });
    const levels = b.status === 'fulfilled' ? attentionCounts(b.value) : null;
    setAttention(levels ? { state: 'ok', value: levels } : { state: 'failed' });
    const total = c.status === 'fulfilled' ? queueTotal(c.value) : null;
    setQueue(total === null ? { state: 'failed' } : { state: 'ok', value: total });
  }, []);

  useEffect(() => {
    // No state is set before load's first await (the convention SessionScriptLiveDelivery follows).
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
      <Group title="Need attention · your athletes" read={attention}>
        {() =>
          attention.state === 'ok' && (
            <>
              <Tile value={attention.value.critical} label="Critical" badge={{ tone: 'restricted', glyph: '▲' }} />
              <Tile value={attention.value.high} label="High" badge={{ tone: 'restricted', glyph: '▲' }} />
              <Tile value={attention.value.moderate} label="Moderate" badge={{ tone: 'monitor', glyph: '◉' }} />
              <Tile value={attention.value.low} label="Low" />
              <Tile value={attention.value.painReports} label="Pain reports" />
            </>
          )
        }
      </Group>
      <Group title="SHADOW queue" read={queue}>
        {() => queue.state === 'ok' && <Tile value={queue.value} label="In the queue" />}
      </Group>
    </div>
  );
}
