'use client';

import { useCallback, useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymStamp } from '@/src/lib/gymTime';

/**
 * The correction desk for the floor-hours ledger.
 *
 * GET and POST /api/pilot/admin/floor-hours have existed since the ledger
 * shipped and nothing on any screen called either. That mattered more than a
 * usual missing door, because the numbers this corrects are already being
 * PUBLISHED: hours accumulate from live code, and
 * /api/pilot/floor-hours/public exposes the organization totals on an
 * unauthenticated endpoint. An operator who spotted a wrong figure there had
 * nowhere to go.
 *
 * NOTHING HERE EDITS A RECORDED ROW. The ledger is append-only by design --
 * floorHours.ts has no updateActivityLog and no deleteActivityLog, and a
 * mistyped duration is fixed by writing a new adjustment that references the
 * original, with a stated reason of at least ten characters. This screen is
 * shaped around that: it shows what was recorded, what has been adjusted, and
 * what the two come to, as three separate figures rather than one number that
 * quietly moved.
 */

interface FloorHoursAdminRow {
  person_account_id: string;
  athlete_id: string | null;
  activity_domain: string;
  period_year: number;
  period_quarter: number;
  hours: string;
  recorded_minutes: string;
  adjustment_minutes: string;
  sessions_recorded: string;
  first_recorded: string;
  last_recorded: string;
}

interface ActivityLedgerRow {
  activity_id: string;
  person_account_id: string;
  activity_domain: string;
  activity_type: string;
  occurred_on: string;
  recorded_minutes: number;
  adjustment_minutes: number;
  effective_minutes: number;
}

interface AdjustmentRow {
  adjustment_id: string;
  activity_id: string;
  delta_minutes: number;
  reason: string;
  adjusted_by_account_id: string;
  adjusted_by_role: string;
  adjusted_at: string;
}

interface Activities {
  rows: ActivityLedgerRow[];
  total: number;
  limit: number;
}

/** Matches pilot_activity_adj_reason, and floorHours.ts's own MIN_REASON_LENGTH. */
const MIN_REASON_LENGTH = 10;

