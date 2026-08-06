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
      <main className="room--board grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        {/* Raised leather rather than bare wall: centred content can straddle
            the board room's plaster/wainscot seam, and a panel carries its own
            ground on either side of it. */}
        <div className="mat-leather--raised max-w-xl rounded-[var(--r-lg)] p-[var(--s6)] text-center">
          <p className="t-eyebrow tracking-[0.35em]">Board Seat</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Opening the board hub</h1>
          <p className="t-body mt-[var(--s3)]">
            The {seat.seatLabel} workspace opens for the holders of that seat and for the President and Chair. Every board member reaches the same aggregate hub.
          </p>
          <Link
            href="/board"
            className="btn btn--ghost mt-[var(--s5)]"
          >
            Board hub
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        {/* The header stands on the board room's plaster upper wall, so it is
            written in dark ink by hand: the .t-* voices pin the light colours
            that belong on the leather panels below, and an unlayered voice
            class cannot be re-coloured by a utility. */}
        <header className="on-plaster flex flex-col gap-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] md:flex-row md:items-end md:justify-between">
          <div className="space-y-[var(--s3)]">
            <p className="t-eyebrow tracking-[0.35em]">Board Workspace Framework</p>
            <h1 className="t-command text-[length:var(--t-2xl)] md:text-[length:var(--t-3xl)]">{seat.seatLabel} Workspace</h1>
            <p className="t-body max-w-[80ch]">One board workspace shell with seat-specific visibility for nonprofit governance, mission stewardship, and strategic oversight.</p>
          </div>
          <div className="plaque">{seat.seatLabel}</div>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] mt-[var(--s5)]">
          <p className="t-eyebrow">Seat Access</p>
          <p className="t-body mt-[var(--s3)]">{seatAccessNotice[access.mode]}</p>
          <p className="t-body mt-[var(--s3)]">
            This notice describes what the page displays. Access is decided by the server on every request, and no choice made in this browser widens it.
          </p>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] mt-[var(--s5)]">
          <h2 className="t-command">Aggregate boundary</h2>
          <p className="t-body mt-[var(--s3)] max-w-[80ch]">
            {BOARD_AGGREGATE_BOUNDARY_STATEMENT}
          </p>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] mt-[var(--s5)]">
          <p className="t-eyebrow">Nonprofit Identity</p>
          <div className="mt-[var(--s3)] grid gap-[var(--s2)] md:grid-cols-2 xl:grid-cols-4">
            {['Veteran-Founded', '501(c)(3) Public Charity', 'Mission-Focused Governance', 'Community Impact Oversight'].map((item) => (
              <div key={item} className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s4)] t-command">
                {item}
              </div>
            ))}
          </div>
        </section>

        <div className="mt-[var(--s5)]">
          <BoardSummaryPanel variant="workspace" heading="Organization Aggregate" />
        </div>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] mt-[var(--s5)]">
          <p className="t-eyebrow">Governance Modules</p>
          <div className="mt-[var(--s4)] grid gap-[var(--s2)] sm:grid-cols-3 xl:grid-cols-9">
            {boardWorkspaceTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`min-h-[44px] rounded-[var(--r-sm)] border px-[var(--s3)] text-[length:var(--t-sm)] font-bold transition ${
                  activeTab === tab
                    ? 'mat-brass--patina border-[color:var(--brass-600)] text-[color:var(--hide-950)]'
                    : 'border-[color:rgba(212,175,74,.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-[var(--s5)] grid gap-[var(--s5)] lg:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-[var(--s5)]">
            <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command">{activeTab}</h2>
              <p className="t-body mt-[var(--s3)]">
                Every card states its own condition. A card marked {BOARD_PLANNED_STAMP} describes intended work and has nothing behind it.
              </p>
              <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-3">
                {cards.map((card) => (
                  <div key={card.title} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    {card.status === 'planned' ? (
                      // A card with nothing behind it wears the refusal as
                      // static ink (Law 7), not as another eyebrow that reads
                      // like chrome on a working module.
                      <p><span className="stamp stamp--flat">{cardStatusLabel[card.status]}</span></p>
                    ) : (
                      <p className="t-eyebrow">{cardStatusLabel[card.status]}</p>
                    )}
                    <p className="t-command mt-[var(--s3)]">{card.title}</p>
                    <p className="t-body mt-[var(--s3)]">{card.detail}</p>
                  </div>
                ))}
              </div>
            </article>

            <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command">Role Description</h2>
              <p className="t-body mt-[var(--s3)]">{seat.roleDescription}</p>
              <h3 className="t-command--brass t-command mt-[var(--s4)]">Primary Responsibilities</h3>
              <ul className="t-body mt-[var(--s3)] space-y-[var(--s1)]">
                {seat.primaryResponsibilities.map((responsibility) => (
                  <li key={responsibility}>- {responsibility}</li>
                ))}
              </ul>
            </article>

            <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command">Seat Modules</h2>
              <p className="mt-[var(--s3)]"><span className="stamp stamp--flat">{BOARD_PLANNED_STAMP}</span></p>
              <p className="t-body mt-[var(--s3)]">
                The scope this seat is meant to cover. None of it reads or writes data yet.
              </p>
              <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2">
                {modules.map((moduleGroup) => (
                  <div key={moduleGroup.title} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-command">{moduleGroup.title}</p>
                    <ul className="t-body mt-[var(--s3)] space-y-[var(--s1)]">
                      {moduleGroup.items.map((item) => (
                        <li key={item}>- {item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>

            <BoardSeatEvidence seat={seat.slug} />

            <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                <h2 className="t-command">Board intelligence unavailable</h2>
                {/* Law 7: a governance refusal is pressed in ink, not narrated. */}
                <span className="stamp stamp--flat">
                  <span aria-hidden="true">✕ </span>
                  <span>Disabled</span>
                </span>
              </div>
              <p className="t-body mt-[var(--s3)]">Board chat and generated background summaries remain disabled. Only the authenticated organization-aggregate summary API is available.</p>
              <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2">
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-eyebrow">Generation status</p>
                  <p className="t-body mt-[var(--s3)]">Disabled. No model call or background Board job is available.</p>
                </div>
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-eyebrow">Data Boundary</p>
                  <ul className="t-body mt-[var(--s3)] space-y-[var(--s1)]">
                    <li>- Athlete data is not surfaced in board SHADOW.</li>
                    <li>- Coach data is not surfaced in board SHADOW.</li>
                    <li>- Parent records are not surfaced in board SHADOW.</li>
                    <li>- Admin-only controls are not surfaced in board SHADOW.</li>
                  </ul>
                </div>
              </div>
            </article>
          </div>

          <aside className="grid gap-[var(--s5)]">
            <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command">Not stored by this platform</h2>
              <p className="t-body mt-[var(--s3)]">
                None of the following exists as a record here, for this seat or any other. There is no figure to load and none is being withheld.
              </p>
              <ul className="t-body mt-[var(--s3)] space-y-[var(--s1)]">
                <li>- Board actions and their status</li>
                <li>- Policy reviews and due dates</li>
                <li>- Meeting and compliance calendars</li>
                <li>- Risk register entries</li>
                <li>- Financial reserves, grants, and budgets</li>
                <li>- Annual filings</li>
              </ul>
            </section>

            <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command">Workspace Links</h2>
              <div className="mt-[var(--s4)] grid gap-[var(--s2)]">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="btn btn--ghost"
                  >
                    {link.label}
                  </Link>
                ))}
                <Link
                  href="/board/compliance-monitoring"
                  className="btn btn--ghost"
                >
                  Hand-Filed Compliance Register
                </Link>
              </div>
            </section>

            <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)]">
              <h2 className="t-command">One workspace shell</h2>
              <p className="t-body mt-[var(--s3)]">
                Every seat runs the same workspace. What differs between seats is which of them may open a given page, and the seat description on it.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
