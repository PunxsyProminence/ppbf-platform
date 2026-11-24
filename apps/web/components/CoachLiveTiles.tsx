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
 * Four reads the coach's screens already make, nothing new on the server:
 *   attendance  GET  /api/pilot/coach/attendance-today -- today's reconciled
 *               marks for the gym (`covered`). A row is a mark; no row is NOT an
 *               absence, so the athletes without one are counted as "Not
 *               marked", never as absent. It is the gym day, not this session,
 *               and the tiles say "today".
 *   attention   GET  /api/pilot/escalations?status=open -- open escalations on
 *               the coach's OWN athletes (the route scopes a coach to them), by
 *               their own severity. A pain-report escalation is skipped here, so
 *               a 7/10 report stored as critical is never counted as "Critical".
 *   pain        GET  /api/pilot/coach/pain-reports -- the feed the coach home's
 *               pain list reads (lane U2-6b, Overwatch's 6b ruling: "the tile and
 *               the panel read one feed ... over one stated window"). The tile
 *               counts exactly the feed's rows and names the feed's own window
 *               (Q2 = A, Q3 = A). It is a number with no severity word
 *               (OD-2026-10-12-005, "Show the number only") and wears no badge:
 *               a pain report is never a medical stop (OD-2026-10-03-017). The
 *               feed covers every athlete the route lets the caller see, which
 *               for a coach is the whole gym, so the tile sits under the list's
 *               own heading, not under "your athletes".
 *   queue       POST /api/pilot/shadow/review-projection -- how many SHADOW
 *               cases are in the queue, every status (the number the coach
 *               workspace calls "in the queue"), not only those awaiting review.
 *
 * Read every two minutes, the header badge's pace: the escalations read also
 * closes hold notices whose hold has ended, so a faster poll is only load. Each
 * read sets its own tiles when it answers, so a read that hangs never holds
 * another's answer back -- above all a failed pain read's "?" (the review of
 * lane U2-6b) -- and an older answer never replaces a newer one.
 *
 * A read that fails says so in words. It never shows 0: "nothing here" and "we
 * could not look" are different claims (the #991 class). The pain tile says it
 * as "?" and "Pain reports: not checked" (Overwatch's 6b ruling).
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
}

/** The pain feed's rows over its own window (lane U2-6b). */
export interface PainReportCount {
  /** How many reports the feed returned: the tile counts exactly these (Q3 = A). */
  count: number;
  /** The feed matched more reports than it returned. */
  truncated: boolean;
  /** The feed's own window, in days; the tile names it and never assumes one. */
  windowDays: number;
}

/** The most rows the pain feed returns (route.ts: parseSafeLimit(..., 25, 50)). */
export const PAIN_FEED_LIMIT = 50;
/** The pain tile's label when its read failed or was refused (Overwatch's 6b ruling, Q2 = A). */
export const PAIN_REPORTS_NOT_CHECKED = 'Pain reports: not checked';

type Read<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; value: T };

/**
 * A pain read the screen already makes and hands the tile (lane U2-6b-2): on the class screen,
 * the one read its pain list draws, so the tile and the list read the same rows over the same
 * window (usePainReports, painTileRead). Without one, the tile reads the feed itself.
 */
export type PainTileRead = Read<PainReportCount>;

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

/** Open escalations by severity, pain reports skipped; null when the payload is not a list. */
export function attentionCounts(payload: unknown): AttentionCounts | null {
  const body = payload as { ok?: unknown; escalations?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.escalations)) return null;
  const counts: AttentionCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const row of body.escalations as Array<{ severity?: unknown; metadata?: unknown }>) {
    // A pain report is the pain tile's, from its own feed (lane U2-6b): never a severity here.
    if (isPainReportEscalation(row?.metadata)) continue;
    const severity = row?.severity;
    if (severity === 'critical' || severity === 'high' || severity === 'moderate' || severity === 'low') {
      counts[severity] += 1;
    }
  }
  return counts;
}

/**
 * The pain feed's rows and window; null when the payload is not what the route sends, so a
 * read whose window or completeness cannot be stated is "not checked", never a count.
 */
export function painReportCount(payload: unknown): PainReportCount | null {
  const body = payload as { ok?: unknown; windowDays?: unknown; truncated?: unknown; painReports?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.painReports) || typeof body.truncated !== 'boolean') return null;
  const days = body.windowDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) return null;
  return { count: body.painReports.length, truncated: body.truncated, windowDays: days };
}

/**
 * The pain tile's value and label (Q2 = A): the count and "Pain reports, last N days" with N from
 * the feed; "50+" when the feed has more than it returned; "?" and "Pain reports: not checked"
 * when the read failed or was refused. Never 0 for a failed read.
 */
