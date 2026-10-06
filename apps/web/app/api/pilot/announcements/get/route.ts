import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  isAnnouncementKind,
  isAnnouncementPlacement,
  listAnnouncements,
  listAuthoredAnnouncementIds,
  listLiveAnnouncements,
  projectAnnouncementForBoard,
  type BoardVisibleAnnouncement,
  type PilotAnnouncement,
} from '@/src/server/pilot/announcements';
import { listSeatsForAccount } from '@/src/server/pilot/boardSeats';

export const runtime = 'nodejs';

/* One place, both reads. Applied by ROLE rather than by which endpoint the
   caller used: the boundary belongs to the board role, not to a particular
   route, so a third reader added later gets it by calling this rather than by
   remembering to. */
function projectForPrincipal(
  role: string,
  announcements: PilotAnnouncement[],
): PilotAnnouncement[] | BoardVisibleAnnouncement[] {
  return role === 'board' ? announcements.map(projectAnnouncementForBoard) : announcements;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      placement?: string;
      kind?: string;
      view?: string;
    };

    // The authoring view is the only read that returns items nobody may see
    // yet: scheduled, expired, and retired ones. It is restricted to the roles
    // that may author, so a member cannot read a notice before it goes live.
    if (body.view === 'authoring') {
      requireRole(principal, ['platform_owner', 'organization_admin', 'admin', 'coach', 'board']);

      const announcements = await listAnnouncements(principal.organizationId, body.limit ?? 25);
      const ids = announcements.map((item) => item.announcement_id);

      // What this caller may DO with the list (CL-A8), so the page offers no
      // seat the post route refuses and no Retire the update route refuses.
      // Top-level arrays rather than row fields, so the board projection's
      // allow-list is untouched. Each write route still decides for itself.
      const editableIds = isOrganizationAdminRole(principal.role)
        ? ids
        : await listAuthoredAnnouncementIds(principal.organizationId, principal.accountId, ids);
      const authorSeats = principal.role === 'board'
        ? (await listSeatsForAccount(principal.organizationId, principal.accountId)).map((item) => `board-${item.seat}`)
        : [];

      return NextResponse.json({
        ok: true,
        organization_id: principal.organizationId,
        // Projected for board HERE, on the server, because a board principal is
        // in the allow-list one line above. The client-side omission this
        // replaces was a TypeScript interface, which is erased at runtime.
        announcements: projectForPrincipal(principal.role, announcements),
        editable_announcement_ids: editableIds,
        author_seats: authorSeats,
      });
    }

    const placement = body.placement ?? 'gym_notices';
    const kind = body.kind ?? 'notice';

    if (!isAnnouncementPlacement(placement) || !isAnnouncementKind(kind)) {
      throw new Error('Unsupported placement or kind');
    }

    const announcements = await listLiveAnnouncements(principal.organizationId, {
      placement,
      kind,
      limit: body.limit ?? 8,
    });

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      // The live read too. It carries no role check at all -- every
      // authenticated principal reaches it, board included -- so projecting
      // only the authoring view above would leave the same fields reachable
      // through the path with the weaker gate.
      announcements: projectForPrincipal(principal.role, announcements),
    });
  } catch (error) {
    return jsonError(error);
  }
}
