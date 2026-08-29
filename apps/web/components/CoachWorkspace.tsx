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
// The lock the takedown applies, imported rather than typed as 72 here. A
// coach is told how long the field stays shut before they confirm, so the
// sentence they read and the lock the server applies have to be the same
// number -- a second copy on this screen is a promise that can go stale
// without anything failing. profileIdentity.ts is a pure module with no
// imports of its own; SignInPanel already reads DEFAULT_PIN_LENGTH the same
// way.
import { NICKNAME_LOCK_HOURS } from '@/src/server/pilot/profileIdentity';
import {
  formatGymDateNumeric,
  formatGymDateTimeShort,
  formatGymDay,
  formatGymStamp,
  formatGymTimeOfDay,
} from '@/src/lib/gymTime';
import {
  COACH_DEVELOPMENT_GOAL_STATUS_LABEL,
  COACH_DEVELOPMENT_TOPIC_PROMPTS,
  coachDevelopmentGoalStatusLabel,
  type CoachDevelopmentActivityRow,
  type CoachDevelopmentGoalRow,
  type CoachDevelopmentGoalStatus,
} from '@/src/shared/coachDevelopment';

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
 * the queue changed.
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
  /* THREE THINGS THIS UNION SAYS, AND THEY ARE NOT INTERCHANGEABLE.
     'Present' | 'Absent' | 'Excused' are marks that exist on record.
     'Unknown' means the platform looked and this athlete has no mark today --
     which, before the register is taken, is everyone.
     'Unavailable' means nobody could look. A read that failed must never
     settle into 'Unknown' beside athletes who genuinely have no mark yet.
     'NotCovered' means nobody asked. This roster lists every athlete in the
     organization; the register is only read for the ones the access contract
     clears this coach for, so the rest were never part of the question. A
     third kind of not-knowing, and it must not wear the second's words.

     'Late' IS GONE, deliberately. pilot.attendance_reconciled normalises a
     late arrival to 'present' on the way out -- a late arrival is a day
     attended -- so nothing can ever produce it. A value in a union that no
     feed can emit is an invitation to make one emit it. */
  attendance: 'Present' | 'Absent' | 'Excused' | 'Unknown' | 'Unavailable' | 'NotCovered';

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
  /* Whether this coach is the coach OF RECORD for this athlete, straight from
     the roster route's `is_mine`. Not a display field: it is the one bit that
     separates the two ways a coach can be looking at a child. A covering coach
     under an active pilot.coach_coverage grant reaches the athlete -- rosters,
     sessions, reviews -- but resolveRelationship still answers
     'organization_staff' for them, and the ring-name takedown admits only
     'coach_of_subject'. Without this the takedown control would be offered to
     a covering coach on an adult athlete (a minor's ring name is already
     withheld from anyone outside MINOR_CIRCLE) and could only ever produce a
     404. */
  isMine?: boolean;
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

/**
 * One of this coach's own development goals, as GET /api/pilot/coach/development
 * returns it. Mirrors CoachDevelopmentGoalRow in src/server/pilot/coachDevelopment.ts.
 *
 * WHAT THIS TYPE NO LONGER HAS IS THE POINT. It used to carry `progress:
 * number`, `category` and `dueDate`, and the tab rendered a bar and a "68%"
 * from them -- for three hardcoded goals shown identically to every coach who
 * logged in. There is no progress column in the table this now reads, so
 * there is nothing to render a bar from: the fake figure was removed at the
 * schema, not just at the surface.
 */
type CoachDevelopmentGoal = Pick<
  CoachDevelopmentGoalRow,
  'goal_id' | 'title' | 'development_focus' | 'target_on' | 'status'
>;

/**
 * Development work this coach recorded doing. SELF-ENTERED AND UNVERIFIED --
 * it is not a credential, and the panel that shows it says so. The verified
 * record is pilot.person_clearances, which the Current Certifications panel
 * above reads.
 */
type CoachDevelopmentActivity = Pick<
  CoachDevelopmentActivityRow,
  'activity_id' | 'title' | 'provider' | 'occurred_on' | 'duration_minutes'
>;

/** The TONE for each development-goal state. A personal planning state, never
 *  a safety one: nothing here wears a saturated safety rung. The words come
 *  from the shared vocabulary so this hub and /coach/development call each
 *  state the same thing. */
const GOAL_STATUS_TONE: Record<CoachDevelopmentGoalStatus, BadgeTone> = {
  draft: 'neutral',
  active: 'cleared',
  completed: 'monitor',
  cancelled: 'neutral',
};

const GOAL_STATUS_BADGE: Record<CoachDevelopmentGoalStatus, { readonly tone: BadgeTone; readonly label: string }> = {
  draft: { tone: GOAL_STATUS_TONE.draft, label: COACH_DEVELOPMENT_GOAL_STATUS_LABEL.draft },
  active: { tone: GOAL_STATUS_TONE.active, label: COACH_DEVELOPMENT_GOAL_STATUS_LABEL.active },
  completed: { tone: GOAL_STATUS_TONE.completed, label: COACH_DEVELOPMENT_GOAL_STATUS_LABEL.completed },
  cancelled: { tone: GOAL_STATUS_TONE.cancelled, label: COACH_DEVELOPMENT_GOAL_STATUS_LABEL.cancelled },
};

/**
 * The coach's own session in progress, as GET /api/pilot/session-scripts/runs
 * returns it. Mirrors LiveSessionScriptRun in
 * src/server/pilot/sessionScriptRuns.ts, trimmed to the fields this hub shows.
 *
 * THE SERVER OWNS THE CLOCK: elapsed_seconds is computed there from
 * started_at, paused_seconds and paused_at, so a coach whose tab reloaded sees
 * the same reading as one whose did not. Nothing here counts time.
 */
interface CoachLiveRun {
  run_id: string;
  script_id: string;
  script_version: number;
  started_at: string;
  elapsed_seconds: number;
  is_paused: boolean;
  athletes_present: number | null;
  delivered_on: string;
}

/**
 * A scheduled class, as GET /api/pilot/scheduler returns it in `classes`.
 * Mirrors SchedulerClass in src/server/pilot/schedulerDb.ts, trimmed to the
 * fields the dashboard names. The route already filters to the classes this
 * coach teaches, scheduled, or covers -- this component does no scoping of
 * its own and must not start.
 */
interface CoachScheduledClass {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  status: 'open' | 'full' | 'cancelled';
}

/**
 * One of this coach's own staff credentials, as GET /api/pilot/coach/credentials
 * returns it. `band` is derived server-side by deriveCredentialBand, which
 * re-checks expires_on against today on every read -- so a certificate that
 * aged out since it was last written reads as expired here without a cron job.
 *
 * The band is displayed, never recomputed. A second derivation on the client
 * is a second answer to "is this coach current", and the two would drift.
 */
interface CoachCredentialItem {
  clearance_type_id: string;
  name: string;
  issuing_authority: string;
  status: string;
  band: string;
  issued_on: string | null;
  expires_on: string | null;
  has_document: boolean;
}

