'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import BoardSeatEvidence from './BoardSeatEvidence';
import { useBoardSession } from './BoardRoleGate';
import BoardSummaryPanel from '@/app/board/BoardSummaryPanel';
import {
  BOARD_AGGREGATE_BOUNDARY_STATEMENT,
  BOARD_PLANNED_STAMP,
  boardWorkspaceCards,
  boardWorkspaceTabs,
  resolveBoardSeatAccess,
  type BoardCardStatus,
  type BoardSeatAccessMode,
  type BoardSeatConfig,
  type BoardSeatSlug,
  type BoardWorkspaceTab,
} from '@/app/board/boardWorkspaceConfig';

interface BoardMemberDashboardProps {
  seat: BoardSeatConfig;
  links: ReadonlyArray<{ label: string; href: string }>;
}

interface ModuleGroup {
  title: string;
  items: string[];
}

const cardStatusLabel: Record<BoardCardStatus, string> = {
  built: 'Available now',
  planned: BOARD_PLANNED_STAMP,
  boundary: 'Enforced boundary',
};

const seatAccessNotice: Record<BoardSeatAccessMode, string> = {
  'seat-holder': 'You hold this seat.',
  'governance-oversight': 'Opened under the President/Chair governance oversight of every seat.',
  'platform-observer': 'Platform owner view. Read-only, and no board seat is held.',
};

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

export default function BoardMemberDashboard({ seat, links }: Readonly<BoardMemberDashboardProps>) {
  const router = useRouter();
  const session = useBoardSession();
  const [activeTab, setActiveTab] = useState<BoardWorkspaceTab>('Overview');
  const modules = roleModulesBySeat[seat.slug];
  const cards = boardWorkspaceCards[activeTab];

  const access = useMemo(
    () => resolveBoardSeatAccess({
      role: session?.role ?? null,
      seats: session?.seats ?? [],
      seat: seat.slug,
    }),
    [session, seat.slug],
  );

  useEffect(() => {
    if (!access.allowed) {
      router.replace(access.redirectTo);
    }
  }, [access, router]);

  // A board member who does not hold this seat is still a board member. The hub
  // is theirs, so this leaves rather than refusing.
  if (!access.allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="max-w-xl text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Board Seat</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">Opening the board hub</h1>
          <p className="mt-3 text-base leading-7 text-[var(--gray-dark)]">
            The {seat.seatLabel} workspace opens for the holders of that seat and for the President and Chair. Every board member reaches the same aggregate hub.
          </p>
          <Link
            href="/board"
            className="mt-5 inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-5 text-sm font-bold uppercase tracking-[0.12em] text-[var(--black)]"
          >
            Board hub
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-2 border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Board Workspace Framework</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">{seat.seatLabel} Workspace</h1>
            <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">One board workspace shell with seat-specific visibility for nonprofit governance, mission stewardship, and strategic oversight.</p>
          </div>
          <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3 text-sm font-mono text-[var(--safety-locked)]">{seat.seatLabel}</div>
        </header>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--safety-locked)]">Seat Access</p>
          <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">{seatAccessNotice[access.mode]}</p>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            This notice describes what the page displays. Access is decided by the server on every request, and no choice made in this browser widens it.
          </p>
        </section>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <h2 className="text-lg font-black text-[var(--black)]">Aggregate boundary</h2>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            {BOARD_AGGREGATE_BOUNDARY_STATEMENT}
          </p>
        </section>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--safety-locked)]">Nonprofit Identity</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {['Veteran-Founded', '501(c)(3) Public Charity', 'Mission-Focused Governance', 'Community Impact Oversight'].map((item) => (
              <div key={item} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-3 text-[16px] font-semibold text-[var(--black)]">
                {item}
              </div>
            ))}
          </div>
        </section>

        <div className="mt-6">
          <BoardSummaryPanel variant="workspace" heading="Organization Aggregate" />
        </div>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.25em] text-[var(--safety-locked)]">Governance Modules</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-9">
            {boardWorkspaceTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`min-h-[44px] border px-3 text-sm font-bold transition ${
                  activeTab === tab
                    ? 'border-[var(--black)] bg-[var(--safety-locked)] text-[var(--canvas-tan-light)]'
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
              <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">
                Every card states its own condition. A card marked {BOARD_PLANNED_STAMP} describes intended work and has nothing behind it.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {cards.map((card) => (
                  <div key={card.title} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--safety-locked)]">{cardStatusLabel[card.status]}</p>
                    <p className="mt-2 text-base font-bold text-[var(--black)]">{card.title}</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{card.detail}</p>
                  </div>
                ))}
              </div>
            </article>

            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
              <h2 className="text-2xl font-black text-[var(--black)]">Role Description</h2>
              <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">{seat.roleDescription}</p>
              <h3 className="mt-4 text-lg font-black text-[var(--safety-locked)]">Primary Responsibilities</h3>
              <ul className="mt-2 space-y-1 text-[15px] leading-7 text-[var(--gray-dark)]">
                {seat.primaryResponsibilities.map((responsibility) => (
                  <li key={responsibility}>- {responsibility}</li>
                ))}
              </ul>
            </article>

            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
              <h2 className="text-2xl font-black text-[var(--black)]">Seat Modules</h2>
              <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--safety-locked)]">{BOARD_PLANNED_STAMP}</p>
              <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">
                The scope this seat is meant to cover. None of it reads or writes data yet.
              </p>
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

            <BoardSeatEvidence seat={seat.slug} />

            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
              <h2 className="text-2xl font-black text-[var(--black)]">Board intelligence unavailable</h2>
              <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">Board chat and generated background summaries remain disabled. Only the authenticated organization-aggregate summary API is available.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[var(--safety-locked)]">Generation status</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">Disabled. No model call or background Board job is available.</p>
                </div>
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-[13px] font-mono uppercase tracking-[0.14em] text-[var(--safety-locked)]">Data Boundary</p>
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
              <h2 className="text-xl font-black text-[var(--black)]">Not stored by this platform</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                None of the following exists as a record here, for this seat or any other. There is no figure to load and none is being withheld.
              </p>
              <ul className="mt-3 space-y-1 text-sm leading-6 text-[var(--gray-dark)]">
                <li>- Board actions and their status</li>
                <li>- Policy reviews and due dates</li>
                <li>- Meeting and compliance calendars</li>
                <li>- Risk register entries</li>
                <li>- Financial reserves, grants, and budgets</li>
                <li>- Annual filings</li>
              </ul>
            </section>

            <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
              <h2 className="text-xl font-black text-[var(--black)]">Workspace Links</h2>
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
                  Hand-Filed Compliance Register
                </Link>
              </div>
            </section>

            <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-5">
              <h2 className="text-lg font-black text-[var(--black)]">One workspace shell</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Every seat runs the same workspace. What differs between seats is which of them may open a given page, and the seat description on it.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
