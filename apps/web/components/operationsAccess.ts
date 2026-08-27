import type { ClubRole } from './roleRoutes';

/**
 * WHO MAY USE THE GENERAL OPERATIONS HUB.
 *
 * OWNER DECISION, 2026-08-26: `/operations` is no longer a cross-role
 * launcher. It is a gym-administration surface, and only an administrator or
 * the platform owner may open it.
 *
 * This supersedes Operations V1 (2026-08-21), which made the hub a directory
 * every signed-in role could open. Under that decision the gate was written
 * as `[...roleRoutes.map((route) => route.role), 'platform_owner']` -- every
 * role the platform has, sixteen of them, derived from the role selector the
 * page happened to render. A list derived from a UI list is not a policy; it
 * changes whenever somebody adds a row to the selector.
 *
 * ---------------------------------------------------------------------------
 * ONE SOURCE, BECAUSE FIVE PLACES ASK THE SAME QUESTION.
 *
 * The hub was reachable from the global header, the standalone role view, the
 * corridor, the card catalog and the command search, and gated by the page
 * itself -- six decisions about one policy. Written out six times they drift,
 * and the way they drift is silent: a link stays visible after the gate
 * narrows, so a coach clicks Operations and is bounced to their dashboard with
 * no explanation. Everything that needs this answer imports it from here.
 *
 * WHAT THIS IS AND IS NOT. buildingMap.ts's `roles` field is advisory
 * visibility and says so in its own header -- "hiding a row here does not
 * protect anything". That remains true, which is exactly why this constant
 * does not live there: the map CONSUMES this policy for its visibility hint,
 * while the page's own RoleSessionGate consumes it as the gate. Neither owns
 * it. Removing a link is not an authorization decision and never was.
 *
 * NOT THE SAME AS `ADMIN_GATE`. buildingMap has a private `ADMIN_GATE` with,
 * today, identical members. They are kept apart deliberately: one answers
 * "who administers the gym's records", the other answers "who gets the
 * operational launcher". They agree now; a future decision may move one and
 * not the other, and a shared constant would move both without anyone
 * choosing to.
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS DOES NOT TOUCH. Every role keeps its own operational surfaces,
 * reached directly rather than through the hub. In particular a coach keeps
 * Today's Floor, Session Scripts, drills, progression, scheduling, and the two
 * routes that merely live under the `/operations/` path prefix --
 * `/operations/external-competition` and `/operations/wrestling-league` --
 * both of which carry their own `['coach', 'admin']` gate and are unaffected
 * by the hub's. A URL prefix is not a permission boundary here; each door
 * carries its own.
 */
export const OPERATIONS_ROLES: readonly ClubRole[] = ['admin', 'platform_owner'];

/**
 * True when this role may open the general Operations hub.
 *
 * Takes a widened type because callers read the role off a session snapshot
 * that may be null while the session is still resolving, and off stored values
 * that are strings as far as the type system is concerned. An unknown value is
 * refused rather than admitted -- the closed side, which is the only safe
 * default for a question asked while a session is still loading.
 */
export function canUseOperationsHub(role: ClubRole | string | null | undefined): boolean {
  return typeof role === 'string' && (OPERATIONS_ROLES as readonly string[]).includes(role);
}
