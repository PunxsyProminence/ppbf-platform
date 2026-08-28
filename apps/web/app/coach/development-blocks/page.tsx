'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * What a block is preparing for, resolved by the route.
 *
 * A NAME AND A DATE. Both competition surfaces are skeletal by owner decision
 * -- no brackets, no weight classes, no qualification rules -- so there is
 * nothing here to build a taper, a peak or a weight plan from, and this page
 * builds none. `sanctioning_body` is null for a wrestling league event because
 * that table HAS NO SUCH COLUMN; the panel says nothing rather than inventing
 * a body, which is exactly what "where stored" means.
 */
interface BlockTarget {
  kind: 'competition' | 'wrestling_event';
  id: string;
  name: string;
  date: string;
  location: string;
  sanctioning_body: string | null;
  status: 'planned' | 'completed' | 'cancelled';
}

/** Mirrors AthleteDevelopmentBlockRow, which is what the route returns. */
interface DevelopmentBlock {
  block_id: string;
  athlete_id: string;
  title: string;
  training_emphasis: string;
  starts_on: string;
  ends_on: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  target_competition_id: string | null;
  target_wrestling_event_id: string | null;
  target: BlockTarget | null;
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

/* An EVENT's status, which is a different vocabulary from a block's and gets
   its own map rather than sharing one. A cancelled event is the case this
   whole panel has to get right: the block stays pointed at it and the
   cancellation is stated, because a coach who cannot tell a cancelled target
   from one that was never chosen will plan around a show that is not
   happening. 'restricted' rather than the safeguarding red -- a called-off
   fixture is not a participation block. */
const EVENT_STATUS_BADGE: Record<BlockTarget['status'], { className: string; label: string }> = {
  planned: { className: 'badge--cleared', label: 'Planned' },
  completed: { className: 'badge--monitor', label: 'Completed' },
  cancelled: { className: 'badge--restricted', label: 'Cancelled' },
};

const TARGET_KIND_LABEL: Record<BlockTarget['kind'], string> = {
  competition: 'Competition',
  wrestling_event: 'Wrestling event',
};

const EMPTY_FORM = {
  title: '',
  training_emphasis: '',
  starts_on: '',
  ends_on: '',
  status: 'draft' as BlockStatus,
};

/** One row of pilot.athlete_development_block_objectives, as the route returns it. */
interface BlockObjective {
  objective_id: string;
  block_id: string;
  domain: string;
  objective: string;
  status: BlockStatus;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

/*
 * HUMAN LABELS FOR THE TEN FULL SPECTRUM DOMAINS.
 *
 * The vocabulary itself is NOT duplicated here. The ten values are owned by
 * the migration's CHECK constraint and served by the route
 * (?domains=options), so this screen offers exactly what the database will
 * accept and cannot drift into offering a value the write would refuse --
 * the failure mode SMART_GOAL_CATEGORIES in AthleteWorkspace.tsx has to guard
 * against with a test, avoided here by not holding a copy at all.
 *
 * What IS local is presentation, which is where it belongs. The map is keyed
 * by the stored value, and coachDevelopmentBlockObjectives' own test asserts
 * its keys are exactly FULL_SPECTRUM_DOMAINS -- so a domain added to the
 * migration without a label here fails a test rather than rendering to a
 * coach as a raw snake_case slug.
 */
export const DOMAIN_LABEL: Record<string, string> = {
  technical: 'Technical',
  physical: 'Physical',
  conditioning: 'Conditioning',
  mental: 'Mental',
  recovery_load: 'Recovery & load',
  sparring_live_progression: 'Sparring & live progression',
  competition_preparation: 'Competition preparation',
  tactical_film_study: 'Tactical & film study',
  lifestyle_athlete_identity: 'Lifestyle & athlete identity',
  nutrition_body_composition: 'Nutrition & body composition',
};

/** A domain with no label yet reads as itself rather than as nothing. */
function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

const EMPTY_OBJECTIVE_FORM = { domain: '', objective: '', status: 'draft' as BlockStatus };

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
  /* Which athlete the panel below is FOR, as opposed to which one was asked
     about. A slow read for the athlete a coach just navigated away from must
     never land under the one they navigated to: the block cards carry no
     athlete name, and their edit and target controls submit only a block id,
     so a coach authorised for both children would be editing A's plan while
     the picker says B and nothing on screen would disagree.

     Same guard and same reason as CoachWorkspace's reviewAthleteRef, which
     this file should have copied in the first place. Found by review on
     #771. */
  const blocksAthleteRef = useRef('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  /* The events a coach may aim a block at. Organization fixtures, so this is
     loaded once rather than per athlete. Three states for the usual reason:
     an empty picker must not be the rendering of a failed read. */
  const [targetOptions, setTargetOptions] = useState<BlockTarget[]>([]);
  const [targetOptionsState, setTargetOptionsState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [targetBusyId, setTargetBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editBusy, setEditBusy] = useState(false);

  /* OBJECTIVES ARE LOADED PER BLOCK, ON DEMAND.
     A coach with a dozen blocks on screen has no use for a dozen extra reads,
     and each one is a separate authorization decision at the route. Only the
     opened block is fetched.

     Keyed by block id rather than held as one list, because two blocks can be
     open in sequence and an answer for the first must never render under the
     second -- the same failure blocksAthleteRef exists to prevent one level
     up. Here the block id IS the key, so a late answer lands in its own slot
     and is simply not the one being rendered. */
  const [openObjectivesId, setOpenObjectivesId] = useState<string | null>(null);
  const [objectivesByBlock, setObjectivesByBlock] = useState<Record<string, BlockObjective[]>>({});
  const [objectivesState, setObjectivesState] = useState<
    Record<string, 'loading' | 'loaded' | 'unavailable'>
  >({});
  const [objectiveForm, setObjectiveForm] = useState(EMPTY_OBJECTIVE_FORM);
  const [objectiveBusy, setObjectiveBusy] = useState(false);
  const [objectiveMovingId, setObjectiveMovingId] = useState<string | null>(null);

  /* The domain vocabulary, from the server. Not a local constant: the ten
     values belong to the migration's CHECK, and a screen offering an eleventh
     would fail the write with a database error a coach cannot act on. Three
     states for the usual reason -- an empty picker must not be the rendering
     of a failed read. */
  const [domains, setDomains] = useState<string[]>([]);
  const [domainsState, setDomainsState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/development-blocks?targets=options`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('targets');
        const payload = (await response.json()) as { options?: BlockTarget[] };
        setTargetOptions(payload.options ?? []);
        setTargetOptionsState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        // Not "your gym has no competitions on the calendar" -- this read did
        // not establish that, and a coach reading it would stop looking.
        setTargetOptions([]);
        setTargetOptionsState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/development-block-objectives?domains=options`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (!response.ok) throw new Error('domains');
        const payload = (await response.json()) as { domains?: string[] };
        setDomains(payload.domains ?? []);
        setDomainsState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setDomains([]);
        setDomainsState('unavailable');
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
      // The selection may have moved on while this was in flight. Dropping a
      // stale answer is right even though it means the panel keeps waiting:
      // the request for the CURRENT athlete is still coming.
      if (blocksAthleteRef.current !== forAthleteId) return;
      setBlocks(payload.blocks ?? []);
      setBlocksState('loaded');
    } catch {
      // A failure for an athlete nobody is looking at any more must not blank
      // the panel belonging to the one they are.
      if (blocksAthleteRef.current !== forAthleteId) return;
      setBlocks([]);
      setBlocksState('unavailable');
    }
  }, []);

