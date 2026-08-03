'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';
import { apiBase } from '@/lib/apiBase';

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

// A block template only. There is no live-session backend, so a block has no
// runtime status. Do not add a status field or a progress bar without a feed
// behind it: hardcoded values here read as a real running session.
interface WorkoutBlock {
  id: string;
  title: string;
  duration: number;
  objective: string;
  trainingItems: string[];
  coachingCues: string[];
}

interface CoachTask {
  id: string;
  title: string;
  // Full sentence, worded by the producer ("In review queue since 2026-07-30"):
  // derived tasks have no real due date, and rendering a fabricated one is the
  // exact defect this list used to have.
  when: string;
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

// One athlete's self-reported pain, already filtered server-side to the
// athletes this coach is authorized for. Every nullable field is a detail the
// athlete did not supply -- render it as "not stated" and never as a value.
interface CoachPainReport {
  nearMissId: string;
  athleteId: string;
  athleteName: string | null;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  painScore: number | null;
  location: string | null;
  painType: string | null;
  observedAt: string | null;
  recordedAt: string | null;
}

function readinessDotClass(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return 'bg-green-500';
  if (readiness === 'YELLOW') return 'bg-yellow-500';
  if (readiness === 'RED') return 'bg-red-500';
  return 'bg-gray-500';
}

function priorityTone(priority: CoachTask['priority']): string {
  if (priority === 'High') return 'bg-red-900 text-red-200';
  if (priority === 'Normal') return 'bg-yellow-900 text-yellow-200';
  return 'bg-blue-900 text-blue-200';
}

function taskStatusTone(status: CoachTask['status']): string {
  if (status === 'Open') return 'bg-[#6b4a2a] text-[color:var(--brass-300)]';
  if (status === 'In Progress') return 'bg-[#4a6b2a] text-[#b4d474]';
  return 'bg-[#4a4a6b] text-[#a4a4d4]';
}

function readinessBadgeTone(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return 'bg-green-900 text-green-200';
  if (readiness === 'YELLOW') return 'bg-yellow-900 text-yellow-200';
  if (readiness === 'RED') return 'bg-red-900 text-red-200';
  return 'bg-gray-800 text-gray-300';
}

function painSeverityTone(severity: CoachPainReport['severity']): string {
  if (severity === 'critical') return 'bg-red-700 text-white';
  if (severity === 'high') return 'bg-red-900 text-red-100';
  return 'bg-[#6b4a2a] text-[#f0d9bf]';
}

// A stored timestamp the browser cannot parse is shown verbatim rather than as
// "Invalid Date": the raw value is at least something a coach can report.
function painReportTime(value: string | null): string {
  if (!value) {
    return 'Not recorded';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function CoachWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [sessionMode, setSessionMode] = useState<SessionMode>('Group');
  const [athleteFloorPlans, setAthleteFloorPlans] = useState<CoachAthleteFloorPlan[]>([]);
  const [floorPlansError, setFloorPlansError] = useState<string | null>(null);
  const [coachAccountId, setCoachAccountId] = useState('');
  const [reviewSessionId, setReviewSessionId] = useState('');
  const [reviewDecision, setReviewDecision] = useState('approved');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSyncMessage, setReviewSyncMessage] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [shadowQueue, setShadowQueue] = useState<ShadowReviewQueueItem[]>([]);
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowReadError, setShadowReadError] = useState('');
  const [shadowQueueUnavailable, setShadowQueueUnavailable] = useState(false);
  const [painReports, setPainReports] = useState<CoachPainReport[]>([]);
  const [painReportWindowDays, setPainReportWindowDays] = useState<number | null>(null);
  const [painReportsTruncated, setPainReportsTruncated] = useState(false);
  const [painReportsLoading, setPainReportsLoading] = useState(true);
  const [painReportsError, setPainReportsError] = useState('');

