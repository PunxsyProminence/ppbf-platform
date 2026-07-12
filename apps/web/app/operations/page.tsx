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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#8b0000] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#c85a17]">The Office</p>
            <h1 className="font-display text-4xl font-black tracking-tight md:text-5xl">The Ring</h1>
            <p className="max-w-3xl text-sm leading-6 text-[#c0c0c0] md:text-base">
              Every corner has its own view. Athlete. Coach. Board. Admin. Public.
            </p>
          </div>
          <Link
            href="/launch"
            className="inline-flex items-center justify-center border-2 border-[#8b0000] bg-[#1a1a1a] px-4 py-2 text-xs font-mono font-bold text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#2a2a2a] hover:text-[#ff6b6b]"
          >
            Jump In
          </Link>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="border-4 border-[#8b0000] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/60">
            <div className="flex items-center justify-between gap-4 border-b-4 border-[#8b0000] pb-4">
              <h2 className="font-display text-lg font-semibold text-[#e5e5e5]">The Boards</h2>
              <span className="border-2 border-[#dc2626] bg-[#2a2a2a] px-3 py-1 text-[11px] font-mono text-[#dc2626]">
                Open to All
              </span>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {primaryDashboards.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group border-2 border-[#8b0000] bg-[#0f0f0f] p-5 transition hover:border-[#dc2626] hover:bg-[#1f1f1f]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#b35806] group-hover:text-[#dc2626]">Your Corner</p>
                      <h3 className="font-display mt-2 text-xl font-black text-[#e5e5e5]">{item.label}</h3>
                      <p className="mt-2 text-sm leading-6 text-[#a0a0a0] group-hover:text-[#c0c0c0]">{item.description}</p>
                    </div>
                    <span className="border-2 border-[#8b0000] bg-[#0a0a0a] px-3 py-1 text-[11px] font-mono text-[#b0b0b0]">
                      Open
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="border-4 border-[#8b0000] bg-[#1a1a1a] p-6">
              <h2 className="font-display text-lg font-semibold text-[#e5e5e5]">Quick Counters</h2>
              <div className="mt-4 grid gap-3">
                {supportSurfaces.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`border-2 px-4 py-3 text-sm transition ${
                      item.highlight
                        ? 'border-[#dc2626] bg-[#2a1a1a] text-[#ff6b6b] hover:border-[#ff6b6b] hover:bg-[#3a2a2a] hover:text-[#ffaaaa]'
                        : 'border-[#8b0000] bg-[#0f0f0f] text-[#c0c0c0] hover:border-[#dc2626] hover:bg-[#1a1a1a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="border-4 border-[#b35806] bg-[#1f1f1f] p-6 text-sm text-[#e5e5e5]">
              <h2 className="font-display text-lg font-semibold text-[#c85a17]">Psst</h2>
              <p className="mt-3 leading-6 text-[#a0a0a0]">
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