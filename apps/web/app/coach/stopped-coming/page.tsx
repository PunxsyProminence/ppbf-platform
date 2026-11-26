'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import RefusalStamp, { REFUSAL_STAMP_COPY } from '@/components/RefusalStamp';
import BackHome from '@/components/BackHome';
import ClusterNav from '@/components/ClusterNav';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { PASSBOOK_PAGE } from '@/components/athleteRecordPages';
import { handOffArrivalAthlete, isPlainClick } from '@/components/decisionLoopArrival';

// STOPPED COMING -- the page over `/api/pilot/stopped-coming` (lane W4-6,
// SC-2; W4 item 6, app scrub CF-14).
//
// Who is on it is the server's (stoppedComing.ts): the gym's athletes not
// marked as left, with an active program membership where the gym records any
// for them (App Overwatch on #2172), who have come before and have not come for
// the gym's number of days (OW27-30 A, OW27-31 A). This page shows no membership
// status. "Came" is a present day on a class register or a "here" tap the
// register does not hold (open gym, a tap that made no register mark, or a
// cancelled class), on this page only (OW27-32 A; App Overwatch on #2172), so
// the words here say "came", never "present" or "attendance": no attendance
// figure is shown.
// The server orders the list, longest gone first; this page renders that order
// as given.
//
// The empty state says what the list covers, so it never reads as "nobody is
// slipping" about athletes it does not cover (never came, left the gym, or every
// recorded program membership lapsed or ended).
//
// Scope: a coach and the gym admin read the same list (a coach's reach is the
// whole gym). The gate below is the courtesy copy; the API is the authority.
//
// THE "REACHED OUT" MARK (SC-3b; OW27-33 B, so two coaches do not both reach
// out, or neither). Who and when only (Overwatch W4-6 Q4 A): PUT
// { athlete_id, reached_out }. An unmarked row has "Mark reached out"; a marked
// row has "Take back mark", sent only if a fresh read still shows the mark the
// row showed. After any answer but a 401 or 403 (the page's own stamp), the
// list is read again, so a row shows what the server holds (another coach's
// mark, after 'already_marked'), never a state set here. A 2xx answer is a
// confirmation only when it carries one of the route's four outcome words
// ('marked', 'already_marked', 'taken_back', 'not_marked'); any other 2xx says
// it is not known whether the change was saved. A marker the server cannot name
// is not given a name, and the row says so. A mark whose on_day is not
// YYYY-MM-DD (the form the server sends), or whose by_name is neither text nor
// null, makes the page say it could not read the list.
//
// A press's outcome is shown under the pressed athlete's row while that row is
// on the list shown, and at the top of the page otherwise. Either way the
// page's one status line reads it out.

interface ReachedOut {
  /** The marker's staff name at this gym; null when the server cannot name them. */
  by_name: string | null;
  /** The gym-local day it was marked, YYYY-MM-DD. */
  on_day: string;
}

interface StoppedComingAthlete {
  athlete_id: string;
  full_name: string;
  last_came_day: string;
  days_since_came: number;
  /** Sent only while newer than last_came_day (the server's rule); null when there is none to show. */
  reached_out: ReachedOut | null;
}

interface StoppedComingList {
  gap_days: number;
  is_default: boolean;
  today: string;
  athletes: StoppedComingAthlete[];
}

/** 14 -> "2 weeks"; the gym's choices are whole weeks. */
function gapWords(days: number): string {
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return `${days} days`;
}

/** "the last week", "the last 2 weeks". */
function withinWords(days: number): string {
  return days === 7 ? 'the last week' : `the last ${gapWords(days)}`;
}

/**
 * A mark as the route sends it (by_name text or null, on_day in the form YYYY-MM-DD), or null.
 * A row without one is not read as unmarked.
 */
function isReachedOut(value: unknown): value is ReachedOut | null {
  if (value === null) return true;
  const mark = value as Partial<ReachedOut> | undefined;
  return typeof mark === 'object' && typeof mark.on_day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(mark.on_day)
    && (mark.by_name === null || typeof mark.by_name === 'string');
}

/** The answer has the shape the route sends, or the page says it could not read it. */
function isStoppedComingList(value: unknown): value is StoppedComingList {
  const list = value as Partial<StoppedComingList> | null;
  return typeof list === 'object' && list !== null
    && typeof list.gap_days === 'number' && typeof list.is_default === 'boolean'
    && typeof list.today === 'string' && Array.isArray(list.athletes)
    && list.athletes.every((athlete) => isReachedOut((athlete as Partial<StoppedComingAthlete> | null)?.reached_out));
}

