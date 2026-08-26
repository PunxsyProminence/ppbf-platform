'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';
import { OPERATIONS_ROLES, canUseOperationsHub } from '@/components/operationsAccess';

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

/* The OTHER DESKS section below renders only for the admin desks -- see
   showsLabDesks in the component.

   That narrowing came from Operations V1 (2026-08-21), when this page was a
   launcher every role could open and the lab desks had to be hidden from most
   of them. The owner decision of 2026-08-26 retired that: the hub itself is
   now administration only, so everyone who reaches this render is already an
   admin or the platform owner and the check below can no longer exclude
   anybody. It is kept as belt-and-braces rather than deleted, because it is
   what would still hold the lab desks back if the hub's gate were ever
   widened again without anyone revisiting this section.

   The list itself stays whole: it is the record of what the lab holds, and
   hiding a desk from a corridor is a visibility decision, never an
   authorization one (buildingMap.ts's own rule). The data behind every one
   of these surfaces is guarded by its own API checks. */
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
  { label: 'The Stands', href: '/guardian' },
];

type CapabilityState = 'EXISTS' | 'PARTIAL' | 'PLACEHOLDER' | 'MISSING';

/* The state is the record's own word, kept as-is because the tests and the
   work queue both read it. What the register PRINTS is the clerk's word for
   the same fact -- "IN USE", not "EXISTS" -- because a visitor to the front
   desk is asking whether a thing works, not what the roadmap calls it. */
const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  EXISTS: 'IN USE',
  PARTIAL: 'IN PART',
  PLACEHOLDER: 'NOT BUILT',
  MISSING: 'NOT ON FILE',
};

/* `record` is the file reference -- the table, backlog id, or capability
   number the entry is kept under. It used to sit inside the sentence, so the
   register read a database schema out loud to whoever walked up to the desk.
   A clerk writes the file number in the margin instead: it stays on the page,
   in the mono record voice, in its own ruled column. */
/* `lab` marks the rows whose desk is a development-lab surface rather than an
   operational one. The register keeps every row -- the record is the record --
   but a lab row prints only for the admin desks (Operations V1, 2026-08-21),
   the same visibility-only narrowing the building map applies to the same
   doors. */