/**
 * The wording for each credential band. Same vocabulary as
 * app/coach/credentials/page.tsx's BAND_BADGE, deliberately: the hub and the
 * upload page describe one record, and two labels for one state is how a coach
 * comes to believe they have two.
 *
 * An unrecognised band falls to 'missing' rather than rendering the raw token,
 * because "Not on file" is the safe reading of a state this build does not
 * know -- never "Current".
 */
const CREDENTIAL_BAND_LABEL: Record<string, { readonly tone: BadgeTone; readonly label: string }> = {
  current: { tone: 'cleared', label: 'Current' },
  expiring_soon: { tone: 'monitor', label: 'Expiring soon' },
  expired: { tone: 'restricted', label: 'Expired' },
  submitted: { tone: 'monitor', label: 'Awaiting review' },
  revoked: { tone: 'restricted', label: 'Revoked' },
  not_required: { tone: 'neutral', label: 'Not required' },
  missing: { tone: 'locked', label: 'Not on file' },
};

function credentialBandBadge(band: string): { readonly tone: BadgeTone; readonly label: string } {
  return CREDENTIAL_BAND_LABEL[band] ?? CREDENTIAL_BAND_LABEL.missing;
}

/**
 * "1h 04m" / "12m 30s" from the server's own elapsed count. Whole seconds
 * only, because that is what the server sends; this never interpolates
 * between reads, which would show a clock that is running while the page is
 * not being told anything.
 */
