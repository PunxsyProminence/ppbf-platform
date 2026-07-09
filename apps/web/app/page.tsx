'use client';

import React, { useState } from 'react';
import PerformanceDeck from '../components/PerformanceDeck';
import FamilyHub from '../components/FamilyHub';
import AtlasRegistry from '../components/AtlasRegistry';
import ExecutiveBoardPanel from '../components/ExecutiveBoardPanel';

type WorkspaceID = 
  | 'core_plat' | 'profile_sys' | 'gov_layer' | 'role_perm' | 'web_access'
  | 'class_eng' | 'adapt_prof' | 'asym_mon' | 'body_comp' | 'waist_track'
  | 'cohort_seg' | 'youth_limit' | 'tactical_trans' | 'goal_intake' | 'base_capt'
  | 'target_out' | 'goal_mgmt' | 'isolated_track' | 'period_eng' | 'swim_screen'
  | 'swim_prog' | 'video_analysis' | 'adaptive_loop' | 'rule_adj' | 'sparring_gates'
  | 'public_preview' | 'volunteer_support' | 'outcome_transfer' | 'nonprofit_impact'
  | 'atlas_registry' | 'sys_audit';

export default function PPBFMasterEcosystemConsole() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceID>('core_plat');
  const [searchQuery, setSearchQuery] = useState('');

  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0 - 0.5E Engine",
    stagingPath: "/system_control/pending/",
    infrastructure: "Free-Tier Google Sheets + Firebase Native Stack"
  };

  // Full 31-Item Navigation Taxonomy Mapping Targets
  const navigationTaxonomy = [
    { id: 'core_plat', name: '01. Core Platform', cat: 'Core Platform' },
    { id: 'profile_sys', name: '02. Athlete Profiles', cat: 'Core Platform' },
    { id: 'gov_layer', name: '03. App Governance', cat: 'Core Platform' },
    { id: 'role_perm', name: '04. Role Permissions', cat: 'Core Platform' },
    { id: 'web_access', name: '05. Web/Mobile Layouts', cat: 'Core Platform' },
    { id: 'class_eng', name: '06. Classification Engine', cat: 'Participant Mgmt' },
    { id: 'adapt_prof', name: '07. Adaptation Profiles', cat: 'Participant Mgmt' },
    { id: 'asym_mon', name: '08. Asymmetry Monitor', cat: 'Participant Mgmt' },
    { id: 'body_comp', name: '09. Body Composition', cat: 'Participant Mgmt' },
    { id: 'waist_track', name: '10. Waist Track Context', cat: 'Participant Mgmt' },
    { id: 'cohort_seg', name: '11. Cohort Segmentation', cat: 'Range & Goals' },
    { id: 'youth_limit', name: '12. Youth Program Limit', cat: 'Range & Goals' },
    { id: 'tactical_trans', name: '13. Tactical Transfer', cat: 'Range & Goals' },
    { id: 'goal_intake', name: '14. Goal Intake System', cat: 'Range & Goals' },
    { id: 'base_capt', name: '15. Baseline Capture', cat: 'Range & Goals' },
    { id: 'target_out', name: '16. Target Outcome Map', cat: 'Range & Goals' },
    { id: 'goal_mgmt', name: '17. Goal Management', cat: 'Range & Goals' },
    { id: 'isolated_track', name: '18. Isolated Track Frameworks', cat: 'Routes & Logging' },
    { id: 'period_eng', name: '19. Periodization Engine', cat: 'Routes & Logging' },
    { id: 'swim_screen', name: '20. Swim Screen Module', cat: 'Routes & Logging' },
    { id: 'swim_prog', name: '21. Swim Progression', cat: 'Routes & Logging' },
    { id: 'video_analysis', name: '22. Video Analysis Tape Logs', cat: 'Routes & Logging' },
    { id: 'adaptive_loop', name: '23. Adaptive Closed Loop', cat: 'New Capabilities' },
    { id: 'rule_adj', name: '24. Rule / Adjustment Engine', cat: 'New Capabilities' },
    { id: 'sparring_gates', name: '25. Contact / Sparring Gates', cat: 'New Capabilities' },
    { id: 'public_preview', name: '26. Public Website Preview', cat: 'New Capabilities' },
    { id: 'volunteer_support', name: '27. Volunteer & Staff Support', cat: 'New Capabilities' },
    { id: 'outcome_transfer', name: '28. Outcome Transfer Matrix', cat: 'Analytics & Impact' },
    { id: 'nonprofit_impact', name: '29. Nonprofit Impact Outcomes', cat: 'Analytics & Impact' },
    { id: 'atlas_registry', name: '30. Core 25-Layer Atlas', cat: 'Analytics & Impact' },
    { id: 'sys_audit', name: '31. System Firewalls Audit', cat: 'Analytics & Impact' },
  ] as const;

  const categories = Array.from(new Set(navigationTaxonomy.map(item => item.cat)));

  // Mock Component Mapping for Scaffolding Enforcer
  const renderWorkspaceContent = () => {
    switch (activeWorkspace) {
      case 'isolated_track':
        return <PerformanceDeck />;
      case 'video_analysis':
      case 'adaptive_loop':
        return <FamilyHub />;
      case 'nonprofit_impact':
        return <ExecutiveBoardPanel />;
      case 'atlas_registry':
        return <AtlasRegistry />;
      default:
        // Generic metadata layout shell handling requested security decorators natively
        const target = navigationTaxonomy.find(t => t.id === activeWorkspace);
        return (
          <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
            {/* Authority Banner */}
            <div className="bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-4 py-2.5 rounded-lg text-xs font-mono flex items-center justify-between">
              <span>🛡️ <strong>AUTHORITY BANNER:</strong> Human Verification Obligation. Head Coach Jason check flag signature required.</span>
              <span className="text-[10px] bg-indigo-900/40 px-2 py-0.5 rounded uppercase font-bold">Coach Clearance Required</span>
            </div>

            <div className="border-b border-slate-800 pb-3 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
              <div>
                <h2 className="text-xl font-black text-slate-100 font-mono">{target?.name}</h2>
                <p className="text-xs text-slate-400 font-mono mt-0.5">Sub-engine execution layout boundary matrix</p>
              </div>
              {/* Sensitivity Tag */}
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-wider uppercase">
                ⚠️ Safety-Critical / Admin-Only
              </span>
            </div>

            {/* Empty / Error Mock State Container */}
            <div className="bg-[#111827] border border-dashed border-slate-800/80 rounded-xl p-12 text-center space-y-2 shadow-inner">
              <div className="text-xl">🛑</div>
              <h4 className="text-sm font-bold text-slate-300 font-mono">0.5E Local Frontend Shell Limitation</h4>
              <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed font-mono">
                Error State Code: <code className="text-amber-400">[Backend not connected]</code>. Remote Google Dataverse connection points are currently deferred to protect free-tier boundaries.
              </p>
            </div>

            {/* Audit Trail Placeholder Block */}
            <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 space-y-2 text-[11px] font-mono text-slate-400">
              <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">System Compliance History Audit Trail</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-left">
                <div><span className="text-slate-600">Created By:</span> System Ingestion Engine</div>
                <div><span className="text-slate-600">Created Date:</span> 2026-07-09</div>
                <div><span className="text-slate-600">Last Reviewed By:</span> Head Coach Jason</div>
                <div><span className="text-slate-600">Decision Reason:</span> Verified alignment with Local Rank constraints</div>
                <div className="col-span-1 md:col-span-2 truncate"><span className="text-slate-600">Source Link:</span> <span className="text-emerald-400 underline">/system_control/pending/layer_sync</span></div>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      
      {/* 0.5E BUILD TRUTH SAFETY BANNER */}
      <div className="bg-gradient-to-r from-red-950 via-slate-900 to-red-950 border-b border-red-500/40 px-6 py-2.5 flex flex-wrap justify-between items-center text-xs font-mono text-red-400 gap-2 shadow-inner">
        <div className="flex items-center space-x-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span><strong>0.5E BUILD TRUTH:</strong> System Promotion Algorithm Deactivated. Manual Jason signature required.</span>
        </div>
        <div className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
          Staging Target: <span className="text-emerald-400 underline font-bold">{corporateStencil.stagingPath}</span>
        </div>
      </div>

      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4 shadow-md">
        <div>
          <h1 className="text-2xl font-black text-slate-50 tracking-tight">{corporateStencil.entity}</h1>
          <p className="text-xs text-slate-400 font-mono">{corporateStencil.version} | Context: {corporateStencil.infrastructure}</p>
        </div>
        <div className="text-xs font-mono text-slate-500 text-center sm:text-right bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
          ⚖️ Stencil Official: <span className="text-slate-300">204 PENNSYLVANIA AVE, BIG RUN, PA</span>
        </div>
      </header>

      {/* THREE ISOLATED CORE DISPLAY ENVIRONMENTS */}
      <div className="flex-1 flex flex-col lg:flex-row">
        
        {/* Left Side Navigation Panel Panel */}
        <aside className="w-full lg:w-80 bg-[#0b0f19] lg:border-r border-slate-800 p-4 space-y-4 shadow-sm overflow-y-auto max-h-[100vh] lg:sticky lg:top-0">
          <div className="space-y-4">
            {categories.map(cat => (
              <div key={cat} className="space-y-1">
                <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono px-1 mb-1.5">{cat}</p>
                {navigationTaxonomy.filter(item => item.cat === cat).map(item => (
                  <button
                    key={item.id}
                    onClick={() => setActiveWorkspace(item.id)}
                    className={`w-full text-left px-3 py-2 rounded-xl text-xs font-mono font-bold border transition truncate flex items-center justify-between ${activeWorkspace === item.id ? 'bg-gradient-to-r from-emerald-950/40 to-slate-900 border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'}`}
                  >
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* Dynamic Display Desk Main Component */}
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          {renderWorkspaceContent()}
        </main>
      </div>
    </div>
  );
}
