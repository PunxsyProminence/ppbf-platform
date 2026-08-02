'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import type { RabbitHoleLessonItem } from './RabbitHole';
import { ANCHOR_KEY_OPTIONS, anchorLabel } from './rabbitHoleAnchorLabels';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';
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

function getGoalStatusTone(status: GoalStatus): string {
  if (status === 'Active') return 'bg-blue-900 text-blue-200';
  if (status === 'Completed') return 'bg-green-900 text-green-200';
  return 'bg-yellow-900 text-yellow-200';
}

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
    return <p className="text-sm text-[color:var(--bone-400)]">Loading the gym&apos;s rabbit holes...</p>;
  }

  if (loadState === 'unavailable') {
    return (
      <p className="text-sm text-[color:var(--bone-400)]">
        The gym&apos;s rabbit holes could not be loaded right now. That is a problem reaching the app, not a sign
        that none have been written.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {isPartial ? (
        <p className="text-sm text-[color:var(--bone-400)]">
          Some topics could not be loaded, so what follows is not the full list.
        </p>
      ) : null}

      {topics.length === 0 && !isPartial ? (
        <p className="text-sm text-[color:var(--bone-400)]">
          Your coaches have not published a rabbit hole yet. When they do, it appears here.
        </p>
      ) : null}

      {topics.map((topic) => (
        <div key={`${topic.anchorType}:${topic.anchorKey}`} className="space-y-3">
          <h3 className="font-mono text-sm font-bold uppercase tracking-[0.1em] text-[color:var(--brass-300)]">
            {anchorLabel(topic.anchorType, topic.anchorKey)}
          </h3>
          {topic.lessons.map((lesson) => (
            <article key={lesson.rabbit_hole_id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
              {/* Provenance before content: who is talking, and on what
                  authority, before the claim itself. */}
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[color:var(--brass-300)]">
                Gym coaching · Written by {lesson.author_display_name}
              </p>
              <h4 className="font-semibold text-lg">{lesson.title}</h4>
              <p className="text-[color:var(--bone-400)]"><strong>Concept:</strong> {lesson.concept}</p>
              {lesson.homework ? (
                <div className="bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] p-4">
                  <p className="text-sm text-[color:var(--bone-200)]"><strong>Homework:</strong> {lesson.homework}</p>
                </div>
              ) : null}
              {lesson.citation ? (
                <p className="text-xs text-[color:var(--bone-400)]">
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

        const payload = (await response.json()) as {
          drills?: Array<{
            drill_id: string;
            name: string;
            category: string;
            focus: string;
            cues: string[];
            difficulty: string;
          }>;
        };
        if (controller.signal.aborted) return;

        setDrills((payload.drills ?? []).map((drill) => ({
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
    <div className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[color:var(--brass-300)]">Athlete Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">My Training Dashboard</h1>
            <p className="text-base text-[color:var(--bone-400)] mt-2">Track readiness, execute daily work, develop your boxing skills, and achieve SMART goals.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[color:var(--bone-300)] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
        </div>

        <AnnouncementBanner
          placement="athlete_workspace"
          kind="notice"
          heading="Gym Notices"
          className="border-2 border-[color:var(--brass-700)] bg-[var(--bone-200)] p-4"
        />
        <AnnouncementBanner
          placement="athlete_workspace"
          kind="motivation"
          heading="From the Gym"
          className="border-2 border-[color:var(--hide-500)] bg-[var(--bone-200)] p-4"
        />

        <div className="border border-[color:var(--hide-500)] bg-[var(--hide-950)] p-4">
          <p className="text-sm text-[color:var(--brass-300)] font-semibold">Daily Reminder</p>
          <p className="mt-1 text-sm text-[color:var(--bone-300)]">Show up. Do the hard rounds. Own the details. Progress is earned through consistent grit and disciplined effort.</p>
          {backendSyncMessage ? <p className="mt-2 text-xs text-[color:var(--brass-300)]">Backend Sync: {backendSyncMessage}</p> : null}
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

        <details className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
          <summary className="cursor-pointer text-xs font-mono uppercase tracking-[0.12em] text-[color:var(--brass-300)]">Critical Capability Surfaces</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <article className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
              <p className="text-sm font-semibold text-[color:var(--bone-200)]">AI/ML Video Analysis - Planned</p>
              <p className="mt-1 text-xs text-[color:var(--bone-300)]">Video feedback and comparison are front-end placeholders only.</p>
              <Link href="/athlete/video-analysis" className="mt-2 inline-flex border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--bone-200)]">
                Open Athlete Video Surface
              </Link>
            </article>
            <article className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
              <p className="text-sm font-semibold text-[color:var(--bone-200)]">Closed-Loop Progression Intelligence - Planned</p>
              <p className="mt-1 text-xs text-[color:var(--bone-300)]">Recommendation and scoring logic are not automated in this pass.</p>
              <Link href="/athlete/progression-intelligence" className="mt-2 inline-flex border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[color:var(--bone-200)]">
                Open Progression Intelligence
              </Link>
            </article>
          </div>
        </details>

        {/* TAB NAVIGATION */}
        <div className={ui.tabContainer}>
          <div className={ui.tabRow}>
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
          {/* MY DASHBOARD */}
          {activeTab === 'my-dashboard' && (
            <div className="space-y-6 animate-fadeIn">
              <section className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <Link
                    href="/schedule"
                    className="min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:bg-[var(--rust-900)] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('bio-checkin')}
                    className="min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-200)] transition hover:bg-[var(--rust-900)]"
                  >
                    Complete Check-In
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
                  >
                    Open Floor Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('smart-goals')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
                  >
                    Update Goals
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="min-h-[44px] border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Readiness Card */}
                <div className={ui.panel}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)] mb-4">Current Readiness</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-[color:var(--bone-400)] block mb-2" htmlFor="readiness-sleep-hours">Sleep (hours)</label>
                      <input id="readiness-sleep-hours" type="range" min="4" max="12" value={sleepHours} onChange={(e) => setSleepHours(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                      <p className="text-xs text-[color:var(--bone-400)] mt-1">{sleepHours} hours</p>
                    </div>
                    <div>
                      <label className="text-sm text-[color:var(--bone-400)] block mb-2" htmlFor="readiness-energy-level">Energy Level (1-10)</label>
                      <input id="readiness-energy-level" type="range" min="1" max="10" value={energyLevel} onChange={(e) => setEnergyLevel(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                      <p className="text-xs text-[color:var(--bone-400)] mt-1">{energyLevel}/10</p>
                    </div>
                    <div>
                      <label className="text-sm text-[color:var(--bone-400)] block mb-2" htmlFor="readiness-train">Readiness to Train (1-10)</label>
                      <input id="readiness-train" type="range" min="1" max="10" value={readinessToTrain} onChange={(e) => setReadinessToTrain(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                      <p className="text-xs text-[color:var(--bone-400)] mt-1">{readinessToTrain}/10</p>
                    </div>
                    <div>
                      <label className="text-sm text-[color:var(--bone-400)] block mb-2" htmlFor="session-duration">Session Duration (minutes)</label>
                      <input
                        id="session-duration"
                        type="number"
                        min={1}
                        max={480}
                        value={sessionDurationMinutes}
                        onChange={(e) => setSessionDurationMinutes(Math.max(1, Number.parseInt(e.target.value, 10) || 0))}
                        className="w-full h-9 px-3 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={medicalReadAck} onChange={(e) => setMedicalReadAck(e.target.checked)} className="w-4 h-4" />
                      <span>I&apos;ve reviewed today&apos;s safety/medical notice</span>
                    </label>
                  </div>
                </div>

                {/* Pain/Injury Card */}
                <div className={ui.panel}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)] mb-4">Pain/Soreness Report</h3>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={injuryFlag} onChange={(e) => setInjuryFlag(e.target.checked)} className="w-4 h-4" />
                      <span>Injury or Pain Flag</span>
                    </label>
                    <div>
                      <label className="text-sm text-[color:var(--bone-400)] block mb-2" htmlFor="readiness-soreness">Soreness Level (1-10)</label>
                      <input id="readiness-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                      <p className="text-xs text-[color:var(--bone-400)] mt-1">{soreness}/10</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-2">
                      {painLocations.slice(0, 3).map(loc => (
                        <button
                          key={loc}
                          onClick={() => {
                            setSelectedPainLocation(loc);
                            setShowPainModal(true);
                          }}
                          className="text-xs px-2 py-1 border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] text-[color:var(--bone-400)] hover:text-[color:var(--bone-200)] transition"
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                    {painSaveMessage ? (
                      <p className="text-xs text-[color:var(--brass-300)]">{painSaveMessage}</p>
                    ) : null}
                    {painLog[0] ? (
                      <p className="text-xs text-[color:var(--bone-400)]">
                        Last report: {painLog[0].location} ({painLog[0].type}, {painLog[0].severity}/10)
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Session Check-In/Out. The open session comes from the server
                  on every load, so a reload, a new tab, or a different device
                  all find the same session still open. */}
              <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Session Log</h3>

                {athleteIdentityState === 'loading' ? (
                  <p className="text-sm text-[color:var(--bone-400)]">Checking your sign-in...</p>
                ) : athleteIdentityState === 'unavailable' ? (
                  <p className="text-sm text-[color:var(--bone-400)]">
                    You are not signed in as an athlete right now, so a session cannot be started or saved here.
                    Sign in again, and tell a coach you are on the floor.
                  </p>
                ) : storedSessionLoad === 'loading' ? (
                  <p className="text-sm text-[color:var(--bone-400)]">Checking whether you are still checked in...</p>
                ) : storedSessionLoad === 'unavailable' ? (
                  <div className="space-y-3">
                    <p className="text-sm text-[color:var(--bone-400)]">
                      Your sessions could not be read, so nobody can tell right now whether you are already checked in.
                      That is a problem reaching the app, not a sign that you have no session open.
                    </p>
                    <button
                      type="button"
                      onClick={() => void loadStoredSessions()}
                      className="w-full border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] text-[color:var(--bone-200)] font-semibold py-2 px-4 transition hover:bg-[var(--rust-900)]"
                    >
                      Try Again
                    </button>
                  </div>
                ) : activeSessionRecord ? (
                  <div className="space-y-3">
                    <p className="text-sm text-[color:var(--bone-400)]">Session active since {checkInTime}</p>
                    <textarea
                      value={checkInNotes}
                      onChange={(e) => setCheckInNotes(e.target.value)}
                      placeholder="Session notes for your coach..."
                      aria-label="Session notes for your coach"
                      className="w-full h-20 px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    />
                    <p className="text-xs text-[color:var(--brass-300)]">
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
                      className="w-full bg-red-700 hover:bg-red-800 text-white font-semibold py-2 px-4 transition disabled:opacity-50"
                    >
                      {isCheckingOut ? 'Checking out...' : 'Check Out'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-[color:var(--bone-400)]">You are not checked in right now.</p>
                    <button
                      type="button"
                      onClick={() => void handleCheckIn()}
                      disabled={isCheckingIn}
                      className="w-full bg-[var(--brass-700)] hover:bg-[var(--rust-700)] text-white font-semibold py-2 px-4 transition disabled:opacity-50"
                    >
                      {isCheckingIn ? 'Checking in...' : 'Check In'}
                    </button>
                  </div>
                )}

                {/* Read back from the server, so "my notes were saved" is
                    something the athlete can see rather than be told. */}
                {storedSessionLoad === 'loaded' && recentSessions.length > 0 ? (
                  <div className="space-y-2 border-t border-[color:var(--hide-600)] pt-3">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[color:var(--brass-300)]">
                      Your Last Sessions
                    </p>
                    <ul className="space-y-2">
                      {recentSessions.map((session) => (
                        <li key={session.sessionId} className="text-xs text-[color:var(--bone-300)]">
                          <span className="font-mono text-[color:var(--bone-400)]">{session.date}</span>
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
                <div className="border border-[color:var(--hide-500)] bg-[var(--hide-950)] p-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[color:var(--brass-300)]">Workout Wiring</p>
                  <p className="mt-1 text-sm text-[color:var(--bone-300)]">{lastWorkoutBuildNote}</p>
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
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-8 text-center">
                  <p className="text-[color:var(--bone-400)]">Loading your tasks...</p>
                  <div className="mt-4 flex justify-center">
                    <div className="animate-spin h-6 w-6 border-2 border-[color:var(--brass-300)] border-t-transparent rounded-full"></div>
                  </div>
                </div>
              )}

              {tasksError && !tasksLoading && (
                <div className="border-2 border-red-600 bg-red-900/20 p-4 rounded">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-red-400 font-semibold">Error loading tasks</p>
                    <button
                      onClick={() => {
                        setTasksError(null);
                        void loadFloorTasks();
                      }}
                      className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition"
                      aria-label="Retry loading tasks"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-red-300 text-sm">{tasksError}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {floorTasks.map(task => (
                  <div
                    key={task.id}
                    className={`border-2 p-4 rounded ${
                      task.completed
                        ? 'bg-[var(--patina-900)] border-[color:var(--cleared)]'
                        : 'bg-[var(--hide-900)] border-[color:var(--brass-700)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--hide-600)] text-[color:var(--bone-400)] px-2 py-1 mb-2">{task.category}</span>
                        <h4 className="text-base font-semibold">{task.title}</h4>
                      </div>
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => {
                          setFloorTasks(floorTasks.map(t => t.id === task.id ? {...t, completed: !t.completed} : t));
                        }}
                        className="w-5 h-5 cursor-pointer"
                      />
                    </div>
                    <p className="text-sm text-[color:var(--bone-400)] mb-3">{task.description}</p>
                    <div className="flex items-center justify-between text-xs text-[color:var(--bone-400)]">
                      <span>⏰ {task.dueDate}</span>
                      <span className={`font-semibold ${task.priority === 'High' ? 'text-red-400' : 'text-yellow-600'}`}>
                        {task.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {!tasksLoading && !tasksError && floorTasks.length === 0 && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 text-center">
                  <p className="text-[color:var(--bone-400)]">No backend floor tasks are available for this athlete yet.</p>
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
                className="px-4 py-2 bg-[var(--brass-700)] hover:bg-[var(--rust-700)] text-white font-semibold transition"
              >
                + New SMART Goal
              </button>

              {showGoalForm && (
                <div className="border-2 border-[color:var(--brass-300)] bg-[var(--hide-900)] p-6 space-y-4">
                  <h3 className="font-mono font-bold text-[color:var(--brass-300)]">Create SMART Goal</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <input
                      type="text"
                      value={newGoalTitle}
                      onChange={(e) => setNewGoalTitle(e.target.value)}
                      placeholder="Goal title"
                      className="px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    />
                    <select
                      value={newGoalCategory}
                      onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)}
                      className="px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    >
                      {(['Boxing', 'Fitness', 'Weight Loss', 'Weight Gain', 'Academics', 'Attendance', 'Recovery', 'Lifestyle', 'Leadership'] as SMARTCategory[]).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={newGoalTargetDate}
                      onChange={(e) => setNewGoalTargetDate(e.target.value)}
                      className="px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    />
                    <input
                      type="text"
                      value={newGoalSuccessMetric}
                      onChange={(e) => setNewGoalSuccessMetric(e.target.value)}
                      placeholder="Success metric"
                      className="px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateGoal}
                      disabled={isCreatingGoal}
                      className="flex-1 bg-[var(--brass-700)] hover:bg-[var(--rust-700)] disabled:bg-[var(--hide-600)] text-white font-semibold py-2 transition"
                    >
                      {isCreatingGoal ? 'Creating...' : 'Create Goal'}
                    </button>
                    <button
                      onClick={() => setShowGoalForm(false)}
                      className="flex-1 bg-[var(--hide-600)] hover:bg-[var(--hide-500)] text-white font-semibold py-2 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {goalsLoading && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-8 text-center">
                  <p className="text-[color:var(--bone-400)]">Loading your goals...</p>
                  <div className="mt-4 flex justify-center">
                    <div className="animate-spin h-6 w-6 border-2 border-[color:var(--brass-300)] border-t-transparent rounded-full"></div>
                  </div>
                </div>
              )}

              {goalsError && !goalsLoading && (
                <div className="border-2 border-red-600 bg-red-900/20 p-4 rounded">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-red-400 font-semibold">Error loading goals</p>
                    <button
                      onClick={() => {
                        setGoalsError(null);
                        void loadGoals();
                      }}
                      className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition"
                      aria-label="Retry loading goals"
                    >
                      Retry
                    </button>
                  </div>
                  <p className="text-red-300 text-sm">{goalsError}</p>
                </div>
              )}

              {!goalsLoading && smartGoals.length === 0 && !goalsError && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-8 text-center">
                  <p className="text-[color:var(--bone-400)]">No goals yet. Create one to get started!</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {smartGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--hide-600)] text-[color:var(--bone-400)] px-2 py-1 mb-2">{goal.category}</span>
                        <h4 className="text-base font-semibold">{goal.title}</h4>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-1 rounded ${getGoalStatusTone(goal.status)}`}>
                        {goal.status}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-[color:var(--bone-400)]">Progress</span>
                        <span className="font-semibold">{goal.progressPercent}%</span>
                      </div>
                      <div className="w-full bg-[var(--hide-600)] h-2">
                        <div className="bg-[var(--brass-300)] h-2" style={{width: `${goal.progressPercent}%`}}></div>
                      </div>
                    </div>
                    <p className="text-sm text-[color:var(--bone-400)]">Target: {goal.targetDate}</p>
                    <p className="text-xs text-[color:var(--bone-400)]">{goal.successMetric}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TRACKS - Placeholder */}
          {activeTab === 'tracks' && (
            <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Track Management</h3>
              <p className="text-[color:var(--bone-400)]">View current track assignment and request upgrades as you progress.</p>
              {/* Track assignment, membership, scholarship, and support status
                  have no backing column anywhere in the schema -- the track
                  itself would come from pilot.admin_track_assignments, which
                  does not exist in staging or prod. These were hardcoded to the
                  same "supported / active member" values for every athlete
                  regardless of their actual status, which is a billing- and
                  eligibility-adjacent misstatement, not a placeholder. Show
                  unavailable honestly until real fields exist. Mirrors the same
                  correction already applied in ParentHub.tsx. */}
              <div className="bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] p-4 space-y-1">
                <p className="text-sm"><strong>Current Track:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm mt-2 text-[color:var(--bone-400)]"><strong>Program Membership:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[color:var(--bone-400)]"><strong>Participation Status:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[color:var(--bone-400)]"><strong>Support Status:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[color:var(--bone-400)]"><strong>Community Service Credits:</strong> <span className="text-[color:var(--bone-400)]">Unavailable - not yet tracked</span></p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS - Placeholder */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Assessments</h3>
              <p className="text-[color:var(--bone-400)]">Complete personality tests, surveys, and skill assessments.</p>
              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked)]">
                PLANNED | NOT YET IMPLEMENTED -- there is no assessment engine behind this tab, so nothing can
                be started or scored from here yet.
              </p>
              <div className="space-y-3">
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-4">
                  <p className="font-semibold">MBTI Personality Test</p>
                  <p className="text-sm text-[color:var(--bone-400)] mt-1">Discover your personality type and learning style.</p>
                  <button
                    type="button"
                    disabled
                    className="mt-3 px-3 py-1 bg-[var(--hide-600)] text-[color:var(--bone-400)] text-sm cursor-not-allowed"
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

              <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-6">
                <h3 className="font-mono font-bold text-[color:var(--brass-300)] uppercase">Daily Biological Check-In</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-[color:var(--bone-400)] block mb-2" htmlFor="bio-sleep-hours">Sleep (4-12 hours)</label>
                    <input id="bio-sleep-hours" type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(Number.parseFloat(e.target.value))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                    <p className="text-xs text-[color:var(--bone-400)] mt-1">{sleepHours} hours</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[color:var(--bone-400)] block mb-2" htmlFor="bio-hydration">Hydration (1-10)</label>
                    <input id="bio-hydration" type="range" min="1" max="10" value={hydrationStatus} onChange={(e) => setHydrationStatus(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                    <p className="text-xs text-[color:var(--bone-400)] mt-1">{hydrationStatus}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[color:var(--bone-400)] block mb-2" htmlFor="bio-motivation">Motivation (1-10)</label>
                    <input id="bio-motivation" type="range" min="1" max="10" value={motivation} onChange={(e) => setMotivation(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                    <p className="text-xs text-[color:var(--bone-400)] mt-1">{motivation}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[color:var(--bone-400)] block mb-2" htmlFor="bio-soreness">Soreness (0-10)</label>
                    <input id="bio-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                    <p className="text-xs text-[color:var(--bone-400)] mt-1">{soreness}/10</p>
                  </div>
                </div>

                <button
                  onClick={() => setExpandedCheckIn(!expandedCheckIn)}
                  className="w-full px-4 py-2 bg-[var(--hide-600)] hover:bg-[var(--hide-500)] text-[color:var(--bone-200)] font-semibold transition"
                >
                  {expandedCheckIn ? '− Collapse' : '+ Expand to Maximum Check-In'}
                </button>

                {expandedCheckIn && (
                  <div className="space-y-4 pt-4 border-t-2 border-[color:var(--brass-700)]">
                    <p className="text-sm text-[color:var(--bone-400)]">Additional detailed metrics available below...</p>
                    <div className="text-xs text-[color:var(--bone-400)]">
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
                <p className="text-sm text-[color:var(--bone-400)]">Loading the drill library...</p>
              )}

              {!drillsLoading && drillsError && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                  <p className="text-sm text-[color:var(--bone-200)]">{drillsError}</p>
                  <p className="mt-1 text-xs text-[color:var(--bone-400)]">
                    This is a failure to load, not an empty library.
                  </p>
                </div>
              )}

              {!drillsLoading && !drillsError && drills.length === 0 && (
                <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 text-center">
                  <p className="text-[color:var(--bone-400)]">
                    Your coaches have not added any drills yet.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {drills.map(drill => (
                  <div key={drill.id} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--hide-600)] text-[color:var(--bone-400)] px-2 py-1 mb-2">{drill.category}</span>
                        <h4 className="text-base font-semibold">{drill.name}</h4>
                      </div>
                      <span className="text-xs font-mono text-[color:var(--brass-300)]">{drill.difficulty}</span>
                    </div>
                    <p className="text-sm text-[color:var(--bone-400)]">{drill.focus}</p>
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-[color:var(--brass-300)]">Coaching Cues:</p>
                      <div className="flex flex-wrap gap-1">
                        {drill.cues.map((cue) => (
                          <span key={`${drill.id}-${cue}`} className="text-xs bg-[var(--hide-600)] text-[color:var(--bone-400)] px-2 py-1">⚡ {cue}</span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setCompletedDrills({...completedDrills, [drill.id]: !completedDrills[drill.id]})}
                      className={`w-full py-2 rounded font-semibold transition ${
                        completedDrills[drill.id]
                          ? 'bg-[var(--cleared)] text-white'
                          : 'bg-[var(--hide-600)] hover:bg-[var(--hide-500)] text-[color:var(--bone-400)]'
                      }`}
                    >
                      {completedDrills[drill.id] ? '✅ Drill Complete' : 'Mark Complete'}
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
              <p className="text-sm text-[color:var(--bone-400)]">
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
                  so this surface cannot claim parent CC is in force. */}
              <div className="border-2 border-red-600 bg-red-900/20 p-4 space-y-2">
                <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked)]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="text-sm text-red-200">🔒 <strong>SafeSport:</strong> messages sent here are logged, but automatic parent carbon copy is not built yet and no coach is notified. Tell a coach or trusted adult in person about anything urgent or unsafe.</p>
              </div>

              <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-6 space-y-4">
                <h3 className="font-mono font-bold text-[color:var(--brass-300)]">Send Message to Coach</h3>
                <form onSubmit={handleSendCoachMessage} className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold mb-2" htmlFor="message-coach-select">Coach</label>
                    <select
                      id="message-coach-select"
                      value={selectedCoach}
                      onChange={(event) => setSelectedCoach(event.target.value)}
                      className="w-full px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]"
                    >
                      <option>Coach Jason (Head Coach)</option>
                      <option>Coach Danielle (Fitness Director)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2" htmlFor="message-coach-body">Your Message</label>
                    <textarea
                      id="message-coach-body"
                      value={coachMessageBody}
                      onChange={(event) => setCoachMessageBody(event.target.value)}
                      placeholder="Type your message..."
                      className="w-full h-24 px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)] resize-none"
                    />
                  </div>
                  {coachMessageStatus ? <p className="text-xs text-[color:var(--brass-300)]">{coachMessageStatus}</p> : null}
                  <button
                    type="submit"
                    disabled={isSendingCoachMessage}
                    className="w-full bg-[var(--brass-700)] hover:bg-[var(--rust-700)] disabled:bg-[var(--hide-600)] text-white font-semibold py-2 transition"
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
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/schedule"
                  className="inline-flex min-h-[44px] items-center border-2 border-[color:var(--brass-700)] bg-[var(--rust-900)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[color:var(--bone-200)] transition hover:bg-[var(--rust-900)]"
                >
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--locked)]">
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
              <div className="border-2 border-[color:var(--brass-300)] bg-[var(--hide-950)] p-6 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--brass-300)]">SHADOW Chat</p>
                  <p className="mt-1 text-sm text-[color:var(--bone-400)]">
                    In-workspace chat is not available here yet. Open the full SHADOW chat to ask a
                    question and get a real response.
                  </p>
                </div>

                <ShadowChatButton context="Athlete Workspace" />

                <div className="space-y-2 border-t-2 border-[color:var(--brass-300)] pt-4">
                  <p className="text-sm font-semibold text-[color:var(--brass-300)]">Things you can ask SHADOW:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {suggestedQuestions.map((q) => (
                      <li key={q} className="text-sm text-[color:var(--bone-400)]">{q}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="bg-yellow-900/20 border-2 border-yellow-700 p-4 text-sm">
                <p className="text-yellow-200"><strong>Note:</strong> SHADOW cannot answer questions about other athletes, board operations, financial data, or provide medical/legal advice.</p>
              </div>

              <div className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
                <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--brass-300)]">SHADOW Observation Projection</h3>
                {shadowObservationError ? (
                  <div className="mt-2 border border-red-600 bg-red-900/20 p-2 rounded flex items-center justify-between">
                    <p className="text-xs text-red-400 flex-1">{shadowObservationError}</p>
                    <button
                      onClick={() => {
                        setShadowObservationError('');
                        void loadShadowObservations();
                      }}
                      className="ml-2 px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition flex-shrink-0"
                      aria-label="Retry loading SHADOW observations"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {!shadowObservationError && shadowObservations.length === 0 ? (
                  <p className="mt-2 text-xs text-[color:var(--bone-400)]">No SHADOW observations available yet.</p>
                ) : null}
                <div className="mt-2 space-y-2">
                  {shadowObservations.slice(0, 6).map((item) => (
                    <div key={item.id} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-2 text-xs text-[color:var(--bone-300)]">
                      <p className="font-semibold text-[color:var(--bone-200)]">{item.label}</p>
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
          <div className="fixed inset-0 bg-[var(--hide-950)]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] p-6 max-w-md w-full space-y-4">
              <h3 className="text-lg font-bold">Soreness Details: {selectedPainLocation}</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-type-select">Pain Type</label>
                  <select id="pain-type-select" value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="w-full px-3 py-2 bg-[var(--hide-950)] border-2 border-[color:var(--brass-700)] text-[color:var(--bone-200)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] focus-visible:border-[color:var(--brass-400)]">
                    {(['Sharp', 'Dull', 'Burning', 'Tight', 'Pulling', 'Throbbing', 'Swollen', 'Numbness/Tingling', 'Instability', 'Other'] as PainType[]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-severity-range">Severity (1-10)</label>
                  <input id="pain-severity-range" type="range" min="1" max="10" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--hide-600)] accent-[var(--brass-300)]" />
                  <p className="text-xs text-[color:var(--bone-400)] mt-1">{currentPainSeverity}/10</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleSavePainReport()}
                  disabled={isSavingPain}
                  className="flex-1 bg-[var(--brass-700)] hover:bg-[var(--rust-700)] disabled:bg-[var(--hide-600)] text-white font-semibold py-2 transition"
                >
                  {isSavingPain ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setShowPainModal(false)} className="flex-1 bg-[var(--hide-600)] hover:bg-[var(--hide-500)] text-white font-semibold py-2 transition">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

