'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAchievementCeremony } from './achievementCeremony';
import useGymSound from './useGymSound';
import { apiBase } from '@/lib/apiBase';
import {
  DEFAULT_PROGRAM,
  PROGRAMS,
  earnedMilestoneKeys,
  isProgram,
  milestoneByKey,
  pathProgress,
  recognitionPhrase,
  type Milestone,
  type Program,
  type TrackProgress,
} from '@/src/shared/achievementPaths';

/**
 * WHAT AN ATHLETE HAS EARNED HERE — for every athlete, not only the ones who fight.
 *
 * This is the surface the gym's other three programs never had. The training
 * card counts sessions and the progression tables hold gaps and drills; between
 * them there was nothing that could tell a fitness-only member, or a kid who
 * comes for the mentorship, that anything they came for was being measured.
 *
 * FOUR THINGS LAND HERE, AND THEY ARE NOT THE SAME KIND OF THING:
 *
 *   THE WALL      what a coach said. First, above everything else on this
 *                 panel, because it is the only thing here that a person said
 *                 to them rather than a thing the system worked out.
 *   THE PATH      conditioning, craft, the room, showing up. Complete for every
 *                 program: what a member's program does not include is ABSENT,
 *                 never greyed out. See achievementPaths.ts rule 3.
 *   MENTORSHIP    who they look after and who looks after them.
 *   THE CEREMONY  reused, not reinvented: seal down under --e-stamp, a line of
 *                 type, and the bell for anyone who turned sound on.
 *
 * NO STREAK, NO RANK, NO GAP. Every number on this panel is cumulative or a
 * plain total of things earned. Nothing compares this athlete to another
 * athlete, and there is no per-athlete total anywhere on the panel that could
 * be lined up against somebody else's, because nothing here is ever rendered
 * beside another athlete's copy of it.
 *
 * `audience` IS FRAMING, NEVER A DIFFERENT SET OF FACTS. 'family' shows the
 * same achievements in the words a parent came to hear. It also silences the
 * ceremony — the bell belongs to the person who earned the thing, and ringing
 * it on a parent's phone for something that happened on Tuesday is a
 * notification, not a moment.
 */

export type AchievementAudience = 'athlete' | 'family';

export interface RecognitionItem {
  recognition_id: string;
  coach_display_name: string;
  kind: string;
  note: string;
  created_at: string;
}

export interface MilestoneAwardItem {
  milestone_key: string;
  awarded_by_role: string;
  note: string;
  awarded_at: string;
}

export interface MentorshipItem {
  mentorship_id: string;
  mentor_athlete_id: string;
  mentor_name: string;
  mentee_athlete_id: string;
  mentee_name: string;
  started_on: string;
  ended_on: string | null;
}

export interface AthleteAchievementsProps {
  /** Null before the session resolves; the panel says so rather than showing an empty path. */
  athleteId: string | null;
  athleteName?: string;
  audience?: AchievementAudience;
  /**
   * Lets the athlete say what they came for. Off on the family surface: a
   * parent choosing the program for a fifteen-year-old is the wrong hand on it.
   */
  allowProgramChange?: boolean;
}

type LoadState = 'loading' | 'ready' | 'unavailable';

