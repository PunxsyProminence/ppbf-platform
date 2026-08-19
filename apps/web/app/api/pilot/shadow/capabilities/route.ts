import { NextRequest, NextResponse } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getShadowChatCapabilities } from '@/src/server/pilot/shadowChatCapabilities';

/**
 * The SHADOW chat surface asking what it is allowed to be.
 *
 * This route had requirePrincipal and no role gate, which made it the one
 * SHADOW endpoint that answered anybody holding a session. A board member — a
 * role SHADOW chat refuses by name, and whose room DNA lists "Ask SHADOW chat"
 * first under FORBIDDEN — received a 200 carrying crossOrganizationRead,
 * canAccessProtectedHealthInformation, canReviewChatSafetyTelemetry,
 * canExportConversationHistory and the tier in `mode`. The page never rendered
 * a pixel of it, which is why nobody noticed; it was still sent, and the names
 * of an authority model are a description of its shape.
 *
 * The list below is the one requireRole already enforces on chat/route.ts and
 * sessions/route.ts, and the set SHADOW_CHAT_ROLES spells in
 * app/shadow/page.tsx. It must stay aligned with them: a role that cannot open
 * a conversation has no capabilities on this surface to be told about.
 */
const SHADOW_CHAT_ROLES = [
  'admin',
  'coach',
  'athlete',
  'parent',
  'organization_admin',
  'staff',
  'volunteer',
  'platform_owner',
] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_CHAT_ROLES]);
    return NextResponse.json({
      success: true,
      capabilities: getShadowChatCapabilities(principal.role),
    });
  } catch (error) {
    return jsonError(error);
  }
}
