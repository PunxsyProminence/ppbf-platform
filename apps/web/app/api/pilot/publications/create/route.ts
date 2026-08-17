import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  createPublication,
  getOrganizationPublications,
} from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError, parseSafeLimit } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

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

    const publications = await getOrganizationPublications(principal.organizationId, {
      status: status || undefined,
      publicationType: publicationType || undefined,
      limit,
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
