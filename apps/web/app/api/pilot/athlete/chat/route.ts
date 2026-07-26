// Compatibility adapter. It injects the authenticated athlete identity and
// delegates to the single canonical SHADOW trust boundary.
import { NextRequest } from 'next/server';

import { POST as postShadowChat } from '@/app/api/pilot/shadow/chat/route';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'athlete']);
    const body = await request.json() as Record<string, unknown>;
    const sanitizedBody = { ...body };
    delete sanitizedBody.organizationId;
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('content-length');
    const forwarded = new NextRequest(request.url, {
      method: 'POST',
      headers: forwardedHeaders,
      body: JSON.stringify({
        ...sanitizedBody,
        ...(principal.role === 'athlete' ? { athleteId: principal.athleteId } : {}),
      }),
    });
    return postShadowChat(forwarded);
  } catch (error) {
    return jsonError(error);
  }
}
