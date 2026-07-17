import { NextResponse, type NextRequest } from 'next/server';

import { getResearchLibrary } from '@/src/server/pilot/publication';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete']);

    const tagsParam = request.nextUrl.searchParams.get('tags');
    const limit = Math.min(Number.parseInt(request.nextUrl.searchParams.get('limit') || '20', 10), 100);
    const offset = Math.max(Number.parseInt(request.nextUrl.searchParams.get('offset') || '0', 10), 0);

    const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;

    const items = await getResearchLibrary(principal.organizationId, {
      tags,
      limit,
      offset,
    });

    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
