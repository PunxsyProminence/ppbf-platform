'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  athleteProfiles,
  loadTrackAssignments,
  readActiveAthleteProfileId,
  trackManifests,
  type TrackID,
} from './trackAssignments';

type TabID = 'dashboard' | 'education' | 'rabbitholes' | 'messaging' | 'scheduling' | 'floor' | 'smart-goals' | 'tracks' | 'assessments' | 'shadow';
type LatinRank = 'TIRO' | 'DISCIPULUS' | 'PUGIL NOVUS' | 'PUGIL SCIENTIA' | 'PUGIL FORTIS' | 'PUGIL PRAECEPTOR';
type SMARTCategory = 'Boxing' | 'Fitness' | 'Weight Loss' | 'Weight Gain' | 'Academics' | 'Attendance' | 'Recovery' | 'Lifestyle' | 'Leadership';
type GoalStatus = 'Not Started' | 'Active' | 'Completed' | 'Paused';
type TrackRequestStatus = 'Draft' | 'Submitted' | 'In Review' | 'Approved' | 'Denied';
type AssessmentType = 'Personality Test' | 'Motivation Survey' | 'Confidence Survey' | 'Burnout/Stress' | 'Leadership Readiness' | 'Discipline Index' | 'Resilience Check' | 'Coach-Created';
type PainType = 'Sharp' | 'Dull' | 'Burning' | 'Tight' | 'Pulling' | 'Throbbing' | 'Swollen' | 'Numbness/Tingling' | 'Instability' | 'Other';
type BodySide = 'Left' | 'Right' | 'Both' | 'Center';
type ReadinessLevel = 'GREEN' | 'YELLOW' | 'RED';

interface Drill {
  id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  minRank: LatinRank;
}

interface RabbitHole {
  id: string;
  title: string;
  concept: string;
  breakdown: string;
  homework: string;
}

interface SMARTGoal {
  id: string;
  title: string;
  category: SMARTCategory;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  timeBound: string;
  targetDate: string;
  successMetric: string;
  linkedWorkouts: string[];
  linkedTasks: string[];
  coachNotes: string;
  athleteReflection: string;
  status: GoalStatus;
  progressPercent: number;
}

interface FloorTask {
  id: string;
  title: string;
  category: string;
  description: string;
  dueTime: string;
  completed: boolean;
  priority: 'High' | 'Normal';
  taskType?: 'Individual Workout' | 'Assigned Task' | 'Goal-Linked' | 'Coach Work' | 'Homework';
  linkedGoalId?: string;
  assignedBy?: string;
  dueDate?: string;
  completionStatus?: 'Not Started' | 'In Progress' | 'Completed';
  completionNotes?: string;
  evidenceUpload?: File;
  progressIndicator?: number;
}

interface TrackRequest {
  id: string;
  trackName: string;
  reason: string;
  status: TrackRequestStatus;
  submittedDate: string;
  requestedTrack?: TrackID;
  reasonForRequest?: string;
  athleteStatement?: string;
  currentReadiness?: number;
  attendanceStatus?: 'Good' | 'Fair' | 'Needs Improvement';
  dateSubmitted?: string;
  coachReviewStatus?: 'Pending' | 'Reviewed' | 'Approved' | 'Denied';
  coachNotes?: string;
  approvalStatus?: 'Pending' | 'Approved' | 'Denied';
}

interface Assessment {
  id: string;
  name?: string;
  title?: string;
  type: AssessmentType;
  description?: string;
  duration?: number;
  dateAssigned?: string;
  dateCompleted?: string;
  score?: number;
  summary?: string;
  coachVisible?: boolean;
  athleteVisible?: boolean;
  recommendedAction?: string;
}

interface PainLocationContext {
  bodyRegion: string;
  side: BodySide;
  severity: number;
  painType: PainType[];
  triggerMovement: string;
  startedWhen: string;
  trend: 'Improving' | 'Same' | 'Worsening';
  notes: string;
  coachReviewNeeded: boolean;
}

interface TelemetryEvent {
  eventType: string;
  timestamp: string;
  data: any;
}

interface ShadowMessage {
  id: string;
  role?: 'user' | 'shadow';
  sender?: 'athlete' | 'shadow';
  content?: string;
  text?: string;
  timestamp: string;
}

