'use client';

import React from 'react';

export default function CoachReviewQueue() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="font-display text-3xl tracking-tight text-[#e8d7c6] mb-6">Coach Review Queue</h1>
      <p className="mb-4 text-[#b0a095]">Merged with Safety Gate + Red Flag Escalation</p>
      
      <div className="border-4 border-[#8b4444] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
        <p className="mb-4 text-[#e8d7c6] font-semibold">Sample Review Card</p>
        <div className="flex gap-3">
          <button className="border-2 border-[#5a4a3a] bg-[#0f0f0f] px-4 py-2 text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#3d2817]">
            Approve
          </button>
          <button className="border-2 border-[#8b4444] bg-[#3d2817] px-4 py-2 text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#5a2a2a]">
            Adjust
          </button>
          <button className="border-2 border-[#8b4444] bg-[#5a2a2a] px-4 py-2 text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#8b4444]">
            Pause
          </button>
        </div>
      </div>
    </div>
  );
}
