export type BoardSeatSlug =
  | 'president'
  | 'chair'
  | 'vice-chair'
  | 'treasurer'
  | 'secretary'
  | 'safety-director'
  | 'community-director'
  | 'at-large';

export interface BoardSeatConfig {
  slug: BoardSeatSlug;
  seatLabel: string;
  roleDescription: string;
  primaryResponsibilities: string[];
}

// The board surface holds no governance work records: there is no board task
// table, no policy-review queue, no meeting calendar and no risk register in
// pilot. A seat therefore has no counter behind it.
//
// Every seat used to carry four count fields -- openTasksCount,
// pendingReviewsCount, meetingItemsCount, complianceItemsCount -- all set to
// this string on all eight seats and rendered by nothing at all. Half a
// feature is worse than none of one, so the fields are gone and the sentence
// they were carrying is now rendered where it belongs: the workspace's own
// "not stored" panel, which lists exactly which records do not exist.
export const BOARD_RECORD_NOT_HELD = 'Not stored by this platform';

// Repeated verbatim on every seat workspace. This must stay character-identical
// to the aggregate boundary paragraph on the board hub (app/board/page.tsx):
// it is one of the few claims on this surface that server code enforces, and a
// seat page that softened it would be describing a boundary the platform does
// not have.
export const BOARD_AGGREGATE_BOUNDARY_STATEMENT =
  'Board access is organization-level and aggregate-only. Small cohorts are suppressed, missing data remains unavailable, and athlete records, messages, notes, intake records, video, and safety review remain outside this role. The only administrative control a seat carries is board seat assignment, held by the president.';

// President and Chair carry governance oversight of every other seat, so they
// open any seat workspace. No other seat reaches across.
export const BOARD_OVERSIGHT_SEATS: readonly BoardSeatSlug[] = ['president', 'chair'];

export const boardSeatConfigs: BoardSeatConfig[] = [
  {
    slug: 'president',
    seatLabel: 'President',
    roleDescription: 'Mission stewardship, governance leadership, and executive accountability for a veteran-founded 501(c)(3) public charity.',
    primaryResponsibilities: ['Mission stewardship', 'Strategic direction', 'Board effectiveness', 'Executive accountability'],
  },
  {
    slug: 'chair',
    seatLabel: 'Board Chair',
    roleDescription: 'Governance oversight, meeting governance quality, committee leadership, and board development.',
    primaryResponsibilities: ['Governance oversight', 'Meeting governance', 'Committee leadership', 'Board development'],
  },
  {
    slug: 'vice-chair',
    seatLabel: 'Vice Chair',
    roleDescription: 'Succession planning, governance continuity, leadership development, and committee coordination.',
    primaryResponsibilities: ['Succession planning', 'Governance continuity', 'Leadership development', 'Committee coordination'],
  },
  {
    slug: 'treasurer',
    seatLabel: 'Treasurer',
    roleDescription: 'Financial stewardship, grant oversight, reserve monitoring, and funding sustainability governance.',
    primaryResponsibilities: ['Financial stewardship', 'Grant oversight', 'Reserve monitoring', 'Funding sustainability'],
  },
  {
    slug: 'secretary',
    seatLabel: 'Secretary',
    roleDescription: 'Governance records stewardship, board action register integrity, and annual filing calendar management.',
    primaryResponsibilities: ['Governance records', 'Board action register', 'Annual filing calendar', 'Document integrity'],
  },
  {
    slug: 'safety-director',
    seatLabel: 'Program & Safety Director',
    roleDescription: 'Youth protection leadership, program compliance governance, risk management, and safety governance oversight.',
    primaryResponsibilities: ['Youth protection', 'Program compliance', 'Risk management', 'Safety governance'],
  },
  {
    slug: 'community-director',
    seatLabel: 'Community & Development Director',
    roleDescription: 'Community impact stewardship, partner development, fundraising oversight, and volunteer engagement governance.',
    primaryResponsibilities: ['Community impact', 'Partner development', 'Fundraising oversight', 'Volunteer engagement'],
  },
  {
    slug: 'at-large',
    seatLabel: 'Director-at-Large',
    roleDescription: 'Independent oversight with strategic project reviews and board accountability support.',
    primaryResponsibilities: ['Independent oversight', 'Strategic projects', 'Special reviews', 'Board accountability'],
  },
];

export const boardSeatMap: Record<BoardSeatSlug, BoardSeatConfig> = boardSeatConfigs.reduce((acc, seat) => {
  acc[seat.slug] = seat;
  return acc;
}, {} as Record<BoardSeatSlug, BoardSeatConfig>);

export function isBoardSeatSlug(value: unknown): value is BoardSeatSlug {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(boardSeatMap, value);
}

// board_seats on the session payload: every seat this account holds, as
// { seat, is_primary } rows out of pilot.board_seats. The session response is
// the only authority on which ones -- the browser never decides that for
// itself, and the field is absent for every non-board role. A gate reads all
// of them rather than the single board_seat landing value, because a small
// board doubles up and a member who holds two seats reaches both.
export function readBoardSeatsFromSession(payload: unknown): BoardSeatSlug[] {
  const raw = (payload as { board_seats?: unknown } | null | undefined)?.board_seats;
  if (!Array.isArray(raw)) {
    return [];
  }

  const slugs = raw
    .map((entry) => (entry as { seat?: unknown } | null | undefined)?.seat)
    .filter(isBoardSeatSlug);

  return [...new Set(slugs)];
}

