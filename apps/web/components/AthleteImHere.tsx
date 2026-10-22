'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay, gymDayIso } from '@/src/lib/gymTime';

/**
 * "I'M HERE" FOR TODAY'S CLASS, ON THE ATHLETE'S TODAY TAB (lane U2, audit
 * UX-A A-4; Jason 2026-10-17, "A: Rename + I'm here on Today (Recommended)").
 *
 * Attendance used to be four taps and a page change away (/schedule), while
 * two other buttons on Today said "check in" and recorded something else. This
 * card is the athlete's attendance control where they already are.
 *
 * THE WRITE PATH IS UNCHANGED: it sends exactly what /schedule's family
 * check-in sends -- POST /api/pilot/scheduler, action attendance_checkin,
 * status 'present' -- for each class today the athlete is registered to, and
 * the server keeps every rule it already holds (same gym day, registered, not
 * cancelled, a family write never changes a coach's mark). It shows what the
 * server answers, including "recorded: false" when the coach's register stood.
 *
 * A failed read says so; it never claims there is no class. Copy PROPOSED,
 * except "I'm here" (ruled).
 *
 * ONE READ (F-127). The Next Session line and this card both come from
 * GET /api/pilot/scheduler, which Today used to read twice. The workspace
 * holds the read (useTodaySchedulerRead) and hands it here; a press reloads
 * it, so the Next Session line follows too.
 */

interface ClassRow {
  class_id: string;
  title: string;
  start_at: string;
  status: 'open' | 'full' | 'cancelled';
}
interface RegistrationRow {
  registration_id: string;
  class_id: string;
  athlete_id: string;
  status: 'registered' | 'waitlisted' | 'cancelled';
}
interface AttendanceRow {
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
}

/** The scheduler read Today shares. `attendance` is null when the reply
 *  carried none: the Next Session line can still use it; this card cannot. */
export type TodaySchedulerRead =
  | { state: 'loading' }
  | { state: 'failed' }
  | {
    state: 'read';
    classes: ClassRow[];
    registrations: RegistrationRow[];
    attendance: AttendanceRow[] | null;
    readAt: number;
  };

