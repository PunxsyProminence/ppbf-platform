'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RabbitHole from '@/components/RabbitHole';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

// A rabbit hole renders its own light panel, so on this dark surface it keeps
// that palette and takes only the rule colour and the spacing from the page.
// Each carries its own top margin rather than sitting in a shared wrapper: two
// anchors are read per gap and either may have nothing to show, so there must
// be no container left behind when they do not.
const GAP_RABBIT_HOLE_CLASS =
  'mt-3 border-l-4 border-[color:var(--brass-300)] bg-[var(--canvas-tan-light)] p-3';

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
      <div className="space-y-6">
        <header className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[color:var(--bone-100)]">Progression Gaps → Drills → Verification</h1>
          <p className="mt-2 text-sm text-[color:var(--bone-300)]">
            Detect performance gaps, assign drills, and track athlete completion and progression.
          </p>
          {errorMessage ? <p className="mt-2 text-xs text-[var(--locked-ink)]">{errorMessage}</p> : null}
        </header>

        {/* Athlete Selector */}
        <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
          <label htmlFor="athlete-input" className="block text-sm font-semibold text-[color:var(--bone-200)]">Select Athlete</label>
          <input
            id="athlete-input"
            type="text"
            placeholder="Enter athlete ID (e.g., athlete-001)"
            value={selectedAthlete}
            onChange={(e) => setSelectedAthlete(e.target.value)}
            className="mt-2 w-full border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-[color:var(--bone-200)] placeholder-[var(--bone-400)]"
          />
        </div>

        {selectedAthlete && (
          <>
            {/* Progression Gaps Section */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-[color:var(--bone-100)]">Progression Gaps ({gaps.length})</h2>
                <button
                  onClick={() => setShowGapForm(!showGapForm)}
                  className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-800)] px-3 py-1 text-xs font-bold text-[color:var(--brass-300)]"
                >
                  {showGapForm ? 'Cancel' : '+ Add Gap'}
                </button>
              </div>

              {showGapForm && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4 space-y-3">
                  <div>
                    <label htmlFor="gap-type-select" className="block text-xs font-bold uppercase text-[color:var(--brass-300)]">Gap Type</label>
                    <select
                      id="gap-type-select"
                      value={newGap.gap_type}
                      onChange={(e) => setNewGap({ ...newGap, gap_type: e.target.value })}
                      className="mt-1 w-full border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-[color:var(--bone-200)]"
                    >
                      <option value="technique">Technique</option>
                      <option value="strength">Strength</option>
                      <option value="endurance">Endurance</option>
                      <option value="skill">Skill</option>
                      <option value="mental">Mental</option>
                      <option value="tactical">Tactical</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="gap-desc-textarea" className="block text-xs font-bold uppercase text-[color:var(--brass-300)]">Description</label>
                    <textarea
                      id="gap-desc-textarea"
                      value={newGap.gap_description}
                      onChange={(e) => setNewGap({ ...newGap, gap_description: e.target.value })}
                      placeholder="Describe the performance gap..."
                      className="mt-1 w-full border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-[color:var(--bone-200)]"
                      rows={3}
                    />
                  </div>
                  <div>
                    <label htmlFor="severity-select" className="block text-xs font-bold uppercase text-[color:var(--brass-300)]">Severity</label>
                    <select
                      id="severity-select"
                      value={newGap.severity}
                      onChange={(e) => setNewGap({ ...newGap, severity: e.target.value })}
                      className="mt-1 w-full border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-[color:var(--bone-200)]"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <button
                    onClick={handleCreateGap}
                    className="w-full border-2 border-[color:var(--brass-700)] bg-[var(--hide-800)] py-2 text-xs font-bold uppercase text-[color:var(--brass-300)]"
                  >
                    Create Gap
                  </button>
                </div>
              )}

              <div className="space-y-2">
                {gaps.length === 0 ? (
                  <p className="text-sm text-[var(--bone-400)]">No gaps identified yet.</p>
                ) : (
                  gaps.map((gap) => (
                    <div key={gap.gap_id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <p className="font-semibold text-[color:var(--bone-200)]">{gap.gap_description}</p>
                          <div className="mt-1 flex gap-2">
                            <span className="text-xs font-mono text-[color:var(--brass-300)]">{gap.gap_type}</span>
                            <span className="text-xs font-mono text-[color:var(--brass-300)]">{gap.severity}</span>
                            <span className="text-xs font-mono text-[var(--bone-400)]">{gap.status}</span>
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
              <h2 className="mb-4 text-lg font-bold text-[color:var(--bone-100)]">Assigned Drills ({assignments.length})</h2>
              <div className="space-y-2">
                {assignments.length === 0 ? (
                  <p className="text-sm text-[var(--bone-400)]">No drills assigned yet.</p>
                ) : (
                  assignments.map((assignment) => (
                    <div key={assignment.assignment_id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <p className="font-semibold text-[color:var(--bone-200)]">{assignment.drill_name}</p>
                          <p className="text-xs text-[color:var(--bone-300)]">{assignment.drill_description}</p>
                          <div className="mt-2 bg-[var(--hide-950)] h-2 border border-[color:var(--hide-600)]">
                            <div
                              className="h-full bg-[var(--brass-300)]"
                              style={{ width: `${assignment.completion_percentage}%` }}
                            />
                          </div>
                          <p className="mt-1 text-xs text-[var(--bone-400)]">{assignment.completion_percentage}% complete</p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/review-queue" className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-800)] px-4 py-2 text-xs font-mono text-[color:var(--brass-300)]">
            Back to Coach Workspace
          </Link>
          <Link href="/rabbit-holes" className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-800)] px-4 py-2 text-xs font-mono text-[color:var(--brass-300)]">
            Write a Rabbit Hole
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