export type BoardWorkspaceTab =
  | 'Overview'
  | 'Governance'
  | 'Strategy'
  | 'Meetings'
  | 'Tasks'
  | 'Policies'
  | 'Resolutions'
  | 'Committees'
  | 'Compliance'
  | 'Documents';

// 'built' is reserved for a card whose data a board member can load today.
// 'planned' carries the stamp and is the honest default: an unstamped card in
// the same visual treatment as a working one reads as shipped, and most of this
// catalogue describes modules no backend serves.
//
// A third state, 'boundary', existed only for the SHADOW tab's three cards and
// went with them. The boundary is stated once, in fiduciary voice, by
// BOARD_AGGREGATE_BOUNDARY_STATEMENT -- it was never a kind of card.
export type BoardCardStatus = 'built' | 'planned';

export interface BoardWorkspaceCard {
  title: string;
  detail: string;
  status: BoardCardStatus;
}

export const BOARD_PLANNED_STAMP = 'PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED';

export const boardWorkspaceTabs: BoardWorkspaceTab[] = [
  'Overview',
  'Governance',
  'Strategy',
  'Meetings',
  'Tasks',
  'Policies',
  'Resolutions',
  'Committees',
  'Compliance',
  'Documents',
];

// Two cards are backed by a route a board session can actually call:
// GET /api/pilot/board/summary and GET /api/pilot/board/compliance-summary.
// Everything else is a description of intended work and says so.
export const boardWorkspaceCards: Record<BoardWorkspaceTab, BoardWorkspaceCard[]> = {
  Overview: [
    { title: 'Organization Aggregate', detail: 'Active athletes, thirty-day training sessions and completion, goal status buckets, and coach review approval. Shown in the aggregate panel above.', status: 'built' },
    { title: 'Hand-Filed Compliance Register', detail: 'Organization-level counts of the compliance violations staff have filed, by severity and by status.', status: 'built' },
    { title: 'Mission Alignment', detail: 'Strategic priorities and mission stewardship checkpoints across the board.', status: 'planned' },
    { title: 'Board Action Register', detail: 'Open resolutions and governance actions needing board-level follow-up.', status: 'planned' },
    { title: 'Annual Governance Calendar', detail: 'Required meetings, filings, reports, and governance review milestones.', status: 'planned' },
  ],
  Governance: [
    { title: 'Bylaws', detail: 'Bylaws review posture and governance update cycle visibility.', status: 'planned' },
    { title: 'Resolutions', detail: 'Resolution register with draft, active, and closeout governance states.', status: 'planned' },
    { title: 'Governance Policies', detail: 'Policy oversight and scheduled review cadence for board governance.', status: 'planned' },
    { title: 'Strategic Plans', detail: 'Board-approved strategic plans and governance milestone checkpoints.', status: 'planned' },
    { title: 'Annual Reports', detail: 'Annual report readiness and board review progress.', status: 'planned' },
    { title: 'Board Action Register', detail: 'Board governance action logging and accountability tracking.', status: 'planned' },
  ],
  Strategy: [
    { title: 'Strategic Priorities', detail: 'Active strategic priorities and board-level review cadence.', status: 'planned' },
    { title: 'Mission Advancement', detail: 'Mission advancement outcomes and governance steering checkpoints.', status: 'planned' },
    { title: 'Community Impact', detail: 'Community impact oversight aligned to the nonprofit mission.', status: 'planned' },
    { title: 'Program Growth', detail: 'Program growth trends and their strategic governance implications.', status: 'planned' },
    { title: 'Facility Development', detail: 'Facility development oversight and long-range governance planning.', status: 'planned' },
    { title: 'Funding Sustainability', detail: 'Funding sustainability reviews in support of mission continuity.', status: 'planned' },
    { title: 'Volunteer Development', detail: 'Volunteer development strategy oversight and support pathways.', status: 'planned' },
  ],
  Meetings: [
    { title: 'Meeting Calendar', detail: 'Upcoming meetings, agenda readiness, and governance prep checkpoints.', status: 'planned' },
    { title: 'Agenda Packets', detail: 'Agenda package queue with seat-aware follow-up responsibilities.', status: 'planned' },
    { title: 'Action Capture', detail: 'Post-meeting action routing into a single board task system.', status: 'planned' },
  ],
  Tasks: [
    { title: 'Open Tasks Queue', detail: 'Board task queue filtered by seat responsibilities and due dates.', status: 'planned' },
    { title: 'Review Tasks', detail: 'Governance reviews tied to policy, compliance, and meeting outputs.', status: 'planned' },
    { title: 'Completion Signals', detail: 'Seat modules reading one task framework rather than duplicating it.', status: 'planned' },
  ],
  Policies: [
    { title: 'Policy Review Queue', detail: 'Policy pipeline with under-review and ready-for-vote states.', status: 'planned' },
    { title: 'Draft Coordination', detail: 'Cross-seat editing and review checkpoints for policy changes.', status: 'planned' },
    { title: 'Policy Outcomes', detail: 'Promotion into resolutions and compliance follow-up tasks.', status: 'planned' },
  ],
  Resolutions: [
    { title: 'Resolution Registry', detail: 'Board-wide registry of draft, active, and archived resolutions.', status: 'planned' },
    { title: 'Vote Readiness', detail: 'Resolution packet quality checks ahead of governance voting sessions.', status: 'planned' },
    { title: 'Execution Tracking', detail: 'Resolution actions routed back into tasks and committees.', status: 'planned' },
  ],
  Committees: [
    { title: 'Committee Workboard', detail: 'Committee workspace with seat-aware views and contribution tracking.', status: 'planned' },
    { title: 'Committee Actions', detail: 'Committee actions flowing into the task and meeting systems.', status: 'planned' },
    { title: 'Coordination Signals', detail: 'Inter-committee dependency visibility for continuity planning.', status: 'planned' },
  ],
  Compliance: [
    { title: 'Hand-Filed Compliance Register', detail: 'Counts of the violations staff have filed, by severity and by status. No detector produces these: every row was entered by a person.', status: 'built' },
    { title: 'Compliance Watchlist', detail: 'Open compliance items with due-date pressure and status progression.', status: 'planned' },
    { title: 'Policy Review Queue', detail: 'Policy review flow with required review dates and board escalation.', status: 'planned' },
    { title: 'Required Review Dates', detail: 'Date-bound compliance obligations for board cycle planning and closeout.', status: 'planned' },
    { title: 'Board Compliance Alerts', detail: 'Board alert feed for compliance exceptions and governance reminders.', status: 'planned' },
    { title: 'Safety Governance Monitoring', detail: 'Safety governance lane for youth safety and policy integrity checks.', status: 'planned' },
    { title: 'Public Charity Compliance', detail: 'Public charity obligation tracking for the 501(c)(3) status.', status: 'planned' },
    { title: 'Annual Filing', detail: 'Annual filing readiness and completion tracking.', status: 'planned' },
    { title: 'Conflict of Interest Review', detail: 'Conflict of interest disclosure and review cycle.', status: 'planned' },
    { title: 'Youth Safety Review', detail: 'Youth safety review cycle at the governance level.', status: 'planned' },
    { title: 'Audit Monitoring', detail: 'Audit readiness and finding closure tracking.', status: 'planned' },
  ],
  Documents: [
    { title: 'Document Registry', detail: 'Board documentation and record index.', status: 'planned' },
    { title: 'Version Tracking', detail: 'Document review and publication workflow.', status: 'planned' },
    { title: 'Retention Controls', detail: 'Governance record lifecycle controls visible to the relevant seats.', status: 'planned' },
  ],
};

