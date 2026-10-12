'use client';

import React, { useEffect, useId, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateShort } from '@/src/lib/gymTime';

/* AN ATHLETE'S GOALS, READ-ONLY (lane N8-05, F-047).
 *
 * Owner ruling 2026-10-12: the goals an athlete set, the progress they
 * reported and the ones they marked "I did it" show to their coach and to
 * their guardian. Nobody but the athlete writes them, so there is no control
 * here at all.
 *
 * The athlete's "why it matters" line is the coach's to read, never the
 * family's. The server already leaves it out of a guardian's answer (see
 * goalProjection.ts); the family audience also never draws it, so a payload
 * that ever carried it would still not put it on a parent's screen.
 *
 * Two reads, one per kind of goal, each keyed by athlete and aborted on a
 * switch so a sibling's late answer never shows. A read that did not answer
 * says Unavailable, never "no goals". */

export type GoalsAudience = 'coach' | 'family';

interface OwnWordsGoal {
  goal_id: string;
  title: string;
  why_it_matters?: string;
  target_date: string | null;
  reached_at: string | null;
}

interface SmartGoal {
  goal_id: string;
  title: string;
  target_date: string;
  metric: string;
  progress_percent: number | null;
  status: string;
}

type Read<T> = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: T[] };

interface Held {
  athleteId: string;
  own: Read<OwnWordsGoal>;
  smart: Read<SmartGoal>;
}

function rowsOf(payload: unknown): Array<Record<string, unknown>> | null {
  if (!payload || typeof payload !== 'object') return null;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || !items.every((row) => row !== null && typeof row === 'object')) return null;
  return items as Array<Record<string, unknown>>;
}

function parseOwn(payload: unknown): OwnWordsGoal[] | null {
  const rows = rowsOf(payload);
  if (!rows || !rows.every((row) => typeof row.goal_id === 'string' && typeof row.title === 'string')) return null;
  return rows.map((row) => ({
    goal_id: row.goal_id as string,
    title: row.title as string,
    why_it_matters: typeof row.why_it_matters === 'string' ? row.why_it_matters : undefined,
    target_date: typeof row.target_date === 'string' ? row.target_date : null,
    reached_at: typeof row.reached_at === 'string' ? row.reached_at : null,
  }));
}

function parseSmart(payload: unknown): SmartGoal[] | null {
  const rows = rowsOf(payload);
  if (!rows || !rows.every((row) => typeof row.goal_id === 'string' && typeof row.title === 'string')) return null;
  return rows
    // The coach's answer is select *, which carries own-words rows too; those
    // are listed from their own read above, not twice.
    .filter((row) => row.goal_kind !== 'own_words')
    .map((row) => ({
      goal_id: row.goal_id as string,
      title: row.title as string,
      target_date: typeof row.target_date === 'string' ? row.target_date : '',
      metric: typeof row.metric === 'string' ? row.metric : '',
      progress_percent: typeof row.progress_percent === 'number' ? row.progress_percent : null,
      status: typeof row.status === 'string' ? row.status : '',
    }));
}

/* The athlete's own screen (AthleteWorkspace) shows a SMART goal's status
   capitalised, with a glyph beside the word; this says it the same way, so the
   two screens never disagree about one goal. */
function statusWords(raw: string): { glyph: string; label: string } {
  const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Not Started';
  if (label === 'Active') return { glyph: '◉', label };
  if (label === 'Completed') return { glyph: '✓', label };
  return { glyph: '▲', label };
}

