'use client';
import React, { useState } from 'react';
import PerformanceDeck from '../components/PerformanceDeck';
import FamilyHub from '../components/FamilyHub';
import AtlasRegistry from '../components/AtlasRegistry';

type WorkspaceType = 'dashboard' | 'parental' | 'atlas';

export default function PPBFMasterEcosystemNode() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceType>('dashboard');

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      {/* IMMUTABLE GATES WARNING RIBBON */}
      <div className="bg-gradient-to-r from-amber-600/20 to-red-600/20 border-b border-amber-500/30 px-6 py-2 flex flex-wrap justify-between items-center text-xs font-mono text-amber-400 gap-2">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
          <span><strong>IMMUTABLE IMMUNITY GATES ACTIVE:</strong> Head Coach Jason signature flag required for all progression.</span>
        </div>
        <div className="bg-slate-900/60 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Target: <span className="text-emerald-400 underline font-bold">/system_control/pending/</span>
        </div>
      </div>

      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-5 flex justify-between items-center shadow-md">
        <div>
          <h1 className="text-2xl font-black text-slate-50 tracking-tight">Punxsy Prominence Boxing and Fitness</h1>
          <p className="text-xs text-slate-400 font-mono">Production Build v21.0 | Free-Tier Google Sheets + Firebase</p>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Left Side Panel - Clean Router */}
        <aside className="w-full lg:w-76 bg-[#0b0f19] lg:border-r border-slate-800 p-5 space-y-2.5 shadow-sm">
          <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-2">Ecosystem Control Hub</p>
          
          <button onClick={() => setActiveWorkspace('dashboard')} className={`w-full text-left px-4 py-3 rounded-xl transition border ${activeWorkspace === 'dashboard' ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}>
            🥊 5-Route Performance Deck
          </button>

          <button onClick={() => setActiveWorkspace('parental')} className={`w-full text-left px-4 py-3 rounded-xl transition border ${activeWorkspace === 'parental' ? 'bg-gradient-to-r from-cyan-950/40 to-slate-900 border-cyan-500 text-cyan-400 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}>
            🏡 Family Co-Observation Hub
          </button>

          <button onClick={() => setActiveWorkspace('atlas')} className={`w-full text-left px-4 py-3 rounded-xl transition border ${activeWorkspace === 'atlas' ? 'bg-gradient-to-r from-slate-800 to-slate-900 border-slate-700 text-slate-200 font-bold' : 'border-transparent text-slate-400 hover:bg-slate-800/40'}`}>
            📋 Core 25-Layer Atlas
          </button>
        </aside>

        {/* Dynamic Display Board - Injects the Components */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          {activeWorkspace === 'dashboard' && <PerformanceDeck />}
          {activeWorkspace === 'parental' && <FamilyHub />}
          {activeWorkspace === 'atlas' && <AtlasRegistry />}
        </main>
      </div>
    </div>
  );
}
