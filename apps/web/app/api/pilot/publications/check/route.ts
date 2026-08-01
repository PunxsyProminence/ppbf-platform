import { NextResponse, type NextRequest } from 'next/server';

import { recordComplianceCheck, updatePublicationStatus } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Both sets are enforced by check constraints on pilot.publication_checks. A
// value outside them would otherwise reach Postgres, fail with 23514 and come
// back to the admin as an opaque 500 after the request had already decided
// what the publication's new status would be.
const CHECK_TYPES = ['compliance', 'safety', 'metadata', 'consent', 'legal'];
const CHECK_STATUSES = ['passed', 'failed', 'warning', 'manual_review'];

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

    if (!CHECK_TYPES.includes(body.check_type)) {
      return NextResponse.json(
        { error: `check_type must be one of: ${CHECK_TYPES.join(', ')}.` },
        { status: 400 },
      );
    }

    if (!CHECK_STATUSES.includes(body.check_status)) {
      return NextResponse.json(
        { error: `check_status must be one of: ${CHECK_STATUSES.join(', ')}.` },
        { status: 400 },
      );
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

    // This is the only path that reaches 'approved', and the only one that
    // reaches 'rejected'. Publishing demands both a status of 'approved' and
    // passed compliance, so a publication that never has a check recorded
    // against it stays a draft forever -- which is the intent: an admin
    // attests to the compliance of a youth athlete's footage before it can
    // leave the gym.
    let complianceStatus = 'pending';
    let publicationStatus = 'pending_review';
    if (body.check_status === 'passed') {
      complianceStatus = 'passed';
      publicationStatus = 'approved';
    } else if (body.check_status === 'failed') {
      complianceStatus = 'failed';
      publicationStatus = 'rejected';
    } else if (body.check_status === 'manual_review') {
      complianceStatus = 'manual_review';
    }

    await updatePublicationStatus(
      principal.organizationId,
      body.publication_id,
      publicationStatus,
      complianceStatus,
      publicationStatus === 'approved' ? principal.accountId : undefined,
    );

    return NextResponse.json(
      { ...check, publication_status: publicationStatus, compliance_check_status: complianceStatus },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
