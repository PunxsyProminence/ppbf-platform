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
    <div className="bg-[#0a0a0a] border border-[#8b4444] p-6 space-y-6 animate-fadeIn">
      {/* Strict Warning Banner */}
      <div className="bg-[#4a3a2a]/10 border border-[#d4a574]/20 px-4 py-2.5 text-xs font-mono text-[#d4a574]">
        ⚠️ <strong>DEEP-DIVE CONTENT STATUS:</strong> PARTIALLY SCAFFOLDED (Educational Only). Build logic not integrated with automated production advancement routes.
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-[#8b4444] pb-3">
        <div>
          <h3 className="text-base font-bold text-[#e8d7c6] font-mono">🕳️ Technical Rabbit-Hole Education Center</h3>
          <p className="text-xs text-[#b0a095] font-mono mt-0.5">Non-linear theoretical drilling and movement analysis</p>
        </div>
        <span className="text-[10px] bg-[#1a1a1a] border border-[#8b4444] px-2.5 py-1 font-mono text-[#b0a095]">PARTIALLY SCAFFOLDED</span>
      </div>

      {/* Category Toggles */}
      <div className="flex flex-wrap gap-1">
        {['All', 'Boxing Skill Concepts', 'Human Capability Transfer', 'Coach Review Model', 'Safety/Youth Protection'].map(cat => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`px-2.5 py-1 text-[11px] font-mono font-bold border transition ${filter === cat ? 'bg-[#4a2020] border-[#8b4444] text-[#d4a574]' : 'border-[#8b4444] text-[#b0a095] bg-[#1a1a1a]/40 hover:text-[#d9c8b8]'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(m => (
          <div key={m.id} className="bg-[#1a1a1a] border border-[#8b4444] p-5 flex flex-col justify-between hover:border-[#d4a574] transition">
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[9px] font-mono bg-[#4a4a4a] text-[#d4a574] border border-[#8b4444] px-1.5 py-0.5 font-bold">{m.id}</span>
                <span className="text-[9px] font-mono text-[#b0a095] bg-[#0a0a0a] px-2 py-0.5 border border-[#8b4444]">{m.source}</span>
              </div>
              <h4 className="font-bold text-[#e8d7c6] text-sm tracking-tight">{m.name}</h4>
              <p className="text-xs text-[#b0a095] leading-relaxed">{m.desc}</p>
            </div>
            <div className="mt-4 pt-3 border-t border-[#8b4444]/60 text-right">
              <button onClick={() => alert(`Accessing context map [${m.id}] inside staging matrix layer.`)} className="text-[10px] font-mono bg-[#0a0a0a] hover:bg-[#1a1a1a] text-[#b0a095] border border-[#8b4444] px-2 py-1 transition">
                Go Deeper ➔
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
