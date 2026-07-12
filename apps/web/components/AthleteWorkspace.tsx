'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  athleteProfiles,
  loadTrackAssignments,
  readActiveAthleteProfileId,
  trackManifests,
  type TrackID,
} from './trackAssignments';

type TabID = 'dashboard' | 'education' | 'rabbitholes' | 'messaging' | 'scheduling';
type LatinRank = 'TIRO' | 'DISCIPULUS' | 'PUGIL NOVUS' | 'PUGIL SCIENTIA' | 'PUGIL FORTIS' | 'PUGIL PRAECEPTOR';

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

export default function AthleteWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [activeTrack, setActiveTrack] = useState<TrackID>('non_contact');
  const [assignedTrackIds, setAssignedTrackIds] = useState<TrackID[]>(['non_contact']);
  const [activeAthleteProfileId, setActiveAthleteProfileId] = useState(athleteProfiles[0].id);
  const [showTrackCatalog, setShowTrackCatalog] = useState(false);
  const [athleteRank, setAthleteRank] = useState<LatinRank>('TIRO');

  // Daily Intake States
  const [sleepHours, setSleepHours] = useState<number>(8);
  const [soreness, setSoreness] = useState<number>(2);
  const [motivation, setMotivation] = useState<number>(7);
  const [rpeGoal, setRpeGoal] = useState<number>(6);
  const [workloadOverrideLevel, setWorkloadOverrideLevel] = useState<number>(0);
  const [sorenessLocations, setSorenessLocations] = useState<string[]>([]);
  const [academicPassing, setAcademicPassing] = useState<boolean>(true);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});
  const [drillSearch, setDrillSearch] = useState<string>('');
  const [telemetryLog, setTelemetryLog] = useState<any | null>(null);

  // SafeSport Messaging States
  const [messageRecipient, setMessageRecipient] = useState<string>("Coach Jason");
  const [messageText, setMessageText] = useState<string>("");
  const [parentCcEmail, setParentCcEmail] = useState<string>("parent.guardian@family.com");

  // Booking States
  const [academicHold, setAcademicHold] = useState<boolean>(false);

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
                <span className="text-xs font-mono text-[#e8d7c6] font-bold">Soreness location mapping</span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {sorenessAreaOptions.map((location) => {
                    const selected = sorenessLocations.includes(location);
                    return (
                      <button
                        key={location}
                        type="button"
                        onClick={() => toggleSorenessLocation(location)}
                        className={`border-2 px-2 py-1.5 text-[11px] font-mono text-left transition ${selected ? 'border-[#d4a574] bg-[#5a2a2a]/30 text-[#8b4444]' : 'border-[#8b4444] bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6]'}`}
                      >
                        {location}
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
        <div className="bg-[#0a0a0a] border-2 border-[#8b0000] p-6 space-y-6 animate-fadeIn">
          <div className="border-b border-[#4a4a4a] pb-3 flex flex-col md:flex-row justify-between md:items-center gap-3">
            <div>
              <h3 className="text-base font-bold font-mono text-[#e5e5e5]">Layer 07: Drill Library & Physical Handouts</h3>
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

      {/* MANDATORY FOOTER */}
      <div className="bg-[#0f0f0f]/60 border-2 border-[#8b4444] p-4 text-[11px] font-mono text-[#8a8a8a] text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}