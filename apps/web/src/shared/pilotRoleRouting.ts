// The seat vocabulary comes from the board workspace config -- the file the
// /board/[seat] pages route on, and the same eight slugs the pilot.board_seats
// check constraint accepts. Recognizing a seat here that no page can render
// would produce a destination nobody can open.
import { isBoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

export { isBoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

/**
 * Where a signed-in account belongs, from its server role and -- for the board
 * -- the seat it holds.
 *
 * The seat is additional identity layered on the authoritative role, never a
 * role of its own: it is consulted only in the board branch, and anything it
 * does not recognize falls back to the shared board workspace. A board member
 * who holds no seat lands there too. The parameter is optional so a caller
 * that only knows the role -- deciding whether a role is routable at all --
 * keeps asking exactly that question.
 */
export function getPilotRoleDestination(role: unknown, seat?: unknown): string | null {
  if (role === 'platform_owner') {
    return '/admin/platform';
  }
  if (role === 'organization_admin' || role === 'admin') {
    return '/admin';
  }
  if (role === 'coach') {
    // The working coach hub: intake review actions, coach reviews, floor
    // plans, and pain reports all live in CoachWorkspace, mounted here. The
    // old destination, /coach/review-queue, was a hardcoded mock whose
    // Approve button discarded everything (owner decision 2026-08-14: the
    // real review queue gets built later from actual backend records, and
    // the mock never ships as operational UI).
    return '/coach/environment/intake-router';
  }
  if (role === 'athlete') {
    return '/athlete/dashboard';
  }
  if (role === 'parent') {
    return '/parent/dashboard';
  }
  if (role === 'board') {
    return isBoardSeatSlug(seat) ? `/board/${seat}` : '/board';
  }
  // Staff and volunteers hold no athlete-scoped or administrative surface, so
  // they share one workspace rather than each getting a near-empty dashboard.
  if (role === 'staff' || role === 'volunteer') {
    return '/workspace';
  }
  return null;
}
