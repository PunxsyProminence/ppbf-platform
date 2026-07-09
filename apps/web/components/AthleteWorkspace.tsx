'use client';

import React, { useState } from 'react';
import NonProfitTrack from './NonProfitTrack';
import SpecOpsTrack from './SpecOpsTrack';

export default function AthleteWorkspace() {
  const [activeSubTrack, setActiveSubTrack] = useState<'non_profit' | 'spec_ops'>('non_profit');

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Dynamic Sub-Track Auto Switcher Header */}
      <div className="bg-[#0b0f19] border border-slate-800 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-0.5">
          <h3 className="text-base font-black font-mono text-slate-100">Automated Pipeline Workspace Selector</h3>
          <p className="text-xs text-slate-400 font-mono">Dynamically swaps nested component views while strictly isolating data structures.</p>
        </div>
        <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button
            type="button" onClick={() => setActiveSubTrack('non_profit')}
            className={`px-4 py-1.5 rounded-lg text-xs font-mono font-bold transition ${activeSubTrack === 'non_profit' ? 'bg-emerald-600 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Non-Profit Track
          </button>
          <button
            type="button" onClick={() => setActiveSubTrack('spec_ops')}
            className={`px-4 py-1.5 rounded-lg text-xs font-mono font-bold transition ${activeSubTrack === 'spec_ops' ? 'bg-cyan-600 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
          >
            SpecOps Track
          </button>
        </div>
      </div>

      {/* Render the selected automated TSX sub-component file natively */}
      <div className="bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
        {activeSubTrack === 'non_profit' ? <NonProfitTrack /> : <SpecOpsTrack />}

        {/* IMMUTABLE HUMAN SAFETY PROGRESSION INTERCEPTOR BLOCK */}
        <div className="bg-red-950/20 text-red-400 border border-red-500/20 p-4 rounded-xl text-xs font-mono space-y-1">
          <span className="font-bold block uppercase text-red-500">🛡️ Directive 5: Immutable Immunity Gate</span>
          <p className="text-slate-400 text-[11px] leading-relaxed">
            All automated path updates are bound purely to client-side caching schemas. Permanent track row progression, return-to-training validation, or live sparring permissions remain completely frozen from automation, requiring explicit manual flag verification from **Head Coach Jason** (`verified_by_jason: true`).
          </p>
        </div>
      </div>

      {/* CORPORATE LEGAL COMPLIANCE STENCIL FOOTER */}
      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[11px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
