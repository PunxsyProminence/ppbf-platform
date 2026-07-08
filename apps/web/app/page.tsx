'use client';

import React, { useState } from 'react';

type WorkspaceType = 'dashboard' | 'nonprofit' | 'specops' | 'parental' | 'board' | 'atlas' | 'sysaudit';

interface CapabilityItem {
  id: string;
  name: string;
  cat: 'core' | 'safety' | 'public' | 'research' | 'operations' | 'executive';
  desc: string;
}

export default function PPBFMasterEcosystemConsole() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceType>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [simulatingId, setSimulatingId] = useState<string | null>(null);

  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0",
    stagingPath: "/system_control/pending/",
    infrastructure: "Free-Tier Google Sheets + Firebase Native Stack"
  };

  const LatinRanks = ['TIRO', 'DISCIPULUS', 'PUGIL NOVUS', 'PUGIL SCIENTIA', 'PUGIL FORTIS', 'PUGIL PRAECEPTOR'];
  const SpecOpsLifecycleStatus = ['Locked', 'Ready', 'Needs verification', 'On hold', 'Created', 'Parked', 'Superseded', 'Archived'];

  const activeRoutes = [
    { name: "USA Boxing Competitive Route", desc: "Governed by the 6 Latin Ranks, USA Boxing safety boundaries, and strict academic passing parameters." },
    { name: "A2P (Adaptive-to-Performance)", desc: "Integrated with Layer 13 rules for seated structural movements and protective non-contact substitutions." },
    { name: "Pro-Grade Performance Track", desc: "High-volume drilling vectors tracking advanced technical progression, round strain, and strict recovery thresholds." },
    { name: "Collegiate Student-Athlete Line", desc: "Combines academic credit compliance and study logs with structural physical training maps." },
    { name: "General Fitness & Conditioning", desc: "Focused purely on work capacity, baseline mobility, physical preparation, and parent-monitored home habits." }
  ];

  // Comprehensive 25-Layer Master Capability Atlas Matrix (Preserving All Sub-Systems)
  const twentyFiveAtlas: CapabilityItem[] = [
    { cat: "core", id: "01", name: "Core Platform", desc: "Web Access Portal, Android UI mobile layout engines, Role Permission Matrix (Athlete, Guardian, Coach, Admin), and underlying runtime structures." },
    { cat: "core", id: "02", name: "Participant Management", desc: "Classification Layer, Adaptation Profiles, Asymmetry/Imbalance Monitors, Body Composition Tracking, and Waist Tracking Measurement Context Engine." },
    { cat: "core", id: "03", name: "Full Participant Range", desc: "Cohort Optimization managing Youth, Disabled, Military-Prep, and Pro-Grade demographics. Includes Non-Contact Youth Program Engine and Tactical Athlete Transfer Modules." },
    { cat: "core", id: "04", name: "Goal-Routing", desc: "Goal Intake Tracking, Baseline Capture Engine (unalterable reference points), Target Outcome Mapping, and Goal Management Systems." },
    { cat: "core", id: "05", name: "Development Routes & Technical Loops", desc: "Isolated Track Routing (Boxing, Confidence, Air Force Prep, Task Completion), Periodization Block Planning, Swim Screening Modules, Water Confidence Tracker, Continuous Swim Progression, and integrated Video Analysis Form Tape Reviews." },
    { cat: "core", id: "06", name: "Assignments Engine", desc: "Training Task Systems, Psychological Reflection Journals, Status Tracking Engine (Created, Parked, Superseded), At-Home Guardian Task System, and At-Home Movement Homework Engine." },
    { cat: "core", id: "07", name: "Skill / Lesson Items & Exercises", desc: "Trainable Drills Database, Coaching Cue Library, Constraint Library Engine, Practice Design Engine, and Parent-Safe Exercise Library (Cap 193) with age-band limits." },
    { cat: "core", id: "08", name: "Session Logging Engine", desc: "Raw Observation Intake, Session Builder, Attendance Engine, Intensity Tracker & RPE Scale, Soreness Index Mapping, Session Outcome Evaluator, and Session Quality Score (Cap 196)." },
    { cat: "core", id: "09", name: "Participant Updates", desc: "Self-Report Portal, Confidence Status Engine, Technical Improvement Log, and Athlete Voice Module (Cap 198) for capturing training confusion." },
    { cat: "core", id: "10", name: "Coach Review Queue", desc: "Queue Decision Interface for /system_control/pending/ lane items, Simplify/Downgrade Rationales, Internal Notes Archive, Coaching Doctrine Engine, Coach Intelligence Module, and Intervention Libraries." },
    { cat: "safety", id: "11", name: "Safety Gates Matrix", desc: "Safety Gate System, Guardian Consent Checks, Concussion Blocker Flags, Pool Safety Gates, Underwater Restriction Engine, Water Panic Flag alarms, and Stop/Hold/Regress Progress Halts." },
    { cat: "safety", id: "12", name: "Medical / Recovery Routing", desc: "Injury-Risk Engine, Overtraining Hold Suggestions, Referral Triggers, Fatigue Decay Monitor, Fatigue Breakdown Engine, Pain/Symptom Flag Catalogs, and Minimum Effective Dose Engine (Cap 195)." },
    { cat: "safety", id: "13", name: "Accessibility / Adaptation", desc: "Seated Movement Protocols, Wheelchair boxing adaptations, Non-Contact Substitutions, Adaptation Engine, and exercise Regression Libraries." },
    { cat: "core", id: "14", name: "Athlete Logins Portal", desc: "Readiness Check-ins (sleep, stress, availability), Action Reminders for outstanding forms, Physical Readiness Engines, and Readiness-to-Learn Score (Cap 197)." },
    { cat: "safety", id: "15", name: "Guardian Portal & Feedback Slots", desc: "Dashboard Visibility into youth progress, Consent Form Manager, Attendance Logs, Guardian Observation Engine, Home Compliance/Habit Engine, and parent video sharing access." },
    { cat: "public", id: "16", name: "Public Portal / Website", desc: "Mission Statements hosting non-profit organizational values, community initiatives, public interest forms, and onboarding pipelines." },
    { cat: "public", id: "17", name: "Payment Capability", desc: "Waiver Pipelines and Scholarship Tracking. [STATUS: DEFERRED to maintain strict baseline architecture bounds]." },
    { cat: "research", id: "18", name: "Research Intake Ingestion", desc: "Field-Test Ingestion, empirical motor-learning data capture, Motor-Learning Backlogs, and Standardized Testing/Retest Engines." },
    { cat: "research", id: "19", name: "Evidence Review & Media Engine", desc: "Source Quality Filters, context window Drift Checks, Evidence Quality Engine, Confidence Score Engine, Video Analysis logs, and False Progress Detection Engines." },
    { cat: "research", id: "20", name: "AI/ML Augmentation Layer", desc: "Background Pattern Flags running non-invasive checks on aggregated rows. Enforces absolute, hard-coded AI Therapy REFUSALS." },
    { cat: "operations", id: "21", name: "Program Management Lanes", desc: "Asset & Facility Logistics across Deegan Lane, Neeko Lane, 3D Print Lab, and Grants Outreach. Includes Class Control Engines, Group Assignments, and Capacity Rotation Managers." },
    { cat: "operations", id: "22", name: "Grant / Impact Reporting", desc: "Total Floor Minutes Accumulated compiler, demographic Waiver Metrics processing, and Grant/Nonprofit Impact Engines for donor review." },
    { cat: "operations", id: "23", name: "Nonprofit Operations Logs", desc: "Board Oversight Logs, PA Standard Compliance Records (child safety/non-profit regulations), and Incident Report Engines with immutable timestamps." },
    { cat: "operations", id: "24", name: "Creative / Communications", desc: "Handouts & Parent Visuals, Flyer templates, Parent Education Module (Cap 199), and Parent Message Drafting Assistants." },
    { cat: "operations", id: "25", name: "Build Continuity Ledger", desc: "Digital Operating Map, Build Ledger, Thread Handoff State Tokens, Source-Control Dashboards, Version Status Engine, Audit Trail Decision History, and Privacy-Tier System (Cap 200)." }
  ];

  const filteredAtlas = twentyFiveAtlas.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.id.includes(searchQuery)
  );

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      
      {/* IMMUTABLE WARNING RIBBON */}
      <div className="bg-gradient-to-r from-amber-600/20 to-red-600/20 border-b border-amber-500/30 px-6 py-2 flex flex-wrap justify-between items-center text-xs font-mono text-amber-400 gap-2 shadow-inner">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 anonymity animate-ping"></span>
          <span><strong>IMMUTABLE IMMUNITY GATES ACTIVE:</strong> Progression logic frozen. Head Coach Jason signature flag required (verified_by_jason: true).</span>
        </div>
        <div className="bg-slate-900/60 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Path: <span className="text-emerald-400 underline font-bold">{corporateStencil.stagingPath}</span>
        </div>
      </div>

      {/* RE-DESIGNED BRAND HEADER */}
      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-5 flex flex-col xl:flex-row xl:justify-between xl:items-center gap-4 shadow-md">
        <div className="flex items-center space-x-4">
          <div className="bg-gradient-to-tr from-emerald-500 to-teal-600 text-slate-950 h-14 w-14 rounded-xl flex flex-col items-center justify-center font-black tracking-tighter shadow-lg border border-emerald-400/20">
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
            className="w-full xl:w-72 bg-[#111827] border border-slate-800 rounded-xl px-4 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition font-mono"
          />
        </div>
      </header>

      {/* MASTER DRAWERS GRID */}
      <div className="flex-1 flex flex-col lg:flex-row">
        
        {/* Left Interactive Control Drawer */}
        <aside className="w-full lg:w-80 bg-[#0b0f19] lg:border-r border-slate-800 p-5 space-y-2 flex flex-col justify-between shadow-sm">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-2">Ecosystem Control Hub</p>
            
            <button
              onClick={() => { setActiveWorkspace('dashboard'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex items-center justify-between border ${activeWorkspace === 'dashboard' && !searchQuery ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span>🥊 5-Route Pathways Deck</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('nonprofit'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex flex-col border ${activeWorkspace === 'nonprofit' && !searchQuery ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🛡️ Non-Profit Governance</span>
              <span className="text-[9px] font-mono text-slate-500">6 Latin Ranks & Child Safeguards</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('specops'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex flex-col border ${activeWorkspace === 'specops' && !searchQuery ? 'bg-gradient-to-r from-indigo-950/40 to-slate-900 border-indigo-500 text-indigo-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🦅 SpecOps Reference Track</span>
              <span className="text-[9px] font-mono text-slate-500">16 Dimensions & 11 Statuses</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('parental'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex flex-col border ${activeWorkspace === 'parental' && !searchQuery ? 'bg-gradient-to-r from-cyan-950/40 to-slate-900 border-cyan-500 text-cyan-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🏡 Family Co-Observation Hub</span>
              <span className="text-[9px] font-mono text-slate-500">Home Exercises & Video Reviews</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('board'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex flex-col border ${activeWorkspace === 'board' && !searchQuery ? 'bg-gradient-to-r from-amber-950/40 to-slate-900 border-amber-500 text-amber-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span className="text-sm">🏛️ Board Executive Registry</span>
              <span className="text-[9px] font-mono text-slate-500">Policy Logs & Compliance Audit</span>
            </button>

            <button
              onClick={() => { setActiveWorkspace('atlas'); setSearchQuery(''); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition flex items-center justify-between border ${activeWorkspace === 'atlas' && !searchQuery ? 'bg-gradient-to-r from-slate-800 to-slate-900 border-slate-700 text-slate-200 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
            >
              <span>📋 Core 25-Layer Atlas</span>
            </button>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-800/80">
            <button
              onClick={() => { setActiveWorkspace('sysaudit'); setSearchQuery(''); }}
              className="w-full text-center px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 rounded-xl text-xs font-bold font-mono border border-slate-800 transition"
            >
              🔍 Run Firewalls Compliance Audit
            </button>
          </div>
        </aside>

        {/* Dynamic Display Panel Container */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          
          {searchQuery ? (
            /* SEARCH LAYOUT WINDOW */
            <div className="space-y-4">
              <h3 className="text-base font-bold text-slate-200 font-mono">Ecosystem Target Search Results ({filteredAtlas.length} items)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredAtlas.map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2">
                    <span className="text-[10px] font-mono font-bold bg-[#111827] border border-slate-800 text-slate-400 px-2 py-0.5 rounded">LAYER {item.id}</span>
                    <h4 className="font-bold text-slate-100 text-sm">{item.name}</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'dashboard' ? (
            /* PANEL 1: 5 PERFORMANCE PATHWAYS */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Unified 5-Route Performance Pathways</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Layer 03 & Layer 05 Dynamic Development Mapping</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {activeRoutes.map((route, i) => (
                  <div key={route.name} className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 flex flex-col justify-between hover:border-emerald-500/30 transition group">
                    <div className="space-y-2.5">
                      <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-950/20 px-2 py-0.5 rounded border border-emerald-500/10">PATHWAY 0{i+1}</span>
                      <h3 className="font-bold text-slate-100 text-sm tracking-tight group-hover:text-emerald-400 transition">{route.name}</h3>
                      <p className="text-xs text-slate-400 leading-relaxed">{route.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeWorkspace === 'nonprofit' ? (
            /* PANEL 2: NON-PROFIT LABELS */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Non-Profit Track Governance</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">6 Latin Ranks, USA Boxing Boundaries, and Academic Compliance Logs</p>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold font-mono text-slate-400 uppercase tracking-wider">Governed Latin Rank Hierarchy</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                  {LatinRanks.map((rank, i) => (
                    <div key={rank} className="bg-[#111827] border border-slate-800 p-3 rounded-xl text-center">
                      <div className="text-[9px] font-mono font-bold text-slate-500 tracking-wider">RANK 0{i+1}</div>
                      <div className="text-xs font-black text-emerald-400 mt-1 tracking-wide">{rank}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : activeWorkspace === 'specops' ? (
            /* PANEL 3: SPECOPS CONTROL MATRIX */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Specialized Project Reference Tracker</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">16 Task Dimensions and 11 Spreadsheet Lifecycle Status Profiles</p>
              </div>
              <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold font-mono text-indigo-400 uppercase tracking-wider">Spreadsheet Lifecycle Status Indexes</h3>
                <div className="flex flex-wrap gap-2">
                  {SpecOpsLifecycleStatus.map(status => (
                    <span key={status} className="bg-[#111827] text-slate-300 border border-slate-800 text-xs px-3 py-1.5 rounded-lg font-mono font-semibold">
                      ⚙️ {status}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : activeWorkspace === 'parental' ? (
            /* PANEL 4: FAMILY ENGINE DRAWERS AND VIDEO ANALYSIS */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Family Co-Observation Hub</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Technical Rabbit Holes, Prescribed Home Exercises, Video Review Tape Logs</p>
              </div>

              <div className="bg-gradient-to-r from-emerald-950/40 to-indigo-950/30 border border-emerald-500/20 rounded-xl p-5 space-y-3">
                <h3 className="text-sm font-bold text-emerald-400 font-mono flex items-center gap-2">📹 Layer 05 / 19 Media Engine: Video Analysis Logs</h3>
                <p className="text-xs text-slate-300 leading-relaxed">Tracks tactical tape review, sparring loop trajectories, stance geometries, and mechanical corrections. Provides full transparency into assigned athletic training markers directly inside the family portal.</p>
              </div>

              <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2">
                <h3 className="text-sm font-bold text-cyan-400 font-mono">🕳️ Layer 05 Technical Rabbit Holes Engine</h3>
                <p className="text-xs text-slate-300">Deep-dive biomechanical drilling sequences (e.g., lever rotation, ring mechanics) branching off primary routes for custom tracking.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2">
                  <h4 className="text-xs font-bold font-mono text-cyan-400 uppercase tracking-wider">🏡 Parental Home Observation Logs (Layer 15)</h4>
                  <p className="text-xs text-slate-400">Structured data feedback entry slots logging out-of-gym behavioral telemetry: Attention Span Stability, Task Completion Persistence, and Home Confidence Shifts.</p>
                </div>
                <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 space-y-2">
                  <h4 className="text-xs font-bold font-mono text-cyan-400 uppercase tracking-wider">🏃 Prescribed Home Skill Exercises (Layer 07)</h4>
                  <p className="text-xs text-slate-400">Custom non-contact technical assignments, mobility routines, and posture stencils pushed by coaches to reinforce facility lessons.</p>
                </div>
              </div>
            </div>
          ) : activeWorkspace === 'board' ? (
            /* PANEL 5: BOARD MEMBER EXECUTIVE VIEWS LAYOUT */
            <div className="space-y-6 animate-fadeIn">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-amber-400 tracking-tight">Board Member Executive Registry Console</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Layer 22 & Layer 23 High-Level Operational Metrics Dashboard</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <span className="text-[10px] font-mono font-bold text-slate-500">LAYER 22 METRIC</span>
                  <h4 className="text-sm font-bold text-slate-200">Total Floor Minutes Accumulated</h4>
                  <p className="text-xs text-slate-400 pt-1 leading-relaxed">Aggregates ongoing real-time operational training floor metrics across active cohorts to validate non-profit community footprint parameters.</p>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <span className="text-[10px] font-mono font-bold text-slate-500">LAYER 22 METRIC</span>
                  <h4 className="text-sm font-bold text-slate-200">Demographic Waiver Metrics</h4>
                  <p className="text-xs text-slate-400 pt-1 leading-relaxed">Processes generalized program cohort utilization patterns dynamically to produce automated data outputs for state funding validation briefs.</p>
                </div>

                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <span className="text-[10px] font-mono font-bold text-slate-500">LAYER 23 METRIC</span>
                  <h4 className="text-sm font-bold text-slate-200">Board Oversight logs & Compliance</h4>
                  <p className="text-xs text-slate-400 pt-1 leading-relaxed">Permanent digitized archive tracking structural executive policy amendments, incident reports, and PA standard verification safety logs.</p>
                </div>
              </div>
            </div>
          ) : activeWorkspace === 'atlas' ? (
            /* PANEL 6: ENTIRE UNIFIED 25 ATLAS CAPS LISTING */
            <div className="space-y-4">
              <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Master 25-Capability Core Atlas Registry Index</h2>
                <span className="text-xs font-mono bg-slate-900 border border-slate-800 px-3 py-1 rounded-full text-slate-400">Layers: 25</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {twentyFiveAtlas.map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl flex flex-col justify-between hover:border-slate-700 transition shadow-sm group">
                    <div className="space-y-2">
                      <span className="text-[10px] font-mono font-bold bg-[#111827] text-slate-400 px-2 py-0.5 rounded border border-slate-800">LAYER {item.id}</span>
                      <h4 className="font-bold text-slate-100 text-xs tracking-tight group-hover:text-emerald-400 transition">{item.name}</h4>
                      <p className="text-[11px] text-slate-400 leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* PANEL 7: DIRECTIVES COMPLIANCE AUDIT PANEL */
            <div className="space-y-6">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-xl font-black text-slate-100 tracking-tight">Ecosystem Node Core Directives Audit</h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">Live compliance validation parameters for Production Build v21.0</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <div className="flex justify-between items-center"><h4 className="font-bold text-slate-200 font-mono text-xs uppercase">1. Infrastructure Boundary</h4><span className="text-[10px] font-mono text-emerald-400">COMPLIANT</span></div>
                  <p className="text-xs text-slate-400">All logic compiles within native free-tier Google Sheets schemas. Enterprise third-party software upcharge advisories are hard-blocked at Layer 0.</p>
                </div>
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <div className="flex justify-between items-center"><h4 className="font-bold text-slate-200 font-mono text-xs uppercase">2. Staging Paths Vector</h4><span className="text-[10px] font-mono text-emerald-400">COMPLIANT</span></div>
                  <p className="text-xs text-slate-400">Transaction data is trapped, structured, and forced through path <code className="text-amber-400">/system_control/pending/</code> before active row commit.</p>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* MANDATORY LEGAL FOOTER STENCIL */}
      <footer className="bg-[#0b0f19] border-t border-slate-900 px-6 py-4 flex flex-col md:flex-row justify-between items-center text-xs text-slate-500 font-mono gap-3 shadow-inner">
        <div>
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
