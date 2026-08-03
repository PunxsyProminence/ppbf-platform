import type { ClubRole } from './roleRoutes';

/* Law 6 gives the platform two grounds: ink leather for staff surfaces, warm
   canvas for the family-facing side. The ground is derived from allowedRoles
   rather than passed as a prop, so it cannot drift from the audience — that
   list already decides who may open the route.

   This lives in its own module rather than beside RoleStandaloneView because
   RoleSessionGate needs it too, and RoleStandaloneView imports RoleSessionGate.
   Exporting it from there would close an import cycle. */
const FAMILY_ROLES = new Set<ClubRole>(['athlete', 'parent']);

export function isFamilyGround(allowedRoles: readonly ClubRole[]): boolean {
  // An empty list is not a family surface. Defaulting the unknown case to ink
  // keeps a misconfigured page off the ground reserved for children's records.
  return allowedRoles.length > 0 && allowedRoles.every((role) => FAMILY_ROLES.has(role));
}

/* The full-bleed ground classes for each side, so the shell and the gate that
   short-circuits in front of it cannot disagree about what a route looks like. */
export function groundClasses(allowedRoles: readonly ClubRole[]): string {
  return isFamilyGround(allowedRoles)
    ? 'bg-[var(--canvas-tan)] text-[var(--black)]'
    : 'bg-[var(--hide-950)] text-[color:var(--bone-200)]';
}
