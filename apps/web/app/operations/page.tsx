import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { roleRoutes } from '@/components/roleRoutes';

const roleSelector = [
  { role: 'Athlete', href: '/athlete/dashboard', status: 'Ready' },
  { role: 'Coach', href: '/coach/review-queue', status: 'Ready' },
  { role: 'Parent', href: '/parent/dashboard', status: 'Ready' },
  { role: 'Board', href: '/board', status: 'Ready' },
  { role: 'Admin', href: '/admin', status: 'Ready' },
  { role: 'Public', href: '/public', status: 'Open' },
];

const priorityLanes = [
  {
    lane: 'GYM',
    count: 9,
    summary: 'Floor coverage, readiness signals, and session execution windows.',
  },
  {
    lane: 'BOARD',
    count: 5,
    summary: 'Governance actions, approvals, and oversight checkpoints.',
  },
  {
    lane: 'SYSTEM',
    count: 4,
    summary: 'Platform integrity, audit state, and release-path integrity checks.',
  },
];

const systemStatus = [
  { label: 'Safety Gates', value: 'Live', tone: 'text-[#d4a574]' },
  { label: 'Continuity Ledger', value: 'Logging', tone: 'text-[#d4a574]' },
  { label: 'Context Boundaries', value: 'Enforced', tone: 'text-[#d4a574]' },
  { label: 'SHADOW', value: 'Operational', tone: 'text-[#d4a574]' },
  { label: 'Validation Status', value: 'Stable', tone: 'text-[#d4a574]' },
];

const workspaces = [
  {
    label: 'Athlete Workspace',
    href: '/athlete/dashboard',
    openCount: 7,
    note: 'Readiness, goals, drills, and session log actions.',
  },
  {
    label: 'Coach Workspace',
    href: '/coach/review-queue',
    openCount: 6,
    note: 'Review queue, floor operations, and athlete management actions.',
  },
  {
    label: 'Parent Hub',
    href: '/parent/dashboard',
    openCount: 4,
    note: 'Family support tasks, attendance visibility, and check-ins.',
  },
  {
    label: 'Admin Hub',
    href: '/admin',
    openCount: 8,
    note: 'Capability controls, assignment matrix, and system posture.',
  },
  {
    label: 'Board Hub',
    href: '/board',
    openCount: 5,
    note: 'Oversight, policy trace, and governance routing.',
  },
];

const shadowOperationalAlerts = [
  '2 athlete readiness flags are below safe threshold.',
  '1 governance deadline enters risk window in 48 hours.',
  'Continuity Ledger capture rate remains at 100% for today.',
];

const developmentLab = [
  { label: 'Research Intake', href: '/research' },
  { label: 'Evidence Review', href: '/evidence' },
  { label: 'Knowledge Graph', href: '/knowledge-graph' },
  { label: 'Scenario Simulator', href: '/simulator' },
  { label: 'Audit Trace', href: '/audit' },
  { label: 'Source Control', href: '/source-control' },
];

const utilityLinks = [
  { label: 'The Bell', href: '/login' },
  { label: 'Entry Point', href: '/dashboard' },
  { label: 'The Office', href: '/admin/shadow' },
  { label: 'The Stands', href: '/guardian' },
];

export default function OperationsHubPage() {
  return (
    <RoleSessionGate allowedRoles={roleRoutes.map((route) => route.role)}>
      <main className="min-h-screen bg-[#0a0a0a] text-[#f2e7da]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
          <header className="space-y-5 border-b-2 border-[#8b4444] pb-8">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">Mission Control</p>
            <h1 className="font-display text-5xl font-black tracking-tight md:text-6xl">The Ring</h1>
            <p className="max-w-4xl text-base leading-7 text-[#e8d7c6] md:text-lg">
              Every corner has its own view. Athlete. Coach. Parent. Board. Admin. Public.
            </p>
          </header>

          <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
            <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">Role Selector</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roleSelector.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between bg-[#1c1c1c] px-4 py-4 transition hover:bg-[#2a1f1a]"
                >
                  <span className="text-lg font-semibold text-[#f2e7da]">{item.role}</span>
                  <span className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">{item.status}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">MY PRIORITIES TODAY</h2>
                <div className="grid gap-3 md:grid-cols-3">
                  {priorityLanes.map((lane) => (
                    <article key={lane.lane} className="bg-[#1c1c1c] px-4 py-4">
                      <p className="text-xs font-mono uppercase tracking-[0.18em] text-[#d4a574]">{lane.lane}</p>
                      <p className="mt-2 text-3xl font-black text-[#f2e7da]">{lane.count}</p>
                      <p className="mt-2 text-sm leading-6 text-[#cfbfae]">{lane.summary}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">WORKSPACES</h2>
                <div className="grid gap-3">
                  {workspaces.map((workspace) => (
                    <article key={workspace.href} className="grid gap-3 bg-[#1c1c1c] px-4 py-4 md:grid-cols-[1fr_auto_auto] md:items-center">
                      <div>
                        <h3 className="text-lg font-bold text-[#f2e7da]">{workspace.label}</h3>
                        <p className="mt-1 text-sm leading-6 text-[#cfbfae]">{workspace.note}</p>
                      </div>
                      <p className="text-sm font-mono uppercase tracking-[0.14em] text-[#d4a574]">{workspace.openCount} open</p>
                      <Link
                        href={workspace.href}
                        className="inline-flex items-center justify-center bg-[#5a2a2a] px-4 py-2 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[#f2e7da] transition hover:bg-[#7a3737]"
                      >
                        Open
                      </Link>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">DEVELOPMENT LAB</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {developmentLab.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="bg-[#1c1c1c] px-4 py-4 text-base font-semibold text-[#f2e7da] transition hover:bg-[#2a1f1a]"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">SYSTEM STATUS</h2>
                <div className="grid gap-2">
                  {systemStatus.map((item) => (
                    <div key={item.label} className="flex items-center justify-between bg-[#1c1c1c] px-4 py-3">
                      <span className="text-sm font-semibold text-[#f2e7da]">{item.label}</span>
                      <span className={`text-xs font-mono uppercase tracking-[0.15em] ${item.tone}`}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[#f2e7da]">SHADOW COMMAND NODE</h2>
                <p className="text-sm leading-6 text-[#cfbfae]">
                  Operational alert stream only. No chat layer. No narrative assistant mode.
                </p>
                <div className="grid gap-2">
                  {shadowOperationalAlerts.map((alert) => (
                    <div key={alert} className="bg-[#2a1a1a] px-4 py-3 text-sm leading-6 text-[#f2e7da]">
                      {alert}
                    </div>
                  ))}
                </div>
                <Link
                  href="/admin/shadow"
                  className="inline-flex items-center justify-center bg-[#5a2a2a] px-4 py-2 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[#f2e7da] transition hover:bg-[#7a3737]"
                >
                  Open SHADOW Ops
                </Link>
              </section>

              <section className="space-y-3 rounded-sm bg-[#131313] px-6 py-6">
                <h2 className="font-display text-xl font-bold tracking-tight text-[#f2e7da]">Utility Routes</h2>
                <div className="grid gap-2">
                  {utilityLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="bg-[#1c1c1c] px-4 py-3 text-sm font-semibold text-[#f2e7da] transition hover:bg-[#2a1f1a]"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </section>
            </aside>
          </section>
        </div>
      </main>
    </RoleSessionGate>
  );
}