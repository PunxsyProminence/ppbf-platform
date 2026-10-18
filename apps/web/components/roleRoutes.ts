export type ClubRole =
  | 'athlete'
  | 'coach'
  | 'parent'
  | 'admin'
  // Distinct from 'admin' on purpose. Omega is broader in breadth and
  // strictly NARROWER in depth (shadowRoleSets.ts): access.ts refuses it
  // every athlete-scoped record. While both collapsed to 'admin', the client
  // could not express that, so page guards were wrong in both directions --
  // Omega rendered pages whose API then refused it, and an organization_admin
  // was locked out of pages its API allows.
  | 'platform_owner'
  | 'staff'
  | 'volunteer'
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
}

export const ROLE_STORAGE_KEY = 'ppbf-club-role';

export const roleRoutes: RoleRoute[] = [
  {
    role: 'athlete',
    label: 'Athlete',
    description: 'Opens the athlete dashboard and sparring surfaces.',
  },
  {
    role: 'coach',
    label: 'Coach',
    description: 'Opens the coach workspace: intake review, floor plans, and pain reports.',
  },
  {
    role: 'parent',
    label: 'Parent',
    description: 'Opens the parent hub to track child training progress.',
  },
  {
    role: 'admin',
    label: 'Admin',
    description: 'Opens platform capability and governance controls.',
  },
  {
    role: 'staff',
    label: 'Staff',
    description: 'Opens the staff and volunteer workspace.',
  },
  {
    role: 'volunteer',
    label: 'Volunteer',
    description: 'Opens the staff and volunteer workspace.',
  },
  {
    role: 'board',
    label: 'Board',
    description: 'Opens the aggregate-only board governance hub.',
  },
  {
    role: 'board-president',
    label: 'President',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-chair',
    label: 'Board Chair',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-vice-chair',
    label: 'Vice Chair',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-treasurer',
    label: 'Treasurer',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-secretary',
    label: 'Secretary',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-safety-director',
    label: 'Program & Safety Director',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-community-director',
    label: 'Community & Development Director',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
  {
    role: 'board-at-large',
    label: 'Director-at-Large',
    description: 'Opens the aggregate board hub (seat-specific access requires server-authorized board session).',
  },
];

/* No getRoleRoute (lane U2, audit UX-A A-14): it was a second table of
   homes that disagreed with sign-in. Where a role lands is
   getPilotRoleDestination (src/shared/pilotRoleRouting.ts), and the shared
   back link (BackHome) asks the same function. */
