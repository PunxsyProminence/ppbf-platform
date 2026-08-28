'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';

/*
 * A coach's multi-week plan for one athlete: writing one, reading it back,
 * and correcting it.
 *
 * WHAT THIS PAGE IS NOT, and the omissions are the point. There is no
 * workload score, no readiness-adjusted volume, no ACWR, no fatigue or
 * injury-risk number, no taper percentage, no periodization label inferred
 * from a date range, and no progress bar. A block is a coach's stated
 * intention over a window; every one of those would be this platform making a
 * training-science claim it has no evidence for, on a record about a child.
 *
 * Nothing advances on its own either. A block becomes 'active' or 'completed'
 * because a coach said so -- "the window has elapsed" and "the plan was
 * carried out" are different claims and only the second one is coaching.
 */

/** Mirrors AthleteDevelopmentBlockRow, which is what the route returns. */
interface DevelopmentBlock {
  block_id: string;
  athlete_id: string;
  title: string;
  training_emphasis: string;
  starts_on: string;
  ends_on: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

/** An option on the athlete picker, from GET /api/pilot/coach/athletes. */
interface AuthorizedAthlete {
  athlete_id: string;
  full_name: string;
}

const STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
type BlockStatus = (typeof STATUSES)[number];

/* The design system's four-rung ladder. A block's status is a planning state,
   not a safety state, so none of these wears a saturated safety rung:
   'cancelled' is filed, not restricted -- a coach abandoning a plan is not a
   participation block, and painting it like one is exactly the Law 2 confusion
   the readiness bands were cleaned up over. */
const STATUS_BADGE: Record<BlockStatus, { className: string; label: string }> = {
  draft: { className: 'badge--filed', label: 'Draft' },
  active: { className: 'badge--cleared', label: 'Active' },
  completed: { className: 'badge--monitor', label: 'Completed' },
  cancelled: { className: 'badge--filed', label: 'Cancelled' },
};

const EMPTY_FORM = {
  title: '',
  training_emphasis: '',
  starts_on: '',
  ends_on: '',
  status: 'draft' as BlockStatus,
};

export default function CoachDevelopmentBlocksPage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');

  const [blocks, setBlocks] = useState<DevelopmentBlock[]>([]);
  /* Four states, not two. 'idle' (no athlete chosen), 'loading', 'loaded'
     (possibly empty) and 'unavailable' (the read failed) stay distinct
     because an error rendered as an empty list reads as "this athlete has no
     plan", and a coach would write a second one over the top of the first. */
  const [blocksState, setBlocksState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('roster');
        const payload = (await response.json()) as { items?: AuthorizedAthlete[] };
        setAthletes(payload.items ?? []);
        setRosterState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        // An empty picker would read as "you have no athletes", which this
        // read did not establish.
        setAthletes([]);
        setRosterState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  const loadBlocks = useCallback(async (forAthleteId: string) => {
    if (!forAthleteId) {
      setBlocks([]);
      setBlocksState('idle');
      return;
    }
    setBlocksState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/development-blocks?athlete_id=${encodeURIComponent(forAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('blocks');
      const payload = (await response.json()) as { blocks?: DevelopmentBlock[] };
      setBlocks(payload.blocks ?? []);
      setBlocksState('loaded');
    } catch {
      setBlocks([]);
      setBlocksState('unavailable');
    }
  }, []);

  function selectAthlete(nextId: string) {
    setAthleteId(nextId);
    setEditingId(null);
    setMessage('');
    setErrorMessage('');
    void loadBlocks(nextId);
  }

  async function submitBlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A second click must not write a second plan. The guard is the busy flag
    // AND the disabled button, because a form can be submitted by keyboard
    // while a pointer is nowhere near the control.
    if (submitting || !athleteId) return;

    setSubmitting(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development-blocks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          title: form.title,
          training_emphasis: form.training_emphasis,
          starts_on: form.starts_on,
          ends_on: form.ends_on,
          status: form.status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The server's own words. A block refused for ending before it begins
        // must say that, not "something went wrong".
        setErrorMessage(payload.error ?? 'That block could not be saved.');
        return;
      }
      setForm(EMPTY_FORM);
      setMessage('Block saved.');
      // Read it back from the server rather than pushing the local copy into
      // the list: what is on screen should be what was stored.
      await loadBlocks(athleteId);
    } catch {
      setErrorMessage('That block could not be saved. Nothing was stored.');
    } finally {
      setSubmitting(false);
    }
  }

