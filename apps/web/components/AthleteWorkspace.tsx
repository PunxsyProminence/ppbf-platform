'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
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

const ATHLETE_FLOOR_PLAN_STORAGE_KEY = 'ppbf-athlete-floor-plans';

interface Drill {
  id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  minRank: string;
}

interface ShadowMessage {
  id: string;
  sender: 'athlete' | 'shadow';
  text: string;
  timestamp: string;
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

function createInitialShadowMessages(): ShadowMessage[] {
  const now = Date.now();
  return [
    {
      id: 'sm_1',
      sender: 'shadow',
      text: 'Hey! I\'m SHADOW, your AI athletic coach. How\'s your training going today?',
      timestamp: new Date(now - 600000).toISOString(),
    },
    {
      id: 'sm_2',
      sender: 'athlete',
      text: 'Pretty good, but my footwork felt off during drills',
      timestamp: new Date(now - 540000).toISOString(),
    },
    {
      id: 'sm_3',
      sender: 'shadow',
      text: 'Let\'s dig into that. What specific footwork drill were you working on?',
      timestamp: new Date(now - 480000).toISOString(),
    },
  ];
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
  const [expandedCheckIn, setExpandedCheckIn] = useState(false);
  const [selectedPainLocation, setSelectedPainLocation] = useState<string | null>(null);
  const [showPainModal, setShowPainModal] = useState(false);
  const [currentPainType, setCurrentPainType] = useState<PainType>('Dull');
  const [currentPainSeverity, setCurrentPainSeverity] = useState(3);

  // Goals State
  const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([
    { id: 'sg_1', title: 'Master 5-Punch Combination', category: 'Boxing', targetDate: '2026-08-12', successMetric: '85% accuracy rate', progressPercent: 45, status: 'Active', specific: 'Execute jab-cross-hook-uppercut-cross with 85% accuracy', measurable: 'Hit target pad 85 times out of 100 attempts', achievable: 'Aligns with current skill level', relevant: 'Foundation for sparring progression', timeBound: '30 days' },
    { id: 'sg_2', title: 'Build 10-Pound Muscle Mass', category: 'Fitness', targetDate: '2026-10-12', successMetric: '10 lbs gain with <15% body fat increase', progressPercent: 25, status: 'Active', specific: 'Gain 10 pounds of lean muscle through resistance training', measurable: 'Weekly bodyweight and body composition tracking', achievable: 'Realistic with 4x/week training and proper nutrition', relevant: 'Improves punch power and resilience', timeBound: '90 days' },
    { id: 'sg_3', title: 'Maintain 4.0 GPA', category: 'Academics', targetDate: '2026-12-15', successMetric: '4.0 GPA on report card', progressPercent: 90, status: 'Active', specific: 'Keep all grades at A (90+) level', measurable: 'Report card GPA = 4.0', achievable: 'Balanced with training schedule', relevant: 'Required for scholarship eligibility', timeBound: 'This semester (18 weeks)' }
  ]);
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<SMARTCategory>('Boxing');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalSuccessMetric, setNewGoalSuccessMetric] = useState('');

  // Floor Tasks State
  const [floorTasks, setFloorTasks] = useState<FloorTask[]>([
    { id: 'ft_1', title: 'Morning Readiness Check-In', category: 'Check-In', description: 'Complete biological readiness survey', dueDate: '7:00 AM', completed: false, priority: 'High' },
    { id: 'ft_2', title: 'Warmup Drills - Footwork', category: 'Training', description: 'Execute prescribed footwork progression', dueDate: '4:00 PM', completed: false, priority: 'High' },
    { id: 'ft_3', title: 'Conditioning Block', category: 'Training', description: 'Complete 30-minute conditioning session', dueDate: '5:00 PM', completed: false, priority: 'Normal' },
    { id: 'ft_4', title: 'Goal Review Journal', category: 'Homework', description: 'Reflect on weekly SMART goal progress', dueDate: '8:00 PM', completed: true, priority: 'Normal' }
  ]);

