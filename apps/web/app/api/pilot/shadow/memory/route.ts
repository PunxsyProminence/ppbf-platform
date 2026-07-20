import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { submitMemoryCorrection } from '@/src/server/pilot/shadowConversations';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner']);
    const body = await request.json();
    if (typeof body.factKey !== 'string' || !body.factKey.trim() || !['replace', 'forget'].includes(body.action)) {
      return NextResponse.json({ success: false, error: 'factKey and a valid action are required.' }, { status: 400 });
    }
    if (body.action === 'replace' && (typeof body.correctedValue !== 'string' || !body.correctedValue.trim())) {
      return NextResponse.json({ success: false, error: 'A corrected value is required for replace.' }, { status: 400 });
    }
    const correctionId = await submitMemoryCorrection({
      organizationId: principal.organizationId,
      userId: principal.accountId,
      factKey: body.factKey.trim(),
      correctedValue: body.correctedValue,
      action: body.action,
    });
    return NextResponse.json({ success: true, correctionId, status: 'recorded' }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
