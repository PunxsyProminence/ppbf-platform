import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessIntakeCase, getIntakeCaseAggregate } from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete', 'parent']);

    const body = (await request.json()) as { intake_case_id?: string };
    const intakeCaseId = body.intake_case_id?.trim() || '';
    if (!intakeCaseId) {
      throw new Error('Missing intake_case_id');
    }

    // BEFORE the aggregate, not after it. This route used to fetch the whole
    // case -- summary, review notes, payload, and every intake_documents row
    // with its file_name, blob_path and classification -- and only then ask
    // whether the caller was allowed to see it, under
    // `if (intakeCase.primary_athlete_id)`. No code path in this repository
    // ever writes that column (see resolveIntakeCaseAuthority), so the
    // condition was false on every row and the gate never ran once. The read
    // IS the disclosure; a check that happens after it is decoration.
    const authority = await assertActorCanAccessIntakeCase(
      principal,
      principal.organizationId,
      intakeCaseId,
    );
    if (!authority.found) {
      return NextResponse.json({ found: false });
    }

    const aggregate = await getIntakeCaseAggregate(principal.organizationId, intakeCaseId, {
      actorAccountId: principal.accountId,
      actorRole: principal.role,
    });
    if (!aggregate) {
      return NextResponse.json({ found: false });
    }

    return NextResponse.json({ found: true, aggregate });
  } catch (error) {
    return jsonError(error);
  }
}
