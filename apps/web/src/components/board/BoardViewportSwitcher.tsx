'use client';

import { useMemo, useState } from 'react';
import { formatGymNumber } from '@/src/lib/gymTime';

type GovernanceView = 'President' | 'Treasurer' | 'Secretary';

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

const DEFERRED_CAPABILITY =
  'Fee and waiver pipeline: deferred by board order. Nothing is built behind it, and no fee or waiver record is stored anywhere in the platform.';

const PANEL = 'mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)]';
const SHEET = 'mat-paper mt-[var(--s4)] overflow-x-auto rounded-[var(--r-sm)] p-[var(--s4)]';

/* This prototype was the one surface in the board tree written in another
   room's clothes: bg-black, thirty border-zinc-800 rules, text-slate-*, a
   one-off #b91c1c, and mono console copy -- [V-BOARD-PUBLIC] eight times,
   "Layers 22 and 23", "L17", "L22". The board room is painted wainscot,
   plaster, dark ink and formal quiet, so it now stands on leather panels in
   the t-* voices with no build tags in rendered copy.

   The fabricated-data declaration is unchanged and deliberately so: it is the
   one thing on this page that is true, and boardViewportSwitcherHonesty.test
   holds it word for word.

   The "Mandatory Reason for Manual Override" prompt is gone rather than
   restyled. Its Acknowledge button called setTrainingMinutes((value) => value)
   -- it accepted a fiduciary rationale and did nothing with it, on a page that
   stores nothing at all. A control that silently discards what it asks for is
   worse than no control. */
