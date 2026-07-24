import { NextRequest, NextResponse } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { isUuid, jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { canUseShadowSessionType } from '@/src/server/pilot/shadowChatCapabilities';
import { listConversations, resolveConversation } from '@/src/server/pilot/shadowConversations';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const conversations = await listConversations(
      principal,
      limit,
    );
    return NextResponse.json({ success: true, conversations });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = await request.json() as {
      conversationId?: unknown;
      athleteId?: unknown;
      sessionType?: unknown;
      firstMessage?: unknown;
    };
    if (typeof body.sessionType !== 'string' || !canUseShadowSessionType(principal.role, body.sessionType)) {
      return NextResponse.json({ error: 'Unsupported SHADOW session type' }, { status: 400 });
    }
    if (typeof body.firstMessage !== 'string' || !body.firstMessage.trim()) {
      return NextResponse.json({ error: 'Missing firstMessage' }, { status: 400 });
    }
    if (body.conversationId !== undefined && (
      typeof body.conversationId !== 'string'
      || !isUuid(body.conversationId)
    )) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (body.athleteId !== undefined && typeof body.athleteId !== 'string') {
      return NextResponse.json({ error: 'Invalid athleteId' }, { status: 400 });
    }
    if (body.athleteId) {
      await assertActorCanAccessAthlete(principal, body.athleteId);
    }

    const conversationId = await resolveConversation({
      actor: principal,
      conversationId: body.conversationId,
      athleteId: body.athleteId,
      sessionType: body.sessionType,
      firstMessage: body.firstMessage,
    });
    return NextResponse.json({ success: true, conversationId });
  } catch (error) {
    if (error instanceof Error && error.message === 'SHADOW_CONVERSATION_NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return jsonError(error);
  }
}
