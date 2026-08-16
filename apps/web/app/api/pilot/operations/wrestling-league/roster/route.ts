import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  LEAGUE_READ_ROLES,
  LEAGUE_WRITE_ROLES,
  addLeagueRosterEntry,
  listLeagueRoster,
} from '@/src/server/pilot/wrestlingLeague';

export const runtime = 'nodejs';

// Wrestling league skeleton: season roster. The entry is a LINK -- athlete
// names come through the org-scoped join in wrestlingLeague.ts, never copied.
// Season and athlete ids from another organization are hidden not-founds.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_READ_ROLES]);

    const seasonId = request.nextUrl.searchParams.get('season_id')?.trim();
    if (!seasonId) throw new ValidationError('Missing season_id.');

    const items = await listLeagueRoster(principal.organizationId, seasonId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_WRITE_ROLES]);

    const body = (await request.json()) as {
      season_id?: string;
      athlete_id?: string;
    };

    if (!body.season_id?.trim()) throw new ValidationError('Missing season_id.');
    if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');

    const item = await addLeagueRosterEntry({
      organizationId: principal.organizationId,
      seasonId: body.season_id.trim(),
      athleteId: body.athlete_id.trim(),
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LEAGUE_ROSTER_DUPLICATE_ENTRY')) {
      return NextResponse.json(
        { ok: false, error: 'This athlete is already on the season roster.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}
