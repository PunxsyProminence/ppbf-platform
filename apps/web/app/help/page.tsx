import type { Metadata } from 'next';
import Link from 'next/link';
import TutorialCard from '@/components/TutorialCard';
import { guideSections, masterTutorialCards, plannedCapabilityGuides } from '@/components/helpContent';
import OperationsLink from '@/components/OperationsLink';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { requirePageRole } from '@/src/server/pilot/pageGuard';
import { roleEquals } from '@/src/server/pilot/roleAlias';
import { builderHelpFor, helpAudienceFor, plainHelpFor } from '@/src/server/pilot/helpForRole';

// Internal tester material: signed-in members only, and kept out of search
// results. Every role may read it; signing in is the only gate (audit
// PUBLIC-06, lane N4-02). A Record so a new role cannot be left out silently.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const HELP_READERS: Record<PilotRole, true> = {
  platform_owner: true,
  organization_admin: true,
  admin: true,
  coach: true,
  athlete: true,
  parent: true,
  board: true,
  volunteer: true,
  staff: true,
};

export default async function HelpCenterPage() {
  const principal = await requirePageRole(Object.keys(HELP_READERS) as PilotRole[]);
  // /admin admits the gym admin and the platform owner only (admin/page.tsx);
  // nobody else is offered a door that would turn them away.
  // The platform owner's desk is Omega: /admin is a "set per gym" notice for
  // that role (lane U2, audit UX-A A-6).
  const adminDesk = roleEquals(principal.role, 'organization_admin')
    ? { href: '/admin', label: 'Capabilities' }
    : roleEquals(principal.role, 'platform_owner')
      ? { href: '/admin/platform', label: 'Omega' }
      : null;

  // Choose what this reader may see BEFORE rendering (F-064): another role's
  // sections must never be in the page sent to the browser.
  const audience = helpAudienceFor(principal.role);
  const plain = plainHelpFor(audience);
  const selection = builderHelpFor(audience);
  const cards = selection ? masterTutorialCards.filter((c) => selection.cards.includes(c.id)) : masterTutorialCards;
  const guides = selection ? guideSections.filter((g) => selection.guides.includes(g.id)) : guideSections;
  const planned = selection ? plannedCapabilityGuides.filter((p) => selection.planned.includes(p.id)) : plannedCapabilityGuides;

  if (plain) {
    return (
      <main className="on-canvas min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-10">
          <header className="space-y-3 border-b-[3px] border-[color:rgb(var(--brass-800-rgb)_/_.28)] pb-6">
            <p className="t-eyebrow tracking-[0.35em]">Help Center</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>{plain.heading}</h1>
            <p className="text-base leading-7 text-[color:var(--hide-800)]">{plain.intro}</p>
            {adminDesk && (
              <div className="flex flex-wrap gap-3">
                <OperationsLink className="btn btn--ghost">Operations</OperationsLink>
                <Link href={adminDesk.href} className="btn btn--ghost">{adminDesk.label}</Link>
              </div>
            )}
          </header>
          <section className="mt-8 space-y-4" id={plain.anchor}>
            {plain.topics.map((topic) => (
              <article key={topic.title} className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_.28)] p-[var(--s5)]">
                <h2 className="text-lg font-black text-[color:var(--hide-950)]">{topic.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[color:var(--hide-800)]">{topic.text}</p>
              </article>
            ))}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="on-canvas min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="space-y-4 border-b-[3px] border-[color:rgb(var(--brass-800-rgb)_/_.28)] pb-6">
          <p className="t-eyebrow tracking-[0.35em]">Help Center</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Help</h1>
          <p className="max-w-4xl text-base leading-7 text-[color:var(--hide-800)] md:text-lg">
            Learn how to navigate the PPBF platform, understand each workspace, and test current capabilities safely.
          </p>
          <div className="flex flex-wrap gap-3">
            <OperationsLink className="btn btn--ghost">
              Operations
            </OperationsLink>
            {adminDesk && (
              <Link href={adminDesk.href} className="btn btn--ghost">
                {adminDesk.label}
              </Link>
            )}
            <Link href="/" className="btn btn--ghost">
              Public Portal
            </Link>
          </div>
        </header>

        {cards.length > 0 && (
        <section className="mt-8 space-y-4" id="master-tutorial">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Master Tutorial Cards</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <TutorialCard key={card.id} card={card} />
            ))}
          </div>
        </section>
        )}

        <section className="mt-10 space-y-4" id="role-guides">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Role and Workspace Guides</h2>
          <div className="space-y-4">
            {guides.map((guide) => (
              <article key={guide.id} id={guide.id} className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_.28)] p-[var(--s5)]">
                <h3 className="text-xl font-black text-[color:var(--hide-950)]">{guide.title}</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">1. What this area is for:</span> {guide.whatThisAreaIsFor}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">2. Who should use it:</span> {guide.whoShouldUseIt}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">3. What is active now:</span> {guide.activeNow}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">4. What is placeholder/planned:</span> {guide.placeholderOrPlanned}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">5. What not to test yet:</span> {guide.doNotTestYet}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)]"><span className="font-bold text-[color:var(--hide-950)]">6. Useful feedback:</span> {guide.usefulFeedback}</p>
                  <p className="text-sm leading-6 text-[color:var(--hide-800)] md:col-span-2"><span className="font-bold text-[color:var(--hide-950)]">7. Where to go next:</span> {guide.whereToGoNext}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4" id="planned-capabilities-guide">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Planned Capability Guide</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {planned.map((capability) => (
              <article key={capability.id} className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_.28)] p-[var(--s5)]">
                <h3 className="text-lg font-black text-[color:var(--hide-950)]">{capability.title}</h3>
                <div className="mt-3 space-y-2 text-sm leading-6 text-[color:var(--hide-800)]">
                  <p><span className="font-bold text-[color:var(--hide-950)]">Current status:</span> {capability.currentStatus}</p>
                  <p><span className="font-bold text-[color:var(--hide-950)]">Where it appears:</span> {capability.whereItAppears}</p>
                  <p><span className="font-bold text-[color:var(--hide-950)]">What is planned:</span> {capability.whatIsPlanned}</p>
                  <p><span className="font-bold text-[color:var(--hide-950)]">What is not automated:</span> {capability.whatIsNotAutomated}</p>
                  <p><span className="font-bold text-[color:var(--hide-950)]">Backend dependency:</span> {capability.backendDependency}</p>
                  <p><span className="font-bold text-[color:var(--hide-950)]">Human review requirement:</span> {capability.humanReviewRequirement}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
