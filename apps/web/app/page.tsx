'use client';

import React, { useState } from 'react';
import CoachView from '../components/CoachView';
// import AthleteView from '../components/AthleteView';
// import BoardView from '../components/BoardView';
// import AdminView from '../components/AdminView';

export type UserRole = 'athlete' | 'coach' | 'board' | 'admin';

export const capabilityRegistry = [
  { id: "08", name: "Session Logging Engine", status: "PARTIALLY SCAFFOLDED", authority: "Coach decision required" },
  { id: "10", name: "Coach Review Queue", status: "PARTIALLY SCAFFOLDED", authority: "Coach decision required" },
  { id: "11", name: "Safety Gates Matrix", status: "BLOCKED BY SAFETY", authority: "Coach/Admin required" },
  { id: "12", name: "Medical / Recovery", status: "INTENDED / NOT YET BUILT", authority: "Referral only; no diagnosis" },
  { id: "15", name: "Contact / Sparring Gates", status: "BLOCKED BY SAFETY", authority: "Human approval required" }
];

export default function PPBFMasterDashboard() {
  const [currentRole, setCurrentRole] = useState<UserRole>('coach');

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      
      {/* STRICT SAFETY BANNER (Per ChatGPT Rules) */}
      <div className="bg-amber-900/40 border-b border-amber-500/30 px-6 py-2 flex justify-between items-center text-xs font-mono text-amber-400">
        <div className="flex items-center space-x-2">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
          <span><strong>0.5E BUILD TRUTH:</strong> Frontend Shell Only. Dataverse Not Connected. Mock Local Data.</span>
        </div>
      </div>

      <header className="bg-[#0b0f19] border-b border-slate-800 px-6 py-4 flex justify-between items-center">
        <div>
          <h1 className="text-xl font-black text-slate-50">Punxsy Prominence Boxing and Fitness</h1>
          <p className="text-[11px] text-slate-400 font-mono">Mock UI Shell - Safe Mode</p>
        </div>
        <div className="bg-[#111827] p-1 rounded-xl border border-slate-800 flex gap-1">
          {['athlete', 'coach', 'board', 'admin'].map(role => (
            <button key={role} onClick={() => setCurrentRole(role as UserRole)} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold capitalize ${currentRole === role ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>
              {role}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 p-6 md:p-8 max-w-[1600px] w-full mx-auto">
        {/* WE INJECT THE ISOLATED COMPONENT HERE */}
        {currentRole === 'coach' && <CoachView registry={capabilityRegistry} />}
        {currentRole === 'athlete' && <div className="text-slate-500 font-mono">Athlete View Component Pending...</div>}
        {currentRole === 'board' && <div className="text-slate-500 font-mono">Board View Component Pending...</div>}
        {currentRole === 'admin' && <div className="text-slate-500 font-mono">Admin View Component Pending...</div>}
      </main>
    </div>
  );
}