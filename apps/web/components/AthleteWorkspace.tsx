'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';

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
  minRank: string;
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

function getReadinessLevel(readinessToTrain: number): ReadinessLevel {
  if (readinessToTrain >= 7) return 'GREEN';
  if (readinessToTrain >= 5) return 'YELLOW';
  return 'RED';
}

function getGoalStatusTone(status: GoalStatus): string {
  if (status === 'Active') return ui.statusInfo;
  if (status === 'Completed') return ui.statusReady;
  if (status === 'Paused') return ui.statusWarning;
  return ui.statusInactive;
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

  await Promise.allSettled(observations.map((observation) => fetch('/api/pilot/shadow/formulas/observations', {
    method: 'POST',
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

export default function AthleteWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('my-dashboard');
  const [backendAthleteId, setBackendAthleteId] = useState<string | null>(null);
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
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<SMARTCategory>('Boxing');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalSuccessMetric, setNewGoalSuccessMetric] = useState('');

  // Floor Tasks State - Real API data
  const [floorTasks, setFloorTasks] = useState<FloorTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  // Drills State
  const [drills] = useState<Drill[]>([
    { id: 'dl_1', name: 'Stance Width Stability', category: 'Footwork', focus: 'Maintains wide base during rapid forward and backward movement.', cues: ['Feet shoulder-width', 'Back heel lifted', 'Weight centered'], minRank: 'TIRO' },
    { id: 'dl_2', name: 'Straight Jab Retraction Snap', category: 'Striking', focus: 'Quick fist return to protect chin and guard stance.', cues: ['Elbow tucked', 'Shoulder covers chin', 'Snap fist on contact'], minRank: 'TIRO' },
    { id: 'dl_3', name: 'Slip and Lateral Pivot Step', category: 'Defense', focus: 'Move outside straight punch while generating lateral counter angles.', cues: ['Slip with head off-center', 'Step 45-degrees', 'Maintain guard width'], minRank: 'DISCIPULUS' }
  ]);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});

  // Shadow State
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowObservationError, setShadowObservationError] = useState('');
  const [selectedCoach, setSelectedCoach] = useState('Coach Jason (Head Coach)');
  const [coachMessageBody, setCoachMessageBody] = useState('');
  const [isSendingCoachMessage, setIsSendingCoachMessage] = useState(false);
  const [coachMessageStatus, setCoachMessageStatus] = useState('');

  // Session Log State
  const [sessionLog, setSessionLog] = useState<Array<{id: string; checkInTime: string; checkOutTime?: string; notes: string}>>([]);
  const [sessionActive, setSessionActive] = useState(false);
  const [checkInTime, setCheckInTime] = useState<string | null>(null);
  const [checkInNotes, setCheckInNotes] = useState('');
  const [lastWorkoutBuildNote, setLastWorkoutBuildNote] = useState<string | null>(null);

  const currentReadiness: ReadinessLevel = getReadinessLevel(readinessToTrain);
  const tasksDue = floorTasks.filter(t => !t.completed).length;
  const goalsActive = smartGoals.filter(g => g.status === 'Active').length;

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/auth/session', { method: 'POST' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (response.ok && payload.authenticated && payload.athlete_id) {
          setBackendAthleteId(payload.athlete_id);
        }
      } catch {
        // Keep workspace usable in local-only mode when backend session is unavailable.
      }
    })();
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
        `/api/pilot/goals/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
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
      const response = await fetch('/api/pilot/floor-plans?limit=1', {
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
      const response = await fetch('/api/pilot/shadow/observation-projection', {
        method: 'POST',
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

  const handleCreateGoal = async () => {
    if (!newGoalTitle || !newGoalTargetDate || !newGoalSuccessMetric) return;
    if (!backendAthleteId) {
      setBackendSyncMessage('Goal saved locally. Backend athlete session not found.');
      return;
    }

    const now = new Date().toISOString();
    const goalId = `goal_${Date.now()}`;

    const response = await fetch('/api/pilot/goals', {
      method: 'POST',
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
  };

  const handleCheckIn = async () => {
    const now = new Date();
    const readiness = getReadinessLevel(readinessToTrain);
    const activeGoal = smartGoals.find((goal) => goal.status === 'Active');
    const generatedTasks = buildWorkoutFloorTasks({
      readiness,
      checkInAt: now,
      activeGoal,
    });

    setSessionActive(true);
    setCheckInTime(now.toLocaleString());
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
      setBackendSyncMessage('Session generated locally. Backend athlete session not found.');
      return;
    }

    try {
      const floorPlanResponse = await fetch('/api/pilot/floor-plans', {
        method: 'POST',
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
    const sessionResponse = await fetch('/api/pilot/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        athlete_id: backendAthleteId,
        date: now.toISOString().slice(0, 10),
        rpe: readinessToTrain,
        notes: checkInNotes || `Auto check-in readiness ${readiness}`,
        completed_flag: false,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      }),
    });

    if (sessionResponse.ok) {
      setBackendSyncMessage('Session check-in persisted to pilot backend.');
    } else {
      const payload = (await sessionResponse.json().catch(() => ({ error: 'Session persistence failed' }))) as { error?: string };
      setBackendSyncMessage(payload.error || 'Session persistence failed');
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

  const handleCheckOut = () => {
    if (checkInTime) {
      const newSession = {
        id: `sess_${Date.now()}`,
        checkInTime: checkInTime,
        checkOutTime: new Date().toLocaleString(),
        notes: checkInNotes
      };
      setSessionLog([newSession, ...sessionLog]);
      setSessionActive(false);
      setCheckInTime(null);
      setCheckInNotes('');
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

      if (backendAthleteId) {
        const response = await fetch('/api/pilot/shadow/formulas/observations', {
          method: 'POST',
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
          throw new Error('Pain report was saved locally but telemetry persistence failed.');
        }

        setPainSaveMessage('Pain report saved and shared with coaching telemetry.');
      } else {
        setPainSaveMessage('Pain report saved locally. Sign in again to sync with coaching telemetry.');
      }

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
      const response = await fetch('/api/pilot/athlete/chat', {
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
    <div className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[var(--black)] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[var(--red-primary)]">Athlete Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">My Training Dashboard</h1>
            <p className="text-base text-[var(--gray-dark)] mt-2">Track readiness, execute daily work, develop your boxing skills, and achieve SMART goals.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
        </div>

        <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <p className="text-sm text-[var(--red-primary)] font-semibold">Daily Reminder</p>
          <p className="mt-1 text-sm text-[var(--gray-dark)]">Show up. Do the hard rounds. Own the details. Progress is earned through consistent grit and disciplined effort.</p>
          {backendSyncMessage ? <p className="mt-2 text-xs text-[var(--red-primary)]">Backend Sync: {backendSyncMessage}</p> : null}
        </div>

        {/* ROLE SUMMARY PANEL */}
        <AthleteSummaryPanel
          readiness={currentReadiness}
          tasksDue={tasksDue}
          goalsActive={goalsActive}
          upcomingSession="Youth Class 4:00 PM"
          unreadMessages={0}
        />

        <details className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <summary className="cursor-pointer text-xs font-mono uppercase tracking-[0.12em] text-[var(--red-primary)]">Critical Capability Surfaces</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <article className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
              <p className="text-sm font-semibold text-[var(--black)]">AI/ML Video Analysis - Planned</p>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">Video feedback and comparison are front-end placeholders only.</p>
              <Link href="/athlete/video-analysis" className="mt-2 inline-flex border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--black)]">
                Open Athlete Video Surface
              </Link>
            </article>
            <article className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3">
              <p className="text-sm font-semibold text-[var(--black)]">Closed-Loop Progression Intelligence - Planned</p>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">Recommendation and scoring logic are not automated in this pass.</p>
              <Link href="/athlete/progression-intelligence" className="mt-2 inline-flex border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--black)]">
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
              { id: 'rabbit-holes', label: 'Learning' },
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
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <Link
                    href="/schedule"
                    className="min-h-[44px] border border-[var(--black)] bg-[var(--canvas-tan-dark)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('bio-checkin')}
                    className="min-h-[44px] border border-[var(--black)] bg-[var(--canvas-tan-dark)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
                  >
                    Complete Check-In
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('athlete-floor')}
                    className="min-h-[44px] border border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
                  >
                    Open Floor Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('smart-goals')}
                    className="min-h-[44px] border border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
                  >
                    Update Goals
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="min-h-[44px] border border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
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
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)] mb-4">Current Readiness</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-[var(--gray-dark)] block mb-2" htmlFor="readiness-sleep-hours">Sleep (hours)</label>
                      <input id="readiness-sleep-hours" type="range" min="4" max="12" value={sleepHours} onChange={(e) => setSleepHours(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                      <p className="text-xs text-[var(--gray-dark)] mt-1">{sleepHours} hours</p>
                    </div>
                    <div>
                      <label className="text-sm text-[var(--gray-dark)] block mb-2" htmlFor="readiness-energy-level">Energy Level (1-10)</label>
                      <input id="readiness-energy-level" type="range" min="1" max="10" value={energyLevel} onChange={(e) => setEnergyLevel(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                      <p className="text-xs text-[var(--gray-dark)] mt-1">{energyLevel}/10</p>
                    </div>
                    <div>
                      <label className="text-sm text-[var(--gray-dark)] block mb-2" htmlFor="readiness-train">Readiness to Train (1-10)</label>
                      <input id="readiness-train" type="range" min="1" max="10" value={readinessToTrain} onChange={(e) => setReadinessToTrain(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                      <p className="text-xs text-[var(--gray-dark)] mt-1">{readinessToTrain}/10</p>
                    </div>
                    <div>
                      <label className="text-sm text-[var(--gray-dark)] block mb-2" htmlFor="session-duration">Session Duration (minutes)</label>
                      <input
                        id="session-duration"
                        type="number"
                        min={1}
                        max={480}
                        value={sessionDurationMinutes}
                        onChange={(e) => setSessionDurationMinutes(Math.max(1, Number.parseInt(e.target.value, 10) || 0))}
                        className="tactical-input"
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
                  <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)] mb-4">Pain/Soreness Report</h3>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={injuryFlag} onChange={(e) => setInjuryFlag(e.target.checked)} className="w-4 h-4" />
                      <span>Injury or Pain Flag</span>
                    </label>
                    <div>
                      <label className="text-sm text-[var(--gray-dark)] block mb-2" htmlFor="readiness-soreness">Soreness Level (1-10)</label>
                      <input id="readiness-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                      <p className="text-xs text-[var(--gray-dark)] mt-1">{soreness}/10</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-2">
                      {painLocations.slice(0, 3).map(loc => (
                        <button
                          key={loc}
                          onClick={() => {
                            setSelectedPainLocation(loc);
                            setShowPainModal(true);
                          }}
                          className="text-xs px-2 py-1 border-2 border-[var(--black)] bg-[var(--canvas-tan)] text-[var(--gray-dark)] hover:text-[var(--black)] transition"
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                    {painSaveMessage ? (
                      <p className="text-xs text-[var(--red-primary)]">{painSaveMessage}</p>
                    ) : null}
                    {painLog[0] ? (
                      <p className="text-xs text-[var(--gray-dark)]">
                        Last report: {painLog[0].location} ({painLog[0].type}, {painLog[0].severity}/10)
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Session Check-In/Out */}
              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6">
                <h3 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)] mb-4">Session Log</h3>
                {!sessionActive ? (
                  <button onClick={handleCheckIn} className="tactical-btn-critical w-full font-semibold py-2 px-4 transition">
                    ✅ Check In
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-[var(--gray-dark)]">Session active since {checkInTime}</p>
                    <textarea
                      value={checkInNotes}
                      onChange={(e) => setCheckInNotes(e.target.value)}
                      placeholder="Session notes..."
                      className="tactical-input h-20"
                    />
                    <button onClick={handleCheckOut} className="tactical-btn-critical w-full font-semibold py-2 px-4 transition">
                      ⏹️ Check Out
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ATHLETE FLOOR */}
          {activeTab === 'athlete-floor' && (
            <div className="space-y-6 animate-fadeIn">
              {lastWorkoutBuildNote && (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Workout Wiring</p>
                  <p className="mt-1 text-sm text-[var(--gray-dark)]">{lastWorkoutBuildNote}</p>
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
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-8 text-center">
                  <p className="text-[var(--gray-dark)]">Loading your tasks...</p>
                  <div className="mt-4 flex justify-center">
                    <div className="animate-spin h-6 w-6 border-2 border-[var(--red-primary)] border-t-transparent rounded-full"></div>
                  </div>
                </div>
              )}

              {tasksError && !tasksLoading && (
                <div className={ui.errorContainer}>
                  <div className="flex items-center justify-between mb-2">
                    <p className={ui.errorText}>Error loading tasks</p>
                    <button
                      onClick={() => {
                        setTasksError(null);
                        void loadFloorTasks();
                      }}
                      className={ui.errorButton}
                      aria-label="Retry loading tasks"
                    >
                      Retry
                    </button>
                  </div>
                  <p className={cx(ui.errorText, 'text-sm')}>{tasksError}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {floorTasks.map(task => (
                  <div
                    key={task.id}
                    className={`border-2 p-4 ${
                      task.completed
                        ? 'bg-[var(--status-ready)]/10 border-[var(--status-ready)]'
                        : 'bg-[var(--canvas-tan-light)] border-[var(--black)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--gray-medium)] text-[var(--white-off)] px-2 py-1 mb-2">{task.category}</span>
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
                    <p className="text-sm text-[var(--gray-dark)] mb-3">{task.description}</p>
                    <div className="flex items-center justify-between text-xs text-[var(--gray-dark)]">
                      <span>⏰ {task.dueDate}</span>
                      <span className={`font-semibold ${task.priority === 'High' ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}`}>
                        {task.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {!tasksLoading && !tasksError && floorTasks.length === 0 && (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 text-center">
                  <p className="text-[var(--gray-dark)]">No backend floor tasks are available for this athlete yet.</p>
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
                className="tactical-btn-critical px-4 py-2 font-semibold transition"
              >
                + New SMART Goal
              </button>

              {showGoalForm && (
                <div className="border-2 border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                  <h3 className="font-mono font-bold text-[var(--red-primary)]">Create SMART Goal</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <input
                      type="text"
                      value={newGoalTitle}
                      onChange={(e) => setNewGoalTitle(e.target.value)}
                      placeholder="Goal title"
                      className="tactical-input"
                    />
                    <select
                      value={newGoalCategory}
                      onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)}
                      className="tactical-input"
                    >
                      {(['Boxing', 'Fitness', 'Weight Loss', 'Weight Gain', 'Academics', 'Attendance', 'Recovery', 'Lifestyle', 'Leadership'] as SMARTCategory[]).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={newGoalTargetDate}
                      onChange={(e) => setNewGoalTargetDate(e.target.value)}
                      className="tactical-input"
                    />
                    <input
                      type="text"
                      value={newGoalSuccessMetric}
                      onChange={(e) => setNewGoalSuccessMetric(e.target.value)}
                      placeholder="Success metric"
                      className="tactical-input"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateGoal}
                      className="tactical-btn-critical flex-1 font-semibold py-2 transition"
                    >
                      Create Goal
                    </button>
                    <button
                      onClick={() => setShowGoalForm(false)}
                      className="tactical-btn-ghost border-2 border-[var(--black)] flex-1 font-semibold py-2 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {goalsLoading && (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-8 text-center">
                  <p className="text-[var(--gray-dark)]">Loading your goals...</p>
                  <div className="mt-4 flex justify-center">
                    <div className="animate-spin h-6 w-6 border-2 border-[var(--red-primary)] border-t-transparent rounded-full"></div>
                  </div>
                </div>
              )}

              {goalsError && !goalsLoading && (
                <div className={ui.errorContainer}>
                  <div className="flex items-center justify-between mb-2">
                    <p className={ui.errorText}>Error loading goals</p>
                    <button
                      onClick={() => {
                        setGoalsError(null);
                        void loadGoals();
                      }}
                      className={ui.errorButton}
                      aria-label="Retry loading goals"
                    >
                      Retry
                    </button>
                  </div>
                  <p className={cx(ui.errorText, 'text-sm')}>{goalsError}</p>
                </div>
              )}

              {!goalsLoading && smartGoals.length === 0 && !goalsError && (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-8 text-center">
                  <p className="text-[var(--gray-dark)]">No goals yet. Create one to get started!</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {smartGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--gray-medium)] text-[var(--white-off)] px-2 py-1 mb-2">{goal.category}</span>
                        <h4 className="text-base font-semibold">{goal.title}</h4>
                      </div>
                      <span className={getGoalStatusTone(goal.status)}>
                        {goal.status}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--gray-dark)]">Progress</span>
                        <span className="font-semibold">{goal.progressPercent}%</span>
                      </div>
                      <div className="w-full bg-[var(--gray-medium)] h-2">
                        <div className="bg-[var(--red-primary)] h-2" style={{width: `${goal.progressPercent}%`}}></div>
                      </div>
                    </div>
                    <p className="text-sm text-[var(--gray-dark)]">Target: {goal.targetDate}</p>
                    <p className="text-xs text-[var(--gray-dark)]">{goal.successMetric}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TRACKS - Placeholder */}
          {activeTab === 'tracks' && (
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Track Management</h3>
              <p className="text-[var(--gray-dark)]">View current track assignment and request upgrades as you progress.</p>
              {/* Track assignment, membership, scholarship, and support status
                  have no backing column anywhere in the schema -- the track
                  itself would come from pilot.admin_track_assignments, which
                  does not exist in staging or prod. These were hardcoded to the
                  same "supported / active member" values for every athlete
                  regardless of their actual status, which is a billing- and
                  eligibility-adjacent misstatement, not a placeholder. Show
                  unavailable honestly until real fields exist. Mirrors the same
                  correction already applied in ParentHub.tsx. */}
              <div className="bg-[var(--canvas-tan)] border-2 border-[var(--black)] p-4 space-y-1">
                <p className="text-sm"><strong>Current Track:</strong> <span className="text-[var(--gray-dark)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm mt-2 text-[var(--gray-dark)]"><strong>Program Membership:</strong> <span className="text-[var(--gray-dark)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[var(--gray-dark)]"><strong>Participation Status:</strong> <span className="text-[var(--gray-dark)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[var(--gray-dark)]"><strong>Support Status:</strong> <span className="text-[var(--gray-dark)]">Unavailable - not yet tracked</span></p>
                <p className="text-sm text-[var(--gray-dark)]"><strong>Community Service Credits:</strong> <span className="text-[var(--gray-dark)]">Unavailable - not yet tracked</span></p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS - Placeholder */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Assessments</h3>
              <p className="text-[var(--gray-dark)]">Complete personality tests, surveys, and skill assessments.</p>
              <div className="space-y-3">
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="font-semibold">MBTI Personality Test</p>
                  <p className="text-sm text-[var(--gray-dark)] mt-1">Discover your personality type and learning style.</p>
                  <button className="tactical-btn-critical mt-3 px-3 py-1 text-sm transition">Start Assessment</button>
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

              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-6">
                <h3 className="font-mono font-bold text-[var(--red-primary)] uppercase">Daily Biological Check-In</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-[var(--gray-dark)] block mb-2" htmlFor="bio-sleep-hours">Sleep (4-12 hours)</label>
                    <input id="bio-sleep-hours" type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(Number.parseFloat(e.target.value))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                    <p className="text-xs text-[var(--gray-dark)] mt-1">{sleepHours} hours</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[var(--gray-dark)] block mb-2" htmlFor="bio-hydration">Hydration (1-10)</label>
                    <input id="bio-hydration" type="range" min="1" max="10" value={hydrationStatus} onChange={(e) => setHydrationStatus(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                    <p className="text-xs text-[var(--gray-dark)] mt-1">{hydrationStatus}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[var(--gray-dark)] block mb-2" htmlFor="bio-motivation">Motivation (1-10)</label>
                    <input id="bio-motivation" type="range" min="1" max="10" value={motivation} onChange={(e) => setMotivation(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                    <p className="text-xs text-[var(--gray-dark)] mt-1">{motivation}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[var(--gray-dark)] block mb-2" htmlFor="bio-soreness">Soreness (0-10)</label>
                    <input id="bio-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                    <p className="text-xs text-[var(--gray-dark)] mt-1">{soreness}/10</p>
                  </div>
                </div>

                <button
                  onClick={() => setExpandedCheckIn(!expandedCheckIn)}
                  className="tactical-btn-ghost border-2 border-[var(--black)] w-full px-4 py-2 font-semibold transition"
                >
                  {expandedCheckIn ? '− Collapse' : '+ Expand to Maximum Check-In'}
                </button>

                {expandedCheckIn && (
                  <div className="space-y-4 pt-4 border-t-2 border-[var(--black)]">
                    <p className="text-sm text-[var(--gray-dark)]">Additional detailed metrics available below...</p>
                    <div className="text-xs text-[var(--gray-dark)]">
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
                  'Progress through complexity levels'
                ]}
                mistakes={[
                  'Skipping coaching cues',
                  'Attempting drills above your rank',
                  'Not practicing enough before marking complete'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {drills.map(drill => (
                  <div key={drill.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[var(--gray-medium)] text-[var(--white-off)] px-2 py-1 mb-2">{drill.category}</span>
                        <h4 className="text-base font-semibold">{drill.name}</h4>
                      </div>
                      <span className="text-xs font-mono text-[var(--red-primary)]">{drill.minRank}</span>
                    </div>
                    <p className="text-sm text-[var(--gray-dark)]">{drill.focus}</p>
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-[var(--red-primary)]">Coaching Cues:</p>
                      <div className="flex flex-wrap gap-1">
                        {drill.cues.map((cue) => (
                          <span key={`${drill.id}-${cue}`} className="text-xs bg-[var(--gray-medium)] text-[var(--white-off)] px-2 py-1">⚡ {cue}</span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setCompletedDrills({...completedDrills, [drill.id]: !completedDrills[drill.id]})}
                      className={`w-full py-2 font-semibold transition border-2 border-[var(--black)] ${
                        completedDrills[drill.id]
                          ? 'bg-[var(--status-ready)] text-white'
                          : 'bg-[var(--canvas-tan-dark)] hover:bg-[var(--olive-dark)] hover:text-white text-[var(--black)]'
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
                description="Advanced research into biomechanics, neurology, and boxing theory with homework assignments."
                usage={[
                  'Read concept breakdowns carefully',
                  'Complete homework to internalize learning',
                  'Apply learnings to your training',
                  'Ask Coach Jason for clarification'
                ]}
                mistakes={[
                  'Reading but not doing homework',
                  'Not applying concepts to actual training'
                ]}
              />

              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4 animate-fadeIn">
                <h3 className="font-semibold text-lg">Biomechanics of Kinetic Force Transfer</h3>
                <p className="text-[var(--gray-dark)]"><strong>Concept:</strong> Power does not generate in the shoulders. Force begins with rear-foot ground rotation through hip rotation into target through clean wrist extension.</p>
                <div className="bg-[var(--canvas-tan)] border-2 border-[var(--black)] p-4">
                  <p className="text-sm text-[var(--black)]"><strong>Homework:</strong> Complete 30 slow shadowboxing crosses, holding full extension for 3 seconds to confirm your rear foot heel is rotated fully outward.</p>
                </div>
              </div>
            </div>
          )}

          {/* MESSAGE COACH */}
          {activeTab === 'message-coach' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Message Coach"
                description="SafeSport-compliant messaging portal with automatic parent carbon copy for minor athletes."
                usage={[
                  'Be clear and specific in questions',
                  'Parent emails are automatically CC\'d for safety',
                  'Messages are logged for accountability',
                  'Coach responds within 24 hours'
                ]}
                mistakes={[
                  'Vague questions without context',
                  'Expecting immediate responses'
                ]}
              />

              <div className="tactical-alert-critical">
                <p className="text-sm">🔒 <strong>SafeSport Policy:</strong> All messages are logged and parent CC is active for all minor athletes.</p>
              </div>

              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4">
                <h3 className="font-mono font-bold text-[var(--red-primary)]">Send Message to Coach</h3>
                <form onSubmit={handleSendCoachMessage} className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold mb-2" htmlFor="message-coach-select">Coach</label>
                    <select
                      id="message-coach-select"
                      value={selectedCoach}
                      onChange={(event) => setSelectedCoach(event.target.value)}
                      className="tactical-input"
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
                      className="tactical-input h-24 resize-none"
                    />
                  </div>
                  {coachMessageStatus ? <p className="text-xs text-[var(--red-primary)]">{coachMessageStatus}</p> : null}
                  <button
                    type="submit"
                    disabled={isSendingCoachMessage}
                    className="tactical-btn-critical w-full border-2 border-[var(--black)] py-2"
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
                  className="tactical-btn-critical inline-flex min-h-[40px] items-center border-2 border-[var(--black)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em]"
                >
                  Open Unified Scheduler
                </Link>
              </div>
              <HelpPanel
                title="Schedule Session"
                description="Book training sessions and coaching appointments from our weekly curriculum schedule."
                usage={[
                  'Check your academic status first',
                  'Book early for preferred time slots',
                  'Readiness RED may limit contact work',
                  '24-hour cancellation notice required'
                ]}
                mistakes={[
                  'Booking while on academic hold',
                  'Booking contact work with RED readiness'
                ]}
              />

              <div className="space-y-4">
                {['Mon-Thu 4:00 PM Youth Class', 'Mon-Thu 5:00 PM Intermediate', 'MWF 5:45 PM Adult Fitness'].map((session) => (
                  <div key={session} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 flex justify-between items-center">
                    <p className="font-semibold">{session}</p>
                    <button className="tactical-btn-critical px-4 py-2 border-2 border-[var(--black)] font-semibold">
                      Book
                    </button>
                  </div>
                ))}
              </div>
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
              <div className="border-2 border-[var(--red-primary)] bg-[var(--canvas-tan)] p-6 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-[var(--red-primary)]">SHADOW Chat</p>
                  <p className="mt-1 text-sm text-[var(--gray-dark)]">
                    In-workspace chat is not available here yet. Open the full SHADOW chat to ask a
                    question and get a real response.
                  </p>
                </div>

                <ShadowChatButton context="Athlete Workspace" />

                <div className="space-y-2 border-t-2 border-[var(--red-primary)] pt-4">
                  <p className="text-sm font-semibold text-[var(--red-primary)]">Things you can ask SHADOW:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {suggestedQuestions.map((q) => (
                      <li key={q} className="text-sm text-[var(--gray-dark)]">{q}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className={ui.errorContainer}>
                <p className={ui.errorText}><strong>Note:</strong> SHADOW cannot answer questions about other athletes, board operations, financial data, or provide medical/legal advice.</p>
              </div>

              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h3 className="font-mono text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">SHADOW Observation Projection</h3>
                {shadowObservationError ? (
                  <div className={cx(ui.errorContainer, 'mt-2 flex items-center justify-between')}>
                    <p className={cx(ui.errorText, 'text-xs flex-1')}>{shadowObservationError}</p>
                    <button
                      onClick={() => {
                        setShadowObservationError('');
                        void loadShadowObservations();
                      }}
                      className={cx(ui.errorButton, 'ml-2 flex-shrink-0')}
                      aria-label="Retry loading SHADOW observations"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {!shadowObservationError && shadowObservations.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--gray-dark)]">No SHADOW observations available yet.</p>
                ) : null}
                <div className="mt-2 space-y-2">
                  {shadowObservations.slice(0, 6).map((item) => (
                    <div key={item.id} className="border border-[var(--black)] bg-[var(--canvas-tan)] p-2 text-xs text-[var(--gray-dark)]">
                      <p className="font-semibold text-[var(--black)]">{item.label}</p>
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
          <div className="fixed inset-0 bg-[var(--black)]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--canvas-tan)] border-2 border-[var(--black)] p-6 max-w-md w-full space-y-4 shadow-[var(--shadow-lg)]">
              <h3 className="text-lg font-bold">Soreness Details: {selectedPainLocation}</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-type-select">Pain Type</label>
                  <select id="pain-type-select" value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="tactical-input">
                    {(['Sharp', 'Dull', 'Burning', 'Tight', 'Pulling', 'Throbbing', 'Swollen', 'Numbness/Tingling', 'Instability', 'Other'] as PainType[]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-severity-range">Severity (1-10)</label>
                  <input id="pain-severity-range" type="range" min="1" max="10" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[var(--gray-medium)] accent-[var(--red-primary)]" />
                  <p className="text-xs text-[var(--gray-dark)] mt-1">{currentPainSeverity}/10</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleSavePainReport()}
                  disabled={isSavingPain}
                  className="tactical-btn-critical flex-1 border-2 border-[var(--black)] py-2"
                >
                  {isSavingPain ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setShowPainModal(false)} className="tactical-btn-ghost flex-1 border-2 border-[var(--black)] py-2">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

