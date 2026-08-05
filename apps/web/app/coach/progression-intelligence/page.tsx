'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

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

interface RosterAthlete {
  athlete_id: string;
  display_name: string;
  status?: string;
}

interface DrillLibraryItem {
  drill_id: string;
  name: string;
  focus: string;
  category: string | null;
  difficulty: string;
  active: boolean;
}

export default function CoachProgressionIntelligencePage() {
  const [gaps, setGaps] = useState<ProgressionGap[]>([]);
  const [assignments, setAssignments] = useState<DrillAssignment[]>([]);
  const [completionsByAssignment, setCompletionsByAssignment] = useState<Record<string, AssignmentCompletion[]>>({});
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [drills, setDrills] = useState<DrillLibraryItem[]>([]);
  const [selectedAthlete, setSelectedAthlete] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showGapForm, setShowGapForm] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [newGap, setNewGap] = useState({
    gap_type: 'technique',
    gap_description: '',
    severity: 'medium',
  });
  const [assignForm, setAssignForm] = useState({
    gap_id: '',
    drill_id: '',
    drill_name: '',
    drill_description: '',
    drill_difficulty: 'intermediate',
    frequency_per_week: '',
    due_date: '',
  });
  const [busy, setBusy] = useState(false);

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
        }
      } catch {
        // Non-fatal: free-text athlete ID still works.
      }
    })();
  }, []);

  const reloadAthleteData = useCallback(async (athleteId: string) => {
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
    const [gapsRes, assignRes] = await Promise.all([
      fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${encodeURIComponent(athleteId)}`, { credentials: 'include' }),
      fetch(`${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(athleteId)}`, { credentials: 'include' }),
    ]);
    if (!gapsRes.ok || !assignRes.ok) {
      throw new Error('Unable to load progression data.');
    }
    const gapsData = (await gapsRes.json()) as { items?: ProgressionGap[] };
    const assignData = (await assignRes.json()) as { items?: DrillAssignment[] };
    setGaps(gapsData.items ?? []);
    const items = assignData.items ?? [];
    setAssignments(items);

    const nextCompletions: Record<string, AssignmentCompletion[]> = {};
    await Promise.all(
      items.map(async (a) => {
        const compRes = await fetch(
          `${apiBase()}/api/pilot/progression/completions?assignment_id=${encodeURIComponent(a.assignment_id)}`,
          { credentials: 'include' },
        );
        if (compRes.ok) {
          const compData = (await compRes.json()) as { items?: AssignmentCompletion[] };
          nextCompletions[a.assignment_id] = compData.items ?? [];
        }
      }),
    );
    setCompletionsByAssignment(nextCompletions);
    setErrorMessage('');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reloadAthleteData(selectedAthlete);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load progression data.');
      }
    })();
  }, [selectedAthlete, reloadAthleteData]);

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
    if (!selectedAthlete || !assignForm.gap_id || !assignForm.drill_name.trim()) {
      setErrorMessage('Select a gap and provide a drill name');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        gap_id: assignForm.gap_id,
        athlete_id: selectedAthlete,
        drill_name: assignForm.drill_name.trim(),
        drill_description: assignForm.drill_description.trim() || assignForm.drill_name.trim(),
        drill_difficulty: assignForm.drill_difficulty,
      };
      if (assignForm.drill_id) body.drill_id = assignForm.drill_id;
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
      setAssignForm({
        gap_id: '',
        drill_id: '',
        drill_name: '',
        drill_description: '',
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

  const openGaps = gaps.filter(
    (g) => g.status === 'identified' || g.status === 'assigned' || g.status === 'in_progress',
  );

  const onLibraryPick = (drillId: string) => {
    const d = drills.find((x) => x.drill_id === drillId);
    if (!d) {
      setAssignForm((prev) => ({ ...prev, drill_id: '', drill_name: '', drill_description: '' }));
      return;
    }
    setAssignForm((prev) => ({
      ...prev,
      drill_id: d.drill_id,
      drill_name: d.name,
      drill_description: d.focus || '',
      drill_difficulty: d.difficulty || 'intermediate',
    }));
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
          {errorMessage ? <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{errorMessage}</p> : null}
        </header>

        {/* Athlete Selector — roster first, free-text fallback for edge IDs */}
        <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <div className="field">
            <label htmlFor="athlete-select" className="t-label">Select Athlete</label>
            {roster.length > 0 ? (
              <select
                id="athlete-select"
                value={selectedAthlete}
                onChange={(e) => setSelectedAthlete(e.target.value)}
                className="select"
              >
                <option value="">Choose from roster…</option>
                {roster.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {athlete.display_name || athlete.athlete_id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="athlete-select"
                type="text"
                placeholder="Enter athlete ID (e.g., ath-001)"
                value={selectedAthlete}
                onChange={(e) => setSelectedAthlete(e.target.value)}
                className="input"
              />
            )}
          </div>
        </div>

        {selectedAthlete && (
          <>
            {/* Progression Gaps Section */}
            <section className="space-y-[var(--s4)]">
              <div className="flex items-center justify-between gap-[var(--s3)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Progression Gaps ({gaps.length})</h2>
                <div className="flex gap-[var(--s2)]">
                  <button
                    type="button"
                    onClick={() => {
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

              {showAssignForm && (
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
                  {drills.length > 0 && (
                    <div className="field">
                      <label htmlFor="library-pick" className="t-label">From library (optional)</label>
                      <select
                        id="library-pick"
                        value={assignForm.drill_id}
                        onChange={(e) => onLibraryPick(e.target.value)}
                        className="select"
                      >
                        <option value="">Free-text or pick…</option>
                        {drills.map((d) => (
                          <option key={d.drill_id} value={d.drill_id}>
                            {d.name} ({d.difficulty})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="drill-name" className="t-label">Drill name</label>
                    <input
                      id="drill-name"
                      className="input"
                      value={assignForm.drill_name}
                      onChange={(e) => setAssignForm((prev) => ({ ...prev, drill_name: e.target.value }))}
                      placeholder="e.g. Jab-cross from southpaw"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="drill-desc" className="t-label">Description / cues</label>
                    <textarea
                      id="drill-desc"
                      className="textarea"
                      rows={2}
                      value={assignForm.drill_description}
                      onChange={(e) => setAssignForm((prev) => ({ ...prev, drill_description: e.target.value }))}
                    />
                  </div>
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
              <div className="space-y-[var(--s3)]">
                {assignments.length === 0 ? (
                  <p className="t-body text-[color:var(--bone-300)]">No drills assigned yet.</p>
                ) : (
                  assignments.map((assignment) => {
                    const comps = completionsByAssignment[assignment.assignment_id] ?? [];
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
                          </div>
                        </div>
                        {comps.length > 0 && (
                          <div className="mt-[var(--s4)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s3)] space-y-[var(--s2)]">
                            <p className="t-label">Completions</p>
                            {comps.map((completion) => (
                              <div
                                key={completion.completion_id}
                                className="flex flex-wrap items-center justify-between gap-[var(--s2)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]"
                              >
                                <div>
                                  <span className="t-data text-[length:var(--t-xs)]">
                                    {new Date(completion.completed_at).toLocaleString()}
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
          <Link href="/coach/review-queue" className="btn btn--ghost">
            Back to Coach Workspace
          </Link>
          <Link href="/rabbit-holes" className="btn btn--ghost">
            Write a Rabbit Hole
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
