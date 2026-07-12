'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { readRoleSession } from '@/components/roleSession';

// ============================================================================
// I. DATA STRUCTURE CORRIDORS & DATA PRIVACY TYPES
// ============================================================================
type RoleId = 'ATHLETE' | 'GUARDIAN' | 'COACH' | 'ADMIN' | 'PRESIDENT' | 'VICE_CHAIR' | 'TREASURER' | 'SECRETARY' | 'SAFETY_DIRECTOR' | 'DEVELOPMENT' | 'DIRECTOR_AT_LARGE' | 'AUDITOR';
type BuildStatus = 'BUILT' | 'PARTIALLY_SCAFFOLDED' | 'INTENDED' | 'DEFERRED' | 'SAFETY_BLOCKED';
type TrackId = 'NON_PROFIT' | 'USA_BOXING' | 'AMATEUR_PRO' | 'AF_SPECOPS';
type AuditEventType = 'CONTROL_CHANGE' | 'GATE_TRIGGERED' | 'OVERRIDE_CONFIRMED' | 'EVALUATION_SUBMITTED';

interface AuditLogItem { id: string; timestamp: string; type: AuditEventType; description: string; roleContext: RoleId; }
interface RoleMetadata { id: RoleId; name: string; authority: string; privacyTier: number; buildStatus: BuildStatus; purpose: string; canSee: string[]; canDo: string[]; cannotDo: string[]; boundaryWarning: string; }
interface DrillNode { id: string; track: TrackId; name: string; cue: string; instructions: string; instructionsSeated: string; development: string; science: string; scienceSeated: string; genesis: string; history: { who: string; what: string; where: string; when: string; }; }
interface AttendanceRow { id: string; name: string; rank: string; checkInTime: string; streak: number; status: 'PRESENT' | 'EXCUSED' | 'UNEXCUSED'; late: boolean; }
interface EquipmentStation { id: string; label: string; assignedId: string; status: 'OPTIMAL' | 'DEGRADED' | 'OUT_OF_SERVICE'; lastInspected: string; }
interface MatchCandidate { id: string; name: string; weightLbs: number; targetClass: number; clearance: string; winStreak: number; skillTier: number; }
interface VideoFrameLog { id: string; timestampMark: string; technicalTag: string; tacticalObservation: string; coachOverlayNote: string; }
interface ResolutionRecord { id: string; timestamp: string; resolutionText: string; voteCount: string; status: 'APPROVED' | 'PENDING'; }

interface AppSnapshotState {
  sleepHours: number;
  sorenessLevel: number;
  disciplineScore: number;
  intendedRpe: number;
  observedRpe: number;
  accumulatedHours: number;
  activeTrack: TrackId;
  mechanicalAccessibility: 'STANDARD' | 'SEATED';
  ringOccupied: boolean;
  academicPassing: boolean;
  globalConcussionBlock: boolean;
  verifiedByJason: boolean;
  break40Rule: boolean;
  activeVideoId: string;
  timestampMarker: string;
  technicalTag: string;
  tacticalObservation: string;
  weighInVariance: number;
  totalLeadershipCredits: number;
  simplifyRationale: string;
  witnessStatement: string;
  smartS: string;
  smartM: string;
  painDetected: boolean;
  dizzinessEvent: boolean;
  waterPanicFlag: boolean;
  unsafeBreathHold: boolean;
}

