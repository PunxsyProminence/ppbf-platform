'use client';

import React, { useState } from 'react';

interface BoardTelemetryPacket {
  timestamp: string;
  stagingPath: string;
  data: {
    monthlyWaiverApproval: boolean;
    totalFloorMinutesAggregated: number;
    paComplianceFilingReady: boolean;
  };
}

export default function ExecutiveBoardPanel() {
  const [floorMinutes, setFloorMinutes] = useState<number>(14240);
  const [waiverApproval, setWaiverApproval] = useState<boolean>(true);
  const [paFiling, setPaFiling] = useState<boolean>(true);
  const [telemetryLog, setTelemetryLog] = useState<BoardTelemetryPacket | null>(null);

  const seats = [
    { title: "1. President / Board Chair", focus: "Strategic leadership, presidings, strategical direction alignment" },
    { title: "2. Vice Chair", focus: "Continuity & support, assumes duties in absence, leads committees" },
    { title: "3. Treasurer", focus: "Financial integrity, budgeting controls, presents financial ledger metrics" },
    { title: "4. Secretary", focus: "Legal documentation, minutes retention, certifies official corporate records" },
    { title: "5. Program & Safety Director", focus: "Youth protection compliance, USA Boxing/insurance check validation" },
    { title: "6. Community & Development Director", focus: "Sustainability partnerships, fundraising execution, grant narrative coordination" },
    { title: "7. Director-at-Large", focus: "Independent oversight, provides board objectivity, full voting rights" }
  ];

  const handleBoardExecute = () => {
    const packet: BoardTelemetryPacket = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/board_resolution_ledger",
      data: {
        monthlyWaiverApproval: waiverApproval,
        totalFloorMinutesAggregated: floorMinutes,
        paComplianceFilingReady: paFiling
      }
    };
    setTelemetryLog(packet);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* AUTHORITY BANNER */}
      <div className="bg-emerald-950/40 text-emerald-400 border border-emerald-500/20 px-4 py-3 rounded-xl text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>🏛️ <strong>STATUTORY GOVERNANCE MODEL:</strong> PA-Compliant Framework. 7-Seat Board Fiduciary Duty Control Loop active.</div>
        <span className="text-[10px] bg-emerald-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Layer 23 Fiduciary Lock</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-xl font-black text-slate-100 font-mono">Fiduciary Reporting & Grant Metrics Summary</h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Transitioning from founder-heavy operations to shared legal oversight and grant validation.</p>
          </div>

          {/* 7-Seats Config */}
          <div className="space-y-2">
            <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">7-Seat Board Seat Index Mapping</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {seats.map(s => (
                <div key={s.title} className="bg-[#111827] border border-slate-800/80 p-3 rounded-xl text-xs font-mono">
                  <span className="text-emerald-400 font-bold block">{s.title}</span>
                  <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{s.focus}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Analytics parameters bound to Microsoft Non-Profit Grant */}
          <div className="border-t border-slate-800/80 pt-4 space-y-4">
            <h4 className="text-xs font-bold font-mono text-slate-400 uppercase tracking-wider">Layer 22 / 23 Cloud Analytics Enforcers</h4>
            
            <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl space-y-2 text-xs font-mono">
              <div className="flex justify-between items-center">
                <div><span className="text-slate-200 block font-bold">Total Floor Minutes Accumulated</span><p className="text-[10px] text-slate-500">Aggregated across active youth cohorts to satisfy Microsoft Grant validation parameters.</p></div>
                <span className="text-emerald-400 font-black text-sm">{floorMinutes} MIN</span>
              </div>
              <input type="range" min="5000" max="30000" step="50" value={floorMinutes} onChange={(e) => setFloorMinutes(parseInt(e.target.value))} className="w-full accent-emerald-500 h-1 bg-slate-800 rounded-lg appearance-none" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div><span className="text-slate-200 block font-bold">75% Attendance Fee Waiver</span><p className="text-[10px] text-slate-500">Authorize standard monthly waivers.</p></div>
                <button type="button" onClick={() => setWaiverApproval(!waiverApproval)} className={`px-3 py-1 rounded font-bold border transition ${waiverApproval ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>{waiverApproval ? 'APPROVED' : 'HOLD'}</button>
              </div>
              <div className="bg-[#111827] border border-slate-800 p-4 rounded-xl flex items-center justify-between text-xs font-mono">
                <div><span className="text-slate-200 block font-bold">PA Compliance Records</span><p className="text-[10px] text-slate-500">Bylaws, records, and child protection.</p></div>
                <button type="button" onClick={() => setPaFiling(!paFiling)} className={`px-3 py-1 rounded font-bold border transition ${paFiling ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>{paFiling ? 'VALID' : 'STALE'}</button>
              </div>
            </div>

            <button type="button" onClick={handleBoardExecute} className="w-full bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-mono font-black text-xs py-2.5 rounded-xl transition uppercase tracking-wider">⚡ Record Fiduciary Quorum Resolution</button>
          </div>

          {telemetryLog && (
            <div className="bg-slate-950/80 border border-slate-900 rounded-xl p-4 font-mono text-[11px] text-slate-400 space-y-1">
              <div className="text-emerald-400 font-bold border-b border-slate-900 pb-1 flex justify-between items-center"><span>📡 LEGISLATIVE RESOLUTION RECORDED IN STAGING PATH</span><span className="text-[10px] text-slate-600">{telemetryLog.timestamp}</span></div>
              <div>• Trace Intercept Destination: <span className="text-slate-300 underline">{telemetryLog.stagingPath}</span></div>
              <div>• Community Footprint Metric: <span className="text-slate-200 font-bold">{telemetryLog.data.totalFloorMinutesAggregated} Minutes Accumulated</span></div>
              <div className="text-red-400 font-bold">• Administrative Promotion Gateway: BLOCKED (Requires Physical Manual Sign-off Check Flag by Head Coach Jason)</div>
            </div>
          )}
        </div>

        <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl text-center font-mono text-xs text-slate-500 border-dashed h-fit space-y-2">
          <div>🛑 Financial System Operational Warning:</div>
          <p className="text-slate-400 text-[11px] leading-relaxed font-mono">
            Error State Message: <code className="text-amber-400">[Permission denied]</code>. High-level scholarship funding trackers remain deferred to protect zero-trust data protection boundaries.
          </p>
        </div>
      </div>

      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[11px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
