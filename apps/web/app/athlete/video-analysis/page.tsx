'use client';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

const athletePanels = [
  'Athlete Feedback',
  'Film Review',
  'Session Comparison',
  'Before / After Comparison',
  'Analysis History',
  'Skill Recognition Placeholder',
  'Technique Scoring Placeholder',
];

export default function AthleteVideoAnalysisPage() {
  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/video-analysis" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">AI / ML Video Analysis</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Athlete Film Feedback Lane</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">Athlete-facing video review and feedback visibility surface.</p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {athletePanels.map((panel) => (
            <article key={panel} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel}</p>
              <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">FRONT-END PLACEHOLDER | BACKEND REQUIRED</p>
            </article>
          ))}
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Athlete Workspace
          </Link>
          <Link href="/coach/video-analysis" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Coach Video Analysis Surface
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
