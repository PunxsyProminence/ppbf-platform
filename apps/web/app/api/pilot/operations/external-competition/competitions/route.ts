import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  COMPETITION_READ_ROLES,
  COMPETITION_WRITE_ROLES,
  createCompetition,
  isCompetitionStatus,
  listCompetitions,
  setCompetitionStatus,
} from '@/src/server/pilot/externalCompetition';

export const runtime = 'nodejs';

// External-competition skeleton: the competitions themselves. Staff read;
// admin write (role sets and the platform_owner exclusion rationale live in
// externalCompetition.ts).

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_READ_ROLES]);

    const items = await listCompetitions(principal.organizationId);
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
      competition_name?: string;
      competition_date?: string;
      location?: string;
      sanctioning_body?: string;
      notes?: string;
    };

    if (!body.competition_name?.trim()) {
      throw new ValidationError('Missing competition_name.');
    }
    if (!body.competition_date || !DATE_SHAPE.test(body.competition_date)) {
      throw new ValidationError('competition_date must be YYYY-MM-DD.');
    }

    const item = await createCompetition({
      organizationId: principal.organizationId,
      competitionName: body.competition_name.trim(),
      competitionDate: body.competition_date,
      location: body.location?.trim(),
      sanctioningBody: body.sanctioning_body?.trim(),
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
    requireRole(principal, [...COMPETITION_WRITE_ROLES]);

    const body = (await request.json()) as {
      competition_id?: string;
      status?: string;
    };

    if (!body.competition_id?.trim()) throw new ValidationError('Missing competition_id.');
    if (!isCompetitionStatus(body.status)) throw new ValidationError('Unknown competition status.');

    const item = await setCompetitionStatus({
      organizationId: principal.organizationId,
      competitionId: body.competition_id.trim(),
      status: body.status,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
