import { CUE_KIND_LABELS, type SelfTalkCueKind } from '@/src/lib/mentalSkills/content';
import { formatGymDayShort } from '@/src/lib/gymTime';

/*
 * One athlete's mental skills, read-only: the coach's mental-domain goals,
 * the athlete's current self-talk cue, and their recent imagery sessions.
 * Rendered by /athlete/mental-skills now and by the guardian page next.
 *
 * NOTHING IS COMPUTED. No total minutes, no streak, no weekly figure and no
 * count of sessions: each row is shown as the athlete logged it. A total shown
 * to a child reads as a score, and no target was ever set (the unsourced
 * "45 minutes a week" figure was deliberately not shipped).
 *
 * A failed read never renders as "nothing logged": the four states are kept
 * apart, as on the development plan pages.
 */

export interface MentalGoal {
  objective_id: string;
  objective: string;
}

export interface MentalSkillsData {
  current_cue: { cue_text: string; cue_kind: SelfTalkCueKind; logged_on: string } | null;
  imagery_sessions: Array<{ entry_id: string; minutes: number; logged_on: string }>;
}

export type LoadState = 'loading' | 'loaded' | 'unavailable';

export default function MentalSkillsView({
  state,
  data,
  goals,
  goalsState,
  subjectLabel,
}: {
  readonly state: LoadState;
  readonly data: MentalSkillsData | null;
  readonly goals: readonly MentalGoal[];
  readonly goalsState: LoadState;
  readonly subjectLabel: string;
}) {
  return (
    <div className="space-y-[var(--s5)]">
      <section aria-labelledby="mental-goals-heading" className="space-y-[var(--s2)]">
        <h2 id="mental-goals-heading" className="t-eyebrow">Mental goals from the coach</h2>
        {goalsState === 'loading' && <p className="t-muted">Loading…</p>}
        {goalsState === 'unavailable' && (
          <p className="t-muted" role="alert">The goals could not be read right now. Ask your coach.</p>
        )}
        {goalsState === 'loaded' && goals.length === 0 && (
          <p className="t-muted">No mental goals in {subjectLabel} development plan yet.</p>
        )}
        {goalsState === 'loaded' && goals.length > 0 && (
          <ul className="space-y-[var(--s2)]">
            {goals.map((goal) => (
              <li key={goal.objective_id} className="t-data">{goal.objective}</li>
            ))}
          </ul>
        )}
      </section>

      {state === 'loading' && <p className="t-muted">Loading…</p>}
      {state === 'unavailable' && (
        <p className="t-muted" role="alert">This could not be read right now. Ask your coach.</p>
      )}
      {state === 'loaded' && data && (
        <>
          <section aria-labelledby="current-cue-heading" className="space-y-[var(--s2)]">
            <h2 id="current-cue-heading" className="t-eyebrow">Self-talk cue</h2>
            {data.current_cue ? (
              <>
                <p className="t-command m-0">{data.current_cue.cue_text}</p>
                <p className="t-label m-0">
                  {CUE_KIND_LABELS[data.current_cue.cue_kind]} · set {formatGymDayShort(data.current_cue.logged_on)}
                </p>
              </>
            ) : (
              <p className="t-muted">No cue chosen yet.</p>
            )}
          </section>

          <section aria-labelledby="imagery-log-heading" className="space-y-[var(--s2)]">
            <h2 id="imagery-log-heading" className="t-eyebrow">Imagery sessions</h2>
            {data.imagery_sessions.length === 0 ? (
              <p className="t-muted">No imagery sessions logged yet.</p>
            ) : (
              <ul className="space-y-[var(--s1)]">
                {data.imagery_sessions.map((session) => (
                  <li key={session.entry_id} className="t-data">
                    {formatGymDayShort(session.logged_on)}: {session.minutes} min
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
