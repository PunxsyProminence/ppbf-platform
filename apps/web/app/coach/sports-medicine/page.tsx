'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { TRAINING_HOLD_GLYPH, TRAINING_HOLD_LABEL } from '@/components/RefusalStamp';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import WorkAxis from '@/components/WorkAxis';

// The coach's clearance board (owner decision 2026-08-15): clearance status
// and active training holds with athlete-safe explanations ONLY.
//
// What this page deliberately does NOT show, and must never grow: diagnoses,
// clinical notes, restriction detail, source references, or any reason beyond
// what the athlete themselves reads. The medical-status route legitimately
// serves coaches more than this page displays (SHADOW_PHI_ROLES); the owner's
// decision constrains the SURFACE, and the constraint is the product.
//
// Reading is fail-closed in presentation: "no record" and "unknown" are
// rendered as action states, never as quiet. The medical gate itself
// (shadowRecommendations/shadowDecisions) already refuses to write against an
// athlete with no clearance record -- this board is where a coach sees that
// coming before the gate says no.
//
// This page replaced a scaffold that rendered org-wide SHADOW observation
// projections under a sports-medicine heading -- data that had nothing to do
// with any athlete's clearance.
//
// PLACING AND LIFTING (capability #82) now happens here too. Until this, the
// hold endpoint had no client caller anywhere in the product that could WRITE:
// a coach could read that a child was held and could not hold a child. Every
// downstream hold behaviour -- the registration STOP, the contact near miss,
// the athlete's own banner -- assumes a hold exists, and nothing in the
// interface could create one. This is the only write surface for holds, and it
// reimplements NO authorization: the route decides whether this coach has
// standing with this child (assertCoachAssignedToAthlete), whether a hold
// already exists, and whether the athlete's sentence was written. The client
// sends the form and renders whatever the server says back.
interface RosterAthlete {
  athlete_id: string;
  full_name?: string;
}

type ClearanceValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';

// The staff projection of an active hold. Staff read the full row from GET, but
// this board shows only the athlete-safe fields (see the surface constraint
// above) plus hold_id, which the lift action needs and nothing renders.
interface ActiveHold {
  hold_id?: string;
  scope: string;
  athlete_explanation: string;
  lift_condition_text: string;
}

interface ClearanceRow {
  athlete_id: string;
  full_name: string;
  // null = no clearance record on file; 'unavailable' = the read itself failed.
  clearance: ClearanceValue | null | 'unavailable';
  effective_at: string | null;
  hold: ActiveHold | null;
}

/**
 * The rungs a coach may PLACE, in the words of the capability's own contract
 * (docs/capabilities/GATES.md §7) -- only the ones the platform actually
 * enforces. `conditioning_only` (GATES.md GAP-6) said out loud that nothing
 * enforces it, and is no longer offered at all: the server refuses it too
 * (training-holds route, OPERATIONAL_TRAINING_HOLD_SCOPES). Historical
 * conditioning_only holds still render everywhere holds are displayed.
 */
const HOLD_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all_training', label: 'All training — STOP: class registration is refused until this is lifted' },
  { value: 'contact_only', label: 'No contact — training continues; contact events are refused, logged contact raises an alarm' },
];

const REASON_CATEGORIES: readonly string[] = ['medical', 'fatigue', 'behavioral', 'administrative', 'other'];

const EMPTY_FORM = {
  scope: 'all_training',
  reason_category: 'medical',
  athlete_explanation: '',
  lift_condition_text: '',
  reason_text: '',
};

// Law 7: a refused write is a stamp on the record it was refused for, with the
// server's own reason beside it -- not a toast that scrolls away from the child
// it concerns.
interface Refusal {
  athleteId: string;
  stamp: string;
  message: string;
}

