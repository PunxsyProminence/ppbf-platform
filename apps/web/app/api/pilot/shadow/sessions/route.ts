import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { listConversations, resolveConversation } from '@/src/server/pilot/shadowConversations';

const ROLES = ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner'] as const;
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    return NextResponse.json({ success: true, sessions: await listConversations(principal.organizationId, principal.accountId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const body = await request.json().catch(() => ({}));
    const firstMessage = typeof body.firstMessage === 'string' ? body.firstMessage : 'New conversation';
    const conversationId = await resolveConversation({
      organizationId: principal.organizationId,
      userId: principal.accountId,
      athleteId: typeof body.athleteId === 'string' ? body.athleteId : undefined,
      sessionType: 'quick_round',
      firstMessage,
    });
    return NextResponse.json({ success: true, conversationId }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
