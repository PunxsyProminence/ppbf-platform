'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import ProfilePortrait from './ProfilePortrait';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';
import { apiBase } from '@/lib/apiBase';
import {
  READINESS_UNVALIDATED_CAVEAT,
  isReadinessMethodValidated,
} from '@/src/server/pilot/readinessProvenance';
import { formatGymDateTimeShort, formatGymStamp } from '@/src/lib/gymTime';

type TabID = 'dashboard' | 'floor' | 'athlete-floor-plans' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';

/**
 * An explicit element type for the tab-bar array, rather than letting it
 * infer one from the object literals. Without this, TypeScript's inference
 * for an array of objects with differing optional keys silently widens every
 * element to carry every key as optional-undefined -- so a typo'd `id` or
 * `badge` property type-checks fine and just never renders, with no compiler
 * signal pointing at the cause.
 */
interface CoachTabBadge {
  readonly tone: BadgeTone;
  readonly label: string;
}
interface CoachTab {
  readonly id: TabID;
  readonly label: string;
  readonly badge?: CoachTabBadge;
}

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
  // 'UNKNOWN' / null / 'Unknown' below are real states, not placeholders.
  // Readiness now has a backend feed (/api/pilot/coach/readiness-board:
  // latest fresh check-in only), but injury status and today's attendance
  // still do not. A prior version fabricated these (round-robin
  // GREEN/YELLOW/RED, injuryFlag always false, attendance always 'Present')
  // and attached them to real athlete names, which is a false-reassurance
  // safety bug, not a cosmetic one -- a coach could read "no injury flag" as
  // a real clearance signal. Never default these to a reassuring value: an
  // athlete absent from the readiness feed stays UNKNOWN, and a failed feed
  // leaves everyone UNKNOWN.
  readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  injuryFlag: boolean | null;
  attendance: 'Present' | 'Late' | 'Excused' | 'Absent' | 'Unknown';

  /* Identity, from /api/pilot/profile/roster. Optional because the roster
     renders correctly without it -- the profile read is a second request and a
     coach whose profile table has not been migrated yet still gets their list,
     with a plate for every face.

     THE CORNER IS DELIBERATELY NOT HERE. A member's corner tints their OWN
     surfaces and nothing else. On a roster it would sit inches from a readiness
     dot and an injury badge, which is exactly where a personal preference
     starts being read as a safety state (Law 2) -- the failure the corner
     tokens were designed around. Faces and names, yes. Dye, no. */
  accountId?: string | null;
  initials?: string;
  ringName?: string | null;
  photoAvailable?: boolean;
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

interface CoachBarrierReport {
  note_id: string;
  athlete_id: string;
  athlete_name: string;
  reporter_role: string;
  note_type: string;
  note_text: string;
  created_at: string;
}

const BARRIER_TYPE_LABEL: Record<string, string> = {
  home_barrier: 'Something at home',
  transportation_barrier: 'Getting to the gym',
};

/**
 * A row of pilot.safety_escalations as GET /api/pilot/escalations returns it
 * to a coach: already scoped server-side to their assigned and covered
 * athletes, with athlete_voice rows excluded entirely (a disclosure-driven
 * escalation may be about the coach). This pull surface is the platform's
 * only notification mechanism -- nothing emails a coach -- so it has to
 * reach them on the workspace they already have open.
 */
interface CoachEscalation {
  escalation_id: string;
  athlete_id: string;
  source_type: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  reason: string;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: string;
}

// athlete_voice is deliberately absent: the server never sends it to a coach.
const ESCALATION_SOURCE_LABEL: Record<string, string> = {
  near_miss: 'Near miss',
  pain_report: 'Pain report',
  safety_gate_evaluation: 'Safety gate',
  repeated_pattern: 'Repeated pattern',
  training_hold: 'Training hold',
  incident: 'Incident',
};

/**
 * A row of pilot.sessions as GET /api/pilot/sessions/list returns it, cut to
 * the fields the review picker labels an option with. Every field is a real
 * stored value; a row missing a usable session_id or date is dropped rather
 * than rendered as a blank or guessed-at option.
 */
interface ReviewableSession {
  sessionId: string;
  date: string;
  rpe: number | null;
  completed: boolean;
  createdAt: string;
}

function normalizeReviewableSession(row: unknown): ReviewableSession | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
  // Sliced to the day and shown verbatim, matching the athlete workspace's
  // treatment of the same column: pilot.sessions.date can be date-only, and
  // pushing a date-only value through a timezone formatter invents a time of
  // day (and sometimes the wrong day) that the record does not contain.
  const date = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
  const createdAt = typeof record.created_at === 'string' ? record.created_at : '';
  if (!sessionId || !date) {
    return null;
  }

  const rpe = Number(record.rpe);
  return {
    sessionId,
    date,
    // null, not 0: an unreadable RPE is omitted from the label rather than
    // shown as a fabricated zero-effort session.
    rpe: Number.isFinite(rpe) ? rpe : null,
    completed: Boolean(record.completed_flag),
    createdAt,
  };
}

/** Real stored fields only: the day, whether it was completed, its RPE. */
function reviewSessionLabel(session: ReviewableSession): string {
  const status = session.completed ? 'completed' : 'open';
  const rpe = session.rpe === null ? '' : ` - RPE ${session.rpe}`;
  return `${session.date} - ${status}${rpe}`;
}

/**
 * A row of pilot.coach_reviews as GET /api/pilot/coach-reviews/list returns
 * it, cut to what the panel shows. Rows without a usable review_id are
 * dropped rather than rendered blank.
 */
interface SessionReview {
  reviewId: string;
  coachId: string;
  decision: string;
  notes: string;
  createdAt: string;
}

function normalizeSessionReview(row: unknown): SessionReview | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const record = row as Record<string, unknown>;
  const reviewId = typeof record.review_id === 'string' ? record.review_id.trim() : '';
  if (!reviewId) {
    return null;
  }
  return {
    reviewId,
    coachId: typeof record.coach_id === 'string' ? record.coach_id : '',
    decision: typeof record.decision === 'string' ? record.decision : '',
    notes: typeof record.notes === 'string' ? record.notes : '',
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

function readinessDotClass(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return 'bg-[var(--cleared)]';
  if (readiness === 'YELLOW') return 'bg-[var(--restricted)]';
  if (readiness === 'RED') return 'bg-[var(--locked)]';
  return 'bg-[var(--hide-600)]';
}

/* Status vocabulary (Law 2 + Law 3): every state maps onto the design system's
   four-rung ladder and renders as a `.badge` -- glyph + uppercase label, never
   colour alone. 'neutral' is for values that are genuinely NOT a safety state
   or queue outcome (unknown readiness, low priority), which Law 2 forbids from
   wearing a saturated rung. */
type BadgeTone = 'cleared' | 'monitor' | 'restricted' | 'locked' | 'neutral';

const BADGE_GLYPH: Record<Exclude<BadgeTone, 'neutral'>, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  locked: '✕',
};

function StatusBadge({ tone, label }: { readonly tone: BadgeTone; readonly label: string }) {
  if (tone === 'neutral') {
    return (
      <span className="badge badge--filed">
        <i>◌</i>
        {label}
      </span>
    );
  }
  return (
    <span className={`badge badge--${tone}`}>
      <i>{BADGE_GLYPH[tone]}</i>
      {label}
    </span>
  );
}

function priorityTone(priority: CoachTask['priority']): BadgeTone {
  if (priority === 'High') return 'restricted';
  if (priority === 'Normal') return 'monitor';
  return 'neutral';
}

function taskStatusTone(status: CoachTask['status']): BadgeTone {
  if (status === 'Open') return 'restricted';
  if (status === 'In Progress') return 'monitor';
  return 'cleared';
}

function readinessBadgeTone(readiness: Athlete['readiness']): BadgeTone {
  if (readiness === 'GREEN') return 'cleared';
  if (readiness === 'YELLOW') return 'restricted';
  if (readiness === 'RED') return 'locked';
  return 'neutral';
}

