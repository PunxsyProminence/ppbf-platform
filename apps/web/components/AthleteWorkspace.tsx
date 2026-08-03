'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import type { RabbitHoleLessonItem } from './RabbitHole';
import { ANCHOR_KEY_OPTIONS, anchorLabel } from './rabbitHoleAnchorLabels';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import TrainingCard, { type TrainingSession } from './TrainingCard';
import { cx } from './uiStyles';
import { apiBase } from '@/lib/apiBase';

type TabID = 'my-dashboard' | 'athlete-floor' | 'smart-goals' | 'tracks' | 'assessments' | 'bio-checkin' | 'drill-library' | 'rabbit-holes' | 'message-coach' | 'schedule-session' | 'shadow';
type ReadinessLevel = 'GREEN' | 'YELLOW' | 'RED';
type SMARTCategory = 'Boxing' | 'Fitness' | 'Weight Loss' | 'Weight Gain' | 'Academics' | 'Attendance' | 'Recovery' | 'Lifestyle' | 'Leadership';
type GoalStatus = 'Not Started' | 'Active' | 'Completed' | 'Paused';
type PainType = 'Sharp' | 'Dull' | 'Burning' | 'Tight' | 'Pulling' | 'Throbbing' | 'Swollen' | 'Numbness/Tingling' | 'Instability' | 'Other';

interface SMARTGoal {
  id: string;
  title: string;
  category: SMARTCategory;
  targetDate: string;
  successMetric: string;
  progressPercent: number;
  status: GoalStatus;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  timeBound: string;
}

interface FloorTask {
  id: string;
  title: string;
  category: string;
  description: string;
  dueDate: string;
  completed: boolean;
  priority: 'High' | 'Normal';
  linkedGoalId?: string;
}

interface WorkoutBuildInput {
  readiness: ReadinessLevel;
  checkInAt: Date;
  activeGoal?: SMARTGoal;
}

interface StoredAthleteFloorPlan {
  athleteName: string;
  readiness: ReadinessLevel;
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    dueDate: string;
    priority: 'High' | 'Normal';
    linkedGoalId?: string;
  }>;
}

interface Drill {
  id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: string;
}

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

interface PainLogEntry {
  id: string;
  location: string;
  type: PainType;
  severity: number;
  capturedAt: string;
}

/**
 * The stored session a check-out updates. Held from check-in because
 * /api/pilot/sessions/update replaces the whole record: every field below has
 * to be sent back unchanged for the notes to be added to it.
 */
interface ActiveSessionRecord {
  sessionId: string;
  athleteId: string;
  date: string;
  rpe: number;
  checkInNote: string;
  createdAt: string;
}

/** A row of pilot.sessions as GET /api/pilot/sessions/list returns it. */
interface StoredSession {
  sessionId: string;
  athleteId: string;
  date: string;
  rpe: number;
  notes: string;
  completed: boolean;
  createdAt: string;
}

type StoredSessionLoadState = 'loading' | 'loaded' | 'unavailable';
type NotesSaveState = 'idle' | 'saving' | 'saved' | 'failed';
type AthleteIdentityState = 'loading' | 'resolved' | 'unavailable';

// How long the athlete stops typing before the draft is written to their open
// session. Short enough that a tablet recycling the tab loses a phrase at
// worst, long enough that ordinary typing is not one request per keystroke.
const NOTES_DRAFT_SAVE_DELAY_MS = 1200;

/**
 * The note stored when the athlete typed nothing at check-in. pilot.sessions
 * requires a non-empty note, so something has to be written; recognising that
 * exact form on the way back is what keeps it out of the athlete's own notes
 * box, where it would read as a sentence they wrote.
 */
function autoCheckInNote(readiness: ReadinessLevel): string {
  return `Auto check-in readiness ${readiness}`;
}

const AUTO_CHECK_IN_NOTE_PATTERN = /^Auto check-in readiness (GREEN|YELLOW|RED)$/;

/**
 * pilot.sessions stores date as `date` and rpe as `numeric`, and node-postgres
 * hands both back in shapes the session validator rejects on the way in: a
 * timestamp for the first, a string for the second. A rehydrated record is
 * sent straight back by check-out, so it is normalized on arrival. A row that
 * cannot be normalized is dropped rather than half-trusted -- a session whose
 * identity or timing is unreadable must not become the one the athlete is
 * offered a check-out for.
 */
function normalizeStoredSession(row: unknown): StoredSession | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
  const athleteId = typeof record.athlete_id === 'string' ? record.athlete_id.trim() : '';
  const date = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
  const createdAt = typeof record.created_at === 'string' ? record.created_at : '';
  const rpe = Number(record.rpe);

  if (!sessionId || !athleteId || !date || !createdAt || !Number.isFinite(rpe)) {
    return null;
  }

  return {
    sessionId,
    athleteId,
    date,
    rpe,
    notes: typeof record.notes === 'string' ? record.notes : '',
    completed: record.completed_flag === true,
    createdAt,
  };
}

function getReadinessLevel(readinessToTrain: number): ReadinessLevel {
  if (readinessToTrain >= 7) return 'GREEN';
  if (readinessToTrain >= 5) return 'YELLOW';
  return 'RED';
}

/* Goal states are queue outcomes, so they wear the design system's badge rungs
   with a glyph beside the label (Laws 2 + 3), never colour alone. */
function getGoalStatusBadge(status: GoalStatus): { className: string; glyph: string } {
  if (status === 'Active') return { className: 'badge badge--monitor', glyph: '◉' };
  if (status === 'Completed') return { className: 'badge badge--cleared', glyph: '✓' };
  return { className: 'badge badge--restricted', glyph: '▲' };
}

/* This workspace is a gym-floor kiosk surface (PAGE_MAP: ink, Law 5), so tabs
   are floor-sized: every target clears var(--tap). A selected tab is a control
   in the "on" position — brass chassis, never a status colour (Laws 1 + 2). */
const KIOSK_TAB_BASE =
  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.08em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const KIOSK_TAB_ACTIVE = 'border-[color:var(--brass-600)] bg-[var(--brass-500)] text-[color:var(--hide-950)]';
const KIOSK_TAB_INACTIVE =
  'border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]';

/* Kiosk panel shells — the sheet's materials instead of bordered rectangles. */
const PANEL = 'mat-leather rounded-[var(--r-lg)] p-[var(--s5)]';
const PANEL_RAISED = 'mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]';

function formatDueTime(checkInAt: Date, offsetMinutes: number): string {
  const due = new Date(checkInAt.getTime() + offsetMinutes * 60000);
  return due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function buildWorkoutFloorTasks({ readiness, checkInAt, activeGoal }: WorkoutBuildInput): FloorTask[] {
  const core: FloorTask[] = [
    {
      id: `wf_${Date.now()}_1`,
      title: 'Dynamic Warmup + Mobility',
      category: 'Training',
      description: '10-12 minute activation block: hips, shoulders, ankles, and core bracing.',
      dueDate: formatDueTime(checkInAt, 10),
      completed: false,
      priority: 'High',
    },
    {
      id: `wf_${Date.now()}_2`,
      title: 'Technical Boxing Block',
      category: 'Training',
      description: readiness === 'GREEN'
        ? 'Footwork progression + combination reps at normal intensity.'
        : 'Controlled technical reps with clean form and reduced impact output.',
      dueDate: formatDueTime(checkInAt, 30),
      completed: false,
      priority: 'High',
      linkedGoalId: activeGoal?.id,
    },
  ];

  const readinessSpecific: FloorTask[] =
    readiness === 'GREEN'
      ? [
          {
            id: `wf_${Date.now()}_3`,
            title: 'Conditioning Finisher',
            category: 'Training',
            description: 'High-output intervals: 6 rounds x 90s on / 60s active recovery.',
            dueDate: formatDueTime(checkInAt, 55),
            completed: false,
            priority: 'Normal',
          },
        ]
      : [
          {
            id: `wf_${Date.now()}_3`,
            title: 'Recovery Conditioning',
            category: 'Recovery',
            description: 'Low-impact aerobic work and breath control. Keep intensity below threshold.',
            dueDate: formatDueTime(checkInAt, 55),
            completed: false,
            priority: 'Normal',
          },
        ];

  const closeout: FloorTask[] = [
    {
      id: `wf_${Date.now()}_4`,
      title: 'Cooldown + Session Journal',
      category: 'Homework',
      description: 'Log notes, recovery signals, and one improvement point for next session.',
      dueDate: formatDueTime(checkInAt, 80),
      completed: false,
      priority: 'Normal',
      linkedGoalId: activeGoal?.id,
    },
  ];

  return [...core, ...readinessSpecific, ...closeout];
}

// Fast-Track observation feed: best-effort only. The athlete's session
// check-in (POST /api/pilot/sessions, above) already fully succeeds or fails
// on its own -- these calls only enrich SHADOW's formula engine with a
// Session Load (RPE x duration) input, so a failure here must never block or
// roll back the primary check-in.
async function submitFastTrackObservations(input: {
  athleteId: string;
  contextId: string;
  observedAt: string;
  rpe: number;
  durationMinutes: number;
  painFlag: boolean;
  medicalReadAck: boolean;
}): Promise<void> {
  const observations = [
    {
      kind: 'session_rpe' as const,
      value: input.rpe,
      unit: 'rpe_0_10' as const,
      dimensions: { painFlag: input.painFlag, medicalReadAck: input.medicalReadAck },
    },
    {
      kind: 'duration' as const,
      value: input.durationMinutes,
      unit: 'minutes' as const,
    },
  ];

  await Promise.allSettled(observations.map((observation) => fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      athleteId: input.athleteId,
      contextId: input.contextId,
      kind: observation.kind,
      value: observation.value,
      unit: observation.unit,
      dimensions: observation.dimensions ?? {},
      observedAt: input.observedAt,
      idempotencyKey: `${input.contextId}-${observation.kind}`,
    }),
  })));
}

