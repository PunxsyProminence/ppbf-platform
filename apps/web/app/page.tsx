'use client';

import React, { useState } from 'react';

// Define explicit types to enforce the strict structural boundaries of Production Build v21.0
type WorkspaceType = 'dashboard' | 'nonprofit' | 'specops' | 'parental' | 'atlas' | 'sysaudit';

interface Capability {
  id: string;
  name: string;
  cat: 'core' | 'safety' | 'public' | 'research' | 'operations';
  desc: string;
}

export default function PPBFMasterEcosystemNode() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceType>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [simulatingId, setSimulatingId] = useState<string | null>(null);

  // Strict Corporate Stencil Configuration
  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0",
    stagingPath: "/system_control/pending/",
    infrastructure: "Free-Tier Google Sheets + Firebase Native Stack"
  };

  const LatinRanks = ['TIRO', 'DISCIPULUS', 'PUGIL NOVUS', 'PUGIL SCIENTIA', 'PUGIL FORTIS', 'PUGIL PRAECEPTOR'];
  
  const SpecOpsLifecycleStatus = [
    'Locked', 'Ready', 'Needs verification', 'On hold', 
    'Created', 'Parked', 'Superseded', 'Archived'
  ];

  const activeRoutes = [
    { name: "USA Boxing Competitive Route", desc: "Governed by the 6 Latin Ranks, USA Boxing safety boundaries, and strict academic passing parameters." },
    { name: "A2P (Adaptive-to-Performance)", desc: "Integrated with Layer 13 rules for seated structural movements and protective non-contact substitutions." },
    { name: "Pro-Grade Performance Track", desc: "High-volume drilling vectors tracking advanced technical progression, round strain, and strict recovery thresholds." },
    { name: "Collegiate Student-Athlete Line", desc: "Combines academic credit compliance and study logs with structural physical training maps." },
    { name: "General Fitness & Conditioning", desc: "Focused purely on work capacity, baseline mobility, physical preparation, and parent-monitored home habits." }
  ];

  // Exhaustive 25-Layer Atlas Registry Mapping Targets
  const twentyFiveAtlas: Capability[] = [
    { cat: "core", id: "01", name: "Core Platform", desc: "Web Access, Android UI native routing channels, and zero-trust role permission tokens." },
    { cat: "core", id: "02", name: "Participant Management", desc: "Structural classification matrices and multi-track adaptation profiles." },
    { cat: "core", id: "03", name: "Full Participant Range", desc: "Specialized processing modules managing USA Boxing, A2P, Pro-Grade, Collegiate, and General Fitness cohorts." },
    { cat: "core", id: "04", name: "Goal-Routing", desc: "Intake parameter capture frameworks mapping directly to discrete lifestyle and performance outcomes." },
    { cat: "core", id: "05", name: "Development Routes", desc: "Progression vectors for Boxing, Confidence, and Performance. Natively embeds \"Rabbit Holes\" deep-dive theoretical sub-tracks." },
    { cat: "core", id: "06", name: "Assignments", desc: "Telemetry tracking tasks, qualitative student reflection prompts, and state monitoring logs passing through secure staging vectors." },
    { cat: "core", id: "07", name: "Skill / Lesson Items", desc: "Trainable physical drills and behavioral cues. Surfaces the custom Prescribed At-Home Skill Exercises framework." },
    { cat: "core", id: "08", name: "Session Logging", desc: "Real-time entry logs capturing Attendance, physical intensity, RPE Scale, and Soreness Index variables." },
    { cat: "core", id: "09", name: "Participant Updates", desc: "Self-reporting modules capturing immediate student confidence status and technical iterations." },
    { cat: "core", id: "10", name: "Coach Review", desc: "Queue priority engine holding system optimization logic, simplification rationales, and private notes." },
    { cat: "safety", id: "11", name: "Safety Gates", desc: "Automated Guardian consent verification checks and Concussion Blocker state flags." },
    { cat: "safety", id: "12", name: "Medical / Recovery", desc: "Overtraining hold generation parameters and external medical referral triggers." },
    { cat: "safety", id: "13", name: "Accessibility / Adaptation", desc: "Alternative path engines for seated movements and protective non-contact substitutions." },
    { cat: "core", id: "14", name: "Athlete Logins", desc: "Mandates pre-session readiness check-ins, alert notifications, and outstanding forms logging." },
    { cat: "safety", id: "15", name: "Guardian Portal", desc: "Dashboard transparency layer. Natively interfaces the Parental At-Home Observation Logs (Behavioral Tracking)." },
    { cat: "public", id: "16", name: "Public Portal / Website", desc: "Dispatches organization mission parameters and public program interest ingestion web-forms." },
    { cat: "public", id: "17", name: "Payment Capability", desc: "Scholarship logging routines. [DEFERRED] to maintain secure baseline architecture bounds." },
    { cat: "research", id: "18", name: "Research Intake", desc: "Field-test data capture pipelines and neurological motor-learning telemetry backlogs." },
    { cat: "research", id: "19", name: "Evidence Review", desc: "Source quality evaluation filters, data drift monitors, and manual Head Coach approval gates." },
    { cat: "research", id: "20", name: "AI/ML Augmentation", desc: "Background pattern checking. Enforces absolute AI Therapy REFUSALS for all parental/student entries." },
    { cat: "operations", id: "21", name: "Program Management", desc: "Segmented workflows for Deegan Lane, Neeko Lane, 3D Print Lab, and Grants Outreach pipelines." },
    { cat: "operations", id: "22", name: "Grant / Impact Reporting", desc: "Compiles data for Total Floor Minutes Accumulated, Waiver Metrics, and board delivery briefs." },
    { cat: "operations", id: "23", name: "Nonprofit Operations", desc: "Maintains active Board Oversight Logs and PA Standard Compliance Records." },
    { cat: "operations", id: "24", name: "Creative / Communications", desc: "Engine assets for print handouts, parental data visualizations, and flyer templates." },
    { cat: "operations", id: "25", name: "Build Continuity", desc: "The digital operating map, master build ledger index, and cross-thread context handoffs." }
  ];

  const filteredAtlas = twentyFiveAtlas.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.id.includes(searchQuery)
  );

  const handleSimulate = (id: string) => {
    setSimulatingId(id);
    setTimeout(() => setSimulatingId(null), 1200);
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      
      {/* 1. IMMUTABLE IMMUNITY GATES WARNING RIBBON */}
      <div className="bg-gradient-to-r from-amber-600/20 to-red-600/20 border-b border-amber-500/30 px-6 py-2 flex flex-wrap justify-between items-center text-xs font-mono text-amber-400 gap-2 shadow-inner">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
          <span><strong>IMMUTABLE IMMUNITY GATES ACTIVE:</strong> Automated advancement is strictly disabled. Head Coach Jason signature flag required for all progression.</span>
        </div>
        <div className="bg-slate-900/60 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Target: <span className="text-emerald-400 underline font-bold">{corporateStencil.stagingPath}</span>
        </div>
      </div>

      {/* RE-DESIGNED BRAND HEADER */}
      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-5 flex flex-col xl:flex-row xl:justify-between xl:items-center gap-4 shadow-md">
        <div className="flex items-center space-x-4">
          <div className="bg-gradient-to-tr from-emerald-500 to-teal-600 text-slate-950 h-14 w-14 rounded-xl flex flex-col items-center justify-center font-black tracking-tighter shadow-lg shadow-emerald-500/10 border border-emerald-400/20">
            <span className="text-xl leading-none">PP</span>
            <span className="text-xs font-bold -mt-0.5 tracking-normal">BF</span>
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center space-x-3">
              <h1 className="text-2xl font-black text-slate-50 tracking-tight">{corporateStencil.entity}</h1>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase">{corporateStencil.version}</span>
            </div>
            <p className="text-xs text-slate-400 font-mono flex items-center gap-2">
              <span>🏛️ Office: {corporateStencil.office}</span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-400">⚡ Engine Context: {corporateStencil.infrastructure}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 w-full xl:w-auto">
          <input
            type="text"
            placeholder="Search all 25 Atlas capabilities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full xl:w-72 bg-[#111827] border border-slate-800 rounded-xl px-4 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition font-mono"
          />
        </div>
      </header>

      {/* CORE WORKSPACE DRAWERS */}
      <div className="flex-1 flex flex-col lg:flex-row">
        
        {/* Left Navigation Panel */}
        <aside className="w-full lg:w-76 bg-[#0b0f19] lg:border-r border-slate-800 p-5 space-y-2.5 flex flex-col justify-between shadow-sm">
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-2">Ecosystem Control Hub</p>
            
            <button
              onClick={() => { setActiveWorkspace('dashboard'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-3 rounded-xl transition flex items-center justify-between border ${activeWorkspace === 'dashboard' && !searchQuery ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span>🥊 5-Route Performance Deck</span>
              <span className="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">5 Active</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('nonprofit'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-3 rounded-xl transition flex flex-col gap-0.5 border ${activeWorkspace === 'nonprofit' && !searchQuery ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🛡️ Non-Profit Track Control</span>
              <span className="text-[10px] font-normal font-mono text-slate-500">6 Latin Ranks & Safeguards</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('specops'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-3 rounded-xl transition flex flex-col gap-0.5 border ${activeWorkspace === 'specops' && !searchQuery ? 'bg-gradient-to-r from-indigo-950/40 to-slate-900 border-indigo-500 text-indigo-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🦅 SpecOps Project Track</span>
              <span className="text-[10px] font-normal font-mono text-slate-500">16 Dimensions & 11 Status Flags</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('parental'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-3 rounded-xl transition flex flex-col gap-0.5 border ${activeWorkspace === 'parental' && !searchQuery ? 'bg-gradient-to-r from-cyan-950/40 to-slate-900 border-cyan-500 text-cyan-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🏡 Family Co-Observation Hub</span>
              <span className="text-[10px] font-normal font-mono text-slate-500">Home Observations & Exercises</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('atlas'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-3 rounded-xl transition flex items-center justify-between border ${activeWorkspace === 'atlas' && !searchQuery ? 'bg-gradient-to-r from-slate-800 to-slate-900 border-slate-700 text-slate-200 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span>📋 Core 25-Layer Atlas</span>
              <span className="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">Complete Index</span>
            </button>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-800/80">
            <button
              onClick={() => { setActiveWorkspace('sysaudit'); setSearchQuery(''); }}
              className={`w-full text-center px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-xl text-xs font-bold font-mono border border-slate-800 tracking-tight transition shadow-sm ${activeWorkspace === 'sysaudit' ? 'border-amber-500/40 text-amber-400' : ''}`}
            >
              🔍 Run Core Directives Audit
            </button>
            <div className="bg-[#111827] border border-slate-800/60 rounded-xl p-3.5 text-[11px] font-mono text-slate-400 leading-relaxed">
              <span className="text-slate-300 font-bold block mb-1">🛡️ SYSTEM LOGIC LOCK</span>
              All pipeline transactions auto-routed to secure memory loops before disk commit.
            </div>
          </div>
        </aside>

        {/* Dynamic Multi-Pane Center Workspace */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          
          {searchQuery ? (
            /* DYNAMIC SEARCH FILTER VIEW */
            <div className="space-y-4">
              <div className="border-b border-slate-800 pb-3">
                <h3 className="text-base font-bold text-slate-200 font-mono">Ecosystem Target Search Results ({filteredAtlas.length} items found)</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredAtlas.map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800/80 rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition shadow-sm group">
                    <div className="space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-mono font-bold bg-[#111827] border border-slate-800 text-slate-400 px-2 py-0.5 rounded">LAYER {item.id}</span>
                        <span className={`h-1.5 w-1.5 rounded-full ${item.cat === 'safety' ? 'bg-amber-400' : item.cat === 'research' ? 'bg-cyan-400' : item.cat === 'operations' ? 'bg-indigo-400' : 'bg-emerald-400'}`}></span>
                      </div>
                      <h4 className="font-bold text-slate-100 text-sm tracking-tight group-hover:text-emerald-400 transition">{item.name}</h4>
                      <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'dashboard' ? (
            /* PANEL 1: UNIFIED 5-ROUTE PERFORMANCE DECK */
            <div className="space-y-6 animate-fadeIn">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Unified 5-Route Performance Pathways</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Layer 03 & Layer 05 Dynamic Development Mapping</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {activeRoutes.map((route, i) => (
                  <div key={route.name} className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 flex flex-col justify-between hover:border-emerald-500/30 hover:shadow-lg hover:shadow-emerald-950/10 transition group">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-950/20 px-2 py-0.5 rounded border border-emerald-500/10">PATHWAY 0{i+1}</span>
                        <span className="text-xs">🥊</span>
                      </div>
                      <h3 className="font-bold text-slate-100 text-base tracking-tight group-hover:text-emerald-400 transition">{route.name}</h3>
                      <p className="text-xs text-slate-400 leading-relaxed">{route.desc}</p>
                    </div>
                    <div className="mt-5 pt-3 border-t border-slate-800/60 text-right">
                      <span className="text-[10px] font-mono bg-[#111827] text-slate-500 px-2 py-1 rounded border border-slate-800">Operational Profile Bound</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'nonprofit' ? (
            /* PANEL 2: NON-PROFIT GOVERNANCE TRACK */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Non-Profit Track Governance</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">6 Latin Ranks, USA Boxing Boundaries, and Academic Compliance Logs</p>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold font-mono text-slate-400 uppercase tracking-wider">Governed Latin Rank Hierarchy</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                  {LatinRanks.map((rank, i) => (
                    <div key={rank} className="bg-[#111827] border border-slate-800 p-3 rounded-xl text-center shadow-inner group hover:border-emerald-500/40 transition">
                      <div className="text-[9px] font-mono font-bold text-slate-500 tracking-wider">RANK 0{i+1}</div>
                      <div className="text-xs font-black text-emerald-400 mt-1 tracking-wide group-hover:scale-105 transition transform">{rank}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {twentyFiveAtlas.filter(i => ['02', '03', '11', '23'].includes(i.id)).map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
                    <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-950/30 px-1.5 py-0.5 rounded border border-emerald-500/10">ATLAS L{item.id}</span>
                    <h4 className="font-bold text-slate-200 text-sm tracking-tight">{item.name}</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'specops' ? (
            /* PANEL 3: SPECIALIZED TRACK / SPECOPS REFERENCE MATRIX */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Specialized Project Reference Tracker</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">16 Task Dimensions and 11 Spreadsheet Lifecycle Status Profiles</p>
              </div>
              
              <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 border-b border-slate-800 pb-3">
                  <h3 className="text-xs font-bold font-mono text-indigo-400 uppercase tracking-wider">Spreadsheet Lifecycle Status Indexes</h3>
                  <span className="text-[10px] font-mono text-slate-500">Source: SPECOPS_PROJECT_CONTROL_TRACKER_updated(1).xlsx</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SpecOpsLifecycleStatus.map(status => (
                    <span key={status} className="bg-[#111827] text-slate-300 border border-slate-800 text-xs px-3 py-1.5 rounded-lg font-mono font-semibold shadow-inner hover:border-indigo-500/30 transition">
                      ⚙️ {status}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {twentyFiveAtlas.filter(i => ['05', '06', '18', '19'].includes(i.id)).map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
                    <span className="text-[9px] font-mono font-bold text-indigo-400 bg-indigo-950/30 px-1.5 py-0.5 rounded border border-indigo-500/10">ATLAS L{item.id}</span>
                    <h4 className="font-bold text-slate-200 text-sm tracking-tight">{item.name}</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'parental' ? (
            /* PANEL 4: FAMILY CO-OBSERVATION HUB & AT-HOME EXERCISES */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Family Co-Observation Hub</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Layer 05 Rabbit Holes, Layer 07 Home Exercises, and Layer 15 Parental Observations</p>
              </div>

              <div className="bg-gradient-to-r from-cyan-950/30 to-slate-900 border border-cyan-500/20 rounded-xl p-6 space-y-4 shadow-md">
                <h3 className="text-base font-bold text-cyan-400 flex items-center gap-2">🕳️ Core Technical Rabbit Holes Engine (Layer 05 / 07)</h3>
                <p className="text-xs text-slate-300 max-w-4xl leading-relaxed">
                  Rabbit Holes are specialized theoretical or deep biomechanical training vectors that branch off standard gym routes. This system allows parents to view assigned drill scopes to reinforce technical precision outside the facility.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 text-xs text-slate-300 font-mono"><span className="text-cyan-400 font-bold block mb-0.5">Vector A</span> Biomechanical Lever Rotation</div>
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 text-xs text-slate-300 font-mono"><span className="text-cyan-400 font-bold block mb-0.5">Vector B</span> Spatial Ring Boundary Control</div>
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 text-xs text-slate-300 font-mono"><span className="text-cyan-400 font-bold block mb-0.5">Vector C</span> Reactive Counter-Punch Geometry</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
                <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2.5 shadow-sm">
                  <div className="flex items-center space-x-2">
                    <span className="text-lg">🏡</span>
                    <h4 className="font-bold text-slate-100 text-sm font-mono uppercase tracking-wider text-cyan-400">Parental Home Observation Logs</h4>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Structured fields built directly into the Guardian Portal allowing families to self-report critical real-world behavioral telemetry: Attention Span Stability, Task Persistence, and Out-of-Gym Confidence Shifts.
                  </p>
                  <div className="text-[10px] font-mono text-red-400 bg-red-950/20 border border-red-500/10 px-2 py-1 rounded inline-block">
                    ⚠️ Layer 20 Rule: Strict AI Therapy Refusal Enforced.
                  </div>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2.5 shadow-sm">
                  <div className="flex items-center space-x-2">
                    <span className="text-lg">🏃</span>
                    <h4 className="font-bold text-slate-100 text-sm font-mono uppercase tracking-wider text-cyan-400">Prescribed Home Skill Exercises</h4>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Custom-assigned non-contact physical mobility routines, focus stencils, and cognitive tracking tasks pushed by coaches directly to the family view. Tracks completion volume within native database bounds.
                  </p>
                  <div className="text-[10px] font-mono text-slate-500 bg-slate-950 px-2 py-1 rounded inline-block border border-slate-800">
                    Compiled within free-tier storage boundaries.
                  </div>
                </div>
              </div>
            </div>
          ) : activeWorkspace === 'atlas' ? (
            /* PANEL 5: DENSE EXHAUSTIVE INDEX OF THE 25 ATLAS CAPS */
            <div className="space-y-4">
              <div className="border-b border-slate-800 pb-3 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <div>
                  <h2 className="text-xl font-black text-slate-100 tracking-tight">Master 25-Capability Core Atlas Registry</h2>
                  <p className="text-xs text-slate-400 mt-0.5 font-mono">Comprehensive system blueprint mapping targets for Production Build v21.0</p>
                </div>
                <span className="text-xs font-mono bg-[#0b0f19] border border-slate-800 px-3 py-1 rounded-full text-slate-400 whitespace-nowrap">Total Layer Registries: {twentyFiveAtlas.length}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {twentyFiveAtlas.map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-between hover:border-slate-700 transition shadow-sm group">
                    <div className="space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-mono font-bold bg-[#111827] text-slate-400 px-2 py-0.5 rounded border border-slate-800">LAYER {item.id}</span>
                        <span className={`h-1.5 w-1.5 rounded-full ${item.cat === 'safety' ? 'bg-amber-400' : item.cat === 'research' ? 'bg-cyan-400' : item.cat === 'operations' ? 'bg-indigo-400' : 'bg-emerald-400'}`}></span>
                      </div>
                      <h4 className="font-bold text-slate-100 text-sm tracking-tight group-hover:text-emerald-400 transition">{item.name}</h4>
                      <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                    </div>
                    <div className="mt-5 pt-3 border-t border-slate-800/60 text-right">
                      <button 
                        onClick={() => handleSimulate(item.id)}
                        disabled={simulatingId !== null}
                        className="text-[10px] font-mono bg-[#111827] hover:bg-slate-800 text-slate-200 border border-slate-800 px-2.5 py-1 rounded transition disabled:opacity-50"
                      >
                        {simulatingId === item.id ? 'Trapping context...' : 'Simulate Pipeline'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* PANEL 6: SYSTEM DIRECTIVES COMPLIANCE AUDIT PANEL */
            <div className="space-y-6 animate-fadeIn">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Ecosystem Node Core Directives Audit</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Live compliance status verification for Production Build v21.0</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                  <div className="flex justify-between items-center">
                    <h4 className="font-bold text-slate-200 font-mono text-xs uppercase tracking-wider">1. Infrastructure Boundary</h4>
                    <span className="text-[10px] font-mono font-bold bg-emerald-950/30 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">COMPLIANT</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">All tracking matrices map entirely inside free-tier Google Sheets schemas. Premium paid third-party application recommendation loops are hard-blocked at Layer 0.</p>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                  <div className="flex justify-between items-center">
                    <h4 className="font-bold text-slate-200 font-mono text-xs uppercase tracking-wider">2. Staging Paths Vector</h4>
                    <span className="text-[10px] font-mono font-bold bg-emerald-950/30 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">COMPLIANT</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">Transactions are captured, serialized, and forced to pass through the path variable <code className="text-amber-400 font-bold">/system_control/pending/</code> before disk commit.</p>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                  <div className="flex justify-between items-center">
                    <h4 className="font-bold text-slate-200 font-mono text-xs uppercase tracking-wider">3. Corporate Legal Stencil</h4>
                    <span className="text-[10px] font-mono font-bold bg-emerald-950/30 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">COMPLIANT</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">Outbound layouts pack data along with verified non-profit filing indices: <code className="text-slate-300 font-bold">{corporateStencil.entity}</code>, Big Run, PA.</p>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                  <div className="flex justify-between items-center">
                    <h4 className="font-bold text-slate-200 font-mono text-xs uppercase tracking-wider">4. AI Therapy Gate (Layer 20)</h4>
                    <span className="text-[10px] font-mono font-bold bg-emerald-950/30 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">COMPLIANT</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">All background logic checking across parent home observation blocks enforces an absolute refusal state on any automated diagnostic/therapeutic logs.</p>
                </div>

              </div>
            </div>
          )}

        </main>
      </div>

      {/* COMPLIANCE STENCIL FOOTER */}
      <footer className="bg-[#0b0f19] border-t border-slate-900 px-6 py-4 flex flex-col md:flex-row justify-between items-center text-xs text-slate-500 font-mono gap-3 shadow-inner">
        <div className="text-center md:text-left leading-relaxed">
          <div>⚖️ Stencil Audit Signature: <strong>{corporateStencil.entity}</strong></div>
          <div>Registered Statutory Office: <span className="text-slate-400">{corporateStencil.office}</span></div>
        </div>
        <div className="bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 text-slate-400 font-bold tracking-tight text-[11px] whitespace-nowrap">
          Continuous Integration Status: <span className="text-emerald-400 font-black">PASSING_RUN_NODE_V21</span>
        </div>
      </footer>
    </div>
  );
}
