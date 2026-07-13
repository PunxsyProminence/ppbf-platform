'use client';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

const overviewStats = [
  { label: 'Progression Intelligence Overview', value: 'PLANNED' },
  { label: 'Assessment History', value: 'FRONT-END PLACEHOLDER' },
  { label: 'Goal Progression', value: 'Visible' },
  { label: 'Skill Progression', value: 'Visible' },
  { label: 'Readiness Trends', value: 'Visible (Mock)' },
  { label: 'Coach Review Trends', value: 'Coach Review Required' },
];

const timelineItems = [
  { period: 'Week 1', note: 'Baseline readiness and movement assessment logged (mock).', status: 'FRONT-END PLACEHOLDER' },
  { period: 'Week 2', note: 'Skill progression checkpoint and coach note registered (mock).', status: 'HUMAN REVIEW REQUIRED' },
  { period: 'Week 3', note: 'Goal progression adjustment and training plan revision (mock).', status: 'COACH REVIEW REQUIRED' },
];

const recommendationCards = [
  { title: 'Development Recommendation Placeholder', state: 'PLANNED | NOT YET AUTOMATED | BACKEND REQUIRED' },
  { title: 'Closed-Loop Feedback Placeholder', state: 'PLANNED | NOT YET AUTOMATED | BACKEND REQUIRED' },
  { title: 'Coach Action Queue Placeholder', state: 'PLANNED | NOT YET AUTOMATED | BACKEND REQUIRED' },
  { title: 'Parent-Support Visibility Placeholder', state: 'PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED' },
];

export default function AthleteProgressionIntelligencePage() {
  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/progression-intelligence" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Athlete Development Timeline</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Closed-Loop Progression Intelligence - Planned. Recommendation and scoring logic is not automated in this pass.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
          </p>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {overviewStats.map((item) => (
            <article key={item.label} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-3">
              <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#d4a574]">{item.label}</p>
              <p className="mt-2 text-sm font-semibold text-[#e8d7c6]">{item.value}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Training History + Assessment History</h2>
            <div className="mt-3 space-y-2">
              {timelineItems.map((item) => (
                <div key={item.period} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{item.period}</p>
                  <p className="mt-1 text-xs text-[#cfbfae]">{item.note}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{item.status}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Recommendation And Feedback Lane</h2>
            <div className="mt-3 space-y-2">
              {recommendationCards.map((card) => (
                <div key={card.title} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{card.title}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{card.state}</p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
          <p className="text-sm font-semibold text-[#d4a574]">Human Governance Boundary</p>
          <p className="mt-1 text-xs text-[#cfbfae]">
            Coach Review Required | Human Review Required. No automated athlete decisioning is performed.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Athlete Workspace
          </Link>
          <Link href="/parent/progression-visibility" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Parent Support Visibility
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
