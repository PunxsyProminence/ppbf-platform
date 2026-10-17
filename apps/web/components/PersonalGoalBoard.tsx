'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAchievementCeremony } from './achievementCeremony';
import useGymSound from './useGymSound';
import { SaveNote, withoutKey, type SaveState } from './AthleteAchievements';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { gymDayIso } from '@/src/lib/gymTime';

/**
 * A GOAL SOMEBODY SET FOR THEMSELVES, IN THEIR OWN WORDS.
 *
 * The workspace already had SMART goals: a title, a category from a picklist of
 * boxing metrics, a required deadline and a required success metric. Four
 * required fields before an athlete is allowed to want something. "Show up on
 * the days I don't want to" cannot be entered into that form — it has no
 * metric and no date — and a kid who came for the mentorship would have had to
 * translate their reason into a fight statistic to type it in at all.
 *
 * This asks for a sentence. The date is optional and the reason is optional,
 * because a goal does not owe anyone a deadline or a justification.
 *
 * It EXTENDS the SMART path rather than replacing it. Both write pilot.goals;
 * this one sets goal_kind = 'own_words'. A coach who wants a measurable
 * conditioning target still has the other form, and an athlete who wants to be
 * a better training partner now has one too.
 *
 * REACHING ONE GETS THE CEREMONY. The same seal press and the same bell the
 * training card uses for a session milestone — deliberately the same, not a
 * second celebration system. A goal somebody set for themselves and got to is
 * at least as much of a moment as a count reaching thirteen.
 *
 * NOTHING HERE CAN FAIL. There is no overdue state, no missed state, and no
 * red. A goal is reached or it is still being worked on, and the second of
 * those is the ordinary state of every goal worth setting. A target date that
 * has passed is not called late — it is just a date somebody wrote down once.
 */

export interface PersonalGoalItem {
  goal_id: string;
  title: string;
  why_it_matters: string;
  target_date: string | null;
  reached_at: string | null;
}

export interface PersonalGoalBoardProps {
  /** Null until the session resolves. The board says so rather than pretending. */
  athleteId: string | null;
  /** Family surfaces read but never write. */
  readOnly?: boolean;
  /** Told after a goal is added or marked reached, so a count elsewhere (Active Goals) reads again. */
  onChanged?: () => void;
}

const TITLE_MAX = 160;
/** When the Undo line stops being offered. The server's PERSONAL_GOAL_UNDO_WINDOW_MS decides. */
const UNDO_WINDOW_MS = 10 * 60 * 1000;
const WHY_MAX = 240;