// Room DNA (clinic): red -- --locked, #A81E22 -- is reserved for a medical or
// safeguarding FACT. `not_cleared` is one: a clinician looked at this child and
// said no. `none` is not. It means nobody has typed a clearance record in yet,
// which this page's own copy below calls what it is -- the office sets one
// during onboarding. Both wore --locked, so a coach scanning the roster could
// not tell "a doctor said no" from "the front desk hasn't got to it", and the
// red that should stop a coach cold stopped meaning anything.
//
// `none` drops one rung to --restricted, where `pending` and `unavailable`
// already sit: still an action state, still fail-closed (nothing here reads as
// cleared), and still Law 3-legible because the LABEL, not the colour, is what
// separates "no record" from "pending" from "unavailable".
const CLEARANCE_BADGE: Record<string, { className: string; glyph: string; label: string }> = {
  cleared: { className: 'badge badge--cleared', glyph: '✓', label: 'cleared' },
  restricted: { className: 'badge badge--restricted', glyph: '▲', label: 'restricted' },
  not_cleared: { className: 'badge badge--locked', glyph: '✕', label: 'not cleared' },
  pending: { className: 'badge badge--restricted', glyph: '▲', label: 'pending' },
  none: { className: 'badge badge--restricted', glyph: '▲', label: 'no record' },
  unavailable: { className: 'badge badge--restricted', glyph: '▲', label: 'unavailable' },
};

function clearanceBadge(row: ClearanceRow) {
  if (row.clearance === 'unavailable') return CLEARANCE_BADGE.unavailable;
  if (row.clearance === null) return CLEARANCE_BADGE.none;
  return CLEARANCE_BADGE[row.clearance] ?? CLEARANCE_BADGE.unavailable;
}

