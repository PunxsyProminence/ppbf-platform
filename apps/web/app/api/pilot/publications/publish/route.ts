import { NextResponse, type NextRequest } from 'next/server';

import { publishToResearchLibrary } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    const body = (await request.json()) as {
      publication_id?: string;
      video_session_id?: string;
      title?: string;
      description?: string;
      tags?: string[];
    };

    if (!body.publication_id || !body.video_session_id) {
      throw new Error('Missing required fields');
    }

    const libraryId = await publishToResearchLibrary({
      organizationId: principal.organizationId,
      publicationId: body.publication_id,
      videoSessionId: body.video_session_id,
      title: body.title || 'Untitled',
      description: body.description || '',
      tags: body.tags || [],
    });

    // No publication of that id in the caller's organization. Indistinguishable
    // from "does not exist" on purpose: the response must not confirm that
    // another gym holds this publication_id.
    if (!libraryId) {
      return hiddenNotFound();
    }

    return NextResponse.json({ ok: true, library_id: libraryId });
  } catch (error) {
    return jsonError(error);
  }
}
