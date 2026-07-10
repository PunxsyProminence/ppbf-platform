'use client';

import React, { useState } from 'react';

// --- Types & Interfaces ---
type TabID = 'dashboard' | 'education' | 'rabbitholes';
type LatinRank = 'TIRO' | 'DISCIPULUS' | 'PUGIL NOVUS' | 'PUGIL SCIENTIA' | 'PUGIL FORTIS' | 'PUGIL PRAECEPTOR';

interface Drill {
  id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: string;
}

interface RabbitHoleModule {
  id: string;
  title: string;
  concept: string;
  breakdown: string;
  homework: string;
}

export default function AthleteWorkspace() {
  // --- Navigation & Role States ---
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [athleteRank, setAthleteRank] = useState<LatinRank>('TIRO');

  // --- Daily Intake & Telemetry States ---
  const [sleepScore, setSleepScore] = useState<number>(8);
  const [sorenessLevel, setSorenessLevel] = useState<number>(2);
  const [academicPassing, setAcademicPassing] = useState<boolean>(true);
  const [completedDrills, setCompletedDrills] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [stagingTelemetry, setStagingTelemetry] = useState<any | null>(null);

  // --- Constant Data Structures Map (Progrm Direction.docx) ---
  const rankDefinitions: Record<LatinRank, { label: string; desc: string; focus: string }> = {
    TIRO: { 
      label: "Beginner", 
      desc: "Learning stance, guard, jab, and core gym discipline protocols.",
      focus: "Stance integrity, guard lock, standard straight jab mechanics."
    },
    DISCIPULUS: { 
      label: "Student", 
      desc: "Developing combinations, basic defensive pacing, rhythm, and reaction cued drills.",
      focus: "Footwork pacing, basic dynamic head movement, visual reaction drills."
    },
    "PUGIL NOVUS": { 
      label: "Developing Boxer", 
      desc: "Building combination fluency, footwork pivoting, defensive recovery, and tactical awareness.",
      focus: "Dynamic pivoting, combination fluidity, simple counter-punching recovery."
    },
    "PUGIL SCIENTIA": { 
      label: "Skilled Boxer", 
      desc: "Applying technical counters, generating target angles, and decision-making under fatigue indices.",
      focus: "Angled counter attacks, complex visual patterns, metabolic conditioning integration."
    },
    "PUGIL FORTIS": { 
      label: "Advanced Boxer", 
      desc: "Adapting strategic block options, maintaining composure in live drilling, and modeling maturity.",
      focus: "Adaptation to defensive adjustments, live sparring scenario composure, emotional control."
    },
    "PUGIL PRAECEPTOR": { 
      label: "Mentor Boxer", 
      desc: "High technical boxing proficiency combined with uncompromised youth mentorship and cultural leadership.",
      focus: "Junior athlete coaching oversight, peer leadership, modeling gym principles."
    }
  };

  const drillLibrary: Drill[] = [
    { id: 'dr_1', name: 'Standard Stance Integrity Lockout', category: 'Footwork', focus: 'Maintains base width and absolute balance distribution.', cues: ['Ankles aligned', 'Hands up', 'Weight centered'], difficulty: 'TIRO' },
    { id: 'dr_2', name: 'Straight Jab Mechanics & Extension', category: 'Striking', focus: 'Teaches absolute shoulder protection and wrist rotation during extension.', cues: ['Elbow in', 'Chin tucked behind shoulder', 'Snap rotation'], difficulty: 'TIRO' },
    { id: 'dr_3', name: 'Dynamic Slip & Step Pivot', category: 'Defense', focus: 'Simultaneously clear a straight punch while generating a clean lateral counter angle.', cues: ['Slip outside', 'Step 45-degrees', 'Maintain athletic stance'], difficulty: 'DISCIPULUS' },
    { id: 'dr_4', name: 'Controlled Auditory Cue Conditioning', category: 'Neurocognitive', focus: 'Sharpens reactive cognitive pathways when executing combinations under physical fatigue.', cues: ['Listen for coach callout', 'No hesitation', 'Exhale on contact'], difficulty: 'PUGIL NOVUS' }
  ];

  const rabbitHoleLibrary: RabbitHoleModule[] = [
    {
      id: 'rh_1',
      title: 'Biomechanics of Punch Power Transfer',
      concept: 'Force Generation from the Floor Up',
      breakdown: 'True punching force does not generate from the arm muscles. Energy transfers from rear foot rotation, drives through hip extension, channels through core stabilization, and finally releases through the fist.',
      homework: 'Slow-motion execution of 50 straight rear-hand crosses, pausing for 2 seconds at full extension to check rear-heel rotation.'
    },
    {
      id: 'rh_2',
      title: 'Neurobiology of Pattern Recognition',
      concept: 'Reducing Visual Reaction Latency',
      breakdown: 'Elite-level defense relies on recognizing micro-cues (such as shoulder dips or foot adjustments) before a punch is thrown, allowing the brain to process movements before they reach conscious awareness.',
      homework: 'During partner drills, focus exclusively on your partner\'s lead shoulder, noting if you can anticipate punches before they leave their guard.'
    }
  ];

  // --- Logic Calculators ---
  const trainingReadinessScore = Math.max(1, Math.min(10, (sleepScore * 1.2) - (sorenessLevel * 0.4)));

  // --- Actions & Staging dispatches ---
  const toggleDrillCompletion = (id: string) => {
    setCompletedDrills(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleDispatchDailyIntake = () => {
    const packet = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/athlete_intake_telemetry",
      data: {
        readinessScore: parseFloat(trainingReadinessScore.toFixed(1)),
        academicPassing: academicPassing,
        completedTaskCount: Object.keys(completedDrills).filter(k => completedDrills[k]).length,
        activeRank: athleteRank,
        verifiedByJason: false
      }
    };
    setStagingTelemetry(packet);
  };

  const filteredDrills = drillLibrary.filter(drill => 
    drill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    drill.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    drill.difficulty.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* 0.5E SYSTEM IDENTITY HEADER */}
      <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-xs font-mono text-emerald-400 font-bold uppercase tracking-wider">Layer 01: Athlete Dashboard Interface</span>
          </div>
          <h2 className="text-xl font-black font-mono text-slate-100">Athlete Development Workspace</h2>
          <p className="text-xs text-slate-400 font-mono">Structured physical and neurocognitive training tracker.</p>
        </div>

        {/* Tab Navigation Hub */}
        <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 font-mono text-xs font-bold text-slate-400">
          <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-1.5 rounded-lg transition ${activeTab === 'dashboard' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>
            🏃 Daily Dashboard
          </button>
          <button onClick={() => setActiveTab('education')} className={`px-4 py-1.5 rounded-lg transition ${activeTab === 'education' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>
            📖 Drill Library
          </button>
          <button onClick={() => setActiveTab('rabbitholes')} className={`px-4 py-1.5 rounded-lg transition ${activeTab === 'rabbitholes' ? 'bg-emerald-600 text-slate-950' : 'hover:text-slate-200'}`}>
            🕳️ Technical Rabbit Holes
          </button>
        </div>
      </div>

      {/* --- DASHBOARD TAB VIEW --- */}
      {activeTab === 'dashboard' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold font-mono text-slate-200">Session Intake & Daily Check-In</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Track your physical state before starting your training block.</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><span className="text-slate-400">Sleep Quality / Duration</span><span className="text-emerald-400 font-bold">{sleepScore} Hours</span></div>
                <input type="range" min="4" max="12" step="0.5" value={sleepScore} onChange={(e) => setSleepScore(parseFloat(e.target.value))} className="w-full accent-emerald-500 h-1 bg-slate-800 rounded-lg appearance-none" />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><span className="text-slate-400">Anatomical Soreness Level</span><span className="text-amber-400 font-bold">Level {sorenessLevel} / 10</span></div>
                <input type="range" min="0" max="10" step="1" value={sorenessLevel} onChange={(e) => setSorenessLevel(parseInt(e.target.value))} className="w-full accent-amber-500 h-1 bg-slate-800 rounded-lg appearance-none" />
              </div>

              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <span className="text-slate-200 block font-bold">Layer 14: Academic Priority Verification</span>
                  <p className="text-[10px] text-slate-500">Academics do not exclude participation, but performance takes priority.</p>
                </div>
                <button type="button" onClick={() => setAcademicPassing(!academicPassing)} className={`px-4 py-1.5 rounded-lg font-bold border transition ${academicPassing ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-red-950/40 border-red-500 text-red-400'}`}>
                  {academicPassing ? '🎓 PASSING ALL' : '⚠️ HOLD TRIGGERED'}
                </button>
              </div>

              <button onClick={handleDispatchDailyIntake} className="w-full bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-mono font-black text-xs py-3 rounded-xl transition uppercase tracking-wider">
                ⚡ Dispatch Intake Data to Staging Layer
              </button>
            </div>

            {stagingTelemetry && (
              <div className="bg-slate-950/80 border border-slate-900 rounded-xl p-4 space-y-2 font-mono text-[11px] text-slate-400">
                <div className="text-emerald-400 font-bold border-b border-slate-900 pb-1 flex justify-between items-center">
                  <span>📡 TELEMETRY BUFFER TRAPPED</span>
                  <span className="text-[10px] text-slate-600">{stagingTelemetry.timestamp}</span>
                </div>
                <div>• Staging Path: <span className="text-slate-300 underline">{stagingTelemetry.stagingPath}</span></div>
                <div>• Computed Readiness Factor: <span className="text-slate-200 font-bold">{stagingTelemetry.data.readinessScore} / 10</span></div>
                <div>• Academic Waiver Eligibility Status: <span className="text-slate-200">{stagingTelemetry.data.academicPassing ? "ACTIVE" : "EXCLUDED"}</span></div>
                <div className="text-red-400 font-bold">• Automated Promotion Status: BLOCKED (Directive 5 Active)</div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Governed Latin Rank</span>
                <h4 className="text-lg font-black font-mono text-emerald-400 tracking-wide">{athleteRank}</h4>
                <span className="text-xs text-slate-400 font-mono">({rankDefinitions[athleteRank].label})</span>
              </div>

              <p className="text-xs text-slate-300 font-mono leading-relaxed bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                {rankDefinitions[athleteRank].desc}
              </p>

              <div className="space-y-1.5 text-xs font-mono">
                <span className="text-slate-400 block text-[11px] uppercase tracking-wider">Active Rank Focus:</span>
                <p className="text-slate-300">• {rankDefinitions[athleteRank].focus}</p>
              </div>

              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <label className="text-[11px] font-mono text-slate-500 block uppercase">Manual Rank Selection (Testing Emulator):</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(Object.keys(rankDefinitions) as LatinRank[]).map(r => (
                    <button key={r} onClick={() => setAthleteRank(r)} className={`p-1.5 text-center text-[10px] font-mono rounded border transition ${athleteRank === r ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400 font-bold' : 'bg-slate-950 border-slate-900 text-slate-500 hover:text-slate-300'}`}>
                      {r}
                    </button>
                  ))}
                </div>
                <div className="bg-red-950/20 text-red-400 border border-red-500/20 p-2.5 rounded-lg text-[9px] font-mono leading-relaxed mt-1">
                  ⚠️ **DEVELOPER LOCK:** Rank changes are local cache only. Permanent updates require manual verification from Head Coach Jason.
                </div>
              </div>
            </div>

            <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
              <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Calculated Performance Capacity</span>
              <div className="flex justify-between items-baseline">
                <span className="text-2xl font-black font-mono text-slate-100">{trainingReadinessScore.toFixed(1)}</span>
                <span className="text-[10px] font-mono font-bold bg-emerald-950/40 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">Layer 12 Validated</span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono leading-relaxed">System computed daily load boundary limit checked against overtraining suggestion logs.</p>
            </div>
          </div>
        </div>
      )}

      {/* --- EDUCATION TAB VIEW (DRILL LIBRARY) --- */}
      {activeTab === 'education' && (
        <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
          <div className="border-b border-slate-800 pb-3 flex flex-col md:flex-row justify-between md:items-center gap-3">
            <div>
              <h3 className="text-base font-bold font-mono text-slate-200">Layer 07: Education Portal & Drill Library</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Review core physical skill drills, neurocognitive tasks, and technical cues.</p>
            </div>
            <input 
              type="text" 
              placeholder="Search drills, categories, or ranks..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500 max-w-xs"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredDrills.map(drill => (
              <div key={drill.id} className="bg-[#111827] border border-slate-800/80 p-5 rounded-xl space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-slate-800 text-slate-400 px-2 py-0.5 rounded uppercase">{drill.category}</span>
                    <h4 className="text-sm font-bold font-mono text-slate-200 mt-1.5">{drill.name}</h4>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                    {drill.difficulty} Target
                  </span>
                </div>

                <p className="text-xs text-slate-400 font-mono leading-relaxed">{drill.focus}</p>

                <div className="space-y-1 pt-2 border-t border-slate-800/60">
                  <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Active Biomechanical Cues:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {drill.cues.map((cue, i) => (
                      <span key={i} className="text-[10px] font-mono bg-slate-900 border border-slate-800 px-2 py-1 rounded text-slate-300">
                        ⚡ {cue}
                      </span>
                    ))}
                  </div>
                </div>

                <button 
                  onClick={() => toggleDrillCompletion(drill.id)}
                  className={`w-full py-2 rounded-lg text-xs font-mono font-bold border transition ${
                    completedDrills[drill.id] ? 'bg-emerald-950/20 border-emerald-500 text-emerald-400' : 'bg-slate-950 border-slate-900 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {completedDrills[drill.id] ? '✅ Drill Target Achieved Today' : '⬜ Mark Drill Completed'}
                </button>
              </div>
            ))}

            {filteredDrills.length === 0 && (
              <div className="col-span-2 py-12 text-center text-xs font-mono text-slate-500">
                No matching library modules located. Update your filters or parameters.
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- TECHNICAL RABBIT HOLES VIEW --- */}
      {activeTab === 'rabbitholes' && (
        <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-base font-bold font-mono text-slate-200">Layer 24: Technical "Rabbit Holes"</h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Deep-dive concepts exploring the physical, neurological, and physiological science of performance.</p>
          </div>

          <div className="space-y-6">
            {rabbitHoleLibrary.map(rh => (
              <div key={rh.id} className="bg-[#111827] border border-slate-800 p-5 rounded-xl space-y-3 hover:border-emerald-500/20 transition">
                <div>
                  <span className="text-[9px] font-mono font-bold bg-slate-800 text-emerald-400 px-2 py-0.5 rounded uppercase">Advanced Study Matrix</span>
                  <h4 className="text-base font-black font-mono text-slate-200 mt-2">{rh.title}</h4>
                  <span className="text-xs text-slate-400 font-mono italic">Core Hypothesis: {rh.concept}</span>
                </div>

                <p className="text-xs text-slate-300 font-mono leading-relaxed bg-slate-950/40 p-4 rounded-lg border border-slate-800">
                  {rh.breakdown}
                </p>

                <div className="bg-emerald-950/20 border border-emerald-500/20 p-4 rounded-xl text-xs font-mono space-y-1.5">
                  <span className="font-bold text-emerald-400 uppercase tracking-wide block text-[10px]">Active Homework Assignment:</span>
                  <p className="text-slate-300">{rh.homework}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MANDATORY COMPLIANCE FOOTER */}
      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[10px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
