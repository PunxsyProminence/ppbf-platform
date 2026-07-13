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
    lane: 'PROGRAM',
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
  { label: 'Safety Gates', value: 'Live', tone: 'text-[var(--status-ready)]' },
  { label: 'Continuity Ledger', value: 'Logging', tone: 'text-[var(--status-ready)]' },
  { label: 'Context Boundaries', value: 'Enforced', tone: 'text-[var(--status-ready)]' },
  { label: 'SHADOW', value: 'Operational', tone: 'text-[var(--status-warning)]' },
  { label: 'Validation Status', value: 'Stable', tone: 'text-[var(--status-ready)]' },
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
  { label: 'Revenue Center', href: '/admin?tab=revenue' },
  { label: 'The Office', href: '/admin/shadow' },
  { label: 'The Stands', href: '/guardian' },
];

type CapabilityState = 'EXISTS' | 'PARTIAL' | 'PLACEHOLDER' | 'MISSING';

const capabilityRadar: Array<{ name: string; state: CapabilityState; href?: string; notes: string }> = [
  { name: 'Athlete Readiness', state: 'EXISTS', href: '/athlete/dashboard', notes: 'Readiness check-ins, session logs, and goals are active.' },
  { name: 'Coach Intelligence', state: 'EXISTS', href: '/coach/review-queue', notes: 'Coach workspace, review queue, and floor controls are available.' },
  { name: 'Research Intelligence', state: 'EXISTS', href: '/research', notes: 'Research intake and Q&A workflow are available.' },
  { name: 'Knowledge Graph', state: 'EXISTS', href: '/knowledge-graph', notes: 'Knowledge and relationship view is available.' },
  { name: 'Scenario Simulation', state: 'EXISTS', href: '/simulator', notes: 'What-if simulator and promotion flow links are available.' },
  { name: 'Source Governance', state: 'EXISTS', href: '/source-control', notes: 'Audit-to-source-control publication flow is visible.' },
  { name: 'Funding Intelligence', state: 'PARTIAL', href: '/admin?tab=revenue', notes: 'Revenue center exists as front-end workflow without backend integration.' },
  { name: 'Scholarship Tracking', state: 'PARTIAL', href: '/admin?tab=revenue', notes: 'Scholarship support status is visible in front-end lanes.' },
  { name: 'Membership Tracking', state: 'PARTIAL', href: '/admin?tab=revenue', notes: 'Program membership lanes are present in planning mode.' },
  { name: 'SHADOW Monitoring', state: 'PARTIAL', href: '/shadow', notes: 'SHADOW interaction exists with front-end role surfaces.' },
  { name: 'AI Video Analysis', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Video Review Intelligence', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Performance Analytics', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Grant Compliance Intelligence', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Sports Medicine', state: 'PLACEHOLDER', href: '/coach/sports-medicine', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'Volunteer Management', state: 'PLACEHOLDER', href: '/admin/volunteer-management', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'Wrestling League Management', state: 'PLACEHOLDER', href: '/operations/wrestling-league', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'External Competition Platform', state: 'PLACEHOLDER', href: '/operations/external-competition', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'Publication Workflow Automation', state: 'MISSING', notes: 'No automation workflow yet. Current flow is manual and front-end staged.' },
];

function capabilityTone(state: CapabilityState): string {
  if (state === 'EXISTS') return 'border-[var(--status-ready)] bg-[#dce7ca] text-[var(--black)]';
  if (state === 'PARTIAL') return 'border-[var(--status-warning)] bg-[#efe3c4] text-[var(--black)]';
  if (state === 'PLACEHOLDER') return 'border-[var(--red-primary)] bg-[#f1d6d1] text-[var(--black)]';
  return 'border-[var(--gray-medium)] bg-[var(--canvas-tan)] text-[var(--black)]';
}

