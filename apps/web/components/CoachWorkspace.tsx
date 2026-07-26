'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import { CoachSummaryPanel, HelpPanel } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';

type TabID = 'dashboard' | 'floor' | 'athlete-floor-plans' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';
type ReadinessStatus = 'GREEN' | 'YELLOW' | 'RED';

interface CoachAthleteFloorPlan {
  athleteName: string;
  readiness: ReadinessStatus;
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    dueDate: string;
    priority: 'High' | 'Normal';
  }>;
}

interface Athlete {
  id: string;
  name: string;
  track: string;
  readiness: ReadinessStatus | null;
  injuryFlag: boolean | null;
  attendance: 'Present' | 'Late' | 'Excused' | 'Absent' | null;
}

interface ShadowReviewQueueItem {
  intake_case_id: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
  summary: string;
  document_count: number;
  updated_at: string;
}

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

function readinessDotClass(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return 'bg-green-500';
  if (readiness === 'YELLOW') return 'bg-yellow-500';
  if (readiness === 'RED') return 'bg-red-500';
  return 'bg-[#6f6f6f]';
}

export default function CoachWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [athleteFloorPlans, setAthleteFloorPlans] = useState<CoachAthleteFloorPlan[]>([]);
  const [floorPlansLoading, setFloorPlansLoading] = useState(true);
  const [floorPlansError, setFloorPlansError] = useState('');
  const [coachAccountId, setCoachAccountId] = useState('');
  const [coachSessionError, setCoachSessionError] = useState('');
  const [reviewSessionId, setReviewSessionId] = useState('');
  const [reviewDecision, setReviewDecision] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSyncMessage, setReviewSyncMessage] = useState('');
  const [shadowQueue, setShadowQueue] = useState<ShadowReviewQueueItem[]>([]);
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowReadError, setShadowReadError] = useState('');
  const [shadowLoading, setShadowLoading] = useState(true);

  // Dashboard data - Real API
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(true);
  const [athletesError, setAthletesError] = useState<string | null>(null);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

  const loadFloorPlans = useCallback(async () => {
    setFloorPlansLoading(true);
    setFloorPlansError('');
    try {
      const response = await fetch('/api/pilot/floor-plans?limit=50', {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Athlete floor-plan drafts are unavailable.');
      }

      const payload = (await response.json()) as { items?: CoachAthleteFloorPlan[] };
      setAthleteFloorPlans(payload.items ?? []);
    } catch (error) {
      setAthleteFloorPlans([]);
      setFloorPlansError(error instanceof Error ? error.message : 'Athlete floor-plan drafts are unavailable.');
    } finally {
      setFloorPlansLoading(false);
    }
  }, []);

  const loadAthletes = useCallback(async () => {
    setAthletesLoading(true);
    setAthletesError(null);
    try {
      const response = await fetch('/api/pilot/athletes/list', {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('The athlete roster is unavailable.');
      }

      const data = (await response.json()) as {
        items?: Array<{ athlete_id: string; full_name?: string; gym_status?: string }>;
      };
      const athleteList: Athlete[] = (data.items ?? []).map((item) => ({
        id: item.athlete_id,
        name: item.full_name || 'Name not reported',
        track: item.gym_status || 'Track not reported',
        readiness: null,
        injuryFlag: null,
        attendance: null,
      }));

      setAthletes(athleteList);
      setSelectedAthleteId((current) => current ?? athleteList[0]?.id ?? null);
    } catch (error) {
      setAthletesError(error instanceof Error ? error.message : 'The athlete roster is unavailable.');
      setAthletes([]);
    } finally {
      setAthletesLoading(false);
    }
  }, []);

  const loadShadowReadModels = useCallback(async () => {
    setShadowLoading(true);
    setShadowReadError('');
    try {
      const [queueResult, observationResult] = await Promise.allSettled([
        fetch('/api/pilot/shadow/review-projection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20 }),
        }),
        fetch('/api/pilot/shadow/observation-projection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20 }),
        }),
      ]);

      let queueError = '';
      let observationError = '';

      if (queueResult.status === 'fulfilled' && queueResult.value.ok) {
        const queuePayload = (await queueResult.value.json()) as { queue?: ShadowReviewQueueItem[] };
        setShadowQueue(queuePayload.queue ?? []);
      } else {
        setShadowQueue([]);
        queueError = 'review projection';
      }

      if (observationResult.status === 'fulfilled' && observationResult.value.ok) {
        const observationPayload = (await observationResult.value.json()) as { items?: ShadowObservationItem[] };
        setShadowObservations(observationPayload.items ?? []);
      } else {
        setShadowObservations([]);
        observationError = 'observation projection';
      }

      if (queueError || observationError) {
        const failed = [queueError, observationError].filter(Boolean).join(' and ');
        setShadowReadError(`Unable to load SHADOW ${failed}.`);
      }
    } catch {
      setShadowQueue([]);
      setShadowObservations([]);
      setShadowReadError('Unable to load SHADOW read models.');
    } finally {
      setShadowLoading(false);
    }
  }, []);

  const loadCoachSession = useCallback(async () => {
    setCoachSessionError('');
    try {
      const response = await fetch('/api/pilot/auth/session', { method: 'POST' });
      const payload = (await response.json()) as { authenticated?: boolean; account_id?: string };
      if (response.ok && payload.authenticated && payload.account_id) {
        setCoachAccountId(payload.account_id);
        return;
      }

      setCoachAccountId('');
      setCoachSessionError('Coach session is unavailable. Sign in again before saving a review.');
    } catch {
      setCoachAccountId('');
      setCoachSessionError('Coach session could not be checked. Retry after confirming your connection.');
    }
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadFloorPlans();
      void loadAthletes();
      void loadShadowReadModels();
      void loadCoachSession();
    }, 0);

    return () => window.clearTimeout(loadTimer);
  }, [loadAthletes, loadCoachSession, loadFloorPlans, loadShadowReadModels]);

  async function submitCoachReview() {
    if (!reviewSessionId.trim()) {
      setReviewSyncMessage('Session ID is required.');
      return;
    }

    if (!coachAccountId.trim()) {
      setReviewSyncMessage('Coach account session not found.');
      return;
    }

    if (!reviewDecision) {
      setReviewSyncMessage('Choose a review decision.');
      return;
    }

    const now = new Date().toISOString();
    const reviewId = `review_${Date.now()}`;

    try {
      const response = await fetch('/api/pilot/coach-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review_id: reviewId,
          session_id: reviewSessionId.trim(),
          coach_id: coachAccountId,
          decision: reviewDecision,
          notes: reviewNotes.trim(),
          approved_flag: reviewDecision === 'approved',
          created_at: now,
          updated_at: now,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: 'Coach review could not be saved.' }))) as { error?: string };
        setReviewSyncMessage(payload.error || 'Coach review could not be saved.');
        return;
      }

      setReviewSyncMessage(`Coach review persisted (${reviewId}).`);
    } catch {
      setReviewSyncMessage('Coach review could not be saved. Check the connection and retry.');
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[#8b4444] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">Coach Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Coach Operations Workspace</h1>
            <p className="text-base text-[#b0a095] mt-2">Review verified organization records. Unconnected services stay visibly unavailable until real data is present.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[#cfbfae] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ShadowChatButton
              context="Coach Workspace"
              label="Open SHADOW Chat"
              className="border-[#8b4444] bg-[#2a1414] text-[#e8d7c6] hover:bg-[#3a1a1a]"
            />
            <button
              type="button"
              onClick={() => setActiveTab('shadow')}
              className="min-h-[40px] border-2 border-[#5a4a3a] bg-[#101010] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[#cfbfae] transition hover:border-[#8b4444]"
            >
              Open SHADOW Intel Tab
            </button>
          </div>
        </div>

        <div className="border border-[#694838] bg-[#14100d] p-4">
          <p className="text-sm text-[#d4a574] font-semibold">Coach Standard</p>
          <p className="mt-1 text-sm text-[#cfbfae]">Lead with discipline, protect the culture, and model the grind. The room rises when the coach stays locked in.</p>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <CoachSummaryPanel
          sessionStatus={null}
          rosterAthletes={athletesLoading || athletesError ? null : athletes.length}
          healthReports={null}
          reviewsNeeded={null}
          assignmentsDue={null}
        />

        {/* TAB NAVIGATION */}
        <div className={ui.tabContainer}>
          <div className={ui.tabRow}>
            {[
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'floor', label: 'Floor' },
              { id: 'athlete-floor-plans', label: 'Athlete Floor Plans' },
              { id: 'development', label: 'Development' },
              { id: 'goals', label: 'Goals' },
              { id: 'tasks', label: 'Tasks' },
              { id: 'assessments', label: 'Assessments' },
              { id: 'film-study', label: 'Film Study' },
              { id: 'athlete-reviews', label: 'Athlete Reviews' },
              { id: 'shadow', label: 'SHADOW Intel' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabID)}
                className={cx(
                  ui.tabButtonBase,
                  activeTab === tab.id ? ui.tabButtonActive : ui.tabButtonInactive,
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6 animate-fadeIn">
              <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Coach Dashboard"
                    label="SHADOW Chat"
                    className="min-h-[44px] border-[#8b4444] bg-[#2a1414] text-[#e8d7c6] hover:bg-[#3a1a1a]"
                  />
                  <Link
                    href="/schedule"
                    className="min-h-[44px] border border-[#8b4444] bg-[#2a1414] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a1a1a] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('floor')}
                    className="min-h-[44px] border border-[#8b4444] bg-[#2a1414] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a1a1a]"
                  >
                    Floor Status
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor-plans')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
                  >
                    Review Athlete Plans
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('tasks')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
                  >
                    Task Status
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
                  >
                    Open SHADOW Intel
                  </button>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <article className="border border-[#5a4a3a] bg-[#101010] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Check-in Reports</p>
                  <p className="mt-2 text-lg font-black text-[#f2e7da]">Not reported</p>
                  <p className="text-xs text-[#b0a095]">No verified check-in feed is connected.</p>
                </article>
                <article className="border border-[#5a4a3a] bg-[#101010] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Health Reports</p>
                  <p className="mt-2 text-lg font-black text-[#f2e7da]">Not reported</p>
                  <p className="text-xs text-[#b0a095]">This surface does not provide medical clearance.</p>
                </article>
                <article className="border border-[#5a4a3a] bg-[#101010] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Open Reviews</p>
                  <p className="mt-2 text-lg font-black text-[#f2e7da]">Unavailable</p>
                  <p className="text-xs text-[#b0a095]">A verified review-count feed is not connected.</p>
                </article>
              </section>

              <HelpPanel
                title="Coach Dashboard"
                description="Overview of your session status, athlete roster, and immediate action items."
                usage={[
                  'Use the roster only for identities returned by the live service',
                  'Treat missing check-in or health data as not reported',
                  'Confirm any training decision directly with the athlete and responsible staff'
                ]}
                mistakes={[
                  'Treating an absent value as a negative report',
                  'Using this screen as medical or sparring clearance',
                  'Assuming unsupported task and session data is current'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Session Status */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Today&apos;s Session</h3>
                  <p className="text-base font-semibold">Not connected yet</p>
                  <p className="text-xs text-[#b0a095]">Session name, time, status, and attendance are unavailable until the scheduler and check-in feeds are connected.</p>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Athlete Roster</h3>
                  
                  {athletesLoading && (
                    <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4 text-center">
                      <p className="text-[#b0a095] text-sm">Loading athletes...</p>
                      <div className="mt-3 flex justify-center">
                        <div className="animate-spin h-5 w-5 border-2 border-[#d4a574] border-t-transparent rounded-full"></div>
                      </div>
                    </div>
                  )}
                  
                  {athletesError && !athletesLoading && (
                    <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-red-400 text-sm font-semibold">Error loading athletes</p>
                        <button
                          type="button"
                          onClick={() => void loadAthletes()}
                          className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition"
                          aria-label="Retry loading athletes"
                        >
                          Retry
                        </button>
                      </div>
                      <p className="text-red-300 text-xs">{athletesError}</p>
                    </div>
                  )}
                  
                  {!athletesLoading && athletes.length === 0 && !athletesError && (
                    <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4 text-center">
                      <p className="text-[#b0a095] text-sm">No athletes found</p>
                    </div>
                  )}
                  
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {athletes.map(athlete => (
                      <button
                        type="button"
                        key={athlete.id}
                        onClick={() => setSelectedAthleteId(athlete.id)}
                        className={`w-full p-3 border-2 rounded cursor-pointer transition text-left ${
                          selectedAthleteId === athlete.id
                            ? 'bg-[#2a2a2a] border-[#8b4444]'
                            : 'bg-[#0f0f0f] border-[#4a4a4a] hover:border-[#8b4444]'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${readinessDotClass(athlete.readiness)}`}></div>
                            <span className="font-semibold">{athlete.name}</span>
                          </div>
                          <span className="text-xs text-[#8a8a8a]">Attendance: {athlete.attendance ?? 'Not reported'}</span>
                        </div>
                        <p className="mt-1 text-xs text-[#8a8a8a]">Check-in: {athlete.readiness ?? 'Not reported'} · Health report: {athlete.injuryFlag === null ? 'Not reported' : athlete.injuryFlag ? 'Reported' : 'No report on file'}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Open Tasks */}
                <div className="md:col-span-2 border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Tasks Due</h3>
                  <p className="text-base font-semibold">Not connected yet</p>
                  <p className="text-xs text-[#b0a095]">No coach-task service is connected, so this screen will not invent assignments or deadlines.</p>
                </div>
              </div>
            </div>
          )}

          {/* ATHLETE FLOOR PLANS */}
          {activeTab === 'athlete-floor-plans' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Athlete Floor Plans"
                description="Unverified draft metadata returned by the floor-plan service. Drafts are not medical clearance, sparring approval, or a training prescription."
                usage={[
                  'Confirm the athlete identity and source timestamp',
                  'Review the underlying source with a responsible human before acting',
                  'Treat source labels and draft item counts as unverified'
                ]}
                mistakes={[
                  'Treating a draft as an approved plan',
                  'Using a source label as medical or sparring clearance',
                  'Assuming missing data means no concern was reported'
                ]}
              />

              {floorPlansLoading ? (
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6">
                  <p className="text-sm text-[#d4a574] font-semibold">Loading unverified drafts…</p>
                </div>
              ) : floorPlansError ? (
                <div className="border-2 border-red-600 bg-red-900/20 p-6">
                  <p className="text-sm font-semibold text-red-300">{floorPlansError}</p>
                  <button
                    type="button"
                    onClick={() => void loadFloorPlans()}
                    className="mt-3 border border-red-500 px-3 py-2 text-xs font-bold uppercase text-red-200"
                  >
                    Retry
                  </button>
                </div>
              ) : athleteFloorPlans.length === 0 ? (
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6">
                  <p className="text-sm text-[#d4a574] font-semibold">No floor-plan drafts reported.</p>
                  <p className="mt-2 text-sm text-[#b0a095]">This does not indicate that an athlete is cleared or that no follow-up is needed.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {athleteFloorPlans.map((plan, index) => (
                    <article key={`${plan.athleteName}-${plan.generatedAt}-${index}`} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Unverified Draft</p>
                          <h4 className="text-lg font-semibold text-[#e8d7c6]">{plan.athleteName}</h4>
                          <p className="text-xs text-[#8a8a8a]">Source timestamp: {new Date(plan.generatedAt).toLocaleString()}</p>
                        </div>
                        <span className="inline-flex items-center rounded bg-[#4a4a4a] px-2 py-1 text-xs font-bold text-[#e8d7c6]">
                          Source label: {plan.readiness}
                        </span>
                      </div>
                      <div className="border border-[#694838] bg-[#0f0f0f] p-3">
                        <p className="text-sm font-semibold text-[#e8d7c6]">{plan.tasks.length} draft item{plan.tasks.length === 1 ? '' : 's'} hidden pending human verification.</p>
                        <p className="mt-1 text-xs text-[#b0a095]">No action, intensity, or clearance is recommended by this screen.</p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FLOOR */}
          {activeTab === 'floor' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Floor</h3>
                <p className="text-base font-semibold">Not connected yet</p>
                <p className="text-sm text-[#b0a095]">The live session, workout-block, observation, and progress services are not connected. No session status or training plan is shown.</p>
              </div>
            </div>
          )}

          {/* DEVELOPMENT */}
          {activeTab === 'development' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-3 animate-fadeIn">
              <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Development</h3>
              <p className="text-base font-semibold">Not connected yet</p>
              <p className="text-sm text-[#b0a095]">No verified certification, license, training-hour, or development-topic service is connected.</p>
            </div>
          )}

          {/* GOALS */}
          {activeTab === 'goals' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-3 animate-fadeIn">
              <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Goals</h3>
              <p className="text-base font-semibold">Not connected yet</p>
              <p className="text-sm text-[#b0a095]">No verified coach-goal service is connected, so progress, due dates, and completion values are unavailable.</p>
            </div>
          )}

          {/* TASKS */}
          {activeTab === 'tasks' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-3 animate-fadeIn">
              <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Tasks</h3>
              <p className="text-base font-semibold">Not connected yet</p>
              <p className="text-sm text-[#b0a095]">No verified coach-task service is connected. Assignments, priorities, statuses, and due dates are unavailable.</p>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="border-2 border-[#d4a574] bg-[#0f0f0f] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">SHADOW Review Data</h3>
                <p className="text-sm text-[#b0a095]">Only persisted review and observation records are shown below. This surface does not provide medical clearance, sparring approval, or an automatic training prescription.</p>
              </div>

              {shadowLoading ? (
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                  <p className="text-sm text-[#b0a095]">Loading SHADOW read models…</p>
                </div>
              ) : shadowReadError ? (
                <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-red-400 text-sm font-semibold">{shadowReadError}</p>
                    <button
                      type="button"
                      onClick={() => void loadShadowReadModels()}
                      className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition flex-shrink-0"
                      aria-label="Retry loading SHADOW read models"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[#d4a574]">SHADOW Review Projection</h3>
                  {shadowQueue.length === 0 ? (
                    <p className="mt-2 text-xs text-[#b0a095]">No review records reported.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowQueue.slice(0, 6).map((item) => (
                        <div key={item.intake_case_id} className="border border-[#5a4a3a] bg-[#101010] p-2 text-xs text-[#cfbfae]">
                          <p className="font-semibold text-[#e8d7c6]">{item.summary}</p>
                          <p>Status: {item.status}</p>
                          <p>Documents: {item.document_count}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[#d4a574]">SHADOW Observation Projection</h3>
                  {shadowObservations.length === 0 ? (
                    <p className="mt-2 text-xs text-[#b0a095]">No observation records reported.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowObservations.slice(0, 6).map((item) => (
                        <div key={item.id} className="border border-[#5a4a3a] bg-[#101010] p-2 text-xs text-[#cfbfae]">
                          <p className="font-semibold text-[#e8d7c6]">{item.label}</p>
                          <p>Source: {item.source}</p>
                          <p>State: {item.review_state}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          )}

          {/* ASSESSMENTS */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Coach Assessments</h3>
              <p className="text-base font-semibold">Not connected yet</p>
              <p className="text-sm text-[#b0a095]">No verified assessment service is connected. Leadership, communication, and teaching-impact results are unavailable.</p>
            </div>
          )}

          {/* FILM STUDY */}
          {activeTab === 'film-study' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Film Study</h3>
              <p className="text-base font-semibold">Not connected yet</p>
              <p className="text-sm text-[#b0a095]">Video upload, annotations, skill recognition, and technique scoring are unavailable. No AI analysis is implied.</p>
            </div>
          )}

          {/* ATHLETE REVIEWS */}
          {activeTab === 'athlete-reviews' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Athlete Performance Reviews</h3>
              <p className="text-[#b0a095]">Comprehensive athlete progress tracking and performance feedback.</p>
              <div className="border border-[#5a4a3a] bg-[#101010] p-3 space-y-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Persist Coach Review</p>
                {coachSessionError ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 border border-red-700 bg-red-900/20 p-2">
                    <p className="text-xs text-red-300">{coachSessionError}</p>
                    <button
                      type="button"
                      onClick={() => void loadCoachSession()}
                      className="border border-red-500 px-2 py-1 text-xs font-bold uppercase text-red-200"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                <input
                  value={reviewSessionId}
                  onChange={(event) => setReviewSessionId(event.target.value)}
                  placeholder="Session ID (from persisted session)"
                  className="h-11 w-full border border-[#8b4444] bg-[#141414] px-3 text-sm text-[#e8d7c6]"
                />
                <select
                  value={reviewDecision}
                  onChange={(event) => setReviewDecision(event.target.value)}
                  className="h-11 w-full border border-[#8b4444] bg-[#141414] px-3 text-sm text-[#e8d7c6]"
                >
                  <option value="" disabled>Choose a review decision</option>
                  <option value="approved">approved</option>
                  <option value="follow_up">follow_up</option>
                  <option value="hold">hold</option>
                </select>
                <textarea
                  value={reviewNotes}
                  onChange={(event) => setReviewNotes(event.target.value)}
                  placeholder="Review notes"
                  className="min-h-[84px] w-full border border-[#8b4444] bg-[#141414] px-3 py-2 text-sm text-[#e8d7c6]"
                />
                <button
                  type="button"
                  onClick={() => void submitCoachReview()}
                  className="h-11 border-2 border-[#8b4444] bg-[#2a1414] px-4 text-xs font-mono font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:border-[#d4a574]"
                >
                  Save Coach Review
                </button>
                {reviewSyncMessage ? <p className="text-xs text-[#d4a574]">{reviewSyncMessage}</p> : null}
              </div>
              <div className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Progression Intelligence</p>
                <p className="mt-1 text-xs text-[#cfbfae]">Not connected yet. No development recommendation or automatic clearance is generated here.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

