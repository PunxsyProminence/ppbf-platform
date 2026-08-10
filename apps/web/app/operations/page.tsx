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
    summary: 'Floor coverage, readiness signals, and session execution windows.',
  },
  {
    lane: 'BOARD',
    summary: 'Governance actions, approvals, and oversight checkpoints.',
  },
  {
    lane: 'SYSTEM',
    summary: 'Platform integrity, audit state, and release-path integrity checks.',
  },
];


const workspaces = [
  {
    label: 'Athlete Workspace',
    href: '/athlete/dashboard',
    note: 'Readiness, goals, drills, and session log actions.',
  },
  {
    label: 'Coach Workspace',
    href: '/coach/review-queue',
    note: 'Review queue, floor operations, and athlete management actions.',
  },
  {
    label: 'Parent Hub',
    href: '/parent/dashboard',
    note: 'Family support tasks, attendance visibility, and check-ins.',
  },
  {
    label: 'Admin Hub',
    href: '/admin',
    note: 'Capability controls, assignment matrix, and system posture.',
  },
  {
    label: 'Board Hub',
    href: '/board',
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
  { name: 'AI Video Analysis', state: 'PARTIAL', href: '/coach/video-analysis', notes: 'Upload, release, and playback are real and backed by persistent records; a released video can be sent to Film Study for human-reviewed observation. Per-skill scoring (punch detection, footwork, and the rest) remains planned and is not yet active.' },
  { name: 'Video Review Intelligence', state: 'EXISTS', href: '/admin/video-review', notes: 'Org-admin console for the automated content-scan quarantine escalation: watch the clip, approve or block. A downstream compliance-review step (appropriateness, consent, audio privacy) is separately available at /admin/video-compliance.' },
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

/* Build state is deliberately kept OFF the status ladder.

   These tiles used to carry it on the ladder's own colours — green for
   EXISTS, amber for PARTIAL, --red-primary for PLACEHOLDER. Law 2 spends
   saturated colour on a participant's safety state or a queue outcome and
   nothing else, and "this screen is not written yet" is neither. Twenty
   tiles of it on one page is the single largest drain on the budget the
   Gate Matrix is supposed to own, and it teaches a coach that red on this
   platform can mean a roadmap gap.

   So the ladder goes back to safety, and build state reads on the chassis
   instead: brass for shipped, bare leather for partial, and a brass stamp
   for a capability that does not exist yet — Law 7's "a declaration is ink
   on the page", in the .stamp--brass variant rather than the red one, so
   even the stamp stays off the safety colour.

   Law 3 is satisfied the same way it always is: each state carries its own
   glyph and its uppercase label, so the three are separable in greyscale
   and to a colour-blind reader without leaning on hue at all. */
function capabilityChip(state: CapabilityState): { cls: string; glyph: string } {
  if (state === 'EXISTS') {
    return {
      cls: 'rounded-[var(--r-sm)] bg-[var(--brass-300)] px-[var(--s3)] py-[var(--s1)] font-bold text-[color:var(--hide-950)]',
      glyph: '✓',
    };
  }
  if (state === 'PARTIAL') {
    return {
      cls: 'mat-leather rounded-[var(--r-sm)] border border-[color:var(--brass-600)] px-[var(--s3)] py-[var(--s1)] text-[color:var(--brass-300)]',
      glyph: '▲',
    };
  }
  if (state === 'PLACEHOLDER') {
    return { cls: 'stamp stamp--brass stamp--flat', glyph: '✕' };
  }
  return {
    cls: 'mat-leather rounded-[var(--r-sm)] px-[var(--s3)] py-[2px] text-[color:var(--bone-400)]',
    glyph: '·',
  };
}

// Navigation only, with no athlete-scoped data on the page, so the platform
// owner belongs here alongside every gym role.
const operationsRoles: ClubRole[] = [...roleRoutes.map((route) => route.role), 'platform_owner'];

export default function OperationsHubPage() {
  return (
    <RoleSessionGate allowedRoles={operationsRoles}>
      <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
            <p className="t-eyebrow tracking-[0.35em]">Mission Control</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>The Ring</h1>
            <p className="t-body max-w-[80ch]">
              Every corner has its own view. Athlete. Coach. Parent. Board. Admin. Public.
            </p>
            <ShadowChatButton context="Mission Control" />
          </header>

          <AnnouncementBanner
            placement="everywhere"
            heading="Gym-wide notice"
            className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]"
          />

          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="t-body max-w-[80ch]">
                Need orientation? Open the full tutorial center from one button instead of rendering all tutorial content inline.
              </p>
              <ShadowChatButton context="Mission Control Start Here" />
            </div>
          </section>

          <details className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s4)]">
            <summary className="cursor-pointer list-none t-command" style={{ fontSize: 'var(--t-lg)' }}>
              System Diagnostics and SHADOW Certification
            </summary>
            <div className="mt-4 space-y-5">
            <div className="space-y-[var(--s3)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-eyebrow">System Operational Audit and Validation Report</p>
              <p className="t-body">
                SHADOW v21.1 seed is ingested, stress-validated, and sealed for development deployment. This build section mirrors the certified guardrails used for floor safety, role isolation, and audit integrity.
              </p>
              <div className="grid gap-2 md:grid-cols-3">
                {shadowCertificationSignals.map((signal) => (
                  <div key={signal} className="mat-leather rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] t-data uppercase tracking-[0.08em]">
                    {signal}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <article className="space-y-[var(--s3)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Mathematical Gate Validation</h3>
                <p className="mat-leather rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] t-data">{shadowReadinessEquation}</p>
                <p className="mat-leather rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] t-data">{shadowRpeEquation}</p>
                <div className="grid gap-2">
                  {shadowBoundaryChecks.map((item) => (
                    <p key={item} className="mat-leather rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] t-body">
                      {item}
                    </p>
                  ))}
                </div>
              </article>

              <article className="space-y-[var(--s3)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Privacy and Compliance Boundaries</h3>
                <div className="grid gap-2">
                  {shadowComplianceChecks.map((item) => (
                    <p key={item} className="mat-leather rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] t-body">
                      {item}
                    </p>
                  ))}
                </div>
              </article>
            </div>

            <article className="space-y-[var(--s4)] mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>SHADOW Dual-Engine Architecture</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {shadowArchitectureNodes.map((node) => (
                  <div key={node.name} className="space-y-[var(--s2)] mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-eyebrow">{node.name}</p>
                    <div className="grid gap-2">
                      {node.details.map((detail) => (
                        <p key={detail} className="t-body">
                          {detail}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* This announced a PASS on a solid --red-primary field — the
                  safety gate's red carrying a success message, which is the
                  most misleading way the token has been misused anywhere in
                  the app. A signed certification is a governance decision, so
                  Law 7 gives it ink: a stamp on the page, in the approved
                  green the system reserves for exactly this. */}
              <div className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                <span className="stamp stamp--green">Signed &amp; Active</span>
                <p className="t-body mt-[var(--s4)]">
                  Certification Status: Signed and Active. Logical paths, equations, role boundaries, and sandbox behavior are aligned for SHADOW core build execution.
                </p>
              </div>
            </article>
            </div>
          </details>

          <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Role Selector</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roleSelector.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s4)] transition hover:border-[color:var(--brass-400)] border border-transparent"
                >
                  <span className="t-command">{item.role}</span>
                  <span className="t-eyebrow">{item.status}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>MY PRIORITIES TODAY</h2>
                <div className="grid gap-3 md:grid-cols-3">
                  {priorityLanes.map((lane) => (
                    <article key={lane.lane} className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s4)]">
                      <p className="t-eyebrow">{lane.lane}</p>
                      <p className="t-body mt-[var(--s3)]">{lane.summary}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>WORKSPACES</h2>
                <div className="grid gap-3">
                  {workspaces.map((workspace) => (
                    <article key={workspace.href} className="grid gap-[var(--s4)] mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s4)] md:grid-cols-[1fr_auto_auto] md:items-center">
                      <div>
                        <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{workspace.label}</h3>
                        <p className="t-body mt-[var(--s2)]">{workspace.note}</p>
                      </div>
                      <Link
                        href={workspace.href}
                        className="btn"
                      >
                        Open
                      </Link>
                    </article>
                  ))}
                </div>
              </section>

              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>DEVELOPMENT LAB</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {developmentLab.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="btn btn--ghost justify-start text-left"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </section>

              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Capability Visibility Map</h2>
                <p className="t-body">
                  Reality-based map of major PPBF capabilities. Placeholders are roadmap visibility only and are not implemented.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {capabilityRadar.map((item) => (
                    <article
                      key={item.name}
                      className="mat-leather--raised rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.18)] p-[var(--s4)]"
                    >
                      <div className="flex items-start justify-between gap-[var(--s4)]">
                        <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>
                          {item.name}
                        </h3>
                        <span
                          className={`inline-flex shrink-0 items-center gap-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.1em] ${capabilityChip(item.state).cls}`}
                        >
                          <i className="not-italic">{capabilityChip(item.state).glyph}</i>
                          {item.state}
                        </span>
                      </div>
                      <p className="t-body mt-[var(--s3)]">{item.notes}</p>
                      {item.href ? (
                        <Link href={item.href} className="btn btn--ghost mt-[var(--s3)]">
                          Open Capability
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="btn btn--ghost mt-[var(--s3)] cursor-not-allowed opacity-60 grayscale"
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

              {/* A solid red panel for "planned, not yet implemented". The
                  copy underneath is the important part — an empty panel here
                  does not mean the floor is clear — and drowning it in the
                  safety red made the panel itself look like the alert it is
                  explicitly telling you it is not. Law 7: the unbuilt state is
                  stamped, in brass so the ladder keeps its colour. */}
              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                {/* Heading case and the stamp's wording are both load-bearing:
                    app/operations/page.test.tsx asserts this panel says
                    "PLANNED | NOT YET IMPLEMENTED" in as many words, so an
                    empty alert panel can never be mistaken for a quiet floor.
                    The restyle carries the exact string rather than paraphrase
                    it — the guarantee is the point, the stamp is just how it
                    is now said. */}
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>SHADOW COMMAND NODE</h2>
                <span className="stamp stamp--brass">PLANNED | NOT YET IMPLEMENTED</span>
                <p className="t-body">
                  No operational alert feed reaches this panel. An empty panel here means nothing is being watched
                  from this screen, not that the floor is clear. Open SHADOW Ops for what the system can report today.
                </p>
                <Link
                  href="/admin/shadow"
                  className="btn btn--ghost"
                >
                  Open SHADOW Ops
                </Link>
              </section>

              <section className="space-y-[var(--s3)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Platform Shortcuts</h2>
                <div className="grid gap-2">
                  {utilityLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="btn btn--ghost justify-start text-left"
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