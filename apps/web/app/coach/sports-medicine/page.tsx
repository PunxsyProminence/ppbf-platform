'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

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
 * The three rungs, in the words of the capability's own contract
 * (`app/api/pilot/training-holds/README.md`). `conditioning_only` says out loud
 * that nothing enforces it: the README calls that "the largest live gap in this
 * capability", and a coach picking a rung has to know which one actually stops
 * something rather than discovering it when a child spars anyway.
 */
const HOLD_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all_training', label: 'All training — STOP: class registration is refused until this is lifted' },
  { value: 'contact_only', label: 'No contact — training continues; contact events are refused, logged contact raises an alarm' },
  { value: 'conditioning_only', label: 'Conditioning only — recorded and an admin is notified; the platform does not yet enforce it' },
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

const CLEARANCE_BADGE: Record<string, { className: string; glyph: string; label: string }> = {
  cleared: { className: 'badge badge--cleared', glyph: '✓', label: 'cleared' },
  restricted: { className: 'badge badge--restricted', glyph: '▲', label: 'restricted' },
  not_cleared: { className: 'badge badge--locked', glyph: '✕', label: 'not cleared' },
  pending: { className: 'badge badge--restricted', glyph: '▲', label: 'pending' },
  none: { className: 'badge badge--locked', glyph: '✕', label: 'no record' },
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
      <div className="min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-4xl">
          <div className="mb-[var(--s5)]">
            <p className="t-eyebrow">Sports Medicine</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Clearance Board</h1>
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

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading clearance board...</span>
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
                      <div className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s3)]">
                        <p className="t-eyebrow">Active Training Hold — {row.hold.scope.replaceAll('_', ' ')}</p>
                        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{row.hold.athlete_explanation}</p>
                        {row.hold.lift_condition_text ? (
                          <p className="t-label mt-[var(--s2)]">Lifts when: {row.hold.lift_condition_text}</p>
                        ) : null}
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
                            What lifts it (optional, and they read this too)
                          </label>
                          <input
                            id={`hold-lift-${row.athlete_id}`}
                            className="input"
                            value={form.lift_condition_text}
                            onChange={(event) => setForm((f) => ({ ...f, lift_condition_text: event.target.value }))}
                          />
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
                        <span className="stamp stamp--flat">{rowRefusal.stamp}</span>
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
        </div>
      </div>
    </RoleStandaloneView>
  );
}
