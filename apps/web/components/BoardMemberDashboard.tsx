import Link from 'next/link';
import RoleSessionGate from './RoleSessionGate';
import type { ClubRole } from './roleRoutes';

interface BoardMemberDashboardProps {
  title: string;
  seatLabel: string;
  focus: string;
  metrics: ReadonlyArray<{ label: string; value: string }>;
  links: ReadonlyArray<{ label: string; href: string }>;
  allowedRoles: ClubRole[];
}

export default function BoardMemberDashboard({ title, seatLabel, focus, metrics, links, allowedRoles }: BoardMemberDashboardProps) {
  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.12),_transparent_30%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">Board Member Dashboard</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-300 md:text-base">{focus}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-slate-950/60 px-4 py-3 text-xs font-mono text-emerald-200 shadow-lg shadow-emerald-950/20">
            {seatLabel}
          </div>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <h2 className="text-lg font-semibold text-slate-100">Board summary</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {metrics.map((metric) => (
                <div key={metric.label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-slate-500">{metric.label}</p>
                  <p className="mt-2 text-xl font-black text-slate-100">{metric.value}</p>
                </div>
              ))}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-200 transition hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-200"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-6 text-sm text-cyan-50">
              <h2 className="text-lg font-semibold text-cyan-50">Member note</h2>
              <p className="mt-3 leading-6 text-cyan-50/90">
                Each board member should use a single focused dashboard with only the information they need for governance.
              </p>
            </section>
          </aside>
        </section>
      </div>
      </main>
    </RoleSessionGate>
  );
}