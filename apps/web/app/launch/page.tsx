import Link from 'next/link';

const launchMilestones = [
  'Safety gate checks are live and blocking unsafe actions.',
  'Continuity Ledger logging is available for review and audit surfaces.',
  'Bounded context boundaries remain in force across roles.',
  'Production deploy still requires Jason approval and platform validation.',
];

const launchLinks = [
  { label: 'Master console', href: '/' },
  { label: 'Athlete dashboard', href: '/athlete/dashboard' },
  { label: 'Coach review queue', href: '/coach/review-queue' },
  { label: 'Admin capabilities', href: '/admin' },
];

export default function LaunchPortalPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.18),_transparent_42%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-emerald-500/20 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">Launch Portal</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">Production readiness surface</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300 md:text-base">
              This portal acts as the public launch lane for PPBF. It summarizes the main governance checks,
              points to the working portals, and keeps the go-live gate visible.
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-slate-950/60 px-4 py-3 text-xs font-mono text-emerald-200 shadow-lg shadow-emerald-950/20">
            Status: ready for review, pending deployment approval
          </div>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <h2 className="text-lg font-semibold text-slate-100">Launch readiness checkpoints</h2>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-mono text-emerald-300">
                Governed surface
              </span>
            </div>

            <ul className="mt-5 space-y-3">
              {launchMilestones.map((item) => (
                <li key={item} className="flex gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
                  <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {launchLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-200 transition hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-200"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-amber-500/20 bg-amber-500/10 p-6 text-sm text-amber-100">
              <h2 className="text-lg font-semibold text-amber-50">Go-live note</h2>
              <p className="mt-3 leading-6 text-amber-50/90">
                The launch portal is now restored. If the public site still returns a 404, the remaining issue is deployment
                wiring rather than the route surface itself.
              </p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}