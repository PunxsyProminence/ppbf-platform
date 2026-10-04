import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { listDevelopmentBlockTemplatesForAthlete } from '@/src/server/pilot/developmentBlockTemplates';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Optional block templates a coach can start a development block from.
 *
 * GET ?athlete_id=...[&minor_opt_in=1]. Same author roles as the block route.
 * The module applies assertActorCanAccessAthlete before it reads anything, and
 * returns templates for an adult, or for a minor only when the coach ticked
 * the opt-in (owner decision 2026-10-04: hidden for minors by default, unsaved
 * per-athlete opt-in). The response carries an adult/not-adult boolean and
 * never the date of birth.
 *
 * Read-only: templates are fixed text and nothing about a choice is stored.
 */

const AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) {
      throw new ValidationError('Choose an athlete to see block templates for.', 'ATHLETE_ID_REQUIRED');
    }
    const minorOptIn = request.nextUrl.searchParams.get('minor_opt_in') === '1';

    const result = await listDevelopmentBlockTemplatesForAthlete(principal, athleteId, { minorOptIn });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
