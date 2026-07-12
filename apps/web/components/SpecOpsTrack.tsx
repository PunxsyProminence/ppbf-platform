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
    <div className="space-y-4 border-2 border-[#8b4444] bg-[#1a1a1a] p-5">
      <div className="flex items-center justify-between border-b-2 border-[#8b4444] pb-2">
        <h4 className="text-sm font-black font-mono uppercase tracking-wider text-[#d4a574]">Component B: Air Force SpecOps Task Track</h4>
        <span className="border border-[#8b4444] bg-[#3d2817] px-2 py-0.5 text-[10px] font-mono text-[#b0a095]">Layer 05 / 06</span>
      </div>

      {/* 16 Task Dimensions Select */}
      <div className="space-y-1.5">
        <label className="block text-[11px] font-mono text-[#b0a095]">SpecOps Task Dimension (16 Matrices Split):</label>
        <select 
          value={selectedDimension} onChange={(e) => setSelectedDimension(e.target.value)}
          className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-2 text-xs font-mono text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
        >
          {taskDimensions.map(td => <option key={td} value={td}>{td}</option>)}
        </select>
      </div>

      {/* 11 Project Lifecycle Status values Select */}
      <div className="space-y-1.5">
        <label className="block text-[11px] font-mono text-[#b0a095]">Project Lifecycle Status Value Alignment:</label>
        <div className="flex flex-wrap gap-1.5">
          {lifecycleStatuses.map(ls => (
            <button
              key={ls} type="button" onClick={() => setSelectedStatus(ls)}
              className={`border px-2 py-1 font-mono text-[10px] transition ${selectedStatus === ls ? 'border-[#d4a574] bg-[#3d2817] text-[#e8d7c6] font-bold' : 'border-[#5a4a3a] bg-[#0f0f0f] text-[#8a8a8a] hover:text-[#e8d7c6]'}`}
            >
              {ls}
            </button>
          ))}
        </div>
      </div>

      {/* Automated Matrix Status Sync Output Box */}
      <div className="space-y-1 border border-[#5a4a3a] bg-[#0f0f0f] p-3 text-[11px] font-mono text-[#b0a095]">
        <span className="block text-[10px] font-bold uppercase text-[#8a8a8a]">Automated Tracker Row Sync Manifest:</span>
        <div>Dimension Hook: <span className="font-bold text-[#e8d7c6]">{selectedDimension}</span></div>
        <div>Active Row Status Code: <span className="font-bold uppercase text-[#d4a574]">[{selectedStatus}]</span></div>
      </div>
    </div>
  );
}
