'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useMilestoneCeremony } from './milestoneCeremony';
import { anniversaryMark } from './gymNotices';
import useGymSound from './useGymSound';
import WordsOnTheWall, { AnniversaryNote, BoxingNumberNote } from './WordsOnTheWall';

/**
 * THE TRAINING CARD — the punch card an athlete accumulates.
 *
 * The platform had no progression artefact at all: an athlete checked in, chose
 * an RPE, submitted, and left. Nothing accumulated, so there was nothing to come
 * back to. A gym's real engagement mechanic is physical and visible — a card
 * that fills up — and every primitive needed for it already existed in the
 * design system, unused for this.
 *
 * It is a RECORD, NOT A SCORE. Every stamp corresponds to one row from
 * /api/pilot/sessions/list, so the card cannot flatter anyone and cannot be
 * gamed. A booked-but-not-completed session shows as an empty box, because that
 * is the truth.
 *
 * NO STREAKS. This is the one design decision here worth defending. A streak
 * punishes illness and injury, and this platform runs a Layer 11 safety gate
 * that locks athletes out for medical reasons — so a streak would mean an
 * athlete watching their run die because a doctor protected them. That is a
 * direct incentive to under-report a concussion, in a contact sport, to
 * children. Cumulative counts never reset and never pressure.
 *
 * LAW 2 HOLDS. Effort is ink density, never hue. A red stamp for a hard session
 * would put a saturated pixel beside the safety ladder and make "trained hard"
 * read as "restricted".
 *
 * LAW 3 HOLDS. Every stamp carries its date and RPE as text in the
 * accessibility tree, so the card is not a wall of colour to a screen reader.
 *
 * THE MILESTONE CEREMONY. Crossing a milestone used to produce nothing: the
 * seal earned at 13 sessions was already in the DOM at 12, one opacity step
 * away, so the card counted but never marked. It now presses: the seal is
 * driven down onto the card under --e-stamp, whose whole physics is arriving
 * and stopping dead, a line of type says in words what was earned, and the
 * bell rings for anyone who has turned sound on. A stamp coming down on paper
 * and nothing else — no confetti, no bounce. This is a boxing gym.
 *
 * The ceremony fires on the CROSSING, once, never on the state. That detection
 * and its "first sighting seeds rather than celebrates" rule live in
 * milestoneCeremony.ts, apart from the rendering and tested on their own.
 */

/** The subset of PilotSession this card needs (src/server/pilot/contracts.ts). */
export interface TrainingSession {
  session_id: string;
  date: string;
  rpe: number;
  completed_flag: boolean;
}

/**
 * Milestones on the Fibonacci series, like everything else in the system
 * (Law 8). Five is reachable in a fortnight so the card rewards early; the gaps
 * then widen the way real progress does, rather than handing out a badge a week
 * forever.
 */
export const MILESTONES = [5, 13, 34, 89, 233] as const;

export interface TrainingCardProps {
  sessions: readonly TrainingSession[];
  /** Shown in the header. Optional so the card works before a name loads. */
  athleteName?: string;
  /** Cap the impressions drawn. The count always reflects every session. */
  maxStamps?: number;
  /**
   * Scopes the record of which seals have already been pressed. A gym tablet is
   * shared, and without it the first card opened on one would silence the next
   * athlete's first milestone. Optional so the card still renders before the
   * identity resolves — it just files the record under an unknown athlete.
   */
  athleteId?: string;
}

