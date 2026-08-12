'use client';

import { useMemo, useState } from 'react';
import { formatGymNumber } from '@/src/lib/gymTime';

type GovernanceView = 'PRESIDENT' | 'TREASURER' | 'SECRETARY';

type PolicyReviewRow = {
  id: string;
  policy: string;
  riskScore: number;
  status: 'pending' | 'approved';
};

type BudgetRow = {
  id: string;
  unit: string;
  allocatedUsd: number;
  spentUsd: number;
};

type GrantPipelineRow = {
  id: string;
  grant: string;
  stage: string;
  projectedUsd: number;
};

type MinutesQueueRow = {
  id: string;
  meeting: string;
  date: string;
  approvalStatus: 'awaiting' | 'approved';
};

const policyReviewQueue: PolicyReviewRow[] = [
  { id: 'pr-001', policy: 'Youth Contact Intensity Cap', riskScore: 78, status: 'pending' },
  { id: 'pr-002', policy: 'Travel Event Chaperone Protocol', riskScore: 62, status: 'pending' },
  { id: 'pr-003', policy: 'Incident Escalation SLA', riskScore: 44, status: 'approved' },
];

const budgetRows: BudgetRow[] = [
  { id: 'bg-001', unit: 'Training Floor', allocatedUsd: 125000, spentUsd: 84220 },
  { id: 'bg-002', unit: 'Safety Operations', allocatedUsd: 94000, spentUsd: 55210 },
  { id: 'bg-003', unit: 'Transportation', allocatedUsd: 36000, spentUsd: 28190 },
];

const grantPipelines: GrantPipelineRow[] = [
  { id: 'gp-001', grant: 'Regional Youth Recovery Fund', stage: 'Compliance Review', projectedUsd: 45000 },
  { id: 'gp-002', grant: 'Community Boxing Access Grant', stage: 'Board Signature', projectedUsd: 28500 },
  { id: 'gp-003', grant: 'Equipment Renewal Initiative', stage: 'Draft', projectedUsd: 16000 },
];

const meetingMinutesQueue: MinutesQueueRow[] = [
  { id: 'mm-001', meeting: 'Quarterly Governance Review', date: '2026-08-02', approvalStatus: 'awaiting' },
  { id: 'mm-002', meeting: 'Safety Compliance Committee', date: '2026-08-05', approvalStatus: 'approved' },
  { id: 'mm-003', meeting: 'Program Integrity Session', date: '2026-08-08', approvalStatus: 'awaiting' },
];

const macroRiskPoints = [74, 68, 72, 59, 64, 49, 46];

const DISABLED_CAPABILITY_CARD =
  'Capability 17 - Fee & Waiver Pipeline: DEFERRED BY NON-PROFIT BOARD ORDER. Production Build v21.0 Database locked to Free-Tier Google Sheets structure.';

