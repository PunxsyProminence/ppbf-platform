'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';

type TabID = 'dashboard' | 'floor' | 'athlete-floor-plans' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';
type SessionMode = 'Group' | 'One-on-One';
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
  // 'UNKNOWN' / null / 'Unknown' below are real states, not placeholders --
  // there is no backend feed for per-athlete readiness, injury status, or
  // today's attendance yet. A prior version fabricated these (round-robin
  // GREEN/YELLOW/RED, injuryFlag always false, attendance always 'Present')
  // and attached them to real athlete names, which is a false-reassurance
  // safety bug, not a cosmetic one -- a coach could read "no injury flag" as
  // a real clearance signal. Never default these to a reassuring value.
  readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  injuryFlag: boolean | null;
  attendance: 'Present' | 'Late' | 'Excused' | 'Absent' | 'Unknown';
}

interface WorkoutBlock {
  id: string;
  title: string;
  duration: number;
  status: 'Not Started' | 'In Progress' | 'Completed' | 'Skipped';
  objective: string;
  trainingItems: string[];
  coachingCues: string[];
}

interface CoachTask {
  id: string;
  title: string;
  dueDate: string;
  priority: 'High' | 'Normal' | 'Low';
  status: 'Open' | 'In Progress' | 'Completed';
  relatedAthlete?: string;
}

interface CoachGoal {
  id: string;
  title: string;
  category: string;
  progress: number;
  dueDate: string;
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
  if (readiness === 'GREEN') return 'bg-[var(--status-ready)]';
  if (readiness === 'YELLOW') return 'bg-[var(--status-warning)]';
  if (readiness === 'RED') return 'bg-[var(--status-critical)]';
  return 'bg-[var(--status-inactive)]';
}

function priorityTone(priority: CoachTask['priority']): string {
  if (priority === 'High') return ui.statusDanger;
  if (priority === 'Normal') return ui.statusWarning;
  return ui.statusInfo;
}

function taskStatusTone(status: CoachTask['status']): string {
  if (status === 'Open') return ui.statusWarning;
  if (status === 'In Progress') return ui.statusInfo;
  return ui.statusReady;
}

function blockCardTone(status: WorkoutBlock['status']): string {
  if (status === 'Completed') return 'border-[var(--status-ready)]';
  if (status === 'In Progress') return 'border-[var(--status-warning)]';
  return 'border-[var(--black)]';
}

function blockStatusTone(status: WorkoutBlock['status']): string {
  if (status === 'Completed') return ui.statusReady;
  if (status === 'In Progress') return ui.statusWarning;
  return ui.statusInactive;
}

function readinessBadgeTone(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return ui.statusReady;
  if (readiness === 'YELLOW') return ui.statusWarning;
  if (readiness === 'RED') return ui.statusDanger;
  return ui.statusInactive;
}

