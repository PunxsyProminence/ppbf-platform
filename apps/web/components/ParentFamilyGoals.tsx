'use client';

import React, { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDate, formatGymDay } from '@/src/lib/gymTime';

/* FAMILY GOALS for one child (#1593, PH-06): what the family will do to
   support the child, from /api/pilot/parent/family-goals.

   This guardian's own goals and the goals the gym's staff set; never the other
   guardian's (the server decides). Progress is a recorded event: "Done" with
   the date it was ticked, or "In progress" -- no percentage. A guardian ticks,
   edits and retires only goals they set; a staff goal shows its state and is
   read-only here (PH-06 Q-2 A), because a tick on a shared goal would show one
   guardian what the other did.

   Mounted per child (key = the child's id), so a draft or an answer for one
   child never lands on a sibling. A read that did not answer says so; it is
   never "no goals". Everything shown comes from the server's answer. */

export interface FamilyGoalItem {
  goal_id: string;
  title: string;
  support_action: string;
  target_date: string | null;
  state: 'active' | 'completed';
  completed_at: string | null;
  set_by: string;
  mine: boolean;
}

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: FamilyGoalItem[] };

interface Draft {
  title: string;
  support: string;
  target: string;
}

const EMPTY: Draft = { title: '', support: '', target: '' };
const URL_PATH = '/api/pilot/parent/family-goals';

async function send(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  const response = await fetch(`${apiBase()}${URL_PATH}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; item?: FamilyGoalItem | null; error?: string };
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || 'The goal was not saved.');
  }
  return payload.item ?? null;
}

function GoalFields({ draft, onChange, idPrefix }: Readonly<{ draft: Draft; onChange: (draft: Draft) => void; idPrefix: string }>) {
  return (
    <>
      <label className="block t-label" htmlFor={`${idPrefix}-title`}>Goal</label>
      <input id={`${idPrefix}-title`} className="input w-full" maxLength={200} value={draft.title}
        onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      <label className="block t-label" htmlFor={`${idPrefix}-support`}>What the family will do</label>
      <textarea id={`${idPrefix}-support`} className="input w-full" rows={2} maxLength={500} value={draft.support}
        onChange={(event) => onChange({ ...draft, support: event.target.value })} />
      <label className="block t-label" htmlFor={`${idPrefix}-target`}>Target date (optional)</label>
      <input id={`${idPrefix}-target`} type="date" className="input" value={draft.target}
        onChange={(event) => onChange({ ...draft, target: event.target.value })} />
    </>
  );
}

export default function ParentFamilyGoals({ athleteId }: Readonly<{ athleteId: string }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ goalId: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The guard itself: state set by one click is not seen by a second click
  // in the same tick, a ref is.
  const writing = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}${URL_PATH}?athlete_id=${encodeURIComponent(athleteId)}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (controller.signal.aborted) return;
        setRead(response.ok && Array.isArray(payload.items)
          ? { state: 'loaded', items: payload.items as FamilyGoalItem[] }
          : { state: 'failed' });
      } catch {
        if (!controller.signal.aborted) setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  // One write at a time; the answer replaces (or, for a retire, removes) that goal.
  async function run(key: string, write: () => Promise<FamilyGoalItem | null>, goalId?: string) {
    if (writing.current) return false;
    writing.current = true;
    setBusy(key);
    setNotice(null);
    try {
      const item = await write();
      setRead((current) => {
        if (current.state !== 'loaded') return current;
        if (!goalId) return item ? { state: 'loaded', items: [item, ...current.items] } : current;
        return {
          state: 'loaded',
          items: item
            ? current.items.map((goal) => (goal.goal_id === goalId ? item : goal))
            : current.items.filter((goal) => goal.goal_id !== goalId),
        };
      });
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The goal was not saved.');
      return false;
    } finally {
      writing.current = false;
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const saved = await run('add', () => send('POST', {
      athlete_id: athleteId, title: draft.title, support_action: draft.support, target_date: draft.target || null,
    }));
    if (saved) setDraft(EMPTY);
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const { goalId, draft: edit } = editing;
    const saved = await run(goalId, () => send('PATCH', {
      goal_id: goalId, action: 'edit', title: edit.title, support_action: edit.support, target_date: edit.target || null,
    }), goalId);
    if (saved) setEditing(null);
  }

  return (
    <div className="space-y-[var(--s4)]">
      {notice && <p role="alert" className="t-body font-bold text-[var(--restricted-ink)]">{notice}</p>}

      {read.state === 'loading' ? (
        <p className="t-muted">Loading…</p>
      ) : read.state === 'failed' ? (
        <p role="alert" className="t-body">Family goals could not be loaded. This is not a statement that there are none.</p>
      ) : read.items.length === 0 ? (
        <p className="t-muted">No family goals yet. Add one below.</p>
      ) : (
        <ul className="space-y-[var(--s4)]" aria-label="Family goals">
          {read.items.map((goal) => (
            <li key={goal.goal_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s2)]">
              {editing?.goalId === goal.goal_id ? (
                <form onSubmit={(event) => void saveEdit(event)} className="space-y-[var(--s2)]" aria-label={`Edit ${goal.title}`}>
                  <GoalFields draft={editing.draft} idPrefix={`edit-${goal.goal_id}`}
                    onChange={(next) => setEditing({ goalId: goal.goal_id, draft: next })} />
                  <div className="flex gap-[var(--s2)]">
                    <button type="submit" className="btn" disabled={busy !== null}>Save</button>
                    <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex justify-between items-start gap-[var(--s3)]">
                    <h4 className="t-body font-semibold">{goal.title}</h4>
                    {goal.target_date && <span className="t-muted">By {formatGymDay(goal.target_date) ?? goal.target_date}</span>}
                  </div>
                  <p className="t-body">{goal.support_action}</p>
                  <p className="t-muted">Set by {goal.set_by}</p>
                  <p className="t-label">
                    {goal.state === 'completed'
                      ? `Done ${goal.completed_at ? formatGymDate(goal.completed_at) ?? '' : ''}`.trim()
                      : 'In progress'}
                  </p>
                  {goal.mine && (
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <label className="inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s2)]">
                        <input
                          type="checkbox"
                          className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                          checked={goal.state === 'completed'}
                          disabled={busy !== null}
                          onChange={(event) => void run(goal.goal_id,
                            () => send('PATCH', { goal_id: goal.goal_id, action: event.target.checked ? 'done' : 'undo' }), goal.goal_id)}
                        />
                        <span className="t-body">Done</span>
                      </label>
                      <button type="button" className="btn btn--ghost" disabled={busy !== null}
                        onClick={() => setEditing({ goalId: goal.goal_id, draft: { title: goal.title, support: goal.support_action, target: goal.target_date ?? '' } })}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--ghost" disabled={busy !== null}
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
          loaded would have nowhere to show, and would be added twice. */}
      {read.state === 'loaded' && (
        <form onSubmit={(event) => void add(event)} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s2)]" aria-label="Add a family goal">
          <h4 className="t-label">Add a family goal</h4>
          <GoalFields draft={draft} onChange={setDraft} idPrefix="new-goal" />
          <button type="submit" className="btn" disabled={busy !== null || !draft.title.trim() || !draft.support.trim()}>
            Add goal
          </button>
        </form>
      )}
    </div>
  );
}
