import { NextRequest, NextResponse } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, isUuid, jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import {
  loadConversationMessages,
  renameConversation,
  softDeleteConversation,
} from '@/src/server/pilot/shadowConversations';

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

function requireShadowSessionRole(principal: Awaited<ReturnType<typeof requirePrincipal>>): void {
  requireRole(principal, [
    'admin',
    'coach',
    'athlete',
    'parent',
    'organization_admin',
    'staff',
    'volunteer',
    'platform_owner',
  ]);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireShadowSessionRole(principal);
    const { conversationId } = await context.params;
    if (!isUuid(conversationId)) return hiddenNotFound();
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 12, 50);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const messages = await loadConversationMessages({
      actor: principal,
      conversationId,
      limit,
    });
    return NextResponse.json({ success: true, messages });
  } catch (error) {
    if (error instanceof Error && error.message === 'SHADOW_CONVERSATION_NOT_FOUND') {
      return hiddenNotFound();
    }
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireShadowSessionRole(principal);
    const { conversationId } = await context.params;
    if (!isUuid(conversationId)) return hiddenNotFound();
    const body = await request.json() as { title?: unknown };
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return NextResponse.json({ error: 'Missing conversation title' }, { status: 400 });
    }
    const updated = await renameConversation(
      principal,
      conversationId,
      body.title,
    );
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireShadowSessionRole(principal);
    const { conversationId } = await context.params;
    if (!isUuid(conversationId)) return hiddenNotFound();
    const deleted = await softDeleteConversation(
      principal,
      conversationId,
    );
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error);
  }
}
