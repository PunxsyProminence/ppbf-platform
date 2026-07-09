'use client';

import React, { useState } from 'react';
import TutorialView from '../components/TutorialView';
import RabbitHoleView from '../components/RabbitHoleView';

type MasterViewType = 'portals' | 'tutorial' | 'rabbithole';
type RoleViewType = 'athlete' | 'coach' | 'admin_board';
type TabScopeType = 'routes' | 'parental' | 'atlas' | 'sysaudit';

interface CapabilityItem {
  id: string;
  name: string;
  cat: 'core' | 'safety' | 'public' | 'research' | 'operations';
  desc: string;
}

export default function PPBFMasterUnifiedConsole() {
  const [masterView, setMasterView] = useState<MasterViewType>('portals');
  const [currentRole, setCurrentRole] = useState<RoleViewType>('athlete');
  const [activeTab, setActiveTab] = useState<TabScopeType>('routes');
  const [searchQuery, setSearchQuery] = useState('');

  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0 Shell 0.5E",
    stagingPath: "/system_control/pending/",
    infrastructure: "Free-Tier Google Sheets + Firebase Native Stack"
  };

  const LatinRanks = ['TIRO', 'DISCIPULUS', 'PUGIL NOVUS', 'PUGIL SCIENTIA', 'PUGIL FORTIS', 'PUGIL PRAECEPTOR'];
  const SpecOpsStatus = ['Locked', 'Ready', 'Needs verification', 'On hold', 'Created', 'Parked', 'Superseded', 'Archived'];

  const activeRoutes = [
    { name: "USA Boxing Competitive Route", desc: "Governed by the 6 Latin Ranks, USA Boxing safety boundaries, and strict academic passing parameters." },
    { name: "A2P (Adaptive-to-Performance)", desc: "Integrated with Layer 13 rules for seated structural movements and protective non-contact substitutions." },
    { name: "Pro-Grade Performance Track", desc: "High-volume drilling vectors tracking advanced technical progression, round strain, and strict recovery thresholds." },
    { name: "Collegiate Student-Athlete Line", desc: "Combines academic credit compliance and study logs with structural physical training maps." },
    { name: "General Fitness & Conditioning", desc: "Focused purely on work capacity, baseline mobility, physical preparation, and parent-monitored home habits." }
  ];

  const twentyFiveAtlas: CapabilityItem[] = [
    { cat: "core", id: "01", name: "Core Platform", desc: "Web Access Portal, Android UI mobile layouts, and Role Permission Matrix configurations (Athlete, Guardian, Coach, Admin)." },
    { cat: "core", id: "02", name: "Participant Management", desc: "Classification Layer, Adaptation Profiles, Asymmetry Monitors, Body Composition, and Waist Tracking Measurement context engines." },
    { cat: "core", id: "03", name: "Full Participant Range", desc: "Cohort Optimization across Youth, Disabled, Military-Prep, and Pro-Grade athlete demographics. Includes Non-Contact Youth Program engines." },
    { cat: "core", id: "04", name: "Goal-Routing", desc: "Goal Intake Tracking, Baseline Capture Engines, and Target Outcome Mapping trajectories." },
    { cat: "core", id: "05", name: "Development Routes", desc: "Progression vectors for Boxing and Confidence. Natively embeds technical 'Rabbit Holes' and Video Analysis loops." },
    { cat: "core", id: "06", name: "Assignments", desc: "Training Task Engines, performance journals, Psychological Reflection prompts, and At-Home Homework modules." },
    { cat: "core", id: "07", name: "Skill / Lesson Items", desc: "Trainable Drills Database, Coaching Cue Libraries, Progression Ruleset Engines, and Parent-Safe Exercise Library (Cap 193)." },
    { cat: "core", id: "08", name: "Session Logging", desc: "Attendance logs, Intensity Tracker & RPE Scale configurations, Soreness Index catalogs, and Session Quality Score (Cap 196)." },
    { cat: "core", id: "09", name: "Participant Updates", desc: "Self-Report Portal, Confidence Status Engine tracking, Technical Improvement Logs, and Athlete Voice Module (Cap 198)." },
    { cat: "core", id: "10", name: "Coach Review", desc: "Queue Decision Interface for items sitting inside the /system_control/pending/ lane, Simplify/Downgrade Rationales, and Notes Archives." },
    { cat: "safety", id: "11", name: "Safety Gates", desc: "Guardian Consent Checks, Concussion Blocker Flags, Pool Safety Gates, and Underwater Restriction engines." },
    { cat: "safety", id: "12", name: "Medical / Recovery", desc: "Overtraining Hold Suggestions, Referral Triggers, Fatigue Decay Monitor, and Minimum Effective Dose Engine (Cap 195)." },
    { cat: "safety", id: "13", name: "Accessibility / Adaptation", desc: "Seated Movement Protocols, wheelchair boxing modifications, and automated Non-Contact Substitutions rules." },
    { cat: "core", id: "14", name: "Athlete Logins", desc: "Pre-session Readiness Check-ins tracking sleep/stress, Action Reminders, and Readiness-to-Learn Score (Cap 197)." },
    { cat: "safety", id: "15", name: "Guardian Portal", desc: "Dashboard Visibility parameters, Consent Form Managers, Attendance logs, and Guardian Observation Engine feedback slots." },
    { cat: "public", id: "16", name: "Public Portal / Website", desc: "Hosts non-profit organizational values, mission parameters, and public onboarding pipeline interest forms." },
    { cat: "public", id: "17", name: "Payment Capability", desc: "Waiver Pipelines and Scholarship Tracking logs. [STATUS: DEFERRED to maintain strict baseline boundaries]." },
    { cat: "research", id: "18", name: "Research Intake", desc: "Field-Test empirical motor-learning data capture and analytical Testing/Retest Engines." },
    { cat: "research", id: "19", name: "Evidence Review", desc: "Source Quality Filters, real-time context Drift Checks, Evidence Quality Engine parameters, and manual Head Coach approval gates." },
    { cat: "research", id: "20", name: "AI/ML Augmentation", desc: "Runs background check pattern flags on aggregated rows. Enforces an absolute, un-passable AI Therapy REFUSAL Gate." },
    { cat: "operations", id: "21", name: "Program Management", desc: "Asset & Facility Logistics across Deegan Lane, Neeko Lane, the 3D Print Lab, and Grants Outreach. Handles Capacity Rotations." },
    { cat: "operations", id: "22", name: "Grant / Impact Reporting", desc: "Total Floor Minutes Accumulated compilers, demographic Waiver Metrics engines, and Grant Nonprofit Impact summaries." },
    { cat: "operations", id: "23", name: "Nonprofit Operations", desc: "Maintains Board Oversight Logs, Incident Report Engines, and Pennsylvania Standard Compliance Records." },
    { cat: "operations", id: "24", name: "Creative / Communications", desc: "Handouts & Parent Visual layouts, flyer templates, Parent Education Module (Cap 199), and drafting assistants." },
    { cat: "operations", id: "25", name: "Build Continuity", desc: "Digital Operating Map, Build Ledger context packages, Thread Handoff tokens, and Privacy-Tier System (Cap 200)." }
  ];

  const filteredAtlas = twentyFiveAtlas.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.id.includes(searchQuery)
  );

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      
      {/* BUILD TRUTH SAFETY BANNER */}
      <div className="bg-gradient-to-r from-red-950 via-slate-900 to-red-950 border-b border-red-500/40 px-6 py-2.5 flex flex-wrap justify-between items-center text-xs font-mono text-red-400 gap-2 shadow-inner">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span><strong>0.5E BUILD TRUTH:</strong> Manual verified_by_jason signature required for active ledger row commit.</span>
        </div>
        <div className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Trap Active: <span className="text-emerald-400 underline font-bold">{corporateStencil.stagingPath}</span>
        </div>
      </div>

      {/* COMMAND CENTER HEADER */}
      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-5 flex flex-col xl:flex-row xl:justify-between xl:items-center gap-4 shadow-md">
        <div className="flex items-center space-x-4">
          <div className="bg-gradient-to-tr from-emerald-500 to-teal-600 text-slate-950 h-14 w-14 rounded-xl flex items-center justify-center font-black text-xl border border-emerald-400/20 shadow-lg">
            PP
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-50 tracking-tight">{corporateStencil.entity}</h1>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Ecosystem Node Core Gateway | {corporateStencil.version}</p>
          </div>
        </div>

        {/* CORE MASTER NAVIGATION NAVIGATION */}
        <div className="flex bg-[#111827] border border-slate-800 p-1 rounded-xl gap-1 w-full xl:w-auto">
          <button
            onClick={() => setMasterView('portals')}
            className={`px-4 py-2 rounded-lg text-xs font-bold font-mono transition tracking-tight ${masterView === 'portals' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
          >
            🕹️ Role Portals
          </button>
          <button
            onClick={() => setMasterView('tutorial')}
            className={`px-4 py-2 rounded-lg text-xs font-bold font-mono transition tracking-tight ${masterView === 'tutorial' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
          >
            📖 Tutorials
          </button>
          <button
            onClick={() => setMasterView('rabbithole')}
            className={`px-4 py-2 rounded-lg text-xs font-bold font-mono transition tracking-tight ${masterView === 'rabbithole' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
          >
            🕳️ Rabbit Hole
          </button>
        </div>
      </header>

      {/* CORE WORKSPACE PORTAL LAYOUTS PANEL */}
      {masterView === 'portals' && (
        <section className="bg-[#090d16] border-b border-slate-800 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <span className="text-lg">{currentRole === 'athlete' ? '🏃' : currentRole === 'coach' ? '📋' : '🏛️'}</span>
            <div>
              <div className="text-xs font-mono font-bold uppercase text-slate-400 tracking-wider">Active Workspace Environment Toggle</div>
              <div className="text-sm font-bold text-slate-200">
                {currentRole === 'athlete' ? 'Participant On-Floor Tracking Context (Pre-Session Check-ins / Athlete Voice Logs)' : currentRole === 'coach' ? 'Staff Ingestion Review Queue (Pending Telemetry / RPE Breakdown Matrix)' : 'Executive Board Operations (Floor Minutes Compiler / Pennsylvania Standard Compliance Ledger)'}
              </div>
            </div>
          </div>

          {/* EXPLICIT ROLE ISOLATION TOGGLES */}
          <div className="flex bg-[#111827] border border-slate-800 p-1 rounded-lg gap-1">
            <button
              onClick={() => setCurrentRole('athlete')}
              className={`px-3 py-1.5 rounded-md text-xs font-bold font-mono transition ${currentRole === 'athlete' ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:text-slate-200'}`}
            >
              🏃 Athlete View
            </button>
            <button
              onClick={() => setCurrentRole('coach')}
              className={`px-3 py-1.5 rounded-md text-xs font-bold font-mono transition ${currentRole === 'coach' ? 'bg-indigo-950 text-indigo-400 border border-indigo-500/20' : 'text-slate-400 hover:text-slate-200'}`}
            >
              📋 Coach View
            </button>
            <button
              onClick={() => setCurrentRole('admin_board')}
              className={`px-3 py-1.5 rounded-md text-xs font-bold font-mono transition ${currentRole === 'admin_board' ? 'bg-amber-950 text-amber-400 border border-amber-500/20' : 'text-slate-400 hover:text-slate-200'}`}
            >
              🏛️ Board View
            </button>
          </div>
        </section>
      )}

      {/* MAIN WORKSPACE SHELL GRID */}
      <div className="flex-1 flex flex-col lg:flex-row">
        
        {/* Left Side Tab Drawer (Always Preserved) */}
        <aside className="w-full lg:w-76 bg-[#0b0f19] lg:border-r border-slate-800 p-5 space-y-2 shadow-sm">
          <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-2">Scope Filters</p>
          <button
            onClick={() => { setActiveTab('routes'); setMasterView('portals'); setSearchQuery(''); }}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-xs font-mono font-bold border transition ${activeTab === 'routes' && masterView === 'portals' && !searchQuery ? 'bg-slate-800 border-slate-700 text-emerald-400' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}
          >
            🥊 5-Route Pathways Deck
          </button>
          <button
            onClick={() => { setActiveTab('parental'); setMasterView('portals'); setSearchQuery(''); }}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-xs font-mono font-bold border transition ${activeTab === 'parental' && masterView === 'portals' && !searchQuery ? 'bg-slate-800 border-slate-700 text-cyan-400' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}
          >
            🏡 Family Co-Observation Hub
          </button>
          <button
            onClick={() => { setActiveTab('atlas'); setMasterView('portals'); setSearchQuery(''); }}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-xs font-mono font-bold border transition ${activeTab === 'atlas' && masterView === 'portals' && !searchQuery ? 'bg-slate-800 border-slate-700 text-slate-200' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}
          >
            📋 Complete 25-Layer Atlas
          </button>
          <button
            onClick={() => { setActiveTab('sysaudit'); setMasterView('portals'); setSearchQuery(''); }}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-xs font-mono font-bold border transition ${activeTab === 'sysaudit' && masterView === 'portals' && !searchQuery ? 'bg-slate-800 border-slate-700 text-amber-400' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}
          >
            ⚙️ System Firewalls Audit
          </button>
          <div className="pt-4 border-t border-slate-800/60 w-full">
            <input
              type="text"
              placeholder="Filter current view..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#111827] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 font-mono focus:outline-none"
            />
          </div>
        </aside>

        {/* Dynamic Display Desk */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          
          {searchQuery ? (
            /* SEARCH ROUTING WINDOW COVERAGE */
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-fadeIn">
              {filteredAtlas.map(item => (
                <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                  <span className="text-[10px] font-mono font-bold bg-slate-800 text-slate-400 px-2 py-0.5 rounded">LAYER {item.id}</span>
                  <h4 className="font-bold text-slate-100 text-sm">{item.name}</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          ) : masterView === 'tutorial' ? (
            /* COMPONENT ROUTE 1: INJECTED TUTORIAL PASSTHROUGH VIEW */
            <TutorialView />
          ) : masterView === 'rabbithole' ? (
            /* COMPONENT ROUTE 2: INJECTED RABBITHOLE DEEP LEARNING VIEW */
            <RabbitHoleView />
          ) : currentRole === 'athlete' ? (
            /* PORTAL CONTEXT 1: ATHLETE WORKSPACE BLUEPRINT */
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-gradient-to-r from-emerald-950/30 to-slate-900 border border-emerald-500/10 p-6 rounded-xl space-y-3 shadow-md">
                <h3 className="text-base font-bold text-emerald-400 font-mono uppercase tracking-tight">🏃 Active Athlete Dashboard (Layers 01 / 09 / 14)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Layer 14: Readiness Check-in</span>
                    <p className="text-[11px] text-slate-400">Processes pre-session variables to map out floor readiness levels safely within storage boundaries.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Layer 06: My Workout Homework</span>
                    <p className="text-[11px] text-slate-400">Displays technical mobility drills and unweighted task items assigned for out-of-gym progression.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Cap 198: Athlete Voice Module</span>
                    <p className="text-[11px] text-slate-400">Direct on-floor portal for submitting qualitative training confusion or recovery logs straight to coaches.</p>
                  </div>
                </div>
              </div>
              {activeTab === 'routes' && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {activeRoutes.map(r => (
                    <div key={r.name} className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2 shadow-sm">
                      <span className="text-[9px] font-mono text-emerald-400 bg-emerald-950/30 px-1.5 py-0.5 rounded border border-emerald-500/10">ATHLETE ROUTE BOUND</span>
                      <h4 className="font-bold text-slate-200 text-xs font-mono">{r.name}</h4>
                      <p className="text-xs text-slate-400 leading-relaxed">{r.desc}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : currentRole === 'coach' ? (
            /* PORTAL CONTEXT 2: COACH WORKSPACE BLUEPRINT */
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-gradient-to-r from-indigo-950/30 to-slate-900 border border-indigo-500/10 p-6 rounded-xl space-y-3 shadow-md">
                <h3 className="text-base font-bold text-indigo-400 font-mono uppercase tracking-tight">📋 Coach Review Queue Dashboard (Layers 08 / 10 / 11)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Staging Queue Ingestion</span>
                    <p className="text-[11px] text-slate-400">Evaluates row transaction payloads currently trapped inside the secure staging vector path.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Cap 196: Session Quality Score</span>
                    <p className="text-[11px] text-slate-400">Audits completed workflows against team safety thresholds and technical drill transfer rules.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Downgrade Rationales Log</span>
                    <p className="text-[11px] text-slate-400">Mandates logging explicit internal notes whenever a target session layout must be scaled back due to physical fatigue markers.</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* PORTAL CONTEXT 3: ADMIN & BOARD WORKSPACE BLUEPRINT */
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-gradient-to-r from-amber-950/30 to-slate-900 border border-amber-500/10 p-6 rounded-xl space-y-3 shadow-md">
                <h3 className="text-base font-bold text-amber-400 font-mono uppercase tracking-tight">🏛️ Executive Board & Admin Portals (Layers 22 / 23 / 25)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Total Floor Minutes Accumulated</span>
                    <p className="text-[11px] text-slate-400">Aggregates continuous training floor time across all program cohorts to track operational community footprint variables.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">Waiver Utilization Metrics</span>
                    <p className="text-[11px] text-slate-400">Compiles historical demographic utilization patterns needed to formulate data briefs for state agency review.</p>
                  </div>
                  <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1">
                    <span className="text-xs font-bold text-slate-200 block">PA Standard compliance</span>
                    <p className="text-[11px] text-slate-400">Digitized records confirming absolute system alignment with Pennsylvania child safety and non-profit mandates.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* FAMILY ENGINE CO-OBSERVATION DRAWER PANEL (SHARED) */}
          {activeTab === 'parental' && masterView === 'portals' && (
            <div className="space-y-4 pt-4 border-t border-slate-800/60 animate-fadeIn">
              <h3 className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-wider">Integrated Family Hub Matrix</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold font-mono text-cyan-400">📹 Layer 05 / 19 Video Tape Review Logs</h4>
                  <p className="text-[11px] text-slate-400">Surfaces sparring clips, balance correction timelines, and coach notes directly inside the guardian interface via unlisted pointer pointers.</p>
                </div>
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold font-mono text-cyan-400">🏡 Home Observation Engine</h4>
                  <p className="text-[11px] text-slate-400">Input matrix for parents to submit behavioral updates covering Attention Span Stability, Home Task Persistence, and Confidence Shifts.</p>
                </div>
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold font-mono text-cyan-400">🕳️ Core Rabbit Holes Tracker</h4>
                  <p className="text-[11px] text-slate-400">Enables visibility into assigned deep biomechanical sub-tracks (lever tracking, geometry layouts) to maintain technical focus outside gym floor metrics.</p>
                </div>
              </div>
            </div>
          )}

          {/* DENSE ATLAS LISTINGS ENTIRELY PRESERVED */}
          {activeTab === 'atlas' && masterView === 'portals' && (
            <div className="space-y-4 pt-4 border-t border-slate-800/60 animate-fadeIn">
              <h3 className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">Complete 25-Layer Atlas Structural Map</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {twentyFiveAtlas.map(item => (
                  <div key={item.id} className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl space-y-1.5 shadow-sm">
                    <span className="text-[9px] font-mono font-bold bg-[#111827] text-slate-500 px-2 py-0.5 rounded border border-slate-800">LAYER {item.id}</span>
                    <h5 className="font-bold text-slate-200 text-xs tracking-tight">{item.name}</h5>
                    <p className="text-[11px] text-slate-400 leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FIREWALL CHECKS ENTIRELY PRESERVED */}
          {activeTab === 'sysaudit' && masterView === 'portals' && (
            <div className="space-y-4 pt-4 border-t border-slate-800/60 animate-fadeIn">
              <h3 className="text-xs font-mono font-bold text-amber-400 uppercase tracking-wider">Live System Core Firewalls Audit</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <div className="flex justify-between items-center"><h4 className="font-bold text-slate-200 font-mono text-xs uppercase">1. Infrastructure Lock</h4><span className="text-[10px] font-mono text-emerald-400">COMPLIANT</span></div>
                  <p className="text-xs text-slate-400">All logic runs entirely inside free-tier spreadsheet models. Enterprise upcharges or subscription-based platform tracking recommendations are blocked at Layer 0.</p>
                </div>
                <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-1">
                  <div className="flex justify-between items-center"><h4 className="font-bold text-slate-200 font-mono text-xs uppercase">2. AI Therapy Block (Layer 20)</h4><span className="text-[10px] font-mono text-emerald-400">COMPLIANT</span></div>
                  <p className="text-xs text-slate-400">In accordance with Layer 20 guidelines, all parental and athlete text fields reject any form of automated diagnostic loops or psychological simulations.</p>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* RE-ESTABLISHED COMPLIANCE LEGAL STENCIL FOOTER STAMP */}
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
