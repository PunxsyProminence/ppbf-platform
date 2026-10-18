import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listLearningPolicies, ratifyLearningPolicy } from '@/src/server/pilot/learningPolicies';

export const runtime = 'nodejs';

// The learning loop's bars (lane L49): when a repeated behaviour may be called
// a pattern, and when a reviewed intervention may be called a lesson. Jason
// 2026-10-18 Q3, "Needs to be backed by research": a bar is saved only with its
// cited sources, and none ships with the app. Staff read the bars in force so a
// coach can see what the app's words rest on; a gym admin ratifies a new
// version (the working default, pending Overwatch's confirmation with Jason).
// A bar names no athlete.

const READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const RATIFY_ROLES = ['organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...READ_ROLES]);
    const policies = await listLearningPolicies(principal.organizationId);
    return NextResponse.json({ ok: true, policies });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RATIFY_ROLES]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.kind !== 'string') {
      return NextResponse.json({ ok: false, error: 'kind, parameters and citations are required.' }, { status: 400 });
    }
    const policy = await ratifyLearningPolicy({
      organizationId: principal.organizationId,
      kind: body.kind,
      parameters: body.parameters,
      citations: body.citations,
      ratifiedByAccountId: principal.accountId,
      ratifiedByRole: principal.role,
    });
    return NextResponse.json({ ok: true, policy }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
