import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  COMPETITION_READ_ROLES,
  COMPETITION_WRITE_ROLES,
  addCompetitionEntry,
  listCompetitionEntries,
} from '@/src/server/pilot/externalCompetition';

export const runtime = 'nodejs';

// External-competition skeleton: athlete entries. The entry is a LINK --
// athlete names come through the org-scoped join in externalCompetition.ts,
// never copied. Competition and athlete ids from another organization are
// hidden not-founds.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_READ_ROLES]);

    const competitionId = request.nextUrl.searchParams.get('competition_id')?.trim();
    if (!competitionId) throw new ValidationError('Missing competition_id.');

    const items = await listCompetitionEntries(principal.organizationId, competitionId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_WRITE_ROLES]);

    const body = (await request.json()) as {
      competition_id?: string;
      athlete_id?: string;
    };

    if (!body.competition_id?.trim()) throw new ValidationError('Missing competition_id.');
    if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');

    const item = await addCompetitionEntry({
      organizationId: principal.organizationId,
      competitionId: body.competition_id.trim(),
      athleteId: body.athlete_id.trim(),
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('COMPETITION_DUPLICATE_ENTRY')) {
      return NextResponse.json(
        { ok: false, error: 'This athlete is already entered in this competition.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}
