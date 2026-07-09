'use client';
import React from 'react';

export default function CoachWorkspace() {
  return (
    <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
      <div className="bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-4 py-2.5 rounded-lg text-xs font-mono flex items-center justify-between">
        <span>📋 <strong>COACH REVIEW ENGINE:</strong> Coaches execute programming. Decisions are guided by policy, not personalities.</span>
        <span className="text-[10px] bg-indigo-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Verified by Jason</span>
      </div>

      <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
        <div>
          <h2 className="text-xl font-black text-slate-100 font-mono">Staff Session Blueprinting Panel</h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Auditing training blocks, session quality scores, and progression rulesets.</p>
        </div>
        <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase">Coach-Only</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[#111827] border border-slate-800 p-5 rounded-xl space-y-2">
          <h4 className="text-xs font-bold font-mono text-indigo-400 uppercase tracking-wider">Layer 10: Ingestion Review Queue</h4>
          <p className="text-xs text-slate-400 font-mono leading-relaxed">Evaluates transaction data payloads currently trapped inside the secure staging vector path before row commit.</p>
          <div className="bg-slate-950 p-3 rounded border border-slate-800 text-[11px] font-mono text-slate-500 text-center">No coach reviews pending. Queue clear.</div>
        </div>
        <div className="bg-[#111827] border border-slate-800 p-5 rounded-xl space-y-2">
          <h4 className="text-xs font-bold font-mono text-indigo-400 uppercase tracking-wider">Layer 08: Session Quality Score & RPE Metrics</h4>
          <p className="text-xs text-slate-400 font-mono leading-relaxed">Mandates capturing explicit internal notes and Simplify/Downgrade Rationales when target floor workouts must be modified.</p>
          <div className="bg-slate-950 p-3 rounded border border-slate-800 text-[11px] font-mono text-slate-500 text-center">Module blocked by safety/governance rules.</div>
        </div>
      </div>
    </div>
  );
}
