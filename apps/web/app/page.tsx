'use client';

import React, { useState } from 'react';

type UserRole = 'athlete' | 'coach' | 'board' | 'admin';

export default function PPBFMasterDashboard() {
  const [currentRole, setCurrentRole] = useState<UserRole>('athlete');
  
  // Simulated Global State
  const [searchQuery, setSearchQuery] = useState('');
  const [readinessScore, setReadinessScore] = useState('7');
  const [athleteVoice, setAthleteVoice] = useState('');
  const [jasonFlag, setJasonFlag] = useState(false);
  const [panicFlag, setPanicFlag] = useState(false);
  
  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    version: "Production Build v22.0 - Full UI Override",
    stagingPath: "/system_control/pending/",
    infrastructure: "Free-Tier Google Sheets + Firebase Native"
  };

  const twentyFiveAtlas = [
    { id: "01", name: "Core Platform", cat: "core" },
    { id: "02", name: "Participant Management", cat: "core" },
    { id: "03", name: "Full Participant Range", cat: "core" },
    { id: "04", name: "Goal-Routing", cat: "core" },
    { id: "05", name: "Development Routes", cat: "core" },
    { id: "06", name: "Assignments Engine", cat: "core" },
    { id: "07", name: "Skill / Lesson Items", cat: "core" },
    { id: "08", name: "Session Logging Engine", cat: "core" },
    { id: "09", name: "Participant Updates", cat: "core" },
    { id: "10", name: "Coach Review Queue", cat: "core" },
    { id: "11", name: "Safety Gates Matrix", cat: "safety" },
    { id: "12", name: "Medical / Recovery", cat: "safety" },
    { id: "13", name: "Accessibility / Adaptation", cat: "safety" },
    { id: "14", name: "Athlete Logins Portal", cat: "core" },
    { id: "15", name: "Guardian Portal", cat: "safety" },
    { id: "16", name: "Public Portal / Website", cat: "public" },
    { id: "17", name: "Payment Capability", cat: "public" },
    { id: "18", name: "Research Intake", cat: "research" },
    { id: "19", name: "Evidence Review Engine", cat: "research" },
    { id: "20", name: "AI/ML Augmentation", cat: "research" },
    { id: "21", name: "Program Management", cat: "operations" },
    { id: "22", name: "Grant / Impact Reporting", cat: "operations" },
    { id: "23", name: "Nonprofit Operations Logs", cat: "operations" },
    { id: "24", name: "Creative / Comms", cat: "operations" },
    { id: "25", name: "Build Continuity Ledger", cat: "operations" }
  ];

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      
      {/* IMMUTABLE SECURITY BANNER */}
      <div className="bg-gradient-to-r from-red-900/40 to-amber-900/40 border-b border-amber-500/30 px-6 py-2 flex justify-between items-center text-xs font-mono text-amber-400">
        <div className="flex items-center space-x-2">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
          <span><strong>IMMUTABLE GATES STATUS:</strong> Staging logic isolated. Sign-off validation checking for <code>verified_by_jason: true</code> state.</span>
        </div>
        <div className="bg-slate-900 px-2 py-0.5 rounded border border-slate-700">Target Gateway: {corporateStencil.stagingPath}</div>
      </div>

      {/* HEADER & ROLE SWITCHER */}
      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-4 flex flex-col lg:flex-row justify-between items-center gap-4">
        <div className="flex items-center space-x-4">
          <div className="bg-emerald-600 text-slate-950 h-12 w-12 rounded-xl flex items-center justify-center font-black text-xl border-2 border-emerald-400">PP</div>
          <div>
            <h1 className="text-xl font-black text-slate-50">{corporateStencil.entity}</h1>
            <p className="text-[11px] text-slate-400 font-mono">{corporateStencil.version}</p>
          </div>
        </div>
        <div className="bg-[#111827] p-1 rounded-xl border border-slate-800 flex gap-1">
          <button onClick={() => setCurrentRole('athlete')} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold ${currentRole === 'athlete' ? 'bg-emerald-600 text-slate-900' : 'text-slate-400 hover:bg-slate-800'}`}>🏃 Athlete</button>
          <button onClick={() => setCurrentRole('coach')} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold ${currentRole === 'coach' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>📋 Coach</button>
          <button onClick={() => setCurrentRole('board')} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold ${currentRole === 'board' ? 'bg-amber-600 text-slate-900' : 'text-slate-400 hover:bg-slate-800'}`}>🏛️ Board</button>
          <button onClick={() => setCurrentRole('admin')} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold ${currentRole === 'admin' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>🛠️ Admin</button>
        </div>
      </header>

      {/* MAIN VIEWPORT */}
      <main className="flex-1 p-6 md:p-8 max-w-[1600px] w-full mx-auto">
        
        {/* ATHLETE VIEW */}
        {currentRole === 'athlete' && (
          <div className="space-y-6 animate-fadeIn">
            <h2 className="text-xl font-black border-b border-slate-800 pb-2">Athlete Performance Hub</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
                <h3 className="font-bold text-emerald-400 font-mono text-sm">Cap 197: Readiness-to-Learn</h3>
                <input type="range" min="1" max="10" value={readinessScore} onChange={(e) => setReadinessScore(e.target.value)} className="w-full accent-emerald-500" />
                <div className="text-xs font-mono flex justify-between text-slate-400"><span>Distracted</span><span className="text-emerald-400 font-bold">{readinessScore}/10</span><span>Optimal</span></div>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
                <h3 className="font-bold text-emerald-400 font-mono text-sm">Cap 198: Athlete Voice</h3>
                <textarea value={athleteVoice} onChange={(e) => setAthleteVoice(e.target.value)} placeholder="Log technical confusion or fatigue..." className="w-full bg-[#111827] border border-slate-700 rounded p-2 text-xs text-slate-200 h-20 resize-none"></textarea>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
                <h3 className="font-bold text-cyan-400 font-mono text-sm">Layer 05: Water Confidence</h3>
                <div className="space-y-2 text-xs font-mono">
                  <label className="flex items-center gap-2"><input type="checkbox" className="accent-cyan-500" /> Base Submersion Comfort</label>
                  <label className="flex items-center gap-2"><input type="checkbox" className="accent-cyan-500" /> Rhythmic Breathing Lock</label>
                  <button className="w-full mt-2 bg-slate-800 hover:bg-cyan-900 text-cyan-400 py-1.5 rounded border border-cyan-800">Log Swim Screening</button>
                </div>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl col-span-full space-y-3">
                <h3 className="font-bold text-slate-200 font-mono text-sm">Assigned 5-Route Vectors</h3>
                <div className="flex gap-3 text-xs font-mono">
                  <div className="p-3 bg-[#111827] border border-emerald-900/50 text-emerald-400 rounded">🥊 USA Boxing Competitive</div>
                  <div className="p-3 bg-[#111827] border border-slate-800 rounded text-slate-400">🦾 A2P Seated Line</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* COACH VIEW */}
        {currentRole === 'coach' && (
          <div className="space-y-6 animate-fadeIn">
            <h2 className="text-xl font-black border-b border-slate-800 pb-2">Coach Active Floor Monitor</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4 col-span-full lg:col-span-2">
                <h3 className="font-bold text-indigo-400 font-mono text-sm">Layer 10: Decision Desk Queue</h3>
                <div className="bg-[#111827] border border-slate-700 p-4 rounded-lg flex justify-between items-center">
                  <div>
                    <span className="block text-sm font-bold">Pending Progression: Sparring Tier 2</span>
                    <span className="text-xs text-slate-400">Needs Head Coach Authorization</span>
                  </div>
                  <button onClick={() => setJasonFlag(!jasonFlag)} className={`px-4 py-2 font-mono font-bold text-xs rounded border ${jasonFlag ? 'bg-emerald-900 border-emerald-500 text-emerald-400' : 'bg-slate-800 border-slate-600 text-slate-300'}`}>
                    {jasonFlag ? '✅ verified_by_jason: true' : 'Set Override Flag'}
                  </button>
                </div>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-4">
                <h3 className="font-bold text-indigo-400 font-mono text-sm">Cap 196: Session Quality</h3>
                <label className="flex items-center gap-3 bg-[#111827] p-3 rounded border border-slate-700 text-xs font-mono cursor-pointer hover:border-indigo-500 transition">
                  <input type="checkbox" className="h-4 w-4 accent-indigo-500" />
                  Audit Safe Practice Doctrine
                </label>
              </div>

              {/* LAYER 08 - MISSING TEXTAREA NOW INJECTED */}
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-3 col-span-full">
                <h3 className="font-bold text-slate-200 font-mono text-sm">Layer 08: Raw Observation Floor Intake</h3>
                <textarea 
                  placeholder="Log real-time technique, fatigue peaks, or asymmetry data notes directly from the gym floor..." 
                  className="w-full bg-[#111827] border border-slate-700 p-3 rounded-lg text-xs font-mono text-slate-300 focus:outline-none focus:border-indigo-500 resize-none h-24"
                />
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-3">
                <h3 className="font-bold text-slate-200 font-mono text-sm">Layer 02: Asymmetry Monitor</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <input type="text" placeholder="Left Drift..." className="bg-[#111827] border border-slate-700 p-2 rounded" />
                  <input type="text" placeholder="Right Drift..." className="bg-[#111827] border border-slate-700 p-2 rounded" />
                </div>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-3">
                <h3 className="font-bold text-slate-200 font-mono text-sm">Layer 12: Recovery Math</h3>
                <div className="bg-[#111827] p-3 rounded border border-slate-700 text-xs font-mono space-y-2">
                  <div className="flex justify-between"><span>Fatigue Decay:</span> <span className="text-amber-400">T-minus 14hrs</span></div>
                  <div className="flex justify-between"><span>Min Effective Dose (Cap 195):</span> <span className="text-emerald-400">4 Rnds</span></div>
                </div>
              </div>

              <div className={`border p-5 rounded-xl space-y-3 flex flex-col justify-center items-center transition-all ${panicFlag ? 'bg-red-950 border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-[#0b0f19] border-slate-800'}`}>
                <h3 className="font-bold font-mono text-sm text-center">Layer 11: Water Panic / Cap 194</h3>
                <button onClick={() => setPanicFlag(!panicFlag)} className="bg-red-600 hover:bg-red-500 text-white font-black px-6 py-3 rounded-lg text-sm w-full uppercase tracking-widest shadow-lg">
                  {panicFlag ? 'PROTOCOL ACTIVE' : 'TRIGGER RED FLAG ALERT'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* BOARD VIEW */}
        {currentRole === 'board' && (
          <div className="space-y-6 animate-fadeIn">
            <h2 className="text-xl font-black border-b border-slate-800 pb-2">Non-Profit Governance Deck</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-5 text-center">
              
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-center">
                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Layer 22: Floor Minutes</span>
                <span className="text-3xl font-black text-amber-500 mt-2">42,850</span>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-center">
                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">PA Standard Compliance</span>
                <span className="text-3xl font-black text-emerald-500 mt-2">100%</span>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-center">
                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Layer 23: Corp Stamp</span>
                <span className="text-xl font-black text-slate-300 mt-2">AUTOMATED</span>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-center">
                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">Layer 19: False Progress</span>
                <span className="text-lg font-black text-cyan-400 mt-2">NO DRIFT</span>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl col-span-full">
                <h3 className="font-bold text-amber-400 font-mono text-sm mb-4">6 Governed Latin Ranks</h3>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs font-mono">
                  {['TIRO', 'DISCIPULUS', 'PUGIL NOVUS', 'PUGIL SCIENTIA', 'PUGIL FORTIS', 'PUGIL PRAECEPTOR'].map((rank, i) => (
                    <div key={rank} className="bg-[#111827] border border-slate-700 py-3 rounded text-slate-300"><span className="opacity-50 block mb-1">0{i+1}</span>{rank}</div>
                  ))}
                </div>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl col-span-full flex justify-around text-xs font-mono text-slate-400">
                <span>📚 Cap 199: Parent Education (Deployed)</span>
                <span>🔒 Cap 200: Privacy Tiers (Strict Enforced)</span>
              </div>
            </div>
          </div>
        )}

        {/* ADMIN VIEW */}
        {currentRole === 'admin' && (
          <div className="space-y-6 animate-fadeIn">
            <div className="flex justify-between items-end border-b border-slate-800 pb-2">
              <h2 className="text-xl font-black">25-Layer Atlas & Admin Controls</h2>
              <input type="text" placeholder="Search Atlas..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-[#111827] border border-slate-700 px-3 py-1 text-xs font-mono rounded-lg focus:outline-none focus:border-rose-500" />
            </div>

            <div className="flex flex-wrap gap-4 bg-[#0b0f19] border border-slate-800 p-4 rounded-xl text-xs font-mono items-center shadow-inner">
              <span className="text-rose-400 font-bold">Layer 21 Facilities:</span>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" defaultChecked className="accent-rose-500" /> Deegan Lane</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" defaultChecked className="accent-rose-500" /> Neeko Lane</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" defaultChecked className="accent-rose-500" /> 3D Print Lab</label>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-slate-500">Layer 02 Waist Tracking Safe-String:</span>
                <input type="text" placeholder="Enter Context String..." className="bg-[#111827] border border-slate-700 px-2 py-1 rounded w-48 text-slate-300" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {twentyFiveAtlas
                .filter(layer => layer.name.toLowerCase().includes(searchQuery.toLowerCase()) || layer.id.includes(searchQuery))
                .map(layer => (
                <div key={layer.id} className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl flex flex-col justify-between group hover:border-slate-600 transition">
                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-400">L-{layer.id}</span>
                    </div>
                    <span className="text-xs font-bold text-slate-300 group-hover:text-rose-400 transition">{layer.name}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