export default function BoardViewportSwitcher() {
  const [activeView, setActiveView] = useState<GovernanceView>('President');

  const projectedGrantTotal = useMemo(
    () => grantPipelines.reduce((total, row) => total + row.projectedUsd, 0),
    [],
  );

  const trainingMinutes = 8720;
  const currentCapacity = useMemo(() => {
    const baselineMinutes = 9200;
    return Math.round((trainingMinutes / baselineMinutes) * 100);
  }, [trainingMinutes]);

  return (
    <section className="mat-leather mx-auto w-full max-w-7xl rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
      <header className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)]">
        <p className="t-eyebrow tracking-[0.28em]">Board Workspace</p>
        <h1 className="t-command mt-[var(--s2)] text-[length:var(--t-xl)]">Seat View Prototype</h1>
        <p className="mt-[var(--s4)]"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
        <p className="t-body mt-[var(--s4)] max-w-[80ch]">
          Every financial figure, governance metric, and compliance statement below is fabricated
          sample data. Nothing on this page reads or writes real records — do not act on anything it
          shows, and never carry a number from this page into a board packet or a filing.
        </p>
      </header>

      <nav aria-label="Seat view" className="mt-[var(--s5)] grid gap-[var(--s2)] sm:grid-cols-3">
        {(['President', 'Treasurer', 'Secretary'] as GovernanceView[]).map((view) => (
          <button
            key={view}
            type="button"
            onClick={() => setActiveView(view)}
            aria-pressed={activeView === view}
            className={`min-h-[44px] rounded-[var(--r-sm)] border px-[var(--s4)] text-[length:var(--t-sm)] font-bold uppercase tracking-[0.09em] transition ${
              activeView === view
                ? 'mat-brass--patina border-[color:var(--brass-600)] text-[color:var(--hide-950)]'
                : 'border-[color:rgba(212,175,74,.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)]'
            }`}
          >
            {view}
          </button>
        ))}
      </nav>

      {activeView === 'President' ? (
        <div className="mt-[var(--s5)] grid gap-[var(--s4)] lg:grid-cols-2">
          <section className={PANEL}>
            <h2 className="t-command text-[length:var(--t-md)]">Organizational risk trend</h2>
            <p className="t-muted mt-[var(--s2)]">Seven weeks, most recent last.</p>
            <div className="mt-[var(--s4)] grid grid-cols-7 gap-[var(--s2)]">
              {macroRiskPoints.map((value, index) => (
                <div key={`${value}-${index}`} className="flex flex-col items-center gap-[var(--s2)]">
                  <div
                    className="w-full rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.34)]"
                    style={{ height: `${Math.max(24, value)}px` }}
                  />
                  <span className="t-data text-[length:var(--t-xs)]">W{index + 1}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={PANEL}>
            <h2 className="t-command text-[length:var(--t-md)]">Policy review queue</h2>
            <div className={SHEET}>
              <table className="ledger">
                <caption className="text-left">Policy Review</caption>
                <thead>
                  <tr>
                    <th scope="col">Policy</th>
                    <th scope="col">Risk</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {policyReviewQueue.map((row) => (
                    <tr key={row.id}>
                      <td>{row.policy}</td>
                      <td>{row.riskScore}</td>
                      <td>{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {activeView === 'Treasurer' ? (
        <div className="mt-[var(--s5)] grid gap-[var(--s4)] lg:grid-cols-2">
          <section className={PANEL}>
            <h2 className="t-command text-[length:var(--t-md)]">Unit budgets</h2>
            <div className={SHEET}>
              <table className="ledger">
                <caption className="text-left">Allocation Against Spend</caption>
                <thead>
                  <tr>
                    <th scope="col">Unit</th>
                    <th scope="col">Allocated</th>
                    <th scope="col">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {budgetRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.unit}</td>
                      <td>${formatGymNumber(row.allocatedUsd)}</td>
                      <td>${formatGymNumber(row.spentUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={PANEL}>
            <h2 className="t-command text-[length:var(--t-md)]">Grant funding pipeline</h2>
            <div className={SHEET}>
              <table className="ledger">
                <caption className="text-left">Projected Awards</caption>
                <thead>
                  <tr>
                    <th scope="col">Grant</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Projected</th>
                  </tr>
                </thead>
                <tbody>
                  {grantPipelines.map((row) => (
                    <tr key={row.id}>
                      <td>{row.grant}</td>
                      <td>{row.stage}</td>
                      <td>${formatGymNumber(row.projectedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <article className="stat mt-[var(--s4)]">
              <p className="stat-label">Pipeline Projection Total</p>
              <p className="stat-val">${formatGymNumber(projectedGrantTotal)}</p>
              <p className="stat-note">Sum of the three sample rows above</p>
            </article>
          </section>

          <section className={`${PANEL} lg:col-span-2`}>
            <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
              <h2 className="t-command text-[length:var(--t-md)]">Deferred capability</h2>
              {/* Law 7: a deferral is pressed in ink. The one-off #b91c1c this
                  heading used to carry was the only raw hex in the board tree,
                  and red is the safety ladder's, not a status label's. */}
              <span className="stamp stamp--flat">Deferred</span>
            </div>
            <p className="t-body mt-[var(--s3)] max-w-[80ch]">{DEFERRED_CAPABILITY}</p>
          </section>
        </div>
      ) : null}

      {activeView === 'Secretary' ? (
        <section className={`${PANEL} mt-[var(--s5)]`}>
          <h2 className="t-command text-[length:var(--t-md)]">Meeting minutes approval queue</h2>
          <div className={SHEET}>
            <table className="ledger">
              <caption className="text-left">Minutes Awaiting Approval</caption>
              <thead>
                <tr>
                  <th scope="col">Meeting</th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {meetingMinutesQueue.map((row) => (
                  <tr key={row.id}>
                    <td>{row.meeting}</td>
                    <td>{row.date}</td>
                    <td>{row.approvalStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className={`${PANEL} mt-[var(--s5)]`}>
        <h2 className="t-command text-[length:var(--t-md)]">Grant reporting</h2>
        <div className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2">
          <article className="stat">
            <p className="stat-label">Training Floor Minutes</p>
            <p className="stat-val">{formatGymNumber(trainingMinutes)}</p>
            <p className="stat-note">Sample figure; nothing counts this</p>
          </article>
          <article className="stat">
            <p className="stat-label">Capacity Index</p>
            <p className="stat-val">{currentCapacity}%</p>
            <p className="stat-note">Sample figure against a 9,200 minute baseline</p>
          </article>
        </div>
      </section>
    </section>
  );
}
