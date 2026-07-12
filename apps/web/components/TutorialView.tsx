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
    <div className="animate-fadeIn space-y-6 border-2 border-[#8b4444] bg-[#1a1a1a] p-6">
      {/* Strict Warning Banner */}
      <div className="border border-[#d4a574] bg-[#3d2817] px-4 py-2.5 text-xs font-mono text-[#e8d7c6]">
        ⚠️ <strong>TUTORIAL STATUS:</strong> PARTIALLY SCAFFOLDED (Mock UI Only). Training and guidance help content only. No safety, medical, governance, or sparring approval authority.
      </div>

      <div className="flex flex-col items-start justify-between gap-2 border-b-2 border-[#8b4444] pb-3 sm:flex-row sm:items-center">
        <div>
          <h3 className="font-mono text-base font-bold text-[#e8d7c6]">Guided Walkthrough Center</h3>
          <p className="mt-0.5 font-mono text-xs text-[#b0a095]">Role-driven system onboarding configurations</p>
        </div>
        <span className="border border-[#5a4a3a] bg-[#0f0f0f] px-2.5 py-1 font-mono text-[10px] text-[#b0a095]">PARTIALLY SCAFFOLDED</span>
      </div>

      {/* Role Switcher */}
      <div className="flex flex-wrap gap-1.5 border border-[#5a4a3a] bg-[#0f0f0f] p-1">
        {(Object.keys(guides) as UserRole[]).map(role => (
          <button
            key={role}
            onClick={() => setSelectedRole(role)}
            className={`px-3 py-1.5 text-xs font-mono font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4a574] ${selectedRole === role ? 'bg-[#8b4444] text-[#e8d7c6]' : 'text-[#b0a095] hover:bg-[#3d2817] hover:text-[#e8d7c6]'}`}
          >
            {role} Shell
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {guides[selectedRole].map(g => (
          <div key={g.step} className="space-y-2 border border-[#5a4a3a] bg-[#0f0f0f] p-4">
            <div className="flex justify-between items-center">
              <span className="border border-[#8b4444] bg-[#3d2817] px-2 py-0.5 font-mono text-[10px] font-bold text-[#d4a574]">STEP {g.step}</span>
              <span className="text-xs">📖</span>
            </div>
            <h4 className="text-sm font-bold tracking-tight text-[#e8d7c6]">{g.title}</h4>
            <p className="text-xs leading-relaxed text-[#b0a095]">{g.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
