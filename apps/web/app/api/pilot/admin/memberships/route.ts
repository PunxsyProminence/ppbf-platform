import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  MEMBERSHIP_ROLES,
  createMembership,
  isMembershipStatus,
  listMemberships,
  setMembershipScholarship,
  setMembershipStatus,
} from '@/src/server/pilot/programMemberships';

export const runtime = 'nodejs';

// Program memberships and scholarships. Admin-only in both directions:
// enrollment and scholarship decisions are administrative records about
// families -- no coach, athlete, or parent access in v1 (a family-facing
// view can grow later as its own decision). Scholarship is a stored
// discount percentage, never a bypass.

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEMBERSHIP_ROLES]);

    const items = await listMemberships(principal.organizationId);
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
      athlete_id?: string;
      program_name?: string;
      started_on?: string;
      scholarship_percent?: number;
      scholarship_note?: string;
      notes?: string;
    };

    if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');
    if (!body.program_name?.trim()) throw new ValidationError('Missing program_name.');
    if (!body.started_on || !DATE_SHAPE.test(body.started_on)) {
      throw new ValidationError('started_on must be YYYY-MM-DD.');
    }
    const scholarshipPercent = body.scholarship_percent ?? 0;
    if (!Number.isInteger(scholarshipPercent) || scholarshipPercent < 0 || scholarshipPercent > 100) {
      throw new ValidationError('scholarship_percent must be an integer 0-100.');
    }

    const item = await createMembership({
      organizationId: principal.organizationId,
      athleteId: body.athlete_id.trim(),
      programName: body.program_name.trim(),
      startedOn: body.started_on,
      scholarshipPercent,
      scholarshipNote: body.scholarship_note,
      notes: body.notes,
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MEMBERSHIP_DUPLICATE_ACTIVE')) {
      return NextResponse.json(
        { ok: false, error: 'This athlete already has an active membership in this program. End or lapse it first, or use that row.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEMBERSHIP_ROLES]);

    const body = (await request.json()) as {
      membership_id?: string;
      status?: string;
      scholarship_percent?: number;
      scholarship_note?: string;
    };

    if (!body.membership_id?.trim()) throw new ValidationError('Missing membership_id.');
    const membershipId = body.membership_id.trim();

    // Exactly one act per call: a status move OR a scholarship change --
    // never both in one ambiguous request.
    const wantsStatus = body.status !== undefined;
    const wantsScholarship = body.scholarship_percent !== undefined;
    if (wantsStatus === wantsScholarship) {
      throw new ValidationError('Send either status or scholarship_percent, not both or neither.');
    }

    if (wantsStatus) {
      if (!isMembershipStatus(body.status)) throw new ValidationError('Unknown membership status.');
      const item = await setMembershipStatus({
        organizationId: principal.organizationId,
        membershipId,
        status: body.status,
      });
      if (!item) return hiddenNotFound();
      return NextResponse.json({ item });
    }

    if (!Number.isInteger(body.scholarship_percent) || body.scholarship_percent! < 0 || body.scholarship_percent! > 100) {
      throw new ValidationError('scholarship_percent must be an integer 0-100.');
    }
    const item = await setMembershipScholarship({
      organizationId: principal.organizationId,
      membershipId,
      scholarshipPercent: body.scholarship_percent!,
      scholarshipNote: body.scholarship_note,
    });
    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
