'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { PAIN_FEED_LIMIT, painReportCount, type PainReportCount } from '@/components/CoachLiveTiles';
import type { PainReporter } from '@/src/server/pilot/formulas/painReportAlert';
import type { ShadowNearMissSeverity } from '@/src/server/pilot/shadowNearMisses';

/**
 * THE ONE READ OF THE PAIN FEED (lane U2-6b-2; Overwatch's 6b ruling: "the tile and the panel read
 * one feed (GET /api/pilot/coach/pain-reports) over one stated window"; QF = A, limit=50).
 *
 * The coach home's pain list, the floor board's pain items and, on the class screen, the pain
 * tile all read this one read, over the same stated window. The tile counts the feed's rows; the
 * list draws the rows it can and says so when it could not draw them all.
 *
 * The server filters to the athletes the caller may see. Anything returned here is a child who
 * told the platform they were hurting and was told a coach would see it, so a read that fails,
 * is refused, or answers with no window, no completeness flag or no list is a failed read with
 * its own words -- never "no athlete reported pain" (painReportCount, the 6b-1 tile's check).
 *
 * The newest answer wins: an answer is kept only if it is from a newer read than the one shown,
 * so a slow older answer never replaces a newer one. Nothing is set after unmount.
 *
 * A timed refresh (refreshMs, the class screen's two minutes) keeps the last answer on screen
 * until the new one arrives, as the 6b-1 tile does, so the list neither blanks nor re-announces
 * every two minutes and the list and the tile show the same answer. Only a refresh the coach asks
 * for (reload: the panel's Refresh, a retry) says it is checking, as the coach home always did;
 * the list says so until every read then out has answered (a timed one included), while the tile
 * shows the newest answer.
 */

/**
 * One pain report, already filtered server-side to the athletes this coach is authorized for.
 * Every nullable field is a detail the REPORTER did not supply -- render it as "not stated" and
 * never as a value.
 *
 * NOT NECESSARILY SELF-REPORTED. The observations route admits athlete, coach,
 * organization_admin and admin, and the card said "Self-reported by the athlete" for all four
 * until 2026-08-24. A coach writing down what they observed was shown to the next coach as the
 * child's own words, which changes what that coach does with it.
 */
export interface CoachPainReport {
  nearMissId: string;
  athleteId: string;
  athleteName: string | null;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  painScore: number | null;
  location: string | null;
  painType: string | null;
  observedAt: string | null;
  recordedAt: string | null;
  /** Bounded classification from the server. 'unknown' on reports written
   *  before provenance was persisted -- see painReportAlert.ts. */
  reporter: 'athlete' | 'coach' | 'staff_admin' | 'unknown';
  /**
   * DR-25: the athlete's note, or null when there is none or (for a coach) it is held for admins.
   * Absent on a read made without notes (the class screen: Jason's Q11, "A: Keep them off").
   */
  note?: string | null;
  /** Organization admins and admins only: true when the note is held for admins. */
  noteAdminOnly?: boolean;
  /** Who marked it reviewed and when; null while nobody has. Never an account id. */
  reviewed: PainReportReview | null;
}

export interface PainReportReview {
  at: string;
  /** The reviewer's staff name at this gym, or null when they cannot be named. */
  byName: string | null;
}

/**
 * The panel's words for any read that did not answer with a list: refused, failed, malformed or
 * a network error. Never the browser's own error text (Overwatch on #2023).
 */
export const PAIN_READ_FAILED = 'Unable to load athlete pain reports';

// Keyed by the server's own types, so a value the server adds fails the typecheck here until the
// panel can draw it, rather than every report carrying it going quietly undrawn.
const SEVERITY_KEYS: Record<ShadowNearMissSeverity, true> = { low: true, moderate: true, high: true, critical: true };
const REPORTER_KEYS: Record<PainReporter, true> = { athlete: true, coach: true, staff_admin: true, unknown: true };
const SEVERITIES: ReadonlySet<unknown> = new Set(Object.keys(SEVERITY_KEYS));
const REPORTERS: ReadonlySet<unknown> = new Set(Object.keys(REPORTER_KEYS));
const textOrNull = (value: unknown) => value === null || typeof value === 'string';

export function isPainReportReview(value: unknown): value is PainReportReview {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.at === 'string' && r.at !== '' && textOrNull(r.byName);
}

/**
 * A row the panel can draw: the route's shape (CoachPainReport, painReportAlert.ts). A row that
 * is not is skipped from the cards, so one bad row cannot throw and take the class screen's
 * console down with it (Overwatch on #2023). It is never skipped silently: the list then shows
 * its failed-read words beside the cards it could draw and never the "no athlete has reported
 * pain" line, the coach home's floor board marks the pain feed failed, and the tile still counts
 * the feed's rows (Q3 = A).
 */
/**
 * A row this screen can draw. With notes (the coach home), `note` must be text or null; without
 * (the class screen), the row must carry no note and no admin-only marker at all -- a row that does
 * is a server answer this screen cannot trust, so it is not drawn and the list says so.
 */
export function isPainReportRow(row: unknown, withNotes = true): row is CoachPainReport {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.nearMissId === 'string' && r.nearMissId !== ''
    && typeof r.athleteId === 'string'
    && textOrNull(r.athleteName)
    && SEVERITIES.has(r.severity)
    && (r.painScore === null || typeof r.painScore === 'number')
    && textOrNull(r.location)
    && textOrNull(r.painType)
    && textOrNull(r.observedAt)
    && textOrNull(r.recordedAt)
    && REPORTERS.has(r.reporter)
    && (withNotes
      ? textOrNull(r.note) && (r.noteAdminOnly === undefined || typeof r.noteAdminOnly === 'boolean')
      : r.note === undefined && r.noteAdminOnly === undefined)
    && (r.reviewed === null || isPainReportReview(r.reviewed))
  );
}

