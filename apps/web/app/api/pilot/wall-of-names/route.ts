import { NextResponse, type NextRequest } from 'next/server';

import { getWallDisplayNameMode } from '@/src/server/pilot/env';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { resolveWallNameMode } from '@/src/server/pilot/wallDisplay';
import { loadWallOfNames } from '@/src/server/pilot/wallOfNamesDb';

export const runtime = 'nodejs';
// A lineage changes when somebody joins, which is rarely, but it must never be
// baked at build time or served from an edge cache: the payload is scoped to
// the caller's own organization and a cached copy is a copy served to the wrong
// gym.
export const dynamic = 'force-dynamic';

/**
 * GET /api/pilot/wall-of-names -- everyone who has come through this gym.
 *
 * BEHIND A SESSION, unlike the gym's television. /api/pilot/wall is deliberately
 * unauthenticated because it is rendered on a screen nobody logs into; this is a
 * page a member opens, so there is a session to require and requiring it is
 * strictly the more conservative choice.
 *
 * The organization is taken from the SESSION and never from the request. There
 * is no query parameter, no body, and no way to point this at another gym's
 * children -- the same rule the public announcements route had to learn.
 *
 * Every role that can sign in may read it. That is safe because of what the
 * payload is rather than because of who is asking: the name gate
 * (wallDisplay.ts) resolves every athlete to initials unless a guardian has
 * signed a release naming a display surface AND an operator has switched
 * PPBF_WALL_DISPLAY_NAMES to 'consent'. Neither exists today, so what comes back
 * is initials and years. The ids are hashed, so it cannot be scraped for a
 * roster, and there is no per-person number on it at all.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const board = await loadWallOfNames({
      organizationId: principal.organizationId,
      mode: resolveWallNameMode(getWallDisplayNameMode()),
    });

    return NextResponse.json({ ok: true, board }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
