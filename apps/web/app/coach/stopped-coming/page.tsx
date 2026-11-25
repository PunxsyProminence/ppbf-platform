'use client';

import { useEffect, useState } from 'react';
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

interface StoppedComingAthlete {
  athlete_id: string;
  full_name: string;
  last_came_day: string;
  days_since_came: number;
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

/** The answer has the shape the route sends, or the page says it could not read it. */
function isStoppedComingList(value: unknown): value is StoppedComingList {
  const list = value as Partial<StoppedComingList> | null;
  return typeof list === 'object' && list !== null
    && typeof list.gap_days === 'number' && typeof list.is_default === 'boolean'
    && typeof list.today === 'string' && Array.isArray(list.athletes);
}

const READ_FAILED = 'Could not read who has stopped coming, so no one is shown. This is not an empty list.';

export default function CoachStoppedComingPage() {
  const [list, setList] = useState<StoppedComingList | null>(null);
  const [refused, setRefused] = useState<'signed_out' | 'wrong_door' | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/stopped-coming`, {
          credentials: 'include',
          signal: controller.signal,
        });
        // A refusal is a stamp, not an error toast (Law 7).
        if (response.status === 401 || response.status === 403) {
          if (controller.signal.aborted) return;
          setRefused(response.status === 401 ? 'signed_out' : 'wrong_door');
          return;
        }
        if (!response.ok) throw new Error('read failed');
        const payload: unknown = await response.json();
        if (!isStoppedComingList(payload)) throw new Error('unexpected answer');
        if (controller.signal.aborted) return;
        setList(payload);
      } catch {
        // An aborted load is the page unmounting, not a failure to report. Any other
        // failure (network, a bad status, an answer that is not the list) shows the
        // same fixed sentence, never an empty list.
        if (controller.signal.aborted) return;
        setFailed(true);
      }
    })();
    return () => controller.abort();
  }, []);

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
