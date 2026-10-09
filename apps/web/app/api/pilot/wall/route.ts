import { NextResponse, type NextRequest } from 'next/server';

import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { getClientIp } from '@/src/server/pilot/rateLimit';
import { loadPublicWallBoard } from '@/src/server/pilot/wallDisplayDb';
import { consumeWallBudget } from '@/src/server/pilot/wallRateLimit';

export const runtime = 'nodejs';
// A wall board is a live read. Nothing about it may be cached at the edge or
// baked at build time, or the TV shows yesterday's classes forever.
export const dynamic = 'force-dynamic';

/**
 * GET /api/pilot/wall -- the PUBLIC board behind /wall, for a television that
 * has not been paired.
 *
 * Unauthenticated, like GET /api/pilot/announcements/public and for the same
 * reason: the client is a browser on a television that nobody logs into, and a
 * 24-hour session token would take the screen dark every morning.
 *
 * That makes the payload public, and OD-2026-10-07-008 (Jason, "Paired gym TV
 * only") says what a public payload may hold: today's classes and a head
 * count. Nothing else. So this route serves WallPublicBoard, a shape with no
 * person in it:
 *
 *   - no names at any visibility, no initials, no milestone crossings and no
 *     per-athlete key, hashed or otherwise. The board with people on it is
 *     served only to a paired TV, through GET /api/pilot/tv/session behind the
 *     device-cookie gate in gymTvs.ts.
 *   - organization_id is never accepted from the caller. Same rule the public
 *     announcements route follows -- it is always the configured default org,
 *     so this cannot be pointed at another gym's children.
 *   - the notice is gym_notices only; 'everywhere' is for members.
 *   - nothing health-related, medical, injury-related or disciplinary is read
 *     at all (see wallDisplayDb.ts loadPublicWallBoard).
 *
 * Budgeted by IP because it is public and it is a database read. The TV polls
 * every 30 seconds from one address, which is 2 of 30 in the window.
 */
export async function GET(request: NextRequest) {
  try {
    const budget = consumeWallBudget(`wall_display_ip:${getClientIp(request)}`);
    if (!budget.allowed) {
      return NextResponse.json(
        { ok: false, error: 'Too many requests.' },
        { status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
      );
    }

    const board = await loadPublicWallBoard({
      organizationId: getPilotDefaultOrganizationId(),
    });

    return NextResponse.json(
      { ok: true, board },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // Deliberately NOT jsonError(): that helper forwards some error messages to
    // the caller, and this response is rendered on a screen in a public room.
    // The diagnostic goes to the log; the wall gets a flag it knows how to
    // degrade on, and no detail at all.
    console.error({ event: 'wall-display-read-failed', message: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json(
      { ok: false, error: 'The board is unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
