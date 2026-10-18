import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requireMicrosoftAuthenticatedPrincipal, requirePrincipal } from '@/src/server/pilot/http';
import { listLearningPolicies, ratifyLearningPolicy } from '@/src/server/pilot/learningPolicies';

export const runtime = 'nodejs';

// The learning loop's bars (lane L49): when a repeated behaviour is emerging, a
// pattern or established; when a lesson improved, likely worked or worked; and
// when a coach pair's reports are calibrated enough to count. Jason 2026-10-18,
// Q3 "Needs to be backed by research", then his approval of the threshold
// research: a bar is saved only with its cited sources, and only a gym admin's
// ratification puts one in force (the approved v1 payloads wait in
// learningPolicyApprovedV1.ts). Staff read the bars in force so a coach can
// see what the app's words rest on. Ratifying is the organization admin's
// alone (Jason 2026-10-18, "A: Gym admin only (Rec.)"), on a
// Microsoft-authenticated session. A bar names no athlete.

const READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const RATIFY_ROLES = ['organization_admin'] as const;

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
    // Ratifying is a privileged write: a Microsoft-authenticated session, as
    // the other admin mutations require (http.ts requireMicrosoftAuthenticatedPrincipal).
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, [...RATIFY_ROLES]);
    // requireRole reads the legacy admin role as organization_admin
    // (roleAlias.ts); the ruling names the organization admin alone, so the
    // role is checked exactly here (and again by the table).
    if (principal.role !== 'organization_admin') throw new Error('Forbidden: role not allowed');
    // A body of null, a number or a list is not a request: read as empty, refused below.
    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
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
