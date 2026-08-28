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

/**
 * A delivered session a coach says supported this block, with the run's OWN
 * recorded account of itself.
 *
 * WHAT THE RUN WROTE, VERBATIM. deviation_note, what_worked and what_did_not
 * are the coach's own words about that session, already stored on the run;
 * this panel shows them and computes nothing from them. There is no session
 * count, no "sessions delivered against plan", no coverage bar and no
 * adherence figure. Plan-versus-actual now has its own panel below, and it
 * did not change that rule: it counts RECORDS ("3 sessions recorded"), never
 * records against a plan, because there is no denominator anywhere that could
 * honestly produce one.
 */
interface LinkedSession {
  run_id: string;
  script_id: string;
  script_name: string;
  delivered_on: string;
  delivered_by_account_id: string;
  run_state: string | null;
  athletes_present: number | null;
  blocks_completed: number | null;
  deviation_note: string;
  what_worked: string;
  what_did_not: string;
  linked_by_account_id: string;
  linked_at: string;
}

/**
 * One of the block's Full Spectrum objectives, and one link saying a session
 * addressed it. Kept as two flat lists rather than a nested structure,
 * matching what the route returns and for the same reason: an objective with
 * no links must stay visibly an objective with no RECORDED links. Nested,
 * it would be indistinguishable from one a join dropped -- and a domain
 * showing nothing is not evidence that the domain was neglected.
 */
interface BlockObjective {
  objective_id: string;
  block_id: string;
  domain: string;
  objective: string;
  status: string;
}

interface ObjectiveLink {
  run_id: string;
  objective_id: string;
  linked_by_account_id: string;
}

/**
 * A coach's dated judgement about how a block went. The whole of it is words
 * and one chosen state; there is no figure on this type and none may be added.
 */
interface BlockReview {
  review_id: string;
  block_id: string;
  adherence_state: string;
  deviations: string;
  reason: string;
  what_worked: string;
  what_did_not: string;
  next_adjustment: string;
  reviewed_by_account_id: string;
  created_at: string;
}

/**
 * One source's contribution to "what was actually recorded".
 *
 * `recorded` IS A COUNT OF ROWS AND NOTHING ELSE. It says how many records
 * exist, never how much of the plan happened -- those are different claims and
 * only the first one has evidence. A zero means nobody wrote anything down.
 *
 * `undated` is rows this athlete has that carry NO event date -- an assessment
 * scheduled and never administered, an intervention that has not started. No
 * window can place them, so they are shown apart from the count rather than
 * folded into it (which would claim work that has not happened) or dropped
 * (which would hide records that exist).
 */
interface EvidenceSource {
  key: string;
  label: string;
  recorded: number;
  undated: number;
  recent: { when: string; detail: string }[];
}

/** A settled session offered by the picker. */
interface SelectableRun {
  run_id: string;
  script_id: string;
  script_name: string;
  delivered_on: string;
  run_state: string | null;
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

/* The five states the build order named, which are pilot.intervention_executions'
   own vocabulary rather than a second one invented here. 'unknown' leads the
   list and is the default because a coach who has not decided has not decided
   -- and because a default of 'delivered_as_planned' would make the easiest
   click the most flattering one. */
const ADHERENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'unknown', label: 'Unknown (honest default)' },
  { value: 'delivered_as_planned', label: 'Delivered as planned' },
  { value: 'delivered_with_deviations', label: 'Delivered with deviations' },
  { value: 'under_delivered', label: 'Under-delivered' },
  { value: 'not_delivered', label: 'Not delivered' },
];

const ADHERENCE_LABEL: Record<string, string> = Object.fromEntries(
  ADHERENCE_OPTIONS.map((option) => [option.value, option.label]),
);

