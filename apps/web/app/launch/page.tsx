import Link from 'next/link';

const launchMilestones = [
  'Safety gate checks are live and blocking unsafe actions.',
  'Continuity Ledger logging is available for review and audit surfaces.',
  'Bounded context boundaries remain in force across roles.',
  'Production deploy still requires Jason approval and platform validation.',
];

const launchLinks = [
  { label: 'Member login', href: '/login' },
  { label: 'Dashboard entry', href: '/dashboard' },
  { label: 'Operations Hub', href: '/operations' },
  { label: 'Athlete dashboard', href: '/athlete/dashboard' },
  { label: 'Coach review queue', href: '/coach/review-queue' },
  { label: 'Board hub', href: '/board' },
  { label: 'Admin capabilities', href: '/admin' },
  { label: 'Public portal', href: '/public' },
  { label: 'Guardian portal', href: '/guardian' },
  { label: 'Research intake', href: '/research' },
  { label: 'Evidence review', href: '/evidence' },
  { label: 'Audit trace', href: '/audit' },
  { label: 'Scenario simulator', href: '/simulator' },
  { label: 'Knowledge graph', href: '/knowledge-graph' },
  { label: 'Source control', href: '/source-control' },
];

export default function LaunchPortalPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#b35806] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#c85a17]">Jump In Portal</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">Ready to Go</h1>
            <p className="max-w-2xl text-sm leading-6 text-[#a0a0a0] md:text-base">
              This is where it starts. Main governance checks, all the working surfaces, and everything you need to step in the ring.
            </p>
          </div>
          <div className="border-2 border-[#b35806] bg-[#1a1a1a] px-4 py-3 text-xs font-mono text-[#c85a17]">
            Status: LIVE
          </div>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
          <div className="border-4 border-[#8b0000] bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
            <div className="flex items-center justify-between gap-4 border-b-4 border-[#8b0000] pb-4">
              <h2 className="text-lg font-semibold text-[#e5e5e5]">The Checks</h2>
              <span className="border-2 border-[#dc2626] bg-[#2a1a1a] px-3 py-1 text-[11px] font-mono text-[#dc2626]">
                In Effect
              </span>
            </div>

            <ul className="mt-5 space-y-3">
              {launchMilestones.map((item) => (
                <li key={item} className="flex gap-3 border-2 border-[#8b0000] bg-[#1a1a1a] p-4 text-sm text-[#c0c0c0]">
                  <span className="mt-0.5 h-2.5 w-2.5 shrink-0 bg-[#dc2626]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-6">
            <section className="border-4 border-[#8b0000] bg-[#0f0f0f] p-6">
              <h2 className="text-lg font-semibold text-[#e5e5e5]">Quick Access</h2>
              <div className="mt-4 grid gap-3">
                {launchLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="border-2 border-[#8b0000] bg-[#1a1a1a] px-4 py-3 text-sm text-[#c0c0c0] transition hover:border-[#dc2626] hover:bg-[#2a1a1a] hover:text-[#e5e5e5]"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="border-4 border-[#b35806] bg-[#0f0a08] p-6 text-sm text-[#e5e5e5]">
              <h2 className="text-lg font-semibold text-[#c85a17]">Word</h2>
              <p className="mt-3 leading-6 text-[#a0a0a0]">
                The Launch Portal is live. Use this to monitor the platform and hand things off.
              </p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}