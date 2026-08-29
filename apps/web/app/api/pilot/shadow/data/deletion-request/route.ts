import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getOwnShadowDataDeletionRequest } from '@/src/server/pilot/shadowConversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where the caller's own deletion request stands.
 *
 * POST /api/pilot/shadow/data files the request and answers with its id. That
 * answer survives exactly as long as the tab: reload the page and a person has
 * no way to tell whether they ever asked, so the only safe assumption
 * available to them is that they did not — and asking twice is the behaviour
 * the route's idempotency check exists to absorb. This is the read that makes
 * the request visible to the person who made it.
 *
 * SELF-SCOPED, with no parameter to be wrong about:
 * getOwnShadowDataDeletionRequest takes the principal and reads
 * organization_id = the caller's, account_id = the caller's. There is no
 * account id in the request and a body carrying one is ignored.
 *
 * It deliberately does NOT return processed_by. Which member of staff handled
 * a child's deletion request is not the child's business to be told; that a
 * person handled it is, and the status carries that.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const item = await getOwnShadowDataDeletionRequest(principal);
    return NextResponse.json({ ok: true, request: item }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
