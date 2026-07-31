'use client';

import FeatureSurface from '@/components/FeatureSurface';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function GuardianPortalPage() {
  return (
    <RoleStandaloneView roleLabel="Guardian Portal" routeLabel="/guardian" allowedRoles={['parent']} showShellHeader={false}>
      <GuardianPortalContent />
    </RoleStandaloneView>
  );
}

function GuardianPortalContent() {
  return (
    <FeatureSurface
      eyebrow="Guardian Portal"
      title="View-only family progress surface"
      description="A secure, easy-to-read snapshot for parents or guardians to monitor attendance, progress, and safety notes."
      status="ready"
      primaryLinks={[
        { label: 'Parent dashboard', href: '/parent/dashboard' },
        { label: 'The Ring', href: '/operations' },
      ]}
      stats={[
        { label: 'Audience', value: 'Guardians' },
        { label: 'Access', value: 'View-only' },
        { label: 'Focus', value: 'Safety' },
        { label: 'Mode', value: 'Family' },
      ]}
    >
      <section className="border-2 border-[#8b4444] bg-[#111111] p-4">
        <h2 className="text-lg font-black text-[#e8d7c6]">Quick Actions</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <a
            href="/parent/dashboard"
            className="inline-flex min-h-[44px] items-center justify-center border border-[#8b4444] bg-[#2a1414] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[#e8d7c6] transition hover:bg-[#3a1a1a]"
          >
            Parent Dashboard
          </a>
          <a
            href="/parent/progression-visibility"
            className="inline-flex min-h-[44px] items-center justify-center border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[#cfbfae] transition hover:border-[#8b4444]"
          >
            Progress Visibility
          </a>
          <a
            href="/guardian"
            className="inline-flex min-h-[44px] items-center justify-center border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[#cfbfae] transition hover:border-[#8b4444]"
          >
            Guardian Snapshot
          </a>
          <a
            href="/shadow"
            className="inline-flex min-h-[44px] items-center justify-center border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[#cfbfae] transition hover:border-[#8b4444]"
          >
            SHADOW Intel
          </a>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <details className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Attendance</summary>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Shows check-ins, streaks, and whether the participant has met minimum participation expectations.</p>
        </details>
        <details className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Safety notes</summary>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Surface for injury flags, recovery holds, and any restricted training guidance.</p>
        </details>
        <details className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Home follow-up</summary>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">A place for at-home practice prompts, family reminders, and message acknowledgements.</p>
        </details>
      </div>
    </FeatureSurface>
  );
}