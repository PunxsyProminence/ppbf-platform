'use client';

import React from 'react';
import type {
  AttendanceGlance,
  EscalationGlance,
  GlanceBadge,
  ReadinessGlance,
} from '@/coach/coachGlance';

/**
 * THE ROOM LAYOUT.
 *
 * The same facts as the board, as the objects a gym already has: a round wall
 * clock, a peg board with name tags hanging in columns, clipboards on nails.
 * Nothing here is decoration for its own sake -- each object was chosen because
 * the physical thing already answers the question the coach is asking, and
 * because a shape is readable across a training floor in a way a row of text is
 * not.
 *
 * IT COMPUTES NOTHING. Every number arrives derived, from the same glance model
 * the board reads. That is the entire architectural point: the repository
 * already contains two instruments over one escalation queue that disagree by
 * construction, and a second layout is the fastest way to make nine more. This
 * file may choose a SHAPE. It may not choose a MEANING.
 *
 * SO THE HARD PART HERE IS THE UNHAPPY STATES, not the pretty ones. A peg board
 * with four empty columns reads as an empty gym, not as a register nobody could
 * read. A clock face showing 0:00 reads as a session that has not started, not
 * as a session nobody could check. Every object below therefore has an explicit
 * rendering for "we could not look", and it never resembles the rendering for
 * "we looked and there is nothing".
 */

export interface CoachRoomLayoutProps {
  /** Whether the live-run read succeeded, failed, or is still going. */
  readonly liveRunState: 'loading' | 'loaded' | 'unavailable';
  /** A run exists. Distinct from the read having succeeded. */
  readonly hasRun: boolean;
  /** Already through formatElapsed, so this layout cannot round it differently
   *  from the board's LED. Null when there is no run to time. */
  readonly elapsedLabel: string | null;
  readonly paused: boolean;
  readonly attendance: AttendanceGlance;
  readonly rosterLoading: boolean;
  readonly escalations: EscalationGlance;
  readonly escalationsLoading: boolean;
  readonly escalationsError: string;
  readonly readiness: ReadinessGlance;
  /** Whether the readiness feed answered. "No signal" is true both when it
   *  answered with nothing and when it did not answer, and the room says which
   *  -- one is somebody to chase, the other is a read to retry. */
  readonly readinessReadState: 'loading' | 'loaded' | 'unavailable';
  readonly shadowBadge: GlanceBadge;
  /** Opens the register behind the peg board -- the first glance -> open ->
   *  work door in the room. */
  readonly onOpenRegister: () => void;
}

/** One hanging tag on the peg board. */
function Peg({ label, count, tone }: {
  readonly label: string;
  readonly count: number;
  readonly tone: string;
}) {
  return (
    <div className={`rm-peg rm-peg--${tone}`}>
      <span className="rm-peg-hook" aria-hidden="true" />
      <b className="rm-peg-n">{count}</b>
      <span className="rm-peg-l">{label}</span>
    </div>
  );
}

/** A clipboard on a nail. `detail` is optional because not every clipboard has
 *  a composition to show, and an empty line would read as a missing one. */
function Clipboard({ title, value, detail, state }: {
  readonly title: string;
  readonly value: string;
  readonly detail?: React.ReactNode;
  readonly state?: 'ok' | 'quiet' | 'unread';
}) {
  return (
    <div className={`rm-clip rm-clip--${state ?? 'ok'}`}>
      <span className="rm-clip-nail" aria-hidden="true" />
      <span className="rm-clip-clamp" aria-hidden="true" />
      <p className="rm-clip-t">{title}</p>
      <b className="rm-clip-v">{value}</b>
      {detail ? <div className="rm-clip-d">{detail}</div> : null}
    </div>
  );
}