/** "Reached out by Sam K. on Mar 9, 2026."; with no name to show, it says who marked it cannot be shown, never a stand-in. */
function reachedOutWords(mark: ReachedOut): string {
  const day = formatCalendarDay(mark.on_day);
  const name = mark.by_name?.trim();
  return name ? `Reached out by ${name} on ${day}.` : `Reached out on ${day}; who marked it cannot be shown.`;
}

// The route's own refusals after its 401 and 403 (handled first): the server said no and wrote nothing.
const REFUSAL_STATUSES = new Set([400, 404, 409]);

/**
 * A refusal's words, by the route's status and code (stoppedComing.ts, reachedOutMarks.ts); `listRead`
 * is whether the read after it worked. RefusalStamp adds the full stop.
 */
function refusalDetail(status: number, code: unknown, name: string, listRead: boolean): string {
  if (code === 'NOT_ON_STOPPED_COMING_LIST') return `${name} is no longer on the stopped-coming list, so nothing was marked`;
  if (code === 'REACHED_OUT_MARK_CHANGED') {
    const changed = `the mark on ${name} changed while it was being saved, so nothing was saved`;
    return listRead ? `${changed}; the list was read again and shows the mark as the server holds it now` : changed;
  }
  if (status === 404) return `${name} was not found in this gym, so nothing was saved`;
  return `the server refused the change for ${name}, so nothing was saved`;
}

type OutcomeWord = 'marked' | 'already_marked' | 'taken_back' | 'not_marked';

/** One of the four outcome words the route's PUT answers with (reachedOutMarks.ts, ReachedOutOutcome). */
function isOutcomeWord(value: unknown): value is OutcomeWord {
  return value === 'marked' || value === 'already_marked' || value === 'taken_back' || value === 'not_marked';
}

/** What the server confirmed, by its outcome word. */
function confirmedWords(outcome: OutcomeWord, name: string): string {
  switch (outcome) {
    case 'marked': return `${name} was marked as reached out.`;
    case 'already_marked': return `${name} was already marked as reached out, so nothing new was saved.`;
    case 'taken_back': return `The mark on ${name} was taken back.`;
    case 'not_marked': return `There was no mark on ${name} to take back, so nothing was taken back.`;
  }
}

/** A stamp's words as the status line reads them: its label, then its sentence with the detail. */
function stampWords(kind: keyof typeof REFUSAL_STAMP_COPY, detail: string): string {
  const copy = REFUSAL_STAMP_COPY[kind];
  return `${copy.label}: ${copy.body(detail)}`;
}

/** The page's own refusal: signed out, or not a coach or admin of this gym. */
type PageRefusal = 'signed_out' | 'wrong_door';

/** The page stamp's detail. A PUT answered 403 names marking; a refused read names reading. signed_out reads the same for both. */
function pageStampDetail(kind: PageRefusal, byPress: boolean): string {
  if (kind === 'signed_out') return 'sign in again to read who has stopped coming';
  return byPress
    ? 'marking who was reached out is for a coach or the gym admin of this gym'
    : 'who has stopped coming is read by a coach or the gym admin of this gym';
}

const LIST_NOT_READ = 'The list could not be read again.';

/** What a press found: a plain line, a refusal stamp (Law 7), or not known. */
type Found = { kind: 'said'; text: string } | { kind: 'refused'; detail: string } | { kind: 'not_known'; text: string };

/** A press's outcome, with the athlete pressed. Set only once it is true. */
type Outcome = Found & { athleteId: string };

/**
 * No answer, an answer that is neither a refusal nor a 2xx, or a 2xx without a known outcome word:
 * whether it saved is not known; `listRead` is whether the read after it worked.
 */
function notKnown(name: string, reachedOut: boolean, listRead: boolean): Found {
  const what = reachedOut ? `${name} was marked as reached out` : `the mark on ${name} was taken back`;
  return { kind: 'not_known', text: `It is not known whether ${what}. ${listRead ? 'The list has been read again.' : LIST_NOT_READ}` };
}

const READ_FAILED = 'Could not read who has stopped coming, so no one is shown. This is not an empty list.';

/** What the status line reads for an outcome: a refusal as its stamp reads, a not-known warning with its title. */
function spokenWords(outcome: Outcome): string {
  if (outcome.kind === 'refused') return stampWords('cannot_be_done', outcome.detail);
  if (outcome.kind === 'not_known') return `Attention: ${outcome.text}`;
  return outcome.text;
}