function painSeverityTone(severity: CoachPainReport['severity']): BadgeTone {
  if (severity === 'critical' || severity === 'high') return 'locked';
  if (severity === 'moderate') return 'restricted';
  return 'monitor';
}

// A stored timestamp the browser cannot parse is shown verbatim rather than as
// "Invalid Date": the raw value is at least something a coach can report.
function painReportTime(value: string | null): string {
  if (!value) {
    return 'Not recorded';
  }
  const parsed = new Date(value);
  return formatGymStamp(parsed) ?? value;
}

export default function CoachWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [sessionMode, setSessionMode] = useState<SessionMode>('Group');
  const [athleteFloorPlans, setAthleteFloorPlans] = useState<CoachAthleteFloorPlan[]>([]);
  const [floorPlansError, setFloorPlansError] = useState<string | null>(null);
  const [coachAccountId, setCoachAccountId] = useState('');
  const [reviewSessionId, setReviewSessionId] = useState('');
  // The review picker: which athlete's sessions are listed, and the list
  // itself. 'idle' (no athlete chosen), 'loading', 'loaded' (possibly empty),
  // and 'unavailable' (the read failed) are distinct states on purpose -- an
  // error rendered as an empty list would read as "this athlete has no
  // sessions", which is the fabrication this workspace's tests exist to catch.
  const [reviewAthleteId, setReviewAthleteId] = useState('');
  const [reviewSessions, setReviewSessions] = useState<ReviewableSession[]>([]);
  const [reviewSessionsState, setReviewSessionsState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [reviewSessionsError, setReviewSessionsError] = useState('');
  // Guards the async session load against athlete switches: a slow response
  // for the previously selected athlete must never render under the current
  // one -- that would attach real sessions to the wrong child's name.
  const reviewAthleteRef = useRef('');
  // The reviews already written on the selected session, read back through
  // /api/pilot/coach-reviews/list before the coach writes another. Same
  // four-state honesty as the session list, and the same stale-response guard:
  // one session's reviews must never render under another session's name.
  const [sessionReviews, setSessionReviews] = useState<SessionReview[]>([]);
  const [sessionReviewsState, setSessionReviewsState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const reviewSessionRef = useRef('');
  const [reviewDecision, setReviewDecision] = useState('approved');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSyncMessage, setReviewSyncMessage] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [shadowQueue, setShadowQueue] = useState<ShadowReviewQueueItem[]>([]);
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowReadError, setShadowReadError] = useState('');
  const [shadowQueueUnavailable, setShadowQueueUnavailable] = useState(false);
  const [shadowQueueTotal, setShadowQueueTotal] = useState<number | null>(null);
  // Per-item, not a single shared flag: a coach can be resolving one case
  // while a different one's error is still on screen.
  const [intakeActionBusyId, setIntakeActionBusyId] = useState<string | null>(null);
  const [intakeActionErrors, setIntakeActionErrors] = useState<Record<string, string>>({});
  const [painReports, setPainReports] = useState<CoachPainReport[]>([]);
  // The escalation inbox. Loading, failed, and empty are distinct: a failed
  // read rendered as "no escalations" would tell a coach their athletes are
  // clear when nobody knows.
  const [escalations, setEscalations] = useState<CoachEscalation[]>([]);
  const [escalationsLoading, setEscalationsLoading] = useState(true);
  const [escalationsError, setEscalationsError] = useState('');
  const [escalationAckBusyId, setEscalationAckBusyId] = useState<string | null>(null);
  const [escalationAckErrors, setEscalationAckErrors] = useState<Record<string, string>>({});
  const [barrierReports, setBarrierReports] = useState<CoachBarrierReport[]>([]);
  const [barrierReportsTruncated, setBarrierReportsTruncated] = useState(false);
  const [barrierReportsLoading, setBarrierReportsLoading] = useState(true);
  const [barrierReportsError, setBarrierReportsError] = useState('');
  const [painReportWindowDays, setPainReportWindowDays] = useState<number | null>(null);
  const [painReportsTruncated, setPainReportsTruncated] = useState(false);
  const [painReportsLoading, setPainReportsLoading] = useState(true);
  const [painReportsError, setPainReportsError] = useState('');

  // Dashboard data - Real API
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(true);
  const [athletesError, setAthletesError] = useState<string | null>(null);
  // Whether ANY reading on the readiness board came from an established
  // method. Starts false so the caveat is present from first paint rather than
  // appearing a moment after the colours do -- the disclaimer must never lag
  // the number it qualifies.
  const [readinessAnyValidated, setReadinessAnyValidated] = useState(false);

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
  // panel below, which shows the same honest state). Said as a sentence rather
  // than as a KPI tile reading "Unavailable - not yet tracked": a tile is the
  // shape of a measurement, and this is the absence of one. CoachSummaryPanel
  // renders it as a line under the counts.
  const sessionStatus = 'Live session tracking is not built yet.';

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
  const unknownReadinessCount = athletes.filter((athlete) => athlete.readiness === 'UNKNOWN').length;
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
  // A missing badge must mean "genuinely nothing pending", never "the queue
  // failed to load" -- assignmentsDue is 0 in both cases, and the Tasks tab's
  // own body already distinguishes them (the "Unable to load" box above).
  // Collapsing that distinction back to silence one UI element up would
  // reproduce the exact false-reassurance failure this file guards against
  // elsewhere (see the readiness/injuryFlag handling).
  const reviewQueueBadge: CoachTabBadge | undefined = shadowQueueUnavailable
    ? { tone: 'locked', label: 'unavailable' }
    : assignmentsDue > 0
      ? { tone: 'monitor', label: `${assignmentsDue} pending` }
      : undefined;

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

  // Guardian barrier reports. The parent form's copy is "Sent to your
  // child's coach" -- this panel is what makes that true. The server filters
  // to the athletes this coach is authorized for.
  const loadBarrierReports = useCallback(async () => {
    setBarrierReportsLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/barrier-reports`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Unable to load family barrier reports');
      }

      const payload = (await response.json()) as {
        barrierReports?: CoachBarrierReport[];
        truncated?: boolean;
      };
      setBarrierReports(payload.barrierReports ?? []);
      setBarrierReportsTruncated(payload.truncated === true);
      setBarrierReportsError('');
    } catch (error) {
      // Never fall through to the "no reports" line: a coach reading that
      // after a failed read would believe no family had asked for help.
      setBarrierReportsError(error instanceof Error ? error.message : 'Unable to load family barrier reports');
      setBarrierReports([]);
      setBarrierReportsTruncated(false);
    } finally {
      setBarrierReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPainReports();
    void loadBarrierReports();
  }, [loadPainReports, loadBarrierReports]);

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

      // Faces, from the profile roster. Best-effort and separate on purpose:
      // this call applies the portrait visibility gate per athlete server-side,
      // so a coach browsing athletes who are not theirs gets plates for them --
      // and if the call fails outright, every athlete falls back to a plate,
      // which is a finished object rather than a broken row.
      try {
        const facesResponse = await fetch(`${apiBase()}/api/pilot/profile/roster`, {
          method: 'GET',
          credentials: 'include',
        });
        if (facesResponse.ok) {
          const faces = (await facesResponse.json()) as {
            items?: Array<{
              athlete_id: string;
              account_id: string | null;
              initials: string;
              ring_name: string | null;
              photo_available: boolean;
            }>;
          };
          const byAthlete = new Map((faces.items ?? []).map((face) => [face.athlete_id, face]));
          for (const athlete of athleteList) {
            const face = byAthlete.get(athlete.id);
            if (!face) continue;
            athlete.accountId = face.account_id;
            athlete.initials = face.initials;
            athlete.ringName = face.ring_name;
            athlete.photoAvailable = face.photo_available;
          }
        }
      } catch {
        // Plates for everyone. Nothing about the roster is degraded by it.
      }

      // Readiness, from the board feed. Best-effort and separate like the
      // faces read: the server returns only athletes with a FRESH check-in,
      // so everyone else stays UNKNOWN -- and a failed feed leaves the whole
      // roster UNKNOWN rather than inventing a color (see the Athlete
      // interface comment: unknown is never clear).
      try {
        const readinessResponse = await fetch(`${apiBase()}/api/pilot/coach/readiness-board`, {
          method: 'GET',
          credentials: 'include',
        });
        if (readinessResponse.ok) {
          const board = (await readinessResponse.json()) as {
            items?: Array<{
              athlete_id: string;
              status: 'GREEN' | 'YELLOW' | 'RED';
              method?: string;
              reliability_status?: string;
              validity_status?: string;
            }>;
          };
          const items = board.items ?? [];
          const statusByAthlete = new Map(items.map((entry) => [entry.athlete_id, entry.status]));
          for (const athlete of athleteList) {
            const status = statusByAthlete.get(athlete.id);
            if (status) athlete.readiness = status;
          }
          // Whether ANY reading on this board came from an established method.
          // Today nothing does -- every score in pilot.readiness was typed by
          // staff during intake against unvalidated defaults -- so the caveat
          // below shows. It is computed from the feed rather than hardcoded so
          // it stops showing on its own if a validated method is ever wired,
          // instead of becoming a stale disclaimer nobody removes.
          setReadinessAnyValidated(
            items.some((entry) => isReadinessMethodValidated({
              method: entry.method ?? 'UNKNOWN',
              reliability_status: entry.reliability_status ?? '',
              validity_status: entry.validity_status ?? '',
            })),
          );
        }
      } catch {
        // UNKNOWN across the board -- the tile says so instead of claiming zero flags.
      }

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
              total?: number;
            };
            setShadowQueue(queuePayload.queue ?? []);
            // The projection reports how many cases exist, not just how many it
            // returned. Kept so the panel can say what it is not showing rather
            // than letting a coach believe the queue ends at the last card.
            setShadowQueueTotal(
              typeof queuePayload.total === 'number' ? queuePayload.total : null,
            );
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

  // The Tasks tab tells a coach to "use the SHADOW tab to act on
  // review-queue items" -- this is that action. /api/pilot/intake/review-action
  // already authorizes 'organization_admin' AND 'coach' for approve/reject
  // (promote is org-admin-only, and not offered here), so this was a pure UI
  // wiring gap, not a new capability. The route's own assertActorCanAccessAthlete
  // scopes a coach to their assigned athletes server-side -- a case outside
  // that scope returns 403, surfaced below rather than silently retried.
  // The escalation inbox read. /api/pilot/escalations already authorizes the
  // coach role and scopes rows server-side (assigned + actively covered
  // athletes, athlete_voice excluded) -- this is UI wiring over an existing
  // capability, exactly like the intake review-action before it.
  const loadEscalations = useCallback(async () => {
    setEscalationsLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations?status=open`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Safety escalations could not be loaded.');
      }
      const payload = (await response.json()) as { escalations?: CoachEscalation[] };
      setEscalations(payload.escalations ?? []);
      setEscalationsError('');
    } catch (error) {
      setEscalations([]);
      setEscalationsError(error instanceof Error ? error.message : 'Safety escalations could not be loaded.');
    } finally {
      setEscalationsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEscalations();
  }, [loadEscalations]);

  // Acknowledging is the coach action the server already grants ("I have seen
  // this"); resolving stays admin-only server-side and is not offered here.
  // The row swaps to whatever the SERVER returns -- never to a local guess.
  async function acknowledgeCoachEscalation(escalationId: string) {
    if (escalationAckBusyId) {
      return;
    }
    setEscalationAckBusyId(escalationId);
    setEscalationAckErrors((prev) => ({ ...prev, [escalationId]: '' }));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', escalation_id: escalationId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        escalation?: CoachEscalation;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.escalation) {
        setEscalationAckErrors((prev) => ({
          ...prev,
          [escalationId]: payload.error || 'The escalation could not be acknowledged.',
        }));
        return;
      }
      const acknowledged = payload.escalation;
      setEscalations((prev) => prev.map((item) => (
        item.escalation_id === escalationId ? acknowledged : item
      )));
    } catch {
      setEscalationAckErrors((prev) => ({
        ...prev,
        [escalationId]: 'Network error -- the escalation was not acknowledged. Please try again.',
      }));
    } finally {
      setEscalationAckBusyId(null);
    }
  }

  async function actOnIntakeCase(intakeCaseId: string, action: 'approve' | 'reject') {
    if (intakeActionBusyId) {
      return;
    }

    setIntakeActionBusyId(intakeCaseId);
    setIntakeActionErrors((prev) => ({ ...prev, [intakeCaseId]: '' }));

    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/review-action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intake_case_id: intakeCaseId, action }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };

      if (!response.ok || !payload.ok) {
        setIntakeActionErrors((prev) => ({ ...prev, [intakeCaseId]: payload.error || 'Action failed.' }));
        return;
      }

      const nextStatus = payload.status;
      if (nextStatus === 'approved' || nextStatus === 'rejected') {
        setShadowQueue((prev) => prev.map((item) => (
          item.intake_case_id === intakeCaseId ? { ...item, status: nextStatus } : item
        )));
      }
    } catch {
      setIntakeActionErrors((prev) => ({ ...prev, [intakeCaseId]: 'Network error -- action was not applied. Please try again.' }));
    } finally {
      setIntakeActionBusyId(null);
    }
  }

  // The review picker's session read. GET /api/pilot/sessions/list is the
  // existing per-athlete session read; its own requireRole +
  // assertActorCanAccessAthlete decide, server-side, whether this coach may
  // see this athlete's sessions at all. The roster select below deliberately
  // offers the whole gym (that is what /api/pilot/athletes/list returns to a
  // coach, by design), so a refusal here is an expected outcome, not an edge
  // case: it is surfaced verbatim rather than softened into an empty list.
  const loadReviewSessions = useCallback(async (athleteId: string) => {
    setReviewSessionsState('loading');
    setReviewSessionsError('');
    setReviewSessions([]);

    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (reviewAthleteRef.current !== athleteId) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setReviewSessionsError(payload.error || 'Sessions could not be loaded.');
        setReviewSessionsState('unavailable');
        return;
      }

      const payload = (await response.json()) as { items?: unknown[] };
      // The list route orders by date alone, which cannot separate two
      // sessions on the same day; the athlete workspace re-orders the same
      // read on created_at for the same reason.
      const sessions = (payload.items ?? [])
        .map(normalizeReviewableSession)
        .filter((session): session is ReviewableSession => session !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      setReviewSessions(sessions);
      setReviewSessionsState('loaded');
    } catch {
      if (reviewAthleteRef.current !== athleteId) {
        return;
      }
      setReviewSessionsError('Network error -- sessions could not be loaded.');
      setReviewSessionsState('unavailable');
    }
  }, []);

  // The read-back: what has already been said about this session, fetched
  // before the coach says more. /api/pilot/coach-reviews/list applies its own
  // session->athlete access check server-side; a refusal or failure here is
  // shown as such, never as "no reviews yet".
  const loadSessionReviews = useCallback(async (sessionId: string) => {
    setSessionReviewsState('loading');
    setSessionReviews([]);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach-reviews/list?session_id=${encodeURIComponent(sessionId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (reviewSessionRef.current !== sessionId) {
        return;
      }
      if (!response.ok) {
        setSessionReviewsState('unavailable');
        return;
      }
      const payload = (await response.json()) as { items?: unknown[] };
      setSessionReviews(
        (payload.items ?? [])
          .map(normalizeSessionReview)
          .filter((review): review is SessionReview => review !== null),
      );
      setSessionReviewsState('loaded');
    } catch {
      if (reviewSessionRef.current !== sessionId) {
        return;
      }
      setSessionReviewsState('unavailable');
    }
  }, []);

  function selectReviewSession(sessionId: string) {
    setReviewSessionId(sessionId);
    reviewSessionRef.current = sessionId;
    if (sessionId) {
      void loadSessionReviews(sessionId);
    } else {
      setSessionReviews([]);
      setSessionReviewsState('idle');
    }
  }

  function selectReviewAthlete(athleteId: string) {
    setReviewAthleteId(athleteId);
    reviewAthleteRef.current = athleteId;
    // A session belongs to exactly one athlete: switching athletes always
    // clears the selection so a stale session_id can never be submitted
    // under the newly selected athlete's name. The read-back panel clears
    // with it -- it describes the cleared session, not the new athlete.
    setReviewSessionId('');
    reviewSessionRef.current = '';
    setSessionReviews([]);
    setSessionReviewsState('idle');
    setReviewSyncMessage('');
    if (athleteId) {
      void loadReviewSessions(athleteId);
    } else {
      setReviewSessions([]);
      setReviewSessionsState('idle');
      setReviewSessionsError('');
    }
  }

  async function submitCoachReview() {
    // The endpoint writes a new row per review_id and review_id is minted here
    // per call, so a second submit while the first is in flight persists a
    // duplicate review rather than being deduplicated server-side.
    if (reviewSubmitting) {
      return;
    }

    setReviewSyncMessage('');

    if (!reviewSessionId.trim()) {
      setReviewSyncMessage('Select a session to review.');
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
      // Close the loop: the review just written comes back from the server's
      // own read, so the panel shows what was actually stored, not what this
      // tab believes it sent.
      void loadSessionReviews(reviewSessionId.trim());
    } finally {
      setReviewSubmitting(false);
    }
  }

  return (
    <div className="text-[color:var(--bone-200)]">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Coach Development Workspace</p>
            <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)] md:text-[length:var(--t-2xl)]">Live Session Management</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Manage your program floor, develop yourself, and track athlete progress with SMART goals and assessments.</p>
          </div>
          {/* Two SHADOW buttons used to sit here and both were already on the
              page. RoleStandaloneView renders a context-carrying Open SHADOW
              Chat above this component on every standalone route, and the tab
              row below already has a SHADOW Intel tab -- so a coach opening
              this queue was offered the same assistant three times before
              reaching any athlete. Both duplicates are gone; neither
              destination is.

              The motto line went with them. "Old Gauze | Sweat | Grit | Grind
              | Dedication | Motivation" rendered at --t-xs on three separate
              role workspaces, identically, above the fold. Repeated verbatim
              per role it stops being the gym's voice and becomes chrome, and
              at that size on leather it also sat under the contrast floor Law
              3 exists to hold. */}
        </div>

        {/* ATHLETE PAIN REPORTS -- deliberately outside the tab switch and above
            everything else on the page. A child reporting pain has to reach the
            coach on whatever screen they are already looking at, not on a tab
            they have to know to open. */}
        <section aria-live="polite" className="mat-leather rounded-[var(--r-lg)] border-2 border-[color:var(--locked)] p-[var(--s4)] space-y-[var(--s3)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <h2 className="font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.12em] text-[var(--locked-ink)]">
              Athlete Pain Reports
            </h2>
            <button
              type="button"
              onClick={() => void loadPainReports()}
              className="btn btn--ghost"
              aria-label="Refresh athlete pain reports"
            >
              Refresh
            </button>
          </div>

          {painReportsLoading && (
            <p className="text-xs text-[color:var(--bone-300)]">Checking for athlete pain reports...</p>
          )}

          {!painReportsLoading && painReportsError && (
            <div className="border-2 border-[var(--locked)] bg-[color-mix(in_srgb,var(--locked)_22%,var(--hide-950))]/20 p-3">
              <p className="text-sm font-semibold text-[color:var(--locked-ink)]">{painReportsError}</p>
              <p className="mt-1 text-xs text-[color:var(--locked-ink)]">
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
                <p className="text-xs text-[var(--locked-ink)]">
                  More reports matched than are listed here. The highest-severity ones are shown first;
                  the rest are in each athlete&apos;s near-miss history on the decision loop.
                </p>
              )}

              {painReports.map((report) => (
                <article key={report.nearMissId} className="mat-leather--raised rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s3)] space-y-[var(--s3)]">
                  <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                    <div>
                      <p className="text-[length:var(--t-md)] font-black text-[color:var(--bone-100)]">
                        {report.athleteName ?? 'Athlete name unavailable'}
                      </p>
                      <p className="t-data text-[color:var(--bone-400)]">Athlete ID {report.athleteId}</p>
                    </div>
                    <StatusBadge
                      tone={painSeverityTone(report.severity)}
                      label={`${report.severity}${report.painScore === null ? '' : ` - ${report.painScore}/10`}`}
                    />
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
                  className="btn"
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

        {/* SAFETY ESCALATIONS -- also outside the tab switch, directly under
            the pain reports and wearing the same locked band: an escalation is
            what a near miss, pain report, or safety-gate flag becomes when it
            is severe enough to auto-escalate, and this pull surface is the
            platform's only alarm. The coach acknowledges ("I have seen this");
            resolving stays an admin call server-side and is not offered. */}
        <section aria-live="polite" className="mat-leather rounded-[var(--r-lg)] border-2 border-[color:var(--locked)] p-[var(--s4)] space-y-[var(--s3)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <h2 className="font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.12em] text-[var(--locked-ink)]">
              Safety Escalations
            </h2>
            <button
              type="button"
              onClick={() => void loadEscalations()}
              className="btn btn--ghost"
              aria-label="Refresh safety escalations"
            >
              Refresh
            </button>
          </div>

          {escalationsLoading && (
            <p className="text-xs text-[color:var(--bone-300)]">Checking for open escalations...</p>
          )}

          {!escalationsLoading && escalationsError && (
            <div className="border-2 border-[var(--locked)] bg-[color-mix(in_srgb,var(--locked)_22%,var(--hide-950))]/20 p-3">
              <p className="text-sm font-semibold text-[color:var(--locked-ink)]">{escalationsError}</p>
              <p className="mt-1 text-xs text-[color:var(--locked-ink)]">
                Escalations may exist that are not shown here. Do not read this as &quot;all clear&quot;.
              </p>
            </div>
          )}

          {!escalationsLoading && !escalationsError && escalations.length === 0 && (
            <p className="text-xs text-[color:var(--bone-400)]">
              No open escalations for your athletes. One appears here the moment a near miss, pain
              report, or safety-gate flag escalates.
            </p>
          )}

          {!escalationsLoading && !escalationsError && escalations.length > 0 && (
            <div className="space-y-3">
              {escalations.map((escalation) => {
                const athleteName = athletes.find((athlete) => athlete.id === escalation.athlete_id)?.name;
                return (
                  <article
                    key={escalation.escalation_id}
                    className="mat-leather--raised rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s3)] space-y-[var(--s2)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                      <div>
                        <p className="text-[length:var(--t-md)] font-black text-[color:var(--bone-100)]">
                          {athleteName ?? `Athlete ID ${escalation.athlete_id}`}
                        </p>
                        <p className="t-data text-[color:var(--bone-400)]">
                          {ESCALATION_SOURCE_LABEL[escalation.source_type] ?? escalation.source_type}
                          {' -- '}
                          {painReportTime(escalation.created_at)}
                        </p>
                      </div>
                      <StatusBadge tone={painSeverityTone(escalation.severity)} label={escalation.severity} />
                    </div>

                    <p className="t-body text-[color:var(--bone-200)]">{escalation.reason}</p>

                    {escalation.status === 'open' ? (
                      <button
                        type="button"
                        onClick={() => void acknowledgeCoachEscalation(escalation.escalation_id)}
                        disabled={escalationAckBusyId !== null}
                        className="btn disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {escalationAckBusyId === escalation.escalation_id ? 'Acknowledging...' : 'Acknowledge'}
                      </button>
                    ) : (
                      <p className="t-data text-[color:var(--bone-400)]">
                        Acknowledged. Closing it out is an admin decision and happens on the admin
                        escalations console.
                      </p>
                    )}

                    {escalationAckErrors[escalation.escalation_id] && (
                      <p role="alert" className="t-data text-[var(--locked-ink)]">
                        {escalationAckErrors[escalation.escalation_id]}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* FAMILY BARRIER REPORTS -- also outside the tab switch. A guardian
            who wrote "something at home is in the way of training" was told it
            was sent to their child's coach; this panel is where that promise
            is kept. Lower urgency than pain, so brass trim rather than the
            locked band. */}
        <section aria-live="polite" className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.35)] p-[var(--s4)] space-y-[var(--s3)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <h2 className="font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
              Family Barrier Reports
            </h2>
            <button
              type="button"
              onClick={() => void loadBarrierReports()}
              className="btn btn--ghost"
              aria-label="Refresh family barrier reports"
            >
              Refresh
            </button>
          </div>

          {barrierReportsLoading && (
            <p className="text-xs text-[color:var(--bone-300)]">Checking for family barrier reports...</p>
          )}

          {!barrierReportsLoading && barrierReportsError && (
            <div className="border-2 border-[color:rgba(212,175,74,.5)] p-3">
              <p className="text-sm font-semibold text-[color:var(--brass-300)]">{barrierReportsError}</p>
              <p className="mt-1 text-xs text-[color:var(--bone-300)]">
                Reports may exist that are not shown here. Do not read this as &quot;no family asked for
                help&quot;.
              </p>
            </div>
          )}

          {!barrierReportsLoading && !barrierReportsError && barrierReports.length === 0 && (
            <p className="text-xs text-[color:var(--bone-400)]">
              No guardian on your roster has reported a barrier to training. A report appears here as
              soon as one is sent.
            </p>
          )}

          {!barrierReportsLoading && !barrierReportsError && barrierReports.length > 0 && (
            <div className="space-y-3">
              {barrierReportsTruncated && (
                <p className="text-xs text-[color:var(--bone-300)]">
                  More reports exist than are listed here; the newest are shown first.
                </p>
              )}

              {barrierReports.map((report) => (
                <article key={report.note_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] space-y-[var(--s2)]">
                  <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                    <div>
                      <p className="text-[length:var(--t-md)] font-black text-[color:var(--bone-100)]">
                        {report.athlete_name}
                      </p>
                      <p className="t-data text-[color:var(--bone-400)]">
                        {BARRIER_TYPE_LABEL[report.note_type] ?? report.note_type}
                        {' '}&middot; reported by {report.reporter_role === 'parent' ? 'a guardian' : report.reporter_role}
                        {' '}&middot; {formatGymDateTimeShort(report.created_at) ?? report.created_at}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-[color:var(--bone-200)]">{report.note_text}</p>
                  <p className="text-xs text-[color:var(--bone-400)]">
                    Reply through the Message Home panel on the decision loop.
                  </p>
                </article>
              ))}

              <Link href="/coach/decision-loop" className="btn btn--ghost">
                Open Decision Loop to Message Home
              </Link>
            </div>
          )}
        </section>

        {/* Announcements are pinned notes from the office: paper, not another
            leather panel. .mat-paper sets its own dark ink so the text does not
            inherit bone-on-bone (the old bg-[--bone-200] wrapper did exactly
            that). */}
        <AnnouncementBanner
          placement="coach_workspace"
          kind="notice"
          heading="Gym Notices"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />
        <AnnouncementBanner
          placement="coach_workspace"
          kind="motivation"
          heading="From the Gym"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <p className="t-eyebrow">Coach Standard</p>
          <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">Lead with discipline, protect the culture, and model the grind. The room rises when the coach stays locked in.</p>
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
        <div className="mat-leather flex w-fit gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] p-[var(--s3)]">
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
            {([
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'floor', label: 'Floor' },
              { id: 'athlete-floor-plans', label: 'Athlete Floor Plans' },
              { id: 'development', label: 'Development' },
              { id: 'goals', label: 'Goals' },
              // Both badges are the same value by construction -- coachTasks
              // is derived entirely from shadowQueue's pending_review items
              // (see the comment above coachTasks) -- so Tasks and SHADOW
              // Intel badge the same underlying work seen from two angles,
              // not two different counts that could disagree.
              { id: 'tasks', label: 'Tasks', badge: reviewQueueBadge },
              { id: 'assessments', label: 'Assessments' },
              { id: 'film-study', label: 'Film Study' },
              { id: 'athlete-reviews', label: 'Athlete Reviews' },
              { id: 'shadow', label: 'SHADOW Intel', badge: reviewQueueBadge }
            ] satisfies CoachTab[]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cx(
                  ui.tabButtonBase,
                  'gap-2',
                  activeTab === tab.id ? ui.tabButtonActive : ui.tabButtonInactive,
                )}
              >
                {tab.label}
                {tab.badge ? <StatusBadge tone={tab.badge.tone} label={tab.badge.label} /> : null}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6 animate-fadeIn">
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                <h3 className="t-eyebrow">Quick Actions</h3>
                <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Coach Dashboard"
                    label="SHADOW Chat"
                    className="btn"
                  />
                  <Link
                    href="/schedule"
                    className="btn"
                  >
                    Open Scheduler
                  </Link>
                  <Link
                    href="/coach/session-scripts"
                    className="btn"
                  >
                    Session Scripts: Run Tonight&apos;s Plan
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('floor')}
                    className="btn"
                  >
                    Open Live Floor
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor-plans')}
                    className="btn btn--ghost"
                  >
                    Review Athlete Plans
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('tasks')}
                    className="btn btn--ghost"
                  >
                    Process Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="btn btn--ghost"
                  >
                    Open SHADOW Intel
                  </button>
                  <Link
                    href="/rabbit-holes"
                    className="btn btn--ghost"
                  >
                    Write a Rabbit Hole
                  </Link>
                  <Link
                    href="/coach/floor-groups"
                    className="btn btn--ghost"
                  >
                    Today&apos;s Floor Groups
                  </Link>
                  <Link
                    href="/coach/drills"
                    className="btn btn--ghost"
                  >
                    Open Drill Library
                  </Link>
                  <Link
                    href="/coach/cue-library"
                    className="btn btn--ghost"
                  >
                    Open Cue Library
                  </Link>
                  <Link
                    href="/coach/workout-templates"
                    className="btn btn--ghost"
                  >
                    Browse Workout Templates
                  </Link>
                </div>
              </section>

              <section className="grid gap-[var(--s3)] md:grid-cols-3">
                <article className="mat-leather--raised rounded-[var(--r-lg)] px-[var(--s4)] py-[var(--s3)]">
                  <p className="t-eyebrow">Readiness Alerts</p>
                  {readinessTrackingAvailable ? (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{redReadinessCount + yellowReadinessCount}</p>
                      <p className="t-muted">{redReadinessCount} RED, {yellowReadinessCount} YELLOW{unknownReadinessCount > 0 ? `, ${unknownReadinessCount} unknown — unknown is not clear` : ''}</p>
                      {/* The score's own caveat, shown WITH the count rather
                          than in a help panel a coach may never open. The rule
                          that already governs assessment results -- a value is
                          never read without its measurement properties --
                          applies here too; readiness was simply exempt from it
                          until the provenance columns existed to say so.
                          Disappears on its own if a validated method is ever
                          wired, because the condition is computed from the
                          feed. */}
                      {!readinessAnyValidated && (
                        <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-400)]">
                          {READINESS_UNVALIDATED_CAVEAT}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-400)]">No signal</p>
                      <p className="t-muted">No fresh readiness check-ins -- do not read this as &quot;zero flags&quot;</p>
                    </>
                  )}
                </article>
                <article className="mat-leather--raised rounded-[var(--r-lg)] px-[var(--s4)] py-[var(--s3)]">
                  <p className="t-eyebrow">Injury Flags</p>
                  {injuryTrackingAvailable ? (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{injuryFlags}</p>
                      <p className="t-muted">Escalate before block progression</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-400)]">Not tracked</p>
                      <p className="t-muted">No backend injury feed yet -- do not read this as &quot;no injuries&quot;</p>
                      <p className="t-muted mt-[var(--s2)]">Pain an athlete reported themselves is a separate feed, at the top of this page.</p>
                    </>
                  )}
                </article>
                <article className="mat-leather--raised rounded-[var(--r-lg)] px-[var(--s4)] py-[var(--s3)]">
                  <p className="t-eyebrow">Open Reviews</p>
                  <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{reviewsNeeded}</p>
                  <p className="t-muted">Resolve queue items this session</p>
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
                  <h3 className="t-eyebrow">Today&apos;s Session</h3>
                  <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
                  <p className="t-muted">
                    There is no scheduling backend feed yet -- session name, time, and status below are not
                    real. Check your actual schedule directly until this is wired up.
                  </p>
                  <div className="space-y-[var(--s3)]">
                    <div>
                      <p className="t-label mb-[var(--s2)] block">Session Name</p>
                      <p className="t-body font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="t-label mb-[var(--s2)] block">Time</p>
                      <p className="t-body font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="t-label mb-[var(--s2)] block">Status</p>
                      <p className="t-body font-semibold text-[color:var(--bone-400)]">Unavailable - not yet tracked</p>
                    </div>
                    <div>
                      <p className="t-label mb-[var(--s2)] block">Athletes Present</p>
                      <p className="t-data text-[length:var(--t-sm)]">
                        {trackedAttendanceCount > 0 ? `${activeAthletes}/${athletes.length}` : (
                          <span className="text-[color:var(--bone-400)]">Not tracked</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="t-eyebrow">Athlete Roster</h3>

                  {athletesLoading && (
                    <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] text-center">
                      <p className="t-muted">Loading athletes...</p>
                      <div className="mt-[var(--s3)] flex justify-center">
                        <div className="animate-spin h-5 w-5 border-2 border-[color:var(--brass-300)] border-t-transparent rounded-full"></div>
                      </div>
                    </div>
                  )}

                  {athletesError && !athletesLoading && (
                    <div className="rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                      <div className="flex items-center justify-between mb-[var(--s2)] gap-[var(--s3)]">
                        <p className="text-[color:var(--locked-ink)] text-[length:var(--t-sm)] font-semibold">Error loading athletes</p>
                        <button
                          onClick={() => void loadAthletes()}
                          className="btn btn--ghost"
                          aria-label="Retry loading athletes"
                        >
                          Retry
                        </button>
                      </div>
                      <p className="text-[color:var(--locked-ink)] text-[length:var(--t-xs)]">{athletesError}</p>
                    </div>
                  )}

                  {!athletesLoading && athletes.length === 0 && !athletesError && (
                    <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] text-center">
                      <p className="t-muted">No athletes found</p>
                    </div>
                  )}

                  {/* The roster kept a cap; Open Tasks below did not, and the
                      difference is the grid, not the list. This panel shares a
                      md:grid row with Today's Session, so an uncapped roster
                      stretches that row to whatever the session's enrolment
                      happens to be and leaves the session card floating in a
                      column of empty leather. The list is also genuinely
                      unbounded -- a club-wide roster, not a session's worth.

                      What was wrong was the number. max-h-48 is 192px: four
                      athlete rows, on a desktop with a thousand pixels of room,
                      so a coach with a twenty-athlete session was scrolling a
                      porthole inside a page that was already scrolling. The cap
                      is viewport-relative now and it grows with the screen --
                      55vh (Fibonacci) on a tablet, the golden major at 61.8vh
                      from lg up. On a 900px laptop that is ~495px, ten or
                      twelve athletes rather than four; on the gym tablet it
                      still stops short of eating the panel. */}
                  <div className="space-y-2 max-h-[55vh] lg:max-h-[61.8vh] overflow-y-auto">
                    {athletes.map(athlete => (
                      <button
                        type="button"
                        key={athlete.id}
                        onClick={() => setSelectedAthleteId(athlete.id)}
                        className={`w-full p-[var(--s3)] border rounded-[var(--r-md)] cursor-pointer transition text-left ${
                          selectedAthleteId === athlete.id
                            ? 'bg-[rgba(212,175,74,.10)] border-[color:var(--brass-500)]'
                            : 'bg-[rgba(0,0,0,.28)] border-[color:rgba(212,175,74,.22)] hover:border-[color:var(--brass-500)]'
                        }`}
                      >
                        {/* A face, then the name. A coach who works with twenty
                            people recognises them by face long before they read
                            a name; the column of strings this replaces made the
                            person holding the tablet do a lookup the room had
                            already done for them.

                            Everyone has a portrait here whether or not they have
                            a photograph -- the brass plate with their initials is
                            the same object in the same frame, so no row looks
                            unfinished and no row advertises that a photograph
                            exists but is being withheld. */}
                        <div className="flex items-center justify-between gap-[var(--s3)]">
                          <div className="flex items-center gap-[var(--s3)] min-w-0">
                            <ProfilePortrait
                              accountId={athlete.accountId ?? null}
                              initials={athlete.initials ?? '—'}
                              name={athlete.name}
                              photoAvailable={Boolean(athlete.photoAvailable)}
                              size="sm"
                              decorative
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-semibold">{athlete.name}</span>
                              {athlete.ringName && (
                                <span className="block truncate font-[family-name:var(--font-hand)] text-[length:var(--t-sm)] text-[color:var(--brass-300)]">
                                  &ldquo;{athlete.ringName}&rdquo;
                                </span>
                              )}
                            </span>
                          </div>
                          {/* The safety column, kept as its own block on the far
                              side of the row. Identity on the left, state on the
                              right, and nothing personal painted onto either. */}
                          <span className="flex flex-none items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full ${readinessDotClass(athlete.readiness)}`}
                              title={athlete.readiness === 'UNKNOWN' ? 'Readiness not tracked' : `Readiness: ${athlete.readiness}`}
                            ></span>
                            <span className="t-muted">{athlete.attendance}</span>
                          </span>
                        </div>
                        {athlete.injuryFlag && (
                          <p className="mt-[var(--s2)]"><StatusBadge tone="locked" label="Injury flag active" /></p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Open Tasks */}
                <div className="md:col-span-2 mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-eyebrow">Open Tasks</h3>
                  {/* Cap removed outright rather than raised. This panel is
                      md:col-span-2 and it is the last thing in the grid, so
                      there is nothing underneath it for a long list to push
                      off-screen: growing costs the page height it was always
                      going to cost, and the page scroll already handles that.
                      What the 192px window bought instead was a scroll trap --
                      a nested scroller with no visible edge, inside a scrolling
                      page, hiding the fourth task onward from a coach who has
                      no reason to suspect there is a fourth task. Whether the
                      work list is finished is exactly the question this panel
                      exists to answer, and it cannot answer it through a
                      porthole. */}
                  <div className="space-y-2">
                    {coachTasks.filter(t => t.status !== 'Completed').map(task => (
                      <div key={task.id} className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                        <div className="flex justify-between items-start mb-[var(--s3)] gap-[var(--s3)]">
                          <h4 className="font-semibold">{task.title}</h4>
                          <StatusBadge tone={priorityTone(task.priority)} label={task.priority} />
                        </div>
                        <p className="t-muted">{task.when}</p>
                      </div>
                    ))}
                    {coachTasks.length === 0 && (
                      <p className="t-muted">No open tasks. Items appear here from the SHADOW review queue.</p>
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
                <div className="rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                  <div className="flex items-center justify-between mb-[var(--s2)] gap-[var(--s3)]">
                    <p className="text-[color:var(--locked-ink)] text-[length:var(--t-sm)] font-semibold">Error loading athlete floor plans</p>
                    <button
                      onClick={() => void loadFloorPlans()}
                      className="btn btn--ghost"
                      aria-label="Retry loading athlete floor plans"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-[color:var(--locked-ink)] text-[length:var(--t-xs)]">{floorPlansError}</p>
                  <p className="text-[color:var(--locked-ink)] text-[length:var(--t-xs)] mt-[var(--s2)]">Plans may exist that are not shown here. Do not read this as an empty queue.</p>
                </div>
              ) : athleteFloorPlans.length === 0 ? (
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                  <p className="t-body font-semibold text-[color:var(--bone-100)]">No athlete floor plans received yet.</p>
                  <p className="t-muted mt-[var(--s3)]">Once an athlete checks in and their floor plan auto-generates, it will appear here as an individual coach review tab.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {athleteFloorPlans.map((plan, index) => (
                    <article key={`${plan.athleteName}-${plan.generatedAt}-${index}`} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                        <div>
                          <p className="t-eyebrow">Individual Plan</p>
                          <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{plan.athleteName}</h4>
                          <p className="t-muted">Generated {formatGymStamp(plan.generatedAt)}</p>
                        </div>
                        <StatusBadge tone={readinessBadgeTone(plan.readiness)} label={plan.readiness} />
                      </div>

                      <div className="grid gap-[var(--s3)] md:grid-cols-2">
                        {plan.tasks.map((task) => (
                          <div key={task.id} className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                            <div className="flex items-center justify-between gap-[var(--s3)]">
                              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-200)]">{task.title}</p>
                              <StatusBadge tone={task.priority === 'High' ? 'restricted' : 'monitor'} label={task.priority} />
                            </div>
                            <p className="t-label mt-[var(--s2)]">{task.category} - {task.dueDate}</p>
                            <p className="t-muted mt-[var(--s3)]">{task.description}</p>
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

              <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                <h3 className="t-eyebrow">Session Workout Plan</h3>
                <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
                <p className="t-muted">
                  This is the standard {sessionMode} block template, not a running session. Block
                  completion and session progress are not tracked yet. Track the live session on the
                  floor until this is wired up.
                </p>

                <div className="space-y-[var(--s3)]">
                  {workoutBlocks.map((block) => (
                    <div key={block.id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-semibold text-[color:var(--bone-100)]">{block.title}</p>
                          <p className="t-muted">{block.duration} minutes</p>
                          <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">{block.objective}</p>
                        </div>
                      </div>
                      <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                        <div className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                          <p className="t-label">Planned Training</p>
                          <ul className="mt-[var(--s2)] space-y-1 text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                            {block.trainingItems.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                          <p className="t-label">Coach Cues</p>
                          <ul className="mt-[var(--s2)] space-y-1 text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
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
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-eyebrow">Current Certifications</h3>
                  <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
                  <p className="t-body text-[color:var(--bone-400)]">
                    There is no backend feed for coach certifications yet, so this platform holds no record
                    of your credentials or their expiry dates and cannot tell you whether a license is
                    current. Check with your certifying body until this is wired up.
                  </p>
                </div>

                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-eyebrow">Development Topics</h3>
                  <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
                  <p className="t-body text-[color:var(--bone-400)]">
                    Reference list of the coach development curriculum. There is no backend store for
                    completion yet, so progress through these topics cannot be recorded here.
                  </p>
                  <ul className="space-y-[var(--s3)]">
                    {[
                      'Boxing Technique Instruction',
                      'Youth Development Psychology',
                      'Injury Prevention Basics',
                      'Class Management Skills',
                      'Adaptive Coaching'
                    ].map((topic) => (
                      <li key={topic} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-sm)]">
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

              <p>
                <span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span>
              </p>
              <p className="t-muted">
                There is no backend feed for coach goals yet, so this section is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {coachGoals.map(goal => (
                  <div key={goal.id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                    <div className="flex justify-between items-start gap-[var(--s3)]">
                      <h4 className="font-semibold">{goal.title}</h4>
                      <span className="plaque">{goal.category}</span>
                    </div>
                    <div>
                      <div className="flex justify-between text-[length:var(--t-xs)] mb-[var(--s2)]">
                        <span className="text-[color:var(--bone-400)]">Progress</span>
                        <span className="t-data">{goal.progress}%</span>
                      </div>
                      <div className="w-full rounded-[var(--r-sm)] bg-[rgba(0,0,0,.4)] h-2">
                        <div className="rounded-[var(--r-sm)] bg-[var(--brass-500)] h-2" style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                    <p className="t-muted">Due: {goal.dueDate}</p>
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
                <div className="rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                  <div className="flex items-center justify-between mb-[var(--s2)] gap-[var(--s3)]">
                    <p className="text-[color:var(--locked-ink)] text-[length:var(--t-sm)] font-semibold">Unable to load the SHADOW review queue</p>
                    <button
                      onClick={() => void loadShadowData()}
                      className="btn btn--ghost flex-shrink-0"
                      aria-label="Retry loading the SHADOW review queue"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-[color:var(--locked-ink)] text-[length:var(--t-xs)]">This board is incomplete. Open review items may exist that are not listed below.</p>
                </div>
              )}

              <div className="space-y-3">
                {coachTasks.length === 0 && !shadowQueueUnavailable && (
                  <p className="t-muted text-[length:var(--t-sm)]">No open tasks. Items appear here from the SHADOW review queue.</p>
                )}
                {coachTasks.map(task => (
                  <div key={task.id} className={`mat-leather rounded-[var(--r-lg)] p-[var(--s4)] ${
                    task.status === 'Completed' ? 'border-2 border-[var(--cleared)]' : 'border border-[color:rgba(212,175,74,.22)]'
                  }`}>
                    <div className="flex justify-between items-start mb-[var(--s3)] gap-[var(--s3)]">
                      <div>
                        <h4 className="font-semibold">{task.title}</h4>
                        <p className="t-muted mt-[var(--s2)]">{task.when}</p>
                      </div>
                      <div className="flex gap-[var(--s3)]">
                        <StatusBadge tone={priorityTone(task.priority)} label={task.priority} />
                        <StatusBadge tone={taskStatusTone(task.status)} label={task.status} />
                      </div>
                    </div>
                    {task.relatedAthlete && (
                      <p className="t-muted">Related: {athletes.find(a => a.id === task.relatedAthlete)?.name}</p>
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

              <div className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                <h3 className="t-eyebrow">SHADOW Coach Assistant</h3>
                <p className="t-body text-[color:var(--bone-400)]">Ask questions about session management, athlete readiness, goals, tasks, or coaching strategy.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h3 className="t-eyebrow">SHADOW Review Projection</h3>
                  {shadowQueue.length === 0 ? (
                    <p className="t-muted mt-[var(--s3)]">No SHADOW queue items returned.</p>
                  ) : (
                    <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                      {/* This panel used to render slice(0, 6) against a request
                          for 20, so fourteen pending cases could sit behind the
                          last card with nothing on screen suggesting they
                          existed. On a queue of decisions waiting on a person,
                          an undisclosed cap is not a display choice -- the work
                          simply disappears. It renders what it fetched, and says
                          what it did not fetch. */}
                      {shadowQueueTotal !== null && shadowQueueTotal > shadowQueue.length && (
                        <p className="t-muted">
                          Showing {shadowQueue.length} of {shadowQueueTotal}.{' '}
                          {shadowQueueTotal - shadowQueue.length} more{' '}
                          {shadowQueueTotal - shadowQueue.length === 1 ? 'case is' : 'cases are'}{' '}
                          in the queue and not listed here.
                        </p>
                      )}
                      {shadowQueue.map((item) => (
                        <div key={item.intake_case_id} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          <p className="font-semibold text-[color:var(--bone-200)]">{item.summary}</p>
                          <p>Status: {item.status}</p>
                          <p>Documents: {item.document_count}</p>
                          {item.status === 'pending_review' && (
                            <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                              <button
                                type="button"
                                disabled={intakeActionBusyId === item.intake_case_id}
                                onClick={() => void actOnIntakeCase(item.intake_case_id, 'approve')}
                                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={intakeActionBusyId === item.intake_case_id}
                                onClick={() => void actOnIntakeCase(item.intake_case_id, 'reject')}
                                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                          {intakeActionErrors[item.intake_case_id] && (
                            <p className="mt-[var(--s2)] text-[color:var(--locked-ink)]">{intakeActionErrors[item.intake_case_id]}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h3 className="t-eyebrow">SHADOW Observation Projection</h3>
                  {shadowObservations.length === 0 ? (
                    <p className="t-muted mt-[var(--s3)]">No SHADOW observation items returned.</p>
                  ) : (
                    <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                      {/* This one keeps its cap. It is a read-only feed rather
                          than a list of decisions waiting on someone, so showing
                          the most recent handful is a real editorial choice --
                          but it still has to admit it is doing so. */}
                      {shadowObservations.length > 6 && (
                        <p className="t-muted">
                          Showing the 6 most recent of {shadowObservations.length} loaded.
                        </p>
                      )}
                      {shadowObservations.slice(0, 6).map((item) => (
                        <div key={item.id} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
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
                <div className="rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                  <div className="flex items-center justify-between gap-[var(--s3)]">
                    <p className="text-[color:var(--locked-ink)] text-[length:var(--t-sm)] font-semibold">{shadowReadError}</p>
                    <button
                      onClick={() => void loadShadowData()}
                      className="btn btn--ghost flex-shrink-0"
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
            <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-eyebrow">Coach Assessments</h3>
              <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
              <p className="t-body text-[color:var(--bone-400)]">Evaluate coaching effectiveness, communication, and athlete development.</p>
              <div className="t-body text-[color:var(--bone-400)]">Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation.</div>
            </div>
          )}

          {/* FILM STUDY */}
          {activeTab === 'film-study' && (
            <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-eyebrow">Film Study</h3>
              <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
              <p className="t-body text-[color:var(--bone-400)]">Record observations from training videos and self-evaluations.</p>
              <div className="t-body text-[color:var(--bone-400)]">Coming soon: Video upload, timestamp annotations, technical analysis tools.</div>
              <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="t-label">AI Video Analysis - Planned</p>
                <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">Video Upload: FRONT-END PLACEHOLDER | Skill Recognition: BACKEND REQUIRED | Technique Scoring: ML REQUIRED</p>
                <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                  <Link href="/coach/video-analysis" className="btn">
                    Open Video Analysis Surface
                  </Link>
                  <Link href="/athlete/video-analysis" className="btn btn--ghost">
                    Athlete Feedback Surface
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* ATHLETE REVIEWS */}
          {activeTab === 'athlete-reviews' && (
            <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-eyebrow">Athlete Performance Reviews</h3>
              <p className="t-body text-[color:var(--bone-400)]">Comprehensive athlete progress tracking and performance feedback.</p>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s3)]">
                <p className="t-label">Persist Coach Review</p>
                <label className="field">
                  <span className="t-label">Athlete</span>
                  <select
                    value={reviewAthleteId}
                    onChange={(event) => selectReviewAthlete(event.target.value)}
                    disabled={athletesLoading}
                    className="select"
                  >
                    <option value="">Select an athlete</option>
                    {athletes.map((athlete) => (
                      <option key={athlete.id} value={athlete.id}>
                        {athlete.name}
                      </option>
                    ))}
                  </select>
                </label>
                {athletesLoading && (
                  <p className="t-data text-[color:var(--bone-400)]">Loading your athlete roster...</p>
                )}
                {!athletesLoading && athletesError && (
                  <p className="t-data text-[color:var(--locked-ink)]">
                    The athlete roster could not be loaded, so sessions cannot be picked. Athletes and
                    sessions may exist that are not shown here.
                  </p>
                )}
                {!athletesLoading && !athletesError && athletes.length === 0 && (
                  <p className="t-data text-[color:var(--bone-400)]">
                    No athletes are on the roster yet. A session to review appears here once an athlete
                    has one recorded.
                  </p>
                )}

                {reviewSessionsState === 'loading' && (
                  <p className="t-data text-[color:var(--bone-400)]">Loading sessions...</p>
                )}
                {reviewSessionsState === 'unavailable' && (
                  <p className="t-data text-[color:var(--locked-ink)]">
                    {reviewSessionsError} Sessions may exist that are not listed here -- do not read
                    this as &quot;no sessions&quot;.
                  </p>
                )}
                {reviewSessionsState === 'loaded' && reviewSessions.length === 0 && (
                  <p className="t-data text-[color:var(--bone-400)]">
                    No sessions are recorded for this athlete yet. One appears here as soon as a
                    session is persisted.
                  </p>
                )}
                {reviewSessionsState === 'loaded' && reviewSessions.length > 0 && (
                  <label className="field">
                    <span className="t-label">Session</span>
                    <select
                      value={reviewSessionId}
                      onChange={(event) => selectReviewSession(event.target.value)}
                      className="select"
                    >
                      <option value="">Select a session</option>
                      {reviewSessions.map((session) => (
                        <option key={session.sessionId} value={session.sessionId}>
                          {reviewSessionLabel(session)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {reviewSessionId ? (
                  <p className="t-data text-[color:var(--bone-400)]">Session ID {reviewSessionId}</p>
                ) : null}

                {/* What has already been said about this session, shown BEFORE
                    the coach writes more -- the endpoint keeps every review,
                    so a duplicate is prevented by reading, not by the server. */}
                {sessionReviewsState === 'loading' && (
                  <p className="t-data text-[color:var(--bone-400)]">Checking for existing reviews...</p>
                )}
                {sessionReviewsState === 'unavailable' && (
                  <p className="t-data text-[color:var(--locked-ink)]">
                    Existing reviews could not be loaded. Reviews may exist on this session that are
                    not shown here.
                  </p>
                )}
                {sessionReviewsState === 'loaded' && sessionReviews.length === 0 && (
                  <p className="t-data text-[color:var(--bone-400)]">
                    No reviews on this session yet.
                  </p>
                )}
                {sessionReviewsState === 'loaded' && sessionReviews.length > 0 && (
                  <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s3)]">
                    <p className="t-label">Reviews already on this session</p>
                    {sessionReviews.map((review) => (
                      <div key={review.reviewId} className="border-t border-[color:rgba(212,175,74,.12)] pt-[var(--s2)] first:border-t-0 first:pt-0">
                        <p className="t-data text-[color:var(--bone-300)]">
                          <span className="font-bold">{review.decision}</span>
                          {' -- '}
                          {review.coachId === coachAccountId
                            ? 'your review'
                            : `another coach (${review.coachId || 'account unknown'})`}
                          {formatGymDateTimeShort(review.createdAt) ? ` -- ${formatGymDateTimeShort(review.createdAt)}` : ''}
                        </p>
                        {review.notes.trim() !== '' && (
                          <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{review.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <label className="field">
                  <span className="t-label">Decision</span>
                  <select
                    value={reviewDecision}
                    onChange={(event) => setReviewDecision(event.target.value)}
                    className="select"
                  >
                    <option value="approved">approved</option>
                    <option value="follow_up">follow_up</option>
                    <option value="hold">hold</option>
                  </select>
                </label>
                <label className="field">
                  <span className="t-label">Review notes</span>
                  <textarea
                    value={reviewNotes}
                    onChange={(event) => setReviewNotes(event.target.value)}
                    placeholder="Review notes"
                    rows={4}
                    className="textarea"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void submitCoachReview()}
                  disabled={reviewSubmitting}
                  className="btn disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reviewSubmitting ? 'Saving...' : 'Save Coach Review'}
                </button>
                {reviewSyncMessage ? <p className="t-data text-[color:var(--brass-300)]">{reviewSyncMessage}</p> : null}
              </div>
              <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="t-label">Closed-Loop Progression Intelligence - Planned</p>
                <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">Development Recommendation: PLACEHOLDER | Coach Review Required | Human Review Required</p>
                <Link href="/coach/progression-intelligence" className="btn btn--ghost mt-[var(--s3)]">
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

