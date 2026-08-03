'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAchievementCeremony } from './achievementCeremony';
import useGymSound from './useGymSound';
import { apiBase } from '@/lib/apiBase';

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
}

const TITLE_MAX = 160;
const WHY_MAX = 240;

export default function PersonalGoalBoard({ athleteId, readOnly = false }: PersonalGoalBoardProps) {
  const [goals, setGoals] = useState<PersonalGoalItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const [ownWords, setOwnWords] = useState('');
  const [why, setWhy] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

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
        setMessage(payload.error || 'That did not save. Try it again.');
        return;
      }
      setOwnWords('');
      setWhy('');
      setTargetDate('');
      setMessage('On the board.');
      await load();
    } catch {
      setMessage('That did not save. Try it again.');
    } finally {
      setSaving(false);
    }
  }, [athleteId, ownWords, why, targetDate, saving, load]);

  const markReached = useCallback(async (goalId: string) => {
    if (!athleteId || readOnly) return;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals/personal`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, goal_id: goalId }),
      });
      if (response.ok) {
        await load();
      }
    } catch {
      /* Silent: the goal stays open, which is the truth until the server says
         otherwise. */
    }
  }, [athleteId, readOnly, load]);

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
        <p className="tcard-sub mt-[var(--s4)]">
          These did not load. That is a connection problem — nothing you wrote has gone anywhere.
        </p>
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
                className="rounded-[var(--r-md)] border-2 border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] p-[var(--s4)]"
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
                  <p className="tcard-sub mt-[var(--s2)]">Wrote down: {formatDay(goal.target_date)}</p>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => void markReached(goal.goal_id)}
                    className="btn btn--kiosk mt-[var(--s3)]"
                  >
                    I did it
                  </button>
                )}
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
              </li>
            ))}
          </ul>
        </div>
      )}
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