export default function AthleteAchievements({
  athleteId,
  athleteName,
  audience = 'athlete',
  allowProgramChange = true,
}: AthleteAchievementsProps) {
  const [recognitions, setRecognitions] = useState<RecognitionItem[]>([]);
  const [awards, setAwards] = useState<MilestoneAwardItem[]>([]);
  const [mentorships, setMentorships] = useState<MentorshipItem[]>([]);
  const [program, setProgram] = useState<Program>(DEFAULT_PROGRAM);
  const [completedSessions, setCompletedSessions] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [savingProgram, setSavingProgram] = useState(false);

  const isFamily = audience === 'family';

  const load = useCallback(async () => {
    if (!athleteId) return;

    try {
      const [milestoneResponse, recognitionResponse, mentorshipResponse] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/achievements/recognition?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/achievements/mentorships?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include' }),
      ]);

      if (!milestoneResponse.ok) {
        throw new Error('unavailable');
      }

      const milestoneBody = (await milestoneResponse.json()) as {
        program?: string;
        completed_sessions?: number;
        items?: MilestoneAwardItem[];
      };

      setProgram(isProgram(milestoneBody.program) ? milestoneBody.program : DEFAULT_PROGRAM);
      setCompletedSessions(Number(milestoneBody.completed_sessions) || 0);
      setAwards(milestoneBody.items ?? []);

      /* Recognition and mentorship failing is not the panel failing. The path
         still stands on its own, and an error banner over somebody's wall of
         compliments is louder than the thing it is apologising for. */
      if (recognitionResponse.ok) {
        const body = (await recognitionResponse.json()) as { items?: RecognitionItem[] };
        setRecognitions(body.items ?? []);
      }
      if (mentorshipResponse.ok) {
        const body = (await mentorshipResponse.json()) as { items?: MentorshipItem[] };
        setMentorships(body.items ?? []);
      }

      setState('ready');
    } catch {
      setState('unavailable');
    }
  }, [athleteId]);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs:
    // a synchronous setState inside an effect cascades a render before the
    // request has even left. Same seam the coach drill library uses.
    void (async () => {
      await load();
    })();
  }, [load]);

  const earned = useMemo(
    () => earnedMilestoneKeys({
      completedSessions,
      awardedKeys: awards.map((award) => award.milestone_key),
    }),
    [completedSessions, awards],
  );

  const tracks = useMemo(
    () => pathProgress(program, {
      completedSessions,
      awardedKeys: awards.map((award) => award.milestone_key),
    }),
    [program, completedSessions, awards],
  );

  /* The gym's own bell. play() is safe to call unconditionally: it returns
     false and does nothing when sound is off, which is the default and stays
     the default on every floor kiosk. */
  const { play } = useGymSound();
  const ring = useCallback(() => { play('bell'); }, [play]);

  const pressed = useAchievementCeremony({
    earned,
    athleteId: athleteId ?? undefined,
    // Never on the family surface, and never before the first read has landed:
    // an empty list is "nobody has said yet", not "nothing earned".
    active: !isFamily && state === 'ready',
    onCross: ring,
  });

  const pressedMilestone = pressed ? milestoneByKey(pressed) : null;

  const chooseProgram = useCallback(async (next: string) => {
    if (!athleteId || !isProgram(next) || savingProgram) return;
    setSavingProgram(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/achievements/milestones`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, program: next }),
      });
      if (response.ok) {
        setProgram(next);
      }
    } catch {
      // Leaving the previous program showing is the honest failure: the path
      // on screen is still the one the server holds.
    } finally {
      setSavingProgram(false);
    }
  }, [athleteId, savingProgram]);

  const markMilestone = useCallback(async (milestone: Milestone) => {
    if (!athleteId || isFamily) return;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/achievements/milestones`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, milestone_key: milestone.key }),
      });
      if (response.ok) {
        await load();
      }
    } catch {
      /* Silent: the milestone simply stays unmarked, which is the truth. */
    }
  }, [athleteId, isFamily, load]);

  if (!athleteId) {
    return null;
  }

  if (state === 'unavailable') {
    return (
      <section className={SHELL(isFamily)} aria-label="Achievements">
        <p className={isFamily ? 't-body' : 'text-[length:var(--t-sm)] text-[color:var(--bone-300)]'}>
          This did not load. It is a connection problem, not an empty record —
          nothing already earned has gone anywhere.
        </p>
      </section>
    );
  }

  /* A path drawn before the ledger has been read would say "0 of 6" and
     "nothing here yet" to somebody who has trained for a year. An empty record
     and an unread one look identical and mean opposite things, so this waits
     rather than guessing -- the same distinction the error state above draws. */
  if (state === 'loading') {
    return (
      <section className={SHELL(isFamily)} aria-label="Achievements">
        <span className="working">Reading the record...</span>
      </section>
    );
  }

  const earnedCount = earned.length;

  return (
    <section className={SHELL(isFamily)} aria-label={isFamily ? 'What they have earned' : 'What you have earned'}>
      <header className="flex flex-wrap items-end justify-between gap-[var(--s3)]">
        <div>
          <h3 className={isFamily ? 't-label' : 'tcard-title'}>
            {isFamily ? 'What they have earned' : 'Earned'}
          </h3>
          <p className="tcard-sub">
            {athleteName ? `${athleteName} · ` : ''}
            {earnedCount} {earnedCount === 1 ? 'thing' : 'things'} earned · nothing here ever comes off
          </p>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* THE WALL — what a coach said. First, because a person said it.      */}
      {/* ------------------------------------------------------------------ */}
      <div className="mt-[var(--s5)]">
        <h4 className={isFamily ? 't-label' : 't-label'}>
          {isFamily ? 'What the coaches have said' : 'From your coaches'}
        </h4>

        {recognitions.length === 0 ? (
          <p className={`mt-[var(--s3)] ${isFamily ? 't-muted' : 'text-[length:var(--t-sm)] text-[color:var(--bone-400)]'}`}>
            {isFamily
              ? 'Nothing here yet. Coaches write these when they catch somebody doing well.'
              : 'Nothing here yet. This fills up when a coach catches you doing something right.'}
          </p>
        ) : (
          <ul className="mt-[var(--s3)] space-y-[var(--s3)]" role="list">
            {recognitions.map((item) => {
              const phrase = recognitionPhrase(item.kind);
              const said = isFamily
                ? phrase?.family ?? item.kind
                : phrase?.said ?? item.kind;
              return (
                <li key={item.recognition_id} className={NOTE_CARD(isFamily)}>
                  {/* Typed on a card, not rendered as a system row: the hand
                      font is what makes it read as something a person wrote. */}
                  <p
                    className={isFamily
                      ? 't-body text-[length:var(--t-md)]'
                      : 'text-[length:var(--t-md)] text-[color:var(--bone-100)]'}
                    style={{ fontFamily: 'var(--font-type)' }}
                  >
                    {said}
                  </p>
                  {item.note && (
                    <p
                      className={isFamily
                        ? 't-body mt-[var(--s2)]'
                        : 'mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-200)]'}
                      style={{ fontFamily: 'var(--font-hand)' }}
                    >
                      “{item.note}”
                    </p>
                  )}
                  <p className={isFamily ? 't-muted mt-[var(--s3)]' : 'tcard-sub mt-[var(--s3)]'}>
                    — {item.coach_display_name}, {formatDay(item.created_at)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* MENTORSHIP — visible on both sides.                                 */}
      {/* ------------------------------------------------------------------ */}
      {mentorships.length > 0 && (
        <div className="mt-[var(--s5)]">
          <h4 className="t-label">{isFamily ? 'Who they train with' : 'Your corner'}</h4>
          <ul className="mt-[var(--s3)] space-y-[var(--s2)]" role="list">
            {mentorships.map((link) => {
              const iAmMentor = link.mentor_athlete_id === athleteId;
              const other = iAmMentor ? link.mentee_name : link.mentor_name;
              const closed = link.ended_on !== null;
              const line = iAmMentor
                ? (isFamily ? `Mentors ${other || 'a newer athlete'}` : `You mentor ${other || 'a newer athlete'}`)
                : (isFamily ? `${other || 'An older athlete'} mentors them` : `${other || 'An older athlete'} mentors you`);
              return (
                <li
                  key={link.mentorship_id}
                  className={isFamily
                    ? 't-body rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s3)]'
                    : 'rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-200)]'}
                >
                  {line}
                  {/* A closed pairing is history, never a failure — the copy
                      says "since", never "ended badly", because the record has
                      no such field to read. */}
                  <span className={isFamily ? 't-muted ml-[var(--s3)]' : 'tcard-sub ml-[var(--s3)]'}>
                    {closed ? `${formatDay(link.started_on)} – ${formatDay(link.ended_on!)}` : `since ${formatDay(link.started_on)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* THE CEREMONY, IN WORDS. The channel that carries the whole message   */}
      {/* on its own — volume down, reduced motion, screen reader.            */}
      {/* ------------------------------------------------------------------ */}
      {pressedMilestone && !isFamily && (
        <p className="tcard-earned mt-[var(--s5)]" role="status">
          <b>{pressedMilestone.label}</b>
          <span>Earned. It never comes off.</span>
        </p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* THE PATH. Only the tracks this program includes — a track that is    */}
      {/* not part of somebody's programme is absent, never greyed out.       */}
      {/* ------------------------------------------------------------------ */}
      <div className="mt-[var(--s5)] space-y-[var(--s5)]">
        {tracks.map((track) => (
          <TrackPanel
            key={track.track}
            track={track}
            isFamily={isFamily}
            pressedKey={pressed}
            onMark={isFamily ? undefined : markMilestone}
          />
        ))}
      </div>

      {/* Programme choice. Not a rank and not a level: the four do not order,
          and changing it changes which tracks are shown and nothing else. */}
      {allowProgramChange && !isFamily && (
        <div className="mt-[var(--s5)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
          <h4 className="t-label">What you came here for</h4>
          <p className="tcard-sub mt-[var(--s2)]">
            This only changes which parts of the path you see. None of them is above another.
          </p>
          <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
            {PROGRAMS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => void chooseProgram(option)}
                disabled={savingProgram}
                aria-pressed={program === option}
                className={
                  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)] '
                  + (program === option
                    ? 'border-[color:var(--brass-600)] bg-[var(--brass-500)] text-[color:var(--hide-950)]'
                    : 'border-[color:rgb(var(--brass-400-rgb)_/_.28)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)]')
                }
              >
                {PROGRAM_LABEL[option]}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const PROGRAM_LABEL: Readonly<Record<Program, string>> = {
  fitness: 'Fitness',
  youth: 'Youth programme',
  recreational: 'Boxing, for me',
  competitive: 'Competing',
};

/* Both grounds (Law 6): this panel renders on leather inside the athlete
   workspace and on the family canvas inside the parent hub, so the shell and
   the note card are chosen once here rather than at every call site. */
function SHELL(isFamily: boolean): string {
  return isFamily
    ? 'mat-paper rounded-[var(--r-lg)] p-[var(--s5)]'
    : 'pap pap--card age-1 lift-1 tcard';
}

function NOTE_CARD(isFamily: boolean): string {
  return isFamily
    ? 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] bg-[var(--paper)] p-[var(--s4)]'
    : 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] bg-[rgba(0,0,0,.3)] p-[var(--s4)]';
}

function TrackPanel({
  track,
  isFamily,
  pressedKey,
  onMark,
}: {
  track: TrackProgress;
  isFamily: boolean;
  pressedKey: string | null;
  onMark?: (milestone: Milestone) => void;
}) {
  const total = track.earned.length + track.ahead.length;

  return (
    <section aria-label={isFamily ? track.meta.family : track.meta.label}>
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
        <h4 className={isFamily ? 't-label' : 't-label'}>
          {isFamily ? track.meta.family : track.meta.label}
        </h4>
        {/* A total of this athlete's own things, never a position among others.
            Printed as text so it is never colour alone (Law 3). */}
        <span className={isFamily ? 't-muted' : 'tcard-sub'}>
          {track.earned.length} of {total}
        </span>
      </div>
      <p className={isFamily ? 't-muted mt-[var(--s2)]' : 'tcard-sub mt-[var(--s2)]'}>
        {track.meta.blurb}
      </p>

      <ul className="mt-[var(--s3)] grid gap-[var(--s2)] md:grid-cols-2" role="list">
        {track.earned.map((milestone) => (
          <li
            key={milestone.key}
            className={
              (isFamily
                ? 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] bg-[var(--paper)] px-[var(--s4)] py-[var(--s3)] t-body'
                : 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-600)] bg-[rgba(0,0,0,.3)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]')
              + (pressedKey === milestone.key ? ' tcard-seal-slot--pressed' : '')
            }
          >
            <span aria-hidden="true" className="mr-[var(--s2)]">✓</span>
            {isFamily ? milestone.family : milestone.label}
            <span className="sr-only"> — earned</span>
          </li>
        ))}

        {track.ahead.map((milestone) => (
          <li
            key={milestone.key}
            className={isFamily
              ? 'rounded-[var(--r-md)] border border-dashed border-[color:rgba(0,0,0,.24)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s3)] t-muted'
              : 'rounded-[var(--r-md)] border border-dashed border-[color:rgb(var(--brass-400-rgb)_/_.28)] bg-[rgba(0,0,0,.18)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-400)]'}
          >
            {/* "Ahead", never "locked". No unearned milestone anywhere states a
                reason it is unearned, so its absence cannot be read backwards
                into a medical, disciplinary or ability fact about anybody. */}
            <span className="sr-only">Ahead of you: </span>
            {isFamily ? milestone.family : milestone.label}
            {onMark && milestone.evidence !== 'coach_marked' && milestone.evidence !== 'session_count' && (
              <button
                type="button"
                onClick={() => onMark(milestone)}
                className="btn btn--ghost ml-[var(--s3)] min-h-[var(--tap)]"
              >
                Did it
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Dates arrive as ISO or YYYY-MM-DD; render without inventing a timezone. */
function formatDay(raw: string): string {
  const ymd = raw.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])} ${match[1]}`;
}
