'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import RoleSessionGate from './RoleSessionGate';
import ShadowChatButton from './ShadowChatButton';
import type { ClubRole } from './roleRoutes';
import type { BoardOverviewMetric, BoardSeatConfig, BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

type WorkspaceTab =
  | 'Overview'
  | 'Governance'
  | 'Strategy'
  | 'Meetings'
  | 'Tasks'
  | 'Policies'
  | 'Resolutions'
  | 'Committees'
  | 'Compliance'
  | 'Documents'
  | 'SHADOW';

interface BoardMemberDashboardProps {
  seat: BoardSeatConfig;
  overviewMetrics: ReadonlyArray<BoardOverviewMetric>;
  links: ReadonlyArray<{ label: string; href: string }>;
  allowedRoles: ClubRole[];
}

interface ModuleGroup {
  title: string;
  items: string[];
}

const tabs: WorkspaceTab[] = ['Overview', 'Governance', 'Strategy', 'Meetings', 'Tasks', 'Policies', 'Resolutions', 'Committees', 'Compliance', 'Documents', 'SHADOW'];

const roleModulesBySeat: Record<BoardSeatSlug, ModuleGroup[]> = {
  president: [
    { title: 'Mission Stewardship', items: ['Mission stewardship checkpoints', 'Mission alignment reviews', 'Mission drift prevention cadence'] },
    { title: 'Strategic Direction', items: ['Strategic objective oversight', 'Board-level priority alignment', 'Quarterly strategy cycle governance'] },
    { title: 'Board Effectiveness', items: ['Board readiness assessment', 'Committee effectiveness scan', 'Governance quality scorecard'] },
    { title: 'Executive Accountability', items: ['Executive oversight register', 'Action accountability reviews', 'Leadership accountability follow-ups'] },
  ],
  chair: [
    { title: 'Governance Oversight', items: ['Bylaws and policy posture', 'Governance compliance pulse', 'Oversight continuity checks'] },
    { title: 'Meeting Governance', items: ['Agenda governance quality', 'Quorum and voting readiness', 'Decision integrity tracking'] },
    { title: 'Committee Leadership', items: ['Committee leadership cadence', 'Committee output oversight', 'Cross-committee governance alignment'] },
    { title: 'Board Development', items: ['Board development roadmap', 'Board education planning', 'Governance maturity progress'] },
  ],
  'vice-chair': [
    { title: 'Succession Planning', items: ['Leadership succession pipeline', 'Succession risk review', 'Role transition readiness'] },
    { title: 'Governance Continuity', items: ['Governance continuity protocol', 'Critical governance handoff map', 'Continuity risk controls'] },
    { title: 'Leadership Development', items: ['Board leadership growth plans', 'Mentorship checkpoints', 'Future leadership readiness'] },
    { title: 'Committee Coordination', items: ['Committee coordination calendar', 'Inter-committee dependencies', 'Committee support governance'] },
  ],
  treasurer: [
    { title: 'Financial Stewardship', items: ['Stewardship dashboard', 'Spending integrity governance', 'Financial policy compliance'] },
    { title: 'Grant Oversight', items: ['Grant oversight register', 'Restricted-funds compliance checks', 'Grant reporting governance'] },
    { title: 'Reserve Monitoring', items: ['Reserve posture tracking', 'Reserve risk alerts', 'Reserve policy adherence'] },
    { title: 'Funding Sustainability', items: ['Funding sustainability scan', 'Revenue diversity governance', 'Long-range funding scenarios'] },
  ],
  secretary: [
    { title: 'Governance Records', items: ['Governance record quality controls', 'Meeting record integrity checks', 'Record retention posture'] },
    { title: 'Board Action Register', items: ['Action register maintenance', 'Action closure integrity', 'Action accountability logging'] },
    { title: 'Annual Filing Calendar', items: ['Annual filing schedule', 'Deadline readiness checks', 'Filing completion tracking'] },
    { title: 'Document Integrity', items: ['Document version governance', 'Bylaws/resolution integrity checks', 'Archival controls'] },
  ],
  'safety-director': [
    { title: 'Youth Protection', items: ['Youth protection governance controls', 'Protection policy readiness', 'Protection escalation reviews'] },
    { title: 'Program Compliance', items: ['Program compliance checkpoints', 'Compliance calendar oversight', 'Compliance closure tracking'] },
    { title: 'Risk Management', items: ['Risk register updates', 'Risk mitigation oversight', 'Risk review cycles'] },
    { title: 'Safety Governance', items: ['Safety governance standards', 'Safety policy lifecycle', 'Safety accountability register'] },
  ],
  'community-director': [
    { title: 'Community Impact', items: ['Impact outcomes review', 'Community impact scorecard', 'Mission impact alignment'] },
    { title: 'Partner Development', items: ['Partner relationship pipeline', 'Partner stewardship cadence', 'Partner alignment checkpoints'] },
    { title: 'Fundraising Oversight', items: ['Fundraising governance checks', 'Campaign oversight reviews', 'Funding ethics alignment'] },
    { title: 'Volunteer Engagement', items: ['Volunteer engagement governance', 'Volunteer support readiness', 'Volunteer participation trends'] },
  ],
  'at-large': [
    { title: 'Independent Oversight', items: ['Independent oversight register', 'Oversight escalation reviews', 'Governance integrity checks'] },
    { title: 'Strategic Projects', items: ['Strategic project governance', 'Project oversight checkpoints', 'Cross-seat strategic alignment'] },
    { title: 'Special Reviews', items: ['Special review queue', 'Targeted governance investigations', 'Special review outcomes tracking'] },
    { title: 'Board Accountability', items: ['Accountability scorecard', 'Board accountability follow-ups', 'Governance gap remediation'] },
  ],
};

const boardShadowSignals: Record<BoardSeatSlug, string[]> = {
  president: ['Policy review reminder: Mission governance policy cycle due this week', 'Governance deadline: Strategic review session in 4 days', 'Resolution follow-up: Executive accountability resolution awaiting closeout'],
  chair: ['Committee oversight alert: Governance committee report pending', 'Governance deadline: Meeting governance checklist due in 2 days', 'Policy review reminder: Bylaws update packet requires chair review'],
  'vice-chair': ['Governance continuity alert: Succession planning review due tomorrow', 'Committee oversight alert: Cross-committee alignment update pending', 'Strategic cycle reminder: Leadership development review approaching'],
  treasurer: ['Compliance alert: Grant oversight review window opens in 3 days', 'Filing deadline reminder: Annual finance filing placeholder approaching', 'Risk alert: Reserve monitoring threshold review pending'],
  secretary: ['Filing deadline reminder: Annual filing calendar update due', 'Resolution follow-up: Board action register entries need closeout notes', 'Governance deadline: Document integrity review scheduled this week'],
  'safety-director': ['Compliance alert: Program compliance checkpoint due in 24 hours', 'Risk alert: Safety governance review item requires follow-up', 'Policy review reminder: Youth protection policy cycle is active'],
  'community-director': ['Committee oversight alert: Community impact report pending', 'Governance deadline: Fundraising oversight review due in 2 days', 'Strategic cycle reminder: Partner development review approaching'],
  'at-large': ['Special review alert: Independent oversight memo pending', 'Risk alert: Strategic project oversight item flagged for review', 'Governance deadline: Board accountability checkpoint due this week'],
};

function sharedTabCards(tab: WorkspaceTab) {
  const cardsByTab: Record<WorkspaceTab, Array<{ title: string; detail: string }>> = {
    Overview: [
      { title: 'Mission Alignment', detail: 'Current strategic priorities and mission stewardship checks across the board.' },
      { title: 'Board Action Register', detail: 'Open resolutions and governance actions requiring board-level follow-up.' },
      { title: 'Organizational Health', detail: 'Board participation, committee activity, and governance readiness indicators.' },
      { title: 'Annual Governance Calendar', detail: 'Required meetings, filings, reports, and governance review milestones.' },
      { title: 'Compliance Snapshot', detail: 'Nonprofit obligations and compliance review status in one governance view.' },
    ],
    Governance: [
      { title: 'Bylaws', detail: 'Bylaws review posture and governance update cycle visibility.' },
      { title: 'Resolutions', detail: 'Resolution register with draft, active, and closeout governance states.' },
      { title: 'Governance Policies', detail: 'Policy oversight and scheduled review cadence for board governance.' },
      { title: 'Strategic Plans', detail: 'Board-approved strategic plans and governance milestone checkpoints.' },
      { title: 'Annual Reports', detail: 'Annual report readiness and board review progress indicators.' },
      { title: 'Board Action Register', detail: 'Unified board governance action logging and accountability tracking.' },
    ],
    Strategy: [
      { title: 'Strategic Priorities', detail: 'Active strategic priorities and board-level review cadence.' },
      { title: 'Mission Advancement', detail: 'Mission advancement outcomes and governance steering checkpoints.' },
      { title: 'Community Impact', detail: 'Community impact oversight indicators aligned to nonprofit mission.' },
      { title: 'Program Growth', detail: 'Program growth oversight trends and strategic governance implications.' },
      { title: 'Facility Development', detail: 'Facility development oversight and long-range governance planning.' },
      { title: 'Funding Sustainability', detail: 'Funding sustainability reviews in support of mission continuity.' },
      { title: 'Volunteer Development', detail: 'Volunteer development strategy oversight and support pathways.' },
    ],
    Meetings: [
      { title: 'Meeting Calendar', detail: 'Upcoming meetings, agenda readiness, and governance prep checkpoints.' },
      { title: 'Agenda Packets', detail: 'Shared agenda package queue with role-aware follow-up responsibilities.' },
      { title: 'Action Capture', detail: 'Post-meeting action routing through one board task system.' },
    ],
    Tasks: [
      { title: 'Open Tasks Queue', detail: 'Single board task queue, filtered by seat responsibilities and due dates.' },
      { title: 'Review Tasks', detail: 'Pending governance reviews tied to policy, compliance, and meeting outputs.' },
      { title: 'Completion Signals', detail: 'Role modules consume the same task framework without duplication.' },
    ],
    Policies: [
      { title: 'Policy Review Queue', detail: 'Shared policy pipeline with under-review and ready-for-vote states.' },
      { title: 'Draft Coordination', detail: 'Cross-seat editing and review checkpoints for policy changes.' },
      { title: 'Policy Outcomes', detail: 'Promotion into resolutions and compliance follow-up tasks.' },
    ],
    Resolutions: [
      { title: 'Resolution Registry', detail: 'Board-wide registry of draft, active, and archived resolutions.' },
      { title: 'Vote Readiness', detail: 'Resolution packet quality checks before governance voting sessions.' },
      { title: 'Execution Tracking', detail: 'Resolution actions route back into shared tasks and committees.' },
    ],
    Committees: [
      { title: 'Committee Workboard', detail: 'Single committee workspace with role-aware views and contribution tracking.' },
      { title: 'Committee Actions', detail: 'Actions flow into unified task and meeting systems.' },
      { title: 'Coordination Signals', detail: 'Inter-committee dependency visibility for continuity planning.' },
    ],
    Compliance: [
      { title: 'Compliance Dashboard', detail: 'Board-level compliance posture snapshot with review windows and governance pressure points.' },
      { title: 'Compliance Watchlist', detail: 'Open compliance items, due-date pressure, and status progression.' },
      { title: 'Policy Review Queue', detail: 'Policy review flow with required review dates and board escalation visibility.' },
      { title: 'Required Review Dates', detail: 'Date-bound compliance obligations for board cycle planning and closeout checks.' },
      { title: 'Board Compliance Alerts', detail: 'Front-end board alert feed for compliance exceptions and governance reminders.' },
      { title: 'Safety Governance Monitoring', detail: 'Safety governance monitor lane for youth safety and policy integrity checks.' },
      { title: 'Public Charity Compliance Placeholder', detail: 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED.' },
      { title: 'Annual Filing Placeholder', detail: 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED.' },
      { title: 'Conflict of Interest Review Placeholder', detail: 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED.' },
      { title: 'Youth Safety Review Placeholder', detail: 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED.' },
      { title: 'Audit Monitoring Placeholder', detail: 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED.' },
    ],
    Documents: [
      { title: 'Document Registry', detail: 'Unified board documentation and record index.' },
      { title: 'Version Tracking', detail: 'Shared document review and publication workflow.' },
      { title: 'Retention Controls', detail: 'Governance record lifecycle controls visible to relevant seats.' },
    ],
    SHADOW: [
      { title: 'Governance SHADOW Feed', detail: 'Policy review reminders, governance deadlines, resolution follow-ups, committee oversight, and compliance alerts.' },
      { title: 'Boundary Enforcement', detail: 'No athlete data, coach data, parent records, or admin-only controls in this board SHADOW view.' },
      { title: 'Role-Aware Signals', detail: 'Each seat sees only governance signals that match role responsibilities.' },
    ],
  };

  return cardsByTab[tab];
}

export default function BoardMemberDashboard({ seat, overviewMetrics, links, allowedRoles }: Readonly<BoardMemberDashboardProps>) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('Overview');
  const modules = roleModulesBySeat[seat.slug];
  const shadowSignals = boardShadowSignals[seat.slug];
  const cards = useMemo(() => sharedTabCards(activeTab), [activeTab]);

  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
          <header className="flex flex-col gap-4 border-b-2 border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
            <div className="space-y-3">
              <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Board Workspace Framework</p>
              <h1 className="text-4xl font-black tracking-tight md:text-5xl">{seat.seatLabel} Workspace</h1>
              <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">One board workspace shell with role-specific visibility for nonprofit governance, mission stewardship, and strategic oversight.</p>
            </div>
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3 text-sm font-mono text-[var(--red-primary)]">{seat.seatLabel}</div>
          </header>

          <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">Nonprofit Identity</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {['Veteran-Owned', '501(c)(3) Public Charity', 'Mission-Focused Governance', 'Community Impact Oversight'].map((item) => (
                <div key={item} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-3 text-[16px] font-semibold text-[var(--black)]">
                  {item}
                </div>
              ))}
            </div>
          </section>

          <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <p className="text-xs font-mono uppercase tracking-[0.25em] text-[var(--red-primary)]">Board Overview Strip</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {overviewMetrics.map((metric) => (
                <article key={metric.label} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                  <p className="text-[12px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">{metric.label}</p>
                  <p className="mt-2 text-[22px] font-black text-[var(--black)]">{metric.value}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <p className="text-xs font-mono uppercase tracking-[0.25em] text-[var(--red-primary)]">Unified Governance Tabs</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-9">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`min-h-[44px] border px-3 text-sm font-bold transition ${
                    activeTab === tab
                      ? 'border-[var(--black)] bg-[var(--red-primary)] text-[var(--canvas-tan-light)]'
                      : 'border-[var(--black)] bg-[var(--canvas-tan)] text-[var(--black)] hover:bg-[var(--canvas-tan-dark)]'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="space-y-6">
              <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-2xl font-black text-[var(--black)]">{activeTab}</h2>
                <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">Shared board architecture for all seats with role-aware visibility and governance-only controls.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {cards.map((card) => (
                    <div key={card.title} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                      <p className="text-base font-bold text-[var(--black)]">{card.title}</p>
                      <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{card.detail}</p>
                    </div>
                  ))}
                </div>
              </article>

              <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-2xl font-black text-[var(--black)]">Role Description</h2>
                <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">{seat.roleDescription}</p>
                <h3 className="mt-4 text-lg font-black text-[var(--red-primary)]">Primary Responsibilities</h3>
                <ul className="mt-2 space-y-1 text-[15px] leading-7 text-[var(--gray-dark)]">
                  {seat.primaryResponsibilities.map((responsibility) => (
                    <li key={responsibility}>- {responsibility}</li>
                  ))}
                </ul>
              </article>

              <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-2xl font-black text-[var(--black)]">Role-Specific Modules</h2>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {modules.map((moduleGroup) => (
                    <div key={moduleGroup.title} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                      <p className="text-lg font-black text-[var(--black)]">{moduleGroup.title}</p>
                      <ul className="mt-2 space-y-1 text-sm leading-6 text-[var(--gray-dark)]">
                        {moduleGroup.items.map((item) => (
                          <li key={item}>- {item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </article>

              <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-2xl font-black text-[var(--black)]">Board SHADOW (Governance Only)</h2>
                <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">Role-specific governance SHADOW can surface policy review reminders, governance deadlines, resolution follow-ups, committee oversight, compliance alerts, filing deadlines, strategic review cycles, and risk alerts.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                    <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">Active Signals</p>
                    <ul className="mt-2 space-y-1 text-sm leading-6 text-[var(--gray-dark)]">
                      {shadowSignals.map((signal) => (
                        <li key={signal}>- {signal}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                    <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">Data Boundary</p>
                    <ul className="mt-2 space-y-1 text-sm leading-6 text-[var(--gray-dark)]">
                      <li>- Athlete data is not surfaced in board SHADOW.</li>
                      <li>- Coach data is not surfaced in board SHADOW.</li>
                      <li>- Parent records are not surfaced in board SHADOW.</li>
                      <li>- Admin-only controls are not surfaced in board SHADOW.</li>
                    </ul>
                  </div>
                </div>
              </article>
            </div>

            <aside className="grid gap-6">
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-xl font-black text-[var(--black)]">Governance Snapshot</h2>
                <div className="mt-4 grid gap-2">
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[var(--gray-dark)]">Board Actions Pending</p>
                    <p className="mt-1 text-2xl font-black text-[var(--black)]">{seat.openTasksCount}</p>
                  </div>
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[var(--gray-dark)]">Policy Reviews Due</p>
                    <p className="mt-1 text-2xl font-black text-[var(--black)]">{seat.pendingReviewsCount}</p>
                  </div>
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[var(--gray-dark)]">Compliance Calendar Events</p>
                    <p className="mt-1 text-2xl font-black text-[var(--black)]">{seat.meetingItemsCount}</p>
                  </div>
                  <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[var(--gray-dark)]">Risk Review Items</p>
                    <p className="mt-1 text-2xl font-black text-[var(--black)]">{seat.complianceItemsCount}</p>
                  </div>
                </div>
              </section>

              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
                <h2 className="text-xl font-black text-[var(--black)]">Workspace Links</h2>
                <div className="mt-3">
                  <ShadowChatButton context="Board Member Dashboard" />
                </div>
                <div className="mt-4 grid gap-2">
                  {links.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-sm font-bold text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                    >
                      {link.label}
                    </Link>
                  ))}
                  <Link
                    href="/board/compliance-monitoring"
                    className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-sm font-bold text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
                  >
                    Compliance Monitoring (Planned)
                  </Link>
                </div>
              </section>

              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-5">
                <h2 className="text-lg font-black text-[var(--black)]">No-Drift Architecture</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                  This seat runs inside one board workspace framework. Task, document, committee, policy, and SHADOW systems are unified and role-aware rather than duplicated per role.
                </p>
              </section>
            </aside>
          </section>
        </div>
      </main>
    </RoleSessionGate>
  );
}
