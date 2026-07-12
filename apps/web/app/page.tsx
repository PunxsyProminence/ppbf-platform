'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import AthleteWorkspace from '../components/AthleteWorkspace';
import CoachWorkspace from '../components/CoachWorkspace';
import AdminWorkspace from '../components/AdminWorkspace';
import ExecutiveBoardPanel from '../components/ExecutiveBoardPanel';
import FamilyHub from '../components/FamilyHub';
import AtlasRegistry from '../components/AtlasRegistry';

type RoleViewID = 'athlete_view' | 'coach_view' | 'admin_view' | 'board_view' | 'family_view' | 'atlas_view';

export default function PPBFMasterEcosystemConsole() {
  const [activeRoleView, setActiveRoleView] = useState<RoleViewID>('athlete_view');

  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0 - Shell 0.5E",
    stagingPath: "/system_control/pending/",
    infrastructure: "Azure Non-Profit Cloud Credits ($2,000/yr Grant)"
  };

  const roleNavigationTaxonomy = [
    { id: 'athlete_view', name: '🏃 Athlete Workspace', cat: 'Ecosystem Gateways' },
    { id: 'coach_view', name: '📋 Coach Workspace', cat: 'Ecosystem Gateways' },
    { id: 'admin_view', name: '⚙️ Admin Workspace', cat: 'Ecosystem Gateways' },
    { id: 'board_view', name: '🏛️ Board Member Panel', cat: 'Ecosystem Gateways' },
    { id: 'family_view', name: '🏡 Family Observation Hub', cat: 'System Indexes' },
    { id: 'atlas_view', name: '📋 Core 25-Layer Atlas', cat: 'System Indexes' }
  ] as const;

  const categories = Array.from(new Set(roleNavigationTaxonomy.map(item => item.cat)));

  const renderActiveRoleWorkspace = () => {
    switch (activeRoleView) {
      case 'athlete_view':
        return <AthleteWorkspace />;
      case 'coach_view':
        return <CoachWorkspace />;
      case 'admin_view':
        return <AdminWorkspace />;
      case 'board_view':
        return <ExecutiveBoardPanel />;
      case 'family_view':
        return <FamilyHub />;
      case 'atlas_view':
        return <AtlasRegistry />;
      default:
        return <AthleteWorkspace />;
    }
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      {/* 0.5E BUILD TRUTH SAFETY BANNER */}
      <div className="bg-gradient-to-r from-red-950 via-slate-900 to-red-950 border-b border-red-500/40 px-6 py-2.5 flex flex-wrap justify-between items-center text-xs font-mono text-red-400 gap-2 shadow-inner">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span><strong>0.5E BUILD TRUTH BANNER:</strong> Every transaction telemetry packet routes strictly through pending gateway path variables.</span>
        </div>
        <div className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Path: <span className="text-emerald-400 underline font-bold">{corporateStencil.stagingPath}</span>
        </div>
      </div>

      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4 shadow-md">
        <div>
          <h1 className="text-2xl font-black text-slate-50 tracking-tight">{corporateStencil.entity}</h1>
          <p className="text-xs text-slate-400 font-mono">{corporateStencil.version} | Tech Stack: {corporateStencil.infrastructure}</p>
        </div>
        <Link
          href="/launch"
          className="inline-flex items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-mono font-bold text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-200"
        >
          Open Launch Portal
        </Link>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Left Side Role Selector Navigation Panel */}
        <aside className="w-full lg:w-80 bg-[#0b0f19] lg:border-r border-slate-800 p-4 space-y-4 shadow-sm overflow-y-auto max-h-[100vh] lg:sticky lg:top-0">
          <div className="space-y-4">
            {categories.map(cat => (
              <div key={cat} className="space-y-1">
                <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-1.5">{cat}</p>
                {roleNavigationTaxonomy.filter(item => item.cat === cat).map(item => (
                  <button
                    key={item.id}
                    onClick={() => setActiveRoleView(item.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-mono font-bold border transition truncate flex items-center justify-between ${activeRoleView === item.id ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
                  >
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* Dynamic Role Workstation display board */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          {renderActiveRoleWorkspace()}
        </main>
      </div>
    </div>
  );
}
