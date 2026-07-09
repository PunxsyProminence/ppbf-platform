'use client';

import React, { useState } from 'react';

type UserRole = 'Athlete' | 'Guardian' | 'Coach' | 'Admin' | 'Board' | 'Research';

export default function TutorialView() {
  const [selectedRole, setSelectedRole] = useState<UserRole>('Athlete');

  const guides = {
    Athlete: [
      { step: "01", title: "Pre-Session Check-in", body: "Complete your readiness logs capturing sleep, structural soreness maps, and stress vectors before stepping onto the floor." },
      { step: "02", title: "Track Assignments", body: "View your assigned core drilling blueprints, technical mobility homework, and specific non-contact drills." }
    ],
    Guardian: [
      { step: "01", title: "Portal Onboarding", body: "Review youth program check-ins, sign mandatory background liability waivers, and track active attendance logs." },
      { step: "02", title: "At-Home Logs", body: "Utilize the Guardian Observation Engine to submit home behavioral feedback (Attention and Task Persistence)." }
    ],
    Coach: [
      { step: "01", title: "Staging Queue Auditing", body: "Ingest unverified transaction telemetry packets trapped inside the secure /system_control/pending/ path." },
      { step: "02", title: "Session Blueprinting", body: "Track on-floor occupancy, log internal RPE scales, and capture mandatory Simplify/Downgrade Rationales." }
    ],
    Admin: [
      { step: "01", title: "Resource Alignment", body: "Manage asset logistics across physical points including Deegan Lane, Neeko Lane, and the 3D Print Lab." },
      { step: "02", title: "Incident Management", body: "Log operational safety issues with immutable timestamps onto the compliance tracking ledger." }
    ],
    Board: [
      { step: "01", title: "Oversight Audits", body: "Access digitized archives tracking executive policy adjustments, funding trends, and PA Standard compliance logs." },
      { step: "02", title: "Impact Verification", body: "Generate verifiable donor briefs covering Total Floor Minutes Accumulated and Waiver Metrics." }
    ],
    Research: [
      { step: "01", title: "Empirical Ingestion", body: "Monitor field-test data inputs and capture neurological motor-learning metrics across cohorts." },
      { step: "02", title: "Drift Monitoring", body: "Run active real-time context audits ensuring background checking matches structural design firewalls." }
    ]
  };

  return (
    <div className="bg-[#0b0f19] border border-slate-800 rounded-xl p-6 space-y-6 animate-fadeIn">
      {/* Strict Warning Banner */}
      <div className="bg-amber-600/10 border border-amber-500/20 px-4 py-2.5 rounded-lg text-xs font-mono text-amber-400">
        ⚠️ <strong>TUTORIAL STATUS:</strong> PARTIALLY SCAFFOLDED (Mock UI Only). Training and guidance help content only. No safety, medical, governance, or sparring approval authority.
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-base font-bold text-slate-200 font-mono">Guided Walkthrough Center</h3>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Role-driven system onboarding configurations</p>
        </div>
        <span className="text-[10px] bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-full font-mono text-slate-400">PARTIALLY SCAFFOLDED</span>
      </div>

      {/* Role Switcher */}
      <div className="flex flex-wrap gap-1.5 bg-[#111827] border border-slate-800 p-1 rounded-xl">
        {(Object.keys(guides) as UserRole[]).map(role => (
          <button
            key={role}
            onClick={() => setSelectedRole(role)}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition ${selectedRole === role ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {role} Shell
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {guides[selectedRole].map(g => (
          <div key={g.step} className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-mono bg-slate-800 px-2 py-0.5 rounded text-emerald-400 font-bold">STEP {g.step}</span>
              <span className="text-xs">📖</span>
            </div>
            <h4 className="font-bold text-slate-200 text-sm tracking-tight">{g.title}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{g.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
