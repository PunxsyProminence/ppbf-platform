import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { getOrganizationName } from '@/src/server/pilot/staffProvisioning';
import { OPERATING_ORGANIZATION_ID } from '@/src/server/pilot/organizationProfileStore';
import { readStoredProfileInput, saveOrganizationProfile } from '@/src/server/pilot/organizationProfileWrite';

export const runtime = 'nodejs';

/*
 * The gym's profile, read and saved by its organization admin for the gym of
 * the session (lane L31 P3). Gym work: the platform owner is refused, as on the
 * other gym routes (OD-2026-10-10-004 ruling 3). The legal name is returned
 * read-only; it is the gym's name of record, which the platform owner sets.
 */

async function requireGymAdmin(request: NextRequest) {
  const principal = await requireMicrosoftAuthenticatedPrincipal(request);
  if (!isOrganizationAdminRole(principal.role)) {
    throw new Error('Forbidden: role not allowed');
  }
  return principal;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireGymAdmin(request);
    const [profile, legalName] = await Promise.all([
      readStoredProfileInput(principal.organizationId),
      getOrganizationName(principal.organizationId),
    ]);
    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      legal_name: legalName,
      profile,
      // The public pages, print sheets, wall and sign-in email name the operating gym (OD-2026-09-28-007).
      public_pages: principal.organizationId === OPERATING_ORGANIZATION_ID,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireGymAdmin(request);
    const body = (await request.json().catch(() => null)) as { profile?: unknown } | null;
    const profile = await saveOrganizationProfile(principal.organizationId, body?.profile, {
      accountId: principal.accountId,
      role: principal.role,
    });
    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      profile,
      public_pages: principal.organizationId === OPERATING_ORGANIZATION_ID,
    });
  } catch (error) {
    return jsonError(error);
  }
}