/** GET /api/pilot/scheduler once while `enabled`, and again on reload(). */
export function useTodaySchedulerRead(enabled: boolean): {
  read: TodaySchedulerRead;
  reload: () => Promise<void>;
} {
  const [read, setRead] = useState<TodaySchedulerRead>({ state: 'loading' });
  // Only the newest read may land: a slow earlier reply must not put back an
  // "I'm here" the press after it already answered.
  const latest = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const mine = ++latest.current;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/scheduler`, { method: 'GET', credentials: 'include', signal });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        classes?: ClassRow[];
        registrations?: RegistrationRow[];
        attendance?: AttendanceRow[];
      };
      if (signal?.aborted || mine !== latest.current) return;
      if (!response.ok || !payload.ok || !Array.isArray(payload.classes) || !Array.isArray(payload.registrations)) {
        setRead({ state: 'failed' });
        return;
      }
      setRead({
        state: 'read',
        classes: payload.classes,
        registrations: payload.registrations,
        attendance: Array.isArray(payload.attendance) ? payload.attendance : null,
        readAt: Date.now(),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError') || mine !== latest.current) return;
      setRead({ state: 'failed' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    // The read sets state when it lands, as every workspace read does.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [enabled, load]);

  // No read without an athlete, whoever asks for one.
  const reload = useCallback(async () => {
    if (enabled) await load();
  }, [enabled, load]);
  return { read, reload };
}

/** Every class today the athlete is registered to, cancelled ones still to end included, earliest first.
 * (The scheduler read no longer sends a family a cancelled class that has ended, lane LC.) */
export function todaysClassesFor(
  athleteId: string,
  classes: readonly ClassRow[],
  registrations: readonly RegistrationRow[],
  nowMs: number,
): ClassRow[] {
  const today = gymDayIso(nowMs);
  // An unreadable clock is not today: two nulls must not match.
  if (!today) return [];
  const mine = new Set(
    registrations.filter((row) => row.athlete_id === athleteId && row.status === 'registered').map((row) => row.class_id),
  );
  return classes
    .filter((row) => mine.has(row.class_id) && gymDayIso(row.start_at) === today)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

const COULD_NOT_SAVE = 'That did not save. Try again, or tell a coach you are here.';
const REGISTER_TAKEN = 'Your coach has already taken the register for this class.';

export default function AthleteImHere({
  athleteId,
  schedule,
  onReload,
}: {
  readonly athleteId: string | null;
  readonly schedule: TodaySchedulerRead;
  readonly onReload: () => Promise<void>;
}) {
  const [sendingClassId, setSendingClassId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const sendingRef = useRef(false);

  const read = useMemo(() => {
    if (schedule.state !== 'read') return schedule;
    // A reply without attendance cannot say whether the athlete is marked.
    if (!athleteId || schedule.attendance === null) return { state: 'failed' as const };
    const marks = new Map(
      schedule.attendance
        .filter((row) => row.athlete_id === athleteId)
        .map((row) => [row.class_id, row.status] as const),
    );
    const classes = todaysClassesFor(athleteId, schedule.classes, schedule.registrations, schedule.readAt);
    return { state: 'read' as const, classes, marks };
  }, [athleteId, schedule]);

  const imHere = async (classId: string) => {
    if (!athleteId || sendingRef.current) return;
    sendingRef.current = true;
    setSendingClassId(classId);
    setAnswers((current) => ({ ...current, [classId]: '' }));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/scheduler`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'attendance_checkin', class_id: classId, athlete_id: athleteId, status: 'present' }),
      });
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; recorded?: boolean };
      if (!response.ok || !result.ok) {
        setAnswers((current) => ({ ...current, [classId]: result.error || COULD_NOT_SAVE }));
        return;
      }
      if (result.recorded === false) {
        setAnswers((current) => ({ ...current, [classId]: REGISTER_TAKEN }));
      }
      await onReload();
    } catch {
      setAnswers((current) => ({ ...current, [classId]: COULD_NOT_SAVE }));
    } finally {
      sendingRef.current = false;
      setSendingClassId(null);
    }
  };

  if (!athleteId) return null;

  return (
    <section aria-labelledby="athlete-im-here" className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
      <h2 id="athlete-im-here" className="t-label">Today&apos;s class</h2>
      {read.state === 'loading' ? (
        <p className="t-body mt-[var(--s3)]">Looking for today&apos;s class…</p>
      ) : read.state === 'failed' ? (
        <p className="t-body mt-[var(--s3)]">
          Today&apos;s class could not be read. <Link href="/schedule" className="underline">Open the schedule</Link>.
        </p>
      ) : read.classes.length === 0 ? (
        <p className="t-body mt-[var(--s3)]">
          No class for you today. <Link href="/schedule" className="underline">Open the schedule</Link>.
        </p>
      ) : (
        <ul className="mt-[var(--s3)] space-y-[var(--s4)]">
          {read.classes.map((klass) => {
            const mark = read.marks.get(klass.class_id);
            const time = formatGymTimeOfDay(klass.start_at);
            const answer = answers[klass.class_id];
            return (
              <li key={klass.class_id} className="space-y-[var(--s2)]">
                <p className="t-body">
                  {klass.title}
                  {time ? `, ${time}` : ''}
                </p>
                {klass.status === 'cancelled' ? (
                  <p className="t-body">This class is cancelled.</p>
                ) : mark === 'present' ? (
                  <p className="t-body" role="status">You are marked here. Your coach can see it.</p>
                ) : mark === 'absent' || mark === 'excused' ? (
                  <p className="t-body">Your coach marked you {mark} for this class.</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void imHere(klass.class_id)}
                    disabled={sendingClassId !== null}
                    className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                  >
                    {sendingClassId === klass.class_id ? 'Sending…' : "I'm here"}
                  </button>
                )}
                {answer ? <p role="alert" className="t-body">{answer}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
