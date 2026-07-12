import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { roleRoutes } from '@/components/roleRoutes';

const primaryDashboards = [
  { label: 'Athlete dashboard', href: '/athlete/dashboard', description: 'Your corner. Readiness, training log, sparring setup.' },
  { label: 'Coach dashboard', href: '/coach/review-queue', description: 'Review your fighters, daily intake, game plans.' },
  { label: 'Board hub', href: '/board', description: 'Governance and oversight—all board seats.' },
  { label: 'Admin dashboard', href: '/admin', description: 'Train smart. Manage the gym.' },
];

const supportSurfaces = [
  { label: 'The Bell', href: '/login' },
  { label: 'Entry Point', href: '/dashboard' },
  { label: 'Jump In', href: '/launch' },
  { label: 'The Office', href: '/admin/shadow', highlight: true },
  { label: 'The Bleachers', href: '/public' },
  { label: 'The Stands', href: '/guardian' },
  { label: 'The Library', href: '/research' },
  { label: 'Evidence Box', href: '/evidence' },
  { label: 'The Book', href: '/audit' },
  { label: 'Shadow Box', href: '/simulator' },
  { label: 'The Encyclopedia', href: '/knowledge-graph' },
  { label: 'The Archive', href: '/source-control' },
];

export default function OperationsHubPage() {
  return (
    <RoleSessionGate allowedRoles={roleRoutes.map((route) => route.role)}>
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.14),_transparent_28%),linear-gradient(180deg,#020617_0%,#0b1120_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">The Office</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">The Ring: Your Dashboard</h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
              Every corner has its own view. Athlete. Coach. Board. Admin. Public.
            </p>
          </div>
          <Link
            href="/launch"
            className="inline-flex items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-mono font-bold text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-200"
          >
            Jump In
          </Link>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <h2 className="text-lg font-semibold text-slate-100">The Boards</h2>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-mono text-emerald-300">
                Open to All
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
                      <p className="text-xs font-mono uppercase tracking-[0.2em] text-slate-500 group-hover:text-emerald-300">Your Corner</p>
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
              <h2 className="text-lg font-semibold text-slate-100">Quick Counters</h2>
              <div className="mt-4 grid gap-3">
                {supportSurfaces.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-2xl border px-4 py-3 text-sm transition ${
                      item.highlight
                        ? 'border-red-500/40 bg-red-500/10 text-red-200 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-100'
                        : 'border-slate-800 bg-slate-900/60 text-slate-200 hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-200'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-6 text-sm text-cyan-50">
              <h2 className="text-lg font-semibold text-cyan-50">Psst</h2>
              <p className="mt-3 leading-6 text-cyan-50/90">
                Only members can see the full schedule. You gotta sign in first.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
    </RoleSessionGate>
  );
}