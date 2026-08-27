'use client';

import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ShadowChatButton from '@/components/ShadowChatButton';

export default function GuardianPortalPage() {
  return (
    <RoleStandaloneView roleLabel="Guardian Portal" routeLabel="/guardian" allowedRoles={['parent']} showShellHeader={false}>
      <GuardianPortalContent />
    </RoleStandaloneView>
  );
}

/* Family-facing surface, so the whole sheet sits on the warm canvas ground
   (Law 6): .on-canvas on the full-bleed wrapper, paper panels standing on it.
   Built from design-system/screens/guardian-portal.html rather than from the
   FeatureSurface scaffold this page used to borrow. */

const STATS = [
  { label: 'Audience', value: 'Guardians' },
  { label: 'Access', value: 'View-only' },
  { label: 'Focus', value: 'Safety' },
  { label: 'Mode', value: 'Family' },
] as const;

// 'Guardian Snapshot' used to be in this list pointing at /guardian -- this
// very page, a circle. The working surface is the Parent Dashboard, which is
// the primary signpost above the fold now, so the list holds the REST of the
// family side.
const QUICK_LINKS = [
  { label: 'Progress Visibility', href: '/parent/progression-visibility' },
  { label: 'SHADOW Intel', href: '/shadow' },
  { label: 'Member Access', href: '/login' },
] as const;

const EXPLAINERS = [
  {
    title: 'Attendance',
    body: 'Shows check-ins, streaks, and whether the participant has met minimum participation expectations.',
  },
  {
    title: 'Safety Notes',
    body: 'Surface for injury flags, recovery holds, and any restricted training guidance.',
  },
  {
    title: 'Home Follow-Up',
    body: 'A place for at-home practice prompts, family reminders, and message acknowledgements.',
  },
] as const;

function GuardianPortalContent() {
  return (
    <div className="on-canvas min-h-full rounded-[var(--r-lg)] p-[var(--s5)] md:p-[var(--s6)]">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Head row — eyebrow, command title, plain-language description. */}
        <div className="mb-[var(--s6)] flex flex-wrap items-start justify-between gap-[var(--s6)]">
          <div className="max-w-[56ch]">
            <p className="t-eyebrow">PPBF Platform · Family Access</p>
            <h1 className="t-command mt-[var(--s2)] mb-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>
              Guardian Portal
            </h1>
            <p className="t-body m-0">
              This page describes the family side of the platform. The place you actually see your
              child&apos;s attendance, safety notes, and messages is the Family Dashboard.
            </p>
            {/* The one action a guardian landing here actually wants: the
                working surface. This page renders no data of its own, and
                without this signpost it read as if it were supposed to. */}
            <Link href="/parent/dashboard" className="btn mt-[var(--s4)]">
              Open your Family Dashboard
            </Link>
          </div>
          <ShadowChatButton context="Guardian Portal View-only family progress surface" />
        </div>

        {/* Governance banner — structure only; the type voices recolour for canvas. */}
        <div
          className="mb-[var(--s6)] rounded-r-[var(--r-lg)] border-l-4 border-[color:var(--brass-700)] p-[var(--s4)] pl-[var(--s5)]"
          style={{ background: 'linear-gradient(90deg, rgb(var(--brass-400-rgb) / .22) 0%, transparent 100%)' }}
        >
          <p className="t-label mb-[var(--s2)]">Layer 0 Governance</p>
          <p className="t-body m-0">
            All guardian actions are logged and attributable. Only records you are authorized to view will appear here.
          </p>
        </div>

        {/* Registry facts as auditable records — t-label over t-data (Law 4). */}
        <div className="mb-[var(--s6)] grid grid-cols-2 gap-[var(--s4)] md:grid-cols-4">
          {STATS.map((item) => (
            <div key={item.label} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-label m-0">{item.label}</p>
              <p className="t-data mt-[var(--s2)] mb-0" style={{ fontSize: 'var(--t-sm)' }}>{item.value}</p>
            </div>
          ))}
        </div>

        <div className="grid items-start gap-[var(--s6)] md:grid-cols-[var(--split-major)_var(--split-minor)]">
          {/* What this surface reports on. */}
          <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>What the Family Dashboard Covers</h2>
            <p className="t-muted mt-[var(--s2)] mb-[var(--s5)]">
              Each of these lives on the Family Dashboard and reads from the participant&apos;s own
              record — nothing is editable from the family side.
            </p>
            <div className="space-y-[var(--s4)]">
              {EXPLAINERS.map((item) => (
                <details key={item.title} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                  <summary className="t-label cursor-pointer">{item.title}</summary>
                  <p className="t-body mt-[var(--s3)] mb-0">{item.body}</p>
                </details>
              ))}
            </div>
          </div>

          {/* Quick links. */}
          <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>Quick Links</h2>
            <p className="t-muted mt-[var(--s2)] mb-[var(--s5)]">The rest of the family side, one tap away.</p>
            <div className="grid gap-[var(--s3)]">
              {QUICK_LINKS.map((item) => (
                <Link key={item.href} href={item.href} className="btn btn--ghost w-full">
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
