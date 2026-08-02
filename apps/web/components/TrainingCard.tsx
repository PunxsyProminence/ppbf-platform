'use client';

import { useMemo } from 'react';

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
}

export default function TrainingCard({
  sessions,
  athleteName,
  maxStamps = 60,
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

      <div className="tcard-seals">
        {MILESTONES.map((m) => {
          const earned = completed >= m;
          return (
            <div
              key={m}
              className={`tcard-seal-slot${earned ? '' : ' tcard-seal-slot--unearned'}`}
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

/** The roundel, zero-asset — curved text via textPath, same as .seal. */
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
      <circle cx="50" cy="50" r="46" fill="none" stroke="#241C11" strokeWidth="2.5" opacity=".8" />
      <circle cx="50" cy="50" r="30" fill="none" stroke="#241C11" strokeWidth="1.5" opacity=".55" />
      <text fontSize="15" fontWeight="700" fill="#241C11" letterSpacing="1">
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
        fill="#241C11"
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
