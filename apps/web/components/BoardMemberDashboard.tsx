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
      <main className="min-h-screen bg-linear-gradient(180deg,#0a0a0a 0%,#0f0f0f 100%) text-[#e5e5e5]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-[#8b0000] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#c85a17]/80">Board Member Dashboard</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-sm leading-6 text-[#c0c0c0] md:text-base">{focus}</p>
          </div>
          <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 px-4 py-3 text-xs font-mono text-[#c85a17]">
            {seatLabel}
          </div>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="border-4 border-[#8b0000] bg-[#1a1a1a]/70 p-6">
            <h2 className="text-lg font-semibold text-[#e5e5e5]">Board summary</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {metrics.map((metric) => (
                <div key={metric.label} className="border-2 border-[#8b0000] bg-[#0f0f0f]/70 p-4">
                  <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#a0a0a0]">{metric.label}</p>
                  <p className="mt-2 text-xl font-black text-[#e5e5e5]">{metric.value}</p>
                </div>
              ))}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="border-4 border-[#8b0000] bg-[#1a1a1a]/70 p-6">
              <h2 className="text-lg font-semibold text-[#e5e5e5]">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="border-2 border-[#8b0000] bg-[#0f0f0f]/60 px-4 py-3 text-sm text-[#c0c0c0] transition hover:border-[#c85a17]/30 hover:bg-[#3a0000]/10 hover:text-[#c85a17]"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="border-2 border-[#8b0000]/20 bg-[#3a0000]/10 p-6 text-sm text-[#c0c0c0]">
              <h2 className="text-lg font-semibold text-[#c0c0c0]">Member note</h2>
              <p className="mt-3 leading-6 text-[#c0c0c0]/90">
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