import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { createVolunteer, listVolunteers, updateVolunteerStatus } from '@/src/server/pilot/volunteers';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);

    const items = await listVolunteers(principal.organizationId);

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json().catch(() => ({}))) as {
      full_name?: string;
      role_focus?: string;
      availability?: string;
      certification_status?: string;
      background_check_status?: string;
      notes?: string | null;
    };

    if (!body.full_name || !body.role_focus || !body.availability || !body.certification_status || !body.background_check_status) {
      return NextResponse.json({ ok: false, error: 'missing volunteer fields' }, { status: 400 });
    }

    const volunteerId = await createVolunteer({
      organizationId: principal.organizationId,
      fullName: body.full_name,
      roleFocus: body.role_focus,
      availability: body.availability,
      certificationStatus: body.certification_status,
      backgroundCheckStatus: body.background_check_status,
      notes: body.notes ?? null,
    });

    return NextResponse.json({ ok: true, volunteer_id: volunteerId });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json().catch(() => ({}))) as {
      volunteer_id?: number;
      status?: 'active' | 'pending' | 'inactive';
    };

    if (!body.volunteer_id || !body.status) {
      return NextResponse.json({ ok: false, error: 'missing volunteer_id or status' }, { status: 400 });
    }

    const updated = await updateVolunteerStatus({
      organizationId: principal.organizationId,
      volunteerId: body.volunteer_id,
      status: body.status,
    });

    return NextResponse.json({ ok: true, updated });
  } catch (error) {
    return jsonError(error);
  }
}