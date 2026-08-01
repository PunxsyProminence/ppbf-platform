import { NextResponse, type NextRequest } from 'next/server';

import { recordComplianceCheck, updatePublicationStatus } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const body = (await request.json()) as {
      publication_id?: string;
      check_type?: string;
      check_status?: string;
      details?: string;
    };

    if (!body.publication_id || !body.check_type || !body.check_status) {
      throw new Error('Missing required fields');
    }

    const check = await recordComplianceCheck({
      organizationId: principal.organizationId,
      publicationId: body.publication_id,
      checkType: body.check_type,
      checkStatus: body.check_status,
      details: body.details || '',
      checkedByAccountId: principal.accountId,
    });

    // A publication_id from another organization records nothing, and must be
    // indistinguishable from one that does not exist.
    if (!check) {
      return hiddenNotFound();
    }

    // Update publication compliance status based on check result
    let complianceStatus = 'pending';
    if (body.check_status === 'passed') {
      complianceStatus = 'passed';
    } else if (body.check_status === 'failed') {
      complianceStatus = 'failed';
    } else if (body.check_status === 'manual_review') {
      complianceStatus = 'manual_review';
    }

    await updatePublicationStatus(
      principal.organizationId,
      body.publication_id,
      'pending_review',
      complianceStatus,
    );

    return NextResponse.json(check, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
