import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import {
  acknowledgeEscalation,
  detectRepeatedPatternEscalations,
  listEscalations,
  resolveEscalation,
  type SafetyEscalationStatus,
} from '@/src/server/pilot/escalationLadder';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The pull-based surface capability #194 exists to be: this platform sends
// no email, ever, so a coach or admin has to come check this page/route for
// a near miss, pain report, or safety-gate flag severe enough to have
// auto-escalated. Board is deliberately not a role this route serves --
// see escalationLadder.ts / the safety-escalations migration for why; board
// reads only the k-anonymity-gated summary via a separate route.
async function coachAthleteIds(organizationId: string, coachAccountId: string): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes where organization_id = $1 and coach_id = $2`,
    [organizationId, coachAccountId],
  );
  return rows.map((row) => row.athlete_id);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;
    const isAdmin = role === 'admin' || isOrganizationAdminRole(role);
    const isCoach = role === 'coach';
    if (!isAdmin && !isCoach) {
      throw new Error('Forbidden: escalations are available to coach and organization_admin/admin only');
    }

    const statusParam = request.nextUrl.searchParams.get('status');
    if (statusParam !== null && !['open', 'acknowledged', 'resolved'].includes(statusParam)) {
      throw new Error('Unsupported status: must be open, acknowledged, or resolved');
    }
    const status = (statusParam ?? undefined) as SafetyEscalationStatus | undefined;

    const athleteIds = isCoach ? await coachAthleteIds(principal.organizationId, principal.accountId) : undefined;
    const escalations = await listEscalations(principal.organizationId, { status, athleteIds });

    return NextResponse.json({ ok: true, escalations });
  } catch (error) {
    return jsonError(error);
  }
}

type EscalationAction = 'acknowledge' | 'resolve' | 'scan_patterns';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;
    const isAdmin = role === 'admin' || isOrganizationAdminRole(role);
    const isCoach = role === 'coach';
    if (!isAdmin && !isCoach) {
      throw new Error('Forbidden: escalations are available to coach and organization_admin/admin only');
    }

    const body = (await request.json()) as {
      action?: EscalationAction;
      escalation_id?: string;
      resolution_note?: string;
    };

    const action = body.action;
    if (!action) throw new Error('Missing action');

    if (action === 'acknowledge') {
      const escalationId = body.escalation_id?.trim();
      if (!escalationId) throw new Error('Missing escalation_id');

      // A coach may only acknowledge an escalation filed for one of their
      // own athletes -- checked by membership in their own scoped list
      // rather than a separate lookup-by-id, so "not mine" and "not real"
      // both land on the same Missing error a coach cannot tell apart.
      if (isCoach) {
        const allowedAthleteIds = await coachAthleteIds(principal.organizationId, principal.accountId);
        const ownEscalations = await listEscalations(principal.organizationId, { athleteIds: allowedAthleteIds });
        if (!ownEscalations.some((escalation) => escalation.escalation_id === escalationId)) {
          throw new Error('Missing escalation record');
        }
      }

      const updated = await acknowledgeEscalation(principal.organizationId, escalationId, principal.accountId);
      if (!updated) throw new Error('Missing escalation record');

      return NextResponse.json({ ok: true, escalation: updated });
    }

    if (action === 'resolve') {
      // Resolving is an organization_admin/admin action -- a coach can
      // acknowledge (they have seen it) but the final call that a red flag
      // is closed out belongs to admin, matching the compliance-violations
      // precedent (escalateViolation's equivalent resolve step).
      if (!isAdmin) {
        throw new Error('Forbidden: only organization_admin/admin can resolve an escalation');
      }
      const escalationId = body.escalation_id?.trim();
      if (!escalationId) throw new Error('Missing escalation_id');
      // Empty maps to '' here and to NULL-equivalent in the module's
      // coalesce(nullif(...)) -- so an absent note can never overwrite a
      // stored one. The status guard in transitionEscalation is what stops
      // re-resolve outright; this is the second layer.
      const resolutionNote = typeof body.resolution_note === 'string' ? body.resolution_note.trim() : '';

      const updated = await resolveEscalation(principal.organizationId, escalationId, principal.accountId, resolutionNote);
      if (!updated) throw new Error('Missing escalation record');

      return NextResponse.json({ ok: true, escalation: updated });
    }

    if (action === 'scan_patterns') {
      if (!isAdmin) {
        throw new Error('Forbidden: only organization_admin/admin can run a pattern scan');
      }
      const filed = await detectRepeatedPatternEscalations(principal.organizationId);
      return NextResponse.json({ ok: true, filed_count: filed.length, escalations: filed });
    }

    throw new Error(`Unsupported action: ${action}`);
  } catch (error) {
    return jsonError(error);
  }
}
