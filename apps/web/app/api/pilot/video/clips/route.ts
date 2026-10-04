import { NextResponse, type NextRequest } from 'next/server';

import {
  assertActorCanAccessAthlete,
  athleteIdsForCoach,
  isOrganizationAdminRole,
  requireRole,
} from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { listTaggedClips } from '@/src/server/pilot/videoClipTags';

export const runtime = 'nodejs';

/*
 * Tagged sparring and bout clips for review: by athlete
 * (?athlete_id=) or by competition (?competition_id=), or everything the
 * caller may see. Staff only (owner, 2026-10-03). A coach sees the tags on
 * athletes who are theirs (decision 3); playback itself still runs every
 * athlete in the clip through the consent gate in video/[videoId].
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id')?.trim() || undefined;
    const competitionId = searchParams.get('competition_id')?.trim() || undefined;
    const limit = parseSafeLimit(searchParams.get('limit'), 50, 200);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }
    const scope = isOrganizationAdminRole(principal.role)
      ? null
      : await athleteIdsForCoach(principal.organizationId, principal.accountId);

    const items = await listTaggedClips({
      organizationId: principal.organizationId,
      athleteIds: scope,
      athleteId,
      competitionId,
      limit,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
