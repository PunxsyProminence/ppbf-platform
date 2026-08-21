import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { MEMBERSHIP_ROLES } from '@/src/server/pilot/programMemberships';
import {
  archiveProgram,
  createProgram,
  listProgramsWithCounts,
  reactivateProgram,
} from '@/src/server/pilot/programs';

export const runtime = 'nodejs';

// The programs catalog behind the memberships page. Reading the catalog is
// admin PLUS coach: a coach planning around persistent groups needs the
// names and headcounts (the upcoming group Coach Cards read), and a name
// with a count discloses nothing about any family. Coaches get exactly
// that -- notes are an admin's field and are stripped from a coach's read.
// Creating, archiving, and reactivating stay admin-only like the
// memberships they organize.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEMBERSHIP_ROLES, 'coach']);

    const rows = await listProgramsWithCounts(principal.organizationId);
    const items = principal.role === 'coach'
      ? rows.map(({ program_id, program_name, status, active_member_count }) => ({
          program_id, program_name, status, active_member_count,
        }))
      : rows;
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEMBERSHIP_ROLES]);

    const body = (await request.json()) as {
      program_name?: string;
      notes?: string;
    };

    if (!body.program_name?.trim()) throw new ValidationError('Missing program_name.');

    const item = await createProgram({
      organizationId: principal.organizationId,
      programName: body.program_name.trim(),
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
    requireRole(principal, [...MEMBERSHIP_ROLES]);

    const body = (await request.json()) as {
      program_id?: string;
      status?: string;
    };

    if (!body.program_id?.trim()) throw new ValidationError('Missing program_id.');
    if (body.status !== 'active' && body.status !== 'archived') {
      throw new ValidationError('status must be "active" or "archived".');
    }

    const item = body.status === 'archived'
      ? await archiveProgram(principal.organizationId, body.program_id.trim())
      : await reactivateProgram(principal.organizationId, body.program_id.trim());

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
