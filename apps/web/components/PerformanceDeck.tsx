'use client';
import React from 'react';

export default function PerformanceDeck() {
  const routes = [
    { name: "USA Boxing Competitive Route", desc: "Governed by the 6 Latin Ranks, USA Boxing safety boundaries, and strict academic passing parameters." },
    { name: "A2P (Adaptive-to-Performance)", desc: "Integrated with Layer 13 rules for seated structural movements and protective non-contact substitutions." },
    { name: "Pro-Grade Performance Track", desc: "High-volume drilling vectors tracking advanced technical progression, round strain, and strict recovery thresholds." },
    { name: "Collegiate Student-Athlete Line", desc: "Combines academic credit compliance and study logs with structural physical training maps." },
    { name: "General Fitness & Conditioning", desc: "Focused purely on work capacity, baseline mobility, physical preparation, and parent-monitored home habits." }
  ];

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-slate-800 pb-3">
        <h2 className="text-xl font-black text-slate-100 tracking-tight">Unified 5-Route Performance Pathways</h2>
        <p className="text-xs text-slate-400 mt-1 font-mono">Layer 03 & Layer 05 Dynamic Development Mapping</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {routes.map((route, i) => (
          <div key={route.name} className="bg-[#0b0f19] border border-slate-800 rounded-xl p-5 hover:border-emerald-500/30 transition">
            <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-950/20 px-2 py-0.5 rounded border border-emerald-500/10 mb-2 inline-block">PATHWAY 0{i+1}</span>
            <h3 className="font-bold text-slate-100 text-base">{route.name}</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">{route.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
