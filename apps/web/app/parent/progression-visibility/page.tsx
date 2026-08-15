'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// A rabbit hole renders as a paper note carrying the gym's own vocabulary
// lesson for a term on the card. Parent surfaces sit on the warm canvas
// ground, so the note takes the paper material plus a brass rule, same as the
// athlete's own gap cards.
const GAP_RABBIT_HOLE_CLASS =
  'mat-paper mt-[var(--s3)] rounded-[var(--r-sm)] border-l-4 border-[color:var(--brass-500)] p-[var(--s3)]';

// This page reads the SAME progression records the athlete and coach surfaces
// read -- pilot progression gaps, drill assignments, and completions. All
// three GET routes already allow the parent role and enforce the guardian
// link server-side (assertActorCanAccessAthlete -> isGuardianLinkedToAthlete),
// and their projections are already athlete-safe (no detection payloads, no
// staff identifiers). A guardian reads exactly what their child reads, never
// more. This surface is deliberately read-only: logging a completion is the
// athlete's or a coach's act, not a guardian's, and the completions route
// enforces that on POST.
interface LinkedChild {
  athlete_id: string;
  full_name?: string;
}

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
  drill_name: string;
  drill_description: string;
  drill_display_name?: string;
  drill_display_description?: string;
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
  reps_completed?: number | null;
  notes: string;
  verification_status: string;
  completed_at: string;
  verified_at?: string | null;
}

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
  if (!rung) return null;
  return <span className={rung.className}><i>{rung.glyph}</i>{status.replaceAll('_', ' ')}</span>;
};

