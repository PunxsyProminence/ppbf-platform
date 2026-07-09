'use client';
import React from 'react';

export default function AdminWorkspace() {
  return (
    <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
      <div className="bg-amber-950/40 text-amber-400 border border-amber-500/20 px-4 py-2.5 rounded-lg text-xs font-mono">
        <span>⚙️ <strong>ADMIN COMPLIANCE MATRIX:</strong> Verifies written safety protocols, background checks, and facility logistics.</span>
      </div>

      <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
        <div>
          <h2 className="text-xl font-black text-slate-100 font-mono">System Administration Control Panel</h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Asset and logistical tracking loops across all physical facilities.</p>
        </div>
        <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase">Admin-Only</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl text-center text-xs font-mono text-slate-300">📍 Deegan Lane Logistics</div>
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl text-center text-xs font-mono text-slate-300">📍 Neeko Lane Operations</div>
        <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl text-center text-xs font-mono text-slate-300">🔬 3D Print Lab Asset Logs</div>
      </div>

      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 space-y-2 text-[11px] font-mono text-slate-400">
        <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Layer 11: Safety Gates Enforcement</h5>
        <div>• Concussion Blocker Active Flag: <span className="text-emerald-400">SECURE</span></div>
        <div>• USA Boxing Background Verification: <span className="text-emerald-400">COMPLIANT</span></div>
        <div>• Pool Safety Gates Lockout: <span className="text-red-400 font-bold">RESTRICTED UNDERWATER DRILLS</span></div>
      </div>
    </div>
  );
}
