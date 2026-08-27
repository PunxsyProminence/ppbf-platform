import Link from 'next/link';
import TutorialCard from '@/components/TutorialCard';
import { guideSections, masterTutorialCards, plannedCapabilityGuides } from '@/components/helpContent';
import OperationsLink from '@/components/OperationsLink';

export default function HelpCenterPage() {
  return (
    <main className="on-canvas min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="space-y-4 border-b-[3px] border-[color:rgb(var(--brass-800-rgb)_/_.28)] pb-6">
          <p className="t-eyebrow tracking-[0.35em]">Help Center</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>PPBF MASTER TUTORIAL</h1>
          <p className="max-w-4xl text-base leading-7 text-[color:var(--hide-800)] md:text-lg">
            Learn how to navigate the PPBF platform, understand each workspace, and test current capabilities safely.
          </p>
          <div className="flex flex-wrap gap-3">
            <OperationsLink className="btn btn--ghost">
              Mission Control
            </OperationsLink>
            <Link href="/admin" className="btn btn--ghost">
              Admin Hub
            </Link>
            <Link href="/public" className="btn btn--ghost">
              Public Portal
            </Link>
          </div>
        </header>

        <section className="mt-8 space-y-4" id="master-tutorial">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Master Tutorial Cards</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {masterTutorialCards.map((card) => (
              <TutorialCard key={card.id} card={card} />
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4" id="role-guides">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Role and Workspace Guides</h2>
          <div className="space-y-4">
            {guideSections.map((guide) => (
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
            {plannedCapabilityGuides.map((capability) => (
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
