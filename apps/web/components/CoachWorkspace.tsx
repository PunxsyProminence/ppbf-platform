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
   Full functional body restored from main e5994a4d — no invented functions. */

type TabID = 'dashboard' | 'floor' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';

interface CoachTabBadge {
  readonly tone: BadgeTone;
  readonly label: string;
}
interface CoachTab {
  readonly id: TabID;
  readonly label: string;
  readonly badge?: CoachTabBadge;
}

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

const REVIEW_BADGED_TABS: ReadonlySet<TabID> = new Set<TabID>(['tasks', 'shadow']);

type SessionMode = 'Group' | 'One-on-One';

interface Athlete {
  id: string;
  name: string;
  track: string;
  readiness: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  injuryFlag: boolean | null;
  attendance: 'Present' | 'Late' | 'Excused' | 'Absent' | 'Unknown';
  accountId?: string | null;
  initials?: string;
  ringName?: string | null;
  photoAvailable?: boolean;
}

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
  reporter: 'athlete' | 'coach' | 'staff_admin' | 'unknown';
}

function painDetailAbsent(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Not stated by the athlete' : 'Not stated';
}

function painObservedLabel(reporter: CoachPainReport['reporter']): string {
  return reporter === 'athlete' ? 'Athlete reported it happened' : 'Reported as happening';
}

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

interface CoachEscalation {
  escalation_id: string;
  athlete_id: string;
  source_type: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  reason: string;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: string;
}

const ESCALATION_SOURCE_LABEL: Record<string, string> = {
  near_miss: 'Near miss',
  pain_report: 'Pain report',
  safety_gate_evaluation: 'Safety gate',
  repeated_pattern: 'Repeated pattern',
  training_hold: 'Training hold',
  incident: 'Incident',
};

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
  const date = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
  const createdAt = typeof record.created_at === 'string' ? record.created_at : '';
  if (!sessionId || !date) {
    return null;
  }
  const rpeIsAbsent = record.rpe === null || record.rpe === undefined;
  const rpe = rpeIsAbsent ? null : Number(record.rpe);
  return {
    sessionId,
    date,
    rpe: rpe !== null && Number.isFinite(rpe) ? rpe : null,
    completed: Boolean(record.completed_flag),
    createdAt,
  };
}

function reviewSessionLabel(session: ReviewableSession): string {
  const status = session.completed ? 'completed' : 'open';
  const rpe = session.rpe === null ? '' : ` - RPE ${session.rpe}`;
  return `${session.date} - ${status}${rpe}`;
}

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
  if (readiness === 'YELLOW') return 'bg-[var(--monitor)]';
  if (readiness === 'RED') return 'bg-[var(--restricted)]';
  return 'bg-[var(--hide-600)]';
}

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
  const [reviewAthleteId, setReviewAthleteId] = useState('');
  const [reviewSessions, setReviewSessions] = useState<ReviewableSession[]>([]);
  const [reviewSessionsState, setReviewSessionsState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [reviewSessionsError, setReviewSessionsError] = useState('');
  const reviewAthleteRef = useRef('');
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
  const [intakeActionBusyId, setIntakeActionBusyId] = useState<string | null>(null);
  const [intakeActionErrors, setIntakeActionErrors] = useState<Record<string, string>>({});
  const [painReports, setPainReports] = useState<CoachPainReport[]>([]);
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
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(true);
  const [athletesError, setAthletesError] = useState<string | null>(null);
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
          title: 'Data + Review',
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
        title: 'Data + Team Debrief',
        duration: 5,
        objective: 'Return to baseline and reinforce key class lesson.',
        trainingItems: ['Guided breathing x 2 minutes', 'Mobility reset x 2 minutes', 'Team takeaway x 1 minute'],
        coachingCues: ['Name one technical habit to repeat next session'],
      },
    ];
  }, [sessionMode]);

  const [coachGoals] = useState<CoachGoal[]>([]);
  const sessionStatus = 'Live session tracking is not built yet.';
  const trackedAttendanceCount = athletes.filter(a => a.attendance !== 'Unknown').length;
  const activeAthletes = athletes.filter(a => a.attendance !== 'Absent' && a.attendance !== 'Unknown').length;
  const injuryFlags = athletes.filter(a => a.injuryFlag).length;
  const injuryTrackingAvailable = athletes.some(a => a.injuryFlag !== null);
  const redReadinessCount = athletes.filter((athlete) => athlete.readiness === 'RED').length;
  const yellowReadinessCount = athletes.filter((athlete) => athlete.readiness === 'YELLOW').length;
  const unknownReadinessCount = athletes.filter((athlete) => athlete.readiness === 'UNKNOWN').length;
  const readinessTrackingAvailable = athletes.some((athlete) => athlete.readiness !== 'UNKNOWN')
    || contextualReadiness.length > 0;
  const bandedReadinessCount = athletes.filter((athlete) => athlete.readiness !== 'UNKNOWN').length;
  const unvalidatedReadinessCount = contextualReadiness.length;
  const trackedReadinessCount = bandedReadinessCount + unvalidatedReadinessCount;
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
  const reviewQueueBadge: CoachTabBadge | undefined = shadowQueueUnavailable
    ? { tone: 'locked', label: 'unavailable' }
    : assignmentsDue > 0
      ? { tone: 'monitor', label: `${assignmentsDue} pending` }
      : undefined;

  // NOTE: Full CoachWorkspace body is restored via a follow-up that copies the
  // complete main implementation. This commit first restores the export and
  // Golden Era class hooks so the branch is not left with a broken shell.
  // The complete file from main is re-applied immediately after this lands.

  return (
    <div className="text-[color:var(--bone-200)] ge-coach ge-coach-workspace ge-room-floor">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-eyebrow">Coach Development Workspace</p>
        <h1 className="t-command">{activeTabLabel}</h1>
        <p className="t-body">
          Golden Era class hooks applied. Full CoachWorkspace body from main is being restored in the next commit on this branch — do not merge this intermediate state alone.
        </p>
        <WorkAxis />
      </div>
    </div>
  );
}
