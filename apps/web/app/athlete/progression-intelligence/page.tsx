'use client';

import { useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { ui } from '@/components/uiStyles';

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
    critical: ui.statusDanger,
    high: ui.statusWarning,
    medium: ui.statusInfo,
    low: ui.statusReady,
  };
  return <span className={colors[severity] || colors.medium}>{severity}</span>;
};

const StatusBadge = ({ status, type }: { status: string; type: 'gap' | 'assignment' | 'completion' }) => {
  const statusColors: Record<string, Record<string, string>> = {
    gap: {
      identified: ui.statusInfo,
      assigned: ui.statusWarning,
      in_progress: ui.statusInfo,
      completed: ui.statusReady,
      deferred: ui.statusInactive,
    },
    assignment: {
      assigned: ui.statusInfo,
      in_progress: ui.statusInfo,
      completed: ui.statusReady,
      incomplete: ui.statusDanger,
      cancelled: ui.statusInactive,
    },
    completion: {
      pending: ui.statusWarning,
      verified: ui.statusReady,
      disputed: ui.statusDanger,
    },
  };

  const colors = statusColors[type];
  return (
    <span className={colors[status] || ui.statusInactive}>
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
        const response = await fetch('/api/pilot/auth/session', { method: 'POST' });
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
      <div className="min-h-screen bg-[var(--canvas-tan)] p-6">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-[var(--black)]">Your Progression</h1>
            <p className="mt-2 text-[var(--gray-dark)]">
              Track your assigned drills, complete workouts, and close identified gaps
            </p>
          </div>

          {errorMessage && (
            <div className="mb-6 tactical-alert-critical">
              <p>{errorMessage}</p>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="text-[var(--gray-dark)]">Loading your progression data...</div>
            </div>
          ) : null}
        {gaps.length === 0 ? (
          <div className="text-center py-12 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)]">
            <p className="text-[var(--gray-dark)] text-lg">No progression gaps assigned</p>
              <p className="text-[var(--gray-dark)] mt-2">Your coaches will identify gaps and assign drills to help you improve</p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Gaps Overview */}
              <section>
                <h2 className="text-2xl font-bold text-[var(--black)] mb-4">Identified Gaps</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {gaps.map((gap) => (
                    <div key={gap.gap_id} className="bg-[var(--canvas-tan-light)] p-4 border border-[var(--black)] hover:shadow-[var(--shadow-sm)] transition">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-[var(--black)] capitalize">{gap.gap_type.replaceAll('_', ' ')}</h3>
                          <p className="text-sm text-[var(--gray-dark)] mt-1">{gap.gap_description}</p>
                        </div>
                        <GapBadge severity={gap.severity} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-[var(--gray-dark)]">
                        <StatusBadge status={gap.status} type="gap" />
                        <span>Identified {new Date(gap.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Drill Assignments */}
              <section>
                <h2 className="text-2xl font-bold text-[var(--black)] mb-4">Drill Assignments</h2>
                {assignments.length === 0 ? (
                  <div className="text-center py-8 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)]">
                    <p className="text-[var(--gray-dark)]">No drills assigned yet</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {assignments.map((assignment) => {
                      const gap = getGapForAssignment(assignment.assignment_id);
                      const assignmentCompletions = getCompletionsForAssignment(assignment.assignment_id);
                      const progressPercent = assignment.completion_percentage;

                      return (
                        <div key={assignment.assignment_id} className="bg-[var(--canvas-tan-light)] p-6 border border-[var(--black)] hover:shadow-[var(--shadow-sm)] transition">
                          {/* Drill Header */}
                          <div className="flex items-start justify-between mb-4">
                            <div className="flex-1">
                              <h3 className="text-lg font-bold text-[var(--black)]">{assignment.drill_name}</h3>
                              <p className="text-sm text-[var(--gray-dark)] mt-1">{assignment.drill_description}</p>
                              {gap && (
                                <p className="text-xs text-[var(--gray-dark)] mt-2">
                                  Assigned for:{' '}
                                  <span className="font-medium">{gap.gap_type.replaceAll('_', ' ')}</span>
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <StatusBadge status={assignment.status} type="assignment" />
                              <p className="text-xs text-[var(--gray-dark)] mt-2">
                                {assignment.drill_difficulty.replaceAll('_', ' ')}
                              </p>
                            </div>
                          </div>

                          {/* Drill Details */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
                            {assignment.rep_count && (
                              <div className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                                <p className="text-[var(--gray-dark)]">Reps</p>
                                <p className="font-semibold text-[var(--black)]">{assignment.rep_count}</p>
                              </div>
                            )}
                            {assignment.duration_minutes && (
                              <div className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                                <p className="text-[var(--gray-dark)]">Duration</p>
                                <p className="font-semibold text-[var(--black)]">{assignment.duration_minutes} min</p>
                              </div>
                            )}
                            {assignment.frequency_per_week && (
                              <div className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                                <p className="text-[var(--gray-dark)]">Frequency</p>
                                <p className="font-semibold text-[var(--black)]">{assignment.frequency_per_week}x/week</p>
                              </div>
                            )}
                            {assignment.due_date && (
                              <div className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                                <p className="text-[var(--gray-dark)]">Due Date</p>
                                <p className="font-semibold text-[var(--black)]">{new Date(assignment.due_date).toLocaleDateString()}</p>
                              </div>
                            )}
                          </div>

                          {/* Progress Bar */}
                          <div className="mb-4">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm font-medium text-[var(--black)]">Completion Progress</p>
                              <p className="text-sm font-semibold text-[var(--black)]">{progressPercent}%</p>
                            </div>
                            <div className="w-full border border-[var(--black)] bg-[var(--canvas-tan-dark)] h-3">
                              <div
                                className="bg-[var(--status-ready)] h-3 transition-all"
                                style={{ width: `${Math.min(progressPercent, 100)}%` }}
                              />
                            </div>
                          </div>

                          {/* Completion History */}
                          {assignmentCompletions.length > 0 && (
                            <div className="border-t border-[var(--black)] pt-4">
                              <p className="text-sm font-semibold text-[var(--black)] mb-3">Completion History</p>
                              <div className="space-y-2">
                                {assignmentCompletions
                                  .toSorted((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                                  .map((completion) => (
                                    <div key={completion.completion_id} className="flex items-start gap-3 border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs font-medium">
                                            {new Date(completion.completed_at).toLocaleDateString()}
                                          </span>
                                          <StatusBadge status={completion.verification_status} type="completion" />
                                        </div>
                                        {completion.reps_completed && (
                                          <p className="text-xs text-[var(--gray-dark)] mt-1">
                                            Completed {completion.reps_completed} reps
                                          </p>
                                        )}
                                        {completion.notes && (
                                          <p className="text-xs text-[var(--gray-dark)] mt-2 italic">&quot;{completion.notes}&quot;</p>
                                        )}
                                        {completion.verified_at && (
                                          <p className="text-xs text-[var(--status-ready)] mt-1 font-medium">
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
                  <div className="bg-[var(--canvas-tan-light)] p-6 border border-[var(--black)]">
                    <p className="text-[var(--gray-dark)] text-sm">Total Gaps</p>
                    <p className="text-3xl font-bold text-[var(--black)] mt-2">{gaps.length}</p>
                  </div>
                  <div className="bg-[var(--canvas-tan-light)] p-6 border border-[var(--black)]">
                    <p className="text-[var(--gray-dark)] text-sm">Active Drills</p>
                    <p className="text-3xl font-bold text-[var(--black)] mt-2">
                      {assignments.filter((a) => a.status === 'in_progress' || a.status === 'assigned').length}
                    </p>
                  </div>
                  <div className="bg-[var(--canvas-tan-light)] p-6 border border-[var(--black)]">
                    <p className="text-[var(--gray-dark)] text-sm">Completed</p>
                    <p className="text-3xl font-bold text-[var(--black)] mt-2">
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