/** The panel's own words when "Mark reviewed" did not go through; never the browser's. */
export const PAIN_REVIEW_FAILED = 'Could not mark this report reviewed. Try again.';

/**
 * "Mark reviewed" on one pain report (DR-25). The server keeps the FIRST review, so the answer may
 * name someone else who got there first; the caller shows whatever comes back.
 */
export async function markPainReportReviewed(nearMissId: string): Promise<PainReportReview> {
  const response = await fetch(
    `${apiBase()}/api/pilot/coach/pain-reports/${encodeURIComponent(nearMissId)}/review`,
    { method: 'POST', credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(PAIN_REVIEW_FAILED);
  const payload = (await response.json().catch(() => null)) as { reviewed?: unknown } | null;
  if (!payload || !isPainReportReview(payload.reviewed)) throw new Error(PAIN_REVIEW_FAILED);
  return payload.reviewed;
}

export interface PainReportsRead {
  /** A read is out (the first, a refresh, or a retry). */
  loading: boolean;
  /** At least one read has answered, well or not. */
  answered: boolean;
  /** The last answer's failure, in words; '' when it answered with a list. */
  error: string;
  /** The rows the list can draw (isPainReportRow). */
  reports: CoachPainReport[];
  /** How many rows the feed returned, drawable or not: the tile's count (Q3 = A). */
  rowCount: number;
  /** Rows the feed returned that the list could not draw (rowCount minus reports). */
  unreadRows: number;
  /** The feed's own window; null until a read answers with one. */
  windowDays: number | null;
  truncated: boolean;
  reload: () => void;
}

async function readPainFeed(withNotes: boolean): Promise<{ reports: CoachPainReport[]; count: PainReportCount }> {
  const notes = withNotes ? '' : '&notes=none';
  const response = await fetch(`${apiBase()}/api/pilot/coach/pain-reports?limit=${PAIN_FEED_LIMIT}${notes}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(PAIN_READ_FAILED);
  const payload: unknown = await response.json();
  const count = painReportCount(payload);
  if (!count) throw new Error(PAIN_READ_FAILED);
  const rows = (payload as { painReports: unknown[] }).painReports;
  return { reports: rows.filter((row): row is CoachPainReport => isPainReportRow(row, withNotes)), count };
}

export function usePainReports(options: {
  refreshMs?: number;
  /**
   * False on the class screen (the gym floor tablet): the read asks for no notes, and the server
   * sends no note text and no admin-only marker (Jason's Q11, OD-2026-11-23-006, "A: Keep them
   * off"). Default true (the coach home).
   */
  withNotes?: boolean;
} = {}): PainReportsRead {
  const { refreshMs, withNotes = true } = options;
  const [state, setState] = useState<Omit<PainReportsRead, 'reload'>>({
    loading: true,
    answered: false,
    error: '',
    reports: [],
    rowCount: 0,
    unreadRows: 0,
    windowDays: null,
    truncated: false,
  });

  const sequence = useRef(0);
  const shown = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Sets no state until the read answers, so it can run from an effect.
  const read = useCallback(() => {
    const mine = ++sequence.current;
    void readPainFeed(withNotes).then(
      ({ reports, count }) => {
        if (!mounted.current || mine <= shown.current) return;
        shown.current = mine;
        setState({
          loading: mine !== sequence.current,
          answered: true,
          error: '',
          reports,
          rowCount: count.count,
          unreadRows: count.count - reports.length,
          windowDays: count.windowDays,
          truncated: count.truncated,
        });
      },
      () => {
        if (!mounted.current || mine <= shown.current) return;
        shown.current = mine;
        // Never fall through to the "no reports" line: a coach reading that after a failed read
        // would believe no child had reported pain. The window last read stays named. The words
        // are the panel's own, whatever the browser said.
        setState((current) => ({
          loading: mine !== sequence.current,
          answered: true,
          error: PAIN_READ_FAILED,
          reports: [],
          rowCount: 0,
          unreadRows: 0,
          windowDays: current.windowDays,
          truncated: false,
        }));
      },
    );
  }, [withNotes]);

  // A refresh or a retry the coach asked for: says a read is out, then reads.
  const reload = useCallback(() => {
    setState((current) => (current.loading ? current : { ...current, loading: true }));
    read();
  }, [read]);

  useEffect(() => {
    read();
    if (!refreshMs) return undefined;
    // The timed refresh reads quietly: the last answer stays until the new one arrives.
    const id = setInterval(read, refreshMs);
    return () => clearInterval(id);
  }, [read, refreshMs]);

  return { ...state, reload };
}

/**
 * The pain tile's read from the shared one (lane U2-6b-2): nothing yet while no read has
 * answered; failed when the last answer failed; else the feed's rows and window. While a refresh
 * is out the tile keeps the last answer, as it does on its own read (6b-1).
 */
export function painTileRead(
  read: Pick<PainReportsRead, 'answered' | 'error' | 'rowCount' | 'windowDays' | 'truncated'>,
): { state: 'loading' } | { state: 'failed' } | { state: 'ok'; value: PainReportCount } {
  if (!read.answered) return { state: 'loading' };
  if (read.error || read.windowDays === null) return { state: 'failed' };
  return { state: 'ok', value: { count: read.rowCount, truncated: read.truncated, windowDays: read.windowDays } };
}
