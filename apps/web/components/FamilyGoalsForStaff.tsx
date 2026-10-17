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
   never "no goals". */

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
    // A network failure (TypeError) says nothing the coach can act on.
    throw new Error(NOT_SAVED);
  }
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; item?: StaffFamilyGoal | null; error?: string };
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || NOT_SAVED);
  return payload.item ?? null;
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

  // One write at a time; the answer replaces (or, for a retire, removes) that goal.
  async function run(key: string, write: () => Promise<StaffFamilyGoal | null>, goalId?: string) {
    if (writing.current) return false;
    writing.current = true;
    setBusy(key);
    setNotice(null);
    try {
      const item = await write();
      setRead((current) => {
        if (current.state !== 'loaded' || current.athleteId !== athleteId) return current;
        if (!goalId) return item ? { ...current, items: [item, ...current.items] } : current;
        return {
          ...current,
          items: item
            ? current.items.map((goal) => (goal.goal_id === goalId ? item : goal))
            : current.items.filter((goal) => goal.goal_id !== goalId),
        };
      });
      return true;
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : NOT_SAVED);
      return false;
    } finally {
      writing.current = false;
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!filled(draft)) return;
    const saved = await run('add', () => send('POST', {
      athlete_id: athleteId, title: draft.title, support_action: draft.support, target_date: draft.target || null,
    }));
    if (saved) setDraft(EMPTY);
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !filled(editing.draft)) return;
    const { goalId, draft: edit } = editing;
    const saved = await run(goalId, () => send('PATCH', {
      goal_id: goalId, action: 'edit', title: edit.title, support_action: edit.support, target_date: edit.target || null,
    }), goalId);
    if (saved) setEditing(null);
  }

  if (!athleteId) return null;
  // What is on screen belongs to the athlete selected now, or it reads as loading.
  const shown: ReadState = read.state !== 'loading' && read.athleteId !== athleteId ? { state: 'loading' } : read;

  return (
    <div className="mt-[var(--s4)] space-y-[var(--s3)]">
      {/* PROPOSED copy: heading, loading, failed and empty lines. */}
      <h3 className="t-label">Family goals</h3>
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
            <li key={goal.goal_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)] space-y-[var(--s1)]">
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
                          onChange={(event) => void run(goal.goal_id,
                            () => send('PATCH', { goal_id: goal.goal_id, action: event.target.checked ? 'done' : 'undo' }), goal.goal_id)}
                        />
                        <span className="t-body">Done</span>
                      </label>
                      <button type="button" className="btn btn--ghost" aria-label={`Edit: ${goal.title}`}
                        disabled={busy !== null || editing !== null}
                        onClick={() => setEditing({ goalId: goal.goal_id, draft: { title: goal.title, support: goal.support_action, target: goal.target_date ?? '' } })}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--ghost" aria-label={`Retire: ${goal.title}`} disabled={busy !== null}
                        onClick={() => void run(goal.goal_id, () => send('PATCH', { goal_id: goal.goal_id, action: 'retire' }), goal.goal_id)}>
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
