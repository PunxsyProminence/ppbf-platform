'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import CoachInstructionPanel from '@/components/drills/CoachInstructionPanel';
import { readAssignmentInstruction, readReferenceInstruction } from '@/components/drills/drillInstructionRead';
import { useDrillOpener } from '@/components/drills/useDrillOpener';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';
import WorkAxis from '@/components/WorkAxis';
import type { CoachRosterAthlete } from '@/src/server/pilot/contracts';

// A rabbit hole renders as a paper note pinned to the leather panel, so it
// takes the design system's paper material (which carries its own dark ink)
// plus a brass rule and the page's spacing. Each carries its own top margin
// rather than sitting in a shared wrapper: two anchors are read per gap and
// either may have nothing to show, so there must be no container left behind
// when they do not.
const GAP_RABBIT_HOLE_CLASS =
  'mat-paper mt-[var(--s3)] rounded-[var(--r-sm)] border-l-4 border-[color:var(--brass-500)] p-[var(--s3)]';

interface ProgressionGap {
  gap_id: string;
  athlete_id: string;
  gap_type: string;
  gap_description: string;
  severity: string;
  status: string;
  created_at: string;
}

interface DrillAssignment {
  assignment_id: string;
  gap_id: string;
  athlete_id: string;
  drill_id: string | null;
  drill_name: string;
  drill_description: string;
  drill_display_name: string;
  drill_display_description: string;
  drill_difficulty: string;
  due_date: string | null;
  status: string;
  completion_percentage: number;
  frequency_per_week: number | null;
}

interface AssignmentCompletion {
  completion_id: string;
  assignment_id: string;
  completed_at: string;
  reps_completed: number | null;
  notes: string;
  verification_status: string;
  verified_at: string | null;
}

// The roster row as the server actually sends it. Typed from the producer
// (getAthletesForCoach -> CoachRosterAthlete) rather than redeclared, which is
// the fix /coach/cards already carries and the reason it carries it: this
// picker read `display_name`, a key /api/pilot/athletes/list has never sent,
// so `athlete.display_name || athlete.athlete_id` fell through to the raw id
// and every coach chose an athlete from a list of `ath-0f3c...` strings.
// A redeclared interface plus an unchecked `as` cast at the fetch boundary
// cannot catch that -- only naming the producer's own type can.
type RosterAthlete = Pick<CoachRosterAthlete, 'athlete_id' | 'full_name'>;

interface GapSuggestionItem {
  athlete_id: string;
  full_name: string;
  rule: string;
  gap_type: string;
  suggested_description: string;
  evidence: Record<string, number | string>;
}

const SUGGESTION_RULE_LABEL: Record<string, string> = {
  readiness_falling: 'Readiness falling',
  training_days_dropping: 'Training days dropping',
  assignments_stalled: 'Assignments stalled',
  transfer_check_failed: 'Not transferring live',
};

const suggestionKey = (item: GapSuggestionItem) => `${item.athlete_id}:${item.rule}`;

interface DrillLibraryItem {
  drill_id: string;
  name: string;
  focus: string;
  category: string | null;
  difficulty: string;
  active: boolean;
  // The exact reference version this gym adopted, or null on a drill the gym
  // wrote itself. Sent to coaches by /api/pilot/drills; removed for athletes.
  reference_drill_id?: string | null;
}

interface ActiveHoldSummary {
  scope: 'all_training' | 'contact_only' | 'conditioning_only';
  reason_category: string;
  athlete_explanation: string;
}

const HOLD_SCOPE_LABEL: Record<ActiveHoldSummary['scope'], string> = {
  all_training: 'ALL TRAINING',
  contact_only: 'CONTACT WORK',
  conditioning_only: 'CONDITIONING',
};

// A-FIN-06. Work the athlete is still expected to do -- the only work a coach
// can cancel. The same two statuses the server's conditional update accepts;
// completed, incomplete and cancelled work offers nothing.
const isOpenWork = (status: string) => status === 'assigned' || status === 'in_progress';

/**
 * What the coach reads when a cancel fails. Plain sentences keyed on the
 * outcome, never the server's status code or its raw message -- those go to
 * the console for whoever debugs it.
 *
 * "Nothing was cancelled" is only said where it is known: every 4xx here is
 * the server refusing before its write (role, not found, already closed).
 * A 5xx or a request that never came back could have failed either side of
 * the write -- the update commits on its own before the response is built, so
 * a dropped connection or a gateway 5xx can follow a cancel that landed. That
 * sentence therefore claims NEITHER outcome: it says the result is unknown and
 * sends the coach to look. Trying again is safe either way, because work that
 * is already cancelled answers success without writing anything.
 */
function cancelFailureMessage(status: number | null): string {
  if (status === 409) {
    return 'This work is already closed, so it can no longer be cancelled. Nothing was cancelled. Reload this athlete to see where it stands.';
  }
  if (status === 404) {
    return 'This work could not be found for this athlete, or your access to their work has ended. Nothing was cancelled.';
  }
  if (status === 401) {
    return 'Your sign-in has ended. Sign in again, then try again. Nothing was cancelled.';
  }
  if (status === 403) {
    return 'Your account cannot cancel this athlete\'s work. Nothing was cancelled.';
  }
  if (status !== null && status >= 400 && status < 500) {
    return 'The cancel request was refused. Nothing was cancelled.';
  }
  return 'The cancel could not be confirmed, so it may or may not have gone through. The work is shown as it was before you asked. Reload this athlete to see where it stands before trying again.';
}

