import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  LEAGUE_READ_ROLES,
  LEAGUE_WRITE_ROLES,
  createLeagueEvent,
  listLeagueEvents,
} from '@/src/server/pilot/wrestlingLeague';

export const runtime = 'nodejs';

// Wrestling league skeleton: events within a season. A season id from
// another organization reads as a hidden not-found in both directions.

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_READ_ROLES]);

    const seasonId = request.nextUrl.searchParams.get('season_id')?.trim();
    if (!seasonId) throw new ValidationError('Missing season_id.');

    const items = await listLeagueEvents(principal.organizationId, seasonId);
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
      event_name?: string;
      event_date?: string;
      location?: string;
      notes?: string;
    };

    if (!body.season_id?.trim()) throw new ValidationError('Missing season_id.');
    if (!body.event_name?.trim()) throw new ValidationError('Missing event_name.');
    if (!body.event_date || !DATE_SHAPE.test(body.event_date)) {
      throw new ValidationError('event_date must be YYYY-MM-DD.');
    }

    const item = await createLeagueEvent({
      organizationId: principal.organizationId,
      seasonId: body.season_id.trim(),
      eventName: body.event_name.trim(),
      eventDate: body.event_date,
      location: body.location?.trim(),
      notes: body.notes,
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
