'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import RefusalStamp from '@/components/RefusalStamp';
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
// out, or neither). Who and when only (Overwatch W4-6 Q4 A): a row's button
// sends PUT { athlete_id, reached_out } and pressing it again takes the mark
// back. Every answer is followed by a fresh read of the list, so a row shows
// what the server holds (another coach's mark, after 'already_marked'), never
// a state set here. A marker the server cannot name is not given a name.

interface ReachedOut {
  /** The marker's staff name at this gym; null when the server cannot name them. */
  by_name: string | null;
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

/** A mark as the route sends it, or null. A row without one is not read as unmarked. */
function isReachedOut(value: unknown): value is ReachedOut | null {
  if (value === null) return true;
  const mark = value as Partial<ReachedOut> | undefined;
  return typeof mark === 'object' && typeof mark.on_day === 'string'
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

/** "Reached out by Sam K. on Mar 9, 2026."; with no name to show, "Reached out on Mar 9, 2026.", never a stand-in. */
function reachedOutWords(mark: ReachedOut): string {
  const day = formatCalendarDay(mark.on_day);
  const name = mark.by_name?.trim();
  return name ? `Reached out by ${name} on ${day}.` : `Reached out on ${day}.`;
}

// The route's own refusals: when one of these comes back, the server said no and wrote nothing.
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

/** A refusal's words, by the route's code (stoppedComing.ts, reachedOutMarks.ts). RefusalStamp adds the full stop. */
function refusalDetail(code: unknown, name: string): string {
  if (code === 'NOT_ON_STOPPED_COMING_LIST') {
    return `${name} is no longer on the stopped-coming list, so nothing was marked; the list has been read again`;
  }
  return `the server refused the change for ${name}, so nothing was saved; the list has been read again`;
}

/** No answer, or one that is not a refusal: whether it saved is not known. */
function notKnownWords(name: string, reachedOut: boolean): string {
  return reachedOut
    ? `It is not known whether ${name} was marked as reached out; the list has been read again.`
    : `It is not known whether the mark on ${name} was taken back; the list has been read again.`;
}

type MarkProblem = { kind: 'refused'; detail: string } | { kind: 'not_known'; text: string };

const READ_FAILED = 'Could not read who has stopped coming, so no one is shown. This is not an empty list.';

/**
 * A row's mark: who reached out and when, and the button that marks or takes it back. The words
 * change with aria-pressed, so colour is not the only channel (Law 3); as SessionRunPresence's
 * "Here" / "Mark here", the pressed button is the brass .btn and the unpressed one the ghost.
 */
function ReachedOutMark({ athlete, busy, onPress }: {
  athlete: StoppedComingAthlete;
  busy: string | null;
  onPress: (athlete: StoppedComingAthlete, reachedOut: boolean) => Promise<void>;
}) {
  const marked = athlete.reached_out !== null;
  const words = busy === athlete.athlete_id ? 'Saving…' : marked ? 'Reached out' : 'Mark reached out';
  return (
    <>
      {athlete.reached_out ? (
        <p className="t-body mt-[var(--s4)] text-[length:var(--t-md)]">{reachedOutWords(athlete.reached_out)}</p>
      ) : null}
      <button
        type="button"
        className={`${marked ? 'btn' : 'btn btn--ghost'} mt-[var(--s4)] mr-[var(--s3)] min-h-[var(--tap)] text-[length:var(--t-md)]`}
        aria-pressed={marked}
        aria-busy={busy === athlete.athlete_id}
        aria-label={`${words}: ${athlete.full_name}`}
        disabled={busy !== null}
        onClick={() => void onPress(athlete, !marked)}
      >
        {words}
      </button>
    </>
  );
}

export default function CoachStoppedComingPage() {
  const [list, setList] = useState<StoppedComingList | null>(null);
  const [refused, setRefused] = useState<'signed_out' | 'wrong_door' | null>(null);
  const [failed, setFailed] = useState(false);
  // The athlete whose mark is on its way; every row's button waits for it (no second PUT).
  const [busy, setBusy] = useState<string | null>(null);
  const [markProblem, setMarkProblem] = useState<MarkProblem | null>(null);

  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/stopped-coming`, {
        credentials: 'include',
        signal,
      });
      // A refusal is a stamp, not an error toast (Law 7).
      if (response.status === 401 || response.status === 403) {
        if (signal?.aborted) return;
        setRefused(response.status === 401 ? 'signed_out' : 'wrong_door');
        return;
      }
      if (!response.ok) throw new Error('read failed');
      const payload: unknown = await response.json();
      if (!isStoppedComingList(payload)) throw new Error('unexpected answer');
      if (signal?.aborted) return;
      setList(payload);
    } catch {
      // An aborted load is the page unmounting, not a failure to report. Any other
      // failure (network, a bad status, an answer that is not the list) shows the
      // same fixed sentence, never an empty list.
      if (signal?.aborted) return;
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // read() sets state only after its fetch resolves (as SessionRunPresence's first read).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  const mark = async (athlete: StoppedComingAthlete, reachedOut: boolean) => {
    if (busy) return;
    setBusy(athlete.athlete_id);
    setMarkProblem(null);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/stopped-coming`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ athlete_id: athlete.athlete_id, reached_out: reachedOut }),
        });
      } catch {
        setMarkProblem({ kind: 'not_known', text: notKnownWords(athlete.full_name, reachedOut) });
        await read();
        return;
      }
      // Signed out, or not a coach or admin of this gym: the page's own stamp, as a refused read.
      if (response.status === 401 || response.status === 403) {
        setRefused(response.status === 401 ? 'signed_out' : 'wrong_door');
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { code?: unknown } | null;
        setMarkProblem(REFUSAL_STATUSES.has(response.status)
          ? { kind: 'refused', detail: refusalDetail(payload?.code, athlete.full_name) }
          : { kind: 'not_known', text: notKnownWords(athlete.full_name, reachedOut) });
      }
      // Any outcome word or refusal: the rows show what the server now holds.
      await read();
    } finally {
      setBusy(null);
    }
  };

  const gap = list ? gapWords(list.gap_days) : null;

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* One room, applied here: this page owns its <main>. */}
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Stopped Coming</h1>
            <ClusterNav cluster="who-needs-me" />
            <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-300)]">
              Athletes on the roster who have come before but have not come for{' '}
              {gap ? <strong>{gap}</strong> : 'the gym’s number of days'} or more, longest gone first. It leaves
              out athletes marked as left the gym and athletes whose program memberships have all lapsed or
              ended. Coming means a present day on a class register, or a &ldquo;here&rdquo; tap the register
              does not hold: open gym, or a class where the tap made no register mark, or that was cancelled.
            </p>
            {list ? (
              <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-400)]">
                {list.is_default
                  ? `The gym has not set its own number of days, so the default, ${gap}, applies.`
                  : `${gap} is the gym’s own setting.`}{' '}
                As of {formatCalendarDay(list.today)}.
              </p>
            ) : null}
          </header>

          {/* What a press could not do stays until the next press (Law 7: a refusal is a stamp). */}
          {markProblem?.kind === 'refused' ? (
            <RefusalStamp
              kind="cannot_be_done"
              detail={markProblem.detail}
              className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]"
            />
          ) : markProblem?.kind === 'not_known' ? (
            <div className="alert alert--warning mb-[var(--s5)]" role="alert">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{markProblem.text}</p>
              </div>
            </div>
          ) : null}

          {refused ? (
            <RefusalStamp
              kind={refused}
              detail={refused === 'signed_out'
                ? 'sign in again to read who has stopped coming'
                : 'who has stopped coming is read by a coach or the gym admin of this gym'}
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
                  <ReachedOutMark athlete={athlete} busy={busy} onPress={mark} />
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
