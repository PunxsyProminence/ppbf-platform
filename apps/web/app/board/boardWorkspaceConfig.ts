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
  openTasksCount: string;
  pendingReviewsCount: string;
  meetingItemsCount: string;
  complianceItemsCount: string;
}

// The board surface holds no governance work records: there is no board task
// table, no policy-review queue, no meeting calendar and no risk register in
// pilot. A seat therefore has no counter behind it, and the four seat fields
// below say so outright. A tile is only allowed to carry a figure the platform
// can actually produce -- a placeholder that reads like a failed load tells a
// fiduciary a number exists somewhere, which is the one thing these must never
// do.
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
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'chair',
    seatLabel: 'Board Chair',
    roleDescription: 'Governance oversight, meeting governance quality, committee leadership, and board development.',
    primaryResponsibilities: ['Governance oversight', 'Meeting governance', 'Committee leadership', 'Board development'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'vice-chair',
    seatLabel: 'Vice Chair',
    roleDescription: 'Succession planning, governance continuity, leadership development, and committee coordination.',
    primaryResponsibilities: ['Succession planning', 'Governance continuity', 'Leadership development', 'Committee coordination'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'treasurer',
    seatLabel: 'Treasurer',
    roleDescription: 'Financial stewardship, grant oversight, reserve monitoring, and funding sustainability governance.',
    primaryResponsibilities: ['Financial stewardship', 'Grant oversight', 'Reserve monitoring', 'Funding sustainability'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'secretary',
    seatLabel: 'Secretary',
    roleDescription: 'Governance records stewardship, board action register integrity, and annual filing calendar management.',
    primaryResponsibilities: ['Governance records', 'Board action register', 'Annual filing calendar', 'Document integrity'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'safety-director',
    seatLabel: 'Program & Safety Director',
    roleDescription: 'Youth protection leadership, program compliance governance, risk management, and safety governance oversight.',
    primaryResponsibilities: ['Youth protection', 'Program compliance', 'Risk management', 'Safety governance'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'community-director',
    seatLabel: 'Community & Development Director',
    roleDescription: 'Community impact stewardship, partner development, fundraising oversight, and volunteer engagement governance.',
    primaryResponsibilities: ['Community impact', 'Partner development', 'Fundraising oversight', 'Volunteer engagement'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
  },
  {
    slug: 'at-large',
    seatLabel: 'Director-at-Large',
    roleDescription: 'Independent oversight with strategic project reviews and board accountability support.',
    primaryResponsibilities: ['Independent oversight', 'Strategic projects', 'Special reviews', 'Board accountability'],
    openTasksCount: BOARD_RECORD_NOT_HELD,
    pendingReviewsCount: BOARD_RECORD_NOT_HELD,
    meetingItemsCount: BOARD_RECORD_NOT_HELD,
    complianceItemsCount: BOARD_RECORD_NOT_HELD,
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
  | 'Documents'
  | 'SHADOW';

// 'built' is reserved for a card whose data a board member can load today.
// 'planned' carries the stamp and is the honest default: an unstamped card in
// the same visual treatment as a working one reads as shipped, and most of this
// catalogue describes modules no backend serves. 'boundary' states a limit the
// server enforces rather than a feature at all.
export type BoardCardStatus = 'built' | 'planned' | 'boundary';

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
  'SHADOW',
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
  SHADOW: [
    { title: 'Governance generation unavailable', detail: 'Board chat and background generation are disabled for this role.', status: 'boundary' },
    { title: 'Data boundary', detail: 'No athlete data, coach data, or parent records reach this board view. Board seat assignment is the one administrative control a seat carries, and only the president holds it.', status: 'boundary' },
    { title: 'Aggregate-only API', detail: 'Only organization-level counts, rates, and suppressed status buckets are served.', status: 'boundary' },
  ],
};

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