  function beginEdit(block: DevelopmentBlock) {
    setEditingId(block.block_id);
    setEditForm({
      title: block.title,
      training_emphasis: block.training_emphasis,
      starts_on: block.starts_on,
      ends_on: block.ends_on,
      status: block.status,
    });
    setMessage('');
    setErrorMessage('');
  }

  async function saveEdit(blockId: string) {
    if (editBusy) return;
    setEditBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development-blocks`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          block_id: blockId,
          title: editForm.title,
          training_emphasis: editForm.training_emphasis,
          starts_on: editForm.starts_on,
          ends_on: editForm.ends_on,
          status: editForm.status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That change could not be saved.');
        return;
      }
      setEditingId(null);
      setMessage('Block updated.');
      await loadBlocks(athleteId);
    } catch {
      setErrorMessage('That change could not be saved. The block is unchanged.');
    } finally {
      setEditBusy(false);
    }
  }

  const athleteName = athletes.find((item) => item.athlete_id === athleteId)?.full_name;

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/development-blocks"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Athlete Development</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">The Next Several Weeks</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            A development block is what you intend for one athlete over a window you choose, in your own
            words. The platform stores it and reads it back. It does not score it, grade it, or move it
            along on its own.
          </p>
          <Link href="/coach/session-scripts" className="btn btn--ghost mt-[var(--s4)]">
            Session Scripts
          </Link>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">Athlete</h2>

          <div className="field">
            <label htmlFor="blockAthlete" className="t-label">Which athlete</label>
            <select
              id="blockAthlete"
              value={athleteId}
              onChange={(event) => selectAthlete(event.target.value)}
              disabled={rosterState !== 'loaded' || athletes.length === 0}
              className="select"
            >
              <option value="">{rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}</option>
              {athletes.map((item) => (
                <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>
              ))}
            </select>
          </div>

          {rosterState === 'unavailable' && (
            <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
              <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                Your athletes could not be loaded, so there is nobody to choose. This is not a statement
                that you have none assigned — reload and try again.
              </p>
            </div>
          )}

          {rosterState === 'loaded' && athletes.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              You are not the coach of record for any athlete and hold no active coverage, so there is
              nobody to plan for. An administrator assigns athletes and grants coverage.
            </p>
          )}
        </section>

        {athleteId && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-eyebrow">New block{athleteName ? ` for ${athleteName}` : ''}</h2>

            <form onSubmit={submitBlock} className="space-y-[var(--s4)]">
              <div className="field">
                <label htmlFor="blockTitle" className="t-label">Title</label>
                <input
                  id="blockTitle"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  className="input"
                  placeholder="Winter technical block"
                />
              </div>

              <div className="field">
                <label htmlFor="blockEmphasis" className="t-label">Training emphasis</label>
                <textarea
                  id="blockEmphasis"
                  value={form.training_emphasis}
                  onChange={(event) => setForm({ ...form, training_emphasis: event.target.value })}
                  rows={3}
                  className="textarea"
                  placeholder="What this block is for, in your own words."
                />
              </div>

              <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="blockStart" className="t-label">Starts on</label>
                  <input
                    id="blockStart"
                    type="date"
                    value={form.starts_on}
                    onChange={(event) => setForm({ ...form, starts_on: event.target.value })}
                    className="input"
                  />
                </div>
                <div className="field">
                  <label htmlFor="blockEnd" className="t-label">Ends on</label>
                  <input
                    id="blockEnd"
                    type="date"
                    value={form.ends_on}
                    onChange={(event) => setForm({ ...form, ends_on: event.target.value })}
                    className="input"
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="blockStatus" className="t-label">Status</label>
                <select
                  id="blockStatus"
                  value={form.status}
                  onChange={(event) => setForm({ ...form, status: event.target.value as BlockStatus })}
                  className="select"
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>{STATUS_BADGE[status].label}</option>
                  ))}
                </select>
              </div>

              <button type="submit" disabled={submitting} className="btn disabled:cursor-not-allowed disabled:opacity-60">
                {submitting ? 'Saving...' : 'Save block'}
              </button>
            </form>

            {message ? <p className="t-data text-[color:var(--brass-300)]">{message}</p> : null}
            {errorMessage ? (
              <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{errorMessage}</p>
              </div>
            ) : null}
          </section>
        )}

        {athleteId && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-eyebrow">Blocks on record</h2>

            {blocksState === 'loading' && <p className="t-muted">Loading blocks...</p>}

            {blocksState === 'unavailable' && (
              <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                  This athlete&apos;s blocks could not be read. This is not a statement that they have none —
                  do not write a new one over a plan you cannot see.
                </p>
              </div>
            )}

            {blocksState === 'loaded' && blocks.length === 0 && (
              <p className="t-muted">No development block has been written for this athlete yet.</p>
            )}

            {blocksState === 'loaded' && blocks.length > 0 && (
              <ul className="space-y-[var(--s4)]">
                {blocks.map((block) => (
                  <li key={block.block_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s3)]">
                    <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                      <p className="t-body font-semibold">{block.title}</p>
                      <span className={`badge ${STATUS_BADGE[block.status].className}`}>
                        {STATUS_BADGE[block.status].label}
                      </span>
                    </div>
                    <p className="t-muted">
                      {formatGymDay(block.starts_on) ?? block.starts_on}
                      {' to '}
                      {formatGymDay(block.ends_on) ?? block.ends_on}
                    </p>
                    <p className="t-body text-[color:var(--bone-300)]">{block.training_emphasis}</p>
                    {/* Attribution, plainly. Who wrote this plan is a fact
                        about the past and no edit path can rewrite it. */}
                    <p className="t-muted">Written by {block.created_by_account_id}</p>

                    {editingId === block.block_id ? (
                      <div className="space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                        <div className="field">
                          <label htmlFor={`edit-title-${block.block_id}`} className="t-label">Title</label>
                          <input
                            id={`edit-title-${block.block_id}`}
                            value={editForm.title}
                            onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
                            className="input"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`edit-emphasis-${block.block_id}`} className="t-label">Training emphasis</label>
                          <textarea
                            id={`edit-emphasis-${block.block_id}`}
                            value={editForm.training_emphasis}
                            onChange={(event) => setEditForm({ ...editForm, training_emphasis: event.target.value })}
                            rows={3}
                            className="textarea"
                          />
                        </div>
                        <div className="grid gap-[var(--s3)] sm:grid-cols-2">
                          <div className="field">
                            <label htmlFor={`edit-start-${block.block_id}`} className="t-label">Starts on</label>
                            <input
                              id={`edit-start-${block.block_id}`}
                              type="date"
                              value={editForm.starts_on}
                              onChange={(event) => setEditForm({ ...editForm, starts_on: event.target.value })}
                              className="input"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`edit-end-${block.block_id}`} className="t-label">Ends on</label>
                            <input
                              id={`edit-end-${block.block_id}`}
                              type="date"
                              value={editForm.ends_on}
                              onChange={(event) => setEditForm({ ...editForm, ends_on: event.target.value })}
                              className="input"
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label htmlFor={`edit-status-${block.block_id}`} className="t-label">Status</label>
                          <select
                            id={`edit-status-${block.block_id}`}
                            value={editForm.status}
                            onChange={(event) => setEditForm({ ...editForm, status: event.target.value as BlockStatus })}
                            className="select"
                          >
                            {STATUSES.map((status) => (
                              <option key={status} value={status}>{STATUS_BADGE[status].label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex flex-wrap gap-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => void saveEdit(block.block_id)}
                            disabled={editBusy}
                            className="btn disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {editBusy ? 'Saving...' : 'Save changes'}
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} className="btn btn--ghost">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => beginEdit(block)} className="btn btn--ghost">
                        Edit block
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </RoleStandaloneView>
  );
}