export default function TrainingCard({
  sessions,
  athleteName,
  maxStamps = 60,
  athleteId,
}: TrainingCardProps) {
  const { completed, ordered, shown, truncated } = useMemo(() => {
    const completedCount = sessions.filter((s) => s.completed_flag).length;
    // The API returns date desc; a card reads oldest-first, left to right.
    const asc = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
    const visible = asc.length > maxStamps ? asc.slice(asc.length - maxStamps) : asc;
    return {
      completed: completedCount,
      ordered: asc,
      shown: visible,
      truncated: asc.length - visible.length,
    };
  }, [sessions, maxStamps]);

  const nextMilestone = MILESTONES.find((m) => m > completed) ?? null;

  /* The bell. play() is safe to call unconditionally — it returns false and
     does nothing when sound is off, which is the default and stays the default
     on every floor kiosk. Rule 2 of the sound system is what makes that
     acceptable: the press and the line of type below carry the whole message
     with the volume down. */
  const { play } = useGymSound();
  const ring = useCallback(() => { play('bell'); }, [play]);

  /* Hooks run before the empty-card return below, so the order is stable.
     `active` is the ledger having been read at all: an empty card is "nobody
     has said yet", and seeding a record from it would make the first real read
     look like several milestones crossing at once. */
  const pressed = useMilestoneCeremony({
    count: completed,
    milestones: MILESTONES,
    athleteId,
    active: ordered.length > 0,
    onCross: ring,
  });

  /* A year at the gym, noticed quietly.
     Read in an effect rather than during render because it reads a CLOCK, and
     a value that differs between the server pass and the client pass is a
     hydration mismatch. It sets state only in the one week a year when there
     is a mark, so the extra render is not a per-visit cost.
     The rule itself is in gymNotices.ts — deliberately not in
     milestoneCeremony.ts, which must never learn to read a date. */
  const firstSessionDate = ordered.length > 0 ? ordered[0].date : null;
  const [anniversary, setAnniversary] = useState<string | null>(null);
  useEffect(() => {
    if (!firstSessionDate) {
      return;
    }
    const mark = anniversaryMark(firstSessionDate, new Date());
    if (mark) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnniversary(mark.line);
    }
  }, [firstSessionDate]);

  if (ordered.length === 0) {
    return (
      <div className="pap pap--card age-1 lift-1 tcard">
        <div className="empty" style={{ padding: 'var(--s7) var(--s5)' }}>
          <div className="empty-glyph" aria-hidden="true">🥊</div>
          <div className="empty-title">No sessions on the card yet</div>
          <div className="empty-msg">
            Check in at the floor kiosk and the first stamp lands here. The card keeps every
            session you log — it never resets.
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="pap pap--card age-1 lift-1 tcard" aria-label="Training card">
      <header className="tcard-hd">
        <div>
          <h3 className="tcard-title">Training Card</h3>
          <div className="tcard-sub">
            {athleteName ? `${athleteName} · ` : ''}
            since {formatDate(ordered[0].date)}
          </div>
        </div>
        <div className="tcard-count">
          <b>{completed}</b>
          <span>{completed === 1 ? 'session logged' : 'sessions logged'}</span>
        </div>
      </header>

      {truncated > 0 && (
        <p className="tcard-sub" style={{ marginBottom: 'var(--s4)' }}>
          Showing the most recent {shown.length}. {truncated} earlier{' '}
          {truncated === 1 ? 'session is' : 'sessions are'} still counted above.
        </p>
      )}

      <div className="tcard-grid" role="list">
        {shown.map((s) => {
          const done = s.completed_flag;
          // RPE 1-10 -> 0-1 ink. Clamped, because a bad row must not blow out
          // the visual scale of the whole card.
          const ink = Math.min(Math.max((s.rpe || 0) / 10, 0), 1);
          const label = done
            ? `Session ${formatDate(s.date)}, effort ${s.rpe} of 10`
            : `Session ${formatDate(s.date)}, booked, not completed`;
          return (
            <div
              key={s.session_id}
              role="listitem"
              className={`tcard-stamp ${done ? 'tcard-stamp--done' : 'tcard-stamp--open'}`}
              style={done ? ({ ['--ink' as string]: String(ink) }) : undefined}
              title={label}
            >
              <span className="sr-only">{label}</span>
              <span aria-hidden="true">{done ? s.rpe : '·'}</span>
            </div>
          );
        })}
      </div>

      {/* The ceremony, in words. This is the channel that carries the whole
          message on its own: it is here for the athlete whose volume is down,
          whose browser blocked audio, who asked for reduced motion, or who is
          reading the card with a screen reader — role="status" announces it.
          The bell and the press are confirmation of this line, never a
          substitute for it. */}
      {pressed !== null && (
        <p className="tcard-earned" role="status">
          <b>{pressed} sessions</b>
          <span>Sealed. It never comes off the card.</span>
        </p>
      )}

      {/* Words on the wall, and only at a moment.
          The source ships EMPTY on purpose — the lines belong to this gym's
          coaches and nobody else can write them, so this renders nothing at
          all until the owner adds them (gymSayings.ts says how). It is placed
          beside the seal rather than at the top of the card because a sign
          that is always there is wallpaper inside a week. */}
      {pressed !== null && <WordsOnTheWall context="at-a-milestone" seed={pressed} />}

      {/* The two quiet asides. Both are one dry line and neither can observe
          an absence: the first is handed a cumulative count, the second a pair
          of dates it cannot turn into attendance. */}
      <BoxingNumberNote count={completed} />
      <AnniversaryNote line={anniversary} />

      <div className="tcard-seals">
        {MILESTONES.map((m) => {
          const earned = completed >= m;
          return (
            <div
              key={m}
              className={
                `tcard-seal-slot${earned ? '' : ' tcard-seal-slot--unearned'}`
                + (pressed === m ? ' tcard-seal-slot--pressed' : '')
              }
            >
              <Seal count={m} earned={earned} />
              <span className="tcard-seal-lbl">
                {m}
                {earned ? '' : ' · to go'}
              </span>
            </div>
          );
        })}
        {nextMilestone && (
          <p className="tcard-sub" style={{ marginLeft: 'auto', textAlign: 'right' }}>
            {nextMilestone - completed} more to {nextMilestone}
          </p>
        )}
      </div>

      <div className="tcard-legend">
        <span><i className="is-done" aria-hidden="true" />Logged — the number is effort, 1&ndash;10</span>
        <span><i className="is-open" aria-hidden="true" />Booked, not completed</span>
      </div>
    </section>
  );
}

