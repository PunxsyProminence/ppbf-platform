import { NextResponse, type NextRequest } from 'next/server';

import { getResearchLibrary } from '@/src/server/pilot/publication';
import { requirePrincipal, requireRole, jsonError, parseSafeLimit } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete']);

    const tagsParam = request.nextUrl.searchParams.get('tags');
    // Math.min(parseInt(...) || 20, 100) never rejected a negative value --
    // `-5 || 20` stays -5 since a negative number is truthy, and Math.min
    // only clamps the upper bound, so it reached the database and crashed
    // Postgres with an unhandled "LIMIT must not be negative", masked as a
    // generic 500. parseSafeLimit rejects it outright instead, the same
    // contract every other bounded list route in this codebase already uses.
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 20, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }
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
