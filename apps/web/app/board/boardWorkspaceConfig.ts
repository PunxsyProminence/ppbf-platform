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
  openTasksCount: string;
  pendingReviewsCount: string;
  meetingItemsCount: string;
  complianceItemsCount: string;
  allowedRole: ClubRole;
}

export interface BoardOverviewMetric {
  label: string;
  value: string;
}

export const boardOverviewStrip: BoardOverviewMetric[] = [
  { label: 'Mission Health', value: 'Unavailable' },
  { label: 'Policy Reviews Due', value: 'Unavailable' },
  { label: 'Compliance Calendar Events', value: 'Unavailable' },
  { label: 'Grant Oversight Items', value: 'Unavailable' },
  { label: 'Board Actions Pending', value: 'Unavailable' },
  { label: 'Strategic Objectives Active', value: 'Unavailable' },
  { label: 'Annual Filings Status', value: 'Unavailable' },
  { label: 'Risk Review Items', value: 'Unavailable' },
];

export const boardSeatConfigs: BoardSeatConfig[] = [
  {
    slug: 'president',
    seatLabel: 'President',
    roleDescription: 'Mission stewardship, governance leadership, and executive accountability for a veteran-owned 501(c)(3) public charity.',
    primaryResponsibilities: ['Mission stewardship', 'Strategic direction', 'Board effectiveness', 'Executive accountability'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-president',
  },
  {
    slug: 'chair',
    seatLabel: 'Board Chair',
    roleDescription: 'Governance oversight, meeting governance quality, committee leadership, and board development.',
    primaryResponsibilities: ['Governance oversight', 'Meeting governance', 'Committee leadership', 'Board development'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-chair',
  },
  {
    slug: 'vice-chair',
    seatLabel: 'Vice Chair',
    roleDescription: 'Succession planning, governance continuity, leadership development, and committee coordination.',
    primaryResponsibilities: ['Succession planning', 'Governance continuity', 'Leadership development', 'Committee coordination'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-vice-chair',
  },
  {
    slug: 'treasurer',
    seatLabel: 'Treasurer',
    roleDescription: 'Financial stewardship, grant oversight, reserve monitoring, and funding sustainability governance.',
    primaryResponsibilities: ['Financial stewardship', 'Grant oversight', 'Reserve monitoring', 'Funding sustainability'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-treasurer',
  },
  {
    slug: 'secretary',
    seatLabel: 'Secretary',
    roleDescription: 'Governance records stewardship, board action register integrity, and annual filing calendar management.',
    primaryResponsibilities: ['Governance records', 'Board action register', 'Annual filing calendar', 'Document integrity'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-secretary',
  },
  {
    slug: 'safety-director',
    seatLabel: 'Program & Safety Director',
    roleDescription: 'Youth protection leadership, program compliance governance, risk management, and safety governance oversight.',
    primaryResponsibilities: ['Youth protection', 'Program compliance', 'Risk management', 'Safety governance'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-safety-director',
  },
  {
    slug: 'community-director',
    seatLabel: 'Community & Development Director',
    roleDescription: 'Community impact stewardship, partner development, fundraising oversight, and volunteer engagement governance.',
    primaryResponsibilities: ['Community impact', 'Partner development', 'Fundraising oversight', 'Volunteer engagement'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-community-director',
  },
  {
    slug: 'at-large',
    seatLabel: 'Director-at-Large',
    roleDescription: 'Independent oversight with strategic project reviews and board accountability support.',
    primaryResponsibilities: ['Independent oversight', 'Strategic projects', 'Special reviews', 'Board accountability'],
    openTasksCount: 'Unavailable',
    pendingReviewsCount: 'Unavailable',
    meetingItemsCount: 'Unavailable',
    complianceItemsCount: 'Unavailable',
    allowedRole: 'board-at-large',
  },
];

export const boardSeatMap: Record<BoardSeatSlug, BoardSeatConfig> = boardSeatConfigs.reduce((acc, seat) => {
  acc[seat.slug] = seat;
  return acc;
}, {} as Record<BoardSeatSlug, BoardSeatConfig>);