  // Dashboard data - Real API
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(true);
  const [athletesError, setAthletesError] = useState<string | null>(null);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

  const workoutBlocks = useMemo<WorkoutBlock[]>(() => {
    if (sessionMode === 'One-on-One') {
      return [
        {
          id: 'wb_1',
          title: 'Individual Warmup + Movement Prep',
          duration: 10,
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
  // The task list is DERIVED from real pending work, not stored: the platform
  // has no coach-task store, and the fabricated five-item list this replaced
  // showed every coach the same stale to-dos with due dates that had already
  // passed (behavioral-audit backlog item). The SHADOW review queue is loaded
  // on mount by loadShadowData; when a real task store exists, this memo is
  // the seam to swap it in.
  const coachTasks = useMemo<CoachTask[]>(
    () => shadowQueue
      .filter((item) => item.status === 'pending_review')
      .map((item) => ({
        id: item.intake_case_id,
        title: `Review intake case: ${item.summary}`,
        when: `In review queue since ${item.updated_at.slice(0, 10)}`,
        priority: 'High' as const,
        status: 'Open' as const,
      })),
    [shadowQueue],
  );
  const reviewsNeeded = coachTasks.filter(t => t.status === 'Open' && t.title.includes('Review')).length;
  const assignmentsDue = coachTasks.filter(t => t.status === 'Open').length;

  // Athlete pain reports. The write path refuses to store a pain report it
  // could not raise a coach-visible record for, so anything returned here is a
  // child who told the platform they were hurting and was told a coach would
  // see it. The server filters to the athletes this coach is authorized for.
  const loadPainReports = useCallback(async () => {
    setPainReportsLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/pain-reports`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Unable to load athlete pain reports');
      }

      const payload = (await response.json()) as {
        painReports?: CoachPainReport[];
        windowDays?: number;
        truncated?: boolean;
      };
      setPainReports(payload.painReports ?? []);
      setPainReportWindowDays(typeof payload.windowDays === 'number' ? payload.windowDays : null);
      setPainReportsTruncated(payload.truncated === true);
      setPainReportsError('');
    } catch (error) {
      // Never fall through to the "no reports" line: a coach reading that after
      // a failed read would believe no child had reported pain.
      setPainReportsError(error instanceof Error ? error.message : 'Unable to load athlete pain reports');
      setPainReports([]);
      setPainReportsTruncated(false);
    } finally {
      setPainReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPainReports();
  }, [loadPainReports]);

  const loadFloorPlans = useCallback(async () => {
    try {
      setFloorPlansError(null);
      const response = await fetch(`${apiBase()}/api/pilot/floor-plans?limit=50`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to load athlete floor plans');
      }

      const payload = (await response.json()) as { items?: CoachAthleteFloorPlan[] };
      setAthleteFloorPlans(payload.items || []);
    } catch (error) {
      // A read failure must not fall through to the empty state: "no plans
      // received yet" is a claim about the athletes, and a coach reading it
      // after a failed fetch would skip plans that do exist.
      setFloorPlansError(error instanceof Error ? error.message : 'Failed to load athlete floor plans');
      setAthleteFloorPlans([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFloorPlans();
  }, [loadFloorPlans]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
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
      const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
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

  const loadShadowData = useCallback(async () => {
      try {
        const [queueResult, observationResult] = await Promise.allSettled([
          fetch(`${apiBase()}/api/pilot/shadow/review-projection`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 20 }),
          }),
          fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
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

        // Tracked apart from the combined message because the task board is
        // built from the review projection alone: an observation-projection
        // failure must not flag the board, and a queue failure must, wherever
        // that board is rendered.
        setShadowQueueUnavailable(Boolean(queueError));

        if (queueError || observationError) {
          const failed = [queueError, observationError].filter(Boolean).join(' and ');
          setShadowReadError(`Unable to load SHADOW ${failed}.`);
        } else {
          setShadowReadError('');
        }
      } catch (error) {
        setShadowQueueUnavailable(true);
        setShadowReadError(error instanceof Error ? error.message : 'Unable to load SHADOW read models.');
      }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadShadowData();
  }, [loadShadowData]);

  async function submitCoachReview() {
    // The endpoint writes a new row per review_id and review_id is minted here
    // per call, so a second submit while the first is in flight persists a
    // duplicate review rather than being deduplicated server-side.
    if (reviewSubmitting) {
      return;
    }

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

    setReviewSubmitting(true);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/coach-reviews`, {
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
    } finally {
      setReviewSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[color:var(--brass-300)]">Coach Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Live Session Management</h1>
            <p className="text-base text-[color:var(--bone-400)] mt-2">Manage your program floor, develop yourself, and track athlete progress with SMART goals and assessments.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[color:var(--bone-300)] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ShadowChatButton
              context="Coach Workspace"
              label="Open SHADOW Chat"
              className="border-[color:var(--brass-700)] bg-[var(--rust-900)] text-[color:var(--bone-200)] hover:bg-[var(--rust-900)]"
            />
            <button
              type="button"
              onClick={() => setActiveTab('shadow')}
              className="min-h-[44px] border-2 border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
            >
              Open SHADOW Intel Tab
            </button>
          </div>
        </div>

        {/* ATHLETE PAIN REPORTS -- deliberately outside the tab switch and above
            everything else on the page. A child reporting pain has to reach the
            coach on whatever screen they are already looking at, not on a tab
            they have to know to open. */}
        <section aria-live="polite" className="border-2 border-[color:var(--locked)] bg-[#180d0d] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-sm font-bold uppercase tracking-[0.12em] text-[#ff9d9d]">
              Athlete Pain Reports
            </h2>
            <button
              type="button"
              onClick={() => void loadPainReports()}
              className="min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-[11px] font-mono font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-300)]"
              aria-label="Refresh athlete pain reports"
            >
              Refresh
            </button>
          </div>

          {painReportsLoading && (
            <p className="text-xs text-[color:var(--bone-300)]">Checking for athlete pain reports...</p>
          )}

          {!painReportsLoading && painReportsError && (
            <div className="border-2 border-red-600 bg-red-900/20 p-3">
              <p className="text-sm font-semibold text-red-400">{painReportsError}</p>
              <p className="mt-1 text-xs text-red-300">
                Pain reports may exist that are not shown here. Do not read this as &quot;no athlete
                reported pain&quot; -- ask the floor.
              </p>
            </div>
          )}

          {!painReportsLoading && !painReportsError && painReports.length === 0 && (
            <p className="text-xs text-[color:var(--bone-400)]">
              No athlete on your roster has reported pain
              {painReportWindowDays === null ? '' : ` in the last ${painReportWindowDays} days`}. A report
              appears here as soon as an athlete submits one.
            </p>
          )}

          {!painReportsLoading && !painReportsError && painReports.length > 0 && (
            <div className="space-y-3">
              {painReportsTruncated && (
                <p className="text-xs text-[#ffb3b3]">
                  More reports matched than are listed here. The highest-severity ones are shown first;
                  the rest are in each athlete&apos;s near-miss history on the decision loop.
                </p>
              )}

              {painReports.map((report) => (
                <article key={report.nearMissId} className="border-2 border-[color:var(--locked)] bg-[var(--hide-950)] p-3 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-black text-[color:var(--bone-100)]">
                        {report.athleteName ?? 'Athlete name unavailable'}
                      </p>
                      <p className="text-xs font-mono text-[color:var(--bone-400)]">Athlete ID {report.athleteId}</p>
                    </div>
                    <span className={`rounded px-2 py-1 text-xs font-bold uppercase tracking-[0.08em] ${painSeverityTone(report.severity)}`}>
                      {report.severity}
                      {report.painScore === null ? '' : ` - ${report.painScore}/10`}
                    </span>
                  </div>

                  <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Body location</dt>
                      <dd className={report.location ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                        {report.location ?? 'Not stated by the athlete'}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Pain type</dt>
                      <dd className={report.painType ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                        {report.painType ?? 'Not stated by the athlete'}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Athlete reported it happened</dt>
                      <dd className={report.observedAt ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                        {painReportTime(report.observedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Recorded</dt>
                      <dd className={report.recordedAt ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                        {painReportTime(report.recordedAt)}
                      </dd>
                    </div>
                  </dl>

                  <p className="text-xs text-[color:var(--bone-300)]">
                    Self-reported by the athlete. This is not a coach assessment and not a medical
                    assessment.
                  </p>
                </article>
              ))}

              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/coach/decision-loop"
                  className="min-h-[44px] inline-flex items-center border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-[11px] font-mono font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-300)]"
                >
                  Record What You Did
                </Link>
                <p className="text-[11px] text-[color:var(--bone-400)]">
                  There is no clear button: a report stays here until it ages out of the window, and the
                  permanent record is the athlete&apos;s near-miss history, which nothing on this screen
                  can remove.
                </p>
              </div>
            </div>
          )}
        </section>

        <AnnouncementBanner
          placement="coach_workspace"
          kind="notice"
          heading="Gym Notices"
          className="border-2 border-[color:var(--brass-700)] bg-[var(--bone-200)] p-4"
        />
        <AnnouncementBanner
          placement="coach_workspace"
          kind="motivation"
          heading="From the Gym"
          className="border-2 border-[color:var(--hide-500)] bg-[var(--bone-200)] p-4"
        />

        <div className="border border-[color:var(--hide-500)] bg-[var(--hide-950)] p-4">
          <p className="text-sm text-[color:var(--brass-300)] font-semibold">Coach Standard</p>
          <p className="mt-1 text-sm text-[color:var(--bone-300)]">Lead with discipline, protect the culture, and model the grind. The room rises when the coach stays locked in.</p>
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
        <div className="flex w-fit gap-2 border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-2">
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
              <section className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Coach Dashboard"
                    label="SHADOW Chat"
                    className="min-h-[44px] border-[color:var(--brass-700)] bg-[var(--rust-900)] text-[color:var(--bone-200)] hover:bg-[var(--rust-900)]"
                  />
                  <Link
                    href="/schedule"
                    className="min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:bg-[var(--rust-900)] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('floor')}
                    className="min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:bg-[var(--rust-900)]"
                  >
                    Open Live Floor
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor-plans')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
                  >
                    Review Athlete Plans
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('tasks')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
                  >
                    Process Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
                  >
                    Open SHADOW Intel
                  </button>
                  <Link
                    href="/rabbit-holes"
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)] inline-flex items-center justify-center"
                  >
                    Write a Rabbit Hole
                  </Link>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <article className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Readiness Alerts</p>
                  {readinessTrackingAvailable ? (
                    <>
                      <p className="mt-2 text-2xl font-black text-[color:var(--bone-100)]">{redReadinessCount + yellowReadinessCount}</p>
                      <p className="text-xs text-[color:var(--bone-400)]">{redReadinessCount} RED, {yellowReadinessCount} YELLOW</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-2xl font-black text-[color:var(--bone-400)]">Not tracked</p>
                      <p className="text-xs text-[color:var(--bone-400)]">No backend readiness feed yet -- do not read this as &quot;zero flags&quot;</p>
                    </>
                  )}
                </article>
                <article className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Injury Flags</p>
                  {injuryTrackingAvailable ? (
                    <>
                      <p className="mt-2 text-2xl font-black text-[color:var(--bone-100)]">{injuryFlags}</p>
                      <p className="text-xs text-[color:var(--bone-400)]">Escalate before block progression</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-2xl font-black text-[color:var(--bone-400)]">Not tracked</p>
                      <p className="text-xs text-[color:var(--bone-400)]">No backend injury feed yet -- do not read this as &quot;no injuries&quot;</p>
                      <p className="mt-1 text-xs text-[color:var(--bone-400)]">Pain an athlete reported themselves is a separate feed, at the top of this page.</p>
                    </>
                  )}
                </article>
                <article className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-4 py-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Open Reviews</p>
                  <p className="mt-2 text-2xl font-black text-[color:var(--bone-100)]">{reviewsNeeded}</p>
                  <p className="text-xs text-[color:var(--bone-400)]">Resolve queue items this session</p>
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
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Today&apos;s Session</h3>
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked-ink)]">
                    PLANNED | NOT YET IMPLEMENTED
                  </p>
                  <p className="text-xs text-[color:var(--bone-400)]">
                    There is no scheduling backend feed yet -- session name, time, and status below are not
                    real. Check your actual schedule directly until this is wired up.
                  </p>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-[color:var(--bone-400)] block mb-1">Session Name</p>
                      <p className="text-base font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[color:var(--bone-400)] block mb-1">Time</p>
                      <p className="text-base font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[color:var(--bone-400)] block mb-1">Status</p>
                      <p className="text-base font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="text-xs text-[color:var(--bone-400)] block mb-1">Athletes Present</p>
                      <p className="text-base font-semibold">
                        {trackedAttendanceCount > 0 ? `${activeAthletes}/${athletes.length}` : (
                          <span className="text-[color:var(--bone-400)]">Not tracked</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Athlete Roster</h3>
                  
                  {athletesLoading && (
                    <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-4 text-center">
                      <p className="text-[color:var(--bone-400)] text-sm">Loading athletes...</p>
                      <div className="mt-3 flex justify-center">
                        <div className="animate-spin h-5 w-5 border-2 border-[color:var(--brass-300)] border-t-transparent rounded-full"></div>
                      </div>
                    </div>
                  )}
                  
                  {athletesError && !athletesLoading && (
                    <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-red-400 text-sm font-semibold">Error loading athletes</p>
                        <button
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
                    <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-4 text-center">
                      <p className="text-[color:var(--bone-400)] text-sm">No athletes found</p>
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
                            ? 'bg-[#2a2a2a] border-[color:var(--brass-700)]'
                            : 'bg-[var(--hide-950)] border-[color:var(--hide-600)] hover:border-[color:var(--brass-700)]'
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
                          <span className="text-xs text-[color:var(--bone-400)]">{athlete.attendance}</span>
                        </div>
                        {athlete.injuryFlag && (
                          <p className="text-xs text-red-400 mt-1">🚨 Injury flag active</p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Open Tasks */}
                <div className="md:col-span-2 border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Open Tasks</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {coachTasks.filter(t => t.status !== 'Completed').map(task => (
                      <div key={task.id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-3">
                        <div className="flex justify-between items-start mb-2">
                          <h4 className="font-semibold">{task.title}</h4>
                          <span className={`text-xs px-2 py-1 rounded font-semibold ${priorityTone(task.priority)}`}>
                            {task.priority}
                          </span>
                        </div>
                        <p className="text-xs text-[color:var(--bone-400)]">{task.when}</p>
                      </div>
                    ))}
                    {coachTasks.length === 0 && (
                      <p className="text-xs text-[color:var(--bone-400)]">No open tasks. Items appear here from the SHADOW review queue.</p>
                    )}
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

              {floorPlansError ? (
                <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-red-400 text-sm font-semibold">Error loading athlete floor plans</p>
                    <button
                      onClick={() => void loadFloorPlans()}
                      className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition"
                      aria-label="Retry loading athlete floor plans"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-red-300 text-xs">{floorPlansError}</p>
                  <p className="text-red-300 text-xs mt-1">Plans may exist that are not shown here. Do not read this as an empty queue.</p>
                </div>
              ) : athleteFloorPlans.length === 0 ? (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6">
                  <p className="text-sm text-[color:var(--brass-300)] font-semibold">No athlete floor plans received yet.</p>
                  <p className="mt-2 text-sm text-[color:var(--bone-400)]">Once an athlete checks in and their floor plan auto-generates, it will appear here as an individual coach review tab.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {athleteFloorPlans.map((plan, index) => (
                    <article key={`${plan.athleteName}-${plan.generatedAt}-${index}`} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Individual Plan</p>
                          <h4 className="text-lg font-semibold text-[color:var(--bone-200)]">{plan.athleteName}</h4>
                          <p className="text-xs text-[color:var(--bone-400)]">Generated {new Date(plan.generatedAt).toLocaleString()}</p>
                        </div>
                        <span className={`inline-flex items-center rounded px-2 py-1 text-xs font-bold ${readinessBadgeTone(plan.readiness)}`}>
                          {plan.readiness}
                        </span>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        {plan.tasks.map((task) => (
                          <div key={task.id} className="border border-[color:var(--hide-500)] bg-[var(--hide-950)] p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-[color:var(--bone-200)]">{task.title}</p>
                              <span className={`text-[11px] font-semibold px-2 py-1 rounded ${task.priority === 'High' ? 'bg-red-900 text-red-200' : 'bg-yellow-900 text-yellow-200'}`}>
                                {task.priority}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-[color:var(--brass-300)]">{task.category} - {task.dueDate}</p>
                            <p className="mt-2 text-xs text-[color:var(--bone-400)]">{task.description}</p>
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

              <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Session Workout Plan</h3>
                <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked-ink)]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="text-xs text-[color:var(--bone-400)]">
                  This is the standard {sessionMode} block template, not a running session. Block
                  completion and session progress are not tracked yet. Track the live session on the
                  floor until this is wired up.
                </p>

                <div className="space-y-2">
                  {workoutBlocks.map((block) => (
                    <div key={block.id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-3 rounded">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-semibold">{block.title}</p>
                          <p className="text-xs text-[color:var(--bone-400)]">{block.duration} minutes</p>
                          <p className="text-xs text-[color:var(--brass-300)] mt-1">{block.objective}</p>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <div className="border border-[color:var(--hide-500)] bg-[var(--hide-900)] p-2">
                          <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Planned Training</p>
                          <ul className="mt-1 space-y-1 text-xs text-[color:var(--bone-300)]">
                            {block.trainingItems.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="border border-[color:var(--hide-500)] bg-[var(--hide-900)] p-2">
                          <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Coach Cues</p>
                          <ul className="mt-1 space-y-1 text-xs text-[color:var(--bone-300)]">
                            {block.coachingCues.map((cue) => (
                              <li key={cue}>- {cue}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  ))}
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
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Current Certifications</h3>
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked-ink)]">
                    PLANNED | NOT YET IMPLEMENTED
                  </p>
                  <p className="text-sm text-[color:var(--bone-400)]">
                    There is no backend feed for coach certifications yet, so this platform holds no record
                    of your credentials or their expiry dates and cannot tell you whether a license is
                    current. Check with your certifying body until this is wired up.
                  </p>
                </div>

                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Development Topics</h3>
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked-ink)]">
                    PLANNED | NOT YET IMPLEMENTED
                  </p>
                  <p className="text-sm text-[color:var(--bone-400)]">
                    Reference list of the coach development curriculum. There is no backend store for
                    completion yet, so progress through these topics cannot be recorded here.
                  </p>
                  <ul className="space-y-2">
                    {[
                      'Boxing Technique Instruction',
                      'Youth Development Psychology',
                      'Injury Prevention Basics',
                      'Class Management Skills',
                      'Adaptive Coaching'
                    ].map((topic) => (
                      <li key={topic} className="p-2 border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] text-sm">
                        {topic}
                      </li>
                    ))}
                  </ul>
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked-ink)]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for coach goals yet, so this section
                is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {coachGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold">{goal.title}</h4>
                      <span className="text-xs bg-[var(--hide-600)] text-[color:var(--bone-400)] px-2 py-1">{goal.category}</span>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[color:var(--bone-400)]">Progress</span>
                        <span className="font-semibold">{goal.progress}%</span>
                      </div>
                      <div className="w-full bg-[var(--hide-600)] h-2">
                        <div className="bg-[var(--brass-300)] h-2" style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                    <p className="text-xs text-[color:var(--bone-400)]">Due: {goal.dueDate}</p>
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
                description={shadowQueueUnavailable
                  ? 'Live work items derived from the SHADOW review queue — the queue could not be read, so this board is incomplete and an empty board does NOT mean the queue is clear.'
                  : 'Live work items derived from the SHADOW review queue — nothing here is invented, and an empty board means the queue is clear.'}
                usage={[
                  'Work HIGH priority items first',
                  'Items clear automatically when the underlying review is resolved',
                  'Use the SHADOW tab to act on review-queue items'
                ]}
                mistakes={[
                  'Letting review-queue items sit unresolved',
                  'Ignoring related athlete information'
                ]}
              />

              {shadowQueueUnavailable && (
                <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-red-400 text-sm font-semibold">Unable to load the SHADOW review queue</p>
                    <button
                      onClick={() => void loadShadowData()}
                      className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition flex-shrink-0"
                      aria-label="Retry loading the SHADOW review queue"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-red-300 text-xs">This board is incomplete. Open review items may exist that are not listed below.</p>
                </div>
              )}

              <div className="space-y-3">
                {coachTasks.length === 0 && !shadowQueueUnavailable && (
                  <p className="text-sm text-[color:var(--bone-400)]">No open tasks. Items appear here from the SHADOW review queue.</p>
                )}
                {coachTasks.map(task => (
                  <div key={task.id} className={`border-2 p-4 rounded ${
                    task.status === 'Completed' ? 'bg-[#2a5a2a]/30 border-green-700' : 'bg-[var(--hide-900)] border-[color:var(--brass-700)]'
                  }`}>
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h4 className="font-semibold">{task.title}</h4>
                        <p className="text-xs text-[color:var(--bone-400)] mt-1">{task.when}</p>
                      </div>
                      <div className="flex gap-2">
                        <span className={`text-xs px-2 py-1 rounded font-semibold ${priorityTone(task.priority)}`}>
                          {task.priority}
                        </span>
                        <span className={`text-xs px-2 py-1 rounded font-semibold ${taskStatusTone(task.status)}`}>
                          {task.status}
                        </span>
                      </div>
                    </div>
                    {task.relatedAthlete && (
                      <p className="text-xs text-[color:var(--bone-400)]">Related: {athletes.find(a => a.id === task.relatedAthlete)?.name}</p>
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

              <div className="border-2 border-[color:var(--brass-300)] bg-[var(--hide-950)] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">SHADOW Coach Assistant</h3>
                <p className="text-sm text-[color:var(--bone-400)]">Ask questions about session management, athlete readiness, goals, tasks, or coaching strategy.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--brass-300)]">SHADOW Review Projection</h3>
                  {shadowQueue.length === 0 ? (
                    <p className="mt-2 text-xs text-[color:var(--bone-400)]">No SHADOW queue items returned.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowQueue.slice(0, 6).map((item) => (
                        <div key={item.intake_case_id} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-xs text-[color:var(--bone-300)]">
                          <p className="font-semibold text-[color:var(--bone-200)]">{item.summary}</p>
                          <p>Status: {item.status}</p>
                          <p>Documents: {item.document_count}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--brass-300)]">SHADOW Observation Projection</h3>
                  {shadowObservations.length === 0 ? (
                    <p className="mt-2 text-xs text-[color:var(--bone-400)]">No SHADOW observation items returned.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {shadowObservations.slice(0, 6).map((item) => (
                        <div key={item.id} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-xs text-[color:var(--bone-300)]">
                          <p className="font-semibold text-[color:var(--bone-200)]">{item.label}</p>
                          <p>Source: {item.source}</p>
                          <p>State: {item.review_state}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {shadowReadError ? (
                <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
                  <div className="flex items-center justify-between">
                    <p className="text-red-400 text-sm font-semibold">{shadowReadError}</p>
                    <button
                      onClick={() => void loadShadowData()}
                      className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition flex-shrink-0"
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
            <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Coach Assessments</h3>
              <p className="text-[color:var(--bone-400)]">Evaluate coaching effectiveness, communication, and athlete development.</p>
              <div className="text-sm text-[color:var(--bone-400)]">Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation.</div>
            </div>
          )}

          {/* FILM STUDY */}
          {activeTab === 'film-study' && (
            <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Film Study</h3>
              <p className="text-[color:var(--bone-400)]">Record observations from training videos and self-evaluations.</p>
              <div className="text-sm text-[color:var(--bone-400)]">Coming soon: Video upload, timestamp annotations, technical analysis tools.</div>
              <div className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">AI Video Analysis - Planned</p>
                <p className="mt-1 text-xs text-[color:var(--bone-300)]">Video Upload: FRONT-END PLACEHOLDER | Skill Recognition: BACKEND REQUIRED | Technique Scoring: ML REQUIRED</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href="/coach/video-analysis" className="border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--bone-200)]">
                    Open Video Analysis Surface
                  </Link>
                  <Link href="/athlete/video-analysis" className="border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--bone-300)]">
                    Athlete Feedback Surface
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* ATHLETE REVIEWS */}
          {activeTab === 'athlete-reviews' && (
            <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Athlete Performance Reviews</h3>
              <p className="text-[color:var(--bone-400)]">Comprehensive athlete progress tracking and performance feedback.</p>
              <div className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3 space-y-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Persist Coach Review</p>
                <input
                  value={reviewSessionId}
                  onChange={(event) => setReviewSessionId(event.target.value)}
                  placeholder="Session ID (from persisted session)"
                  className="h-11 w-full border border-[color:var(--brass-700)] bg-[#141414] px-3 text-sm text-[color:var(--bone-200)]"
                />
                <select
                  value={reviewDecision}
                  onChange={(event) => setReviewDecision(event.target.value)}
                  className="h-11 w-full border border-[color:var(--brass-700)] bg-[#141414] px-3 text-sm text-[color:var(--bone-200)]"
                >
                  <option value="approved">approved</option>
                  <option value="follow_up">follow_up</option>
                  <option value="hold">hold</option>
                </select>
                <textarea
                  value={reviewNotes}
                  onChange={(event) => setReviewNotes(event.target.value)}
                  placeholder="Review notes"
                  className="min-h-[84px] w-full border border-[color:var(--brass-700)] bg-[#141414] px-3 py-2 text-sm text-[color:var(--bone-200)]"
                />
                <button
                  type="button"
                  onClick={() => void submitCoachReview()}
                  disabled={reviewSubmitting}
                  className="h-11 border-2 border-[color:var(--brass-700)] bg-[var(--rust-900)] px-4 text-xs font-mono font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-300)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reviewSubmitting ? 'Saving...' : 'Save Coach Review'}
                </button>
                {reviewSyncMessage ? <p className="text-xs text-[color:var(--brass-300)]">{reviewSyncMessage}</p> : null}
              </div>
              <div className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Closed-Loop Progression Intelligence - Planned</p>
                <p className="mt-1 text-xs text-[color:var(--bone-300)]">Development Recommendation: PLACEHOLDER | Coach Review Required | Human Review Required</p>
                <Link href="/coach/progression-intelligence" className="mt-2 inline-flex border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--bone-200)]">
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

