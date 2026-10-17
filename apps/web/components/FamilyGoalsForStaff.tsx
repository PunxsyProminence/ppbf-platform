'use client';

import React, { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDate, formatGymDay } from '@/src/lib/gymTime';

/* FAMILY GOALS, THE STAFF SIDE (#1593, PH-06b): under "From the family" on
   /coach/decision-loop, every live goal for the selected athlete, from
   GET /api/pilot/coach/family-goals -- the guardians' and the gym's.

   Each shows its title, what the family will do, the target date (a calendar
   day), who set it ("A guardian" or the staff member's name: the server never
   says which guardian) and "Done <gym date>" or "In progress" from the
   server's completed_at; no percentage. Staff read a guardian's goal but never
   change it (PH-06 Q-2 A): controls appear only where the server marks the
   goal mine_to_change. Staff add, edit, tick, untick and retire staff goals;
   a retired goal leaves the list, nothing is deleted.

   Mounted per athlete (key = athlete id), so a draft or an answer for one
   child never lands on another. A read that did not answer says so; it is
   never "no goals".

   A write the server refused (4xx) shows the server's words. A 5xx or a
   network failure does not say "not saved": the write may have landed, and a
   coach who believes it did not would Add it twice. A 404 on a change means
   the goal is no longer there to change (retired elsewhere), so it leaves the
   list. After a write, focus goes where the coach's next step is. */

export interface StaffFamilyGoal {
  goal_id: string;
  title: string;
  support_action: string;
  target_date: string | null;
  state: 'active' | 'completed';
  completed_at: string | null;
  set_by: string;
  mine_to_change: boolean;
}

type ReadState =
  | { state: 'loading' }
  | { state: 'failed'; athleteId: string }
  | { state: 'loaded'; athleteId: string; items: StaffFamilyGoal[] };

interface Draft {
  title: string;
  support: string;
  target: string;
}

const EMPTY: Draft = { title: '', support: '', target: '' };
const URL_PATH = '/api/pilot/coach/family-goals';
// PROPOSED copy
const NOT_SAVED = 'The goal was not saved.';
const UNSURE = 'The goal may not have been saved. Reload to check.';
const GONE = 'That goal is no longer on the list.';

// refused: the server said no (4xx), nothing was written. unsure: no answer or
// a server failure, the write may have happened. gone: a change to a goal that
// is no longer there (404).
class WriteError extends Error {
  constructor(readonly kind: 'refused' | 'unsure' | 'gone', message: string) {
    super(message);
  }
}

type Focus = { to: 'heading' } | { to: 'edit'; goalId: string } | { to: 'goal'; goalId: string };

const filled = (draft: Draft) => draft.title.trim() !== '' && draft.support.trim() !== '';

async function send(method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<StaffFamilyGoal | null> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${URL_PATH}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // A network failure (TypeError): the request may still have reached the server.
    throw new WriteError('unsure', UNSURE);
  }
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; item?: StaffFamilyGoal | null; error?: string };
  if (response.ok && payload.ok === true) return payload.item ?? null;
  if (method === 'PATCH' && response.status === 404) throw new WriteError('gone', GONE);
  if (response.status >= 400 && response.status < 500) throw new WriteError('refused', payload.error || NOT_SAVED);
  throw new WriteError('unsure', UNSURE);
}

function GoalFields({ draft, onChange, idPrefix }: Readonly<{ draft: Draft; onChange: (draft: Draft) => void; idPrefix: string }>) {
  // PROPOSED copy: the three field labels.
  return (
    <>
      <label className="block t-label" htmlFor={`${idPrefix}-title`}>Goal</label>
      <input id={`${idPrefix}-title`} className="input w-full" maxLength={200} value={draft.title}
        onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      <label className="block t-label" htmlFor={`${idPrefix}-support`}>What the family will do</label>
      <textarea id={`${idPrefix}-support`} className="textarea w-full" rows={2} maxLength={500} value={draft.support}
        onChange={(event) => onChange({ ...draft, support: event.target.value })} />
      <label className="block t-label" htmlFor={`${idPrefix}-target`}>Target date (optional)</label>
      <input id={`${idPrefix}-target`} type="date" className="input" value={draft.target}
        onChange={(event) => onChange({ ...draft, target: event.target.value })} />
    </>
  );
}

