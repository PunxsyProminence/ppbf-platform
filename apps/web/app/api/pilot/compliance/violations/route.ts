import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  type ComplianceViolationTransition,
  createComplianceViolation,
  getComplianceRuleById,
  getComplianceViolationById,
  getOrganizationViolations,
  transitionComplianceViolation,
} from '@/src/server/pilot/compliance';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { hiddenNotFound, parseSafeLimit, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the admin their (already-committed) lifecycle transition
// failed -- the same doctrine every sibling console carries.
async function auditViolationEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'compliance-violation-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    const violations = await getOrganizationViolations(principal.organizationId, {
      athleteId: athleteId || undefined,
      status: status || undefined,
      limit,
      coachAccountId: principal.role === 'coach' && !athleteId ? principal.accountId : undefined,
    });

    // `limit` travels with the rows because this read is capped and ordered
    // `created_at desc`: what comes back is the newest slice of the register,
    // not the register. Callers were computing totals and severity counts off
    // it and labelling them as the whole record. Naming the applied cap is
    // what lets a screen say which window its figures cover.
    return NextResponse.json({ items: violations, limit });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    // .catch(() => null) mirrors PATCH below: without it, malformed/empty
    // JSON throws a SyntaxError that matches no PilotError/prefix branch in
    // jsonError and falls to a masked 500, while the identical failure on
    // PATCH already returns a clean 400 for the same input.
    const body = (await request.json().catch(() => null)) as {
      rule_id?: string;
      video_session_id?: string;
      athlete_id?: string;
      severity?: string;
      details?: Record<string, unknown>;
    } | null;

    if (!body?.rule_id || !body.athlete_id) {
      throw new Error('Missing rule_id or athlete_id');
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    // Reject a rule_id from another organization without revealing whether
    // it exists at all.
    const rule = await getComplianceRuleById(principal.organizationId, body.rule_id);
    if (!rule) {
      return hiddenNotFound();
    }

    // Reject a video_session_id that belongs to another organization, or
    // that is attributed to a different athlete than the one this
    // violation is being filed against.
    if (body.video_session_id) {
      const videoSession = await getVideoSessionById(principal.organizationId, body.video_session_id);
      if (!videoSession || (videoSession.athlete_id && videoSession.athlete_id !== body.athlete_id)) {
        return hiddenNotFound();
      }
    }

    const violation = await createComplianceViolation({
      organizationId: principal.organizationId,
      ruleId: body.rule_id,
      videoSessionId: body.video_session_id || null,
      athleteId: body.athlete_id,
      detectedByAccountId: principal.accountId,
      severity: body.severity || 'medium',
      details: body.details || {},
    });

    return NextResponse.json(violation, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

const TRANSITIONS = new Set<ComplianceViolationTransition>(['acknowledge', 'resolve', 'dismiss']);

// The lifecycle levers. Gated to the same role set as the escalate route --
// the only pre-existing violation lifecycle mutation -- because that is the
// authority current source establishes: coaches read violations, admins move
// them. A transition changes workflow state only; it never touches severity,
// rule, athlete, evidence, or the escalation history rows.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const body = (await request.json().catch(() => null)) as
      | { violation_id?: unknown; action?: unknown; note?: unknown }
      | null;
    const violationId = typeof body?.violation_id === 'string' ? body.violation_id.trim() : '';
    const rawAction: unknown = body?.action;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';

    if (!violationId) {
      throw new Error('Missing violation_id');
    }
    if (!TRANSITIONS.has(rawAction as ComplianceViolationTransition)) {
      throw new Error('Unsupported action: expected "acknowledge", "resolve", or "dismiss"');
    }
    const action = rawAction as ComplianceViolationTransition;

    // Closing a violation about a minor without a stated reason is
    // unauditable -- same rule the escalation ladder and the video console
    // apply to their own closing verdicts. Acknowledgement is receipt, not
    // closure, and carries no such requirement.
    if (action !== 'acknowledge' && !note) {
      throw new Error(`Missing note: a ${action === 'resolve' ? 'resolution' : 'dismissal'} needs a stated reason`);
    }

    // Resolve the violation scoped to this organization first, rejecting a
    // cross-organization violation_id without revealing whether it exists.
    const violation = await getComplianceViolationById(principal.organizationId, violationId);
    if (!violation) {
      return hiddenNotFound();
    }

    const applied = await transitionComplianceViolation({
      organizationId: principal.organizationId,
      violationId,
      transition: action,
    });

    // The CAS refused: the violation is not in a state this transition may
    // leave from, or another operator's transition already committed since
    // the read above. Name the current state so the refusal is actionable.
    const pastTense = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'dismissed';
    if (!applied) {
      return NextResponse.json(
        { error: `This violation cannot be ${pastTense} from its current state.`, status: violation.status },
        { status: 409 },
      );
    }

    await auditViolationEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'compliance_violation',
      entity_id: violationId,
      details: {
        action: `violation_${action}`,
        prior_status: violation.status,
        new_status: pastTense,
        note: note || undefined,
      },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, violation_id: violationId, prior_status: violation.status });
  } catch (error) {
    return jsonError(error);
  }
}
