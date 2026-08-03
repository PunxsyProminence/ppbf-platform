'use client';

import { useEffect, useState } from 'react';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';

// Each rabbit hole carries its own top margin rather than sitting in a shared
// wrapper: two anchors are read per gap and either may have nothing to show, so
// there must be no container left behind when they do not.
const GAP_RABBIT_HOLE_CLASS = 'mt-3 border-l-4 border-[var(--hide-950)] bg-[var(--paper)] p-3';

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

const GapBadge = ({ severity }: { severity: string }) => {
  const colors: Record<string, string> = {
    critical: 'bg-[color-mix(in_srgb,var(--locked)_12%,var(--paper))] text-[color:var(--locked)]',
    high: 'bg-[color-mix(in_srgb,var(--restricted)_12%,var(--paper))] text-[color:var(--restricted-deep)]',
    medium: 'bg-[color-mix(in_srgb,var(--restricted)_12%,var(--paper))] text-[color:var(--restricted-deep)]',
    low: 'bg-[color-mix(in_srgb,var(--cleared)_12%,var(--paper))] text-[color:var(--cleared-deep)]',
  };
  return <span className={`px-2 py-1 rounded text-xs font-semibold ${colors[severity] || colors.medium}`}>{severity}</span>;
};

const StatusBadge = ({ status, type }: { status: string; type: 'gap' | 'assignment' | 'completion' }) => {
  const statusColors: Record<string, Record<string, string>> = {
    gap: {
      identified: 'bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] text-[color:var(--monitor-deep)]',
      assigned: 'bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] text-[color:var(--monitor-deep)]',
      in_progress: 'bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] text-[color:var(--monitor-deep)]',
      completed: 'bg-[color-mix(in_srgb,var(--cleared)_12%,var(--paper))] text-[color:var(--cleared-deep)]',
      deferred: 'bg-[var(--paper)] text-[color:var(--hide-900)]',
    },
    assignment: {
      assigned: 'bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] text-[color:var(--monitor-deep)]',
      in_progress: 'bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] text-[color:var(--monitor-deep)]',
      completed: 'bg-[color-mix(in_srgb,var(--cleared)_12%,var(--paper))] text-[color:var(--cleared-deep)]',
      incomplete: 'bg-[color-mix(in_srgb,var(--locked)_12%,var(--paper))] text-[color:var(--locked)]',
      cancelled: 'bg-[var(--paper)] text-[color:var(--hide-900)]',
    },
    completion: {
      pending: 'bg-[color-mix(in_srgb,var(--restricted)_12%,var(--paper))] text-[color:var(--restricted-deep)]',
      verified: 'bg-[color-mix(in_srgb,var(--cleared)_12%,var(--paper))] text-[color:var(--cleared-deep)]',
      disputed: 'bg-[color-mix(in_srgb,var(--locked)_12%,var(--paper))] text-[color:var(--locked)]',
    },
  };

  const colors = statusColors[type];
  return (
    <span
      className={`px-2 py-1 rounded text-xs font-semibold ${colors[status] || 'bg-[var(--paper)] text-[color:var(--hide-900)]'}`}
    >
      {status.replaceAll('_', ' ')}
    </span>
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
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/progression-intelligence" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="min-h-screen bg-[var(--paper)] p-6">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-[color:var(--hide-950)]">Your Progression</h1>
            <p className="mt-2 text-[color:var(--hide-700)]">
              Track your assigned drills, complete workouts, and close identified gaps
            </p>
          </div>

          {errorMessage && (
            <div className="mb-6 p-4 bg-[color-mix(in_srgb,var(--locked)_10%,var(--paper))] border border-[color:var(--locked)] rounded-lg">
              <p className="text-[color:var(--hide-950)]">{errorMessage}</p>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="text-[color:var(--hide-700)]">Loading your progression data...</div>
            </div>
          ) : gaps.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-lg border border-[rgba(0,0,0,.14)]">
              <p className="text-[color:var(--hide-700)] text-lg">No progression gaps assigned</p>
              <p className="text-[color:var(--hide-700)] mt-2">Your coaches will identify gaps and assign drills to help you improve</p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Gaps Overview */}
              <section>
                <h2 className="text-2xl font-bold text-[color:var(--hide-950)] mb-4">Identified Gaps</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {gaps.map((gap) => (
                    <div key={gap.gap_id} className="bg-white p-4 rounded-lg border border-[rgba(0,0,0,.14)] hover:shadow-md transition">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-[color:var(--hide-950)] capitalize">{gap.gap_type.replaceAll('_', ' ')}</h3>
                          <p className="text-sm text-[color:var(--hide-700)] mt-1">{gap.gap_description}</p>
                        </div>
                        <GapBadge severity={gap.severity} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-[color:var(--hide-700)]">
                        <StatusBadge status={gap.status} type="gap" />
                        <span>Identified {new Date(gap.created_at).toLocaleDateString()}</span>
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
                <h2 className="text-2xl font-bold text-[color:var(--hide-950)] mb-4">Drill Assignments</h2>
                {assignments.length === 0 ? (
                  <div className="text-center py-8 bg-white rounded-lg border border-[rgba(0,0,0,.14)]">
                    <p className="text-[color:var(--hide-700)]">No drills assigned yet</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {assignments.map((assignment) => {
                      const gap = getGapForAssignment(assignment.assignment_id);
                      const assignmentCompletions = getCompletionsForAssignment(assignment.assignment_id);
                      const progressPercent = assignment.completion_percentage;

                      return (
                        <div key={assignment.assignment_id} className="bg-white p-6 rounded-lg border border-[rgba(0,0,0,.14)] hover:shadow-md transition">
                          {/* Drill Header */}
                          <div className="flex items-start justify-between mb-4">
                            <div className="flex-1">
                              <h3 className="text-lg font-bold text-[color:var(--hide-950)]">{assignment.drill_name}</h3>
                              <p className="text-sm text-[color:var(--hide-700)] mt-1">{assignment.drill_description}</p>
                              {gap && (
                                <p className="text-xs text-[color:var(--hide-700)] mt-2">
                                  Assigned for:{' '}
                                  <span className="font-medium">{gap.gap_type.replaceAll('_', ' ')}</span>
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <StatusBadge status={assignment.status} type="assignment" />
                              <p className="text-xs text-[color:var(--hide-700)] mt-2">
                                {assignment.drill_difficulty.replaceAll('_', ' ')}
                              </p>
                            </div>
                          </div>

                          {/* Drill Details */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
                            {assignment.rep_count && (
                              <div className="bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] p-3 rounded">
                                <p className="text-[color:var(--hide-700)]">Reps</p>
                                <p className="font-semibold text-[color:var(--hide-950)]">{assignment.rep_count}</p>
                              </div>
                            )}
                            {assignment.duration_minutes && (
                              <div className="bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] p-3 rounded">
                                <p className="text-[color:var(--hide-700)]">Duration</p>
                                <p className="font-semibold text-[color:var(--hide-950)]">{assignment.duration_minutes} min</p>
                              </div>
                            )}
                            {assignment.frequency_per_week && (
                              <div className="bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] p-3 rounded">
                                <p className="text-[color:var(--hide-700)]">Frequency</p>
                                <p className="font-semibold text-[color:var(--hide-950)]">{assignment.frequency_per_week}x/week</p>
                              </div>
                            )}
                            {assignment.due_date && (
                              <div className="bg-[color-mix(in_srgb,var(--monitor)_12%,var(--paper))] p-3 rounded">
                                <p className="text-[color:var(--hide-700)]">Due Date</p>
                                {/* due_date is a pg DATE. new Date() parses a bare date as UTC
                                    midnight and renders the previous day in every zone west of
                                    Greenwich -- the athlete saw the 14th for a drill due the 15th. */}
                                <p className="font-semibold text-[color:var(--hide-950)]">{formatCalendarDay(assignment.due_date)}</p>
                              </div>
                            )}
                          </div>

                          {/* Progress Bar */}
                          <div className="mb-4">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm font-medium text-[color:var(--hide-800)]">Completion Progress</p>
                              <p className="text-sm font-semibold text-[color:var(--hide-950)]">{progressPercent}%</p>
                            </div>
                            <div className="w-full bg-[var(--paper-2)] rounded-full h-3">
                              <div
                                className="bg-[var(--cleared)] h-3 rounded-full transition-all"
                                style={{ width: `${Math.min(progressPercent, 100)}%` }}
                              />
                            </div>
                          </div>

                          {/* Completion History */}
                          {assignmentCompletions.length > 0 && (
                            <div className="border-t pt-4">
                              <p className="text-sm font-semibold text-[color:var(--hide-950)] mb-3">Completion History</p>
                              <div className="space-y-2">
                                {assignmentCompletions
                                  .toSorted((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                                  .map((completion) => (
                                    <div key={completion.completion_id} className="flex items-start gap-3 bg-[var(--paper)] p-3 rounded">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs font-medium">
                                            {new Date(completion.completed_at).toLocaleDateString()}
                                          </span>
                                          <StatusBadge status={completion.verification_status} type="completion" />
                                        </div>
                                        {completion.reps_completed && (
                                          <p className="text-xs text-[color:var(--hide-700)] mt-1">
                                            Completed {completion.reps_completed} reps
                                          </p>
                                        )}
                                        {completion.notes && (
                                          <p className="text-xs text-[color:var(--hide-800)] mt-2 italic">&quot;{completion.notes}&quot;</p>
                                        )}
                                        {completion.verified_at && (
                                          <p className="text-xs text-[color:var(--cleared-deep)] mt-1 font-medium">
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

              {/* Statistics Summary */}
              {assignments.length > 0 && (
                <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white p-6 rounded-lg border border-[rgba(0,0,0,.14)]">
                    <p className="text-[color:var(--hide-700)] text-sm">Total Gaps</p>
                    <p className="text-3xl font-bold text-[color:var(--hide-950)] mt-2">{gaps.length}</p>
                  </div>
                  <div className="bg-white p-6 rounded-lg border border-[rgba(0,0,0,.14)]">
                    <p className="text-[color:var(--hide-700)] text-sm">Active Drills</p>
                    <p className="text-3xl font-bold text-[color:var(--hide-950)] mt-2">
                      {assignments.filter((a) => a.status === 'in_progress' || a.status === 'assigned').length}
                    </p>
                  </div>
                  <div className="bg-white p-6 rounded-lg border border-[rgba(0,0,0,.14)]">
                    <p className="text-[color:var(--hide-700)] text-sm">Completed</p>
                    <p className="text-3xl font-bold text-[color:var(--hide-950)] mt-2">
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
