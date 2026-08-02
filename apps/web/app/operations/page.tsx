import Link from 'next/link';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';

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
  { label: 'Safety Gates', value: 'Live', tone: 'text-[var(--cleared-deep)]' },
  { label: 'Continuity Ledger', value: 'Logging', tone: 'text-[var(--cleared-deep)]' },
  { label: 'Context Boundaries', value: 'Enforced', tone: 'text-[var(--cleared-deep)]' },
  { label: 'SHADOW', value: 'Operational', tone: 'text-[var(--restricted-deep)]' },
  { label: 'Validation Status', value: 'Stable', tone: 'text-[var(--cleared-deep)]' },
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

const developmentLab = [
  { label: 'Research Intake', href: '/research' },
  { label: 'Evidence Review', href: '/evidence' },
  { label: 'Knowledge Graph', href: '/knowledge-graph' },
  { label: 'Scenario Simulator', href: '/simulator' },
  { label: 'Audit Trace', href: '/audit' },
  { label: 'Source Control', href: '/source-control' },
  { label: 'AI/ML Video Analysis', href: '/coach/video-analysis' },
  { label: 'Compliance Monitoring', href: '/board/compliance-monitoring' },
  { label: 'Progression Intelligence', href: '/athlete/progression-intelligence' },
  { label: 'Publication Workflow', href: '/source-control/publication-workflow' },
];

