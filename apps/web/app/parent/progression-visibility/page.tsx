'use client';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

const familyPanels = [
  'Parent-Support Visibility Placeholder',
  'Athlete Development Timeline (Family View)',
  'Coach Review Required Notices',
  'Human Review Required Notices',
];

export default function ParentProgressionVisibilityPage() {
  return (
    <RoleStandaloneView roleLabel="Parent Hub" routeLabel="/parent/progression-visibility" allowedRoles={['parent']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Parent Progression Visibility</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Family-facing progression surface for support visibility only.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          {familyPanels.map((panel) => (
            <article key={panel} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel}</p>
              <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                FRONT-END PLACEHOLDER | BACKEND REQUIRED
              </p>
            </article>
          ))}
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/parent/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Parent Hub
          </Link>
          <Link href="/athlete/progression-intelligence" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Athlete Progression Surface
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
