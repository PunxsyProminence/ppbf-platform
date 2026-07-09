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
  | 'atlas_registry' | 'sys_audit'
  | 'path_a2p' | 'path_collegiate' | 'path_pro_grade'; // 3 Specialized Pathways Injected

export default function PPBFMasterEcosystemConsole() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceID>('core_plat');
  const [searchQuery, setSearchQuery] = useState('');

  const corporateStencil = {
    entity: "Punxsy Prominence Boxing and Fitness",
    office: "204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715",
    version: "Production Build v21.0 - Core Shell",
    stagingPath: "/system_control/pending/",
    infrastructure: "Azure Non-Profit Cloud Credits ($2,000/yr Grant)"
  };

  const navigationTaxonomy = [
    { id: 'core_plat', name: '01. Core Platform', cat: 'Core Platform', sensitivity: 'Internal / Restricted' },
    { id: 'profile_sys', name: '02. Athlete Profiles', cat: 'Core Platform', sensitivity: 'Youth-Sensitive' },
    { id: 'gov_layer', name: '03. App Governance', cat: 'Core Platform', sensitivity: 'Admin-Only / Safety-Critical' },
    { id: 'role_perm', name: '04. Role Permissions', cat: 'Core Platform', sensitivity: 'Admin-Only / Safety-Critical' },
    { id: 'web_access', name: '05. Web/Mobile Layouts', cat: 'Core Platform', sensitivity: 'Public' },
    { id: 'class_eng', name: '06. Classification Engine', cat: 'Participant Mgmt', sensitivity: 'Coach-Only' },
    { id: 'adapt_prof', name: '07. Adaptation Profiles', cat: 'Participant Mgmt', sensitivity: 'Coach-Only' },
    { id: 'asym_mon', name: '08. Asymmetry Monitor', cat: 'Participant Mgmt', sensitivity: 'Research / Coach' },
    { id: 'body_comp', name: '09. Body Composition', cat: 'Participant Mgmt', sensitivity: 'Guardian-Sensitive' },
    { id: 'waist_track', name: '10. Waist Track Context', cat: 'Participant Mgmt', sensitivity: 'Guardian-Sensitive' },
    { id: 'cohort_seg', name: '11. Cohort Segmentation', cat: 'Range & Goals', sensitivity: 'Coach-Only' },
    { id: 'youth_limit', name: '12. Youth Program Limit', cat: 'Range & Goals', sensitivity: 'Safety-Critical' },
    { id: 'tactical_trans', name: '13. Tactical Transfer', cat: 'Range & Goals', sensitivity: 'Internal' },
    { id: 'goal_intake', name: '14. Goal Intake System', cat: 'Range & Goals', sensitivity: 'Athlete / Guardian' },
    { id: 'base_capt', name: '15. Baseline Capture', cat: 'Range & Goals', sensitivity: 'Internal / Reference' },
    { id: 'target_out', name: '16. Target Outcome Map', cat: 'Range & Goals', sensitivity: 'Internal' },
    { id: 'goal_mgmt', name: '17. Goal Management', cat: 'Range & Goals', sensitivity: 'Internal' },
    { id: 'isolated_track', name: '18. Isolated Track Frameworks', cat: 'Routes & Logging', sensitivity: 'Athlete Latin Ranks Track' },
    { id: 'period_eng', name: '19. Periodization Engine', cat: 'Routes & Logging', sensitivity: 'Coach-Only' },
    { id: 'swim_screen', name: '20. Swim Screen Module', cat: 'Routes & Logging', sensitivity: 'SpecOps Track / Safety' },
    { id: 'swim_prog', name: '21. Swim Progression', cat: 'Routes & Logging', sensitivity: 'SpecOps Track / Safety' },
    { id: 'video_analysis', name: '22. Video Analysis Tape Logs', cat: 'Routes & Logging', sensitivity: 'Media / Video Restricted' },
    { id: 'path_a2p', name: '23. A2P (Adaptive-to-Performance)', cat: 'Specialized Performance Pathways', sensitivity: 'Seated / Non-Contact Track' },
    { id: 'path_collegiate', name: '24. Collegiate Student-Athlete Line', cat: 'Specialized Performance Pathways', sensitivity: 'Academic Priority / Credit Log' },
    { id: 'path_pro_grade', name: '25. Pro-Grade Performance Track', cat: 'Specialized Performance Pathways', sensitivity: 'High-Volume Strain / Recovery' },
    { id: 'adaptive_loop', name: '26. Adaptive Closed Loop', cat: 'New Capabilities', sensitivity: 'Coach-Only / Adaptive' },
    { id: 'rule_adj', name: '27. Rule / Adjustment Engine', cat: 'New Capabilities', sensitivity: 'Coach-Only' },
    { id: 'sparring_gates', name: '28. Contact / Sparring Gates', cat: 'New Capabilities', sensitivity: 'Safety-Critical / Jason Sign-Off' },
    { id: 'public_preview', name: '29. Public Website Preview', cat: 'New Capabilities', sensitivity: 'Public' },
    { id: 'volunteer_support', name: '30. Volunteer & Staff Support', cat: 'New Capabilities', sensitivity: 'Internal' },
    { id: 'outcome_transfer', name: '31. Outcome Transfer Matrix', cat: 'Analytics & Impact', sensitivity: 'Research-Draft / Board' },
    { id: 'nonprofit_impact', name: '32. Nonprofit Impact Outcomes', cat: 'Analytics & Impact', sensitivity: 'Board-Only / Grant Summary' },
    { id: 'atlas_registry', name: '33. Core 25-Layer Atlas', cat: 'Analytics & Impact', sensitivity: 'Internal / Core Index' },
    { id: 'sys_audit', name: '34. System Firewalls Audit', cat: 'Analytics & Impact', sensitivity: 'Admin-Only / Safety-Critical' },
  ] as const;

  const categories = Array.from(new Set(navigationTaxonomy.map(item => item.cat)));

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
      case 'path_a2p':
        return (
          <div className="space-y-4 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
            <div className="bg-emerald-950/40 text-emerald-400 border border-emerald-500/20 px-4 py-2.5 rounded-lg text-xs font-mono">
              🛡️ <strong>A2P PATHWAY ENGINE:</strong> Integrated with Layer 13 parameters for seated structural movements and protective non-contact substitutions.
            </div>
            <h2 className="text-xl font-black text-slate-100 font-mono">A2P (Adaptive-to-Performance) Route</h2>
            <p className="text-xs text-slate-400 leading-relaxed font-mono">Custom performance tracing designed for disabled, rehabilitation, or adaptive athletic tracks. Completely mirrors standard progression blocks with structural safety constraints enabled.</p>
          </div>
        );
      case 'path_collegiate':
        return (
          <div className="space-y-4 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
            <div className="bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-4 py-2.5 rounded-lg text-xs font-mono">
              🏛️ <strong>COLLEGIATE PATHWAY ENGINE:</strong> Ties academic credit compliance and study tracking logs with physical training maps.
            </div>
            <h2 className="text-xl font-black text-slate-100 font-mono">Collegiate Student-Athlete Line</h2>
            <p className="text-xs text-slate-400 leading-relaxed font-mono">Enforces strict academic prioritization routines. Integrates tracking variables capturing class attendance, passing grade verification, and training-hour balances.</p>
          </div>
        );
      case 'path_pro_grade':
        return (
          <div className="space-y-4 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
            <div className="bg-red-950/40 text-red-400 border border-red-500/20 px-4 py-2.5 rounded-lg text-xs font-mono">
              🥊 <strong>PRO-GRADE PERFORMANCE TRACK:</strong> High-volume drilling vectors tracking advanced technical progression and recovery thresholds.
            </div>
            <h2 className="text-xl font-black text-slate-100 font-mono">Pro-Grade Performance Track</h2>
            <p className="text-xs text-slate-400 leading-relaxed font-mono">Monitors extreme energy system demands, advanced tactical sparring metrics, round fatigue metrics, and anatomical soreness index arrays.</p>
          </div>
        );
      default:
        const target = navigationTaxonomy.find(t => t.id === activeWorkspace);
        return (
          <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl">
            <div className="bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-4 py-2.5 rounded-lg text-xs font-mono flex items-center justify-between">
              <span>🛡️ <strong>AUTHORITY BANNER:</strong> Human Intervention Required. No automated algorithm advancement clearance authorized.</span>
            </div>
            <div className="border-b border-slate-800 pb-3 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
              <div>
                <h2 className="text-xl font-black text-slate-100 font-mono">{target?.name}</h2>
                <p className="text-xs text-slate-400 font-mono mt-0.5">Scaffolded 0.5E interface sub-engine portal</p>
              </div>
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-wider uppercase">
                ⚠️ Sensitivity Tier: {target?.sensitivity}
              </span>
            </div>
            <div className="bg-[#111827] border border-dashed border-slate-800/80 rounded-xl p-12 text-center space-y-2 shadow-inner">
              <div className="text-xl">🛑</div>
              <h4 className="text-sm font-bold text-slate-300 font-mono">0.5E Local Frontend Shell Boundary</h4>
              <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed font-mono">
                Error State Log: <code className="text-amber-400">[Backend not connected]</code>. Remote data pipelines are deferred to preserve the local free-tier architecture loop bounds.
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
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
      </header>
      <div className="flex-1 flex flex-col lg:flex-row">
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
        <main className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto max-w-[1600px]">
          {renderWorkspaceContent()}
        </main>
      </div>
    </div>
  );
}
