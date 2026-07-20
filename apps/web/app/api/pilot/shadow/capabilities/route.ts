import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { getShadowChatCapabilities } from '@/src/server/pilot/shadowChatCapabilities';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner']);
    return NextResponse.json({
      success: true,
      role: principal.role,
      capabilities: getShadowChatCapabilities(principal.role as PilotRole),
    });
  } catch (error) {
    return jsonError(error);
  }
}