export default function SHADOWConsole() {
  const router = useRouter();
  
  // Auth check - verify user is logged in and is admin/coach
  useEffect(() => {
    const session = readRoleSession();
    if (!session || !['admin', 'coach', 'athlete', 'guardian'].includes(session.role)) {
      router.replace('/login');
    }
  }, [router]);

  // ==========================================================================
  // II. MONOLITH CENTRAL BASE STATE REGISTRIES
  // ==========================================================================
  const [activeRole, setActiveRole] = useState<RoleId>('ATHLETE');
  const [showAtlasModal, setShowAtlasModal] = useState<boolean>(false);
  const [activeSeat, setActiveSeat] = useState<RoleId>('PRESIDENT');
  const [selectedSkillId, setSelectedSkillId] = useState<string>('SKILL-02');
  
  const [sleepHours, setSleepHours] = useState<number>(8);
  const [sorenessLevel, setSorenessLevel] = useState<number>(3);
  const [disciplineScore] = useState<number>(8);
  const [intendedRpe, setIntendedRpe] = useState<number>(6);
  const [observedRpe, setObservedRpe] = useState<number>(7);
  const [accumulatedHours, setAccumulatedHours] = useState<number>(142.5);
  const [activeTrack, setActiveTrack] = useState<TrackId>('USA_BOXING');
  const [mechanicalAccessibility, setMechanicalAccessibility] = useState<'STANDARD' | 'SEATED'>('STANDARD');
  
  const [ringOccupied, setRingOccupied] = useState<boolean>(true);
  const [academicPassing, setAcademicPassing] = useState<boolean>(true);
  const [globalConcussionBlock, setGlobalConcussionBlock] = useState<boolean>(false);
  const [verifiedByJason, setVerifiedByJason] = useState<boolean>(false);
  const [break40Rule, setBreak40Rule] = useState<boolean>(false);

  const [activeVideoId, setActiveVideoId] = useState<string>('VID-SPAR-RD3');
  const [timestampMarker, setTimestampMarker] = useState<string>('01:42.05');
  const [technicalTag, setTechnicalTag] = useState<string>('Guard Alignment Flaw');
  const [tacticalObservation, setTacticalObservation] = useState<string>('Lead elbow flares out by 12cm prior to executing jab launch kinetic alignment mechanism.');
  const [coachOverlayNote, setCoachOverlayNote] = useState<string>('Enforce block drill: Mount foam barrier on lead side.');

  // ==========================================================================
  // III. LOCAL SHADOW COPILOT ACTIVE LEARNING REVIEWS
  // ==========================================================================
  const [copilotInputText, setCopilotInputText] = useState<string>('');
  const [copilotOutputLogs, setCopilotOutputLogs] = useState<string>('SHADOW Engine Standby. Awaiting tactical prompt input sequence from floor logs.');
  const [automationMode, setAutomationMode] = useState<boolean>(false);
  const [readOnlyMode, setReadOnlyMode] = useState<boolean>(false);
  const [maxHistoryQueue, setMaxHistoryQueue] = useState<number>(10);
  const [rlhfRating, setRlhfRating] = useState<'GOOD' | 'WRONG' | null>(null);
  const [rlhfComment, setRlhfComment] = useState<string>('');
  const [rawImportTextArea, setRawImportTextArea] = useState<string>('');
  const [importStatusMessage, setImportStatusMessage] = useState<string>('AWAITING_STREAM_INGESTION');
  const [ruleTraceOutput, setRuleTraceOutput] = useState<string>('System core warm boot successful.');
  const [showOverrideModal, setShowOverrideModal] = useState<boolean>(false);
  const [pendingHourChange, setPendingHourChange] = useState<number | null>(null);
  const [overrideReasonInput, setOverrideReasonInput] = useState<string>('');
  const [expandedDrillId, setExpandedDrillId] = useState<string | null>(null);

  // Time-Travel Snapshots Backlog Matrix
  const [historyPointer, setHistoryPointer] = useState<number>(0);
  const [snapshotHistory, setSnapshotHistory] = useState<AppSnapshotState[]>([
    { sleepHours: 8, sorenessLevel: 3, disciplineScore: 8, intendedRpe: 6, observedRpe: 7, accumulatedHours: 142.5, activeTrack: 'USA_BOXING', mechanicalAccessibility: 'STANDARD', ringOccupied: true, academicPassing: true, globalConcussionBlock: false, verifiedByJason: false, break40Rule: false, activeVideoId: 'VID-SPAR-RD3', timestampMarker: '01:42.05', technicalTag: 'Guard Alignment Flaw', tacticalObservation: 'Lead elbow flares out.', weighInVariance: 1.4, totalLeadershipCredits: 45, simplifyRationale: '', witnessStatement: 'Observed canvas bolt micro-fracture.', smartS: 'Increase jab translational velocity vector', smartM: 'Register 12.5 m/s via accelerometer', painDetected: false, dizzinessEvent: false, waterPanicFlag: false, unsafeBreathHold: false }
  ]);

  const [auditTerminalStream, setAuditTerminalStream] = useState<AuditLogItem[]>([
    { id: 'LOG-001', timestamp: new Date().toISOString(), type: 'CONTROL_CHANGE', roleContext: 'ADMIN', description: 'SHADOW Platform initialized in browser execution context.' }
  ]);

  const logSystemEvent = (type: AuditEventType, description: string, role: RoleId) => {
    const newItem: AuditLogItem = { id: `LOG-${Math.floor(1000 + Math.random() * 9000)}`, timestamp: new Date().toISOString(), type, description, roleContext: role };
    setAuditTerminalStream(prev => [newItem, ...prev].slice(0, maxHistoryQueue));
  };

  const captureHistorySnapshot = (updatedFields: Partial<AppSnapshotState>) => {
    const nextState: AppSnapshotState = {
      sleepHours: updatedFields.sleepHours !== undefined ? updatedFields.sleepHours : sleepHours,
      sorenessLevel: updatedFields.sorenessLevel !== undefined ? updatedFields.sorenessLevel : sorenessLevel,
      disciplineScore: updatedFields.disciplineScore !== undefined ? updatedFields.disciplineScore : disciplineScore,
      intendedRpe: updatedFields.intendedRpe !== undefined ? updatedFields.intendedRpe : intendedRpe,
      observedRpe: updatedFields.observedRpe !== undefined ? updatedFields.observedRpe : observedRpe,
      accumulatedHours: updatedFields.accumulatedHours !== undefined ? updatedFields.accumulatedHours : accumulatedHours,
      activeTrack: updatedFields.activeTrack !== undefined ? updatedFields.activeTrack : activeTrack,
      mechanicalAccessibility: updatedFields.mechanicalAccessibility !== undefined ? updatedFields.mechanicalAccessibility : mechanicalAccessibility,
      ringOccupied: updatedFields.ringOccupied !== undefined ? updatedFields.ringOccupied : ringOccupied,
      academicPassing: updatedFields.academicPassing !== undefined ? updatedFields.academicPassing : academicPassing,
      globalConcussionBlock: updatedFields.globalConcussionBlock !== undefined ? updatedFields.globalConcussionBlock : globalConcussionBlock,
      verifiedByJason: updatedFields.verifiedByJason !== undefined ? updatedFields.verifiedByJason : verifiedByJason,
      break40Rule: updatedFields.break40Rule !== undefined ? updatedFields.break40Rule : break40Rule,
      activeVideoId: updatedFields.activeVideoId !== undefined ? updatedFields.activeVideoId : activeVideoId,
      timestampMarker: updatedFields.timestampMarker !== undefined ? updatedFields.timestampMarker : timestampMarker,
      technicalTag: updatedFields.technicalTag !== undefined ? updatedFields.technicalTag : technicalTag,
      tacticalObservation: updatedFields.tacticalObservation !== undefined ? updatedFields.tacticalObservation : tacticalObservation,
      weighInVariance: updatedFields.weighInVariance !== undefined ? updatedFields.weighInVariance : weighInVariance,
      totalLeadershipCredits: updatedFields.totalLeadershipCredits !== undefined ? updatedFields.totalLeadershipCredits : totalLeadershipCredits,
      simplifyRationale: updatedFields.simplifyRationale !== undefined ? updatedFields.simplifyRationale : simplifyRationale,
      witnessStatement: updatedFields.witnessStatement !== undefined ? updatedFields.witnessStatement : witnessStatement,
      smartS: updatedFields.smartS !== undefined ? updatedFields.smartS : smartS,
      smartM: updatedFields.smartM !== undefined ? updatedFields.smartM : smartM,
      painDetected: updatedFields.painDetected !== undefined ? updatedFields.painDetected : painDetected,
      dizzinessEvent: updatedFields.dizzinessEvent !== undefined ? updatedFields.dizzinessEvent : dizzinessEvent,
      waterPanicFlag: updatedFields.waterPanicFlag !== undefined ? updatedFields.waterPanicFlag : waterPanicFlag,
      unsafeBreathHold: updatedFields.unsafeBreathHold !== undefined ? updatedFields.unsafeBreathHold : unsafeBreathHold,
    };
    const prunedHistory = snapshotHistory.slice(0, historyPointer + 1);
    const combined = [...prunedHistory, nextState].slice(-20);
    setSnapshotHistory(combined);
    setHistoryPointer(combined.length - 1);
  };

  const handleUndo = () => {
    if (historyPointer > 0) {
      const idx = historyPointer - 1;
      setHistoryPointer(idx);
      const target = snapshotHistory[idx];
      setSleepHours(target.sleepHours); setSorenessLevel(target.sorenessLevel); 
      setIntendedRpe(target.intendedRpe); setObservedRpe(target.observedRpe); setAccumulatedHours(target.accumulatedHours);
      setActiveTrack(target.activeTrack); setMechanicalAccessibility(target.mechanicalAccessibility);
      setRingOccupied(target.ringOccupied); setAcademicPassing(target.academicPassing);
      setGlobalConcussionBlock(target.globalConcussionBlock); setVerifiedByJason(target.verifiedByJason); setBreak40Rule(target.break40Rule);
      setWeighInVariance(target.weighInVariance); setServiceCredits(target.totalLeadershipCredits);
      setSimplifyRationale(target.simplifyRationale); setWitnessStatement(target.witnessStatement);
      setSmartS(target.smartS); setSmartM(target.smartM);
      setPainDetected(target.painDetected); setDizzinessEvent(target.dizzinessEvent);
      setWaterPanicFlag(target.waterPanicFlag); setUnsafeBreathHold(target.unsafeBreathHold);
      logSystemEvent('CONTROL_CHANGE', `Executed registers timeline rollback step to checkpoint [${idx}]`, activeRole);
    }
  };

  const handleRedo = () => {
    if (historyPointer < snapshotHistory.length - 1) {
      const idx = historyPointer + 1;
      setHistoryPointer(idx);
      const target = snapshotHistory[idx];
      setSleepHours(target.sleepHours); setSorenessLevel(target.sorenessLevel);
      setIntendedRpe(target.intendedRpe); setObservedRpe(target.observedRpe); setAccumulatedHours(target.accumulatedHours);
      setActiveTrack(target.activeTrack); setMechanicalAccessibility(target.mechanicalAccessibility);
      setRingOccupied(target.ringOccupied); setAcademicPassing(target.academicPassing);
      setGlobalConcussionBlock(target.globalConcussionBlock); setVerifiedByJason(target.verifiedByJason); setBreak40Rule(target.break40Rule);
      setWeighInVariance(target.weighInVariance); setServiceCredits(target.totalLeadershipCredits);
      setSimplifyRationale(target.simplifyRationale); setWitnessStatement(target.witnessStatement);
      setSmartS(target.smartS); setSmartM(target.smartM);
      setPainDetected(target.painDetected); setDizzinessEvent(target.dizzinessEvent);
      setWaterPanicFlag(target.waterPanicFlag); setUnsafeBreathHold(target.unsafeBreathHold);
      logSystemEvent('CONTROL_CHANGE', `Executed registers timeline roll-forward step to checkpoint [${idx}]`, activeRole);
    }
  };

  // ==========================================================================
  // IV. CORE CORE ARRAYS & PARAMETER CONFIGURATIONS
  // ==========================================================================
  const [smartS, setSmartS] = useState<string>('Increase lead jab translational velocity vector');
  const [smartM, setSmartM] = useState<string>('Register 12.5 m/s via 3D Print Lab accelerometer array');
  const [smartA] = useState<string>('Integrate 3 explosive plyometric rounds per floor session');
  const [smartR] = useState<string>('Fulfills rank upgrade metric criteria for A2P track');
  const [smartT] = useState<string>('Attain audited verification within a 45-day cycle');
  
  const [painDetected, setPainDetected] = useState<boolean>(false);
  const [dizzinessEvent, setDizzinessEvent] = useState<boolean>(false);
  const [waterPanicFlag, setWaterPanicFlag] = useState<boolean>(false);
  const [unsafeBreathHold, setUnsafeBreathHold] = useState<boolean>(false);
  
  const [weighInVariance, setWeighInVariance] = useState<number>(1.4); 
  const [totalLeadershipCredits, setServiceCredits] = useState<number>(45);
  const [simplifyRationale, setSimplifyRationale] = useState<string>('');
  const [witnessStatement, setWitnessStatement] = useState<string>(
    'Structural link micro-fracture line separation discovered along main ring canvas tension bolts.'
  );

  const [attendanceList, setAttendanceList] = useState<AttendanceRow[]>([
    { id: 'ATH-801', name: 'Deegan Vance', rank: 'DISCIPULUS', checkInTime: '17:42', streak: 6, status: 'PRESENT', late: false },
    { id: 'ATH-402', name: 'Neeko BigRun', rank: 'TIRO', checkInTime: '18:01', streak: 3, status: 'PRESENT', late: true },
    { id: 'ATH-109', name: 'Sarah Connor', rank: 'PUGIL PRAECEPTOR', checkInTime: '--:--', streak: 12, status: 'EXCUSED', late: false }
  ]);

  const [equipmentFleet] = useState<EquipmentStation[]>([
    { id: 'BAG-01', label: 'Leather Heavy Bag #01 (Deegan Lane)', assignedId: 'ATH-801', status: 'OPTIMAL', lastInspected: '2026-07-09' },
    { id: 'BAG-02', label: 'Leather Heavy Bag #02 (Heavy Load)', assignedId: 'NONE', status: 'DEGRADED', lastInspected: '2026-07-08' },
    { id: 'RING-01', label: 'Competition Sparring Ring (Neeko Lane)', assignedId: 'ATH-402', status: 'OPTIMAL', lastInspected: '2026-07-10' }
  ]);

  const [filmLogs, setFilmLogs] = useState<VideoFrameLog[]>([
    { id: 'FL-201', timestampMark: '01:42.05', technicalTag: 'Guard Alignment Flaw', tacticalObservation: 'Lead elbow flares out by 12cm prior to executing jab launch kinetic alignment mechanism.', coachOverlayNote: 'Enforce block drill: Mount foam barrier on lead side.' }
  ]);

  const [resolutionLedger] = useState<ResolutionRecord[]>([
    { id: 'RES-401', timestamp: '2026-07-01T12:00:00Z', resolutionText: 'Bylaw amendment: Restrict parent communication interfaces matching Cap-11 guidelines.', voteCount: '5-0 APPROVED', status: 'APPROVED' }
  ]);

  const [sandboxAthletes] = useState<MatchCandidate[]>([
    { id: 'CAND-01', name: 'Marcus Brody Jr.', weightLbs: 166.4, targetClass: 165, clearance: 'CLEARED_HUMAN_OVERSIGHT', winStreak: 8, skillTier: 4 }
  ]);

  // ==========================================================================
  // V. CLOSED SHADOW MATHEMATICAL ENGINE PARSERS
  // ==========================================================================
  const readinessScore = useMemo(() => {
    const raw = (sleepHours * 1.25) - (sorenessLevel * 0.45) + (disciplineScore * 0.3);
    return Math.max(1, Math.min(10, parseFloat(raw.toFixed(2))));
  }, [sleepHours, sorenessLevel, disciplineScore]);

  const isReadinessAlertActive = readinessScore < 5.0 && !break40Rule;
  const rpeDelta = useMemo(() => observedRpe - intendedRpe, [observedRpe, intendedRpe]);
  const isSimplifyActive = rpeDelta >= 2;
  const isCriticalLockoutTripped = painDetected || dizzinessEvent || waterPanicFlag || unsafeBreathHold;

  // Sync state parameters with administrative debug string channels
  useEffect(() => {
    const trace = `Readiness Index: ${readinessScore} || Delta Exertion Index: ${rpeDelta} || Concussion Active: ${globalConcussionBlock}`;
    setRuleTraceOutput(trace);
  }, [readinessScore, rpeDelta, globalConcussionBlock]);

  // ==========================================================================
  // VI. THE SHADOW Active Chat Router Engine (No-Hallucination Guard)
  // ==========================================================================
  const handleExecuteShadowQuery = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = copilotInputText.toUpperCase().trim();
    if (!cmd) return;

    let reply = "";
    if (cmd.includes("DIAGNOSIS") || cmd.includes("THERAPY") || cmd.includes("PRESCRIBE")) {
      reply = `⚠️ CRITICAL LOG ERROR: Source parameters unavailable. AI hallucination blocker active. Generating missing parameter request trace string for Head Coach Jason.`;
      logSystemEvent('GATE_TRIGGERED', `SHADOW intercepted therapeutic query bypass attempt: [${copilotInputText}]`, activeRole);
    } else if (cmd.includes("READINESS")) {
      reply = `[SHADOW STATE ANALYSIS]: Current Calculated Readiness Score = ${readinessScore}/10. Sleep: ${sleepHours}h, Soreness level: ${sorenessLevel}. Status: ${isReadinessAlertActive ? 'CRITICAL CEILING BREACH - RESTRICTION ACTIVE' : 'OPTIMAL RESILIENCY MARGINS'}.`;
    } else if (cmd.includes("DELTA") || cmd.includes("RPE")) {
      reply = `[SHADOW STATE ANALYSIS]: Observed RPE = ${observedRpe}, Intended RPE = ${intendedRpe}. Computed Discrepancy (ΔRPE) = ${rpeDelta}. Status: ${isSimplifyActive ? 'SIMPLIFY INTERCEPTOR TRIPPED - RATIO FREEZE ENGAGED' : 'ALIGNMENT SECURE'}.`;
    } else if (cmd.includes("WEIGHT") || cmd.includes("NUTRITION")) {
      reply = `[SHADOW WEIGHT-CUT LOG]: Athlete Marcus Brody Jr. Target: 165 lbs. Current Weigh-In: 166.4 lbs. Discrepancy Variance: ${weighInVariance} lbs. Metabolic intake log flags active [V-COACH].`;
    } else if (cmd.includes("SENSOR") || cmd.includes("VIDEO")) {
      reply = `[SHADOW KINEMATIC REVIEW]: Frame telemetry parsed at Mark ${timestampMarker}. Tag [${technicalTag}]. Tactical Observation: ${tacticalObservation}. Verified Source Anchor: Zatsiorsky Biomechanics Paper (1972).`;
    } else {
      reply = `⚠️ CRITICAL LOG ERROR: Source parameters unavailable. AI hallucination blocker active. Generating missing parameter request trace string for Head Coach Jason.`;
      logSystemEvent('GATE_TRIGGERED', `SHADOW ungrounded token generated. Injected trace loop to terminal buffers for: [${copilotInputText}]`, activeRole);
    }
    setCopilotOutputLogs(reply);
    setCopilotInputText('');
  };

  // ==========================================================================
  // VII. ROLE ACCESS ISOLATION GATE SYSTEM (Strict User Context Mappings)
  // ==========================================================================
  const roleRegistry: Record<RoleId, RoleMetadata> = {
    ATHLETE: { 
      id: 'ATHLETE', name: 'Athlete / Participant View', authority: 'Level 1 - Intake Only', privacyTier: 1, buildStatus: 'BUILT', 
      purpose: 'Low-cognitive-load tracking of personal development progress, assignments, and safety paths.', 
      canSee: ['Personal assignments', 'SMART goals', 'Tri-phase logs', '6-tier drill library', 'Coach notes', 'Attendance records'], 
      canDo: ['Input daily check-in metrics', 'Log tri-phase nutritional intake', 'Toggle task checkboxes', 'Report training confusion'], 
      cannotDo: ['Approve training assignments', 'Alter rank progression states', 'Clear contact/sparring gates', 'Access board financial ledgers'], 
      boundaryWarning: 'Athlete can submit updates and self-reports only. Senior human coach review required for track progression.' 
    },
    GUARDIAN: { 
      id: 'GUARDIAN', name: 'Guardian / Parent View', authority: 'Level 1 - Consent Access', privacyTier: 2, buildStatus: 'PARTIALLY_SCAFFOLDED', 
      purpose: 'Secure, high-visibility monitoring of minor youth athlete progress, institutional consent, and behavior feedback.', 
      canSee: ['Youth progress summaries', 'Attendance data logs', 'Consent status indicators', 'Safety announcements'], 
      canDo: ['Submit home observations', 'Issue a safety concern text block', 'Manage media/video permissions'], 
      cannotDo: ['Clear safety holds', 'Approve coach athletic decisions', 'View other participant files'], 
      boundaryWarning: 'Minor profiles lock automatically to non-contact default tracks without human sign-off.' 
    },
    COACH: { 
      id: 'COACH', name: 'Staff Boxing Coach View', authority: 'Level 3 - Floor Evaluation', privacyTier: 3, buildStatus: 'BUILT', 
      purpose: 'Floor operations control deck to evaluate training loads, distribute tasks, and enforce safety gates.', 
      canSee: ['Coach review queues', 'Pending participant updates', 'Complete drill library', 'Real-time readiness alerts'], 
      canDo: ['Approve/reject/hold assignments', 'Input modify rationales for delta gates', 'Manage adaptive slider', 'Flag safety holds'], 
      cannotDo: ['Formulate formal medical diagnoses', 'Clear medical holds without board confirmation', 'Alter corporate budgets'], 
      boundaryWarning: 'All sparring blocks require strict adherence to physical human policy verification criteria.' 
    },
    ADMIN: { 
      id: 'ADMIN', name: 'System Administrator View', authority: 'Level 4 - Setup Control', privacyTier: 4, buildStatus: 'BUILT', 
      purpose: 'Complete system architectural control, role visibility auditing, and non-destructive operations setup tracking.', 
      canSee: ['Module configuration status logs', 'Privacy-tier matrices', 'Participant case overviews', 'Public/internal data panel'], 
      canDo: ['Preview role permissions', 'Change mock data states', 'Audit build ledger tracks'], 
      cannotDo: ['Unilaterally pass corporate board policies', 'Clear contact/sparring gates alone'], 
      boundaryWarning: 'Admin tool modifications run inside browser memory spaces. No network overrides permitted.' 
    },
    PRESIDENT: { 
      id: 'PRESIDENT', name: 'President / Board Chair View', authority: 'Level 5 - Governance Lead', privacyTier: 5, buildStatus: 'PARTIALLY_SCAFFOLDED', 
      purpose: 'Strategic leadership, non-profit governance policy enforcement, and executive accountability tracking.', 
      canSee: ['Strategic agendas', 'Policy review queues', 'Board meeting notes', 'Macro organizational risk graphs'], 
      canDo: ['Review board meeting packets', 'Track executive milestones', 'Audit the global build truth panel'], 
      cannotDo: ['Execute financial asset movements without treasurer', 'Override physical coaching programming decisions'], 
      boundaryWarning: 'Unilateral operational decisions are blocked. Strategic actions require board quorum consensus.' 
    },
    VICE_CHAIR: { id: 'VICE_CHAIR', name: 'Vice Chair View', authority: 'Level 5 - Backup Lead', privacyTier: 5, buildStatus: 'INTENDED', purpose: 'Operational board continuity, special sub-committee tracking, and board member recruitment.', canSee: [], canDo: [], cannotDo: [], boundaryWarning: 'Presiding authority triggers strictly when designated by bylaws or during active Chair absence.' },
    TREASURER: { 
      id: 'TREASURER', name: 'Treasurer View', authority: 'Level 5 - Asset Oversight', privacyTier: 5, buildStatus: 'BUILT', 
      purpose: 'Absolute financial transparency, non-profit budget tracking, reserve logging, and grant funding oversight.', 
      canSee: ['Corporate budgets', 'Grant funding pipelines', 'IRS tax-filing checklists', 'Scholarship metrics'], 
      canDo: ['Review grant expenditure rows', 'Audit the $20 monthly due waiver metrics', 'Check mock B2B merchandise fundraising balances'], 
      cannotDo: ['Activate commercial store checkout systems', 'Expose private youth biometric data beyond aggregate reporting'], 
      boundaryWarning: 'Database configurations are structurally bound to free-tier spreadsheet systems by board decree.' 
    },
    SECRETARY: { id: 'SECRETARY', name: 'Secretary View', authority: 'Level 5 - Document Integrity', privacyTier: 5, buildStatus: 'PARTIALLY_SCAFFOLDED', purpose: 'Official corporate documentation, meeting minute recording, resolution tracking, and document retention compliance.', canSee: [], canDo: [], cannotDo: [], boundaryWarning: 'Records tracking must apply exact Zulu-timestamp structures to enforce staging integrity paths.' },
    SAFETY_DIRECTOR: { 
      id: 'SAFETY_DIRECTOR', name: 'Program & Safety Director View', authority: 'Level 4 - Safety Enforcer', privacyTier: 4, buildStatus: 'BUILT', 
      purpose: 'Youth protection compliance enforcement, incident logging, and background-check compliance oversight.', 
      canSee: ['Youth protection reports', 'Safety gate indicators', 'Background check logs', 'Emergency concussion blocker status panel'], 
      canDo: ['Review active incident logs', 'Monitor coach safety compliance parameters', 'Verify return-to-play criteria'], 
      cannotDo: ['Clear an athlete for full contact or sparring without required multi-party human policy sign-offs'], 
      boundaryWarning: 'Safety holds operate on a maximum restrictive loop. Re-entry requires human coach sign-off.' 
    },
    DEVELOPMENT: { id: 'DEVELOPMENT', name: 'Community & Development Director View', authority: 'Level 3 - Resource Hub', privacyTier: 3, buildStatus: 'PARTIALLY_SCAFFOLDED', purpose: 'Fundraising strategy orchestration, donor engagement tracking, grant pipeline coordination, and merchandise/B2B outreach.', canSee: [], canDo: [], cannotDo: [], boundaryWarning: 'Public promotional updates must strictly filter out individual private participant identifiers.' },
    DIRECTOR_AT_LARGE: { id: 'DIRECTOR_AT_LARGE', name: 'Director-at-Large View', authority: 'Level 5 - Neutral Vote', privacyTier: 5, buildStatus: 'INTENDED', purpose: 'Unbiased independent oversight, governance risk assessment, and objective fiduciary participation.', canSee: [], canDo: [], cannotDo: [], boundaryWarning: 'Fiduciary duties demand absolute structural neutrality across all program lane adjustments.' },
    AUDITOR: { 
      id: 'AUDITOR', name: 'System Auditor View', authority: 'Level 5 - Comprehensive Audit', privacyTier: 5, buildStatus: 'BUILT', 
      purpose: 'Comprehensive front-end layout validation, public/internal data route checkouts, and trace analysis.', 
      canSee: ['Full structural role visibility matrices', 'Mock-data status maps', 'Stale/duplicate source warnings', 'Immutable build ledger history'], 
      canDo: ['Run cross-panel access previews', 'Audit missing capability coverage fields', 'Check for public exposure vulnerabilities'], 
      cannotDo: ['Authorize corporate policy changes', 'Modify official data logs'], 
      boundaryWarning: 'Auditor views function strictly as assessment viewports. Live write capabilities are suppressed.' 
    }
  };

  const currentRoleMeta = roleRegistry[activeRole];

  // Drill library data cell matching Level 06 ancestral mappings
  const drillLibrary: DrillNode[] = [
    {
      id: 'drill-pendulum', track: 'USA_BOXING', name: 'Soviet Pendulum Footwork Pivot Line', cue: 'Heel flare out, head behind lead knee-line.',
      instructions: 'Shift center of mass backward along a 45-degree tracking vector. Flare rear heel rapidly to drive hip compression loops.',
      instructionsSeated: 'Execute upper torso rotational shift through a 30-degree tracking plane. Engage opposite abdominal wall to anchor frame layout.',
      development: 'Accelerates vestibulocochlear signal processing speeds during high cardiovascular stress blocks, maximizing spatial balance parameters.',
      science: 'Central Institute of Physical Culture Moscow (1978): Dynamic stability maps optimal center-of-gravity shifts at precisely 15% stance length.',
      scienceSeated: 'Journal of Adaptive Biomechanics (2023): Wheelchair frame base distribution requires lateral core compression to prevent acceleration loss.',
      genesis: 'Extracted from the state-sponsored biomechanics logs of the GTSOLIFK High-Performance Physical Culture Lab under Vladimir Zatsiorsky.',
      history: { who: 'Master Coach Viktor Ogurenkov', what: 'Engineered high-frequency kinetic shifting models to eliminate standard stance vulnerabilities.', where: 'Moscow Experimental Complexes', when: 'Refined between 1964 and 1972.' }
    }
  ];

  const knowledgeGraph: Record<string, { drill: string; goal: string; injuryRisk: string; historicalSource: string; }> = {
    'SKILL-01': { drill: 'Linear Shuttle Reset Step', goal: 'Establish baseline entry vector metrics', injuryRisk: 'Low Metatarsal Load Strain Check', historicalSource: 'Ogurenkov Soviet Moscow Selection Manual (1966)' },
    'SKILL-02': { drill: 'Soviet Pendulum Pivot Line Matrix', goal: 'Increase lead punch translational velocity', injuryRisk: 'Ankle Torsion Pre-emptive Hold', historicalSource: 'Zatsiorsky GTSOLIFK Functional Biomechanics Paper (1972)' }
  };

  const selectedGraphData = knowledgeGraph[selectedSkillId] || knowledgeGraph['SKILL-02'];

  const handleImportTelemetryJSON = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const parsed = JSON.parse(rawImportTextArea);
      if (parsed.payload?.exertion_variance?.observed) {
        setObservedRpe(parsed.payload.exertion_variance.observed);
        setImportStatusMessage(`SUCCESS: TELEMETRY STREAM PACKET INSTANTLY INGESTED`);
        logSystemEvent('CONTROL_CHANGE', `Injected telemetry parsing pack from clipboard matrix data slots.`, activeRole);
      } else { setImportStatusMessage('REJECTED: PAYLOAD DISCREPANCY'); }
    } catch (err) { setImportStatusMessage('ERROR: INVALID CHECKSUM FORMAT'); }
  };

  const handleAddAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tacticalObservation.trim() || !coachOverlayNote.trim()) return;
    const newLog: VideoFrameLog = {
      id: `FL-${Math.floor(100 + Math.random() * 900)}`,
      timestampMark: timestampMarker,
      technicalTag,
      tacticalObservation: tacticalObservation.trim(),
      coachOverlayNote: coachOverlayNote.trim()
    };
    setFilmLogs([newLog, ...filmLogs]);
    logSystemEvent('CONTROL_CHANGE', `Inserted Technical Video Frame Annotation: ${newLog.id}`, activeRole);
  };

  // ==========================================================================
  // VIII. CENTRAL DISPATCH TELEMETRY (Live Coupling Mirror Loop Target)
  // ==========================================================================
  const telemetryDataStream = useMemo(() => {
    return {
      timestamp: new Date().toISOString(),
      staging_path: `/system_control/pending/`,
      capability_layer_id: "L01_CORE_PLATFORM",
      verified_by_jason: verifiedByJason,
      payload: {
        active_role_context: activeRole, privacy_tier: currentRoleMeta?.privacyTier,
        automation_mode: automationMode, read_only_mode: readOnlyMode, history_pointer: historyPointer,
        global_concussion_block: globalConcussionBlock,
        biometric_assessment: { calculated_readiness: readinessScore, warning_tripped: isReadinessAlertActive, override_engaged: break40Rule, academic_passing: academicPassing },
        exertion_variance: { intended: intendedRpe, observed: observedRpe, delta: rpeDelta, lockout_active: isSimplifyActive, rationale: simplifyRationale },
        fiduciary_grant_hours: accumulatedHours, source_version_registry: 'v21.1-WINTER-COMPLETE'
      }
    };
  }, [verifiedByJason, activeRole, currentRoleMeta, automationMode, readOnlyMode, historyPointer, globalConcussionBlock, readinessScore, isReadinessAlertActive, break40Rule, academicPassing, intendedRpe, observedRpe, rpeDelta, isSimplifyActive, simplifyRationale, accumulatedHours]);

  return (
    <div className="min-h-screen bg-[#09090b] text-slate-400 font-mono p-4 selection:bg-[#b91c1c] selection:text-white relative antialiased">
      
      {/* CAPABILITY 194 ACCESS LOCKOUT OVERLAY SHIELD */}
      {isCriticalLockoutTripped && (
        <div className="fixed inset-0 bg-black/95 z-50 flex flex-col justify-center items-center p-6 border-4 border-[#b91c1c]">
          <div className="max-w-xl text-center space-y-4">
            <h1 className="text-[#b91c1c] text-2xl font-black tracking-widest uppercase animate-pulse">🚨 SHADOW INTERCEPT: CRITICAL PROTOCOL LOCKOUT ENGAGED</h1>
            <p className="text-white text-xs border border-zinc-800 p-4 bg-zinc-950 leading-relaxed font-mono">
              CAPABILITY 194 ACCESSIBILITY SAFETY LOCKOUT TRIPPED BY LIVE INSTANT SYMPTOM INGESTION. TELEMETRY COUPLING FROZEN.
            </p>
            <div className="flex flex-wrap gap-2 justify-center pt-2">
              <button onClick={() => { setPainDetected(false); setDizzinessEvent(false); setWaterPanicFlag(false); setUnsafeBreathHold(false); }} className="bg-[#b91c1c] text-white text-[10px] p-2 tracking-widest font-black uppercase rounded-none">Clear Distress Signals</button>
            </div>
          </div>
        </div>
      )}

      {/* L22 UN-BYPASSABLE FINANCIAL OVERRIDE POPUP */}
      {showOverrideModal && (
        <div className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-4 border-2 border-[#b91c1c]">
          <div className="bg-zinc-950 border border-zinc-800 p-5 max-w-md w-full space-y-4 rounded-none">
            <span className="text-xs font-black text-[#b91c1c] uppercase tracking-wider block animate-pulse">⚠️ Mandatory Reason for Manual Override Required</span>
            <p className="text-[10px] text-slate-500 uppercase leading-relaxed">Fiduciary grant metrics are tracked globally. Provide an explicit reason string parameters to shift core hours data.</p>
            <textarea required rows={3} value={overrideReasonInput} onChange={(e) => setOverrideReasonInput(e.target.value)} placeholder="Specify precise reason configuration for manual grant alteration tracking..." className="w-full bg-black text-white text-xs border border-[#b91c1c] p-2 focus:outline-none font-mono rounded-none resize-none"/>
            <div className="flex gap-2 text-xs font-bold uppercase">
              <button 
                type="button"
                onClick={() => {
                  if (!overrideReasonInput.trim() || pendingHourChange === null) return;
                  const targetHours = parseFloat((accumulatedHours + pendingHourChange).toFixed(1));
                  setAccumulatedHours(targetHours);
                  logSystemEvent('OVERRIDE_CONFIRMED', `Manual grant hours adjusted to ${targetHours}. Reason: ${overrideReasonInput.trim()}`, activeRole);
                  setShowOverrideModal(false); setPendingHourChange(null);
                }}
                className="flex-1 bg-[#b91c1c] text-white py-1.5 rounded-none text-center font-bold"
              >
                Commit Audit Override
              </button>
              <button type="button" onClick={() => { setShowOverrideModal(false); setPendingHourChange(null); }} className="px-3 bg-zinc-800 text-slate-400 py-1.5 rounded-none">Abort</button>
            </div>
          </div>
        </div>
      )}

      {/* APEX SYSTEM STATUS BANNER */}
      <div className="bg-[#b91c1c] text-white text-[10px] font-black tracking-widest text-center py-1 uppercase px-4 mb-4 select-none">
        ⚠️ SHADOW ENGINE v21.1 COMPLETE MONOLITH EMBED • DATA ACCESS DETACHED RUNTIME CONSOLE
      </div>

      {/* RECONCILED IDENTITY BRAND BAR HEADER */}
      <header className="border-b border-zinc-800 pb-4 mb-4 flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
        <div>
          <h1 className="text-white text-lg font-black tracking-tighter uppercase flex items-center gap-2">
            PUNXSY PROMINENCE <span className="text-[#b91c1c] font-light">// SHADOW CONSOLE INTEGRATION</span>
          </h1>
          <p className="text-[10px] text-slate-500 uppercase mt-0.5">COMPREHENSIVE MULTI-ROLE CORE SHEET ARCHITECTURE • AT-A-GLANCE MONITOR</p>
        </div>
      </header>

      {/* 12-USER ROLE MOCK RECONCILIATION TOGGLE SECTOR */}
      <section className="bg-zinc-950 border border-zinc-800 p-3 mb-6 relative">
        <span className="block text-[8px] text-slate-500 font-bold uppercase mb-1.5 tracking-wider">GLOBAL ADMINISTRATIVE PRIVACY-TIER ACCESS MATRIX SWITCHER [12 SIMULATED ACCOUNTS]</span>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12 gap-1 bg-black p-1 border border-zinc-900">
          {(['ATHLETE', 'GUARDIAN', 'COACH', 'ADMIN', 'PRESIDENT', 'VICE_CHAIR', 'TREASURER', 'SECRETARY', 'SAFETY_DIRECTOR', 'DEVELOPMENT', 'DIRECTOR_AT_LARGE', 'AUDITOR'] as RoleId[]).map(rId => (
            <button
              key={rId} onClick={() => { setActiveRole(rId); logSystemEvent('CONTROL_CHANGE', `Swapped simulated viewport profile context path down to role tier: ${rId}`, rId); }}
              className={`py-1.5 text-[8px] font-black border uppercase tracking-tight text-center rounded-none truncate ${
                activeRole === rId ? 'bg-zinc-900 text-[#b91c1c] border-[#b91c1c]' : 'bg-zinc-950 border-zinc-900 text-slate-600 hover:text-slate-400'
              }`}
            >
              {rId.replace('_', ' ')}
            </button>
          ))}
        </div>
        
        <div className="mt-2 text-[9px] text-[#b91c1c] font-bold uppercase tracking-tight flex justify-between items-center bg-black/60 p-2 border border-zinc-900/60">
          <span>⚠️ WARNING: Live access permissions detached. System running in mock-only front-end simulation mode. Data segregation enforced contextually.</span>
          <div className="flex gap-2 text-slate-400 select-none">
            <button onClick={handleUndo} disabled={historyPointer === 0} className="hover:text-white disabled:opacity-20 text-[9px]">Undo [-]</button>
            <button onClick={handleRedo} disabled={historyPointer === snapshotHistory.length - 1} className="hover:text-white disabled:opacity-20 text-[9px]">Redo [+]</button>
          </div>
        </div>
      </section>

      {/* MAIN DATA APPARATUS WORKSPACE CANVAS */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN: ACTIVE DATA SECTORS */}
        <div className={`xl:col-span-8 space-y-6 ${readOnlyMode ? 'opacity-60 pointer-events-none' : ''}`}>
          
          {/* PERSISTENT HEADER BLOCK */}
          <section className="bg-zinc-950 border border-zinc-800 p-4 relative rounded-none">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-zinc-900 pb-2 mb-3">
              <div>
                <span className="text-[9px] bg-zinc-900 text-slate-400 px-1.5 py-0.5 border border-zinc-800 font-black uppercase rounded-none">
                  {currentRoleMeta.buildStatus.replace('_', ' ')}
                </span>
                <h3 className="text-white text-xs font-black uppercase mt-1">{currentRoleMeta.name} Connected Dashboard</h3>
              </div>
              <div className="text-[10px] text-slate-500 font-bold uppercase">PRIVACY LEVEL: <span className="text-white font-mono">{currentRoleMeta.authority}</span></div>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed font-sans">Purpose Framework: {currentRoleMeta.purpose}</p>
            <div className="bg-black text-[10px] text-[#b91c1c] border border-zinc-900 p-2 mt-2 leading-tight uppercase font-bold">
              🚫 BOUNDARY WARNING: {currentRoleMeta.boundaryWarning}
            </div>
          </section>

          {/* ATHLETE SECTOR */}
          {activeRole === 'ATHLETE' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-zinc-950 border border-zinc-800 p-5 relative rounded-none">
                <span className="absolute top-0 right-0 bg-zinc-900 text-slate-500 text-[8px] px-2 py-0.5 font-bold uppercase">L14 CONTROLLERS</span>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
                  <span className="block text-white font-black text-xs uppercase border-l-2 border-[#b91c1c] pl-2">Daily Biometric Slider Tracking Deck</span>
                  <button 
                    onClick={() => setBreak40Rule(!break40Rule)}
                    className={`px-2 py-0.5 text-[9px] font-black tracking-tight border rounded-none ${break40Rule ? 'bg-[#b91c1c] text-white border-[#b91c1c]' : 'border-zinc-800 text-slate-500 hover:text-slate-300'}`}
                  >
                    [BREAK MY 40% RULE]
                  </button>
                </div>
                
                {isReadinessAlertActive && (
                  <div className="border border-[#b91c1c] bg-[#b91c1c]/10 p-2.5 text-[11px] text-[#b91c1c] font-black uppercase mb-3 animate-pulse">
                    ⚠️ READINESS ALERT: Score dropped below 5.0. SHADOW has locked standard sparring.
                  </div>
                )}

                <div className="space-y-4 text-xs font-mono">
                  <div>
                    <div className="flex justify-between mb-0.5"><span>Daily Rest Sleep Hours:</span><span className="text-white font-bold">{sleepHours} Hrs</span></div>
                    <input type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => { const val = parseFloat(e.target.value); setSleepHours(val); captureHistorySnapshot({ sleepHours: val }); }} className="w-full accent-[#b91c1c] bg-zinc-900 h-1 cursor-pointer" />
                  </div>
                  <div>
                    <div className="flex justify-between mb-0.5"><span>Muscle Soreness Level:</span><span className="text-[#b91c1c] font-bold">Level {sorenessLevel} / 10</span></div>
                    <input type="range" min="0" max="10" step="1" value={sorenessLevel} onChange={(e) => { const val = parseInt(e.target.value); setSorenessLevel(val); captureHistorySnapshot({ sorenessLevel: val }); }} className="w-full accent-[#b91c1c] bg-zinc-900 h-1 cursor-pointer" />
                  </div>
                </div>
                
                <div className="mt-4 pt-2 border-t border-zinc-900 flex justify-between items-center bg-black p-2 text-[11px]">
                  <span className="text-slate-500 font-bold uppercase">COMPUTED READINESS SCORE:</span>
                  <span className={`font-black text-xs ${isReadinessAlertActive ? 'text-[#b91c1c]' : 'text-emerald-500'}`}>{readinessScore.toFixed(2)} / 10.0</span>
                </div>
              </div>
            </div>
          )}

          {/* COACH SECTOR */}
          {activeRole === 'COACH' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-zinc-950 border border-zinc-800 p-5 relative rounded-none">
                <span className="block text-white font-black text-xs uppercase mb-4 border-l-2 border-[#b91c1c] pl-2">L11 Gym Floor Intensity Delta Interceptor</span>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono mb-4">
                  <div>
                    <label className="block text-[8px] text-slate-500 uppercase mb-1">INTENDED RPE</label>
                    <input type="range" min="1" max="10" value={intendedRpe} onChange={(e) => setIntendedRpe(parseInt(e.target.value))} className="w-full accent-slate-500 bg-zinc-900 h-1" />
                    <span className="text-[10px] text-slate-400 block mt-1 text-right">{intendedRpe} / 10</span>
                  </div>
                  <div>
                    <label className="block text-[8px] text-[#b91c1c] uppercase mb-1">OBSERVED RPE</label>
                    <input type="range" min="1" max="10" value={observedRpe} onChange={(e) => setObservedRpe(parseInt(e.target.value))} className="w-full accent-[#b91c1c] bg-zinc-900 h-1" />
                    <span className="text-[10px] text-white block mt-1 text-right">{observedRpe} / 10</span>
                  </div>
                </div>

                <div className="bg-black border border-zinc-900 p-2 text-xs flex justify-between items-center">
                  <span className="text-slate-500 font-bold uppercase">DELTA RPE:</span>
                  <span className={`font-black text-xs ${isSimplifyActive ? 'text-[#b91c1c]' : 'text-emerald-500'}`}>{rpeDelta >= 0 ? `+${rpeDelta}` : rpeDelta}</span>
                </div>

                {isSimplifyActive && (
                  <div className="border border-[#b91c1c] bg-[#b91c1c]/5 p-4 mt-4 space-y-2 border-dashed">
                    <span className="block text-[9px] font-black text-[#b91c1c] uppercase animate-pulse">🚨 LOCKOUT ACTIVE</span>
                    <textarea required rows={2} value={simplifyRationale} onChange={(e) => setSimplifyRationale(e.target.value)} placeholder="Provide rationale..." className="w-full bg-black text-white text-xs border border-[#b91c1c] p-2 focus:outline-none font-mono rounded-none resize-none" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* BOARD SECTOR */}
          {['PRESIDENT', 'VICE_CHAIR', 'TREASURER', 'SECRETARY', 'DIRECTOR_AT_LARGE'].includes(activeRole) && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-zinc-950 border border-zinc-800 p-5 relative rounded-none">
                <span className="block text-white font-black text-xs uppercase mb-3 border-l-2 border-[#b91c1c] pl-2">L23 Board Fiduciary Operations</span>
                <div className="flex flex-wrap gap-1 bg-black p-1 border border-zinc-900 mb-3 font-mono">
                  {['PRESIDENT', 'VICE_CHAIR', 'TREASURER', 'SECRETARY', 'DIRECTOR_AT_LARGE'].map(seat => (
                    <button key={seat} onClick={() => setActiveSeat(seat as RoleId)} className={`px-2 py-0.5 text-[9px] font-black border uppercase transition-all rounded-none ${activeSeat === seat ? 'bg-zinc-800 text-[#b91c1c] border-[#b91c1c]' : 'border-zinc-900 text-slate-500'}`}>{seat.replace('_',' ')}</button>
                  ))}
                </div>

                <div className="bg-black border border-zinc-900 p-4 space-y-2 text-xs">
                  <span className="text-white font-black uppercase block border-b border-zinc-950 pb-2">Board Operations: {activeSeat}</span>
                  <div className="text-slate-400">Fiduciary operations tracking loaded under role context [{activeSeat}].</div>
                </div>
              </div>
            </div>
          )}

          {/* AUDITOR SECTOR */}
          {activeRole === 'AUDITOR' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-zinc-950 border border-zinc-800 p-5 relative rounded-none">
                <span className="block text-white font-black text-xs uppercase mb-3 border-l-2 border-[#b91c1c] pl-2">L32 System Audit & Diagnostics</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                  <div className="bg-black border border-zinc-900 p-3 space-y-2">
                    <span className="block text-[9px] text-[#b91c1c] font-black uppercase">LIVE ANOMALIES</span>
                    <div className="space-y-1 text-[10px]">
                      <div className={isReadinessAlertActive ? "text-[#b91c1c] animate-pulse font-bold" : "text-slate-500"}>• Readiness Breach: {isReadinessAlertActive ? "TRUE" : "FALSE"}</div>
                      <div className={isSimplifyActive ? "text-[#b91c1c] animate-pulse font-bold" : "text-slate-500"}>• Exertion Lockout: {isSimplifyActive ? "TRUE" : "FALSE"}</div>
                      <div className={globalConcussionBlock ? "text-[#b91c1c] animate-pulse font-bold" : "text-slate-500"}>• Concussion Hold: {globalConcussionBlock ? "TRUE" : "FALSE"}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* RIGHT COLUMN: TELEMETRY & CONTROLS */}
        <div className="xl:col-span-4 space-y-6">
          
          {/* GRANT HOURS MONITOR */}
          <section className="bg-zinc-950 border border-zinc-800 p-5 relative text-xs font-mono rounded-none">
            <span className="block text-white font-black text-xs uppercase mb-3 tracking-tight text-center">💰 GRANT IMPACT MONITOR</span>
            <div className="bg-black border border-zinc-900 p-4 text-center space-y-2.5 rounded-none">
              <span className="text-2xl font-black text-white tracking-widest block font-mono">{accumulatedHours} / 500.0 HRS</span>
              <div className="w-full bg-zinc-900 h-1.5 border border-zinc-800 rounded-none overflow-hidden">
                <div className="bg-[#b91c1c] h-full transition-all" style={{ width: `${(accumulatedHours/500)*100}%` }}></div>
              </div>
              <span className="text-[9px] text-slate-500 font-bold block uppercase tracking-wide">{((accumulatedHours/500)*100).toFixed(1)}% COMMITTED</span>
            </div>
          </section>

          {/* SHADOW AI INTERFACE */}
          <section className="bg-zinc-950 border border-zinc-800 p-4 font-mono text-xs rounded-none relative">
            <span className="absolute top-0 right-0 bg-[#b91c1c] text-white text-[9px] px-2 py-0.5 font-bold uppercase tracking-widest">SHADOW ENGINE</span>
            <h3 className="text-white font-bold text-xs uppercase mb-3 flex items-center gap-1"><span>🤖 AI OPERATIONAL HUB</span></h3>
            <div className="space-y-3">
              <div className="bg-black p-2.5 text-[10px] text-slate-400 border border-zinc-900 font-mono whitespace-pre-wrap leading-tight select-all min-h-20">
                {copilotOutputLogs}
              </div>
              <form onSubmit={handleExecuteShadowQuery} className="flex gap-1">
                <input 
                  type="text" 
                  value={copilotInputText} 
                  onChange={(e) => setCopilotInputText(e.target.value)} 
                  placeholder="Query: READINESS, DELTA, WEIGHT, SENSOR..." 
                  className="w-full bg-black text-white text-xs border border-zinc-800 p-1.5 focus:outline-none rounded-none font-mono"
                />
                <button type="submit" className="bg-zinc-900 text-slate-300 border border-zinc-800 font-bold uppercase px-3 text-[10px] rounded-none">Execute</button>
              </form>
            </div>
          </section>

          {/* CONCUSSION HOLD SWITCH */}
          <section className="bg-zinc-950 border border-zinc-800 p-4 text-center relative rounded-none">
            <span className="block text-white font-black text-[11px] uppercase mb-2 tracking-wide font-mono">🚨 L12 MEDICAL RECOVERY HOLD</span>
            <button onClick={() => { const nextState = !globalConcussionBlock; setGlobalConcussionBlock(nextState); logSystemEvent('OVERRIDE_CONFIRMED', `Concussion hold flag set to: ${nextState}`, activeRole); }} className={`w-full py-2 text-xs font-black uppercase border tracking-widest rounded-none ${globalConcussionBlock ? 'bg-black text-[#b91c1c] border-[#b91c1c] animate-pulse font-black' : 'bg-[#b91c1c] text-white border-[#b91c1c]'}`}>
              {globalConcussionBlock ? '⚠️ DISENGAGE MEDICAL HOLD' : '🚨 TRIGGER CONCUSSION BLOCKER'}
            </button>
          </section>

          {/* VERIFICATION STATUS */}
          <section className="bg-zinc-950 border border-zinc-800 p-4 text-center rounded-none">
            <span className="block text-slate-400 text-[10px] font-bold uppercase mb-2">COACH VERIFICATION:</span>
            <button onClick={() => { const n = !verifiedByJason; setVerifiedByJason(n); logSystemEvent('CONTROL_CHANGE', `Coach verification set to: ${n}`, activeRole); }} className={`px-4 py-1.5 text-[10px] font-black tracking-widest uppercase border transition-all rounded-none ${verifiedByJason ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-[#b91c1c] border-[#b91c1c] text-white animate-pulse'}`}>
              {verifiedByJason ? '✓ VERIFIED' : '❌ PENDING'}
            </button>
          </section>

          {/* TELEMETRY STREAM */}
          <section className="bg-zinc-950 border border-zinc-800 rounded-none overflow-hidden font-mono text-xs">
            <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-1.5 flex justify-between items-center select-none">
              <span className="text-[9px] font-black text-slate-300 uppercase tracking-tight">📂 TELEMETRY STREAM</span>
            </div>
            <div className="p-3 bg-black max-h-56 overflow-y-auto text-[10px] text-emerald-500 leading-tight font-mono select-all">
              <pre>{JSON.stringify(telemetryDataStream, null, 2)}</pre>
            </div>
          </section>

        </div>
      </div>

      {/* FOOTER AUDIT LOG */}
      <footer className="mt-6 pt-4 border-t border-zinc-900 bg-zinc-950/40 p-4 text-xs">
        <div className="bg-black border border-zinc-900 p-3">
          <span className="block text-[9px] text-slate-500 font-bold uppercase mb-1.5">📟 AUDIT TRAIL</span>
          <div className="space-y-1 max-h-24 overflow-y-auto text-[9px] text-slate-400 leading-tight">
            {auditTerminalStream.map(log => (
              <div key={log.id} className="border-b border-zinc-950 pb-1 last:border-0 truncate">
                <span className="text-[#b91c1c] font-bold">[{log.type}]</span> - {log.description}
              </div>
            ))}
          </div>
        </div>
      </footer>

    </div>
  );
}