export default function CoachRoomLayout({
  liveRunState,
  hasRun,
  elapsedLabel,
  paused,
  attendance,
  rosterLoading,
  escalations,
  escalationsLoading,
  escalationsError,
  readiness,
  readinessReadState,
  shadowBadge,
  onOpenRegister,
}: CoachRoomLayoutProps) {
  return (
    <div className="rm">
      {/* THE CLOCK. A round face because that is what is screwed to the wall of
          a boxing gym, and because a coach glancing up from the floor reads a
          dial before they read a word.

          Four states, and the three that are not "a session is running" do not
          borrow the fourth's typography. UNKNOWN must never render as "no
          session": /coach/session-scripts disables its start control on exactly
          that signal so a coach cannot open a second delivery over a live one,
          and a clock reading 0:00 would be an invitation to do it. */}
      <section className="rm-clockwrap" aria-label="Session time">
        <div className={`rm-clock${paused && hasRun ? ' rm-clock--paused' : ''}`}>
          <div className="rm-clock-ticks" aria-hidden="true" />
          {liveRunState === 'loading' && (
            <>
              <b className="rm-clock-n rm-clock-n--quiet">--:--</b>
              <span className="rm-clock-s">Checking session</span>
            </>
          )}
          {liveRunState === 'unavailable' && (
            <>
              <b className="rm-clock-n rm-clock-n--quiet">?</b>
              <span className="rm-clock-s rm-clock-s--warn">Could not be checked</span>
            </>
          )}
          {liveRunState === 'loaded' && !hasRun && (
            <>
              <b className="rm-clock-n rm-clock-n--quiet">--:--</b>
              <span className="rm-clock-s">No session in progress</span>
            </>
          )}
          {liveRunState === 'loaded' && hasRun && (
            <>
              <b className="rm-clock-n">{elapsedLabel}</b>
              <span className="rm-clock-s">{paused ? 'Paused' : 'Server elapsed'}</span>
            </>
          )}
        </div>
      </section>

      {/* THE PEG BOARD. Four columns of hanging tags, which is how a gym signs
          people in, and which makes UNMARKED a physical thing occupying its own
          hook rather than a number that rounds away.

          The unreadable case does NOT render four empty columns. That is the
          whole reason attendanceGlance carries a `readable` flag instead of
          leaving a renderer to infer it from zeroes: empty columns read as an
          empty gym, in the same wood the full ones use. */}
      {/* Named for what it IS -- the glance -- so it cannot be confused with
          the register it opens. Two regions called "attendance register" is a
          coin toss for anyone navigating by landmark. */}
      <section className="rm-pegs" aria-label="Attendance at a glance">
        <p className="rm-h">Attendance</p>
        {rosterLoading ? (
          <p className="rm-state">Reading the register…</p>
        ) : !attendance.readable ? (
          <div className="rm-unread">
            <p className="rm-unread-h">Register unavailable</p>
            <p className="rm-state">
              Nobody could be looked up. Do not read this as an empty gym.
            </p>
          </div>
        ) : (
          <>
            {/* THE PEG BOARD IS THE DOOR. The whole board is one control rather
                than four, because the question a coach is asking when they
                reach for it is "who is that", not "who is that, in the absent
                column" -- and four separate doors into one register would be
                four ways to land in the same place. */}
            <button
              type="button"
              className="rm-pegrow rm-pegrow--door"
              onClick={onOpenRegister}
              aria-label="Open today's attendance register"
            >
              <Peg label="Present" count={attendance.present} tone="in" />
              <Peg label="Absent" count={attendance.absent} tone="out" />
              <Peg label="Excused" count={attendance.excused} tone="ex" />
              <Peg label="Unmarked" count={attendance.unmarked} tone="un" />
            </button>
            {attendance.notCovered > 0 && (
              <p className="rm-state">
                {attendance.notCovered} not on your register — nobody asked about them.
              </p>
            )}
          </>
        )}
      </section>

      {/* THE CLIPBOARDS. Three nails, three jobs. */}
      <section className="rm-clips" aria-label="Attention">
        {escalationsLoading ? (
          <Clipboard title="Need attention" value="Checking" state="quiet" />
        ) : escalationsError ? (
          <Clipboard
            title="Need attention"
            value="Unread"
            state="unread"
            detail="Escalations may exist that are not shown. Not an all-clear."
          />
        ) : (
          <Clipboard
            title="Need attention"
            value={String(escalations.open)}
            state={escalations.open > 0 ? 'ok' : 'quiet'}
            detail={escalations.open > 0 ? (
              <ul className="rm-sev">
                {escalations.critical > 0 && <li><b>{escalations.critical}</b> critical</li>}
                {escalations.high > 0 && <li><b>{escalations.high}</b> high</li>}
                {escalations.moderate > 0 && <li><b>{escalations.moderate}</b> moderate</li>}
                {escalations.low > 0 && <li><b>{escalations.low}</b> low</li>}
              </ul>
            ) : 'Nothing open'}
          />
        )}

        {/* READINESS AS AN ATTENTION COUNT, never a dial.
            Bands are gated on provenance upstream: a reading from an established
            method may become GREEN/YELLOW/RED, a staff judgement may not, and
            today nothing satisfies that gate. So what this clipboard reports is
            how much judgement is sitting here uncounted -- which is a real
            number and a real prompt -- and it says "not counted" out loud rather
            than letting a coach read it as a measurement. */}
        {readinessReadState === 'loading' ? (
          <Clipboard title="Context items" value="Checking" state="quiet" />
        ) : (
          <Clipboard
            title="Context items"
            value={readiness.trackingAvailable ? String(readiness.unvalidated) : 'No signal'}
            state={readiness.trackingAvailable ? (readiness.unvalidated > 0 ? 'ok' : 'quiet') : 'unread'}
            detail={readiness.trackingAvailable
              ? (readiness.unvalidated > 0
                ? 'Staff judgement recorded, not counted as a measurement'
                : 'Nothing recorded today')
              /* Which kind of nothing. Both are "No signal" -- that collapse is
                 a recorded ruling -- but one is somebody to chase and the other
                 is a read to retry, and a coach cannot act on the first without
                 being told which they have. */
              : readinessReadState === 'unavailable'
                ? 'The feed could not be read — not a statement that nobody checked in'
                : 'No fresh check-ins — do not read this as "zero flags"'}
          />
        )}

        <Clipboard
          title="Shadow queue"
          value={shadowBadge.label}
          state={shadowBadge.tone === 'restricted' ? 'unread' : 'ok'}
        />
      </section>
    </div>
  );
}
