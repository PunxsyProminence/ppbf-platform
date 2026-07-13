import type { ClubRole } from '@/components/roleRoutes';

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
  openTasksCount: number;
  pendingReviewsCount: number;
  meetingItemsCount: number;
  complianceItemsCount: number;
  allowedRole: ClubRole;
}

export interface BoardOverviewMetric {
  label: string;
  value: string;
}

export const boardOverviewStrip: BoardOverviewMetric[] = [
  { label: 'Mission Health', value: 'Stable' },
  { label: 'Policy Reviews Due', value: '6' },
  { label: 'Compliance Calendar Events', value: '4' },
  { label: 'Grant Oversight Items', value: '5' },
  { label: 'Board Actions Pending', value: '12' },
  { label: 'Strategic Objectives Active', value: '7' },
  { label: 'Annual Filings Status', value: 'On Track' },
  { label: 'Risk Review Items', value: '3' },
];

export const boardSeatConfigs: BoardSeatConfig[] = [
  {
    slug: 'president',
    seatLabel: 'President',
    roleDescription: 'Mission stewardship, governance leadership, and executive accountability for a veteran-owned 501(c)(3) public charity.',
    primaryResponsibilities: ['Mission stewardship', 'Strategic direction', 'Board effectiveness', 'Executive accountability'],
    openTasksCount: 6,
    pendingReviewsCount: 3,
    meetingItemsCount: 5,
    complianceItemsCount: 2,
    allowedRole: 'board-president',
  },
  {
    slug: 'chair',
    seatLabel: 'Board Chair',
    roleDescription: 'Governance oversight, meeting governance quality, committee leadership, and board development.',
    primaryResponsibilities: ['Governance oversight', 'Meeting governance', 'Committee leadership', 'Board development'],
    openTasksCount: 4,
    pendingReviewsCount: 4,
    meetingItemsCount: 6,
    complianceItemsCount: 1,
    allowedRole: 'board-chair',
  },
  {
    slug: 'vice-chair',
    seatLabel: 'Vice Chair',
    roleDescription: 'Succession planning, governance continuity, leadership development, and committee coordination.',
    primaryResponsibilities: ['Succession planning', 'Governance continuity', 'Leadership development', 'Committee coordination'],
    openTasksCount: 3,
    pendingReviewsCount: 2,
    meetingItemsCount: 4,
    complianceItemsCount: 1,
    allowedRole: 'board-vice-chair',
  },
  {
    slug: 'treasurer',
    seatLabel: 'Treasurer',
    roleDescription: 'Financial stewardship, grant oversight, reserve monitoring, and funding sustainability governance.',
    primaryResponsibilities: ['Financial stewardship', 'Grant oversight', 'Reserve monitoring', 'Funding sustainability'],
    openTasksCount: 5,
    pendingReviewsCount: 3,
    meetingItemsCount: 3,
    complianceItemsCount: 2,
    allowedRole: 'board-treasurer',
  },
  {
    slug: 'secretary',
    seatLabel: 'Secretary',
    roleDescription: 'Governance records stewardship, board action register integrity, and annual filing calendar management.',
    primaryResponsibilities: ['Governance records', 'Board action register', 'Annual filing calendar', 'Document integrity'],
    openTasksCount: 4,
    pendingReviewsCount: 2,
    meetingItemsCount: 7,
    complianceItemsCount: 1,
    allowedRole: 'board-secretary',
  },
  {
    slug: 'safety-director',
    seatLabel: 'Program & Safety Director',
    roleDescription: 'Youth protection leadership, program compliance governance, risk management, and safety governance oversight.',
    primaryResponsibilities: ['Youth protection', 'Program compliance', 'Risk management', 'Safety governance'],
    openTasksCount: 3,
    pendingReviewsCount: 4,
    meetingItemsCount: 2,
    complianceItemsCount: 5,
    allowedRole: 'board-safety-director',
  },
  {
    slug: 'community-director',
    seatLabel: 'Community & Development Director',
    roleDescription: 'Community impact stewardship, partner development, fundraising oversight, and volunteer engagement governance.',
    primaryResponsibilities: ['Community impact', 'Partner development', 'Fundraising oversight', 'Volunteer engagement'],
    openTasksCount: 2,
    pendingReviewsCount: 2,
    meetingItemsCount: 3,
    complianceItemsCount: 1,
    allowedRole: 'board-community-director',
  },
  {
    slug: 'at-large',
    seatLabel: 'Director-at-Large',
    roleDescription: 'Independent oversight with strategic project reviews and board accountability support.',
    primaryResponsibilities: ['Independent oversight', 'Strategic projects', 'Special reviews', 'Board accountability'],
    openTasksCount: 2,
    pendingReviewsCount: 1,
    meetingItemsCount: 2,
    complianceItemsCount: 1,
    allowedRole: 'board-at-large',
  },
];

export const boardSeatMap: Record<BoardSeatSlug, BoardSeatConfig> = boardSeatConfigs.reduce((acc, seat) => {
  acc[seat.slug] = seat;
  return acc;
}, {} as Record<BoardSeatSlug, BoardSeatConfig>);
