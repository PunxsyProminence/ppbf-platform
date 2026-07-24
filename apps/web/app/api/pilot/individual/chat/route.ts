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
    return postShadowChat(request);
  } catch (error) {
    return jsonError(error);
  }
}