function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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

  /* The coach's session in progress, from /api/pilot/session-scripts/runs.
     Four states, not two: 'loading' and 'unavailable' must never collapse into
     the same rendering as 'loaded with no run'. "You have nothing running" and
     "nobody could tell whether you have anything running" are opposite answers
     to a coach deciding whether to start a second session over a live one --
     which is exactly why /coach/session-scripts disables its own start button
     while this read is failing. */
  const [liveRun, setLiveRun] = useState<CoachLiveRun | null>(null);
  const [liveRunState, setLiveRunState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  /* Today's classes, from /api/pilot/scheduler. The route filters to the
     classes this coach teaches, scheduled, or covers; nothing is re-scoped
     here. Same three states and the same reason: an empty schedule and an
     unreadable one are different facts about a coach's evening. */
  const [todayClasses, setTodayClasses] = useState<CoachScheduledClass[]>([]);
  const [todayClassesState, setTodayClassesState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  /* This coach's own staff credentials, from /api/pilot/coach/credentials.
     Read-only here -- uploading is /coach/credentials' job and this hub does
     not duplicate it. A failed read renders as UNAVAILABLE and never as "no
     credentials on file", which a coach would read as "I have none recorded"
     rather than "the platform could not look". */
  const [credentials, setCredentials] = useState<CoachCredentialItem[]>([]);
  const [credentialsState, setCredentialsState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

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
  /* Whether the coach PICKED this athlete, as opposed to the roster having
     seeded the first row when it loaded (see loadAthletes). Every other panel
     is happy with the seeded selection -- it is what stops the detail column
     rendering empty on arrival -- but the ring-name takedown below is gated on
     a deliberate act, and a selection nobody made is not one. Without this,
     exactly one child per gym, the alphabetically first with a ring name,
     would carry a live takedown control on every coach's dashboard from first
     paint, for no reason a coach could be told. */
  const [athleteChosenByCoach, setAthleteChosenByCoach] = useState(false);

  /* THE RING-NAME TAKEDOWN, coach side.
     POST /api/pilot/profile/nickname/clear has existed since ring names
     shipped, and until now nothing on any screen called it. A safeguarding
     control with no door is a control this gym does not have: the route's own
     header calls a takedown "an instant undo" for the adults who know the
     child, and the instant part was missing.

     Three pieces of state, all keyed by athlete rather than global, because a
     roster is a list and a coach may be part-way through one row while another
     row is still showing why its attempt failed.

     `nicknameClearArmedId` is the confirm step. A clear is immediate, has no
     undo, and locks the field for NICKNAME_LOCK_HOURS -- a single click on a
     scrolling list of children, on a tablet, in a gym, is the wrong shape for
     that. It is deliberately NOT window.confirm: the sentence a coach needs to
     read names the child and says what the lock does, and a browser dialog
     cannot say either. */
  const [nicknameClearArmedId, setNicknameClearArmedId] = useState<string | null>(null);
  const [nicknameClearBusyId, setNicknameClearBusyId] = useState<string | null>(null);
  const [nicknameClearErrors, setNicknameClearErrors] = useState<Record<string, string>>({});
  /* What the coach is told AFTER it happened, and where the number comes from.
     The row's ring name disappears on success, and a name quietly vanishing is
     not an acknowledgement -- a coach who looked away has no way to tell a
     completed takedown from a row that never had one. This holds the lock the
     SERVER reported (`locked_for_hours` off the response), not the constant
     above: the pre-confirm warning is a prediction and this is a record, and
     the two are allowed to be sourced differently for that reason. */
  const [nicknameClearedHours, setNicknameClearedHours] = useState<Record<string, number | null>>({});

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

  /* This coach's own development record: what they said they are working on,
     and what they did about it.

     This used to be `useState<CoachGoal[]>([])` with a comment reading "there
     is no backend feed for coach development goals yet" -- true when it was
     written, and it stopped being true when /api/pilot/coach/development
     shipped. Before that it was three hardcoded goals with invented progress
     percentages, identical for every coach. The list is now the coach's own
     rows and the percentages have nowhere to come from.

     Self-scoped like the credential read beside it: the route takes no
     account id and answers for the caller, so nothing here can widen to a
     colleague's goals. */
  const [coachGoals, setCoachGoals] = useState<CoachDevelopmentGoal[]>([]);
  const [coachActivities, setCoachActivities] = useState<CoachDevelopmentActivity[]>([]);
  const [developmentState, setDevelopmentState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  /* One sentence under the KPI row saying whether a session is running.
     Said as a sentence rather than as a tile because a tile is the shape of a
     measurement; this is a state.

     This read used to say "Live session tracking is not built yet." It was
     wrong: pilot.session_script_runs, /api/pilot/session-scripts/runs and
     /coach/session-scripts have carried real server-clocked delivery since the
     run-state migration. A hub telling a coach a capability does not exist is
     the same class of defect as a hub inventing one -- the coach acts on the
     claim either way, and here they would go on working around a feature they
     already have. */
  const sessionStatus = useMemo(() => {
    if (liveRunState === 'loading') {
      return 'Checking whether you have a session in progress...';
    }
    if (liveRunState === 'unavailable') {
      return 'Whether you have a session in progress could not be checked. A live session may be running that is not shown here.';
    }
    if (liveRun) {
      return liveRun.is_paused
        ? `Session in progress, paused at ${formatElapsed(liveRun.elapsed_seconds)}.`
        : `Session in progress -- running ${formatElapsed(liveRun.elapsed_seconds)}.`;
    }
    return 'No session in progress. Session Scripts is where a live delivery starts.';
  }, [liveRun, liveRunState]);

  // Attendance/injury/readiness are currently always 'Unknown'/null/'UNKNOWN'
  // (see loadAthletes) -- these counts are real aggregations, but over data
  // that isn't tracked yet, so every stat derived from them below is
  // rendered with an explicit "not tracked" state instead of a bare number.
  // A bare 0 here would read as "confirmed zero injuries," which is false.
  /* trackedAttendanceCount stood here and fed the old "Today's Session"
     panel's Athletes Present row. That row now reads athletes_present off the
     live run, which is a number a coach actually entered when they started
     the delivery, so the roster-derived count has no reader left.

     A count over the attendance column stood here after it too, and is gone
     with this change rather than repointed at the real feed. It had no
     reader: the summary panel takes the roster size. Now that today's marks
     ARE loaded, such a count would be a NEW claim on the dashboard -- "how
     many of your athletes are in today" -- and one whose denominator invites
     the percentage this lane keeps refusing. The per-athlete mark on each
     roster row is the feature; a gym-wide tally is a decision somebody should
     make deliberately, not a side effect of wiring a feed. */
     live run, which is a number a coach actually entered when they started the
     delivery, so the roster-derived count has no reader left. It is not
     re-added as an unused aggregate: the roster's attendance column is still
     'Unknown' for everyone (see loadAthletes), and a second count over it
     would only be another way to render nothing.

     activeAthletes followed it, for the same reason and one step later. It
     counted the roster minus Absent and Unknown -- but attendance is 'Unknown'
     for everyone until a register is wired up, so it counted nobody and the
     panel read "no athletes are assigned to you" to a coach with a full
     roster. The panel now takes athletes.length, which is a number this
     component actually knows. Deleted rather than left for a future reader:
     lint caught it the moment its last caller moved, and an unused aggregate
     over data we do not have is what produced the wrong sentence. */
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

  /* Whether this coach has a session on the floor right now. Same contract as
     /coach/session-scripts' own check -- { run: null } is a successful answer,
     not a missing resource -- so a null run here means "checked, nothing
     running" and only a thrown read means "unknown". */
  const loadLiveRun = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('live-run');
      }
      const payload = (await response.json()) as { run?: CoachLiveRun | null };
      setLiveRun(payload.run ?? null);
      setLiveRunState('loaded');
    } catch {
      // Never fall through to "no session in progress": a coach reading that
      // after a failed check could start a second delivery over a live one.
      setLiveRun(null);
      setLiveRunState('unavailable');
    }
  }, []);

  /* Today's classes for this coach. The scheduler route returns the whole
     visible set; the gym-day filter below is presentation, and the gym's zone
     is the one the rest of this platform names dates in (see src/lib/gymTime).
     Comparing with the viewer's local day would put a 7pm class on tomorrow
     for anyone reading from further east. */
  const loadTodayClasses = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/scheduler`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('scheduler');
      }
      const payload = (await response.json()) as { classes?: CoachScheduledClass[] };
      const today = formatGymDateNumeric(new Date());
      const items = (payload.classes ?? [])
        .filter((item) => item && typeof item.start_at === 'string')
        .filter((item) => formatGymDateNumeric(item.start_at) === today)
        /* By instant, not by string: two classes on the same gym day can
           arrive with different UTC offsets, and lexical order on those is
           not chronological order. */
        .sort((left, right) => new Date(left.start_at).getTime() - new Date(right.start_at).getTime());
      setTodayClasses(items);
      setTodayClassesState('loaded');
    } catch {
      // An empty list would read as "nothing is on tonight", which is a
      // scheduling claim this read did not earn.
      setTodayClasses([]);
      setTodayClassesState('unavailable');
    }
  }, []);

  /* This coach's own credential record. The route is self-scoped -- it takes
     no account id and answers for the caller -- so nothing here can widen to
     another person's documents, and no document bytes cross this boundary
     (the list response deliberately withholds document_ref). */
  const loadCredentials = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/credentials`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('credentials');
      }
      const payload = (await response.json()) as { items?: CoachCredentialItem[] };
      setCredentials(payload.items ?? []);
      setCredentialsState('loaded');
    } catch {
      // "Not on file" is a claim about the record; this is a failure to read
      // it. A coach must not conclude either way from a broken request.
      setCredentials([]);
      setCredentialsState('unavailable');
    }
  }, []);

  /* TODAY'S MARKS, from pilot.attendance_reconciled by way of its own route.

     A SEPARATE READ FROM THE ROSTER, deliberately. The two fail differently
     and a coach needs the roster whether or not the register loaded: folding
     this into the athletes call would mean one broken query costs both, and
     the athlete list is the more important half. It also means the failure
     state is per-concern, which is what lets the row say "attendance
     unavailable" against a name it can still show.

     A MARK ARRIVES OR IT DOES NOT. Athletes with no row keep 'Unknown',
     which before the register is taken is everyone -- that is the ordinary
     state of a gym at 4pm, not a finding. Only a FAILED read moves anyone to
     'Unavailable', and it moves everyone, because what failed was the
     question and not any one answer. */
  const loadAttendanceToday = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/attendance-today`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('attendance');
      const payload = (await response.json()) as {
        covered?: string[];
        marks?: Array<{ athlete_id: string; status: 'present' | 'absent' | 'excused' }>;
      };
      const byAthlete = new Map(
        (payload.marks ?? []).map((mark) => [mark.athlete_id, mark.status] as const),
      );
      const covered = new Set(payload.covered ?? []);
      const LABEL = { present: 'Present', absent: 'Absent', excused: 'Excused' } as const;
      setAthletes((prior) => prior.map((athlete) => {
        const mark = byAthlete.get(athlete.id);
        if (mark) return { ...athlete, attendance: LABEL[mark] };
        /* An athlete the register did not cover was never asked about. This
           roster lists the whole organization; the register is scoped to the
           athletes this coach is cleared for, so for the others there is no
           answer rather than an empty one. */
        if (!covered.has(athlete.id)) return { ...athlete, attendance: 'NotCovered' as const };
        // Covered and unmarked is 'Unknown', never 'Absent'. The register may
        // simply not have been taken yet, and a child who did not train and a
        // child nobody has ticked off look identical from here.
        return { ...athlete, attendance: 'Unknown' as const };
      }));
    } catch {
      /* Everyone, not just the ones without a mark: the read that failed
         covered the whole roster, so no athlete's attendance on this screen
         rests on anything. Leaving stale marks up would be worse than saying
         so -- a coach would read yesterday's register as today's. */
      setAthletes((prior) => prior.map((athlete) => ({ ...athlete, attendance: 'Unavailable' })));
    }
  }, []);

  /* This coach's own development goals and recorded work. Self-scoped in the
     same way as the credential read above -- the route takes no account id. */
  const loadDevelopment = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('development');
      }
      const payload = (await response.json()) as {
        goals?: CoachDevelopmentGoal[];
        activities?: CoachDevelopmentActivity[];
      };
      setCoachGoals(payload.goals ?? []);
      setCoachActivities(payload.activities ?? []);
      setDevelopmentState('loaded');
    } catch {
      // "You have written nothing down" is a claim about the coach; this is a
      // failure to read. A coach who believed the first would re-write a goal
      // they already had.
      setCoachGoals([]);
      setCoachActivities([]);
      setDevelopmentState('unavailable');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPainReports();
    void loadBarrierReports();
    void loadLiveRun();
    void loadTodayClasses();
    void loadCredentials();
    void loadDevelopment();
  }, [loadPainReports, loadBarrierReports, loadLiveRun, loadTodayClasses, loadCredentials, loadDevelopment]);

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

      // Convert PilotAthlete to Athlete format. Readiness and injury flag have
      // no backend source yet -- do not fabricate them (see the Athlete
      // interface comment). Attendance now HAS one, read separately below, so
      // it starts Unknown and is filled in from the marks that exist. Do not
      // truncate the roster either; a silent slice(0, 3) here would hide real
      // athletes from the coach with no indication anything was cut.
      const athleteList: Athlete[] = items.map((item) => ({
        id: item.athlete_id,
        name: item.full_name || 'Unknown',
        track: item.gym_status || 'Foundations',
        readiness: 'UNKNOWN',
        injuryFlag: null,
        // Today's mark arrives from its own read, below. 'Unknown' is the
        // correct starting value and stays correct for anyone with no mark.
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
              is_mine?: boolean;
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
            athlete.isMine = face.is_mine;
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
      /* Today's marks, after the roster is in state. Sequenced rather than
         fired alongside because it maps over the athletes that were just set;
         started here rather than in its own effect so a roster REFRESH
         re-reads the register too -- otherwise the retry button would leave
         yesterday's marks standing beside today's names. */
      void loadAttendanceToday();
    } catch (error) {
      setAthletesError(error instanceof Error ? error.message : 'Failed to load athletes');
      // Fallback: set empty list but don't block UI
      setAthletes([]);
    } finally {
      setAthletesLoading(false);
    }
  }, [loadAttendanceToday]);

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

  /**
   * Clear an athlete's ring name.
   *
   * The server decides whether this coach may: POST
   * /api/pilot/profile/nickname/clear runs assertViewerMayReachSubject and
   * then requires organization admin, coach_of_subject or guardian_of_subject,
   * and answers a refusal as a hidden 404. Nothing is re-decided here. What
   * this screen contributes is that the control is only OFFERED where it can
   * work -- the faces read that supplies `ringName` is the coach's own roster,
   * and decideRingName only returns a name to someone the ring name is already
   * visible to -- so a coach is not handed a button whose only outcome is a
   * refusal about a child they cannot see.
   *
   * On success the row's ring name is dropped locally rather than the roster
   * being refetched. The refetch would be honest too, but it is a four-request
   * reload of a list the coach is standing in the middle of, and the one fact
   * that changed is known exactly.
   */
  async function clearRingName(athleteId: string, accountId: string) {
    if (nicknameClearBusyId) return;

    setNicknameClearBusyId(athleteId);
    setNicknameClearErrors((prev) => ({ ...prev, [athleteId]: '' }));

    try {
      const response = await fetch(`${apiBase()}/api/pilot/profile/nickname/clear`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        locked_for_hours?: number;
      };

      if (!response.ok || !payload.ok) {
        /* A 404 here is the route's hidden-not-found, which is what it answers
           BOTH for "no such athlete" and for "you are not allowed to". It is
           deliberately not decoded into either -- guessing would either accuse
           a coach of overreach or tell them a child does not exist, and only
           one of those is true. */
        setNicknameClearErrors((prev) => ({
          ...prev,
          [athleteId]: payload.error || 'The ring name was not cleared. Ask an organization admin.',
        }));
        return;
      }

      setAthletes((prev) => prev.map((athlete) => (
        athlete.id === athleteId ? { ...athlete, ringName: null } : athlete
      )));
      /* Number.isFinite, not `?? NICKNAME_LOCK_HOURS`. A response that did not
         carry the lock is a response that did not say how long -- substituting
         the client's own constant would put a duration in front of a coach
         that no server ever stated, which is the whole failure mode this
         platform keeps writing comments about. Absent stays absent, and the
         rendering below says "cleared" without a number. */
      const lockedHours = payload.locked_for_hours;
      setNicknameClearedHours((prev) => ({
        ...prev,
        [athleteId]: typeof lockedHours === 'number' && Number.isFinite(lockedHours) ? lockedHours : null,
      }));
      setNicknameClearArmedId(null);
    } catch {
      setNicknameClearErrors((prev) => ({
        ...prev,
        [athleteId]: 'Network error -- the ring name was NOT cleared. Please try again.',
      }));
    } finally {
      setNicknameClearBusyId(null);
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
      /* THE CHECK IS REPEATED AFTER EVERY await, NOT ONLY AFTER THE FETCH.
         Reading the body is a second suspension point, and a coach who
         changes athlete during it used to get the previous athlete's session
         list rendered under the new athlete's name -- one athlete's training
         record attributed to another, which is the failure this guard exists
         to prevent and the one it did not cover. Every state-setting branch
         below is now downstream of a check that no await follows. */
      if (reviewAthleteRef.current !== athleteId) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (reviewAthleteRef.current !== athleteId) {
          return;
        }
        setReviewSessionsError(payload.error || 'Sessions could not be loaded.');
        setReviewSessionsState('unavailable');
        return;
      }

      const payload = (await response.json()) as { items?: unknown[] };
      if (reviewAthleteRef.current !== athleteId) {
        return;
      }
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
      // Same second suspension point, same re-check: reviews written about
      // one session must not appear under another.
      if (reviewSessionRef.current !== sessionId) {
        return;
      }
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
        <section aria-live="polite" className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] p-[var(--s4)] space-y-[var(--s3)]">
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
            <div className="border-2 border-[color:rgb(var(--brass-400-rgb)_/_.5)] p-3">
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
          /* THE ROSTER SIZE. This was the attendance-derived count, which
             was permanently 0 because nothing fed the attendance column, so
             the panel's empty-floor branch fired for every coach, always. A
             feed exists now -- but the roster is still the right source for
             "is anybody assigned to you", because an empty floor and a floor
             nobody has marked in yet are different questions. */
          /* THE ROSTER, not the attendance-derived count. activeAthletes
             below is athletes whose attendance is not 'Unknown', and
             loadAthletes hardcodes 'Unknown' for everyone because there is no
             attendance feed -- so it is always 0, and the panel's empty-floor
             branch fired for every coach, always. */
          activeAthletes={athletes.length}
          /* null where no feed answered, which the panel renders as a
             disclosure instead of a number. injuryFlag is null for every
             athlete (no feed), and the two queue counts are derived from
             coachTasks, which is empty whenever the review queue could not be
             read -- a 0 there tells a coach their queue is clear when nobody
             could look. */
          injuryFlags={injuryTrackingAvailable ? injuryFlags : null}
          reviewsNeeded={shadowQueueUnavailable ? null : reviewsNeeded}
          assignmentsDue={shadowQueueUnavailable ? null : assignmentsDue}
        />

        {/* MODE TOGGLE */}
        <div className="mat-leather flex w-fit gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s3)]">
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
            {COACH_TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                /* Which tab is open was carried by colour alone. A coach using
                   a screen reader, or a colour-blind coach on a bright gym
                   floor, got no answer at all -- Law 3, and the athlete
                   workspace's own tab row has said aria-current since it was
                   built. */
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={cx(
                  ui.tabButtonBase,
                  'gap-2',
                  activeTab === tab.id ? ui.tabButtonActive : ui.tabButtonInactive,
                )}
              >
                {tab.label}
                {reviewQueueBadge && REVIEW_BADGED_TABS.has(tab.id) ? (
                  <StatusBadge tone={reviewQueueBadge.tone} label={reviewQueueBadge.label} />
                ) : null}
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
                {/* The SHADOW Chat launcher and the Write a Rabbit Hole link
                    used to open this grid. Operations V1 (2026-08-21) keeps
                    Quick Actions operational: the SHADOW Intel tab below is
                    the coach's own intelligence surface and stays, and
                    /rabbit-holes keeps its corridor door -- neither surface
                    lost any access, only this shortcut row. */}
                <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-4">
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
                      {contextualReadiness.length > 0 && (
                        <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-400)]">
                          {contextualReadiness.length} staff judgement(s) recorded but not counted
                          above — they are written down, not measured, so they are not read as a
                          readiness band.
                        </p>
                      )}
                      {unvalidatedReadinessCount > 0 && (
                        <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-400)]">
                          {unvalidatedReadinessCount === trackedReadinessCount
                            ? READINESS_UNVALIDATED_CAVEAT
                            : `${unvalidatedReadinessCount} of ${trackedReadinessCount} of these `
                              + `readings come from a method nobody has established. `
                              + READINESS_UNVALIDATED_CAVEAT}
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
                  {/* Its two siblings above both guard this exact case and
                      both say so out loud ("do not read this as zero flags",
                      "do not read this as no injuries"). This tile alone
                      rendered the bare count, and coachTasks is empty whenever
                      the queue could not be read -- so it printed a confident
                      0 over an unread queue. */}
                  {shadowQueueUnavailable ? (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-400)]">Unavailable</p>
                      <p className="t-muted">The review queue could not be read -- do not read this as &quot;no reviews&quot;</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-[var(--s3)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{reviewsNeeded}</p>
                      <p className="t-muted">Resolve queue items this session</p>
                    </>
                  )}
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
                {/* Session Status.

                    Two real feeds, kept apart on purpose. The live run
                    (/api/pilot/session-scripts/runs) is what is happening on
                    the floor NOW, clocked by the server. The schedule
                    (/api/pilot/scheduler) is what the gym intends today. A
                    scheduled class is not evidence that anyone is in the room,
                    and a live delivery is not evidence that it was the class
                    on the calendar -- so neither is ever rendered as the
                    other, and no third "session status" is synthesised from
                    the pair.

                    This panel used to carry a "Planned — Not Yet Implemented"
                    stamp over three "Unavailable - not yet tracked" rows and
                    the sentence "There is no scheduling backend feed yet".
                    All four claims were false against this build. */}
                <div className={ui.panelSpaced}>
                  <h3 className="t-eyebrow">Today&apos;s Session</h3>

                  {liveRunState === 'loading' && (
                    <p className="t-muted">Checking for a session in progress...</p>
                  )}

                  {/* --restricted, not --locked, on this and the other two
                      "could not be read" boxes added here. The safeguarding
                      red is reserved for the top of the safety ladder -- a
                      person who may not participate (owner decision
                      2026-08-19) -- and a fetch that failed is not that.
                      src/design/safeguardingRedReservation.test.ts enforces
                      it and names the substitution. */}
                  {liveRunState === 'unavailable' && (
                    <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                      <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                        Whether you have a session in progress could not be checked. A live session may be
                        running that is not shown here.
                      </p>
                    </div>
                  )}

                  {liveRunState === 'loaded' && liveRun && (
                    <div className="space-y-[var(--s3)]">
                      <p>
                        <StatusBadge tone={liveRun.is_paused ? 'monitor' : 'cleared'} label={liveRun.is_paused ? 'Paused' : 'In progress'} />
                      </p>
                      <div>
                        <p className="t-label mb-[var(--s2)] block">Started</p>
                        <p className="t-body font-semibold">{formatGymDateTimeShort(liveRun.started_at) ?? liveRun.started_at}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)] block">Elapsed (server clock)</p>
                        <p className="t-data text-[length:var(--t-sm)]">{formatElapsed(liveRun.elapsed_seconds)}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)] block">Athletes Present</p>
                        <p className="t-data text-[length:var(--t-sm)]">
                          {typeof liveRun.athletes_present === 'number' ? liveRun.athletes_present : (
                            <span className="text-[color:var(--bone-400)]">Not recorded for this run</span>
                          )}
                        </p>
                      </div>
                      <Link href="/coach/session-scripts" className="btn">
                        Return to live delivery
                      </Link>
                    </div>
                  )}

                  {liveRunState === 'loaded' && !liveRun && (
                    <p className="t-muted">No session in progress.</p>
                  )}

                  <div className="space-y-[var(--s3)]">
                    <p className="t-label mb-[var(--s2)] block">Scheduled today</p>

                    {todayClassesState === 'loading' && (
                      <p className="t-muted">Loading today&apos;s schedule...</p>
                    )}

                    {todayClassesState === 'unavailable' && (
                      <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                        <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                          Today&apos;s schedule could not be loaded. This is not a statement that nothing is
                          scheduled -- open the scheduler to see what is on.
                        </p>
                      </div>
                    )}

                    {todayClassesState === 'loaded' && todayClasses.length === 0 && (
                      <p className="t-muted">No class is scheduled for you today.</p>
                    )}

                    {todayClassesState === 'loaded' && todayClasses.length > 0 && (
                      <ul className="space-y-[var(--s2)]">
                        {todayClasses.map((item) => (
                          <li
                            key={item.class_id}
                            className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
                          >
                            <p className="t-body font-semibold">{item.title}</p>
                            <p className="t-muted">
                              {formatGymTimeOfDay(item.start_at) ?? item.start_at}
                              {' - '}
                              {formatGymTimeOfDay(item.end_at) ?? item.end_at}
                              {item.location ? ` | ${item.location}` : ''}
                            </p>
                            {/* A cancelled class stays listed and says so.
                                Dropping it would leave a coach who remembers
                                it on the calendar unable to tell a
                                cancellation from a failed read. */}
                            {item.status === 'cancelled' && (
                              <p className="mt-[var(--s2)]"><StatusBadge tone="restricted" label="Cancelled" /></p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="t-eyebrow">Athlete Roster</h3>

                  {athletesLoading && (
                    <div className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] text-center">
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
                    <div className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] text-center">
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
                      /* The row and its takedown are SIBLINGS, not nested. The
                         row is itself a button -- the whole card selects the
                         athlete -- and a button inside a button is invalid HTML
                         that browsers resolve by dropping one of them, so the
                         only way to put a second control on this card is beside
                         it. The wrapper carries the key for that reason and
                         does nothing else. */
                      <div key={athlete.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAthleteId(athlete.id);
                          setAthleteChosenByCoach(true);
                        }}
                        className={`w-full p-[var(--s3)] border rounded-[var(--r-md)] cursor-pointer transition text-left ${
                          selectedAthleteId === athlete.id
                            ? 'bg-[rgb(var(--brass-400-rgb)_/_.10)] border-[color:var(--brass-500)]'
                            : 'bg-[rgba(0,0,0,.28)] border-[color:rgb(var(--brass-400-rgb)_/_.22)] hover:border-[color:var(--brass-500)]'
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
                            {/* TODAY'S MARK, and the three readings it can
                                carry are worded so they cannot be confused.
                                A mark that exists shows as itself. 'No mark
                                yet' is what an unregistered athlete looks
                                like before class and is not a claim about
                                whether they came. 'Unavailable' means the
                                register could not be read at all -- said
                                plainly, in the restricted ink, because a
                                coach glancing down this column would
                                otherwise read a quiet word as a quiet
                                answer. */}
                            <span
                              className={athlete.attendance === 'Unavailable'
                                ? 't-muted text-[var(--restricted-ink)]'
                                : 't-muted'}
                              title={athlete.attendance === 'Unavailable'
                                ? 'Today\u2019s register could not be read \u2014 this is not a statement that they were absent'
                                : athlete.attendance === 'NotCovered'
                                  ? 'The register is only read for athletes you are cleared for, so nobody asked about this one -- not a statement about whether they trained'
                                  : athlete.attendance === 'Unknown'
                                    ? 'No attendance mark recorded for today yet'
                                    : `Marked ${athlete.attendance.toLowerCase()} today`}
                            >
                              {athlete.attendance === 'Unknown'
                                ? 'No mark yet'
                                : athlete.attendance === 'Unavailable'
                                  ? 'Register unavailable'
                                  : athlete.attendance === 'NotCovered'
                                    ? 'Not your athlete'
                                    : athlete.attendance}
                            </span>
                          </span>
                        </div>
                        {athlete.injuryFlag && (
                          <p className="mt-[var(--s2)]"><StatusBadge tone="locked" label="Injury flag active" /></p>
                        )}
                      </button>

                      {/* THE TAKEDOWN, shown only on the athlete the coach
                          deliberately selected.

                          Not on every row: twenty children with a "remove"
                          control each, an inch from a readiness dot, on a
                          tablet held in a gym, is a mis-tap waiting to happen
                          on a change that has no undo. Selecting the athlete
                          is the first of the two deliberate acts; arming the
                          confirm is the second.
                          `athleteChosenByCoach` is what makes the first act
                          real: the roster seeds a selection when it loads, and
                          a selection nobody made is not a deliberate act.

                          Not offered at all where there is nothing to remove
                          (`ringName`), nothing to address it to (`accountId`),
                          or no standing to remove it (`isMine`). The first two
                          travel together -- the roster route only produces a
                          ring name from a profile it found by account id --
                          but the control asserts both rather than inferring
                          one from the other. The third is the one that is NOT
                          implied: a covering coach sees an adult athlete's
                          ring name and is still 'organization_staff' to
                          resolveRelationship, so offering them this button
                          would offer a 404. */}
                      {athleteChosenByCoach && selectedAthleteId === athlete.id
                        && athlete.ringName && athlete.accountId && athlete.isMine && (
                        <div className="mt-[var(--s2)] rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          {nicknameClearArmedId === athlete.id ? (
                            <>
                              <p>
                                Removing &ldquo;{athlete.ringName}&rdquo; takes it off every screen
                                now. {athlete.name} cannot set a new ring name for{' '}
                                {NICKNAME_LOCK_HOURS} hours. This cannot be undone.
                              </p>
                              <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s2)]">
                                <button
                                  type="button"
                                  disabled={nicknameClearBusyId === athlete.id}
                                  onClick={() => void clearRingName(athlete.id, athlete.accountId as string)}
                                  className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {nicknameClearBusyId === athlete.id ? 'Removing…' : 'Remove it'}
                                </button>
                                <button
                                  type="button"
                                  disabled={nicknameClearBusyId === athlete.id}
                                  onClick={() => setNicknameClearArmedId(null)}
                                  className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Keep it
                                </button>
                              </div>
                            </>
                          ) : (
                            <button
                              type="button"
                              /* The visible label is short because the row it
                                 sits under already says whose it is; the
                                 accessible name is not, because a screen reader
                                 user arriving by button list gets no such row.
                                 Both name the same action. */
                              aria-label={`Remove ring name “${athlete.ringName}” from ${athlete.name}`}
                              onClick={() => {
                                setNicknameClearArmedId(athlete.id);
                                setNicknameClearErrors((prev) => ({ ...prev, [athlete.id]: '' }));
                              }}
                              className="btn btn--ghost"
                            >
                              Remove ring name
                            </button>
                          )}
                          {nicknameClearErrors[athlete.id] && (
                            /* --restricted-ink, not --locked-ink. The
                               safeguarding red is reserved for the top of the
                               safety ladder -- a person who may not
                               participate. A refused or failed takedown is a
                               request that did not land, and painting it in
                               the participation-block red teaches a coach to
                               read that colour as "something went wrong".
                               src/design/safeguardingRedReservation.test.ts
                               caught this exact substitution here. */
                            <p className="mt-[var(--s2)] text-[color:var(--restricted-ink)]">
                              {nicknameClearErrors[athlete.id]}
                            </p>
                          )}
                        </div>
                      )}

                      {/* The receipt. Outlives the control above -- once the
                          ring name is gone the block that offered to remove it
                          is gone too, and a coach who looked away would
                          otherwise see a row that simply never had one. It says
                          the lock the SERVER reported, and says nothing about a
                          duration when the server did not state one. */}
                      {athlete.id in nicknameClearedHours && (
                        <p className="mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          {typeof nicknameClearedHours[athlete.id] === 'number'
                            ? `Ring name removed. ${athlete.name} cannot set a new one for ${nicknameClearedHours[athlete.id]} hours.`
                            : `Ring name removed. ${athlete.name} cannot set a new one until the gym's lock expires.`}
                        </p>
                      )}
                      </div>
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
                      <div key={task.id} className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
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

          {/* THE "ATHLETE FLOOR PLANS" TAB IS GONE, and honestly rather than
              quietly. Every plan it listed was auto-generated at athlete
              check-in from the readiness slider -- an unvalidated 1-10
              self-report that readinessProvenance.ts says may not be treated
              as an established measurement -- and was headed with a
              client-supplied athleteName (the literal 'Current Athlete'),
              which this panel rendered as if it were an athlete's verified
              identity over individualized work. Nothing coach-authored ever
              wrote to pilot.athlete_floor_plans, so there was no genuine
              plan here to keep: the panel presented machine output over an
              unverifiable name as operational coaching input. When coaches
              get a surface for real individualized plans, it starts from
              coach authorship and server-resolved identity, not this feed. */}

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
                {/* The template is still a template -- these five blocks are a
                    shape for a class, carry no run state, and must never grow
                    a progress bar or a per-block status badge here.

                    What changed is the second half of the old sentence. It
                    said block completion and session progress "are not tracked
                    yet", which stopped being true when pilot.session_script_runs
                    shipped: a coach delivering an authored script at
                    /coach/session-scripts has a server-clocked run with a block
                    cursor, pause/resume, and a settled record at the end. The
                    honest statement is that THIS panel does not track a
                    session, not that the platform does not. */}
                <p className="t-muted">
                  This is the standard {sessionMode} block template, not a running session -- it has no
                  run state, and nothing here records what was delivered.
                </p>
                <p className="t-muted">
                  Live delivery of an authored session script is real and runs on its own surface: the
                  server holds the clock, the block cursor, pauses, and the settled record of the night.
                  {liveRunState === 'loaded' && liveRun
                    ? ' You have a session in progress right now.'
                    : ''}
                </p>
                <Link href="/coach/session-scripts" className="btn">
                  {liveRunState === 'loaded' && liveRun ? 'Return to live delivery' : 'Open Session Scripts'}
                </Link>

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
                        <div className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                          <p className="t-label">Planned Training</p>
                          <ul className="mt-[var(--s2)] space-y-1 text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                            {block.trainingItems.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
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
                {/* This coach's real credential record.

                    The panel used to carry a "Planned — Not Yet Implemented"
                    stamp and the sentence "There is no backend feed for coach
                    certifications yet, so this platform holds no record of
                    your credentials or their expiry dates and cannot tell you
                    whether a license is current." Every clause was false:
                    pilot.person_clearances, /api/pilot/coach/credentials
                    (self-upload and self-read), /api/pilot/admin/credentials
                    (verification) and /coach/credentials have been carrying
                    exactly that since the clearance register shipped.

                    The damage of the stale version was not cosmetic. A coach
                    reading it would not go and upload a SafeSport certificate
                    or a background check -- they would conclude the platform
                    had no place for one, on a safeguarding record about work
                    with minors.

                    STATUS ONLY. No document bytes and no document reference
                    reach this hub: the list response deliberately withholds
                    document_ref, and /api/pilot/credentials/document is the
                    single path to the file. The band is the server's own
                    derivation, displayed, never recomputed here. */}
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-eyebrow">Current Certifications</h3>

                  {credentialsState === 'loading' && (
                    <p className="t-muted">Loading your credential record...</p>
                  )}

                  {credentialsState === 'unavailable' && (
                    <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                      <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                        Your credential record could not be read. This does not mean nothing is on file --
                        nobody could look. Open the credentials page to check.
                      </p>
                    </div>
                  )}

                  {credentialsState === 'loaded' && credentials.length === 0 && (
                    <p className="t-body text-[color:var(--bone-400)]">
                      Your organization has no active clearance types configured, so there is nothing to
                      hold against your name yet.
                    </p>
                  )}

                  {credentialsState === 'loaded' && credentials.length > 0 && (
                    <ul className="space-y-[var(--s3)]">
                      {credentials.map((item) => {
                        const badge = credentialBandBadge(item.band);
                        return (
                          <li
                            key={item.clearance_type_id}
                            className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                              <p className="t-body font-semibold">{item.name}</p>
                              <StatusBadge tone={badge.tone} label={badge.label} />
                            </div>
                            {item.issuing_authority ? (
                              <p className="t-muted">{item.issuing_authority}</p>
                            ) : null}
                            {/* An expiry date is shown only for the bands that
                                have one to mean. Printing expires_on next to
                                "Awaiting review" would put a date on a document
                                nobody has confirmed yet. */}
                            {item.expires_on && (item.band === 'current' || item.band === 'expiring_soon' || item.band === 'expired') ? (
                              <p className="t-muted">
                                {item.band === 'expired' ? 'Expired' : 'Expires'} {item.expires_on}
                              </p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <Link href="/coach/credentials" className="btn">
                    Manage your credentials
                  </Link>
                </div>

                {/* WHAT THIS PANEL USED TO SAY. "There is no backend store for
                    completion yet, so progress through these topics cannot be
                    recorded here." That was true when it was written and is no
                    longer: /api/pilot/coach/development stores what a coach
                    did, and this shows it back.

                    SELF-ENTERED, AND SAID SO. What a coach records about their
                    own learning is not verified by anyone, and it sits on the
                    same tab as the credential list, which IS verified by an
                    administrator. Two records of very different standing, one
                    screen: the difference is stated rather than left to be
                    inferred.

                    NO COMPLETION MARKS ON THE TOPIC LIST. The five topics are
                    a reference list and stay one. Ticking them off would need
                    this platform to decide what "completed Adaptive Coaching"
                    means, which is coaching curriculum it does not possess --
                    so a topic a coach worked through is recorded as work they
                    did, in their own words, and shows up in the list below
                    like any other. */}
                <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                  <h3 className="t-eyebrow">Your Development Work</h3>

                  {developmentState === 'loading' && (
                    <p className="t-muted">Loading your development record...</p>
                  )}

                  {developmentState === 'unavailable' && (
                    <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                      <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                        Your development record could not be read. This does not mean nothing is
                        recorded — nobody could look. Open your development page to check.
                      </p>
                    </div>
                  )}

                  {developmentState === 'loaded' && coachActivities.length === 0 && (
                    <p className="t-body text-[color:var(--bone-400)]">
                      You have not recorded any development work yet.
                    </p>
                  )}

                  {developmentState === 'loaded' && coachActivities.length > 0 && (
                    <>
                      <p className="t-body text-[color:var(--bone-400)]">
                        What you recorded doing, most recent first. Self-entered: this is your own note
                        that you did it, and it confirms nothing — the verified record is the
                        certifications panel beside this one.
                      </p>
                      {/* SAYING THE LIST IS PARTIAL, because the heading above
                          presents it as the record. A coach with forty entries
                          saw five and had nothing on screen telling them so --
                          the same wrong inference the failed-read copy three
                          lines up works to prevent. */}
                      {coachActivities.length > 5 && (
                        <p className="t-muted m-0">
                          Showing the 5 most recent of {coachActivities.length}. The full record is
                          on your development page.
                        </p>
                      )}
                      <ul className="space-y-[var(--s3)]">
                        {coachActivities.slice(0, 5).map((item) => (
                          <li
                            key={item.activity_id}
                            className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
                          >
                            <p className="t-body font-semibold">{item.title}</p>
                            {/* Every optional part appears only when it was
                                recorded, so a row with no provider renders one
                                clean line rather than a dangling separator. */}
                            <p className="t-muted">
                              {[
                                formatGymDay(item.occurred_on) ?? item.occurred_on,
                                item.provider || null,
                              ].filter(Boolean).join(' · ')}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {/* Read from the shared list rather than recited. The same
                      five topics were hand-typed here as prose, so the
                      development page could gain or lose one and this hub
                      would go on naming the old set -- two copies of a list
                      that is explicitly "not a syllabus" is how one of them
                      quietly becomes the authoritative one. */}
                  <p className="t-muted">
                    Topics some coaches work through: {COACH_DEVELOPMENT_TOPIC_PROMPTS.join(', ')}.
                    A reference list, not a syllabus and not a checklist.
                  </p>

                  <Link href="/coach/development" className="btn">
                    Your development
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* GOALS */}
          {activeTab === 'goals' && (
            <div className="space-y-6 animate-fadeIn">
              {/* THE HELP PANEL CHANGED WITH THE FEATURE. It used to promise
                  "SMART framework", "specific, measurable goals" and "track
                  progress monthly" -- guidance for a surface that measured
                  things. Nothing here measures anything, so guidance telling a
                  coach to make their goals measurable would be describing a
                  product that does not exist. */}
              <HelpPanel
                title="Coach Goals"
                description="What you are trying to get better at, in your own words. The platform stores it and reads it back; it does not score it or move it along."
                usage={[
                  'Write down what you are working on',
                  'Say what it is for, in your own words',
                  'Move a goal along yourself when you decide it has moved',
                  'Record the courses, clinics and topics you worked through'
                ]}
                mistakes={[
                  'Neglecting your own development',
                  'Waiting until renewal deadlines',
                  'Treating a recorded course as a certification -- it is not, and only an administrator verifies those'
                ]}
              />

              {developmentState === 'loading' && (
                <p className="t-muted">Loading your development record...</p>
              )}

              {developmentState === 'unavailable' && (
                <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                  <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                    Your goals could not be read. This is not a statement that you have none — nobody
                    could look. Reload before writing anything down twice.
                  </p>
                </div>
              )}

              {developmentState === 'loaded' && coachGoals.length === 0 && (
                <p className="t-body text-[color:var(--bone-400)]">
                  You have not written down a development goal yet.
                </p>
              )}

              {/* NO PROGRESS BAR AND NO PERCENTAGE, and their absence is the
                  reason this block was rewritten rather than pointed at a new
                  feed. What stood here rendered `{goal.progress}%` and a bar
                  sized by it, over three hardcoded goals that showed every
                  coach the same figures. There is no progress column in
                  pilot.coach_development_goals for it to read, so the shape
                  cannot come back by accident. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {developmentState === 'loaded' && coachGoals.map(goal => {
                  /* Unguarded, this took the whole surface down rather than one
                     row: an unrecognised status yields undefined and the next
                     property read throws during render. An unknown state is
                     shown as the word it arrived as, which is the honest
                     rendering of a value this build does not understand.

                     THE FALLBACK USED TO BE THE WRONG SHAPE -- it supplied a
                     `className`, and this render reads `badge.tone`. Nothing
                     caught it: `Record<K, V>` indexing is typed non-nullable,
                     so `?? fallback` narrows to the left operand and the
                     fallback's shape is checked against nothing. Indexing
                     through a Partial is what makes the `??` real to the type
                     checker, and therefore what makes the fallback's shape
                     checked at all. */
    const badge = (GOAL_STATUS_BADGE as Partial<Record<string, { readonly tone: BadgeTone; readonly label: string }>>)[goal.status]
      ?? { tone: 'neutral' as BadgeTone, label: coachDevelopmentGoalStatusLabel(goal.status) };
                  return (
                    <div key={goal.goal_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                      <div className="flex justify-between items-start gap-[var(--s3)]">
                        <h4 className="font-semibold">{goal.title}</h4>
                        <StatusBadge tone={badge.tone} label={badge.label} />
                      </div>
                      <p className="t-body text-[color:var(--bone-300)]">{goal.development_focus}</p>
                      {/* Only when there is one. A goal with no deadline shows
                          no date line, rather than an empty "Due:" label. */}
                      {goal.target_on ? (
                        <p className="t-muted">Target date {formatGymDay(goal.target_on) ?? goal.target_on}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <Link href="/coach/development" className="btn">
                Write or change a goal
              </Link>
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
                    task.status === 'Completed' ? 'border-2 border-[var(--cleared)]' : 'border border-[color:rgb(var(--brass-400-rgb)_/_.22)]'
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
                        <div key={item.intake_case_id} className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
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
                        <div key={item.id} className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
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
              {/* Human film study is BUILT. Per-skill machine scoring is not,
                  and is parked by owner decision.

                  This tab used to stamp the whole capability "Planned — Not
                  Yet Implemented" and promise "Coming soon: Video upload,
                  timestamp annotations, technical analysis tools", with the
                  upload itself labelled FRONT-END PLACEHOLDER. That was wrong
                  in the direction that costs a coach real work: uploads,
                  malware scanning, guardian-consent-gated playback, film-study
                  proposals and coach review all run today through
                  /api/pilot/video/* and /coach/video-analysis. A coach
                  reading the old copy would have gone on keeping clips
                  somewhere else.

                  The AI half stays honest and stays separate. Per-skill video
                  scoring of minors' technique is PARKED by owner decision
                  (BACKLOG-video-skill-scoring, docs/current/ACTIVE_WORK.md) --
                  not "coming soon", which is a schedule nobody promised. */}
              <h3 className="t-eyebrow">Film Study</h3>
              <p className="t-body text-[color:var(--bone-400)]">
                Coach-led film study is built and running: upload a clip, have it scanned, review it
                against an athlete, and record what you saw. Playback stays behind the guardian consent
                recorded for that athlete.
              </p>
              <div className="flex flex-wrap gap-[var(--s3)]">
                <Link href="/coach/video-analysis" className="btn">
                  Open Video Analysis Surface
                </Link>
                <Link href="/athlete/video-analysis" className="btn btn--ghost">
                  Athlete Feedback Surface
                </Link>
              </div>
              <div className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="t-label">Automatic technique scoring - parked, not scheduled</p>
                <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                  Per-skill machine scoring -- punch detection, footwork grading, technique scores -- is
                  deliberately not built. Publishing machine judgements about a child&apos;s athletic ability
                  without proven accuracy is the risk being refused, not a queue position. Human film study
                  above is the analysis pathway.
                </p>
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
                  <div className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)] space-y-[var(--s3)]">
                    <p className="t-label">Reviews already on this session</p>
                    {sessionReviews.map((review) => (
                      <div key={review.reviewId} className="border-t border-[color:rgb(var(--brass-400-rgb)_/_.12)] pt-[var(--s2)] first:border-t-0 first:pt-0">
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
              {/* Progression intelligence is a real surface, not a planned
                  one. It was labelled "Planned" with a "Development
                  Recommendation: PLACEHOLDER" line while
                  /api/pilot/progression/{gaps,suggestions,assignments,
                  completions} and /coach/progression-intelligence were already
                  carrying recorded gaps, drill assignments and completions.

                  The "Coach Review Required" half of the old line was the one
                  true clause and is kept, in words: a suggestion is
                  deterministic and reaches nobody until a coach confirms or
                  dismisses it. That is the authority boundary, and it is not a
                  build state. */}
              <div className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="t-label">Progression Intelligence</p>
                <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                  Recorded progression gaps, the drills assigned against them, and what was completed.
                  Suggestions are deterministic and reach no athlete until a coach confirms or dismisses
                  them -- the platform never decides this for you.
                </p>
                <Link href="/coach/progression-intelligence" className="btn btn--ghost mt-[var(--s3)]">
                  Open Progression Intelligence Surface
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* The four words, at the foot of the page. See WorkAxis for why this
            is not the motto line that was taken out of this header. */}
        <WorkAxis />
      </div>
    </div>
  );
}