export default function SportsMedicinePage() {
  const [rows, setRows] = useState<ClearanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Write state. One athlete at a time: a hold names one child, and a form
  // shared across rows cannot be submitted against the wrong one.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [liftNotes, setLiftNotes] = useState<Record<string, string>>({});
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  // The one hold read, used by the initial board load AND by the refresh after
  // a write, so a placed or lifted hold is displayed by exactly the same
  // GET-based logic that displayed it before -- no write response is trusted to
  // paint the board on its own.
  const readActiveHold = useCallback(async (athleteId: string): Promise<ActiveHold | null> => {
    const response = await fetch(
      `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(athleteId)}&status=active`,
      { method: 'GET', credentials: 'include' },
    );
    if (!response.ok) throw new Error('Unable to read this athlete’s holds.');
    const payload = (await response.json()) as { holds?: ActiveHold[] };
    return payload.holds?.[0] ?? null;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const rosterRes = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!rosterRes.ok) throw new Error('Unable to load your roster.');
        const rosterPayload = (await rosterRes.json()) as { items?: RosterAthlete[] };
        const roster = rosterPayload.items ?? [];

        // One clearance read and one hold read per athlete, through the same
        // routes that enforce coach-of-record/coverage access server-side. A
        // failed read renders as 'unavailable', never as cleared.
        const built = await Promise.all(
          roster.map(async (athlete): Promise<ClearanceRow> => {
            const base: ClearanceRow = {
              athlete_id: athlete.athlete_id,
              full_name: athlete.full_name || 'Unknown',
              clearance: 'unavailable',
              effective_at: null,
              hold: null,
            };
            try {
              const [statusRes, hold] = await Promise.all([
                fetch(
                  `${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(athlete.athlete_id)}`,
                  { method: 'GET', credentials: 'include' },
                ),
                // A failed hold read stays null, exactly as it did before: this
                // board never claims a hold it could not read.
                readActiveHold(athlete.athlete_id).catch(() => null),
              ]);

              if (statusRes.ok) {
                const payload = (await statusRes.json()) as {
                  status?: { status: ClearanceValue; effective_at: string } | null;
                };
                base.clearance = payload.status ? payload.status.status : null;
                base.effective_at = payload.status?.effective_at ?? null;
              }

              base.hold = hold;
            } catch {
              // Leave the fail-closed defaults: unavailable, no hold claim.
            }
            return base;
          }),
        );

        setRows(built);
        setErrorMessage(null);
      } catch (error) {
        setRows([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the clearance board.');
      } finally {
        setLoading(false);
      }
    })();
  }, [readActiveHold]);

  /**
   * Re-read one athlete's hold after a write.
   *
   * `fallback` is what the board shows if the re-read itself fails, and the two
   * directions are not symmetric. After a PLACE, the write already committed,
   * so falling back to "no hold" would show a held child as free -- the
   * dangerous direction. After a LIFT, the write already committed too, so the
   * hold is gone and showing it as active would be the wrong claim. Each caller
   * passes the outcome the server has already told it is true.
   */
  const refreshHold = useCallback(
    async (athleteId: string, fallback: ActiveHold | null) => {
      let hold = fallback;
      try {
        hold = await readActiveHold(athleteId);
      } catch {
        // Keep the committed outcome; the board is refreshed on the next load.
      }
      setRows((current) => current.map((row) => (row.athlete_id === athleteId ? { ...row, hold } : row)));
    },
    [readActiveHold],
  );

  const postHoldAction = async (body: Record<string, unknown>): Promise<{ hold?: ActiveHold } | null> => {
    const response = await fetch(`${apiBase()}/api/pilot/training-holds`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || `The gym’s server refused this (${response.status}).`);
    }
    return (await response.json().catch(() => null)) as { hold?: ActiveHold } | null;
  };

  const placeHold = async (athleteId: string) => {
    // The server owns this rule (gate 3: "a hold a child cannot read a reason
    // for is a punishment, not a safety measure"). Checked here only so the
    // coach is told before the round trip, never instead of it.
    if (!form.athlete_explanation.trim()) {
      setRefusal({
        athleteId,
        stamp: 'Hold Not Placed',
        message: 'Write the sentence this athlete reads. A hold with no explanation for the child is not placed.',
      });
      return;
    }

    setBusyFor(athleteId);
    setRefusal(null);
    try {
      const result = await postHoldAction({
        action: 'place',
        athlete_id: athleteId,
        scope: form.scope,
        reason_category: form.reason_category,
        athlete_explanation: form.athlete_explanation.trim(),
        lift_condition_text: form.lift_condition_text.trim(),
        reason_text: form.reason_text.trim(),
      });
      await refreshHold(athleteId, result?.hold ?? null);
      setOpenFor(null);
      setForm({ ...EMPTY_FORM });
    } catch (error) {
      setRefusal({
        athleteId,
        stamp: 'Hold Not Placed',
        message: error instanceof Error ? error.message : 'The hold was not placed.',
      });
    } finally {
      setBusyFor(null);
    }
  };

  const liftHold = async (athleteId: string, holdId: string) => {
    setBusyFor(athleteId);
    setRefusal(null);
    try {
      await postHoldAction({
        action: 'lift',
        hold_id: holdId,
        lift_note: (liftNotes[athleteId] ?? '').trim(),
      });
      await refreshHold(athleteId, null);
      setLiftNotes((current) => ({ ...current, [athleteId]: '' }));
    } catch (error) {
      setRefusal({
        athleteId,
        stamp: 'Hold Not Lifted',
        message: error instanceof Error ? error.message : 'The hold was not lifted.',
      });
    } finally {
      setBusyFor(null);
    }
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/sports-medicine" allowedRoles={['coach', 'admin']} room="clinic" showShellHeader={false}>
      {/* This div is a CHILD of RoleStandaloneView's room element, so nothing it
          states is outranked by the room: `bg-[var(--hide-950)]` painted a
          full-viewport night-ink rectangle over the clinic's cabinetry AND over
          the plate layer (.room::after sits at z-index:-1), and the flagship
          clinic page rendered as the Night room with a green tint. The shell's
          own comment records the identical correction on its <main>: once a
          room is present the ground utility is not just redundant, it is a
          second answer to "what colour is this page". .room already supplies
          min-height, the ground and --bone-200; the shell's <section> already
          supplies the page padding. */}
      {/* ge-clinic: Golden Era Visual 009 scope. This class is the ONLY change
          on this route -- the instrument board and its dark surround, the
          slate masthead with its riveted brass nameplate, the brushed-steel
          trays the roster stands on, the pinned parchment notes and the
          brass/steel control hierarchy all live in scoped CSS under .ge-clinic
          in design-system/current/ppbf-golden-era.css. Every control,
          clearance badge, hold stamp and refusal on this page is untouched,
          the room's own wall and lamp are left to the committed plate, and no
          reserved safeguarding red is restated. */}
      <div className="ge-clinic">
        {/* The fixture the room's light has always implied. .room--clinic::before
            throws a green pool from the top of the wall and nothing in the app
            ever hung the lamp casting it. Right-hung deliberately: every
            masthead in this room is left-aligned, so the pool falls on bare
            wall and on the top-right of the panel, never across type. */}
        <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
        <div className="mx-auto max-w-4xl">
          {/* Room DNA (clinic), Feel line: varnished cabinetry. The room's own
              material was unused app-wide -- nine clinic surfaces, 29 panels,
              every one of them the same leather the board, the file room, the
              front office and the night console are made of, which is why this
              room read generic even standing against the right wall.

              The masthead is set in the blackletter the design system reserves
              for exactly one thing ("the clinic masthead only") and only at
              display size; the README is explicit that it fails Law 3 small, so
              it is nowhere near body copy.

              .mat-wood's lit top edge is --wood-500 (#7A5029), where
              .t-eyebrow's --brass-400 measures 3.34:1 -- under the 4.5:1 an
              11px label owes. --brass-200 clears it at 5.39:1. That restatement
              belongs in ppbf.css beside the .mat-paper and .on-canvas ones it
              mirrors (`.mat-wood .t-eyebrow`); it is stated here because this
              branch does not own that sheet. Raised, not taken. */}
          <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Clearance Board
            </h1>
            <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
              Clearance status and active training holds for your roster — exactly what the athlete themselves
              can read, and nothing more. Clearance records are set by the office; an athlete with no record
              cannot receive recommendations until one exists.
            </p>
            <p className="mt-[var(--s3)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
              You can pause or narrow training here for an athlete you coach or cover. Placing a hold notifies
              an organization admin in the same breath, and the sentence you write is the one that athlete and
              their guardian read.
            </p>
          </div>

          {/* A board that would not load is a network fact, not a medical one.
              It wore .alert--critical -- the same --locked red as "a clinician
              said no" -- alongside eight other "unable to load" banners across
              this room. --restricted carries it now, glyph and uppercase label
              intact (Law 3), and red is left to mean a child is in danger. */}
          {errorMessage && (
            <div className="alert alert--warning" role="alert">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading clearance board...</span>
            </div>
          ) : errorMessage ? (
            /* THE BOARD COULD NOT BE READ, WHICH IS NOT THE SAME AS AN EMPTY
               BOARD. This screen answers "who is medically cleared", so an
               empty roster here reads as "nothing to check" -- which on this
               one screen means "everyone may train". The per-row failure was
               already fail-closed (CLEARANCE_BADGE.unavailable); only the
               whole-board failure escaped, and it escaped into the most
               reassuring sentence on the page. */
            <div className="mat-leather rounded-[var(--r-lg)] border-2 border-[var(--restricted)]">
              <div className="empty">
                <div className="empty-title text-[var(--restricted-ink)]">
                  The clearance board could not be read
                </div>
                <p className="empty-msg mx-auto">
                  This is not a statement that you have no athletes, and not a statement that
                  anyone is cleared. Nobody could look. Reload, and if it persists, say so before
                  making a clearance decision from this screen.
                </p>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No athletes on your roster</div>
                <p className="empty-msg mx-auto">Athletes you coach (or cover) will appear here with their clearance state.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {rows.map((row) => {
                const badge = clearanceBadge(row);
                const busy = busyFor === row.athlete_id;
                const rowRefusal = refusal && refusal.athleteId === row.athlete_id ? refusal : null;
                return (
                  <li key={row.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{row.full_name}</span>
                      <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{badge.label}</span>
                      {row.effective_at ? (
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          since {formatGymDateNumeric(row.effective_at)}
                        </span>
                      ) : null}
                    </div>
                    {row.clearance === null ? (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                        No clearance record on file. The office sets one during onboarding; until then the
                        medical gate blocks recommendations for this athlete.
                      </p>
                    ) : null}
                    {row.clearance === 'unavailable' ? (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                        Clearance could not be read just now. Unknown is not cleared — check again before
                        making a call that depends on it.
                      </p>
                    ) : null}
                    {row.hold ? (
                      <div data-refusal-stamp="training_hold" className="mt-[var(--s3)]">
                        {/* Same brass, non-punitive mark as the floor room's
                            TrainingHoldBanner and the guardian's safety page
                            (Room DNA: the clinic room's cooler chrome does not
                            change the stamp itself). Still the bare glyph/label
                            here, not the family surfaces' full RefusalStamp:
                            this staff roster is one row per athlete over
                            listTrainingHolds' raw TrainingHoldRow, not the
                            athlete-safe projection those two now resolve a
                            placed_by_name through (2026-08-19 decision) --
                            staff already knows who's placing/lifting a hold
                            from the roster itself, so adding a per-row name
                            lookup here is a separate, un-asked-for slice, not
                            a gap this owner decision covers. */}
                        <span className="stamp stamp--brass stamp--flat stamp--kiosk">
                          <i aria-hidden="true">{TRAINING_HOLD_GLYPH}</i>
                          <span>{TRAINING_HOLD_LABEL}</span>
                        </span>
                        <div className="mat-paper mt-[var(--s2)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s3)]">
                          <p className="t-eyebrow">Active Training Hold — {row.hold.scope.replaceAll('_', ' ')}</p>
                          <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{row.hold.athlete_explanation}</p>
                          {/* NEVER CONDITIONAL. This line used to render only
                              when a lift condition had been written, and the
                              field that fills it is optional -- so a hold could
                              show a stamp, a scope, an explanation and a Lift
                              button, and say nothing at all about what ends it.
                              The rest of the app refuses that: RefusalStamp's
                              training_hold THROWS rather than render a blank
                              hold, because "a hold that reads as blank tells an
                              athlete 'something is wrong and nobody will say
                              what', which is the opposite of the non-punitive,
                              path-back intent"; TrainingHoldBanner, the surface
                              the athlete actually reads, substitutes
                              `Ask ${placed_by_name} what has to happen next.`

                              Throwing is not the right shape HERE. This is the
                              staff board, and a thrown render would take the
                              held child off the coach's screen entirely -- the
                              dangerous direction. So it states the gap instead,
                              in the same words the child is being given, which
                              is the only honest thing this projection can say:
                              listTrainingHolds returns the raw staff row, which
                              carries placed_by_account_id and no resolved name
                              (see the note on the stamp above), so naming a
                              coach here would mean inventing one. */}
                          <p className="t-label mt-[var(--s2)]">
                            Lifts when:{' '}
                            {row.hold.lift_condition_text
                              || 'Not written down — all this athlete is told is to ask whoever placed the hold. Tell them what ends it.'}
                          </p>
                          {row.hold.hold_id ? (
                            <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
                              <div className="field grow">
                                <label className="t-label" htmlFor={`lift-note-${row.athlete_id}`}>
                                  Lift note (optional)
                                </label>
                                <input
                                  id={`lift-note-${row.athlete_id}`}
                                  className="input"
                                  value={liftNotes[row.athlete_id] ?? ''}
                                  onChange={(event) =>
                                    setLiftNotes((current) => ({ ...current, [row.athlete_id]: event.target.value }))
                                  }
                                />
                              </div>
                              <button
                                type="button"
                                className="btn btn--ghost"
                                disabled={busy}
                                aria-busy={busy}
                                onClick={() => void liftHold(row.athlete_id, row.hold?.hold_id ?? '')}
                              >
                                {busy ? 'Lifting…' : 'Lift this hold'}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : openFor === row.athlete_id ? (
                      <div className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
                        <p className="t-eyebrow">Place a training hold</p>
                        <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                          <div className="field">
                            <label className="t-label" htmlFor={`hold-scope-${row.athlete_id}`}>What stops</label>
                            <select
                              id={`hold-scope-${row.athlete_id}`}
                              className="select"
                              value={form.scope}
                              onChange={(event) => setForm((f) => ({ ...f, scope: event.target.value }))}
                            >
                              {HOLD_SCOPES.map((scope) => (
                                <option key={scope.value} value={scope.value}>{scope.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`hold-category-${row.athlete_id}`}>Why (category)</label>
                            <select
                              id={`hold-category-${row.athlete_id}`}
                              className="select"
                              value={form.reason_category}
                              onChange={(event) => setForm((f) => ({ ...f, reason_category: event.target.value }))}
                            >
                              {REASON_CATEGORIES.map((category) => (
                                <option key={category} value={category}>{category}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="field mt-[var(--s3)]">
                          <label className="t-label" htmlFor={`hold-explanation-${row.athlete_id}`}>
                            What this athlete reads (required)
                          </label>
                          <textarea
                            id={`hold-explanation-${row.athlete_id}`}
                            className="textarea"
                            rows={2}
                            value={form.athlete_explanation}
                            onChange={(event) => setForm((f) => ({ ...f, athlete_explanation: event.target.value }))}
                          />
                        </div>
                        <div className="field mt-[var(--s3)]">
                          <label className="t-label" htmlFor={`hold-lift-${row.athlete_id}`}>
                            What lifts it — the path back (they read this too)
                          </label>
                          <input
                            id={`hold-lift-${row.athlete_id}`}
                            className="input"
                            aria-describedby={`hold-lift-hint-${row.athlete_id}`}
                            value={form.lift_condition_text}
                            onChange={(event) => setForm((f) => ({ ...f, lift_condition_text: event.target.value }))}
                          />
                          {/* Not made required, deliberately. The route does not
                              require it (only the athlete's sentence is gated
                              server-side), and TrainingHoldBanner's own comment
                              settles why the app answers a missing condition
                              with an honest fallback rather than a locked form:
                              a safety hold that does not get placed because a
                              coach cannot yet phrase the lift condition is
                              worse than a hold whose path back is "ask me".
                              What changes is that leaving it blank is now an
                              informed choice instead of the word "optional". */}
                          <p
                            id={`hold-lift-hint-${row.athlete_id}`}
                            className="t-body mt-[var(--s2)]"
                            style={{ fontSize: 'var(--t-xs)' }}
                          >
                            Leave this blank only if you genuinely cannot say yet — then all they are told is
                            to come and ask you.
                          </p>
                        </div>
                        <div className="field mt-[var(--s3)]">
                          <label className="t-label" htmlFor={`hold-reason-${row.athlete_id}`}>
                            Staff note (optional — the athlete and their guardian never see this)
                          </label>
                          <input
                            id={`hold-reason-${row.athlete_id}`}
                            className="input"
                            value={form.reason_text}
                            onChange={(event) => setForm((f) => ({ ...f, reason_text: event.target.value }))}
                          />
                        </div>
                        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            aria-busy={busy}
                            onClick={() => void placeHold(row.athlete_id)}
                          >
                            {busy ? 'Placing…' : 'Place hold'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy}
                            onClick={() => { setOpenFor(null); setRefusal(null); }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-[var(--s3)]">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setOpenFor(row.athlete_id);
                            setForm({ ...EMPTY_FORM });
                            setRefusal(null);
                          }}
                        >
                          Place a training hold
                        </button>
                      </div>
                    )}
                    {rowRefusal ? (
                      <div className="mt-[var(--s3)]" role="alert">
                        {/* Brass, not red. The bare .stamp renders in
                            --stamp-red (#A81E22, the same ink as --locked), and
                            what it was carrying is a client-side required-field
                            message and raw HTTP status text. RefusalStamp's
                            locked art policy is explicit that
                            MEDICALLY_NOT_ALLOWED is the ONLY kind that may wear
                            red -- "a coach who is not scoped to an athlete and
                            a same-day medical hold must never wear the same
                            colour of no". A write the server bounced is
                            CANNOT_BE_DONE, so it takes that family's brass and
                            its ▲, which also gives the mark the glyph Law 3
                            asks for and it never had. */}
                        <span className="stamp stamp--brass stamp--flat">
                          <i aria-hidden="true">▲</i> {rowRefusal.stamp}
                        </span>
                        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{rowRefusal.message}</p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/progression-intelligence" className="btn btn--ghost">
              Progression Intelligence
            </Link>
            <Link href="/coach/performance-analytics" className="btn btn--ghost">
              Performance Analytics
            </Link>
          </div>

        {/* The four words, at the foot of the page — the same foot the
            approved boards put under every full screen. See WorkAxis. */}
        <WorkAxis />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