export function painTileWords(read: { state: 'failed' } | { state: 'ok'; value: PainReportCount }): { value: string; label: string } {
  if (read.state === 'failed') return { value: '?', label: PAIN_REPORTS_NOT_CHECKED };
  const { count, truncated, windowDays } = read.value;
  return { value: truncated ? `${count}+` : String(count), label: `Pain reports, last ${windowDays} days` };
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

function Tile({ value, label, badge }: { value: number | string; label: string; badge?: { tone: string; glyph: string } }) {
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

/**
 * A titled row of tiles. A failed read says "Could not read" in place of its tiles, unless the
 * tiles say it themselves (failedInTiles: the pain tile's "?" and "not checked").
 */
function Group({
  title,
  read,
  failedInTiles = false,
  children,
}: {
  title: string;
  read: Read<unknown>;
  failedInTiles?: boolean;
  children: () => ReactNode;
}) {
  const tiles = read.state === 'ok' || (read.state === 'failed' && failedInTiles);
  return (
    <section className="coach-tiles__group" aria-label={title}>
      <h3 className="coach-tiles__cap ge-enamel ge-enamel--sign">{title}</h3>
      {read.state === 'loading' && <p className="coach-tiles__note">Reading...</p>}
      {read.state === 'failed' && !failedInTiles && <p className="coach-tiles__note">Could not read</p>}
      {tiles && <ul className="coach-tiles__row">{children()}</ul>}
    </section>
  );
}

export default function CoachLiveTiles({ painFeed }: { painFeed?: PainTileRead } = {}) {
  const [attendance, setAttendance] = useState<Read<AttendanceCounts>>({ state: 'loading' });
  const [attention, setAttention] = useState<Read<AttentionCounts>>({ state: 'loading' });
  const [ownPain, setPain] = useState<Read<PainReportCount>>({ state: 'loading' });
  // The screen's own pain read when it hands one over; else the tile's (6b-1).
  const readsOwnPain = painFeed === undefined;
  const pain = painFeed ?? ownPain;
  const [queue, setQueue] = useState<Read<number>>({ state: 'loading' });

  // Each read is numbered; a tile takes an answer only if it is from a newer read than the one it
  // shows, so a read slower than the next one never overwrites it. Nothing is set after unmount.
  const sequence = useRef(0);
  const shown = useRef({ attendance: 0, attention: 0, queue: 0, pain: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const mine = ++sequence.current;
    const base = apiBase();
    function settle<T>(
      tile: keyof typeof shown.current,
      read: Promise<unknown>,
      parse: (payload: unknown) => T | null,
      set: (value: Read<T>) => void,
    ) {
      void read
        .then((payload) => parse(payload))
        // A failed read, or a payload the parser cannot take, is unread: never a number.
        .catch(() => null)
        .then((value) => {
          if (!mounted.current || mine <= shown.current[tile]) return;
          shown.current[tile] = mine;
          set(value === null ? { state: 'failed' } : { state: 'ok', value });
        });
    }
    settle('attendance', readJson(`${base}/api/pilot/coach/attendance-today`), attendanceCounts, setAttendance);
    settle('attention', readJson(`${base}/api/pilot/escalations?status=open`), attentionCounts, setAttention);
    settle(
      'queue',
      readJson(`${base}/api/pilot/shadow/review-projection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1 }),
      }),
      queueTotal,
      setQueue,
    );
    if (readsOwnPain) {
      // Counts only, so it asks for no notes (Jason's Q11, OD-2026-11-23-006; PR #2151 reviewer B).
      settle('pain', readJson(`${base}/api/pilot/coach/pain-reports?limit=${PAIN_FEED_LIMIT}&notes=none`), painReportCount, setPain);
    }
  }, [readsOwnPain]);

  useEffect(() => {
    // No state is set until a read answers (the convention SessionScriptLiveDelivery follows).
    load();
    const id = setInterval(load, COACH_TILES_REFRESH_MS);
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
            </>
          )
        }
      </Group>
      {/* The pain list's own heading (PainReportsPanel, "Athlete Pain Reports"): the feed is
          every athlete the caller may see, so it is not under "your athletes" (lane U2-6b). */}
      <Group title="Athlete pain reports" read={pain} failedInTiles>
        {() => {
          if (pain.state === 'loading') return null;
          const words = painTileWords(pain);
          return <Tile value={words.value} label={words.label} />;
        }}
      </Group>
      <Group title="SHADOW queue" read={queue}>
        {() => queue.state === 'ok' && <Tile value={queue.value} label="In the queue" />}
      </Group>
    </div>
  );
}
