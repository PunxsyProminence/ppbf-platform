import { redirect } from 'next/navigation';

import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

/*
 * /coach sends a coach to their home (#1482 item 6). It was a 404, though it
 * is the address a coach types and the first rung a breadcrumb trail names.
 *
 * The target is read from getPilotRoleDestination, the same table sign-in
 * routes by, so the two cannot drift. It lands on a gated page: a visitor who
 * is not a coach meets that page's own RoleSessionGate, exactly as if they had
 * typed its address. It carries no door of its own --
 * buildingMapCoverage.test.ts's EXCLUDED names it for that reason.
 */
export default function CoachHomeRedirectPage() {
  redirect(getPilotRoleDestination('coach') ?? '/');
}
