import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getModelStatus } from '@/src/server/pilot/shadowRouter';

export const runtime = 'nodejs';

// Same manual-override role set as the chat route's tier/sessionType
// overrides -- model choice is just another manual override, gated the
// same way, not a separate authorization concept.
const MANUAL_OVERRIDE_ROLES = ['coach', 'admin', 'organization_admin', 'platform_owner'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MANUAL_OVERRIDE_ROLES]);

    return NextResponse.json({ ok: true, models: getModelStatus() });
  } catch (error) {
    return jsonError(error);
  }
}
