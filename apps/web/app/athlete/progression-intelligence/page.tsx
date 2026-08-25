'use client';

import { useEffect, useState } from 'react';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

const GAP_RABBIT_HOLE_CLASS = 'mat-paper mt-[var(--s4)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s4)]';

/*
 * What an athlete reads when something on this page does not load.
 *
 * These lines used to be `Failed to fetch gaps: ${res.status}`,
 * `Failed to fetch assignments: ${res.status}` and `Log failed (${res.status})`
 * -- a stored HTTP status printed to a kid on a gym tablet, the same defect as
 * the raw review_state enum /athlete/video-analysis used to show. A status code
 * says nothing an athlete can act on, and "Failed" on its own reads as a
 * verdict on them rather than on the network. Each line says what did not
 * happen, what is still true, and what to do next.
 *
 * These are also the ONLY failure strings this page will show. `err.message` is
 * never rendered straight through: on a dead network the browser writes that
 * message itself, and what it writes is "Failed to fetch".
 */
const GAPS_DID_NOT_LOAD =
  'The gaps your coach wrote down did not load. Nothing is lost — they are still there. Try again in a minute.';
const DRILLS_DID_NOT_LOAD =
  'Your drills did not load. Nothing is lost — the work your coach assigned is still there. Try again in a minute.';
const SCREEN_DID_NOT_LOAD =
  'This screen did not load. Nothing is lost — your gaps and your drills are still there. Try again in a minute.';
const LOG_DID_NOT_SAVE =
  'That log did not save. What you typed is still in the box — try Save log again in a minute.';

// Pinned by e2e/athlete-journey.spec.ts, which asserts it is ABSENT on a
// session the gate just accepted.
const SESSION_UNRESOLVED = 'Unable to resolve athlete session. Sign in again.';

// Only copy written in this file reaches the athlete; anything else that
// arrives on an Error -- the browser's own network text, an API message
// written for a developer -- is logged instead.
const ATHLETE_LOAD_COPY: ReadonlySet<string> = new Set([
  GAPS_DID_NOT_LOAD,
  DRILLS_DID_NOT_LOAD,
  SCREEN_DID_NOT_LOAD,
]);

interface ProgressionGap {
  gap_id: string;
  athlete_id: string;
  gap_type: string;
  gap_description: string;
  severity: string;
  status: string;
  created_at: string;
  updated_at?: string;
}

