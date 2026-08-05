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
        { label: 'Athlete dashboard', href: '/athlete/dashboard' },
        { label: 'The Ring', href: '/operations' },
      ]}
      stats={[
        { label: 'Audience', value: 'Guardians' },
        { label: 'Access', value: 'View-only' },
        { label: 'Focus', value: 'Safety' },
        { label: 'Mode', value: 'Family' },
      ]}
    >
      <section className="tactical-panel p-4">
        <h2 className="text-lg font-black text-[var(--black)]">Quick Actions</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <a
            href="/parent/dashboard"
            className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
          >
            Parent Dashboard
          </a>
          <a
            href="/parent/progression-visibility"
            className="inline-flex min-h-[44px] items-center justify-center border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
          >
            Progress Visibility
          </a>
          <a
            href="/guardian"
            className="inline-flex min-h-[44px] items-center justify-center border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
          >
            Guardian Snapshot
          </a>
          <a
            href="/shadow"
            className="inline-flex min-h-[44px] items-center justify-center border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--gray-dark)] transition hover:border-[var(--red-primary)]"
          >
            SHADOW Intel
          </a>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <details className="tactical-panel p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Attendance</summary>
          <p className="mt-2 text-sm leading-6 text-[var(--black)]">Shows check-ins, streaks, and whether the participant has met minimum participation expectations.</p>
        </details>
        <details className="tactical-panel p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Safety notes</summary>
          <p className="mt-2 text-sm leading-6 text-[var(--black)]">Surface for injury flags, recovery holds, and any restricted training guidance.</p>
        </details>
        <details className="tactical-panel p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Home follow-up</summary>
          <p className="mt-2 text-sm leading-6 text-[var(--black)]">A place for at-home practice prompts, family reminders, and message acknowledgements.</p>
        </details>
      </div>
    </FeatureSurface>
  );
}