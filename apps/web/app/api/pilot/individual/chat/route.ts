// Compatibility adapter for the old individual/parent route. The canonical
// endpoint owns all safety, authorization, persistence, and provider logic.
import { NextRequest } from 'next/server';

import { POST as postShadowChat } from '@/app/api/pilot/shadow/chat/route';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'parent']);
    const body = await request.json() as Record<string, unknown>;
    const sanitizedBody = { ...body };
    delete sanitizedBody.organizationId;
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('content-length');
    const forwarded = new NextRequest(request.url, {
      method: 'POST',
      headers: forwardedHeaders,
      body: JSON.stringify(sanitizedBody),
    });
    return postShadowChat(forwarded);
  } catch (error) {
    return jsonError(error);
  }
}
