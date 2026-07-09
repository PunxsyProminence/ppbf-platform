'use client';

import React from 'react';

export default function ExecutiveBoardPanel() {
  return (
    <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
      {/* Authority Banner */}
      <div className="bg-amber-950/40 text-amber-400 border border-amber-500/20 px-4 py-2.5 rounded-lg text-xs font-mono flex items-center justify-between">
        <span>🏛️ <strong>AUTHORITY BANNER:</strong> Executive Board Oversight View. Policy modifications require verified board voting quorum.</span>
        <span className="text-[10px] bg-amber-900/40 px-2 py-0.5 rounded uppercase font-bold">Admin Ledger Block</span>
      </div>

      <div className="border-b border-slate-800 pb-3 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
        <div>
          <h2 className="text-xl font-black text-slate-100 font-mono">Nonprofit Analytical Impact Registry</h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">High-level statutory metric outputs and community footprint tracking</p>
        </div>
        {/* Sensitivity Badge */}
        <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-wider uppercase">
          🛡️ Board-Only Validation
        </span>
      </div>

      {/* Grid displays tracking required metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-[10px] font-mono text-slate-500">LAYER 22 TELEMETRY</span>
          <h4 className="text-sm font-bold text-slate-200">Total Floor Minutes Accumulated</h4>
          <p className="text-xs text-slate-400 pt-1 leading-relaxed font-mono text-[11px]">Aggregates participant duration tracking records across active cohorts to compute verifiable community footprints.</p>
        </div>
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-[10px] font-mono text-slate-500">LAYER 22 TELEMETRY</span>
          <h4 className="text-sm font-bold text-slate-200">Demographic Waiver Metrics</h4>
          <p className="text-xs text-slate-400 pt-1 leading-relaxed font-mono text-[11px]">Processes program utilization data segments required for validation logs and donor audit briefs.</p>
        </div>
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-[10px] font-mono text-slate-500">LAYER 23 OPERATIONS</span>
          <h4 className="text-sm font-bold text-slate-200">PA Standard Records</h4>
          <p className="text-xs text-slate-400 pt-1 leading-relaxed font-mono text-[11px]">Archived operational data frames tracking absolute system alignment with Pennsylvania childcare compliance.</p>
        </div>
      </div>

      {/* Audit Trail Placeholder */}
      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 space-y-2 text-[11px] font-mono text-slate-400">
        <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Statutory Audit Trail</h5>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
          <div><span className="text-slate-600">Created By:</span> Corporate Board Module</div>
          <div><span className="text-slate-600">Last Reviewed By:</span> Board Secretary</div>
          <div><span className="text-slate-600">Decision Reason:</span> Direct structural funding alignment check</div>
        </div>
      </div>
    </div>
  );
}
