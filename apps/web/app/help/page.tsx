import Link from 'next/link';
import TutorialCard from '@/components/TutorialCard';
import { guideSections, masterTutorialCards, plannedCapabilityGuides } from '@/components/helpContent';

export default function HelpCenterPage() {
  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="space-y-4 border-b-[3px] border-[var(--black)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Help Center</p>
          <h1 className="font-display text-4xl font-black tracking-tight md:text-5xl">PPBF MASTER TUTORIAL</h1>
          <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">
            Learn how to navigate the PPBF platform, understand each workspace, and test current capabilities safely.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/operations" className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.1em]">
              Mission Control
            </Link>
            <Link href="/admin" className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.1em]">
              Admin Hub
            </Link>
            <Link href="/public" className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.1em]">
              Public Portal
            </Link>
          </div>
        </header>

        <section className="mt-8 space-y-4" id="master-tutorial">
          <h2 className="font-display text-2xl font-black">Master Tutorial Cards</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {masterTutorialCards.map((card) => (
              <TutorialCard key={card.id} card={card} />
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4" id="role-guides">
          <h2 className="font-display text-2xl font-black">Role and Workspace Guides</h2>
          <div className="space-y-4">
            {guideSections.map((guide) => (
              <article key={guide.id} id={guide.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h3 className="text-xl font-black text-[var(--black)]">{guide.title}</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">1. What this area is for:</span> {guide.whatThisAreaIsFor}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">2. Who should use it:</span> {guide.whoShouldUseIt}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">3. What is active now:</span> {guide.activeNow}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">4. What is placeholder/planned:</span> {guide.placeholderOrPlanned}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">5. What not to test yet:</span> {guide.doNotTestYet}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)]"><span className="font-bold text-[var(--black)]">6. Useful feedback:</span> {guide.usefulFeedback}</p>
                  <p className="text-sm leading-6 text-[var(--gray-dark)] md:col-span-2"><span className="font-bold text-[var(--black)]">7. Where to go next:</span> {guide.whereToGoNext}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4" id="planned-capabilities-guide">
          <h2 className="font-display text-2xl font-black">Planned Capability Guide</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {plannedCapabilityGuides.map((capability) => (
              <article key={capability.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h3 className="text-lg font-black text-[var(--black)]">{capability.title}</h3>
                <div className="mt-3 space-y-2 text-sm leading-6 text-[var(--gray-dark)]">
                  <p><span className="font-bold text-[var(--black)]">Current status:</span> {capability.currentStatus}</p>
                  <p><span className="font-bold text-[var(--black)]">Where it appears:</span> {capability.whereItAppears}</p>
                  <p><span className="font-bold text-[var(--black)]">What is planned:</span> {capability.whatIsPlanned}</p>
                  <p><span className="font-bold text-[var(--black)]">What is not automated:</span> {capability.whatIsNotAutomated}</p>
                  <p><span className="font-bold text-[var(--black)]">Backend dependency:</span> {capability.backendDependency}</p>
                  <p><span className="font-bold text-[var(--black)]">Human review requirement:</span> {capability.humanReviewRequirement}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
