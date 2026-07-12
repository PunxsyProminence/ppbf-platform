'use client';

import React, { useState } from 'react';

type SessionType = 'Youth Class' | 'Adult Class' | 'Competition Team' | 'One-on-One' | 'Adaptive Session' | 'Conditioning Group' | 'Open Gym';
type SessionStatus = 'Not Started' | 'In Progress' | 'Paused' | 'Ended';
type AttendanceStatus = 'Present' | 'Late' | 'Excused' | 'Absent';
type ReadinessLevel = 'GREEN' | 'YELLOW' | 'RED';
type ObservationType = 'Positive' | 'Needs Correction' | 'Safety' | 'Behavioral';
type ModificationType = 'Reduced Intensity' | 'Alternative Drill' | 'Non-Contact Version' | 'Observation Only' | 'Coach Review Required';
type ModificationReason = 'Fatigue' | 'Pain' | 'Readiness' | 'Skill Deficit' | 'Behavior' | 'Injury Concern';
type AssignmentType = 'Workout' | 'Drill' | 'Film Review' | 'Survey' | 'Reflection' | 'Goal Update' | 'Coach Meeting';
type CoachMode = 'Group' | 'One-on-One';

interface SessionHeader {
  sessionName: string;
  sessionType: SessionType;
  coachName: string;
  date: string;
  startTime: string;
  sessionDuration: number;
  athleteCount: number;
  status: SessionStatus;
}

interface Athlete {
  id: string;
  name: string;
  track: string;
  attendance: AttendanceStatus;
  readiness: ReadinessLevel;
  sleepHours: number;
  energyLevel: number;
  mood: number;
  stressLevel: number;
  sorenessLevel: number;
  hydrationStatus: number;
  injuryFlag: boolean;
  readinessScore: number;
  currentGoals: string[];
  attendancePercent: number;
}

interface WorkoutBlock {
  id: string;
  title: string;
  description: string;
  duration: number;
  order: number;
  status: 'Not Started' | 'In Progress' | 'Completed' | 'Skipped';
  startTime?: string;
}

interface QuickObservation {
  id: string;
  athleteId: string;
  type: ObservationType;
  category: string;
  timestamp: string;
}

interface CoachObservation {
  id: string;
  athleteId: string;
  technical: Record<string, number>;
  physical: Record<string, number>;
  mental: Record<string, number>;
  behavior: Record<string, number>;
  notes: string;
  timestamp: string;
}

interface PainObservation {
  id: string;
  athleteId: string;
  bodyLocation: string;
  severity: 'Mild' | 'Moderate' | 'Severe';
  observedDuring: string;
  visibleRestriction: boolean;
  notes: string;
  timestamp: string;
}

interface WorkoutModification {
  id: string;
  athleteId: string;
  reason: ModificationReason;
  modification: ModificationType;
  notes: string;
  timestamp: string;
}

interface FollowUpAssignment {
  id: string;
  athleteId: string;
  assignmentType: AssignmentType;
  title: string;
  dueDate: string;
  priority: 'Low' | 'Medium' | 'High';
  notes: string;
}

interface SessionNotes {
  whatWentWell: string;
  areasNeedImprovement: string;
  technicalObservations: string;
  behaviorObservations: string;
  nextSessionPriorities: string;
}

interface ShadowAlert {
  id: string;
  athleteId: string;
  message: string;
  severity: 'Info' | 'Warning' | 'Critical';
  timestamp: string;
}