// The vocabularies this tab reads. A rabbit hole is stored against one stable
// key, and the read takes one anchor at a time, so the tab asks for the terms
// that describe an athlete's own development: every progression gap type and
// every severity. Built from the shared vocabulary rather than retyped, so a
// term added to either list is asked for here without another edit.
const RABBIT_HOLE_TAB_ANCHORS: ReadonlyArray<{ anchorType: 'gap_type' | 'severity'; anchorKey: string }> = [
  ...ANCHOR_KEY_OPTIONS.gap_type.map((option) => ({ anchorType: 'gap_type' as const, anchorKey: option.key })),
  ...ANCHOR_KEY_OPTIONS.severity.map((option) => ({ anchorType: 'severity' as const, anchorKey: option.key })),
];

interface RabbitHoleTopic {
  anchorType: string;
  anchorKey: string;
  lessons: RabbitHoleLessonItem[];
}

type RabbitHoleLoadState = 'loading' | 'loaded' | 'unavailable';

/**
 * The gym's authored lessons, as the athlete reads them.
 *
 * Every lesson here was written by a person at this gym. Nothing on this
 * surface carries a SHADOW evidence tier -- PROVEN / EMERGING / EXPERIMENTAL /
 * RESEARCH_NEEDED grade retrieved and cited material, and coaching written by
 * hand cannot borrow that authority.
 *
 * A topic with no lesson is not drawn at all, and a read that did not complete
 * is never reported as an empty library: "the gym has published nothing" is a
 * claim about the coaches, not about the network.
 */
