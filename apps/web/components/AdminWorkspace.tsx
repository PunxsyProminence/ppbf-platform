'use client';

import React, { useState } from 'react';

interface AdminTelemetryPacket {
  timestamp: string;
  stagingPath: string;
  data: {
    activeFacility: string;
    concussionBlockerActive: boolean;
    usaBoxingBackgroundCheck: boolean;
    poolSafetyLockout: boolean;
  };
}

export default function AdminWorkspace() {
  const [facility, setFacility] = useState<string>("Deegan Lane");
  const [concussionBlocker, setConcussionBlocker] = useState<boolean>(true);
  const [backgroundCheck, setBackgroundCheck] = useState<boolean>(true);
  const [poolLockout, setPoolLockout] = useState<boolean>(true);
  const [telemetryLog, setTelemetryLog] = useState<AdminTelemetryPacket | null>(null);

  const handleAdminSync = () => {
    const packet: AdminTelemetryPacket = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/facility_safety_manifest",
      data: {
        activeFacility: facility,
        concussionBlockerActive: concussionBlocker,
        usaBoxingBackgroundCheck: backgroundCheck,
        poolSafetyLockout: poolLockout
      }
    };
    setTelemetryLog(packet);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* AUTHORITY BANNER */}
      <div className="bg-[#5a4a3a]/40 text-[#d4a574] border-2 border-[#d4a574] px-4 py-3 text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>⚡️ <strong>ADMINISTRATION COMPLIANCE PANEL:</strong> Tracking logistics, background checks, and child safeguarding boundaries.</div>
        <span className="text-[10px] bg-[#5a4a3a] px-2 py-0.5 uppercase font-bold text-[#e8d7c6]">Layer 11 Active</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6">
          <div className="border-b border-[#8b4444] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Facility Logistics & Asset Controls</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Manage operational parameters across your geographic workspace footprint.</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#b0a095] block">Select Active Facility Node</label>
              <div className="grid grid-cols-3 gap-2">
                {["Deegan Lane", "Neeko Lane", "3D Print Lab"].map(f => (
                  <button key={f} type="button" onClick={() => setFacility(f)} className={`p-3 text-center border-2 font-mono text-xs transition ${facility === f ? 'bg-[#5a4a3a]/40 border-[#d4a574] text-[#d4a574] font-bold' : 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095] hover:text-[#e8d7c6]'}`}>{f}</button>
                ))}
              </div>
            </div>

            <div className="border-t border-[#8b4444]/80 pt-4 space-y-3">
              <h4 className="text-xs font-bold font-mono text-[#b0a095] uppercase tracking-wider">Layer 11 Safety Gate Enforcements</h4>
              
              <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div><span className="text-[#e8d7c6] block font-bold">Concussion Blocker Active Flag</span><p className="text-[10px] text-[#b0a095]">Enforces an absolute return-to-play lockout if head trauma indicators trigger.</p></div>
                <button type="button" onClick={() => setConcussionBlocker(!concussionBlocker)} className={`px-4 py-1.5 font-bold border transition ${concussionBlocker ? 'bg-[#4a2020]/40 border-[#8b4444] text-[#d4a574]' : 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#d4a574]'}`}>{concussionBlocker ? 'ACTIVE' : 'MUTED'}</button>
              </div>

              <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div><span className="text-[#e8d7c6] block font-bold">USA Boxing Background Verification</span><p className="text-[10px] text-[#b0a095]">Cross-checks staff screening data metrics for absolute non-profit compliance.</p></div>
                <button type="button" onClick={() => setBackgroundCheck(!backgroundCheck)} className={`px-4 py-1.5 font-bold border transition ${backgroundCheck ? 'bg-[#4a2020]/40 border-[#8b4444] text-[#d4a574]' : 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#d4a574]'}`}>{backgroundCheck ? 'COMPLIANT' : 'FAILING'}</button>
              </div>

              <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div><span className="text-[#e8d7c6] block font-bold">Pool Safety Gates Lockout</span><p className="text-[10px] text-[#b0a095]">Restricts specialized tactical underwater training batteries until certified staff flags confirm presence.</p></div>
                <button type="button" onClick={() => setPoolLockout(!poolLockout)} className={`px-4 py-1.5 font-bold border transition ${poolLockout ? 'bg-[#5a2a2a]/40 border-[#8b4444] text-[#d4a574] font-bold' : 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095]'}`}>{poolLockout ? 'RESTRICTED' : 'OPEN ACCESS'}</button>
              </div>
            </div>

            <button type="button" onClick={handleAdminSync} className="w-full bg-[#d4a574] hover:bg-[#e8d7c6] text-[#0a0a0a] font-mono font-black text-xs py-2.5 transition uppercase tracking-wider">⚡ Synchronize Facility Safety Manifest</button>
          </div>

          {telemetryLog && (
            <div className="bg-[#0a0a0a]/80 border border-[#4a4a4a] p-4 font-mono text-[11px] text-[#b0a095] space-y-1">
              <div className="text-[#d4a574] font-bold border-b border-[#4a4a4a] pb-1 flex justify-between items-center"><span>📡 SAFETY MANIFEST TRAPPED IN STAGING VECTOR</span><span className="text-[10px] text-[#8b4444]">{telemetryLog.timestamp}</span></div>
              <div>• Destination Buffer Vector: <span className="text-[#e8d7c6] underline">{telemetryLog.stagingPath}</span></div>
              <div>• Configured Node Focus: <span className="text-[#e8d7c6] font-bold">{telemetryLog.data.activeFacility}</span></div>
              <div>• Concussion Intercept Protocol: <span className="text-[#e8d7c6]">{telemetryLog.data.concussionBlockerActive ? "ENGAGED" : "BYPASSED"}</span></div>
              <div className="text-[#d4a574] font-bold">• Automated Clearance Status: BLOCKED BY MODULE (Requires Manual Coach Jason Verification Flag)</div>
            </div>
          )}
        </div>

        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 text-center font-mono text-xs text-[#b0a095] border-dashed h-fit space-y-2">
          <div>🛑 Workspace Interface Notification State:</div>
          <div className="text-[#e8d7c6] font-bold text-[11px] leading-relaxed">Error State Code: <code className="text-[#d4a574]">[Module blocked by safety/governance rules]</code>.</div>
        </div>
      </div>

      <div className="bg-[#0a0a0a]/60 border border-[#4a4a4a] p-4 text-[11px] font-mono text-[#b0a095] text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
