import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  createGrantObligation,
  isGrantObligationStatus,
  isGrantObligationType,
  listGrantObligations,
  updateGrantObligationStatus,
} from '@/src/server/pilot/grantObligations';

export const runtime = 'nodejs';

// Internal grant-obligation ledger. Admin-only in both directions: these are
// the organization's commitments to funders, not program records -- no coach,
// athlete, parent, or board access in v1 (the board's compliance view can
// grow a read later as its own decision). Nothing here touches athlete data;
// the table structurally has none (see the migration header).
const GRANT_ROLES = ['organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GRANT_ROLES]);

    const status = request.nextUrl.searchParams.get('status');
    if (status !== null && !isGrantObligationStatus(status)) {
      throw new Error('Unknown status filter');
    }

    const items = await listGrantObligations(
      principal.organizationId,
      status ? { status } : {},
    );
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GRANT_ROLES]);

    const body = (await request.json()) as {
      grant_name?: string;
      funder_name?: string;
      obligation_type?: string;
      description?: string;
      due_date?: string;
      notes?: string;
    };

    if (!body.grant_name?.trim() || !body.description?.trim()) {
      throw new Error('Missing grant_name or description');
    }
    if (!isGrantObligationType(body.obligation_type)) {
      throw new Error('Unknown obligation_type');
    }
    if (!body.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      throw new Error('due_date must be YYYY-MM-DD');
    }

    const item = await createGrantObligation({
      organizationId: principal.organizationId,
      grantName: body.grant_name.trim(),
      funderName: body.funder_name?.trim(),
      obligationType: body.obligation_type,
      description: body.description.trim(),
      dueDate: body.due_date,
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
    requireRole(principal, [...GRANT_ROLES]);

    const body = (await request.json()) as {
      obligation_id?: string;
      status?: string;
      notes?: string;
    };

    if (!body.obligation_id) throw new Error('Missing obligation_id');
    if (!isGrantObligationStatus(body.status)) throw new Error('Unknown status');

    const item = await updateGrantObligationStatus({
      organizationId: principal.organizationId,
      obligationId: body.obligation_id,
      status: body.status,
      notes: body.notes,
    });

    if (!item) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
