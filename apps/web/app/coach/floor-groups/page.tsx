'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

// Today's floor (modules 121 + 123): the room split for the people who
// actually showed up. Groups may carry a station (a circuit) or not (small
// groups) -- the page labels the day from what is there, never assuming
// one shape. A placement is a fact about this session only: it carries no
// level, no rank, and nothing follows an athlete to tomorrow.

interface PlanRow {
  plan_id: string;
  plan_on: string;
  title: string;
  rotation_minutes: number | null;
  notes: string;
}

interface GroupRow {
  group_id: string;
  group_name: string;
  station_name: string | null;
  focus: string;
  rotation_order: number | null;
  members: Array<{ athlete_id: string; athlete_name: string }>;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function FloorGroupsPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ plan_on: today(), title: '', rotation_minutes: '' });
  const [groupForm, setGroupForm] = useState({ group_name: '', station_name: '', focus: '' });
  const [placeAthleteId, setPlaceAthleteId] = useState('');

  const reloadPlans = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/floor-groups`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load floor plans.');
    const payload = (await response.json()) as { plans?: PlanRow[] };
    setPlans(payload.plans ?? []);
  }, []);

  const reloadGroups = useCallback(async (planId: string) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/floor-groups?plan_id=${encodeURIComponent(planId)}`, {
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Unable to load groups.');
    const payload = (await response.json()) as { groups?: GroupRow[] };
    setGroups(payload.groups ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [, athleteResponse] = await Promise.all([
          reloadPlans(controller.signal),
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (athleteResponse.ok) {
          const payload = (await athleteResponse.json()) as { items?: AthleteOption[] };
          if (!controller.signal.aborted) setAthletes(payload.items ?? []);
        }
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load floor plans.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reloadPlans]);

  const post = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/floor-groups`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      setErrorMessage(null);
      return (await response.json()) as { item?: { plan_id?: string }; groups?: GroupRow[] };
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePlan = async () => {
    const rotation = planForm.rotation_minutes.trim();
    const result = await post({
      action: 'create_plan',
      plan_on: planForm.plan_on,
      title: planForm.title,
      rotation_minutes: rotation === '' ? undefined : Number(rotation),
    }, 'Unable to start the floor plan.');
    if (!result?.item?.plan_id) return;
    setPlanForm({ plan_on: today(), title: '', rotation_minutes: '' });
    await reloadPlans();
    setSelectedPlanId(result.item.plan_id);
    setGroups([]);
  };

  const handleAddGroup = async () => {
    if (!selectedPlanId || !groupForm.group_name.trim()) {
      setErrorMessage('A group needs a name.');
      return;
    }
    const result = await post({
      action: 'add_group',
      plan_id: selectedPlanId,
      group_name: groupForm.group_name,
      station_name: groupForm.station_name.trim() === '' ? undefined : groupForm.station_name,
      focus: groupForm.focus,
      rotation_order: groupForm.station_name.trim() === '' ? undefined : groups.length + 1,
    }, 'Unable to add the group.');
    if (!result) return;
    setGroupForm({ group_name: '', station_name: '', focus: '' });
    await reloadGroups(selectedPlanId);
  };

  const handlePlace = async (groupId: string) => {
    if (!selectedPlanId || !placeAthleteId) {
      setErrorMessage('Pick an athlete to place.');
      return;
    }
    const result = await post({
      action: 'place', plan_id: selectedPlanId, group_id: groupId, athlete_id: placeAthleteId,
    }, 'Unable to place the athlete.');
    if (result?.groups) setGroups(result.groups);
    setPlaceAthleteId('');
  };

  const handleRemove = async (athleteId: string) => {
    if (!selectedPlanId) return;
    const result = await post({
      action: 'remove', plan_id: selectedPlanId, athlete_id: athleteId,
    }, 'Unable to remove the athlete.');
    if (result?.groups) setGroups(result.groups);
  };

  const isCircuit = groups.some((group) => (group.station_name ?? '').trim() !== '');
  const placed = new Set(groups.flatMap((group) => group.members.map((member) => member.athlete_id)));

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* data-surface="kiosk" -- Law 5, same one-attribute device as
          app/athlete/layout.tsx. This one is genuinely mat-side: the room is
          split for whoever showed up, while they are standing there waiting to
          be told where to go. It is not desk work and it is not planned the
          night before. */}
      <main data-surface="kiosk" className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Today&rsquo;s Floor</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The room split for whoever showed up. Add groups with stations for a circuit, or
              without for small groups — both are real days. A placement is about this session
              only: it carries no level or rank, and nothing here follows an athlete to tomorrow.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-label mb-[var(--s3)]">Start a floor plan</h2>
            <div className="grid gap-[var(--s3)] md:grid-cols-3">
              <div className="field">
                <label className="t-label" htmlFor="plan-date">Day</label>
                <input id="plan-date" type="date" className="input" value={planForm.plan_on}
                  onChange={(e) => setPlanForm((f) => ({ ...f, plan_on: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="plan-title">Title (optional)</label>
                <input id="plan-title" className="input" value={planForm.title}
                  onChange={(e) => setPlanForm((f) => ({ ...f, title: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="plan-rotation">Rotation minutes (circuits only)</label>
                <input id="plan-rotation" className="input" inputMode="numeric" value={planForm.rotation_minutes}
                  onChange={(e) => setPlanForm((f) => ({ ...f, rotation_minutes: e.target.value }))} />
              </div>
            </div>
            <div className="mt-[var(--s4)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleCreatePlan()}>
                {busy ? 'Starting…' : 'Start plan'}
              </button>
            </div>
          </section>

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading floor plans...</span>
            </div>
          ) : (
            <>
              <div className="field mb-[var(--s4)] md:max-w-sm">
                <label className="t-label" htmlFor="plan-picker">Floor plan</label>
                <select id="plan-picker" className="select" value={selectedPlanId ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSelectedPlanId(value || null);
                    setGroups([]);
                    if (value) void reloadGroups(value);
                  }}>
                  <option value="">Select a day…</option>
                  {plans.map((plan) => (
                    <option key={plan.plan_id} value={plan.plan_id}>
                      {plan.plan_on}{plan.title ? ` — ${plan.title}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {selectedPlanId && (
                <>
                  <p className="t-data mb-[var(--s3)]" style={{ fontSize: 'var(--t-xs)' }}>
                    {groups.length === 0
                      ? 'No groups yet — add one with a station for a circuit, or without for small groups.'
                      : isCircuit ? 'Circuit day (stations set)' : 'Small-group day (no stations)'}
                  </p>

                  <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="grid gap-[var(--s3)] md:grid-cols-3">
                      <div className="field">
                        <label className="t-label" htmlFor="group-name">Group name</label>
                        <input id="group-name" className="input" value={groupForm.group_name}
                          onChange={(e) => setGroupForm((f) => ({ ...f, group_name: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label className="t-label" htmlFor="group-station">Station (leave blank for a small group)</label>
                        <input id="group-station" className="input" value={groupForm.station_name}
                          onChange={(e) => setGroupForm((f) => ({ ...f, station_name: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label className="t-label" htmlFor="group-focus">Focus (optional)</label>
                        <input id="group-focus" className="input" value={groupForm.focus}
                          onChange={(e) => setGroupForm((f) => ({ ...f, focus: e.target.value }))} />
                      </div>
                    </div>
                    <div className="mt-[var(--s3)]">
                      <button type="button" className="btn" disabled={busy} onClick={() => void handleAddGroup()}>
                        Add group
                      </button>
                    </div>
                  </section>

                  {groups.length > 0 && (
                    <div className="field mb-[var(--s3)] md:max-w-sm">
                      <label className="t-label" htmlFor="place-athlete">Athlete to place</label>
                      <select id="place-athlete" className="select" value={placeAthleteId}
                        onChange={(e) => setPlaceAthleteId(e.target.value)}>
                        <option value="">Select an athlete…</option>
                        {athletes.map((athlete) => (
                          <option key={athlete.athlete_id} value={athlete.athlete_id}>
                            {athlete.full_name}{placed.has(athlete.athlete_id) ? ' (placed)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <ul className="space-y-[var(--s2)]">
                    {groups.map((group) => (
                      <li key={group.group_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                        <div className="flex flex-wrap items-center gap-[var(--s3)]">
                          <span className="t-body font-semibold text-[color:var(--bone-100)]">{group.group_name}</span>
                          {group.station_name ? (
                            <span className="badge badge--monitor">
                              <i aria-hidden="true">◉</i>
                              {group.rotation_order ? `${group.rotation_order}. ` : ''}{group.station_name}
                            </span>
                          ) : (
                            <span className="badge badge--filed"><i aria-hidden="true">▣</i>small group</span>
                          )}
                          {group.focus ? (
                            <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{group.focus}</span>
                          ) : null}
                          <button type="button" className="btn btn--ghost" disabled={busy || !placeAthleteId}
                            onClick={() => void handlePlace(group.group_id)}>
                            Place here
                          </button>
                        </div>
                        <ul className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                          {group.members.length === 0 ? (
                            <li className="t-body" style={{ fontSize: 'var(--t-sm)' }}>Nobody placed yet.</li>
                          ) : group.members.map((member) => (
                            <li key={member.athlete_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                              {member.athlete_name}
                              <button type="button" className="btn btn--ghost" disabled={busy}
                                onClick={() => void handleRemove(member.athlete_id)}>
                                remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>

        {/* The four words, at the foot of the page — the same foot the
            approved boards put under every full screen. See WorkAxis. */}
        <WorkAxis />
        </div>
      </main>
    </RoleSessionGate>
  );
}
