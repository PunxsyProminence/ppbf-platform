import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { createComplianceViolation, getComplianceRuleById, getOrganizationViolations } from '@/src/server/pilot/compliance';
import { hiddenNotFound, parseSafeLimit, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

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

    return NextResponse.json({ items: violations });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as {
      rule_id?: string;
      video_session_id?: string;
      athlete_id?: string;
      severity?: string;
      details?: Record<string, unknown>;
    };

    if (!body.rule_id || !body.athlete_id) {
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