export default function CoachProgressionIntelligencePage() {
  const [gaps, setGaps] = useState<ProgressionGap[]>([]);
  const [assignments, setAssignments] = useState<DrillAssignment[]>([]);
  const [completionsByAssignment, setCompletionsByAssignment] = useState<Record<string, AssignmentCompletion[]>>({});
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [drills, setDrills] = useState<DrillLibraryItem[]>([]);
  const [selectedAthlete, setSelectedAthlete] = useState('');
  // Capability #5: best-effort and independent of the gaps/assignments load
  // above. progression.ts has no readiness rule connecting a hold to
  // anything -- this is deliberately just visibility, not an enforced
  // block, so a coach assigning drills or verifying completions for a held
  // athlete sees that context instead of it being invisible on this page.
  //
  // The hold is stored WITH the athlete it was read for, and matched against
  // the current selection at render, the same way RabbitHole.tsx stores its
  // anchor alongside the lessons it fetched. A hold banner is a safety claim
  // about one particular child's body: it must never be shown, or withheld,
  // on the strength of a read that was about somebody else. Absence is the
  // honest state while the read for the newly selected athlete is in flight
  // -- no banner says "this page knows of no hold", which is exactly true --
  // so the previous athlete's banner comes down the instant the selection
  // changes rather than lingering over the new name.
  /* THREE STATES, NOT TWO. `hold: null` means the platform looked and this
     athlete is not held. `hold: 'unreadable'` means nobody could look. On
     this page the banner's ABSENCE is the claim "not held", so collapsing
     those two renders a failed read as a clearance -- which is the exact harm
     the read's own comment below names. */
  const [activeHold, setActiveHold] = useState<{
    athleteId: string;
    hold: ActiveHoldSummary | null | 'unreadable';
  }>({
    athleteId: '',
    hold: null,
  });
  const [errorMessage, setErrorMessage] = useState('');
  const [showGapForm, setShowGapForm] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [newGap, setNewGap] = useState({
    gap_type: 'technique',
    gap_description: '',
    severity: 'medium',
  });
  // No drill_name or drill_description: since W-D3 (OD-2026-09-18-001) an
  // assignment takes its wording from the drill it points at, so there is
  // nothing for the coach to type. The drill IS the identity.
  const [assignForm, setAssignForm] = useState({
    gap_id: '',
    drill_id: '',
    drill_difficulty: 'intermediate',
    frequency_per_week: '',
    due_date: '',
  });
  // Distinguishes "this gym has no drills" from "the drill list did not load",
  // so the empty state below never tells a coach their gym is empty when the
  // truth is that the request failed.
  const [drillsLoadFailed, setDrillsLoadFailed] = useState(false);
  // And from "the drill list has not answered yet". An empty array is also what
  // the page holds BEFORE the read lands, so "this gym has no drills" may only
  // be said once the read has actually succeeded.
  const [drillsLoaded, setDrillsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // One drill's instruction open at a time, from the assign form or from an
  // assigned drill. Reading only: every read behind it is a GET (W-D4B).
  const instruction = useDrillOpener();
  // Deterministic gap suggestions (owner decision 2026-08-15): computed
  // server-side from transparent arithmetic rules, never stored, and shown to
  // staff only. A suggestion becomes a real gap only through the confirm
  // button below, which files it through the ordinary gaps POST under this
  // coach's name. Dismissal is this-visit-only by design: nothing about an
  // unconfirmed machine observation deserves a database row.
  const [suggestions, setSuggestions] = useState<GapSuggestionItem[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string>>(new Set());
  const [confirmingSuggestion, setConfirmingSuggestion] = useState<string | null>(null);
  // A-FIN-06 (owner decisions 2026-09-22): a coach can cancel work that is
  // still open. Cancel is the only change offered -- no edit, no delete, no
  // undo -- and it takes two presses: the first only asks. Each piece of
  // state names the assignment it belongs to, so a question, a failure or a
  // result can only ever render on the card it is about.
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<{ assignmentId: string; message: string } | null>(null);
  const [cancelNotice, setCancelNotice] = useState('');
  // The athlete on screen right now, readable from inside an async handler.
  // A cancel is a write the coach can walk away from mid-flight; when it
  // lands, the reload it triggers must be for the athlete still selected, or
  // it would draw the previous athlete's list under the new one's name (see
  // REQUEST ORDERING below). Written only in chooseAthlete, the one place the
  // selection changes.
  const selectedAthleteRef = useRef('');

  // Load roster + drill library once.
  useEffect(() => {
    void (async () => {
      try {
        const [rosterRes, drillsRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/drills`, { credentials: 'include' }),
        ]);
        if (rosterRes.ok) {
          const data = (await rosterRes.json()) as { items?: RosterAthlete[] };
          setRoster(data.items ?? []);
        }
        if (drillsRes.ok) {
          const data = (await drillsRes.json()) as { items?: DrillLibraryItem[] };
          setDrills((data.items ?? []).filter((d) => d.active !== false));
          setDrillsLoaded(true);
        } else {
          setDrillsLoadFailed(true);
        }
      } catch {
        // Non-fatal for the roster: a free-text athlete ID still works. It IS
        // fatal for assigning, which now requires a drill, so say so.
        setDrillsLoadFailed(true);
      }
    })();
  }, []);

  // Load deterministic suggestions once per visit. Best-effort: a coach with
  // no suggestions endpoint sees the same page they always did.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/progression/suggestions`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: GapSuggestionItem[] };
        if (!controller.signal.aborted) setSuggestions(payload.items ?? []);
      } catch {
        // Best-effort (and aborted-on-unmount lands here too): no suggestions
        // is a smaller loss than a broken page.
      }
    })();
    return () => controller.abort();
  }, []);

  const handleConfirmSuggestion = async (item: GapSuggestionItem) => {
    const key = suggestionKey(item);
    setConfirmingSuggestion(key);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/progression/gaps`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: item.athlete_id,
          gap_type: item.gap_type,
          gap_description: item.suggested_description,
          severity: 'medium',
          detected_from: `deterministic_rule:${item.rule}`,
          detection_data: item.evidence,
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Confirm failed (${response.status})`);
      }
      setSuggestions((current) => current.filter((s) => suggestionKey(s) !== key));
      if (selectedAthlete === item.athlete_id) {
        await reloadAthleteData(item.athlete_id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to confirm the suggestion.');
    } finally {
      setConfirmingSuggestion(null);
    }
  };

  // REQUEST ORDERING. Every athlete-scoped read on this page shares one
  // AbortController, kept in a ref rather than a local because two different
  // things start these loads: the selection effect below, and each write
  // handler that reloads after it succeeds. Whichever starts second aborts
  // whatever the first still has in flight.
  //
  // Without that, the loads simply raced. This is not one request but a chain
  // -- gaps and assignments in parallel, then one completions read per
  // assignment -- so two chains for two athletes resolve interleaved, in
  // whatever order the network hands them back, and the LOSER can land last.
  // A coach clicking from one athlete to the next on a slow phone would then
  // be shown the first athlete's gaps, drills and verification queue with the
  // second athlete's name selected above them, and would assign and verify
  // work against that. On a platform where the record is a minor's, that is a
  // data-integrity failure, not a flicker.
  //
  // AbortController rather than comparing the id after the fact because these
  // are chains: aborting stops the per-assignment completions fan-out
  // mid-flight instead of paying for a dozen requests whose answers are
  // already known to be discardable, and one signal covers every request in
  // the chain. It is also the shape this codebase already uses everywhere a
  // fetch is keyed to something that changes -- RabbitHole.tsx,
  // AnnouncementBanner.tsx, app/admin/platform/page.tsx and the suggestions
  // effect a few lines above all abort in effect cleanup and then re-check
  // controller.signal.aborted before touching state. Same pattern here, and
  // the same pattern on the two parent surfaces this page shares its records
  // with (components/ParentHub.tsx, app/parent/progression-visibility).
  const athleteLoadRef = useRef<AbortController | null>(null);

  const reloadAthleteData = useCallback(async (athleteId: string) => {
    // Supersede anything still in flight for the previously requested athlete
    // before this load starts, so there is only ever one live chain.
    athleteLoadRef.current?.abort();
    const controller = new AbortController();
    athleteLoadRef.current = controller;
    const { signal } = controller;

    // Clearing lives here rather than in the effect below: setState called
    // synchronously in an effect body triggers cascading renders, and the lint
    // rule that blocks CI is pointing at a real problem rather than a style
    // preference. Deselecting an athlete is just a load of "no athlete".
    if (!athleteId) {
      setGaps([]);
      setAssignments([]);
      setCompletionsByAssignment({});
      return;
    }
    try {
      const [gapsRes, assignRes] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${encodeURIComponent(athleteId)}`, { credentials: 'include', signal }),
        fetch(`${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(athleteId)}`, { credentials: 'include', signal }),
      ]);
      if (signal.aborted) return;
      if (!gapsRes.ok || !assignRes.ok) {
        throw new Error('Unable to load progression data.');
      }
      const gapsData = (await gapsRes.json()) as { items?: ProgressionGap[] };
      const assignData = (await assignRes.json()) as { items?: DrillAssignment[] };
      if (signal.aborted) return;
      setGaps(gapsData.items ?? []);
      const items = assignData.items ?? [];
      setAssignments(items);

      const nextCompletions: Record<string, AssignmentCompletion[]> = {};
      await Promise.all(
        items.map(async (a) => {
          const compRes = await fetch(
            `${apiBase()}/api/pilot/progression/completions?assignment_id=${encodeURIComponent(a.assignment_id)}`,
            { credentials: 'include', signal },
          );
          if (compRes.ok) {
            const compData = (await compRes.json()) as { items?: AssignmentCompletion[] };
            nextCompletions[a.assignment_id] = compData.items ?? [];
          }
        }),
      );
      if (signal.aborted) return;
      setCompletionsByAssignment(nextCompletions);
      setErrorMessage('');
    } catch (error) {
      // A superseded or unmounted load is not something a coach needs to
      // read: it was cancelled on purpose. Swallowing it HERE, rather than in
      // each of the five callers, is what keeps every caller's own catch
      // reporting genuine failures exactly as it did before -- a real refusal
      // or a dead network still reaches errorMessage.
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      throw error;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reloadAthleteData(selectedAthlete);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load progression data.');
      }
    })();
    // Unmount, and a selection change while a write-triggered reload is in
    // flight: reloadAthleteData supersedes its own predecessor, but nothing
    // else would cancel a chain when this page goes away.
    return () => athleteLoadRef.current?.abort();
  }, [selectedAthlete, reloadAthleteData]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!selectedAthlete) {
        setActiveHold({ athleteId: '', hold: null });
        return;
      }
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(selectedAthlete)}&status=active`,
          { credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setActiveHold({ athleteId: selectedAthlete, hold: 'unreadable' });
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as { holds?: ActiveHoldSummary[] };
        if (controller.signal.aborted) return;
        setActiveHold({ athleteId: selectedAthlete, hold: payload.holds?.[0] ?? null });
      } catch (error) {
        // An ABORT must not write anything -- this read was superseded by the
        // next athlete's, and writing here would be the previous athlete's
        // answer landing on the current athlete.
        //
        // ANY OTHER FAILURE IS SAID OUT LOUD. This used to write `hold: null`,
        // which renders as no banner, which on this page reads as "this
        // athlete is not held" -- the precise failure the previous version of
        // this comment named and then performed: a coach who cannot see an
        // active hold puts a child who is not cleared back into contact work.
        // A silent absence and a real absence must not look the same here.
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setActiveHold({ athleteId: selectedAthlete, hold: 'unreadable' });
      }
    })();
    return () => controller.abort();
  }, [selectedAthlete]);

  const handleCreateGap = async () => {
    if (!selectedAthlete || !newGap.gap_description) {
      setErrorMessage('Please select athlete and describe gap');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/progression/gaps`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: selectedAthlete,
          gap_type: newGap.gap_type,
          gap_description: newGap.gap_description,
          severity: newGap.severity,
          detected_from: 'coach_observation',
        }),
      });
      if (!res.ok) throw new Error('Failed to create gap');
      setShowGapForm(false);
      setNewGap({ gap_type: 'technique', gap_description: '', severity: 'medium' });
      await reloadAthleteData(selectedAthlete);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create gap');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignDrill = async () => {
    if (!selectedAthlete || !assignForm.gap_id || !assignForm.drill_id) {
      setErrorMessage('Select a gap and a drill from this gym\'s library');
      return;
    }
    setBusy(true);
    try {
      // drill_id and nothing that names the drill in words -- the server
      // snapshots the wording from the drill, and refuses a request that tries
      // to supply it.
      const body: Record<string, unknown> = {
        gap_id: assignForm.gap_id,
        athlete_id: selectedAthlete,
        drill_id: assignForm.drill_id,
        drill_difficulty: assignForm.drill_difficulty,
      };
      if (assignForm.frequency_per_week) body.frequency_per_week = Number(assignForm.frequency_per_week);
      if (assignForm.due_date) body.due_date = assignForm.due_date;

      const res = await fetch(`${apiBase()}/api/pilot/progression/assignments`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Failed to assign drill');
      }
      setShowAssignForm(false);
      if (instruction.openKey?.startsWith('picked:')) instruction.close({ returnFocus: false });
      setAssignForm({
        gap_id: '',
        drill_id: '',
        drill_difficulty: 'intermediate',
        frequency_per_week: '',
        due_date: '',
      });
      await reloadAthleteData(selectedAthlete);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to assign drill');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (completion: AssignmentCompletion, verified: boolean) => {
    if (!selectedAthlete) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/progression/completions`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          completion_id: completion.completion_id,
          athlete_id: selectedAthlete,
          verify: true,
          verified,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Verify failed');
      }
      await reloadAthleteData(selectedAthlete);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Verify failed');
    } finally {
      setBusy(false);
    }
  };

  // The first press on "Cancel assignment" only opens the question, and puts
  // focus on the safe answer. Keeping the work hands focus back to the button
  // that asked, the same courtesy the instruction toggles give.
  const askToCancel = (assignmentId: string) => {
    setCancelFailure(null);
    setCancelNotice('');
    setConfirmingCancel(assignmentId);
    window.requestAnimationFrame(() => document.getElementById(`cancel-keep-${assignmentId}`)?.focus());
  };

  const keepAssignment = (assignmentId: string) => {
    setCancelFailure(null);
    setConfirmingCancel(null);
    window.requestAnimationFrame(() => document.getElementById(`cancel-assignment-${assignmentId}`)?.focus());
  };

  const handleCancelAssignment = async (assignment: DrillAssignment, name: string) => {
    const athleteId = selectedAthlete;
    if (!athleteId) return;
    const { assignment_id: assignmentId } = assignment;
    setBusy(true);
    setCancelling(assignmentId);
    setCancelFailure(null);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/progression/assignments/cancel`, {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignment_id: assignmentId, athlete_id: athleteId }),
        });
      } catch (error) {
        console.error({ event: 'assignment-cancel-failed', assignmentId, error });
        setCancelFailure({ assignmentId, message: cancelFailureMessage(null) });
        return;
      }

      // A FAILED CANCEL CHANGES NOTHING ON SCREEN. The card keeps the status
      // the server last reported and the question stays open, so the coach can
      // try again or keep the work. The page never marks work cancelled on its
      // own say-so -- only the reload below, after the server agreed, does.
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { code?: unknown };
        console.error({
          event: 'assignment-cancel-failed',
          assignmentId,
          status: response.status,
          ...(typeof payload.code === 'string' ? { code: payload.code } : {}),
        });
        setCancelFailure({ assignmentId, message: cancelFailureMessage(response.status) });
        return;
      }

      setConfirmingCancel(null);
      // The coach moved to another athlete while this was in flight. The
      // cancel still happened, but this screen is somebody else's now and
      // their own load is already running -- reloading this athlete here would
      // put their list under the new name.
      if (selectedAthleteRef.current !== athleteId) return;
      setCancelNotice(
        `${name} is cancelled. The athlete is no longer expected to do it; completions already logged are kept.`,
      );
      try {
        await reloadAthleteData(athleteId);
      } catch {
        // Said as what it is: the cancel landed, the refresh did not. The card
        // still shows the old status, and the coach must not read that as the
        // cancel having failed.
        setErrorMessage(
          'The work was cancelled, but the list could not be reloaded to show it. Reload this athlete to see where it stands.',
        );
      }
    } finally {
      setCancelling(null);
      setBusy(false);
    }
  };

  const openGaps = gaps.filter(
    (g) => g.status === 'identified' || g.status === 'assigned' || g.status === 'in_progress',
  );

  // A hold read for somebody else is not shown at all. See the note on the
  // activeHold state for why this is matched at render rather than cleared on
  // switch.
  const shownHold = activeHold.athleteId === selectedAthlete ? activeHold.hold : null;
  const holdUnreadable = shownHold === 'unreadable';

  const onLibraryPick = (drillId: string) => {
    // Instructions opened for the previous pick describe a drill that is no
    // longer the one being assigned.
    if (instruction.openKey?.startsWith('picked:')) instruction.close({ returnFocus: false });
    const d = drills.find((x) => x.drill_id === drillId);
    if (!d) {
      setAssignForm((prev) => ({ ...prev, drill_id: '' }));
      return;
    }
    setAssignForm((prev) => ({
      ...prev,
      drill_id: d.drill_id,
      drill_difficulty: d.difficulty || 'intermediate',
    }));
  };

  // The drill the coach picked, so its wording can be SHOWN -- as what the
  // athlete will read -- without being editable.
  const pickedDrill = drills.find((d) => d.drill_id === assignForm.drill_id) ?? null;
  const pickedKey = pickedDrill ? `picked:${pickedDrill.drill_id}` : null;
  const pickedOpen = pickedKey !== null && instruction.openKey === pickedKey;

  // Before assigning: the exact reference version this gym adopted, by the
  // pointer the operational drill carries -- never a name match.
  const togglePickedInstructions = () => {
    if (!pickedDrill?.reference_drill_id || !pickedKey) return;
    if (pickedOpen) {
      instruction.close();
      return;
    }
    const referenceDrillId = pickedDrill.reference_drill_id;
    instruction.open(pickedKey, 'assign-picked-instructions', (signal) => readReferenceInstruction(referenceDrillId, signal));
  };

  // After assigning: the instruction the assignment links to, resolved on the
  // server from the assignment itself -- so a drill the gym has since retired
  // still opens, at the version the work was assigned against.
  // A drill opened for one athlete's work is closed when the coach moves to
  // another athlete, so it cannot reappear, expanded and unasked, on the way
  // back -- and its read, if still in flight, is cancelled with it.
  const chooseAthlete = (athleteId: string) => {
    if (instruction.openKey) instruction.close({ returnFocus: false });
    // A cancel question, failure or result belongs to the athlete it was
    // asked about, and does not follow the coach to the next one.
    setConfirmingCancel(null);
    setCancelFailure(null);
    setCancelNotice('');
    selectedAthleteRef.current = athleteId;
    setSelectedAthlete(athleteId);
  };

  const toggleAssignmentInstructions = (assignmentId: string) => {
    const key = `assignment:${assignmentId}`;
    if (instruction.openKey === key) {
      instruction.close();
      return;
    }
    instruction.open(key, `assignment-instructions-${assignmentId}`, (signal) => readAssignmentInstruction(assignmentId, signal));
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/progression-intelligence" allowedRoles={['coach']} room="floor" showShellHeader={false}>
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Closed-Loop Progression Intelligence</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Progression Gaps → Drills → Verification</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Detect performance gaps, assign drills, and track athlete completion and progression.
          </p>
          {/* --restricted-ink, not --locked-ink: see sports-medicine, where
              the same correction is made and the reason written out. */}
          {errorMessage ? <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--restricted-ink)]">{errorMessage}</p> : null}
        </header>

        {/* Athlete Selector — roster first, free-text fallback for edge IDs */}
        <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <div className="field">
            <label htmlFor="athlete-select" className="t-label">Select Athlete</label>
            {roster.length > 0 ? (
              <select
                id="athlete-select"
                value={selectedAthlete}
                onChange={(e) => chooseAthlete(e.target.value)}
                className="select"
              >
                <option value="">Choose from roster…</option>
                {roster.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {athlete.full_name || athlete.athlete_id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="athlete-select"
                type="text"
                placeholder="Enter athlete ID (e.g., ath-001)"
                value={selectedAthlete}
                onChange={(e) => chooseAthlete(e.target.value)}
                className="input"
              />
            )}
          </div>
        </div>

        {suggestions.filter((item) => !dismissedSuggestions.has(suggestionKey(item))).length > 0 && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-lg)]">Suggested Gaps</h2>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
              Deterministic rules over records the gym already keeps — readiness check-ins, training days, and
              overdue assignments. Nothing here reaches an athlete unless you confirm it as a gap. Dismissing
              hides a suggestion for this visit only.
            </p>
            <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
              {suggestions
                .filter((item) => !dismissedSuggestions.has(suggestionKey(item)))
                .map((item) => {
                  const key = suggestionKey(item);
                  return (
                    <li key={key} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <span className="badge badge--monitor"><i aria-hidden="true">◉</i>suggested</span>
                        <span className="t-body font-semibold">{item.full_name}</span>
                        <span className="t-label">{SUGGESTION_RULE_LABEL[item.rule] ?? item.rule}</span>
                      </div>
                      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{item.suggested_description}</p>
                      <div className="mt-[var(--s3)] flex gap-[var(--s2)]">
                        <button
                          type="button"
                          className="btn"
                          disabled={confirmingSuggestion === key}
                          onClick={() => void handleConfirmSuggestion(item)}
                        >
                          {confirmingSuggestion === key ? 'Confirming…' : 'Confirm as gap'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => setDismissedSuggestions((current) => new Set([...current, key]))}
                        >
                          Dismiss
                        </button>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        )}

        {selectedAthlete && (
          <>
            {holdUnreadable && (
              /* Not a hold, and not the absence of one. The restricted rung
                 rather than the safeguarding red: this is "do not read this
                 screen as a clearance", not "this person may not
                 participate". */
              <section
                role="status"
                className="mat-paper rounded-[var(--r-md)] border-2 border-[var(--restricted)] p-[var(--s4)]"
              >
                <p className="t-eyebrow text-[var(--restricted-ink)]">Training hold: could not be read</p>
                <p className="t-body mt-[var(--s2)] font-semibold">
                  Whether this athlete is under a training hold is UNKNOWN — nobody could look.
                </p>
                <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                  Do not read this as &quot;no hold&quot;. Check the training holds record before
                  assigning or verifying anything that contact work depends on.
                </p>
              </section>
            )}

            {shownHold && shownHold !== 'unreadable' && (
              <section
                role="status"
                className="mat-paper rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s4)]"
              >
                <p className="t-eyebrow">Active Training Hold</p>
                <p className="t-body mt-[var(--s2)] font-semibold">
                  {HOLD_SCOPE_LABEL[shownHold.scope]} is currently paused for this athlete ({shownHold.reason_category}).
                </p>
                <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{shownHold.athlete_explanation}</p>
                <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                  Progression tools below still work -- this is visibility, not a block. Confirm the hold&apos;s
                  scope before assigning or verifying anything that conflicts with it.
                </p>
              </section>
            )}

            {/* Progression Gaps Section */}
            <section className="space-y-[var(--s4)]">
              <div className="flex items-center justify-between gap-[var(--s3)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Progression Gaps ({gaps.length})</h2>
                <div className="flex gap-[var(--s2)]">
                  <button
                    type="button"
                    onClick={() => {
                      // Collapsing the form takes the picked drill's preview with it.
                      if (showAssignForm && instruction.openKey?.startsWith('picked:')) {
                        instruction.close({ returnFocus: false });
                      }
                      setShowAssignForm((v) => !v);
                      if (!showAssignForm && openGaps.length === 1) {
                        setAssignForm((prev) => ({ ...prev, gap_id: openGaps[0].gap_id }));
                      }
                    }}
                    className="btn btn--ghost"
                    disabled={busy || openGaps.length === 0}
                  >
                    {showAssignForm ? 'Cancel assign' : 'Assign drill'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowGapForm(!showGapForm)}
                    className="btn btn--ghost"
                    disabled={busy}
                  >
                    {showGapForm ? 'Cancel' : '+ Add Gap'}
                  </button>
                </div>
              </div>

              {showGapForm && (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                  <div className="field">
                    <label htmlFor="gap-type-select" className="t-label">Gap Type</label>
                    <select
                      id="gap-type-select"
                      value={newGap.gap_type}
                      onChange={(e) => setNewGap({ ...newGap, gap_type: e.target.value })}
                      className="select"
                    >
                      <option value="technique">Technique</option>
                      <option value="strength">Strength</option>
                      <option value="endurance">Endurance</option>
                      <option value="skill">Skill</option>
                      <option value="mental">Mental</option>
                      <option value="tactical">Tactical</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="gap-desc-textarea" className="t-label">Description</label>
                    <textarea
                      id="gap-desc-textarea"
                      value={newGap.gap_description}
                      onChange={(e) => setNewGap({ ...newGap, gap_description: e.target.value })}
                      placeholder="Describe the performance gap..."
                      className="textarea"
                      rows={3}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="severity-select" className="t-label">Severity</label>
                    <select
                      id="severity-select"
                      value={newGap.severity}
                      onChange={(e) => setNewGap({ ...newGap, severity: e.target.value })}
                      className="select"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <button type="button" onClick={() => void handleCreateGap()} className="btn w-full" disabled={busy}>
                    Create Gap
                  </button>
                </div>
              )}

              {/* Since W-D3 an assignment requires a drill from this gym's
                  library. So the form is only worth showing when there IS one
                  to pick -- a form whose only submit can never succeed is a
                  dead end dressed as a control. The two empty cases are told
                  apart deliberately: "the list did not load" and "your gym has
                  no drills" call for different actions, and conflating them
                  would send a coach to add drills that already exist. */}
              {showAssignForm && drillsLoadFailed && (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <p className="t-body text-[color:var(--bone-300)]">
                    The gym&apos;s drill library did not load, so a drill cannot be assigned right now. This is a
                    failure to load, not an empty library.
                  </p>
                </div>
              )}

              {/* Not answered yet: say only that. */}
              {showAssignForm && !drillsLoaded && !drillsLoadFailed && (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <p className="t-body text-[color:var(--bone-300)]">Loading the gym&apos;s drills…</p>
                </div>
              )}

              {showAssignForm && drillsLoaded && drills.length === 0 && (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s2)]">
                  <p className="t-body text-[color:var(--bone-300)]">
                    This gym has no drills to assign yet. Every assignment is built from a drill in the gym&apos;s own
                    library -- add one there, or promote one from the reference library, and it will appear here.
                  </p>
                  <Link href="/coach/drills" className="t-label">Open the Drill Library</Link>
                </div>
              )}

              {showAssignForm && !drillsLoadFailed && drills.length > 0 && (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                  <div className="field">
                    <label htmlFor="assign-gap" className="t-label">Gap</label>
                    <select
                      id="assign-gap"
                      value={assignForm.gap_id}
                      onChange={(e) => setAssignForm((prev) => ({ ...prev, gap_id: e.target.value }))}
                      className="select"
                    >
                      <option value="">Select gap…</option>
                      {openGaps.map((g) => (
                        <option key={g.gap_id} value={g.gap_id}>
                          [{g.severity}] {g.gap_description.slice(0, 80)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="library-pick" className="t-label">Drill</label>
                    <select
                      id="library-pick"
                      value={assignForm.drill_id}
                      onChange={(e) => onLibraryPick(e.target.value)}
                      className="select"
                      required
                    >
                      <option value="">Select a drill…</option>
                      {drills.map((d) => (
                        <option key={d.drill_id} value={d.drill_id}>
                          {d.name} ({d.difficulty})
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Read-only, and that is the point: this is the wording the
                      athlete will see, taken from the drill. It used to be two
                      editable fields whose typed text replaced the drill's own. */}
                  {pickedDrill && (
                    <div className="field">
                      <p className="t-label">What the athlete will see</p>
                      <p className="font-semibold text-[color:var(--bone-100)]">{pickedDrill.name}</p>
                      {pickedDrill.focus && (
                        <p className="t-body text-[color:var(--bone-300)]">{pickedDrill.focus}</p>
                      )}
                      {/* The full drill, read before it is assigned: safety,
                          scaling, stop rules. A drill this gym wrote itself has
                          no reference instruction, and says so. */}
                      {pickedDrill.reference_drill_id ? (
                        <div>
                          <button
                            type="button"
                            id="assign-picked-instructions"
                            className="btn btn--ghost"
                            aria-expanded={pickedOpen}
                            aria-label={`${pickedOpen ? 'Hide' : 'View'} instructions: ${pickedDrill.name}`}
                            onClick={togglePickedInstructions}
                          >
                            {pickedOpen ? 'Hide instructions' : 'View instructions'}
                          </button>
                          {pickedOpen && (
                            <CoachInstructionPanel loading={instruction.loading} failed={instruction.failed} opened={instruction.opened} />
                          )}
                        </div>
                      ) : (
                        <p className="t-muted text-[length:var(--t-xs)]">
                          Written by this gym, so there are no reference instructions to open.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-[var(--s3)]">
                    <div className="field">
                      <label htmlFor="drill-diff" className="t-label">Difficulty</label>
                      <select
                        id="drill-diff"
                        className="select"
                        value={assignForm.drill_difficulty}
                        onChange={(e) => setAssignForm((prev) => ({ ...prev, drill_difficulty: e.target.value }))}
                      >
                        <option value="beginner">Beginner</option>
                        <option value="intermediate">Intermediate</option>
                        <option value="advanced">Advanced</option>
                        <option value="elite">Elite</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="freq" className="t-label">Frequency / week</label>
                      <input
                        id="freq"
                        type="number"
                        min={1}
                        className="input"
                        value={assignForm.frequency_per_week}
                        onChange={(e) => setAssignForm((prev) => ({ ...prev, frequency_per_week: e.target.value }))}
                        placeholder="e.g. 3"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="due" className="t-label">Due date</label>
                      <input
                        id="due"
                        type="date"
                        className="input"
                        value={assignForm.due_date}
                        onChange={(e) => setAssignForm((prev) => ({ ...prev, due_date: e.target.value }))}
                      />
                    </div>
                  </div>
                  <button type="button" onClick={() => void handleAssignDrill()} className="btn w-full" disabled={busy}>
                    Assign drill
                  </button>
                </div>
              )}

              <div className="space-y-[var(--s3)]">
                {gaps.length === 0 ? (
                  <p className="t-body text-[color:var(--bone-300)]">No gaps identified yet.</p>
                ) : (
                  gaps.map((gap) => (
                    <div key={gap.gap_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="flex items-start justify-between gap-[var(--s3)]">
                        <div className="flex-1">
                          <p className="font-semibold text-[color:var(--bone-100)]">{gap.gap_description}</p>
                          <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s3)]">
                            <span className="t-data text-[color:var(--bone-300)]">{gap.gap_type}</span>
                            <span className="t-data text-[color:var(--bone-300)]">{gap.severity}</span>
                            <span className="t-data text-[color:var(--bone-400)]">{gap.status}</span>
                          </div>
                        </div>
                      </div>
                      <RabbitHole
                        anchor={{ anchorType: 'gap_type', anchorKey: gap.gap_type }}
                        className={GAP_RABBIT_HOLE_CLASS}
                      />
                      <RabbitHole
                        anchor={{ anchorType: 'severity', anchorKey: gap.severity }}
                        className={GAP_RABBIT_HOLE_CLASS}
                      />
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Drill Assignments + verify surface */}
            <section>
              <h2 className="t-command mb-[var(--s4)] text-[length:var(--t-lg)]">Assigned Drills ({assignments.length})</h2>
              {/* Always mounted, so a screen reader is already listening when
                  a cancel's result is written into it. Empty otherwise. */}
              <p role="status" aria-live="polite" className="t-body text-[color:var(--bone-300)]">
                {cancelNotice ? <span className="mb-[var(--s3)] block">{cancelNotice}</span> : null}
              </p>
              <div className="space-y-[var(--s3)]">
                {assignments.length === 0 ? (
                  <p className="t-body text-[color:var(--bone-300)]">No drills assigned yet.</p>
                ) : (
                  assignments.map((assignment) => {
                    const comps = completionsByAssignment[assignment.assignment_id] ?? [];
                    const assignmentOpen = instruction.openKey === `assignment:${assignment.assignment_id}`;
                    const assignmentName = assignment.drill_display_name || assignment.drill_name;
                    // Only open work can be cancelled, and the question is only
                    // ever shown on the card it was asked about.
                    const cancellable = isOpenWork(assignment.status);
                    const askingToCancel = cancellable && confirmingCancel === assignment.assignment_id;
                    const failedCancel =
                      cancelFailure?.assignmentId === assignment.assignment_id ? cancelFailure.message : null;
                    return (
                      <div key={assignment.assignment_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                        <div className="flex items-start justify-between gap-[var(--s3)]">
                          <div className="flex-1">
                            <p className="font-semibold text-[color:var(--bone-100)]">
                              {assignment.drill_display_name || assignment.drill_name}
                            </p>
                            <p className="t-muted text-[color:var(--bone-300)]">
                              {assignment.drill_display_description || assignment.drill_description}
                            </p>
                            <div className="mt-[var(--s3)] h-2 rounded-[var(--r-sm)] bg-[rgba(0,0,0,.4)]">
                              <div
                                className="h-full rounded-[var(--r-sm)] bg-[var(--brass-500)]"
                                style={{ width: `${assignment.completion_percentage}%` }}
                              />
                            </div>
                            <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                              {assignment.completion_percentage}% complete · {assignment.status}
                            </p>
                            {/* A legacy assignment has no drill behind it, so nothing to open. */}
                            {assignment.drill_id && (
                              <div className="mt-[var(--s3)]">
                                <button
                                  type="button"
                                  id={`assignment-instructions-${assignment.assignment_id}`}
                                  className="btn btn--ghost"
                                  aria-expanded={assignmentOpen}
                                  aria-label={`${assignmentOpen ? 'Hide' : 'View'} instructions: ${assignmentName}`}
                                  onClick={() => toggleAssignmentInstructions(assignment.assignment_id)}
                                >
                                  {assignmentOpen ? 'Hide instructions' : 'View instructions'}
                                </button>
                                {assignmentOpen && (
                                  <CoachInstructionPanel loading={instruction.loading} failed={instruction.failed} opened={instruction.opened} />
                                )}
                              </div>
                            )}
                            {/* The cancelled state, as the server reported it on
                                the last read -- never drawn from the button press
                                alone. */}
                            {assignment.status === 'cancelled' && (
                              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                                Cancelled. The athlete is no longer expected to do this work; completions already logged
                                stay on its record.
                              </p>
                            )}
                            {/* A-FIN-06: cancel is the only change a coach can
                                make to issued work here, and only while it is
                                open. Two presses: this one asks, the next one
                                acts. */}
                            {cancellable && (
                              <div className="mt-[var(--s3)]">
                                {askingToCancel ? (
                                  <div
                                    role="group"
                                    aria-labelledby={`cancel-question-${assignment.assignment_id}`}
                                    className="mat-leather--raised rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-500)] p-[var(--s3)] space-y-[var(--s2)]"
                                  >
                                    <p id={`cancel-question-${assignment.assignment_id}`} className="t-body font-semibold">
                                      Cancel {assignmentName}?
                                    </p>
                                    <p className="t-body text-[color:var(--bone-300)]">
                                      The athlete will no longer be expected to do this work. Its history stays:
                                      completions already logged are kept, and nothing is deleted. Cancelled work cannot
                                      be reopened.
                                    </p>
                                    {/* A failed write, so the page's alert
                                        channel -- said once, on this card. */}
                                    {failedCancel && (
                                      <p role="alert" className="t-body text-[var(--restricted-ink)]">
                                        {failedCancel}
                                      </p>
                                    )}
                                    <div className="flex flex-wrap gap-[var(--s2)]">
                                      <button
                                        type="button"
                                        className="btn"
                                        disabled={busy}
                                        onClick={() => void handleCancelAssignment(assignment, assignmentName)}
                                      >
                                        {cancelling === assignment.assignment_id ? 'Cancelling…' : 'Yes, cancel assignment'}
                                      </button>
                                      {/* Not while the request is in flight: a
                                          sent cancel cannot be taken back, and a
                                          "keep" pressed then would promise it. */}
                                      <button
                                        type="button"
                                        id={`cancel-keep-${assignment.assignment_id}`}
                                        className="btn btn--ghost"
                                        disabled={cancelling === assignment.assignment_id}
                                        onClick={() => keepAssignment(assignment.assignment_id)}
                                      >
                                        Keep assignment
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    id={`cancel-assignment-${assignment.assignment_id}`}
                                    className="btn btn--ghost"
                                    disabled={busy}
                                    aria-label={`Cancel assignment: ${assignmentName}`}
                                    onClick={() => askToCancel(assignment.assignment_id)}
                                  >
                                    Cancel assignment
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        {comps.length > 0 && (
                          <div className="mt-[var(--s4)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)] space-y-[var(--s2)]">
                            <p className="t-label">Completions</p>
                            {comps.map((completion) => (
                              <div
                                key={completion.completion_id}
                                className="flex flex-wrap items-center justify-between gap-[var(--s2)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]"
                              >
                                <div>
                                  <span className="t-data text-[length:var(--t-xs)]">
                                    {formatGymStamp(completion.completed_at)}
                                  </span>
                                  <span className="t-data ml-[var(--s2)] text-[color:var(--bone-400)]">
                                    {completion.verification_status}
                                  </span>
                                  {completion.notes ? (
                                    <p className="t-muted mt-[var(--s1)] text-[length:var(--t-xs)]">{completion.notes}</p>
                                  ) : null}
                                </div>
                                {completion.verification_status === 'pending' && (
                                  <div className="flex gap-[var(--s2)]">
                                    <button
                                      type="button"
                                      className="btn btn--ghost"
                                      disabled={busy}
                                      onClick={() => void handleVerify(completion, true)}
                                    >
                                      Verify
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--ghost"
                                      disabled={busy}
                                      onClick={() => void handleVerify(completion, false)}
                                    >
                                      Dispute
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </>
        )}

        <div className="flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/environment/intake-router" className="btn btn--ghost">
            Back to Coach Workspace
          </Link>
          <Link href="/rabbit-holes" className="btn btn--ghost">
            Write a Rabbit Hole
          </Link>

        {/* The four words, at the foot of the page — the same foot the
            approved boards put under every full screen. See WorkAxis. */}
        <WorkAxis />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
