import { NextResponse, type NextRequest } from 'next/server';

import {
  assertActorCanAccessAthlete,
  athleteIdsForCoach,
  isOrganizationAdminRole,
} from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  createPublication,
  getOrganizationPublications,
} from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError, parseSafeLimit } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

/**
 * Which athletes' publications this caller may read, as the scope the SQL
 * itself is narrowed by.
 *
 * The rule per role, decided from what each role's own gate already does
 * rather than by scoping everybody:
 *
 *   organization_admin / admin  Unscoped, and that is not a concession.
 *                               assertActorCanAccessAthlete for this role is
 *                               assertAthleteBelongsToOrganization, so the
 *                               organization filter IS the per-athlete gate --
 *                               a narrower scope would refuse nothing and
 *                               would break the compliance console's
 *                               deliberate reach into a departed coach's
 *                               drafts (owner decision, 2026-08-14).
 *
 *   coach                       Scoped to athleteIdsForCoach: coach of record
 *                               plus coverage grants that have started and not
 *                               expired. Evaluated per request against
 *                               coach_coverage's own now() predicates, so a
 *                               lapsed grant -- or one ended early by
 *                               revokeCoachCoverage -- stops admitting on the
 *                               very next call, with nothing cached in
 *                               between.
 *
 *   anything else               Empty scope. Nothing else is admitted by the
 *                               requireRole gate below today; if a role is
 *                               ever added there, it reads nothing until
 *                               somebody decides its scope here, rather than
 *                               inheriting the whole organization by default.
 */
async function readableAthleteScope(principal: PilotPrincipal): Promise<readonly string[] | undefined> {
  if (isOrganizationAdminRole(principal.role)) {
    return undefined;
  }

  if (principal.role === 'coach') {
    return athleteIdsForCoach(principal.organizationId, principal.accountId);
  }

  return [];
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const status = request.nextUrl.searchParams.get('status');
    const publicationType = request.nextUrl.searchParams.get('publication_type');
    // See publications/library/route.ts: Math.min(parseInt(...) || 50, 100)
    // never rejected a negative value, letting it reach Postgres and crash
    // with an unhandled "LIMIT must not be negative".
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    // THIS LIST IS THE SAME FOOTAGE THE VIDEO LIST SCOPES, SO IT SCOPES TOO.
    //
    // This read was `where organization_id = $1` and nothing else, for every
    // allowed role. Its sibling GET /api/pilot/video/list narrows a coach's
    // view of the SAME video sessions in SQL to the athletes on that coach's
    // roster -- so a coach who is refused a minor's video row could still read
    // that video's publication here: publication_id, video_session_id,
    // athlete_id, title, description, and the status and
    // compliance_check_status that say where a child's footage stands in the
    // consent and compliance workflow.
    //
    // The scope is applied as a predicate on the statement rather than to the
    // rows it returns: an unreachable child's record is never fetched, so
    // there is nothing here for a later refactor to forget to drop.
    const athleteIds = await readableAthleteScope(principal);

    const publications = await getOrganizationPublications(principal.organizationId, {
      status: status || undefined,
      publicationType: publicationType || undefined,
      limit,
      athleteIds,
    });

    return NextResponse.json({ items: publications });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as {
      video_session_id?: string;
      athlete_id?: string;
      publication_type?: string;
      title?: string;
      description?: string;
      tags?: string[];
    };

    if (!body.video_session_id || !body.athlete_id || !body.publication_type) {
      throw new Error('Missing required fields');
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    // Reject a video_session_id that belongs to another organization, or that
    // is attributed to a different athlete than the one being published,
    // without revealing whether it exists at all.
    const videoSession = await getVideoSessionById(principal.organizationId, body.video_session_id);
    if (!videoSession || (videoSession.athlete_id && videoSession.athlete_id !== body.athlete_id)) {
      return hiddenNotFound();
    }

    // Footage nobody has released is footage nobody has looked at. A
    // publication drafted from it would carry a quarantined -- or infected --
    // file all the way to a passing compliance check, since every later step
    // reads the publication row rather than the video.
    if (videoSession.status !== 'ready') {
      return NextResponse.json(
        {
          error: 'That video has not been released for playback yet. Release it first, then create the publication.',
          video_status: videoSession.status,
        },
        { status: 409 },
      );
    }

    const publication = await createPublication({
      organizationId: principal.organizationId,
      videoSessionId: body.video_session_id,
      athleteId: body.athlete_id,
      submittedByAccountId: principal.accountId,
      publicationType: body.publication_type,
      title: body.title || 'Untitled Video',
      description: body.description || '',
      tags: body.tags || [],
    });

    return NextResponse.json(publication, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
