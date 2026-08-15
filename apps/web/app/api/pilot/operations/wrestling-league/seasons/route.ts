import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  LEAGUE_READ_ROLES,
  LEAGUE_WRITE_ROLES,
  createLeagueSeason,
  isLeagueSeasonStatus,
  listLeagueSeasons,
  setLeagueSeasonStatus,
} from '@/src/server/pilot/wrestlingLeague';

export const runtime = 'nodejs';

// Wrestling league skeleton: seasons. Staff read; admin write (role sets and
// the platform_owner exclusion rationale live in wrestlingLeague.ts).

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_READ_ROLES]);

    const items = await listLeagueSeasons(principal.organizationId);
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
      season_name?: string;
      starts_on?: string;
      ends_on?: string | null;
      notes?: string;
    };

    if (!body.season_name?.trim()) {
      throw new ValidationError('Missing season_name.');
    }
    if (!body.starts_on || !DATE_SHAPE.test(body.starts_on)) {
      throw new ValidationError('starts_on must be YYYY-MM-DD.');
    }
    const endsOn =
      typeof body.ends_on === 'string' && body.ends_on.trim() !== '' ? body.ends_on.trim() : null;
    if (endsOn !== null && !DATE_SHAPE.test(endsOn)) {
      throw new ValidationError('ends_on must be YYYY-MM-DD when provided.');
    }
    if (endsOn !== null && endsOn < body.starts_on) {
      throw new ValidationError('ends_on must not be before starts_on.');
    }

    const item = await createLeagueSeason({
      organizationId: principal.organizationId,
      seasonName: body.season_name.trim(),
      startsOn: body.starts_on,
      endsOn,
      notes: body.notes,
      createdByAccountId: principal.accountId,
    });

    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_WRITE_ROLES]);

    const body = (await request.json()) as {
      season_id?: string;
      status?: string;
    };

    if (!body.season_id?.trim()) throw new ValidationError('Missing season_id.');
    if (!isLeagueSeasonStatus(body.status)) throw new ValidationError('Unknown season status.');

    const item = await setLeagueSeasonStatus({
      organizationId: principal.organizationId,
      seasonId: body.season_id.trim(),
      status: body.status,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
