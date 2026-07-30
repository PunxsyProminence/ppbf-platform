// Compatibility adapter for the old board route. Board requests now pass
// through the canonical SHADOW trust boundary and never use a second model
// prompt or provider client.
import { NextRequest } from 'next/server';

import { POST as postShadowChat } from '@/app/api/pilot/shadow/chat/route';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);
    const body = await request.json() as Record<string, unknown>;
    const sanitizedBody = { ...body };
    delete sanitizedBody.organizationId;
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('content-length');
    // The forced sessionType made this endpoint answer 503 to every request.
    // 'board_summary' is one of the background modes the canonical route
    // rejects outright ("not active until the secure job worker is
    // configured"), and because it was spread last it overrode whatever the
    // caller sent, so no input could reach a model. Nothing enqueues background
    // SHADOW work today -- executeHeavyBagAsync and generateScoutReport have no
    // production callers and no worker drains the queue -- so forcing a
    // background mode could only ever fail.
    //
    // Board requests now classify like any other chat request, which is what
    // the adapter's own comment describes: pass through the canonical trust
    // boundary rather than run a second prompt path. If board_summary is
    // revived later it belongs behind a working worker, not hardcoded here.
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