export default function AthleteWorkspace() {
  // Tab & Navigation
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [activeTrack, setActiveTrack] = useState<TrackID>('non_contact');
  const [assignedTrackIds, setAssignedTrackIds] = useState<TrackID[]>(['non_contact']);
  const [activeAthleteProfileId, setActiveAthleteProfileId] = useState(athleteProfiles[0].id);
  const [showTrackCatalog, setShowTrackCatalog] = useState(false);
  const [athleteRank, setAthleteRank] = useState<LatinRank>('TIRO');

  // Daily Intake States
  const [sleepHours, setSleepHours] = useState<number>(8);
  const [sleepQuality, setSleepQuality] = useState<number>(7);
  const [energyLevel, setEnergyLevel] = useState<number>(7);
  const [mood, setMood] = useState<number>(7);
  const [stressLevel, setStressLevel] = useState<number>(3);
  const [soreness, setSoreness] = useState<number>(2);
  const [bodyWeight, setBodyWeight] = useState<number>(150);
  const [hydrationStatus, setHydrationStatus] = useState<number>(8);
  const [injuryFlag, setInjuryFlag] = useState<boolean>(false);
  const [readinessToTrain, setReadinessToTrain] = useState<number>(8);
  const [expandedCheckIn, setExpandedCheckIn] = useState(false);
  const [selectedPainLocation, setSelectedPainLocation] = useState<string | null>(null);
  const [painLocationContexts, setPainLocationContexts] = useState<Record<string, PainLocationContext>>({});
  const [motivation, setMotivation] = useState<number>(7);
  const [rpeGoal, setRpeGoal] = useState<number>(6);
  const [workloadOverrideLevel, setWorkloadOverrideLevel] = useState<number>(0);
  const [sorenessLocations, setSorenessLocations] = useState<string[]>([]);
  const [selectedSorenessLocation, setSelectedSorenessLocation] = useState<string | null>(null);
  const [sorenessDescriptions, setSorenessDescriptions] = useState<Record<string, { painType: PainType; severity: number; description: string; startedWhen: string }>>({});
  const [showSorenessModal, setShowSorenessModal] = useState(false);
  const [currentPainType, setCurrentPainType] = useState<PainType>('Dull');
  const [currentPainSeverity, setCurrentPainSeverity] = useState(3);
  const [currentPainDescription, setCurrentPainDescription] = useState('');
  const [currentPainStarted, setCurrentPainStarted] = useState('Today');
  const [academicPassing, setAcademicPassing] = useState<boolean>(true);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});
  const [drillSearch, setDrillSearch] = useState<string>('');

  // Check-In/Check-Out States
  const [sessionActive, setSessionActive] = useState(false);
  const [checkInTime, setCheckInTime] = useState<string | null>(null);
  const [checkInNotes, setCheckInNotes] = useState('');
  const [checkOutNotes, setCheckOutNotes] = useState('');
  const [tempCheckInNotes, setTempCheckInNotes] = useState('');
  const [sessionLog, setSessionLog] = useState<Array<{ id: string; checkInTime: string; checkOutTime?: string; checkInNotes: string; checkOutNotes?: string }>>([
    { id: 'sess_1', checkInTime: '2026-07-11 4:00 PM', checkOutTime: '2026-07-11 5:30 PM', checkInNotes: 'Feeling good, ready for heavy footwork drills', checkOutNotes: 'Great session! Completed all combo targets with 88% accuracy' },
    { id: 'sess_2', checkInTime: '2026-07-10 4:00 PM', checkOutTime: '2026-07-10 5:15 PM', checkInNotes: 'Slight left shoulder soreness, will monitor', checkOutNotes: 'Modified rounds 7-9 due to fatigue, recovered well' }
  ]);

  // Telemetry & Diagnostics
  const [telemetryLog, setTelemetryLog] = useState<any | null>(null);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [expandedDiagnostics, setExpandedDiagnostics] = useState(false);

  // SafeSport Messaging States
  const [messageRecipient, setMessageRecipient] = useState<string>("Coach Jason");
  const [messageText, setMessageText] = useState<string>("");
  const [parentCcEmail, setParentCcEmail] = useState<string>("parent.guardian@family.com");

  // Booking States
  const [academicHold, setAcademicHold] = useState<boolean>(false);

  // Athlete Floor States
  const [floorTasks, setFloorTasks] = useState<FloorTask[]>([
    { id: 'ft_1', title: 'Morning Readiness Check-In', category: 'Check-In', description: 'Complete biological readiness survey', dueTime: '7:00 AM', completed: false, priority: 'High' },
    { id: 'ft_2', title: 'Warmup Drills - Footwork', category: 'Training', description: 'Execute prescribed footwork progression', dueTime: '4:00 PM', completed: false, priority: 'High' },
    { id: 'ft_3', title: 'Conditioning Block', category: 'Training', description: 'Complete 30-minute conditioning session', dueTime: '5:00 PM', completed: false, priority: 'Normal' },
    { id: 'ft_4', title: 'Goal Review Journal', category: 'Homework', description: 'Reflect on weekly SMART goal progress', dueTime: '8:00 PM', completed: true, priority: 'Normal' }
  ]);
  const [newFloorTaskTitle, setNewFloorTaskTitle] = useState('');
  const [newFloorTaskType, setNewFloorTaskType] = useState<'Individual Workout' | 'Assigned Task' | 'Goal-Linked' | 'Coach Work' | 'Homework'>('Individual Workout');
  const [newFloorTaskDueDate, setNewFloorTaskDueDate] = useState('');

  // SMART Goals States
  const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([
    { id: 'sg_1', title: 'Master 5-Punch Combination', category: 'Boxing', specific: 'Execute jab-cross-hook-uppercut-cross with 85% accuracy', measurable: 'Hit target pad 85 times out of 100 attempts', achievable: 'Aligns with current skill level', relevant: 'Foundation for sparring progression', timeBound: '30 days', targetDate: '2026-08-12', successMetric: '85% accuracy rate', linkedWorkouts: ['wd_2', 'wd_3'], linkedTasks: [], coachNotes: 'Focus on hip rotation for power', athleteReflection: 'Feeling good about combo drills', status: 'Active', progressPercent: 45 },
    { id: 'sg_2', title: 'Build 10-Pound Muscle Mass', category: 'Fitness', specific: 'Gain 10 pounds of lean muscle through resistance training', measurable: 'Weekly bodyweight and body composition tracking', achievable: 'Realistic with 4x/week training and proper nutrition', relevant: 'Improves punch power and resilience', timeBound: '90 days', targetDate: '2026-10-12', successMetric: '10 lbs gain with <15% body fat increase', linkedWorkouts: ['wd_4'], linkedTasks: [], coachNotes: 'Increase protein intake to 1.2g per lb', athleteReflection: 'On track with meal prep', status: 'Active', progressPercent: 25 },
    { id: 'sg_3', title: 'Maintain 4.0 GPA', category: 'Academics', specific: 'Keep all grades at A (90+) level', measurable: 'Report card GPA = 4.0', achievable: 'Balanced with training schedule', relevant: 'Required for scholarship eligibility', timeBound: 'This semester (18 weeks)', targetDate: '2026-12-15', successMetric: '4.0 GPA on report card', linkedWorkouts: [], linkedTasks: [], coachNotes: 'Time management is key', athleteReflection: 'Need to study more consistently', status: 'Active', progressPercent: 90 }
  ]);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<SMARTCategory>('Boxing');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalSpecific, setNewGoalSpecific] = useState('');
  const [newGoalMeasurable, setNewGoalMeasurable] = useState('');
  const [newGoalAchievable, setNewGoalAchievable] = useState('');
  const [newGoalRelevant, setNewGoalRelevant] = useState('');
  const [newGoalTimeBound, setNewGoalTimeBound] = useState('');
  const [newGoalSuccessMetric, setNewGoalSuccessMetric] = useState('');
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);

  // Tracks States
  const [trackRequests, setTrackRequests] = useState<TrackRequest[]>([
    { id: 'tr_1', trackName: 'Pugil Scientia (Technical Boxing)', reason: 'Demonstrated mastery of fundamentals and ready for advanced techniques', status: 'Approved', submittedDate: '2026-07-01' },
    { id: 'tr_2', trackName: 'Fitness Progression Track', reason: 'Want to focus more on strength and conditioning for boxing performance', status: 'Submitted', submittedDate: '2026-07-08' },
    { id: 'tr_3', trackName: 'Leadership Development', reason: 'Interested in mentoring newer athletes', status: 'In Review', submittedDate: '2026-07-10' }
  ]);
  const [newTrackRequest, setNewTrackRequest] = useState<Partial<TrackRequest>>({});
  const [showTrackRequestForm, setShowTrackRequestForm] = useState(false);

  // Assessments States
  const [completedAssessments, setCompletedAssessments] = useState<Assessment[]>([]);
  const [selectedAssessment, setSelectedAssessment] = useState<string | null>(null);
  const [assessmentAnswers, setAssessmentAnswers] = useState<Record<string, string | number>>({});

  // SHADOW AI States
  const [shadowChatHistory, setShadowChatHistory] = useState<ShadowMessage[]>([
    { id: 'sm_1', sender: 'shadow', text: 'Hey! I\'m SHADOW, your AI athletic coach. How\'s your training going today?', timestamp: new Date(Date.now() - 600000).toISOString() },
    { id: 'sm_2', sender: 'athlete', text: 'Pretty good, but my footwork felt off during drills', timestamp: new Date(Date.now() - 540000).toISOString() },
    { id: 'sm_3', sender: 'shadow', text: 'Let\'s dig into that. What specific footwork drill were you working on?', timestamp: new Date(Date.now() - 480000).toISOString() },
    { id: 'sm_4', sender: 'athlete', text: 'The pivot and angle adjustment from the technical boxing progression', timestamp: new Date(Date.now() - 420000).toISOString() },
    { id: 'sm_5', sender: 'shadow', text: 'Good - try focusing on your weight transfer first. The angles will follow. Record a short video if you can.', timestamp: new Date(Date.now() - 360000).toISOString() }
  ]);
  const [shadowInput, setShadowInput] = useState('');
  const [shadowOnline, setShadowOnline] = useState(true);
  const [shadowRoleMode, setShadowRoleMode] = useState<'Athlete'>('Athlete');

  // Help/Tutorial States
  const [expandedHelpTab, setExpandedHelpTab] = useState<TabID | null>(null);

  // Ranks mapped directly to the Boxing program (Progrm Direction.docx)
  const rankDefinitions: Record<LatinRank, { label: string; desc: string }> = {
    TIRO: { label: "Beginner", desc: "Learning stance, guard, jab, and core gym discipline protocols." },
    DISCIPULUS: { label: "Student", desc: "Developing combinations, basic defensive pacing, rhythm, and reaction cued drills." },
    'PUGIL NOVUS': { label: "Developing Boxer", desc: "Building combination fluency, footwork pivoting, defensive recovery, and tactical awareness." },
    'PUGIL SCIENTIA': { label: "Skilled Boxer", desc: "Applying technical counters, generating target angles, and decision-making under fatigue indices." },
    'PUGIL FORTIS': { label: "Advanced Boxer", desc: "Adapting strategic block options, maintaining composure in live drilling, and modeling maturity." },
    'PUGIL PRAECEPTOR': { label: "Mentor Boxer", desc: "High boxing proficiency combined with youth mentorship and cultural leadership standards." }
  };

  // Skill Items (Layer 07)
  const drillLibrary: Drill[] = [
    { id: 'dl_1', name: 'Stance Width Stability', category: 'Footwork', focus: 'Maintains wide base during rapid forward and backward movement.', cues: ['Feet shoulder-width', 'Back heel lifted', 'Weight centered'], minRank: 'TIRO' },
    { id: 'dl_2', name: 'Straight Jab Retraction Snap', category: 'Striking', focus: 'Quick fist return to protect chin and guard stance.', cues: ['Elbow tucked', 'Shoulder covers chin', 'Snap fist on contact'], minRank: 'TIRO' },
    { id: 'dl_3', name: 'Slip and Lateral Pivot Step', category: 'Defense', focus: 'Move outside straight punch while generating lateral counter angles.', cues: ['Slip with head off-center', 'Step 45-degrees', 'Maintain guard width'], minRank: 'DISCIPULUS' },
    { id: 'dl_4', name: 'Cognitive Auditory Reaction Drills', category: 'Neurocognitive', focus: 'Execute punch modifications instantly in response to coach calls under stress.', cues: ['Exhale on punches', 'Listen for number calls', 'No movement hesitation'], minRank: 'PUGIL NOVUS' }
  ];

  // Creative Handouts (Layer 24)
  const rabbitHoles: RabbitHole[] = [
    {
      id: 'rh_1',
      title: 'Biomechanics of Kinetic Force Transfer',
      concept: 'Generating Punch Force from Ground Up to Fist Contact',
      breakdown: 'Power does not generate in the shoulders. Force begins with rear-foot ground rotation, transfers through hip rotation, stabilizes through core muscle groups, and snaps into the target through clean wrist extension.',
      homework: 'Complete 30 slow shadowboxing crosses, holding full extension for 3 seconds to confirm your rear foot heel is rotated fully outward.'
    },
    {
      id: 'rh_2',
      title: 'Neurobiology of Pattern Recognition',
      concept: 'Reducing Visual Latency below Conscious Decision Thresholds',
      breakdown: 'Elite defense processes visual micro-cues (like shoulder dips or slight glove drops) before the opponent throws, allowing physical reactions to occur before conscious thought.',
      homework: 'During shadowboxing, look strictly at your shadow\'s chest area, tracking how torso shifts predict arm movements.'
    }
  ];

  // Assessment Library
  const assessmentLibrary: Assessment[] = [
    {
      id: 'ass_1',
      name: 'MBTI Personality Test',
      title: 'MBTI Personality Test',
      type: 'Personality Test',
      description: 'Discover your personality type and learning style through comprehensive assessment.',
      duration: 15,
      dateAssigned: new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0],
      dateCompleted: undefined,
      score: undefined,
      coachVisible: true,
      athleteVisible: true,
      recommendedAction: 'Complete self-reflection session to understand communication strengths'
    },
    {
      id: 'ass_2',
      name: 'Motivation & Drive Survey',
      title: 'Motivation & Drive Survey',
      type: 'Motivation Survey',
      description: 'Evaluate your intrinsic and extrinsic motivation factors in athletics.',
      duration: 12,
      dateAssigned: new Date(Date.now() - 5*24*60*60*1000).toISOString().split('T')[0],
      dateCompleted: undefined,
      score: undefined,
      coachVisible: true,
      athleteVisible: true,
      recommendedAction: 'Identify intrinsic vs extrinsic motivation factors'
    },
    {
      id: 'ass_3',
      name: 'Burnout & Stress Screening',
      title: 'Burnout & Stress Screening',
      type: 'Burnout/Stress',
      description: 'Screen for burnout signs and stress levels affecting your performance.',
      duration: 10,
      dateAssigned: new Date(Date.now() - 3*24*60*60*1000).toISOString().split('T')[0],
      dateCompleted: undefined,
      score: undefined,
      coachVisible: true,
      athleteVisible: false,
      recommendedAction: 'Coach will review and plan recovery week if needed'
    }
  ];

  // Help Content by Tab
  const helpContent: Record<TabID, { title: string; description: string; tips: string[] }> = {
    'dashboard': {
      title: 'My Dashboard',
      description: 'Your daily command center. Track readiness, complete biological check-in, view prescribed workload, and monitor academic status.',
      tips: [
        'Expand the biological check-in for detailed metrics',
        'Readiness score (GREEN/YELLOW/RED) guides training intensity',
        'Academic holds prevent session booking',
        'Track soreness locations for coach awareness'
      ]
    },
    'floor': {
      title: 'Athlete Floor',
      description: 'Your daily execution board. View workouts, assigned tasks, homework, and coaching work with completion status and due dates.',
      tips: [
        'Check daily for new tasks from Coach Jason',
        'Link tasks to your SMART goals',
        'Mark completion status as you work',
        'Upload evidence or notes for accountability'
      ]
    },
    'smart-goals': {
      title: 'SMART Goals',
      description: 'Create and track measurable goals using SMART framework. Monitor progress and connect workouts/tasks to your goals.',
      tips: [
        'Specific goals are concrete and clear',
        'Measurable goals track progress with metrics',
        'Set realistic timeframes in your target date',
        'Regular reflection improves outcomes'
      ]
    },
    'tracks': {
      title: 'Tracks',
      description: 'Manage your current track assignment and request new tracks as you progress through the boxing program.',
      tips: [
        'Current track shows your active training level',
        'Review eligibility requirements before applying',
        'Attend consistently to qualify for upgrades',
        'Coach review takes 5-7 business days'
      ]
    },
    'education': {
      title: 'Drill Library',
      description: 'Physical lesson items and technical boxing drills organized by category with coaching cues.',
      tips: [
        'Search by drill name or category',
        'Coaching cues are keys to proper technique',
        'Mark drills complete as you master them',
        'Progressive complexity based on rank'
      ]
    },
    'rabbitholes': {
      title: 'Rabbit Holes',
      description: 'Deep-dive research into biomechanics, neurology, and advanced boxing theory. Homework assignments included.',
      tips: [
        'Read the breakdown carefully',
        'Complete homework to internalize concepts',
        'Ask Coach Jason for clarification',
        'Apply learnings to your training'
      ]
    },
    'assessments': {
      title: 'Assessments',
      description: 'Complete personality tests, surveys, and skill assessments. Results inform coaching and personal development.',
      tips: [
        'Answer honestly for best insights',
        'Some assessments are coach-visible only',
        'Recommended actions guide your next steps',
        'Retake annually to track growth'
      ]
    },
    'messaging': {
      title: 'Message Coach',
      description: 'SafeSport-compliant messaging portal. Parent carbon copy active for all minor communications.',
      tips: [
        'Parent email CC is automatic for minors',
        'Be clear and specific in your questions',
        'Messages are logged for safety',
        'Coach responds within 24 hours typically'
      ]
    },
    'scheduling': {
      title: 'Schedule Session',
      description: 'Book training sessions, coaching appointments, and group classes. Academic holds prevent scheduling.',
      tips: [
        'Check your academic status first',
        'Book early for preferred time slots',
        'Cancellations require 24-hour notice',
        'Readiness RED status may limit contact work'
      ]
    },
    'shadow': {
      title: 'SHADOW AI Assistant',
      description: 'SHADOW (Systemic Holistic Analytics & Diagnostic Oversight Wing) provides answers to your training questions.',
      tips: [
        'SHADOW is athlete-only and cannot expose board/financial data',
        'Ask about workouts, goals, tasks, readiness, tracks, and SMART goals',
        'SHADOW refuses to answer about other athletes or admin data',
        'Use suggested questions to get started'
      ]
    }
  };

  const sorenessAreaOptions = [
    'Neck',
    'Shoulders',
    'Upper back',
    'Lower back',
    'Core',
    'Hips',
    'Quads',
    'Hamstrings',
    'Calves',
    'Hands/Wrists',
  ];

  const suggestedShadowQuestions = [
    'What workout is scheduled for today?',
    'Why is my readiness score low?',
    'What SMART goal am I working on this week?',
    'Do I have any outstanding tasks?',
    'What does soreness score mean for my training?',
    'How do I request a track upgrade?',
    'What are the steps to create a SMART goal?',
    'What readiness level means I can do contact work?'
  ];

  useEffect(() => {
    const profileId = readActiveAthleteProfileId();
    const assignments = loadTrackAssignments();
    const assigned = assignments[profileId] ?? ['non_contact'];

    setActiveAthleteProfileId(profileId);
    setAssignedTrackIds(assigned);
    setActiveTrack(assigned[0]);
  }, []);

  const activeAthleteProfileLabel = useMemo(
    () => athleteProfiles.find((profile) => profile.id === activeAthleteProfileId)?.label ?? activeAthleteProfileId,
    [activeAthleteProfileId],
  );

  const toggleDrill = (id: string) => {
    setCompletedDrills(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSorenessLocation = (location: string) => {
    setSorenessLocations((current) =>
      current.includes(location) ? current.filter((item) => item !== location) : [...current, location],
    );
  };

  const currentReadinessScore = Math.max(
    1,
    Math.min(10, (sleepHours * 1.05) + (motivation * 0.55) - (soreness * 0.45) + (workloadOverrideLevel * 0.3)),
  );

  const handleCreateNewGoal = () => {
    if (newGoalTitle && newGoalSpecific && newGoalMeasurable && newGoalAchievable && newGoalRelevant && newGoalTimeBound && newGoalTargetDate && newGoalSuccessMetric) {
      const newGoal: SMARTGoal = {
        id: `sg_${Date.now()}`,
        title: newGoalTitle,
        category: newGoalCategory,
        specific: newGoalSpecific,
        measurable: newGoalMeasurable,
        achievable: newGoalAchievable,
        relevant: newGoalRelevant,
        timeBound: newGoalTimeBound,
        targetDate: newGoalTargetDate,
        successMetric: newGoalSuccessMetric,
        linkedWorkouts: [],
        linkedTasks: [],
        coachNotes: '',
        athleteReflection: '',
        status: 'Active',
        progressPercent: 0
      };
      setSmartGoals([...smartGoals, newGoal]);
      setNewGoalTitle('');
      setNewGoalCategory('Boxing');
      setNewGoalTargetDate('');
      setNewGoalSpecific('');
      setNewGoalMeasurable('');
      setNewGoalAchievable('');
      setNewGoalRelevant('');
      setNewGoalTimeBound('');
      setNewGoalSuccessMetric('');
      setShowGoalForm(false);
    }
  };

  const handleCheckIn = () => {
    setSessionActive(true);
    setCheckInTime(new Date().toLocaleString());
    setCheckInNotes(tempCheckInNotes);
    setTempCheckInNotes('');
  };

  const handleCheckOut = () => {
    if (checkInTime) {
      const newSession = {
        id: `sess_${Date.now()}`,
        checkInTime: checkInTime,
        checkOutTime: new Date().toLocaleString(),
        checkInNotes: checkInNotes,
        checkOutNotes: checkOutNotes
      };
      setSessionLog([newSession, ...sessionLog]);
      setSessionActive(false);
      setCheckInTime(null);
      setCheckInNotes('');
      setCheckOutNotes('');
    }
  };

  const handleDispatchIntake = () => {
    const packet = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/athlete_profile_checkin",
      data: {
        activeTrack,
        assignedTracks: assignedTrackIds,
        athleteProfileId: activeAthleteProfileId,
        activeRank: athleteRank,
        sleepHours,
        motivation,
        rpeGoal,
        workloadOverrideLevel,
        sorenessLevel: soreness,
        sorenessLocations,
        readinessScore: parseFloat(currentReadinessScore.toFixed(1)),
        academicPassing,
        completedDrillsCount: Object.keys(completedDrills).filter(k => completedDrills[k]).length,
        verifiedByJason: false
      }
    };
    setTelemetryLog(packet);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim()) return;

    const packet = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/safesport_messages/",
      payload: {
        sender: "Athlete Node (Minor-Aware)",
        recipient: messageRecipient,
        message: messageText,
        guardianCcActive: true,
        guardianEmail: parentCcEmail,
        safeSportApproved: parentCcEmail.length > 5
      }
    };
    setTelemetryLog(packet);
    setMessageText("");
  };

  const handleBookSession = (title: string, time: string) => {
    if (academicHold) return;
    const packet = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/booking_ledger/",
      payload: {
        classTitle: title,
        timeSlot: time,
        academicCheck: "Approved",
        verifiedByJason: false
      }
    };
    setTelemetryLog(packet);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="bg-[#1a1a1a] border-4 border-[#8b4444] p-5 flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 shadow-sm">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-[#8b4444] animate-pulse"></span>
            <span className="text-xs font-mono text-[#d4a574] font-bold uppercase tracking-wider">Layer 01: Core Athlete Console</span>
          </div>
          <h2 className="text-xl font-black font-mono text-[#e8d7c6]">Athlete Development Workspace</h2>
          <p className="text-xs text-[#b0a095] font-mono">Integrated physical progression, scheduling, and SafeSport messaging portal.</p>
        </div>

        {/* Tab Selector Hub */}
        <div className="flex flex-wrap bg-[#0f0f0f] p-1 border-2 border-[#8b4444] font-mono text-xs font-bold text-[#b0a095] gap-1">
          <button onClick={() => setActiveTab('dashboard')} className={`px-3 py-1.5 transition ${activeTab === 'dashboard' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>My Dashboard</button>
          <button onClick={() => setActiveTab('education')} className={`px-3 py-1.5 transition ${activeTab === 'education' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Drill Library</button>
          <button onClick={() => setActiveTab('rabbitholes')} className={`px-3 py-1.5 transition ${activeTab === 'rabbitholes' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Rabbit Holes</button>
          <button onClick={() => setActiveTab('messaging')} className={`px-3 py-1.5 transition ${activeTab === 'messaging' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Message Coach</button>
          <button onClick={() => setActiveTab('scheduling')} className={`px-3 py-1.5 transition ${activeTab === 'scheduling' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Schedule Session</button>
          <button onClick={() => setActiveTab('floor')} className={`px-3 py-1.5 transition ${activeTab === 'floor' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Athlete Floor</button>
          <button onClick={() => setActiveTab('smart-goals')} className={`px-3 py-1.5 transition ${activeTab === 'smart-goals' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>SMART Goals</button>
          <button onClick={() => setActiveTab('tracks')} className={`px-3 py-1.5 transition ${activeTab === 'tracks' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Track Upgrade</button>
          <button onClick={() => setActiveTab('assessments')} className={`px-3 py-1.5 transition ${activeTab === 'assessments' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>Assessments</button>
          <button onClick={() => setActiveTab('shadow')} className={`px-3 py-1.5 transition ${activeTab === 'shadow' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'hover:text-[#e8d7c6]'}`}>SHADOW AI</button>
        </div>
      </div>

      {/* --- DASHBOARD VIEW --- */}
      {activeTab === 'dashboard' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">
            {/* Track Selector */}
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
              <div className="border-b border-[#4a4a4a] pb-2">
                <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase tracking-wide">Active Track Profile Selection</h3>
                <p className="text-[11px] text-[#b0a095] font-mono">Assigned profile: {activeAthleteProfileLabel}. Only admin-assigned tracks are selectable.</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {assignedTrackIds.map(id => (
                  <button
                    key={id} onClick={() => setActiveTrack(id)}
                    className={`p-2.5 border-2 text-left font-mono transition flex flex-col justify-between h-20 ${
                      activeTrack === id ? 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#8b4444] font-bold' : 'bg-[#1a1a1a]/40 border-[#8b4444] text-[#b0a095] hover:text-[#e8d7c6]'
                    }`}
                  >
                    <span className="text-[11px] truncate block">{trackManifests[id].name}</span>
                    <span className="text-[8px] opacity-75 leading-tight font-light overflow-hidden text-[#b0a095]">{id === 'spec_ops' ? '16 Tasks' : 'Boxing Track'}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowTrackCatalog((current) => !current)}
                className="w-full border-2 border-[#d4a574]/30 bg-[#d4a574]/10 px-3 py-2 text-left text-[11px] font-mono text-[#d4a574] transition hover:bg-[#d4a574]/20"
              >
                {showTrackCatalog ? 'Hide available tracks' : 'Review available tracks'}
              </button>

              {showTrackCatalog ? (
                <div className="border-2 border-[#8b4444] bg-[#0f0f0f]/70 p-3 space-y-2">
                  {(Object.keys(trackManifests) as TrackID[]).map((id) => (
                    <div key={id} className="border-2 border-[#8b4444] bg-[#1a1a1a]/50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono text-[#e8d7c6]">{trackManifests[id].name}</span>
                        <span className={`text-[10px] font-mono ${assignedTrackIds.includes(id) ? 'text-[#d4a574]' : 'text-[#8a8a8a]'}`}>
                          {assignedTrackIds.includes(id) ? 'Assigned' : 'Available by admin assignment'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="bg-[#0f0f0f] p-4 border-2 border-[#8b4444] space-y-1">
                <span className="text-xs font-mono font-bold text-[#e8d7c6]">Selected Path Concept:</span>
                <p className="text-[11px] text-[#b0a095] font-mono leading-relaxed">{trackManifests[activeTrack].desc}</p>
              </div>

              {/* SESSION CHECK-IN / CHECK-OUT */}
              <div className={`border-2 p-4 space-y-3 ${sessionActive ? 'bg-[#0a2a0a] border-[#4a9a4a]' : 'bg-[#0a0a0a] border-[#8b4444]'}`}>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-mono font-bold text-[#e8d7c6]">Session Check-In / Check-Out Log</span>
                  <span className={`text-[9px] font-bold px-2 py-0.5 font-mono ${sessionActive ? 'bg-[#4a9a4a]/30 text-[#4a9a4a]' : 'bg-[#4a4a4a]/30 text-[#8a8a8a]'}`}>{sessionActive ? '🟢 SESSION ACTIVE' : '⚪ No Active Session'}</span>
                </div>

                {!sessionActive ? (
                  <div className="space-y-2">
                    <textarea value={tempCheckInNotes} onChange={(e) => setTempCheckInNotes(e.target.value)} placeholder="Start of session notes (pain, readiness, goals today...)" className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-12" />
                    <button onClick={handleCheckIn} className="w-full bg-[#4a9a4a] hover:bg-[#2a7a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 transition border-2 border-[#4a9a4a]">
                      ✅ Check In (Start Session)
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 bg-[#0a2a0a]/40 p-3 border-2 border-[#4a9a4a]">
                    <div className="text-xs font-mono text-[#b0a095] space-y-1">
                      <div><strong>Check-In Time:</strong> {checkInTime}</div>
                      <div><strong>Check-In Notes:</strong> {checkInNotes || '(none)'}</div>
                    </div>
                    <textarea value={checkOutNotes} onChange={(e) => setCheckOutNotes(e.target.value)} placeholder="End of session notes (performance summary, what went well, what to improve...)" className="w-full bg-[#1a1a1a] border-2 border-[#4a9a4a] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-12" />
                    <button onClick={handleCheckOut} className="w-full bg-[#dc2626] hover:bg-[#8b4444] text-[#e8d7c6] font-mono font-bold text-xs py-2 transition border-2 border-[#8b4444]">
                      ⏹️ Check Out (End Session)
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Today's Prescribed Workout drills */}
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
              <div className="border-b border-[#4a4a4a] pb-2 flex justify-between items-center">
                <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase tracking-wide">Prescribed Daily Workload Targets</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] bg-[#5a2a2a]/40 border-2 border-[#8b4444] text-[#8b4444] px-2 py-0.5 font-mono font-bold uppercase">{trackManifests[activeTrack].name}</span>
                  <span className="text-[9px] bg-[#0a2a4a]/40 border-2 border-[#d4a574] text-[#d4a574] px-2 py-0.5 font-mono font-bold uppercase">Override +{workloadOverrideLevel}</span>
                </div>
              </div>

              <div className="space-y-2">
                {trackManifests[activeTrack].focusWorkout.map((drill, idx) => (
                  <div key={idx} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-3 flex items-center gap-3 text-xs font-mono text-[#b0a095]">
                    <span className="text-[#8b4444] font-bold">0{idx + 1}.</span>
                    <span>{drill}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Daily check-in form */}
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
              <div className="border-b border-[#4a4a4a] pb-2">
                <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase tracking-wide">Daily Biological Check-In (Layer 14)</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-[#b0a095]">Sleep Duration</span><span className="text-[#8b4444] font-bold">{sleepHours} Hours</span></div>
                  <input type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(parseFloat(e.target.value))} className="w-full accent-[#8b4444] h-1 bg-[#4a4a4a]" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-[#b0a095]">Anatomical Soreness</span><span className="text-[#d4a574] font-bold">Level {soreness} / 10</span></div>
                  <input type="range" min="0" max="10" step="1" value={soreness} onChange={(e) => setSoreness(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-[#b0a095]">Motivation</span><span className="text-[#d4a574] font-bold">{motivation} / 10</span></div>
                  <input type="range" min="1" max="10" step="1" value={motivation} onChange={(e) => setMotivation(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-[#b0a095]">RPE Goal</span><span className="text-[#d4a574] font-bold">{rpeGoal} / 10</span></div>
                  <input type="range" min="1" max="10" step="1" value={rpeGoal} onChange={(e) => setRpeGoal(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
                </div>
                <div className="sm:col-span-2 space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-[#b0a095]">Daily Workload Override</span><span className="text-[#8b4444] font-bold">+{workloadOverrideLevel} difficulty levels</span></div>
                  <input type="range" min="0" max="4" step="1" value={workloadOverrideLevel} onChange={(e) => setWorkloadOverrideLevel(parseInt(e.target.value))} className="w-full accent-[#8b4444] h-1 bg-[#4a4a4a]" />
                </div>
              </div>

              <div className="space-y-2 border-2 border-[#8b4444] bg-[#1a1a1a]/50 p-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-mono text-[#e8d7c6] font-bold">Soreness location mapping</span>
                  {sorenessLocations.length > 0 && <span className="text-[9px] bg-[#8b4444]/30 text-[#8b4444] px-2 py-0.5 font-bold font-mono">{sorenessLocations.length} locations selected</span>}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {sorenessAreaOptions.map((location) => {
                    const selected = sorenessLocations.includes(location);
                    const hasDescription = sorenessDescriptions[location];
                    return (
                      <button
                        key={location}
                        type="button"
                        onClick={() => { setSelectedSorenessLocation(location); setShowSorenessModal(true); if (hasDescription) { setCurrentPainType(hasDescription.painType); setCurrentPainSeverity(hasDescription.severity); setCurrentPainDescription(hasDescription.description); setCurrentPainStarted(hasDescription.startedWhen); } else { setCurrentPainType('Dull'); setCurrentPainSeverity(3); setCurrentPainDescription(''); setCurrentPainStarted('Today'); } }}
                        className={`border-2 px-2 py-1.5 text-[11px] font-mono text-left transition relative ${selected ? 'border-[#d4a574] bg-[#5a2a2a]/30 text-[#8b4444]' : 'border-[#8b4444] bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6]'}`}
                      >
                        {location}
                        {hasDescription && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-[#d4a574] rounded-full"></span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <span className="text-[#e8d7c6] block font-bold">School Academic Passing Grade Check</span>
                  <p className="text-[10px] text-[#8a8a8a]">Passing standards are verified before training. Holds trigger automatic schedule freezes.</p>
                </div>
                <button type="button" onClick={() => setAcademicPassing(!academicPassing)} className={`px-3 py-1.5 font-bold border-2 transition ${academicPassing ? 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#8b4444]' : 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#b0a095]'}`}>
                  {academicPassing ? '✅ PASSING ALL' : '❌ ACADEMIC HOLD'}
                </button>
              </div>

              <button onClick={handleDispatchIntake} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-black text-xs py-2.5 transition uppercase tracking-wider border-2 border-[#8b4444]">
                ⚡ Dispatch Ingest Telemetry to Staging Path
              </button>

              {/* SESSION HISTORY LOG */}
              {sessionLog.length > 0 && (
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/40 p-4 space-y-3">
                  <h4 className="text-xs font-mono font-bold text-[#e8d7c6] uppercase tracking-wide">📋 Recent Session Log</h4>
                  <div className="space-y-3 max-h-64 overflow-y-auto">
                    {sessionLog.slice(0, 5).map(session => (
                      <div key={session.id} className="bg-[#0f0f0f] border-2 border-[#8b4444]/40 p-3 space-y-1.5">
                        <div className="flex justify-between items-center text-[10px] font-mono">
                          <span className="text-[#d4a574] font-bold">Check-In: {session.checkInTime}</span>
                          {session.checkOutTime && <span className="text-[#8a8a8a]">Check-Out: {session.checkOutTime}</span>}
                        </div>
                        {session.checkInNotes && <p className="text-[10px] text-[#b0a095] font-mono italic">📝 Start: {session.checkInNotes}</p>}
                        {session.checkOutNotes && <p className="text-[10px] text-[#b0a095] font-mono italic">📝 End: {session.checkOutNotes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* SORENESS DESCRIPTION MODAL */}
              {showSorenessModal && selectedSorenessLocation && (
                <div className="fixed inset-0 bg-[#0a0a0a]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                  <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 max-w-md w-full space-y-4 animate-fadeIn">
                    <div className="border-b border-[#4a4a4a] pb-3">
                      <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Soreness Details: {selectedSorenessLocation}</h3>
                      <p className="text-xs text-[#b0a095] font-mono mt-1">Describe the pain you're experiencing in this location</p>
                    </div>

                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-mono text-[#b0a095] block">Pain Type</label>
                        <select value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                          <option value="Sharp">Sharp</option>
                          <option value="Dull">Dull</option>
                          <option value="Burning">Burning</option>
                          <option value="Tight">Tight</option>
                          <option value="Pulling">Pulling</option>
                          <option value="Throbbing">Throbbing</option>
                          <option value="Swollen">Swollen</option>
                          <option value="Numbness/Tingling">Numbness/Tingling</option>
                          <option value="Instability">Instability</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex justify-between">
                          <label className="text-xs font-mono text-[#b0a095]">Pain Severity</label>
                          <span className="text-[#d4a574] font-bold text-xs">{currentPainSeverity}/10</span>
                        </div>
                        <input type="range" min="0" max="10" step="1" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-mono text-[#b0a095] block">When did it start?</label>
                        <select value={currentPainStarted} onChange={(e) => setCurrentPainStarted(e.target.value)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                          <option value="Just now">Just now</option>
                          <option value="Today">Today</option>
                          <option value="Yesterday">Yesterday</option>
                          <option value="This week">This week</option>
                          <option value="Last week">Last week</option>
                          <option value="Ongoing">Ongoing</option>
                        </select>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-mono text-[#b0a095] block">Additional Notes</label>
                        <textarea value={currentPainDescription} onChange={(e) => setCurrentPainDescription(e.target.value)} placeholder="e.g., Sharp pain on lateral side, worse with rotation..." className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-20" />
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => {
                          if (currentPainType) {
                            setSorenessDescriptions({
                              ...sorenessDescriptions,
                              [selectedSorenessLocation]: {
                                painType: currentPainType,
                                severity: currentPainSeverity,
                                description: currentPainDescription,
                                startedWhen: currentPainStarted
                              }
                            });
                            if (!sorenessLocations.includes(selectedSorenessLocation)) {
                              setSorenessLocations([...sorenessLocations, selectedSorenessLocation]);
                            }
                          }
                          setShowSorenessModal(false);
                          setSelectedSorenessLocation(null);
                        }}
                        className="flex-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 transition border-2 border-[#8b4444]"
                      >
                        Save Soreness
                      </button>
                      <button
                        onClick={() => {
                          if (sorenessDescriptions[selectedSorenessLocation]) {
                            const newDescriptions = { ...sorenessDescriptions };
                            delete newDescriptions[selectedSorenessLocation];
                            setSorenessDescriptions(newDescriptions);
                            setSorenessLocations(sorenessLocations.filter(l => l !== selectedSorenessLocation));
                          }
                          setShowSorenessModal(false);
                          setSelectedSorenessLocation(null);
                        }}
                        className="flex-1 bg-[#4a4a4a] hover:bg-[#8b4444]/30 text-[#8a8a8a] font-mono font-bold text-xs py-2 transition border-2 border-[#8b4444]"
                      >
                        Remove
                      </button>
                      <button onClick={() => setShowSorenessModal(false)} className="flex-1 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-[#b0a095] font-mono font-bold text-xs py-2 transition border-2 border-[#8b4444]">
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            {/* Latin ranks (restricted to boxing program) */}
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 space-y-4">
              <div className="border-b border-[#4a4a4a] pb-2">
                <span className="text-[10px] font-mono font-bold text-[#8a8a8a] uppercase tracking-wider block">Boxing Program Rank Progression</span>
                <h4 className="text-base font-black font-mono text-[#d4a574] tracking-wide">{athleteRank}</h4>
                <span className="text-xs text-[#b0a095] font-mono">({rankDefinitions[athleteRank].label})</span>
              </div>

              <p className="text-xs text-[#b0a095] font-mono leading-relaxed bg-[#0f0f0f]/60 p-3 border-2 border-[#8b4444]">
                {rankDefinitions[athleteRank].desc}
              </p>

              <div className="space-y-2 border-t border-[#4a4a4a]/80 pt-3">
                <label className="text-[11px] font-mono text-[#8a8a8a] block uppercase font-bold">Manual Rank Select (Development Test Emulator):</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(Object.keys(rankDefinitions) as LatinRank[]).map(r => (
                    <button key={r} onClick={() => setAthleteRank(r)} className={`p-1.5 text-center text-[10px] font-mono border-2 transition ${athleteRank === r ? 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#8b4444] font-bold' : 'bg-[#0f0f0f] border-[#8b4444] text-[#8a8a8a] hover:text-[#e8d7c6]'}`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#5a2a2a]/20 text-[#8b4444] border-2 border-[#8b4444] p-3.5 text-[10px] font-mono leading-relaxed space-y-1">
                <span className="font-bold text-[#8b4444] block uppercase">🛡️ Directive 5: Immunity Gate</span>
                <p className="text-[#b0a095]">All local selector updates are restricted to sandbox memory state only. Permanent rank database modifications or sparring permissions require explicit verification flags checked by Head Coach Jason.</p>
              </div>
            </div>

            {telemetryLog && (
              <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4 font-mono text-[10px] text-[#b0a095] space-y-1.5">
                <span className="text-[#d4a574] font-bold block border-b border-[#8b4444] pb-1">📡 TELEMETRY PACKET TRAPPED</span>
                <div>• Staging Node: <span className="underline">{telemetryLog.stagingPath}</span></div>
                <div>• Verified Flag: <span className="text-[#8b4444] font-bold">FALSE (Bypassed)</span></div>
                <pre className="text-[#8a8a8a] text-[9px] bg-[#1a1a1a] p-2 overflow-x-auto whitespace-pre-wrap border border-[#4a4a4a]">{JSON.stringify(telemetryLog, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- DRILL LIBRARY VIEW --- */}
      {activeTab === 'education' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3 flex flex-col md:flex-row justify-between md:items-center gap-3">
            <div>
              <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Layer 07: Drill Library & Physical Handouts</h3>
              <p className="text-xs text-[#a0a0a0] font-mono mt-0.5">Explore physical lesson items, technical boxing drills, and biomechanical cues.</p>
            </div>
            <input
              type="text" placeholder="Search drills or categories..." value={drillSearch} onChange={(e) => setDrillSearch(e.target.value)}
              className="bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-1.5 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#8b4444] max-w-xs"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {drillLibrary.filter(d => d.name.toLowerCase().includes(drillSearch.toLowerCase()) || d.category.toLowerCase().includes(drillSearch.toLowerCase())).map(drill => (
              <div key={drill.id} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-5 space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#e8d7c6] px-2 py-0.5 uppercase">{drill.category}</span>
                    <h4 className="text-sm font-bold font-mono text-[#e8d7c6] mt-2">{drill.name}</h4>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-[#8b4444] border-2 border-[#8b4444] px-2 py-0.5">{drill.minRank}</span>
                </div>

                <p className="text-xs text-[#b0a095] font-mono leading-relaxed">{drill.focus}</p>

                <div className="space-y-1.5 pt-2 border-t border-[#4a4a4a]/80">
                  <span className="text-[9px] font-mono font-bold text-[#8a8a8a] uppercase tracking-wider block">Coaching Cues:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {drill.cues.map((cue, idx) => (
                      <span key={idx} className="text-[10px] font-mono bg-[#0f0f0f] px-2 py-0.5 text-[#d4a574] border-2 border-[#8b4444]">⚡ {cue}</span>
                    ))}
                  </div>
                </div>

                <button onClick={() => toggleDrill(drill.id)} className={`w-full py-2 text-xs font-mono font-bold border-2 transition ${
                  completedDrills[drill.id] ? 'bg-[#5a2a2a]/20 border-[#8b4444] text-[#8b4444]' : 'bg-[#0f0f0f] border-[#8b4444] text-[#8a8a8a] hover:text-[#e8d7c6]'
                }`}>
                  {completedDrills[drill.id] ? '✅ Drill Target Met Today' : '⬜ Mark Drill Checked'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- RABBIT HOLES VIEW --- */}
      {activeTab === 'rabbitholes' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Layer 24: Technical "Rabbit Holes"</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Deep-dive athletic research covering motor learning, kinetics, and neurological training parameters.</p>
          </div>

          <div className="space-y-6">
            {rabbitHoles.map(rh => (
              <div key={rh.id} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-5 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#d4a574] px-2 py-0.5 uppercase">Advanced Study Matrix</span>
                  <span className="text-[9px] font-mono text-[#8a8a8a] font-bold">ID: {rh.id}</span>
                </div>

                <h4 className="text-base font-black font-mono text-[#e8d7c6]">{rh.title}</h4>
                <span className="text-xs text-[#b0a095] font-mono italic block">Concept Block: {rh.concept}</span>

                <p className="text-xs text-[#e8d7c6] font-mono leading-relaxed bg-[#0f0f0f]/60 p-4 border-2 border-[#8b4444]">
                  {rh.breakdown}
                </p>

                <div className="bg-[#4a0000]/25 border-2 border-[#8b4444] p-4 text-xs font-mono space-y-1">
                  <span className="font-bold text-[#ff6b6b] uppercase tracking-wide block text-[10px]">Home Study & Application Homework:</span>
                  <p className="text-[#e8d7c6]">{rh.homework}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- SAFESPORT MESSAGING VIEW --- */}
      {activeTab === 'messaging' && (
        <div className="space-y-6 animate-fadeIn">
          <div className="bg-[#4a0000]/40 text-[#ff6b6b] border-2 border-[#8b4444] px-4 py-3 text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>🔒 <strong>SAFESPORT POLICY GATES:</strong> Direct adult-to-minor individual messages are blocked. Parent CC loops are active.</div>
            <span className="text-[10px] bg-[#4a0000]/40 px-2 py-0.5 uppercase font-bold text-[#e8d7c6] border-2 border-[#8b4444]">SafeSport Enforced</span>
          </div>

          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6">
            <div className="border-b border-[#4a4a4a] pb-3">
              <h3 className="text-base font-bold font-mono text-[#e8d7c6]">SafeSport Certified Communications Portal</h3>
              <p className="text-xs text-[#b0a095] font-mono mt-0.5">Secure messaging protecting our youth, guardians, and coaching staff.</p>
            </div>

            <form onSubmit={handleSendMessage} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#b0a095] block">Select Staff Member Recipient</label>
                <select value={messageRecipient} onChange={(e) => setMessageRecipient(e.target.value)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#dc2626]">
                  <option value="Coach Jason">Coach Jason (Head Coach)</option>
                  <option value="Coach Danielle">Coach Danielle (Adult Fitness Director)</option>
                </select>
              </div>

              <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4 space-y-2">
                <span className="text-xs font-bold font-mono text-[#ff6b6b] block uppercase tracking-wider">Automated Guardian Carbon Copy (CC) Engaged</span>
                <p className="text-[11px] text-[#b0a095] font-mono">To maintain strict SafeSport compliance, parents receive a physical, non-deletable archive copy of all outbound communications.</p>
                <input type="email" value={parentCcEmail} onChange={(e) => setParentCcEmail(e.target.value)} placeholder="Parent email address" className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#dc2626]" />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#b0a095] block">Your Message Body</label>
                <textarea value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="Type your message text here..." className="w-full h-24 bg-[#1a1a1a] border-2 border-[#8b4444] p-3 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#dc2626] resize-none" />
              </div>

              <button type="submit" className="w-full bg-[#dc2626] hover:bg-[#8b4444] text-[#e8d7c6] font-mono font-black text-xs py-2.5 transition uppercase tracking-wider border-2 border-[#8b4444]">🔒 Send SafeSport Compliant Log Message</button>
            </form>
          </div>
        </div>
      )}

      {/* --- SCHEDULING VIEW --- */}
      {activeTab === 'scheduling' && (
        <div className="space-y-6 animate-fadeIn">
          <div className="bg-[#4a0000]/40 text-[#ff6b6b] border-2 border-[#8b4444] px-4 py-3 text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>📅 <strong>SCHEDULING CURRICULUM:</strong> Book classes directly. Access requires clear academic records.</div>
            <span className="text-[10px] bg-[#4a0000]/40 px-2 py-0.5 uppercase font-bold text-[#e8d7c6] border-2 border-[#8b4444]">Layer 06 Active</span>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2 bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6">
              <div className="border-b border-[#4a4a4a] pb-3">
                <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Prescribed Training Blocks Schedule</h3>
                <p className="text-xs text-[#b0a095] font-mono mt-0.5">Reserve class coordinates directly within our weekly curriculum schedule.</p>
              </div>

              <div className="space-y-3">
                {[
                  { days: "Mon - Thu", time: "4:00 - 5:00 PM", title: "Youth Non-Contact Development Block", desc: "Balance, stance, shadowboxing, neurocognitive drills, zero-sparring." },
                  { days: "Mon - Thu", time: "5:00 - 6:00 PM", title: "Intermediate / Technical Boxing", desc: "Partner combinations, target-pad coordination, controlled light sparring." },
                  { days: "Mon / Wed / Fri", time: "5:45 - 7:00 PM", title: "Danielle's Strength & Fitness", desc: "Adult conditioning, physical fitness progression ($50/mo or $10 drop-in)." }
                ].map((block, idx) => (
                  <div key={idx} className="bg-[#1a1a1a] border-2 border-[#8b4444] p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:border-[#dc2626]/20 transition">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#a0a0a0] px-2 py-0.5">{block.days}</span>
                        <span className="text-xs font-bold text-[#e8d7c6] font-mono">{block.time}</span>
                      </div>
                      <h4 className="text-sm font-black font-mono text-[#d4a574]">{block.title}</h4>
                      <p className="text-[11px] text-[#b0a095] font-mono leading-relaxed">{block.desc}</p>
                    </div>
                    <button
                      type="button" disabled={academicHold} onClick={() => handleBookSession(block.title, block.time)}
                      className={`w-full sm:w-auto px-4 py-2 text-xs font-mono font-bold transition uppercase tracking-wider border-2 ${
                        academicHold ? 'bg-[#4a4a4a] text-[#8a8a8a] border-[#8b4444] cursor-not-allowed' : 'bg-[#dc2626] hover:bg-[#8b4444] text-[#e8d7c6] border-[#8b4444]'
                      }`}
                    >
                      {academicHold ? 'Hold Lock' : 'Book Class'}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 space-y-4 h-fit">
              <span className="text-[10px] font-mono font-bold text-[#8a8a8a] uppercase tracking-wider block">Scheduling Safety Controls</span>
              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3.5 flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <span className="text-[#e8d7c6] block font-bold">Academic Hold Trigger</span>
                  <p className="text-[10px] text-[#8a8a8a]">Simulate school tracking blockades.</p>
                </div>
                <button type="button" onClick={() => setAcademicHold(!academicHold)} className={`px-3 py-1 text-[11px] font-bold border-2 transition ${academicHold ? 'bg-[#4a0000]/40 border-[#8b4444] text-[#ff6b6b]' : 'bg-[#4a0000]/40 border-[#8b4444] text-[#d4a574]'}`}>{academicHold ? 'HOLD ACTIVE' : 'CLEAR'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- ATHLETE FLOOR VIEW --- */}
      {activeTab === 'floor' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Athlete Floor: Daily Execution Board</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Track daily tasks, training blocks, and accountability checkpoints.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {floorTasks.map(task => (
              <div key={task.id} className={`border-2 p-4 space-y-3 ${task.completed ? 'bg-[#1a1a1a]/20 border-[#4a6a4a]' : 'bg-[#1a1a1a]/40 border-[#8b4444]'}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#e8d7c6] px-2 py-0.5 uppercase">{task.category}</span>
                    <h4 className="text-sm font-bold font-mono text-[#e8d7c6] mt-2">{task.title}</h4>
                  </div>
                  <input type="checkbox" checked={task.completed} onChange={() => {
                    setFloorTasks(floorTasks.map(t => t.id === task.id ? {...t, completed: !t.completed} : t));
                  }} className="w-5 h-5 cursor-pointer" />
                </div>
                <p className="text-xs text-[#b0a095] font-mono">{task.description}</p>
                <div className="flex items-center gap-2 text-[10px] font-mono text-[#8a8a8a]">
                  <span>⏰ {task.dueTime}</span>
                  <span className={`px-2 py-0.5 font-bold ${task.priority === 'High' ? 'bg-[#8b4444]/40 text-[#ff6b6b]' : 'bg-[#4a4a4a]/40 text-[#d4a574]'}`}>{task.priority}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- SMART GOALS VIEW --- */}
      {activeTab === 'smart-goals' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3 flex justify-between items-start">
            <div>
              <h3 className="text-base font-bold font-mono text-[#e8d7c6]">SMART Goals Framework</h3>
              <p className="text-xs text-[#b0a095] font-mono mt-0.5">Specific, Measurable, Achievable, Relevant, Time-bound goal tracking for athletic progression.</p>
            </div>
            <button onClick={() => setShowGoalForm(!showGoalForm)} className="px-3 py-1.5 bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs border-2 border-[#8b4444] transition">
              + New Goal
            </button>
          </div>

          {/* CREATE NEW GOAL FORM */}
          {showGoalForm && (
            <div className="bg-[#1a1a1a] border-2 border-[#d4a574] p-5 space-y-4">
              <h4 className="text-sm font-bold font-mono text-[#d4a574] uppercase">Create SMART Goal</h4>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#b0a095] block mb-1">Goal Title</label>
                  <input type="text" value={newGoalTitle} onChange={(e) => setNewGoalTitle(e.target.value)} placeholder="e.g., Master Double End Bag" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#b0a095] block mb-1">Category</label>
                  <select value={newGoalCategory} onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                    <option value="Boxing">Boxing</option>
                    <option value="Fitness">Fitness</option>
                    <option value="Weight Loss">Weight Loss</option>
                    <option value="Weight Gain">Weight Gain</option>
                    <option value="Academics">Academics</option>
                    <option value="Attendance">Attendance</option>
                    <option value="Recovery">Recovery</option>
                    <option value="Lifestyle">Lifestyle</option>
                    <option value="Leadership">Leadership</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-[#b0a095] block mb-1">Target Date</label>
                  <input type="date" value={newGoalTargetDate} onChange={(e) => setNewGoalTargetDate(e.target.value)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#b0a095] block mb-1">Success Metric</label>
                  <input type="text" value={newGoalSuccessMetric} onChange={(e) => setNewGoalSuccessMetric(e.target.value)} placeholder="e.g., Complete 20 rounds without fatigue" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-[#b0a095] block">SPECIFIC - What exactly will you do?</label>
                <textarea value={newGoalSpecific} onChange={(e) => setNewGoalSpecific(e.target.value)} placeholder="e.g., Practice 12-minute double-end bag rounds with footwork focus" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-16" />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-[#b0a095] block">MEASURABLE - How will you track it?</label>
                <textarea value={newGoalMeasurable} onChange={(e) => setNewGoalMeasurable(e.target.value)} placeholder="e.g., Track time per round, number of unbroken rounds, punch accuracy percentage" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-16" />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-[#b0a095] block">ACHIEVABLE - Why is this realistic?</label>
                <textarea value={newGoalAchievable} onChange={(e) => setNewGoalAchievable(e.target.value)} placeholder="e.g., Currently doing 8 rounds; increasing by 2 rounds/week is sustainable" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-16" />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-[#b0a095] block">RELEVANT - Why does this matter?</label>
                <textarea value={newGoalRelevant} onChange={(e) => setNewGoalRelevant(e.target.value)} placeholder="e.g., Stamina and footwork are critical for sparring advancement" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-16" />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-[#b0a095] block">TIME-BOUND - What's the timeline?</label>
                <textarea value={newGoalTimeBound} onChange={(e) => setNewGoalTimeBound(e.target.value)} placeholder="e.g., 8 weeks; reach 12 rounds by end of August" className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none h-16" />
              </div>

              <div className="flex gap-2 pt-2">
                <button onClick={handleCreateNewGoal} className="flex-1 bg-[#4a9a4a] hover:bg-[#2a7a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 transition border-2 border-[#4a9a4a]">
                  ✅ Create Goal
                </button>
                <button onClick={() => { setShowGoalForm(false); setNewGoalTitle(''); setNewGoalSpecific(''); setNewGoalMeasurable(''); setNewGoalAchievable(''); setNewGoalRelevant(''); setNewGoalTimeBound(''); setNewGoalSuccessMetric(''); }} className="flex-1 bg-[#4a4a4a] hover:bg-[#8b4444]/30 text-[#b0a095] font-mono font-bold text-xs py-2 transition border-2 border-[#8b4444]">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="space-y-4">
            {smartGoals.map(goal => (
              <div key={goal.id} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-5 space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#e8d7c6] px-2 py-0.5 uppercase">{goal.category}</span>
                    <h4 className="text-sm font-bold font-mono text-[#e8d7c6] mt-2">{goal.title}</h4>
                  </div>
                  <span className={`text-[9px] font-bold px-2 py-1 border-2 font-mono ${goal.status === 'Active' ? 'bg-[#4a6a4a]/40 border-[#4a6a4a] text-[#4a9a4a]' : goal.status === 'Completed' ? 'bg-[#4a6a4a]/40 border-[#4a6a4a] text-[#6aaa6a]' : 'bg-[#4a4a4a]/40 border-[#8a8a8a] text-[#b0a095]'}`}>{goal.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono text-[#b0a095]">
                  <span><strong>Target:</strong> {goal.successMetric}</span>
                  <span><strong>Due:</strong> {goal.targetDate}</span>
                </div>
                <div className="w-full bg-[#0f0f0f] border-2 border-[#8b4444]/40 h-2 rounded">
                  <div className="bg-[#8b4444] h-full" style={{ width: `${Math.min(100, goal.progressPercent)}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- TRACK REQUESTS VIEW --- */}
      {activeTab === 'tracks' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Track Upgrade Applications</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Apply for boxing and fitness track upgrades. Requires coach approval and demonstrated competency.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {trackRequests.map(tr => (
              <div key={tr.id} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-4 space-y-2">
                <h4 className="text-sm font-bold font-mono text-[#e8d7c6]">{tr.trackName}</h4>
                <p className="text-xs text-[#b0a095] font-mono">{tr.reason}</p>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className={`px-2 py-0.5 font-bold ${tr.status === 'Approved' ? 'bg-[#4a6a4a]/40 text-[#4a9a4a]' : tr.status === 'Denied' ? 'bg-[#8b4444]/40 text-[#ff6b6b]' : 'bg-[#4a4a4a]/40 text-[#b0a095]'}`}>{tr.status}</span>
                  <span className="text-[#8a8a8a]">Submitted: {tr.submittedDate}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- ASSESSMENTS VIEW --- */}
      {activeTab === 'assessments' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Athlete Assessments & Surveys</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Complete personality tests, motivation surveys, burnout screening, and leadership readiness evaluations.</p>
          </div>

          <div className="space-y-4">
            {assessmentLibrary.map(assess => (
              <div key={assess.id} className="bg-[#1a1a1a]/40 border-2 border-[#8b4444] p-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-[#4a4a4a] text-[#e8d7c6] px-2 py-0.5 uppercase">{assess.type}</span>
                    <h4 className="text-sm font-bold font-mono text-[#e8d7c6] mt-2">{assess.name}</h4>
                  </div>
                  <span className="text-[10px] font-mono text-[#8a8a8a]">{assess.duration} min</span>
                </div>
                <p className="text-xs text-[#b0a095] font-mono mb-3">{assess.description}</p>
                <button className="w-full bg-[#dc2626] hover:bg-[#8b4444] text-[#e8d7c6] font-mono font-bold text-xs py-2 transition uppercase tracking-wider border-2 border-[#8b4444]">
                  Start Assessment
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- SHADOW AI CHAT VIEW --- */}
      {activeTab === 'shadow' && (
        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">SHADOW: AI Athletic Coach Assistant</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Personalized AI coaching conversation for technique, motivation, recovery, and progression planning.</p>
          </div>

          <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-4 h-64 overflow-y-auto space-y-3 mb-4">
            {shadowChatHistory.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.sender === 'athlete' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-xs px-3 py-2 rounded text-xs font-mono ${msg.sender === 'athlete' ? 'bg-[#8b4444] text-[#e8d7c6]' : 'bg-[#4a4a4a] text-[#e8d7c6]'}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text" placeholder="Ask SHADOW about your training..."
                className="flex-1 bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#dc2626]"
              />
              <button className="px-4 py-2 bg-[#dc2626] hover:bg-[#8b4444] text-[#e8d7c6] font-mono font-bold text-xs border-2 border-[#8b4444] transition">Send</button>
            </div>
            <div className="border-t border-[#4a4a4a] pt-3">
              <span className="text-[9px] font-bold font-mono text-[#8a8a8a] uppercase block mb-2">Suggested Questions:</span>
              <div className="flex flex-wrap gap-2">
                {['How can I improve my footwork?', 'What should I focus on this week?', 'Recovery recommendations?'].map((q, idx) => (
                  <button key={idx} className="text-[9px] font-mono bg-[#4a4a4a] hover:bg-[#8b4444] text-[#e8d7c6] px-2 py-1 border-2 border-[#8b4444] transition">{q}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MANDATORY FOOTER */}
      <div className="bg-[#0f0f0f]/60 border-2 border-[#8b4444] p-4 text-[11px] font-mono text-[#8a8a8a] text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}