export default function BoardViewportSwitcher() {
  const [activeView, setActiveView] = useState<GovernanceView>('PRESIDENT');
  const [trainingMinutes, setTrainingMinutes] = useState(8720);
  const [showOverridePrompt, setShowOverridePrompt] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const projectedGrantTotal = useMemo(
    () => grantPipelines.reduce((total, row) => total + row.projectedUsd, 0),
    [],
  );

  const currentCapacity = useMemo(() => {
    const baselineMinutes = 9200;
    return Math.round((trainingMinutes / baselineMinutes) * 100);
  }, [trainingMinutes]);

  function triggerOverridePrompt() {
    setShowOverridePrompt(true);
  }

  function acknowledgeOverrideReason() {
    if (overrideReason.trim().length === 0) {
      return;
    }
    setShowOverridePrompt(false);
    setTrainingMinutes((value) => value);
  }

  return (
    <section className="mx-auto w-full max-w-7xl bg-black border border-zinc-800 rounded-none p-4">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-sm uppercase tracking-[0.2em] text-slate-200">
          Fiduciary Board Command Center [V-BOARD-PUBLIC]
        </h1>
        <p className="mt-2 text-xs text-zinc-500">Layers 22 and 23 | Governance Role Switchboard</p>
      </header>

      <nav className="mt-4 grid gap-2 sm:grid-cols-3">
        {(['PRESIDENT', 'TREASURER', 'SECRETARY'] as GovernanceView[]).map((view) => (
          <button
            key={view}
            type="button"
            onClick={() => setActiveView(view)}
            className={`border border-zinc-800 rounded-none px-3 py-2 text-xs tracking-[0.15em] ${
              activeView === view ? 'bg-zinc-900 text-slate-100' : 'bg-black text-zinc-400 hover:text-slate-200'
            }`}
          >
            {view}
          </button>
        ))}
      </nav>

      {activeView === 'PRESIDENT' ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="bg-black border border-zinc-800 rounded-none p-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
              Macro Organizational Risk Graph [V-BOARD-PUBLIC]
            </h2>
            <div className="mt-3 grid grid-cols-7 gap-2">
              {macroRiskPoints.map((value, index) => (
                <div key={`${value}-${index}`} className="flex flex-col items-center gap-2">
                  <div className="w-full border border-zinc-700 bg-zinc-950" style={{ height: `${Math.max(24, value)}px` }} />
                  <span className="text-[10px] text-zinc-500">W{index + 1}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-black border border-zinc-800 rounded-none p-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
              Policy Review Queue [V-BOARD-PUBLIC]
            </h2>
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="border border-zinc-800">
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Policy</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Risk</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {policyReviewQueue.map((row) => (
                  <tr key={row.id} className="border border-zinc-800">
                    <td className="border border-zinc-800 p-2">{row.policy}</td>
                    <td className="border border-zinc-800 p-2">{row.riskScore}</td>
                    <td className="border border-zinc-800 p-2">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      ) : null}

      {activeView === 'TREASURER' ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="bg-black border border-zinc-800 rounded-none p-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
              Corporate Budgets [V-BOARD-PUBLIC]
            </h2>
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="border border-zinc-800">
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Unit</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Allocated</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Spent</th>
                </tr>
              </thead>
              <tbody>
                {budgetRows.map((row) => (
                  <tr key={row.id} className="border border-zinc-800">
                    <td className="border border-zinc-800 p-2">{row.unit}</td>
                    <td className="border border-zinc-800 p-2">${formatGymNumber(row.allocatedUsd)}</td>
                    <td className="border border-zinc-800 p-2">${formatGymNumber(row.spentUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="bg-black border border-zinc-800 rounded-none p-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
              Grant Funding Pipelines [V-BOARD-PUBLIC]
            </h2>
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="border border-zinc-800">
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Grant</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Stage</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Projected</th>
                </tr>
              </thead>
              <tbody>
                {grantPipelines.map((row) => (
                  <tr key={row.id} className="border border-zinc-800">
                    <td className="border border-zinc-800 p-2">{row.grant}</td>
                    <td className="border border-zinc-800 p-2">{row.stage}</td>
                    <td className="border border-zinc-800 p-2">${formatGymNumber(row.projectedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-zinc-500">Pipeline projection total: ${formatGymNumber(projectedGrantTotal)}</p>
          </section>

          <section className="lg:col-span-2 bg-black border border-zinc-800 rounded-none p-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-[#b91c1c]">
              L17 Disabled Capability Card [V-BOARD-PUBLIC]
            </h2>
            <p className="mt-2 border border-zinc-800 bg-black p-2 text-xs text-zinc-300">{DISABLED_CAPABILITY_CARD}</p>
          </section>
        </div>
      ) : null}

      {activeView === 'SECRETARY' ? (
        <section className="mt-4 bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
            Meeting Minutes Approval Queue [V-BOARD-PUBLIC]
          </h2>
          <table className="mt-3 w-full border-collapse text-xs">
            <thead>
              <tr className="border border-zinc-800">
                <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Meeting</th>
                <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Date</th>
                <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Status</th>
              </tr>
            </thead>
            <tbody>
              {meetingMinutesQueue.map((row) => (
                <tr key={row.id} className="border border-zinc-800">
                  <td className="border border-zinc-800 p-2">{row.meeting}</td>
                  <td className="border border-zinc-800 p-2">{row.date}</td>
                  <td className="border border-zinc-800 p-2">{row.approvalStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mt-4 bg-black border border-zinc-800 rounded-none p-3">
        <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
          L22 Grant Reporting [V-BOARD-PUBLIC]
        </h2>
        <p className="mt-2 text-sm text-slate-100">Total Training Floor Minutes: {formatGymNumber(trainingMinutes)}</p>
        <p className="mt-1 text-[11px] text-zinc-500">Capacity index: {currentCapacity}%</p>
        <label htmlFor="training-floor-minutes" className="mt-3 block text-[11px] text-zinc-400">
          Locked Counter Input [V-BOARD-PUBLIC]
        </label>
        <input
          id="training-floor-minutes"
          readOnly
          value={trainingMinutes}
          onClick={triggerOverridePrompt}
          onFocus={triggerOverridePrompt}
          className="mt-1 w-full border border-zinc-800 bg-black p-2 text-xs text-zinc-300"
        />

        {showOverridePrompt ? (
          <div className="mt-3 border border-zinc-800 bg-black p-3">
            <label htmlFor="override-reason" className="block text-xs text-slate-200">
              Mandatory Reason for Manual Override
            </label>
            <input
              id="override-reason"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              className="mt-2 w-full border border-zinc-700 bg-black p-2 text-xs text-zinc-200"
              placeholder="State fiduciary rationale"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={acknowledgeOverrideReason}
                className="border border-zinc-700 px-3 py-1 text-xs text-slate-200 hover:bg-zinc-900"
              >
                Acknowledge
              </button>
              <button
                type="button"
                onClick={() => setShowOverridePrompt(false)}
                className="border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}