export default function CoachWorkspace() {
  const [coachMode, setCoachMode] = useState<CoachMode>('Group');
  const [sessionHeader, setSessionHeader] = useState<SessionHeader>({
    sessionName: 'Youth Non-Contact Development',
    sessionType: 'Youth Class',
    coachName: 'Coach Jason',
    date: new Date().toISOString().split('T')[0],
    startTime: '16:00',
    sessionDuration: 60,
    athleteCount: 0,
    status: 'Not Started'
  });

  const [athletes, setAthletes] = useState<Athlete[]>([
    {
      id: 'ath_001',
      name: 'Marcus Rodriguez',
      track: 'Foundations',
      attendance: 'Present',
      readiness: 'GREEN',
      sleepHours: 8,
      energyLevel: 8,
      mood: 7,
      stressLevel: 2,
      sorenessLevel: 1,
      hydrationStatus: 9,
      injuryFlag: false,
      readinessScore: 8.5,
      currentGoals: ['Improve jab speed', 'Build conditioning'],
      attendancePercent: 95
    },
    {
      id: 'ath_002',
      name: 'Sophia Chen',
      track: 'Competition',
      attendance: 'Late',
      readiness: 'YELLOW',
      sleepHours: 6,
      energyLevel: 6,
      mood: 6,
      stressLevel: 5,
      sorenessLevel: 3,
      hydrationStatus: 7,
      injuryFlag: false,
      readinessScore: 6.2,
      currentGoals: ['Defensive footwork', 'Ring IQ'],
      attendancePercent: 88
    },
    {
      id: 'ath_003',
      name: 'James Thompson',
      track: 'Non-Contact',
      attendance: 'Absent',
      readiness: 'RED',
      sleepHours: 5,
      energyLevel: 4,
      mood: 5,
      stressLevel: 7,
      sorenessLevel: 6,
      hydrationStatus: 5,
      injuryFlag: true,
      readinessScore: 3.8,
      currentGoals: ['Recovery focus', 'Mobility work'],
      attendancePercent: 75
    }
  ]);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>('ath_001');
  const [showAthleteDrawer, setShowAthleteDrawer] = useState(false);

  const [workoutBlocks, setWorkoutBlocks] = useState<WorkoutBlock[]>([
    { id: 'wb_1', title: 'Warmup', description: 'Light cardio, dynamic stretches, mobility prep', duration: 10, order: 1, status: 'Not Started' },
    { id: 'wb_2', title: 'Footwork', description: 'Stance drills, pivot variations, angular movement', duration: 15, order: 2, status: 'Not Started' },
    { id: 'wb_3', title: 'Defense', description: 'Slip drills, head movement patterns, block technique', duration: 15, order: 3, status: 'Not Started' },
    { id: 'wb_4', title: 'Reaction Drills', description: 'Auditory cues, visual tracking, reflexive responses', duration: 12, order: 4, status: 'Not Started' },
    { id: 'wb_5', title: 'Conditioning', description: 'High-intensity intervals, circuit training', duration: 10, order: 5, status: 'Not Started' },
    { id: 'wb_6', title: 'Cooldown', description: 'Light movement, stretching, breathing work', duration: 8, order: 6, status: 'Not Started' }
  ]);
  const [currentBlockIndex, setCurrentBlockIndex] = useState(0);

  const [quickObservations, setQuickObservations] = useState<QuickObservation[]>([]);
  const [coachObservations, setCoachObservations] = useState<CoachObservation[]>([]);
  const [technicalScores, setTechnicalScores] = useState<Record<string, number>>({
    'Jab': 5, 'Cross': 5, 'Hook': 5, 'Defense': 5, 'Footwork': 5,
    'Ring IQ': 5, 'Combination Flow': 5, 'Distance Management': 5
  });
  const [physicalScores, setPhysicalScores] = useState<Record<string, number>>({
    'Conditioning': 5, 'Balance': 5, 'Mobility': 5, 'Reaction': 5,
    'Coordination': 5, 'Strength': 5, 'Endurance': 5
  });
  const [mentalScores, setMentalScores] = useState<Record<string, number>>({
    'Confidence': 5, 'Focus': 5, 'Composure': 5, 'Motivation': 5, 'Resilience': 5
  });
  const [behaviorScores, setBehaviorScores] = useState<Record<string, number>>({
    'Coachability': 5, 'Leadership': 5, 'Discipline': 5, 'Sportsmanship': 5, 'Accountability': 5
  });
  const [observationNotes, setObservationNotes] = useState('');

  const [painObservations, setPainObservations] = useState<PainObservation[]>([]);
  const [newPainLocation, setNewPainLocation] = useState('');
  const [newPainSeverity, setNewPainSeverity] = useState<'Mild' | 'Moderate' | 'Severe'>('Mild');
  const [newPainObservedDuring, setNewPainObservedDuring] = useState('');

  const [workoutModifications, setWorkoutModifications] = useState<WorkoutModification[]>([]);
  const [modificationReason, setModificationReason] = useState<ModificationReason>('Fatigue');
  const [modificationType, setModificationType] = useState<ModificationType>('Reduced Intensity');
  const [modificationNotes, setModificationNotes] = useState('');

  const [followUpAssignments, setFollowUpAssignments] = useState<FollowUpAssignment[]>([]);
  const [newAssignmentType, setNewAssignmentType] = useState<AssignmentType>('Workout');
  const [newAssignmentTitle, setNewAssignmentTitle] = useState('');
  const [newAssignmentDueDate, setNewAssignmentDueDate] = useState('');

  const [sessionNotes, setSessionNotes] = useState<SessionNotes>({
    whatWentWell: '',
    areasNeedImprovement: '',
    technicalObservations: '',
    behaviorObservations: '',
    nextSessionPriorities: ''
  });

  const [showSessionNotesPanel, setShowSessionNotesPanel] = useState(false);
  const [shadowOnline, setShadowOnline] = useState(true);
  const [shadowAlerts, setShadowAlerts] = useState<ShadowAlert[]>([
    { id: 'sa_1', athleteId: 'ath_003', message: 'Athlete has injury flag', severity: 'Warning', timestamp: new Date().toISOString() },
    { id: 'sa_2', athleteId: 'ath_002', message: 'Readiness below threshold (YELLOW)', severity: 'Info', timestamp: new Date().toISOString() }
  ]);
  const [expandedShadow, setExpandedShadow] = useState(true);

  const handleStartSession = () => {
    setSessionHeader({ ...sessionHeader, status: 'In Progress' });
    if (workoutBlocks[0]) {
      setWorkoutBlocks(prev => [...prev.slice(0, 0), { ...prev[0], status: 'In Progress' }, ...prev.slice(1)]);
    }
  };

  const handlePauseSession = () => {
    setSessionHeader({ ...sessionHeader, status: 'Paused' });
  };

  const handleEndSession = () => {
    setSessionHeader({ ...sessionHeader, status: 'Ended' });
    setShowSessionNotesPanel(true);
  };

  const handleCompleteBlock = (blockId: string) => {
    setWorkoutBlocks(prev =>
      prev.map(b => b.id === blockId ? { ...b, status: 'Completed' } : b)
    );
    const nextIndex = currentBlockIndex + 1;
    if (nextIndex < workoutBlocks.length) {
      setCurrentBlockIndex(nextIndex);
      setWorkoutBlocks(prev =>
        prev.map((b, i) => i === nextIndex ? { ...b, status: 'In Progress' } : b)
      );
    }
  };

  const handleAttendanceChange = (athleteId: string, status: AttendanceStatus) => {
    setAthletes(prev =>
      prev.map(a => a.id === athleteId ? { ...a, attendance: status } : a)
    );
  };

  const handleAddQuickObservation = (athleteId: string, category: string, type: ObservationType) => {
    const newObs: QuickObservation = {
      id: `qo_${Date.now()}`,
      athleteId,
      type,
      category,
      timestamp: new Date().toISOString()
    };
    setQuickObservations(prev => [...prev, newObs]);
  };

  const handleSaveCoachObservation = () => {
    if (!selectedAthleteId) return;
    const newObs: CoachObservation = {
      id: `co_${Date.now()}`,
      athleteId: selectedAthleteId,
      technical: technicalScores,
      physical: physicalScores,
      mental: mentalScores,
      behavior: behaviorScores,
      notes: observationNotes,
      timestamp: new Date().toISOString()
    };
    setCoachObservations(prev => [...prev, newObs]);
    setObservationNotes('');
  };

  const handleAddModification = () => {
    if (!selectedAthleteId) return;
    const newMod: WorkoutModification = {
      id: `wm_${Date.now()}`,
      athleteId: selectedAthleteId,
      reason: modificationReason,
      modification: modificationType,
      notes: modificationNotes,
      timestamp: new Date().toISOString()
    };
    setWorkoutModifications(prev => [...prev, newMod]);
    setModificationNotes('');
  };

  const handleAddFollowUp = () => {
    if (!selectedAthleteId) return;
    const newAssign: FollowUpAssignment = {
      id: `fa_${Date.now()}`,
      athleteId: selectedAthleteId,
      assignmentType: newAssignmentType,
      title: newAssignmentTitle,
      dueDate: newAssignmentDueDate,
      priority: 'Medium',
      notes: ''
    };
    setFollowUpAssignments(prev => [...prev, newAssign]);
    setNewAssignmentTitle('');
    setNewAssignmentDueDate('');
  };

  const getProgressPercent = () => {
    const completed = workoutBlocks.filter(b => b.status === 'Completed').length;
    return Math.round((completed / workoutBlocks.length) * 100);
  };

  const selectedAthlete = athletes.find(a => a.id === selectedAthleteId);

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="bg-[#1a1a1a] border-4 border-[#8b4444] p-4 flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-[#d4a574] font-bold uppercase">Coach Floor Control</div>
          <h2 className="text-xl font-black font-mono text-[#e8d7c6]">Live Session Management</h2>
        </div>
        <div className="flex gap-2 border-2 border-[#8b4444] bg-[#0f0f0f] p-1">
          <button onClick={() => setCoachMode('Group')} className={`px-4 py-2 font-mono text-xs font-bold transition ${coachMode === 'Group' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6]'}`}>Group Mode</button>
          <button onClick={() => setCoachMode('One-on-One')} className={`px-4 py-2 font-mono text-xs font-bold transition ${coachMode === 'One-on-One' ? 'bg-[#5a2a2a] text-[#e8d7c6]' : 'bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6]'}`}>One-on-One</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        <div className="xl:col-span-3 space-y-6">
          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
            <div className="border-b border-[#4a4a4a] pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-black font-mono text-[#e8d7c6]">{sessionHeader.sessionName}</h3>
                <p className="text-xs text-[#b0a095] font-mono mt-1">{sessionHeader.sessionType}</p>
              </div>
              <div className={`px-3 py-1 text-xs font-mono font-bold rounded-sm ${sessionHeader.status === 'In Progress' ? 'bg-[#2a6b2a] text-[#a0d0a0]' : sessionHeader.status === 'Paused' ? 'bg-[#6b5a2a] text-[#d0c0a0]' : sessionHeader.status === 'Ended' ? 'bg-[#5a2a2a] text-[#d0a0a0]' : 'bg-[#2a2a2a] text-[#b0a095]'}`}>{sessionHeader.status}</div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
              <div className="bg-[#1a1a1a] p-3 border-2 border-[#8b4444]/30">
                <div className="text-[#8a8a8a] text-[10px] mb-1">Coach</div>
                <div className="text-[#e8d7c6] font-bold text-sm">{sessionHeader.coachName}</div>
              </div>
              <div className="bg-[#1a1a1a] p-3 border-2 border-[#8b4444]/30">
                <div className="text-[#8a8a8a] text-[10px] mb-1">Date</div>
                <div className="text-[#e8d7c6] font-bold text-sm">{sessionHeader.date}</div>
              </div>
              <div className="bg-[#1a1a1a] p-3 border-2 border-[#8b4444]/30">
                <div className="text-[#8a8a8a] text-[10px] mb-1">Start Time</div>
                <div className="text-[#e8d7c6] font-bold text-sm">{sessionHeader.startTime}</div>
              </div>
              <div className="bg-[#1a1a1a] p-3 border-2 border-[#8b4444]/30">
                <div className="text-[#8a8a8a] text-[10px] mb-1">Duration</div>
                <div className="text-[#e8d7c6] font-bold text-sm">{sessionHeader.sessionDuration} min</div>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={handleStartSession} disabled={sessionHeader.status !== 'Not Started'} className="flex-1 bg-[#2a6b2a] hover:bg-[#1a5a1a] disabled:bg-[#2a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#2a6b2a] disabled:border-[#4a4a4a] transition">[Start Session]</button>
              <button onClick={handlePauseSession} disabled={sessionHeader.status !== 'In Progress'} className="flex-1 bg-[#6b5a2a] hover:bg-[#5a4a1a] disabled:bg-[#2a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#6b5a2a] disabled:border-[#4a4a4a] transition">[Pause Session]</button>
              <button onClick={handleEndSession} className="flex-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#8b4444] transition">[End Session]</button>
            </div>
          </div>

          {coachMode === 'Group' && (
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
              <div className="border-b border-[#4a4a4a] pb-3">
                <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase">Section 2: Live Athlete Roster</h3>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono mb-4">
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30 text-center">
                  <div className="text-[#8a8a8a] text-[9px]">Total</div>
                  <div className="text-[#d4a574] font-bold">{athletes.length}</div>
                </div>
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#2a6b2a]/50 text-center">
                  <div className="text-[#8a8a8a] text-[9px]">✓ Checked In</div>
                  <div className="text-[#a0d0a0] font-bold">{athletes.filter(a => a.attendance !== 'Absent').length}</div>
                </div>
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#d4a574]/50 text-center">
                  <div className="text-[#8a8a8a] text-[9px]">⚠ Yellow</div>
                  <div className="text-[#d4a574] font-bold">{athletes.filter(a => a.readiness === 'YELLOW').length}</div>
                </div>
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#ff6b6b]/50 text-center">
                  <div className="text-[#8a8a8a] text-[9px]">🔴 Red</div>
                  <div className="text-[#ff6b6b] font-bold">{athletes.filter(a => a.readiness === 'RED').length}</div>
                </div>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {athletes.map(athlete => (
                  <div key={athlete.id} onClick={() => { setSelectedAthleteId(athlete.id); setShowAthleteDrawer(true); }} className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3 cursor-pointer hover:bg-[#2a2a2a] transition">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${athlete.readiness === 'GREEN' ? 'bg-[#2a6b2a]' : athlete.readiness === 'YELLOW' ? 'bg-[#6b5a2a]' : 'bg-[#6b2a2a]'}`}></div>
                        <span className="font-mono font-bold text-sm text-[#e8d7c6]">{athlete.name}</span>
                      </div>
                      <div className="text-[10px] font-mono text-[#b0a095]">{athlete.track}</div>
                    </div>
                    <div className="flex gap-2 text-[10px] font-mono">
                      <div className="flex-1">
                        <span className="text-[#8a8a8a]">Attendance:</span>
                        <div className="flex gap-1 mt-1">
                          {(['Present', 'Late', 'Excused', 'Absent'] as const).map(status => (
                            <button key={status} onClick={(e) => { e.stopPropagation(); handleAttendanceChange(athlete.id, status); }} className={`px-1.5 py-0.5 border-2 transition ${athlete.attendance === status ? 'bg-[#5a2a2a] border-[#8b4444] text-[#8b4444]' : 'bg-[#0f0f0f] border-[#8b4444] text-[#8a8a8a] hover:text-[#e8d7c6]'}`}>{status}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
            <div className="border-b border-[#4a4a4a] pb-3">
              <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase">Section 4: Session Plan Execution</h3>
              <p className="text-xs text-[#b0a095] font-mono mt-1">Progress: {getProgressPercent()}%</p>
            </div>

            <div className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] h-3 overflow-hidden">
              <div className="bg-[#8b4444] h-full transition-all duration-300" style={{ width: `${getProgressPercent()}%` }}></div>
            </div>

            <div className="space-y-2">
              {workoutBlocks.map((block, idx) => (
                <div key={block.id} className={`border-2 p-3 font-mono text-xs ${block.status === 'Completed' ? 'bg-[#2a5a2a]/30 border-[#2a6b2a]' : block.status === 'In Progress' ? 'bg-[#5a3a1a]/30 border-[#d4a574]' : block.status === 'Skipped' ? 'bg-[#4a4a4a]/30 border-[#8a8a8a]' : 'bg-[#1a1a1a] border-[#8b4444]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[#d4a574] font-bold">{idx + 1}</span>
                      <span className="text-[#e8d7c6] font-bold">{block.title}</span>
                      {block.status === 'In Progress' && <span className="text-[#d4a574] animate-pulse">●</span>}
                    </div>
                    <span className={`text-[10px] font-bold ${block.status === 'Completed' ? 'text-[#2a6b2a]' : block.status === 'In Progress' ? 'text-[#d4a574]' : block.status === 'Skipped' ? 'text-[#8a8a8a]' : 'text-[#b0a095]'}`}>{block.status} • {block.duration} min</span>
                  </div>
                  <p className="text-[#b0a095] text-[10px] mb-2">{block.description}</p>
                  <div className="flex gap-1">
                    <button onClick={() => handleCompleteBlock(block.id)} disabled={block.status === 'Completed' || block.status === 'Skipped'} className="flex-1 px-2 py-1 bg-[#2a6b2a] hover:bg-[#1a5a1a] disabled:bg-[#2a2a2a] text-[#e8d7c6] border-2 border-[#2a6b2a] disabled:border-[#4a4a4a] transition text-[9px] font-bold">[Complete]</button>
                    <button className="px-2 py-1 bg-[#0f0f0f] hover:bg-[#1a1a1a] text-[#b0a095] border-2 border-[#8b4444] transition text-[9px] font-bold">[Modify]</button>
                    <button className="px-2 py-1 bg-[#0f0f0f] hover:bg-[#1a1a1a] text-[#b0a095] border-2 border-[#8b4444] transition text-[9px] font-bold">[Skip]</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
            <div className="border-b border-[#4a4a4a] pb-3">
              <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase">Section 5: Group Observation Panel</h3>
              <p className="text-xs text-[#b0a095] font-mono mt-1">One-click observation logging</p>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs font-mono text-[#d4a574] font-bold mb-2">✅ Positive Observations</div>
                <div className="grid grid-cols-2 gap-2">
                  {['Excellent Effort', 'Excellent Leadership', 'Excellent Coachability', 'Excellent Focus'].map(obs => (
                    <button key={obs} onClick={() => selectedAthleteId && handleAddQuickObservation(selectedAthleteId, obs, 'Positive')} disabled={!selectedAthleteId} className="px-2 py-2 bg-[#2a5a2a]/30 hover:bg-[#2a5a2a]/50 disabled:bg-[#2a2a2a] border-2 border-[#2a6b2a] disabled:border-[#4a4a4a] text-[#a0d0a0] disabled:text-[#8a8a8a] font-mono text-[10px] font-bold transition">+ {obs}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-mono text-[#ff6b6b] font-bold mb-2">⚠️ Needs Attention</div>
                <div className="grid grid-cols-2 gap-2">
                  {['Needs Redirection', 'Safety Reminder', 'Behavioral Issue', 'Attendance Issue'].map(obs => (
                    <button key={obs} onClick={() => selectedAthleteId && handleAddQuickObservation(selectedAthleteId, obs, 'Needs Correction')} disabled={!selectedAthleteId} className="px-2 py-2 bg-[#6b2a2a]/30 hover:bg-[#6b2a2a]/50 disabled:bg-[#2a2a2a] border-2 border-[#6b2a2a] disabled:border-[#4a4a4a] text-[#ff9999] disabled:text-[#8a8a8a] font-mono text-[10px] font-bold transition">+ {obs}</button>
                  ))}
                </div>
              </div>
            </div>

            {quickObservations.length > 0 && (
              <div className="bg-[#1a1a1a] p-3 border-2 border-[#8b4444]/30">
                <div className="text-xs font-mono text-[#d4a574] font-bold mb-2">Recent: {quickObservations.length} observations</div>
                <div className="text-[10px] text-[#b0a095] space-y-1 max-h-16 overflow-y-auto">
                  {quickObservations.slice(-5).map(obs => (
                    <div key={obs.id} className="flex justify-between">
                      <span>{obs.category}</span>
                      <span className="text-[#8a8a8a]">{new Date(obs.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {coachMode === 'One-on-One' && (
            <>
              <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
                <div className="border-b border-[#4a4a4a] pb-3">
                  <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase">One-on-One: Goal Review</h3>
                </div>
                {selectedAthlete && (
                  <div className="space-y-2">
                    {selectedAthlete.currentGoals.map((goal, idx) => (
                      <div key={idx} className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3">
                        <div className="text-sm font-mono text-[#e8d7c6] font-bold">{goal}</div>
                        <div className="text-xs text-[#b0a095] mt-2">Progress tracking: Ready for backend integration</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
                <div className="border-b border-[#4a4a4a] pb-3">
                  <h3 className="text-sm font-black font-mono text-[#e8d7c6] uppercase">Action Plan & Follow-Up</h3>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-mono text-[#b0a095] block">Follow-Up Date</label>
                    <input type="date" value={newAssignmentDueDate} onChange={(e) => setNewAssignmentDueDate(e.target.value)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                  </div>
                  <button className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#8b4444] transition">Schedule Follow-Up</button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="xl:col-span-1 space-y-4">
          {showAthleteDrawer && selectedAthlete && (
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4 space-y-4 sticky top-4">
              <div className="flex justify-between items-center border-b border-[#4a4a4a] pb-3">
                <h4 className="text-sm font-black font-mono text-[#e8d7c6]">{selectedAthlete.name}</h4>
                <button onClick={() => setShowAthleteDrawer(false)} className="text-[#b0a095] hover:text-[#e8d7c6] font-mono text-lg">✕</button>
              </div>

              <div className="space-y-2 text-xs font-mono">
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30">
                  <div className="text-[#8a8a8a] text-[9px]">Track</div>
                  <div className="text-[#e8d7c6] font-bold">{selectedAthlete.track}</div>
                </div>
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30">
                  <div className="text-[#8a8a8a] text-[9px]">Attendance %</div>
                  <div className="text-[#e8d7c6] font-bold">{selectedAthlete.attendancePercent}%</div>
                </div>
                <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30">
                  <div className="text-[#8a8a8a] text-[9px]">Readiness Score</div>
                  <div className="text-[#e8d7c6] font-bold">{selectedAthlete.readinessScore}/10</div>
                </div>
              </div>

              <div className="space-y-1 text-[10px] font-mono">
                <div className="text-[#d4a574] font-bold">Self-Report Data</div>
                <div className="grid grid-cols-2 gap-1">
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Sleep</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.sleepHours}h</div>
                  </div>
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Energy</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.energyLevel}/10</div>
                  </div>
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Mood</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.mood}/10</div>
                  </div>
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Stress</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.stressLevel}/10</div>
                  </div>
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Soreness</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.sorenessLevel}/10</div>
                  </div>
                  <div className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/20">
                    <div className="text-[#8a8a8a]">Hydration</div>
                    <div className="text-[#e8d7c6] font-bold">{selectedAthlete.hydrationStatus}/10</div>
                  </div>
                </div>
                {selectedAthlete.injuryFlag && (
                  <div className="bg-[#6b2a2a]/30 border-2 border-[#ff6b6b] p-2 text-[#ff6b6b]">🚨 INJURY FLAG ACTIVE</div>
                )}
              </div>

              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3 space-y-2">
                <div className="text-xs font-mono text-[#d4a574] font-bold">SECTION 7: Coach Observation</div>
                <div className="space-y-2 text-[10px] font-mono">
                  <div>
                    <label className="text-[#8a8a8a] block mb-1">Technical</label>
                    <div className="grid grid-cols-2 gap-1">
                      {Object.entries(technicalScores).slice(0, 4).map(([key, val]) => (
                        <div key={key} className="bg-[#0f0f0f] p-1 border-2 border-[#8b4444]/20">
                          <div className="text-[#8a8a8a] text-[8px] truncate">{key}</div>
                          <input type="range" min="1" max="10" value={val} onChange={(e) => setTechnicalScores({ ...technicalScores, [key]: parseInt(e.target.value) })} className="w-full h-1 accent-[#d4a574]" />
                          <div className="text-[#d4a574] font-bold">{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <textarea value={observationNotes} onChange={(e) => setObservationNotes(e.target.value)} placeholder="Quick notes..." className="w-full h-12 bg-[#0f0f0f] border-2 border-[#8b4444] p-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none" />
                <button onClick={handleSaveCoachObservation} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-1.5 border-2 border-[#8b4444] transition">Save Observation</button>
              </div>

              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3 space-y-2">
                <div className="text-xs font-mono text-[#ff6b6b] font-bold">SECTION 8: Pain & Modification</div>
                <div className="text-[9px] text-[#8a8a8a] italic mb-2">Coach observations are not medical diagnoses.</div>
                <input type="text" placeholder="Pain location..." value={newPainLocation} onChange={(e) => setNewPainLocation(e.target.value)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                <select value={newPainSeverity} onChange={(e) => setNewPainSeverity(e.target.value as 'Mild' | 'Moderate' | 'Severe')} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                  <option>Mild</option>
                  <option>Moderate</option>
                  <option>Severe</option>
                </select>
              </div>

              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3 space-y-2">
                <div className="text-xs font-mono text-[#d4a574] font-bold">SECTION 9: Modification</div>
                <select value={modificationReason} onChange={(e) => setModificationReason(e.target.value as ModificationReason)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                  <option>Fatigue</option>
                  <option>Pain</option>
                  <option>Readiness</option>
                </select>
                <select value={modificationType} onChange={(e) => setModificationType(e.target.value as ModificationType)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                  <option>Reduced Intensity</option>
                  <option>Alternative Drill</option>
                  <option>Non-Contact Version</option>
                </select>
                <button onClick={handleAddModification} className="w-full bg-[#6b2a2a] hover:bg-[#5a1a1a] text-[#e8d7c6] font-mono font-bold text-xs py-1.5 border-2 border-[#6b2a2a] transition">Log Modification</button>
              </div>

              <div className="bg-[#1a1a1a] border-2 border-[#8b4444] p-3 space-y-2">
                <div className="text-xs font-mono text-[#d4a574] font-bold">SECTION 10: Follow-Up</div>
                <input type="text" placeholder="Assignment title..." value={newAssignmentTitle} onChange={(e) => setNewAssignmentTitle(e.target.value)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                <select value={newAssignmentType} onChange={(e) => setNewAssignmentType(e.target.value as AssignmentType)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                  <option>Workout</option>
                  <option>Drill</option>
                  <option>Film Review</option>
                </select>
                <input type="date" value={newAssignmentDueDate} onChange={(e) => setNewAssignmentDueDate(e.target.value)} className="w-full bg-[#0f0f0f] border-2 border-[#8b4444] px-2 py-1 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                <button onClick={handleAddFollowUp} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-1.5 border-2 border-[#8b4444] transition">Assign</button>
              </div>
            </div>
          )}

          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4 sticky top-4">
            <button onClick={() => setExpandedShadow(!expandedShadow)} className="w-full flex items-center justify-between mb-3 pb-3 border-b border-[#4a4a4a]">
              <h4 className="text-sm font-black font-mono text-[#e8d7c6]">SHADOW</h4>
              <div className={`text-xs font-mono font-bold ${shadowOnline ? 'text-[#2a6b2a]' : 'text-[#8a8a8a]'}`}>{shadowOnline ? '● ONLINE' : '○ OFFLINE'}</div>
            </button>

            {expandedShadow && (
              <div className="space-y-3">
                <div className="text-xs font-mono text-[#d4a574] font-bold">SESSION ALERTS</div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {shadowAlerts.map(alert => (
                    <div key={alert.id} className={`p-2 border-2 text-[10px] font-mono ${alert.severity === 'Critical' ? 'bg-[#6b2a2a]/30 border-[#ff6b6b] text-[#ff9999]' : alert.severity === 'Warning' ? 'bg-[#6b5a2a]/30 border-[#d4a574] text-[#d4a574]' : 'bg-[#2a5a6b]/30 border-[#4a9fbf] text-[#7ab5c9]'}`}>
                      <div className="font-bold mb-1">{alert.message}</div>
                      <div className="text-[#8a8a8a]">{new Date(alert.timestamp).toLocaleTimeString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSessionNotesPanel && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 max-w-2xl w-full max-h-96 overflow-y-auto space-y-4">
            <h3 className="text-lg font-black font-mono text-[#e8d7c6]">Session Notes - End of Class</h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-mono text-[#b0a095] block mb-1">What Went Well</label>
                <textarea value={sessionNotes.whatWentWell} onChange={(e) => setSessionNotes({ ...sessionNotes, whatWentWell: e.target.value })} className="w-full h-12 bg-[#1a1a1a] border-2 border-[#8b4444] p-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none" />
              </div>
              <div>
                <label className="text-xs font-mono text-[#b0a095] block mb-1">Areas Needing Improvement</label>
                <textarea value={sessionNotes.areasNeedImprovement} onChange={(e) => setSessionNotes({ ...sessionNotes, areasNeedImprovement: e.target.value })} className="w-full h-12 bg-[#1a1a1a] border-2 border-[#8b4444] p-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none" />
              </div>
              <div>
                <label className="text-xs font-mono text-[#b0a095] block mb-1">Next Session Priorities</label>
                <textarea value={sessionNotes.nextSessionPriorities} onChange={(e) => setSessionNotes({ ...sessionNotes, nextSessionPriorities: e.target.value })} className="w-full h-12 bg-[#1a1a1a] border-2 border-[#8b4444] p-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none" />
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setShowSessionNotesPanel(false)} className="flex-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#8b4444] transition">Save & Close</button>
              <button onClick={() => { setSessionNotes({ whatWentWell: '', areasNeedImprovement: '', technicalObservations: '', behaviorObservations: '', nextSessionPriorities: '' }); setShowSessionNotesPanel(false); }} className="flex-1 bg-[#0f0f0f] hover:bg-[#1a1a1a] text-[#b0a095] font-mono font-bold text-xs py-2 border-2 border-[#8b4444] transition">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
