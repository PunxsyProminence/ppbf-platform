'use client';

import React, { useState } from 'react';

export default function NonProfitTrack() {
  const [attendance, setAttendance] = useState<number>(13);
  const [academicPassing, setAcademicPassing] = useState<boolean>(true);
  const [selectedRank, setSelectedRank] = useState<string>('TIRO');

  const latinRanks = [
    { name: "TIRO", label: "Beginner", desc: "Learning stance, guard, jab, and core gym discipline protocols." },
    { name: "DISCIPULUS", label: "Student", desc: "Developing combinations, basic defensive pacing, rhythm, and reaction cued drills." },
    { name: "PUGIL NOVUS", label: "Developing Boxer", desc: "Building combination fluency, footwork pivoting, defensive recovery, and tactical awareness parameters." },
    { name: "PUGIL SCIENTIA", label: "Skilled Boxer", desc: "Applying technical counters, generating target angles, and decision-making under fatigue indices." },
    { name: "PUGIL FORTIS", label: "Advanced Boxer", desc: "Adapting strategic block options, maintaining composure in live drilling, and modeling maturity." },
    { name: "PUGIL PRAECEPTOR", label: "Mentor Boxer", desc: "High technical boxing proficiency combined with uncompromised youth mentorship and cultural leadership standards." }
  ];

  const totalSessions = 16;
  const qualifiesForWaiver = attendance >= 12; // 75% Attendance standard rule

  return (
    <div className="space-y-4 bg-[#1a1a1a]/40 border border-[#8b4444] p-5">
      <div className="border-b border-[#8b4444] pb-2 flex justify-between items-center">
        <h4 className="text-sm font-black font-mono text-[#d4a574] uppercase tracking-wider">📋 Component A: Non-Profit Athlete Ranks Track</h4>
        <span className="text-[10px] bg-[#4a4a4a] border border-[#8b4444] font-mono text-[#a0a0a0] px-2 py-0.5">Layer 05 / 22</span>
      </div>

      {/* Attendance-Based Fee Waiver Engine */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs font-mono text-slate-400">
          <span>Monthly Checked Attendance</span>
          <span className="text-slate-200 font-bold">{attendance} / {totalSessions} Sessions</span>
        </div>
        <input 
          type="range" min="0" max="16" step="1" value={attendance} 
          onChange={(e) => setAttendance(parseInt(e.target.value))}
          className="w-full accent-emerald-500 h-1 bg-slate-800 rounded-lg appearance-none"
        />
        <div className={`p-2.5 rounded-lg border text-[11px] font-mono text-center ${qualifiesForWaiver ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-400'}`}>
          {qualifiesForWaiver ? "🎉 75% Threshold Met: Full $20.00 Membership Fee Waived!" : "⚠️ Attendance Under 75%: Standard $20.00 Monthly Due Applies"}
        </div>
      </div>

      {/* Academic Priority Checkpoint */}
      <div className="bg-slate-950/40 border border-slate-800 p-3 rounded-xl flex items-center justify-between text-xs font-mono">
        <div className="space-y-0.5">
          <span className="text-slate-200 block font-bold">Academic Passing Verification</span>
          <p className="text-[10px] text-slate-500">School performance takes priority over training conflicts.</p>
        </div>
        <button 
          type="button" onClick={() => setAcademicPassing(!academicPassing)}
          className={`px-3 py-1 rounded font-bold border transition ${academicPassing ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-red-950/40 border-red-500 text-red-400'}`}
        >
          {academicPassing ? '✅ PASSING ALL' : '❌ ACADEMIC HOLD'}
        </button>
      </div>

      {/* Ranks Ladder */}
      <div className="space-y-2">
        <label className="text-[11px] font-mono text-slate-400 block">Active Latin Rank Assignment Profile:</label>
        <div className="grid grid-cols-2 gap-2">
          {latinRanks.map(r => (
            <button 
              key={r.name} type="button" onClick={() => setSelectedRank(r.name)}
              className={`p-2 text-left rounded-lg border font-mono text-[11px] transition ${selectedRank === r.name ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400 font-bold' : 'bg-[#0b0f19] border-slate-900 text-slate-400 hover:text-slate-200'}`}
            >
              <div className="truncate">{r.name}</div>
              <div className="text-[9px] text-slate-500 truncate">{r.label}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