export default function PersonalGoalBoard({ athleteId, readOnly = false, onChanged }: PersonalGoalBoardProps) {
  const [goals, setGoals] = useState<PersonalGoalItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const [ownWords, setOwnWords] = useState('');
  const [why, setWhy] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);
  // "I did it" says it is saving, and says so if the server did not keep it (WO-N5-02). Keyed by
  // athlete and goal, so the line sits on the goal that was pressed and leaves with its athlete.
  const [reachSave, setReachSave] = useState<Readonly<Record<string, SaveState>>>({});
  const [message, setMessage] = useState('');
  // "Undo" for a mark made in the last ten minutes (UXB Q1 B). The server
  // decides the window and the owner (undoPersonalGoalReached); this clock only
  // decides when to stop offering the line. Ticked in an effect, not read in render.
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [undoFailed, setUndoFailed] = useState<Readonly<Record<string, string>>>({});
  const undoingRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!athleteId) return;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/goals/personal?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('unavailable');
      const body = (await response.json()) as { items?: PersonalGoalItem[] };
      setGoals(body.items ?? []);
      setFailed(false);
      setLoaded(true);
    } catch {
      setFailed(true);
      setLoaded(true);
    }
  }, [athleteId]);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await load();
    })();
  }, [load]);

  /* The ceremony's input: the set of goals already reached. A SET, never a rate
     — nothing here can see a gap, so nothing here can punish one. */
  const reachedKeys = useMemo(
    () => goals.filter((goal) => goal.reached_at !== null).map((goal) => `goal:${goal.goal_id}`),
    [goals],
  );

  const { play } = useGymSound();
  const ring = useCallback(() => { play('bell'); }, [play]);

  const pressed = useAchievementCeremony({
    earned: reachedKeys,
    athleteId: athleteId ?? undefined,
    active: !readOnly && loaded && !failed,
    onCross: ring,
  });

  const pressedGoal = pressed
    ? goals.find((goal) => `goal:${goal.goal_id}` === pressed) ?? null
    : null;

  const create = useCallback(async () => {
    if (!athleteId || saving) return;
    const words = ownWords.trim();
    if (!words) {
      setMessage('Write the goal in your own words first.');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals/personal`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          own_words: words,
          why_it_matters: why.trim(),
          target_date: targetDate,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(payload.error || 'That did not save. Try again.');
        return;
      }
      setOwnWords('');
      setWhy('');
      setTargetDate('');
      setMessage('On the board.');
      await load();
      onChanged?.();
    } catch {
      setMessage('That did not save. Try again.');
    } finally {
      setSaving(false);
    }
  }, [athleteId, ownWords, why, targetDate, saving, load, onChanged]);

  // One mark per press (UXB-19), as AthleteAchievements does (#1529): a second
  // tap before the first is answered must not send a second write.
  const reachingRef = useRef<Set<string>>(new Set());

  const markReached = useCallback(async (goalId: string) => {
    if (!athleteId || readOnly) return;
    const key = `${athleteId}:${goalId}`;
    if (reachingRef.current.has(key)) return;
    reachingRef.current.add(key);
    setReachSave((now) => ({ ...now, [key]: 'saving' }));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals/personal`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, goal_id: goalId }),
      });
      if (response.ok) {
        await load();
        setReachSave((now) => withoutKey(now, key));
        onChanged?.();
      } else {
        setReachSave((now) => ({ ...now, [key]: 'failed' }));
      }
    } catch {
      // The goal stays open, which is the truth until the server says otherwise,
      // and its card says the press was not kept.
      setReachSave((now) => ({ ...now, [key]: 'failed' }));
    } finally {
      reachingRef.current.delete(key);
    }
  }, [athleteId, readOnly, load, onChanged]);

  useEffect(() => {
    const timer = setInterval(() => setClockMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const undoReached = useCallback(async (goalId: string) => {
    if (!athleteId || readOnly) return;
    const key = `${athleteId}:${goalId}`;
    if (undoingRef.current.has(key)) return;
    undoingRef.current.add(key);
    setUndoFailed((now) => {
      const { [key]: _cleared, ...rest } = now;
      return rest;
    });
    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals/personal`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, goal_id: goalId, undo: true }),
      });
      if (response.ok) {
        await load();
        onChanged?.();
      } else {
        // 409: past the window, as the server counts it. PROPOSED wording.
        setUndoFailed((now) => ({
          ...now,
          [key]: response.status === 409 ? 'That can no longer be undone.' : 'That did not undo. Try again.',
        }));
      }
    } catch {
      setUndoFailed((now) => ({ ...now, [key]: 'That did not undo. Try again.' }));
    } finally {
      undoingRef.current.delete(key);
    }
  }, [athleteId, readOnly, load, onChanged]);

  if (!athleteId) {
    return null;
  }

  const working = goals.filter((goal) => goal.reached_at === null);
  const reached = goals.filter((goal) => goal.reached_at !== null);

  return (
    <section className="pap pap--card age-1 lift-1 tcard" aria-label="Your own goals">
      <header>
        <h3 className="tcard-title">In your own words</h3>
        <p className="tcard-sub">
          Not a list of boxing numbers. Whatever you actually came here to do.
        </p>
      </header>

      {!readOnly && (
        <div className="mt-[var(--s4)] space-y-[var(--s3)]">
          <label htmlFor="own-goal" className="t-label">
            What do you want to be able to do?
          </label>
          <input
            id="own-goal"
            value={ownWords}
            maxLength={TITLE_MAX}
            onChange={(event) => setOwnWords(event.target.value)}
            className="input input--kiosk"
            placeholder="Run a mile without stopping"
          />

          <label htmlFor="own-goal-why" className="t-label">
            Why it matters — only if you want to say
          </label>
          <input
            id="own-goal-why"
            value={why}
            maxLength={WHY_MAX}
            onChange={(event) => setWhy(event.target.value)}
            className="input input--kiosk"
            placeholder="Because I quit last time"
          />

          <label htmlFor="own-goal-date" className="t-label">
            A date, if there is one. Most goals do not need one.
          </label>
          <input
            id="own-goal-date"
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
            className="input input--kiosk"
          />

          <button
            type="button"
            onClick={() => void create()}
            disabled={saving}
            className="btn btn--kiosk disabled:opacity-50"
          >
            {saving ? 'Putting it up...' : 'Put it on the board'}
          </button>

          {message && (
            <p className="tcard-sub" role="status">{message}</p>
          )}
        </div>
      )}

      {/* The ceremony in words — the channel that carries the whole message on
          its own for anyone whose volume is down or who is reading with a
          screen reader. role="status" announces it. */}
      {pressedGoal && (
        <p className="tcard-earned mt-[var(--s4)]" role="status">
          <b>{pressedGoal.title}</b>
          <span>You said you would. You did.</span>
        </p>
      )}

      {failed && (
        <div className="mt-[var(--s4)] space-y-[var(--s3)]">
          <p className="tcard-sub" role="alert">
            These did not load. That is a connection problem — nothing you wrote has gone anywhere.
          </p>
          <button type="button" onClick={() => void load()} className="btn btn--kiosk">
            Try again
          </button>
        </div>
      )}

      {loaded && !failed && goals.length === 0 && (
        <p className="tcard-sub mt-[var(--s4)]">
          Nothing up yet. One sentence is enough.
        </p>
      )}

      {working.length > 0 && (
        <div className="mt-[var(--s5)]">
          <h4 className="t-label">Working on</h4>
          <ul className="mt-[var(--s3)] space-y-[var(--s3)]" role="list">
            {working.map((goal) => (
              <li
                key={goal.goal_id}
                className="rounded-[var(--r-md)] border-2 border-[color:rgb(var(--brass-400-rgb)_/_.28)] bg-[rgba(0,0,0,.26)] p-[var(--s4)]"
              >
                <p className="text-[length:var(--t-md)] text-[color:var(--bone-100)]">{goal.title}</p>
                {goal.why_it_matters && (
                  <p
                    className="mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]"
                    style={{ fontFamily: 'var(--font-hand)' }}
                  >
                    {goal.why_it_matters}
                  </p>
                )}
                {/* A date that has passed is not called late. There is no
                    overdue state here and no column that could hold one. */}
                {goal.target_date && (
                  <p className="tcard-sub mt-[var(--s2)]">Aiming for: {formatDay(goal.target_date)}</p>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => void markReached(goal.goal_id)}
                    disabled={reachSave[`${athleteId}:${goal.goal_id}`] === 'saving'}
                    className="btn btn--kiosk mt-[var(--s3)] disabled:opacity-60"
                  >
                    I did it
                  </button>
                )}
                <SaveNote state={reachSave[`${athleteId}:${goal.goal_id}`]} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {reached.length > 0 && (
        <div className="mt-[var(--s5)]">
          <h4 className="t-label">Done</h4>
          <ul className="mt-[var(--s3)] space-y-[var(--s2)]" role="list">
            {reached.map((goal) => (
              <li
                key={goal.goal_id}
                className={
                  'rounded-[var(--r-md)] border-2 border-[color:var(--brass-600)] bg-[rgba(0,0,0,.3)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]'
                  + (pressed === `goal:${goal.goal_id}` ? ' tcard-seal-slot--pressed' : '')
                }
              >
                <span aria-hidden="true" className="mr-[var(--s2)]">✓</span>
                {goal.title}
                <span className="tcard-sub ml-[var(--s3)]">{formatDay(goal.reached_at ?? '')}</span>
                {/* One tap marks it; a slip can be taken back for ten minutes (UXB Q1 B). */}
                {!readOnly && goal.reached_at && clockMs - Date.parse(goal.reached_at) < UNDO_WINDOW_MS && (
                  <p className="mt-[var(--s2)]">
                    Marked.{' '}
                    <button
                      type="button"
                      onClick={() => void undoReached(goal.goal_id)}
                      className="btn btn--ghost min-h-[var(--tap)]"
                    >
                      Undo
                    </button>
                  </p>
                )}
                {undoFailed[`${athleteId}:${goal.goal_id}`] && (
                  <p className="tcard-sub mt-[var(--s2)]" role="status">{undoFailed[`${athleteId}:${goal.goal_id}`]}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * target_date arrives as a bare YYYY-MM-DD; reached_at as an instant. A bare
 * day is written as it is. An instant is reduced to the gym's day first:
 * slicing the ISO text names the UTC day, which is tomorrow for a goal ticked
 * off after 8 PM gym time.
 */
function formatDay(raw: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : (gymDayIso(raw) ?? raw.slice(0, 10));
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return raw;
  // One date form across the app (UXB-30): "Oct 16, 2026".
  return formatCalendarDay(ymd);
}
