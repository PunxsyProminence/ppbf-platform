import { NextResponse, type NextRequest } from 'next/server';

import {
  createPublication,
  getOrganizationPublications,
} from '@/src/server/pilot/publication';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const status = request.nextUrl.searchParams.get('status');
    const publicationType = request.nextUrl.searchParams.get('publication_type');
    const limit = Math.min(Number.parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 100);

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