export default function AthleteGoalsReadOnly({
  athleteId,
  audience,
}: {
  readonly athleteId: string;
  readonly audience: GoalsAudience;
}) {
  const headingId = useId();
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const id = encodeURIComponent(athleteId);
    const publish = (line: Partial<Omit<Held, 'athleteId'>>) => {
      if (signal.aborted) return;
      setHeld((prior) => (prior && prior.athleteId === athleteId
        ? { ...prior, ...line }
        : { athleteId, own: { state: 'loading' }, smart: { state: 'loading' }, ...line }));
    };
    const read = async <T,>(url: string, parse: (payload: unknown) => T[] | null): Promise<Read<T>> => {
      try {
        const response = await fetch(url, { method: 'GET', credentials: 'include', signal });
        if (!response.ok) return { state: 'failed' };
        const items = parse(await response.json().catch(() => null));
        return items ? { state: 'loaded', items } : { state: 'failed' };
      } catch {
        return { state: 'failed' };
      }
    };
    void read(`${apiBase()}/api/pilot/goals/personal?athlete_id=${id}`, parseOwn).then((own) => publish({ own }));
    void read(`${apiBase()}/api/pilot/goals/list?athlete_id=${id}`, parseSmart).then((smart) => publish({ smart }));
    return () => controller.abort();
  }, [athleteId]);

  const shown = held?.athleteId === athleteId ? held : null;
  const own: Read<OwnWordsGoal> = shown?.own ?? { state: 'loading' };
  const smart: Read<SmartGoal> = shown?.smart ?? { state: 'loading' };
  const nothingSet = own.state === 'loaded' && smart.state === 'loaded' && own.items.length === 0 && smart.items.length === 0;

  return (
    <section aria-labelledby={headingId} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]" data-testid="athlete-goals">
      <h3 id={headingId} className="t-label">Goals they have set</h3>
      {nothingSet ? (
        <p className="t-muted">No goals set yet.</p>
      ) : (
        <>
          <div className="space-y-[var(--s2)]">
            <h4 className="t-eyebrow">In their own words</h4>
            {own.state === 'loading' && <p className="working">Reading...</p>}
            {own.state === 'failed' && <p className="t-muted">Unavailable - these goals could not be read.</p>}
            {own.state === 'loaded' && own.items.length === 0 && <p className="t-muted">None set yet.</p>}
            {own.state === 'loaded' && own.items.length > 0 && (
              <ul role="list" className="space-y-[var(--s2)]">
                {own.items.map((goal) => {
                  const reachedOn = goal.reached_at ? formatGymDateShort(goal.reached_at) : null;
                  return (
                    <li key={goal.goal_id} className="space-y-[var(--s1)]">
                      <p className="t-body">{goal.title}</p>
                      {audience === 'coach' && goal.why_it_matters ? (
                        <p className="t-muted">Why it matters to them: {goal.why_it_matters}</p>
                      ) : null}
                      <p className="t-muted">
                        <span aria-hidden="true">{goal.reached_at ? '✓ ' : '○ '}</span>
                        {goal.reached_at ? `Did it${reachedOn ? ` · ${reachedOn}` : ''}` : 'Still working on it'}
                        {goal.target_date ? ` · Aiming for ${formatCalendarDay(goal.target_date)}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="space-y-[var(--s2)]">
            <h4 className="t-eyebrow">Goals with a measure</h4>
            {smart.state === 'loading' && <p className="working">Reading...</p>}
            {smart.state === 'failed' && <p className="t-muted">Unavailable - these goals could not be read.</p>}
            {smart.state === 'loaded' && smart.items.length === 0 && <p className="t-muted">None set yet.</p>}
            {smart.state === 'loaded' && smart.items.length > 0 && (
              <ul role="list" className="space-y-[var(--s2)]">
                {smart.items.map((goal) => {
                  const status = statusWords(goal.status);
                  return (
                  <li key={goal.goal_id} className="space-y-[var(--s1)]">
                    <p className="t-body">{goal.title}</p>
                    <p className="t-muted">
                      <span aria-hidden="true">{status.glyph} </span>
                      {[
                        status.label,
                        goal.metric ? `Measured by ${goal.metric}` : null,
                        goal.target_date ? `by ${formatCalendarDay(goal.target_date)}` : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                    <p className="t-muted">
                      {goal.progress_percent === null
                        ? 'No progress reported yet'
                        : `Reported progress: ${goal.progress_percent}%`}
                    </p>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
