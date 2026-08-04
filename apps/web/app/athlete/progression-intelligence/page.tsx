'use client';

import { useEffect, useState } from 'react';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';

// Each rabbit hole carries its own top margin rather than sitting in a shared
// wrapper: two anchors are read per gap and either may have nothing to show, so
// there must be no container left behind when they do not. A lesson is a paper
// note pinned to the leather panel, so it wears the paper material and its
// content inherits the paper's own ink via currentColor.
const GAP_RABBIT_HOLE_CLASS = 'mat-paper mt-[var(--s4)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s4)]';

interface ProgressionGap {
  gap_id: string;
  athlete_id: string;
  gap_type: string;
  gap_description: string;
  severity: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DrillAssignment {
  assignment_id: string;
  gap_id: string;
  drill_name: string;
  drill_description: string;
  drill_difficulty: string;
  rep_count?: number;
  duration_minutes?: number;
  frequency_per_week?: number;
  due_date?: string;
  completion_percentage: number;
  status: string;
  created_at: string;
}

interface AssignmentCompletion {
  completion_id: string;
  assignment_id: string;
  reps_completed?: number;
  notes: string;
  verification_status: string;
  completed_at: string;
  verified_at?: string;
}

/* Every state below is a queue outcome, so it wears the design system's badge
   rungs with a glyph beside the label (Laws 2 + 3) rather than colour alone.
   States with no ladder meaning (deferred, cancelled) take a neutral chip so
   they never borrow a safety hue. */

const NEUTRAL_CHIP_CLASS =
  'inline-flex items-center gap-[7px] rounded-[var(--r-pill)] border border-[color:rgba(212,175,74,.32)] bg-[rgba(0,0,0,.28)] px-[12px] py-[6px] font-bold uppercase tracking-[0.1em] text-[11px] text-[color:var(--bone-300)]';

const GapBadge = ({ severity }: { severity: string }) => {
  const rungs: Record<string, { className: string; glyph: string }> = {
    critical: { className: 'badge badge--locked', glyph: '✕' },
    high: { className: 'badge badge--restricted', glyph: '▲' },
    medium: { className: 'badge badge--restricted', glyph: '▲' },
    low: { className: 'badge badge--cleared', glyph: '✓' },
  };
  const rung = rungs[severity] || rungs.medium;
  return <span className={rung.className}><i>{rung.glyph}</i>{severity}</span>;
};

const StatusBadge = ({ status, type }: { status: string; type: 'gap' | 'assignment' | 'completion' }) => {
  const statusRungs: Record<string, Record<string, { className: string; glyph: string } | null>> = {
    gap: {
      identified: { className: 'badge badge--monitor', glyph: '◉' },
      assigned: { className: 'badge badge--monitor', glyph: '◉' },
      in_progress: { className: 'badge badge--monitor', glyph: '◉' },
      completed: { className: 'badge badge--cleared', glyph: '✓' },
      deferred: null,
    },
    assignment: {
      assigned: { className: 'badge badge--monitor', glyph: '◉' },
      in_progress: { className: 'badge badge--monitor', glyph: '◉' },
      completed: { className: 'badge badge--cleared', glyph: '✓' },
      incomplete: { className: 'badge badge--locked', glyph: '✕' },
      cancelled: null,
    },
    completion: {
      pending: { className: 'badge badge--restricted', glyph: '▲' },
      verified: { className: 'badge badge--cleared', glyph: '✓' },
      disputed: { className: 'badge badge--locked', glyph: '✕' },
    },
  };

  const rung = statusRungs[type]?.[status];
  const label = status.replaceAll('_', ' ');
  if (!rung) {
    return <span className={NEUTRAL_CHIP_CLASS}>{label}</span>;
  }
  return <span className={rung.className}><i>{rung.glyph}</i>{label}</span>;
};

/* Completion progress as the brass gauge. Ticks and needle only — no
   .gauge-arc, because completion has no danger threshold: Law 2 reserves the
   red band for readings where "too high" is a real, defined state. The percent
   is also printed beside it, so the needle is never the only channel (Law 3). */
const CompletionGauge = ({ percent }: { percent: number }) => {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const deg = clamped * 1.8 - 90;
  return (
    <div className="gauge">
      <div className="gauge-bezel">
        <div className="gauge-face">
          <div className="gauge-ticks" />
          <div className="gauge-needle" style={{ ['--deg' as string]: `${deg}deg` }} />
          <div className="gauge-hub" />
        </div>
      </div>
      <div className="gauge-cap">Completion</div>
      <div className="gauge-val">{clamped}%</div>
    </div>
  );
};

export default function AthleteProgressionIntelligencePage() {
  const [athleteId, setAthleteId] = useState<string | null>(null);
  const [gaps, setGaps] = useState<ProgressionGap[]>([]);
  const [assignments, setAssignments] = useState<DrillAssignment[]>([]);
  const [completions, setCompletions] = useState<AssignmentCompletion[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (!response.ok || !payload.authenticated || !payload.athlete_id) {
          throw new Error('Unable to resolve athlete session. Sign in again.');
        }
        setAthleteId(payload.athlete_id);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Unable to resolve athlete session.');
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!athleteId) {
      return;
    }

    const fetchData = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);

