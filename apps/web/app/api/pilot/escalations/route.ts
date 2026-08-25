import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole } from '@/src/server/pilot/access';
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
//
// The coach scope (assigned athletes PLUS actively covered ones, T-002) was
// born here as a local query and is now the central contract in access.ts:
// athleteIdsForCoach. This pull surface is the platform's only notification
// mechanism, and coverage that excluded it would hand the substitute the
// data but not the alarm.

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

    const athleteIds = isCoach ? await athleteIdsForCoach(principal.organizationId, principal.accountId) : undefined;
    // athlete_voice rows are admin-surface only: their existence alone says
    // "this child said something", and the coach may be who it is about.
    const escalations = await listEscalations(principal.organizationId, {
      status,
      athleteIds,
      excludeAthleteVoice: isCoach ? true : undefined,
    });

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
      // athlete_voice is excluded here exactly as in GET: a coach can
      // neither see nor act on a disclosure-driven escalation, and probing
      // this path with a guessed id yields the same Missing as a bogus id.
      if (isCoach) {
        const allowedAthleteIds = await athleteIdsForCoach(principal.organizationId, principal.accountId);
        const ownEscalations = await listEscalations(principal.organizationId, {
          athleteIds: allowedAthleteIds,
          excludeAthleteVoice: true,
        });
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
      const resolutionNote = typeof body.resolution_note === 'string' ? body.resolution_note.trim() : '';

      // Closing a safety escalation about a minor without a stated reason is
      // unauditable. This is the identical rule
      // compliance/violations/route.ts:PATCH applies to its own closing
      // verdicts -- and the rule that route's own comment already credits
      // "the escalation ladder" with enforcing. It did not. The only place
      // it existed was app/admin/escalations/page.tsx, in the browser
      // ("A resolution needs a stated reason -- the escalation was not
      // resolved"), so any other caller could close a 'critical' incident
      // report, a pain-report escalation, or an athlete_voice disclosure
      // with resolution_note absent: resolved_by_account_id named who, and
      // nothing anywhere said on what grounds.
      //
      // Acknowledgement is receipt, not closure, and deliberately carries no
      // such requirement -- same split as the compliance console.
      //
      // The module's coalesce(nullif(...)) still stands behind this: it is
      // what stops a '' from wiping a stored note, and the status guard in
      // transitionEscalation is what stops a re-resolve. This refusal is the
      // layer in front of both.
      if (!resolutionNote) {
        throw new Error('Missing note: a resolution needs a stated reason');
      }

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
