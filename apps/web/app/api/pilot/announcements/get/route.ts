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
  type AnnouncementPlacement,
  type BoardVisibleAnnouncement,
  type PilotAnnouncement,
} from '@/src/server/pilot/announcements';
import { listSeatsForAccount } from '@/src/server/pilot/boardSeats';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { roleEquals } from '@/src/server/pilot/roleAlias';

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

/* WHICH PLACEMENTS EACH ROLE MAY ASK THE LIVE READ FOR (issue #1475 Part B).
   The placement comes from the request body, and until this table existed any
   signed-in role could name any of them: an athlete could ask for the coaches'
   board or the parents'. The rows follow what the Customize screen says each
   board is for and which screens draw it. gym_notices is the public wall and
   'everywhere' is every signed-in surface, so every role may ask for those
   two. Coach, organization admin, platform owner and board draw all four
   boards on /chalkboard and keep all five.

   Written out per role rather than derived from ANNOUNCEMENT_PLACEMENTS, and
   with no fallback row: a placement added later, or a role, reaches nobody
   here until someone names it. */
const EVERY_PLACEMENT: readonly AnnouncementPlacement[] = [
  'gym_notices',
  'athlete_workspace',
  'coach_workspace',
  'parent_hub',
  'everywhere',
];

const LIVE_PLACEMENTS_BY_ROLE: ReadonlyArray<{ role: PilotRole; placements: readonly AnnouncementPlacement[] }> = [
  { role: 'coach', placements: EVERY_PLACEMENT },
  { role: 'organization_admin', placements: EVERY_PLACEMENT },
  { role: 'platform_owner', placements: EVERY_PLACEMENT },
  { role: 'board', placements: EVERY_PLACEMENT },
  { role: 'athlete', placements: ['athlete_workspace', 'gym_notices', 'everywhere'] },
  { role: 'parent', placements: ['parent_hub', 'gym_notices', 'everywhere'] },
  { role: 'staff', placements: ['gym_notices', 'everywhere'] },
  { role: 'volunteer', placements: ['gym_notices', 'everywhere'] },
];

function mayReadLivePlacement(role: PilotRole, placement: AnnouncementPlacement): boolean {
  return LIVE_PLACEMENTS_BY_ROLE.some((row) => roleEquals(role, row.role) && row.placements.includes(placement));
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

    // A placement that is not this role's own is answered exactly as a word
    // that is no placement at all, before anything is read, so the answer
    // does not say the board exists.
    if (
      !isAnnouncementPlacement(placement)
      || !isAnnouncementKind(kind)
      || !mayReadLivePlacement(principal.role, placement)
    ) {
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
      // The live read too. Every authenticated principal reaches it, board
      // included, each for its own placements -- so projecting only the
      // authoring view above would leave the same fields reachable through
      // the path with the weaker gate.
      announcements: projectForPrincipal(principal.role, announcements),
    });
  } catch (error) {
    return jsonError(error);
  }
}
