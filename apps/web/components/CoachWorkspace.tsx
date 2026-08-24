'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import ProfilePortrait from './ProfilePortrait';
import WorkAxis from './WorkAxis';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import { cx, ui } from './uiStyles';
import { apiBase } from '@/lib/apiBase';
import {
  READINESS_UNVALIDATED_CAVEAT,
  isReadinessMethodValidated,
} from '@/src/server/pilot/readinessProvenance';
import { formatGymDateTimeShort, formatGymStamp } from '@/src/lib/gymTime';

/* Golden Era V1 (2026-08-24): root carries ge-coach / ge-coach-workspace /
   ge-room-floor so ppbf-golden-era.css density + brass + room DNA apply.
   Full functional body is the exact current main implementation — no invented functions. */

type TabID = 'dashboard' | 'floor' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';

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

/**
 * The coach workspace's nine surfaces, in the order the tab row draws them.
 *
 * Hoisted out of the JSX so the masthead can name the open one without a
 * second copy of the labels standing next to the first: two lists of the same
 * tabs is how a heading starts disagreeing with the nav underneath it. Badges
 * are deliberately NOT here -- they are live counts read per render, not part
 * of the registry, and freezing one into a constant would be a lie the moment
 * the count changed.
 *
 * 'Athlete Floor Plans' stood between Floor and Development until 2026-08-24.
 * See the comment where its panel used to render for why it is gone.
 */
const COACH_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'floor', label: 'Floor' },
  { id: 'development', label: 'Development' },
  { id: 'goals', label: 'Goals' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'assessments', label: 'Assessments' },
  { id: 'film-study', label: 'Film Study' },
  { id: 'athlete-reviews', label: 'Athlete Reviews' },
  { id: 'shadow', label: 'SHADOW Intel' },
] as const satisfies readonly CoachTab[];

/**
 * Both of these badge the same value by construction -- coachTasks is derived
 * entirely from shadowQueue's pending_review items (see the comment above
 * coachTasks) -- so Tasks and SHADOW Intel show the same underlying work seen
 * from two angles, not two counts that could disagree.
 */
const REVIEW_BADGED_TABS: ReadonlySet<TabID> = new Set<TabID>(['tasks', 'shadow']);

type SessionMode = 'Group' | 'One-on-One';

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

// One pain report, already filtered server-side to the athletes this coach is
// authorized for. Every nullable field is a detail the REPORTER did not supply
// -- render it as "not stated" and never as a value.
//
// NOT NECESSARILY SELF-REPORTED. The observations route admits athlete, coach,
// organization_admin and admin, and this card said "Self-reported by the
// athlete" for all four until 2026-08-24. A coach writing down what they
// observed was shown to the next coach as the child's own words, which changes
// what that coach does with it.
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
  /** Bounded classification from the server. 'unknown' on reports written
   *  before provenance was persisted -- see painReportAlert.ts. */
  reporter: 'athlete' | 'coach' | 'staff_admin' | 'unknown';
}

/** What a missing detail is called, which depends on who was asked. */
function painDetailAbsent(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Not stated by the athlete' : 'Not stated';
}

/** The label over the time the report refers to. */
function painObservedLabel(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Athlete reported it happened' : 'Reported as happening';
}

/* The provenance sentence under each card. Only an athlete's own report is
   described as self-reported; a staff-entered one says so and says it is not a
   medical assessment; an unestablished reporter says that rather than
   defaulting to the athlete. */