export default function AdminFloorHoursPage() {
  const [rows, setRows] = useState<FloorHoursAdminRow[]>([]);
  /* Three states, never two. A ledger that could not be READ and a gym with
     no recorded hours are opposite facts, and rendering the first as the
     second tells an operator the clock is empty when nobody could look. */
  const [state, setState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [activities, setActivities] = useState<Activities | null>(null);
  const [activitiesState, setActivitiesState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');

  const [openActivityId, setOpenActivityId] = useState<string | null>(null);
  const [trail, setTrail] = useState<AdjustmentRow[] | null>(null);

  const [deltaMinutes, setDeltaMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  const loadTotals = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/floor-hours`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        setState('unavailable');
        return;
      }
      const payload = (await response.json()) as { floor_hours?: FloorHoursAdminRow[] };
      if (!Array.isArray(payload.floor_hours)) {
        setState('unavailable');
        return;
      }
      setRows(payload.floor_hours);
      setState('loaded');
    } catch {
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadTotals();
    })();
  }, [loadTotals]);

  const loadPerson = useCallback(async (personAccountId: string, activityId?: string) => {
    setActivitiesState('loading');
    try {
      const params = new URLSearchParams({ person_account_id: personAccountId });
      if (activityId) params.set('activity_id', activityId);
      const response = await fetch(`${apiBase()}/api/pilot/admin/floor-hours?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        setActivitiesState('unavailable');
        return;
      }
      const payload = (await response.json()) as {
        activities?: Activities | null;
        adjustments?: AdjustmentRow[] | null;
      };
      if (!payload.activities) {
        setActivitiesState('unavailable');
        return;
      }
      setActivities(payload.activities);
      setTrail(payload.adjustments ?? null);
      setActivitiesState('loaded');
    } catch {
      setActivitiesState('unavailable');
    }
  }, []);

  function openPerson(personAccountId: string) {
    setSelectedPerson(personAccountId);
    setOpenActivityId(null);
    setTrail(null);
    setNotice('');
    setFormError('');
    void loadPerson(personAccountId);
  }

  function openActivity(row: ActivityLedgerRow) {
    setOpenActivityId(row.activity_id);
    setDeltaMinutes('');
    setReason('');
    setFormError('');
    setNotice('');
    void loadPerson(row.person_account_id, row.activity_id);
  }

  async function fileCorrection(row: ActivityLedgerRow) {
    if (busy) return;

    /* Refused HERE as well as by the server, because the server's refusal
       arrives after a round trip and this one arrives while the operator is
       still looking at the box. Both exist; neither is decoration. */
    const delta = Number(deltaMinutes);
    if (!Number.isInteger(delta) || delta === 0) {
      setFormError('Enter a whole number of minutes, positive or negative, and not zero.');
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setFormError(`Say why, in at least ${MIN_REASON_LENGTH} characters. A correction without a stated reason cannot be told apart from tampering.`);
      return;
    }

    setBusy(true);
    setFormError('');
    setNotice('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/floor-hours`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: row.activity_id,
          delta_minutes: delta,
          reason: reason.trim(),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        adjustment?: AdjustmentRow;
        error?: string;
      };
      if (!response.ok || !payload.adjustment) {
        setFormError(payload.error || 'The correction was not recorded.');
        return;
      }
      setDeltaMinutes('');
      setReason('');
      setNotice(
        `Correction recorded: ${payload.adjustment.delta_minutes > 0 ? '+' : ''}`
        + `${payload.adjustment.delta_minutes} minutes on ${formatGymDateNumeric(row.occurred_on) ?? row.occurred_on}. `
        + 'The original entry is unchanged and both now show against this session.',
      );
      /* Re-read rather than adjusting the numbers here. The effective minutes
         are computed by the view from the recorded row plus every adjustment,
         and a screen that did that arithmetic itself would be a second
         definition of the figure the public clock publishes. */
      await loadPerson(row.person_account_id, row.activity_id);
      await loadTotals();
    } catch {
      setFormError('Network error -- nothing was recorded. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const personRows = selectedPerson
    ? rows.filter((row) => row.person_account_id === selectedPerson)
    : [];

  return (
    <RoleStandaloneView
      roleLabel="Admin Workspace"
      routeLabel="/admin/floor-hours"
      /* ClubRole's 'admin' is the ORGANIZATION admin -- roleRoutes.ts splits
         Omega out as 'platform_owner' precisely so the client can tell them
         apart. The route behind this admits organization_admin and admin,
         both of which arrive here as 'admin'; platform_owner is not on that
         list and is not on this one. Same shape as the compliance centre. */
      allowedRoles={['admin']}
      showShellHeader={false}
      room="office"
    >
      <div className="space-y-[var(--s5)]">
        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Floor hours</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            The ledger behind the public clock
          </h1>
          <p className="t-body mt-[var(--s3)]">
            These are the per-person figures the organization totals on the public page are
            computed from. Nothing here edits a recorded session — a wrong duration is fixed by
            filing a correction against it, with a reason, and both stay on the record.
          </p>
        </section>

        {state === 'loading' && <p className="t-muted">Loading the ledger...</p>}

        {state === 'unavailable' && (
          <p className="t-body text-[color:var(--restricted-ink)]">
            The ledger could not be read. This is not the same as there being no recorded hours —
            reload before concluding the clock is empty.
          </p>
        )}

        {state === 'loaded' && rows.length === 0 && (
          <p className="t-muted">No hours are recorded for this gym yet.</p>
        )}

        {state === 'loaded' && rows.length > 0 && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-eyebrow">By person and quarter</h2>
            <div className="mt-[var(--s3)] overflow-x-auto">
              <table className="w-full text-[length:var(--t-xs)]">
                <thead>
                  <tr className="text-left">
                    <th>Person</th>
                    <th>Domain</th>
                    <th>Period</th>
                    <th>Recorded</th>
                    <th>Adjusted</th>
                    <th>Hours</th>
                    <th>Sessions</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.person_account_id}-${row.activity_domain}-${row.period_year}-${row.period_quarter}`}>
                      <td>{row.person_account_id}</td>
                      <td>{row.activity_domain}</td>
                      <td>{row.period_year} Q{row.period_quarter}</td>
                      {/* Recorded and adjusted are shown SEPARATELY, never
                          netted into one figure. "340 hours" and "360 hours
                          less 20 corrected away" are different facts about a
                          gym's record, and only one of them survives being
                          collapsed. */}
                      <td>{row.recorded_minutes} min</td>
                      <td>{row.adjustment_minutes} min</td>
                      <td>{row.hours}</td>
                      <td>{row.sessions_recorded}</td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Open the sessions behind ${row.person_account_id}'s total`}
                          onClick={() => openPerson(row.person_account_id)}
                          className="btn btn--ghost whitespace-nowrap"
                        >
                          Open sessions
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {selectedPerson && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-eyebrow">Sessions for {selectedPerson}</h2>
            {personRows.length > 0 && (
              <p className="t-muted mt-[var(--s2)]">
                First recorded {formatGymDateNumeric(personRows[0].first_recorded) ?? personRows[0].first_recorded}.
              </p>
            )}

            {activitiesState === 'loading' && <p className="t-muted mt-[var(--s3)]">Loading sessions...</p>}

            {activitiesState === 'unavailable' && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--restricted-ink)]">
                Those sessions could not be read. Reload before concluding there are none.
              </p>
            )}

            {activitiesState === 'loaded' && activities && (
              <>
                {/* The bound, stated. Silently showing the newest 200 of
                    somebody's 400 sessions would hide the older half, which
                    is exactly where a stale mistake sits. */}
                {activities.total > activities.rows.length && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--restricted-ink)]">
                    Showing the most recent {activities.rows.length} of {activities.total} sessions.
                    The remaining {activities.total - activities.rows.length} are not listed here and
                    cannot be corrected from this screen.
                  </p>
                )}

                {notice && <p role="status" className="t-body mt-[var(--s3)]">{notice}</p>}

                {activities.rows.length === 0 ? (
                  <p className="t-muted mt-[var(--s3)]">No sessions recorded for this person.</p>
                ) : (
                  <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                    {activities.rows.map((row) => {
                      const open = openActivityId === row.activity_id;
                      return (
                        <li
                          key={row.activity_id}
                          className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                            <span className="t-body font-semibold">
                              {formatGymDateNumeric(row.occurred_on) ?? row.occurred_on} · {row.activity_domain} · {row.activity_type}
                            </span>
                            <span className="t-muted">
                              {row.recorded_minutes} min recorded
                              {row.adjustment_minutes !== 0 && (
                                <>
                                  {' '}· {row.adjustment_minutes > 0 ? '+' : ''}{row.adjustment_minutes} corrected
                                  {' '}· {row.effective_minutes} min counted
                                </>
                              )}
                            </span>
                          </div>

                          {open ? (
                            <div className="mt-[var(--s3)] space-y-[var(--s2)]">
                              {trail && trail.length > 0 && (
                                <div>
                                  <p className="t-label">Corrections already filed</p>
                                  <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                                    {trail.map((entry) => (
                                      <li key={entry.adjustment_id} className="t-muted">
                                        {entry.delta_minutes > 0 ? '+' : ''}{entry.delta_minutes} min —{' '}
                                        &ldquo;{entry.reason}&rdquo; — {entry.adjusted_by_account_id}{' '}
                                        ({entry.adjusted_by_role}),{' '}
                                        {formatGymStamp(entry.adjusted_at) ?? entry.adjusted_at}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {trail && trail.length === 0 && (
                                <p className="t-muted">No corrections filed against this session yet.</p>
                              )}

                              <label className="block">
                                <span className="t-label">Minutes to add or subtract</span>
                                <input
                                  type="number"
                                  step={1}
                                  value={deltaMinutes}
                                  onChange={(event) => setDeltaMinutes(event.target.value)}
                                  className="input mt-[var(--s1)] w-full"
                                  aria-label="Minutes to add or subtract"
                                />
                              </label>
                              <label className="block">
                                <span className="t-label">Why (at least {MIN_REASON_LENGTH} characters)</span>
                                <input
                                  type="text"
                                  value={reason}
                                  onChange={(event) => setReason(event.target.value)}
                                  className="input mt-[var(--s1)] w-full"
                                  aria-label="Why this correction is being made"
                                />
                              </label>

                              <div className="flex flex-wrap gap-[var(--s2)]">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void fileCorrection(row)}
                                  className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy ? 'Recording…' : 'File the correction'}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenActivityId(null)}
                                  className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Cancel
                                </button>
                              </div>

                              {formError && (
                                <p className="text-[color:var(--restricted-ink)]">{formError}</p>
                              )}
                            </div>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Correct the session on ${formatGymDateNumeric(row.occurred_on) ?? row.occurred_on}`}
                              onClick={() => openActivity(row)}
                              className="btn btn--ghost mt-[var(--s2)]"
                            >
                              Correct this session
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </RoleStandaloneView>
  );
}
