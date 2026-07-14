'use client';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

const coachTrendPanels = [
  { title: 'Readiness Trends', note: 'Mock trend line placeholder for weekly readiness variation.', label: 'FRONT-END PLACEHOLDER' },
  { title: 'Coach Review Trends', note: 'Review cadence and pending trend checks (mock display).', label: 'COACH REVIEW REQUIRED' },
  { title: 'Goal Progression', note: 'Goal completion path with mock checkpoint markers.', label: 'HUMAN REVIEW REQUIRED' },
  { title: 'Skill Progression', note: 'Technique development lane with static sample status cards.', label: 'FRONT-END PLACEHOLDER' },
];

const queueItems = [
  'Coach Action Queue Placeholder',
  'Closed-Loop Feedback Placeholder',
  'Development Recommendation Placeholder',
  'Assessment History Placeholder',
];

export default function CoachProgressionIntelligencePage() {
  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/progression-intelligence" allowedRoles={['coach']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Coach Progression Review Lane</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Front-end visibility only. Recommendation logic, predictive scoring, and automation are not implemented.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            {capabilityStatus}
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          {coachTrendPanels.map((panel) => (
            <article key={panel.title} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel.title}</p>
              <p className="mt-1 text-xs text-[#cfbfae]">{panel.note}</p>
              <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{panel.label}</p>
            </article>
          ))}
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Queue + Timeline</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {queueItems.map((item) => (
              <div key={item} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-sm font-semibold text-[#e8d7c6]">{item}</p>
                <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{capabilityStatus}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/review-queue" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Coach Workspace
          </Link>
          <Link href="/athlete/progression-intelligence" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Athlete Progression View
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
