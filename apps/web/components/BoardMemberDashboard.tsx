'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import RoleSessionGate from './RoleSessionGate';
import type { ClubRole } from './roleRoutes';
import type { BoardOverviewMetric, BoardSeatConfig, BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

type WorkspaceTab =
  | 'Overview'
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

const tabs: WorkspaceTab[] = ['Overview', 'Meetings', 'Tasks', 'Policies', 'Resolutions', 'Committees', 'Compliance', 'Documents', 'SHADOW'];

const roleModulesBySeat: Record<BoardSeatSlug, ModuleGroup[]> = {
  president: [
    { title: 'Strategic Priorities', items: ['Annual goals alignment', 'Cross-seat priority alignment', 'Quarterly governance cadence'] },
    { title: 'Organizational Health', items: ['Seat workload balance', 'Governance risk posture', 'Stability checkpoint reviews'] },
    { title: 'Meeting Oversight', items: ['Meeting agenda validation', 'Vote readiness checks', 'Facilitation checkpoints'] },
    { title: 'Executive Actions', items: ['Executive follow-up queue', 'Escalation approvals', 'Board execution sign-off'] },
  ],
  chair: [
    { title: 'Strategic Priorities', items: ['Board direction continuity', 'Meeting governance quality', 'Decision-flow consistency'] },
    { title: 'Organizational Health', items: ['Open issue visibility', 'Board readiness pulse', 'Role coordination health'] },
    { title: 'Meeting Oversight', items: ['Agenda sequencing', 'Timebox and quorum checks', 'Decision closure tracking'] },
    { title: 'Executive Actions', items: ['Action owner assignment', 'Post-meeting execution', 'Cross-seat resolution flow'] },
  ],
  'vice-chair': [
    { title: 'Committee Coordination', items: ['Committee cadence map', 'Owner follow-up coverage', 'Cross-committee dependency tracking'] },
    { title: 'Continuity Planning', items: ['Leadership backup routes', 'Meeting continuity protocol', 'Critical process handoff status'] },
    { title: 'Meeting Support', items: ['Agenda readiness support', 'Vote logistics support', 'Follow-up packaging support'] },
  ],
  treasurer: [
    { title: 'Budget Review', items: ['Budget variance watchlist', 'Program allocation review', 'Monthly budget check cycle'] },
    { title: 'Financial Tracking', items: ['Ledger control checkpoints', 'Financial status snapshots', 'Spending verification queue'] },
    { title: 'Grant Monitoring', items: ['Grant timeline milestones', 'Funding compliance watch', 'Grant report readiness'] },
    { title: 'Financial Tasks', items: ['Actionable finance tasks', 'Approval queue', 'Financial follow-up ledger'] },
  ],
  secretary: [
    { title: 'Minutes', items: ['Draft minutes queue', 'Approval-ready minutes', 'Distribution readiness'] },
    { title: 'Meeting Records', items: ['Attendance register', 'Meeting archive quality', 'Session index updates'] },
    { title: 'Resolution Registry', items: ['Resolution indexing', 'Resolution state tracking', 'Resolution publication checks'] },
    { title: 'Document Management', items: ['Governance document lifecycle', 'Version check queue', 'Record retention checkpoints'] },
  ],
  'safety-director': [
    { title: 'Safety Reviews', items: ['Safety protocol reviews', 'Critical safety follow-ups', 'Readiness gate checks'] },
    { title: 'Incident Oversight', items: ['Incident review queue', 'Corrective action oversight', 'Incident closeout tracking'] },
    { title: 'Compliance Review', items: ['Policy-to-practice checks', 'Safety compliance readiness', 'Review backlog governance'] },
    { title: 'Youth Protection', items: ['Youth protection checklist', 'Sensitive process safeguards', 'Protection policy status'] },
  ],
  'community-director': [
    { title: 'Partnerships', items: ['Partnership pipeline', 'Partner action follow-ups', 'Partner governance coordination'] },
    { title: 'Fundraising', items: ['Campaign planning status', 'Contribution tracking visibility', 'Execution checkpoint tracking'] },
    { title: 'Grant Opportunities', items: ['Opportunity watchlist', 'Submission calendar alignment', 'Grant readiness tasks'] },
    { title: 'Volunteer Development', items: ['Volunteer lane coordination', 'Volunteer readiness signals', 'Support development tasks'] },
  ],
  'at-large': [
    { title: 'Voting Items', items: ['Vote packet review', 'Vote timeline watchlist', 'Vote readiness tracking'] },
    { title: 'Special Projects', items: ['Special project backlog', 'Independent project oversight', 'Cross-role support tasks'] },
    { title: 'General Oversight', items: ['Cross-workspace health scan', 'Policy and task alignment scan', 'Governance gap watch'] },
  ],
};

const boardShadowSignals: Record<BoardSeatSlug, string[]> = {
  president: ['Task deadline: Annual strategy actions due in 4 days', 'Meeting item: Agenda approval packet awaiting sign-off', 'Policy review: Governance escalation policy requires final pass'],
  chair: ['Meeting item: Quorum planning reminders for next session', 'Committee action: Committee updates pending consolidation', 'Task deadline: Action owner assignment due in 2 days'],
  'vice-chair': ['Committee action: Cross-committee sync pending', 'Task deadline: Continuity protocol review due tomorrow', 'Meeting item: Backup facilitation checklist incomplete'],
  treasurer: ['Task deadline: Budget variance review due in 3 days', 'Compliance reminder: Grant financial control checklist pending', 'Policy review: Financial policy addendum in review queue'],
  secretary: ['Meeting item: Minutes approval pending for prior session', 'Task deadline: Resolution registry update due in 1 day', 'Policy review: Record retention policy open for edits'],
  'safety-director': ['Compliance reminder: Youth safety checklist requires closeout', 'Task deadline: Incident follow-up due in 24 hours', 'Policy review: Safety gate policy under revision'],
  'community-director': ['Committee action: Partnership follow-up tasks due this week', 'Task deadline: Fundraising status update due in 2 days', 'Compliance reminder: Grant documentation prep pending'],
  'at-large': ['Voting item: Special project vote packet pending review', 'Task deadline: Independent oversight note due in 3 days', 'Policy review: General governance policy currently open'],
};

function sharedTabCards(tab: WorkspaceTab) {
  const cardsByTab: Record<WorkspaceTab, Array<{ title: string; detail: string }>> = {
    Overview: [
      { title: 'Board Seat Context', detail: 'Role-aware governance modules with one shared board workspace shell.' },
      { title: 'Governance Workflow', detail: 'Unified meeting, policy, task, and compliance operations across all seats.' },
      { title: 'Visibility Boundary', detail: 'Board SHADOW exposes governance-only reminders and no athlete, coach, parent, or admin-only data.' },
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
      { title: 'Compliance Watchlist', detail: 'Open compliance items, due-date pressure, and status progression.' },
      { title: 'Risk Signals', detail: 'Governance risk reminders aligned with policy and safety obligations.' },
      { title: 'Remediation Routing', detail: 'Compliance tasks route to responsible seat modules in one system.' },
    ],
    Documents: [
      { title: 'Document Registry', detail: 'Unified board documentation and record index.' },
      { title: 'Version Tracking', detail: 'Shared document review and publication workflow.' },
      { title: 'Retention Controls', detail: 'Governance record lifecycle controls visible to relevant seats.' },
    ],
    SHADOW: [
      { title: 'Governance SHADOW Feed', detail: 'Task deadlines, meeting items, policy reviews, committee actions, and compliance reminders.' },
      { title: 'Boundary Enforcement', detail: 'No athlete data, coach data, parent records, or admin-only controls in this board SHADOW view.' },
      { title: 'Role-Aware Signals', detail: 'Each seat sees only governance signals that match role responsibilities.' },
    ],
  };

  return cardsByTab[tab];
}

export default function BoardMemberDashboard({ seat, overviewMetrics, links, allowedRoles }: BoardMemberDashboardProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('Overview');
  const modules = roleModulesBySeat[seat.slug];
  const shadowSignals = boardShadowSignals[seat.slug];
  const cards = useMemo(() => sharedTabCards(activeTab), [activeTab]);

  return (
    <RoleSessionGate allowedRoles={allowedRoles}>
      <main className="min-h-screen bg-linear-gradient(180deg,#0a0a0a 0%,#0f0f0f 100%) text-[#e8d7c6]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
          <header className="flex flex-col gap-4 border-b-2 border-[#8b4444] pb-6 md:flex-row md:items-end md:justify-between">
            <div className="space-y-3">
              <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]/80">Board Workspace Framework</p>
              <h1 className="text-4xl font-black tracking-tight md:text-5xl">{seat.seatLabel} Workspace</h1>
              <p className="max-w-4xl text-base leading-7 text-[#d9c8b8] md:text-lg">One board workspace shell with role-specific visibility. No duplicated task, document, or SHADOW systems.</p>
            </div>
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 px-4 py-3 text-sm font-mono text-[#d4a574]">{seat.seatLabel}</div>
          </header>

          <section className="mt-6 border-2 border-[#8b4444] bg-[#121212] p-5">
            <p className="text-xs font-mono uppercase tracking-[0.25em] text-[#d4a574]">Board Overview Strip</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {overviewMetrics.map((metric) => (
                <article key={metric.label} className="border border-[#694838] bg-[#0f0f0f] p-3">
                  <p className="text-[12px] font-mono uppercase tracking-[0.14em] text-[#a89181]">{metric.label}</p>
                  <p className="mt-2 text-[22px] font-black text-[#e8d7c6]">{metric.value}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="mt-6 border-2 border-[#8b4444] bg-[#121212] p-5">
            <p className="text-xs font-mono uppercase tracking-[0.25em] text-[#d4a574]">Unified Tabs</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-9">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`min-h-[44px] border px-3 text-sm font-bold transition ${
                    activeTab === tab
                      ? 'border-[#d4a574] bg-[#2b1a12] text-[#e8d7c6]'
                      : 'border-[#694838] bg-[#101010] text-[#c8b7a7] hover:border-[#8b4444]'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="space-y-6">
              <article className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-2xl font-black text-[#e8d7c6]">{activeTab}</h2>
                <p className="mt-2 text-base leading-7 text-[#cbb8a8]">Shared board architecture for all seats with role-aware visibility and governance-only controls.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {cards.map((card) => (
                    <div key={card.title} className="border border-[#694838] bg-[#101010] p-4">
                      <p className="text-base font-bold text-[#e8d7c6]">{card.title}</p>
                      <p className="mt-2 text-sm leading-6 text-[#bca997]">{card.detail}</p>
                    </div>
                  ))}
                </div>
              </article>

              <article className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-2xl font-black text-[#e8d7c6]">Role Description</h2>
                <p className="mt-2 text-base leading-7 text-[#cbb8a8]">{seat.roleDescription}</p>
                <h3 className="mt-4 text-lg font-black text-[#d4a574]">Primary Responsibilities</h3>
                <ul className="mt-2 space-y-1 text-[15px] leading-7 text-[#cbb8a8]">
                  {seat.primaryResponsibilities.map((responsibility) => (
                    <li key={responsibility}>- {responsibility}</li>
                  ))}
                </ul>
              </article>

              <article className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-2xl font-black text-[#e8d7c6]">Role-Specific Modules</h2>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {modules.map((moduleGroup) => (
                    <div key={moduleGroup.title} className="border border-[#694838] bg-[#101010] p-4">
                      <p className="text-lg font-black text-[#e8d7c6]">{moduleGroup.title}</p>
                      <ul className="mt-2 space-y-1 text-sm leading-6 text-[#bca997]">
                        {moduleGroup.items.map((item) => (
                          <li key={item}>- {item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </article>

              <article className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-2xl font-black text-[#e8d7c6]">Board SHADOW (Governance Only)</h2>
                <p className="mt-2 text-base leading-7 text-[#cbb8a8]">Role-specific governance SHADOW can surface task deadlines, meeting items, policy reviews, committee actions, and compliance reminders.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="border border-[#694838] bg-[#101010] p-4">
                    <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[#d4a574]">Active Signals</p>
                    <ul className="mt-2 space-y-1 text-sm leading-6 text-[#bca997]">
                      {shadowSignals.map((signal) => (
                        <li key={signal}>- {signal}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="border border-[#694838] bg-[#101010] p-4">
                    <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[#d4a574]">Data Boundary</p>
                    <ul className="mt-2 space-y-1 text-sm leading-6 text-[#bca997]">
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
              <section className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-xl font-black text-[#e8d7c6]">Seat Workload</h2>
                <div className="mt-4 grid gap-2">
                  <div className="border border-[#694838] bg-[#101010] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[#a89181]">Open Tasks</p>
                    <p className="mt-1 text-2xl font-black text-[#e8d7c6]">{seat.openTasksCount}</p>
                  </div>
                  <div className="border border-[#694838] bg-[#101010] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[#a89181]">Pending Reviews</p>
                    <p className="mt-1 text-2xl font-black text-[#e8d7c6]">{seat.pendingReviewsCount}</p>
                  </div>
                  <div className="border border-[#694838] bg-[#101010] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[#a89181]">Meeting Items</p>
                    <p className="mt-1 text-2xl font-black text-[#e8d7c6]">{seat.meetingItemsCount}</p>
                  </div>
                  <div className="border border-[#694838] bg-[#101010] p-3">
                    <p className="text-xs font-mono uppercase tracking-[0.13em] text-[#a89181]">Compliance Items</p>
                    <p className="mt-1 text-2xl font-black text-[#e8d7c6]">{seat.complianceItemsCount}</p>
                  </div>
                </div>
              </section>

              <section className="border-2 border-[#8b4444] bg-[#121212] p-5">
                <h2 className="text-xl font-black text-[#e8d7c6]">Workspace Links</h2>
                <div className="mt-4 grid gap-2">
                  {links.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="inline-flex min-h-[44px] items-center border border-[#694838] bg-[#101010] px-3 text-sm font-bold text-[#d9c8b8] transition hover:border-[#d4a574] hover:text-[#d4a574]"
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </section>

              <section className="border-2 border-[#8b4444]/70 bg-[#2a1414]/40 p-5">
                <h2 className="text-lg font-black text-[#e8d7c6]">No-Drift Architecture</h2>
                <p className="mt-2 text-sm leading-6 text-[#d9c8b8]">
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
