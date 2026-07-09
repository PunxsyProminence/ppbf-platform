'use client';

import React, { useState } from 'react';

export default function RabbitHoleView() {
  const [filter, setFilter] = useState('All');

  const modules = [
    { cat: "Boxing Skill Concepts", id: "LOOP-A", name: "Biomechanical Lever Rotation", source: "Internal Doctrine", desc: "Deep-dive tracking of shoulder-hip separation, torque generation, and kinetic chain vector transfers during punch cycles." },
    { cat: "Boxing Skill Concepts", id: "LOOP-B", name: "Spatial Ring Boundaries", source: "Technical Guide V2", desc: "Focused theoretical pacing sequences managing geometry layout anchors, positioning vectors, and floor trap maneuvers." },
    { cat: "Human Capability Transfer", id: "CAP-05", name: "Neurological Motor Mapping", source: "Research Intake", desc: "Telemetry frameworks investigating tactical behavioral adaptation loops, cognitive load limits, and reaction speeds." },
    { cat: "Coach Review Model", id: "DOC-10", name: "Coaching Intelligence Doctrine", desc: "Algorithmic alignment templates used to calibrate lesson pacing constraints against cumulative team exhaustion metrics." },
    { cat: "Safety/Youth Protection", id: "SAFE-11", name: "Concussion Blocker Architecture", source: "Medical Board V1", desc: "System firewalls governing absolute physical lockout sequences when structural neurological flags are triggered." }
  ];

  const filtered = filter === 'All' ? modules : modules.filter(m => m.cat === filter);

  return (
    <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-6 space-y-6 animate-fadeIn">
      {/* Strict Warning Banner */}
      <div className="bg-amber-600/10 border border-amber-500/20 px-4 py-2.5 rounded-lg text-xs font-mono text-amber-400">
        ⚠️ <strong>DEEP-DIVE CONTENT STATUS:</strong> PARTIALLY SCAFFOLDED (Educational Only). Build logic not integrated with automated production advancement routes.
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-base font-bold text-slate-200 font-mono">🕳️ Technical Rabbit-Hole Education Center</h3>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Non-linear theoretical drilling and movement analysis</p>
        </div>
        <span className="text-[10px] bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-full font-mono text-slate-400">PARTIALLY SCAFFOLDED</span>
      </div>

      {/* Category Toggles */}
      <div className="flex flex-wrap gap-1">
        {['All', 'Boxing Skill Concepts', 'Human Capability Transfer', 'Coach Review Model', 'Safety/Youth Protection'].map(cat => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold border transition ${filter === cat ? 'bg-indigo-950 border-indigo-500 text-indigo-400' : 'border-slate-800 text-slate-400 bg-slate-900/40 hover:text-slate-200'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(m => (
          <div key={m.id} className="bg-[#111827] border border-slate-800 p-5 rounded-xl flex flex-col justify-between hover:border-slate-700 transition">
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[9px] font-mono bg-slate-800 text-indigo-400 border border-slate-700 px-1.5 py-0.5 rounded font-bold">{m.id}</span>
                <span className="text-[9px] font-mono text-slate-500 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">{m.source}</span>
              </div>
              <h4 className="font-bold text-slate-200 text-sm tracking-tight">{m.name}</h4>
              <p className="text-xs text-slate-400 leading-relaxed">{m.desc}</p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/60 text-right">
              <button onClick={() => alert(`Accessing context map [${m.id}] inside staging matrix layer.`)} className="text-[10px] font-mono bg-[#0b0f19] hover:bg-slate-800 text-slate-300 border border-slate-800 px-2 py-1 rounded transition">
                Go Deeper ➔
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