// An eleventh tab used to read 'SHADOW' and hold three cards narrating what
// board SHADOW will not do. Every word of it was true and none of it belonged:
// the room's rule is not "say no to SHADOW here", it is that the word does not
// appear on this wall at all. BOARD_AGGREGATE_BOUNDARY_STATEMENT states the
// same limit in fiduciary voice and every seat page renders it -- once on the
// hub, once on the workspace. Nothing enforced is lost; the enforcement was
// never in the copy.

export type BoardTabStatus = 'partly-built' | 'planned';

// The tab strip rendered eleven identical buttons over a catalogue that is
// mostly placeholder, so a fiduciary only found that out by clicking. This is
// not a new fact -- it is read off the cards declared above, so a tab cannot
// say 'planned' while holding something built, or the reverse.
export function boardTabStatus(tab: BoardWorkspaceTab): BoardTabStatus {
  return boardWorkspaceCards[tab].some((card) => card.status === 'built')
    ? 'partly-built'
    : 'planned';
}

export const BOARD_TAB_PLANNED_STAMP = 'Planned';

export type BoardSeatAccessMode = 'seat-holder' | 'governance-oversight' | 'platform-observer';

export type BoardSeatAccess =
  | { allowed: true; mode: BoardSeatAccessMode }
  | { allowed: false; redirectTo: '/board' };

// Display convenience only. Every board API re-derives the caller's role and
// organization from the server session, so a client that got this wrong would
// render a workspace whose requests still refuse it.
export function resolveBoardSeatAccess(input: {
  role: 'board' | 'platform_owner' | null;
  seats: readonly BoardSeatSlug[];
  seat: BoardSeatSlug;
}): BoardSeatAccess {
  if (input.role === 'platform_owner') {
    return { allowed: true, mode: 'platform-observer' };
  }

  if (input.role !== 'board') {
    return { allowed: false, redirectTo: '/board' };
  }

  if (input.seats.includes(input.seat)) {
    return { allowed: true, mode: 'seat-holder' };
  }

  if (input.seats.some((held) => BOARD_OVERSIGHT_SEATS.includes(held))) {
    return { allowed: true, mode: 'governance-oversight' };
  }

  return { allowed: false, redirectTo: '/board' };
}
