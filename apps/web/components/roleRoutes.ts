export type ClubRole =
  | 'athlete'
  | 'coach'
  | 'parent'
  | 'admin'
  | 'board-president'
  | 'board-chair'
  | 'board-vice-chair'
  | 'board-treasurer'
  | 'board-secretary'
  | 'board-safety-director'
  | 'board-community-director'
  | 'board-at-large';

export interface RoleRoute {
  role: ClubRole;
  label: string;
  description: string;
  href: string;
}

export const ROLE_STORAGE_KEY = 'ppbf-club-role';

export const roleRoutes: RoleRoute[] = [
  {
    role: 'athlete',
    label: 'Athlete',
    description: 'Opens the athlete dashboard and sparring surfaces.',
    href: '/athlete/dashboard',
  },
  {
    role: 'coach',
    label: 'Coach',
    description: 'Opens the coach review queue and intake workflow.',
    href: '/coach/review-queue',
  },
  {
    role: 'parent',
    label: 'Parent',
    description: 'Opens the parent hub to track child training progress.',
    href: '/parent/dashboard',
  },
  {
    role: 'admin',
    label: 'Admin',
    description: 'Opens platform capability and governance controls.',
    href: '/admin',
  },
  {
    role: 'board-president',
    label: 'President',
    description: 'Opens the unified board workspace with president visibility.',
    href: '/board/president',
  },
  {
    role: 'board-chair',
    label: 'Board Chair',
    description: 'Opens the unified board workspace with board chair visibility.',
    href: '/board/chair',
  },
  {
    role: 'board-vice-chair',
    label: 'Vice Chair',
    description: 'Opens the unified board workspace with vice chair visibility.',
    href: '/board/vice-chair',
  },
  {
    role: 'board-treasurer',
    label: 'Treasurer',
    description: 'Opens the unified board workspace with treasurer visibility.',
    href: '/board/treasurer',
  },
  {
    role: 'board-secretary',
    label: 'Secretary',
    description: 'Opens the unified board workspace with secretary visibility.',
    href: '/board/secretary',
  },
  {
    role: 'board-safety-director',
    label: 'Program & Safety Director',
    description: 'Opens the unified board workspace with safety and compliance visibility.',
    href: '/board/safety-director',
  },
  {
    role: 'board-community-director',
    label: 'Community & Development Director',
    description: 'Opens the unified board workspace with community and development visibility.',
    href: '/board/community-director',
  },
  {
    role: 'board-at-large',
    label: 'Director-at-Large',
    description: 'Opens the unified board workspace with director-at-large visibility.',
    href: '/board/at-large',
  },
];

export function getRoleRoute(role: ClubRole | string | null | undefined) {
  return roleRoutes.find((item) => item.role === role)?.href ?? '/login';
}