/** A press's outcome as it is seen: a refusal stamp (Law 7), the not-known warning, or a plain line. */
function OutcomeShown({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'refused') {
    return (
      <RefusalStamp
        kind="cannot_be_done"
        detail={outcome.detail}
        className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
      />
    );
  }
  if (outcome.kind === 'not_known') {
    return (
      <div className="alert alert--warning">
        <span className="alert-icon" aria-hidden="true">▲</span>
        <div className="alert-body">
          <p className="alert-title">Attention</p>
          <p className="alert-msg">{outcome.text}</p>
        </div>
      </div>
    );
  }
  return <p className="t-body text-[length:var(--t-md)]">{outcome.text}</p>;
}

/** The athlete whose request is on its way: the take-back's check-read, or the PUT itself. */
type Busy = { athleteId: string; phase: 'checking' | 'saving' };

/**
 * A row's mark: who reached out and when, and one button named for its action ("Mark reached out",
 * or "Take back mark" on a marked row), so the words, not colour, say which (Law 3). While a request
 * runs, the pressed row's button says "Checking…" or "Saving…" and every other row's says "Waiting…".
 * aria-disabled, not disabled, so focus stays on it through a request (SessionRunPresence's register button).
 */
function ReachedOutMark({ athlete, busy, onPress }: {
  athlete: StoppedComingAthlete;
  busy: Busy | null;
  onPress: (athlete: StoppedComingAthlete, reachedOut: boolean, button: HTMLElement) => Promise<void>;
}) {
  const mark = athlete.reached_out;
  const mine = busy?.athleteId === athlete.athlete_id ? busy.phase : null;
  const words = mine === 'checking' ? 'Checking…'
    : mine === 'saving' ? 'Saving…'
      : busy ? 'Waiting…'
        : mark ? 'Take back mark' : 'Mark reached out';
  return (
    <>
      {mark ? <p className="t-body mt-[var(--s4)] text-[length:var(--t-md)]">{reachedOutWords(mark)}</p> : null}
      <button
        type="button"
        className="btn btn--ghost mt-[var(--s4)] mr-[var(--s3)] min-h-[var(--tap)] text-[length:var(--t-md)]"
        aria-disabled={busy !== null}
        aria-busy={mine !== null}
        aria-label={`${words}: ${athlete.full_name}`}
        onClick={(event) => void onPress(athlete, mark === null, event.currentTarget)}
      >
        {words}
      </button>
    </>
  );
}

