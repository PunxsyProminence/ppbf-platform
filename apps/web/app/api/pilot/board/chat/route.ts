// Compatibility adapter for the old board route. Board requests now pass
// through the canonical SHADOW trust boundary and never use a second model
// prompt or provider client.
//
// THE BOARD ROLE ITSELF IS NOT ADMITTED HERE, and the path is not evidence that
// it is. This URL is a legacy address kept alive for callers that already point
// at it -- the gym administrators who ask SHADOW about governance work -- and
// the name records where those callers came from, not who may use it.
//
// The denial is deliberate and stands on its own reason: the board role is
// aggregate-only, so every figure it may see has to clear the k-anonymity floor
// in boardSummary.ts (BOARD_MINIMUM_COHORT_SIZE = 5). A chat turn is free-form
// and cannot be gated that way, and SHADOW's board context is deliberately
// empty for exactly that reason. Admitting the role here would re-open the
// aggregate boundary through a surface that has no gate on it.
//
// The board's own governance figures come from /api/pilot/board/summary, which
// suppresses any cohort below the floor.
import { NextRequest } from 'next/server';

import { POST as postShadowChat } from '@/app/api/pilot/shadow/chat/route';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // Named before the generic role check so the refusal says why rather than
    // reading as a misconfigured allow-list on a board-addressed URL.
    if (principal.role === 'board') {
      throw new Error(
        'Forbidden: the board role is aggregate-only and SHADOW chat is not an aggregate surface. Board governance figures come from /api/pilot/board/summary, which suppresses any cohort smaller than five.',
      );
    }
    requireRole(principal, ['organization_admin', 'admin']);
    const body = await request.json() as Record<string, unknown>;
    const sanitizedBody = { ...body };
    delete sanitizedBody.organizationId;
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('content-length');
    // The forced sessionType made this endpoint answer 503 to every request:
    // it was spread last, so it overrode whatever the caller sent, and at the
    // time no worker existed to drain background modes. The worker is live
    // now and board_summary IS queueable through the canonical route -- but
    // the fix stands for the original reason: board requests pass through the
    // canonical trust boundary and classify like any other chat request,
    // rather than this adapter hardcoding a second prompt path.
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
