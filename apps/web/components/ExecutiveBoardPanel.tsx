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
      <div className="bg-[#4a2020]/40 text-[#d4a574] border-2 border-[#8b4444] px-4 py-3 text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>🏛️ <strong>STATUTORY GOVERNANCE MODEL:</strong> PA-Compliant Framework. 7-Seat Board Fiduciary Duty Control Loop active.</div>
        <span className="text-[10px] bg-[#5a4a3a] px-2 py-0.5 uppercase font-bold text-[#e8d7c6]">Layer 23 Fiduciary Lock</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6">
          <div className="border-b border-[#8b4444] pb-3">
            <h2 className="text-xl font-black text-[#e8d7c6] font-mono">Fiduciary Reporting & Grant Metrics Summary</h2>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Transitioning from founder-heavy operations to shared legal oversight and grant validation.</p>
          </div>

          {/* 7-Seats Config */}
          <div className="space-y-2">
            <span className="text-[10px] font-mono font-bold text-[#b0a095] uppercase tracking-wider block">7-Seat Board Seat Index Mapping</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {seats.map(s => (
                <div key={s.title} className="bg-[#1a1a1a] border border-[#8b4444]/80 p-3 text-xs font-mono">
                  <span className="text-[#d4a574] font-bold block">{s.title}</span>
                  <p className="text-[10px] text-[#b0a095] mt-0.5 leading-relaxed">{s.focus}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Analytics parameters bound to Microsoft Non-Profit Grant */}
          <div className="border-t border-[#8b4444]/80 pt-4 space-y-4">
            <h4 className="text-xs font-bold font-mono text-[#b0a095] uppercase tracking-wider">Layer 22 / 23 Cloud Analytics Enforcers</h4>
            
            <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 space-y-2 text-xs font-mono">
              <div className="flex justify-between items-center">
                <div><span className="text-[#e8d7c6] block font-bold">Total Floor Minutes Accumulated</span><p className="text-[10px] text-[#b0a095]">Aggregated across active youth cohorts to satisfy Microsoft Grant validation parameters.</p></div>
                <span className="text-[#d4a574] font-black text-sm">{floorMinutes} MIN</span>
              </div>
              <input type="range" min="5000" max="30000" step="50" value={floorMinutes} onChange={(e) => setFloorMinutes(parseInt(e.target.value))} className="w-full accent-[#8b4444] h-1 bg-[#4a4a4a] appearance-none" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div><span className="text-[#e8d7c6] block font-bold">75% Attendance Fee Waiver</span><p className="text-[10px] text-[#b0a095]">Authorize standard monthly waivers.</p></div>
                <button type="button" onClick={() => setWaiverApproval(!waiverApproval)} className={`px-3 py-1 font-bold border transition ${waiverApproval ? 'bg-[#4a2020]/40 border-[#8b4444] text-[#d4a574]' : 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095]'}`}>{waiverApproval ? 'APPROVED' : 'HOLD'}</button>
              </div>
              <div className="bg-[#1a1a1a] border border-[#8b4444] p-4 flex items-center justify-between text-xs font-mono">
                <div><span className="text-[#e8d7c6] block font-bold">PA Compliance Records</span><p className="text-[10px] text-[#b0a095]">Bylaws, records, and child protection.</p></div>
                <button type="button" onClick={() => setPaFiling(!paFiling)} className={`px-3 py-1 font-bold border transition ${paFiling ? 'bg-[#4a2020]/40 border-[#8b4444] text-[#d4a574]' : 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095]'}`}>{paFiling ? 'VALID' : 'STALE'}</button>
              </div>
            </div>

            <button type="button" onClick={handleBoardExecute} className="w-full bg-[#8b4444] hover:bg-[#d4a574] text-[#e8d7c6] font-mono font-black text-xs py-2.5 transition uppercase tracking-wider">⚡ Record Fiduciary Quorum Resolution</button>
          </div>

          {telemetryLog && (
            <div className="bg-[#0a0a0a]/80 border border-[#4a4a4a] p-4 font-mono text-[11px] text-[#b0a095] space-y-1">
              <div className="text-[#d4a574] font-bold border-b border-[#4a4a4a] pb-1 flex justify-between items-center"><span>📡 LEGISLATIVE RESOLUTION RECORDED IN STAGING PATH</span><span className="text-[10px] text-[#8b4444]">{telemetryLog.timestamp}</span></div>
              <div>• Trace Intercept Destination: <span className="text-[#e8d7c6] underline">{telemetryLog.stagingPath}</span></div>
              <div>• Community Footprint Metric: <span className="text-[#e8d7c6] font-bold">{telemetryLog.data.totalFloorMinutesAggregated} Minutes Accumulated</span></div>
              <div className="text-[#d4a574] font-bold">• Administrative Promotion Gateway: BLOCKED (Requires Physical Manual Sign-off Check Flag by Head Coach Jason)</div>
            </div>
          )}
        </div>

        <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 text-center font-mono text-xs text-[#b0a095] border-dashed h-fit space-y-2">
          <div>🛑 Financial System Operational Warning:</div>
          <p className="text-[#e8d7c6] text-[11px] leading-relaxed font-mono">
            Error State Message: <code className="text-[#d4a574]">[Permission denied]</code>. High-level scholarship funding trackers remain deferred to protect zero-trust data protection boundaries.
          </p>
        </div>
      </div>

      <div className="bg-[#0a0a0a]/60 border border-[#4a4a4a] p-4 text-[11px] font-mono text-[#b0a095] text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
