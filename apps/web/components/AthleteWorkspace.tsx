'use client';
import React from 'react';

export default function AthleteWorkspace() {
  const requirements = [
    { type: "Technical Skill", focus: "Stance integrity, punch mechanics, defensive movement, and footwork control." },
    { type: "Neurocognitive", focus: "Reaction speed to visual/verbal cues, and decision-making under controlled fatigue." },
    { type: "Discipline & Conduct", focus: "Coachability, emotional regulation, and absolute respect for peers and gym equipment." }
  ];

  return (
    <div className="space-y-6 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl animate-fadeIn">
      <div className="bg-emerald-950/40 text-emerald-400 border border-emerald-500/20 px-4 py-2.5 rounded-lg text-xs font-mono flex items-center justify-between">
        <span>🏃 <strong>ATHLETE PORTS GATEWAY:</strong> Your effort, focus, behavior, and leadership determine advancement.</span>
        <span className="text-[10px] bg-emerald-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Active Shell</span>
      </div>

      <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
        <div>
          <h2 className="text-xl font-black text-slate-100 font-mono">Athlete On-Floor Tracking Profile</h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Ranks are earned through demonstrated maturity — not age or time in gym.</p>
        </div>
        <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase">Public / Internal</span>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold font-mono text-slate-400 uppercase tracking-wider">My Rank Advancement Benchmarks</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {requirements.map(r => (
            <div key={r.type} className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-1">
              <span className="text-xs font-bold text-slate-200 block font-mono">{r.type}</span>
              <p className="text-[11px] text-slate-400 font-mono leading-relaxed">{r.focus}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2 text-[11px] font-mono text-slate-500">
        <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Active Athlete Logs</h5>
        <div>• Layer 14: Pre-session Readiness Check-in ➔ <span className="text-amber-500">[Backend not connected]</span></div>
        <div>• Layer 09: Athlete Voice Qualitative Log ➔ <span className="text-amber-500">[Backend not connected]</span></div>
      </div>
    </div>
  );
}