export default function ParentProgressionVisibilityPage() {
  const [children, setChildren] = useState<LinkedChild[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const [gaps, setGaps] = useState<ProgressionGap[]>([]);
  const [assignments, setAssignments] = useState<DrillAssignment[]>([]);
  const [completions, setCompletions] = useState<AssignmentCompletion[]>([]);
  const [progressionLoading, setProgressionLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // One card per child, from the route that runs the guardian visibility
  // gate: /api/pilot/athletes/list returns only the athletes this guardian
  // is linked to.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Unable to load your linked athletes.');
        const payload = (await response.json()) as { items?: LinkedChild[] };
        const items = payload.items ?? [];
        setChildren(items);
        setActiveChildId(items.length > 0 ? items[0].athlete_id : null);
        setErrorMessage(null);
      } catch (error) {
        setChildren([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load your linked athletes.');
      } finally {
        setChildrenLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    // No active child means no children were linked: the progression state is
    // still its initial [] and there is nothing to clear.
    if (!activeChildId) return;

    void (async () => {
      try {
        setProgressionLoading(true);
        setErrorMessage(null);

        const gapsRes = await fetch(
          `${apiBase()}/api/pilot/progression/gaps?athlete_id=${encodeURIComponent(activeChildId)}`,
          { method: 'GET', credentials: 'include' },
        );
        if (!gapsRes.ok) throw new Error(`Failed to fetch gaps: ${gapsRes.status}`);
        const gapsData = (await gapsRes.json()) as { items?: ProgressionGap[] };
        setGaps(gapsData.items ?? []);

        const assignRes = await fetch(
          `${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(activeChildId)}`,
          { method: 'GET', credentials: 'include' },
        );
        if (!assignRes.ok) throw new Error(`Failed to fetch assignments: ${assignRes.status}`);
        const assignData = (await assignRes.json()) as { items?: DrillAssignment[] };
        const assignmentItems = assignData.items ?? [];
        setAssignments(assignmentItems);

        // A child carries a handful of assignments at most, so this stays one
        // small request per assignment, same as the athlete's own surface.
        const allCompletions: AssignmentCompletion[] = [];
        for (const assignment of assignmentItems) {
          const compRes = await fetch(
            `${apiBase()}/api/pilot/progression/completions?assignment_id=${encodeURIComponent(assignment.assignment_id)}`,
            { method: 'GET', credentials: 'include' },
          );
          if (compRes.ok) {
            const compData = (await compRes.json()) as { items?: AssignmentCompletion[] };
            allCompletions.push(...(compData.items ?? []));
          }
        }
        setCompletions(allCompletions);
      } catch (error) {
        setGaps([]);
        setAssignments([]);
        setCompletions([]);
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load progression data.');
      } finally {
        setProgressionLoading(false);
      }
    })();
  }, [activeChildId]);

  const activeChild = children.find((child) => child.athlete_id === activeChildId);
  const loading = childrenLoading || progressionLoading;

  const completionsForAssignment = (assignmentId: string) =>
    completions.filter((completion) => completion.assignment_id === assignmentId);

  return (
    <RoleStandaloneView roleLabel="Parent Hub" routeLabel="/parent/progression-visibility" allowedRoles={['parent']} showShellHeader={false}>
      {/* Family-facing surface — warm canvas ground (Law 6), paper panels on it. */}
      <div className="on-canvas min-h-full rounded-[var(--r-lg)] p-[var(--s5)] md:p-[var(--s6)]">
        <div className="mx-auto w-full max-w-[1080px] space-y-[var(--s6)]">
          <header className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow">Closed-Loop Progression Intelligence</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              {activeChild ? `${activeChild.full_name || 'Your Athlete'}'s Progression` : 'Parent Progression Visibility'}
            </h1>
            <p className="t-body mt-[var(--s3)]">
              The gaps your child&rsquo;s coaches have identified, the drills assigned to close them, and how the
              work is going &mdash; the same record your child and their coach read. This view is read-only:
              completions are logged by your athlete on the floor and verified by a coach.
            </p>
            {errorMessage ? (
              <div className="alert alert--critical alert--tight mt-[var(--s4)]" role="alert">
                <div className="alert-body">
                  <span className="badge badge--locked"><i>✕</i>Failed</span>
                  <p className="alert-msg mt-[var(--s3)]">{errorMessage}</p>
                </div>
              </div>
            ) : null}
          </header>

          {children.length > 1 ? (
            <nav aria-label="Choose athlete" className="flex flex-wrap gap-[var(--s3)]">
              {children.map((child) => (
                <button
                  key={child.athlete_id}
                  type="button"
                  className={child.athlete_id === activeChildId ? 'btn' : 'btn btn--ghost'}
                  aria-pressed={child.athlete_id === activeChildId}
                  onClick={() => setActiveChildId(child.athlete_id)}
                >
                  {child.full_name || 'Unknown'}
                </button>
              ))}
            </nav>
          ) : null}

          {loading ? (
            <div className="mat-paper flex justify-center rounded-[var(--r-lg)] py-[var(--s7)]">
              <span className="working">Loading progression data...</span>
            </div>
          ) : children.length === 0 ? (
            <div className="mat-paper rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No linked athletes</div>
                <p className="empty-msg mx-auto">
                  Your account is not linked to an athlete yet. Ask the front desk to connect your family.
                </p>
              </div>
            </div>
          ) : gaps.length === 0 && assignments.length === 0 ? (
            <div className="mat-paper rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">🥊</div>
                <div className="empty-title">No progression gaps on record</div>
                <p className="empty-msg mx-auto">
                  When a coach identifies a development gap and assigns drills, it will show up here.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s6)]">
              <section>
                <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Identified Gaps</h2>
                <div className="grid grid-cols-1 gap-[var(--s4)] md:grid-cols-2">
                  {gaps.map((gap) => (
                    <article key={gap.gap_id} className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="mb-[var(--s3)] flex items-start justify-between gap-[var(--s3)]">
                        <div>
                          <h3 className="t-body font-semibold capitalize">{gap.gap_type.replaceAll('_', ' ')}</h3>
                          <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{gap.gap_description}</p>
                        </div>
                        <GapBadge severity={gap.severity} />
                      </div>
                      <div className="flex items-center gap-[var(--s3)]">
                        <StatusBadge status={gap.status} type="gap" />
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          Identified {formatGymDateNumeric(gap.created_at)}
                        </span>
                      </div>
                      <RabbitHole anchor={{ anchorType: 'gap_type', anchorKey: gap.gap_type }} className={GAP_RABBIT_HOLE_CLASS} />
                      <RabbitHole anchor={{ anchorType: 'severity', anchorKey: gap.severity }} className={GAP_RABBIT_HOLE_CLASS} />
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Drill Assignments</h2>
                {assignments.length === 0 ? (
                  <div className="mat-paper rounded-[var(--r-lg)]">
                    <div className="empty" style={{ padding: 'var(--s6) var(--s5)' }}>
                      <p className="empty-msg mx-auto">No drills assigned yet</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-[var(--s4)]">
                    {assignments.map((assignment) => {
                      const assignmentCompletions = completionsForAssignment(assignment.assignment_id);
                      return (
                        <article key={assignment.assignment_id} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
                          <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                            <div>
                              <h3 className="t-body font-semibold">
                                {assignment.drill_display_name || assignment.drill_name}
                              </h3>
                              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                                {assignment.drill_display_description || assignment.drill_description}
                              </p>
                            </div>
                            <StatusBadge status={assignment.status} type="assignment" />
                          </div>
                          <dl className="mt-[var(--s4)] flex flex-wrap gap-x-[var(--s5)] gap-y-[var(--s2)]">
                            <div>
                              <dt className="t-label">Completion</dt>
                              <dd className="t-data">{Math.min(Math.max(assignment.completion_percentage, 0), 100)}%</dd>
                            </div>
                            {assignment.frequency_per_week ? (
                              <div>
                                <dt className="t-label">Per week</dt>
                                <dd className="t-data">{assignment.frequency_per_week}x</dd>
                              </div>
                            ) : null}
                            {assignment.due_date ? (
                              <div>
                                <dt className="t-label">Due</dt>
                                <dd className="t-data">{formatGymDateNumeric(assignment.due_date)}</dd>
                              </div>
                            ) : null}
                          </dl>
                          {assignmentCompletions.length > 0 ? (
                            <div className="mt-[var(--s4)]">
                              <p className="t-label">Logged work</p>
                              <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                                {assignmentCompletions.map((completion) => (
                                  <li key={completion.completion_id} className="flex flex-wrap items-center gap-[var(--s3)]">
                                    <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                                      {formatGymDateNumeric(completion.completed_at)}
                                    </span>
                                    {completion.reps_completed != null ? (
                                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                                        {completion.reps_completed} reps
                                      </span>
                                    ) : null}
                                    <StatusBadge status={completion.verification_status} type="completion" />
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          <div className="flex flex-wrap gap-[var(--s3)]">
            <Link href="/parent/dashboard" className="btn btn--ghost">
              Back to Parent Hub
            </Link>
          </div>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
