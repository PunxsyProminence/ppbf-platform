'use client';

import React, { useState } from 'react';

interface CoachTelemetryPacket {
  timestamp: string;
  stagingPath: string;
  data: {
    athleteId: string;
    targetTrack: 'Non-Profit' | 'SpecOps';
    rpeScore: number;
    sorenessIndex: number;
    simplifyRationale: string;
    internalNotes: string;
    verifiedByJason: boolean;
  };
}

export default function CoachWorkspace() {
  const [athleteId, setAthleteId] = useState<string>("PPBF-YOUTH-092");
  const [targetTrack, setTargetTrack] = useState<'Non-Profit' | 'SpecOps'>('Non-Profit');
  const [rpeValue, setRpeValue] = useState<number>(6);
  const [sorenessValue, setSorenessValue] = useState<number>(3);
  const [simplifyRationale, setSimplifyRationale] = useState<string>("");
  const [internalNotes, setInternalNotes] = useState<string>("");
  const [telemetryLog, setTelemetryLog] = useState<CoachTelemetryPacket | null>(null);

  const handleCoachSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const packet: CoachTelemetryPacket = {
      timestamp: new Date().toISOString(),
      stagingPath: "/system_control/pending/coach_evaluation_log",
      data: {
        athleteId,
        targetTrack,
        rpeScore: rpeValue,
        sorenessIndex: sorenessValue,
        simplifyRationale: rpeValue > 8 ? simplifyRationale || "Auto-triggered overload modification" : simplifyRationale,
        internalNotes,
        verifiedByJason: false // Hard-blocked from automated track progression by Directive 5
      }
    };
    setTelemetryLog(packet);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* AUTHORITY BANNER */}
      <div className="bg-[#5a2a2a]/40 text-[#8b4444] border-2 border-[#8b4444] px-4 py-3 text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>📋 <strong>COACH EVALUATION ENGINE:</strong> Decisions guided by explicit policy standards, not personal relationships.</div>
        <span className="text-[10px] bg-[#5a2a2a]/40 px-2 py-0.5 uppercase font-bold text-[#e8d7c6] border-2 border-[#8b4444]">Layer 10 Active</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-6">
          <div className="border-b border-[#4a4a4a] pb-3">
            <h3 className="text-base font-bold font-mono text-[#e8d7c6]">Session Evaluation & Queue Decisions</h3>
            <p className="text-xs text-[#b0a095] font-mono mt-0.5">Audit session quality scores, record RPE tracking variables, and file training modifications.</p>
          </div>

          <form onSubmit={handleCoachSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#b0a095] block">Target Participant ID</label>
                <input type="text" value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#8b4444]" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#b0a095] block">Isolated Operational Track</label>
                <select value={targetTrack} onChange={(e) => setTargetTrack(e.target.value as 'Non-Profit' | 'SpecOps')} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#8b4444]">
                  <option value="Non-Profit">Non-Profit Track (6 Latin Ranks)</option>
                  <option value="SpecOps">Air Force SpecOps (16 Dimensions)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><label className="text-[#b0a095]">RPE Intensity Scale</label><span className="text-[#d4a574] font-bold">RPE {rpeValue}</span></div>
                <input type="range" min="1" max="10" step="1" value={rpeValue} onChange={(e) => setRpeValue(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><label className="text-[#b0a095]">Observed Soreness Index</label><span className="text-[#d4a574] font-bold">Level {sorenessValue}</span></div>
                <input type="range" min="0" max="10" step="1" value={sorenessValue} onChange={(e) => setSorenessValue(parseInt(e.target.value))} className="w-full accent-[#d4a574] h-1 bg-[#4a4a4a]" />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-[#b0a095] block">Simplify / Downgrade Rationale <span className="text-[10px] text-[#9a8a7a]">(Mandatory if RPE &gt; 8)</span></label>
              <textarea value={simplifyRationale} onChange={(e) => setSimplifyRationale(e.target.value)} placeholder="Required when programmatic target baseline tasks must be modified due to mechanical fatigue or recovery constraints." className="w-full h-16 bg-[#1a1a1a] border-2 border-[#8b4444] p-3 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#8b4444] resize-none" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-[#b0a095] block">Internal Technical Coaching Notes</label>
              <textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} placeholder="Record internal observations regarding stance integrity, combination fluency, or neurocognitive response parameters." className="w-full h-16 bg-[#1a1a1a] border-2 border-[#8b4444] p-3 text-xs font-mono text-[#e8d7c6] focus:outline-none focus:border-[#8b4444] resize-none" />
            </div>

            <button type="submit" className="w-full bg-[#8b4444] hover:bg-[#8b4444] text-[#e8d7c6] font-mono font-black text-xs py-2.5 transition uppercase tracking-wider border-2 border-[#8b4444]">⚡ Dispatch Evaluation to Staging Pipeline</button>
          </form>

          {telemetryLog && (
            <div className="bg-[#0f0f0f]/80 border-2 border-[#8b4444] p-4 space-y-1.5 font-mono text-[11px] text-[#b0a095]">
              <div className="text-[#8b4444] font-bold border-b border-[#8b4444] pb-1 flex justify-between items-center"><span>📡 EVALUATION LOG TRAPPED IN STAGING VECTOR</span><span className="text-[10px] text-[#9a8a7a]">{telemetryLog.timestamp}</span></div>
              <div>• Intercept Path: <span className="text-[#e8d7c6] underline">{telemetryLog.stagingPath}</span></div>
              <div>• Active Track Validation: <span className="text-[#e8d7c6] font-bold">{telemetryLog.data.targetTrack} Pathway</span></div>
              {telemetryLog.data.simplifyRationale && <div>• Downgrade Audit Entry: <span className="text-[#d4a574]">"{ telemetryLog.data.simplifyRationale}"</span></div>}
              <div className="text-[#8b4444] font-bold">• Automated Rank Promotion: BLOCKED (Requires Head Coach Jason Signature Flag)</div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 space-y-2">
            <span className="text-[10px] font-mono font-bold text-[#9a8a7a] uppercase tracking-wider block">Layer 07: Progression Rulesets</span>
            <h4 className="text-xs font-bold font-mono text-[#e8d7c6]">Technical Benchmarks Checklist</h4>
            <div className="text-[11px] font-mono text-[#b0a095] space-y-1.5 pt-1">
              <div>🔲 Stance Integrity & Guard Lockout</div>
              <div>🔲 Visual/Auditory Cue Coordination Speed</div>
              <div>🔲 Pattern Recognition Under Pressure</div>
              <div>🔲 Emotional Control & Coachability Rules</div>
            </div>
          </div>
          <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-5 text-center font-mono text-xs text-[#9a8a7a]">
            🛑 Queue Notification State:<br /><span className="text-[#b0a095] font-bold text-[11px]">[No coach reviews pending. Queue clear.]</span>
          </div>
        </div>
      </div>

      <div className="bg-[#0f0f0f]/60 border-2 border-[#8b4444] p-4 text-[11px] font-mono text-[#9a8a7a] text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
