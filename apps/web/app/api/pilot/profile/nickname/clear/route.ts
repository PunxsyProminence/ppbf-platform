import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  clearNickname,
  getSubjectIdentity,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';
import { NICKNAME_LOCK_HOURS } from '@/src/server/pilot/profileIdentity';

export const runtime = 'nodejs';

/**
 * THE TAKEDOWN.
 *
 * This platform does not run a wordlist over ring names -- see the long note in
 * profileIdentity.ts for why a blocklist on a children's platform buys the
 * wrong thing. What it has instead is a bounded audience and this: any of the
 * athlete's assigned coaches, any organization admin, and any linked guardian
 * can clear a ring name outright, immediately, with no appeal step and no
 * queue.
 *
 * Clearing sets a lock for NICKNAME_LOCK_HOURS. That is not a punishment; it is
 * what makes a takedown a takedown. An athlete who can retype the string thirty
 * seconds later has not been moderated, and the adult is now in a loop instead
 * of a conversation.
 *
 * A guardian is on this list deliberately. They are responsible for the child,
 * they are the person most likely to recognise that a name is a problem, and
 * making them wait for a coach to be free is making them wait for something
 * they should not have to wait for.
 *
 * WHERE THE DOORS ARE, AND WHERE ONE IS STILL MISSING (2026-08-28).
 *
 * This route shipped with the ring-name slice and, until this change, nothing
 * on any screen called it. profileIdentity.ts's case for not running a
 * wordlist over children's names rests on three legs, and the third one --
 * "the adults who know the child can clear it outright, immediately" -- was a
 * route with no caller. It is reachable now from the coach roster in
 * CoachWorkspace.tsx, on an athlete the coach has selected, gated on the same
 * coach_of_subject standing this route requires.
 *
 * The GUARDIAN door is not built. ParentHub.tsx does not display a ring name
 * anywhere, and a control that clears a string it never showed is a control a
 * parent cannot use responsibly -- so surfacing the name to guardians comes
 * first, and it is a visibility change with its own decision to make rather
 * than a button to add. The permission below is correct and stays; the honest
 * statement of today's state is that a guardian must ask a coach or an
 * organization admin. Nothing here silently narrows to match the UI.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'parent']);

    const body = (await request.json().catch(() => null)) as { account_id?: unknown } | null;
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'account_id is required.' }, { status: 400 });
    }

    const identity = await getSubjectIdentity(principal.organizationId, accountId);
    if (!identity) return hiddenNotFound();

    try {
      await assertViewerMayReachSubject(principal, identity);
    } catch {
      return hiddenNotFound();
    }

    const relationship = await resolveRelationship(principal, identity, principal.organizationId);
    const mayClear = isOrganizationAdminRole(principal.role)
      || relationship === 'coach_of_subject'
      || relationship === 'guardian_of_subject';
    if (!mayClear) return hiddenNotFound();

    await clearNickname(principal.organizationId, accountId, principal.accountId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile',
      entity_id: accountId,
      // The string that was taken down is NOT recorded. An audit row is read by
      // more people than the ring name was, so writing it here would republish
      // the exact thing the takedown removed -- to a wider audience, forever.
      details: { action: 'nickname_cleared_by_staff', lock_hours: NICKNAME_LOCK_HOURS },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, locked_for_hours: NICKNAME_LOCK_HOURS });
  } catch (error) {
    return jsonError(error);
  }
}
