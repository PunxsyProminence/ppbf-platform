import { redirect } from 'next/navigation';

import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// This route used to mount IncidentCommandCenter -- a prototype rendering a
// hardcoded escalation queue, invented near-misses, and a heavy-bag matrix
// about athletes who do not exist, behind a live organization_admin guard.
// Fabricated safety incidents on a real safeguarding surface are the exact
// class of false reassurance this codebase deletes rather than stamps (see
// the guardian dashboard's identical treatment). The real escalation queue
// -- open, acknowledge, resolve, pattern-scan, all persisted and audited --
// lives at /admin/escalations.
//
// Lane BT, BOA-23: the signpost page that replaced it is gone too; the route
// now sends an organization admin straight to the queue. The gate is the one
// the signpost had, checked first, so who this route admits is unchanged.
// Removed with the signpost: its text and its two buttons, "Open the
// Escalation Queue" and "Safety Review Rollup".
export default async function DirectorDashboardPage() {
  await requirePageRole(['organization_admin']);
  redirect('/admin/escalations');
}