const EMPTY_REVIEW_FORM = {
  adherence_state: 'unknown',
  deviations: '',
  reason: '',
  what_worked: '',
  what_did_not: '',
  next_adjustment: '',
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

  /* The sessions each block was worked in, keyed by block id, with a state
     per block rather than one for the panel as a whole: these are separate
     reads and one failing must not make the others render as "no sessions".
     A block missing from the state map has not been read yet. */
  const [sessionsByBlock, setSessionsByBlock] = useState<Record<string, LinkedSession[]>>({});
  const [sessionsStateByBlock, setSessionsStateByBlock] =
    useState<Record<string, 'loading' | 'loaded' | 'unavailable'>>({});
  /* The sessions a coach may attach. Organization fixtures carrying no
     athlete id, so this is loaded once rather than per block or per athlete --
     the same reasoning the competition picker records. */
  const [runOptions, setRunOptions] = useState<SelectableRun[]>([]);
  const [runOptionsState, setRunOptionsState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [linkBusyBlockId, setLinkBusyBlockId] = useState<string | null>(null);
  /* The block's objectives and the links against them, per block and with
     their own state, for the same reason the sessions have one: one block's
     failed read must not make another's render as "nothing recorded". */
  const [objectivesByBlock, setObjectivesByBlock] = useState<Record<string, BlockObjective[]>>({});
  const [objectiveLinksByBlock, setObjectiveLinksByBlock] = useState<Record<string, ObjectiveLink[]>>({});
  const [objectivesStateByBlock, setObjectivesStateByBlock] =
    useState<Record<string, 'loading' | 'loaded' | 'unavailable'>>({});
  const [objectiveBusyKey, setObjectiveBusyKey] = useState<string | null>(null);

  /* Plan versus what was actually recorded, per block. Two halves kept in two
     places on purpose: `reviewsByBlock` is what a human said, `evidenceByBlock`
     is what is on record elsewhere, and nothing on this page joins them into a
     verdict. */
  const [reviewsByBlock, setReviewsByBlock] = useState<Record<string, BlockReview[]>>({});
  const [evidenceByBlock, setEvidenceByBlock] = useState<Record<string, EvidenceSource[]>>({});
  const [reviewStateByBlock, setReviewStateByBlock] =
    useState<Record<string, 'loading' | 'loaded' | 'unavailable'>>({});
  const [reviewForms, setReviewForms] = useState<Record<string, typeof EMPTY_REVIEW_FORM>>({});
  const [reviewBusyBlockId, setReviewBusyBlockId] = useState<string | null>(null);

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
        const response = await fetch(`${apiBase()}/api/pilot/coach/session-block-links?runs=options`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('runs');
        const payload = (await response.json()) as { runs?: SelectableRun[] };
        setRunOptions(payload.runs ?? []);
        setRunOptionsState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        // Not "no sessions have been delivered here" -- this read did not
        // establish that, and a coach reading it would stop looking.
        setRunOptions([]);
        setRunOptionsState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  /* The sessions one block was worked in.
   *
   * Read per block rather than in one sweep because the route gates each
   * block on its own athlete: one call per block is what the authorization
   * boundary actually is, and batching would mean inventing a bulk endpoint
   * whose gate is a different shape. A failure marks THAT block unavailable
   * and leaves the others alone. */
  const loadSessionsForBlock = useCallback(async (blockId: string) => {
    setSessionsStateByBlock((prior) => ({ ...prior, [blockId]: 'loading' }));
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/session-block-links?block_id=${encodeURIComponent(blockId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('sessions');
      const payload = (await response.json()) as { sessions?: LinkedSession[] };
      setSessionsByBlock((prior) => ({ ...prior, [blockId]: payload.sessions ?? [] }));
      setSessionsStateByBlock((prior) => ({ ...prior, [blockId]: 'loaded' }));
    } catch {
      // An empty list here would read as "no session has worked this plan",
      // which is a claim about the coach's own delivery that this failed read
      // did not establish.
      setSessionsByBlock((prior) => ({ ...prior, [blockId]: [] }));
      setSessionsStateByBlock((prior) => ({ ...prior, [blockId]: 'unavailable' }));
    }
  }, []);

  /* One read per block gives both halves: what the block is trying to move,
     and which sessions a coach says worked on each. The route gates on the
     block, so one call per block is what the authorization boundary is. */
  const loadObjectivesForBlock = useCallback(async (blockId: string) => {
    setObjectivesStateByBlock((prior) => ({ ...prior, [blockId]: 'loading' }));
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/session-objective-links?block_id=${encodeURIComponent(blockId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('objectives');
      const payload = (await response.json()) as {
        objectives?: BlockObjective[];
        links?: ObjectiveLink[];
      };
      setObjectivesByBlock((prior) => ({ ...prior, [blockId]: payload.objectives ?? [] }));
      setObjectiveLinksByBlock((prior) => ({ ...prior, [blockId]: payload.links ?? [] }));
      setObjectivesStateByBlock((prior) => ({ ...prior, [blockId]: 'loaded' }));
    } catch {
      // Not "this block has no objectives" -- that is a statement about the
      // plan which this failed read did not establish.
      setObjectivesByBlock((prior) => ({ ...prior, [blockId]: [] }));
      setObjectiveLinksByBlock((prior) => ({ ...prior, [blockId]: [] }));
      setObjectivesStateByBlock((prior) => ({ ...prior, [blockId]: 'unavailable' }));
    }
  }, []);

  /* One read gives both halves of plan-versus-actual for a block.
     
     A FAILURE IS A FAILURE, NOT AN EMPTY RECORD. Every other loader on this
     page says so; here it is the difference between "nobody logged anything"
     and "nobody could look", and those two look identical the moment a failed
     read is allowed to render as zeroes. So the sources are cleared and the
     panel says it could not read them. */
  const loadReviewForBlock = useCallback(async (blockId: string) => {
    setReviewStateByBlock((prior) => ({ ...prior, [blockId]: 'loading' }));
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/block-review?block_id=${encodeURIComponent(blockId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('review');
      const payload = (await response.json()) as {
        reviews?: BlockReview[];
        evidence?: EvidenceSource[];
      };
      setReviewsByBlock((prior) => ({ ...prior, [blockId]: payload.reviews ?? [] }));
      setEvidenceByBlock((prior) => ({ ...prior, [blockId]: payload.evidence ?? [] }));
      setReviewStateByBlock((prior) => ({ ...prior, [blockId]: 'loaded' }));
    } catch {
      setReviewsByBlock((prior) => ({ ...prior, [blockId]: [] }));
      setEvidenceByBlock((prior) => ({ ...prior, [blockId]: [] }));
      setReviewStateByBlock((prior) => ({ ...prior, [blockId]: 'unavailable' }));
    }
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
      const loaded = payload.blocks ?? [];
      setBlocks(loaded);
      setBlocksState('loaded');
      // The sessions each of these blocks was worked in. Started after the
      // staleness check, so a read for an athlete nobody is looking at any
      // more does not fire a second wave of requests behind it.
      for (const item of loaded) {
        void loadSessionsForBlock(item.block_id);
        void loadObjectivesForBlock(item.block_id);
        void loadReviewForBlock(item.block_id);
      }
    } catch {
      // A failure for an athlete nobody is looking at any more must not blank
      // the panel belonging to the one they are.
      if (blocksAthleteRef.current !== forAthleteId) return;
      setBlocks([]);
      setBlocksState('unavailable');
    }
  }, [loadSessionsForBlock, loadObjectivesForBlock, loadReviewForBlock]);

  /* Recording that a session supported this block, and taking it back.

     A statement, not a measurement. Linking says a coach believes that class
     moved this plan; nothing infers it from overlapping dates or from the
     athlete having been present, and unlinking removes the claim while
     leaving both the session and the block exactly as they were. */
  async function linkSession(blockId: string, runId: string) {
    // One link at a time, and the select is disabled while it is in flight:
    // a second choice landing mid-write would attach a session the coach has
    // already moved on from.
    if (linkBusyBlockId || !runId) return;

    setLinkBusyBlockId(blockId);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/session-block-links`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId, block_id: blockId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; created?: boolean };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That session could not be linked.');
        return;
      }
      // "Already linked" is not a failure and does not pretend to be a fresh
      // one either.
      setMessage(payload.created === false ? 'Already linked.' : 'Session linked.');
      await loadSessionsForBlock(blockId);
    } catch {
      setErrorMessage('That session could not be linked. Nothing was stored.');
    } finally {
      setLinkBusyBlockId(null);
    }
  }

  async function unlinkSession(blockId: string, runId: string) {
    if (linkBusyBlockId) return;

    setLinkBusyBlockId(blockId);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/session-block-links`
        + `?run_id=${encodeURIComponent(runId)}&block_id=${encodeURIComponent(blockId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That link could not be removed.');
        return;
      }
      setMessage('Link removed.');
      await loadSessionsForBlock(blockId);
    } catch {
      setErrorMessage('That link could not be removed. Nothing changed.');
    } finally {
      setLinkBusyBlockId(null);
    }
  }

  /* Marking an objective a session addressed, and taking the mark back.

     A STATEMENT, NOT A MEASUREMENT, and the same refusal the session link
     makes one level up: nothing infers that a class worked an objective
     because its date fell in the window or because the domain sounds like the
     drills. A coach says so.

     The block id travels with every call because the route gates on it -- a
     group session serves several children's blocks, and a run-wide write
     would be a write about a child this coach may not have. */
  async function toggleObjective(
    blockId: string,
    runId: string,
    objectiveId: string,
    currentlyLinked: boolean,
  ) {
    // One at a time. The controls are disabled while any is in flight, so a
    // second click cannot race the reload that follows the first.
    if (objectiveBusyKey) return;

    setObjectiveBusyKey(`${runId}:${objectiveId}`);
    setMessage('');
    setErrorMessage('');
    try {
      const response = currentlyLinked
        ? await fetch(
          `${apiBase()}/api/pilot/coach/session-objective-links`
          + `?run_id=${encodeURIComponent(runId)}`
          + `&objective_id=${encodeURIComponent(objectiveId)}`
          + `&block_id=${encodeURIComponent(blockId)}`,
          { method: 'DELETE', credentials: 'include' },
        )
        : await fetch(`${apiBase()}/api/pilot/coach/session-objective-links`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run_id: runId, objective_id: objectiveId, block_id: blockId }),
        });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The server's own words. An objective refused because the session
        // does not support its block must say that.
        setErrorMessage(payload.error ?? 'That objective could not be changed.');
        return;
      }
      setMessage(currentlyLinked ? 'Objective unmarked.' : 'Objective marked.');
      // Read it back rather than toggling the local copy: what is on screen
      // should be what was stored.
      await loadObjectivesForBlock(blockId);
    } catch {
      setErrorMessage('That objective could not be changed. Nothing was stored.');
    } finally {
      setObjectiveBusyKey(null);
    }
  }

  /* Recording the coach's own reading of how the block went.

     THE JUDGEMENT IS THEIRS. Nothing on this page proposes a state, pre-fills
     one from the evidence counts, or changes the selection when the counts
     change. The form opens on 'unknown' and stays there until a human picks
     something else.

     REVIEWS ACCUMULATE. There is no edit path here by design: a judgement
     someone recorded at the time is a fact about that time, and a coach who
     changes their mind writes a new dated review beside the old one. */
  async function submitReview(blockId: string) {
    if (reviewBusyBlockId) return;
    const form = reviewForms[blockId] ?? EMPTY_REVIEW_FORM;

    setReviewBusyBlockId(blockId);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/block-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block_id: blockId, ...form }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The server's own words. A review refused for claiming deviations
        // without naming them must say that.
        setErrorMessage(payload.error ?? 'That review could not be recorded.');
        return;
      }
      setMessage('Review recorded.');
      setReviewForms((prior) => ({ ...prior, [blockId]: { ...EMPTY_REVIEW_FORM } }));
      // Read it back rather than pushing the local copy: what is on screen
      // should be what was stored.
      await loadReviewForBlock(blockId);
    } catch {
      setErrorMessage('That review could not be recorded. Nothing was stored.');
    } finally {
      setReviewBusyBlockId(null);
    }
  }

  function updateReviewForm(blockId: string, field: keyof typeof EMPTY_REVIEW_FORM, value: string) {
    setReviewForms((prior) => ({
      ...prior,
      [blockId]: { ...(prior[blockId] ?? EMPTY_REVIEW_FORM), [field]: value },
    }));
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

                    {/* WHICH SESSIONS WORKED THIS BLOCK.

                        The build order's "which athlete development block a
                        session supports" and "which actual activities
                        occurred", from the two records that already hold
                        them: the link a coach made, and the run's own account
                        of itself.

                        NOTHING IS COUNTED. No "4 of 12 sessions", no coverage
                        bar, no adherence figure and no "on track" judgement.
                        Plan-versus-actual is the next slice; the moment
                        sessions are counted against a plan, a percentage
                        about a coach's work with a child is one aggregate
                        away, and it would be built out of links nobody
                        validated.

                        NOTHING IS INFERRED EITHER. A session appears here
                        because a coach said it belonged, never because its
                        date fell inside the window or because the athlete was
                        present. */}
                    <div className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s2)]">
                      <p className="t-label m-0">Sessions that worked this block</p>

                      {sessionsStateByBlock[block.block_id] === 'loading' && (
                        <p className="t-muted m-0">Loading linked sessions...</p>
                      )}

                      {sessionsStateByBlock[block.block_id] === 'unavailable' && (
                        <div className="rounded-[var(--r-sm)] border-2 border-[var(--restricted)] p-[var(--s2)]">
                          <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                            The linked sessions could not be read. This is not a statement that none
                            are linked — nobody could look.
                          </p>
                        </div>
                      )}

                      {sessionsStateByBlock[block.block_id] === 'loaded'
                        && (sessionsByBlock[block.block_id] ?? []).length === 0 && (
                        <p className="t-muted m-0">
                          No session has been linked to this block yet.
                        </p>
                      )}

                      {sessionsStateByBlock[block.block_id] === 'loaded'
                        && (sessionsByBlock[block.block_id] ?? []).map((session) => (
                        <div
                          key={session.run_id}
                          className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.16)] p-[var(--s2)] space-y-[var(--s2)]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                            <p className="t-body m-0 font-semibold">{session.script_name}</p>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={linkBusyBlockId !== null}
                              onClick={() => void unlinkSession(block.block_id, session.run_id)}
                            >
                              Unlink
                            </button>
                          </div>
                          <p className="t-muted m-0">
                            {formatGymDay(session.delivered_on) ?? session.delivered_on}
                          </p>
                          {/* The run's own words, verbatim, and each only when
                              the coach actually wrote one. An empty heading
                              over nothing would suggest the session had no
                              account of itself rather than that this field was
                              left blank. */}
                          {session.what_worked ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              What worked: {session.what_worked}
                            </p>
                          ) : null}
                          {session.what_did_not ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              What did not: {session.what_did_not}
                            </p>
                          ) : null}
                          {session.deviation_note ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              Deviation: {session.deviation_note}
                            </p>
                          ) : null}
                          <p className="t-muted m-0">Linked by {session.linked_by_account_id}</p>

                          {/* WHICH OBJECTIVES THIS SESSION ADDRESSED.

                              The build order's second bullet, and the last
                              piece of PR F. Every objective the block carries
                              is listed, marked or not, because the unmarked
                              ones are the point: a coach has to see what this
                              class did NOT touch in order to mark it, and
                              hiding them would make the list a summary of
                              itself.

                              NOTHING IS COUNTED. No "2 of 5", no per-domain
                              tally, no coverage bar. An objective with no mark
                              means nobody recorded one -- not that the domain
                              was neglected -- and rendering the second from
                              the first is exactly the honesty failure this
                              lane keeps refusing. */}
                          {objectivesStateByBlock[block.block_id] === 'unavailable' && (
                            <p className="t-muted m-0 text-[var(--restricted-ink)]">
                              This block&apos;s objectives could not be read, so there is nothing to
                              mark. This is not a statement that it has none.
                            </p>
                          )}

                          {objectivesStateByBlock[block.block_id] === 'loaded'
                            && (objectivesByBlock[block.block_id] ?? []).length > 0 && (
                            <div className="space-y-[var(--s2)]">
                              <p className="t-label m-0">Objectives this session addressed</p>
                              {(objectivesByBlock[block.block_id] ?? []).map((item) => {
                                const linked = (objectiveLinksByBlock[block.block_id] ?? []).some(
                                  (link) => link.run_id === session.run_id
                                    && link.objective_id === item.objective_id,
                                );
                                return (
                                  <button
                                    key={item.objective_id}
                                    type="button"
                                    className={`btn ${linked ? '' : 'btn--ghost'}`}
                                    disabled={objectiveBusyKey !== null}
                                    aria-pressed={linked}
                                    onClick={() => void toggleObjective(
                                      block.block_id, session.run_id, item.objective_id, linked,
                                    )}
                                  >
                                    {linked ? 'Addressed' : 'Not marked'}
                                    {': '}
                                    {item.objective}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}

                      {runOptionsState === 'unavailable' && (
                        <div className="rounded-[var(--r-sm)] border-2 border-[var(--restricted)] p-[var(--s2)]">
                          <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                            The list of delivered sessions could not be read, so there is nothing to
                            choose from. This is not a statement that none have been delivered.
                          </p>
                        </div>
                      )}

                      {runOptionsState === 'loaded' && runOptions.length === 0 && (
                        <p className="t-muted m-0">
                          No session has been delivered and finished in this gym yet, so there is
                          nothing to link.
                        </p>
                      )}

                      {runOptionsState === 'loaded' && runOptions.length > 0 && (
                        <div className="field">
                          <label htmlFor={`link-session-${block.block_id}`} className="t-label">
                            Link a session
                          </label>
                          <select
                            id={`link-session-${block.block_id}`}
                            value=""
                            disabled={linkBusyBlockId !== null}
                            onChange={(event) => {
                              /* The submitted id is LOOKED UP, never parsed
                                 out of the raw select value: a run id
                                 containing the separator would otherwise be
                                 truncated on its way to the server. */
                              const chosen = runOptions.find((run) => run.run_id === event.target.value);
                              if (chosen) void linkSession(block.block_id, chosen.run_id);
                            }}
                            className="select"
                          >
                            <option value="">Choose a delivered session</option>
                            {runOptions.map((run) => (
                              <option key={run.run_id} value={run.run_id}>
                                {run.script_name}
                                {' — '}
                                {formatGymDay(run.delivered_on) ?? run.delivered_on}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* PLAN VERSUS WHAT WAS ACTUALLY RECORDED.

                        TWO HALVES, AND THIS PANEL NEVER JOINS THEM. Above is
                        what is on record elsewhere for this athlete in this
                        block's window; below is what a coach SAID about how
                        the block went. Nothing here compares the two, scores
                        the block, or decides whether the evidence supports the
                        state a coach chose. The build order settles it in its
                        own words -- "Do not invent an adherence percentage" --
                        and this is the surface where one would be assembled if
                        one ever were.

                        A COUNT IS A FACT ABOUT THE RECORD. "3 training
                        attempts recorded" is a statement about the database.
                        "3 of 12 delivered" would be a statement about a coach,
                        and there is no denominator anywhere that could
                        honestly produce one.

                        A ZERO IS NOT A FINDING. Nothing recorded means nobody
                        recorded anything -- not that the athlete did not train
                        and not that the coach neglected the block. Every count
                        says "recorded" for that reason.

                        NOTHING IS SUGGESTED. No state is pre-selected from the
                        counts, no adjustment is drafted, and SHADOW is not
                        consulted. The judgement is the coach's, and it is
                        theirs alone to write. */}
                    <div className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s2)]">
                      <p className="t-label m-0">Plan versus what was recorded</p>
                      <p className="t-muted m-0">
                        What is on record for this athlete between{' '}
                        {formatGymDay(block.starts_on) ?? block.starts_on}
                        {' and '}
                        {formatGymDay(block.ends_on) ?? block.ends_on}. These are counts of
                        records, not of what happened, and nothing here scores the block.
                      </p>

                      {reviewStateByBlock[block.block_id] === 'loading' && (
                        <p className="t-muted m-0">Loading the record...</p>
                      )}

                      {reviewStateByBlock[block.block_id] === 'unavailable' && (
                        <div className="rounded-[var(--r-sm)] border-2 border-[var(--restricted)] p-[var(--s2)]">
                          <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                            The record for this block could not be read. This is not a statement
                            that nothing was recorded — nobody could look.
                          </p>
                        </div>
                      )}

                      {reviewStateByBlock[block.block_id] === 'loaded' && (
                        <div className="space-y-[var(--s2)]">
                          {(evidenceByBlock[block.block_id] ?? []).map((item) => (
                            <div
                              key={item.key}
                              className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.16)] p-[var(--s2)]"
                            >
                              <p className="t-body m-0">
                                {item.label}: {item.recorded} recorded
                              </p>
                              {/* The rows no window can place, said out loud
                                  and kept apart from the count. Folding them
                                  in would claim work that has not happened;
                                  dropping them would hide records that
                                  exist. */}
                              {item.undated > 0 ? (
                                <p className="t-muted m-0">
                                  {item.undated} more on record with no date, which this window
                                  cannot place.
                                </p>
                              ) : null}
                              {/* The entries themselves, so a coach reads
                                  records rather than a number. */}
                              {item.recent.map((entry, index) => (
                                <p key={`${item.key}-${index}`} className="t-muted m-0">
                                  {formatGymDay(entry.when) ?? entry.when} — {entry.detail}
                                </p>
                              ))}
                            </div>
                          ))}
                          <p className="t-muted m-0">
                            A zero means nobody wrote anything down. It is not a statement that the
                            athlete did not train, or that this block went unworked.
                          </p>
                        </div>
                      )}

                      {reviewStateByBlock[block.block_id] === 'loaded'
                        && (reviewsByBlock[block.block_id] ?? []).length === 0 && (
                        <p className="t-muted m-0">
                          Nobody has reviewed this block yet.
                        </p>
                      )}

                      {/* Every review, newest first, not just the latest. An
                          earlier reading saying the block was off track and a
                          later one saying it recovered are both true, and
                          showing only the second erases the more useful half. */}
                      {reviewStateByBlock[block.block_id] === 'loaded'
                        && (reviewsByBlock[block.block_id] ?? []).map((item) => (
                        <div
                          key={item.review_id}
                          className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.16)] p-[var(--s2)] space-y-[var(--s2)]"
                        >
                          <p className="t-body m-0 font-semibold">
                            {ADHERENCE_LABEL[item.adherence_state] ?? item.adherence_state}
                          </p>
                          {item.deviations ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              Deviations: {item.deviations}
                            </p>
                          ) : null}
                          {item.reason ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              Reason: {item.reason}
                            </p>
                          ) : null}
                          {item.what_worked ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              What worked: {item.what_worked}
                            </p>
                          ) : null}
                          {item.what_did_not ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              What did not: {item.what_did_not}
                            </p>
                          ) : null}
                          {item.next_adjustment ? (
                            <p className="t-body m-0 text-[color:var(--bone-300)]">
                              Next adjustment: {item.next_adjustment}
                            </p>
                          ) : null}
                          <p className="t-muted m-0">
                            Reviewed by {item.reviewed_by_account_id}
                            {' — '}
                            {formatGymDay(item.created_at) ?? item.created_at}
                          </p>
                        </div>
                      ))}

                      <div className="space-y-[var(--s2)]">
                        <p className="t-label m-0">Record a review</p>
                        <div className="field">
                          <label htmlFor={`adherence-${block.block_id}`} className="t-label">
                            How did it go
                          </label>
                          <select
                            id={`adherence-${block.block_id}`}
                            className="select"
                            value={(reviewForms[block.block_id] ?? EMPTY_REVIEW_FORM).adherence_state}
                            disabled={reviewBusyBlockId !== null}
                            onChange={(event) => updateReviewForm(
                              block.block_id, 'adherence_state', event.target.value,
                            )}
                          >
                            {ADHERENCE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>

                        {([
                          ['deviations', 'What departed from the plan'],
                          ['reason', 'Why'],
                          ['what_worked', 'What worked'],
                          ['what_did_not', 'What did not'],
                          ['next_adjustment', 'What you will adjust'],
                        ] as const).map(([field, label]) => (
                          <div className="field" key={field}>
                            <label htmlFor={`${field}-${block.block_id}`} className="t-label">
                              {label}
                            </label>
                            <textarea
                              id={`${field}-${block.block_id}`}
                              className="textarea"
                              rows={2}
                              value={(reviewForms[block.block_id] ?? EMPTY_REVIEW_FORM)[field]}
                              disabled={reviewBusyBlockId !== null}
                              onChange={(event) => updateReviewForm(
                                block.block_id, field, event.target.value,
                              )}
                            />
                          </div>
                        ))}

                        <button
                          type="button"
                          className="btn"
                          disabled={reviewBusyBlockId !== null}
                          onClick={() => void submitReview(block.block_id)}
                        >
                          Record review
                        </button>
                        <p className="t-muted m-0">
                          Reviews are not edited. A later reading is recorded beside this one, and
                          both stay.
                        </p>
                      </div>
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
