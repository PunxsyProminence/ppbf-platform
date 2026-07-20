import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { exportOwnShadowData, requestOwnShadowDataDeletion } from '@/src/server/pilot/shadowConversations';

const ROLES = ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner'] as const;
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const data = await exportOwnShadowData(principal.organizationId, principal.accountId);
    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="shadow-chat-export.json"' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const requestId = await requestOwnShadowDataDeletion(principal.organizationId, principal.accountId);
    return NextResponse.json({
      success: true,
      requestId,
      status: 'pending',
      message: 'Your deletion request was recorded for authorized review. Data is not automatically erased until retention, legal-hold, and safeguarding requirements are checked.',
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
