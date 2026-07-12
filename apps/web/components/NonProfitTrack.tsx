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
    <div className="space-y-4 border-2 border-[#8b4444] bg-[#1a1a1a] p-5">
      <div className="flex items-center justify-between border-b-2 border-[#8b4444] pb-2">
        <h4 className="text-sm font-black font-mono uppercase tracking-wider text-[#d4a574]">Component A: Non-Profit Athlete Ranks Track</h4>
        <span className="border border-[#8b4444] bg-[#3d2817] px-2 py-0.5 font-mono text-[10px] text-[#b0a095]">Layer 05 / 22</span>
      </div>

      {/* Attendance-Based Fee Waiver Engine */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs font-mono text-[#b0a095]">
          <span>Monthly Checked Attendance</span>
          <span className="font-bold text-[#e8d7c6]">{attendance} / {totalSessions} Sessions</span>
        </div>
        <input 
          type="range" min="0" max="16" step="1" value={attendance} 
          onChange={(e) => setAttendance(parseInt(e.target.value))}
          className="h-1 w-full appearance-none bg-[#4a4a4a]"
          style={{ accentColor: '#d4a574' }}
        />
        <div className={`border p-2.5 text-center text-[11px] font-mono ${qualifiesForWaiver ? 'border-[#d4a574] bg-[#3d2817] text-[#e8d7c6]' : 'border-[#5a4a3a] bg-[#0f0f0f] text-[#b0a095]'}`}>
          {qualifiesForWaiver ? "🎉 75% Threshold Met: Full $20.00 Membership Fee Waived!" : "⚠️ Attendance Under 75%: Standard $20.00 Monthly Due Applies"}
        </div>
      </div>

      {/* Academic Priority Checkpoint */}
      <div className="flex items-center justify-between border border-[#5a4a3a] bg-[#0f0f0f] p-3 text-xs font-mono">
        <div className="space-y-0.5">
          <span className="block font-bold text-[#e8d7c6]">Academic Passing Verification</span>
          <p className="text-[10px] text-[#8a8a8a]">School performance takes priority over training conflicts.</p>
        </div>
        <button 
          type="button" onClick={() => setAcademicPassing(!academicPassing)}
          className={`border px-3 py-1 font-bold transition ${academicPassing ? 'border-[#d4a574] bg-[#3d2817] text-[#e8d7c6]' : 'border-[#dc2626] bg-[#450a0a] text-[#fca5a5]'}`}
        >
          {academicPassing ? '✅ PASSING ALL' : '❌ ACADEMIC HOLD'}
        </button>
      </div>

      {/* Ranks Ladder */}
      <div className="space-y-2">
        <label className="block text-[11px] font-mono text-[#b0a095]">Active Latin Rank Assignment Profile:</label>
        <div className="grid grid-cols-2 gap-2">
          {latinRanks.map(r => (
            <button 
              key={r.name} type="button" onClick={() => setSelectedRank(r.name)}
              className={`border p-2 text-left font-mono text-[11px] transition ${selectedRank === r.name ? 'border-[#d4a574] bg-[#3d2817] text-[#e8d7c6] font-bold' : 'border-[#5a4a3a] bg-[#0f0f0f] text-[#b0a095] hover:text-[#e8d7c6]'}`}
            >
              <div className="truncate">{r.name}</div>
              <div className="truncate text-[9px] text-[#8a8a8a]">{r.label}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