export default function OperationsHubPage() {
  return (
    <RoleSessionGate allowedRoles={roleRoutes.map((route) => route.role)}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
          <header className="space-y-5 border-b-[3px] border-[var(--black)] pb-8">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Mission Control</p>
            <h1 className="font-display text-5xl font-black tracking-tight md:text-6xl">The Ring</h1>
            <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Every corner has its own view. Athlete. Coach. Parent. Board. Admin. Public.
            </p>
          </header>

          <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
            <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">Role Selector</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roleSelector.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-4 transition hover:bg-[var(--canvas-tan-dark)]"
                >
                  <span className="text-lg font-semibold text-[var(--black)]">{item.role}</span>
                  <span className="text-xs font-mono uppercase tracking-[0.15em] text-[var(--red-primary)]">{item.status}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">MY PRIORITIES TODAY</h2>
                <div className="grid gap-3 md:grid-cols-3">
                  {priorityLanes.map((lane) => (
                    <article key={lane.lane} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-4">
                      <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">{lane.lane}</p>
                      <p className="mt-2 text-3xl font-black text-[var(--black)]">{lane.count}</p>
                      <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{lane.summary}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">WORKSPACES</h2>
                <div className="grid gap-3">
                  {workspaces.map((workspace) => (
                    <article key={workspace.href} className="grid gap-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-4 md:grid-cols-[1fr_auto_auto] md:items-center">
                      <div>
                        <h3 className="text-lg font-bold text-[var(--black)]">{workspace.label}</h3>
                        <p className="mt-1 text-sm leading-6 text-[var(--gray-dark)]">{workspace.note}</p>
                      </div>
                      <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">{workspace.openCount} open</p>
                      <Link
                        href={workspace.href}
                        className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 py-2 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
                      >
                        Open
                      </Link>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">DEVELOPMENT LAB</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {developmentLab.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-4 text-base font-semibold text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </section>

              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">Capability Visibility Map</h2>
                <p className="text-sm leading-6 text-[var(--gray-dark)]">
                  Reality-based map of major PPBF capabilities. Placeholders are roadmap visibility only and are not implemented.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {capabilityRadar.map((item) => (
                    <article key={item.name} className={`border-2 p-4 ${capabilityTone(item.state)}`}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-[15px] font-bold uppercase tracking-[0.05em]">{item.name}</h3>
                        <span className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-2 py-0.5 text-[10px] font-mono font-bold uppercase">
                          {item.state}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6">{item.notes}</p>
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="mt-3 inline-flex min-h-[38px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                        >
                          Open Capability
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="mt-3 inline-flex min-h-[38px] cursor-not-allowed items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)] opacity-80"
                        >
                          Planned Capability
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--black)]">SYSTEM STATUS</h2>
                <div className="grid gap-2">
                  {systemStatus.map((item) => (
                    <div key={item.label} className="flex items-center justify-between border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3">
                      <span className="text-sm font-semibold text-[var(--black)]">{item.label}</span>
                      <span className={`text-xs font-mono uppercase tracking-[0.15em] ${item.tone}`}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--red-primary)] px-6 py-6 text-[var(--white)] shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--white)]">SHADOW COMMAND NODE</h2>
                <p className="text-sm leading-6 text-[var(--white-off)]">
                  Operational alert stream only. No chat layer. No narrative assistant mode.
                </p>
                <div className="grid gap-2">
                  {shadowOperationalAlerts.map((alert) => (
                    <div key={alert} className="border-2 border-[var(--black)] bg-[var(--red-blood)] px-4 py-3 text-sm leading-6 text-[var(--white)]">
                      {alert}
                    </div>
                  ))}
                </div>
                <Link
                  href="/admin/shadow"
                  className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-2 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                >
                  Open SHADOW Ops
                </Link>
              </section>

              <section className="space-y-3 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-6 shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-xl font-bold tracking-tight text-[var(--black)]">Platform Shortcuts</h2>
                <div className="grid gap-2">
                  {utilityLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-sm font-semibold text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
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