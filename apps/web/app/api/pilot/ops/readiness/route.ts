import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { buildPilotOpsReadinessReport } from '@/src/server/pilot/pilotOpsReadiness';

export const runtime = 'nodejs';

// Admin-only, and read-only: this answers "why didn't X run?" without
// requiring a shell into the database or the deploy config. Every field is a
// boolean plus a one-line reason -- buildPilotOpsReadinessReport never reads
// a secret's value, only whether one is present, so this route has nothing
// to redact.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'platform_owner']);

    const readiness = buildPilotOpsReadinessReport();
    return NextResponse.json({ ok: true, readiness });
  } catch (error) {
    return jsonError(error);
  }
}
