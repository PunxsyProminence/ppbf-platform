export type ClubRole =
  | 'athlete'
  | 'coach'
  | 'parent'
  | 'admin'
  | 'board'
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
    role: 'board',
    label: 'Board',
    description: 'Opens the aggregate-only board governance hub.',
    href: '/board',
  },
  {
    role: 'board-president',
    label: 'President',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-chair',
    label: 'Board Chair',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-vice-chair',
    label: 'Vice Chair',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-treasurer',
    label: 'Treasurer',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-secretary',
    label: 'Secretary',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-safety-director',
    label: 'Program & Safety Director',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-community-director',
    label: 'Community & Development Director',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
  {
    role: 'board-at-large',
    label: 'Director-at-Large',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
    href: '/board',
  },
];

export function getRoleRoute(role: ClubRole | string | null | undefined) {
  return roleRoutes.find((item) => item.role === role)?.href ?? '/login';
}
