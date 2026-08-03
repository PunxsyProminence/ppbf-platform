import { NextResponse, type NextRequest } from 'next/server';

import { getPilotDefaultOrganizationId, getWallDisplayNameMode } from '@/src/server/pilot/env';
import { getClientIp } from '@/src/server/pilot/rateLimit';
import { resolveWallNameMode } from '@/src/server/pilot/wallDisplay';
import { loadWallBoard } from '@/src/server/pilot/wallDisplayDb';
import { consumeWallBudget } from '@/src/server/pilot/wallRateLimit';

export const runtime = 'nodejs';
// A wall board is a live read. Nothing about it may be cached at the edge or
// baked at build time, or the TV shows yesterday's classes forever.
export const dynamic = 'force-dynamic';

/**
 * GET /api/pilot/wall -- the board behind /wall, the gym's TV.
 *
 * Unauthenticated, like GET /api/pilot/announcements/public and for the same
 * reason: the client is a browser on a television that nobody logs into, and a
 * 24-hour session token would take the screen dark every morning.
 *
 * That makes the payload public, so it is built to be safe as a public
 * document rather than trusted to stay behind a wall:
 *
 *   - organization_id is never accepted from the caller. Same rule the public
 *     announcements route follows -- it is always the configured default org,
 *     so this cannot be pointed at another gym's children.
 *   - names are gated per athlete by wallDisplay.ts, and the operator-level
 *     mode defaults to initials.
 *   - athlete_id never appears; the payload carries an opaque hashed key, so
 *     the endpoint cannot be scraped for a roster.
 *   - nothing health-related, medical, injury-related or disciplinary is read
 *     at all (see wallDisplayDb.ts).
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

    const board = await loadWallBoard({
      organizationId: getPilotDefaultOrganizationId(),
      mode: resolveWallNameMode(getWallDisplayNameMode()),
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
