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
      <div className="bg-amber-950/40 text-amber-400 border border-amber-500/20 px-4 py-3 rounded-xl text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>⚙️ <strong>ADMINISTRATION COMPLIANCE PANEL:</strong> Tracking logistics, background checks, and child safeguarding boundaries.</div>
        <span className="text-[10px] bg-amber-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Layer 11 Active</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-base font-bold font-mono text-slate-100">Facility Logistics & Asset Controls</h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Manage operational parameters across your geographic workspace footprint.</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-slate-400 block">Select Active Facility Node</label>
              <div className="grid grid-cols-3 gap-2">
                {["Deegan Lane", "Neeko Lane", "3D Print Lab"].map(f => (
                  <button key={f} type="button" onClick={() => setFacility(f)} className={`p-3 text-center rounded-xl border font-mono text-xs transition ${facility === f ? 'bg-amber-950/40 border-amber-500 text-amber-400 font-bold' : 'bg-[#111827] border-slate-900 text-slate-400 hover:text-slate-200'}`}>{f}</button>
                ))}
              </div>
            </div>

            <div className="border-t border-slate-800/80 pt-4 space-y-3">
              <h4 className="text-xs font-bold font-mono text-slate-400 uppercase tracking-wider">Layer 11 Safety Gate Enforcements</h4>
              
              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div><span className="text-slate-200 block font-bold">Concussion Blocker Active Flag</span><p className="text-[10px] text-slate-500">Enforces an absolute return-to-play lockout if head trauma indicators trigger.</p></div>
                <button type="button" onClick={() => setConcussionBlocker(!concussionBlocker)} className={`px-4 py-1.5 rounded-lg font-bold border transition ${concussionBlocker ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-red-950/40 border-red-500 text-red-400'}`}>{concussionBlocker ? 'ACTIVE' : 'MUTED'}</button>
              </div>

              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div><span className="text-slate-200 block font-bold">USA Boxing Background Verification</span><p className="text-[10px] text-slate-500">Cross-checks staff screening data metrics for absolute non-profit compliance.</p></div>
                <button type="button" onClick={() => setBackgroundCheck(!backgroundCheck)} className={`px-4 py-1.5 rounded-lg font-bold border transition ${backgroundCheck ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-red-950/40 border-red-500 text-red-400'}`}>{backgroundCheck ? 'COMPLIANT' : 'FAILING'}</button>
              </div>

              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div><span className="text-slate-200 block font-bold">Pool Safety Gates Lockout</span><p className="text-[10px] text-slate-500">Restricts specialized tactical underwater training batteries until certified staff flags confirm presence.</p></div>
                <button type="button" onClick={() => setPoolLockout(!poolLockout)} className={`px-4 py-1.5 rounded-lg font-bold border transition ${poolLockout ? 'bg-red-950/40 border-red-500 text-red-400 font-bold' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>{poolLockout ? 'RESTRICTED' : 'OPEN ACCESS'}</button>
              </div>
            </div>

            <button type="button" onClick={handleAdminSync} className="w-full bg-amber-600 hover:bg-amber-500 text-slate-950 font-mono font-black text-xs py-2.5 rounded-xl transition uppercase tracking-wider">⚡ Synchronize Facility Safety Manifest</button>
          </div>

          {telemetryLog && (
            <div className="bg-slate-950/80 border border-slate-900 rounded-xl p-4 font-mono text-[11px] text-slate-400 space-y-1">
              <div className="text-amber-400 font-bold border-b border-slate-900 pb-1 flex justify-between items-center"><span>📡 SAFETY MANIFEST TRAPPED IN STAGING VECTOR</span><span className="text-[10px] text-slate-600">{telemetryLog.timestamp}</span></div>
              <div>• Destination Buffer Vector: <span className="text-slate-300 underline">{telemetryLog.stagingPath}</span></div>
              <div>• Configured Node Focus: <span className="text-slate-200 font-bold">{telemetryLog.data.activeFacility}</span></div>
              <div>• Concussion Intercept Protocol: <span className="text-slate-200">{telemetryLog.data.concussionBlockerActive ? "ENGAGED" : "BYPASSED"}</span></div>
              <div className="text-red-400 font-bold">• Automated Clearance Status: BLOCKED BY MODULE (Requires Manual Coach Jason Verification Flag)</div>
            </div>
          )}
        </div>

        <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl text-center font-mono text-xs text-slate-500 border-dashed h-fit space-y-2">
          <div>🛑 Workspace Interface Notification State:</div>
          <div className="text-slate-400 font-bold text-[11px] leading-relaxed">Error State Code: <code className="text-amber-400">[Module blocked by safety/governance rules]</code>.</div>
        </div>
      </div>

      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[11px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
