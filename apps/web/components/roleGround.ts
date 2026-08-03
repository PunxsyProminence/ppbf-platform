import type { ClubRole } from './roleRoutes';

/* Law 6 gives the platform two grounds: ink leather for staff surfaces, warm
   canvas for the family-facing side. The ground is derived from allowedRoles
   rather than passed as a prop, so it cannot drift from the audience — that
   list already decides who may open the route.

   This lives in its own module rather than beside RoleStandaloneView because
   RoleSessionGate needs it too, and RoleStandaloneView imports RoleSessionGate.
   Exporting it from there would close an import cycle. */
/* Athlete surfaces left this set in the golden-era pass: PAGE_MAP puts every
   athlete route on ink — the floor kiosk (Law 5) — and AthleteWorkspace is now
   built from ink materials, so cream around it would be the drift, not the fix.
   The family side of Law 6 is the parent/guardian audience. */
const FAMILY_ROLES = new Set<ClubRole>(['parent']);

export function isFamilyGround(allowedRoles: readonly ClubRole[]): boolean {
  // An empty list is not a family surface. Defaulting the unknown case to ink
  // keeps a misconfigured page off the ground reserved for children's records.
  return allowedRoles.length > 0 && allowedRoles.every((role) => FAMILY_ROLES.has(role));
}

/* The full-bleed ground classes for each side, so the shell and the gate that
   short-circuits in front of it cannot disagree about what a route looks like. */
export function groundClasses(allowedRoles: readonly ClubRole[]): string {
  /* The family ground is the design system's own .on-canvas: it paints the
     warm canvas AND restates every component tuned against leather, which the
     old legacy-alias pair (bg canvas-tan + black text) never did. The content
     that used to make this unsafe — ParentHub, the guardian portal — is now
     converted and expects those restatements. */
  return isFamilyGround(allowedRoles)
    ? 'on-canvas'
    : 'bg-[var(--hide-950)] text-[color:var(--bone-200)]';
}
