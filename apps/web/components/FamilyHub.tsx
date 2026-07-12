'use client';
import React from 'react';

export default function FamilyHub() {
  return (
    <div className="space-y-6">
      <div className="border-b border-[#8b4444] pb-3">
        <h2 className="text-xl font-black text-[#e8d7c6] tracking-tight">Family Co-Observation Hub</h2>
        <p className="text-xs text-[#b0a095] mt-1 font-mono">Layer 05 Video Analysis, Layer 07 Home Exercises, and Layer 15 Observations</p>
      </div>

      <div className="border-4 border-[#3d2817] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
        <h3 className="text-base font-bold text-[#d4a574] font-mono tracking-tight mb-2">Layer 05 / 19 Media Integration: Video Analysis Logs</h3>
        <p className="text-xs text-[#b0a095] leading-relaxed mb-4">Tracks technical mechanical corrections, tactical ring sparring tapes, and biomechanical feedback parameters.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-[#0f0f0f] p-3 border-2 border-[#5a4a3a] text-xs text-[#e8d7c6] font-mono">Tape Loop A: Stance & Balance</div>
          <div className="bg-[#0f0f0f] p-3 border-2 border-[#5a4a3a] text-xs text-[#e8d7c6] font-mono">Tape Loop B: Guard Leakage</div>
          <div className="bg-[#0f0f0f] p-3 border-2 border-[#5a4a3a] text-xs text-[#e8d7c6] font-mono">Tape Loop C: Footwork Trajectories</div>
        </div>
      </div>
    </div>
  );
}
