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
      <div className="border-b-4 border-[#8b4444] pb-3">
        <h2 className="font-display text-2xl tracking-tight text-[#e8d7c6]">Unified 5-Route Performance Pathways</h2>
        <p className="mt-1 text-xs font-mono text-[#b0a095]">Layer 03 & Layer 05 Dynamic Development Mapping</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {routes.map((route, i) => (
          <div key={route.name} className="border-2 border-[#5a4a3a] bg-[#1a1a1a] p-5 transition hover:border-[#d4a574] hover:bg-[#0f0f0f]">
            <span className="mb-2 inline-block border border-[#8b4444] bg-[#3d2817] px-2 py-0.5 text-[10px] font-mono font-bold text-[#d4a574]">PATHWAY 0{i+1}</span>
            <h3 className="text-base font-bold text-[#e8d7c6]">{route.name}</h3>
            <p className="mt-2 text-xs leading-relaxed text-[#b0a095]">{route.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
