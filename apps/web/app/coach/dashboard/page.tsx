import { redirect } from 'next/navigation';

import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

/*
 * /coach/dashboard sends a coach to their home, as /coach does (#1482 item
 * 6): both were 404, and every other role's home is a /<role>/dashboard, so
 * it is the address a coach guesses. Target from getPilotRoleDestination, the
 * table sign-in routes by. No door of its own (buildingMapCoverage EXCLUDED).
 */
export default function CoachDashboardRedirectPage() {
  redirect(getPilotRoleDestination('coach') ?? '/');
}
