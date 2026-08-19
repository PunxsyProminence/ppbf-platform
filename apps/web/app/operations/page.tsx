import Link from 'next/link';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
import ShadowCommandFeed from '@/components/ShadowCommandFeed';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';

const roleSelector = [
  { role: 'Athlete', href: '/athlete/dashboard', status: 'Ready' },
  { role: 'Coach', href: '/coach/environment/intake-router', status: 'Ready' },
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
    href: '/coach/environment/intake-router',
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
  { name: 'Coach Intelligence', state: 'EXISTS', href: '/coach/environment/intake-router', notes: 'Coach workspace, review queue, and floor controls are available.' },
  { name: 'Research Intelligence', state: 'EXISTS', href: '/research', notes: 'Research intake and Q&A workflow are available.' },
  { name: 'Knowledge Graph', state: 'EXISTS', href: '/knowledge-graph', notes: 'Knowledge and relationship view is available.' },
  { name: 'Scenario Simulation', state: 'EXISTS', href: '/simulator', notes: 'What-if simulator and promotion flow links are available.' },
  { name: 'Source Governance', state: 'EXISTS', href: '/source-control', notes: 'Audit-to-source-control publication flow is visible.' },
  { name: 'Funding Intelligence', state: 'PARTIAL', href: '/admin?tab=revenue', notes: 'Revenue center front-end plus the payment ledger schema and the Stripe Connect onboarding flow (/admin/payments: connect button, OAuth round trip, deauthorization webhook). No charging exists — CAP-012 stays BLOCKED behind owner platform-account registration and compliance sign-off.' },
  { name: 'Scholarship Tracking', state: 'EXISTS', href: '/admin/memberships', notes: 'Scholarships are stored discounts on real membership rows (100% = full scholarship), never bypasses — backed by pilot.program_memberships. Fee computation from these records arrives with the payment lanes.' },
  { name: 'Membership Tracking', state: 'EXISTS', href: '/admin/memberships', notes: 'Program enrollment records with an active/lapsed/ended lifecycle and one-active-per-program enforcement, backed by pilot.program_memberships. Billing is not built — fees arrive with the payment lanes and will read these records.' },
  { name: 'SHADOW Monitoring', state: 'EXISTS', href: '/shadow', notes: 'SHADOW consoles are wired to live routes, and the operations hub command node reads the real event/telemetry record, read-only and newest-first. Which recorded facts deserve an alarm remains a human decision; the feed reports what is recorded and claims nothing more.' },
  { name: 'AI Video Analysis', state: 'PARTIAL', href: '/coach/video-analysis', notes: 'Upload, release, and playback are real and backed by persistent records; a released video can be sent to Film Study for human-reviewed observation — Film Study is the analysis pathway. Per-skill scoring is PARKED for Phase 2+ by owner decision (2026-08-15, BACKLOG-video-skill-scoring): partial by design, not by neglect.' },
  { name: 'Video Review Intelligence', state: 'EXISTS', href: '/admin/video-review', notes: 'Org-admin console for the automated content-scan quarantine escalation: watch the clip, approve or block. A downstream compliance-review step (appropriateness, consent, audio privacy) is separately available at /admin/video-compliance.' },
  { name: 'Session Script Delivery', state: 'EXISTS', href: '/coach/session-scripts', notes: 'Script browse, live floor delivery with a server-owned clock, and settled delivery history are backed by pilot.session_script_runs.' },
  { name: 'Safety Compliance Center', state: 'EXISTS', href: '/admin/compliance-center', notes: 'Violation register with acknowledge / escalate / resolve / dismiss lifecycle; org-scoped, audited, backed by pilot.compliance_violations.' },
  { name: 'Coach Coverage', state: 'EXISTS', href: '/admin/coach-coverage', notes: 'Temporary athlete-record access for a covering coach, with expiry and immediate revocation, backed by pilot.coach_coverage.' },
  { name: 'Drill Library', state: 'EXISTS', href: '/coach/drills', notes: 'Versioned drill library backed by persistent records.' },
  { name: 'Performance Analytics', state: 'EXISTS', href: '/coach/performance-analytics', notes: 'Read-only roster rollup for coach/admin: sessions and RPE, readiness check-ins with a glanceable trend, activity-log training days, and progression work over a selectable window. Aggregates existing records only; no new data collection.' },
  { name: 'Grant Compliance Intelligence', state: 'PARTIAL', href: '/admin/grants', notes: 'The internal grant-obligation ledger is real: deadlines, deliverables, renewals, and filings with a status lifecycle, backed by pilot.grant_obligations — which structurally carries no athlete data, keeping the parked external-disclosure question parked. Grant-packet generation for funders remains parked until a real grant defines its disclosure set.' },
  { name: 'Closed-Loop Progression Intelligence', state: 'PARTIAL', href: '/athlete/progression-intelligence', notes: 'Athlete, coach, and parent surfaces read the real gap / drill-assignment / completion records behind the pilot progression routes. Gaps are coach-identified today; automated gap detection remains planned.' },
  { name: 'Sports Medicine', state: 'PARTIAL', href: '/coach/sports-medicine', notes: 'The clearance board is real: per-athlete clearance status and active training holds with athlete-safe explanations only — no diagnoses or clinical detail, by owner decision (2026-08-15). Broader sports-medicine workflow (injury tracking, treatment records) remains planned.' },
  { name: 'Volunteer Management', state: 'EXISTS', href: '/admin/volunteer-management', notes: 'Volunteer roster, status, and availability are backed by persistent records.' },
  { name: 'Wrestling League Management', state: 'PARTIAL', href: '/operations/wrestling-league', notes: 'Season, event, and roster records are real, backed by pilot.wrestling_league_* tables — deliberately skeletal by owner decision (2026-08-15). Match cards, brackets, weigh-ins, scoring, and scheduling stay unbuilt until a real league defines them.' },
  { name: 'External Competition Platform', state: 'PARTIAL', href: '/operations/external-competition', notes: 'Competition and entry records are real, backed by pilot.external_competition* tables — deliberately skeletal by owner decision (2026-08-15). Federation integration, result sync, brackets, travel, and compliance checklists stay unbuilt until real competitions define them.' },
  { name: 'Publication Workflow Automation', state: 'PLACEHOLDER', href: '/source-control/publication-workflow', notes: 'Parked by owner-approved assessment (2026-08-15, BACKLOG-publication-automation): the internal publication machinery that exists — video compliance, research evidence review, retraction — is human-gated on purpose, and outward automation has no defined destination or disclosure set yet. Front-end placeholder remains visible.' },
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

          {/* The "System Diagnostics and SHADOW Certification" panel used to sit
              here, ending in a green .stamp--green reading "Signed & Active" over
              "Certification Status: Signed and Active". It is deleted, and it must
              not come back.

              Nothing signed it. The whole panel was module-level string constants
              in this file — no fetch, no state, no build metadata, no signer, no
              date, no build id. A certification stamp that names no authority and
              no artifact is a decoration that reads as a guarantee, on the one
              surface where staff go to ask whether the platform is safe to run on.

              It was also wrong on the facts:

              * "Mathematical Gate Validation" presented the readiness equation as
                a live safety gate. formulas/registry.ts registers that exact
                formula as LEGACY-READINESS, support 'experimental_unsupported':
                "Coefficients, input scales, fairness, and clinical/safety validity
                are unproven. It must not clear, restrict, or prescribe training."
                readinessBoard.ts keeps it deliberately unwired for that reason;
                calculateReadinessL14 has no caller but its own unit test.
              * "Any readiness score below 5.0 triggers protective route and drill
                constraints" described a threshold that does not exist. The real
                numbers are READINESS_GREEN_MIN = 7 and READINESS_YELLOW_MIN = 4 in
                readinessBoard.ts, and they are display triage colours over a
                staff-typed score — they constrain nothing.
              * "12-role viewport segregation" was a count of nothing: ClubRole in
                components/roleRoutes.ts defines 16 roles.

              readinessMath.ts still holds the 1-10 clamp and the delta-RPE >= 2
              lockout-unless-rationale, and both are unit-tested — but neither has a
              production caller either, so neither is a guardrail this page may
              advertise as active. If a real certification ever exists, it needs a
              signer, a timestamp, and a build it was signed against, read from a
              record — not a const.

              page.test.tsx pins the absence. */}

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
                {/* The stamp is gone because the feed is real: ShadowCommandFeed
                    reads the same org-scoped, role-projected record the SHADOW
                    consoles read. The doctrine the old stamp carried survives in
                    the feed's own copy — every state (loading, failed, empty)
                    says in as many words that it does not mean the floor is
                    clear, and app/operations/page.test.tsx pins that. What this
                    panel still does NOT do is rank or alarm: which recorded
                    facts deserve an alarm is a human decision nobody has made,
                    and inventing one here would put fabricated urgency on a
                    safety-adjacent surface. */}
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>SHADOW COMMAND NODE</h2>
                <ShadowCommandFeed />
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