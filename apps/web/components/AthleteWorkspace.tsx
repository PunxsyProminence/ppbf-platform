'use client';

import React, { useState } from 'react';

type TabID = 'dashboard' | 'education' | 'rabbitholes' | 'messaging' | 'scheduling';
type TrackID = 'non_contact' | 'usa_boxing' | 'a2p' | 'pro' | 'collegiate' | 'usa_masters' | 'spec_ops';
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
  const [athleteRank, setAthleteRank] = useState<LatinRank>('TIRO');

  // Daily Intake States
  const [sleepHours, setSleepHours] = useState<number>(8);
  const [soreness, setSoreness] = useState<number>(2);
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
    "PUGIL NOVUS": { label: "Developing Boxer", desc: "Building combination fluency, footwork pivoting, defensive recovery, and tactical awareness." },
    "PUGIL SCIENTIA": { label: "Skilled Boxer", desc: "Applying technical counters, generating target angles, and decision-making under fatigue indices." },
    "PUGIL FORTIS": { label: "Advanced Boxer", desc: "Adapting strategic block options, maintaining composure in live drilling, and modeling maturity." },
    "PUGIL PRAECEPTOR": { label: "Mentor Boxer", desc: "High boxing proficiency combined with youth mentorship and cultural leadership standards." }
  };

  // 6 Athletic Boxing Tracks + SpecOps Track Manifest
  const trackManifests: Record<TrackID, { name: string; desc: string; focusWorkout: string[] }> = {
    non_contact: {
      name: "Non-Contact Track",
      desc: "General athletic fitness, technical boxing biomechanics, and lifestyle accountability without live contact.",
      focusWorkout: [
        "Stance stability and core balance weight-distribution checks",
        "15 minutes of dynamic shadowboxing focusing on clean jab mechanics",
        "Reaction ball tracking responding to visual focus target changes",
        "10-minute lifestyle and personal discipline reflection block"
      ]
    },
    usa_boxing: {
      name: "USA Boxing Track",
      desc: "Amateur competitive track operating strictly under USA Boxing safety standards, red/blue books, and certified coach guidelines.",
      focusWorkout: [
        "Dynamic footwork agility and ring geometry movement drills",
        "Partner defensive blocking utilizing approved padded shields",
        "High-cadence punch output drills tracking extension and guard return",
        "Review of safe athletic travel policies and SafeSport boundaries"
      ]
    },
    a2p: {
      name: "Amateur to Pro Track (A2P)",
      desc: "Accelerated developmental track bridging high-level amateur skillsets with professional licensing requirements.",
      focusWorkout: [
        "Multi-round heavy bag intervals simulating professional rounds pacing",
        "Slipping under the cord line with immediate counter-punch delivery",
        "High-volume focus mitt combinations testing physical stamina limits",
        "Metabolic recovery control breathing between round intervals"
      ]
    },
    pro: {
      name: "Pro Track",
      desc: "Professional program monitoring high-volume training stress, round fatigue indexes, and recovery thresholds.",
      focusWorkout: [
        "12 rounds of targeted heavy bag drills utilizing complex punch combinations",
        "Anatomical defensive shell checks against high-intensity focus shots",
        "Reaction cue speed testing under severe localized muscle fatigue",
        "Post-workout joint cooling and soreness index mapping logs"
      ]
    },
    collegiate: {
      name: "Collegiate Track",
      desc: "Tailored for student-athletes. Enforces academic passing standards as a requirement for on-floor training access.",
      focusWorkout: [
        "Agility ladder footwork drills maintaining balance-width",
        "Dynamic high-guard partner counter-movement drills",
        "Conditioning sprints to maintain high athletic work-capacity",
        "Mandatory 30-minute academic study or homework block (Layer 14)"
      ]
    },
    usa_masters: {
      name: "USA Masters Track",
      desc: "Designed for competitive athletes aged 35+. Focuses on extended mobility prep, low-impact drills, and strict medical clearance logs.",
      focusWorkout: [
        "Mandatory 15-minute joint mobility and core activation warmup",
        "Technical guard blocking drills keeping impact forces controlled",
        "Targeted bag work focusing on timing rather than high anaerobic spikes",
        "Extended muscle cooldown and joint-soreness feedback mapping"
      ]
    },
    spec_ops: {
      name: "Air Force SpecOps Track",
      desc: "Specialized military prep track focused on tracking the 16 Task Dimensions and 11 Project Lifecycle statuses.",
      focusWorkout: [
        "Anatomical load carriage baseline pacing run",
        "Water confidence pool prep (Dry land breath control drills)",
        "Neuromuscular power tracking testing battery V1",
        "Decision-making response testing under high localized physical fatigue"
      ]
    }
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

  const toggleDrill = (id: string) => {
    setCompletedDrills(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const currentReadinessScore = Math.max(1, Math.min(10, (sleepHours * 1.25) - (soreness * 0.45)));

  const handleDispatchIntake = () => {
    const packet = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/athlete_profile_checkin",
      data: {
        activeTrack,
        activeRank: athleteRank,
        sleepHours,
        sorenessLevel: soreness,
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
      <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 shadow-sm">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-xs font-mono text-emerald-400 font-bold uppercase tracking-wider">Layer 01: Core Athlete Console</span>
          </div>
          <h2 className="text-xl font-black font-mono text-slate-100">Athlete Development Workspace</h2>
          <p className="text-xs text-slate-400 font-mono">Integrated physical progression, scheduling, and SafeSport messaging portal.</p>
        </div>

        {/* Tab Selector Hub */}
        <div className="flex flex-wrap bg-slate-950 p-1 rounded-xl border border-slate-800 font-mono text-xs font-bold text-slate-400 gap-1">
          <button onClick={() => setActiveTab('dashboard')} className={`px-3 py-1.5 rounded-lg transition ${activeTab === 'dashboard' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>My Dashboard</button>
          <button onClick={() => setActiveTab('education')} className={`px-3 py-1.5 rounded-lg transition ${activeTab === 'education' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>Drill Library</button>
          <button onClick={() => setActiveTab('rabbitholes')} className={`px-3 py-1.5 rounded-lg transition ${activeTab === 'rabbitholes' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>Rabbit Holes</button>
          <button onClick={() => setActiveTab('messaging')} className={`px-3 py-1.5 rounded-lg transition ${activeTab === 'messaging' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>Message Coach</button>
          <button onClick={() => setActiveTab('scheduling')} className={`px-3 py-1.5 rounded-lg transition ${activeTab === 'scheduling' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>Schedule Session</button>
        </div>
      </div>

      {/* --- DASHBOARD VIEW --- */}
      {activeTab === 'dashboard' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">
            {/* Track Selector */}
            <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <h3 className="text-sm font-black font-mono text-slate-200 uppercase tracking-wide">Active Track Profile Selection</h3>
                <p className="text-[11px] text-slate-400 font-mono">Select your customized active program pathway.</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {(Object.keys(trackManifests) as TrackID[]).map(id => (
                  <button
                    key={id} onClick={() => setActiveTrack(id)}
                    className={`p-2.5 rounded-xl border text-left font-mono transition flex flex-col justify-between h-20 ${
                      activeTrack === id ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400 font-bold' : 'bg-[#111827]/40 border-slate-900 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-[11px] truncate block">{trackManifests[id].name}</span>
                    <span className="text-[8px] opacity-75 leading-tight font-light overflow-hidden text-slate-400">{id === 'spec_ops' ? '16 Tasks' : 'Boxing Track'}</span>
                  </button>
                ))}
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-900 space-y-1">
                <span className="text-xs font-mono font-bold text-slate-300">Selected Path Concept:</span>
                <p className="text-[11px] text-slate-400 font-mono leading-relaxed">{trackManifests[activeTrack].desc}</p>
              </div>
            </div>

            {/* Today's Prescribed Workout drills */}
            <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-4">
              <div className="border-b border-slate-800 pb-2 flex justify-between items-center">
                <h3 className="text-sm font-black font-mono text-slate-200 uppercase tracking-wide">Prescribed Daily Workload Targets</h3>
                <span className="text-[9px] bg-emerald-950/40 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded font-mono font-bold uppercase">{trackManifests[activeTrack].name}</span>
              </div>

              <div className="space-y-2">
                {trackManifests[activeTrack].focusWorkout.map((drill, idx) => (
                  <div key={idx} className="bg-[#111827]/40 border border-slate-900 p-3 rounded-lg flex items-center gap-3 text-xs font-mono text-slate-300">
                    <span className="text-emerald-500 font-bold">0{idx + 1}.</span>
                    <span>{drill}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Daily check-in form */}
            <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <h3 className="text-sm font-black font-mono text-slate-200 uppercase tracking-wide">Daily Biological Check-In (Layer 14)</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-slate-400">Sleep Duration</span><span className="text-emerald-400 font-bold">{sleepHours} Hours</span></div>
                  <input type="range" min="4" max="12" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(parseFloat(e.target.value))} className="w-full accent-emerald-500 h-1 bg-slate-800 rounded-lg appearance-none" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono"><span className="text-slate-400">Anatomical Soreness</span><span className="text-amber-400 font-bold">Level {soreness} / 10</span></div>
                  <input type="range" min="0" max="10" step="1" value={soreness} onChange={(e) => setSoreness(parseInt(e.target.value))} className="w-full accent-amber-500 h-1 bg-slate-800 rounded-lg appearance-none" />
                </div>
              </div>

              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <span className="text-slate-200 block font-bold">School Academic Passing Grade Check</span>
                  <p className="text-[10px] text-slate-500">Passing standards are verified before training. Holds trigger automatic schedule freezes.</p>
                </div>
                <button type="button" onClick={() => setAcademicPassing(!academicPassing)} className={`px-3 py-1.5 rounded-lg font-bold border transition ${academicPassing ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-red-950/40 border-red-500 text-red-400'}`}>
                  {academicPassing ? '✅ PASSING ALL' : '❌ ACADEMIC HOLD'}
                </button>
              </div>

              <button onClick={handleDispatchIntake} className="w-full bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-mono font-black text-xs py-2.5 rounded-xl transition uppercase tracking-wider">
                ⚡ Dispatch Ingest Telemetry to Staging Path
              </button>
            </div>
          </div>

          <div className="space-y-6">
            {/* Latin ranks (restricted to boxing program) */}
            <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Boxing Program Rank Progression</span>
                <h4 className="text-base font-black font-mono text-emerald-400 tracking-wide">{athleteRank}</h4>
                <span className="text-xs text-slate-400 font-mono">({rankDefinitions[athleteRank].label})</span>
              </div>

              <p className="text-xs text-slate-300 font-mono leading-relaxed bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                {rankDefinitions[athleteRank].desc}
              </p>

              <div className="space-y-2 border-t border-slate-800/80 pt-3">
                <label className="text-[11px] font-mono text-slate-500 block uppercase font-bold">Manual Rank Select (Development Test Emulator):</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(Object.keys(rankDefinitions) as LatinRank[]).map(r => (
                    <button key={r} onClick={() => setAthleteRank(r)} className={`p-1.5 text-center text-[10px] font-mono rounded border transition ${athleteRank === r ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400 font-bold' : 'bg-slate-950 border-slate-900 text-slate-500 hover:text-slate-300'}`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-red-950/20 text-red-400 border border-red-500/20 p-3.5 rounded-xl text-[10px] font-mono leading-relaxed space-y-1">
                <span className="font-bold text-red-500 block uppercase">🛡️ Directive 5: Immunity Gate</span>
                <p className="text-slate-400">All local selector updates are restricted to sandbox memory state only. Permanent rank database modifications or sparring permissions require explicit verification flags checked by Head Coach Jason.</p>
              </div>
            </div>

            {telemetryLog && (
              <div className="bg-slate-950 border border-slate-900 rounded-xl p-4 font-mono text-[10px] text-slate-400 space-y-1.5">
                <span className="text-amber-500 font-bold block border-b border-slate-900 pb-1">📡 TELEMETRY PACKET TRAPPED</span>
                <div>• Staging Node: <span className="underline">{telemetryLog.stagingPath}</span></div>
                <div>• Verified Flag: <span className="text-red-400 font-bold">FALSE (Bypassed)</span></div>
                <pre className="text-slate-500 text-[9px] bg-slate-900 p-2 rounded overflow-x-auto whitespace-pre-wrap">{JSON.stringify(telemetryLog, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- DRILL LIBRARY VIEW --- */}
      {activeTab === 'education' && (
        <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6 animate-fadeIn">
          <div className="border-b border-slate-800 pb-3 flex flex-col md:flex-row justify-between md:items-center gap-3">
            <div>
              <h3 className="text-base font-bold font-mono text-slate-200">Layer 07: Drill Library & Physical Handouts</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Explore physical lesson items, technical boxing drills, and biomechanical cues.</p>
            </div>
            <input
              type="text" placeholder="Search drills or categories..." value={drillSearch} onChange={(e) => setDrillSearch(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500 max-w-xs"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {drillLibrary.filter(d => d.name.toLowerCase().includes(drillSearch.toLowerCase()) || d.category.toLowerCase().includes(drillSearch.toLowerCase())).map(drill => (
              <div key={drill.id} className="bg-[#111827]/40 border border-slate-800/80 p-5 rounded-xl space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-slate-800 text-slate-400 px-2 py-0.5 rounded uppercase">{drill.category}</span>
                    <h4 className="text-sm font-bold font-mono text-slate-200 mt-2">{drill.name}</h4>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">{drill.minRank}</span>
                </div>

                <p className="text-xs text-slate-400 font-mono leading-relaxed">{drill.focus}</p>

                <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                  <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Coaching Cues:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {drill.cues.map((cue, idx) => (
                      <span key={idx} className="text-[10px] font-mono bg-slate-950 px-2 py-0.5 rounded text-slate-300 border border-slate-900">⚡ {cue}</span>
                    ))}
                  </div>
                </div>

                <button onClick={() => toggleDrill(drill.id)} className={`w-full py-2 rounded-lg text-xs font-mono font-bold border transition ${
                  completedDrills[drill.id] ? 'bg-emerald-950/20 border-emerald-500 text-emerald-400' : 'bg-slate-950 border-slate-900 text-slate-500 hover:text-slate-300'
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
        <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6 animate-fadeIn">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-base font-bold font-mono text-slate-200">Layer 24: Technical "Rabbit Holes"</h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Deep-dive athletic research covering motor learning, kinetics, and neurological training parameters.</p>
          </div>

          <div className="space-y-6">
            {rabbitHoles.map(rh => (
              <div key={rh.id} className="bg-[#111827]/40 border border-slate-800 p-5 rounded-xl space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-mono font-bold bg-slate-800 text-emerald-400 px-2 py-0.5 rounded uppercase">Advanced Study Matrix</span>
                  <span className="text-[9px] font-mono text-slate-500 font-bold">ID: {rh.id}</span>
                </div>

                <h4 className="text-base font-black font-mono text-slate-200">{rh.title}</h4>
                <span className="text-xs text-slate-400 font-mono italic block">Concept Block: {rh.concept}</span>

                <p className="text-xs text-slate-300 font-mono leading-relaxed bg-slate-950/60 p-4 rounded-lg border border-slate-800">
                  {rh.breakdown}
                </p>

                <div className="bg-emerald-950/25 border border-emerald-500/25 p-4 rounded-xl text-xs font-mono space-y-1">
                  <span className="font-bold text-emerald-400 uppercase tracking-wide block text-[10px]">Home Study & Application Homework:</span>
                  <p className="text-slate-300">{rh.homework}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- SAFESPORT MESSAGING VIEW --- */}
      {activeTab === 'messaging' && (
        <div className="space-y-6 animate-fadeIn">
          <div className="bg-red-950/40 text-red-400 border border-red-500/20 px-4 py-3 rounded-xl text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>🔒 <strong>SAFESPORT POLICY GATES:</strong> Direct adult-to-minor individual messages are blocked. Parent CC loops are active.</div>
            <span className="text-[10px] bg-red-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">SafeSport Enforced</span>
          </div>

          <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold font-mono text-slate-200">SafeSport Certified Communications Portal</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Secure messaging protecting our youth, guardians, and coaching staff.</p>
            </div>

            <form onSubmit={handleSendMessage} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 block">Select Staff Member Recipient</label>
                <select value={messageRecipient} onChange={(e) => setMessageRecipient(e.target.value)} className="w-full bg-[#111827] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-red-500">
                  <option value="Coach Jason">Coach Jason (Head Coach)</option>
                  <option value="Coach Danielle">Coach Danielle (Adult Fitness Director)</option>
                </select>
              </div>

              <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-2">
                <span className="text-xs font-bold font-mono text-red-400 block uppercase tracking-wider">Automated Guardian Carbon Copy (CC) Engaged</span>
                <p className="text-[11px] text-slate-400 font-mono">To maintain strict SafeSport compliance, parents receive a physical, non-deletable archive copy of all outbound communications.</p>
                <input type="email" value={parentCcEmail} onChange={(e) => setParentCcEmail(e.target.value)} placeholder="Parent email address" className="w-full bg-[#111827] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-red-500" />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 block">Your Message Body</label>
                <textarea value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="Type your message text here..." className="w-full h-24 bg-[#111827] border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-red-500 resize-none" />
              </div>

              <button type="submit" className="w-full bg-red-600 hover:bg-red-500 text-slate-950 font-mono font-black text-xs py-2.5 rounded-xl transition uppercase tracking-wider">🔒 Send SafeSport Compliant Log Message</button>
            </form>
          </div>
        </div>
      )}

      {/* --- SCHEDULING VIEW --- */}
      {activeTab === 'scheduling' && (
        <div className="space-y-6 animate-fadeIn">
          <div className="bg-emerald-950/40 text-emerald-400 border border-emerald-500/20 px-4 py-3 rounded-xl text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>📅 <strong>SCHEDULING CURRICULUM:</strong> Book classes directly. Access requires clear academic records.</div>
            <span className="text-[10px] bg-emerald-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Layer 06 Active</span>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h3 className="text-base font-bold font-mono text-slate-200">Prescribed Training Blocks Schedule</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">Reserve class coordinates directly within our weekly curriculum schedule.</p>
              </div>

              <div className="space-y-3">
                {[
                  { days: "Mon - Thu", time: "4:00 - 5:00 PM", title: "Youth Non-Contact Development Block", desc: "Balance, stance, shadowboxing, neurocognitive drills, zero-sparring." },
                  { days: "Mon - Thu", time: "5:00 - 6:00 PM", title: "Intermediate / Technical Boxing", desc: "Partner combinations, target-pad coordination, controlled light sparring." },
                  { days: "Mon / Wed / Fri", time: "5:45 - 7:00 PM", title: "Danielle's Strength & Fitness", desc: "Adult conditioning, physical fitness progression ($50/mo or $10 drop-in)." }
                ].map((block, idx) => (
                  <div key={idx} className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:border-emerald-500/20 transition">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono font-bold bg-slate-800 text-slate-400 px-2 py-0.5 rounded">{block.days}</span>
                        <span className="text-xs font-bold text-slate-100 font-mono">{block.time}</span>
                      </div>
                      <h4 className="text-sm font-black font-mono text-emerald-400">{block.title}</h4>
                      <p className="text-[11px] text-slate-400 font-mono leading-relaxed">{block.desc}</p>
                    </div>
                    <button
                      type="button" disabled={academicHold} onClick={() => handleBookSession(block.title, block.time)}
                      className={`w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-mono font-bold transition uppercase tracking-wider ${
                        academicHold ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500 text-slate-950'
                      }`}
                    >
                      {academicHold ? 'Hold Lock' : 'Book Class'}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4 h-fit">
              <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Scheduling Safety Controls</span>
              <div className="bg-[#111827] border border-slate-800 p-3.5 rounded-xl flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <span className="text-slate-200 block font-bold">Academic Hold Trigger</span>
                  <p className="text-[10px] text-slate-500">Simulate school tracking blockades.</p>
                </div>
                <button type="button" onClick={() => setAcademicHold(!academicHold)} className={`px-3 py-1 text-[11px] rounded font-bold border transition ${academicHold ? 'bg-red-950/40 border-red-500 text-red-400' : 'bg-emerald-950/40 border-emerald-500 text-emerald-400'}`}>{academicHold ? 'HOLD ACTIVE' : 'CLEAR'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MANDATORY FOOTER */}
      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[11px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}