interface DrillAssignment {
  assignment_id: string;
  // Null on a Coach Card -- work a coach issued directly, with no detection
  // gap behind it. getGapForAssignment already tolerates it (find over the
  // gaps list simply misses), so the card renders without an "Assigned for"
  // line rather than with an invented gap.
  gap_id: string | null;
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
  reps_completed?: number;
  notes: string;
  verification_status: string;
  completed_at: string;
  verified_at?: string;
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
  const label = status.replaceAll('_', ' ');
  if (!rung) {
    return <span className="badge badge--filed"><i>◌</i>{label}</span>;
  }
  return <span className={rung.className}><i>{rung.glyph}</i>{label}</span>;
};

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
  // A failed read is not an empty record. This says which one the page is
  // looking at, so the empty state -- a claim about the athlete's COACH -- is
  // never made on the strength of a network failure.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [loggingAssignmentId, setLoggingAssignmentId] = useState<string | null>(null);
  const [logReps, setLogReps] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [logBusy, setLogBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (!response.ok || !payload.authenticated || !payload.athlete_id) {
          throw new Error(SESSION_UNRESOLVED);
        }
        setAthleteId(payload.athlete_id);
      } catch (err) {
        // Logged, not displayed.
        console.error({ event: 'athlete-progression-session-failed', error: err });
        // A refused session is worth telling an athlete to sign in again. A
        // network that never answered is not -- that advice would send a kid
        // to the login screen over a dropped tablet connection.
        setErrorMessage(err instanceof Error && err.message === SESSION_UNRESOLVED ? SESSION_UNRESOLVED : SCREEN_DID_NOT_LOAD);
        setLoadFailed(true);
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!athleteId) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);
        setLoadFailed(false);

        const gapsRes = await fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${encodeURIComponent(athleteId)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        // The status rides along on `cause` -- logged for diagnosis below, never rendered.
        if (!gapsRes.ok) throw new Error(GAPS_DID_NOT_LOAD, { cause: { status: gapsRes.status } });
        const gapsData = await gapsRes.json();
        setGaps(gapsData.items || []);

        const assignRes = await fetch(`${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(athleteId)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (!assignRes.ok) throw new Error(DRILLS_DID_NOT_LOAD, { cause: { status: assignRes.status } });
        const assignData = await assignRes.json();
        setAssignments(assignData.items || []);

        if ((assignData.items || []).length > 0) {
          const allCompletions: AssignmentCompletion[] = [];
          for (const assignment of assignData.items) {
            const compRes = await fetch(`${apiBase()}/api/pilot/progression/completions?assignment_id=${assignment.assignment_id}`, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
            });
            if (compRes.ok) {
              const compData = await compRes.json();
              allCompletions.push(...(compData.items || []));
            }
          }
          setCompletions(allCompletions);
        } else {
          setCompletions([]);
        }
      } catch (err) {
        // Logged, not displayed -- the status and the stack stay available to
        // whoever is debugging the gym's tablet.
        console.error({ event: 'athlete-progression-load-failed', error: err });
        setErrorMessage(err instanceof Error && ATHLETE_LOAD_COPY.has(err.message) ? err.message : SCREEN_DID_NOT_LOAD);
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [athleteId, reloadToken]);

  const handleLogCompletion = async (assignmentId: string) => {
    if (!athleteId) return;
    setLogBusy(true);
    try {
      const body: Record<string, unknown> = {
        assignment_id: assignmentId,
        athlete_id: athleteId,
      };
      if (logReps.trim()) body.reps_completed = Number(logReps);
      if (logNotes.trim()) body.notes = logNotes.trim();

      const res = await fetch(`${apiBase()}/api/pilot/progression/completions`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        // The API's `error` field is written for a developer -- "Assignment
        // does not belong to the specified athlete", "Forbidden", "Not found"
        // -- and none of it is a sentence to hand a child who just finished
        // their reps. It rides on `cause` to the log instead.
        throw new Error(LOG_DID_NOT_SAVE, { cause: { status: res.status, detail } });
      }
      setLoggingAssignmentId(null);
      setLogReps('');
      setLogNotes('');
      setReloadToken((t) => t + 1);
    } catch (err) {
      // Logged, not displayed.
      console.error({ event: 'athlete-progression-log-failed', error: err });
      // A failed log is not a failed read: the gaps and drills already on
      // screen were read fine and stay exactly where they are.
      setErrorMessage(LOG_DID_NOT_SAVE);
    } finally {
      setLogBusy(false);
    }
  };

  const getCompletionsForAssignment = (assignmentId: string) => {
    return completions.filter((c) => c.assignment_id === assignmentId);
  };

  const getGapForAssignment = (assignmentId: string) => {
    const assignment = assignments.find((a) => a.assignment_id === assignmentId);
    return gaps.find((g) => g.gap_id === assignment?.gap_id);
  };

  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/progression-intelligence" allowedRoles={['athlete']} showShellHeader={false} room="floor">
      <div className="max-w-5xl mx-auto">
        <div className="mb-[var(--s6)]">
          {/* The h1 was already right. Above it sat the capability's register
              name -- "Closed-Loop Progression Intelligence" -- which is what
              this is called in /operations, where the people who build it
              read. On an athlete's own screen it is the night console leaning
              over a kid's shoulder. The register keeps its name; this page
              says what it is. */}
          <p className="t-eyebrow">Drills</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Your Progression</h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            What your coach wants you working on, and somewhere to say when you have done it.
          </p>
        </div>

        {errorMessage && (
          <div className="alert alert--critical" role="alert">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              {/* "Failed", alone and in bold, is a word this gym uses about
                  rounds, not about a kid's screen. The title now says which
                  thing did not happen; the message under it says what is
                  still true. */}
              <p className="alert-title">{loadFailed ? 'This screen did not load' : 'That log did not save'}</p>
              <p className="alert-msg">{errorMessage}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-[var(--s7)]">
            <span className="working">Loading your progression data...</span>
          </div>
        ) : gaps.length === 0 && assignments.length === 0 ? (
          /* An unread record and an empty one look identical and mean opposite
             things. "No progression gaps assigned" is a claim about the
             athlete's COACH; a read that failed gives no standing to make it,
             so the alert above is left to speak alone. The same distinction
             the loading branch above draws -- see page.test.tsx. */
          loadFailed ? null : (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">🥊</div>
                <div className="empty-title">No progression gaps assigned</div>
                <p className="empty-msg mx-auto">Your coaches will identify gaps and assign drills to help you improve</p>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-[var(--s6)]">
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
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>Identified {formatGymDateNumeric(gap.created_at)}</span>
                    </div>
                    <RabbitHole anchor={{ anchorType: 'gap_type', anchorKey: gap.gap_type }} className={GAP_RABBIT_HOLE_CLASS} />
                    <RabbitHole anchor={{ anchorType: 'severity', anchorKey: gap.severity }} className={GAP_RABBIT_HOLE_CLASS} />
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="t-command mb-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Drill Assignments</h2>
              {assignments.length === 0 ? (
                /* Same rule one level down: the gaps read can succeed while
                   the assignments read fails, and "No drills assigned yet"
                   would then be the network talking about the coach. */
                loadFailed ? null : (
                  <div className="mat-leather rounded-[var(--r-lg)]">
                    <div className="empty" style={{ padding: 'var(--s6) var(--s5)' }}>
                      <p className="empty-msg mx-auto">No drills assigned yet</p>
                    </div>
                  </div>
                )
              ) : (
                <div className="space-y-[var(--s4)]">
                  {assignments.map((assignment) => {
                    const gap = getGapForAssignment(assignment.assignment_id);
                    const assignmentCompletions = getCompletionsForAssignment(assignment.assignment_id);
                    const progressPercent = assignment.completion_percentage;
                    const isLogging = loggingAssignmentId === assignment.assignment_id;

                    return (
                      <div key={assignment.assignment_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                        <div className="flex items-start justify-between gap-[var(--s4)] mb-[var(--s4)]">
                          <div className="flex-1">
                            <h3 className="text-[length:var(--t-md)] font-bold text-[color:var(--bone-100)]">
                              {assignment.drill_display_name || assignment.drill_name}
                            </h3>
                            <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                              {assignment.drill_display_description || assignment.drill_description}
                            </p>
                            {gap && (
                              <p className="t-muted mt-[var(--s3)]">
                                Assigned for:{' '}
                                <span className="font-medium text-[color:var(--bone-200)]">{gap.gap_type.replaceAll('_', ' ')}</span>
                              </p>
                            )}
                          </div>
                          <div className="text-right">
                            <StatusBadge status={assignment.status} type="assignment" />
                            <p className="t-label mt-[var(--s3)]">{assignment.drill_difficulty.replaceAll('_', ' ')}</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--s4)] mb-[var(--s4)]">
                          {assignment.rep_count != null && (
                            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                              <p className="t-label">Reps</p>
                              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.rep_count}</p>
                            </div>
                          )}
                          {assignment.duration_minutes != null && (
                            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                              <p className="t-label">Duration</p>
                              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.duration_minutes} min</p>
                            </div>
                          )}
                          {assignment.frequency_per_week != null && (
                            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                              <p className="t-label">Frequency</p>
                              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{assignment.frequency_per_week}x/week</p>
                            </div>
                          )}
                          {assignment.due_date && (
                            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                              <p className="t-label">Due Date</p>
                              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{formatCalendarDay(assignment.due_date)}</p>
                            </div>
                          )}
                        </div>

                        <div className="mb-[var(--s4)] flex items-center gap-[var(--s5)]">
                          <CompletionGauge percent={Math.min(progressPercent, 100)} />
                        </div>

                        {/* Log completion form */}
                        {assignment.status !== 'cancelled' && assignment.status !== 'completed' && (
                          <div className="mb-[var(--s4)]">
                            {!isLogging ? (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => {
                                  setLoggingAssignmentId(assignment.assignment_id);
                                  setLogReps('');
                                  setLogNotes('');
                                }}
                              >
                                Log completion
                              </button>
                            ) : (
                              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s3)]">
                                <div className="field">
                                  <label className="t-label" htmlFor={`reps-${assignment.assignment_id}`}>Reps completed (optional)</label>
                                  <input
                                    id={`reps-${assignment.assignment_id}`}
                                    type="number"
                                    min={0}
                                    className="input"
                                    value={logReps}
                                    onChange={(e) => setLogReps(e.target.value)}
                                  />
                                </div>
                                <div className="field">
                                  <label className="t-label" htmlFor={`notes-${assignment.assignment_id}`}>Notes (optional)</label>
                                  <textarea
                                    id={`notes-${assignment.assignment_id}`}
                                    className="textarea"
                                    rows={2}
                                    value={logNotes}
                                    onChange={(e) => setLogNotes(e.target.value)}
                                    placeholder="How it felt, what you focused on…"
                                  />
                                </div>
                                <div className="flex gap-[var(--s2)]">
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={logBusy}
                                    onClick={() => void handleLogCompletion(assignment.assignment_id)}
                                  >
                                    {logBusy ? 'Saving…' : 'Save log'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    disabled={logBusy}
                                    onClick={() => setLoggingAssignmentId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {assignmentCompletions.length > 0 && (
                          <div className="border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
                            <p className="t-label mb-[var(--s4)]">Completion History</p>
                            <div className="space-y-[var(--s3)]">
                              {assignmentCompletions
                                .toSorted((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                                .map((completion) => (
                                  <div key={completion.completion_id} className="mat-leather--raised flex items-start gap-[var(--s4)] rounded-[var(--r-md)] p-[var(--s4)]">
                                    <div className="flex-1">
                                      <div className="flex items-center gap-[var(--s3)]">
                                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                                          {formatGymDateNumeric(completion.completed_at)}
                                        </span>
                                        <StatusBadge status={completion.verification_status} type="completion" />
                                      </div>
                                      {completion.reps_completed != null && (
                                        <p className="t-muted mt-[var(--s2)]">Completed {completion.reps_completed} reps</p>
                                      )}
                                      {completion.notes && (
                                        <p className="mt-[var(--s3)] text-[length:var(--t-sm)] italic text-[color:var(--bone-300)]">&ldquo;{completion.notes}&rdquo;</p>
                                      )}
                                      {completion.verified_at && (
                                        <p className="mt-[var(--s2)] text-[length:var(--t-xs)] font-medium text-[color:var(--cleared-ink)]">
                                          ✓ Verified on {formatGymDateNumeric(completion.verified_at)}
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

            {assignments.length > 0 && (
              <section className="grid grid-cols-1 md:grid-cols-3 gap-[var(--s4)]">
                <div className="stat">
                  <p className="stat-label">Total Gaps</p>
                  <p className="stat-val">{gaps.length}</p>
                </div>
                <div className="stat">
                  <p className="stat-label">Active Drills</p>
                  <p className="stat-val">
                    {assignments.filter((a) => a.status === 'in_progress' || a.status === 'assigned').length}
                  </p>
                </div>
                <div className="stat">
                  <p className="stat-label">Completed</p>
                  <p className="stat-val">
                    {assignments.filter((a) => a.status === 'completed').length}
                  </p>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </RoleStandaloneView>
  );
}
