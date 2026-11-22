import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  behaviourWindowOf,
  changeLastWindowTap,
  closeBehaviourWindow,
  currentWindowChance,
  listMyWindowTaps,
  recordWindowTap,
  type BehaviourWindowRow,
} from '@/src/server/pilot/behaviourSampleWindows';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

export const runtime = 'nodejs';

// One sampled window (lane PATTERN-1, PATTERN-1e; PunxsyProminence/ppbf-platform#2082).
// GET: the window, the chance the count stands at (a number only; Overwatch
// 7084899452 point 2) and the caller's own taps -- never another coach's
// (Q2 A, join blind). PATCH, by action: `tap` a chance shown or not shown,
// `change_last` (the caller's most recent tap, Q8 A), or `close`. Staff only;
// a window of another gym, or of an athlete the caller may not reach, answers
// exactly as one that does not exist. The observer, role and gym are the
// session's, never the body's.

const WINDOW_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const ACTIONS = ['tap', 'change_last', 'close'] as const;

interface RouteContext {
  params: Promise<{ windowId: string }>;
}

/**
 * The window, if this gym's and its athlete is one the caller may reach; null otherwise. A failure
 * to read the window is rethrown; the athlete check, like the reports route's, answers any refusal
 * of it as null.
 */
async function reachableWindow(principal: PilotPrincipal, windowId: string): Promise<BehaviourWindowRow | null> {
  if (windowId.length > 100) return null;
  let window: BehaviourWindowRow;
  try {
    window = await behaviourWindowOf(principal.organizationId, windowId);
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
  try {
    await assertActorCanAccessAthlete(principal, window.athlete_id);
  } catch {
    return null;
  }
  return window;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...WINDOW_ROLES]);
    const { windowId } = await context.params;
    const window = await reachableWindow(principal, windowId);
    if (!window) return hiddenNotFound();
    const scope = { organizationId: principal.organizationId, windowId };
    const currentChance = await currentWindowChance({ ...scope, readerAccountId: principal.accountId });
    const myTaps = await listMyWindowTaps({ ...scope, observerAccountId: principal.accountId });
    return NextResponse.json({ ok: true, window, currentChance, myTaps });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...WINDOW_ROLES]);
    // A body of null, a number or a list is not a request: read as empty, refused below.
    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const action = body.action;
    const polarity = typeof body.polarity === 'string' && body.polarity !== '' ? body.polarity : undefined;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)
        || (action === 'tap' && (!Number.isInteger(body.chance) || !polarity))
        || (action === 'change_last' && !polarity)) {
      return NextResponse.json({
        ok: false, error: `action is one of ${ACTIONS.join(', ')}; a tap takes a whole-number chance and a polarity, a change a polarity.`,
      }, { status: 400 });
    }
    const { windowId } = await context.params;
    if (!(await reachableWindow(principal, windowId))) return hiddenNotFound();
    const scope = { organizationId: principal.organizationId, windowId };
    const as = { observerAccountId: principal.accountId, authorRole: principal.role };
    if (action === 'close') {
      const window = await closeBehaviourWindow({ ...scope, closedByAccountId: principal.accountId });
      return NextResponse.json({ ok: true, window });
    }
    const tap = action === 'tap'
      ? await recordWindowTap({ ...scope, chance: body.chance as number, polarity: polarity as string, ...as })
      : await changeLastWindowTap({ ...scope, polarity: polarity as string, ...as });
    return NextResponse.json({ ok: true, tap });
  } catch (error) {
    return jsonError(error);
  }
}