        // Fetch gaps
        const gapsRes = await fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${encodeURIComponent(athleteId)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (!gapsRes.ok) throw new Error(`Failed to fetch gaps: ${gapsRes.status}`);
        const gapsData = await gapsRes.json();
        setGaps(gapsData.items || []);

        // Fetch assignments
        const assignRes = await fetch(`${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(athleteId)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (!assignRes.ok) throw new Error(`Failed to fetch assignments: ${assignRes.status}`);
        const assignData = await assignRes.json();
        setAssignments(assignData.items || []);

        // Fetch completions for each assignment
        if ((assignData.items || []).length > 0) {
          const completionsMap: Record<string, AssignmentCompletion[]> = {};
          for (const assignment of assignData.items) {
            const compRes = await fetch(`${apiBase()}/api/pilot/progression/completions?assignment_id=${assignment.assignment_id}`, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
            });
            if (compRes.ok) {
              const compData = await compRes.json();
              completionsMap[assignment.assignment_id] = compData.items || [];
            }
          }
          // Flatten all completions
          const allCompletions = Object.values(completionsMap).flat();
          setCompletions(allCompletions);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load progression data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [athleteId]);

  const getCompletionsForAssignment = (assignmentId: string) => {
    return completions.filter((c) => c.assignment_id === assignmentId);
  };

  const getGapForAssignment = (assignmentId: string) => {
    const assignment = assignments.find((a) => a.assignment_id === assignmentId);
    return gaps.find((g) => g.gap_id === assignment?.gap_id);
  };

  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/progression-intelligence" allowedRoles={['athlete']} showShellHeader={false} room="floor">
      {/* Athlete-facing floor surface: ink ground with the floor room's brick
          wall, leather panels standing in it (PAGE_MAP: ink, dashboard). */}
      <div className="room--floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <div className="mb-[var(--s6)]">
            <p className="t-eyebrow">Closed-Loop Progression Intelligence</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Your Progression</h1>
            <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
              Track your assigned drills, complete workouts, and close identified gaps
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
              <span className="working">Loading your progression data...</span>
            </div>
          ) : gaps.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">🥊</div>
                <div className="empty-title">No progression gaps assigned</div>
                <p className="empty-msg mx-auto">Your coaches will identify gaps and assign drills to help you improve</p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s6)]">
              {/* Gaps Overview */}
              <section>
                <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Identified Gaps</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                  {gaps.map((gap) => (
                    <div key={gap.gap_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="flex items-start justify-between gap-[var(--s3)] mb-[var(--s4)]">
                        <div>
                          <h3 className="text-[length:var(--t-md)] font-semibold capitalize text-[color:var(--bone-100)]">{gap.gap_type.replaceAll('_', ' ')}</h3>
                          <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">{gap.gap_description}</p>
                        </div>
                        <GapBadge severity={gap.severity} />
                      </div>
                      <div className="flex items-center gap-[var(--s3)]">
                        <StatusBadge status={gap.status} type="gap" />
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>Identified {new Date(gap.created_at).toLocaleDateString()}</span>
                      </div>

                      {/* Anchored to the two vocabulary terms this card already
                          names, never to the card. */}
                      <RabbitHole
                        anchor={{ anchorType: 'gap_type', anchorKey: gap.gap_type }}
                        className={GAP_RABBIT_HOLE_CLASS}
                      />
                      <RabbitHole
                        anchor={{ anchorType: 'severity', anchorKey: gap.severity }}
                        className={GAP_RABBIT_HOLE_CLASS}
                      />
                    </div>
                  ))}
                </div>
              </section>

              {/* Drill Assignments */}
              <section>
                <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Drill Assignments</h2>
                {assignments.length === 0 ? (
                  <div className="mat-leather rounded-[var(--r-lg)]">
                    <div className="empty" style={{ padding: 'var(--s6) var(--s5)' }}>
                      <p className="empty-msg mx-auto">No drills assigned yet</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-[var(--s4)]">
                    {assignments.map((assignment) => {
                      const gap = getGapForAssignment(assignment.assignment_id);
                      const assignmentCompletions = getCompletionsForAssignment(assignment.assignment_id);
                      const progressPercent = assignment.completion_percentage;

                      return (
                        <div key={assignment.assignment_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                          {/* Drill Header */}
                          <div className="flex items-start justify-between gap-[var(--s4)] mb-[var(--s4)]">
                            <div className="flex-1">
                              <h3 className="text-[length:var(--t-md)] font-bold text-[color:var(--bone-100)]">{assignment.drill_name}</h3>
                              <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">{assignment.drill_description}</p>
                              {gap && (
                                <p className="t-muted mt-[var(--s3)]">
                                  Assigned for:{' '}
                                  <span className="font-medium text-[color:var(--bone-200)]">{gap.gap_type.replaceAll('_', ' ')}</span>
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <StatusBadge status={assignment.status} type="assignment" />
                              <p className="t-label mt-[var(--s3)]">
                                {assignment.drill_difficulty.replaceAll('_', ' ')}
                              </p>
                            </div>
                          </div>

                          {/* Drill Details — auditable numbers, so the record voice (Law 4). */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--s4)] mb-[var(--s4)]">
                            {assignment.rep_count && (
                              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                                <p className="t-label">Reps</p>
                                <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.rep_count}</p>
                              </div>
                            )}
                            {assignment.duration_minutes && (
                              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                                <p className="t-label">Duration</p>
                                <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.duration_minutes} min</p>
                              </div>
                            )}
                            {assignment.frequency_per_week && (
                              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                                <p className="t-label">Frequency</p>
                                <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.frequency_per_week}x/week</p>
                              </div>
                            )}
                            {assignment.due_date && (
                              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                                <p className="t-label">Due Date</p>
                                {/* due_date is a pg DATE. new Date() parses a bare date as UTC
                                    midnight and renders the previous day in every zone west of
                                    Greenwich -- the athlete saw the 14th for a drill due the 15th. */}
                                <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{formatCalendarDay(assignment.due_date)}</p>
                              </div>
                            )}
                          </div>

                          {/* Completion gauge — ticks and needle, no danger arc:
                              completion has no defined "too high" (Law 2). */}
                          <div className="mb-[var(--s4)] flex items-center gap-[var(--s5)]">
                            <CompletionGauge percent={Math.min(progressPercent, 100)} />
                          </div>

                          {/* Completion History */}
                          {assignmentCompletions.length > 0 && (
                            <div className="border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s4)]">
                              <p className="t-label mb-[var(--s4)]">Completion History</p>
                              <div className="space-y-[var(--s3)]">
                                {assignmentCompletions
                                  .toSorted((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                                  .map((completion) => (
                                    <div key={completion.completion_id} className="mat-leather--raised flex items-start gap-[var(--s4)] rounded-[var(--r-md)] p-[var(--s4)]">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-[var(--s3)]">
                                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                                            {new Date(completion.completed_at).toLocaleDateString()}
                                          </span>
                                          <StatusBadge status={completion.verification_status} type="completion" />
                                        </div>
                                        {completion.reps_completed && (
                                          <p className="t-muted mt-[var(--s2)]">
                                            Completed {completion.reps_completed} reps
                                          </p>
                                        )}
                                        {completion.notes && (
                                          <p className="mt-[var(--s3)] text-[length:var(--t-sm)] italic text-[color:var(--bone-300)]">&quot;{completion.notes}&quot;</p>
                                        )}
                                        {completion.verified_at && (
                                          <p className="mt-[var(--s2)] text-[length:var(--t-xs)] font-medium text-[color:var(--cleared-ink)]">
                                            ✓ Verified on {new Date(completion.verified_at).toLocaleDateString()}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Statistics Summary — plain headcounts with no danger threshold,
                  so leather record blocks rather than gauges with arcs (Law 2). */}
              {assignments.length > 0 && (
                <section className="grid grid-cols-1 md:grid-cols-3 gap-[var(--s4)]">
                  <div className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
                    <p className="t-label">Total Gaps</p>
                    <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>{gaps.length}</p>
                  </div>
                  <div className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
                    <p className="t-label">Active Drills</p>
                    <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
                      {assignments.filter((a) => a.status === 'in_progress' || a.status === 'assigned').length}
                    </p>
                  </div>
                  <div className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
                    <p className="t-label">Completed</p>
                    <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
                      {assignments.filter((a) => a.status === 'completed').length}
                    </p>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </RoleStandaloneView>
  );
}
