import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { createComplianceViolation, getOrganizationViolations } from '@/src/server/pilot/compliance';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');
    const limit = Math.min(Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10), 100);

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