export default function CoachStoppedComingPage() {
  const [list, setList] = useState<StoppedComingList | null>(null);
  const [refused, setRefused] = useState<PageRefusal | null>(null);
  // Whether the page's refusal answered a PUT (true) or a read (false).
  const [refusedByPress, setRefusedByPress] = useState(false);
  const [failed, setFailed] = useState(false);
  // The athlete whose mark is on its way, and which step; every row's button waits for it.
  const [busy, setBusy] = useState<Busy | null>(null);
  // Set before press()'s first await, so a second click that arrives before React re-renders
  // still finds it set, and sends nothing.
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Counts presses that have settled; the focus check below runs on each.
  const [settled, setSettled] = useState(0);
  // The button of the latest press, so focus is moved only once that button has gone.
  const pressedButton = useRef<HTMLElement | null>(null);
  const topOutcomeRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /** Reads the list and shows it; answers what it read, or null when it could not. */
  const read = useCallback(async (signal?: AbortSignal): Promise<StoppedComingList | null> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/stopped-coming`, {
        credentials: 'include',
        signal,
      });
      // A refusal is a stamp, not an error toast (Law 7).
      if (response.status === 401 || response.status === 403) {
        if (signal?.aborted) return null;
        setRefused(response.status === 401 ? 'signed_out' : 'wrong_door');
        return null;
      }
      if (!response.ok) throw new Error('read failed');
      const payload: unknown = await response.json();
      if (!isStoppedComingList(payload)) throw new Error('unexpected answer');
      if (signal?.aborted) return null;
      // A read that works clears an earlier failure, so the list it read is shown.
      setFailed(false);
      setList(payload);
      return payload;
    } catch {
      // An aborted load is the page unmounting, not a failure to report. Any other
      // failure (network, a bad status, an answer that is not the list) shows the
      // same fixed sentence, never an empty list.
      if (signal?.aborted) return null;
      setFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // read() sets state only after its fetch resolves (as SessionRunPresence's first read).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  // After a press settles, if the pressed button has gone (its row left the list, or the list is no
  // longer shown) and no element but the body has focus, focus moves to the outcome at the top, or
  // to the heading when there is none. Focus on any other element is never moved.
  useEffect(() => {
    if (settled === 0 || pressedButton.current?.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (topOutcomeRef.current ?? headingRef.current)?.focus();
  }, [settled]);

  /** Sends the PUT, then reads the list again (but after a 401 or 403); the outcome is worded after that read. */
  const send = async (athlete: StoppedComingAthlete, reachedOut: boolean): Promise<Found | null> => {
    const name = athlete.full_name;
    setBusy({ athleteId: athlete.athlete_id, phase: 'saving' });
    let response: Response;
    try {
      response = await fetch(`${apiBase()}/api/pilot/stopped-coming`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athlete.athlete_id, reached_out: reachedOut }),
      });
    } catch {
      return notKnown(name, reachedOut, (await read()) !== null);
    }
    // Signed out, or not a coach or admin of this gym: the page's own stamp, as a refused read, and
    // read out by the status line. No read follows.
    if (response.status === 401 || response.status === 403) {
      setRefused(response.status === 401 ? 'signed_out' : 'wrong_door');
      setRefusedByPress(true);
      return null;
    }
    // A body that is not JSON (a 204's empty one included) reads as null.
    const payload = (await response.json().catch(() => null)) as { outcome?: unknown; code?: unknown } | null;
    const listRead = (await read()) !== null;
    if (REFUSAL_STATUSES.has(response.status)) {
      return { kind: 'refused', detail: refusalDetail(response.status, payload?.code, name, listRead) };
    }
    if (!response.ok) return notKnown(name, reachedOut, listRead);
    // A 2xx is a confirmation only with one of the four outcome words.
    const outcomeWord = payload?.outcome;
    if (!isOutcomeWord(outcomeWord)) return notKnown(name, reachedOut, listRead);
    // Confirmed by the server, whether or not the list could then be read.
    return { kind: 'said', text: `${confirmedWords(outcomeWord, name)}${listRead ? '' : ` ${LIST_NOT_READ}`}` };
  };

  /**
   * Sends a take-back only if a fresh read just before it still shows the mark the row showed: the
   * same name and on_day, each name compared trimmed, with a blank one read as no name. Its limits:
   * - it compares the name and day shown, not a mark id;
   * - so a marker renamed, or no longer nameable, reads as changed, and nothing is sent;
   * - and two different marks with the same name and day pass;
   * - the PUT carries no mark id, so a change between that read and the PUT is not caught here: the
   *   server takes back the athlete's current mark at that moment, if it is newer than the last day
   *   they came, whichever mark that is.
   */
  const takeBack = async (athlete: StoppedComingAthlete): Promise<Found | null> => {
    const shown = athlete.reached_out;
    const fresh = await read();
    if (!fresh) return { kind: 'said', text: `The mark on ${athlete.full_name} could not be checked, so nothing was taken back.` };
    const row = fresh.athletes.find((listed) => listed.athlete_id === athlete.athlete_id);
    if (!row) return { kind: 'said', text: `${athlete.full_name} is no longer on the stopped-coming list, so nothing was taken back.` };
    const now = row.reached_out;
    const nameOf = (mark: ReachedOut) => mark.by_name?.trim() || null;
    if (!shown || !now || nameOf(now) !== nameOf(shown) || now.on_day !== shown.on_day) {
      return { kind: 'said', text: `The mark on ${athlete.full_name} has changed since it was shown, so nothing was taken back.` };
    }
    return send(athlete, false);
  };

  const press = async (athlete: StoppedComingAthlete, reachedOut: boolean, button: HTMLElement) => {
    if (inFlight.current) return;
    inFlight.current = true;
    pressedButton.current = button;
    // A take-back first checks the mark with a read ("Checking…"); send() says "Saving…" as the PUT goes.
    setBusy({ athleteId: athlete.athlete_id, phase: reachedOut ? 'saving' : 'checking' });
    // The last outcome stays on screen until this press (Law 7: not dismissed by a timer).
    setOutcome(null);
    try {
      const found = await (reachedOut ? send(athlete, true) : takeBack(athlete));
      setOutcome(found && { ...found, athleteId: athlete.athlete_id });
    } finally {
      inFlight.current = false;
      setBusy(null);
      setSettled((count) => count + 1);
    }
  };

  const gap = list ? gapWords(list.gap_days) : null;
  // The pressed athlete's row, while it is listed and the list is shown; otherwise the outcome shows at the top.
  const outcomeRow = outcome && list && !refused && !failed
    && list.athletes.some((listed) => listed.athlete_id === outcome.athleteId) ? outcome.athleteId : null;
  // The status line: a PUT answered 401 or 403 reads the page stamp's words; any other press, its outcome.
  // A refused first read leaves it empty, as before: the page stamp shows alone.
  const spoken = refused && refusedByPress
    ? stampWords(refused, pageStampDetail(refused, true))
    : outcome ? spokenWords(outcome) : '';

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* One room, applied here: this page owns its <main>. */}
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            {/* tabIndex -1, so focus can be sent here after a press whose button has gone and that left no outcome at the top. */}
            <h1 ref={headingRef} tabIndex={-1} className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Stopped Coming</h1>
            <ClusterNav cluster="who-needs-me" />
            <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-300)]">
              Athletes on the roster who have come before but have not come for{' '}
              {gap ? <strong>{gap}</strong> : 'the gym’s number of days'} or more, longest gone first. It leaves
              out athletes marked as left the gym and athletes whose program memberships have all lapsed or
              ended. Coming means a present day on a class register, or a &ldquo;here&rdquo; tap the register
              does not hold: open gym, or a class where the tap made no register mark, or that was cancelled.
            </p>
            {list && !failed ? (
              <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-400)]">
                {list.is_default
                  ? `The gym has not set its own number of days, so the default, ${gap}, applies.`
                  : `${gap} is the gym’s own setting.`}{' '}
                As of {formatCalendarDay(list.today)}.
              </p>
            ) : null}
          </header>

          {/* Always mounted, so what is put into it is announced (SessionRunPresence's status line). It
              reads every press's outcome, a refusal included, since the copy under a row is aria-hidden;
              and the page stamp's words after a PUT answered 401 or 403. */}
          <p role="status" className="sr-only">{spoken}</p>
          {/* A press's outcome stays until the next press (Law 7: a refusal is a stamp, not dismissed).
              Here when the pressed athlete's row is not shown; not aria-hidden, as focus may be sent here. */}
          {outcome && outcomeRow === null ? (
            <div ref={topOutcomeRef} tabIndex={-1} className="mb-[var(--s5)]">
              <OutcomeShown outcome={outcome} />
            </div>
          ) : null}

          {refused ? (
            <RefusalStamp
              kind={refused}
              detail={pageStampDetail(refused, refusedByPress)}
              className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
            />
          ) : failed ? (
            <div className="alert alert--warning" role="alert">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{READ_FAILED}</p>
              </div>
            </div>
          ) : !list ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Reading the registers...</span>
            </div>
          ) : list.athletes.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No one this list covers has gone {gap} without coming</div>
                <p className="empty-msg mx-auto">
                  Every athlete this list covers came within {withinWords(list.gap_days)}. It does not cover
                  athletes who have never come, athletes marked as left the gym, or athletes whose program
                  memberships have all lapsed or ended.
                </p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s4)]">
              {list.athletes.map((athlete) => (
                <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                  <span className="font-semibold text-[length:var(--t-lg)] text-[color:var(--bone-100)]">{athlete.full_name}</span>
                  <dl className="mt-[var(--s4)] flex flex-wrap gap-x-[var(--s6)] gap-y-[var(--s3)]">
                    <div>
                      <dt className="t-eyebrow">Last came</dt>
                      <dd className="t-data t-data--lg mt-[var(--s1)]">{formatCalendarDay(athlete.last_came_day)}</dd>
                    </div>
                    <div>
                      <dt className="t-eyebrow">Days since</dt>
                      <dd className="t-data t-data--lg mt-[var(--s1)]">{athlete.days_since_came}</dd>
                    </div>
                  </dl>
                  <ReachedOutMark athlete={athlete} busy={busy} onPress={press} />
                  {/* The athlete travels in page memory, never in the address (lane AS-11;
                      #1474 Q2 = C). Only a plain click hands off. The href stays literal so
                      the dead-link check reads it. */}
                  <Link
                    href="/coach/passbook"
                    className="btn btn--ghost mt-[var(--s4)] min-h-[var(--tap)] text-[length:var(--t-md)]"
                    aria-label={`Open passbook: ${athlete.full_name}`}
                    onClick={(event) => {
                      if (isPlainClick(event)) handOffArrivalAthlete(athlete.athlete_id, PASSBOOK_PAGE);
                    }}
                  >
                    Open passbook
                  </Link>
                  {/* Seen here, below the row's buttons; read out by the status line above. */}
                  {outcome && outcomeRow === athlete.athlete_id ? (
                    <div aria-hidden="true" className="mt-[var(--s4)]">
                      <OutcomeShown outcome={outcome} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <BackHome className="btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-md)]" />
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