export default function FamilyGoalsForStaff({ athleteId }: Readonly<{ athleteId: string }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ goalId: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The guard itself: state set by one click is not seen by a second click in
  // the same tick, a ref is.
  const writing = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  // Where focus goes once that element is on screen and enabled.
  const pendingFocus = useRef<Focus | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || !panel.current) return;
    const element = Array.from(panel.current.querySelectorAll<HTMLElement>(`[data-focus="${target.to}"]`))
      .find((candidate) => target.to === 'heading' || candidate.dataset.goalId === target.goalId);
    if (!element || (element as HTMLButtonElement).disabled) return;
    pendingFocus.current = null;
    element.focus();
  });

  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}${URL_PATH}?athlete_id=${encodeURIComponent(athleteId)}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; items?: unknown };
        if (controller.signal.aborted) return;
        setRead(response.ok && payload.ok === true && Array.isArray(payload.items)
          ? { state: 'loaded', athleteId, items: payload.items as StaffFamilyGoal[] }
          : { state: 'failed', athleteId });
      } catch {
        if (!controller.signal.aborted) setRead({ state: 'failed', athleteId });
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  // One write at a time; the answer replaces (or, for a retire or a goal that
  // is gone, removes) that goal. `after` runs with the answer in the same
  // update, so the focus it asks for meets the render that shows the answer.
  async function run(key: string, write: () => Promise<StaffFamilyGoal | null>, goalId: string | null,
    after: (item: StaffFamilyGoal | null) => void) {
    if (writing.current) return;
    writing.current = true;
    pendingFocus.current = null;
    setBusy(key);
    setNotice(null);
    try {
      let item: StaffFamilyGoal | null = null;
      let gone = false;
      try {
        item = await write();
      } catch (error) {
        setNotice(error instanceof Error && error.message ? error.message : UNSURE);
        gone = error instanceof WriteError && error.kind === 'gone' && goalId !== null;
        // Refused or unknown: the goal and any open form stay as they are.
        if (!gone) return;
      }
      const answer = item;
      setRead((current) => {
        if (current.state !== 'loaded' || current.athleteId !== athleteId) return current;
        if (!goalId) return answer ? { ...current, items: [answer, ...current.items] } : current;
        return {
          ...current,
          items: answer
            ? current.items.map((goal) => (goal.goal_id === goalId ? answer : goal))
            : current.items.filter((goal) => goal.goal_id !== goalId),
        };
      });
      if (gone) {
        setEditing((current) => (current?.goalId === goalId ? null : current));
        pendingFocus.current = { to: 'heading' };
      } else {
        after(item);
      }
    } finally {
      writing.current = false;
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!filled(draft)) return;
    await run('add', () => send('POST', {
      athlete_id: athleteId, title: draft.title, support_action: draft.support, target_date: draft.target || null,
    }), null, (item) => {
      setDraft(EMPTY);
      if (item) pendingFocus.current = { to: 'goal', goalId: item.goal_id };
    });
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !filled(editing.draft)) return;
    const { goalId, draft: edit } = editing;
    await run(goalId, () => send('PATCH', {
      goal_id: goalId, action: 'edit', title: edit.title, support_action: edit.support, target_date: edit.target || null,
    }), goalId, () => {
      setEditing(null);
      pendingFocus.current = { to: 'edit', goalId };
    });
  }

  function retire(goalId: string) {
    return run(goalId, () => send('PATCH', { goal_id: goalId, action: 'retire' }), goalId, () => {
      pendingFocus.current = { to: 'heading' };
    });
  }

  function tick(goalId: string, done: boolean) {
    return run(goalId, () => send('PATCH', { goal_id: goalId, action: done ? 'done' : 'undo' }), goalId, () => undefined);
  }

  if (!athleteId) return null;
  // What is on screen belongs to the athlete selected now, or it reads as loading.
  const shown: ReadState = read.state !== 'loading' && read.athleteId !== athleteId ? { state: 'loading' } : read;

  return (
    <div ref={panel} className="mt-[var(--s4)] space-y-[var(--s3)]">
      {/* PROPOSED copy: heading, loading, failed and empty lines. */}
      <h3 className="t-label" tabIndex={-1} data-focus="heading">Family goals</h3>
      {notice && <p role="alert" className="t-body font-bold text-[var(--restricted-ink)]">{notice}</p>}

      {shown.state === 'loading' ? (
        <p className="t-muted">Loading family goals…</p>
      ) : shown.state === 'failed' ? (
        <p role="alert" className="t-body">Family goals could not be loaded. This is not a statement that there are none.</p>
      ) : shown.items.length === 0 ? (
        <p className="t-muted">No family goals for this athlete yet.</p>
      ) : (
        <ul className="space-y-[var(--s3)]" aria-label="Family goals">
          {shown.items.map((goal) => (
            <li key={goal.goal_id} tabIndex={-1} data-focus="goal" data-goal-id={goal.goal_id}
              className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)] space-y-[var(--s1)]">
              {editing?.goalId === goal.goal_id ? (
                <form onSubmit={(event) => void saveEdit(event)} className="space-y-[var(--s2)]" aria-label={`Edit ${goal.title}`}>
                  <GoalFields draft={editing.draft} idPrefix={`edit-${goal.goal_id}`}
                    onChange={(next) => setEditing({ goalId: goal.goal_id, draft: next })} />
                  <div className="flex gap-[var(--s2)]">
                    <button type="submit" className="btn" disabled={busy !== null || !filled(editing.draft)}>Save</button>
                    <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="t-body font-semibold">{goal.title}</p>
                  <p className="t-body whitespace-pre-wrap">{goal.support_action}</p>
                  <p className="t-muted">
                    {/* PROPOSED copy: "Set by" and "By <day>". */}
                    Set by {goal.set_by}
                    {goal.target_date ? ` · By ${formatGymDay(goal.target_date) ?? goal.target_date}` : ''}
                  </p>
                  <span className={`badge ${goal.state === 'completed' ? 'badge--cleared' : 'badge--monitor'}`}>
                    {goal.state === 'completed'
                      ? `Done ${goal.completed_at ? formatGymDate(goal.completed_at) ?? '' : ''}`.trim()
                      : 'In progress'}
                  </span>
                  {goal.mine_to_change && (
                    <div className="flex flex-wrap items-center gap-[var(--s3)] pt-[var(--s1)]">
                      <label className="inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s2)]">
                        <input
                          type="checkbox"
                          aria-label={`Done: ${goal.title}`}
                          className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                          checked={goal.state === 'completed'}
                          disabled={busy !== null}
                          onChange={(event) => void tick(goal.goal_id, event.target.checked)}
                        />
                        <span className="t-body">Done</span>
                      </label>
                      <button type="button" className="btn btn--ghost" aria-label={`Edit: ${goal.title}`}
                        data-focus="edit" data-goal-id={goal.goal_id}
                        disabled={busy !== null || editing !== null}
                        onClick={() => setEditing({ goalId: goal.goal_id, draft: { title: goal.title, support: goal.support_action, target: goal.target_date ?? '' } })}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--ghost" aria-label={`Retire: ${goal.title}`} disabled={busy !== null}
                        onClick={() => void retire(goal.goal_id)}>
                        Retire
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Only once the list has loaded: a goal saved into a list that never
          loaded would have nowhere to show. */}
      {shown.state === 'loaded' && (
        <form onSubmit={(event) => void add(event)} className="space-y-[var(--s2)]" aria-label="Add a goal for the family">
          {/* PROPOSED copy: form heading and button. */}
          <h4 className="t-label">Add a goal for the family</h4>
          <GoalFields draft={draft} onChange={setDraft} idPrefix="staff-new-goal" />
          <button type="submit" className="btn btn--ghost" disabled={busy !== null || !filled(draft)}>
            {busy === 'add' ? 'Adding…' : 'Add goal'}
          </button>
        </form>
      )}
    </div>
  );
}
