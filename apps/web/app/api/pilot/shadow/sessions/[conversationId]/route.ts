import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { loadConversationMessages, renameConversation, softDeleteConversation } from '@/src/server/pilot/shadowConversations';

const ROLES = ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner'] as const;
export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const { conversationId } = await context.params;
    const messages = await loadConversationMessages({ organizationId: principal.organizationId, userId: principal.accountId, conversationId, limit: 50 });
    return NextResponse.json({ success: true, conversationId, messages });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const { conversationId } = await context.params;
    const body = await request.json();
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return NextResponse.json({ success: false, error: 'A title is required.' }, { status: 400 });
    }
    const updated = await renameConversation(principal.organizationId, principal.accountId, conversationId, body.title);
    return updated ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const { conversationId } = await context.params;
    const deleted = await softDeleteConversation(principal.organizationId, principal.accountId, conversationId);
    return deleted ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