function AthleteRabbitHoleLibrary() {
  const [topics, setTopics] = useState<RabbitHoleTopic[]>([]);
  const [loadState, setLoadState] = useState<RabbitHoleLoadState>('loading');
  const [isPartial, setIsPartial] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const results = await Promise.all(RABBIT_HOLE_TAB_ANCHORS.map(async (anchor) => {
        try {
          const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/get`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchor_type: anchor.anchorType, anchor_key: anchor.anchorKey }),
            signal: controller.signal,
          });

          if (!response.ok) {
            return { anchor, lessons: null };
          }

          const payload = (await response.json()) as { ok?: boolean; rabbit_holes?: RabbitHoleLessonItem[] };
          if (payload.ok !== true || !Array.isArray(payload.rabbit_holes)) {
            return { anchor, lessons: null };
          }

          return { anchor, lessons: payload.rabbit_holes };
        } catch {
          return { anchor, lessons: null };
        }
      }));

      if (controller.signal.aborted) {
        return;
      }

      const failures = results.filter((result) => result.lessons === null).length;
      if (failures === results.length) {
        setTopics([]);
        setIsPartial(false);
        setLoadState('unavailable');
        return;
      }

      setTopics(
        results
          .filter((result) => result.lessons !== null && result.lessons.length > 0)
          .map((result) => ({
            anchorType: result.anchor.anchorType,
            anchorKey: result.anchor.anchorKey,
            lessons: result.lessons as RabbitHoleLessonItem[],
          })),
      );
      setIsPartial(failures > 0);
      setLoadState('loaded');
    })();

    return () => controller.abort();
  }, []);

  if (loadState === 'loading') {
    return <span className="working">Loading the gym&apos;s rabbit holes...</span>;
  }

  if (loadState === 'unavailable') {
    return (
      <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
        The gym&apos;s rabbit holes could not be loaded right now. That is a problem reaching the app, not a sign
        that none have been written.
      </p>
    );
  }

  return (
    <div className="space-y-[var(--s5)]">
      {isPartial ? (
        <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
          Some topics could not be loaded, so what follows is not the full list.
        </p>
      ) : null}

      {topics.length === 0 && !isPartial ? (
        <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
          Your coaches have not published a rabbit hole yet. When they do, it appears here.
        </p>
      ) : null}

      {topics.map((topic) => (
        <div key={`${topic.anchorType}:${topic.anchorKey}`} className="space-y-[var(--s4)]">
          <h3 className="t-eyebrow">
            {anchorLabel(topic.anchorType, topic.anchorKey)}
          </h3>
          {/* A lesson is an authored sheet, so it is a paper object on the
              leather ground — its ink comes from the material itself. */}
          {topic.lessons.map((lesson) => (
            <article key={lesson.rabbit_hole_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s5)] space-y-[var(--s4)]">
              {/* Provenance before content: who is talking, and on what
                  authority, before the claim itself. */}
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">
                Gym coaching · Written by {lesson.author_display_name}
              </p>
              <h4 className="text-[length:var(--t-md)] font-semibold">{lesson.title}</h4>
              <p className="text-[length:var(--t-sm)] leading-relaxed"><strong>Concept:</strong> {lesson.concept}</p>
              {lesson.homework ? (
                <div className="rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] bg-[var(--paper-2)] p-[var(--s4)]">
                  <p className="text-[length:var(--t-sm)] leading-relaxed"><strong>Homework:</strong> {lesson.homework}</p>
                </div>
              ) : null}
              {lesson.citation ? (
                <p className="text-[length:var(--t-xs)] opacity-80">
                  <strong>Library source:</strong> {lesson.citation.document_name}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function AthleteWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('my-dashboard');
  const [backendAthleteId, setBackendAthleteId] = useState<string | null>(null);
  const [athleteIdentityState, setAthleteIdentityState] = useState<AthleteIdentityState>('loading');
  const [backendSyncMessage, setBackendSyncMessage] = useState('');

  // Bio Check-In State
  const [sleepHours, setSleepHours] = useState(8);
  const [energyLevel, setEnergyLevel] = useState(7);
  const [motivation, setMotivation] = useState(7);
  const [soreness, setSoreness] = useState(2);
  const [hydrationStatus, setHydrationStatus] = useState(8);
  const [readinessToTrain, setReadinessToTrain] = useState(8);
  const [injuryFlag, setInjuryFlag] = useState(false);
  // Fast-Track: the minimum-friction data path so athletes who won't fill out
  // a rich Deep-Track sparring log still contribute something SHADOW's
  // formula engine can use (Session Load needs RPE * duration).
  const [sessionDurationMinutes, setSessionDurationMinutes] = useState(60);
  const [medicalReadAck, setMedicalReadAck] = useState(false);
  const [expandedCheckIn, setExpandedCheckIn] = useState(false);
  const [selectedPainLocation, setSelectedPainLocation] = useState<string | null>(null);
  const [showPainModal, setShowPainModal] = useState(false);
  const [currentPainType, setCurrentPainType] = useState<PainType>('Dull');
  const [currentPainSeverity, setCurrentPainSeverity] = useState(3);
  const [painLog, setPainLog] = useState<PainLogEntry[]>([]);
  const [isSavingPain, setIsSavingPain] = useState(false);
  const [painSaveMessage, setPainSaveMessage] = useState('');

  // Goals State - Real API data
  const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [trainingSessions, setTrainingSessions] = useState<TrainingSession[]>([]);

  const [showGoalForm, setShowGoalForm] = useState(false);
  const [isCreatingGoal, setIsCreatingGoal] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<SMARTCategory>('Boxing');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalSuccessMetric, setNewGoalSuccessMetric] = useState('');

  // Floor Tasks State - Real API data
  const [floorTasks, setFloorTasks] = useState<FloorTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  // The gym's own drill library, written by its coaches.
  const [drills, setDrills] = useState<Drill[]>([]);
  const [drillsLoading, setDrillsLoading] = useState(true);
  const [drillsError, setDrillsError] = useState<string | null>(null);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});

  // Shadow State
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowObservationError, setShadowObservationError] = useState('');
  const [selectedCoach, setSelectedCoach] = useState('Coach Jason (Head Coach)');
  const [coachMessageBody, setCoachMessageBody] = useState('');
  const [isSendingCoachMessage, setIsSendingCoachMessage] = useState(false);
  const [coachMessageStatus, setCoachMessageStatus] = useState('');

  // Session Log State. The open session is the server's, not this tab's: a
  // shared gym tablet recycles the tab without warning, and an athlete who
  // came back to a check-in button had no way to close the session they were
  // still inside.
  const [storedSessions, setStoredSessions] = useState<StoredSession[]>([]);
  const [storedSessionLoad, setStoredSessionLoad] = useState<StoredSessionLoadState>('loading');
  const [checkInNotes, setCheckInNotes] = useState('');
  const [activeSessionRecord, setActiveSessionRecord] = useState<ActiveSessionRecord | null>(null);
  const [notesSaveState, setNotesSaveState] = useState<NotesSaveState>('idle');
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [lastWorkoutBuildNote, setLastWorkoutBuildNote] = useState<string | null>(null);

  const currentReadiness: ReadinessLevel = getReadinessLevel(readinessToTrain);
  const checkInTime = activeSessionRecord ? new Date(activeSessionRecord.createdAt).toLocaleString() : null;
  const notesDraft = checkInNotes.trim();
  const notesStored = notesDraft.length > 0 && notesDraft === activeSessionRecord?.checkInNote;
  const recentSessions = storedSessions.filter((session) => session.completed).slice(0, 5);
  const tasksDue = floorTasks.filter(t => !t.completed).length;
  const goalsActive = smartGoals.filter(g => g.status === 'Active').length;

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (response.ok && payload.authenticated && payload.athlete_id) {
          setBackendAthleteId(payload.athlete_id);
          setAthleteIdentityState('resolved');
          return;
        }
        setAthleteIdentityState('unavailable');
      } catch {
        // Keep workspace usable in local-only mode when backend session is
        // unavailable. Nothing about a session can be read or written in that
        // state, so the session panel says so rather than offering buttons.
        setAthleteIdentityState('unavailable');
      }
    })();
  }, []);

  // The drill library is gym-wide coaching content, so it loads once and does
  // not depend on which athlete is signed in.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/drills`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Drill library could not be loaded.');

        // `items`, not `drills` -- same seam defect as the coach library.
        const payload = (await response.json()) as {
          items?: Array<{
            drill_id: string;
            name: string;
            category: string;
            focus: string;
            cues: string[];
            difficulty: string;
          }>;
        };
        if (controller.signal.aborted) return;

        setDrills((payload.items ?? []).map((drill) => ({
          id: drill.drill_id,
          name: drill.name,
          category: drill.category,
          focus: drill.focus,
          cues: drill.cues ?? [],
          difficulty: drill.difficulty,
        })));
        setDrillsError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDrills([]);
        setDrillsError(error instanceof Error ? error.message : 'Drill library could not be loaded.');
      } finally {
        if (!controller.signal.aborted) setDrillsLoading(false);
      }
    })();

    return () => controller.abort();
  }, []);

  // Fetch goals when athlete ID is set
  const loadGoals = useCallback(async () => {
    if (!backendAthleteId) {
      return;
    }

    try {
      setGoalsLoading(true);
      setGoalsError(null);
      const response = await fetch(
        `${apiBase()}/api/pilot/goals/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' }
      );
      if (!response.ok) throw new Error('Failed to load goals');

      const data = (await response.json()) as { items?: Array<{ goal_id: string; title: string; category?: string; target_date?: string; metric?: string; progress_percent?: number; status?: string }> };
      const items = data.items || [];

      // Convert PilotGoal to SMARTGoal format
      const goals: SMARTGoal[] = items.map((item) => ({
        id: item.goal_id,
        title: item.title,
        category: (item.category || 'Boxing') as SMARTCategory,
        targetDate: item.target_date?.split('T')[0] || '',
        successMetric: item.metric || '',
        progressPercent: item.progress_percent || 0,
        status: (item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1).toLowerCase() : 'Not Started') as GoalStatus,
        specific: '',
        measurable: '',
        achievable: '',
        relevant: '',
        timeBound: ''
      }));
      setSmartGoals(goals);
    } catch (error) {
      setGoalsError(error instanceof Error ? error.message : 'Failed to load goals');
    } finally {
      setGoalsLoading(false);
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGoals();
  }, [loadGoals]);

  /**
   * The training card's rows. Read-only and honest: one stamp per session row,
   * so the card cannot show progress the ledger does not have. Failure is silent
   * on purpose -- an athlete's card is an encouragement, not an operational
   * surface, and an error banner over it would be louder than the thing itself.
   */
  const loadTrainingCard = useCallback(async () => {
    if (!backendAthleteId) return;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) { setTrainingSessions([]); return; }
      const data = (await response.json()) as { items?: TrainingSession[] };
      setTrainingSessions(
        (data.items ?? []).map((s) => ({
          session_id: s.session_id,
          date: s.date,
          rpe: Number(s.rpe) || 0,
          completed_flag: Boolean(s.completed_flag),
        })),
      );
    } catch {
      setTrainingSessions([]);
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTrainingCard();
  }, [loadTrainingCard]);

  /**
   * Load the athlete's floor tasks from their persisted floor plan.
   *
   * Check-in writes the generated plan to pilot.athlete_floor_plans via
   * POST /api/pilot/floor-plans, so that table — not the session list — is the
   * durable source for what is on the floor. GET returns plans newest-first.
   */
  const loadFloorTasks = useCallback(async () => {
    if (!backendAthleteId) {
      return;
    }

    try {
      setTasksLoading(true);
      setTasksError(null);
      const response = await fetch(`${apiBase()}/api/pilot/floor-plans?limit=1`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to load floor plan');

      const data = (await response.json()) as {
        items?: Array<{
          generatedAt?: string;
          readiness?: string;
          tasks?: Array<{
            id: string;
            title: string;
            category?: string;
            description?: string;
            dueDate?: string;
            priority?: string;
            linkedGoalId?: string;
          }>;
        }>;
      };

      const latestPlan = data.items?.[0] ?? null;
      const planTasks: FloorTask[] = (latestPlan?.tasks ?? []).map((task) => ({
        id: task.id,
        title: task.title,
        category: (task.category || 'Training') as FloorTask['category'],
        description: task.description || '',
        dueDate: task.dueDate || 'Scheduled',
        completed: false,
        priority: (task.priority || 'Normal') as FloorTask['priority'],
        linkedGoalId: task.linkedGoalId,
      }));

      setFloorTasks(planTasks);
      if (planTasks.length === 0) {
        setBackendSyncMessage('No backend floor tasks are currently assigned.');
      }
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : 'Failed to load floor plan');
      setFloorTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFloorTasks();
  }, [loadFloorTasks]);

  const loadShadowObservations = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 20 }),
      });

      if (!response.ok) {
        throw new Error('Unable to load SHADOW observation stream.');
      }

      const payload = (await response.json()) as { items?: ShadowObservationItem[] };
      setShadowObservations(payload.items ?? []);
      setShadowObservationError('');
    } catch (error) {
      setShadowObservationError(error instanceof Error ? error.message : 'Unable to load SHADOW observation stream.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadShadowObservations();
  }, [loadShadowObservations]);

  /**
   * Read this athlete's sessions and recover the one still open.
   *
   * pilot.sessions is the only durable record of a check-in, so it is also the
   * only thing that can answer "am I still checked in" after a reload. The
   * list route orders by date alone, which cannot separate two sessions on the
   * same day, so ordering is redone here on created_at.
   */
  const loadStoredSessions = useCallback(async () => {
    if (!backendAthleteId) {
      return;
    }

    setStoredSessionLoad('loading');

    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('Session history could not be read.');

      const payload = (await response.json()) as { items?: unknown[] };
      const sessions = (payload.items ?? [])
        .map(normalizeStoredSession)
        .filter((session): session is StoredSession => session !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      const open = sessions.find((session) => !session.completed) ?? null;

      setStoredSessions(sessions);
      setActiveSessionRecord(open
        ? {
            sessionId: open.sessionId,
            athleteId: open.athleteId,
            date: open.date,
            rpe: open.rpe,
            checkInNote: open.notes,
            createdAt: open.createdAt,
          }
        : null);

      if (open && !AUTO_CHECK_IN_NOTE_PATTERN.test(open.notes)) {
        // Put back what the athlete had written. A draft already in the box
        // wins: this read also runs on a manual retry and after a check-out
        // failure, where overwriting would destroy the notes it exists to
        // protect.
        setCheckInNotes((current) => current || open.notes);
      }

      setStoredSessionLoad('loaded');
    } catch {
      // "No open session" and "could not ask" have to stay distinguishable:
      // the first offers a check-in, the second must not claim the athlete is
      // checked out when nobody knows.
      setStoredSessionLoad('unavailable');
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStoredSessions();
  }, [loadStoredSessions]);

  /**
   * Write the notes box through to the open session while it is still open.
   *
   * Notes typed here used to exist only in this tab until check-out, so a
   * reload, a navigation, or a tablet recycling the tab threw away everything
   * the athlete had written for their coach. The session record is updated in
   * place instead, which is also what makes those notes survive a check-out
   * that never happens.
   */
  useEffect(() => {
    const record = activeSessionRecord;
    if (!record || isCheckingOut) {
      return;
    }

    const draft = checkInNotes.trim();
    // pilot.sessions requires a non-empty note, so an emptied box is not a
    // write -- clearing it must not erase what was already stored.
    if (!draft || draft === record.checkInNote) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        setNotesSaveState('saving');
        try {
          const response = await fetch(`${apiBase()}/api/pilot/sessions/update`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: record.sessionId,
              athlete_id: record.athleteId,
              date: record.date,
              rpe: record.rpe,
              notes: draft,
              completed_flag: false,
              created_at: record.createdAt,
              updated_at: new Date().toISOString(),
            }),
          });

          if (!response.ok) throw new Error('Notes were not saved.');

          setActiveSessionRecord((current) => (
            current && current.sessionId === record.sessionId
              ? { ...current, checkInNote: draft }
              : current
          ));
          setNotesSaveState('saved');
        } catch {
          setNotesSaveState('failed');
        }
      })();
    }, NOTES_DRAFT_SAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [checkInNotes, activeSessionRecord, isCheckingOut]);

  const handleCreateGoal = async () => {
    if (isCreatingGoal) return;
    if (!newGoalTitle || !newGoalTargetDate || !newGoalSuccessMetric) return;
    if (!backendAthleteId) {
      // There is no local goal store -- goals exist only in pilot.goals -- so
      // without a backend session nothing is written anywhere.
      setBackendSyncMessage('Goal was not saved. Backend athlete session not found - sign in again and retry.');
      return;
    }

    const now = new Date().toISOString();
    const goalId = `goal_${Date.now()}`;

    setIsCreatingGoal(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_id: goalId,
          athlete_id: backendAthleteId,
          title: newGoalTitle,
          target_date: newGoalTargetDate,
          metric: newGoalSuccessMetric,
          status: 'active',
          created_at: now,
          updated_at: now,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: 'Goal persistence failed' }))) as { error?: string };
        setBackendSyncMessage(payload.error || 'Goal persistence failed');
        return;
      }

      const newGoal: SMARTGoal = {
        id: goalId,
        title: newGoalTitle,
        category: newGoalCategory,
        targetDate: newGoalTargetDate,
        successMetric: newGoalSuccessMetric,
        progressPercent: 0,
        status: 'Active',
        specific: '',
        measurable: '',
        achievable: '',
        relevant: '',
        timeBound: ''
      };
      setSmartGoals([...smartGoals, newGoal]);
      setNewGoalTitle('');
      setNewGoalTargetDate('');
      setNewGoalSuccessMetric('');
      setShowGoalForm(false);
      setBackendSyncMessage('Goal persisted to pilot backend.');
    } catch (error) {
      setBackendSyncMessage(error instanceof Error ? error.message : 'Goal persistence failed');
    } finally {
      setIsCreatingGoal(false);
    }
  };

  const handleCheckIn = async () => {
    // A second check-in over an open session would leave the first one open
    // forever, which is the state this screen exists to get out of.
    if (isCheckingIn || activeSessionRecord) {
      return;
    }

    const now = new Date();
    const readiness = getReadinessLevel(readinessToTrain);
    const activeGoal = smartGoals.find((goal) => goal.status === 'Active');
    const generatedTasks = buildWorkoutFloorTasks({
      readiness,
      checkInAt: now,
      activeGoal,
    });

    setIsCheckingIn(true);
    setFloorTasks((current) => {
      const keepCompleted = current.filter((task) => task.completed);
      return [...generatedTasks, ...keepCompleted];
    });

    const floorPlanPayload: StoredAthleteFloorPlan = {
      athleteName: 'Current Athlete',
      readiness,
      generatedAt: now.toISOString(),
      tasks: generatedTasks.map((task) => ({
        id: task.id,
        title: task.title,
        category: task.category,
        description: task.description,
        dueDate: task.dueDate,
        priority: task.priority,
        linkedGoalId: task.linkedGoalId,
      })),
    };

    setLastWorkoutBuildNote(`Workout auto-generated on check-in (${readiness} readiness).`);
    setActiveTab('athlete-floor');

    if (!backendAthleteId) {
      setIsCheckingIn(false);
      setBackendSyncMessage('Session generated locally. Backend athlete session not found, '
        + 'so nothing was stored and there is no session to check out of.');
      return;
    }

    try {
      const floorPlanResponse = await fetch(`${apiBase()}/api/pilot/floor-plans`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: backendAthleteId,
          plan: floorPlanPayload,
        }),
      });

      // Re-read the persisted plan so the floor shows what was actually stored
      // rather than only the locally generated tasks.
      if (floorPlanResponse.ok) {
        await loadFloorTasks();
      }
    } catch {
      // Floor plan persistence is secondary to session check-in.
    }

    const sessionId = `session_${Date.now()}`;
    const sessionDate = now.toISOString().slice(0, 10);
    const checkInNote = checkInNotes.trim() || autoCheckInNote(readiness);

    try {
      const sessionResponse = await fetch(`${apiBase()}/api/pilot/sessions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          athlete_id: backendAthleteId,
          date: sessionDate,
          rpe: readinessToTrain,
          notes: checkInNote,
          completed_flag: false,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        }),
      });

      if (sessionResponse.ok) {
        // Only a stored session becomes the active one. An athlete offered a
        // check-out for a session the app never wrote would lose everything
        // they typed into it at the moment they tried to hand it over.
        setActiveSessionRecord({
          sessionId,
          athleteId: backendAthleteId,
          date: sessionDate,
          rpe: readinessToTrain,
          checkInNote,
          createdAt: now.toISOString(),
        });
        setNotesSaveState(checkInNotes.trim() ? 'saved' : 'idle');
        setBackendSyncMessage('Session check-in persisted to pilot backend.');
      } else {
        const payload = (await sessionResponse.json().catch(() => ({ error: 'Session persistence failed' }))) as { error?: string };
        setBackendSyncMessage(`${payload.error || 'Session persistence failed'} `
          + 'Nothing was stored, so there is no session to check out of. Tell a coach you are here.');
      }
    } catch (error) {
      setBackendSyncMessage(`${error instanceof Error ? error.message : 'Session persistence failed'} `
        + 'Nothing was stored, so there is no session to check out of. Tell a coach you are here.');
    } finally {
      setIsCheckingIn(false);
    }

    void submitFastTrackObservations({
      athleteId: backendAthleteId,
      contextId: sessionId,
      observedAt: now.toISOString(),
      rpe: readinessToTrain,
      durationMinutes: sessionDurationMinutes,
      painFlag: injuryFlag,
      medicalReadAck,
    });
  };

  const handleCheckOut = async () => {
    // Only ever reachable with a stored session behind it, so there is no
    // longer a path where check-out is offered and the notes go nowhere.
    if (!activeSessionRecord || isCheckingOut) {
      return;
    }

    const record = activeSessionRecord;
    const now = new Date();
    const notes = checkInNotes.trim();

    setIsCheckingOut(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/sessions/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: record.sessionId,
          athlete_id: record.athleteId,
          date: record.date,
          rpe: record.rpe,
          // The check-in note is the fallback because the session record
          // requires a note and an empty box must not erase what check-in
          // already stored.
          notes: notes || record.checkInNote,
          completed_flag: true,
          created_at: record.createdAt,
          updated_at: now.toISOString(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || '');
      }

      setActiveSessionRecord(null);
      setCheckInNotes('');
      setNotesSaveState('idle');
      setBackendSyncMessage(notes
        ? 'Check-out saved. Your session notes are on the session record for your coach.'
        : 'Check-out saved to pilot backend.');
      // Re-read rather than trust the write: the recent list below and the
      // "are you still checked in" question are both answered from the server.
      await loadStoredSessions();
    } catch (error) {
      // Nothing is cleared on a failure. The session is still open and the
      // notes are still in the box, so the athlete can try again instead of
      // watching the screen empty itself.
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '.';
      setBackendSyncMessage(
        `Check-out did not save and you are still checked in${detail} `
        + 'Try Check Out again, and tell a coach anything they need to know.',
      );
    } finally {
      setIsCheckingOut(false);
    }
  };

  const handleSavePainReport = async () => {
    if (!selectedPainLocation) {
      return;
    }

    const now = new Date();
    const newPainLogEntry: PainLogEntry = {
      id: `pain_${Date.now()}`,
      location: selectedPainLocation,
      type: currentPainType,
      severity: currentPainSeverity,
      capturedAt: now.toISOString(),
    };

    setIsSavingPain(true);
    setPainSaveMessage('');

    try {
      setPainLog((current) => [newPainLogEntry, ...current]);
      setInjuryFlag(true);
      setSoreness((current) => Math.max(current, currentPainSeverity));

      if (!backendAthleteId) {
        // Nothing outside this browser tab holds a pain report, so a missing
        // session means it reached no one at all.
        setPainSaveMessage('Pain report was not saved and no coach was told. Sign in again and report it, '
          + 'and tell a coach in person.');
        return;
      }

      const response = await fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: backendAthleteId,
          contextId: newPainLogEntry.id,
          kind: 'pain_report',
          value: currentPainSeverity,
          unit: 'severity_1_10',
          dimensions: {
            location: selectedPainLocation,
            painType: currentPainType,
            injuryFlag: true,
          },
          observedAt: now.toISOString(),
          idempotencyKey: `${newPainLogEntry.id}-pain_report`,
        }),
      });

      if (!response.ok) {
        throw new Error('Pain report was not saved and no coach was told. Report it again, '
          + 'and tell a coach in person.');
      }

      const payload = (await response.json().catch(() => ({}))) as {
        painReport?: { coachNotified?: boolean };
      };

      setPainSaveMessage(payload.painReport?.coachNotified
        ? 'Pain report saved and raised for coach review.'
        : 'Pain report saved to your record. No coach review was raised for it -- '
          + 'tell a coach in person.');

      setShowPainModal(false);
    } catch (error) {
      setPainSaveMessage(error instanceof Error ? error.message : 'Pain report save failed.');
    } finally {
      setIsSavingPain(false);
    }
  };

  const handleSendCoachMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const message = coachMessageBody.trim();
    if (!message) {
      setCoachMessageStatus('Write a message before sending.');
      return;
    }

    setIsSendingCoachMessage(true);
    setCoachMessageStatus('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 'individual_support' is not one of the session types the canonical
        // chat validator accepts, and an unrecognized sessionType is rejected
        // outright rather than ignored -- so this form answered 400 ("Enter a
        // question for SHADOW.") on every submission and the success message
        // below was unreachable. Omitting it lets the request classify normally.
        body: JSON.stringify({
          message: `Coach message for ${selectedCoach}: ${message}`,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: 'Message delivery failed.' }))) as { error?: string };
        throw new Error(payload.error || 'Message delivery failed.');
      }

      setCoachMessageBody('');
      // The old copy promised a coach reply. This posts to SHADOW, not to a
      // person: it is recorded in the athlete's own conversation and answered
      // by SHADOW. No coach is notified and none ever sees it, so saying so
      // would be a promise the system does not keep.
      setCoachMessageStatus(
        `Saved to your SHADOW conversation for ${selectedCoach}. SHADOW will respond there -- open SHADOW Chat to read it. This does not notify ${selectedCoach} directly.`,
      );
    } catch (error) {
      setCoachMessageStatus(error instanceof Error ? error.message : 'Message delivery failed.');
    } finally {
      setIsSendingCoachMessage(false);
    }
  };

  const painLocations = ['Neck', 'Shoulders', 'Upper back', 'Lower back', 'Core', 'Hips', 'Quads', 'Hamstrings', 'Calves', 'Hands/Wrists'];
  const suggestedQuestions = [
    'What workout is scheduled for today?',
    'Why is my readiness score low?',
    'What SMART goal am I working on this week?',
    'Do I have any outstanding tasks?',
    'What does soreness score mean for my training?'
  ];

  return (
    /* Gym-floor kiosk surface: ink ground with the floor room's brick wall
       (PAGE_MAP), the same room pattern /schedule uses. Law 5 applies to
       everything inside — targets at var(--tap), working type at var(--t-md). */
    <div className="room--floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Athlete Development Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>My Training Dashboard</h1>
            <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Track readiness, execute daily work, develop your boxing skills, and achieve SMART goals.</p>
            <p className="t-label mt-[var(--s3)]">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
        </div>

        {/* Notices are posted paper on the leather wall. */}
        <AnnouncementBanner
          placement="athlete_workspace"
          kind="notice"
          heading="Gym Notices"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />
        <AnnouncementBanner
          placement="athlete_workspace"
          kind="motivation"
          heading="From the Gym"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        <div className={PANEL}>
          <p className="t-eyebrow">Daily Reminder</p>
          <p className="mt-[var(--s2)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Show up. Do the hard rounds. Own the details. Progress is earned through consistent grit and disciplined effort.</p>
          {backendSyncMessage ? <p className="mt-[var(--s3)] t-data" style={{ fontSize: 'var(--t-xs)' }} role="status">Backend Sync: {backendSyncMessage}</p> : null}
        </div>

        {/* ROLE SUMMARY PANEL */}
        {/* Class times and registrations live behind the unified scheduler;
            this workspace has no feed for the athlete's next class, so the
            tile must not name one. */}
        <AthleteSummaryPanel
          readiness={currentReadiness}
          tasksDue={tasksDue}
          goalsActive={goalsActive}
          upcomingSession="Unavailable - not yet tracked"
          unreadMessages={0}
        />

        {/* The training card. One stamp per session row from the ledger -- a
            record the athlete accumulates, so there is something to come back
            to. Cumulative, never a streak: see TrainingCard.tsx. */}
        <TrainingCard sessions={trainingSessions} />

        <details className={PANEL}>
          <summary className="t-label cursor-pointer">Critical Capability Surfaces</summary>
          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">AI/ML Video Analysis - Planned</p>
              <p className="t-muted mt-[var(--s2)]">Video feedback and comparison are front-end placeholders only.</p>
              <Link href="/athlete/video-analysis" className="btn btn--ghost mt-[var(--s3)] min-h-[var(--tap)]">
                Open Athlete Video Surface
              </Link>
            </article>
            <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">Closed-Loop Progression Intelligence - Planned</p>
              <p className="t-muted mt-[var(--s2)]">Recommendation and scoring logic are not automated in this pass.</p>
              <Link href="/athlete/progression-intelligence" className="btn btn--ghost mt-[var(--s3)] min-h-[var(--tap)]">
                Open Progression Intelligence
              </Link>
            </article>
          </div>
        </details>

        {/* TAB NAVIGATION — floor-sized targets (Law 5). */}
        <div className="mat-leather rounded-[var(--r-md)]">
          <div className="flex flex-wrap gap-[var(--s2)] p-[var(--s3)]">
            {[
              { id: 'my-dashboard', label: 'Dashboard' },
              { id: 'athlete-floor', label: 'Floor' },
              { id: 'smart-goals', label: 'Goals' },
              { id: 'tracks', label: 'Tracks' },
              { id: 'assessments', label: 'Assessments' },
              { id: 'bio-checkin', label: 'Bio Check-In' },
              { id: 'drill-library', label: 'Drills' },
              { id: 'rabbit-holes', label: 'Rabbit Holes' },
              { id: 'message-coach', label: 'Messages' },
              { id: 'schedule-session', label: 'Schedule' },
              { id: 'shadow', label: 'SHADOW Intel' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabID)}
                className={cx(
                  KIOSK_TAB_BASE,
                  activeTab === tab.id ? KIOSK_TAB_ACTIVE : KIOSK_TAB_INACTIVE,
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* MY DASHBOARD */}
          {activeTab === 'my-dashboard' && (
            <div className="space-y-6 animate-fadeIn">
              <section className={PANEL}>
                <h3 className="t-label">Quick Actions</h3>
                <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-4">
                  <Link href="/schedule" className="btn btn--kiosk">
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('bio-checkin')}
                    className="btn btn--kiosk"
                  >
                    Complete Check-In
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor')}
                    className="btn btn--kiosk btn--ghost"
                  >
                    Open Floor Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('smart-goals')}
                    className="btn btn--kiosk btn--ghost"
                  >
                    Update Goals
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="btn btn--kiosk btn--ghost"
                  >
                    Ask SHADOW
                  </button>
                </div>
              </section>

              <HelpPanel
                title="My Dashboard"
                description="Your daily command center. Track readiness, see assigned work, and monitor your progress toward goals."
                usage={[
                  'Check your readiness status first thing each morning',
                  'Complete biological check-in for accuracy',
                  'Review today\'s floor tasks',
                  'Monitor active SMART goals',
                  'Note any pain or injury concerns'
                ]}
                mistakes={[
                  'Ignoring LOW readiness scores before intense training',
                  'Not reporting pain to your coach',
                  'Skipping the check-in process',
                  'Assuming academic status is still current'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s5)]">
                {/* Readiness Card */}
                <div className={PANEL_RAISED}>
                  <h3 className="t-label mb-[var(--s4)]">Current Readiness</h3>
                  <div className="space-y-[var(--s4)]">
                    <div>
                      <label className="t-label block mb-[var(--s3)]" htmlFor="readiness-sleep-hours">Sleep (hours)</label>
                      <input id="readiness-sleep-hours" type="range" min="4" max="12" value={sleepHours} onChange={(e) => setSleepHours(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                      <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{sleepHours} hours</p>
                    </div>
                    <div>
                      <label className="t-label block mb-[var(--s3)]" htmlFor="readiness-energy-level">Energy Level (1-10)</label>
                      <input id="readiness-energy-level" type="range" min="1" max="10" value={energyLevel} onChange={(e) => setEnergyLevel(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                      <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{energyLevel}/10</p>
                    </div>
                    <div>
                      <label className="t-label block mb-[var(--s3)]" htmlFor="readiness-train">Readiness to Train (1-10)</label>
                      <input id="readiness-train" type="range" min="1" max="10" value={readinessToTrain} onChange={(e) => setReadinessToTrain(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                      <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{readinessToTrain}/10</p>
                    </div>
                    <div className="field">
                      <label className="t-label" htmlFor="session-duration">Session Duration (minutes)</label>
                      <input
                        id="session-duration"
                        type="number"
                        min={1}
                        max={480}
                        value={sessionDurationMinutes}
                        onChange={(e) => setSessionDurationMinutes(Math.max(1, Number.parseInt(e.target.value, 10) || 0))}
                        className="input input--kiosk"
                      />
                    </div>
                    <label className="flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)] text-[length:var(--t-md)]">
                      <input type="checkbox" checked={medicalReadAck} onChange={(e) => setMedicalReadAck(e.target.checked)} className="h-[21px] w-[21px] accent-[var(--brass-600)]" />
                      <span>I&apos;ve reviewed today&apos;s safety/medical notice</span>
                    </label>
                  </div>
                </div>

                {/* Pain/Injury Card */}
                <div className={PANEL_RAISED}>
                  <h3 className="t-label mb-[var(--s4)]">Pain/Soreness Report</h3>
                  <div className="space-y-[var(--s4)]">
                    <label className="flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)] text-[length:var(--t-md)]">
                      <input type="checkbox" checked={injuryFlag} onChange={(e) => setInjuryFlag(e.target.checked)} className="h-[21px] w-[21px] accent-[var(--brass-600)]" />
                      <span>Injury or Pain Flag</span>
                    </label>
                    <div>
                      <label className="t-label block mb-[var(--s3)]" htmlFor="readiness-soreness">Soreness Level (1-10)</label>
                      <input id="readiness-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                      <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{soreness}/10</p>
                    </div>
                    <div className="grid grid-cols-3 gap-[var(--s3)] pt-[var(--s2)]">
                      {painLocations.slice(0, 3).map(loc => (
                        <button
                          key={loc}
                          onClick={() => {
                            setSelectedPainLocation(loc);
                            setShowPainModal(true);
                          }}
                          className="btn btn--ghost min-h-[var(--tap)] px-[var(--s3)]"
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                    {painSaveMessage ? (
                      <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{painSaveMessage}</p>
                    ) : null}
                    {painLog[0] ? (
                      <p className="t-muted">
                        Last report: {painLog[0].location} ({painLog[0].type}, {painLog[0].severity}/10)
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Session Check-In/Out. The open session comes from the server
                  on every load, so a reload, a new tab, or a different device
                  all find the same session still open. */}
              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <h3 className="t-label">Session Log</h3>

                {athleteIdentityState === 'loading' ? (
                  <span className="working">Checking your sign-in...</span>
                ) : athleteIdentityState === 'unavailable' ? (
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    You are not signed in as an athlete right now, so a session cannot be started or saved here.
                    Sign in again, and tell a coach you are on the floor.
                  </p>
                ) : storedSessionLoad === 'loading' ? (
                  <span className="working">Checking whether you are still checked in...</span>
                ) : storedSessionLoad === 'unavailable' ? (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                      Your sessions could not be read, so nobody can tell right now whether you are already checked in.
                      That is a problem reaching the app, not a sign that you have no session open.
                    </p>
                    <button
                      type="button"
                      onClick={() => void loadStoredSessions()}
                      className="btn btn--kiosk btn--ghost"
                    >
                      Try Again
                    </button>
                  </div>
                ) : activeSessionRecord ? (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Session active since {checkInTime}</p>
                    <textarea
                      value={checkInNotes}
                      onChange={(e) => setCheckInNotes(e.target.value)}
                      placeholder="Session notes for your coach..."
                      aria-label="Session notes for your coach"
                      className="textarea input--kiosk h-[89px]"
                    />
                    <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]" role="status">
                      {notesSaveState === 'failed'
                        ? 'Your notes are not saved yet -- the app could not reach your session record. Keep this tab open and keep typing; it will try again.'
                        : notesSaveState === 'saving'
                          ? 'Saving your notes...'
                          : notesStored
                            ? 'Saved to your session record. Your notes survive closing this tab.'
                            : notesDraft
                              ? 'Not saved yet.'
                              : 'Anything you write here is saved to your session record as you go.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCheckOut()}
                      disabled={isCheckingOut}
                      className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                    >
                      {isCheckingOut ? 'Checking out...' : 'Check Out'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">You are not checked in right now.</p>
                    <button
                      type="button"
                      onClick={() => void handleCheckIn()}
                      disabled={isCheckingIn}
                      className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                    >
                      {isCheckingIn ? 'Checking in...' : 'Check In'}
                    </button>
                  </div>
                )}

                {/* Read back from the server, so "my notes were saved" is
                    something the athlete can see rather than be told. */}
                {storedSessionLoad === 'loaded' && recentSessions.length > 0 ? (
                  <div className="space-y-[var(--s3)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s4)]">
                    <p className="t-label">
                      Your Last Sessions
                    </p>
                    <ul className="space-y-[var(--s3)]">
                      {recentSessions.map((session) => (
                        <li key={session.sessionId} className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{session.date}</span>
                          {' - '}
                          {AUTO_CHECK_IN_NOTE_PATTERN.test(session.notes)
                            ? 'No notes were written for this session.'
                            : session.notes}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* ATHLETE FLOOR */}
          {activeTab === 'athlete-floor' && (
            <div className="space-y-6 animate-fadeIn">
              {lastWorkoutBuildNote && (
                <div className={PANEL}>
                  <p className="t-eyebrow">Workout Wiring</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">{lastWorkoutBuildNote}</p>
                </div>
              )}
              <HelpPanel
                title="Athlete Floor"
                description="Execute your daily assignments. Track training, homework, and goal-linked work with completion status."
                usage={[
                  'Review all tasks for the day',
                  'Mark tasks complete as you finish them',
                  'Link tasks to your active SMART goals',
                  'Upload evidence or notes for accountability'
                ]}
                mistakes={[
                  'Overlooking tasks marked as High priority',
                  'Not linking tasks to relevant goals',
                  'Missing deadlines by not checking due dates'
                ]}
              />

              {tasksLoading && (
                <div className={`${PANEL} text-center`}>
                  <span className="working">Loading your tasks...</span>
                </div>
              )}

              {tasksError && !tasksLoading && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Error loading tasks</p>
                    <p className="alert-msg">{tasksError}</p>
                    <div className="alert-action">
                      <button
                        onClick={() => {
                          setTasksError(null);
                          void loadFloorTasks();
                        }}
                        className="btn btn--ghost min-h-[var(--tap)]"
                        aria-label="Retry loading tasks"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {floorTasks.map(task => (
                  <div
                    key={task.id}
                    className={`mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)] ${
                      task.completed ? 'border-2 border-[color:var(--cleared)]' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-[var(--s4)] mb-[var(--s4)]">
                      <div>
                        <span className="t-label mb-[var(--s3)] inline-block rounded-[var(--r-sm)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)]">{task.category}</span>
                        <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{task.title}</h4>
                        {task.completed ? (
                          <span className="badge badge--cleared mt-[var(--s3)]"><i>✓</i>Done</span>
                        ) : null}
                      </div>
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => {
                          setFloorTasks(floorTasks.map(t => t.id === task.id ? {...t, completed: !t.completed} : t));
                        }}
                        className="h-[21px] w-[21px] cursor-pointer accent-[var(--brass-600)]"
                      />
                    </div>
                    <p className="mb-[var(--s4)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">{task.description}</p>
                    <div className="flex items-center justify-between text-[length:var(--t-sm)] text-[color:var(--bone-400)]">
                      <span>⏰ {task.dueDate}</span>
                      {/* Priority is chrome, not a safety state: bold bone with a
                          glyph for High, muted for Normal (Laws 2 + 3). */}
                      <span className={`font-semibold uppercase ${task.priority === 'High' ? 'text-[color:var(--bone-100)]' : 'text-[color:var(--bone-400)]'}`}>
                        {task.priority === 'High' ? <span aria-hidden="true">▲ </span> : null}{task.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {!tasksLoading && !tasksError && floorTasks.length === 0 && (
                <div className={`${PANEL} text-center`}>
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">No backend floor tasks are available for this athlete yet.</p>
                </div>
              )}
            </div>
          )}

          {/* SMART GOALS */}
          {activeTab === 'smart-goals' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex justify-between items-start">
                <HelpPanel
                  title="SMART Goals"
                  description="Create and track measurable goals using SMART framework. Monitor progress and connect workouts/tasks."
                  usage={[
                    'Create specific, measurable goals',
                    'Set realistic target dates',
                    'Track progress regularly',
                    'Link workouts and tasks to goals'
                  ]}
                  mistakes={[
                    'Vague goals without specific metrics',
                    'Unrealistic timeframes',
                    'Not reviewing progress weekly'
                  ]}
                />
              </div>

              <button
                onClick={() => setShowGoalForm(!showGoalForm)}
                className="btn min-h-[var(--tap)]"
              >
                + New SMART Goal
              </button>

              {showGoalForm && (
                <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                  <h3 className="t-label">Create SMART Goal</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                    <input
                      type="text"
                      value={newGoalTitle}
                      onChange={(e) => setNewGoalTitle(e.target.value)}
                      placeholder="Goal title"
                      aria-label="Goal title"
                      className="input input--kiosk"
                    />
                    <select
                      value={newGoalCategory}
                      onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)}
                      aria-label="Goal category"
                      className="select input--kiosk"
                    >
                      {(['Boxing', 'Fitness', 'Weight Loss', 'Weight Gain', 'Academics', 'Attendance', 'Recovery', 'Lifestyle', 'Leadership'] as SMARTCategory[]).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={newGoalTargetDate}
                      onChange={(e) => setNewGoalTargetDate(e.target.value)}
                      aria-label="Goal target date"
                      className="input input--kiosk"
                    />
                    <input
                      type="text"
                      value={newGoalSuccessMetric}
                      onChange={(e) => setNewGoalSuccessMetric(e.target.value)}
                      placeholder="Success metric"
                      aria-label="Success metric"
                      className="input input--kiosk"
                    />
                  </div>
                  <div className="flex gap-[var(--s3)]">
                    <button
                      onClick={handleCreateGoal}
                      disabled={isCreatingGoal}
                      className="btn btn--kiosk flex-1 disabled:opacity-50 disabled:grayscale"
                    >
                      {isCreatingGoal ? 'Creating...' : 'Create Goal'}
                    </button>
                    <button
                      onClick={() => setShowGoalForm(false)}
                      className="btn btn--kiosk btn--ghost flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {goalsLoading && (
                <div className={`${PANEL} text-center`}>
                  <span className="working">Loading your goals...</span>
                </div>
              )}

              {goalsError && !goalsLoading && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Error loading goals</p>
                    <p className="alert-msg">{goalsError}</p>
                    <div className="alert-action">
                      <button
                        onClick={() => {
                          setGoalsError(null);
                          void loadGoals();
                        }}
                        className="btn btn--ghost min-h-[var(--tap)]"
                        aria-label="Retry loading goals"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {!goalsLoading && smartGoals.length === 0 && !goalsError && (
                <div className={`${PANEL} text-center`}>
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">No goals yet. Create one to get started!</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {smartGoals.map(goal => {
                  const statusBadge = getGoalStatusBadge(goal.status);
                  return (
                    <div key={goal.id} className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                      <div className="flex justify-between items-start gap-[var(--s3)]">
                        <div>
                          <span className="t-label mb-[var(--s3)] inline-block rounded-[var(--r-sm)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)]">{goal.category}</span>
                          <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{goal.title}</h4>
                        </div>
                        <span className={statusBadge.className}><i>{statusBadge.glyph}</i>{goal.status}</span>
                      </div>
                      <div className="space-y-[var(--s2)]">
                        <div className="flex justify-between">
                          <span className="t-label">Progress</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-sm)' }}>{goal.progressPercent}%</span>
                        </div>
                        {/* Progress is chrome — a brass fill, never a status hue. */}
                        <div className="h-[8px] w-full rounded-[var(--r-pill)] bg-[rgba(0,0,0,.4)]">
                          <div className="h-full rounded-[var(--r-pill)] bg-[var(--brass-500)]" style={{width: `${goal.progressPercent}%`}}></div>
                        </div>
                      </div>
                      <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">Target: {goal.targetDate}</p>
                      <p className="t-muted">{goal.successMetric}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TRACKS - Placeholder */}
          {activeTab === 'tracks' && (
            <div className={`${PANEL} space-y-[var(--s4)] animate-fadeIn`}>
              <h3 className="t-label">Track Management</h3>
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">View current track assignment and request upgrades as you progress.</p>
              {/* Track assignment, membership, scholarship, and support status
                  have no backing column anywhere in the schema -- the track
                  itself would come from pilot.admin_track_assignments, which
                  does not exist in staging or prod. These were hardcoded to the
                  same "supported / active member" values for every athlete
                  regardless of their actual status, which is a billing- and
                  eligibility-adjacent misstatement, not a placeholder. Show
                  unavailable honestly until real fields exist. Mirrors the same
                  correction already applied in ParentHub.tsx. */}
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s2)]">
                <p className="text-[length:var(--t-sm)]"><strong>Current Track:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
                <p className="text-[length:var(--t-sm)] text-[color:var(--bone-400)]"><strong>Program Membership:</strong> <span>Unavailable - not yet tracked</span></p>
                <p className="text-[length:var(--t-sm)] text-[color:var(--bone-400)]"><strong>Participation Status:</strong> <span>Unavailable - not yet tracked</span></p>
                <p className="text-[length:var(--t-sm)] text-[color:var(--bone-400)]"><strong>Support Status:</strong> <span>Unavailable - not yet tracked</span></p>
                <p className="text-[length:var(--t-sm)] text-[color:var(--bone-400)]"><strong>Community Service Credits:</strong> <span>Unavailable - not yet tracked</span></p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS - Placeholder */}
          {activeTab === 'assessments' && (
            <div className={`${PANEL} space-y-[var(--s4)] animate-fadeIn`}>
              <h3 className="t-label">Assessments</h3>
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Complete personality tests, surveys, and skill assessments.</p>
              {/* Not-built-yet is a statement of fact, not a refusal or a safety
                  state — the label voice, never the safety gate's red (Law 2). */}
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no assessment engine behind this tab, so nothing can
                be started or scored from here yet.
              </p>
              <div className="space-y-[var(--s4)]">
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">MBTI Personality Test</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">Discover your personality type and learning style.</p>
                  <button
                    type="button"
                    disabled
                    className="btn btn--ghost mt-[var(--s4)] min-h-[var(--tap)] cursor-not-allowed opacity-50"
                  >
                    Start Assessment
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* BIO CHECK-IN */}
          {activeTab === 'bio-checkin' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Bio Check-In"
                description="Daily biological assessment covering sleep, vitals, recovery, mental state, and training readiness."
                usage={[
                  'Complete check-in every morning before training',
                  'Answer honestly for accurate coaching guidance',
                  'Expand for detailed metrics if you have time',
                  'Flag injuries immediately'
                ]}
                mistakes={[
                  'Minimizing pain reports',
                  'Skipping check-in to save time',
                  'Not expanding when RED flags present'
                ]}
              />

              <div className={`${PANEL_RAISED} space-y-[var(--s5)]`}>
                <h3 className="t-label">Daily Biological Check-In</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                  <div>
                    <label className="t-label block mb-[var(--s3)]" htmlFor="bio-sleep-hours">Sleep (4-12 hours)</label>
                    <input id="bio-sleep-hours" type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(Number.parseFloat(e.target.value))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{sleepHours} hours</p>
                  </div>
                  <div>
                    <label className="t-label block mb-[var(--s3)]" htmlFor="bio-hydration">Hydration (1-10)</label>
                    <input id="bio-hydration" type="range" min="1" max="10" value={hydrationStatus} onChange={(e) => setHydrationStatus(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{hydrationStatus}/10</p>
                  </div>
                  <div>
                    <label className="t-label block mb-[var(--s3)]" htmlFor="bio-motivation">Motivation (1-10)</label>
                    <input id="bio-motivation" type="range" min="1" max="10" value={motivation} onChange={(e) => setMotivation(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{motivation}/10</p>
                  </div>
                  <div>
                    <label className="t-label block mb-[var(--s3)]" htmlFor="bio-soreness">Soreness (0-10)</label>
                    <input id="bio-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{soreness}/10</p>
                  </div>
                </div>

                <button
                  onClick={() => setExpandedCheckIn(!expandedCheckIn)}
                  className="btn btn--kiosk btn--ghost"
                >
                  {expandedCheckIn ? '− Collapse' : '+ Expand to Maximum Check-In'}
                </button>

                {expandedCheckIn && (
                  <div className="space-y-[var(--s4)] pt-[var(--s4)] border-t-2 border-[color:var(--brass-700)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Additional detailed metrics available below...</p>
                    <div className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-400)]">
                      <p>• Resting Heart Rate, HRV, Blood Pressure</p>
                      <p>• Upper/Lower Body Soreness by location</p>
                      <p>• Mental clarity, focus, stress levels</p>
                      <p>• Nutrition and hydration compliance</p>
                      <p>• Training load and RPE recommendations</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* DRILL LIBRARY */}
          {activeTab === 'drill-library' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Drill Library"
                description="Physical lesson items and technical boxing drills organized by category with coaching cues."
                usage={[
                  'Search by drill name or category',
                  'Review coaching cues before executing',
                  'Mark drills complete as you master them',
                  'Work up through the difficulty levels'
                ]}
                mistakes={[
                  'Skipping coaching cues',
                  'Attempting drills above your level',
                  'Not practicing enough before marking complete'
                ]}
              />

              {drillsLoading && (
                <span className="working">Loading the drill library...</span>
              )}

              {!drillsLoading && drillsError && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Failed</p>
                    <p className="alert-msg">{drillsError}</p>
                    <p className="alert-msg mt-[var(--s2)]">This is a failure to load, not an empty library.</p>
                  </div>
                </div>
              )}

              {!drillsLoading && !drillsError && drills.length === 0 && (
                <div className={`${PANEL} text-center`}>
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    Your coaches have not added any drills yet.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {drills.map(drill => (
                  <div key={drill.id} className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                    <div className="flex justify-between items-start gap-[var(--s3)]">
                      <div>
                        <span className="t-label mb-[var(--s3)] inline-block rounded-[var(--r-sm)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)]">{drill.category}</span>
                        <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{drill.name}</h4>
                      </div>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{drill.difficulty}</span>
                    </div>
                    <p className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">{drill.focus}</p>
                    <div className="space-y-[var(--s2)]">
                      <p className="t-label">Coaching Cues:</p>
                      <div className="flex flex-wrap gap-[var(--s2)]">
                        {drill.cues.map((cue) => (
                          <span key={`${drill.id}-${cue}`} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">⚡ {cue}</span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setCompletedDrills({...completedDrills, [drill.id]: !completedDrills[drill.id]})}
                      className={`btn btn--kiosk ${completedDrills[drill.id] ? 'btn--ghost' : ''}`}
                    >
                      {completedDrills[drill.id] ? '✓ Drill Complete' : 'Mark Complete'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RABBIT HOLES / LEARNING */}
          {activeTab === 'rabbit-holes' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Rabbit Holes - Deep Learning"
                description="Deep-dive lessons your coaches wrote, each one a concept to understand and something to go and do with it."
                usage={[
                  'Read concept breakdowns carefully',
                  'Complete homework to internalize learning',
                  'Apply learnings to your training',
                  'Ask a coach for clarification'
                ]}
                mistakes={[
                  'Reading but not doing homework',
                  'Not applying concepts to actual training'
                ]}
              />

              {/* The honesty line the whole tab depends on. A rabbit hole is a
                  person's coaching, so it makes no evidence claim and carries
                  no SHADOW evidence tier. */}
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                Everything here is this gym&apos;s own coaching, written by a coach and published under their name. It
                is not research and it is not SHADOW evidence.
              </p>

              <AthleteRabbitHoleLibrary />
            </div>
          )}

          {/* MESSAGE COACH */}
          {activeTab === 'message-coach' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Message Coach"
                description="Write a question for your coach. It is recorded in your own SHADOW conversation and answered by SHADOW -- it is not delivered to the coach."
                usage={[
                  'Be clear and specific in questions',
                  'Messages are logged for accountability',
                  'Open SHADOW Chat to read the response',
                  'Speak to a coach in person for anything urgent'
                ]}
                mistakes={[
                  'Vague questions without context',
                  'Assuming a coach has read what you sent here'
                ]}
              />

              {/* No parent notification exists anywhere in the messaging path --
                  no recipient, address, or delivery step is stored or sent --
                  so this surface cannot claim parent CC is in force. A missing
                  safeguard is a caution, not a Layer 11 lock, so it takes the
                  warning rung with its glyph (Laws 2 + 3). */}
              <div className="alert alert--warning">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Planned | Not Yet Implemented</p>
                  <p className="alert-msg"><strong>SafeSport:</strong> messages sent here are logged, but automatic parent carbon copy is not built yet and no coach is notified. Tell a coach or trusted adult in person about anything urgent or unsafe.</p>
                </div>
              </div>

              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <h3 className="t-label">Send Message to Coach</h3>
                <form onSubmit={handleSendCoachMessage} className="space-y-[var(--s4)]">
                  <div className="field">
                    <label className="t-label" htmlFor="message-coach-select">Coach</label>
                    <select
                      id="message-coach-select"
                      value={selectedCoach}
                      onChange={(event) => setSelectedCoach(event.target.value)}
                      className="select input--kiosk"
                    >
                      <option>Coach Jason (Head Coach)</option>
                      <option>Coach Danielle (Fitness Director)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="message-coach-body">Your Message</label>
                    <textarea
                      id="message-coach-body"
                      value={coachMessageBody}
                      onChange={(event) => setCoachMessageBody(event.target.value)}
                      placeholder="Type your message..."
                      className="textarea input--kiosk h-24 resize-none"
                    />
                  </div>
                  {coachMessageStatus ? <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]" role="status">{coachMessageStatus}</p> : null}
                  <button
                    type="submit"
                    disabled={isSendingCoachMessage}
                    className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                  >
                    {isSendingCoachMessage ? 'Sending...' : 'Send Message'}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* SCHEDULE SESSION */}
          {activeTab === 'schedule-session' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex flex-wrap gap-[var(--s3)]">
                <Link href="/schedule" className="btn min-h-[var(--tap)]">
                  Open Unified Scheduler
                </Link>
              </div>
              <HelpPanel
                title="Schedule Session"
                description="Booking happens in the unified scheduler; this tab is a placeholder until it can read the gym's classes."
                usage={[
                  'Open the unified scheduler to see live classes',
                  'Check your academic status first',
                  'Readiness RED may limit contact work'
                ]}
                mistakes={[
                  'Booking while on academic hold',
                  'Booking contact work with RED readiness'
                ]}
              />

              {/* Statement of fact, not a refusal or safety state (Law 2). */}
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- this tab cannot read the gym&apos;s classes or register you
                for one. Open the unified scheduler above for live classes and real registration.
              </p>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 animate-fadeIn">
              <RoleSpecificShadow
                role="athlete"
                description="Ask SHADOW about your next workout, goals, or progress. Open the real SHADOW chat to get a response -- this workspace does not answer questions inline."
                chatContext="Athlete Workspace"
              />

              {/* This panel used to render a hardcoded three-message exchange --
                  including a fabricated athlete utterance -- above a text input
                  whose Send button had no handler at all, under a description
                  claiming "nothing here is a canned example". Nothing shown to an
                  athlete may be a static transcript that could be mistaken for
                  their own conversation, and a control that cannot send must not
                  look like one. Route to the real chat instead; see the same
                  correction in RoleSummaryPanels.tsx. */}
              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <div>
                  <p className="t-label">SHADOW Chat</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    In-workspace chat is not available here yet. Open the full SHADOW chat to ask a
                    question and get a real response.
                  </p>
                </div>

                <ShadowChatButton context="Athlete Workspace" />

                <div className="space-y-[var(--s3)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s4)]">
                  <p className="t-label">Things you can ask SHADOW:</p>
                  <ul className="list-disc space-y-[var(--s2)] pl-[var(--s5)]">
                    {suggestedQuestions.map((q) => (
                      <li key={q} className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">{q}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* A scope note, not a caution state — plain leather, no rung. */}
              <div className={PANEL}>
                <p className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-200)]"><strong>Note:</strong> SHADOW cannot answer questions about other athletes, board operations, financial data, or provide medical/legal advice.</p>
              </div>

              <div className={PANEL}>
                <h3 className="t-label">SHADOW Observation Projection</h3>
                {shadowObservationError ? (
                  <div className="alert alert--critical" role="alert">
                    <span className="alert-icon" aria-hidden="true">✕</span>
                    <div className="alert-body">
                      <p className="alert-title">Failed</p>
                      <p className="alert-msg">{shadowObservationError}</p>
                      <div className="alert-action">
                        <button
                          onClick={() => {
                            setShadowObservationError('');
                            void loadShadowObservations();
                          }}
                          className="btn btn--ghost min-h-[var(--tap)]"
                          aria-label="Retry loading SHADOW observations"
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {!shadowObservationError && shadowObservations.length === 0 ? (
                  <p className="t-muted mt-[var(--s3)]">No SHADOW observations available yet.</p>
                ) : null}
                <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                  {shadowObservations.slice(0, 6).map((item) => (
                    <div key={item.id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{item.label}</p>
                      <p>Source: {item.source}</p>
                      <p>State: {item.review_state}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* PAIN MODAL */}
        {showPainModal && selectedPainLocation && (
          <div className="fixed inset-0 bg-[var(--hide-950)]/80 backdrop-blur-sm flex items-center justify-center z-50 p-[var(--s4)]">
            <div className="mat-leather--raised w-full max-w-md space-y-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]">
              <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Soreness Details: {selectedPainLocation}</h3>
              <div className="space-y-[var(--s4)]">
                <div className="field">
                  <label className="t-label" htmlFor="pain-type-select">Pain Type</label>
                  <select id="pain-type-select" value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="select input--kiosk">
                    {(['Sharp', 'Dull', 'Burning', 'Tight', 'Pulling', 'Throbbing', 'Swollen', 'Numbness/Tingling', 'Instability', 'Other'] as PainType[]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="t-label block mb-[var(--s3)]" htmlFor="pain-severity-range">Severity (1-10)</label>
                  <input id="pain-severity-range" type="range" min="1" max="10" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(Number.parseInt(e.target.value, 10))} className="w-full min-h-[var(--tap)] cursor-pointer accent-[var(--brass-400)]" />
                  <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{currentPainSeverity}/10</p>
                </div>
              </div>
              <div className="flex gap-[var(--s3)]">
                <button
                  onClick={() => void handleSavePainReport()}
                  disabled={isSavingPain}
                  className="btn btn--kiosk flex-1 disabled:opacity-50 disabled:grayscale"
                >
                  {isSavingPain ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setShowPainModal(false)} className="btn btn--kiosk btn--ghost flex-1">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

