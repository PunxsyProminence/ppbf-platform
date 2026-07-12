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
  { label: 'Seats Filled', value: '8 / 8' },
  { label: 'Open Tasks', value: '29' },
  { label: 'Policies Under Review', value: '6' },
  { label: 'Meetings Scheduled', value: '4' },
  { label: 'Compliance Items', value: '9' },
  { label: 'Upcoming Votes', value: '5' },
];

export const boardSeatConfigs: BoardSeatConfig[] = [
  {
    slug: 'president',
    seatLabel: 'President',
    roleDescription: 'Executive leadership and organizational oversight.',
    primaryResponsibilities: ['Strategic direction', 'Organizational health', 'Executive action alignment'],
    openTasksCount: 6,
    pendingReviewsCount: 3,
    meetingItemsCount: 5,
    complianceItemsCount: 2,
    allowedRole: 'board-president',
  },
  {
    slug: 'chair',
    seatLabel: 'Board Chair',
    roleDescription: 'Strategic direction and governance meeting leadership.',
    primaryResponsibilities: ['Agenda leadership', 'Governance continuity', 'Vote facilitation'],
    openTasksCount: 4,
    pendingReviewsCount: 4,
    meetingItemsCount: 6,
    complianceItemsCount: 1,
    allowedRole: 'board-chair',
  },
  {
    slug: 'vice-chair',
    seatLabel: 'Vice Chair',
    roleDescription: 'Continuity planning, committee support, and leadership backup.',
    primaryResponsibilities: ['Committee coordination', 'Continuity planning', 'Meeting support'],
    openTasksCount: 3,
    pendingReviewsCount: 2,
    meetingItemsCount: 4,
    complianceItemsCount: 1,
    allowedRole: 'board-vice-chair',
  },
  {
    slug: 'treasurer',
    seatLabel: 'Treasurer',
    roleDescription: 'Budget integrity, financial tracking, and grant visibility.',
    primaryResponsibilities: ['Budget review', 'Financial tracking', 'Grant monitoring'],
    openTasksCount: 5,
    pendingReviewsCount: 3,
    meetingItemsCount: 3,
    complianceItemsCount: 2,
    allowedRole: 'board-treasurer',
  },
  {
    slug: 'secretary',
    seatLabel: 'Secretary',
    roleDescription: 'Minutes, records, and official governance documentation.',
    primaryResponsibilities: ['Minutes management', 'Record retention', 'Resolution registry updates'],
    openTasksCount: 4,
    pendingReviewsCount: 2,
    meetingItemsCount: 7,
    complianceItemsCount: 1,
    allowedRole: 'board-secretary',
  },
  {
    slug: 'safety-director',
    seatLabel: 'Program & Safety Director',
    roleDescription: 'Program safety oversight, youth protection, and compliance review.',
    primaryResponsibilities: ['Safety reviews', 'Incident oversight', 'Youth protection controls'],
    openTasksCount: 3,
    pendingReviewsCount: 4,
    meetingItemsCount: 2,
    complianceItemsCount: 5,
    allowedRole: 'board-safety-director',
  },
  {
    slug: 'community-director',
    seatLabel: 'Community & Development Director',
    roleDescription: 'Partnerships, fundraising lanes, and grant opportunity growth.',
    primaryResponsibilities: ['Partnership development', 'Fundraising strategy', 'Volunteer development'],
    openTasksCount: 2,
    pendingReviewsCount: 2,
    meetingItemsCount: 3,
    complianceItemsCount: 1,
    allowedRole: 'board-community-director',
  },
  {
    slug: 'at-large',
    seatLabel: 'Director-at-Large',
    roleDescription: 'Independent oversight, voting input, and special project support.',
    primaryResponsibilities: ['Voting participation', 'Special projects', 'General oversight'],
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