const capabilityRadar: Array<{ name: string; state: CapabilityState; href: string; record?: string; notes: string; lab?: true }> = [
  { name: 'Athlete Readiness', state: 'EXISTS', href: '/athlete/dashboard', notes: 'Check-ins, session logs, and goals are open to athletes today.' },
  { name: 'Coach Intelligence', state: 'EXISTS', href: '/coach/environment/intake-router', notes: 'The coach workspace, the review queue, and the floor controls are open.' },
  { name: 'Research Intelligence', lab: true, state: 'EXISTS', href: '/research', notes: 'Research intake and the question-and-answer workflow are open.' },
  { name: 'Knowledge Graph', lab: true, state: 'EXISTS', href: '/knowledge-graph', notes: 'The knowledge and relationship view is open.' },
  { name: 'Scenario Simulation', lab: true, state: 'EXISTS', href: '/simulator', notes: 'The what-if simulator and its promotion links are open.' },
  { name: 'Source Governance', lab: true, state: 'EXISTS', href: '/source-control', notes: 'The route from an audit entry through to source control is visible end to end.' },
  { name: 'Funding Intelligence', state: 'PARTIAL', href: '/admin?tab=revenue', record: 'CAP-012', notes: 'The revenue desk, the payment record, and the Stripe Connect sign-up round trip are all in place. Nothing can be charged yet: that waits on the owner registering the platform account and on compliance signing it off.' },
  { name: 'Scholarship Tracking', state: 'EXISTS', href: '/admin/memberships', record: 'pilot.program_memberships', notes: 'A scholarship is a discount written on a real membership record — 100% is a full scholarship — and never bypasses one. Working the fee out from those records arrives with the payment lanes.' },
  { name: 'Membership Tracking', state: 'EXISTS', href: '/admin/memberships', record: 'pilot.program_memberships', notes: 'Enrollment records with an active, lapsed, or ended life, and one active membership per program. Billing is not built — fees arrive with the payment lanes and will read these records.' },
  { name: 'SHADOW Monitoring', lab: true, state: 'EXISTS', href: '/shadow', notes: 'The SHADOW consoles read the live record. The record itself is kept in the after-hours room rather than at this desk. Which of the recorded facts deserves an alarm remains a human decision, and nothing claims more than what is written down.' },
  { name: 'AI Video Analysis', state: 'PARTIAL', href: '/coach/video-analysis', record: 'BACKLOG-video-skill-scoring · 2026-08-15', notes: 'Upload, release, and playback are real and kept on file, and a released video can go to Film Study for a person to watch and write up. Film Study is the analysis path. Scoring a clip skill by skill is parked for a later phase by owner decision: part built on purpose, not by neglect.' },
  { name: 'Video Review Intelligence', state: 'EXISTS', href: '/admin/video-review', notes: 'The organization admin\u2019s desk for a clip the content scan has held back: watch it, then approve or block. Whether the clip is also appropriate, consented to, and private on audio is a separate read with a desk of its own.' },
  { name: 'Session Script Delivery', state: 'EXISTS', href: '/coach/session-scripts', record: 'pilot.session_script_runs', notes: 'Browsing a script, running it on the floor against a clock the server owns, and the settled history afterwards are all kept on file.' },
  { name: 'Safety Compliance Center', state: 'EXISTS', href: '/admin/compliance-center', record: 'pilot.compliance_violations', notes: 'A register of violations that can be acknowledged, escalated, resolved, or dismissed. One organization at a time, and every step is written to the audit record.' },
  { name: 'Coach Coverage', state: 'EXISTS', href: '/admin/coach-coverage', record: 'pilot.coach_coverage', notes: 'Temporary access to an athlete record for a covering coach, with a date it runs out and a revoke that takes effect at once.' },
  { name: 'Drill Library', state: 'EXISTS', href: '/coach/drills', notes: 'A versioned drill library kept on file.' },
  { name: 'Performance Analytics', state: 'EXISTS', href: '/coach/performance-analytics', notes: 'A read-only roster rollup for coaches and admins: sessions and RPE, readiness check-ins with a trend you can read at a glance, training days from the activity log, and progression work over a window you choose. It adds up records that already exist and collects nothing new.' },
  { name: 'Grant Compliance Intelligence', state: 'PARTIAL', href: '/admin/grants', record: 'pilot.grant_obligations', notes: 'The gym\u2019s own obligation ledger is real: deadlines, deliverables, renewals, and filings, each with a status. It carries no athlete data at all, which is what keeps the question of what a funder may see parked. Building a packet for a funder waits until a real grant says what belongs in one.' },
  { name: 'Closed-Loop Progression Intelligence', state: 'PARTIAL', href: '/athlete/progression-intelligence', notes: 'The athlete, coach, and parent surfaces read the real gap, drill-assignment, and completion records. A coach names the gaps today; finding them automatically is still planned.' },
  { name: 'Sports Medicine', state: 'PARTIAL', href: '/coach/sports-medicine', notes: 'The clearance board is real: where each athlete stands, and any training hold, written so the athlete can read it — no diagnoses or clinical detail, by owner decision. The wider work, injury tracking and treatment records, is still planned.' },
  { name: 'Volunteer Management', state: 'EXISTS', href: '/admin/volunteer-management', notes: 'The volunteer roster, their status, and their availability are kept on file.' },
  { name: 'Wrestling League Management', state: 'PARTIAL', href: '/operations/wrestling-league', record: 'pilot.wrestling_league_* · 2026-08-15', notes: 'Season, event, and roster records are real, and deliberately bare by owner decision. Match cards, brackets, weigh-ins, scoring, and scheduling stay unbuilt until a real league defines them.' },
  { name: 'External Competition Platform', state: 'PARTIAL', href: '/operations/external-competition', record: 'pilot.external_competition* · 2026-08-15', notes: 'Competition and entry records are real, and deliberately bare by owner decision. Federation links, result sync, brackets, travel, and compliance checklists stay unbuilt until real competitions define them.' },
  { name: 'Publication Workflow Automation', lab: true, state: 'PLACEHOLDER', href: '/source-control/publication-workflow', record: 'BACKLOG-publication-automation · 2026-08-15', notes: 'Parked by an owner-approved assessment. What already exists inside the building — video compliance, research evidence review, retraction — is human-gated on purpose, and sending anything outward has no destination and no agreed disclosure set yet. The front-end placeholder stays visible.' },
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

/* THE GATE IS THE POLICY, IMPORTED, NOT DERIVED HERE.

   This was `[...roleRoutes.map((route) => route.role), 'platform_owner']` --
   every role the platform has, computed from the role-selector list this page
   happens to render. Two things were wrong with that beyond its breadth: a
   policy derived from a UI list changes whenever somebody adds a row to the
   selector, and it was one of six places that independently decided who gets
   Operations. The owner decision of 2026-08-26 narrows the hub to gym
   administration; operationsAccess.ts states it once and everything else --
   this gate, the global header, the standalone band, and the building map's
   visibility hint -- reads it from there. */

export default function OperationsHubPage() {
  /* The viewer's own role, read the way Corridor and CardCatalog read it. By
     the time RoleSessionGate lets the children mount it has persisted the
     authoritative session, so the snapshot is the server's answer, not a
     guess. Used for VISIBILITY ONLY (buildingMap.ts's rule): the pages behind
     the lab desks keep their own guards and every lab API keeps its own
     access checks.

     canUseOperationsHub rather than a hand-written `=== 'admin' || ===
     'platform_owner'`: that spelling was a second copy of the same two roles
     the gate uses, and two copies of one policy are how a narrowing lands in
     one place and not the other. */
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const viewerRole = session?.role ?? null;
  const showsLabDesks = canUseOperationsHub(viewerRole);

  return (
    <RoleSessionGate allowedRoles={[...OPERATIONS_ROLES]}>
      {/* Front office. The hub is a launcher and a notice board -- the role
          selector, the workspace directory and AnnouncementBanner, which is
          office chrome by name in ROOM-PURPOSE-DNA -- rather than floor work
          or a night console. It was on bare ink, which is no room at all. */}
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="relative space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
            {/* The office's own fixture, hung over the desk. .lamp draws the
                shade and the pool of light under it; the room supplies the
                wall behind, and nothing else on the page paints light. */}
            <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
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
            className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]"
          />

          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
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

          <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
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
              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
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

              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
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

              {showsLabDesks && (
                <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>OTHER DESKS</h2>
                  <p className="t-body">
                    The research, evidence, and publication desks, and the rooms that keep their records.
                  </p>
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
              )}

              <section className="space-y-[var(--s4)]" aria-labelledby="capability-register">
                <h2 id="capability-register" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                  What This Gym Can Do Today
                </h2>
                <p className="t-body max-w-[80ch]">
                  One line for every part of the platform, and a plain word for how far along it is.
                  A line that says NOT BUILT is not built — it is on the list, and that is all.
                </p>
                {/* The register is a record, so it is a ruled sheet on the desk
                    rather than another grid of leather tiles: .ledger on
                    .mat-paper, in the brass frame the office hangs its records
                    in. The mono voice is Law 4's — every row here is auditable
                    against the work queue. */}
                <div className="frame">
                  <span className="rivet rivet--tl" />
                  <span className="rivet rivet--tr" />
                  <span className="rivet rivet--bl" />
                  <span className="rivet rivet--br" />
                  <div className="frame-in mat-paper p-[var(--s5)]">
                    {/* The scroller is a child: .frame > .frame-in sets
                        overflow:hidden unlayered, which beats a layered
                        overflow-x utility on the same element. */}
                    <div className="overflow-x-auto">
                    <table className="ledger">
                      <caption className="text-left">The capability register</caption>
                      <thead>
                        <tr>
                          <th scope="col">Capability</th>
                          <th scope="col">State</th>
                          <th scope="col">What is on file</th>
                          <th scope="col">Filed under</th>
                          <th scope="col">Desk</th>
                        </tr>
                      </thead>
                      <tbody>
                        {capabilityRadar.filter((item) => showsLabDesks || item.lab !== true).map((item) => (
                          <tr key={item.name}>
                            <td>
                              {/* Still a heading -- a row label in a register is
                                  the record's name -- but it takes the ledger's
                                  own voice rather than the display stencil,
                                  which is what makes a ruled sheet read as one. */}
                              <h3 className="font-bold">{item.name}</h3>
                            </td>
                            <td>
                              <span
                                className={`inline-flex shrink-0 items-center gap-[var(--s2)] uppercase tracking-[0.1em] ${capabilityChip(item.state).cls}`}
                              >
                                <i className="not-italic">{capabilityChip(item.state).glyph}</i>
                                {CAPABILITY_STATE_LABEL[item.state]}
                              </span>
                            </td>
                            <td className="max-w-[58ch]">{item.notes}</td>
                            <td className="ledger-id">{item.record ?? '—'}</td>
                            <td>
                              <Link href={item.href} className="btn--lever hover:no-underline" aria-label={`Open ${item.name}`}>
                                Open
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <aside className="space-y-6">

              {/* THE NIGHT RECORD IS NOT KEPT AT THIS DESK.

                  This panel used to mount <ShadowCommandFeed /> under a heading
                  reading "SHADOW COMMAND NODE": a newest-first event feed,
                  POSTing to the shadow events and telemetry routes, rendered
                  inside .room--office. ROOM-PURPOSE-DNA names night telemetry
                  as forbidden chrome in the front office in as many words, and
                  the feed is the After Hours room's own core furniture -- the
                  page was wearing another room's face.

                  So the panel is a door, not a console. The doctrine the feed
                  carried travels with it: whoever reads that log reads it in the
                  room that owns it, where an empty feed still does not mean the
                  floor is clear. The component itself is untouched and still
                  tested (components/shadowCommandFeed.test.tsx) -- it is for the
                  night room to mount, not this one.

                  This is the ONLY link to /admin/shadow on the page. The
                  "Platform Shortcuts" list carried a second one labelled "The
                  Office", which pointed at the After Hours room -- a door with
                  the wrong room painted on it. It is gone. */}
              <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>After Hours</h2>
                <p className="t-body">
                  The night record — every SHADOW event and reading, newest first — is kept in the
                  after-hours room, not at this desk. Open it when you need the log itself.
                </p>
                <Link href="/admin/shadow" className="btn btn--ghost">
                  Open the after-hours room
                </Link>
              </section>

              <section className="space-y-[var(--s3)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Around The Building</h2>
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