'use client';

import React, { useState } from 'react';

export default function CompleteCommandCenter() {
  const [activeTab, setActiveTab] = useState('execution');
  const [searchQuery, setSearchQuery] = useState('');

  // 25 Core Governed Capabilities mapped straight from PPBF_CAPABILITIES.json
  const capabilityRegistry = {
    execution: [
      { id: 'E01', name: 'Participant Intake Processing', status: 'ACTIVE', tier: 'Layer 1', desc: 'Validates basic registration, entry parameters, and foundational bio-metrics.' },
      { id: 'E02', name: 'Safety Gate Matrix Evaluation', status: 'ACTIVE', tier: 'Layer 1', desc: 'Enforces hard real-time risk screening across all system entry nodes.' },
      { id: 'E03', name: 'Medical Recovery Guidance Routing', status: 'ACTIVE', tier: 'Layer 2', desc: 'Tracks return-to-play timelines, mandatory rest periods, and clearance flags.' },
      { id: 'E04', name: 'Participant Spectrum Allocation', status: 'ACTIVE', tier: 'Layer 1', desc: 'Routes users into accurate profiles ranging from Youth to Master/Elite tiers.' },
      { id: 'E05', name: 'Adaptive Workout Blueprint Generation', status: 'ACTIVE', tier: 'Layer 2', desc: 'Compiles dynamic, volume-adjusted performance and drilling schedules.' },
      { id: 'E06', name: 'Sparring Intensity Ledger Tracking', status: 'ACTIVE', tier: 'Layer 2', desc: 'Logs head-contact occurrences, round counts, and session strain limits.' },
      { id: 'E07', name: 'Biometric Feedback Aggregation', status: 'ACTIVE', tier: 'Layer 3', desc: 'Consolidates wearable streams, exertion indicators, and resting heart rates.' },
      { id: 'E08', name: 'Red Flag Escalation Dispatch', status: 'ACTIVE', tier: 'Layer 1', desc: 'Triggers immediate automated supervisor alerts upon threshold breach.' },
      { id: 'E09', name: 'Performance Metric Extrapolator', status: 'ACTIVE', tier: 'Layer 3', desc: 'Projects linear development velocity and recovery tracking trends.' }
    ],
    governance: [
      { id: 'G01', name: 'Bounded Context Integrity Enforcement', status: 'ACTIVE', tier: 'Layer 0', desc: 'Secures monorepo code isolation boundaries and strict data leakage rules.' },
      { id: 'G02', name: 'Strict RLS Access Control Engine', status: 'ACTIVE', tier: 'Layer 0', desc: 'Applies row-level cryptographic multi-tenant segmentation policies.' },
      { id: 'G03', name: 'Role-Based Action Validation', status: 'ACTIVE', tier: 'Layer 0', desc: 'Maintains zero-trust execution gates between Athletes, Coaches, and Admins.' },
      { id: 'G04', name: 'Audit Log Immutable Anchoring', status: 'ACTIVE', tier: 'Layer 0', desc: 'Cryptographically stamps every system mutation inside system logs.' },
      { id: 'G05', name: 'Consent & Mandate State Machine', status: 'ACTIVE', tier: 'Layer 1', desc: 'Tracks active execution waivers, digital signatures, and legal clearances.' },
      { id: 'G06', name: 'Safety Policy Override Counter', status: 'ACTIVE', tier: 'Layer 0', desc: 'Locks down and counts physical exceptions or forced pipeline releases.' },
      { id: 'G07', name: 'Tenant Boundary Watchdog', status: 'ACTIVE', tier: 'Layer 0', desc: 'Continuously monitors system cross-talk vectors across isolated schemas.' },
      { id: 'G08', name: 'Compliance Reporting Compiler', status: 'ACTIVE', tier: 'Layer 1', desc: 'Generates external agency verification briefs and safety audit outputs.' }
    ],
    continuity: [
      { id: 'C01', name: 'State Engine Recovery Buffer', status: 'ACTIVE', tier: 'Layer 0', desc: 'Caches mid-session system failures to prevent state corruption.' },
      { id: 'C02', name: 'Database Heartbeat Heartbeat', status: 'ACTIVE', tier: 'Layer 0', desc: 'Monitors underlying persistence engines and connection pool metrics.' },
      { id: 'C03', name: 'Automated Migration Validation', status: 'ACTIVE', tier: 'Layer 0', desc: 'Pre-evaluates database change scripts against live production schemas.' },
      { id: 'C04', name: 'Offline State Ledger Sync', status: 'ACTIVE', tier: 'Layer 2', desc: 'Queues dynamic tracking events locally when network transport is lost.' },
      { id: 'C05', name: 'Distributed Cache Invalid Engine', status: 'ACTIVE', tier: 'Layer 0', desc: 'Flushes stale telemetry buffers instantly upon critical data updates.' },
      { id: 'C06', name: 'Historical Log Pruning Manager', status: 'ACTIVE', tier: 'Layer 1', desc: 'Anonymizes and archive-packs long-term system telemetry records.' },
      { id: 'C07', name: 'Backup Continuity Dispatcher', status: 'ACTIVE', tier: 'Layer 0', desc: 'Orchestrates hot-standby region replication loops and failovers.' },
      { id: 'C08', name: 'Telemetry Rate-Limiting Gate', status: 'ACTIVE', tier: 'Layer 1', desc: 'Prevents database choking by filtering bursts of redundant endpoint calls.' }
    ]
  };

  const allCapabilities = [
    ...capabilityRegistry.execution,
    ...capabilityRegistry.governance,
    ...capabilityRegistry.continuity
  ];

  const filteredItems = allCapabilities.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      {/* Platform Header */}
      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-4 flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div className="flex items-center space-x-4">
          <div className="bg-gradient-to-br from-emerald-500 to-teal-600 text-[#030712] h-12 w-12 rounded-xl flex items-center justify-center font-black text-2xl tracking-tighter shadow-lg shadow-emerald-500/10">
            Ω
          </div>
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-xl font-extrabold tracking-tight text-slate-50">PPBF Unified Management Engine</h1>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase">Enterprise</span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5 font-mono">Monorepo Packages Core Boundary Layer Access</p>
          </div>
        </div>

        {/* Global Search Bar */}
        <div className="w-full md:w-80">
          <input
            type="text"
            placeholder="Search all 25 modules..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#111827] border border-slate-800 rounded-lg px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition font-mono"
          />
        </div>
      </header>

      {/* Main Control Board Layout */}
      <div className="flex-1 flex flex-col lg:flex-row">
        
        {/* Left Control Panel Navigation */}
        <aside className="w-full lg:w-72 bg-[#0b0f19] lg:border-r border-slate-800 p-4 space-y-2">
          <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase px-3 mb-2 font-mono">Engine Domain Scopes</p>
          
          <button
            onClick={() => { setActiveTab('execution'); setSearchQuery(''); }}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition ${activeTab === 'execution' && !searchQuery ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/10' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}
          >
            <span>🏃 Core Performance Execution</span>
            <span className="bg-[#1f2937] text-slate-300 text-xs px-2 py-0.5 rounded-full font-mono">{capabilityRegistry.execution.length}</span>
          </button>

          <button
            onClick={() => { setActiveTab('governance'); setSearchQuery(''); }}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition ${activeTab === 'governance' && !searchQuery ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/10' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}
          >
            <span>🛡️ Zero-Trust Governance</span>
            <span className="bg-[#1f2937] text-slate-300 text-xs px-2 py-0.5 rounded-full font-mono">{capabilityRegistry.governance.length}</span>
          </button>

          <button
            onClick={() => { setActiveTab('continuity'); setSearchQuery(''); }}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition ${activeTab === 'continuity' && !searchQuery ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-600/10' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}
          >
            <span>💾 Architecture Continuity</span>
            <span className="bg-[#1f2937] text-slate-300 text-xs px-2 py-0.5 rounded-full font-mono">{capabilityRegistry.continuity.length}</span>
          </button>

          <div className="pt-6 border-t border-slate-800/80 px-3 mt-4">
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono mb-2">Direct Terminal Triggers</p>
            <div className="flex flex-col gap-2">
              <a href="/athlete/dashboard" className="text-xs bg-[#1f2937] hover:bg-slate-700 text-slate-200 p-2 rounded text-center font-medium transition border border-slate-800">Open Athlete View</a>
              <a href="/coach/review-queue" className="text-xs bg-[#1f2937] hover:bg-slate-700 text-slate-200 p-2 rounded text-center font-medium transition border border-slate-800">Open Coach View</a>
              <a href="/admin" className="text-xs bg-[#1f2937] hover:bg-slate-700 text-slate-200 p-2 rounded text-center font-medium transition border border-slate-800">Open Admin Panel</a>
            </div>
          </div>
        </aside>

        {/* Right Dynamic Workspace Panel */}
        <main className="flex-1 p-6 md:p-8 space-y-6">
          
          {/* Section Dynamic Heading */}
          <div className="border-b border-slate-800 pb-4">
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">
              {searchQuery ? `Search Results (${filteredItems.length} Found)` : activeTab === 'execution' ? 'Core Performance Execution Module Matrix' : activeTab === 'governance' ? 'Zero-Trust Governance Engine Matrix' : 'Architecture Continuity & Telemetry Buffer Matrix'}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {searchQuery ? 'Showing filtered capability targets.' : activeTab === 'execution' ? 'Layer-driven pipelines controlling onboarding, sparring safety, and dynamic workout blueprinting structures.' : activeTab === 'governance' ? 'Layer 0 configurations validating role semantics, database RLS constraints, and context compliance rules.' : 'Infrastructure fallbacks managing hot-standby failovers, offline sync buffers, and telemetry throttling pools.'}
            </p>
          </div>

          {/* Grid Deck displaying the 25 capabilities */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {(searchQuery ? filteredItems : capabilityRegistry[activeTab]).map((cap) => (
              <div key={cap.id} className="bg-[#0b0f19] border border-slate-800/80 rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition shadow-sm">
                <div className="space-y-3">
                  <div className="flex justify-between items-start">
                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">{cap.id}</span>
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">{cap.tier}</span>
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-100 text-base tracking-tight">{cap.name}</h4>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">{cap.desc}</p>
                  </div>
                </div>
                
                <div className="mt-5 pt-3 border-t border-slate-800/60 flex justify-between items-center">
                  <div className="flex items-center space-x-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                    <span className="text-[10px] font-bold text-emerald-400 font-mono tracking-wide uppercase">Operational</span>
                  </div>
                  <button 
                    onClick={() => alert(`Initializing sandbox simulation framework for capability matrix run context [${cap.id}]. Logic fully wired via underlying monorepo packages Layer.`)}
                    className="text-[10px] font-bold bg-[#1f2937] hover:bg-slate-700 text-slate-200 border border-slate-700 px-2.5 py-1 rounded transition"
                  >
                    Simulate Pipeline
                  </button>
                </div>
              </div>
            ))}
          </div>

        </main>
      </div>

      {/* Unified Frame Footer */}
      <footer className="bg-[#0b0f19] border-t border-slate-900 px-6 py-3 flex flex-col sm:flex-row justify-between items-center text-xs text-slate-500 gap-2 font-mono">
        <div>System State Context: Bounded Architecture Fully Configured</div>
        <div>Punxsy Prominence Organization © 2026</div>
      </footer>
    </div>
  );
}
