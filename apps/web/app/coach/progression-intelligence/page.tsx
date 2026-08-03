'use client';

import { useEffect, useState } from 'react';
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
  drill_name: string;
  drill_description: string;
  due_date: string | null;
  status: string;
  completion_percentage: number;
}

export default function CoachProgressionIntelligencePage() {
  const [gaps, setGaps] = useState<ProgressionGap[]>([]);
  const [assignments, setAssignments] = useState<DrillAssignment[]>([]);
  const [selectedAthlete, setSelectedAthlete] = useState('');

  const [errorMessage, setErrorMessage] = useState('');
  const [showGapForm, setShowGapForm] = useState(false);
  const [newGap, setNewGap] = useState({
    gap_type: 'technique',
    gap_description: '',
    severity: 'medium',
  });

  // Load gaps and assignments
  useEffect(() => {
    void (async () => {
      try {
        if (!selectedAthlete) return;

        const [gapsRes, assignRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${selectedAthlete}`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/progression/assignments?athlete_id=${selectedAthlete}`, { credentials: 'include' }),
        ]);

        if (!gapsRes.ok || !assignRes.ok) {
          throw new Error('Unable to load progression data.');
        }

        const gapsData = (await gapsRes.json()) as { items?: ProgressionGap[] };
        const assignData = (await assignRes.json()) as { items?: DrillAssignment[] };

        setGaps(gapsData.items ?? []);
        setAssignments(assignData.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load progression data.');
      }
    })();
  }, [selectedAthlete]);

  const handleCreateGap = async () => {
    if (!selectedAthlete || !newGap.gap_description) {
      setErrorMessage('Please select athlete and describe gap');
      return;
    }

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

      // Reload gaps
      const reloadRes = await fetch(`${apiBase()}/api/pilot/progression/gaps?athlete_id=${selectedAthlete}`, { credentials: 'include' });
      if (reloadRes.ok) {
        const data = (await reloadRes.json()) as { items?: ProgressionGap[] };
        setGaps(data.items ?? []);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create gap');
    }
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

        {/* Athlete Selector */}
        <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <div className="field">
            <label htmlFor="athlete-input" className="t-label">Select Athlete</label>
            <input
              id="athlete-input"
              type="text"
              placeholder="Enter athlete ID (e.g., athlete-001)"
              value={selectedAthlete}
              onChange={(e) => setSelectedAthlete(e.target.value)}
              className="input"
            />
          </div>
        </div>

        {selectedAthlete && (
          <>
            {/* Progression Gaps Section */}
            <section className="space-y-[var(--s4)]">
              <div className="flex items-center justify-between gap-[var(--s3)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Progression Gaps ({gaps.length})</h2>
                <button
                  onClick={() => setShowGapForm(!showGapForm)}
                  className="btn btn--ghost"
                >
                  {showGapForm ? 'Cancel' : '+ Add Gap'}
                </button>
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
                  <button
                    onClick={handleCreateGap}
                    className="btn w-full"
                  >
                    Create Gap
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
                  ))
                )}
              </div>
            </section>

            {/* Drill Assignments Section */}
            <section>
              <h2 className="t-command mb-[var(--s4)] text-[length:var(--t-lg)]">Assigned Drills ({assignments.length})</h2>
              <div className="space-y-[var(--s3)]">
                {assignments.length === 0 ? (
                  <p className="t-body text-[color:var(--bone-300)]">No drills assigned yet.</p>
                ) : (
                  assignments.map((assignment) => (
                    <div key={assignment.assignment_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="flex items-start justify-between gap-[var(--s3)]">
                        <div className="flex-1">
                          <p className="font-semibold text-[color:var(--bone-100)]">{assignment.drill_name}</p>
                          <p className="t-muted text-[color:var(--bone-300)]">{assignment.drill_description}</p>
                          {/* A plain completion meter, not a .gauge: completion
                              has no danger threshold, so it gets no arc and no
                              saturated colour (Law 2). */}
                          <div className="mt-[var(--s3)] h-2 rounded-[var(--r-sm)] bg-[rgba(0,0,0,.4)]">
                            <div
                              className="h-full rounded-[var(--r-sm)] bg-[var(--brass-500)]"
                              style={{ width: `${assignment.completion_percentage}%` }}
                            />
                          </div>
                          <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">{assignment.completion_percentage}% complete</p>
                        </div>
                      </div>
                    </div>
                  ))
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