const PAIN_PROVENANCE: Record<CoachPainReport['reporter'], string> = {
  athlete:
    'Self-reported by the athlete. This is not a coach assessment and not a medical assessment.',
  coach:
    'Entered by a coach, not self-reported by the athlete. This is an observation, not a medical assessment.',
  staff_admin:
    'Entered by staff, not self-reported by the athlete. This is an observation, not a medical assessment.',
  unknown:
    'The reporter is not recorded. Do not read this as self-reported by the athlete. This is an observation, not a medical assessment.',
};

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

  // Absence is checked BEFORE Number(), because Number(null) is 0, 0 is a
  // legitimate RPE, and Number.isFinite(0) is true -- so the previous
  // `Number(record.rpe)` turned every unrated session into one the athlete
  // had rated zero effort, and the label said so. pilot.sessions.rpe is
  // nullable as of pilot_slice_postgres_session_rpe_semantics_migration.sql,
  // and an open check-in is exactly the row that arrives here as null.
  const rpeIsAbsent = record.rpe === null || record.rpe === undefined;
  const rpe = rpeIsAbsent ? null : Number(record.rpe);
  return {
    sessionId,
    date,
    // null, not 0: an RPE that is absent or unreadable is omitted from the
    // label rather than shown as a fabricated zero-effort session.
    rpe: rpe !== null && Number.isFinite(rpe) ? rpe : null,
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

/* READINESS RED IS NOT THE LOCKED RUNG.
   readinessBoard defines its own bands as operational triage and says so:
   "GREEN = train as planned, YELLOW = check in with the athlete first,
   RED = adjust the plan", explicitly "not clinical judgments". --locked is
   reserved by Jason's locked decision of 2026-08-19 for MEDICALLY_NOT_ALLOWED
   -- a clinician saying no. "Adjust tonight's plan" wearing the same red as
   "a doctor has barred this child" spends the colour that has to mean the
   second thing, on a number a staff member typed at intake.

   The ladder shifts down one rung and keeps three distinct, ordered steps:
   cleared / monitor / restricted. No token is invented and none is added --
   all three already exist and already carry this order. */
function readinessDotClass(readiness: Athlete['readiness']): string {
  if (readiness === 'GREEN') return 'bg-[var(--cleared)]';
  if (readiness === 'YELLOW') return 'bg-[var(--monitor)]';
  if (readiness === 'RED') return 'bg-[var(--restricted)]';
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
  const activeTabLabel = COACH_TABS.find((tab) => tab.id === activeTab)?.label ?? 'Dashboard';
  const [sessionMode, setSessionMode] = useState<SessionMode>('Group');
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
  /* Readings that exist but may not be presented as measurements. Kept so a
     coach sees the judgement and its caveat rather than having it vanish --
     "not a measurement" is not "not written down". */
  const [contextualReadiness, setContextualReadiness] = useState<
    ReadonlyArray<{ athleteId: string; band: string; score: number | null }>
  >([]);

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
  /* "The feed told us something", NOT "somebody has a band".
     This was `athletes.some(a => a.readiness !== 'UNKNOWN')`, which was the
     same question while every reading became a band. Once unvalidated readings
     stopped being promoted, an organization whose scores are ALL staff
     judgements -- which is every organization today -- had no athlete with a
     band, so the tile fell to "No signal": it called a working feed a dead one
     AND took the provenance caveat down with it, since the caveat renders
     inside this branch. "No signal" has to keep meaning no signal. */
  const readinessTrackingAvailable = athletes.some((athlete) => athlete.readiness !== 'UNKNOWN')
    || contextualReadiness.length > 0;
  /* How many readings the feed returned, and how many of those may not be
     presented as measurements.
     Counted from the two sources SEPARATELY, because an unvalidated reading no
     longer becomes a band: it leaves the athlete UNKNOWN and lands in
     contextualReadiness instead. Deriving "unvalidated" from the roster the way
     an earlier draft did returned 0 for exactly the rows it was meant to count,
     so the caveat silently stopped rendering the moment the gate started
     working -- the opposite of the intent, and invisible without a test. */
  const bandedReadinessCount = athletes.filter((athlete) => athlete.readiness !== 'UNKNOWN').length;
  const unvalidatedReadinessCount = contextualReadiness.length;
  const trackedReadinessCount = bandedReadinessCount + unvalidatedReadinessCount;
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
              score?: number;
              method?: string;
              reliability_status?: string;
              validity_status?: string;
            }>;
          };
          const items = board.items ?? [];
          /* ITEM 2: AN UNVALIDATED ROW IS NOT PROMOTED TO A BAND.
             GREEN/YELLOW/RED on this roster is an authoritative reading a coach
             acts on -- it drives the alert count, the dot and the floor-plan
             badge. A score whose method nobody established cannot carry that,
             so it does not become one: the athlete stays UNKNOWN, which this
             tile already refuses to read as "clear", and the raw judgement is
             kept beside it so nothing is lost.
             The stored row is untouched. This decides what may be PRESENTED as
             a measurement, not what is kept. */
          const usable = new Set(items
            .filter((entry) => isReadinessMethodValidated({
              method: entry.method ?? 'UNKNOWN',
              reliability_status: entry.reliability_status ?? '',
              validity_status: entry.validity_status ?? '',
            }))
            .map((entry) => entry.athlete_id));
          const statusByAthlete = new Map(items
            .filter((entry) => usable.has(entry.athlete_id))
            .map((entry) => [entry.athlete_id, entry.status]));
          /* The contextual judgements, preserved with their raw value so a
             coach can still see a colleague wrote something down -- as an
             opinion, under its caveat, never as a rung. */
          setContextualReadiness(items
            .filter((entry) => !usable.has(entry.athlete_id))
            .map((entry) => ({
              athleteId: entry.athlete_id,
              band: entry.status,
              score: typeof entry.score === 'number' ? entry.score : null,
            })));
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
    <div className="text-[color:var(--bone-200)] ge-coach ge-coach-workspace ge-room-floor">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Coach Development Workspace</p>
            {/* The masthead names the open surface, the way the approved
                athlete board does. It read "Live Session Management" on all
                ten tabs, so the one line claiming to say where the coach was
                was wrong nine times out of ten. Derived from activeTab, so it
                cannot drift from the tab row below. */}
            <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)] md:text-[length:var(--t-2xl)]">{activeTabLabel}</h1>
            <p className="t-label mt-[var(--s3)] text-[color:var(--bone-400)]">
              Coach workspace · Live session management
            </p>
            {/* The standing description of the workspace, kept on the tab it
                describes. Under "Film Study" it was describing somewhere
                else. */}
            {activeTab === 'dashboard' && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Manage your program floor, develop yourself, and track athlete progress with SMART goals and assessments.</p>
            )}
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
                Pain reports may exist that are not shown here. Do not read this as "no athlete
                reported pain" -- ask the floor.
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
                  the rest are in each athlete's near-miss history on the decision loop.
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
                        {report.location ?? painDetailAbsent(report.reporter)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Pain type</dt>
                      <dd className={report.painType ? 'text-[color:var(--bone-200)]' : 'text-[color:var(--bone-400)]'}>
                        {report.painType ?? painDetailAbsent(report.reporter)}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">{painObservedLabel(report.reporter)}</dt>
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
                    {PAIN_PROVENANCE[report.reporter]}
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
                  permanent record is the athlete's near-miss history, which nothing on this screen
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
            resolving stays an admin call server-side and is not offered. */