const utilityLinks = [
  { label: 'The Bell', href: '/login' },
  { label: 'Notices & Motivation', href: '/notices' },
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
  { name: 'AI Video Analysis', state: 'PLACEHOLDER', href: '/coach/video-analysis', notes: 'Planned surface with mock-only video analysis cards. FRONT-END PLACEHOLDER, NOT YET AUTOMATED, BACKEND REQUIRED.' },
  { name: 'Video Review Intelligence', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Performance Analytics', state: 'PLACEHOLDER', notes: 'Planned capability placeholder only. Not yet implemented.' },
  { name: 'Grant Compliance Intelligence', state: 'PLACEHOLDER', href: '/board/compliance-monitoring', notes: 'Planned board/admin compliance watch surfaces. FRONT-END PLACEHOLDER, NOT YET AUTOMATED, BACKEND REQUIRED.' },
  { name: 'Closed-Loop Progression Intelligence', state: 'PLACEHOLDER', href: '/athlete/progression-intelligence', notes: 'Planned progression intelligence surfaces for athlete/coach/parent visibility.' },
  { name: 'Sports Medicine', state: 'PLACEHOLDER', href: '/coach/sports-medicine', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'Volunteer Management', state: 'EXISTS', href: '/admin/volunteer-management', notes: 'Volunteer roster, status, and availability are backed by persistent records.' },
  { name: 'Wrestling League Management', state: 'PLACEHOLDER', href: '/operations/wrestling-league', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'External Competition Platform', state: 'PLACEHOLDER', href: '/operations/external-competition', notes: 'Front-end scaffold only. Planned capability and not yet implemented.' },
  { name: 'Publication Workflow Automation', state: 'PLACEHOLDER', href: '/source-control/publication-workflow', notes: 'Planned publication workflow surface is now visible as front-end placeholder. Not yet automated.' },
];

const shadowReadinessEquation = 'Readiness = max(1, min(10, (Sleep x 1.25) - (Soreness x 0.45) + (Discipline x 0.3)))';
const shadowRpeEquation = 'Delta RPE = RPE Observed - RPE Intended';

const shadowCertificationSignals = [
  'System Core Tracking Context: ONLINE',
  'Enforcement Context: Production Build v21.1 - SHADOW Pre-Flight Calibration',
  'Aesthetic Preset: ULTRA-DENSE WINTER GRIT',
];

const shadowBoundaryChecks = [
  'Readiness upper bound test resolves to 10.0 and remains stable at clamp.',
  'Readiness lower bound test resolves to 1.0 and remains stable at clamp.',
  'Any readiness score below 5.0 triggers protective route and drill constraints.',
  'Delta RPE lockout engages when discrepancy is 2 or greater until rationale is provided.',
  'Override token BREAK MY 40% RULE emits GRIND STATE ENGAGED in JSON audit logs.',
];

const shadowArchitectureNodes = [
  {
    name: 'Background Telemetry Scout',
    details: [
      'Silent state scraping and metric watch.',
      'Delta RPE sieve and intercept checks.',
      'Zulu-timestamped JSON transaction output for pending control pipeline.',
    ],
  },
  {
    name: 'Blunt Analytical Hub',
    details: [
      'Direct, fact-based guidance responses.',
      'Refusal matrix for diagnosis and treatment requests.',
      'Role isolation block for restricted governance and finance content.',
    ],
  },
];

const shadowComplianceChecks = [
  '12-role viewport segregation prevents cross-role data leakage.',
  'Athlete view cannot mount finance/admin controls.',
  'Board and governance view cannot parse raw individual biometric streams.',
  'Build-state badges stay visible for QA handoff and release triage.',
  'Immutability default verified_by_jason: false remains locked pending coach verification.',
];

function capabilityTone(state: CapabilityState): string {
  if (state === 'EXISTS') return 'border-[var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_14%,var(--paper))] text-[var(--black)]';
  if (state === 'PARTIAL') return 'border-[var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_14%,var(--paper))] text-[var(--black)]';
  if (state === 'PLACEHOLDER') return 'border-[var(--accent-quiet)] bg-[color-mix(in_srgb,var(--accent)_14%,var(--paper))] text-[var(--black)]';
  return 'border-[var(--gray-medium)] bg-[var(--canvas-tan)] text-[var(--black)]';
}

// Navigation only, with no athlete-scoped data on the page, so the platform
// owner belongs here alongside every gym role.
const operationsRoles: ClubRole[] = [...roleRoutes.map((route) => route.role), 'platform_owner'];

export default function OperationsHubPage() {
  return (
    <RoleSessionGate allowedRoles={operationsRoles}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
          <header className="space-y-5 border-b-[3px] border-[var(--black)] pb-8">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--accent-quiet)]">Mission Control</p>
            <h1 className="font-display text-5xl font-black tracking-tight md:text-6xl">The Ring</h1>
            <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Every corner has its own view. Athlete. Coach. Parent. Board. Admin. Public.
            </p>
            <ShadowChatButton context="Mission Control" />
          </header>

          <AnnouncementBanner
            placement="everywhere"
            heading="Gym-wide notice"
            className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-5 shadow-[var(--shadow-sm)]"
          />

          <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-5 shadow-[var(--shadow-sm)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
                Need orientation? Open the full tutorial center from one button instead of rendering all tutorial content inline.
              </p>
              <ShadowChatButton context="Mission Control Start Here" />
            </div>
          </section>

          <details className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-4 shadow-[var(--shadow-sm)]">
            <summary className="cursor-pointer list-none text-lg font-bold uppercase tracking-[0.08em] text-[var(--black)]">
              System Diagnostics and SHADOW Certification
            </summary>
            <div className="mt-4 space-y-5">
            <div className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
              <p className="text-xs font-mono uppercase tracking-[0.15em] text-[var(--accent-quiet)]">System Operational Audit and Validation Report</p>
              <p className="text-sm leading-6 text-[var(--gray-dark)]">
                SHADOW v21.1 seed is ingested, stress-validated, and sealed for development deployment. This build section mirrors the certified guardrails used for floor safety, role isolation, and audit integrity.
              </p>
              <div className="grid gap-2 md:grid-cols-3">
                {shadowCertificationSignals.map((signal) => (
                  <div key={signal} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--black)]">
                    {signal}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <article className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <h3 className="font-display text-xl font-bold text-[var(--black)]">Mathematical Gate Validation</h3>
                <p className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-xs font-mono text-[var(--black)]">{shadowReadinessEquation}</p>
                <p className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-xs font-mono text-[var(--black)]">{shadowRpeEquation}</p>
                <div className="grid gap-2">
                  {shadowBoundaryChecks.map((item) => (
                    <p key={item} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm leading-6 text-[var(--gray-dark)]">
                      {item}
                    </p>
                  ))}
                </div>
              </article>

              <article className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <h3 className="font-display text-xl font-bold text-[var(--black)]">Privacy and Compliance Boundaries</h3>
                <div className="grid gap-2">
                  {shadowComplianceChecks.map((item) => (
                    <p key={item} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm leading-6 text-[var(--gray-dark)]">
                      {item}
                    </p>
                  ))}
                </div>
              </article>
            </div>

            <article className="space-y-4 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
              <h3 className="font-display text-xl font-bold text-[var(--black)]">SHADOW Dual-Engine Architecture</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {shadowArchitectureNodes.map((node) => (
                  <div key={node.name} className="space-y-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                    <p className="text-sm font-mono font-bold uppercase tracking-[0.08em] text-[var(--accent-quiet)]">{node.name}</p>
                    <div className="grid gap-2">
                      {node.details.map((detail) => (
                        <p key={detail} className="text-sm leading-6 text-[var(--gray-dark)]">
                          {detail}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* --cleared as a fill puts bone at 4.38:1, a hair under the
                  floor at this size. The -deep rung takes it to 5.65:1. */}
              <p className="border-2 border-[var(--black)] bg-[var(--cleared-deep)] px-4 py-3 text-sm font-bold uppercase tracking-[0.08em] text-[var(--white)]">
                Certification Status: Signed and Active. Logical paths, equations, role boundaries, and sandbox behavior are aligned for SHADOW core build execution.
              </p>
            </article>
            </div>
          </details>

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
                  <span className="text-xs font-mono uppercase tracking-[0.15em] text-[var(--accent-quiet)]">{item.status}</span>
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
                      <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--accent-quiet)]">{lane.lane}</p>
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
                      <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--accent-quiet)]">{workspace.openCount} open</p>
                      <Link
                        href={workspace.href}
                        className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--accent-strong)] px-4 py-2 text-xs font-mono font-bold uppercase tracking-[0.14em] text-[var(--accent-ink)] transition hover:bg-[var(--brass-400)]"
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
                          className="mt-3 inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                        >
                          Open Capability
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="mt-3 inline-flex min-h-[44px] cursor-not-allowed items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)] opacity-80"
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

              <section className="space-y-4 border-[3px] border-[var(--black)] bg-[var(--hide-800)] px-6 py-6 text-[var(--white)] shadow-[var(--shadow-sm)]">
                <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--white)]">SHADOW COMMAND NODE</h2>
                <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--white)]">PLANNED | NOT YET IMPLEMENTED</p>
                <p className="text-sm leading-6 text-[var(--white-off)]">
                  No operational alert feed reaches this panel. An empty panel here means nothing is being watched
                  from this screen, not that the floor is clear. Open SHADOW Ops for what the system can report today.
                </p>
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