/** The roundel, zero-asset — curved text via textPath, same as .seal.
 *
 * The seal's ink is the paper-card ink ppbf.css uses for .tcard-title. The
 * design sheet now provides a token for it, so the --hide-900 stand-in is
 * gone: this is --card-ink itself. */
const SEAL_INK = 'var(--card-ink)';

function Seal({ count, earned }: { count: number; earned: boolean }) {
  const id = `tcard-seal-${count}`;
  return (
    <svg
      width="52"
      height="52"
      viewBox="0 0 100 100"
      role="img"
      aria-label={earned ? `${count} session milestone, earned` : `${count} session milestone, not yet earned`}
    >
      <defs>
        <path id={id} d="M 50,50 m -34,0 a 34,34 0 1,1 68,0 a 34,34 0 1,1 -68,0" />
      </defs>
      <circle cx="50" cy="50" r="46" fill="none" stroke={SEAL_INK} strokeWidth="2.5" opacity=".8" />
      <circle cx="50" cy="50" r="30" fill="none" stroke={SEAL_INK} strokeWidth="1.5" opacity=".55" />
      <text fontSize="15" fontWeight="700" fill={SEAL_INK} letterSpacing="1">
        <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
          PPBF · LOGGED
        </textPath>
      </text>
      <text
        x="50"
        y="58"
        textAnchor="middle"
        fontSize="26"
        fontWeight="700"
        fill={SEAL_INK}
        fontFamily="var(--font-display)"
      >
        {count}
      </text>
    </svg>
  );
}

/** Dates arrive as ISO or YYYY-MM-DD; render without inventing a timezone. */
function formatDate(raw: string): string {
  const ymd = raw.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])} ${m[1]}`;
}
