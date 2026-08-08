import { NextResponse, type NextRequest } from 'next/server';

import { listOrganizationConsentStatus } from '@/src/server/pilot/guardianConsent';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * T-008: THE ORG-WIDE CONSENT AUDIT.
 *
 * Read-only, org-admin only. Every athlete in the organization, with their
 * current guardian media-consent status -- including athletes with zero
 * linked guardians, which is itself the finding an admin auditing this
 * needs to see (checkGuardianMediaConsent treats that as "unverifiable",
 * not vacuously satisfied). See guardianConsent.ts for the full reasoning.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const rows = await listOrganizationConsentStatus(principal.organizationId);

    return NextResponse.json({
      ok: true,
      items: rows.map((row) => ({
        athlete_id: row.athleteId,
        athlete_name: row.athleteName,
        consent_ok: row.consent.ok,
        guardian_count: row.consent.guardianIds.length,
        missing_guardian_count: row.consent.missingParentIds.length,
        per_guardian: row.consent.perGuardian.map((g) => ({
          parent_id: g.parentId,
          status: g.status,
          covers_video: g.coversVideo,
          public_use_allowed: g.publicUseAllowed,
          signed_at: g.signedAt,
        })),
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
