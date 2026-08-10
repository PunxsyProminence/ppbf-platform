import { NextResponse, type NextRequest } from 'next/server';

import {
  grantCoachCoverage,
  isOrganizationAdminRole,
  listActiveCoachCoverage,
  revokeCoachCoverage,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Every coverage grant currently in effect for the caller's own gym. Until
// this existed, an admin who forgot which athletes had an active grant had
// no way to find out except a direct database query -- the POST/DELETE
// halves of this route existed with no way to see what they had done.
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const coverage = await listActiveCoachCoverage(principal.organizationId);
    return NextResponse.json({ coverage });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      athlete_id?: string;
      covering_coach_id?: string;
      ttl_hours?: number;
    };

    const athleteId = body.athlete_id?.trim() || '';
    const coveringCoachId = body.covering_coach_id?.trim() || '';

    if (!athleteId || !coveringCoachId) {
      throw new Error('Missing athlete_id or covering_coach_id');
    }

    const result = await grantCoachCoverage({
      organizationId: principal.organizationId,
      athleteId,
      coveringCoachId,
      grantedByAccountId: principal.accountId,
      ttlHours: body.ttl_hours,
    });

    // A coverage grant hands a coach access to a child's athlete-scoped
    // records; who granted it, to whom, and until when must survive in the
    // audit stream, not only in the coverage row itself.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_coverage',
      entity_id: result.coverageId,
      details: {
        athlete_id: athleteId,
        covering_coach_id: coveringCoachId,
        expires_at: result.expiresAt,
      },
    });

    return NextResponse.json({
      ok: true,
      coverage_id: result.coverageId,
      organization_id: principal.organizationId,
      athlete_id: athleteId,
      covering_coach_id: coveringCoachId,
      expires_at: result.expiresAt,
    });
  } catch (error) {
    return jsonError(error);
  }
}

// The withdrawal half of POST. Same authorization -- an organization admin
// grants coverage and the same role takes it back -- and the same
// organization scoping, so one gym cannot end another gym's grant by
// guessing a coverage_id.
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json().catch(() => ({}))) as { coverage_id?: string };
    const coverageId = body.coverage_id?.trim() || '';

    if (!coverageId) {
      throw new Error('Missing coverage_id');
    }

    const result = await revokeCoachCoverage({
      organizationId: principal.organizationId,
      coverageId,
    });

    // Audit the state change only: an idempotent re-revoke of an already
    // ended grant changed nothing, so it writes nothing.
    if (result.revoked) {
      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'coach_coverage',
        entity_id: coverageId,
        details: { action: 'revoke' },
      });
    }

    // `revoked: false` means no active grant matched -- already expired,
    // already revoked, or another organization's. Deliberately not a 404: the
    // caller's intent (this coverage is not active) holds either way, and
    // distinguishing the cases would confirm whether a coverage_id exists in
    // some other gym.
    return NextResponse.json({
      ok: true,
      coverage_id: coverageId,
      organization_id: principal.organizationId,
      revoked: result.revoked,
    });
  } catch (error) {
    return jsonError(error);
  }
}
