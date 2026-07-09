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
      <div className="bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-4 py-3 rounded-xl text-xs font-mono flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>📋 <strong>COACH EVALUATION ENGINE:</strong> Decisions guided by explicit policy standards, not personal relationships.</div>
        <span className="text-[10px] bg-indigo-900/40 px-2 py-0.5 rounded uppercase font-bold text-white">Layer 10 Active</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#0b0f19] border border-slate-800 p-6 rounded-xl space-y-6">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-base font-bold font-mono text-slate-100">Session Evaluation & Queue Decisions</h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Audit session quality scores, record RPE tracking variables, and file training modifications.</p>
          </div>

          <form onSubmit={handleCoachSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 block">Target Participant ID</label>
                <input type="text" value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="w-full bg-[#111827] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 block">Isolated Operational Track</label>
                <select value={targetTrack} onChange={(e) => setTargetTrack(e.target.value as 'Non-Profit' | 'SpecOps')} className="w-full bg-[#111827] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500">
                  <option value="Non-Profit">Non-Profit Track (6 Latin Ranks)</option>
                  <option value="SpecOps">Air Force SpecOps (16 Dimensions)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><label className="text-slate-400">RPE Intensity Scale</label><span className="text-indigo-400 font-bold">RPE {rpeValue}</span></div>
                <input type="range" min="1" max="10" step="1" value={rpeValue} onChange={(e) => setRpeValue(parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none" />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono"><label className="text-slate-400">Observed Soreness Index</label><span className="text-amber-400 font-bold">Level {sorenessValue}</span></div>
                <input type="range" min="0" max="10" step="1" value={sorenessValue} onChange={(e) => setSorenessValue(parseInt(e.target.value))} className="w-full accent-amber-500 h-1 bg-slate-800 rounded-lg appearance-none" />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-slate-400 block">Simplify / Downgrade Rationale <span className="text-[10px] text-slate-600">(Mandatory if RPE &gt; 8)</span></label>
              <textarea value={simplifyRationale} onChange={(e) => setSimplifyRationale(e.target.value)} placeholder="Required when programmatic target baseline tasks must be modified due to mechanical fatigue or recovery constraints." className="w-full h-16 bg-[#111827] border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-none" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-slate-400 block">Internal Technical Coaching Notes</label>
              <textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} placeholder="Record internal observations regarding stance integrity, combination fluency, or neurocognitive response parameters." className="w-full h-16 bg-[#111827] border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-none" />
            </div>

            <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-500 text-slate-950 font-mono font-black text-xs py-2.5 rounded-xl transition uppercase tracking-wider">⚡ Dispatch Evaluation to Staging Pipeline</button>
          </form>

          {telemetryLog && (
            <div className="bg-slate-950/80 border border-slate-900 rounded-xl p-4 space-y-1.5 font-mono text-[11px] text-slate-400">
              <div className="text-indigo-400 font-bold border-b border-slate-900 pb-1 flex justify-between items-center"><span>📡 EVALUATION LOG TRAPPED IN STAGING VECTOR</span><span className="text-[10px] text-slate-600">{telemetryLog.timestamp}</span></div>
              <div>• Intercept Path: <span className="text-slate-300 underline">{telemetryLog.stagingPath}</span></div>
              <div>• Active Track Validation: <span className="text-slate-200 font-bold">{telemetryLog.data.targetTrack} Pathway</span></div>
              {telemetryLog.data.simplifyRationale && <div>• Downgrade Audit Entry: <span className="text-amber-400">"{telemetryLog.data.simplifyRationale}"</span></div>}
              <div className="text-red-400 font-bold">• Automated Rank Promotion: BLOCKED (Requires Head Coach Jason Signature Flag)</div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl space-y-2">
            <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">Layer 07: Progression Rulesets</span>
            <h4 className="text-xs font-bold font-mono text-slate-200">Technical Benchmarks Checklist</h4>
            <div className="text-[11px] font-mono text-slate-400 space-y-1.5 pt-1">
              <div>🔲 Stance Integrity & Guard Lockout</div>
              <div>🔲 Visual/Auditory Cue Coordination Speed</div>
              <div>🔲 Pattern Recognition Under Pressure</div>
              <div>🔲 Emotional Control & Coachability Rules</div>
            </div>
          </div>
          <div className="bg-[#0b0f19] border border-slate-800 p-5 rounded-xl text-center font-mono text-xs text-slate-500 border-dashed">
            🛑 Queue Notification State:<br /><span className="text-slate-400 font-bold text-[11px]">[No coach reviews pending. Queue clear.]</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-950/60 border border-slate-900 rounded-xl p-4 text-[11px] font-mono text-slate-500 text-center">
        ⚖️ <strong>CORPORATE LEGAL STENCIL STAMP:</strong> Punxsy Prominence Boxing and Fitness | Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715 | Enforcement Context: Production Build v21.0 Compliance Enforced
      </div>
    </div>
  );
}
