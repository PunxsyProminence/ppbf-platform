'use client';

import { useState } from 'react';

type StaffRecord = {
  id: string;
  name: string;
  certificationTracker: string;
  safeSportStatus: string;
  backgroundCheckStatus: string;
};

type ProgramLaneMetric = {
  id: string;
  lane: string;
  activeAthletes: number;
  weeklyAttendance: number;
};

type ReadinessBucket = {
  label: string;
  count: number;
};

const IMMUNITY_GATE = 'Pending Coach Verification Flag {"verified_by_jason": false}';

const staffRecords: StaffRecord[] = [
  {
    id: 'st-001',
    name: 'Avery Hall',
    certificationTracker: 'Level 2 Coaching Ops',
    safeSportStatus: 'Current - Renewal due in 64 days',
    backgroundCheckStatus: 'Cleared - 2026 cycle',
  },
  {
    id: 'st-002',
    name: 'Jordan Pike',
    certificationTracker: 'Film and Safety Rotation',
    safeSportStatus: 'Pending annual recertification',
    backgroundCheckStatus: 'Cleared - Follow-up review flagged',
  },
  {
    id: 'st-003',
    name: 'Morgan Lee',
    certificationTracker: 'Volunteer Team Lead',
    safeSportStatus: 'Current - Verified this quarter',
    backgroundCheckStatus: 'Pending county validation receipt',
  },
];

const programLaneMetrics: ProgramLaneMetric[] = [
  { id: 'pl-001', lane: 'Non-Profit Boxing Program', activeAthletes: 84, weeklyAttendance: 312 },
  { id: 'pl-002', lane: 'Air Force SpecOps Prep Line', activeAthletes: 28, weeklyAttendance: 104 },
  { id: 'pl-003', lane: 'Cross-Track Recovery Lab', activeAthletes: 41, weeklyAttendance: 146 },
];

const readinessDistribution: ReadinessBucket[] = [
  { label: 'Green', count: 63 },
  { label: 'Yellow', count: 39 },
  { label: 'Red', count: 11 },
];

const readinessTrendBars = [82, 78, 76, 71, 74, 69, 73, 77];

export default function MacroCommandCenter() {
  const [specific, setSpecific] = useState('Increase defensive response consistency in live rounds.');
  const [measurable, setMeasurable] = useState('Raise average defensive score from 68 to 80 by checkpoint week 6.');
  const [achievable, setAchievable] = useState('Four supervised sessions weekly with film replay reinforcement.');
  const [relevant, setRelevant] = useState('Supports injury mitigation and confidence retention goals for active roster.');
  const [timeBound, setTimeBound] = useState('Target completion date: 2026-10-15.');

  return (
    <section className="mx-auto w-full max-w-7xl bg-black border border-zinc-800 rounded-none p-4">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-sm uppercase tracking-[0.2em] text-slate-200">Macro Analytics and Intake Command Center</h1>
        <p className="mt-2 text-xs text-zinc-500">Layers 04, 06, 32, 34, 37</p>
      </header>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="bg-black border border-zinc-800 rounded-none p-3 xl:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L37] Organization Command Center [V-BOARD-PUBLIC]</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-xs">
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Total Athlete Count</p>
              <p className="mt-1 text-slate-200 text-lg">113</p>
            </div>
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Program Lane Metrics</p>
              <ul className="mt-1 space-y-1 text-zinc-400">
                {programLaneMetrics.map((metric) => (
                  <li key={metric.id}>
                    {metric.lane}: {metric.activeAthletes}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Readiness Distribution</p>
              <ul className="mt-1 space-y-1 text-zinc-400">
                {readinessDistribution.map((bucket) => (
                  <li key={bucket.label}>
                    {bucket.label}: {bucket.count}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Board Governance Snapshot</p>
              <p className="mt-1 text-zinc-400">2 active agenda escalations, 5 policy votes pending, fiscal cadence on target.</p>
            </div>
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L32] Decision Support Center [V-COACH]</h2>
          <p className="mt-2 text-xs text-zinc-500">Readiness Trend Graphs</p>
          <div className="mt-2 grid grid-cols-8 gap-2">
            {readinessTrendBars.map((value, index) => (
              <div key={`${value}-${index}`} className="flex flex-col items-center gap-1">
                <div className="w-full border border-zinc-700 bg-zinc-950" style={{ height: `${value}px` }} />
                <span className="text-[10px] text-zinc-500">W{index + 1}</span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-zinc-500">Deload Recommendations</p>
          <ul className="mt-1 space-y-1 text-xs text-zinc-400">
            <li>- Lane 2 sprint-contact volume: reduce by 12% for 5-day cycle.</li>
            <li>- Recovery lab morning block: add guided mobility extension.</li>
            <li>- Red-zone athletes: lock contact rotations until clearance review.</li>
          </ul>

          <p className="mt-3 text-xs text-zinc-500">Red Flag Aggregator</p>
          <div className="mt-1 border border-zinc-800 bg-black p-2 text-xs text-[#b91c1c]">
            7 risk flags active: 3 attendance anomalies, 2 recovery compliance misses, 2 escalation queue holds.
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L34] Volunteer and Staff Management [V-STAFF]</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border border-zinc-800">
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Staff</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Certification Tracker</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">SafeSport Status</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Background Checks</th>
                </tr>
              </thead>
              <tbody>
                {staffRecords.map((row) => (
                  <tr key={row.id} className="border border-zinc-800 align-top">
                    <td className="border border-zinc-800 p-2 text-slate-200">{row.name}</td>
                    <td className="border border-zinc-800 p-2 text-zinc-400">{row.certificationTracker}</td>
                    <td className="border border-zinc-800 p-2 text-zinc-400">
                      <p>{row.safeSportStatus}</p>
                      <p className="mt-1 text-[11px] text-[#b91c1c]">{IMMUNITY_GATE}</p>
                    </td>
                    <td className="border border-zinc-800 p-2 text-zinc-400">
                      <p>{row.backgroundCheckStatus}</p>
                      <p className="mt-1 text-[11px] text-[#b91c1c]">{IMMUNITY_GATE}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3 xl:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L04 and L06] Goal Routing and Assignments [V-STAFF]</h2>
          <p className="mt-2 text-xs text-zinc-500">S-M-A-R-T intake protocol form</p>
          <div className="mt-3 grid gap-2 text-xs">
            <label htmlFor="smart-specific" className="text-zinc-400">Specific</label>
            <input
              id="smart-specific"
              value={specific}
              onChange={(event) => setSpecific(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />

            <label htmlFor="smart-measurable" className="text-zinc-400">Measurable</label>
            <input
              id="smart-measurable"
              value={measurable}
              onChange={(event) => setMeasurable(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />

            <label htmlFor="smart-achievable" className="text-zinc-400">Achievable</label>
            <input
              id="smart-achievable"
              value={achievable}
              onChange={(event) => setAchievable(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />

            <label htmlFor="smart-relevant" className="text-zinc-400">Relevant</label>
            <input
              id="smart-relevant"
              value={relevant}
              onChange={(event) => setRelevant(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />

            <label htmlFor="smart-time-bound" className="text-zinc-400">Time-bound</label>
            <input
              id="smart-time-bound"
              value={timeBound}
              onChange={(event) => setTimeBound(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />
          </div>
        </section>
      </div>
    </section>
  );
}
