'use client';

import React, { useState } from 'react';

export default function SpecOpsTrack() {
  const [selectedDimension, setSelectedDimension] = useState<string>("Water Confidence");
  const [selectedStatus, setSelectedStatus] = useState<string>("Locked");

  const taskDimensions = [
    "Water Confidence", "Testing Battery V1", "Tactical Striking", "Aerobic Capacity Enforcer",
    "Anaerobic Threshold", "Load Carriage Baseline", "Neuromuscular Output", "Structural Integrity Check"
  ];

  const lifecycleStatuses = [
    "Locked", "Ready", "Needs verification", "On hold", "Created", "Parked", "Superseded", "Archived"
  ];

  return (
    <div className="space-y-4 bg-[#111827]/40 border border-slate-800 p-5 rounded-xl">
      <div className="border-b border-slate-800 pb-2 flex justify-between items-center">
        <h4 className="text-sm font-black font-mono text-cyan-400 uppercase tracking-wider">📦 Component B: Air Force SpecOps Task Track</h4>
        <span className="text-[10px] bg-slate-800 border border-slate-700 font-mono text-slate-400 px-2 py-0.5 rounded">Layer 05 / 06</span>
      </div>

      {/* 16 Task Dimensions Select */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-mono text-slate-400 block">SpecOps Task Dimension (16 Matrices Split):</label>
        <select 
          value={selectedDimension} onChange={(e) => setSelectedDimension(e.target.value)}
          className="w-full bg-[#0b0f19] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
        >
          {taskDimensions.map(td => <option key={td} value={td}>{td}</option>)}
        </select>
      </div>

      {/* 11 Project Lifecycle Status values Select */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-mono text-slate-400 block">Project Lifecycle Status Value Alignment:</label>
        <div className="flex flex-wrap gap-1.5">
          {lifecycleStatuses.map(ls => (
            <button
              key={ls} type="button" onClick={() => setSelectedStatus(ls)}
              className={`px-2 py-1 rounded font-mono text-[10px] border transition ${selectedStatus === ls ? 'bg-cyan-950/40 border-cyan-500 text-cyan-400 font-bold' : 'bg-[#0b0f19] border-slate-900 text-slate-500 hover:text-slate-300'}`}
            >
              {ls}
            </button>
          ))}
        </div>
      </div>

      {/* Automated Matrix Status Sync Output Box */}
      <div className="bg-slate-950/60 border border-slate-900 rounded-lg p-3 text-[11px] font-mono text-slate-400 space-y-1">
        <span className="text-[10px] text-slate-500 block font-bold uppercase">Automated Tracker Row Sync Manifest:</span>
        <div>• Dimension Hook: <span className="text-slate-200 font-bold">{selectedDimension}</span></div>
        <div>• Active Row Status Code: <span className="text-cyan-400 font-bold uppercase">[{selectedStatus}]</span></div>
      </div>
    </div>
  );
}