  // Drills State
  const [drills] = useState<Drill[]>([
    { id: 'dl_1', name: 'Stance Width Stability', category: 'Footwork', focus: 'Maintains wide base during rapid forward and backward movement.', cues: ['Feet shoulder-width', 'Back heel lifted', 'Weight centered'], minRank: 'TIRO' },
    { id: 'dl_2', name: 'Straight Jab Retraction Snap', category: 'Striking', focus: 'Quick fist return to protect chin and guard stance.', cues: ['Elbow tucked', 'Shoulder covers chin', 'Snap fist on contact'], minRank: 'TIRO' },
    { id: 'dl_3', name: 'Slip and Lateral Pivot Step', category: 'Defense', focus: 'Move outside straight punch while generating lateral counter angles.', cues: ['Slip with head off-center', 'Step 45-degrees', 'Maintain guard width'], minRank: 'DISCIPULUS' }
  ]);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});

  // Shadow State
  const [shadowMessages] = useState<ShadowMessage[]>(createInitialShadowMessages);
  const [shadowInput, setShadowInput] = useState('');

  // Session Log State
  const [sessionLog, setSessionLog] = useState<Array<{id: string; checkInTime: string; checkOutTime?: string; notes: string}>>([
    { id: 'sess_1', checkInTime: '2026-07-11 4:00 PM', checkOutTime: '2026-07-11 5:30 PM', notes: 'Great session! Felt strong' },
    { id: 'sess_2', checkInTime: '2026-07-10 4:00 PM', checkOutTime: '2026-07-10 5:15 PM', notes: 'Slight shoulder soreness, recovered well' }
  ]);
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

    if (typeof window !== 'undefined') {
      const payload: StoredAthleteFloorPlan = {
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

      const existing = window.localStorage.getItem(ATHLETE_FLOOR_PLAN_STORAGE_KEY);
      const parsed: StoredAthleteFloorPlan[] = existing ? (JSON.parse(existing) as StoredAthleteFloorPlan[]) : [];
      const updated = [payload, ...parsed].slice(0, 25);
      window.localStorage.setItem(ATHLETE_FLOOR_PLAN_STORAGE_KEY, JSON.stringify(updated));
    }

    setLastWorkoutBuildNote(`Workout auto-generated on check-in (${readiness} readiness).`);
    setActiveTab('athlete-floor');

    if (!backendAthleteId) {
      setBackendSyncMessage('Session generated locally. Backend athlete session not found.');
      return;
    }

    const sessionResponse = await fetch('/api/pilot/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: `session_${Date.now()}`,
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

  const painLocations = ['Neck', 'Shoulders', 'Upper back', 'Lower back', 'Core', 'Hips', 'Quads', 'Hamstrings', 'Calves', 'Hands/Wrists'];
  const suggestedQuestions = [
    'What workout is scheduled for today?',
    'Why is my readiness score low?',
    'What SMART goal am I working on this week?',
    'Do I have any outstanding tasks?',
    'What does soreness score mean for my training?'
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[#8b4444] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">Athlete Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">My Training Dashboard</h1>
            <p className="text-base text-[#b0a095] mt-2">Track readiness, execute daily work, develop your boxing skills, and achieve SMART goals.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[#cfbfae] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
        </div>

        <div className="border border-[#694838] bg-[#14100d] p-4">
          <p className="text-sm text-[#d4a574] font-semibold">Daily Reminder</p>
          <p className="mt-1 text-sm text-[#cfbfae]">Show up. Do the hard rounds. Own the details. Progress is earned through consistent grit and disciplined effort.</p>
          {backendSyncMessage ? <p className="mt-2 text-xs text-[#d4a574]">Backend Sync: {backendSyncMessage}</p> : null}
        </div>

        {/* ROLE SUMMARY PANEL */}
        <AthleteSummaryPanel
          readiness={currentReadiness}
          tasksDue={tasksDue}
          goalsActive={goalsActive}
          upcomingSession="Youth Class 4:00 PM"
          unreadMessages={0}
        />

        <section className="border-2 border-[#8b4444] bg-[#111111] p-4">
          <p className="text-xs font-mono uppercase tracking-[0.12em] text-[#d4a574]">Critical Capability Surfaces</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <article className="border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-sm font-semibold text-[#e8d7c6]">AI/ML Video Analysis - Planned</p>
              <p className="mt-1 text-xs text-[#cfbfae]">Video feedback and comparison are front-end placeholders only.</p>
              <Link href="/athlete/video-analysis" className="mt-2 inline-flex border border-[#8b4444] bg-[#2a1414] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[#e8d7c6]">
                Open Athlete Video Surface
              </Link>
            </article>
            <article className="border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-sm font-semibold text-[#e8d7c6]">Closed-Loop Progression Intelligence - Planned</p>
              <p className="mt-1 text-xs text-[#cfbfae]">Recommendation and scoring logic are not automated in this pass.</p>
              <Link href="/athlete/progression-intelligence" className="mt-2 inline-flex border border-[#8b4444] bg-[#2a1414] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[#e8d7c6]">
                Open Progression Intelligence
              </Link>
            </article>
          </div>
        </section>

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
                onAskShadow={() => setShadowInput('What should I focus on today?')}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Readiness Card */}
                <div className={ui.panel}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574] mb-4">Current Readiness</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-[#b0a095] block mb-2" htmlFor="readiness-sleep-hours">Sleep (hours)</label>
                      <input id="readiness-sleep-hours" type="range" min="4" max="12" value={sleepHours} onChange={(e) => setSleepHours(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                      <p className="text-xs text-[#8a8a8a] mt-1">{sleepHours} hours</p>
                    </div>
                    <div>
                      <label className="text-sm text-[#b0a095] block mb-2" htmlFor="readiness-energy-level">Energy Level (1-10)</label>
                      <input id="readiness-energy-level" type="range" min="1" max="10" value={energyLevel} onChange={(e) => setEnergyLevel(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                      <p className="text-xs text-[#8a8a8a] mt-1">{energyLevel}/10</p>
                    </div>
                    <div>
                      <label className="text-sm text-[#b0a095] block mb-2" htmlFor="readiness-train">Readiness to Train (1-10)</label>
                      <input id="readiness-train" type="range" min="1" max="10" value={readinessToTrain} onChange={(e) => setReadinessToTrain(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                      <p className="text-xs text-[#8a8a8a] mt-1">{readinessToTrain}/10</p>
                    </div>
                  </div>
                </div>

                {/* Pain/Injury Card */}
                <div className={ui.panel}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574] mb-4">Pain/Soreness Report</h3>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={injuryFlag} onChange={(e) => setInjuryFlag(e.target.checked)} className="w-4 h-4" />
                      <span>Injury or Pain Flag</span>
                    </label>
                    <div>
                      <label className="text-sm text-[#b0a095] block mb-2" htmlFor="readiness-soreness">Soreness Level (1-10)</label>
                      <input id="readiness-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                      <p className="text-xs text-[#8a8a8a] mt-1">{soreness}/10</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-2">
                      {painLocations.slice(0, 3).map(loc => (
                        <button
                          key={loc}
                          onClick={() => {
                            setSelectedPainLocation(loc);
                            setShowPainModal(true);
                          }}
                          className="text-xs px-2 py-1 border-2 border-[#8b4444] bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6] transition"
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Session Check-In/Out */}
              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574] mb-4">Session Log</h3>
                {!sessionActive ? (
                  <button onClick={handleCheckIn} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold py-2 px-4 transition">
                    ✅ Check In
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-[#b0a095]">Session active since {checkInTime}</p>
                    <textarea
                      value={checkInNotes}
                      onChange={(e) => setCheckInNotes(e.target.value)}
                      placeholder="Session notes..."
                      className="w-full h-20 px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none"
                    />
                    <button onClick={handleCheckOut} className="w-full bg-red-700 hover:bg-red-800 text-white font-semibold py-2 px-4 transition">
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
                <div className="border border-[#694838] bg-[#14100d] p-3">
                  <p className="text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">Workout Wiring</p>
                  <p className="mt-1 text-sm text-[#cfbfae]">{lastWorkoutBuildNote}</p>
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
                onAskShadow={() => setShadowInput('What tasks do I have today?')}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {floorTasks.map(task => (
                  <div
                    key={task.id}
                    className={`border-2 p-4 rounded ${
                      task.completed
                        ? 'bg-[#0a2a0a] border-[#4a9a4a]'
                        : 'bg-[#1a1a1a] border-[#8b4444]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[#4a4a4a] text-[#8a8a8a] px-2 py-1 mb-2">{task.category}</span>
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
                    <p className="text-sm text-[#b0a095] mb-3">{task.description}</p>
                    <div className="flex items-center justify-between text-xs text-[#8a8a8a]">
                      <span>⏰ {task.dueDate}</span>
                      <span className={`font-semibold ${task.priority === 'High' ? 'text-red-400' : 'text-yellow-600'}`}>
                        {task.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
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
                  onAskShadow={() => setShadowInput('How do I set SMART goals?')}
                />
              </div>

              <button
                onClick={() => setShowGoalForm(!showGoalForm)}
                className="px-4 py-2 bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold transition"
              >
                + New SMART Goal
              </button>

              {showGoalForm && (
                <div className="border-2 border-[#d4a574] bg-[#1a1a1a] p-6 space-y-4">
                  <h3 className="font-mono font-bold text-[#d4a574]">Create SMART Goal</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <input
                      type="text"
                      value={newGoalTitle}
                      onChange={(e) => setNewGoalTitle(e.target.value)}
                      placeholder="Goal title"
                      className="px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none"
                    />
                    <select
                      value={newGoalCategory}
                      onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)}
                      className="px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none"
                    >
                      {(['Boxing', 'Fitness', 'Weight Loss', 'Weight Gain', 'Academics', 'Attendance', 'Recovery', 'Lifestyle', 'Leadership'] as SMARTCategory[]).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={newGoalTargetDate}
                      onChange={(e) => setNewGoalTargetDate(e.target.value)}
                      className="px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newGoalSuccessMetric}
                      onChange={(e) => setNewGoalSuccessMetric(e.target.value)}
                      placeholder="Success metric"
                      className="px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateGoal}
                      className="flex-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold py-2 transition"
                    >
                      Create Goal
                    </button>
                    <button
                      onClick={() => setShowGoalForm(false)}
                      className="flex-1 bg-[#4a4a4a] hover:bg-[#5a5a5a] text-white font-semibold py-2 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {smartGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[#4a4a4a] text-[#8a8a8a] px-2 py-1 mb-2">{goal.category}</span>
                        <h4 className="text-base font-semibold">{goal.title}</h4>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-1 rounded ${getGoalStatusTone(goal.status)}`}>
                        {goal.status}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-[#b0a095]">Progress</span>
                        <span className="font-semibold">{goal.progressPercent}%</span>
                      </div>
                      <div className="w-full bg-[#4a4a4a] h-2">
                        <div className="bg-[#d4a574] h-2" style={{width: `${goal.progressPercent}%`}}></div>
                      </div>
                    </div>
                    <p className="text-sm text-[#b0a095]">Target: {goal.targetDate}</p>
                    <p className="text-xs text-[#8a8a8a]">{goal.successMetric}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TRACKS - Placeholder */}
          {activeTab === 'tracks' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Track Management</h3>
              <p className="text-[#b0a095]">View current track assignment and request upgrades as you progress.</p>
              <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4">
                <p className="text-sm"><strong>Current Track:</strong> Non-Contact Foundations</p>
                <p className="text-sm mt-2 text-[#b0a095]">Master basic stance, guard, jab, and program discipline protocols.</p>
                <p className="text-sm mt-2 text-[#b0a095]"><strong>Program Membership:</strong> Active Member</p>
                <p className="text-sm mt-1 text-[#b0a095]"><strong>Participation Status:</strong> Scholarship Supported</p>
                <p className="text-sm mt-1 text-[#b0a095]"><strong>Support Status:</strong> Member Support Active</p>
                <p className="text-sm mt-1 text-[#b0a095]"><strong>Community Service Credits:</strong> 0 (Display Placeholder)</p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS - Placeholder */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Assessments</h3>
              <p className="text-[#b0a095]">Complete personality tests, surveys, and skill assessments.</p>
              <div className="space-y-3">
                <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
                  <p className="font-semibold">MBTI Personality Test</p>
                  <p className="text-sm text-[#b0a095] mt-1">Discover your personality type and learning style.</p>
                  <button className="mt-3 px-3 py-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-white text-sm transition">Start Assessment</button>
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
                onAskShadow={() => setShadowInput('What do these scores mean?')}
              />

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-6">
                <h3 className="font-mono font-bold text-[#d4a574] uppercase">Daily Biological Check-In</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-[#b0a095] block mb-2" htmlFor="bio-sleep-hours">Sleep (4-12 hours)</label>
                    <input id="bio-sleep-hours" type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(Number.parseFloat(e.target.value))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                    <p className="text-xs text-[#8a8a8a] mt-1">{sleepHours} hours</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#b0a095] block mb-2" htmlFor="bio-hydration">Hydration (1-10)</label>
                    <input id="bio-hydration" type="range" min="1" max="10" value={hydrationStatus} onChange={(e) => setHydrationStatus(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                    <p className="text-xs text-[#8a8a8a] mt-1">{hydrationStatus}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#b0a095] block mb-2" htmlFor="bio-motivation">Motivation (1-10)</label>
                    <input id="bio-motivation" type="range" min="1" max="10" value={motivation} onChange={(e) => setMotivation(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                    <p className="text-xs text-[#8a8a8a] mt-1">{motivation}/10</p>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#b0a095] block mb-2" htmlFor="bio-soreness">Soreness (0-10)</label>
                    <input id="bio-soreness" type="range" min="0" max="10" value={soreness} onChange={(e) => setSoreness(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                    <p className="text-xs text-[#8a8a8a] mt-1">{soreness}/10</p>
                  </div>
                </div>

                <button
                  onClick={() => setExpandedCheckIn(!expandedCheckIn)}
                  className="w-full px-4 py-2 bg-[#4a4a4a] hover:bg-[#5a5a5a] text-[#e8d7c6] font-semibold transition"
                >
                  {expandedCheckIn ? '− Collapse' : '+ Expand to Maximum Check-In'}
                </button>

                {expandedCheckIn && (
                  <div className="space-y-4 pt-4 border-t-2 border-[#8b4444]">
                    <p className="text-sm text-[#b0a095]">Additional detailed metrics available below...</p>
                    <div className="text-xs text-[#8a8a8a]">
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
                onAskShadow={() => setShadowInput('What drills should I practice?')}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {drills.map(drill => (
                  <div key={drill.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block text-xs font-mono font-bold bg-[#4a4a4a] text-[#8a8a8a] px-2 py-1 mb-2">{drill.category}</span>
                        <h4 className="text-base font-semibold">{drill.name}</h4>
                      </div>
                      <span className="text-xs font-mono text-[#d4a574]">{drill.minRank}</span>
                    </div>
                    <p className="text-sm text-[#b0a095]">{drill.focus}</p>
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-[#d4a574]">Coaching Cues:</p>
                      <div className="flex flex-wrap gap-1">
                        {drill.cues.map((cue) => (
                          <span key={`${drill.id}-${cue}`} className="text-xs bg-[#4a4a4a] text-[#8a8a8a] px-2 py-1">⚡ {cue}</span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setCompletedDrills({...completedDrills, [drill.id]: !completedDrills[drill.id]})}
                      className={`w-full py-2 rounded font-semibold transition ${
                        completedDrills[drill.id]
                          ? 'bg-[#4a9a4a] text-white'
                          : 'bg-[#4a4a4a] hover:bg-[#5a5a5a] text-[#b0a095]'
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
                onAskShadow={() => setShadowInput('Can you explain biomechanics?')}
              />

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
                <h3 className="font-semibold text-lg">Biomechanics of Kinetic Force Transfer</h3>
                <p className="text-[#b0a095]"><strong>Concept:</strong> Power does not generate in the shoulders. Force begins with rear-foot ground rotation through hip rotation into target through clean wrist extension.</p>
                <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4">
                  <p className="text-sm text-[#e8d7c6]"><strong>Homework:</strong> Complete 30 slow shadowboxing crosses, holding full extension for 3 seconds to confirm your rear foot heel is rotated fully outward.</p>
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
                onAskShadow={() => setShadowInput('How do I contact my coach?')}
              />

              <div className="border-2 border-red-600 bg-red-900/20 p-4">
                <p className="text-sm text-red-200">🔒 <strong>SafeSport Policy:</strong> All messages are logged and parent CC is active for all minor athletes.</p>
              </div>

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                <h3 className="font-mono font-bold text-[#d4a574]">Send Message to Coach</h3>
                <form className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold mb-2" htmlFor="message-coach-select">Coach</label>
                    <select id="message-coach-select" className="w-full px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none">
                      <option>Coach Jason (Head Coach)</option>
                      <option>Coach Danielle (Fitness Director)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2" htmlFor="message-coach-body">Your Message</label>
                    <textarea
                      id="message-coach-body"
                      placeholder="Type your message..."
                      className="w-full h-24 px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none resize-none"
                    />
                  </div>
                  <button className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold py-2 transition">
                    Send Message
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* SCHEDULE SESSION */}
          {activeTab === 'schedule-session' && (
            <div className="space-y-6 animate-fadeIn">
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
                onAskShadow={() => setShadowInput('What classes are available?')}
              />

              <div className="space-y-4">
                {['Mon-Thu 4:00 PM Youth Class', 'Mon-Thu 5:00 PM Intermediate', 'MWF 5:45 PM Adult Fitness'].map((session) => (
                  <div key={session} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 flex justify-between items-center">
                    <p className="font-semibold">{session}</p>
                    <button className="px-4 py-2 bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold transition">
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
                query="What workout is next?"
                response="Your next class is Youth Class on Mon-Thu 4:00-5:00 PM. Focus on Non-Contact developmental work: footwork, shadowboxing, neurocognitive drills."
              />

              <div className="border-2 border-[#d4a574] bg-[#0f0f0f] p-6 space-y-4">
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {shadowMessages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.sender === 'athlete' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-xs px-4 py-2 rounded ${
                        msg.sender === 'athlete'
                          ? 'bg-blue-900 text-blue-100'
                          : 'bg-[#4a4a4a] text-[#e8d7c6]'
                      }`}>
                        <p className="text-sm">{msg.text}</p>
                        <p className="text-xs opacity-75 mt-1">{new Date(msg.timestamp).toLocaleTimeString()}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-4 border-t-2 border-[#d4a574] space-y-3">
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-[#d4a574]">Suggested Questions:</p>
                    <div className="grid grid-cols-1 gap-2">
                      {suggestedQuestions.map((q) => (
                        <button
                          key={q}
                          onClick={() => setShadowInput(q)}
                          className="text-left px-3 py-2 bg-[#1a1a1a] border-2 border-[#d4a574] hover:bg-[#2a2a2a] text-sm text-[#d4a574] transition"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={shadowInput}
                      onChange={(e) => setShadowInput(e.target.value)}
                      placeholder="Ask SHADOW a question..."
                      className="flex-1 px-3 py-2 bg-[#1a1a1a] border-2 border-[#d4a574] text-[#e8d7c6] focus:outline-none"
                    />
                    <button className="px-4 py-2 bg-[#d4a574] hover:bg-[#b08060] text-[#0a0a0a] font-semibold transition">
                      Send
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-yellow-900/20 border-2 border-yellow-700 p-4 text-sm">
                <p className="text-yellow-200"><strong>Note:</strong> SHADOW cannot answer questions about other athletes, board operations, financial data, or provide medical/legal advice.</p>
              </div>
            </div>
          )}
        </div>

        {/* PAIN MODAL */}
        {showPainModal && selectedPainLocation && (
          <div className="fixed inset-0 bg-[#0a0a0a]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 max-w-md w-full space-y-4">
              <h3 className="text-lg font-bold">Soreness Details: {selectedPainLocation}</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-type-select">Pain Type</label>
                  <select id="pain-type-select" value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="w-full px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none">
                    {(['Sharp', 'Dull', 'Burning', 'Tight', 'Pulling', 'Throbbing', 'Swollen', 'Numbness/Tingling', 'Instability', 'Other'] as PainType[]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2" htmlFor="pain-severity-range">Severity (1-10)</label>
                  <input id="pain-severity-range" type="range" min="1" max="10" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(Number.parseInt(e.target.value, 10))} className="w-full h-2 bg-[#4a4a4a] accent-[#d4a574]" />
                  <p className="text-xs text-[#8a8a8a] mt-1">{currentPainSeverity}/10</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setShowPainModal(false)} className="flex-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold py-2 transition">Save</button>
                <button onClick={() => setShowPainModal(false)} className="flex-1 bg-[#4a4a4a] hover:bg-[#5a5a5a] text-white font-semibold py-2 transition">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

