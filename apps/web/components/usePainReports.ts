'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { PAIN_FEED_LIMIT, painReportCount, type PainReportCount } from '@/components/CoachLiveTiles';

/**
 * THE ONE READ OF THE PAIN FEED (lane U2-6b-2; Overwatch's 6b ruling: "the tile and the panel read
 * one feed (GET /api/pilot/coach/pain-reports) over one stated window"; QF = A, limit=50).
 *
 * The coach home's pain list, the floor board's pain items and, on the class screen, the pain
 * tile all read this one read, so they count the same rows over the same stated window.
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
}

/** The coach home's words for a read that did not answer with a list (unchanged). */
export const PAIN_READ_FAILED = 'Unable to load athlete pain reports';

export interface PainReportsRead {
  /** A read is out (the first, a refresh, or a retry). */
  loading: boolean;
  /** At least one read has answered, well or not. */
  answered: boolean;
  /** The last answer's failure, in words; '' when it answered with a list. */
  error: string;
  reports: CoachPainReport[];
  /** The feed's own window; null until a read answers with one. */
  windowDays: number | null;
  truncated: boolean;
  reload: () => void;
}

async function readPainFeed(): Promise<{ reports: CoachPainReport[]; count: PainReportCount }> {
  const response = await fetch(`${apiBase()}/api/pilot/coach/pain-reports?limit=${PAIN_FEED_LIMIT}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(PAIN_READ_FAILED);
  const payload: unknown = await response.json();
  const count = painReportCount(payload);
  if (!count) throw new Error(PAIN_READ_FAILED);
  return { reports: (payload as { painReports: CoachPainReport[] }).painReports, count };
}

export function usePainReports(options: { refreshMs?: number } = {}): PainReportsRead {
  const { refreshMs } = options;
  const [state, setState] = useState<Omit<PainReportsRead, 'reload'>>({
    loading: true,
    answered: false,
    error: '',
    reports: [],
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
    void readPainFeed().then(
      ({ reports, count }) => {
        if (!mounted.current || mine <= shown.current) return;
        shown.current = mine;
        setState({
          loading: mine !== sequence.current,
          answered: true,
          error: '',
          reports,
          windowDays: count.windowDays,
          truncated: count.truncated,
        });
      },
      (error: unknown) => {
        if (!mounted.current || mine <= shown.current) return;
        shown.current = mine;
        // Never fall through to the "no reports" line: a coach reading that after a failed read
        // would believe no child had reported pain. The window last read stays named.
        setState((current) => ({
          loading: mine !== sequence.current,
          answered: true,
          error: error instanceof Error && error.message ? error.message : PAIN_READ_FAILED,
          reports: [],
          windowDays: current.windowDays,
          truncated: false,
        }));
      },
    );
  }, []);

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
  read: Pick<PainReportsRead, 'answered' | 'error' | 'reports' | 'windowDays' | 'truncated'>,
): { state: 'loading' } | { state: 'failed' } | { state: 'ok'; value: PainReportCount } {
  if (!read.answered) return { state: 'loading' };
  if (read.error || read.windowDays === null) return { state: 'failed' };
  return { state: 'ok', value: { count: read.reports.length, truncated: read.truncated, windowDays: read.windowDays } };
}
