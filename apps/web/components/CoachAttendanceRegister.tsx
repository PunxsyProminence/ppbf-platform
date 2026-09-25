'use client';

import React from 'react';
import Link from 'next/link';
import {
  attendanceMarkLabel,
  attendanceMarkTitle,
  type GlanceAttendanceMark,
} from '@/coach/coachGlance';

/**
 * THE OPEN REGISTER.
 *
 * What the peg board opens into: one athlete a line, the mark beside the name.
 * The first glance -> open -> work journey in the coach room.
 *
 * WHY IT IS A DIFFERENT OBJECT FROM THE PEG BOARD. A larger peg board would
 * tell a coach they had zoomed in. A register tells them they have moved from
 * "how is the room" to "who exactly". The peg board answers the first question
 * and stays the glance instrument; this answers the second.
 *
 * WHY IT IS READ-ONLY, and it is NOT because attendance cannot be written.
 * It can -- app/api/pilot/scheduler/route.ts carries attendance_checkin and
 * bulk_attendance_checkin, and a coach marks a class register on the Schedule
 * page today. The reason is a GRAIN MISMATCH. What this screen shows is
 * athlete-DAY attendance, reconciled across sources; what the write takes is
 * athlete-CLASS attendance. An athlete can sit in two classes in a day, and an
 * activity_log row can outrank the class marks entirely. A "Present" control on
 * a day row would not know which class record it was editing, so it would have
 * to guess -- and a guess written into a safeguarding record about a child is
 * not a convenience.
 *
 * So there is a door instead of a control. It goes to the place the mark is
 * actually made, rather than telling the coach the screen cannot do it.
 *
 * IT COMPUTES NOTHING. The rows arrive already derived, and the words for each
 * mark come from the glance model, so this surface and the peg board above it
 * cannot describe the same register differently.
 */

export interface RegisterAthlete {
  readonly id: string;
  readonly name: string;
  readonly attendance: GlanceAttendanceMark;
}

export interface CoachAttendanceRegisterProps {
  readonly athletes: ReadonlyArray<RegisterAthlete>;
  readonly loading: boolean;
  /** The register read failed. Distinct from "read fine, nobody is marked". */
  readonly readable: boolean;
  readonly onClose: () => void;
}

/** The order a coach reads a register in: the ones needing a decision first.
 *  Unmarked leads because it is the actionable state -- somebody has to be
 *  looked at. Not-covered sinks, because nobody asked and nobody can act. */
const MARK_ORDER: Record<GlanceAttendanceMark, number> = {
  Unknown: 0,
  Present: 1,
  Absent: 2,
  Excused: 3,
  Unavailable: 4,
  NotCovered: 5,
};

export default function CoachAttendanceRegister({
  athletes,
  loading,
  readable,
  onClose,
}: CoachAttendanceRegisterProps) {
  const rows = [...athletes].sort((a, b) => {
    const byMark = MARK_ORDER[a.attendance] - MARK_ORDER[b.attendance];
    return byMark !== 0 ? byMark : a.name.localeCompare(b.name);
  });

  return (
    <section className="rg" aria-label="Today's attendance register">
      <div className="rg-top">
        <div>
          <p className="rg-eyebrow">Today&rsquo;s record</p>
          <h2 className="rg-h">Attendance register</h2>
        </div>
        <button type="button" className="rg-close" onClick={onClose}>
          Close
        </button>
      </div>

      {loading ? (
        <p className="rg-state">Reading the register&hellip;</p>
      ) : !readable ? (
        /* The failed read gets a card, not an empty list. A register rendered
           as zero rows reads as a gym nobody came to. */
        <div className="rg-unread">
          <p className="rg-unread-h">Register unavailable</p>
          <p className="rg-state">
            Nobody could be looked up. Do not read this as an empty gym.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <p className="rg-state">Nobody is assigned to you yet.</p>
      ) : (
        <ul className="rg-rows">
          {rows.map((athlete) => (
            <li key={athlete.id} className="rg-row">
              <span className="rg-name">{athlete.name}</span>
              <span
                className={`rg-mark rg-mark--${athlete.attendance.toLowerCase()}`}
                title={attendanceMarkTitle(athlete.attendance)}
              >
                {attendanceMarkLabel(athlete.attendance)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* THE DOOR. An operational cue, not an explanation of the architecture.
          "Marks arrive from class registers and the activity log, not from this
          screen" is accurate and would be wallpaper inside a week. This says
          the same thing by pointing at the place the work happens. */}
      <Link href="/schedule" className="rg-door">
        Mark class attendance in Schedule &rarr;
      </Link>
    </section>
  );
}