export default function CoachWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [sessionMode, setSessionMode] = useState<SessionMode>('Group');
  const [athleteFloorPlans, setAthleteFloorPlans] = useState<CoachAthleteFloorPlan[]>([]);
  const [coachAccountId, setCoachAccountId] = useState('');
  const [reviewSessionId, setReviewSessionId] = useState('');
  const [reviewDecision, setReviewDecision] = useState('approved');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSyncMessage, setReviewSyncMessage] = useState('');
  const [shadowQueue, setShadowQueue] = useState<ShadowReviewQueueItem[]>([]);
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowReadError, setShadowReadError] = useState('');

  // Dashboard data - Real API
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(true);
  const [athletesError, setAthletesError] = useState<string | null>(null);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

  const [coachTasks, setCoachTasks] = useState<CoachTask[]>([]);

  const workoutBlocks = useMemo<WorkoutBlock[]>(() => {
    if (sessionMode === 'One-on-One') {
      return [
        {
          id: 'wb_1',
          title: 'Individual Warmup + Movement Prep',
          duration: 10,
          status: 'Completed',
          objective: 'Prime mechanics and movement quality before technical rounds.',
          trainingItems: [
            '2 rounds jump rope x 2:00 with 0:30 reset',
            'Hip/ankle mobility circuit x 6 minutes',
            'Mirror stance checks and guard alignment x 2 minutes',
          ],
          coachingCues: ['Nose over toes in stance', 'Shoulders relaxed, guard alive'],
        },
        {
          id: 'wb_2',
          title: 'Footwork and Angle Entry',
          duration: 15,
          status: 'In Progress',
          objective: 'Build clean entries and exits from jab range.',
          trainingItems: [
            '4 x 2:00 ladder step + pivot (inside/outside)',
            'Cone angle entry drill 3 x 90s',
            'Reactive call-outs: left exit/right exit x 4 sets',
          ],
          coachingCues: ['Push from rear foot, do not hop', 'Exit with hands home'],
        },
        {
          id: 'wb_3',
          title: 'Targeted Technical Rounds',
          duration: 15,
          status: 'Not Started',
          objective: 'Refine high-value combinations with defensive responsibility.',
          trainingItems: [
            'Pad rounds: 3 x 3:00 (jab-cross-slip-cross focus)',
            'Defense return drill: slip-counter x 3 sets',
            '30-second burst finisher each round',
          ],
          coachingCues: ['Exhale on impact', 'Head off center after second shot'],
        },
        {
          id: 'wb_4',
          title: 'Conditioning Micro-Block',
          duration: 10,
          status: 'Not Started',
          objective: 'Support repeat power without technique breakdown.',
          trainingItems: [
            'Battle rope intervals 6 x 30:30',
            'Med-ball rotational throws 3 x 8 each side',
            'Core brace plank ladder 3 sets',
          ],
          coachingCues: ['Quality over speed', 'Maintain posture under fatigue'],
        },
        {
          id: 'wb_5',
          title: 'Cooldown + Review',
          duration: 5,
          status: 'Not Started',
          objective: 'Recover and lock one technical takeaway.',
          trainingItems: ['Breath downshift x 2 minutes', 'Stretch reset x 3 minutes'],
          coachingCues: ['Identify one repeatable win from session'],
        },
      ];
    }

    return [
      {
        id: 'wb_1',
        title: 'Group Warmup Flow',
        duration: 10,
        status: 'Completed',
        objective: 'Raise heart rate and establish class rhythm safely.',
        trainingItems: [
          'Jump rope cadence ladder: 3 x 90s',
          'Dynamic mobility line drills: hips, thoracic, ankles',
          'Guard and stance shadow round x 2:00',
        ],
        coachingCues: ['Eyes up, shoulders down', 'Move with stance integrity'],
      },
      {
        id: 'wb_2',
        title: 'Footwork Pods',
        duration: 15,
        status: 'In Progress',
        objective: 'Install directional movement under control and spacing.',
        trainingItems: [
          'Station A: forward/backward step-and-stop x 3 sets',
          'Station B: lateral shuffle + pivot x 3 sets',
          'Station C: partner mirror footwork x 3 sets',
        ],
        coachingCues: ['Stay balanced at every stop', 'Hands in position during movement'],
      },
      {
        id: 'wb_3',
        title: 'Defense + Combo Circuit',
        duration: 15,
        status: 'Not Started',
        objective: 'Connect defensive reactions to simple scoring combinations.',
        trainingItems: [
          'Slip line: jab-slip-jab x 3 rounds',
          'Partner feed: parry-cross-hook x 3 rounds',
          'Coach call reaction: block/roll/return x 6 sets',
        ],
        coachingCues: ['Defense first, then fire', 'Reset feet before second phase'],
      },
      {
        id: 'wb_4',
        title: 'Group Conditioning',
        duration: 15,
        status: 'Not Started',
        objective: 'Build engine while preserving technical form standards.',
        trainingItems: [
          'Bag intervals 5 x 2:00 (45s active recovery)',
          'Bodyweight circuit: squat, pushup, mountain climber x 3 rounds',
          'Finisher: 60-second nonstop straight punches',
        ],
        coachingCues: ['Form before pace', 'Match breathing to output'],
      },
      {
        id: 'wb_5',
        title: 'Cooldown + Team Debrief',
        duration: 5,
        status: 'Not Started',
        objective: 'Return to baseline and reinforce key class lesson.',
        trainingItems: ['Guided breathing x 2 minutes', 'Mobility reset x 2 minutes', 'Team takeaway x 1 minute'],
        coachingCues: ['Name one technical habit to repeat next session'],
      },
    ];
  }, [sessionMode]);

  // There is no backend feed for coach development goals yet. This used to
  // be 3 hardcoded goals with fake progress percentages shown identically to
  // every coach regardless of who was logged in -- removed rather than left
  // as fake personal data.
  const [coachGoals] = useState<CoachGoal[]>([]);

  // There is no backend session-status feed yet (see the "Today's Session"
  // panel below, which shows the same honest state).
  const sessionStatus = 'Unavailable - not yet tracked';

  // Attendance/injury/readiness are currently always 'Unknown'/null/'UNKNOWN'
  // (see loadAthletes) -- these counts are real aggregations, but over data
  // that isn't tracked yet, so every stat derived from them below is
  // rendered with an explicit "not tracked" state instead of a bare number.
  // A bare 0 here would read as "confirmed zero injuries," which is false.
  const trackedAttendanceCount = athletes.filter(a => a.attendance !== 'Unknown').length;
  const activeAthletes = athletes.filter(a => a.attendance !== 'Absent' && a.attendance !== 'Unknown').length;
  const injuryFlags = athletes.filter(a => a.injuryFlag).length;
  const injuryTrackingAvailable = athletes.some(a => a.injuryFlag !== null);
  const redReadinessCount = athletes.filter((athlete) => athlete.readiness === 'RED').length;
  const yellowReadinessCount = athletes.filter((athlete) => athlete.readiness === 'YELLOW').length;
  const readinessTrackingAvailable = athletes.some((athlete) => athlete.readiness !== 'UNKNOWN');
  const reviewsNeeded = coachTasks.filter(t => t.status === 'Open' && t.title.includes('Review')).length;
  const assignmentsDue = coachTasks.filter(t => t.status === 'Open').length;

  useEffect(() => {
    const loadPlans = async () => {
      try {
        const response = await fetch('/api/pilot/floor-plans?limit=50', {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error('Failed to load athlete floor plans');
        }

        const payload = (await response.json()) as { items?: CoachAthleteFloorPlan[] };
        setAthleteFloorPlans(payload.items || []);
      } catch {
        setAthleteFloorPlans([]);
      }
    };

    void loadPlans();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/auth/session', { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; account_id?: string };
        if (response.ok && payload.authenticated && payload.account_id) {
          setCoachAccountId(payload.account_id);
        }
      } catch {
        // coachAccountId stays unset; submitCoachReview reports the failure.
      }
    })();
  }, []);

  // Fetch athletes for the organization
  const loadAthletes = useCallback(async () => {
    try {
      setAthletesLoading(true);
      setAthletesError(null);
      const response = await fetch('/api/pilot/athletes/list', {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to load athletes');

      const data = (await response.json()) as { items?: Array<{ athlete_id: string; full_name?: string; gym_status?: string }> };
      const items = data.items || [];

      // Convert PilotAthlete to Athlete format. Readiness, injury flag, and
      // attendance have no backend source yet -- do not fabricate them (see
      // the Athlete interface comment). Do not truncate the roster either; a
      // silent slice(0, 3) here would hide real athletes from the coach with
      // no indication anything was cut.
      const athleteList: Athlete[] = items.map((item) => ({
        id: item.athlete_id,
        name: item.full_name || 'Unknown',
        track: item.gym_status || 'Foundations',
        readiness: 'UNKNOWN',
        injuryFlag: null,
        attendance: 'Unknown'
      }));

      setAthletes(athleteList);
      setSelectedAthleteId((current) => current || athleteList[0]?.id || current);
    } catch (error) {
      setAthletesError(error instanceof Error ? error.message : 'Failed to load athletes');
      // Fallback: set empty list but don't block UI
      setAthletes([]);
    } finally {
      setAthletesLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAthletes();
  }, [loadAthletes]);

  // Fetch coach tasks (hardcoded for now since backend doesn't have coach-tasks endpoint yet)
  useEffect(() => {
    void (async () => {
      try {
        // SHADOW endpoint integrated: POST /api/pilot/shadow/chat
        // For now, generate default tasks pending backend coach-tasks API
        const defaultTasks: CoachTask[] = [
          { id: 't_1', title: 'Review athlete goals', dueDate: '2026-07-13', priority: 'High', status: 'Open' },
          { id: 't_2', title: 'Approve track applications', dueDate: '2026-07-14', priority: 'High', status: 'Open' },
          { id: 't_3', title: 'Conduct athlete evaluations', dueDate: '2026-07-15', priority: 'Normal', status: 'In Progress' },
          { id: 't_4', title: 'Film review - last session', dueDate: '2026-07-16', priority: 'Normal', status: 'Open' },
          { id: 't_5', title: 'Submit monthly report', dueDate: '2026-07-20', priority: 'Normal', status: 'Open' }
        ];
        setCoachTasks(defaultTasks);
      } catch {
        // Task loading error - UI will show empty state
      }
    })();
  }, []);

  const loadShadowData = useCallback(async () => {
      try {
        const [queueResult, observationResult] = await Promise.allSettled([
          fetch('/api/pilot/shadow/review-projection', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 20 }),
          }),
          fetch('/api/pilot/shadow/observation-projection', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 20 }),
          }),
        ]);

        let queueError = '';
        let observationError = '';

        if (queueResult.status === 'fulfilled') {
          if (queueResult.value.ok) {
            const queuePayload = (await queueResult.value.json()) as {
              queue?: ShadowReviewQueueItem[];
            };
            setShadowQueue(queuePayload.queue ?? []);
          } else {
            queueError = 'review projection';
          }
        } else {
          queueError = 'review projection';
        }

        if (observationResult.status === 'fulfilled') {
          if (observationResult.value.ok) {
            const observationPayload = (await observationResult.value.json()) as {
              items?: ShadowObservationItem[];
            };
            setShadowObservations(observationPayload.items ?? []);
          } else {
            observationError = 'observation projection';
          }
        } else {
          observationError = 'observation projection';
        }

        if (queueError || observationError) {
          const failed = [queueError, observationError].filter(Boolean).join(' and ');
          setShadowReadError(`Unable to load SHADOW ${failed}.`);
        } else {
          setShadowReadError('');
        }
      } catch (error) {
        setShadowReadError(error instanceof Error ? error.message : 'Unable to load SHADOW read models.');
      }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadShadowData();
  }, [loadShadowData]);

  async function submitCoachReview() {
    setReviewSyncMessage('');

    if (!reviewSessionId.trim()) {
      setReviewSyncMessage('Session ID is required.');
      return;
    }

    if (!coachAccountId.trim()) {
      setReviewSyncMessage('Coach account session not found.');
      return;
    }

    const now = new Date().toISOString();
    const reviewId = `review_${Date.now()}`;

    let response: Response;
    try {
      response = await fetch('/api/pilot/coach-reviews', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review_id: reviewId,
          session_id: reviewSessionId.trim(),
          coach_id: coachAccountId,
          decision: reviewDecision,
          notes: reviewNotes || 'Coach review from Coach Workspace',
          approved_flag: reviewDecision === 'approved',
          created_at: now,
          updated_at: now,
        }),
      });
    } catch {
      setReviewSyncMessage('Network error -- coach review was not saved. Please try again.');
      return;
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: 'Coach review persistence failed' }))) as { error?: string };
      setReviewSyncMessage(payload.error || 'Coach review persistence failed');
      return;
    }

    setReviewSyncMessage(`Coach review persisted (${reviewId}).`);
  }

  return (
    <div className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[var(--black)] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[var(--red-primary)]">Coach Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Live Session Management</h1>
            <p className="text-base text-[var(--gray-dark)] mt-2">Manage your program floor, develop yourself, and track athlete progress with SMART goals and assessments.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ShadowChatButton
              context="Coach Workspace"
              label="Open SHADOW Chat"
              className="border-[var(--black)] bg-[var(--red-primary)] text-[var(--white)] hover:bg-[var(--red-highlight)]"
            />
            <button
              type="button"
              onClick={() => setActiveTab('shadow')}
              className="tactical-btn-ghost min-h-[40px] border-2 border-[var(--black)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em]"
            >
              Open SHADOW Intel Tab
            </button>
          </div>
        </div>

        <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <p className="text-sm text-[var(--red-primary)] font-semibold">Coach Standard</p>
          <p className="mt-1 text-sm text-[var(--gray-dark)]">Lead with discipline, protect the culture, and model the grind. The room rises when the coach stays locked in.</p>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <CoachSummaryPanel
          sessionStatus={sessionStatus}
          activeAthletes={activeAthletes}
          injuryFlags={injuryFlags}
          reviewsNeeded={reviewsNeeded}
          assignmentsDue={assignmentsDue}
        />

        {/* MODE TOGGLE */}
        <div className="flex w-fit gap-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
          {(['Group', 'One-on-One'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setSessionMode(mode)}
              className={cx(
                ui.modeButtonBase,
                sessionMode === mode ? ui.modeButtonActive : ui.modeButtonInactive,
              )}
            >
              {mode} Mode
            </button>
          ))}
        </div>

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
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Coach Dashboard"
                    label="SHADOW Chat"
                    className="min-h-[44px] border-[var(--black)] bg-[var(--red-primary)] text-[var(--white)] hover:bg-[var(--red-highlight)]"
                  />
                  <Link
                    href="/schedule"
                    className="tactical-btn-critical min-h-[44px] border border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('floor')}
                    className="tactical-btn-critical min-h-[44px] border border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em]"
                  >
                    Open Live Floor
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor-plans')}
                    className="tactical-btn-ghost min-h-[44px] border border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em]"
                  >
                    Review Athlete Plans
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('tasks')}
                    className="tactical-btn-ghost min-h-[44px] border border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em]"
                  >
                    Process Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="tactical-btn-ghost min-h-[44px] border border-[var(--black)] px-3 text-xs font-bold uppercase tracking-[0.08em]"
                  >
                    Open SHADOW Intel
                  </button>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <article className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Readiness Alerts</p>
                  {readinessTrackingAvailable ? (
                    <>
                      <p className="mt-2 text-2xl font-black text-[var(--black)]">{redReadinessCount + yellowReadinessCount}</p>
                      <p className="text-xs text-[var(--gray-dark)]">{redReadinessCount} RED, {yellowReadinessCount} YELLOW</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-2xl font-black text-[var(--gray-dark)]">Not tracked</p>
                      <p className="text-xs text-[var(--gray-dark)]">No backend readiness feed yet -- do not read this as &quot;zero flags&quot;</p>
                    </>
                  )}
                </article>
                <article className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Injury Flags</p>
                  {injuryTrackingAvailable ? (
                    <>
                      <p className="mt-2 text-2xl font-black text-[var(--black)]">{injuryFlags}</p>
                      <p className="text-xs text-[var(--gray-dark)]">Escalate before block progression</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-2xl font-black text-[var(--gray-dark)]">Not tracked</p>
                      <p className="text-xs text-[var(--gray-dark)]">No backend injury feed yet -- do not read this as &quot;no injuries&quot;</p>
                    </>
                  )}
                </article>
                <article className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Open Reviews</p>
                  <p className="mt-2 text-2xl font-black text-[var(--black)]">{reviewsNeeded}</p>
                  <p className="text-xs text-[var(--gray-dark)]">Resolve queue items this session</p>
                </article>
              </section>

              <HelpPanel
                title="Coach Dashboard"
                description="Overview of your session status, athlete roster, and immediate action items."
                usage={[
                  'Check session status and athlete readiness before class',
                  'Review flagged athletes (RED/YELLOW readiness)',
                  'See athletes with injury concerns',
                  'Monitor open tasks and due dates'
                ]}
                mistakes={[
                  'Missing injury flags before session start',
                  'Not reviewing task deadlines',
                  'Overlooking RED readiness athletes'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Session Status */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Today&apos;s Session</h3>
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)]">
                    PLANNED | NOT YET IMPLEMENTED
                  </p>
                  <p className="text-xs text-[var(--gray-dark)]">
                    There is no scheduling backend feed yet -- session name, time, and status below are not
                    real. Check your actual schedule directly until this is wired up.
                  </p>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-[var(--gray-dark)] block mb-1">Session Name</p>
                      <p className="text-base font-semibold text-[var(--gray-dark)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--gray-dark)] block mb-1">Time</p>
                      <p className="text-base font-semibold text-[var(--gray-dark)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--gray-dark)] block mb-1">Status</p>
                      <p className="text-base font-semibold text-[var(--gray-dark)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--gray-dark)] block mb-1">Athletes Present</p>
                      <p className="text-base font-semibold">
                        {trackedAttendanceCount > 0 ? `${activeAthletes}/${athletes.length}` : (
                          <span className="text-[var(--gray-dark)]">Not tracked</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Athlete Roster</h3>
                  
                  {athletesLoading && (
                    <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 text-center">
                      <p className="text-[var(--gray-dark)] text-sm">Loading athletes...</p>
                      <div className="mt-3 flex justify-center">
                        <div className="animate-spin h-5 w-5 border-2 border-[var(--red-primary)] border-t-transparent rounded-full"></div>
                      </div>
                    </div>
                  )}
                  
                  {athletesError && !athletesLoading && (
                    <div className="tactical-alert-critical">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm font-semibold">Error loading athletes</p>
                        <button
                          onClick={() => void loadAthletes()}
                          className="tactical-btn-critical px-2 py-0.5 text-xs uppercase"
                          aria-label="Retry loading athletes"
                        >
                          Retry
                        </button>
                      </div>
                      <p className="text-xs">{athletesError}</p>
                    </div>
                  )}
                  
                  {!athletesLoading && athletes.length === 0 && !athletesError && (
                    <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 text-center">
                      <p className="text-[var(--gray-dark)] text-sm">No athletes found</p>
                    </div>
                  )}
                  
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {athletes.map(athlete => (
                      <button
                        type="button"
                        key={athlete.id}
                        onClick={() => setSelectedAthleteId(athlete.id)}
                        className={`w-full p-3 border-2 cursor-pointer transition text-left ${
                          selectedAthleteId === athlete.id
                            ? 'bg-[var(--canvas-tan-dark)] border-[var(--red-primary)]'
                            : 'bg-[var(--canvas-tan-light)] border-[var(--gray-medium)] hover:border-[var(--red-primary)]'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-2 h-2 rounded-full ${readinessDotClass(athlete.readiness)}`}
                              title={athlete.readiness === 'UNKNOWN' ? 'Readiness not tracked' : `Readiness: ${athlete.readiness}`}
                            ></div>
                            <span className="font-semibold">{athlete.name}</span>
                          </div>
                          <span className="text-xs text-[var(--gray-dark)]">{athlete.attendance}</span>
                        </div>
                        {athlete.injuryFlag && (
                          <p className="text-xs text-[var(--red-primary)] mt-1">🚨 Injury flag active</p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Open Tasks */}
                <div className="md:col-span-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Tasks Due</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {coachTasks.filter(t => t.status !== 'Completed').map(task => (
                      <div key={task.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                        <div className="flex justify-between items-start mb-2">
                          <h4 className="font-semibold">{task.title}</h4>
                          <span className={`text-xs px-2 py-1 rounded font-semibold ${priorityTone(task.priority)}`}>
                            {task.priority}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--gray-dark)]">Due: {task.dueDate}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ATHLETE FLOOR PLANS */}
          {activeTab === 'athlete-floor-plans' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Athlete Floor Plans"
                description="Individual athlete workout plans generated at athlete check-in. Separate from coach group and one-on-one floor operations."
                usage={[
                  'Review each athlete\'s generated plan before live coaching decisions',
                  'Use readiness color to adjust coaching intensity',
                  'Confirm task order and due-time pacing',
                  'Use this tab as individual plan intake, not class block control'
                ]}
                mistakes={[
                  'Treating individual plans as group-session block plan',
                  'Ignoring RED readiness plans during live coaching',
                  'Overwriting individual targets with one-size-fits-all flow'
                ]}
              />

              {athleteFloorPlans.length === 0 ? (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6">
                  <p className="text-sm text-[var(--red-primary)] font-semibold">No athlete floor plans received yet.</p>
                  <p className="mt-2 text-sm text-[var(--gray-dark)]">Once an athlete checks in and their floor plan auto-generates, it will appear here as an individual coach review tab.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {athleteFloorPlans.map((plan, index) => (
                    <article key={`${plan.athleteName}-${plan.generatedAt}-${index}`} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Individual Plan</p>
                          <h4 className="text-lg font-semibold text-[var(--black)]">{plan.athleteName}</h4>
                          <p className="text-xs text-[var(--gray-dark)]">Generated {new Date(plan.generatedAt).toLocaleString()}</p>
                        </div>
                        <span className={cx('inline-flex items-center font-bold', readinessBadgeTone(plan.readiness))}>
                          {plan.readiness}
                        </span>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        {plan.tasks.map((task) => (
                          <div key={task.id} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-[var(--black)]">{task.title}</p>
                              <span className={task.priority === 'High' ? ui.statusDanger : ui.statusWarning}>
                                {task.priority}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-[var(--red-primary)]">{task.category} - {task.dueDate}</p>
                            <p className="mt-2 text-xs text-[var(--gray-dark)]">{task.description}</p>
                          </div>
                        ))}
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
              <HelpPanel
                title="Coach Floor"
                description="Live session management. Track workout blocks, athlete observations, and make real-time adjustments."
                usage={[
                  'Start session when class begins',
                  'Progress through workout blocks',
                  'Record quick observations for each athlete',
                  'Mark modifications for individual athletes',
                  'End session and review summary'
                ]}
                mistakes={[
                  'Not starting session timer',
                  'Missing critical observations',
                  'Forgetting to record modifications'
                ]}
              />

              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Session Workout Plan</h3>

                <div className="space-y-2">
                  {workoutBlocks.map((block) => (
                    <div key={block.id} className={`border-2 bg-[var(--canvas-tan-light)] p-3 ${blockCardTone(block.status)} `}>
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-semibold">{block.title}</p>
                          <p className="text-xs text-[var(--gray-dark)]">{block.duration} minutes</p>
                          <p className="text-xs text-[var(--red-primary)] mt-1">{block.objective}</p>
                        </div>
                        <span className={blockStatusTone(block.status)}>
                          {block.status}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                          <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Actual Training</p>
                          <ul className="mt-1 space-y-1 text-xs text-[var(--gray-dark)]">
                            {block.trainingItems.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                          <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Coach Cues</p>
                          <ul className="mt-1 space-y-1 text-xs text-[var(--gray-dark)]">
                            {block.coachingCues.map((cue) => (
                              <li key={cue}>- {cue}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-[var(--canvas-tan-light)] border-2 border-[var(--black)] p-4">
                  <p className="text-xs text-[var(--gray-dark)]">Session Progress: 40%</p>
                  <div className="w-full bg-[var(--gray-dark)] h-2 mt-2">
                    <div className="bg-[var(--red-primary)] h-2" style={{width: '40%'}}></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DEVELOPMENT */}
          {activeTab === 'development' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Development"
                description="Your personal coaching growth path. Track certifications, skills, and professional development."
                usage={[
                  'Review your current coaching level',
                  'Track certification requirements',
                  'Set coach development goals',
                  'Record training hours and completed courses',
                  'Monitor mentorship progress'
                ]}
                mistakes={[
                  'Neglecting your own development',
                  'Not tracking training hours',
                  'Waiting until renewal deadlines'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Current Certifications</h3>
                  <div className="space-y-3">
                    <div className="bg-[var(--canvas-tan-light)] p-3 border-2 border-[var(--black)]">
                      <p className="font-semibold">Bronze Certification</p>
                      <p className="text-xs text-[var(--gray-dark)] mt-1">Expires: 2026-12-31</p>
                    </div>
                    <div className="bg-[var(--canvas-tan-light)] p-3 border-2 border-[var(--black)]">
                      <p className="font-semibold">USA Boxing Coach License</p>
                      <p className="text-xs text-[var(--gray-dark)] mt-1">Expires: 2027-06-30</p>
                    </div>
                  </div>
                </div>

                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Development Topics</h3>
                  <div className="space-y-2">
                    {[
                      'Boxing Technique Instruction',
                      'Youth Development Psychology',
                      'Injury Prevention Basics',
                      'Class Management Skills',
                      'Adaptive Coaching'
                    ].map((topic) => (
                      <label key={topic} className="flex items-center gap-2 cursor-pointer p-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] hover:bg-[var(--canvas-tan-dark)]">
                        <input type="checkbox" className="w-4 h-4" />
                        <span className="text-sm">{topic}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* GOALS */}
          {activeTab === 'goals' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Goals"
                description="Set and track your coaching development goals using SMART framework."
                usage={[
                  'Create specific, measurable goals',
                  'Link to certification or skill development',
                  'Track progress monthly',
                  'Reflect on achievements'
                ]}
                mistakes={[
                  'Vague goals without metrics',
                  'Unrealistic timeframes',
                  'Not reviewing progress regularly'
                ]}
              />

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for coach goals yet, so this section
                is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {coachGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold">{goal.title}</h4>
                      <span className="tactical-chip">{goal.category}</span>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[var(--gray-dark)]">Progress</span>
                        <span className="font-semibold">{goal.progress}%</span>
                      </div>
                      <div className="w-full bg-[var(--gray-medium)] h-2">
                        <div className="bg-[var(--red-primary)] h-2" style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--gray-dark)]">Due: {goal.dueDate}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TASKS */}
          {activeTab === 'tasks' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Tasks"
                description="Mission board with athlete evaluations, reviews, and administrative tasks."
                usage={[
                  'Complete task reviews before deadlines',
                  'Related athlete tasks link to athlete profiles',
                  'Update status as you work through tasks',
                  'Prioritize HIGH tasks first'
                ]}
                mistakes={[
                  'Missing task deadlines',
                  'Not updating task status',
                  'Ignoring related athlete information'
                ]}
              />

              <div className="space-y-3">
                {coachTasks.map(task => (
                  <div key={task.id} className={`border-2 bg-[var(--canvas-tan-light)] p-4 ${
                    task.status === 'Completed' ? 'border-[var(--status-ready)]' : 'border-[var(--black)]'
                  }`}>
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h4 className="font-semibold">{task.title}</h4>
                        <p className="text-xs text-[var(--gray-dark)] mt-1">Due: {task.dueDate}</p>
                      </div>
                      <div className="flex gap-2">
                        <span className={priorityTone(task.priority)}>
                          {task.priority}
                        </span>
                        <span className={taskStatusTone(task.status)}>
                          {task.status}
                        </span>
                      </div>
                    </div>
                    {task.relatedAthlete && (
                      <p className="text-xs text-[var(--gray-dark)]">Related: {athletes.find(a => a.id === task.relatedAthlete)?.name}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 animate-fadeIn">
              <RoleSpecificShadow
                role="coach"
                description="Ask SHADOW about session management, athlete readiness, goals, tasks, or coaching strategy. Every answer below and in the assistant panel comes from a live request scoped to your roster -- nothing here is a canned example."
                chatContext="Coach Workspace"
              />

              <div className="border-2 border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">SHADOW Coach Assistant</h3>
                <p className="text-sm text-[var(--gray-dark)]">Ask questions about session management, athlete readiness, goals, tasks, or coaching strategy.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">SHADOW Review Projection</h3>
                  {shadowQueue.length === 0 ? (
                    <p className="mt-2 text-xs text-[var(--gray-dark)]">No SHADOW queue items returned.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowQueue.slice(0, 6).map((item) => (
                        <div key={item.intake_case_id} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2 text-xs text-[var(--gray-dark)]">
                          <p className="font-semibold text-[var(--black)]">{item.summary}</p>
                          <p>Status: {item.status}</p>
                          <p>Documents: {item.document_count}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">SHADOW Observation Projection</h3>
                  {shadowObservations.length === 0 ? (
                    <p className="mt-2 text-xs text-[var(--gray-dark)]">No SHADOW observation items returned.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowObservations.slice(0, 6).map((item) => (
                        <div key={item.id} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2 text-xs text-[var(--gray-dark)]">
                          <p className="font-semibold text-[var(--black)]">{item.label}</p>
                          <p>Source: {item.source}</p>
                          <p>State: {item.review_state}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {shadowReadError ? (
                <div className="tactical-alert-critical">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{shadowReadError}</p>
                    <button
                      onClick={() => void loadShadowData()}
                      className="tactical-btn-critical px-2 py-0.5 text-xs uppercase flex-shrink-0"
                      aria-label="Retry loading SHADOW queue"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* ASSESSMENTS */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Coach Assessments</h3>
              <p className="text-[var(--gray-dark)]">Evaluate coaching effectiveness, communication, and athlete development.</p>
              <div className="text-sm text-[var(--gray-dark)]">Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation.</div>
            </div>
          )}

          {/* FILM STUDY */}
          {activeTab === 'film-study' && (
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Film Study</h3>
              <p className="text-[var(--gray-dark)]">Record observations from training videos and self-evaluations.</p>
              <div className="text-sm text-[var(--gray-dark)]">Coming soon: Video upload, timestamp annotations, technical analysis tools.</div>
              <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">AI Video Analysis - Planned</p>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">Video Upload: FRONT-END PLACEHOLDER | Skill Recognition: BACKEND REQUIRED | Technique Scoring: ML REQUIRED</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href="/coach/video-analysis" className="tactical-btn-critical border border-[var(--black)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em]">
                    Open Video Analysis Surface
                  </Link>
                  <Link href="/athlete/video-analysis" className="tactical-btn-ghost border border-[var(--black)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em]">
                    Athlete Feedback Surface
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* ATHLETE REVIEWS */}
          {activeTab === 'athlete-reviews' && (
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Athlete Performance Reviews</h3>
              <p className="text-[var(--gray-dark)]">Comprehensive athlete progress tracking and performance feedback.</p>
              <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 space-y-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Persist Coach Review</p>
                <input
                  value={reviewSessionId}
                  onChange={(event) => setReviewSessionId(event.target.value)}
                  placeholder="Session ID (from persisted session)"
                  className="tactical-input h-11"
                />
                <select
                  value={reviewDecision}
                  onChange={(event) => setReviewDecision(event.target.value)}
                  className="tactical-input h-11"
                >
                  <option value="approved">approved</option>
                  <option value="follow_up">follow_up</option>
                  <option value="hold">hold</option>
                </select>
                <textarea
                  value={reviewNotes}
                  onChange={(event) => setReviewNotes(event.target.value)}
                  placeholder="Review notes"
                  className="tactical-input min-h-[84px]"
                />
                <button
                  type="button"
                  onClick={() => void submitCoachReview()}
                  className="tactical-btn-critical h-11 border-2 border-[var(--black)] px-4 text-xs font-mono font-bold uppercase tracking-[0.08em]"
                >
                  Save Coach Review
                </button>
                {reviewSyncMessage ? <p className="text-xs text-[var(--red-primary)]">{reviewSyncMessage}</p> : null}
              </div>
              <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Closed-Loop Progression Intelligence - Planned</p>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">Development Recommendation: PLACEHOLDER | Coach Review Required | Human Review Required</p>
                <Link href="/coach/progression-intelligence" className="tactical-btn-critical mt-2 inline-flex border border-[var(--black)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em]">
                  Open Progression Intelligence Surface
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

