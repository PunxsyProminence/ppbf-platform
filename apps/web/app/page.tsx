import Link from 'next/link';
const primaryDashboards = [
  { label: 'Athlete dashboard', href: '/athlete/dashboard', description: 'Personal training, readiness, and sparring surfaces.' },
  { label: 'Coach dashboard', href: '/coach/review-queue', description: 'Review queue and intake workflow for daily coaching.' },
  { label: 'Board hub', href: '/board', description: 'One dashboard per board seat for governance and oversight.' },
  { label: 'Admin dashboard', href: '/admin', description: 'Capability control and platform governance.' },
];

const supportSurfaces = [
  { label: 'Launch portal', href: '/launch' },
  { label: 'Public portal', href: '/public' },
  { label: 'Guardian portal', href: '/guardian' },
  { label: 'Research intake', href: '/research' },
  { label: 'Evidence review', href: '/evidence' },
  { label: 'Audit trace', href: '/audit' },
  { label: 'Scenario simulator', href: '/simulator' },
  { label: 'Knowledge graph', href: '/knowledge-graph' },
  { label: 'Source control', href: '/source-control' },
];

export default function PPBFMasterOperationHub() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.14),_transparent_28%),linear-gradient(180deg,#020617_0%,#0b1120_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">Main Operation Hub</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">PPBF platform dashboards</h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
              One clean dashboard per user group: athlete, coach, board member, admin, plus supporting public and governance surfaces.
            </p>
          </div>
          <Link
            href="/launch"
            className="inline-flex items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-mono font-bold text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-200"
          >
            Open Launch Portal
          </Link>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <h2 className="text-lg font-semibold text-slate-100">Primary dashboards</h2>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-mono text-emerald-300">
                User friendly
              </span>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {primaryDashboards.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group rounded-3xl border border-slate-800 bg-slate-900/60 p-5 transition hover:border-emerald-500/30 hover:bg-emerald-500/10"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-mono uppercase tracking-[0.2em] text-slate-500 group-hover:text-emerald-300">Dashboard</p>
                      <h3 className="mt-2 text-xl font-black text-slate-100">{item.label}</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-400 group-hover:text-slate-300">{item.description}</p>
                    </div>
                    <span className="rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1 text-[11px] font-mono text-slate-300">
                      Open
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Support surfaces</h2>
              <div className="mt-4 grid gap-3">
                {supportSurfaces.map((item) => (
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

            <section className="rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-6 text-sm text-cyan-50">
              <h2 className="text-lg font-semibold text-cyan-50">Hub note</h2>
              <p className="mt-3 leading-6 text-cyan-50/90">
                The home page is now the main operation hub. Board members should use the board hub for their own seat-specific dashboard.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