  const loadObjectives = useCallback(async (blockId: string) => {
    setObjectivesState((prev) => ({ ...prev, [blockId]: 'loading' }));
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/development-block-objectives?block_id=${encodeURIComponent(blockId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('objectives');
      const payload = (await response.json()) as { objectives?: BlockObjective[] };
      setObjectivesByBlock((prev) => ({ ...prev, [blockId]: payload.objectives ?? [] }));
      setObjectivesState((prev) => ({ ...prev, [blockId]: 'loaded' }));
    } catch {
      /* Not an empty list. "This block has no objectives yet" and "the read
         failed" are different facts, and a coach shown the first when the
         second happened would write a second copy of a plan that is already
         there. */
      setObjectivesState((prev) => ({ ...prev, [blockId]: 'unavailable' }));
    }
  }, []);

  function toggleObjectives(blockId: string) {
    if (openObjectivesId === blockId) {
      setOpenObjectivesId(null);
      return;
    }
    setOpenObjectivesId(blockId);
    setObjectiveForm(EMPTY_OBJECTIVE_FORM);
    setMessage('');
    setErrorMessage('');
    // Re-read on every open rather than trusting a cached list: another coach
    // may have added one, and this panel is where a coach decides what is
    // still missing.
    void loadObjectives(blockId);
  }

  async function submitObjective(event: React.FormEvent<HTMLFormElement>, blockId: string) {
    event.preventDefault();
    if (objectiveBusy) return;

    setObjectiveBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development-block-objectives`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          block_id: blockId,
          domain: objectiveForm.domain,
          objective: objectiveForm.objective,
          status: objectiveForm.status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The server's own words again. An objective refused for a blank
        // sentence must say so rather than "something went wrong".
        setErrorMessage(payload.error ?? 'That objective could not be saved.');
        return;
      }
      setObjectiveForm(EMPTY_OBJECTIVE_FORM);
      setMessage('Objective saved.');
      await loadObjectives(blockId);
    } catch {
      setErrorMessage('That objective could not be saved. Nothing was stored.');
    } finally {
      setObjectiveBusy(false);
    }
  }

  async function moveObjective(blockId: string, objectiveId: string, status: BlockStatus) {
    if (objectiveMovingId) return;

    setObjectiveMovingId(objectiveId);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development-block-objectives`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective_id: objectiveId, status }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That objective could not be moved.');
        return;
      }
      setMessage('Objective updated.');
      await loadObjectives(blockId);
    } catch {
      setErrorMessage('That objective could not be moved. Nothing was stored.');
    } finally {
      setObjectiveMovingId(null);
    }
  }

  function selectAthlete(nextId: string) {
    // Set BEFORE the read starts, so an answer for the previous athlete that
    // arrives afterwards can recognise itself as stale.
    blocksAthleteRef.current = nextId;
    setAthleteId(nextId);
    /* No setBlocks([]) here, deliberately. loadBlocks moves the panel to
       'loading' immediately and the list renders only in 'loaded', so the
       previous athlete's blocks are already off screen for the whole flight
       of the new read. A clear here would be a second mechanism for the same
       property -- and a mutation test proved it redundant: removing it broke
       nothing, because the state machine was doing the work. */
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

  /* Setting or clearing what a block is preparing for. Its own request rather
     than a field on the edit form: clearing a target and leaving it alone are
     different intentions, and the route distinguishes them by whether the
     `target` key is present at all. */
  async function setTarget(blockId: string, choice: string) {
    if (targetBusyId) return;
    setTargetBusyId(blockId);
    setMessage('');
    setErrorMessage('');
    try {
      const option = targetOptions.find((item) => `${item.kind}:${item.id}` === choice);
      const response = await fetch(`${apiBase()}/api/pilot/coach/development-blocks`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          block_id: blockId,
          // null clears it. An option the server did not offer cannot be
          // composed here: the value is looked up in the list it came from.
          target: option ? { kind: option.kind, id: option.id } : null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That target could not be saved.');
        return;
      }
      setMessage(option ? 'Target saved.' : 'Target cleared.');
      await loadBlocks(athleteId);
    } catch {
      setErrorMessage('That target could not be saved. The block is unchanged.');
    } finally {
      setTargetBusyId(null);
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

                    {/* WHAT THIS BLOCK IS PREPARING FOR.

                        A name, a date, where it is, who sanctions it if
                        anyone recorded that, and whether it is still
                        happening. Nothing else, and nothing derived: no
                        countdown driving a taper, no "weeks out" figure, no
                        peak week. Both competition surfaces are skeletal by
                        owner decision and carry nothing such a number could
                        honestly be built from. */}
                    <div className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s2)]">
                      <p className="t-label m-0">Preparing for</p>

                      {block.target ? (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                            <p className="t-body m-0 font-semibold">{block.target.name}</p>
                            <span className={`badge ${EVENT_STATUS_BADGE[block.target.status].className}`}>
                              {EVENT_STATUS_BADGE[block.target.status].label}
                            </span>
                          </div>
                          <p className="t-muted m-0">
                            {TARGET_KIND_LABEL[block.target.kind]}
                            {' · '}
                            {formatGymDay(block.target.date) ?? block.target.date}
                            {/* Location and sanctioning body are shown ONLY
                                where they are stored. A wrestling league event
                                has no sanctioning_body column at all, and both
                                tables default location to an empty string, so
                                a blank is an absence and renders as nothing
                                rather than as an empty field. */}
                            {block.target.location ? ` · ${block.target.location}` : ''}
                            {block.target.sanctioning_body ? ` · ${block.target.sanctioning_body}` : ''}
                          </p>
                          {block.target.status === 'cancelled' && (
                            <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                              This event was cancelled. The block is still pointed at it — change or clear the
                              target if the plan has moved.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="t-muted m-0">No event named. This block is a date range of its own.</p>
                      )}

                      {targetOptionsState === 'unavailable' && (
                        <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                          The gym&apos;s competitions and events could not be loaded, so there is nothing to
                          choose from. This is not a statement that none are scheduled.
                        </p>
                      )}

                      {targetOptionsState === 'loaded' && targetOptions.length === 0 && (
                        <p className="t-muted m-0">
                          No competition or league event has been recorded for this gym yet, so there is
                          nothing to aim a block at.
                        </p>
                      )}

                      {targetOptionsState === 'loaded' && targetOptions.length > 0 && (
                        <div className="field">
                          <label htmlFor={`target-${block.block_id}`} className="t-label">
                            Change what this block is preparing for
                          </label>
                          <select
                            id={`target-${block.block_id}`}
                            value={block.target ? `${block.target.kind}:${block.target.id}` : ''}
                            onChange={(event) => void setTarget(block.block_id, event.target.value)}
                            disabled={targetBusyId !== null}
                            className="select"
                          >
                            <option value="">No event</option>
                            {targetOptions.map((option) => (
                              <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>
                                {option.name}
                                {' — '}
                                {formatGymDay(option.date) ?? option.date}
                                {/* A cancelled fixture stays selectable and
                                    says so: a coach retargeting away from one
                                    has to be able to see which it was. */}
                                {option.status === 'cancelled' ? ' (cancelled)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

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

                    {/* WHAT THIS BLOCK IS TRYING TO MOVE.
                        One row per Full Spectrum domain, in the coach's own
                        words. Deliberately NOT summarised: there is no "3 of 5
                        complete", no proportion and no grade anywhere in this
                        panel, because whether a block went well is a coach's
                        judgment and a count is not it. */}
                    <div className="space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                      <button
                        type="button"
                        onClick={() => toggleObjectives(block.block_id)}
                        aria-expanded={openObjectivesId === block.block_id}
                        className="btn btn--ghost"
                      >
                        {openObjectivesId === block.block_id ? 'Hide objectives' : 'Objectives'}
                      </button>

                      {openObjectivesId === block.block_id && (
                        <div className="space-y-[var(--s4)]">
                          {objectivesState[block.block_id] === 'loading' && (
                            <p className="t-muted m-0">Loading objectives...</p>
                          )}

                          {objectivesState[block.block_id] === 'unavailable' && (
                            <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                              This block&apos;s objectives could not be loaded. This is not a statement that
                              it has none — reload and try again before writing new ones.
                            </p>
                          )}

                          {objectivesState[block.block_id] === 'loaded'
                            && (objectivesByBlock[block.block_id] ?? []).length === 0 && (
                            <p className="t-muted m-0">
                              Nothing recorded yet. This block says what it is for; an objective says what
                              it is trying to move, one domain at a time.
                            </p>
                          )}

                          {objectivesState[block.block_id] === 'loaded'
                            && (objectivesByBlock[block.block_id] ?? []).length > 0 && (
                            <ul className="space-y-[var(--s3)] list-none p-0 m-0">
                              {(objectivesByBlock[block.block_id] ?? []).map((item) => (
                                <li
                                  key={item.objective_id}
                                  className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s3)] space-y-[var(--s2)]"
                                >
                                  <div className="flex flex-wrap items-center gap-[var(--s3)]">
                                    <span className="t-label">{domainLabel(item.domain)}</span>
                                    <span className={`badge ${STATUS_BADGE[item.status].className}`}>
                                      {STATUS_BADGE[item.status].label}
                                    </span>
                                  </div>
                                  {/* The coach's sentence, read back exactly as
                                      written. Nothing parses it, classifies it
                                      or shortens it. */}
                                  <p className="t-body m-0 whitespace-pre-wrap">{item.objective}</p>
                                  <div className="field">
                                    {/* "Objective status", not "Status": the
                                        new-block form above carries a Status
                                        field of its own, and several
                                        objectives can be on screen at once.
                                        A screen reader announcing four
                                        identical "Status" labels names none
                                        of them. */}
                                    <label htmlFor={`obj-status-${item.objective_id}`} className="t-label">
                                      Objective status
                                    </label>
                                    <select
                                      id={`obj-status-${item.objective_id}`}
                                      value={item.status}
                                      onChange={(event) => void moveObjective(
                                        block.block_id,
                                        item.objective_id,
                                        event.target.value as BlockStatus,
                                      )}
                                      disabled={objectiveMovingId !== null}
                                      className="select"
                                    >
                                      {STATUSES.map((status) => (
                                        <option key={status} value={status}>{STATUS_BADGE[status].label}</option>
                                      ))}
                                    </select>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          {domainsState === 'unavailable' && (
                            <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                              The development domains could not be loaded, so there is nothing to choose
                              from. Reload before writing an objective.
                            </p>
                          )}

                          {domainsState === 'loaded' && domains.length > 0 && (
                            <form
                              onSubmit={(event) => void submitObjective(event, block.block_id)}
                              className="space-y-[var(--s3)]"
                            >
                              <div className="field">
                                <label htmlFor={`obj-domain-${block.block_id}`} className="t-label">
                                  Domain
                                </label>
                                <select
                                  id={`obj-domain-${block.block_id}`}
                                  value={objectiveForm.domain}
                                  onChange={(event) => setObjectiveForm({
                                    ...objectiveForm, domain: event.target.value,
                                  })}
                                  className="select"
                                >
                                  <option value="">Choose a domain</option>
                                  {domains.map((domain) => (
                                    <option key={domain} value={domain}>{domainLabel(domain)}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label htmlFor={`obj-text-${block.block_id}`} className="t-label">
                                  What this is trying to move
                                </label>
                                <textarea
                                  id={`obj-text-${block.block_id}`}
                                  value={objectiveForm.objective}
                                  onChange={(event) => setObjectiveForm({
                                    ...objectiveForm, objective: event.target.value,
                                  })}
                                  rows={2}
                                  className="textarea"
                                  placeholder="In your own words."
                                />
                              </div>
                              <button
                                type="submit"
                                disabled={objectiveBusy}
                                className="btn disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {objectiveBusy ? 'Saving...' : 'Add objective'}
                              </button>
                            </form>
                          )}
                        </div>
                      )}
                    </div>
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
