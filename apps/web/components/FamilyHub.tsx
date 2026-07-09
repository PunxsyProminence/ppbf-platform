'use client';
import React from 'react';

export default function FamilyHub() {
  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-3">
        <h2 className="text-xl font-black text-slate-100 tracking-tight">Family Co-Observation Hub</h2>
        <p className="text-xs text-slate-400 mt-1 font-mono">Layer 05 Video Analysis, Layer 07 Home Exercises, and Layer 15 Observations</p>
      </div>

      <div className="bg-gradient-to-r from-emerald-950/40 to-indigo-950/30 border border-emerald-500/20 rounded-xl p-6 shadow-md">
        <h3 className="text-base font-bold text-emerald-400 font-mono tracking-tight mb-2">📹 Layer 05 / 19 Media Integration: Video Analysis Logs</h3>
        <p className="text-xs text-slate-300 leading-relaxed mb-4">Tracks technical mechanical corrections, tactical ring sparring tapes, and biomechanical feedback parameters.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 text-xs text-slate-300 font-mono">Tape Loop A: Stance & Balance</div>
          <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 text-xs text-slate-300 font-mono">Tape Loop B: Guard Leakage</div>
          <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 text-xs text-slate-300 font-mono">Tape Loop C: Footwork Trajectories</div>
        </div>
      </div>
    </div>
  );
}
